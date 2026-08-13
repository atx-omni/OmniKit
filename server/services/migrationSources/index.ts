import { createHash } from 'node:crypto';
import type { DomoApiEvidenceResult, MigrationBiSourceTool, MigrationPreparedEvidenceResult } from '../../../src/services/semanticMigration/types';
import { savedSourceAuthenticationIssue, type SavedPlatformConnection } from '../nativeVault';
import { domoApiEvidenceToPreparedSourceEvidence, prepareDomoApiEvidence, prepareDomoSourceEvidence } from '../migrationConnectors';
import { redactSensitiveText } from '../jobSanitizer';
import type {
  MigrationSourceCollectorContext,
  MigrationSourceConnectionSnapshot,
  MigrationSourceEvidenceCollector,
  MigrationSourceTransport,
  MigrationSourceTransportRequest,
  MigrationSourceTransportResponse,
} from './contracts';
import { migrationSourceAuthModeAllowed, migrationSourceAuthPolicy } from './policy';
import { createMigrationSourceTransport } from './secureTransport';
import { lookerEvidenceCollector } from './looker';
import { sigmaEvidenceCollector } from './sigma';
import { metabaseEvidenceCollector } from './metabase';
import { tableauEvidenceCollector } from './tableau';
import { powerBiEvidenceCollector } from './powerBi';
import { microStrategyEvidenceCollector } from './microStrategy';

const COLLECTORS: Readonly<Partial<Record<MigrationBiSourceTool, MigrationSourceEvidenceCollector>>> = {
  looker: lookerEvidenceCollector,
  sigma: sigmaEvidenceCollector,
  metabase: metabaseEvidenceCollector,
  tableau: tableauEvidenceCollector,
  power_bi: powerBiEvidenceCollector,
  microstrategy: microStrategyEvidenceCollector,
};
const SUPPORTED_PLATFORMS = new Set<MigrationBiSourceTool>(['domo', 'looker', 'sigma', 'metabase', 'tableau', 'power_bi', 'microstrategy']);
const MAX_SELECTED_ROOTS = 200;
const MAX_ROOT_ID_CHARACTERS = 300;
const MAX_PREPARATION_REQUESTS = 1_500;
const PREPARATION_DEADLINE_MS = 5 * 60_000;
export const MAX_PREPARATION_RESPONSE_BYTES = 256 * 1024 * 1024;

export type MigrationSourcePreparationOptions = {
  signal?: AbortSignal;
  transport?: MigrationSourceTransport;
  /** Tests may shorten, but never extend, the production five-minute ceiling. */
  deadlineMs?: number;
};

function isControlCharacter(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

function replaceControlCharacters(value: string, replacement: string): string {
  return Array.from(value, (character) => isControlCharacter(character) ? replacement : character).join('');
}

function sensitiveVariants(connection: SavedPlatformConnection, additionalValues: readonly string[] = []): string[] {
  return Array.from(new Set([connection.credential, connection.productApiToken, ...additionalValues]
    .filter((value): value is string => Boolean(value && Array.from(value).length >= 4))
    .flatMap((value) => {
      const base64 = Buffer.from(value, 'utf8').toString('base64');
      return [value, encodeURIComponent(value), base64, base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')];
    })))
    .sort((left, right) => right.length - left.length);
}

function redactBrowserEvidence<Result>(
  result: Result,
  connection: SavedPlatformConnection,
  additionalValues: readonly string[] = [],
): Result {
  const variants = sensitiveVariants(connection, additionalValues);
  if (variants.length === 0) return result;
  const redactString = (value: string): string => variants.reduce(
    (text, secret) => text.replaceAll(secret, '[REDACTED]'),
    value,
  );
  const redactValue = (value: unknown): unknown => {
    if (typeof value === 'string') return redactString(value);
    if (Array.isArray(value)) return value.map(redactValue);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .map(([key, child]) => [redactString(key), redactValue(child)]));
    }
    return value;
  };
  return redactValue(JSON.parse(JSON.stringify(result))) as Result;
}

function assertSafelyRedactableStoredCredentials(connection: SavedPlatformConnection): void {
  for (const value of [connection.credential, connection.productApiToken]) {
    if (value && Array.from(value).length < 4) {
      throw Object.assign(new Error('The saved source credential is too short to handle safely and must be replaced.'), { statusCode: 409 });
    }
  }
}

function redactPreparationError(error: unknown, connection: SavedPlatformConnection, sensitiveValues: readonly string[]): Error {
  const source = error instanceof Error ? error : new Error(String(error ?? 'Source evidence preparation failed.'));
  const redacted = redactBrowserEvidence({ message: source.message }, connection, sensitiveValues).message;
  const safe = Object.assign(new Error(redactSensitiveText(redacted)), { name: source.name });
  const statusCode = (source as { statusCode?: unknown }).statusCode;
  if (typeof statusCode === 'number') Object.assign(safe, { statusCode });
  return safe;
}

function connectionSnapshot(connection: SavedPlatformConnection): MigrationSourceConnectionSnapshot {
  return {
    id: connection.id,
    name: connection.name,
    platform: connection.platform as MigrationBiSourceTool,
    baseUrl: connection.baseUrl || '',
    updatedAt: connection.updatedAt,
    authMode: connection.authMode || migrationSourceAuthPolicy(connection.platform as MigrationBiSourceTool).primaryAuthMode,
    clientId: connection.clientId,
    credential: connection.credential,
    productApiToken: connection.productApiToken,
    accountIdentifier: connection.accountIdentifier,
    workspaceId: connection.workspaceId,
    projectId: connection.projectId,
    siteId: connection.siteId,
    username: connection.username,
    repositoryPath: connection.repositoryPath,
    credentialExpiresAt: connection.credentialExpiresAt,
  };
}

function migrationSourceRequestSeed(input: {
  connectionId: string;
  connectionUpdatedAt: string;
  platform: MigrationBiSourceTool;
  selectedRootIds: readonly string[];
}): string {
  return createHash('sha256').update(JSON.stringify({
    connectionId: input.connectionId,
    connectionUpdatedAt: input.connectionUpdatedAt,
    platform: input.platform,
    selectedRootIds: Array.from(new Set(input.selectedRootIds.map(String).map((value) => value.trim()).filter(Boolean))).sort(),
  })).digest('hex');
}

function requestError(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function aggregateResponseLimitError(): Error {
  return Object.assign(new Error('Source evidence preparation exceeded the 256 MB aggregate response limit. Narrow the selected scope and retry.'), { statusCode: 413 });
}

async function withinMigrationSourcePreparationLimits<T>(
  options: MigrationSourcePreparationOptions,
  prepare: (context: { signal: AbortSignal; transport: MigrationSourceTransport }) => Promise<T>,
): Promise<{ result: T; aggregateResponseBytes: number }> {
  const controller = new AbortController();
  let deadlineReached = false;
  const abortFromParent = () => controller.abort();
  options.signal?.addEventListener('abort', abortFromParent, { once: true });
  if (options.signal?.aborted) controller.abort();
  const configuredDeadline = Number.isFinite(options.deadlineMs) && Number(options.deadlineMs) > 0
    ? Math.min(Math.floor(Number(options.deadlineMs)), PREPARATION_DEADLINE_MS)
    : PREPARATION_DEADLINE_MS;
  const deadline = setTimeout(() => {
    deadlineReached = true;
    controller.abort();
  }, configuredDeadline);
  let reservedRequests = 0;
  let aggregateResponseBytes = 0;
  let aggregateLimitReached = false;
  let transportTail: Promise<void> = Promise.resolve();
  const baseTransport = options.transport || createMigrationSourceTransport();
  const executeTransportRequest = async <ResponseBody = unknown>(
    request: MigrationSourceTransportRequest,
  ): Promise<MigrationSourceTransportResponse<ResponseBody>> => {
    if (aggregateLimitReached) throw aggregateResponseLimitError();
    if (controller.signal.aborted) {
      throw Object.assign(new Error(deadlineReached
        ? 'Source evidence preparation reached the five-minute overall deadline. Narrow the selected scope and retry.'
        : 'Source evidence preparation was cancelled.'), { statusCode: deadlineReached ? 504 : 499 });
    }
    if (reservedRequests >= MAX_PREPARATION_REQUESTS) {
      throw Object.assign(new Error(`Source evidence preparation reached the ${MAX_PREPARATION_REQUESTS}-request safety bound. Narrow the selected scope and retry.`), { statusCode: 413 });
    }
    const remainingBytes = MAX_PREPARATION_RESPONSE_BYTES - aggregateResponseBytes;
    if (remainingBytes <= 0) {
      aggregateLimitReached = true;
      controller.abort();
      throw aggregateResponseLimitError();
    }
    reservedRequests += 1;
    const responseLimit = Math.min(request.maxResponseBytes ?? remainingBytes, remainingBytes);
    try {
      const response = await baseTransport.request<ResponseBody>({
        ...request,
        signal: controller.signal,
        maxResponseBytes: responseLimit,
      });
      if (!Number.isSafeInteger(response.bytesRead) || response.bytesRead < 0) {
        throw Object.assign(new Error('The source transport returned an invalid response byte count.'), { statusCode: 502 });
      }
      if (response.bytesRead > remainingBytes) {
        aggregateLimitReached = true;
        controller.abort();
        throw aggregateResponseLimitError();
      }
      aggregateResponseBytes += response.bytesRead;
      return response;
    } catch (error) {
      const statusCode = (error as { statusCode?: number })?.statusCode;
      if (statusCode === 413 && responseLimit === remainingBytes) {
        aggregateLimitReached = true;
        controller.abort();
        throw aggregateResponseLimitError();
      }
      throw error;
    }
  };
  const transport: MigrationSourceTransport = {
    request<ResponseBody = unknown>(request: MigrationSourceTransportRequest): Promise<MigrationSourceTransportResponse<ResponseBody>> {
      // Serialize reads so concurrent vendor fan-out cannot reserve the same
      // remaining aggregate budget and inflate past the preparation ceiling.
      const pending = transportTail.then(() => executeTransportRequest<ResponseBody>(request));
      transportTail = pending.then(() => undefined, () => undefined);
      return pending;
    },
  };
  const assertPreparationActive = (): void => {
    if (aggregateLimitReached) throw aggregateResponseLimitError();
    if (!controller.signal.aborted) return;
    throw Object.assign(new Error(deadlineReached
      ? 'Source evidence preparation reached the five-minute overall deadline. Narrow the selected scope and retry.'
      : 'Source evidence preparation was cancelled.'), {
      name: deadlineReached ? 'Error' : 'AbortError',
      statusCode: deadlineReached ? 504 : 499,
    });
  };
  try {
    const result = await prepare({ signal: controller.signal, transport });
    assertPreparationActive();
    return { result, aggregateResponseBytes };
  } catch (error) {
    if (aggregateLimitReached) throw aggregateResponseLimitError();
    if (deadlineReached) {
      throw Object.assign(new Error('Source evidence preparation reached the five-minute overall deadline. Narrow the selected scope and retry.'), { statusCode: 504 });
    }
    if (options.signal?.aborted) {
      throw Object.assign(new Error('Source evidence preparation was cancelled.'), { name: 'AbortError', statusCode: 499 });
    }
    throw error;
  } finally {
    clearTimeout(deadline);
    options.signal?.removeEventListener('abort', abortFromParent);
  }
}

/**
 * Normalize and validate the complete caller-supplied scope before a collector
 * sees it. Root identifiers are opaque vendor IDs, but they are still bounded
 * protocol inputs and must never be allowed to carry terminal/control bytes.
 */
export function normalizeMigrationSourceRootIds(selectedRootIds: readonly unknown[]): string[] {
  if (selectedRootIds.length > MAX_SELECTED_ROOTS) {
    throw requestError(`Select ${MAX_SELECTED_ROOTS} or fewer source roots before preparing migration evidence.`);
  }
  const normalized: string[] = [];
  for (const value of selectedRootIds) {
    if (typeof value !== 'string') throw requestError('Every selected source root identifier must be a string.');
    if (Array.from(value).some(isControlCharacter)) throw requestError('Selected source root identifiers must not contain control characters.');
    const rootId = value.trim();
    if (!rootId) throw requestError('Selected source root identifiers must not be empty.');
    if (Array.from(rootId).length > MAX_ROOT_ID_CHARACTERS) {
      throw requestError(`Selected source root identifiers must be ${MAX_ROOT_ID_CHARACTERS} characters or fewer.`);
    }
    normalized.push(rootId);
  }
  const deduplicated = Array.from(new Set(normalized)).sort();
  if (deduplicated.length === 0) throw requestError('Select at least one source root before preparing migration evidence.');
  return deduplicated;
}

function sanitizedFingerprintText(value: unknown, requestSeed: string): string {
  return redactSensitiveText(replaceControlCharacters(
    String(value ?? '').replaceAll(requestSeed, '[REQUEST_SCOPE]'),
    ' ',
  )
    .replace(/\s+/g, ' ')
    .trim());
}

function sortedSanitizedStrings(values: readonly string[], requestSeed: string): string[] {
  return Array.from(new Set(values.map((value) => sanitizedFingerprintText(value, requestSeed)))).sort();
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(',')}}`;
}

/**
 * Bind the browser-visible evidence token to what was actually collected, not
 * merely to the requested scope. Diagnostics are normalized before hashing so
 * secrets/redaction placeholders, ordering, and terminal bytes cannot create
 * a misleading or unsafe review token.
 */
export function migrationPreparedEvidenceContentFingerprint(input: {
  connectionId: string;
  connectionUpdatedAt: string;
  platform: MigrationBiSourceTool;
  selectedRootIds: readonly string[];
  requestSeed: string;
  result: MigrationPreparedEvidenceResult;
}): string {
  const { result, requestSeed } = input;
  const dependencies = result.dependencies.map((dependency) => ({
    sourceId: sanitizedFingerprintText(dependency.sourceId, requestSeed),
    dependencySourceId: sanitizedFingerprintText(dependency.dependencySourceId, requestSeed),
    category: dependency.category,
    required: dependency.required,
    status: dependency.status,
    reason: sanitizedFingerprintText(dependency.reason, requestSeed),
  })).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  const artifactProvenance = result.artifacts.map((artifact) => ({
    id: sanitizedFingerprintText(artifact.id, requestSeed),
    name: sanitizedFingerprintText(artifact.name, requestSeed),
    sourceId: sanitizedFingerprintText(artifact.sourceId, requestSeed),
    parentSourceId: sanitizedFingerprintText(artifact.parentSourceId, requestSeed),
    locator: sanitizedFingerprintText(artifact.locator, requestSeed),
    mediaType: sanitizedFingerprintText(artifact.mediaType, requestSeed),
    evidenceClass: artifact.evidenceClass,
    sha256: artifact.sha256.toLowerCase(),
    sizeBytes: artifact.sizeBytes,
    documentationIds: sortedSanitizedStrings(artifact.documentationIds, requestSeed),
    rawContentIncluded: artifact.rawContentIncluded,
  })).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  const contractArtifactFingerprints = result.evidenceContract.artifactFingerprints.map((artifact) => ({
    name: sanitizedFingerprintText(artifact.name, requestSeed),
    sha256: (artifact.sha256 || '').toLowerCase(),
    sizeBytes: artifact.sizeBytes,
  })).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  const collectionDiagnostics = {
    status: result.status,
    complete: result.diagnostics.complete,
    verifiedEmpty: result.diagnostics.verifiedEmpty,
    truncated: result.diagnostics.truncated,
    requestsMade: result.diagnostics.requestsMade,
    pagesFetched: result.diagnostics.pagesFetched,
    itemsObserved: result.diagnostics.itemsObserved,
    bytesRead: result.diagnostics.bytesRead,
    limits: result.diagnostics.limits,
    permissionGaps: sortedSanitizedStrings(result.diagnostics.permissionGaps, requestSeed),
    manualRequirements: sortedSanitizedStrings(result.diagnostics.manualRequirements, requestSeed),
    errors: sortedSanitizedStrings(result.diagnostics.errors, requestSeed),
    warnings: sortedSanitizedStrings(result.diagnostics.warnings, requestSeed),
    contractCollection: {
      expectedArtifactCount: result.evidenceContract.collection.expectedArtifactCount,
      observedArtifactCount: result.evidenceContract.collection.observedArtifactCount,
      complete: result.evidenceContract.collection.complete,
      truncated: result.evidenceContract.collection.truncated,
      permissionGaps: sortedSanitizedStrings(result.evidenceContract.collection.permissionGaps, requestSeed),
    },
    dependencyClosure: result.evidenceContract.dependencyClosure,
    contractDiagnostics: sortedSanitizedStrings(result.evidenceContract.diagnostics, requestSeed),
  };
  return createHash('sha256').update(canonicalJson({
    schemaVersion: result.schemaVersion,
    connectionId: input.connectionId,
    connectionUpdatedAt: input.connectionUpdatedAt,
    platform: input.platform,
    selectedRootIds: [...input.selectedRootIds].sort(),
    collectorScopeIdentity: sanitizedFingerprintText(result.scopeFingerprint, requestSeed),
    parser: {
      name: sanitizedFingerprintText(result.evidenceContract.parser.name, requestSeed),
      version: sanitizedFingerprintText(result.evidenceContract.parser.version, requestSeed),
      rulebookVersion: sanitizedFingerprintText(result.evidenceContract.parser.rulebookVersion, requestSeed),
      rulebookSha256: sanitizedFingerprintText(result.evidenceContract.parser.rulebookSha256, requestSeed),
    },
    acquisition: {
      mode: result.evidenceContract.acquisition.mode,
      selectedScopeIds: sortedSanitizedStrings(result.evidenceContract.acquisition.selectedScopeIds, requestSeed),
    },
    documentationIds: sortedSanitizedStrings(result.evidenceContract.documentationIds, requestSeed),
    artifactProvenance,
    contractArtifactFingerprints,
    dependencies,
    collectionDiagnostics,
  })).digest('hex');
}

function publishContentFingerprint(
  result: MigrationPreparedEvidenceResult,
  requestSeed: string,
  contentFingerprint: string,
): MigrationPreparedEvidenceResult {
  // Some collectors use the internal seed to correlate scope-only placeholder
  // records. Replace those references before crossing the browser boundary.
  const published = JSON.parse(JSON.stringify(result).replaceAll(requestSeed, contentFingerprint)) as MigrationPreparedEvidenceResult;
  const publishedEvidenceContract = {
    ...published.evidenceContract,
    acquisition: {
      ...published.evidenceContract.acquisition,
      runId: contentFingerprint,
    },
  };
  return {
    ...published,
    scopeFingerprint: contentFingerprint,
    evidenceContract: publishedEvidenceContract,
    inventory: {
      ...published.inventory,
      sourceEvidence: published.inventory.sourceEvidence
        ? { ...published.inventory.sourceEvidence, acquisition: { ...published.inventory.sourceEvidence.acquisition, runId: contentFingerprint } }
        : publishedEvidenceContract,
    },
  };
}

function sameNormalizedScope(left: readonly string[], right: readonly string[]): boolean {
  return canonicalJson([...new Set(left)].sort()) === canonicalJson([...new Set(right)].sort());
}

/**
 * Publish one normalized collector result through the shared, content-bound
 * review-token seam. Domo arrives with an earlier content identity rather than
 * the internal request seed; that identity is retained as a hash input, then
 * replaced by the complete prepared-evidence fingerprint at publication.
 */
export function publishMigrationPreparedEvidenceResult(
  connection: SavedPlatformConnection,
  selectedRootIds: readonly unknown[],
  result: MigrationPreparedEvidenceResult,
  additionalSensitiveValues: readonly string[] = [],
): MigrationPreparedEvidenceResult {
  assertSafelyRedactableStoredCredentials(connection);
  const platform = connection.platform as MigrationBiSourceTool;
  const normalizedRoots = normalizeMigrationSourceRootIds(selectedRootIds);
  const requestSeed = migrationSourceRequestSeed({
    connectionId: connection.id,
    connectionUpdatedAt: connection.updatedAt,
    platform,
    selectedRootIds: normalizedRoots,
  });
  if (
    result.connectionId !== connection.id
    || result.connectionUpdatedAt !== connection.updatedAt
    || result.platform !== platform
    || result.evidenceContract.sourceTool !== platform
    || result.inventory.sourceTool !== platform
    || !sameNormalizedScope(result.selectedRootIds, normalizedRoots)
    || !sameNormalizedScope(result.evidenceContract.acquisition.selectedScopeIds, normalizedRoots)
    || (platform !== 'domo' && (
      result.scopeFingerprint !== requestSeed
      || (result.evidenceContract.acquisition.runId != null && result.evidenceContract.acquisition.runId !== requestSeed)
    ))
  ) {
    throw Object.assign(new Error('The prepared source evidence did not match its reviewed connection revision and scope.'), { statusCode: 409 });
  }
  const redacted = redactBrowserEvidence(result, connection, additionalSensitiveValues);
  const contentFingerprint = migrationPreparedEvidenceContentFingerprint({
    connectionId: connection.id,
    connectionUpdatedAt: connection.updatedAt,
    platform,
    selectedRootIds: normalizedRoots,
    requestSeed,
    result: redacted,
  });
  return publishContentFingerprint(redacted, requestSeed, contentFingerprint);
}

/** Publish the legacy Domo DTO with the same review token as its shared DTO. */
export function publishDomoApiEvidenceResult(
  connection: SavedPlatformConnection,
  result: DomoApiEvidenceResult,
  aggregateResponseBytes: number,
): DomoApiEvidenceResult {
  const prepared = domoApiEvidenceToPreparedSourceEvidence(connection, result);
  const published = publishMigrationPreparedEvidenceResult(connection, result.selectedDashboardIds, {
    ...prepared,
    diagnostics: {
      ...prepared.diagnostics,
      bytesRead: aggregateResponseBytes,
      limits: { ...prepared.diagnostics.limits, maxBytes: MAX_PREPARATION_RESPONSE_BYTES },
    },
  });
  const redacted = redactBrowserEvidence(result, connection);
  return {
    ...redacted,
    scopeFingerprint: published.scopeFingerprint,
    parseResult: {
      ...redacted.parseResult,
      inventory: {
        ...redacted.parseResult.inventory,
        sourceEvidence: published.evidenceContract,
      },
    },
  };
}

export async function prepareSavedMigrationSourceEvidence(
  connection: SavedPlatformConnection,
  selectedRootIds: readonly unknown[],
  options: MigrationSourcePreparationOptions = {},
): Promise<MigrationPreparedEvidenceResult> {
  assertSafelyRedactableStoredCredentials(connection);
  if (!SUPPORTED_PLATFORMS.has(connection.platform as MigrationBiSourceTool)) {
    throw Object.assign(new Error(`${connection.platform} does not have a BI Saved API evidence collector. Use Manual Files.`), { statusCode: 409 });
  }
  const sourceIssue = savedSourceAuthenticationIssue(connection);
  if (sourceIssue) throw Object.assign(new Error(sourceIssue), { statusCode: 409 });
  const platform = connection.platform as MigrationBiSourceTool;
  const policy = migrationSourceAuthPolicy(platform);
  const authMode = connection.authMode || policy.primaryAuthMode;
  if (!migrationSourceAuthModeAllowed(platform, authMode)) {
    throw Object.assign(new Error(`${policy.label} Saved API uses an unsupported authentication method. Replace the connection or use Manual Files.`), { statusCode: 409 });
  }
  const normalizedRoots = normalizeMigrationSourceRootIds(selectedRootIds);
  const requestSeed = migrationSourceRequestSeed({
    connectionId: connection.id,
    connectionUpdatedAt: connection.updatedAt,
    platform,
    selectedRootIds: normalizedRoots,
  });
  const withAggregateDiagnostics = (result: MigrationPreparedEvidenceResult, aggregateResponseBytes: number): MigrationPreparedEvidenceResult => ({
    ...result,
    diagnostics: {
      ...result.diagnostics,
      bytesRead: aggregateResponseBytes,
      limits: {
        ...result.diagnostics.limits,
        maxBytes: MAX_PREPARATION_RESPONSE_BYTES,
      },
    },
  });
  const transientSensitiveValues = new Set<string>();
  const registerSensitiveValue = (value: string, label = 'Source authentication'): void => {
    if (Array.from(value).length < 4) {
      throw Object.assign(new Error(`${label} returned a credential too short to handle safely.`), { statusCode: 502 });
    }
    transientSensitiveValues.add(value);
  };
  try {
    const bounded = await withinMigrationSourcePreparationLimits(options, async ({ signal, transport }) => {
      if (platform === 'domo') {
        return prepareDomoSourceEvidence(connection, normalizedRoots, signal, transport);
      }
      const collector = COLLECTORS[platform];
      if (!collector) throw Object.assign(new Error(`${policy.label} does not have a Saved API evidence collector. Use Manual Files.`), { statusCode: 409 });
      const context: MigrationSourceCollectorContext = {
        connection: connectionSnapshot(connection),
        selectedRootIds: normalizedRoots,
        scopeFingerprint: requestSeed,
        transport,
        registerSensitiveValue,
        signal,
      };
      return collector.prepareEvidence(context);
    });
    const result = withAggregateDiagnostics(bounded.result, bounded.aggregateResponseBytes);
    return publishMigrationPreparedEvidenceResult(connection, normalizedRoots, result, [...transientSensitiveValues]);
  } catch (error) {
    throw redactPreparationError(error, connection, [...transientSensitiveValues]);
  }
}

/**
 * Preserve the legacy Domo response contract while applying the same aggregate
 * byte, request, deadline, and cancellation boundary as every Saved API source.
 */
export async function prepareBoundedDomoApiEvidence(
  connection: SavedPlatformConnection,
  selectedDashboardIds: readonly unknown[],
  options: MigrationSourcePreparationOptions = {},
) {
  assertSafelyRedactableStoredCredentials(connection);
  const normalizedRoots = normalizeMigrationSourceRootIds(selectedDashboardIds);
  const bounded = await withinMigrationSourcePreparationLimits(options, ({ signal, transport }) => (
    prepareDomoApiEvidence(connection, normalizedRoots, signal, transport)
  ));
  return publishDomoApiEvidenceResult(connection, bounded.result, bounded.aggregateResponseBytes);
}

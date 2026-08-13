import { createHash } from 'node:crypto';
import { buildMigrationInventory } from '../../../src/services/semanticMigration/adapters';
import type {
  MigrationArtifact,
  MigrationInventory,
  MigrationPreparedEvidenceResult,
  MigrationPreparedEvidenceStatus,
  MigrationSourceArtifactProvenance,
  MigrationSourceDependencyEvidence,
} from '../../../src/services/semanticMigration/types';
import type {
  MigrationSourceCollectorContext,
  MigrationSourceConnectionSnapshot,
  MigrationSourceEvidenceCollector,
  MigrationSourceTransport,
  MigrationSourceTransportResponse,
} from './contracts';

const FABRIC_API_BASE = 'https://api.fabric.microsoft.com/v1';
const POWER_BI_API_BASE = 'https://api.powerbi.com/v1.0/myorg';
const MICROSOFT_LOGIN_BASE = 'https://login.microsoftonline.com';
const FABRIC_SCOPE = 'https://api.fabric.microsoft.com/.default';
const POWER_BI_SCOPE = 'https://analysis.windows.net/powerbi/api/.default';
const FABRIC_OPERATION_STATE_DOCUMENTATION = 'https://learn.microsoft.com/en-us/rest/api/fabric/core/long-running-operations/get-operation-state';
const FABRIC_OPERATION_RESULT_DOCUMENTATION = 'https://learn.microsoft.com/en-us/rest/api/fabric/core/long-running-operations/get-operation-result';
const MAX_SELECTED_ROOTS = 50;
const MAX_INVENTORY_PAGES = 10;
const MAX_INVENTORY_ITEMS = 2_000;
const MAX_LRO_POLLS = 20;
const MAX_LRO_WAIT_SECONDS = 10;
const MAX_DEFINITION_PARTS = 1_000;
const MAX_DEFINITION_RESPONSE_BYTES = 120 * 1024 * 1024;
const MAX_DEFINITION_PART_BYTES = 25 * 1024 * 1024;
const MAX_DEFINITION_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_GOVERNANCE_BYTES = 5 * 1024 * 1024;
const POWER_BI_DOCUMENTATION = [
  'https://learn.microsoft.com/en-us/rest/api/fabric/core/items/list-items',
  'https://learn.microsoft.com/en-us/rest/api/fabric/semanticmodel/items/get-semantic-model-definition',
  'https://learn.microsoft.com/en-us/rest/api/fabric/report/items/get-report-definition',
  'https://learn.microsoft.com/en-us/rest/api/fabric/articles/long-running-operation',
  'https://learn.microsoft.com/en-us/rest/api/fabric/articles/item-management/definitions/report-definition',
  'https://learn.microsoft.com/en-us/rest/api/power-bi/groups/get-group-users',
  'https://learn.microsoft.com/en-us/rest/api/power-bi/datasets/get-dataset-users-in-group',
  'https://learn.microsoft.com/en-us/rest/api/power-bi/datasets/get-refresh-schedule-in-group',
  'https://learn.microsoft.com/en-us/power-bi/enterprise/service-premium-service-principal',
  'https://learn.microsoft.com/en-us/rest/api/power-bi/reports/get-reports-in-group',
  FABRIC_OPERATION_STATE_DOCUMENTATION,
  FABRIC_OPERATION_RESULT_DOCUMENTATION,
] as const;

type PowerBiRootKind = 'semantic_model' | 'report';

interface PowerBiSelectedRoot {
  kind: PowerBiRootKind;
  id: string;
  sourceId: string;
}

interface PowerBiTokens {
  fabric: string;
  powerBi?: string;
}

interface PowerBiTotals {
  requestsMade: number;
  pagesFetched: number;
  bytesRead: number;
  itemsObserved: number;
}

export interface PowerBiFabricDiscoveryItem {
  id: string;
  displayName: string;
  description?: string;
  type: string;
  workspaceId: string;
  folderId?: string;
}

export interface PowerBiFabricInventoryResult {
  items: PowerBiFabricDiscoveryItem[];
  truncated: boolean;
}

export interface PowerBiDiscoveryResult {
  platform: 'power_bi';
  connectionId: string;
  connectionUpdatedAt: string;
  workspaceId: string;
  items: PowerBiFabricDiscoveryItem[];
  complete: boolean;
  truncated: boolean;
  requestsMade: number;
  pagesFetched: number;
  bytesRead: number;
  warnings: string[];
}

interface FabricDefinitionPart {
  path: string;
  bytes: Uint8Array;
  mediaType: string;
  text?: string;
}

interface FabricDefinitionResult {
  root: PowerBiSelectedRoot;
  format?: string;
  artifacts: MigrationArtifact[];
  provenance: MigrationSourceArtifactProvenance[];
  parts: FabricDefinitionPart[];
  warnings: string[];
}

interface PowerBiSupplementalEvidence {
  name: string;
  sourceId: string;
  parentSourceId?: string;
  payload: unknown;
  documentationIds: string[];
}

type PowerBiSupplementalValidation<T> =
  | { valid: true; value: T }
  | { valid: false; permissionGap: string };

const POWER_BI_PRINCIPAL_TYPES = new Set(['None', 'User', 'Group', 'App']);
const POWER_BI_GROUP_ACCESS_RIGHTS = new Set(['None', 'Member', 'Admin', 'Contributor', 'Viewer']);
const POWER_BI_DATASET_ACCESS_RIGHTS = new Set([
  'None',
  'Read',
  'ReadWrite',
  'ReadReshare',
  'ReadWriteReshare',
  'ReadExplore',
  'ReadReshareExplore',
  'ReadWriteExplore',
  'ReadWriteReshareExplore',
]);
const POWER_BI_REFRESH_DAYS = new Set([
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
]);
const POWER_BI_REFRESH_NOTIFY_OPTIONS = new Set(['NoNotification', 'MailOnFailure']);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function header(response: MigrationSourceTransportResponse, name: string): string | undefined {
  const target = name.toLowerCase();
  return Object.entries(response.headers).find(([key]) => key.toLowerCase() === target)?.[1];
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeJson(value: unknown): string {
  return JSON.stringify(value, (_key, child) => child === undefined ? null : child);
}

function powerBiError(message: string, statusCode = 502): Error {
  return Object.assign(new Error(message), { statusCode });
}

function rethrowPowerBiCancellation(error: unknown): void {
  const statusCode = (error as { statusCode?: number })?.statusCode;
  if (statusCode === 499 || statusCode === 504 || (error as { name?: string })?.name === 'AbortError') throw error;
}

function hasUnsafeOpaqueIdentifierCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f || '\\/?#'.includes(character);
  });
}

function observe(totals: PowerBiTotals, response: MigrationSourceTransportResponse): void {
  totals.requestsMade += Math.max(1, response.requestCount || 1);
  totals.bytesRead += response.bytesRead;
}

function assertOpaqueIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 240 || hasUnsafeOpaqueIdentifierCharacter(normalized) || normalized === '.' || normalized === '..') {
    throw powerBiError(`${label} is invalid.`, 400);
  }
  return normalized;
}

function assertMicrosoftTenant(value: string): string {
  const tenant = value.trim();
  if (!tenant || tenant.length > 240 || !/^[A-Za-z0-9.-]+$/.test(tenant) || tenant.startsWith('.') || tenant.endsWith('.')) {
    throw powerBiError('Microsoft Entra tenant ID or verified tenant domain is invalid.', 400);
  }
  return tenant;
}

function parsePowerBiRoot(value: string): PowerBiSelectedRoot {
  const trimmed = value.trim();
  const matched = trimmed.match(/^(semantic_model|semanticmodel|dataset|report):(.+)$/i);
  const rawKind = matched?.[1]?.toLowerCase();
  const kind: PowerBiRootKind = rawKind === 'semantic_model' || rawKind === 'semanticmodel' || rawKind === 'dataset'
    ? 'semantic_model'
    : 'report';
  const id = assertOpaqueIdentifier(matched?.[2] || trimmed, `Power BI ${kind.replace('_', ' ')} ID`);
  return { kind, id, sourceId: `power_bi:${kind}:${id}` };
}

function assertPowerBiConnection(connection: MigrationSourceConnectionSnapshot): void {
  if (connection.platform !== 'power_bi') throw powerBiError('The Power BI collector requires a Power BI/Fabric connection.', 400);
  if (!connection.workspaceId) throw powerBiError('A Fabric workspace ID is required for selected-scope evidence.', 409);
  assertOpaqueIdentifier(connection.workspaceId, 'Fabric workspace ID');
  if (connection.authMode === 'oauth_access_token') {
    if (!connection.credential) throw powerBiError('A Microsoft Entra OAuth access token for the Fabric API audience is required.', 409);
    if (!connection.credentialExpiresAt) throw powerBiError('The Microsoft Entra OAuth access-token expiration is required.', 409);
    if (!Number.isFinite(Date.parse(connection.credentialExpiresAt))) throw powerBiError('The Microsoft Entra OAuth access-token expiration is invalid.', 409);
    if (Date.parse(connection.credentialExpiresAt) <= Date.now()) {
      throw powerBiError('The saved Microsoft Entra OAuth access token has expired and must be replaced.', 409);
    }
    return;
  }
  if (connection.authMode === 'oauth_client_credentials') {
    if (!connection.accountIdentifier || !connection.clientId || !connection.credential) {
      throw powerBiError('Power BI service-principal authentication requires a Microsoft Entra tenant, client ID, and client secret.', 409);
    }
    assertMicrosoftTenant(connection.accountIdentifier);
    assertOpaqueIdentifier(connection.clientId, 'Microsoft Entra client ID');
    if (connection.credential.length > 16_384 || /[\r\n]/.test(connection.credential)) {
      throw powerBiError('The saved Microsoft Entra client secret is invalid and must be replaced.', 409);
    }
    return;
  }
  throw powerBiError('Power BI Saved API requires an Entra OAuth access token or service-principal client credentials.', 409);
}

async function exchangeClientCredentials(
  connection: MigrationSourceConnectionSnapshot,
  scope: string,
  label: string,
  transport: MigrationSourceTransport,
  totals: PowerBiTotals,
  signal?: AbortSignal,
): Promise<string> {
  const tenant = assertMicrosoftTenant(connection.accountIdentifier || '');
  const response = await transport.request<Record<string, unknown>>({
    url: `${MICROSOFT_LOGIN_BASE}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`,
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: connection.clientId || '',
      client_secret: connection.credential || '',
      grant_type: 'client_credentials',
      scope,
    }).toString(),
    responseType: 'json',
    label,
    allowStatuses: [200, 400, 401, 403],
    maxResponseBytes: 512 * 1024,
    signal,
  });
  observe(totals, response);
  if (response.status !== 200) {
    throw powerBiError('Microsoft Entra rejected the saved service-principal credentials or requested API scope. Replace the credential and verify tenant consent.', 409);
  }
  const accessToken = nonEmptyString(record(response.body).access_token);
  if (!accessToken) throw powerBiError('Microsoft Entra returned an incomplete token response.');
  return accessToken;
}

async function acquirePowerBiTokens(
  connection: MigrationSourceConnectionSnapshot,
  transport: MigrationSourceTransport,
  totals: PowerBiTotals,
  signal?: AbortSignal,
): Promise<PowerBiTokens> {
  assertPowerBiConnection(connection);
  if (connection.authMode === 'oauth_access_token') {
    // One delegated token is audience-bound. The saved token is used only for
    // the Fabric API; it must never be replayed to api.powerbi.com under the
    // assumption that the two Microsoft resource audiences are interchangeable.
    return { fabric: connection.credential || '' };
  }
  const [fabric, powerBi] = await Promise.all([
    exchangeClientCredentials(connection, FABRIC_SCOPE, 'Microsoft Entra Fabric service-principal token exchange', transport, totals, signal),
    exchangeClientCredentials(connection, POWER_BI_SCOPE, 'Microsoft Entra Power BI service-principal token exchange', transport, totals, signal)
      .catch(() => undefined),
  ]);
  return { fabric, powerBi };
}

function bearer(token: string): Record<string, string> {
  return { Accept: 'application/json', Authorization: `Bearer ${token}` };
}

function fabricWorkspaceUrl(workspaceId: string, suffix: string): string {
  return `${FABRIC_API_BASE}/workspaces/${encodeURIComponent(workspaceId)}${suffix}`;
}

function safeFabricContinuation(current: string, continuation: string): string {
  const currentUrl = new URL(current);
  const next = new URL(continuation, currentUrl);
  if (
    next.protocol !== 'https:'
    || next.hostname.toLowerCase() !== 'api.fabric.microsoft.com'
    || next.port
    || next.username
    || next.password
    || !next.pathname.startsWith('/v1/')
  ) {
    throw powerBiError('Fabric returned an unsafe cross-origin continuation URL. Evidence collection stopped before forwarding credentials.');
  }
  next.hash = '';
  return next.toString();
}

function normalizeFabricItem(value: unknown, workspaceId: string): PowerBiFabricDiscoveryItem | undefined {
  const item = record(value);
  const id = nonEmptyString(item.id);
  const displayName = nonEmptyString(item.displayName) || nonEmptyString(item.name);
  const type = nonEmptyString(item.type);
  if (!id || !displayName || !type) return undefined;
  return {
    id,
    displayName,
    type,
    workspaceId: nonEmptyString(item.workspaceId) || workspaceId,
    description: nonEmptyString(item.description),
    folderId: nonEmptyString(item.folderId),
  };
}

/** Bounded Fabric catalog discovery. It proves selectable IDs, not source definitions. */
export async function listPowerBiFabricItems(input: {
  workspaceId: string;
  accessToken: string;
  transport: MigrationSourceTransport;
  totals?: PowerBiTotals;
  signal?: AbortSignal;
}): Promise<PowerBiFabricInventoryResult> {
  const workspaceId = assertOpaqueIdentifier(input.workspaceId, 'Fabric workspace ID');
  const totals = input.totals || { requestsMade: 0, pagesFetched: 0, bytesRead: 0, itemsObserved: 0 };
  const items: PowerBiFabricDiscoveryItem[] = [];
  const seen = new Set<string>();
  let url = fabricWorkspaceUrl(workspaceId, '/items?recursive=true');
  let truncated = false;
  for (let page = 0; page < MAX_INVENTORY_PAGES; page += 1) {
    const response = await input.transport.request<Record<string, unknown>>({
      url,
      headers: bearer(input.accessToken),
      responseType: 'json',
      label: 'Fabric selected-workspace item inventory',
      allowStatuses: [200, 401, 403, 404, 429],
      maxResponseBytes: MAX_GOVERNANCE_BYTES,
      signal: input.signal,
    });
    observe(totals, response);
    totals.pagesFetched += 1;
    if (response.status !== 200) {
      throw powerBiError(response.status === 401 || response.status === 403
        ? 'Fabric rejected the saved identity or it lacks access to the selected workspace.'
        : response.status === 404
          ? 'The selected Fabric workspace was not found.'
          : 'Fabric workspace inventory could not be completed.');
    }
    if (!response.body || typeof response.body !== 'object' || Array.isArray(response.body)) {
      throw powerBiError('Fabric workspace inventory returned an unrecognized HTTP-200 envelope; the catalog was not treated as empty.');
    }
    const payload = response.body as Record<string, unknown>;
    if (!Array.isArray(payload.value)) {
      throw powerBiError('Fabric workspace inventory HTTP-200 response did not contain the documented value array; the catalog was not treated as empty.');
    }
    for (const key of ['continuationUri', 'continuationToken'] as const) {
      const continuation = payload[key];
      if (continuation !== undefined && continuation !== null && typeof continuation !== 'string') {
        throw powerBiError(`Fabric workspace inventory returned an invalid ${key}; the catalog is incomplete.`);
      }
    }
    const normalizedRows = payload.value.map((value, index) => {
      const item = normalizeFabricItem(value, workspaceId);
      if (!item) {
        throw powerBiError(`Fabric workspace inventory returned an invalid item record at index ${index}; the catalog is incomplete.`);
      }
      return item;
    });
    for (const item of normalizedRows) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
      if (items.length >= MAX_INVENTORY_ITEMS) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
    const continuationUri = nonEmptyString(payload.continuationUri);
    const continuationToken = nonEmptyString(payload.continuationToken);
    if (!continuationUri && !continuationToken) break;
    if (page === MAX_INVENTORY_PAGES - 1) {
      truncated = true;
      break;
    }
    if (continuationUri) {
      url = safeFabricContinuation(url, continuationUri);
    } else {
      const next = new URL(fabricWorkspaceUrl(workspaceId, '/items'));
      next.searchParams.set('recursive', 'true');
      next.searchParams.set('continuationToken', continuationToken || '');
      url = next.toString();
    }
  }
  totals.itemsObserved += items.length;
  return { items, truncated };
}

/**
 * Authenticated Fabric catalog discovery. It exchanges service-principal
 * credentials server-side where configured and never returns an access token.
 * The returned item list remains discovery metadata until prepared evidence is
 * collected for an exact selected scope.
 */
export async function discoverPowerBiSource(
  connection: MigrationSourceConnectionSnapshot,
  transport: MigrationSourceTransport,
  signal?: AbortSignal,
): Promise<PowerBiDiscoveryResult> {
  assertPowerBiConnection(connection);
  const workspaceId = assertOpaqueIdentifier(connection.workspaceId || '', 'Fabric workspace ID');
  const totals: PowerBiTotals = { requestsMade: 0, pagesFetched: 0, bytesRead: 0, itemsObserved: 0 };
  const tokens = await acquirePowerBiTokens(connection, transport, totals, signal);
  const inventory = await listPowerBiFabricItems({
    workspaceId,
    accessToken: tokens.fabric,
    transport,
    totals,
    signal,
  });
  return {
    platform: 'power_bi',
    connectionId: connection.id,
    connectionUpdatedAt: connection.updatedAt,
    workspaceId,
    items: inventory.items,
    complete: !inventory.truncated,
    truncated: inventory.truncated,
    requestsMade: totals.requestsMade,
    pagesFetched: totals.pagesFetched,
    bytesRead: totals.bytesRead,
    warnings: inventory.truncated
      ? ['Fabric workspace inventory reached its bounded page or item limit. Narrow the saved workspace scope before planning.']
      : [],
  };
}

interface FabricOperationLocation {
  url: string;
  operationId: string;
  result: boolean;
}

function safeFabricOperationLocation(value: string): FabricOperationLocation {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw powerBiError('Fabric returned an invalid long-running operation URL.');
  }
  const pathMatch = parsed.pathname.match(/^\/(?:v1\/)?operations\/([A-Za-z0-9-]+)(\/result)?$/);
  if (
    parsed.protocol !== 'https:'
    || parsed.hostname.toLowerCase() !== 'api.fabric.microsoft.com'
    || parsed.port
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || !pathMatch
  ) {
    throw powerBiError('Fabric returned an unsafe long-running operation URL. Evidence collection stopped before forwarding credentials.');
  }
  const operationId = pathMatch[1]!;
  const result = Boolean(pathMatch[2]);
  // Fabric has emitted documented Location values both with and without the
  // version segment. Normalize either exact path to the canonical v1 origin.
  return {
    url: `${FABRIC_API_BASE}/operations/${operationId}${result ? '/result' : ''}`,
    operationId,
    result,
  };
}

function safeOperationUrl(value: string): string {
  return safeFabricOperationLocation(value).url;
}

function retryAfterSeconds(response: MigrationSourceTransportResponse): number {
  const seconds = Number(header(response, 'retry-after') || 1);
  return Number.isFinite(seconds) ? Math.max(0, Math.min(MAX_LRO_WAIT_SECONDS, Math.floor(seconds))) : 1;
}

async function boundedWait(seconds: number, signal?: AbortSignal): Promise<void> {
  if (seconds <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      reject(Object.assign(new Error('Fabric evidence preparation was cancelled.'), { name: 'AbortError' }));
    };
    if (signal?.aborted) {
      reject(Object.assign(new Error('Fabric evidence preparation was cancelled.'), { name: 'AbortError' }));
      return;
    }
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, seconds * 1_000);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

async function resolveFabricDefinitionResponse(
  initial: MigrationSourceTransportResponse<Record<string, unknown>>,
  token: string,
  transport: MigrationSourceTransport,
  totals: PowerBiTotals,
  signal?: AbortSignal,
): Promise<{ body: Record<string, unknown>; documentationIds: string[] }> {
  if (initial.status === 200) return { body: record(initial.body), documentationIds: [] };
  if (initial.status !== 202) {
    if (initial.status === 400 || initial.status === 403 || initial.status === 409) {
      throw powerBiError('Fabric could not return this item definition. Encrypted sensitivity labels, insufficient read/write permission, or unsupported item formats require PBIP/PBIX Manual Files.', 403);
    }
    if (initial.status === 401) throw powerBiError('Fabric rejected the saved Microsoft Entra identity.', 401);
    if (initial.status === 404) throw powerBiError('The selected Fabric item was not found.', 404);
    if (initial.status === 429) throw powerBiError('Fabric rate-limited definition retrieval. Narrow the selected scope and retry.', 429);
    throw powerBiError('Fabric definition retrieval failed.');
  }

  const operationId = nonEmptyString(header(initial, 'x-ms-operation-id'));
  const location = nonEmptyString(header(initial, 'location'));
  if (!operationId && !location) throw powerBiError('Fabric accepted definition retrieval without returning a documented operation locator.');
  const locationDetails = location ? safeFabricOperationLocation(location) : undefined;
  if (locationDetails?.result) throw powerBiError('Fabric returned an operation-result URL where an operation-state URL was required.');
  if (operationId && locationDetails && operationId !== locationDetails.operationId) {
    throw powerBiError('Fabric returned conflicting long-running operation identifiers. Evidence collection failed closed.');
  }
  const resolvedOperationId = operationId || locationDetails?.operationId;
  if (!resolvedOperationId) throw powerBiError('Fabric did not return a usable long-running operation identifier.');
  const statusUrl = locationDetails?.url || safeOperationUrl(`${FABRIC_API_BASE}/operations/${resolvedOperationId}`);
  for (let poll = 0; poll < MAX_LRO_POLLS; poll += 1) {
    await boundedWait(poll === 0 ? retryAfterSeconds(initial) : 1, signal);
    const stateResponse = await transport.request<Record<string, unknown>>({
      url: statusUrl,
      headers: bearer(token),
      responseType: 'json',
      label: 'Fabric definition long-running operation state',
      allowStatuses: [200, 401, 403, 404, 429],
      maxResponseBytes: 1 * 1024 * 1024,
      signal,
    });
    observe(totals, stateResponse);
    if (stateResponse.status === 429) {
      await boundedWait(retryAfterSeconds(stateResponse), signal);
      continue;
    }
    if (stateResponse.status !== 200) throw powerBiError('Fabric definition operation state could not be verified.');
    const state = record(stateResponse.body);
    const status = nonEmptyString(state.status)?.toLowerCase();
    if (status === 'failed' || status === 'cancelled') {
      throw powerBiError('Fabric definition retrieval failed. Use PBIP/PBIX Manual Files if the item is unsupported or sensitivity-label protected.', 422);
    }
    if (status === 'succeeded') {
      const resultLocation = nonEmptyString(header(stateResponse, 'location'));
      const resultLocationDetails = resultLocation ? safeFabricOperationLocation(resultLocation) : undefined;
      if (resultLocationDetails && resultLocationDetails.operationId !== resolvedOperationId) {
        throw powerBiError('Fabric returned a result URL for a different long-running operation. Evidence collection failed closed.');
      }
      const resultUrl = resultLocationDetails?.result
        ? resultLocationDetails.url
        : safeOperationUrl(`${FABRIC_API_BASE}/operations/${resolvedOperationId}/result`);
      const result = await transport.request<Record<string, unknown>>({
        url: resultUrl,
        headers: bearer(token),
        responseType: 'json',
        label: 'Fabric definition long-running operation result',
        allowStatuses: [200, 401, 403, 404, 429],
        maxResponseBytes: MAX_DEFINITION_RESPONSE_BYTES,
        signal,
      });
      observe(totals, result);
      if (result.status !== 200) throw powerBiError('Fabric completed definition retrieval but the operation result could not be read.');
      return {
        body: record(result.body),
        documentationIds: [FABRIC_OPERATION_STATE_DOCUMENTATION, FABRIC_OPERATION_RESULT_DOCUMENTATION],
      };
    }
    if (status && status !== 'running' && status !== 'notstarted' && status !== 'not_started') {
      throw powerBiError('Fabric returned an unknown long-running operation state. Evidence collection failed closed.');
    }
  }
  throw powerBiError('Fabric definition retrieval exceeded the 20-poll safety bound. Narrow the scope and retry.', 504);
}

function strictBase64(value: string, path: string): Uint8Array {
  const compact = value.replace(/\s+/g, '');
  if (!compact || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact)) {
    throw powerBiError(`Fabric definition part ${path} did not contain valid InlineBase64 data.`, 422);
  }
  const normalized = compact.replaceAll('-', '+').replaceAll('_', '/');
  const padding = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + '='.repeat(padding);
  const bytes = Buffer.from(padded, 'base64');
  const roundTrip = bytes.toString('base64').replace(/=+$/, '');
  if (roundTrip !== normalized.replace(/=+$/, '')) {
    throw powerBiError(`Fabric definition part ${path} failed base64 integrity validation.`, 422);
  }
  return bytes;
}

function safeDefinitionPath(value: unknown): string {
  const path = nonEmptyString(value)?.replaceAll('\\', '/');
  if (!path || path.length > 500 || path.startsWith('/') || path.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw powerBiError('Fabric definition contained an unsafe or invalid part path.', 422);
  }
  return path;
}

function textPart(path: string, bytes: Uint8Array): { text?: string; mediaType: string } {
  const lower = path.toLowerCase();
  const textual = lower.endsWith('.json')
    || lower.endsWith('.tmdl')
    || lower.endsWith('.tmsl')
    || lower.endsWith('.pbism')
    || lower.endsWith('.pbir')
    || lower.endsWith('.platform')
    || lower === 'report.json';
  if (!textual) return { mediaType: 'application/octet-stream' };
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { text, mediaType: lower.endsWith('.json') || lower.endsWith('.pbir') || lower.endsWith('.pbism') || lower.endsWith('.platform') ? 'application/json' : 'text/plain' };
  } catch {
    throw powerBiError(`Fabric definition part ${path} was expected to be UTF-8 text.`, 422);
  }
}

function parseFabricDefinition(
  root: PowerBiSelectedRoot,
  payload: Record<string, unknown>,
  displayName: string,
  acquisitionDocumentationIds: readonly string[] = [],
): FabricDefinitionResult {
  const definition = record(payload.definition);
  const rawParts = Array.isArray(definition.parts) ? definition.parts : [];
  if (rawParts.length === 0) throw powerBiError(`Fabric returned no public definition parts for ${root.kind.replace('_', ' ')} ${root.id}.`, 422);
  if (rawParts.length > MAX_DEFINITION_PARTS) throw powerBiError('Fabric definition exceeded the 1,000-part safety limit.', 413);
  const artifacts: MigrationArtifact[] = [];
  const provenance: MigrationSourceArtifactProvenance[] = [];
  const parts: FabricDefinitionPart[] = [];
  const warnings: string[] = [];
  const seenPaths = new Set<string>();
  let totalBytes = 0;
  for (const rawPart of rawParts) {
    const part = record(rawPart);
    const path = safeDefinitionPath(part.path);
    const pathKey = path.toLowerCase();
    if (seenPaths.has(pathKey)) throw powerBiError('Fabric definition contained duplicate part paths.', 422);
    seenPaths.add(pathKey);
    if (part.payloadType !== 'InlineBase64') {
      throw powerBiError(`Fabric definition part ${path} used an unsupported payload type. Evidence collection failed closed.`, 422);
    }
    const payloadText = nonEmptyString(part.payload);
    if (!payloadText) throw powerBiError(`Fabric definition part ${path} was empty.`, 422);
    const bytes = strictBase64(payloadText, path);
    if (bytes.byteLength > MAX_DEFINITION_PART_BYTES) throw powerBiError(`Fabric definition part ${path} exceeded the 25 MB safety limit.`, 413);
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_DEFINITION_TOTAL_BYTES) throw powerBiError('Fabric definition exceeded the 100 MB aggregate safety limit.', 413);
    const decoded = textPart(path, bytes);
    parts.push({ path, bytes, mediaType: decoded.mediaType, text: decoded.text });
    provenance.push({
      id: `${root.sourceId}:definition:${sha256(path).slice(0, 16)}`,
      name: `${displayName}/${path}`,
      sourceId: `${root.sourceId}:part:${path}`,
      parentSourceId: root.sourceId,
      locator: `${root.kind}:${root.id}:definition:${path}`,
      mediaType: decoded.mediaType,
      evidenceClass: 'authoritative_definition',
      sha256: sha256(bytes),
      sizeBytes: bytes.byteLength,
      documentationIds: Array.from(new Set([
        root.kind === 'semantic_model' ? POWER_BI_DOCUMENTATION[1] : POWER_BI_DOCUMENTATION[2],
        ...acquisitionDocumentationIds,
      ])),
      rawContentIncluded: false,
    });
    if (decoded.text !== undefined) {
      artifacts.push({
        id: `power-bi-api-${root.kind}-${sha256(`${root.id}:${path}`).slice(0, 16)}`,
        sourceTool: 'power_bi',
        name: `${displayName}/${path}`,
        kind: path.toLowerCase().endsWith('.json') || path.toLowerCase().endsWith('.pbir') || path.toLowerCase().endsWith('.pbism') || path.toLowerCase().endsWith('.platform') ? 'json' : 'text',
        content: decoded.text,
        sizeBytes: bytes.byteLength,
        parseWarnings: [],
      });
    } else {
      warnings.push(`Fabric definition resource ${path} was fingerprinted but not parsed because it is binary.`);
    }
  }
  return { root, format: nonEmptyString(definition.format), artifacts, provenance, parts, warnings };
}

async function getFabricDefinition(
  root: PowerBiSelectedRoot,
  displayName: string,
  workspaceId: string,
  accessToken: string,
  transport: MigrationSourceTransport,
  totals: PowerBiTotals,
  signal?: AbortSignal,
): Promise<FabricDefinitionResult> {
  const suffix = root.kind === 'semantic_model'
    ? `/semanticModels/${encodeURIComponent(root.id)}/getDefinition?format=TMDL`
    : `/reports/${encodeURIComponent(root.id)}/getDefinition`;
  const initial = await transport.request<Record<string, unknown>>({
    url: fabricWorkspaceUrl(workspaceId, suffix),
    method: 'POST',
    headers: bearer(accessToken),
    responseType: 'json',
    label: `Fabric ${root.kind.replace('_', ' ')} public definition`,
    allowStatuses: [200, 202, 400, 401, 403, 404, 409, 429],
    maxResponseBytes: MAX_DEFINITION_RESPONSE_BYTES,
    signal,
  });
  observe(totals, initial);
  const resolved = await resolveFabricDefinitionResponse(initial, accessToken, transport, totals, signal);
  const definition = parseFabricDefinition(root, resolved.body, displayName, resolved.documentationIds);
  totals.itemsObserved += definition.parts.length;
  return definition;
}

async function optionalPowerBiJson(input: {
  url: string;
  token: string;
  label: string;
  transport: MigrationSourceTransport;
  totals: PowerBiTotals;
  signal?: AbortSignal;
}): Promise<{ status: number; body?: unknown }> {
  try {
    const response = await input.transport.request({
      url: input.url,
      headers: bearer(input.token),
      responseType: 'json',
      label: input.label,
      allowStatuses: [200, 400, 401, 403, 404, 429],
      maxResponseBytes: MAX_GOVERNANCE_BYTES,
      signal: input.signal,
    });
    observe(input.totals, response);
    return { status: response.status, body: response.status === 200 ? response.body : undefined };
  } catch {
    return { status: 502 };
  }
}

function malformedPowerBiSupplemental<T>(label: string, detail: string): PowerBiSupplementalValidation<T> {
  return {
    valid: false,
    permissionGap: `${label} returned malformed HTTP-200 governance evidence (${detail}). The response was not fingerprinted or treated as verified empty.`,
  };
}

function validatePowerBiODataCollection(
  payload: unknown,
  label: string,
  validateRow: (row: Record<string, unknown>, index: number) => string | undefined,
): PowerBiSupplementalValidation<Record<string, unknown>[]> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return malformedPowerBiSupplemental(label, 'the documented OData object envelope was missing');
  }
  const envelope = payload as Record<string, unknown>;
  if (!Array.isArray(envelope.value)) {
    return malformedPowerBiSupplemental(label, 'the documented value array was missing');
  }
  if (envelope['@odata.context'] !== undefined && typeof envelope['@odata.context'] !== 'string') {
    return malformedPowerBiSupplemental(label, '@odata.context was not a string');
  }
  const rows: Record<string, unknown>[] = [];
  for (let index = 0; index < envelope.value.length; index += 1) {
    const value = envelope.value[index];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return malformedPowerBiSupplemental(label, `value[${index}] was not an object`);
    }
    const row = value as Record<string, unknown>;
    const invalid = validateRow(row, index);
    if (invalid) return malformedPowerBiSupplemental(label, invalid);
    rows.push(row);
  }
  return { valid: true, value: rows };
}

function validatePowerBiWorkspaceUsers(payload: unknown): PowerBiSupplementalValidation<Record<string, unknown>[]> {
  return validatePowerBiODataCollection(payload, 'Power BI workspace principals', (row, index) => {
    if (!nonEmptyString(row.identifier)) return `value[${index}].identifier was missing`;
    const principalType = nonEmptyString(row.principalType);
    if (!principalType || !POWER_BI_PRINCIPAL_TYPES.has(principalType)) {
      return `value[${index}].principalType was missing or unsupported`;
    }
    const accessRight = nonEmptyString(row.groupUserAccessRight);
    if (!accessRight || !POWER_BI_GROUP_ACCESS_RIGHTS.has(accessRight)) {
      return `value[${index}].groupUserAccessRight was missing or unsupported`;
    }
    return undefined;
  });
}

function validatePowerBiReports(payload: unknown): PowerBiSupplementalValidation<Record<string, unknown>[]> {
  return validatePowerBiODataCollection(payload, 'Power BI report metadata', (row, index) => {
    if (!nonEmptyString(row.id)) return `value[${index}].id was missing`;
    if (!nonEmptyString(row.name)) return `value[${index}].name was missing`;
    if (row.datasetId !== undefined && !nonEmptyString(row.datasetId)) {
      return `value[${index}].datasetId was present but invalid`;
    }
    return undefined;
  });
}

function validatePowerBiDatasetUsers(
  payload: unknown,
  modelId: string,
): PowerBiSupplementalValidation<Record<string, unknown>[]> {
  return validatePowerBiODataCollection(payload, `Power BI semantic model ${modelId} principals`, (row, index) => {
    if (!nonEmptyString(row.identifier)) return `value[${index}].identifier was missing`;
    const principalType = nonEmptyString(row.principalType);
    if (!principalType || !POWER_BI_PRINCIPAL_TYPES.has(principalType)) {
      return `value[${index}].principalType was missing or unsupported`;
    }
    const accessRight = nonEmptyString(row.datasetUserAccessRight);
    if (!accessRight || !POWER_BI_DATASET_ACCESS_RIGHTS.has(accessRight)) {
      return `value[${index}].datasetUserAccessRight was missing or unsupported`;
    }
    return undefined;
  });
}

function validatePowerBiRefreshSchedule(
  payload: unknown,
  modelId: string,
): PowerBiSupplementalValidation<Record<string, unknown>> {
  const label = `Power BI semantic model ${modelId} refresh schedule`;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return malformedPowerBiSupplemental(label, 'the documented refresh-schedule object was missing');
  }
  const schedule = payload as Record<string, unknown>;
  if (typeof schedule.enabled !== 'boolean') {
    return malformedPowerBiSupplemental(label, 'enabled was not a boolean');
  }
  if (!Array.isArray(schedule.days) || !schedule.days.every((day) => typeof day === 'string' && POWER_BI_REFRESH_DAYS.has(day))) {
    return malformedPowerBiSupplemental(label, 'days was not an array of documented weekday values');
  }
  if (!Array.isArray(schedule.times) || !schedule.times.every((time) => typeof time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))) {
    return malformedPowerBiSupplemental(label, 'times was not an array of documented 24-hour HH:mm values');
  }
  if (schedule.localTimeZoneId !== undefined && !nonEmptyString(schedule.localTimeZoneId)) {
    return malformedPowerBiSupplemental(label, 'localTimeZoneId was present but invalid');
  }
  if (schedule.notifyOption !== undefined) {
    const notifyOption = nonEmptyString(schedule.notifyOption);
    if (!notifyOption || !POWER_BI_REFRESH_NOTIFY_OPTIONS.has(notifyOption)) {
      return malformedPowerBiSupplemental(label, 'notifyOption was present but unsupported');
    }
  }
  return { valid: true, value: schedule };
}

async function collectPowerBiSupplementalEvidence(
  roots: PowerBiSelectedRoot[],
  workspaceId: string,
  token: string | undefined,
  transport: MigrationSourceTransport,
  totals: PowerBiTotals,
  signal?: AbortSignal,
): Promise<{ evidence: PowerBiSupplementalEvidence[]; permissionGaps: string[]; warnings: string[]; reportDatasetIds: Map<string, string> }> {
  const evidence: PowerBiSupplementalEvidence[] = [];
  const permissionGaps: string[] = [];
  const warnings: string[] = [];
  const reportDatasetIds = new Map<string, string>();
  if (!token) {
    permissionGaps.push('A separately audience-bound Power BI REST API token was unavailable. The saved delegated token is Fabric-only, so workspace permissions, semantic-model permissions, report bindings, and refresh schedules require manual review; service-principal connections exchange both audiences independently.');
    return { evidence, permissionGaps, warnings, reportDatasetIds };
  }

  const [workspaceUsers, reports] = await Promise.all([
    optionalPowerBiJson({
      url: `${POWER_BI_API_BASE}/groups/${encodeURIComponent(workspaceId)}/users?$top=1000`, token,
      label: 'Power BI workspace principals', transport, totals, signal,
    }),
    optionalPowerBiJson({
      url: `${POWER_BI_API_BASE}/groups/${encodeURIComponent(workspaceId)}/reports`, token,
      label: 'Power BI workspace report metadata', transport, totals, signal,
    }),
  ]);
  if (workspaceUsers.status === 200) {
    const validated = validatePowerBiWorkspaceUsers(workspaceUsers.body);
    if (validated.valid) {
      evidence.push({
        name: 'Power BI workspace principals', sourceId: `power_bi:workspace:${workspaceId}:principals`,
        payload: workspaceUsers.body, documentationIds: [POWER_BI_DOCUMENTATION[5]],
      });
    } else {
      permissionGaps.push(validated.permissionGap);
    }
  } else {
    permissionGaps.push('Power BI workspace principals could not be verified with the saved identity.');
  }
  if (reports.status === 200) {
    const validated = validatePowerBiReports(reports.body);
    if (validated.valid) {
      evidence.push({
        name: 'Power BI report metadata', sourceId: `power_bi:workspace:${workspaceId}:reports`,
        payload: reports.body, documentationIds: [POWER_BI_DOCUMENTATION[9]],
      });
      for (const item of validated.value) {
        const reportId = nonEmptyString(item.id);
        const datasetId = nonEmptyString(item.datasetId);
        if (reportId && datasetId) reportDatasetIds.set(reportId, datasetId);
      }
    } else {
      permissionGaps.push(validated.permissionGap);
    }
  } else {
    warnings.push('Power BI report-to-semantic-model references could not be cross-checked through the supplemental API.');
  }

  for (const root of roots.filter((candidate) => candidate.kind === 'semantic_model')) {
    const modelEvidence = await collectPowerBiSemanticModelSupplementalEvidence(
      [root.id], workspaceId, token, transport, totals, signal,
    );
    evidence.push(...modelEvidence.evidence);
    permissionGaps.push(...modelEvidence.permissionGaps);
  }
  return { evidence, permissionGaps, warnings, reportDatasetIds };
}

async function collectPowerBiSemanticModelSupplementalEvidence(
  modelIds: string[],
  workspaceId: string,
  token: string,
  transport: MigrationSourceTransport,
  totals: PowerBiTotals,
  signal?: AbortSignal,
): Promise<{ evidence: PowerBiSupplementalEvidence[]; permissionGaps: string[] }> {
  const evidence: PowerBiSupplementalEvidence[] = [];
  const permissionGaps: string[] = [];
  for (const modelId of Array.from(new Set(modelIds)).sort()) {
    const sourceId = `power_bi:semantic_model:${modelId}`;
    const base = `${POWER_BI_API_BASE}/groups/${encodeURIComponent(workspaceId)}/datasets/${encodeURIComponent(modelId)}`;
    const [users, schedule] = await Promise.all([
      optionalPowerBiJson({ url: `${base}/users`, token, label: 'Power BI semantic model principals', transport, totals, signal }),
      optionalPowerBiJson({ url: `${base}/refreshSchedule`, token, label: 'Power BI semantic model refresh schedule', transport, totals, signal }),
    ]);
    if (users.status === 200) {
      const validated = validatePowerBiDatasetUsers(users.body, modelId);
      if (validated.valid) {
        evidence.push({
          name: `Semantic model ${modelId} principals`, sourceId: `${sourceId}:principals`, parentSourceId: sourceId,
          payload: users.body, documentationIds: [POWER_BI_DOCUMENTATION[6]],
        });
      } else {
        permissionGaps.push(validated.permissionGap);
      }
    } else {
      permissionGaps.push(`Power BI semantic model ${modelId} principals could not be verified.`);
    }
    if (schedule.status === 200) {
      const validated = validatePowerBiRefreshSchedule(schedule.body, modelId);
      if (validated.valid) {
        evidence.push({
          name: `Semantic model ${modelId} refresh schedule`, sourceId: `${sourceId}:refresh-schedule`, parentSourceId: sourceId,
          payload: schedule.body, documentationIds: [POWER_BI_DOCUMENTATION[7]],
        });
      } else {
        permissionGaps.push(validated.permissionGap);
      }
    } else if (schedule.status !== 404) {
      permissionGaps.push(`Power BI semantic model ${modelId} refresh schedule could not be verified.`);
    }
  }
  return { evidence, permissionGaps };
}

function supplementalProvenance(item: PowerBiSupplementalEvidence): MigrationSourceArtifactProvenance {
  const payload = safeJson(item.payload);
  return {
    id: item.sourceId,
    name: item.name,
    sourceId: item.sourceId,
    parentSourceId: item.parentSourceId,
    locator: item.sourceId,
    mediaType: 'application/json',
    evidenceClass: 'governance_evidence',
    sha256: sha256(payload),
    sizeBytes: Buffer.byteLength(payload, 'utf8'),
    documentationIds: item.documentationIds,
    rawContentIncluded: false,
  };
}

function extractSemanticModelReferences(definition: FabricDefinitionResult): string[] {
  if (definition.root.kind !== 'report') return [];
  const references = new Set<string>();
  for (const part of definition.parts) {
    if (!part.text) continue;
    for (const match of part.text.matchAll(/semanticmodelid\s*=\s*([A-Za-z0-9-]+)/gi)) references.add(match[1]);
    try {
      const parsed = JSON.parse(part.text) as unknown;
      const queue: unknown[] = [parsed];
      while (queue.length > 0) {
        const current = queue.pop();
        if (Array.isArray(current)) queue.push(...current);
        else if (current && typeof current === 'object') {
          for (const [key, value] of Object.entries(current as Record<string, unknown>)) {
            if (/^(semanticModelId|datasetId)$/i.test(key) && typeof value === 'string' && value.trim()) references.add(value.trim());
            else queue.push(value);
          }
        }
      }
    } catch {
      // TMDL and other text parts are searched with the documented connection-string pattern above.
    }
  }
  return [...references];
}

function reportBehaviorReviewRequirement(definition: FabricDefinitionResult): string {
  const reportedFormat = definition.format?.trim();
  const formatLabel = reportedFormat?.toLowerCase() === 'pbir'
    ? 'supported PBIR public-definition format'
    : reportedFormat
      ? `${reportedFormat} public-definition format`
      : 'Fabric public-definition format';
  return `Fabric report ${definition.root.id} was acquired in the ${formatLabel}. Definition retrieval does not prove rendering or interaction equivalence; review visuals, bookmarks, custom visuals, formatting, interactions, and semantic-model binding before Apply to Dev.`;
}

function buildDependencies(
  roots: PowerBiSelectedRoot[],
  definitions: FabricDefinitionResult[],
  reportDatasetIds: Map<string, string>,
  permissionGaps: string[],
): MigrationSourceDependencyEvidence[] {
  const resolvedRoots = new Set(definitions.map((definition) => definition.root.sourceId));
  const resolvedModels = new Set(definitions.filter((definition) => definition.root.kind === 'semantic_model').map((definition) => definition.root.id));
  const dependencies: MigrationSourceDependencyEvidence[] = roots.map((root) => ({
    sourceId: root.sourceId,
    category: root.kind === 'semantic_model' ? 'semantic_model' : 'content',
    required: true,
    status: resolvedRoots.has(root.sourceId) ? 'resolved' : 'manual_required',
    reason: resolvedRoots.has(root.sourceId)
      ? `The selected Fabric ${root.kind.replace('_', ' ')} public definition was retrieved and fingerprinted.`
      : `The selected Fabric ${root.kind.replace('_', ' ')} requires PBIP/PBIX Manual Files.`,
  }));
  for (const definition of definitions.filter((candidate) => candidate.root.kind === 'report')) {
    dependencies.push({
      sourceId: definition.root.sourceId,
      category: 'content',
      required: true,
      status: 'review_required',
      reason: reportBehaviorReviewRequirement(definition),
    });
    const references = new Set([
      ...extractSemanticModelReferences(definition),
      ...(reportDatasetIds.get(definition.root.id) ? [reportDatasetIds.get(definition.root.id) as string] : []),
    ]);
    if (references.size === 0) {
      dependencies.push({
        sourceId: definition.root.sourceId,
        category: 'semantic_model',
        required: true,
        status: 'review_required',
        reason: 'The report definition did not expose an unambiguous semantic-model ID; verify its binding before Apply.',
      });
    }
    for (const reference of references) {
      dependencies.push({
        sourceId: definition.root.sourceId,
        dependencySourceId: `power_bi:semantic_model:${reference}`,
        category: 'semantic_model',
        required: true,
        status: resolvedModels.has(reference) ? 'resolved' : 'missing',
        reason: resolvedModels.has(reference)
          ? 'The report semantic-model dependency was resolved through the documented Fabric public-definition endpoint.'
          : 'The report references this semantic model, but its documented Fabric public definition was not acquired automatically. Supply its PBIP/TMDL definition.',
      });
    }
  }
  if (permissionGaps.length > 0) {
    dependencies.push({
      sourceId: 'power_bi:governance:selected-scope',
      category: 'security',
      required: true,
      status: 'review_required',
      reason: permissionGaps.join(' '),
    });
  }
  return dependencies;
}

function browserSafeInventory(inventory: MigrationInventory, evidenceContract: MigrationPreparedEvidenceResult['evidenceContract']): MigrationInventory {
  return {
    ...inventory,
    artifacts: [],
    sourceEvidence: evidenceContract,
    warnings: Array.from(new Set(inventory.warnings)),
  };
}

export async function preparePowerBiEvidence(context: MigrationSourceCollectorContext): Promise<MigrationPreparedEvidenceResult> {
  assertPowerBiConnection(context.connection);
  const roots = Array.from(new Set(context.selectedRootIds.map((value) => value.trim()).filter(Boolean))).map(parsePowerBiRoot);
  if (roots.length === 0) throw powerBiError('Select at least one Fabric report or semantic model before preparing evidence.', 400);
  if (roots.length > MAX_SELECTED_ROOTS) throw powerBiError(`Power BI evidence preparation accepts at most ${MAX_SELECTED_ROOTS} selected roots.`, 400);
  const workspaceId = assertOpaqueIdentifier(context.connection.workspaceId || '', 'Fabric workspace ID');
  const totals: PowerBiTotals = { requestsMade: 0, pagesFetched: 0, bytesRead: 0, itemsObserved: 0 };
  const tokens = await acquirePowerBiTokens(context.connection, context.transport, totals, context.signal);
  context.registerSensitiveValue?.(tokens.fabric, 'Microsoft Entra Fabric token exchange');
  if (tokens.powerBi) context.registerSensitiveValue?.(tokens.powerBi, 'Microsoft Entra Power BI token exchange');
  const inventoryResult = await listPowerBiFabricItems({
    workspaceId,
    accessToken: tokens.fabric,
    transport: context.transport,
    totals,
    signal: context.signal,
  });
  const catalogById = new Map(inventoryResult.items.map((item) => [item.id, item]));
  const definitions: FabricDefinitionResult[] = [];
  const errors: string[] = [];
  const manualRequirements: string[] = [];
  const warnings: string[] = inventoryResult.truncated
    ? ['Fabric workspace inventory reached its safety bound; selected IDs were still retrieved directly where possible.']
    : [];
  for (const root of roots) {
    const catalog = catalogById.get(root.id);
    if (catalog) {
      const expectedType = root.kind === 'semantic_model' ? 'semanticmodel' : 'report';
      if (catalog.type.replace(/[^A-Za-z]/g, '').toLowerCase() !== expectedType) {
        errors.push(`Fabric item ${root.id} is ${catalog.type}, not the selected ${root.kind.replace('_', ' ')} type.`);
        continue;
      }
    }
    try {
      const definition = await getFabricDefinition(
        root,
        catalog?.displayName || `${root.kind.replace('_', ' ')}-${root.id}`,
        workspaceId,
        tokens.fabric,
        context.transport,
        totals,
        context.signal,
      );
      definitions.push(definition);
      warnings.push(...definition.warnings);
    } catch (error) {
      rethrowPowerBiCancellation(error);
      const message = error instanceof Error ? error.message : `Fabric ${root.kind.replace('_', ' ')} ${root.id} could not be collected.`;
      const statusCode = (error as { statusCode?: number })?.statusCode;
      if (statusCode === 403 || statusCode === 413 || statusCode === 422) manualRequirements.push(message);
      else errors.push(message);
    }
  }

  const reportReferences = new Map<string, Set<string>>();
  definitions.filter((definition) => definition.root.kind === 'report').forEach((definition) => {
    reportReferences.set(definition.root.id, new Set(extractSemanticModelReferences(definition)));
  });

  const supplemental = await collectPowerBiSupplementalEvidence(
    roots,
    workspaceId,
    tokens.powerBi,
    context.transport,
    totals,
    context.signal,
  );
  warnings.push(...supplemental.warnings);
  const permissionGaps = supplemental.permissionGaps;
  definitions.filter((definition) => definition.root.kind === 'report').forEach((definition) => {
    const metadataReference = supplemental.reportDatasetIds.get(definition.root.id);
    if (metadataReference) reportReferences.get(definition.root.id)?.add(metadataReference);
  });
  const referencedModelIds = Array.from(new Set(Array.from(reportReferences.values()).flatMap((references) => Array.from(references)))).sort();
  if (referencedModelIds.length > MAX_SELECTED_ROOTS) {
    throw powerBiError(`The selected reports reference more than ${MAX_SELECTED_ROOTS} semantic models. Narrow the report scope.`, 413);
  }
  const definitionKeys = new Set(definitions.map((definition) => definition.root.sourceId));
  for (const modelId of referencedModelIds) {
    const root: PowerBiSelectedRoot = { kind: 'semantic_model', id: modelId, sourceId: `power_bi:semantic_model:${modelId}` };
    if (definitionKeys.has(root.sourceId)) continue;
    const catalog = catalogById.get(modelId);
    if (catalog && catalog.type.replace(/[^A-Za-z]/g, '').toLowerCase() !== 'semanticmodel') {
      manualRequirements.push(`Report semantic-model dependency ${modelId} is cataloged as ${catalog.type}, so no semantic-model definition was accepted.`);
      continue;
    }
    try {
      const definition = await getFabricDefinition(
        root,
        catalog?.displayName || `semantic_model-${modelId}`,
        workspaceId,
        tokens.fabric,
        context.transport,
        totals,
        context.signal,
      );
      definitions.push(definition);
      definitionKeys.add(root.sourceId);
      warnings.push(...definition.warnings);
    } catch (error) {
      rethrowPowerBiCancellation(error);
      const message = error instanceof Error ? error.message : `Fabric semantic model ${modelId} could not be collected.`;
      manualRequirements.push(`Report dependency ${modelId}: ${message}`);
    }
  }
  const selectedModelIds = new Set(roots.filter((root) => root.kind === 'semantic_model').map((root) => root.id));
  const autoResolvedModelIds = referencedModelIds.filter((modelId) => !selectedModelIds.has(modelId));
  if (tokens.powerBi && autoResolvedModelIds.length > 0) {
    const modelSupplemental = await collectPowerBiSemanticModelSupplementalEvidence(
      autoResolvedModelIds,
      workspaceId,
      tokens.powerBi,
      context.transport,
      totals,
      context.signal,
    );
    supplemental.evidence.push(...modelSupplemental.evidence);
    supplemental.permissionGaps.push(...modelSupplemental.permissionGaps);
  }
  const rawInventory = buildMigrationInventory('power_bi', definitions.flatMap((definition) => definition.artifacts));
  const provenance = [
    ...definitions.flatMap((definition) => definition.provenance),
    ...supplemental.evidence.map(supplementalProvenance),
  ];
  const dependencies = buildDependencies(roots, definitions, supplemental.reportDatasetIds, permissionGaps);
  const behavioralReviewRequirements = definitions
    .filter((definition) => definition.root.kind === 'report')
    .map(reportBehaviorReviewRequirement);
  warnings.push(...behavioralReviewRequirements);
  const reportedManualRequirements = Array.from(new Set([
    ...manualRequirements,
    ...behavioralReviewRequirements,
    ...permissionGaps,
  ]));
  const missingDependencies = dependencies.filter((dependency) => dependency.status === 'missing' || dependency.status === 'manual_required');
  const reviewDependencies = dependencies.filter((dependency) => dependency.status === 'review_required');
  const resolvedDefinitionIds = new Set(definitions.map((definition) => definition.root.sourceId));
  const selectedDefinitionMissing = roots.some((root) => !resolvedDefinitionIds.has(root.sourceId));
  const reportBindingsComplete = definitions
    .filter((definition) => definition.root.kind === 'report')
    .every((definition) => (reportReferences.get(definition.root.id)?.size || 0) > 0);
  const manualRequired = selectedDefinitionMissing || manualRequirements.length > 0 || missingDependencies.length > 0;
  const partial = permissionGaps.length > 0 || reviewDependencies.length > 0;
  const status: MigrationPreparedEvidenceStatus = manualRequired
    ? 'manual_required'
    : errors.length > 0
      ? 'failed'
      : inventoryResult.truncated
        ? 'bounded'
        : partial
          ? 'partial'
          : 'complete';
  const acquisitionComplete = !inventoryResult.truncated
    && !selectedDefinitionMissing
    && reportBindingsComplete
    && referencedModelIds.every((modelId) => resolvedDefinitionIds.has(`power_bi:semantic_model:${modelId}`))
    && errors.length === 0
    && permissionGaps.length === 0
    && manualRequirements.length === 0
    && missingDependencies.length === 0;
  const evidenceContract: MigrationPreparedEvidenceResult['evidenceContract'] = {
    schemaVersion: 'omnikit.source-evidence.v2',
    sourceTool: 'power_bi',
    parser: { name: 'Microsoft Fabric TMDL and PBIR public-definition collector', version: '1.0.0' },
    acquisition: { mode: 'api', runId: context.scopeFingerprint, selectedScopeIds: roots.map((root) => root.sourceId) },
    collection: {
      expectedArtifactCount: new Set([
        ...roots.map((root) => root.sourceId),
        ...referencedModelIds.map((modelId) => `power_bi:semantic_model:${modelId}`),
      ]).size,
      observedArtifactCount: definitions.length,
      complete: acquisitionComplete,
      truncated: inventoryResult.truncated,
      permissionGaps,
    },
    dependencyClosure: {
      status: missingDependencies.length > 0 ? 'blocked' : reviewDependencies.length > 0 ? 'partial' : 'complete',
      resolvedCount: dependencies.filter((dependency) => dependency.status === 'resolved').length,
      missingCount: missingDependencies.length,
      reviewCount: reviewDependencies.length,
    },
    artifactFingerprints: provenance.map((artifact) => ({ name: artifact.name, sha256: artifact.sha256, sizeBytes: artifact.sizeBytes })),
    documentationIds: [...POWER_BI_DOCUMENTATION],
    diagnostics: [...warnings, ...permissionGaps, ...reportedManualRequirements, ...errors],
  };
  const inventory = browserSafeInventory({
    ...rawInventory,
    warnings: [...rawInventory.warnings, ...warnings, ...permissionGaps, ...reportedManualRequirements, ...errors],
  }, evidenceContract);
  return {
    schemaVersion: 'omnikit.prepared-source-evidence.v1',
    platform: 'power_bi',
    connectionId: context.connection.id,
    connectionUpdatedAt: context.connection.updatedAt,
    selectedRootIds: roots.map((root) => root.sourceId),
    scopeFingerprint: context.scopeFingerprint,
    preparedAt: new Date().toISOString(),
    status,
    evidenceContract,
    inventory,
    artifacts: provenance,
    dependencies,
    diagnostics: {
      complete: acquisitionComplete,
      verifiedEmpty: false,
      truncated: inventoryResult.truncated,
      requestsMade: totals.requestsMade,
      pagesFetched: totals.pagesFetched,
      itemsObserved: totals.itemsObserved,
      bytesRead: totals.bytesRead,
      limits: {
        maxRequests: 2 + MAX_INVENTORY_PAGES + (roots.length + referencedModelIds.length) * (MAX_LRO_POLLS + 4),
        maxPages: MAX_INVENTORY_PAGES,
        maxItems: MAX_INVENTORY_ITEMS,
        maxBytes: MAX_DEFINITION_TOTAL_BYTES,
      },
      permissionGaps,
      manualRequirements: reportedManualRequirements,
      errors,
      warnings,
    },
  };
}

export const powerBiEvidenceCollector: MigrationSourceEvidenceCollector = {
  platform: 'power_bi',
  prepareEvidence: preparePowerBiEvidence,
};

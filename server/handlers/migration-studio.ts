import { jsonHeaders, validateBaseUrl } from '../security';
import { randomUUID } from 'node:crypto';
import { listSourceInventory, runLookerSourceValidationProbe, sourceInventoryAuthenticationVerified, type LookerSourceValidationProbeInput } from '../services/migrationConnectors';
import { normalizeMigrationSourceRootIds, prepareBoundedDomoApiEvidence, prepareSavedMigrationSourceEvidence } from '../services/migrationSources';
import { generateStructuredProposal, providerCapabilities, testLlmProvider, type MigrationAiTask } from '../services/migrationProviders';
import { redactSensitiveText } from '../services/jobSanitizer';
import { parseDomoManualArtifacts } from '../services/semanticMigration/domoManualParser';
import { parseLookerManualArtifacts } from '../services/semanticMigration/lookerManualParser';
import { parseMicroStrategyManualArtifacts } from '../services/semanticMigration/microStrategyManualParser';
import { parsePowerBiManualArtifacts } from '../services/semanticMigration/powerBiManualParser';
import { applyMigrationEngineConnectionOverrides, getMigrationEngineCapabilities, migrationEngineRolloutMode, recordMigrationEngineParityObservation, runMigrationEngineExtract, validateMigrationEngineArtifactBounds, type MigrationEngineArtifactInput } from '../services/migrationEngineBridge';
import {
  BiMigrationFoundationError,
  loadBiMigrationFoundationInventory,
  provisionBiMigrationFoundationWithRun,
} from '../services/biMigrationFoundation';
import { OmniClient } from '../services/omniClient';
import {
  cancelSemanticMigrationJob,
  getSemanticMigrationJob,
  getSemanticMigrationJobResult,
  startSemanticMigrationJob,
  type SemanticMigrationJobRecord,
} from '../services/semanticMigrationJobs';
import {
  assertMigrationProviderAllowed,
  listSemanticMigrationAuditEvents,
  recordSemanticMigrationAuditEvent,
  recordSemanticMigrationLifecycleEvent,
  type SemanticMigrationLifecycleMetadata,
} from '../services/semanticMigrationAudit';
import {
  deleteLlmProvider,
  deletePlatformConnection,
  getLlmProvider,
  getPlatformConnection,
  getInstance,
  isVaultUnlocked,
  listLlmProviders,
  listPlatformConnections,
  markLlmProviderValidated,
  markLlmProviderValidationFailed,
  markPlatformConnectionValidated,
  markPlatformConnectionValidationFailed,
  upsertLlmProvider,
  upsertPlatformConnection,
} from '../services/nativeVault';
import type { MigrationArtifact } from '../../src/services/semanticMigration/types';
import { buildMigrationInventory } from '../../src/services/semanticMigration/adapters';
import { sanitizeSemanticMigrationProviderText } from '../../src/services/semanticMigration/prompts';
import { parseDestinationFoundationPlan } from '../../src/services/semanticMigration/destinationFoundation';
import type { MigrationEngineSource } from '../../src/services/semanticMigration/engineBridge';
import type { MigrationEngineBridgeResult } from '../../src/services/semanticMigration/engineBridge';
import {
  SEMANTIC_MIGRATION_COMPILE_CONTRACT,
  SEMANTIC_MIGRATION_PLAN_CONTRACT,
  SEMANTIC_MIGRATION_REPAIR_CONTRACT,
  type SemanticMigrationContractValidationContext,
  type SemanticMigrationStageContractId,
} from '../../src/services/semanticMigration/contracts';

function maxPromptChars(): number {
  const configured = Number(process.env.OMNIKIT_MIGRATION_MAX_PROMPT_CHARS);
  return Number.isFinite(configured) && configured >= 10_000 ? Math.min(configured, 1_000_000) : 500_000;
}

export function strictPromptFields(body: Record<string, unknown>): { system: string; prompt: string } {
  const system = sanitizeSemanticMigrationProviderText(typeof body.system === 'string' ? body.system : '');
  const prompt = sanitizeSemanticMigrationProviderText(typeof body.prompt === 'string' ? body.prompt : '');
  const maximum = maxPromptChars();
  const total = system.length + prompt.length;
  if (total > maximum) {
    throw Object.assign(new Error(`The semantic migration AI request is ${total.toLocaleString()} characters, above the ${maximum.toLocaleString()} character limit. OmniKit did not truncate it. Reduce the migration scope or split the selected dashboards and retry.`), { statusCode: 413 });
  }
  return { system, prompt };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: jsonHeaders });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(',')}}`;
}

function lifecycleErrorMetadata(error: unknown): Pick<SemanticMigrationLifecycleMetadata, 'requestId' | 'attemptCount' | 'statusCode' | 'errorCode'> & { circuitOpened: boolean } {
  const record = isRecord(error) ? error : {};
  const statusCode = typeof record.statusCode === 'number' && Number.isSafeInteger(record.statusCode)
    ? record.statusCode
    : undefined;
  const attemptCount = typeof record.attempts === 'number' && Number.isSafeInteger(record.attempts)
    ? Math.max(1, Math.min(record.attempts, 100))
    : undefined;
  const errorCode = typeof record.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(record.code)
    ? record.code
    : undefined;
  const requestId = typeof record.requestId === 'string' ? record.requestId : undefined;
  return {
    requestId,
    attemptCount,
    statusCode,
    errorCode,
    circuitOpened: record.circuitOpened === true,
  };
}

function recordLifecycleWithoutMaskingFailure(
  state: Parameters<typeof recordSemanticMigrationLifecycleEvent>[0],
  metadata: SemanticMigrationLifecycleMetadata,
): void {
  try {
    recordSemanticMigrationLifecycleEvent(state, metadata);
  } catch {
    // Provider completion must remain authoritative if the local audit sink becomes unavailable.
  }
}

function typedProviderExecutionError(error: unknown): unknown {
  const record = isRecord(error) ? error : {};
  if (record.statusCode !== 429 || typeof record.code === 'string') return error;
  const retryableConcurrency = { code: 'AI_PROVIDER_CONCURRENCY_LIMIT', retryable: true };
  try {
    return Object.assign(error as object, retryableConcurrency);
  } catch {
    return Object.assign(new Error(error instanceof Error ? error.message : 'The AI provider concurrency limit was reached.'), {
      ...retryableConcurrency,
      statusCode: 429,
    });
  }
}

function sanitizedSemanticMigrationJob(
  job: SemanticMigrationJobRecord,
): Omit<SemanticMigrationJobRecord, 'requestFingerprint' | 'idempotencyKey'> {
  const { requestFingerprint, idempotencyKey, ...sanitized } = job;
  void requestFingerprint;
  void idempotencyKey;
  return sanitized;
}

function semanticMigrationJobStatusResponse(id: string, includeResult: boolean): Response {
  const job = getSemanticMigrationJob(id);
  if (!job) return json({ error: 'Semantic migration job not found.' }, 404);
  const sanitizedJob = sanitizedSemanticMigrationJob(job);
  if (job.status !== 'succeeded') return json({ job: sanitizedJob });
  const result = getSemanticMigrationJobResult(id);
  if (result === undefined) return json({ job: sanitizedJob, resultExpired: true });
  if (!includeResult) return json({ job: sanitizedJob, resultRequiresVaultUnlock: true });
  return json({ job: sanitizedJob, result });
}

async function semanticMigrationJobCancellationResponse(id: string): Promise<Response> {
  const cancellation = cancelSemanticMigrationJob(id);
  if (!cancellation) return json({ error: 'Semantic migration job not found.' }, 404);
  const transitioned = cancellation.transitioned;
  const job = await cancellation;
  if (transitioned && job.status === 'cancelled') {
    const provider = isVaultUnlocked() ? getLlmProvider(job.providerId) : undefined;
    recordLifecycleWithoutMaskingFailure('cancelled', {
      providerKind: provider?.kind,
      providerId: job.providerId,
      projectId: job.projectId,
      stage: job.stage,
      jobId: id,
    });
  }
  return json({ job: sanitizedSemanticMigrationJob(job) });
}

function sanitizedConnectionOverrides(value: unknown, targetConnectionIds: Set<string>): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([sourceKey, connectionId]) => sourceKey.trim() && sourceKey.length <= 200 && typeof connectionId === 'string' && targetConnectionIds.has(connectionId))
    .slice(0, 100)
    .map(([sourceKey, connectionId]) => [sourceKey.trim(), String(connectionId)]));
}

const SEMANTIC_MIGRATION_CONTRACT_IDS = new Set<SemanticMigrationStageContractId>([
  SEMANTIC_MIGRATION_PLAN_CONTRACT,
  SEMANTIC_MIGRATION_COMPILE_CONTRACT,
  SEMANTIC_MIGRATION_REPAIR_CONTRACT,
]);

function cleanStringArray(value: unknown, limit = 1_000): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .slice(0, limit)
    .map((item) => item.trim().slice(0, 512));
}

function semanticMigrationContractInput(value: unknown): { id: SemanticMigrationStageContractId; validationContext: SemanticMigrationContractValidationContext } | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || !SEMANTIC_MIGRATION_CONTRACT_IDS.has(value.id as SemanticMigrationStageContractId)) return undefined;
  const rawContext = isRecord(value.validationContext) ? value.validationContext : {};
  const baselineDigests = isRecord(rawContext.baselineDigests)
    ? Object.fromEntries(Object.entries(rawContext.baselineDigests)
      .filter((entry): entry is [string, string] => entry[0].trim().length > 0 && typeof entry[1] === 'string' && /^[a-f0-9]{64}$/i.test(entry[1]))
      .slice(0, 500)
      .map(([fileName, digest]) => [fileName.slice(0, 512), digest.toLowerCase()]))
    : undefined;
  return {
    id: value.id as SemanticMigrationStageContractId,
    validationContext: {
      expectedWriteCount: typeof rawContext.expectedWriteCount === 'number' && Number.isSafeInteger(rawContext.expectedWriteCount)
        ? Math.max(0, Math.min(rawContext.expectedWriteCount, 1_000))
        : undefined,
      approvedIntentIds: cleanStringArray(rawContext.approvedIntentIds),
      allowedEvidenceIds: cleanStringArray(rawContext.allowedEvidenceIds),
      allowedFileNames: cleanStringArray(rawContext.allowedFileNames, 500),
      baselineDigests,
      repairAttempt: rawContext.repairAttempt === 1 ? 1 : undefined,
    },
  };
}

const MIGRATION_AI_TASKS = new Set<MigrationAiTask>(['classify_inventory', 'propose_mappings', 'translate_expression', 'draft_semantic_patch', 'draft_content_spec', 'explain_exception', 'generate_validation_sql', 'evaluate_reconciliation']);
const MANUAL_ARTIFACT_KINDS = new Set<MigrationArtifact['kind']>(['manifest', 'yaml', 'sql', 'lookml', 'dashboard', 'json', 'xml', 'metadata', 'text', 'unknown']);
const MAX_MANUAL_ARTIFACTS = 100;
const MAX_LOOKER_MANUAL_ARTIFACTS = 500;
const MAX_MANUAL_ARTIFACT_BYTES = 500_000;
const MAX_MANUAL_TOTAL_BYTES = 4_000_000;
const MAX_POWER_BI_MANUAL_ARTIFACTS = 1_000;
const MAX_POWER_BI_MANUAL_ARTIFACT_BYTES = 5 * 1024 * 1024;
const MAX_POWER_BI_MANUAL_TOTAL_BYTES = 18 * 1024 * 1024;
const ENGINE_SCOPE_ARRAY_FIELDS = new Set(['project_ids', 'dashboard_ids', 'selected_dashboard_ids', 'workbook_ids']);
const ENGINE_SCOPE_SCALAR_FIELDS = new Set(['project_id']);
const MAX_ENGINE_SCOPE_VALUES = 1_000;
const MAX_ENGINE_SCOPE_VALUE_CHARS = 200;

function migrationAiTask(value: unknown): MigrationAiTask | null {
  return typeof value === 'string' && MIGRATION_AI_TASKS.has(value as MigrationAiTask) ? value as MigrationAiTask : null;
}

async function bodyJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = await req.json();
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function requireUnlocked(): Response | null {
  return isVaultUnlocked() ? null : json({ error: 'vault locked' }, 423);
}

function validateSavedBaseUrl(body: Record<string, unknown>): Response | null {
  if (typeof body.baseUrl !== 'string' || !body.baseUrl.trim()) return null;
  const error = validateBaseUrl(body.baseUrl.trim());
  return error ? json({ error }, 400) : null;
}

function manualArtifacts(body: Record<string, unknown>): MigrationArtifact[] {
  if (body.sourceTool !== 'domo' && body.sourceTool !== 'looker' && body.sourceTool !== 'microstrategy' && body.sourceTool !== 'power_bi') {
    throw Object.assign(new Error('The backend manual parser currently supports Domo, Looker, MicroStrategy, and Power BI artifacts only.'), { statusCode: 400 });
  }
  const sourceTool = body.sourceTool;
  const sourceLabel = sourceTool === 'domo' ? 'Domo' : sourceTool === 'looker' ? 'Looker' : sourceTool === 'microstrategy' ? 'MicroStrategy' : 'Power BI';
  const maxArtifacts = sourceTool === 'power_bi'
    ? MAX_POWER_BI_MANUAL_ARTIFACTS
    : sourceTool === 'looker'
      ? MAX_LOOKER_MANUAL_ARTIFACTS
      : MAX_MANUAL_ARTIFACTS;
  const maxArtifactBytes = sourceTool === 'power_bi' ? MAX_POWER_BI_MANUAL_ARTIFACT_BYTES : MAX_MANUAL_ARTIFACT_BYTES;
  const maxTotalBytes = sourceTool === 'power_bi' ? MAX_POWER_BI_MANUAL_TOTAL_BYTES : MAX_MANUAL_TOTAL_BYTES;
  if (!Array.isArray(body.artifacts) || body.artifacts.length === 0) {
    throw Object.assign(new Error(`At least one ${sourceLabel} source artifact is required.`), { statusCode: 400 });
  }
  if (body.artifacts.length > maxArtifacts) {
    throw Object.assign(new Error(`Upload no more than ${maxArtifacts} ${sourceLabel} artifacts at a time.`), { statusCode: 413 });
  }
  let totalBytes = 0;
  return body.artifacts.map((value, index) => {
    if (!isRecord(value)) throw Object.assign(new Error(`${sourceLabel} artifact ${index + 1} is invalid.`), { statusCode: 400 });
    const content = typeof value.content === 'string' ? value.content : '';
    const contentBytes = Buffer.byteLength(content);
    totalBytes += contentBytes;
    if (!content.trim()) throw Object.assign(new Error(`${sourceLabel} artifact ${index + 1} has no readable content.`), { statusCode: 400 });
    if (contentBytes > maxArtifactBytes || totalBytes > maxTotalBytes) {
      throw Object.assign(new Error(`The ${sourceLabel} manual bundle is too large. Split it into smaller, focused exports.`), { statusCode: 413 });
    }
    const kind = typeof value.kind === 'string' && MANUAL_ARTIFACT_KINDS.has(value.kind as MigrationArtifact['kind'])
      ? value.kind as MigrationArtifact['kind']
      : 'unknown';
    return {
      id: typeof value.id === 'string' && value.id.trim() ? value.id.trim().slice(0, 200) : `${sourceTool}-artifact-${index + 1}`,
      sourceTool,
      name: typeof value.name === 'string' && value.name.trim() ? value.name.trim().slice(0, 300) : `${sourceTool}-artifact-${index + 1}.${kind === 'sql' ? 'sql' : sourceTool === 'looker' ? 'lkml' : 'json'}`,
      kind,
      content,
      sizeBytes: typeof value.sizeBytes === 'number' && Number.isFinite(value.sizeBytes) ? Math.max(0, value.sizeBytes) : Buffer.byteLength(content),
      parseWarnings: Array.isArray(value.parseWarnings)
        ? value.parseWarnings.filter((warning): warning is string => typeof warning === 'string').slice(0, 20).map((warning) => warning.slice(0, 500))
        : [],
    } satisfies MigrationArtifact;
  });
}

const ENGINE_SOURCES = new Set<MigrationEngineSource>(['looker', 'metabase', 'powerbi', 'sigma', 'tableau']);

function engineSource(value: unknown): MigrationEngineSource {
  const normalized = value === 'power_bi' ? 'powerbi' : value;
  if (typeof normalized === 'string' && ENGINE_SOURCES.has(normalized as MigrationEngineSource)) return normalized as MigrationEngineSource;
  throw Object.assign(new Error('Select a migration-engine source: Looker, Metabase, Power BI, Sigma, or Tableau.'), { statusCode: 400 });
}

export function sanitizedEngineScope(value: unknown): Record<string, string | string[]> {
  if (value == null) return {};
  if (!isRecord(value)) throw Object.assign(new Error('Migration engine scope must be an object.'), { statusCode: 400 });
  const result: Record<string, string | string[]> = {};
  for (const [key, item] of Object.entries(value)) {
    if (ENGINE_SCOPE_ARRAY_FIELDS.has(key)) {
      if (!Array.isArray(item) || item.length > MAX_ENGINE_SCOPE_VALUES) {
        throw Object.assign(new Error(`Migration engine scope ${key} must contain at most ${MAX_ENGINE_SCOPE_VALUES} identifiers.`), { statusCode: 400 });
      }
      const values = item.map((entry) => {
        if (typeof entry !== 'string' || !entry.trim() || entry.trim().length > MAX_ENGINE_SCOPE_VALUE_CHARS) {
          throw Object.assign(new Error(`Migration engine scope ${key} contains an invalid identifier.`), { statusCode: 400 });
        }
        return entry.trim();
      });
      result[key] = Array.from(new Set(values));
      continue;
    }
    if (ENGINE_SCOPE_SCALAR_FIELDS.has(key)) {
      if (typeof item !== 'string' || !item.trim() || item.trim().length > MAX_ENGINE_SCOPE_VALUE_CHARS) {
        throw Object.assign(new Error(`Migration engine scope ${key} must be a valid identifier.`), { statusCode: 400 });
      }
      result[key] = item.trim();
      continue;
    }
    throw Object.assign(new Error(`Migration engine scope field is not supported: ${key}.`), { statusCode: 400 });
  }
  return result;
}

interface PreparedEngineArtifact {
  name: string;
  byteLength: number;
  content?: string;
  contentBase64?: string;
}

function decodedBase64ByteLength(value: string, name: string): number {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw Object.assign(new Error(`${name} is not valid base64 artifact content.`), { statusCode: 400 });
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function preparedEngineArtifacts(body: Record<string, unknown>, field: string): PreparedEngineArtifact[] {
  if (!Array.isArray(body[field])) return [];
  return body[field].map((value, index) => {
    if (!isRecord(value)) throw Object.assign(new Error(`Engine artifact ${index + 1} is invalid.`), { statusCode: 400 });
    const name = typeof value.name === 'string' && value.name.trim() ? value.name.trim().slice(0, 300) : `artifact-${index + 1}`;
    if (typeof value.contentBase64 === 'string') {
      return { name, contentBase64: value.contentBase64, byteLength: decodedBase64ByteLength(value.contentBase64, name) };
    }
    if (typeof value.content !== 'string') throw Object.assign(new Error(`${name} has no readable artifact content.`), { statusCode: 400 });
    return { name, content: value.content, byteLength: Buffer.byteLength(value.content, 'utf8') };
  });
}

function materializeEngineArtifacts(artifacts: PreparedEngineArtifact[]): MigrationEngineArtifactInput[] {
  return artifacts.map((artifact) => ({
    name: artifact.name,
    content: artifact.contentBase64 === undefined
      ? artifact.content || ''
      : new Uint8Array(Buffer.from(artifact.contentBase64, 'base64')),
  }));
}

export function boundedEngineArtifactPayloads(
  body: Record<string, unknown>,
  mode: 'manual' | 'api',
): { artifacts: MigrationEngineArtifactInput[]; parityArtifacts: MigrationEngineArtifactInput[] } {
  const artifacts = preparedEngineArtifacts(body, 'artifacts');
  const parityArtifacts = preparedEngineArtifacts(body, 'parityArtifacts');
  validateMigrationEngineArtifactBounds([...artifacts, ...parityArtifacts].map(({ name, byteLength }) => ({ name, byteLength })));
  return {
    artifacts: mode === 'manual' ? materializeEngineArtifacts(artifacts) : [],
    parityArtifacts: materializeEngineArtifacts(parityArtifacts),
  };
}

function engineArtifactKind(name: string, source: MigrationEngineSource): MigrationArtifact['kind'] {
  const lower = name.toLowerCase();
  if (lower.endsWith('.lkml') || lower.endsWith('.lookml')) return lower.includes('dashboard') ? 'dashboard' : 'lookml';
  if (lower.endsWith('.twb') || lower.endsWith('.tds') || lower.endsWith('.xml')) return 'xml';
  if (lower.endsWith('.bim') || lower.endsWith('.tmdl') || lower.endsWith('.model')) return 'metadata';
  if (lower.endsWith('.json')) return 'json';
  return source === 'looker' ? 'lookml' : 'unknown';
}

export function buildEngineManualParityBaseline(source: MigrationEngineSource, artifacts: MigrationEngineArtifactInput[]) {
  if (artifacts.length === 0 || artifacts.some((artifact) => typeof artifact.content !== 'string')) return undefined;
  const sourceTool = source === 'powerbi' ? 'power_bi' : source;
  const migrationArtifacts: MigrationArtifact[] = artifacts.map((artifact, index) => ({
    id: `${sourceTool}-engine-baseline-${index + 1}`,
    sourceTool,
    name: artifact.name,
    kind: engineArtifactKind(artifact.name, source),
    content: artifact.content as string,
    sizeBytes: Buffer.byteLength(artifact.content as string),
    parseWarnings: [],
  }));
  if (sourceTool === 'looker') return parseLookerManualArtifacts(migrationArtifacts).inventory;
  if (sourceTool === 'power_bi') return parsePowerBiManualArtifacts(migrationArtifacts).inventory;
  return buildMigrationInventory(sourceTool, migrationArtifacts);
}

export default async function handler(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api\/migration-studio\/?/, '');
    const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
    const [resource, id, action] = parts;

    if (resource === 'jobs' && req.method === 'GET' && id && !action) {
      return semanticMigrationJobStatusResponse(id, isVaultUnlocked());
    }
    if (resource === 'jobs' && req.method === 'POST' && id && action === 'cancel') {
      return semanticMigrationJobCancellationResponse(id);
    }

    const locked = requireUnlocked();
    if (locked) return locked;

    if (resource === 'audit' && req.method === 'GET') {
      return json({ events: listSemanticMigrationAuditEvents() });
    }

    if (resource === 'destination-foundation' && id && action === 'inventory' && req.method === 'GET') {
      const targetInstance = getInstance(id);
      if (!targetInstance) return json({ error: 'Target Omni instance not found in the unlocked vault.' }, 404);
      const inventory = await loadBiMigrationFoundationInventory(new OmniClient(targetInstance), id);
      return json({ inventory });
    }

    if (resource === 'destination-foundation' && id && action === 'provision' && req.method === 'POST') {
      const targetInstance = getInstance(id);
      if (!targetInstance) return json({ error: 'Target Omni instance not found in the unlocked vault.' }, 404);
      const plan = parseDestinationFoundationPlan(await bodyJson(req));
      if (plan.targetInstanceId !== id) {
        return json({ error: 'Destination foundation plan does not match the requested Omni instance.' }, 409);
      }
      const result = await provisionBiMigrationFoundationWithRun(new OmniClient(targetInstance), plan, {
        signal: req.signal,
        idempotencyKey: req.headers.get('idempotency-key') || undefined,
      });
      const created = result.created.connection || result.created.schemaModel || result.created.sharedModel;
      return json({ result }, created ? 201 : 200);
    }

    if (resource === 'engine' && id === 'capabilities' && req.method === 'GET') {
      try {
        return json({ available: true, capabilities: await getMigrationEngineCapabilities() });
      } catch (caught) {
        const status = caught && typeof caught === 'object' && 'statusCode' in caught
          ? Number((caught as { statusCode?: unknown }).statusCode)
          : 500;
        if (status === 503) {
          return json({
            available: false,
            capabilities: null,
            reason: 'The deterministic migration engine is unavailable. OmniKit will use its native migration path.',
          });
        }
        throw caught;
      }
    }

    if (resource === 'engine' && id === 'parity' && req.method === 'POST') {
      const body = await bodyJson(req);
      const requestId = typeof body.requestId === 'string' ? body.requestId.trim().slice(0, 200) : '';
      if (!requestId) return json({ error: 'A completed migration-engine request ID is required.' }, 400);
      const summary = await recordMigrationEngineParityObservation(requestId);
      recordSemanticMigrationAuditEvent({
        type: 'engine_parity_recorded',
        resourceId: `${summary.source}:${summary.observationCount}`,
        sourcePlatform: summary.source === 'powerbi' ? 'power_bi' : summary.source,
        outcome: 'completed',
        telemetry: {
          rolloutMode: 'shadow',
          parityScore: summary.latestOverall,
        },
      });
      return json({ summary }, 201);
    }

    if (resource === 'engine' && id === 'confirm-connections' && req.method === 'POST') {
      const body = await bodyJson(req);
      const targetInstanceId = typeof body.targetInstanceId === 'string' ? body.targetInstanceId.trim().slice(0, 200) : '';
      const targetInstance = targetInstanceId ? getInstance(targetInstanceId) : undefined;
      if (!targetInstance) return json({ error: 'Target Omni instance not found in the unlocked vault.' }, 404);
      if (!isRecord(body.result) || !Array.isArray(body.result.connection_mappings)) {
        return json({ error: 'A normalized migration-engine result with connection mappings is required.' }, 400);
      }

      const targetConnections = (await new OmniClient(targetInstance).listConnections())
        .filter((item) => !item.deletedAt && item.id && item.name)
        .slice(0, 500)
        .map((item) => ({
          id: item.id,
          name: item.name,
          dialect: item.dialect,
          database: item.database || undefined,
          defaultSchema: item.defaultSchema || undefined,
        }));
      const requestedOverrides = isRecord(body.connectionOverrides) ? body.connectionOverrides : {};
      const connectionOverrides = sanitizedConnectionOverrides(requestedOverrides, new Set(targetConnections.map((item) => item.id)));
      if (Object.keys(connectionOverrides).length !== Object.keys(requestedOverrides).length) {
        return json({ error: 'A migration connection override references a destination that is not available to this request.' }, 400);
      }
      const sourceKeys = new Set(body.result.connection_mappings
        .map((mapping) => isRecord(mapping) && typeof mapping.source_key === 'string' ? mapping.source_key : '')
        .filter(Boolean));
      if (Object.keys(connectionOverrides).some((sourceKey) => !sourceKeys.has(sourceKey))) {
        return json({ error: 'A migration connection override references an unknown source connection.' }, 400);
      }

      const result = applyMigrationEngineConnectionOverrides(
        { targetConnections, connectionOverrides },
        body.result as unknown as MigrationEngineBridgeResult,
      );
      recordSemanticMigrationAuditEvent({
        type: 'engine_connections_confirmed',
        resourceId: result.request_id,
        outcome: 'completed',
      });
      return json({ result });
    }

    if (resource === 'engine' && id === 'extract' && req.method === 'POST') {
      const body = await bodyJson(req);
      const source = engineSource(body.sourceTool);
      const mode = body.mode === 'api' ? 'api' : 'manual';
      if (mode === 'api') {
        return json({ error: 'Direct migration-engine API extraction is retired. Prepare revision-bound Saved API evidence through the source collector, or use Manual Files.' }, 409);
      }
      const { artifacts, parityArtifacts } = boundedEngineArtifactPayloads(body, mode);
      const targetInstanceId = typeof body.targetInstanceId === 'string' ? body.targetInstanceId.trim().slice(0, 200) : '';
      const targetInstance = targetInstanceId ? getInstance(targetInstanceId) : undefined;
      if (targetInstanceId && !targetInstance) return json({ error: 'Target Omni instance not found in the unlocked vault.' }, 404);
      const targetConnections = targetInstance
        ? (await new OmniClient(targetInstance).listConnections())
          .filter((item) => !item.deletedAt && item.id && item.name)
          .slice(0, 500)
          .map((item) => ({
            id: item.id,
            name: item.name,
            dialect: item.dialect,
            database: item.database || undefined,
            defaultSchema: item.defaultSchema || undefined,
          }))
        : [];
      const connectionOverrides = sanitizedConnectionOverrides(body.connectionOverrides, new Set(targetConnections.map((item) => item.id)));
      const expectedPlatform = source === 'powerbi' ? 'power_bi' : source;
      const requestId = typeof body.requestId === 'string' && body.requestId.trim() ? body.requestId.trim().slice(0, 200) : `engine_${randomUUID()}`;
      const scope = sanitizedEngineScope(body.scope);
      let parityBaseline;
      let parityBaselineWarning = '';
      try {
        parityBaseline = buildEngineManualParityBaseline(source, parityArtifacts.length > 0 ? parityArtifacts : artifacts);
      } catch {
        parityBaselineWarning = 'A comparable native baseline could not be generated, so this run is limited to canonical conformance and cannot be described as an old-versus-new differential.';
      }
      const startedAt = Date.now();
      try {
        const result = await runMigrationEngineExtract({
          requestId,
          source,
          mode,
          artifacts,
          connection: undefined,
          defaultSchema: typeof body.defaultSchema === 'string' ? body.defaultSchema.trim().slice(0, 200) : undefined,
          scope,
          includeModelSuggestions: body.includeModelSuggestions !== false,
          rulebookVersion: typeof body.rulebookVersion === 'string' && body.rulebookVersion.trim() ? body.rulebookVersion.trim().slice(0, 50) : 'v2',
          targetConnections,
          connectionOverrides,
          parityBaseline,
          parityBaselineSource: parityBaseline ? 'server_native' : undefined,
          parityComparisonType: parityBaseline ? 'native_differential' : 'canonical_conformance',
          signal: req.signal,
        });
        recordSemanticMigrationAuditEvent({
          type: 'engine_artifacts_parsed',
          resourceId: `${requestId}:${result.engine.version}:${result.diagnostics.view_count}:${result.diagnostics.dashboard_count}`,
          sourcePlatform: expectedPlatform,
          outcome: 'completed',
          telemetry: {
            engineName: result.engine.name,
            engineVersion: result.engine.version,
            parserVersion: result.model_suggestions[0]?.parser_version || result.engine.version,
            rolloutMode: result.control_plane?.rollout_mode || migrationEngineRolloutMode(source),
            durationMs: result.control_plane?.duration_ms || Date.now() - startedAt,
            queueWaitMs: result.control_plane?.queue_wait_ms,
          },
        });
        return json({
          result,
          parity: {
            comparisonType: parityBaseline ? 'native_differential' : 'canonical_conformance',
            warning: parityBaselineWarning || undefined,
          },
        });
      } catch (caught) {
        const statusCode = caught && typeof caught === 'object' && 'statusCode' in caught ? Number((caught as { statusCode?: unknown }).statusCode) : 500;
        recordSemanticMigrationAuditEvent({
          type: 'engine_artifacts_parsed',
          resourceId: requestId,
          sourcePlatform: expectedPlatform,
          outcome: 'rejected',
          telemetry: {
            rolloutMode: migrationEngineRolloutMode(source),
            durationMs: Date.now() - startedAt,
            fallbackReason: statusCode === 503 && migrationEngineRolloutMode(source) === 'off' ? 'engine_off' : statusCode === 503 ? 'engine_unavailable' : 'engine_failed',
          },
        });
        throw caught;
      }
    }

    if (resource === 'manual-artifacts' && id === 'parse' && req.method === 'POST') {
      const body = await bodyJson(req);
      const artifacts = manualArtifacts(body);
      const sourcePlatform = artifacts[0].sourceTool === 'looker'
        ? 'looker'
        : artifacts[0].sourceTool === 'microstrategy'
          ? 'microstrategy'
          : artifacts[0].sourceTool === 'power_bi'
            ? 'power_bi'
            : 'domo';
      const result = sourcePlatform === 'looker'
        ? parseLookerManualArtifacts(artifacts)
        : sourcePlatform === 'microstrategy'
          ? parseMicroStrategyManualArtifacts(artifacts)
          : sourcePlatform === 'power_bi'
            ? parsePowerBiManualArtifacts(artifacts)
            : parseDomoManualArtifacts(artifacts);
      recordSemanticMigrationAuditEvent({
        type: 'manual_artifacts_parsed',
        resourceId: `${sourcePlatform}-manual:${result.diagnostics.parsedArtifactCount}:${result.diagnostics.mappingCount}`,
        sourcePlatform,
        outcome: 'completed',
      });
      return json({ result });
    }

    if (resource === 'jobs') {
      if (req.method === 'POST' && !id) {
        const body = await bodyJson(req);
        const providerId = typeof body.providerId === 'string' ? body.providerId.trim().slice(0, 160) : '';
        const provider = getLlmProvider(providerId);
        if (!provider) return json({ error: 'AI provider not found.' }, 404);
        assertMigrationProviderAllowed(provider.kind);
        const { system, prompt } = strictPromptFields(body);
        const schemaName = typeof body.schemaName === 'string' && body.schemaName.trim() ? body.schemaName.trim().slice(0, 120) : 'semantic_migration_proposal';
        const schema = isRecord(body.schema) ? body.schema : {};
        const task = migrationAiTask(body.task);
        if (!system || !prompt || !task || Object.keys(schema).length === 0) return json({ error: 'providerId, task, system, prompt, and schema are required.' }, 400);
        const stage = body.stage === 'compile' || body.stage === 'repair' ? body.stage : 'analyze';
        const semanticMigrationContract = semanticMigrationContractInput(body.semanticMigrationContract);
        if (body.semanticMigrationContract !== undefined && !semanticMigrationContract) {
          return json({ error: 'The semantic migration stage contract is invalid.' }, 400);
        }
        const projectId = typeof body.projectId === 'string' && body.projectId.trim()
          ? body.projectId.trim().slice(0, 200)
          : undefined;
        const targetModelId = typeof body.targetModelId === 'string' && body.targetModelId.trim()
          ? body.targetModelId.trim().slice(0, 200)
          : undefined;
        const branchId = typeof body.branchId === 'string' && body.branchId.trim()
          ? body.branchId.trim().slice(0, 200)
          : undefined;
        const idempotencyKey = req.headers.get('idempotency-key')
          || (typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined);
        const requestFingerprintSource = stableJson({
          providerId,
          providerConfigurationRevision: {
            updatedAt: provider.updatedAt,
            kind: provider.kind,
            model: provider.model,
            baseUrl: provider.baseUrl,
            linkedInstanceId: provider.linkedInstanceId,
            accountIdentifier: provider.accountIdentifier,
            warehouse: provider.warehouse,
            database: provider.database,
            schema: provider.schema,
            authMode: provider.authMode,
            enabled: provider.enabled,
            credentialExpiresAt: provider.credentialExpiresAt,
          },
          projectId,
          stage,
          task,
          system,
          prompt,
          schemaName,
          schema,
          targetModelId,
          branchId,
          semanticMigrationContract,
        });
        const lifecycleBase = {
          providerKind: provider.kind,
          providerId,
          projectId,
          stage,
        } satisfies SemanticMigrationLifecycleMetadata;
        let providerStartedAt = Date.now();
        const job = startSemanticMigrationJob({
          providerId,
          projectId,
          stage,
          requestFingerprintSource,
          idempotencyKey,
          onCreated: (createdJob) => recordSemanticMigrationLifecycleEvent('started', {
            ...lifecycleBase,
            jobId: createdJob.id,
          }),
          run: async (executionContext) => {
            providerStartedAt = Date.now();
            try {
              const currentProvider = getLlmProvider(providerId);
              if (!currentProvider || currentProvider.updatedAt !== provider.updatedAt) {
                throw Object.assign(new Error('The AI provider changed after this job was reviewed. Start a new job with the current provider configuration.'), {
                  statusCode: 409,
                  code: 'AI_PROVIDER_CONFIGURATION_STALE',
                });
              }
              const result = await generateStructuredProposal(currentProvider, {
                task,
                system,
                prompt,
                schemaName,
                schema,
                targetModelId,
                branchId,
                semanticMigrationContract,
              }, executionContext);
              const retries = result.telemetry?.providerRetries || 0;
              if (retries > 0) {
                recordLifecycleWithoutMaskingFailure('retried', {
                  ...lifecycleBase,
                  jobId: job.id,
                  requestId: result.telemetry?.requestId,
                  attemptCount: Math.min(100, retries + 1),
                  durationMs: result.telemetry?.durationMs,
                });
              }
              return result;
            } catch (caught) {
              const error = typedProviderExecutionError(caught);
              const failure = lifecycleErrorMetadata(error);
              if (failure.attemptCount && failure.attemptCount > 1) {
                recordLifecycleWithoutMaskingFailure('retried', {
                  ...lifecycleBase,
                  jobId: job.id,
                  requestId: failure.requestId,
                  attemptCount: failure.attemptCount,
                  durationMs: Date.now() - providerStartedAt,
                });
              }
              if (failure.circuitOpened || failure.errorCode === 'AI_PROVIDER_CIRCUIT_OPEN' || failure.errorCode === 'AI_PROVIDER_CIRCUIT_HALF_OPEN') {
                recordLifecycleWithoutMaskingFailure('circuit', {
                  ...lifecycleBase,
                  jobId: job.id,
                  requestId: failure.requestId,
                  attemptCount: failure.attemptCount,
                  durationMs: Date.now() - providerStartedAt,
                  statusCode: failure.statusCode,
                  errorCode: failure.errorCode,
                });
              }
              throw error;
            }
          },
          onSucceeded: (completedJob, value) => {
            const result = value as Awaited<ReturnType<typeof generateStructuredProposal>>;
            recordLifecycleWithoutMaskingFailure('completed', {
              ...lifecycleBase,
              jobId: completedJob.id,
              requestId: result.telemetry?.requestId,
              modelVersion: result.telemetry?.modelVersion,
              attemptCount: Math.min(100, Math.max(1, result.telemetry?.providerAttempts || 1)),
              durationMs: result.telemetry?.durationMs ?? Date.now() - providerStartedAt,
            });
          },
          onFailed: (failedJob, error) => {
            const failure = lifecycleErrorMetadata(error);
            recordLifecycleWithoutMaskingFailure('failed', {
              ...lifecycleBase,
              jobId: failedJob.id,
              requestId: failure.requestId,
              attemptCount: failure.attemptCount,
              durationMs: Date.now() - providerStartedAt,
              statusCode: failure.statusCode,
              errorCode: failure.errorCode,
            });
          },
        });
        return json({ job }, 202);
      }
    }

    if (resource === 'providers') {
      if (req.method === 'GET' && !id) {
        return json({ providers: listLlmProviders().map((provider) => ({ ...provider, capabilities: providerCapabilities(provider.kind) })) });
      }
      if ((req.method === 'POST' || req.method === 'PATCH') && (!id || !action)) {
        const body = await bodyJson(req);
        if (id) body.id = id;
        if (typeof body.kind === 'string') assertMigrationProviderAllowed(body.kind);
        const invalidUrl = validateSavedBaseUrl(body);
        if (invalidUrl) return invalidUrl;
        const provider = upsertLlmProvider(body);
        recordSemanticMigrationAuditEvent({ type: 'provider_saved', resourceId: provider.id, providerKind: provider.kind, outcome: 'completed' });
        return json({ provider: { ...provider, capabilities: providerCapabilities(provider.kind) } }, req.method === 'POST' ? 201 : 200);
      }
      if (req.method === 'DELETE' && id && !action) {
        deleteLlmProvider(id);
        recordSemanticMigrationAuditEvent({ type: 'provider_deleted', resourceId: id, outcome: 'completed' });
        return json({ ok: true });
      }
      if (req.method === 'POST' && id && action === 'test') {
        const provider = getLlmProvider(id);
        if (!provider) return json({ error: 'AI provider not found.' }, 404);
        const testedProviderUpdatedAt = provider.updatedAt;
        try {
          const result = await testLlmProvider(provider);
          recordSemanticMigrationAuditEvent({ type: 'provider_tested', resourceId: id, providerKind: provider.kind, outcome: 'completed' });
          return json({ ...result, provider: markLlmProviderValidated(id, testedProviderUpdatedAt) });
        } catch (error) {
          try {
            markLlmProviderValidationFailed(id, testedProviderUpdatedAt);
          } catch (markError) {
            if ((markError as { code?: string })?.code === 'AI_PROVIDER_CONFIGURATION_STALE') throw markError;
          }
          recordSemanticMigrationAuditEvent({ type: 'provider_tested', resourceId: id, providerKind: provider.kind, outcome: 'rejected' });
          throw error;
        }
      }
      if (req.method === 'POST' && id && action === 'generate') {
        return json({
          error: 'Direct AI provider generation has been retired. Start a durable semantic migration job instead.',
          code: 'AI_JOB_REQUIRED',
        }, 410);
      }
    }

    if (resource === 'platform-connections') {
      if (req.method === 'GET' && !id) return json({ connections: listPlatformConnections() });
      if ((req.method === 'POST' || req.method === 'PATCH') && (!id || !action)) {
        const body = await bodyJson(req);
        if (id) body.id = id;
        const invalidUrl = validateSavedBaseUrl(body);
        if (invalidUrl) return invalidUrl;
        const connection = upsertPlatformConnection(body);
        recordSemanticMigrationAuditEvent({ type: 'source_saved', resourceId: connection.id, sourcePlatform: connection.platform, outcome: 'completed' });
        return json({ connection }, req.method === 'POST' ? 201 : 200);
      }
      if (req.method === 'DELETE' && id && !action) {
        deletePlatformConnection(id);
        recordSemanticMigrationAuditEvent({ type: 'source_deleted', resourceId: id, outcome: 'completed' });
        return json({ ok: true });
      }
      if (req.method === 'POST' && id && action === 'test') {
        const connection = getPlatformConnection(id);
        if (!connection) return json({ error: 'Platform connection not found.' }, 404);
        const testedConnectionUpdatedAt = connection.updatedAt;
        let inventory: Awaited<ReturnType<typeof listSourceInventory>>;
        try {
          inventory = await listSourceInventory(connection, req.signal);
        } catch (error) {
          const cancelled = (error as { statusCode?: number; name?: string })?.statusCode === 499
            || (error as { name?: string })?.name === 'AbortError';
          if (!cancelled) {
            try {
              markPlatformConnectionValidationFailed(id, testedConnectionUpdatedAt);
            } catch (revisionError) {
              if ((revisionError as { statusCode?: number })?.statusCode === 409) throw revisionError;
            }
          }
          recordSemanticMigrationAuditEvent({
            type: 'source_tested',
            resourceId: id,
            sourcePlatform: connection.platform,
            outcome: 'rejected',
          });
          throw error;
        }
        // Catalog discovery is selection-only. Reaching a documented item/page
        // bound with no collection error still proves the exact credential and
        // tenant revision, while prepared evidence remains independently scoped,
        // fingerprinted, and fail-closed.
        const verified = sourceInventoryAuthenticationVerified(inventory);
        let testedConnectionState: ReturnType<typeof markPlatformConnectionValidated> | undefined;
        if (verified) {
          try {
            testedConnectionState = markPlatformConnectionValidated(id, testedConnectionUpdatedAt);
            // The compare-and-set above proves that only validation metadata changed
            // after this scan. Bind the returned inventory to the resulting exact
            // saved revision so follow-on evidence preparation can use its own CAS.
            inventory.connectionUpdatedAt = testedConnectionState.updatedAt;
          } catch (error) {
            recordSemanticMigrationAuditEvent({
              type: 'source_tested',
              resourceId: id,
              sourcePlatform: connection.platform,
              outcome: 'rejected',
            });
            throw error;
          }
        } else {
          testedConnectionState = markPlatformConnectionValidationFailed(id, testedConnectionUpdatedAt);
        }
        recordSemanticMigrationAuditEvent({
          type: 'source_tested',
          resourceId: id,
          sourcePlatform: connection.platform,
          outcome: verified ? 'completed' : 'rejected',
        });
        return json({
          ok: verified,
          platform: connection.platform,
          itemCount: inventory.items.length,
          inventory,
          ...(testedConnectionState ? { connection: testedConnectionState } : {}),
        });
      }
      if (req.method === 'GET' && id && action === 'inventory') {
        const connection = getPlatformConnection(id);
        if (!connection) return json({ error: 'Platform connection not found.' }, 404);
        return json({ inventory: await listSourceInventory(connection, req.signal) });
      }
      if (req.method === 'POST' && id && action === 'domo-evidence') {
        const connection = getPlatformConnection(id);
        if (!connection) return json({ error: 'Platform connection not found.' }, 404);
        if (connection.platform !== 'domo') return json({ error: 'Domo evidence preparation requires a saved Domo source.' }, 409);
        const body = await bodyJson(req);
        const expectedConnectionUpdatedAt = typeof body.connectionUpdatedAt === 'string'
          ? body.connectionUpdatedAt.trim()
          : '';
        if (!expectedConnectionUpdatedAt || connection.updatedAt !== expectedConnectionUpdatedAt) {
          return json({ error: 'The saved Domo source changed after inventory was loaded. Reload and test the current source before preparing evidence.' }, 409);
        }
        if (connection.lastValidatedRevision !== expectedConnectionUpdatedAt) {
          return json({ error: 'Test this exact saved source revision before preparing migration evidence.' }, 409);
        }
        const selectedDashboardIds = normalizeMigrationSourceRootIds(Array.isArray(body.selectedDashboardIds) ? body.selectedDashboardIds : []);
        const result = await prepareBoundedDomoApiEvidence(connection, selectedDashboardIds, { signal: req.signal });
        const currentConnection = getPlatformConnection(id);
        if (!currentConnection || currentConnection.updatedAt !== expectedConnectionUpdatedAt || result.connectionUpdatedAt !== expectedConnectionUpdatedAt) {
          return json({ error: 'The saved Domo source changed while evidence was being prepared. Reload and test the current source before continuing.' }, 409);
        }
        recordSemanticMigrationAuditEvent({
          type: 'source_evidence_prepared',
          resourceId: result.scopeFingerprint,
          sourcePlatform: 'domo',
          outcome: result.diagnostics.status === 'ready' ? 'completed' : 'rejected',
          telemetry: {
            selectedDashboardCount: result.diagnostics.selectedDashboardCount,
            resolvedCardCount: result.diagnostics.resolvedCardCount,
            resolvedDatasetCount: result.diagnostics.resolvedDatasetCount,
            blockerCount: result.diagnostics.blockers.length,
          },
        });
        return json({ result });
      }
      if (req.method === 'POST' && id && action === 'evidence') {
        const connection = getPlatformConnection(id);
        if (!connection) return json({ error: 'Platform connection not found.' }, 404);
        const body = await bodyJson(req);
        const expectedConnectionUpdatedAt = typeof body.connectionUpdatedAt === 'string'
          ? body.connectionUpdatedAt.trim()
          : '';
        if (!expectedConnectionUpdatedAt || connection.updatedAt !== expectedConnectionUpdatedAt) {
          return json({ error: 'The saved source changed after inventory was loaded. Reload and test the current source before preparing evidence.' }, 409);
        }
        if (connection.lastValidatedRevision !== expectedConnectionUpdatedAt) {
          return json({ error: 'Test this exact saved source revision before preparing migration evidence.' }, 409);
        }
        const selectedRootIds = normalizeMigrationSourceRootIds(Array.isArray(body.selectedRootIds) ? body.selectedRootIds : []);
        const result = await prepareSavedMigrationSourceEvidence(connection, selectedRootIds, { signal: req.signal });
        const currentConnection = getPlatformConnection(id);
        if (!currentConnection || currentConnection.updatedAt !== expectedConnectionUpdatedAt || result.connectionUpdatedAt !== expectedConnectionUpdatedAt) {
          return json({ error: 'The saved source changed while evidence was being prepared. Reload and test the current source before continuing.' }, 409);
        }
        recordSemanticMigrationAuditEvent({
          type: 'source_evidence_prepared',
          resourceId: result.scopeFingerprint,
          sourcePlatform: connection.platform,
          outcome: result.status === 'complete' ? 'completed' : 'rejected',
          telemetry: {
            selectedRootCount: result.selectedRootIds.length,
            artifactCount: result.artifacts.length,
            missingDependencyCount: result.dependencies.filter((dependency) => dependency.status === 'missing' || dependency.status === 'manual_required').length,
            requestCount: result.diagnostics.requestsMade,
          },
        });
        return json({ result });
      }
      if (req.method === 'POST' && id && action === 'validate-query') {
        const connection = getPlatformConnection(id);
        if (!connection) return json({ error: 'Platform connection not found.' }, 404);
        const body = await bodyJson(req);
        const result = await runLookerSourceValidationProbe(connection, body as unknown as LookerSourceValidationProbeInput);
        return json({ result });
      }
    }

    return json({ error: `Unknown Semantic Migration Studio route: ${path}` }, 404);
  } catch (error) {
    const status = typeof (error as { statusCode?: unknown }).statusCode === 'number'
      ? (error as { statusCode: number }).statusCode
      : 500;
    const code = error instanceof BiMigrationFoundationError
      ? error.code
      : error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : undefined;
    return json({
      error: error instanceof Error ? redactSensitiveText(error.message) : 'Semantic migration operation failed.',
      ...(code ? { code } : {}),
    }, status);
  }
}

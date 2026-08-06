import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { redactSensitiveText } from './jobSanitizer';

export type SemanticMigrationLifecycleState =
  | 'started'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'retried'
  | 'circuit';

export type SemanticMigrationLifecycleEventType =
  | 'ai_job_started'
  | 'ai_job_completed'
  | 'ai_job_failed'
  | 'ai_job_cancelled'
  | 'ai_job_retried'
  | 'ai_provider_circuit';

export type SemanticMigrationAuditEventType =
  | 'provider_saved'
  | 'provider_deleted'
  | 'provider_tested'
  | 'source_saved'
  | 'source_deleted'
  | 'source_tested'
  | 'source_evidence_prepared'
  | 'project_saved'
  | 'project_deleted'
  | 'manual_artifacts_parsed'
  | 'engine_artifacts_parsed'
  | 'engine_connections_confirmed'
  | 'engine_parity_recorded'
  | SemanticMigrationLifecycleEventType;

export type SemanticMigrationAuditProviderKind =
  | 'omni_ai'
  | 'openai'
  | 'anthropic'
  | 'snowflake_cortex'
  | 'databricks_genie'
  | 'databricks_model_serving'
  | 'custom_openai_compatible';

export type SemanticMigrationLifecycleStage = 'analyze' | 'compile' | 'repair';

export interface SemanticMigrationLifecycleMetadata {
  providerKind?: SemanticMigrationAuditProviderKind;
  providerId?: string;
  /** Compatibility-only input copied to the established top-level audit field. */
  projectId?: string;
  stage?: SemanticMigrationLifecycleStage;
  jobId?: string;
  requestId?: string;
  modelVersion?: string;
  attemptCount?: number;
  durationMs?: number;
  statusCode?: number;
  errorCode?: string;
}

type PersistedSemanticMigrationLifecycleMetadata = Omit<SemanticMigrationLifecycleMetadata, 'projectId'>;

interface SemanticMigrationAuditTelemetry {
  engineName?: string;
  engineVersion?: string;
  parserVersion?: string;
  rolloutMode?: 'off' | 'shadow' | 'primary';
  durationMs?: number;
  queueWaitMs?: number;
  fallbackReason?: 'engine_off' | 'engine_unavailable' | 'engine_failed' | 'native_unavailable';
  parityScore?: number;
  selectedDashboardCount?: number;
  resolvedCardCount?: number;
  resolvedDatasetCount?: number;
  blockerCount?: number;
}

export interface SemanticMigrationAuditEvent {
  id: string;
  type: SemanticMigrationAuditEventType;
  timestamp: string;
  resourceId?: string;
  providerKind?: string;
  sourcePlatform?: string;
  projectId?: string;
  outcome: 'accepted' | 'completed' | 'rejected';
  telemetry?: SemanticMigrationAuditTelemetry;
  lifecycle?: PersistedSemanticMigrationLifecycleMetadata;
}

const MAX_EVENTS = 2_000;
const DEFAULT_AUDIT_PATH = './data/semantic-migration-audit.json';
const AUDIT_EVENT_TYPES = new Set<SemanticMigrationAuditEventType>([
  'provider_saved',
  'provider_deleted',
  'provider_tested',
  'source_saved',
  'source_deleted',
  'source_tested',
  'source_evidence_prepared',
  'project_saved',
  'project_deleted',
  'manual_artifacts_parsed',
  'engine_artifacts_parsed',
  'engine_connections_confirmed',
  'engine_parity_recorded',
  'ai_job_started',
  'ai_job_completed',
  'ai_job_failed',
  'ai_job_cancelled',
  'ai_job_retried',
  'ai_provider_circuit',
]);
const LIFECYCLE_EVENT_TYPES = new Set<SemanticMigrationLifecycleEventType>([
  'ai_job_started',
  'ai_job_completed',
  'ai_job_failed',
  'ai_job_cancelled',
  'ai_job_retried',
  'ai_provider_circuit',
]);
const PROVIDER_KINDS = new Set<SemanticMigrationAuditProviderKind>([
  'omni_ai',
  'openai',
  'anthropic',
  'snowflake_cortex',
  'databricks_genie',
  'databricks_model_serving',
  'custom_openai_compatible',
]);
const LIFECYCLE_STAGES = new Set<SemanticMigrationLifecycleStage>(['analyze', 'compile', 'repair']);
const AUDIT_OUTCOMES = new Set<SemanticMigrationAuditEvent['outcome']>(['accepted', 'completed', 'rejected']);
const LIFECYCLE_EVENT_BY_STATE: Record<SemanticMigrationLifecycleState, SemanticMigrationLifecycleEventType> = {
  started: 'ai_job_started',
  completed: 'ai_job_completed',
  failed: 'ai_job_failed',
  cancelled: 'ai_job_cancelled',
  retried: 'ai_job_retried',
  circuit: 'ai_provider_circuit',
};
const LIFECYCLE_OUTCOME_BY_STATE: Record<SemanticMigrationLifecycleState, SemanticMigrationAuditEvent['outcome']> = {
  started: 'accepted',
  completed: 'completed',
  failed: 'rejected',
  cancelled: 'completed',
  retried: 'accepted',
  circuit: 'rejected',
};
const SAFE_AUDIT_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:+/-]*$/;
const SAFE_PROVIDER_METADATA_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const SECRET_SHAPED_AUDIT_TOKEN = /^(?:sk[-_]|rk[-_]|pk[-_]|gh[pousr]_|xox[a-z]-|omni_|AKIA|ASIA|AIza|ya29\.|eyJ[A-Za-z0-9_-]{10,}\.)/i;
const OPAQUE_INTERNAL_UUID = /^(?:(?:semantic_job|semantic_audit)_)?[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function auditPath(): string {
  return process.env.OMNIKIT_SEMANTIC_MIGRATION_AUDIT_PATH || DEFAULT_AUDIT_PATH;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : undefined;
}

function safeAuditToken(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maximumLength || !SAFE_AUDIT_TOKEN.test(trimmed)) return undefined;
  if (SECRET_SHAPED_AUDIT_TOKEN.test(trimmed)) return undefined;
  if (!OPAQUE_INTERNAL_UUID.test(trimmed) && redactSensitiveText(trimmed) !== trimmed) return undefined;
  return trimmed;
}

function safeLifecycleJobId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (/^semantic_job_/i.test(trimmed) && OPAQUE_INTERNAL_UUID.test(trimmed)) return trimmed;
  return safeAuditToken(trimmed, 200);
}

function safeProviderMetadataToken(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maximumLength || !SAFE_PROVIDER_METADATA_TOKEN.test(trimmed)) return undefined;
  if (redactSensitiveText(trimmed) !== trimmed || SECRET_SHAPED_AUDIT_TOKEN.test(trimmed)) return undefined;
  return trimmed;
}

function safeErrorCode(value: unknown): string | undefined {
  if (typeof value !== 'string' || !SAFE_ERROR_CODE.test(value)) return undefined;
  if (redactSensitiveText(value) !== value || SECRET_SHAPED_AUDIT_TOKEN.test(value)) return undefined;
  return value;
}

function sanitizedText(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return redactSensitiveText(value.trim()).slice(0, maximumLength);
}

function sanitizeTelemetry(value: unknown): SemanticMigrationAuditTelemetry | undefined {
  if (!isRecord(value)) return undefined;
  const telemetry: SemanticMigrationAuditTelemetry = {};
  const engineName = sanitizedText(value.engineName, 100);
  const engineVersion = sanitizedText(value.engineVersion, 50);
  const parserVersion = sanitizedText(value.parserVersion, 50);
  if (engineName) telemetry.engineName = engineName;
  if (engineVersion) telemetry.engineVersion = engineVersion;
  if (parserVersion) telemetry.parserVersion = parserVersion;
  if (value.rolloutMode === 'off' || value.rolloutMode === 'shadow' || value.rolloutMode === 'primary') telemetry.rolloutMode = value.rolloutMode;
  if (numeric(value.durationMs) !== undefined) telemetry.durationMs = numeric(value.durationMs);
  if (numeric(value.queueWaitMs) !== undefined) telemetry.queueWaitMs = numeric(value.queueWaitMs);
  if (value.fallbackReason === 'engine_off' || value.fallbackReason === 'engine_unavailable' || value.fallbackReason === 'engine_failed' || value.fallbackReason === 'native_unavailable') {
    telemetry.fallbackReason = value.fallbackReason;
  }
  if (numeric(value.parityScore) !== undefined) telemetry.parityScore = numeric(value.parityScore);
  if (numeric(value.selectedDashboardCount) !== undefined) telemetry.selectedDashboardCount = numeric(value.selectedDashboardCount);
  if (numeric(value.resolvedCardCount) !== undefined) telemetry.resolvedCardCount = numeric(value.resolvedCardCount);
  if (numeric(value.resolvedDatasetCount) !== undefined) telemetry.resolvedDatasetCount = numeric(value.resolvedDatasetCount);
  if (numeric(value.blockerCount) !== undefined) telemetry.blockerCount = numeric(value.blockerCount);
  return Object.keys(telemetry).length > 0 ? telemetry : undefined;
}

function sanitizeLifecycleMetadata(value: unknown): PersistedSemanticMigrationLifecycleMetadata | undefined {
  if (!isRecord(value)) return undefined;
  const lifecycle: PersistedSemanticMigrationLifecycleMetadata = {};
  if (typeof value.providerKind === 'string' && PROVIDER_KINDS.has(value.providerKind as SemanticMigrationAuditProviderKind)) {
    lifecycle.providerKind = value.providerKind as SemanticMigrationAuditProviderKind;
  }
  const providerId = safeAuditToken(value.providerId, 160);
  const jobId = safeLifecycleJobId(value.jobId);
  const requestId = safeProviderMetadataToken(value.requestId, 96);
  const modelVersion = safeProviderMetadataToken(value.modelVersion, 80);
  if (providerId) lifecycle.providerId = providerId;
  if (typeof value.stage === 'string' && LIFECYCLE_STAGES.has(value.stage as SemanticMigrationLifecycleStage)) {
    lifecycle.stage = value.stage as SemanticMigrationLifecycleStage;
  }
  if (jobId) lifecycle.jobId = jobId;
  if (requestId) lifecycle.requestId = requestId;
  if (modelVersion) lifecycle.modelVersion = modelVersion;
  const attemptCount = boundedInteger(value.attemptCount, 1, 100);
  const durationMs = boundedInteger(value.durationMs, 0, Number.MAX_SAFE_INTEGER);
  const statusCode = boundedInteger(value.statusCode, 100, 599);
  if (attemptCount !== undefined) lifecycle.attemptCount = attemptCount;
  if (durationMs !== undefined) lifecycle.durationMs = durationMs;
  if (statusCode !== undefined) lifecycle.statusCode = statusCode;
  const errorCode = safeErrorCode(value.errorCode);
  if (errorCode) lifecycle.errorCode = errorCode;
  return Object.keys(lifecycle).length > 0 ? lifecycle : undefined;
}

function lifecycleMetadataForEvent(
  type: SemanticMigrationAuditEventType,
  value: unknown,
  legacyProviderKind?: string,
  legacyResourceId?: string,
): PersistedSemanticMigrationLifecycleMetadata | undefined {
  if (!LIFECYCLE_EVENT_TYPES.has(type as SemanticMigrationLifecycleEventType)) return undefined;
  const source = isRecord(value) ? value : {};
  return sanitizeLifecycleMetadata({
    ...source,
    providerKind: source.providerKind ?? legacyProviderKind,
    jobId: source.jobId ?? legacyResourceId,
  });
}

function normalizePersistedAuditEvent(value: unknown): SemanticMigrationAuditEvent | null {
  if (!isRecord(value) || typeof value.type !== 'string' || !AUDIT_EVENT_TYPES.has(value.type as SemanticMigrationAuditEventType)) return null;
  if (typeof value.outcome !== 'string' || !AUDIT_OUTCOMES.has(value.outcome as SemanticMigrationAuditEvent['outcome'])) return null;
  const id = safeAuditToken(value.id, 200);
  const timestamp = sanitizedText(value.timestamp, 80);
  if (!id || !timestamp) return null;
  const event: SemanticMigrationAuditEvent = {
    id,
    type: value.type as SemanticMigrationAuditEventType,
    timestamp,
    outcome: value.outcome as SemanticMigrationAuditEvent['outcome'],
  };
  const providerKind = safeAuditToken(value.providerKind, 100);
  const lifecycle = lifecycleMetadataForEvent(value.type as SemanticMigrationAuditEventType, value.lifecycle, providerKind, typeof value.resourceId === 'string' ? value.resourceId : undefined);
  const resourceId = LIFECYCLE_EVENT_TYPES.has(value.type as SemanticMigrationLifecycleEventType)
    ? lifecycle?.jobId
    : safeAuditToken(value.resourceId, 200);
  const sourcePlatform = safeAuditToken(value.sourcePlatform, 100);
  const projectId = safeAuditToken(value.projectId, 200);
  if (resourceId) event.resourceId = resourceId;
  if (providerKind) event.providerKind = providerKind;
  if (sourcePlatform) event.sourcePlatform = sourcePlatform;
  if (projectId) event.projectId = projectId;
  const telemetry = sanitizeTelemetry(value.telemetry);
  if (telemetry) event.telemetry = telemetry;
  if (lifecycle) event.lifecycle = lifecycle;
  return event;
}

function readAuditEventsFromPath(path: string): SemanticMigrationAuditEvent[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((value) => {
      const event = normalizePersistedAuditEvent(value);
      return event ? [event] : [];
    }).slice(0, MAX_EVENTS);
  } catch {
    return [];
  }
}

function writeAuditEventsAtomically(path: string, events: SemanticMigrationAuditEvent[]): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, 'wx', 0o600);
    writeFileSync(descriptor, JSON.stringify(events.slice(0, MAX_EVENTS), null, 2), { encoding: 'utf8' });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, path);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    throw error;
  }
}

export function listSemanticMigrationAuditEvents(): SemanticMigrationAuditEvent[] {
  return readAuditEventsFromPath(auditPath());
}

export function recordSemanticMigrationAuditEvent(input: Omit<SemanticMigrationAuditEvent, 'id' | 'timestamp'>): SemanticMigrationAuditEvent {
  if (!AUDIT_EVENT_TYPES.has(input.type)) {
    throw Object.assign(new Error('Semantic migration audit event type is not permitted.'), { statusCode: 400 });
  }
  if (!AUDIT_OUTCOMES.has(input.outcome)) {
    throw Object.assign(new Error('Semantic migration audit outcome is not permitted.'), { statusCode: 400 });
  }
  const lifecycle = lifecycleMetadataForEvent(input.type, input.lifecycle, input.providerKind, input.resourceId);
  if (LIFECYCLE_EVENT_TYPES.has(input.type as SemanticMigrationLifecycleEventType) && !lifecycle?.jobId) {
    throw Object.assign(new Error('Semantic migration lifecycle events require a valid job identifier.'), { statusCode: 400 });
  }
  const resourceId = LIFECYCLE_EVENT_TYPES.has(input.type as SemanticMigrationLifecycleEventType)
    ? lifecycle?.jobId
    : safeAuditToken(input.resourceId, 200);
  const event: SemanticMigrationAuditEvent = {
    id: `semantic_audit_${randomUUID()}`,
    type: input.type,
    timestamp: new Date().toISOString(),
    resourceId,
    providerKind: safeAuditToken(input.providerKind, 100),
    sourcePlatform: safeAuditToken(input.sourcePlatform, 100),
    projectId: safeAuditToken(input.projectId, 200),
    outcome: input.outcome,
  };
  const telemetry = sanitizeTelemetry(input.telemetry);
  if (telemetry) event.telemetry = telemetry;
  if (lifecycle) event.lifecycle = lifecycle;
  const path = auditPath();
  writeAuditEventsAtomically(path, [event, ...readAuditEventsFromPath(path)]);
  return event;
}

export function recordSemanticMigrationLifecycleEvent(
  state: SemanticMigrationLifecycleState,
  metadata: SemanticMigrationLifecycleMetadata,
): SemanticMigrationAuditEvent {
  if (!Object.prototype.hasOwnProperty.call(LIFECYCLE_EVENT_BY_STATE, state)) {
    throw Object.assign(new Error('Semantic migration lifecycle state is not permitted.'), { statusCode: 400 });
  }
  const lifecycle = sanitizeLifecycleMetadata(metadata);
  const projectId = safeAuditToken(metadata.projectId, 200);
  return recordSemanticMigrationAuditEvent({
    type: LIFECYCLE_EVENT_BY_STATE[state],
    resourceId: lifecycle?.jobId,
    providerKind: lifecycle?.providerKind,
    projectId,
    outcome: LIFECYCLE_OUTCOME_BY_STATE[state],
    lifecycle,
  });
}

export function migrationProviderAllowlist(): string[] {
  return (process.env.OMNIKIT_MIGRATION_PROVIDER_ALLOWLIST || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

export function migrationProviderHostAllowlist(): string[] {
  return (process.env.OMNIKIT_MIGRATION_PROVIDER_HOST_ALLOWLIST || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

export function migrationSourceHostAllowlist(): string[] {
  return (process.env.OMNIKIT_MIGRATION_SOURCE_HOST_ALLOWLIST || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

export function assertMigrationProviderAllowed(kind: string): void {
  const allowlist = migrationProviderAllowlist();
  if (allowlist.length > 0 && !allowlist.includes(kind)) {
    throw Object.assign(new Error(`AI provider kind is not permitted by OMNIKIT_MIGRATION_PROVIDER_ALLOWLIST: ${kind}.`), { statusCode: 403 });
  }
}

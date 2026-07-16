import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { redactSensitiveText } from './jobSanitizer';

export type SemanticMigrationAuditEventType =
  | 'provider_saved'
  | 'provider_deleted'
  | 'provider_tested'
  | 'source_saved'
  | 'source_deleted'
  | 'source_tested'
  | 'project_saved'
  | 'project_deleted'
  | 'manual_artifacts_parsed'
  | 'engine_artifacts_parsed'
  | 'engine_parity_recorded'
  | 'ai_job_started'
  | 'ai_job_cancelled';

export interface SemanticMigrationAuditEvent {
  id: string;
  type: SemanticMigrationAuditEventType;
  timestamp: string;
  resourceId?: string;
  providerKind?: string;
  sourcePlatform?: string;
  projectId?: string;
  outcome: 'accepted' | 'completed' | 'rejected';
  telemetry?: {
    engineName?: string;
    engineVersion?: string;
    parserVersion?: string;
    rolloutMode?: 'off' | 'shadow' | 'primary';
    durationMs?: number;
    queueWaitMs?: number;
    fallbackReason?: 'engine_off' | 'engine_unavailable' | 'engine_failed' | 'native_unavailable';
    parityScore?: number;
  };
}

const MAX_EVENTS = 2_000;
const DEFAULT_AUDIT_PATH = './data/semantic-migration-audit.json';

function auditPath(): string {
  return process.env.OMNIKIT_SEMANTIC_MIGRATION_AUDIT_PATH || DEFAULT_AUDIT_PATH;
}

export function listSemanticMigrationAuditEvents(): SemanticMigrationAuditEvent[] {
  const path = auditPath();
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return Array.isArray(parsed) ? parsed.filter((event): event is SemanticMigrationAuditEvent => Boolean(event?.id)).slice(0, MAX_EVENTS) : [];
  } catch {
    return [];
  }
}

export function recordSemanticMigrationAuditEvent(input: Omit<SemanticMigrationAuditEvent, 'id' | 'timestamp'>): SemanticMigrationAuditEvent {
  const numeric = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
  const telemetry = input.telemetry ? {
    engineName: input.telemetry.engineName ? redactSensitiveText(input.telemetry.engineName).slice(0, 100) : undefined,
    engineVersion: input.telemetry.engineVersion ? redactSensitiveText(input.telemetry.engineVersion).slice(0, 50) : undefined,
    parserVersion: input.telemetry.parserVersion ? redactSensitiveText(input.telemetry.parserVersion).slice(0, 50) : undefined,
    rolloutMode: input.telemetry.rolloutMode,
    durationMs: numeric(input.telemetry.durationMs),
    queueWaitMs: numeric(input.telemetry.queueWaitMs),
    fallbackReason: input.telemetry.fallbackReason,
    parityScore: numeric(input.telemetry.parityScore),
  } : undefined;
  const event: SemanticMigrationAuditEvent = {
    id: `semantic_audit_${randomUUID()}`,
    type: input.type,
    timestamp: new Date().toISOString(),
    resourceId: input.resourceId ? redactSensitiveText(input.resourceId).slice(0, 200) : undefined,
    providerKind: input.providerKind ? redactSensitiveText(input.providerKind).slice(0, 100) : undefined,
    sourcePlatform: input.sourcePlatform ? redactSensitiveText(input.sourcePlatform).slice(0, 100) : undefined,
    projectId: input.projectId ? redactSensitiveText(input.projectId).slice(0, 200) : undefined,
    outcome: input.outcome,
    telemetry,
  };
  const path = auditPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify([event, ...listSemanticMigrationAuditEvents()].slice(0, MAX_EVENTS), null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
  return event;
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

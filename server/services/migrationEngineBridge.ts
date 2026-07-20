import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import {
  MIGRATION_ENGINE_BRIDGE_SCHEMA_VERSION,
  migrationInventoryFromEngine,
  parseMigrationEngineConformanceResult,
  parseMigrationEngineBridgeResult,
  type MigrationEngineConformanceResult,
  type MigrationEngineBridgeResult,
  type MigrationEngineSource,
} from '../../src/services/semanticMigration/engineBridge';
import {
  buildMigrationEngineParityReport,
  buildMigrationParityManifest,
  migrationEnginePromotionRequirements,
} from '../../src/services/semanticMigration/engineParity';
import type { MigrationEngineParityReport } from '../../src/services/semanticMigration/engineParity';
import type { MigrationInventory } from '../../src/services/semanticMigration/types';
import { redactSensitiveText } from './jobSanitizer';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_ENGINE_OUTPUT_BYTES = 50 * 1024 * 1024;
const MAX_ENGINE_ARTIFACTS = 2_000;
const MAX_ENGINE_ARTIFACT_BYTES = 1_000_000_000;
const MANAGED_ENGINE_ROOT = resolve(process.cwd(), 'data/migration-engine/source');
const FIRST_PARTY_ENGINE_ROOT = resolve(process.cwd(), 'packages/omnikit-migration-engine');
const MANAGED_ENGINE_MANIFEST = resolve(process.cwd(), 'data/migration-engine/manifest.json');
const ENGINE_TEMP_PREFIX = 'omnikit-migration-engine-';
const EXPECTED_ENGINE_NAME = 'omni-migrator';
const EXPECTED_ENGINE_MAJOR = 0;
const DEFAULT_MAX_CONCURRENCY = 2;
const DEFAULT_MAX_QUEUE = 8;
const DEFAULT_MEMORY_MB = 1_024;
const DEFAULT_TEMP_MAX_AGE_MS = 60 * 60_000;
const DEFAULT_PROMOTION_PATH = resolve(process.cwd(), 'data/migration-engine/promotions.json');
const DEFAULT_PARITY_OBSERVATION_PATH = resolve(process.cwd(), 'data/migration-engine/parity-observations.json');
const PARITY_ATTESTATION_MAX_AGE_MS = 30 * 60_000;
const PARITY_ATTESTATION_LIMIT = 100;
const MIGRATION_ENGINE_SOURCES: MigrationEngineSource[] = ['looker', 'powerbi', 'tableau', 'metabase', 'sigma'];

function migrationEngineManifestPath(): string {
  return resolve(process.env.OMNIKIT_MIGRATION_ENGINE_MANIFEST_PATH || MANAGED_ENGINE_MANIFEST);
}

function readManagedEngineManifest(): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(migrationEngineManifestPath(), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export type MigrationEngineRolloutMode = 'off' | 'shadow' | 'primary';

interface QueueWaiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abort?: () => void;
}

let activeEngineProcesses = 0;
const engineQueue: QueueWaiter[] = [];
const inFlightRequestIds = new Map<string, string>();
let cleanupPromise: Promise<number> | null = null;
let validatedCapabilities: { root: string; value: Record<string, unknown> } | null = null;
const canonicalConformanceCache = new Map<string, CanonicalConformanceAttestation>();
let parityObservationWrite: Promise<unknown> = Promise.resolve();
const completedExtractionAttestations = new Map<string, CompletedExtractionAttestation>();

export interface MigrationEngineArtifactInput {
  name: string;
  content: string | Uint8Array;
}

export interface MigrationEngineExtractInput {
  requestId: string;
  source: MigrationEngineSource;
  mode: 'manual' | 'api';
  artifacts?: MigrationEngineArtifactInput[];
  connection?: { baseUrl: string; auth: Record<string, unknown> };
  defaultSchema?: string;
  scope?: Record<string, unknown>;
  includeModelSuggestions?: boolean;
  rulebookVersion?: string;
  targetConnections?: Array<{
    id: string;
    name: string;
    dialect: string;
    database?: string;
    defaultSchema?: string;
  }>;
  connectionOverrides?: Record<string, string>;
  parityBaseline?: MigrationInventory;
  parityBaselineSource?: 'server_native' | 'canonical_fixture';
  parityComparisonType?: 'native_differential' | 'canonical_conformance';
  signal?: AbortSignal;
}

interface CompletedExtractionAttestation {
  requestId: string;
  requestFingerprint: string;
  resultFingerprint: string;
  baselineFingerprint?: string;
  baselineSource?: 'server_native' | 'canonical_fixture';
  comparisonType: 'native_differential' | 'canonical_conformance';
  baseline?: MigrationInventory;
  canonicalConformance?: CanonicalConformanceAttestation;
  result: MigrationEngineBridgeResult;
  rolloutMode: MigrationEngineRolloutMode;
  completedAt: string;
}

interface CanonicalConformanceAttestation {
  source: MigrationEngineSource;
  engineVersion: string;
  manifestSha256: string;
  expectedSha256: string;
}

interface EngineProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  queueWaitMs: number;
  durationMs: number;
}

function statusError(message: string, statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

export function applyMigrationEngineConnectionOverrides(
  input: Pick<MigrationEngineExtractInput, 'connectionOverrides' | 'targetConnections'>,
  result: MigrationEngineBridgeResult,
): MigrationEngineBridgeResult {
  const overrides = input.connectionOverrides || {};
  if (Object.keys(overrides).length === 0) return result;

  const targetsById = new Map((input.targetConnections || []).map((connection) => [connection.id, connection]));
  for (const targetConnectionId of Object.values(overrides)) {
    if (!targetsById.has(targetConnectionId)) {
      throw statusError('A migration connection override references a destination that is not available to this request.', 400);
    }
  }

  return {
    ...result,
    connection_mappings: (result.connection_mappings || []).map((mapping) => {
      const targetConnectionId = overrides[mapping.source_key];
      if (!targetConnectionId) return mapping;
      const target = targetsById.get(targetConnectionId)!;
      const existingCandidates = mapping.candidates || [];
      const candidate = {
        id: target.id,
        name: target.name,
        dialect: target.dialect,
        database: target.database || null,
        default_schema: target.defaultSchema || null,
      };
      return {
        ...mapping,
        target_connection_id: target.id,
        target_connection_name: target.name,
        target_dialect: target.dialect,
        target_database: target.database || null,
        target_default_schema: target.defaultSchema || null,
        reason: 'Confirmed by operator mapping override.',
        candidate_ids: Array.from(new Set([...mapping.candidate_ids, target.id])),
        candidates: existingCandidates.some((item) => item.id === target.id)
          ? existingCandidates
          : [...existingCandidates, candidate],
        confirmed: true,
      };
    }),
  };
}

function sensitiveStringValues(value: unknown): string[] {
  if (typeof value === 'string') return value.length >= 4 ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(sensitiveStringValues);
  if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>).flatMap(sensitiveStringValues);
  return [];
}

export function redactMigrationEngineErrorText(value: string, sensitiveValues: string[] = []): string {
  return sensitiveValues
    .filter((secret) => secret.length >= 4)
    .sort((left, right) => right.length - left.length)
    .reduce((message, secret) => message.split(secret).join('[redacted]'), redactSensitiveText(value));
}

export function assertMigrationEngineOutputContainsNoSecrets(value: unknown, sensitiveValues: string[]): void {
  const serialized = JSON.stringify(value);
  if (sensitiveValues.some((secret) => secret.length >= 4 && serialized.includes(secret))) {
    throw statusError('Migration engine output contained source credentials and was rejected.', 502);
  }
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(Math.floor(parsed), maximum)) : fallback;
}

export function migrationEngineQueueLimits(): { maxConcurrency: number; maxQueue: number } {
  return {
    maxConcurrency: boundedInteger(process.env.OMNIKIT_MIGRATION_ENGINE_MAX_CONCURRENCY, DEFAULT_MAX_CONCURRENCY, 1, 16),
    maxQueue: boundedInteger(process.env.OMNIKIT_MIGRATION_ENGINE_MAX_QUEUE, DEFAULT_MAX_QUEUE, 0, 100),
  };
}

function releaseEngineSlot(): void {
  activeEngineProcesses = Math.max(0, activeEngineProcesses - 1);
  const next = engineQueue.shift();
  if (!next) return;
  if (next.abort) next.signal?.removeEventListener('abort', next.abort);
  activeEngineProcesses += 1;
  next.resolve(releaseEngineSlot);
}

function acquireEngineSlot(signal?: AbortSignal): Promise<() => void> {
  const limits = migrationEngineQueueLimits();
  if (signal?.aborted) return Promise.reject(statusError('Migration engine request was cancelled before execution.', 499));
  if (activeEngineProcesses < limits.maxConcurrency) {
    activeEngineProcesses += 1;
    return Promise.resolve(releaseEngineSlot);
  }
  if (engineQueue.length >= limits.maxQueue) {
    return Promise.reject(statusError('Migration engine capacity is full. Retry after an active analysis finishes.', 429));
  }
  return new Promise((resolveSlot, rejectSlot) => {
    const waiter: QueueWaiter = { resolve: resolveSlot, reject: rejectSlot, signal };
    waiter.abort = () => {
      const index = engineQueue.indexOf(waiter);
      if (index >= 0) engineQueue.splice(index, 1);
      rejectSlot(statusError('Migration engine request was cancelled while queued.', 499));
    };
    signal?.addEventListener('abort', waiter.abort, { once: true });
    engineQueue.push(waiter);
  });
}

export function migrationEngineRoot(): string | null {
  if (String(process.env.OMNIKIT_MIGRATION_ENGINE_ENABLED || 'true').toLowerCase() === 'false') return null;
  if (process.env.NODE_ENV === 'production') {
    return existsSync(join(MANAGED_ENGINE_ROOT, 'src/omni_migrator/bridge.py')) ? MANAGED_ENGINE_ROOT : null;
  }
  const candidates = [
    MANAGED_ENGINE_ROOT,
    FIRST_PARTY_ENGINE_ROOT,
  ];
  return candidates.find((candidate) => existsSync(join(candidate, 'src/omni_migrator/bridge.py'))) || null;
}

function migrationEnginePython(root: string): string {
  const configured = process.env.OMNIKIT_MIGRATION_ENGINE_PYTHON;
  if (configured) return configured;
  const candidates = [
    resolve(process.cwd(), 'data/migration-engine/venv/Scripts/python.exe'),
    resolve(process.cwd(), 'data/migration-engine/venv/bin/python'),
    join(root, '.venv', 'Scripts', 'python.exe'),
    join(root, '.venv', 'bin', 'python'),
  ];
  return candidates.find((candidate) => existsSync(candidate))
    || (process.platform === 'win32' ? 'python' : 'python3');
}

function managedEngineRevision(root: string): string | undefined {
  try {
    const manifest = readManagedEngineManifest() as { sourceRoot?: unknown; sourceRevision?: unknown } | null;
    if (!manifest) return undefined;
    if (manifest.sourceRoot !== root || typeof manifest.sourceRevision !== 'string' || !manifest.sourceRevision.trim()) return undefined;
    return manifest.sourceRevision.trim();
  } catch {
    return undefined;
  }
}

function migrationEngineSourceEnabled(source: MigrationEngineSource): boolean {
  const configured = String(process.env.OMNIKIT_MIGRATION_ENGINE_SOURCES || '').trim();
  if (!configured) return true;
  const enabled = new Set(configured.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean));
  return enabled.has(source);
}

function rolloutMode(value: unknown, fallback: MigrationEngineRolloutMode): MigrationEngineRolloutMode {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'off' || normalized === 'shadow' || normalized === 'primary' ? normalized : fallback;
}

function requestedMigrationEngineRolloutMode(source: MigrationEngineSource): MigrationEngineRolloutMode {
  if (!migrationEngineSourceEnabled(source)) return 'off';
  const sourceKey = `OMNIKIT_MIGRATION_ENGINE_MODE_${source.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
  const defaultMode = rolloutMode(process.env.OMNIKIT_MIGRATION_ENGINE_MODE, 'shadow');
  return rolloutMode(process.env[sourceKey], defaultMode);
}

export function migrationEnginePromotionGate(source: MigrationEngineSource): { approved: boolean; reason: string; observationCount: number } {
  if (String(process.env.OMNIKIT_MIGRATION_ENGINE_ALLOW_UNGATED_PRIMARY || '').toLowerCase() === 'true') {
    return { approved: true, reason: 'Emergency ungated primary override is active.', observationCount: 0 };
  }
  const requirements = migrationEnginePromotionRequirements(source);
  const path = process.env.OMNIKIT_MIGRATION_ENGINE_PROMOTION_PATH || DEFAULT_PROMOTION_PATH;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { schemaVersion?: unknown; sources?: Record<string, unknown> };
    const raw = parsed.schemaVersion === 'omnikit.migration.engine-promotions.v1' && parsed.sources && typeof parsed.sources[source] === 'object' && parsed.sources[source]
      ? parsed.sources[source] as Record<string, unknown>
      : null;
    if (!raw) return { approved: false, reason: 'No valid source promotion record exists.', observationCount: 0 };
    const scores = raw.scores && typeof raw.scores === 'object' ? raw.scores as Record<string, unknown> : {};
    const observationCount = boundedInteger(raw.observationCount, 0, 0, 1_000_000);
    const approvedAt = typeof raw.approvedAt === 'string' && Number.isFinite(Date.parse(raw.approvedAt));
    const approvedBy = typeof raw.approvedBy === 'string' && Boolean(raw.approvedBy.trim());
    const rollbackDrill = raw.rollbackDrill && typeof raw.rollbackDrill === 'object'
      ? raw.rollbackDrill as Record<string, unknown>
      : {};
    const rollbackDrillPassed = typeof rollbackDrill.id === 'string'
      && Boolean(rollbackDrill.id.trim())
      && typeof rollbackDrill.completedAt === 'string'
      && Number.isFinite(Date.parse(rollbackDrill.completedAt))
      && typeof rollbackDrill.completedBy === 'string'
      && Boolean(rollbackDrill.completedBy.trim())
      && /^[a-f0-9]{64}$/i.test(String(rollbackDrill.ledgerSha256 || ''));
    const liveAcceptance = raw.liveAcceptance && typeof raw.liveAcceptance === 'object'
      ? raw.liveAcceptance as Record<string, unknown>
      : {};
    const liveAcceptancePassed = liveAcceptance.schemaVersion === 'omnikit.migration-engine-live-acceptance.v2'
      && liveAcceptance.source === source
      && typeof liveAcceptance.recordedAt === 'string'
      && Number.isFinite(Date.parse(liveAcceptance.recordedAt))
      && typeof liveAcceptance.finalizedAt === 'string'
      && Number.isFinite(Date.parse(liveAcceptance.finalizedAt))
      && typeof liveAcceptance.expiresAt === 'string'
      && Number.isFinite(Date.parse(liveAcceptance.expiresAt))
      && Date.parse(liveAcceptance.expiresAt) > Date.now()
      && typeof liveAcceptance.owner === 'string'
      && Boolean(liveAcceptance.owner.trim())
      && /^[a-f0-9]{40}$/i.test(String(liveAcceptance.omnikitCommitSha || ''))
      && /^[a-f0-9]{64}$/i.test(String(liveAcceptance.evidenceSha256 || ''))
      && Number(liveAcceptance.viewCount) > 0
      && Number(liveAcceptance.dashboardCount) > 0
      && Number(liveAcceptance.connectionMappingCount) > 0
      && Number(liveAcceptance.stageCount) === 8
      && Number(liveAcceptance.acceptedGapCount) >= 0
      && Number(liveAcceptance.deferredGapCount) >= 0;
    const rolledBack = typeof raw.rolledBackAt === 'string' && Number.isFinite(Date.parse(raw.rolledBackAt));
    const engine = raw.engine && typeof raw.engine === 'object' ? raw.engine as Record<string, unknown> : {};
    const conformance = raw.conformance && typeof raw.conformance === 'object' ? raw.conformance as Record<string, unknown> : {};
    const manifest = readManagedEngineManifest();
    const manifestConformance = manifest?.conformance && typeof manifest.conformance === 'object'
      ? manifest.conformance as Record<string, unknown>
      : {};
    const manifestSources = manifestConformance.sources && typeof manifestConformance.sources === 'object'
      ? manifestConformance.sources as Record<string, unknown>
      : {};
    const sourceConformance = manifestSources[source] && typeof manifestSources[source] === 'object'
      ? manifestSources[source] as Record<string, unknown>
      : {};
    const provenancePassed = engine.name === EXPECTED_ENGINE_NAME
      && typeof engine.version === 'string'
      && /^[a-f0-9]{40,64}$/i.test(String(engine.sourceRevision || ''))
      && !String(engine.sourceRevision).endsWith('-dirty')
      && /^[a-f0-9]{64}$/i.test(String(engine.sourceContentSha256 || ''))
      && conformance.schemaVersion === 'omnikit.migration.conformance-run.v1'
      && /^[a-f0-9]{64}$/i.test(String(conformance.manifestSha256 || ''))
      && conformance.manifestSha256 === conformance.expectedSha256
      && manifest?.schemaVersion === 2
      && manifest.engine === engine.name
      && manifest.version === engine.version
      && manifest.sourceRevision === engine.sourceRevision
      && manifest.sourceContentSha256 === engine.sourceContentSha256
      && manifest.conformanceSchemaVersion === conformance.schemaVersion
      && sourceConformance.passed === true
      && sourceConformance.manifest_sha256 === conformance.manifestSha256
      && sourceConformance.expected_sha256 === conformance.expectedSha256;
    const passes = approvedAt
      && approvedBy
      && rollbackDrillPassed
      && liveAcceptancePassed
      && !rolledBack
      && provenancePassed
      && observationCount >= requirements.observations
      && Number(scores.semantic) >= requirements.semantic
      && Number(scores.dashboards) >= requirements.dashboards
      && Number(scores.stableIdentity) >= requirements.stableIdentity
      && Number(scores.overall) >= requirements.overall;
    return passes
      ? { approved: true, reason: 'Source parity, live acceptance, observation, and named approval requirements passed.', observationCount }
      : rolledBack
        ? { approved: false, reason: 'This source promotion was rolled back and remains in shadow mode.', observationCount }
        : { approved: false, reason: 'The promotion record does not meet source parity, finalized live-acceptance, conformance, clean provenance, observation, verified rollback-drill, expiry, and named approval requirements.', observationCount };
  } catch {
    return { approved: false, reason: 'No readable source promotion record exists.', observationCount: 0 };
  }
}

interface StoredParityObservation {
  attestationVersion: 'server.v1';
  observationType: 'native_parity' | 'canonical_conformance' | 'operational';
  requestId: string;
  requestFingerprint: string;
  resultFingerprint: string;
  baselineFingerprint: string;
  baselineSource: 'server_native' | 'canonical_fixture';
  comparisonType: 'native_differential' | 'canonical_conformance';
  canonicalFixtureSha256?: string;
  generatedAt: string;
  source: MigrationEngineSource;
  mode: MigrationEngineRolloutMode;
  engineName: string;
  engineVersion: string;
  parserVersion: string;
  rulebookVersion: string;
  scores: MigrationEngineParityReport['scores'];
  durationMs?: number;
  queueWaitMs?: number;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function pruneCompletedExtractionAttestations(now = Date.now()): void {
  for (const [requestId, attestation] of completedExtractionAttestations) {
    if (now - Date.parse(attestation.completedAt) > PARITY_ATTESTATION_MAX_AGE_MS) completedExtractionAttestations.delete(requestId);
  }
  while (completedExtractionAttestations.size > PARITY_ATTESTATION_LIMIT) {
    const oldest = completedExtractionAttestations.keys().next().value as string | undefined;
    if (!oldest) break;
    completedExtractionAttestations.delete(oldest);
  }
}

export function attestCompletedMigrationEngineExtraction(
  input: MigrationEngineExtractInput,
  result: MigrationEngineBridgeResult,
  fingerprint = requestFingerprint(input),
  canonicalConformance?: CanonicalConformanceAttestation,
): void {
  if (result.request_id !== input.requestId || result.source !== input.source || result.mode !== input.mode) {
    throw statusError('Migration engine extraction identity does not match its server request attestation.', 502);
  }
  pruneCompletedExtractionAttestations();
  const baselineManifest = input.parityBaseline ? buildMigrationParityManifest(input.parityBaseline) : undefined;
  completedExtractionAttestations.set(input.requestId, {
    requestId: input.requestId,
    requestFingerprint: fingerprint,
    resultFingerprint: sha256({
      schemaVersion: result.schema_version,
      engine: result.engine,
      source: result.source,
      mode: result.mode,
      provenance: result.provenance,
      capabilityCoverage: result.capability_coverage,
      bundle: result.bundle,
      connectionMappings: result.connection_mappings || [],
      suggestions: result.model_suggestions,
      diagnostics: result.diagnostics,
    }),
    baselineFingerprint: baselineManifest ? sha256(baselineManifest) : undefined,
    baselineSource: input.parityBaselineSource,
    comparisonType: input.parityBaseline
      ? 'native_differential'
      : input.parityComparisonType || 'canonical_conformance',
    baseline: input.parityBaseline,
    canonicalConformance,
    result,
    rolloutMode: result.control_plane?.rollout_mode || migrationEngineRolloutMode(result.source),
    completedAt: new Date().toISOString(),
  });
  pruneCompletedExtractionAttestations();
}

function parityObservationsFromAttestation(attestation: CompletedExtractionAttestation): StoredParityObservation[] {
  if ((!attestation.baseline || !attestation.baselineFingerprint || !attestation.baselineSource) && !attestation.canonicalConformance) {
    throw statusError('This extraction has no server-generated parity baseline and cannot become promotion evidence.', 409);
  }
  if (attestation.rolloutMode !== 'shadow') {
    throw statusError('Only shadow-mode extractions can become parity promotion evidence.', 409);
  }
  const canonical = attestation.canonicalConformance;
  if (canonical && (canonical.source !== attestation.result.source
    || canonical.engineVersion !== attestation.result.engine.version
    || canonical.manifestSha256 !== canonical.expectedSha256
    || !/^[a-f0-9]{64}$/i.test(canonical.expectedSha256))) {
    throw statusError('Canonical conformance evidence does not match this extraction runtime.', 409);
  }
  const report = attestation.baseline
    ? buildMigrationEngineParityReport({
      baseline: attestation.baseline,
      candidate: migrationInventoryFromEngine(attestation.result, attestation.baseline.artifacts),
      engineResult: attestation.result,
      mode: 'shadow',
    })
    : null;
  const scores = report?.scores || {
    semantic: 100,
    dashboards: 100,
    stableIdentity: 100,
    warningsAndLimitations: 100,
    overall: 100,
  };
  const shared: Pick<StoredParityObservation,
    'attestationVersion' | 'generatedAt' | 'source' | 'mode' | 'engineName' | 'engineVersion'
    | 'parserVersion' | 'rulebookVersion' | 'scores' | 'durationMs' | 'queueWaitMs'> = {
    attestationVersion: 'server.v1',
    generatedAt: report?.generatedAt || new Date().toISOString(),
    source: attestation.result.source,
    mode: 'shadow',
    engineName: redactSensitiveText(attestation.result.engine.name).slice(0, 100),
    engineVersion: redactSensitiveText(attestation.result.engine.version).slice(0, 50),
    parserVersion: redactSensitiveText(attestation.result.model_suggestions[0]?.parser_version || attestation.result.engine.version).slice(0, 50),
    rulebookVersion: redactSensitiveText(attestation.result.diagnostics.rulebook_version).slice(0, 50),
    scores: { ...scores },
    durationMs: typeof attestation.result.control_plane?.duration_ms === 'number' && attestation.result.control_plane.duration_ms >= 0 ? attestation.result.control_plane.duration_ms : undefined,
    queueWaitMs: typeof attestation.result.control_plane?.queue_wait_ms === 'number' && attestation.result.control_plane.queue_wait_ms >= 0 ? attestation.result.control_plane.queue_wait_ms : undefined,
  };
  if (report) {
    return [{
      ...shared,
      observationType: 'native_parity',
      requestId: attestation.requestId.trim().slice(0, 200),
      requestFingerprint: attestation.requestFingerprint,
      resultFingerprint: attestation.resultFingerprint,
      baselineFingerprint: attestation.baselineFingerprint!,
      baselineSource: 'server_native',
      comparisonType: 'native_differential',
    }];
  }
  const canonicalRequestId = `canonical:${canonical!.source}:${canonical!.expectedSha256}`;
  const canonicalObservation: StoredParityObservation = {
    ...shared,
    observationType: 'canonical_conformance',
    requestId: canonicalRequestId.slice(0, 200),
    requestFingerprint: sha256({
      source: canonical!.source,
      engineVersion: canonical!.engineVersion,
      expectedSha256: canonical!.expectedSha256,
      parserVersion: shared.parserVersion,
      rulebookVersion: shared.rulebookVersion,
    }),
    resultFingerprint: canonical!.manifestSha256,
    baselineFingerprint: canonical!.expectedSha256,
    baselineSource: 'canonical_fixture',
    comparisonType: 'canonical_conformance',
    canonicalFixtureSha256: canonical!.expectedSha256,
  };
  const operationalObservation: StoredParityObservation = {
    ...shared,
    observationType: 'operational',
    requestId: attestation.requestId.trim().slice(0, 200),
    requestFingerprint: attestation.requestFingerprint,
    resultFingerprint: attestation.resultFingerprint,
    baselineFingerprint: canonical!.expectedSha256,
    baselineSource: 'canonical_fixture',
    comparisonType: 'canonical_conformance',
    canonicalFixtureSha256: canonical!.expectedSha256,
  };
  return [canonicalObservation, operationalObservation];
}

async function canonicalConformanceAttestation(
  root: string,
  source: MigrationEngineSource,
): Promise<CanonicalConformanceAttestation> {
  const revision = managedEngineRevision(root) || 'development';
  const cacheKey = `${root}:${revision}:${source}`;
  const cached = canonicalConformanceCache.get(cacheKey);
  if (cached) return cached;
  const conformance = await getMigrationEngineConformance(source);
  const evidence = conformance.sources[source];
  if (!conformance.passed || !evidence?.passed || evidence.manifest_sha256 !== evidence.expected_sha256) {
    throw statusError(`Canonical ${source} conformance did not pass for this migration-engine runtime.`, 422);
  }
  const attestation = {
    source,
    engineVersion: conformance.engine.version,
    manifestSha256: evidence.manifest_sha256,
    expectedSha256: evidence.expected_sha256,
  };
  canonicalConformanceCache.set(cacheKey, attestation);
  return attestation;
}

export async function recordMigrationEngineParityObservation(
  requestId: string,
): Promise<{ source: MigrationEngineSource; observationCount: number; latestOverall: number; comparisonType: 'native_differential' | 'canonical_conformance' }> {
  if (!requestId.trim()) throw statusError('Migration engine parity request ID is required.', 400);
  pruneCompletedExtractionAttestations();
  const attestation = completedExtractionAttestations.get(requestId);
  if (!attestation) throw statusError('No recent completed engine extraction matches this parity request.', 404);
  const observations = parityObservationsFromAttestation(attestation);
  const source = observations[0]!.source;
  const path = process.env.OMNIKIT_MIGRATION_ENGINE_PARITY_PATH || DEFAULT_PARITY_OBSERVATION_PATH;
  const write = async () => {
    let document: { schemaVersion: string; sources: Partial<Record<MigrationEngineSource, StoredParityObservation[]>> } = {
      schemaVersion: 'omnikit.migration.engine-parity-observations.v1',
      sources: {},
    };
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as typeof document;
      if (parsed.schemaVersion === document.schemaVersion && parsed.sources && typeof parsed.sources === 'object') document = parsed;
    } catch {
      // The observation ledger is optional and starts empty.
    }
    const current = Array.isArray(document.sources[source]) ? document.sources[source]! : [];
    const requestIds = new Set(observations.map((observation) => observation.requestId));
    const next = [...current.filter((item) => !requestIds.has(item.requestId)), ...observations].slice(-500);
    document.sources[source] = next;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${path}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, path);
    const observationCount = next.filter((item) => item.observationType !== 'canonical_conformance').length;
    return {
      source,
      observationCount,
      latestOverall: observations.at(-1)!.scores.overall,
      comparisonType: observations[0]!.comparisonType,
    };
  };
  const pending = parityObservationWrite.then(write, write);
  parityObservationWrite = pending.catch(() => undefined);
  return pending;
}

export function migrationEngineRolloutMode(source: MigrationEngineSource): MigrationEngineRolloutMode {
  const requested = requestedMigrationEngineRolloutMode(source);
  if (requested !== 'primary') return requested;
  return migrationEnginePromotionGate(source).approved ? 'primary' : 'shadow';
}

export function migrationEngineControlPlane(): {
  defaultMode: MigrationEngineRolloutMode;
  sourceModes: Record<MigrationEngineSource, MigrationEngineRolloutMode>;
  requestedSourceModes: Record<MigrationEngineSource, MigrationEngineRolloutMode>;
  promotionGates: Record<MigrationEngineSource, { approved: boolean; reason: string; observationCount: number }>;
  fallback: 'native_when_available';
  observationRequired: boolean;
} {
  const defaultMode = rolloutMode(process.env.OMNIKIT_MIGRATION_ENGINE_MODE, 'shadow');
  return {
    defaultMode,
    sourceModes: Object.fromEntries(MIGRATION_ENGINE_SOURCES.map((source) => [source, migrationEngineRolloutMode(source)])) as Record<MigrationEngineSource, MigrationEngineRolloutMode>,
    requestedSourceModes: Object.fromEntries(MIGRATION_ENGINE_SOURCES.map((source) => [source, requestedMigrationEngineRolloutMode(source)])) as Record<MigrationEngineSource, MigrationEngineRolloutMode>,
    promotionGates: Object.fromEntries(MIGRATION_ENGINE_SOURCES.map((source) => [source, migrationEnginePromotionGate(source)])) as Record<MigrationEngineSource, { approved: boolean; reason: string; observationCount: number }>,
    fallback: 'native_when_available',
    observationRequired: true,
  };
}

export function migrationEngineChildEnvironment(root: string): NodeJS.ProcessEnv {
  const sourceRoot = join(root, 'src');
  const allowedNames = [
    'PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'COMSPEC',
    'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  ];
  const allowed = Object.fromEntries(allowedNames.flatMap((name) => typeof process.env[name] === 'string' ? [[name, process.env[name]]] : []));
  const timeoutSeconds = Math.ceil(Math.max(1_000, Math.min(Number(process.env.OMNIKIT_MIGRATION_ENGINE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS, 15 * 60_000)) / 1_000);
  return {
    ...allowed,
    PYTHONPATH: sourceRoot,
    PYTHONUNBUFFERED: '1',
    OMNIKIT_ENGINE_MEMORY_MB: String(boundedInteger(process.env.OMNIKIT_MIGRATION_ENGINE_MEMORY_MB, DEFAULT_MEMORY_MB, 256, 16_384)),
    OMNIKIT_ENGINE_CPU_SECONDS: String(boundedInteger(process.env.OMNIKIT_MIGRATION_ENGINE_CPU_SECONDS, timeoutSeconds + 5, 5, 3_600)),
  };
}

async function runEngineProcess(root: string, args: string[], stdin: string, signal?: AbortSignal): Promise<EngineProcessResult> {
  const timeoutMs = Math.max(1_000, Math.min(Number(process.env.OMNIKIT_MIGRATION_ENGINE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS, 15 * 60_000));
  const queuedAt = Date.now();
  const release = await acquireEngineSlot(signal);
  const startedAt = Date.now();
  try {
    return await new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(migrationEnginePython(root), ['-m', 'omni_migrator.runtime', ...args], {
      cwd: root,
      env: migrationEngineChildEnvironment(root),
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      callback();
    };
    const abort = () => {
      child.kill('SIGKILL');
      finish(() => rejectProcess(statusError('Migration engine request was cancelled.', 499)));
    };
    const append = (chunk: Buffer, target: 'stdout' | 'stderr') => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_ENGINE_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        finish(() => rejectProcess(statusError('Migration engine output exceeded the safe response limit.', 413)));
        return;
      }
      if (target === 'stdout') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => rejectProcess(statusError(`Migration engine exceeded the ${timeoutMs} ms time limit.`, 504)));
    }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => append(chunk, 'stdout'));
    child.stderr.on('data', (chunk: Buffer) => append(chunk, 'stderr'));
    child.on('error', (error) => finish(() => rejectProcess(statusError(`Migration engine could not start: ${redactSensitiveText(error.message)}`, 503))));
    child.on('close', (code) => finish(() => resolveProcess({
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exitCode: code ?? 1,
      queueWaitMs: startedAt - queuedAt,
      durationMs: Date.now() - startedAt,
    })));
    child.stdin.end(stdin);
    });
  } finally {
    release();
  }
}

function processIsRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function cleanupAbandonedMigrationEngineTempDirectories(
  baseDirectory = tmpdir(),
  now = Date.now(),
): Promise<number> {
  const maximumAge = boundedInteger(process.env.OMNIKIT_MIGRATION_ENGINE_TEMP_MAX_AGE_MS, DEFAULT_TEMP_MAX_AGE_MS, 60_000, 7 * 24 * 60 * 60_000);
  let removed = 0;
  let names: string[] = [];
  try {
    names = await readdir(baseDirectory);
  } catch {
    return 0;
  }
  await Promise.all(names.filter((name) => name.startsWith(ENGINE_TEMP_PREFIX)).map(async (name) => {
    const path = join(baseDirectory, name);
    try {
      const details = await stat(path);
      if (!details.isDirectory() || now - details.mtimeMs < maximumAge) return;
      const match = name.match(/^omnikit-migration-engine-(\d+)-/);
      const ownerPid = match ? Number(match[1]) : 0;
      if (ownerPid === process.pid || processIsRunning(ownerPid)) return;
      await rm(path, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Startup scavenging is best effort; active requests still use finally cleanup.
    }
  }));
  return removed;
}

function ensureEngineTempCleanup(): Promise<number> {
  cleanupPromise ||= cleanupAbandonedMigrationEngineTempDirectories();
  return cleanupPromise;
}

function safeArtifactName(name: string, index: number): string {
  const clean = basename(name).replace(/[^A-Za-z0-9._-]+/g, '_').slice(-240) || `artifact-${index + 1}`;
  return `${String(index + 1).padStart(4, '0')}-${clean}`;
}

function parseEngineOutput(processResult: EngineProcessResult, sensitiveValues: string[] = []): unknown {
  let payload: unknown;
  try {
    payload = JSON.parse(processResult.stdout);
  } catch {
    throw statusError(`Migration engine returned invalid JSON${processResult.stderr ? `: ${redactMigrationEngineErrorText(processResult.stderr, sensitiveValues).slice(0, 1_000)}` : '.'}`, 502);
  }
  if (processResult.exitCode !== 0) {
    const message = payload && typeof payload === 'object' && 'error' in payload && (payload as { error?: { message?: unknown } }).error?.message;
    throw statusError(redactMigrationEngineErrorText(typeof message === 'string' ? message : processResult.stderr || 'Migration engine failed.', sensitiveValues), 422);
  }
  return payload;
}

export async function getMigrationEngineCapabilities(): Promise<Record<string, unknown>> {
  const root = migrationEngineRoot();
  if (!root) throw statusError('The first-party OmniKit migration engine is unavailable. Run npm run setup:migration-engine.', 503);
  const result = await runEngineProcess(root, ['capabilities'], '');
  const payload = parseEngineOutput(result);
  if (!payload || typeof payload !== 'object' || (payload as { write_authority?: unknown }).write_authority !== false) {
    throw statusError('Migration engine capability response did not confirm its read-only boundary.', 502);
  }
  const capability = payload as Record<string, unknown>;
  const engine = capability.engine;
  const version = engine && typeof engine === 'object' ? (engine as { version?: unknown }).version : undefined;
  const name = engine && typeof engine === 'object' ? (engine as { name?: unknown }).name : undefined;
  const pythonVersion = capability.runtime && typeof capability.runtime === 'object' ? (capability.runtime as { python_version?: unknown }).python_version : undefined;
  const major = typeof version === 'string' && /^(\d+)\.\d+\.\d+/.test(version) ? Number(version.split('.')[0]) : NaN;
  const supportedResultSchemas = Array.isArray(capability.supported_result_schema_versions) ? capability.supported_result_schema_versions : [];
  if (capability.schema_version !== MIGRATION_ENGINE_BRIDGE_SCHEMA_VERSION || capability.result_schema_version !== 'omnikit.migration.bundle.v1' || !supportedResultSchemas.includes('omnikit.migration.bundle.v1') || name !== EXPECTED_ENGINE_NAME || major !== EXPECTED_ENGINE_MAJOR || typeof pythonVersion !== 'string' || Number(pythonVersion.split('.')[0]) < 3 || (Number(pythonVersion.split('.')[0]) === 3 && Number(pythonVersion.split('.')[1]) < 11)) {
    throw statusError('Migration engine runtime, identity, or contract version is incompatible with this OmniKit build.', 502);
  }
  const requiresManagedManifest = root === MANAGED_ENGINE_ROOT || process.env.NODE_ENV === 'production';
  if (requiresManagedManifest) {
    const manifest = readManagedEngineManifest();
    const conformance = manifest?.conformance && typeof manifest.conformance === 'object'
      ? manifest.conformance as Record<string, unknown>
      : {};
    const sourceResults = conformance.sources && typeof conformance.sources === 'object'
      ? conformance.sources as Record<string, unknown>
      : {};
    const cleanProductionRevision = process.env.NODE_ENV !== 'production'
      || (/^[a-f0-9]{40,64}$/i.test(String(manifest?.sourceRevision || '')) && !String(manifest?.sourceRevision).endsWith('-dirty'));
    if (manifest?.schemaVersion !== 2
      || manifest.sourceRoot !== root
      || manifest.engine !== name
      || manifest.version !== version
      || manifest.bridgeSchemaVersion !== capability.schema_version
      || manifest.resultSchemaVersion !== capability.result_schema_version
      || manifest.conformanceSchemaVersion !== 'omnikit.migration.conformance-run.v1'
      || conformance.passed !== true
      || MIGRATION_ENGINE_SOURCES.some((source) => (sourceResults[source] as { passed?: unknown } | undefined)?.passed !== true)
      || !cleanProductionRevision) {
      throw statusError('The installed first-party migration engine manifest is stale, incomplete, dirty, or incompatible with the live runtime.', 502);
    }
  }
  validatedCapabilities = { root, value: capability };
  return { ...capability, control_plane: migrationEngineControlPlane() };
}

export async function getMigrationEngineConformance(
  source?: MigrationEngineSource,
): Promise<MigrationEngineConformanceResult> {
  const root = migrationEngineRoot();
  if (!root) throw statusError('The first-party OmniKit migration engine is unavailable. Run npm run setup:migration-engine.', 503);
  await validateMigrationEngineRuntime(root);
  const args = ['conformance'];
  if (source) args.push('--source', source);
  const result = await runEngineProcess(root, args, '');
  let payload: unknown;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    throw statusError('Migration engine returned invalid conformance JSON.', 502);
  }
  const parsed = parseMigrationEngineConformanceResult(payload, source ? [source] : MIGRATION_ENGINE_SOURCES);
  if (result.exitCode !== 0 || !parsed.passed) {
    const errors = Object.entries(parsed.sources)
      .flatMap(([itemSource, evidence]) => evidence.errors.map((error) => `${itemSource}: ${error}`))
      .slice(0, 5);
    throw statusError(`Migration engine conformance failed${errors.length ? `: ${errors.join('; ')}` : '.'}`, 422);
  }
  return parsed;
}

async function validateMigrationEngineRuntime(root: string): Promise<void> {
  if (validatedCapabilities?.root === root) return;
  await getMigrationEngineCapabilities();
}

function requestFingerprint(input: MigrationEngineExtractInput): string {
  const artifacts = (input.artifacts || []).map((artifact) => ({
    name: artifact.name,
    sha256: createHash('sha256').update(typeof artifact.content === 'string' ? Buffer.from(artifact.content) : Buffer.from(artifact.content)).digest('hex'),
  }));
  return createHash('sha256').update(JSON.stringify({
    source: input.source,
    mode: input.mode,
    artifacts,
    baseUrl: input.connection?.baseUrl,
    defaultSchema: input.defaultSchema,
    scope: input.scope || {},
    includeModelSuggestions: input.includeModelSuggestions !== false,
    rulebookVersion: input.rulebookVersion || 'v2',
    targetConnections: [...(input.targetConnections || [])]
      .map((connection) => ({ ...connection }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    connectionOverrides: Object.fromEntries(
      Object.entries(input.connectionOverrides || {}).sort(([left], [right]) => left.localeCompare(right)),
    ),
  })).digest('hex');
}

export async function withMigrationEngineTemporaryDirectory<T>(
  operation: (temporaryRoot: string) => Promise<T>,
  baseDirectory = tmpdir(),
): Promise<T> {
  await mkdir(baseDirectory, { recursive: true });
  const temporaryRoot = await mkdtemp(join(baseDirectory, `${ENGINE_TEMP_PREFIX}${process.pid}-`));
  try {
    await chmod(temporaryRoot, 0o700);
    await writeFile(join(temporaryRoot, '.owner.json'), JSON.stringify({
      pid: process.pid,
      createdAt: new Date().toISOString(),
    }), { mode: 0o600 });
    return await operation(temporaryRoot);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function runMigrationEngineExtract(input: MigrationEngineExtractInput): Promise<MigrationEngineBridgeResult> {
  const root = migrationEngineRoot();
  if (!root) throw statusError('The first-party OmniKit migration engine is unavailable. Run npm run setup:migration-engine.', 503);
  const selectedMode = migrationEngineRolloutMode(input.source);
  if (selectedMode === 'off') {
    throw statusError(`The migration engine is off for ${input.source}; OmniKit will use its available native parser fallback.`, 503);
  }
  await validateMigrationEngineRuntime(root);
  await ensureEngineTempCleanup();
  const artifacts = input.artifacts || [];
  if (artifacts.length > MAX_ENGINE_ARTIFACTS) throw statusError(`Migration engine accepts at most ${MAX_ENGINE_ARTIFACTS} artifacts.`, 413);
  const totalBytes = artifacts.reduce((total, artifact) => total + (typeof artifact.content === 'string' ? Buffer.byteLength(artifact.content) : artifact.content.byteLength), 0);
  if (totalBytes > MAX_ENGINE_ARTIFACT_BYTES) throw statusError('Migration artifacts exceed the engine byte limit.', 413);
  const fingerprint = requestFingerprint(input);
  const existingFingerprint = inFlightRequestIds.get(input.requestId);
  if (existingFingerprint) {
    throw statusError(existingFingerprint === fingerprint
      ? `Migration engine request ${input.requestId} is already running.`
      : `Migration engine request ID ${input.requestId} was reused with different input.`, 409);
  }
  inFlightRequestIds.set(input.requestId, fingerprint);
  try {
    return await withMigrationEngineTemporaryDirectory(async (temporaryRoot) => {
      const descriptors = [];
      for (const [index, artifact] of artifacts.entries()) {
        const fileName = safeArtifactName(artifact.name, index);
        const bytes = typeof artifact.content === 'string' ? Buffer.from(artifact.content, 'utf8') : Buffer.from(artifact.content);
        await writeFile(join(temporaryRoot, fileName), bytes, { mode: 0o600 });
        descriptors.push({
          path: fileName,
          name: artifact.name,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
      }
      const request = {
        schema_version: MIGRATION_ENGINE_BRIDGE_SCHEMA_VERSION,
        request_id: input.requestId,
        source: input.source,
        mode: input.mode,
        artifact_root: input.mode === 'manual' ? temporaryRoot : undefined,
        artifacts: descriptors,
        connection: input.connection ? { base_url: input.connection.baseUrl, auth: input.connection.auth } : undefined,
        default_schema: input.defaultSchema,
        scope: input.scope || {},
        include_model_suggestions: input.includeModelSuggestions !== false,
        rulebook_version: input.rulebookVersion || 'v2',
        target_connections: (input.targetConnections || []).map((connection) => ({
          id: connection.id,
          name: connection.name,
          dialect: connection.dialect,
          database: connection.database,
          default_schema: connection.defaultSchema,
        })),
        connection_overrides: input.connectionOverrides || {},
      };
      const sensitiveValues = sensitiveStringValues(input.connection?.auth);
      const processResult = await runEngineProcess(root, ['extract'], JSON.stringify(request), input.signal);
      const output = parseEngineOutput(processResult, sensitiveValues);
      assertMigrationEngineOutputContainsNoSecrets(output, sensitiveValues);
      const parsed = applyMigrationEngineConnectionOverrides(input, parseMigrationEngineBridgeResult(output));
      const revision = managedEngineRevision(root);
      if (revision) parsed.engine.revision = revision;
      parsed.control_plane = {
        rollout_mode: selectedMode,
        queue_wait_ms: processResult.queueWaitMs,
        duration_ms: processResult.durationMs,
        fallback: 'native_when_available',
      };
      const canonicalConformance = input.parityBaseline
        ? undefined
        : await canonicalConformanceAttestation(root, input.source);
      attestCompletedMigrationEngineExtraction(input, parsed, fingerprint, canonicalConformance);
      return parsed;
    });
  } finally {
    inFlightRequestIds.delete(input.requestId);
  }
}

export function resetMigrationEngineRuntimeForTests(): void {
  activeEngineProcesses = 0;
  engineQueue.splice(0);
  inFlightRequestIds.clear();
  cleanupPromise = null;
  validatedCapabilities = null;
  canonicalConformanceCache.clear();
  parityObservationWrite = Promise.resolve();
  completedExtractionAttestations.clear();
}

import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { redactSensitiveText } from './jobSanitizer';

export type SemanticMigrationJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface SemanticMigrationJobRecord {
  id: string;
  providerId: string;
  projectId?: string;
  stage: 'analyze' | 'compile' | 'repair';
  status: SemanticMigrationJobStatus;
  requestFingerprint: string;
  idempotencyKey?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
  errorCode?: string;
  retryable?: boolean;
  failureAttempts?: number;
  usage?: Record<string, number>;
  cancellationWarning?: string;
}

export interface SemanticMigrationJobRunContext {
  signal: AbortSignal;
  registerUpstreamCancellation: (cancel: () => void | Promise<void>) => void;
}

export type SemanticMigrationJobCancellation = SemanticMigrationJobRecord & Promise<SemanticMigrationJobRecord> & {
  readonly transitioned: boolean;
};

export class SemanticMigrationJobIdempotencyConflictError extends Error {
  readonly statusCode = 409;
  readonly code = 'SEMANTIC_JOB_IDEMPOTENCY_CONFLICT';

  constructor() {
    super('This semantic migration idempotency key is already bound to different request input for the same provider, project, and stage.');
    this.name = 'SemanticMigrationJobIdempotencyConflictError';
  }
}

interface PersistedJobStore {
  version: 1;
  jobs: SemanticMigrationJobRecord[];
}

interface TransientResult {
  value: unknown;
  expiresAt: number;
}

interface SemanticMigrationJobRuntime {
  generation: number;
  controller: AbortController;
  cancelRequested: boolean;
  upstreamCancellation?: () => void | Promise<void>;
  upstreamCancellationPromise?: Promise<void>;
}

const DEFAULT_JOB_PATH = './data/semantic-migration-jobs.json';
const RESULT_TTL_MS = 30 * 60 * 1000;
const MAX_JOBS = 500;
const CANCELLATION_WARNING = 'OmniKit cancelled local execution, but could not confirm upstream cancellation. The provider may continue processing.';
const transientResults = new Map<string, TransientResult>();
const jobRuntimes = new Map<string, SemanticMigrationJobRuntime>();
// Fingerprints only need to remain stable for this process. A keyed digest keeps
// copied job metadata from becoming an offline oracle for sensitive prompt input.
const requestFingerprintKey = randomBytes(32);
let loadedPath = '';
let records: SemanticMigrationJobRecord[] = [];
let stateGeneration = 0;

function jobPath(): string {
  return process.env.OMNIKIT_SEMANTIC_MIGRATION_JOB_PATH || DEFAULT_JOB_PATH;
}

function load(): void {
  const path = jobPath();
  if (loadedPath === path) return;
  loadedPath = path;
  records = [];
  if (!existsSync(path)) return;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<PersistedJobStore>;
    records = Array.isArray(parsed.jobs) ? parsed.jobs.filter((job): job is SemanticMigrationJobRecord => Boolean(job?.id)) : [];
    const now = new Date().toISOString();
    records = records.map((job) => ['queued', 'running'].includes(job.status)
      ? { ...job, status: 'failed', error: 'OmniKit restarted before this job completed. Rerun the reviewed step.', completedAt: now, updatedAt: now }
      : job);
  } catch {
    records = [];
  }
}

function persist(): void {
  const path = jobPath();
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, JSON.stringify({ version: 1, jobs: records.slice(0, MAX_JOBS) } satisfies PersistedJobStore, null, 2), { mode: 0o600 });
  renameSync(temp, path);
}

function fingerprint(value: string): string {
  return createHmac('sha256', requestFingerprintKey).update(value).digest('hex');
}

function normalizedIdempotencyKey(value: string | undefined): string | undefined {
  const key = value?.trim();
  if (!key) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(key)) {
    throw Object.assign(new Error('Semantic migration idempotency keys must be 1-200 characters using letters, numbers, period, underscore, colon, slash, or hyphen.'), {
      statusCode: 400,
      code: 'SEMANTIC_JOB_IDEMPOTENCY_KEY_INVALID',
    });
  }
  return key;
}

function sameIdempotencyScope(
  job: SemanticMigrationJobRecord,
  input: Pick<SemanticMigrationJobRecord, 'providerId' | 'projectId' | 'stage'>,
): boolean {
  return job.providerId === input.providerId
    && (job.projectId || '') === (input.projectId || '')
    && job.stage === input.stage;
}

function cleanupTransient(): void {
  const now = Date.now();
  for (const [id, result] of transientResults.entries()) if (result.expiresAt <= now) transientResults.delete(id);
}

function isReusableIdempotencyRecord(job: SemanticMigrationJobRecord): boolean {
  if (job.status === 'queued' || job.status === 'running') return true;
  if (job.status !== 'succeeded') return false;
  return transientResults.get(job.id)?.value !== undefined;
}

function replace(record: SemanticMigrationJobRecord): void {
  records = [record, ...records.filter((job) => job.id !== record.id)].slice(0, MAX_JOBS);
  persist();
}

function recordCancellationWarning(jobId: string, generation: number): void {
  if (generation !== stateGeneration) return;
  const current = getSemanticMigrationJob(jobId);
  if (!current || current.status !== 'cancelled' || current.cancellationWarning === CANCELLATION_WARNING) return;
  replace({
    ...current,
    cancellationWarning: CANCELLATION_WARNING,
    updatedAt: new Date().toISOString(),
  });
}

function invokeRegisteredUpstreamCancellation(jobId: string, runtime: SemanticMigrationJobRuntime): Promise<void> {
  if (!runtime.cancelRequested || !runtime.upstreamCancellation) return Promise.resolve();
  if (runtime.upstreamCancellationPromise) return runtime.upstreamCancellationPromise;
  const cancel = runtime.upstreamCancellation;
  runtime.upstreamCancellationPromise = Promise.resolve()
    .then(() => cancel())
    .catch(() => recordCancellationWarning(jobId, runtime.generation));
  return runtime.upstreamCancellationPromise;
}

function awaitableCancellation(
  snapshot: SemanticMigrationJobRecord,
  completion: Promise<void>,
  transitioned: boolean,
): SemanticMigrationJobCancellation {
  const finalRecord = completion.then(() => getSemanticMigrationJob(snapshot.id) || snapshot);
  return Object.assign(finalRecord, snapshot, { transitioned });
}

export function startSemanticMigrationJob(input: {
  providerId: string;
  projectId?: string;
  stage: SemanticMigrationJobRecord['stage'];
  requestFingerprintSource: string;
  idempotencyKey?: string;
  onCreated?: (job: SemanticMigrationJobRecord) => void;
  onSucceeded?: (job: SemanticMigrationJobRecord, value: unknown) => void;
  onFailed?: (job: SemanticMigrationJobRecord, error: unknown) => void;
  run: (context: SemanticMigrationJobRunContext) => Promise<unknown>;
}): SemanticMigrationJobRecord {
  load();
  cleanupTransient();
  const requestFingerprint = fingerprint(input.requestFingerprintSource);
  const idempotencyKey = normalizedIdempotencyKey(input.idempotencyKey);
  const projectId = input.projectId?.trim() || undefined;
  if (idempotencyKey) {
    const existing = records.find((job) => job.idempotencyKey === idempotencyKey
      && sameIdempotencyScope(job, {
        providerId: input.providerId,
        projectId,
        stage: input.stage,
      })
      && isReusableIdempotencyRecord(job));
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) throw new SemanticMigrationJobIdempotencyConflictError();
      return existing;
    }
  }

  const generation = stateGeneration;
  const now = new Date().toISOString();
  const record: SemanticMigrationJobRecord = {
    id: `semantic_job_${randomUUID()}`,
    providerId: input.providerId,
    projectId,
    stage: input.stage,
    status: 'queued',
    requestFingerprint,
    idempotencyKey,
    createdAt: now,
    updatedAt: now,
  };
  // The durable job is written before its started audit. A crash between these two
  // file writes can leave a queued job without an audit event; closing that narrow
  // window safely requires a transactional outbox shared by both stores.
  replace(record);
  try {
    input.onCreated?.(record);
  } catch (error) {
    const completedAt = new Date().toISOString();
    replace({
      ...record,
      status: 'failed',
      error: 'Semantic migration execution did not start because lifecycle audit persistence failed.',
      errorCode: 'SEMANTIC_JOB_START_AUDIT_FAILED',
      retryable: true,
      updatedAt: completedAt,
      completedAt,
    });
    throw error;
  }
  queueMicrotask(async () => {
    if (generation !== stateGeneration) return;
    const current = getSemanticMigrationJob(record.id);
    if (!current || current.status === 'cancelled') return;
    const runtime: SemanticMigrationJobRuntime = {
      generation,
      controller: new AbortController(),
      cancelRequested: false,
    };
    jobRuntimes.set(record.id, runtime);
    replace({ ...current, status: 'running', updatedAt: new Date().toISOString() });
    try {
      let value: unknown;
      try {
        value = await input.run({
          signal: runtime.controller.signal,
          registerUpstreamCancellation: (cancel) => {
            if (!runtime.upstreamCancellation) runtime.upstreamCancellation = cancel;
            if (runtime.cancelRequested) void invokeRegisteredUpstreamCancellation(record.id, runtime);
          },
        });
      } catch (error) {
        if (generation !== stateGeneration) return;
        const latest = getSemanticMigrationJob(record.id);
        if (!latest || latest.status === 'cancelled') return;
        const completedAt = new Date().toISOString();
        const errorRecord = error && typeof error === 'object' ? error as Record<string, unknown> : {};
        const errorCode = typeof errorRecord.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(errorRecord.code)
          ? errorRecord.code
          : undefined;
        const failureAttempts = typeof errorRecord.attempts === 'number'
          && Number.isSafeInteger(errorRecord.attempts)
          && errorRecord.attempts > 0
          ? Math.min(errorRecord.attempts, 10)
          : undefined;
        const failed: SemanticMigrationJobRecord = {
          ...latest,
          status: 'failed',
          error: redactSensitiveText(error instanceof Error ? error.message : 'Semantic migration AI job failed.').slice(0, 500),
          errorCode,
          retryable: errorRecord.retryable === true || undefined,
          failureAttempts,
          updatedAt: completedAt,
          completedAt,
        };
        replace(failed);
        try { input.onFailed?.(failed, error); } catch { /* Durable failure remains authoritative. */ }
        return;
      }

      if (generation !== stateGeneration) return;
      const latest = getSemanticMigrationJob(record.id);
      if (!latest || latest.status === 'cancelled') return;
      const completedAt = new Date().toISOString();
      const valueRecord = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
      const usageRecord = valueRecord.usage && typeof valueRecord.usage === 'object' && !Array.isArray(valueRecord.usage)
        ? Object.fromEntries(Object.entries(valueRecord.usage as Record<string, unknown>).flatMap(([key, item]) => typeof item === 'number' && Number.isFinite(item) ? [[key, item] as const] : []))
        : undefined;
      const succeeded: SemanticMigrationJobRecord = {
        ...latest,
        status: 'succeeded',
        usage: usageRecord && Object.keys(usageRecord).length > 0 ? usageRecord : undefined,
        updatedAt: completedAt,
        completedAt,
      };
      replace(succeeded);
      transientResults.set(record.id, { value, expiresAt: Date.now() + RESULT_TTL_MS });
      try { input.onSucceeded?.(succeeded, value); } catch { /* Durable success remains authoritative. */ }
    } finally {
      if (runtime.upstreamCancellationPromise) await runtime.upstreamCancellationPromise;
      if (jobRuntimes.get(record.id) === runtime) jobRuntimes.delete(record.id);
    }
  });
  return record;
}

export function getSemanticMigrationJob(id: string): SemanticMigrationJobRecord | undefined {
  load();
  return records.find((job) => job.id === id);
}

export function getSemanticMigrationJobResult(id: string): unknown | undefined {
  cleanupTransient();
  return transientResults.get(id)?.value;
}

/**
 * Returns an awaitable job snapshot so existing synchronous handlers can serialize the
 * terminal state while async callers wait for the upstream cancellation attempt.
 */
export function cancelSemanticMigrationJob(id: string): SemanticMigrationJobCancellation | undefined {
  const job = getSemanticMigrationJob(id);
  if (!job) return undefined;
  const existingRuntime = jobRuntimes.get(id);
  if (['succeeded', 'failed', 'cancelled'].includes(job.status)) {
    const completion = job.status === 'cancelled' && existingRuntime
      ? invokeRegisteredUpstreamCancellation(id, existingRuntime)
      : Promise.resolve();
    return awaitableCancellation(job, completion, false);
  }
  const completedAt = new Date().toISOString();
  const cancelled = { ...job, status: 'cancelled' as const, updatedAt: completedAt, completedAt };
  transientResults.delete(id);
  replace(cancelled);
  const runtime = jobRuntimes.get(id);
  if (!runtime) return awaitableCancellation(cancelled, Promise.resolve(), true);
  runtime.cancelRequested = true;
  if (!runtime.controller.signal.aborted) runtime.controller.abort();
  return awaitableCancellation(cancelled, invokeRegisteredUpstreamCancellation(id, runtime), true);
}

export function resetSemanticMigrationJobsForTests(): void {
  stateGeneration += 1;
  for (const runtime of jobRuntimes.values()) {
    if (!runtime.controller.signal.aborted) runtime.controller.abort();
  }
  jobRuntimes.clear();
  const paths = new Set([loadedPath, jobPath()].filter(Boolean));
  loadedPath = '';
  records = [];
  transientResults.clear();
  for (const path of paths) {
    rmSync(path, { force: true });
    rmSync(`${path}.tmp`, { force: true });
  }
}

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
  usage?: Record<string, number>;
}

interface PersistedJobStore {
  version: 1;
  jobs: SemanticMigrationJobRecord[];
}

interface TransientResult {
  value: unknown;
  expiresAt: number;
}

const DEFAULT_JOB_PATH = './data/semantic-migration-jobs.json';
const RESULT_TTL_MS = 30 * 60 * 1000;
const MAX_JOBS = 500;
const transientResults = new Map<string, TransientResult>();
let loadedPath = '';
let records: SemanticMigrationJobRecord[] = [];

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
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function cleanupTransient(): void {
  const now = Date.now();
  for (const [id, result] of transientResults.entries()) if (result.expiresAt <= now) transientResults.delete(id);
}

function replace(record: SemanticMigrationJobRecord): void {
  records = [record, ...records.filter((job) => job.id !== record.id)].slice(0, MAX_JOBS);
  persist();
}

export function startSemanticMigrationJob(input: {
  providerId: string;
  projectId?: string;
  stage: SemanticMigrationJobRecord['stage'];
  requestFingerprintSource: string;
  run: () => Promise<unknown>;
}): SemanticMigrationJobRecord {
  load();
  const now = new Date().toISOString();
  const record: SemanticMigrationJobRecord = {
    id: `semantic_job_${randomUUID()}`,
    providerId: input.providerId,
    projectId: input.projectId,
    stage: input.stage,
    status: 'queued',
    requestFingerprint: fingerprint(input.requestFingerprintSource),
    createdAt: now,
    updatedAt: now,
  };
  replace(record);
  queueMicrotask(async () => {
    const current = getSemanticMigrationJob(record.id);
    if (!current || current.status === 'cancelled') return;
    replace({ ...current, status: 'running', updatedAt: new Date().toISOString() });
    try {
      const value = await input.run();
      const latest = getSemanticMigrationJob(record.id);
      if (!latest || latest.status === 'cancelled') return;
      transientResults.set(record.id, { value, expiresAt: Date.now() + RESULT_TTL_MS });
      const completedAt = new Date().toISOString();
      const valueRecord = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
      const usageRecord = valueRecord.usage && typeof valueRecord.usage === 'object' && !Array.isArray(valueRecord.usage)
        ? Object.fromEntries(Object.entries(valueRecord.usage as Record<string, unknown>).flatMap(([key, item]) => typeof item === 'number' && Number.isFinite(item) ? [[key, item] as const] : []))
        : undefined;
      replace({ ...latest, status: 'succeeded', usage: usageRecord && Object.keys(usageRecord).length > 0 ? usageRecord : undefined, updatedAt: completedAt, completedAt });
    } catch (error) {
      const latest = getSemanticMigrationJob(record.id);
      if (!latest || latest.status === 'cancelled') return;
      const completedAt = new Date().toISOString();
      replace({
        ...latest,
        status: 'failed',
        error: redactSensitiveText(error instanceof Error ? error.message : 'Semantic migration AI job failed.'),
        updatedAt: completedAt,
        completedAt,
      });
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

export function cancelSemanticMigrationJob(id: string): SemanticMigrationJobRecord | undefined {
  const job = getSemanticMigrationJob(id);
  if (!job || ['succeeded', 'failed', 'cancelled'].includes(job.status)) return job;
  const completedAt = new Date().toISOString();
  const cancelled = { ...job, status: 'cancelled' as const, updatedAt: completedAt, completedAt };
  transientResults.delete(id);
  replace(cancelled);
  return cancelled;
}

export function resetSemanticMigrationJobsForTests(): void {
  loadedPath = '';
  records = [];
  transientResults.clear();
}

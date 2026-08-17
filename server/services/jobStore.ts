import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

import type {
  MigrationJob,
  MigrationJobItem,
} from './migrationJobs';
import { sanitizeJob, sanitizeJobHistory, sanitizeJobItem } from './jobSanitizer';
import {
  clearMigrationDestinationModelReservations,
  migrationDestinationModelMutationLease,
} from './migrationScopeReservation';

const DEFAULT_JOB_HISTORY_PATH = './data/omnikit-jobs.json';
const DEFAULT_LEGACY_JOBS_PATH = './data/jobs.json';

let jobsCache: MigrationJob[] | null = null;
let jobsPath = '';

const SAFE_COPY_EVIDENCE_REVISION_KEY = 'safeCopyEvidenceRevision';

function isDashboardSafeCopyJob(job: MigrationJob): boolean {
  return job.workflow === 'dashboard'
    && job.details?.safeCopyProfile === 'safe_copy_v1'
    && job.details?.operationMode === 'safe_copy';
}

function safeCopyEvidenceRevision(job: MigrationJob | undefined): number {
  const value = job?.details?.[SAFE_COPY_EVIDENCE_REVISION_KEY];
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function withInitialSafeCopyEvidenceRevision(job: MigrationJob): MigrationJob {
  if (!isDashboardSafeCopyJob(job) || safeCopyEvidenceRevision(job) > 0) return job;
  return {
    ...job,
    details: {
      ...(job.details || {}),
      [SAFE_COPY_EVIDENCE_REVISION_KEY]: 1,
    },
  };
}

function withNextSafeCopyEvidenceRevision(
  current: MigrationJob | undefined,
  next: MigrationJob,
): MigrationJob {
  if (!isDashboardSafeCopyJob(next)) return next;
  const currentRevision = safeCopyEvidenceRevision(current);
  if (currentRevision >= Number.MAX_SAFE_INTEGER - 1) {
    throw new Error('Safe-copy evidence revision exhausted its bounded integer range.');
  }
  return {
    ...next,
    details: {
      ...(next.details || {}),
      [SAFE_COPY_EVIDENCE_REVISION_KEY]: Math.max(1, currentRevision + 1),
    },
  };
}

function bumpRecoveredSafeCopyEvidenceRevision(job: MigrationJob): void {
  if (!isDashboardSafeCopyJob(job)) return;
  const revision = safeCopyEvidenceRevision(job);
  job.details = {
    ...(job.details || {}),
    [SAFE_COPY_EVIDENCE_REVISION_KEY]: Math.max(1, revision + 1),
  };
}

export function getJobsDbPath(): string {
  return process.env.OMNIKIT_JOB_HISTORY_PATH
    || process.env.OMNIKIT_DB_PATH
    || DEFAULT_JOB_HISTORY_PATH;
}

export function getLegacyJobsPath(): string {
  return process.env.OMNIKIT_JOBS_PATH || DEFAULT_LEGACY_JOBS_PATH;
}

function secureHistoryFile(pathname = getJobsDbPath()): void {
  if (existsSync(pathname)) chmodSync(pathname, 0o600);
}

function isJob(value: unknown): value is MigrationJob {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as MigrationJob).id === 'string'
    && Array.isArray((value as MigrationJob).items);
}

function parseJobs(value: unknown): MigrationJob[] {
  if (Array.isArray(value)) {
    return sanitizeJobHistory(value.filter(isJob));
  }
  if (
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Array.isArray((value as { jobs?: unknown }).jobs)
  ) {
    return sanitizeJobHistory((value as { jobs: unknown[] }).jobs.filter(isJob));
  }
  return [];
}

function readJobsFile(pathname: string): MigrationJob[] {
  if (!existsSync(pathname)) return [];
  try {
    return parseJobs(JSON.parse(readFileSync(pathname, 'utf8')) as unknown);
  } catch {
    // A corrupt or non-JSON history file should not stop OmniKit from starting.
    return [];
  }
}

function writeJobsFile(pathname: string, jobs: MigrationJob[]): void {
  mkdirSync(dirname(pathname), { recursive: true });
  const sanitized = sanitizeJobHistory(jobs);
  const tempPath = `${pathname}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(sanitized, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tempPath, 0o600);
    renameSync(tempPath, pathname);
    chmodSync(pathname, 0o600);
  } catch (error) {
    if (existsSync(tempPath)) {
      try {
        unlinkSync(tempPath);
      } catch {
        // Best-effort cleanup only; preserve the original write error.
      }
    }
    throw error;
  }
}

function importLegacyJobsIfNeeded(pathname: string, jobs: MigrationJob[]): MigrationJob[] {
  const legacyPath = getLegacyJobsPath();
  if (jobs.length > 0 || legacyPath === pathname || !existsSync(legacyPath)) return jobs;
  try {
    const imported = parseJobs(JSON.parse(readFileSync(legacyPath, 'utf8')) as unknown);
    if (imported.length === 0) return jobs;
    renameSync(legacyPath, `${legacyPath}.bak`);
    return imported;
  } catch {
    // A corrupt legacy job file should not stop OmniKit from starting.
    return jobs;
  }
}

function recoverInterruptedJobs(jobs: MigrationJob[]): boolean {
  const now = Date.now();
  let changed = false;
  for (const job of jobs) {
    if (job.status !== 'running' && job.status !== 'pending') {
      let terminalHasUnresolvedMutation = false;
      for (const item of job.items) {
        const lease = migrationDestinationModelMutationLease(item);
        if (lease?.state === 'claimed') {
          item.status = 'failed';
          item.error = 'The destination-model operation stopped before an external write was dispatched.';
          item.details = {
            ...(item.details || {}),
            migrationMutationState: 'failed_prewrite',
            migrationMutationUpdatedAt: now,
            migrationMutationRevision: (lease.revision || 0) + 1,
          };
          item.endedAt = now;
          changed = true;
          continue;
        }
        if (lease?.state !== 'dispatched' && lease?.state !== 'remote_pending') continue;
        item.status = 'warning';
        item.error = 'A destination-model write outcome requires reconciliation before another workflow can use this model.';
        item.details = {
          ...(item.details || {}),
          migrationMutationState: 'uncertain',
          migrationMutationUpdatedAt: now,
          migrationMutationRevision: (lease.revision || 0) + 1,
        };
        item.endedAt = now;
        terminalHasUnresolvedMutation = true;
        changed = true;
      }
      if (terminalHasUnresolvedMutation) {
        for (const item of job.items) {
          if (item.details?.migrationDestinationModelMutation === true) continue;
          if (item.status !== 'running' && item.status !== 'pending') continue;
          item.status = 'failed';
          item.error = item.error || 'Interrupted by server restart.';
          item.endedAt = item.endedAt || now;
          changed = true;
        }
        job.status = 'failed';
        job.endedAt = now;
        job.details = {
          ...(job.details || {}),
          migrationMutationState: 'reconciliation_required',
        };
      }
      continue;
    }
    const safeCopyPreparationState = typeof job.details?.safeCopyPreparationState === 'string'
      ? job.details.safeCopyPreparationState
      : '';
    const safeCopyIsDurablyWaiting = job.status === 'pending'
      && isDashboardSafeCopyJob(job)
      && (safeCopyPreparationState === 'prepared' || safeCopyPreparationState === 'needs_attention')
      && job.items.every((item) => item.status !== 'running' && item.status !== 'pending');
    if (safeCopyIsDurablyWaiting) continue;
    for (const item of job.items) {
      const lease = migrationDestinationModelMutationLease(item);
      if (lease?.state !== 'claimed') continue;
      item.status = 'failed';
      item.error = 'The destination-model operation stopped before an external write was dispatched.';
      item.details = {
        ...(item.details || {}),
        migrationMutationState: 'failed_prewrite',
        migrationMutationUpdatedAt: now,
        migrationMutationRevision: (lease.revision || 0) + 1,
      };
      item.endedAt = now;
      changed = true;
    }
    const mutationLeaseItems = job.items.filter((item) => {
      const lease = migrationDestinationModelMutationLease(item);
      return lease?.state === 'dispatched' || lease?.state === 'remote_pending' || lease?.state === 'uncertain';
    });
    if (mutationLeaseItems.length > 0) {
      for (const item of mutationLeaseItems) {
        const lease = migrationDestinationModelMutationLease(item);
        if (!lease || lease.state === 'uncertain') continue;
        item.status = 'warning';
        item.error = 'A destination-model write outcome requires reconciliation before another workflow can use this model.';
        item.details = {
          ...(item.details || {}),
          migrationMutationState: 'uncertain',
          migrationMutationUpdatedAt: now,
          migrationMutationRevision: (lease.revision || 0) + 1,
        };
        item.endedAt = now;
        changed = true;
      }
      for (const item of job.items) {
        if (mutationLeaseItems.includes(item)) continue;
        if (item.status !== 'running' && item.status !== 'pending') continue;
        item.status = 'failed';
        item.error = item.error || 'Interrupted by server restart.';
        item.endedAt = item.endedAt || now;
      }
      job.status = 'failed';
      job.endedAt = now;
      job.details = {
        ...(job.details || {}),
        migrationMutationState: 'reconciliation_required',
      };
      changed = true;
      continue;
    }
    const safeCopyAttemptItems = isDashboardSafeCopyJob(job)
      ? job.items.filter((item) => {
        const state = item.details?.safeCopyAttemptState;
        return state === 'dispatched' || state === 'uncertain';
      })
      : [];
    if (safeCopyAttemptItems.length > 0) {
      for (const item of safeCopyAttemptItems) {
        const attemptUpdatedAt = item.details?.safeCopyAttemptUpdatedAt;
        const canonicalAttemptUpdatedAt = typeof attemptUpdatedAt === 'number'
          && Number.isSafeInteger(attemptUpdatedAt)
          && attemptUpdatedAt > 0
          ? attemptUpdatedAt
          : now;
        item.status = 'warning';
        item.error = 'The write outcome requires exact reconciliation before retry.';
        item.details = {
          ...(item.details || {}),
          safeCopyAttemptState: 'uncertain',
          safeCopyAttemptUpdatedAt: canonicalAttemptUpdatedAt,
        };
        item.endedAt = canonicalAttemptUpdatedAt;
      }
      job.status = 'pending';
      job.endedAt = undefined;
      job.details = {
        ...(job.details || {}),
        safeCopyExecutionState: 'reconciliation_required',
      };
      bumpRecoveredSafeCopyEvidenceRevision(job);
      changed = true;
      continue;
    }
    if (isDashboardSafeCopyJob(job) && job.targets?.length) {
      const targetStates = job.targets.map((target) => {
        const execution = job.items.find((item) => (
          item.targetId === target.id && item.details?.safeCopyTargetExecutionSummary === true
        ));
        if (execution) {
          return execution.details?.safeCopyTargetStatus === 'succeeded' ? 'succeeded' : 'needs_attention';
        }
        const preparation = job.items.find((item) => (
          item.targetId === target.id
          && item.details?.safeCopyPreparationSummary === true
          && item.details?.safeCopyTargetStatus === 'needs_attention'
        ));
        return preparation ? 'needs_attention' : 'pending';
      });
      if (targetStates.every((state) => state !== 'pending')) {
        const succeeded = targetStates.filter((state) => state === 'succeeded').length;
        job.status = succeeded === targetStates.length
          ? 'succeeded'
          : succeeded > 0
            ? 'partial'
            : 'failed';
        job.endedAt = job.endedAt || now;
        job.details = {
          ...(job.details || {}),
          safeCopyExecutionState: job.status === 'succeeded' ? 'complete' : 'needs_attention',
          safeCopySucceededTargetCount: succeeded,
          safeCopyNeedsAttentionTargetCount: targetStates.length - succeeded,
        };
        bumpRecoveredSafeCopyEvidenceRevision(job);
        changed = true;
        continue;
      }
      const hasPreparationLedger = job.items.some((item) => (
        item.details?.safeCopyPreparationSummary === true
      ));
      if (hasPreparationLedger) {
        job.status = 'pending';
        job.endedAt = undefined;
        job.details = {
          ...(job.details || {}),
          safeCopyExecutionState: 'resume_required',
        };
        bumpRecoveredSafeCopyEvidenceRevision(job);
        changed = true;
        continue;
      }
    }
    for (const item of job.items) {
      if (item.status !== 'running' && item.status !== 'pending') continue;
      item.status = 'failed';
      item.error = item.error || 'Interrupted by server restart.';
      item.endedAt = item.endedAt || now;
      changed = true;
    }
    job.status = 'failed';
    job.endedAt = job.endedAt || now;
    bumpRecoveredSafeCopyEvidenceRevision(job);
    changed = true;
  }
  return changed;
}

function loadJobs(): MigrationJob[] {
  const nextPath = getJobsDbPath();
  if (jobsCache && jobsPath === nextPath) return jobsCache;

  mkdirSync(dirname(nextPath), { recursive: true });
  if (jobsPath !== nextPath) jobsCache = null;
  jobsPath = nextPath;
  let jobs = readJobsFile(nextPath);
  const hadHistoryFile = existsSync(nextPath);
  const beforeImportCount = jobs.length;
  jobs = importLegacyJobsIfNeeded(nextPath, jobs);
  const importedLegacy = jobs.length !== beforeImportCount;
  const initializedSafeCopyRevisions = jobs.some((job) => (
    isDashboardSafeCopyJob(job) && safeCopyEvidenceRevision(job) === 0
  ));
  jobs = jobs.map(withInitialSafeCopyEvidenceRevision);
  const recovered = recoverInterruptedJobs(jobs);
  const next = sanitizeJobHistory(jobs);
  if (!hadHistoryFile || importedLegacy || initializedSafeCopyRevisions || recovered) writeJobsFile(nextPath, next);
  else secureHistoryFile(nextPath);
  jobsCache = next;
  return next;
}

function persistJobs(jobs: MigrationJob[]): void {
  const next = sanitizeJobHistory(jobs);
  writeJobsFile(getJobsDbPath(), next);
  jobsCache = next;
}

function upsertJob(jobs: MigrationJob[], job: MigrationJob): MigrationJob[] {
  const sanitized = sanitizeJob(job);
  const index = jobs.findIndex((row) => row.id === sanitized.id);
  if (index === -1) return [...jobs, sanitized];
  const next = [...jobs];
  next[index] = sanitized;
  return next;
}

export function insertJob(job: MigrationJob): void {
  persistJobs(upsertJob(loadJobs(), withInitialSafeCopyEvidenceRevision(job)));
}

export function updateJobStatus(job: MigrationJob): void {
  const jobs = loadJobs();
  const existing = jobs.find((row) => row.id === job.id);
  const merged = {
    ...(existing || {}),
    ...job,
    items: job.items || existing?.items || [],
  } as MigrationJob;
  persistJobs(upsertJob(jobs, withNextSafeCopyEvidenceRevision(existing, merged)));
}

/**
 * Applies one synchronous reducer to the latest persisted job snapshot. This is
 * the safe update seam for concurrent target workers; callers must not retain
 * the returned snapshot across an await and write it back later.
 */
export function updateJobAtomically(
  jobId: string,
  reducer: (current: MigrationJob) => MigrationJob,
): MigrationJob | undefined {
  const jobs = loadJobs();
  const current = jobs.find((row) => row.id === jobId);
  if (!current) return undefined;
  const currentSnapshot = sanitizeJob(current);
  const previousSerialized = JSON.stringify(currentSnapshot);
  const reduced = reducer(currentSnapshot);
  if (JSON.stringify(reduced) === previousSerialized) return current;
  const next = withNextSafeCopyEvidenceRevision(current, reduced);
  if (!next || next.id !== current.id) {
    throw new Error('Atomic job updates must preserve the persisted job identity.');
  }
  persistJobs(upsertJob(jobs, next));
  return getJob(jobId);
}

export function updateJobItem(item: MigrationJobItem): void {
  const jobs = loadJobs();
  const job = jobs.find((row) => row.id === item.jobId);
  if (!job) return;
  const sanitized = sanitizeJobItem(item);
  const index = job.items.findIndex((row) => row.id === sanitized.id);
  const nextItems = [...job.items];
  if (index === -1) nextItems.push(sanitized);
  else nextItems[index] = { ...nextItems[index], ...sanitized };
  persistJobs(upsertJob(jobs, withNextSafeCopyEvidenceRevision(job, { ...job, items: nextItems })));
}

export function getJob(id: string): MigrationJob | undefined {
  return loadJobs().find((job) => job.id === id);
}

export function listJobs(limit = 100, offset = 0): MigrationJob[] {
  return [...loadJobs()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(offset, offset + limit);
}

export function clearJobs(): void {
  persistJobs([]);
  clearMigrationDestinationModelReservations();
}

export function closeJobStoreForTests(): void {
  jobsCache = null;
  jobsPath = '';
  clearMigrationDestinationModelReservations();
}

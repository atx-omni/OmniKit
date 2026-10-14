import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
} from 'node:fs';
import { createHash } from 'node:crypto';
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
let jobsFileSnapshot: HistoryFileSnapshot | null = null;

// Fixed diagnostic labels only: never include paths, saved content, or OS errors.
export type JobHistoryDiagnostic = 'invalid_structure' | 'read_failed' | 'file_type_changed'
  | 'permissions_changed' | 'file_identity_changed' | 'content_changed' | 'timestamps_unstable';

export class JobHistoryUnavailableError extends Error {
  readonly code = 'MIGRATION_HISTORY_UNAVAILABLE';
  readonly statusCode = 503;

  constructor(readonly reason: 'invalid' | 'unreadable' | 'changed', readonly source: 'current' | 'legacy',
    readonly diagnostic: JobHistoryDiagnostic = reason === 'invalid' ? 'invalid_structure' : reason === 'unreadable' ? 'read_failed' : 'file_identity_changed') {
    super('Migration history could not be verified. Migration writes and history deletion are blocked. Restore a verified history backup or repair the history file, then restart OmniKit before retrying; do not delete it to bypass recovery.');
    this.name = 'JobHistoryUnavailableError';
  }
}

type HistoryFileMetadata = { identity: string; revision: string; mode: bigint; size: bigint };
type HistoryFileSnapshot = { metadata: HistoryFileMetadata; sha256: string };
type HistoryRead = { state: 'missing' } | { state: 'valid'; jobs: MigrationJob[]; snapshot: HistoryFileSnapshot };
const HISTORY_READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const historyDigest = (contents: Buffer | string) => createHash('sha256').update(contents).digest('hex');

function historyMetadata(stat: BigIntStats, source: 'current' | 'legacy', secure: boolean): HistoryFileMetadata {
  if (!stat.isFile()) throw new JobHistoryUnavailableError('changed', source, 'file_type_changed');
  if (secure && (stat.mode & 0o7777n) !== 0o600n) throw new JobHistoryUnavailableError('changed', source, 'permissions_changed');
  const identity = [stat.dev, stat.ino, stat.uid, stat.gid, stat.nlink].join(':');
  return { identity, revision: [identity, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode].join(':'), mode: stat.mode, size: stat.size };
}

function historyPathMetadata(pathname: string, source: 'current' | 'legacy', secure: boolean): HistoryFileMetadata {
  // lstat deliberately rejects a symlink, even when its target has the expected bytes.
  return historyMetadata(lstatSync(pathname, { bigint: true }), source, secure);
}

function assertHistoryIdentity(actual: HistoryFileMetadata, expected: HistoryFileMetadata, source: 'current' | 'legacy') {
  if (actual.identity !== expected.identity) throw new JobHistoryUnavailableError('changed', source, 'file_identity_changed');
  if (actual.mode !== expected.mode) throw new JobHistoryUnavailableError('changed', source, 'permissions_changed');
  if (actual.size !== expected.size) throw new JobHistoryUnavailableError('changed', source, 'content_changed');
}

function readStableHistoryFile(pathname: string, source: 'current' | 'legacy', expected: HistoryFileMetadata, secure: boolean, expectedDigest?: string) {
  // Only known bytes may be reverified. Cold reads have no trusted digest and
  // remain single-attempt. Nothing in this loop writes, parses or recovers jobs.
  const attempts = expectedDigest ? 3 : 1;
  let observed = expected;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(pathname, HISTORY_READ_FLAGS);
      const before = historyMetadata(fstatSync(descriptor, { bigint: true }), source, secure);
      assertHistoryIdentity(before, expected, source);
      const contents = readFileSync(descriptor);
      const after = historyMetadata(fstatSync(descriptor, { bigint: true }), source, secure);
      const pathnameAfter = historyPathMetadata(pathname, source, secure);
      assertHistoryIdentity(after, expected, source);
      assertHistoryIdentity(pathnameAfter, expected, source);
      const sha256 = historyDigest(contents);
      if (expectedDigest && sha256 !== expectedDigest) throw new JobHistoryUnavailableError('changed', source, 'content_changed');
      if (before.revision !== observed.revision || after.revision !== before.revision || pathnameAfter.revision !== after.revision) {
        // Exact bytes and security identity already matched. Re-read only to
        // establish stability after timestamp drift, never to accept new data.
        observed = pathnameAfter;
        continue;
      }
      return { contents, snapshot: { metadata: after, sha256 } };
    } catch (error) {
      if (error instanceof JobHistoryUnavailableError) throw error;
      throw new JobHistoryUnavailableError('unreadable', source);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }
  throw new JobHistoryUnavailableError('changed', source, 'timestamps_unstable');
}

function assertCachedHistoryUnchanged(): void {
  try {
    const current = historyPathMetadata(jobsPath, 'current', true);
    if (!jobsFileSnapshot || current.identity !== jobsFileSnapshot.metadata.identity) {
      throw new JobHistoryUnavailableError('changed', 'current');
    }
    if (current.revision === jobsFileSnapshot.metadata.revision) return;
    // Metadata alone can change without a history edit. Verify the exact raw
    // bytes, not reserialized/sanitized JSON, before accepting that narrow case.
    const { snapshot } = readStableHistoryFile(jobsPath, 'current', current, true, jobsFileSnapshot.sha256);
    // Never parse/recover/replay a warm ledger, especially while a job is running.
    jobsFileSnapshot = snapshot;
  } catch (error) {
    if (error instanceof JobHistoryUnavailableError) throw error;
    throw new JobHistoryUnavailableError('unreadable', 'current');
  }
}

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

function secureHistoryFile(pathname: string, expected: HistoryFileMetadata): void {
  if ((expected.mode & 0o7777n) === 0o600n) return;
  const descriptor = openSync(pathname, HISTORY_READ_FLAGS);
  try {
    const actual = historyMetadata(fstatSync(descriptor, { bigint: true }), 'current', false);
    assertHistoryIdentity(actual, expected, 'current');
    if (actual.revision !== expected.revision) throw new JobHistoryUnavailableError('changed', 'current', 'timestamps_unstable');
    fchmodSync(descriptor, 0o600);
  } finally {
    closeSync(descriptor);
  }
}

function isJob(value: unknown): value is MigrationJob {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const job = value as MigrationJob;
  return typeof job.id === 'string'
    && Boolean(job.id.trim())
    && typeof job.sourceId === 'string'
    && typeof job.sourceLabel === 'string'
    && Array.isArray(job.destinationIds) && job.destinationIds.every((id) => typeof id === 'string')
    && Array.isArray(job.documentIds) && job.documentIds.every((id) => typeof id === 'string')
    && Array.isArray(job.postMigrationActions)
    && Number.isFinite(job.createdAt)
    && ['pending', 'running', 'succeeded', 'partial', 'failed', 'canceled'].includes(job.status)
    && (job.workflow === undefined || job.workflow === 'model' || job.workflow === 'dashboard')
    && isOptionalDetails(job.details)
    && Array.isArray(job.items)
    && job.items.every((item) => item && typeof item === 'object' && !Array.isArray(item)
      && typeof item.id === 'string' && Boolean(item.id.trim())
      && item.jobId === job.id
      && typeof item.destinationId === 'string'
      && typeof item.destinationLabel === 'string'
      && typeof item.kind === 'string' && Boolean(item.kind)
      && ['pending', 'running', 'succeeded', 'failed', 'warning', 'skipped'].includes(item.status)
      && isOptionalDetails(item.details))
    && new Set(job.items.map((item) => item.id)).size === job.items.length;
}

function isOptionalDetails(value: unknown): boolean {
  return value === undefined || (value !== null && typeof value === 'object' && !Array.isArray(value));
}

function parseJobs(value: unknown): MigrationJob[] {
  const rows: unknown = Array.isArray(value) ? value : (
    value
    && typeof value === 'object'
    ? (value as { jobs?: unknown }).jobs
    : undefined
  );
  // Never discard an invalid row: it may contain unresolved write evidence.
  if (!Array.isArray(rows) || !rows.every(isJob)
    || new Set(rows.map((job) => job.id)).size !== rows.length) {
    throw new Error('Invalid migration history structure.');
  }
  return sanitizeJobHistory(rows);
}

function readJobsFile(pathname: string, source: 'current' | 'legacy'): HistoryRead {
  let metadata: HistoryFileMetadata;
  try {
    metadata = historyPathMetadata(pathname, source, false);
  } catch (error) {
    // existsSync also returns false for some access errors. Only ENOENT is an
    // absent store; permission and other I/O failures must fail closed.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' };
    if (error instanceof JobHistoryUnavailableError) throw error;
    throw new JobHistoryUnavailableError('unreadable', source);
  }
  const { contents, snapshot } = readStableHistoryFile(pathname, source, metadata, false);
  try {
    return { state: 'valid', jobs: parseJobs(JSON.parse(contents.toString('utf8')) as unknown), snapshot };
  } catch {
    // Do not expose persisted contents, filesystem paths, or parser excerpts.
    throw new JobHistoryUnavailableError('invalid', source);
  }
}

function writeJobsFile(pathname: string, jobs: MigrationJob[]): HistoryFileSnapshot {
  mkdirSync(dirname(pathname), { recursive: true });
  const sanitized = sanitizeJobHistory(jobs);
  const contents = `${JSON.stringify(sanitized, null, 2)}\n`;
  const tempPath = `${pathname}.${process.pid}.${Date.now()}.tmp`;
  let temporaryCreated = false;
  try {
    writeFileSync(tempPath, contents, { mode: 0o600, flag: 'wx' });
    temporaryCreated = true;
    const temporary = historyPathMetadata(tempPath, 'current', false);
    secureHistoryFile(tempPath, temporary);
    renameSync(tempPath, pathname);
    const written = historyPathMetadata(pathname, 'current', true);
    if (written.identity !== temporary.identity) throw new JobHistoryUnavailableError('changed', 'current');
    const { snapshot } = readStableHistoryFile(pathname, 'current', written, true, historyDigest(contents));
    return snapshot;
  } catch (error) {
    if (temporaryCreated && existsSync(tempPath)) {
      try {
        unlinkSync(tempPath);
      } catch {
        // Best-effort cleanup only; preserve the original write error.
      }
    }
    throw error;
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
  if (jobsCache && jobsPath === nextPath) {
    assertCachedHistoryUnchanged();
    return jobsCache;
  }

  if (jobsPath !== nextPath) jobsCache = null;
  jobsPath = nextPath;
  const current = readJobsFile(nextPath, 'current');
  const legacyPath = getLegacyJobsPath();
  // An existing current store, including [], is authoritative. Never replace
  // corrupt or intentionally cleared history with a stale legacy snapshot.
  const legacy = current.state === 'missing' && legacyPath !== nextPath
    ? readJobsFile(legacyPath, 'legacy')
    : { state: 'missing' } as const;
  let jobs = current.state === 'valid' ? current.jobs : legacy.state === 'valid' ? legacy.jobs : [];
  const initializedSafeCopyRevisions = jobs.some((job) => (
    isDashboardSafeCopyJob(job) && safeCopyEvidenceRevision(job) === 0
  ));
  jobs = jobs.map(withInitialSafeCopyEvidenceRevision);
  const recovered = recoverInterruptedJobs(jobs);
  const next = sanitizeJobHistory(jobs);
  let snapshot: HistoryFileSnapshot;
  if (current.state === 'missing' || initializedSafeCopyRevisions || recovered) snapshot = writeJobsFile(nextPath, next);
  else {
    secureHistoryFile(nextPath, current.snapshot.metadata);
    snapshot = readStableHistoryFile(nextPath, 'current', historyPathMetadata(nextPath, 'current', true), true, current.snapshot.sha256).snapshot;
    if (snapshot.metadata.identity !== current.snapshot.metadata.identity) {
      throw new JobHistoryUnavailableError('changed', 'current');
    }
  }
  // Archive only after the canonical history is durable. Preserve any existing
  // backup; never rename the sole recovery source before a successful write.
  if (legacy.state === 'valid' && !existsSync(`${legacyPath}.bak`)) {
    try {
      renameSync(legacyPath, `${legacyPath}.bak`);
    } catch {
      // Archiving is optional once the canonical write succeeds. Leave the
      // legacy source intact; a valid current store always takes precedence.
    }
  }
  jobsFileSnapshot = snapshot;
  jobsCache = next;
  return next;
}

function persistJobs(jobs: MigrationJob[]): void {
  assertCachedHistoryUnchanged();
  const next = sanitizeJobHistory(jobs);
  jobsFileSnapshot = writeJobsFile(getJobsDbPath(), next);
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
  const sanitized = sanitizeJobItem(item, job);
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
  loadJobs();
  persistJobs([]);
  clearMigrationDestinationModelReservations();
}

export function closeJobStoreForTests(): void {
  jobsCache = null;
  jobsPath = '';
  jobsFileSnapshot = null;
  clearMigrationDestinationModelReservations();
}

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import {
  cancelSemanticMigrationJob,
  getSemanticMigrationJob,
  resetSemanticMigrationJobsForTests,
  SemanticMigrationJobIdempotencyConflictError,
  startSemanticMigrationJob,
} from '../server/services/semanticMigrationJobs';

let tempDir = '';

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'omnikit-semantic-jobs-'));
  process.env.OMNIKIT_SEMANTIC_MIGRATION_JOB_PATH = path.join(tempDir, 'semantic-jobs.json');
  resetSemanticMigrationJobsForTests();
});

afterEach(() => {
  resetSemanticMigrationJobsForTests();
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.OMNIKIT_SEMANTIC_MIGRATION_JOB_PATH;
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitForTerminal(id: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (['succeeded', 'failed', 'cancelled'].includes(getSemanticMigrationJob(id)?.status || '')) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`Semantic migration job ${id} did not reach a terminal state.`);
}

test('running cancellation aborts the job and invokes upstream cancellation once', async () => {
  const started = deferred();
  let observedSignal: AbortSignal | undefined;
  let upstreamCancellationCalls = 0;
  const job = startSemanticMigrationJob({
    providerId: 'provider-a',
    projectId: 'project-a',
    stage: 'analyze',
    requestFingerprintSource: 'request-a',
    run: async ({ signal, registerUpstreamCancellation }) => {
      observedSignal = signal;
      registerUpstreamCancellation(async () => { upstreamCancellationCalls += 1; });
      started.resolve();
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      return { output: 'ignored-after-cancel' };
    },
  });

  await started.promise;
  const first = cancelSemanticMigrationJob(job.id);
  const second = cancelSemanticMigrationJob(job.id);
  assert.ok(first);
  assert.ok(second);
  assert.equal(first.transitioned, true);
  assert.equal(second.transitioned, false);
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(observedSignal?.aborted, true);
  assert.equal(upstreamCancellationCalls, 1);
  assert.equal(firstResult.status, 'cancelled');
  assert.equal(secondResult.status, 'cancelled');
  assert.equal(getSemanticMigrationJob(job.id)?.status, 'cancelled');
});

test('upstream cancellation failures persist only a safe terminal warning', async () => {
  const started = deferred();
  const upstreamSecret = 'Bearer upstream-cancellation-secret-value';
  const job = startSemanticMigrationJob({
    providerId: 'provider-a',
    stage: 'compile',
    requestFingerprintSource: 'request-b',
    run: async ({ signal, registerUpstreamCancellation }) => {
      registerUpstreamCancellation(async () => { throw new Error(upstreamSecret); });
      started.resolve();
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      return {};
    },
  });

  await started.promise;
  const cancellation = cancelSemanticMigrationJob(job.id);
  assert.ok(cancellation);
  const cancelled = await cancellation;
  const durable = readFileSync(process.env.OMNIKIT_SEMANTIC_MIGRATION_JOB_PATH!, 'utf8');

  assert.equal(cancelled.status, 'cancelled');
  assert.match(cancelled.cancellationWarning || '', /could not confirm upstream cancellation/i);
  assert.equal(durable.includes(upstreamSecret), false);
  assert.match(durable, /could not confirm upstream cancellation/i);
});

test('queued cancellation is terminal and prevents execution', async () => {
  let runCalls = 0;
  const job = startSemanticMigrationJob({
    providerId: 'provider-a',
    stage: 'repair',
    requestFingerprintSource: 'request-c',
    run: async () => { runCalls += 1; },
  });

  const cancellation = cancelSemanticMigrationJob(job.id);
  assert.ok(cancellation);
  assert.equal((await cancellation).status, 'cancelled');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(runCalls, 0);
  assert.equal(getSemanticMigrationJob(job.id)?.status, 'cancelled');
});

test('idempotency reuses identical scoped requests and rejects conflicting input', () => {
  let duplicateRunCalls = 0;
  const base = {
    providerId: 'provider-a',
    projectId: 'project-a',
    stage: 'analyze' as const,
    idempotencyKey: 'migration-plan-1',
    requestFingerprintSource: 'identical-request',
  };
  const first = startSemanticMigrationJob({ ...base, run: async () => ({ first: true }) });
  const reused = startSemanticMigrationJob({ ...base, run: async () => { duplicateRunCalls += 1; } });

  assert.equal(reused.id, first.id);
  assert.match(first.requestFingerprint, /^[a-f0-9]{64}$/);
  assert.notEqual(first.requestFingerprint, createHash('sha256').update(base.requestFingerprintSource).digest('hex'));
  assert.equal(duplicateRunCalls, 0);
  assert.throws(
    () => startSemanticMigrationJob({ ...base, requestFingerprintSource: 'different-request', run: async () => ({}) }),
    (error: unknown) => error instanceof SemanticMigrationJobIdempotencyConflictError
      && error.statusCode === 409
      && error.code === 'SEMANTIC_JOB_IDEMPOTENCY_CONFLICT',
  );

  const differentProject = startSemanticMigrationJob({ ...base, projectId: 'project-b', requestFingerprintSource: 'different-request', run: async () => ({}) });
  const differentStage = startSemanticMigrationJob({ ...base, stage: 'compile', requestFingerprintSource: 'different-request', run: async () => ({}) });
  const differentProvider = startSemanticMigrationJob({ ...base, providerId: 'provider-b', requestFingerprintSource: 'different-request', run: async () => ({}) });
  assert.notEqual(differentProject.id, first.id);
  assert.notEqual(differentStage.id, first.id);
  assert.notEqual(differentProvider.id, first.id);
});

test('idempotency releases failed and cancelled jobs but retains a retrievable success', async () => {
  const base = {
    providerId: 'provider-retry',
    projectId: 'project-retry',
    stage: 'compile' as const,
    idempotencyKey: 'retryable-request',
    requestFingerprintSource: 'stable-request',
  };
  let runCalls = 0;
  const failed = startSemanticMigrationJob({
    ...base,
    run: async () => {
      runCalls += 1;
      throw Object.assign(new Error('Temporary provider failure.'), { code: 'AI_PROVIDER_UNAVAILABLE', retryable: true });
    },
  });
  await waitForTerminal(failed.id);

  const succeeded = startSemanticMigrationJob({
    ...base,
    run: async () => {
      runCalls += 1;
      return { output: { ok: true } };
    },
  });
  assert.notEqual(succeeded.id, failed.id);
  await waitForTerminal(succeeded.id);

  const reused = startSemanticMigrationJob({
    ...base,
    run: async () => {
      runCalls += 1;
      return { output: { duplicate: true } };
    },
  });
  assert.equal(reused.id, succeeded.id);

  const queued = startSemanticMigrationJob({
    ...base,
    idempotencyKey: 'cancelled-request',
    run: async () => {
      runCalls += 1;
      return {};
    },
  });
  const cancellation = cancelSemanticMigrationJob(queued.id);
  assert.ok(cancellation);
  await cancellation;
  const afterCancellation = startSemanticMigrationJob({
    ...base,
    idempotencyKey: 'cancelled-request',
    run: async () => {
      runCalls += 1;
      return {};
    },
  });
  assert.notEqual(afterCancellation.id, queued.id);
  await waitForTerminal(afterCancellation.id);
  assert.equal(runCalls, 3);
});

test('an expired transient result releases the idempotency key for a new attempt', async () => {
  const base = {
    providerId: 'provider-expiry',
    stage: 'analyze' as const,
    idempotencyKey: 'expiring-result',
    requestFingerprintSource: 'expiring-request',
  };
  const first = startSemanticMigrationJob({ ...base, run: async () => ({ output: { ok: true } }) });
  await waitForTerminal(first.id);

  const originalNow = Date.now;
  Date.now = () => originalNow() + (31 * 60 * 1000);
  let second;
  try {
    second = startSemanticMigrationJob({ ...base, run: async () => ({ output: { ok: true } }) });
  } finally {
    Date.now = originalNow;
  }
  assert.notEqual(second.id, first.id);
  await waitForTerminal(second.id);
});

test('a process-recovered running job does not retain the idempotency lease', async () => {
  const requestFingerprintSource = 'restarted-request';
  const recoveredId = 'semantic_job_recovered';
  const now = new Date().toISOString();
  writeFileSync(process.env.OMNIKIT_SEMANTIC_MIGRATION_JOB_PATH!, JSON.stringify({
    version: 1,
    jobs: [{
      id: recoveredId,
      providerId: 'provider-restart',
      projectId: 'project-restart',
      stage: 'repair',
      status: 'running',
      requestFingerprint: createHash('sha256').update(requestFingerprintSource).digest('hex'),
      idempotencyKey: 'restarted-key',
      createdAt: now,
      updatedAt: now,
    }],
  }));

  const replacement = startSemanticMigrationJob({
    providerId: 'provider-restart',
    projectId: 'project-restart',
    stage: 'repair',
    requestFingerprintSource,
    idempotencyKey: 'restarted-key',
    run: async () => ({ output: { recovered: true } }),
  });
  assert.notEqual(replacement.id, recoveredId);
  assert.equal(getSemanticMigrationJob(recoveredId)?.status, 'failed');
  await waitForTerminal(replacement.id);
});

test('lifecycle hooks observe durable transitions and a started-audit failure remains fail closed', async () => {
  let createdStatus = '';
  let succeededStatus = '';
  const succeeded = startSemanticMigrationJob({
    providerId: 'provider-lifecycle',
    stage: 'analyze',
    requestFingerprintSource: 'lifecycle-success',
    onCreated: (job) => {
      const durable = JSON.parse(readFileSync(process.env.OMNIKIT_SEMANTIC_MIGRATION_JOB_PATH!, 'utf8')) as { jobs: Array<{ id: string; status: string }> };
      createdStatus = durable.jobs.find((item) => item.id === job.id)?.status || '';
    },
    onSucceeded: (job) => {
      const durable = JSON.parse(readFileSync(process.env.OMNIKIT_SEMANTIC_MIGRATION_JOB_PATH!, 'utf8')) as { jobs: Array<{ id: string; status: string }> };
      succeededStatus = durable.jobs.find((item) => item.id === job.id)?.status || '';
    },
    run: async () => ({ output: { ok: true } }),
  });
  await waitForTerminal(succeeded.id);
  assert.equal(createdStatus, 'queued');
  assert.equal(succeededStatus, 'succeeded');

  let failedStatus = '';
  const failed = startSemanticMigrationJob({
    providerId: 'provider-lifecycle',
    stage: 'compile',
    requestFingerprintSource: 'lifecycle-failure',
    onFailed: (job) => {
      const durable = JSON.parse(readFileSync(process.env.OMNIKIT_SEMANTIC_MIGRATION_JOB_PATH!, 'utf8')) as { jobs: Array<{ id: string; status: string }> };
      failedStatus = durable.jobs.find((item) => item.id === job.id)?.status || '';
    },
    run: async () => { throw new Error('Expected provider failure.'); },
  });
  await waitForTerminal(failed.id);
  assert.equal(failedStatus, 'failed');

  let runCalls = 0;
  assert.throws(() => startSemanticMigrationJob({
    providerId: 'provider-lifecycle',
    stage: 'repair',
    requestFingerprintSource: 'lifecycle-audit-failure',
    onCreated: () => { throw new Error('Audit sink unavailable.'); },
    run: async () => {
      runCalls += 1;
      return {};
    },
  }), /Audit sink unavailable/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runCalls, 0);
  const durable = JSON.parse(readFileSync(process.env.OMNIKIT_SEMANTIC_MIGRATION_JOB_PATH!, 'utf8')) as { jobs: Array<{ errorCode?: string; status: string }> };
  assert.ok(durable.jobs.some((job) => job.status === 'failed' && job.errorCode === 'SEMANTIC_JOB_START_AUDIT_FAILED'));
});

test('durable job errors are redacted and length bounded', async () => {
  const job = startSemanticMigrationJob({
    providerId: 'provider-bounded-error',
    stage: 'analyze',
    requestFingerprintSource: 'bounded-error',
    run: async () => {
      throw new Error(`Provider failure ${'x'.repeat(2_000)} api_key=secret-value`);
    },
  });
  await waitForTerminal(job.id);
  const failed = getSemanticMigrationJob(job.id);
  assert.equal(failed?.status, 'failed');
  assert.ok((failed?.error?.length || 0) <= 500);
  assert.doesNotMatch(failed?.error || '', /secret-value/);
});

test('reset aborts active controllers and clears durable idempotency state', async () => {
  const started = deferred();
  const release = deferred();
  let signal: AbortSignal | undefined;
  const input = {
    providerId: 'provider-reset',
    stage: 'analyze' as const,
    idempotencyKey: 'reset-key',
    requestFingerprintSource: 'reset-request',
  };
  const first = startSemanticMigrationJob({
    ...input,
    run: async (context) => {
      signal = context.signal;
      started.resolve();
      await release.promise;
      return {};
    },
  });
  await started.promise;

  resetSemanticMigrationJobsForTests();
  assert.equal(signal?.aborted, true);
  const second = startSemanticMigrationJob({ ...input, run: async () => ({}) });
  assert.notEqual(second.id, first.id);
  release.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(getSemanticMigrationJob(second.id)?.id, second.id);
});

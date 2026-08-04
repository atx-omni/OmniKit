import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import {
  appendBiMigrationOperationTransition,
  appendBiMigrationRunTransition,
  BiMigrationRunIdempotencyConflictError,
  BiMigrationRunTamperError,
  BiMigrationRunValidationError,
  BiMigrationRunVersionError,
  createBiMigrationRun,
  getBiMigrationRun,
  getBiMigrationRunSnapshotPath,
  getBiMigrationRunStorePath,
  markBiMigrationOperationDispatched,
  resetBiMigrationRunStoreForTests,
  type HashDigest,
} from '../server/services/biMigrationRunStore';

let temporaryRoot = '';

function digest(value: string): HashDigest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

async function createRun(idempotencyKey = 'foundation-project-a') {
  return createBiMigrationRun({
    idempotencyKey,
    planHash: digest('plan-a'),
    inputHash: digest('input-a'),
  });
}

beforeEach(() => {
  temporaryRoot = mkdtempSync(join(tmpdir(), 'omnikit-bi-migration-runs-'));
  process.env.OMNIKIT_BI_MIGRATION_RUN_STORE_PATH = join(temporaryRoot, 'runs.jsonl');
  resetBiMigrationRunStoreForTests();
});

afterEach(() => {
  resetBiMigrationRunStoreForTests();
  delete process.env.OMNIKIT_BI_MIGRATION_RUN_STORE_PATH;
  rmSync(temporaryRoot, { recursive: true, force: true });
});

test('a dispatched mutation becomes UNKNOWN and requires reconciliation after restart', async () => {
  let run = await createRun();
  run = await appendBiMigrationOperationTransition({
    runId: run.id,
    expectedVersion: run.version,
    operationKey: 'create-shared-model',
    kind: 'create_model',
    logicalResourceKey: 'shared-model-a',
    inputHash: digest('create-shared-model-input'),
    status: 'PLANNED',
  });
  run = await markBiMigrationOperationDispatched({
    runId: run.id,
    expectedVersion: run.version,
    operationKey: 'create-shared-model',
  });
  assert.equal(run.operations[0].status, 'DISPATCHED');

  resetBiMigrationRunStoreForTests();
  const recovered = await getBiMigrationRun(run.id);

  assert.ok(recovered);
  assert.equal(recovered.phase, 'RECONCILE_REQUIRED');
  assert.equal(recovered.version, 4);
  assert.equal(recovered.operations[0].status, 'UNKNOWN');
  assert.ok(recovered.operations[0].unknownAt);
  assert.deepEqual(recovered.allowedCommands, ['reconcile', 'rollback']);
  assert.equal(readFileSync(getBiMigrationRunStorePath(), 'utf8').trim().split('\n').length, 4);
});

test('the hash chain detects journal tampering before returning run state', async () => {
  const run = await createRun();
  const pathname = getBiMigrationRunStorePath();
  const [firstLine] = readFileSync(pathname, 'utf8').trim().split('\n');
  const event = JSON.parse(firstLine) as { run: { phase: string } };
  event.run.phase = 'READY_FOR_YAML';
  writeFileSync(pathname, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  resetBiMigrationRunStoreForTests();

  await assert.rejects(
    getBiMigrationRun(run.id),
    (error: unknown) => {
      assert.ok(error instanceof BiMigrationRunTamperError);
      assert.equal(error.statusCode, 500);
      return true;
    },
  );
});

test('the derived snapshot detects state tampering when it is current', async () => {
  const run = await createRun();
  const pathname = getBiMigrationRunSnapshotPath();
  const snapshot = JSON.parse(readFileSync(pathname, 'utf8')) as {
    runs: Array<{ id: string; phase: string }>;
  };
  snapshot.runs[0].phase = 'READY_FOR_YAML';
  writeFileSync(pathname, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
  resetBiMigrationRunStoreForTests();

  await assert.rejects(
    getBiMigrationRun(run.id),
    (error: unknown) => {
      assert.ok(error instanceof BiMigrationRunTamperError);
      assert.match(error.message, /snapshot/i);
      return true;
    },
  );
});

test('stale run updates produce a typed 412 version mismatch', async () => {
  const run = await createRun();

  await assert.rejects(
    appendBiMigrationRunTransition({
      runId: run.id,
      expectedVersion: run.version + 1,
      phase: 'PREFLIGHTED',
    }),
    (error: unknown) => {
      assert.ok(error instanceof BiMigrationRunVersionError);
      assert.equal(error.statusCode, 412);
      assert.equal(error.expectedVersion, 2);
      assert.equal(error.actualVersion, 1);
      return true;
    },
  );
});

test('the process-local mutex allows only one concurrent writer at a version', async () => {
  const run = await createRun();
  const results = await Promise.allSettled([
    appendBiMigrationRunTransition({
      runId: run.id,
      expectedVersion: run.version,
      phase: 'PREFLIGHTED',
    }),
    appendBiMigrationRunTransition({
      runId: run.id,
      expectedVersion: run.version,
      phase: 'FAILED',
    }),
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.ok(rejected && rejected.status === 'rejected');
  assert.ok(rejected.reason instanceof BiMigrationRunVersionError);
  assert.equal(rejected.reason.statusCode, 412);
  const persisted = await getBiMigrationRun(run.id);
  assert.equal(persisted?.version, 2);
});

test('idempotent creation reuses matching input and rejects key collisions', async () => {
  const first = await createRun('stable-project-key');
  const repeated = await createRun('stable-project-key');
  assert.deepEqual(repeated, first);
  assert.equal(readFileSync(getBiMigrationRunStorePath(), 'utf8').trim().split('\n').length, 1);

  await assert.rejects(
    createBiMigrationRun({
      idempotencyKey: 'stable-project-key',
      planHash: digest('plan-a'),
      inputHash: digest('different-input'),
    }),
    (error: unknown) => {
      assert.ok(error instanceof BiMigrationRunIdempotencyConflictError);
      assert.equal(error.statusCode, 409);
      return true;
    },
  );
});

test('secret-shaped fields and values are rejected before journal creation', async () => {
  await assert.rejects(
    createBiMigrationRun({
      idempotencyKey: 'secret-field-test',
      planHash: digest('plan-a'),
      inputHash: digest('input-a'),
      apiKey: 'must-not-be-written',
    } as never),
    (error: unknown) => {
      assert.ok(error instanceof BiMigrationRunValidationError);
      assert.match(error.message, /Secret-shaped field/);
      return true;
    },
  );

  const run = await createRun('secret-value-test');
  let planned = await appendBiMigrationOperationTransition({
    runId: run.id,
    expectedVersion: run.version,
    operationKey: 'refresh-schema',
    kind: 'refresh_schema',
    logicalResourceKey: 'schema-a',
    inputHash: digest('refresh-schema-input'),
    status: 'PLANNED',
  });
  planned = await markBiMigrationOperationDispatched({
    runId: planned.id,
    expectedVersion: planned.version,
    operationKey: 'refresh-schema',
  });
  await assert.rejects(
    appendBiMigrationOperationTransition({
      runId: planned.id,
      expectedVersion: planned.version,
      operationKey: 'refresh-schema',
      status: 'TERMINAL_FAILURE',
      errorMessage: 'authorization: Bearer should-never-persist',
    }),
    (error: unknown) => {
      assert.ok(error instanceof BiMigrationRunValidationError);
      assert.match(error.message, /Secret-shaped content/);
      return true;
    },
  );

  assert.doesNotMatch(readFileSync(getBiMigrationRunStorePath(), 'utf8'), /must-not-be-written|should-never-persist/);
});

test('journal and atomic snapshot are created with owner-only permissions', async () => {
  await createRun();

  assert.equal(statSync(getBiMigrationRunStorePath()).mode & 0o777, 0o600);
  assert.equal(statSync(getBiMigrationRunSnapshotPath()).mode & 0o777, 0o600);
});

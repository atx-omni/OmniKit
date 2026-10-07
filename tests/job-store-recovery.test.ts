import assert from 'node:assert/strict';
import fs, { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import migrationJobsHandler from '../server/handlers/migration-jobs';
import vaultHandler from '../server/handlers/vault';
import { createDashboardSafeCopyJob } from '../server/services/dashboardSafeCopyJobs';
import {
  JobHistoryUnavailableError, clearJobs, closeJobStoreForTests, getJob, insertJob,
  listJobs, updateJobAtomically, updateJobItem, updateJobStatus,
} from '../server/services/jobStore';
import { runTrackedSchemaRefresh, type MigrationJob } from '../server/services/migrationJobs';
import { migrationJobHasUnresolvedDestinationModelMutation } from '../server/services/migrationScopeReservation';
import { getInstance, isVaultUnlocked, lockVault, resetVault, unlockVault, upsertInstance } from '../server/services/nativeVault';
import { OmniClient } from '../server/services/omniClient';

let root: string;
let historyPath: string;
let legacyPath: string;
const environmentKeys = ['OMNIKIT_JOB_HISTORY_PATH', 'OMNIKIT_JOBS_PATH', 'OMNIKIT_VAULT_PATH'] as const;
let originalEnvironment: Array<string | undefined>;

beforeEach(() => {
  originalEnvironment = environmentKeys.map((key) => process.env[key]);
  root = mkdtempSync(join(tmpdir(), 'omnikit-history-recovery-'));
  historyPath = join(root, 'history.json');
  legacyPath = join(root, 'legacy.json');
  process.env.OMNIKIT_JOB_HISTORY_PATH = historyPath;
  process.env.OMNIKIT_JOBS_PATH = legacyPath;
  process.env.OMNIKIT_VAULT_PATH = join(root, 'vault.enc');
  closeJobStoreForTests();
  resetVault();
});

afterEach(() => {
  lockVault();
  closeJobStoreForTests();
  resetVault();
  rmSync(root, { recursive: true, force: true });
  environmentKeys.forEach((key, index) => {
    const value = originalEnvironment[index];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
});

function job(): MigrationJob {
  return {
    id: 'history-job', workflow: 'model', sourceId: 'example-source', sourceLabel: 'Example source',
    destinationIds: ['example-destination'], documentIds: [], postMigrationActions: [],
    emptyFirst: false, replaceSameNamed: false, deleteSourceOnSuccess: false,
    status: 'failed', createdAt: 1,
    items: [{
      id: 'history-item', jobId: 'history-job', destinationId: 'example-destination',
      destinationLabel: 'Example destination', targetModelId: 'example-model', kind: 'model_yaml_write', status: 'failed',
    }],
  };
}

function unavailable(error: unknown): boolean {
  assert.ok(error instanceof JobHistoryUnavailableError);
  assert.equal(error.code, 'MIGRATION_HISTORY_UNAVAILABLE');
  assert.equal(error.statusCode, 503);
  assert.equal(error.message.includes(root), false);
  return true;
}

function assertAllStoreAccessBlocked(): void {
  const candidate = job();
  for (const operation of [
    () => listJobs(), () => getJob(candidate.id), () => insertJob(candidate),
    () => updateJobStatus(candidate), () => updateJobItem(candidate.items[0]),
    () => updateJobAtomically(candidate.id, (current) => current), () => clearJobs(),
  ]) assert.throws(operation, unavailable);
}

test('missing history initializes securely and normal mutations still round trip', () => {
  assert.deepEqual(listJobs(), []);
  assert.equal(statSync(historyPath).mode & 0o777, 0o600);
  insertJob(job());
  updateJobItem({ ...job().items[0], status: 'succeeded' });
  updateJobAtomically(job().id, (current) => ({ ...current, status: 'succeeded' }));
  closeJobStoreForTests();
  assert.equal(getJob(job().id)?.status, 'succeeded');
  assert.equal(getJob(job().id)?.items[0].status, 'succeeded');
  clearJobs();
  assert.deepEqual(listJobs(), []);
});

const invalidHistories: Array<[string, () => string]> = [
  ['invalid JSON', () => '{"secret":"fixture-only",'],
  ['unsupported container', () => '{}'],
  ['invalid row among valid jobs', () => JSON.stringify([job(), { id: 'lost-evidence' }])],
  ['invalid required status', () => JSON.stringify([{ ...job(), status: 'unknown' }])],
  ['invalid item identity', () => JSON.stringify([{ ...job(), items: [{ ...job().items[0], jobId: 'other' }] }])],
  ['duplicate job identity', () => JSON.stringify([job(), job()])],
  ['invalid wrapped history', () => JSON.stringify({ jobs: [job(), null] })],
];
for (const [name, contents] of invalidHistories) {
  test(`${name} blocks reads and every mutator without replacing evidence`, () => {
    const original = contents();
    writeFileSync(historyPath, original);
    assertAllStoreAccessBlocked();
    assert.equal(readFileSync(historyPath, 'utf8'), original);
  });
}

test('unreadable history is not treated as absent', () => {
  // A directory is a deterministic read failure, including under privileged CI.
  mkdirSync(historyPath);
  assertAllStoreAccessBlocked();
  assert.equal(statSync(historyPath).isDirectory(), true);
});

test('corrupt current history never falls back to valid legacy history', () => {
  writeFileSync(historyPath, '{');
  const legacy = JSON.stringify([job()]);
  writeFileSync(legacyPath, legacy);
  assertAllStoreAccessBlocked();
  assert.equal(readFileSync(historyPath, 'utf8'), '{');
  assert.equal(readFileSync(legacyPath, 'utf8'), legacy);
  assert.equal(existsSync(`${legacyPath}.bak`), false);
});

test('corrupt legacy history blocks fresh initialization and retains the original', () => {
  writeFileSync(legacyPath, '{');
  assertAllStoreAccessBlocked();
  assert.equal(existsSync(historyPath), false);
  assert.equal(readFileSync(legacyPath, 'utf8'), '{');
  assert.equal(existsSync(`${legacyPath}.bak`), false);
});

test('valid empty canonical history is authoritative even if legacy history is corrupt', () => {
  writeFileSync(historyPath, '[]');
  writeFileSync(legacyPath, '{');
  assert.deepEqual(listJobs(), []);
  insertJob(job());
  assert.equal(readFileSync(legacyPath, 'utf8'), '{');
});

test('wrapped legacy history imports and archives only after a canonical write', () => {
  const original = JSON.stringify({ jobs: [job()] });
  writeFileSync(legacyPath, original);
  assert.equal(listJobs()[0].id, job().id);
  assert.equal(JSON.parse(readFileSync(historyPath, 'utf8'))[0].id, job().id);
  assert.equal(readFileSync(`${legacyPath}.bak`, 'utf8'), original);
  closeJobStoreForTests();
  assert.equal(listJobs()[0].id, job().id);
});

test('failed canonical write never renames the sole legacy recovery source', (t) => {
  const original = JSON.stringify([job()]);
  writeFileSync(legacyPath, original);
  t.mock.method(Date, 'now', () => 12345);
  // Fail the atomic temporary-file write, after history reads succeed. This
  // works under privileged CI too, without depending on permission bits.
  mkdirSync(`${historyPath}.${process.pid}.12345.tmp`);
  assert.throws(() => listJobs(), /EEXIST/);
  assert.equal(existsSync(historyPath), false);
  assert.equal(readFileSync(legacyPath, 'utf8'), original);
  assert.equal(existsSync(`${legacyPath}.bak`), false);
});

for (const change of ['corrupt', 'delete'] as const) {
  test(`warm cache cannot hide history ${change}`, () => {
    insertJob(job());
    if (change === 'corrupt') writeFileSync(historyPath, '{');
    else unlinkSync(historyPath);
    assertAllStoreAccessBlocked();
    if (change === 'corrupt') assert.equal(readFileSync(historyPath, 'utf8'), '{');
    else assert.equal(existsSync(historyPath), false);
  });
}

test('warm metadata-only drift preserves exact running state without recovery or a history rewrite', () => {
  const running = job();
  running.status = 'running';
  running.items[0].status = 'running';
  running.items.push({ ...running.items[0], id: 'claimed-item', kind: 'destination_model_mutation', details: {
    migrationDestinationModelMutation: true, migrationMutationState: 'claimed',
    migrationMutationOperation: 'model_job', migrationMutationUpdatedAt: 1,
  } });
  insertJob(running);
  const baseline = structuredClone(getJob(running.id));
  const raw = readFileSync(historyPath);
  chmodSync(historyPath, 0o600);
  assert.equal(getJob(running.id)?.status, 'running');
  const changedTime = new Date('2025-01-02T03:04:05.000Z');
  utimesSync(historyPath, changedTime, changedTime);
  const beforeRead = statSync(historyPath, { bigint: true });
  assert.deepEqual(getJob(running.id), baseline);
  assert.equal(getJob(running.id)?.items[1].details?.migrationMutationState, 'claimed');
  assert.deepEqual(readFileSync(historyPath), raw);
  const afterRead = statSync(historyPath, { bigint: true });
  assert.equal(afterRead.ino, beforeRead.ino);
  assert.equal(afterRead.mtimeNs, beforeRead.mtimeNs);
  assert.equal(afterRead.ctimeNs, beforeRead.ctimeNs);
  updateJobItem({ ...running.items[0], status: 'succeeded' });
  assert.equal(getJob(running.id)?.items[0].status, 'succeeded');
  assert.equal(getJob(running.id)?.status, 'running');
});

test('a timestamp change during post-rename verification commits the new cache without repeating the write', (t) => {
  insertJob(job());
  const read = fs.readFileSync;
  const rename = fs.renameSync;
  let renamed = false;
  let renameCount = 0;
  let changedDuringRead = false;
  const renamedFile = t.mock.method(fs, 'renameSync', (...args: Parameters<typeof fs.renameSync>) => {
    const result = Reflect.apply(rename, fs, args);
    if (args[1] === historyPath) { renamed = true; renameCount += 1; }
    return result;
  });
  const reader = t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
    const result = Reflect.apply(read, fs, args);
    if (renamed && typeof args[0] === 'number' && !changedDuringRead) {
      changedDuringRead = true;
      const changedTime = new Date('2025-01-02T03:04:05.000Z');
      utimesSync(historyPath, changedTime, changedTime);
    }
    return result;
  });
  syncBuiltinESMExports();
  try {
    updateJobItem({ ...job().items[0], status: 'succeeded' });
    assert.equal(getJob(job().id)?.items[0].status, 'succeeded');
    assert.equal(JSON.parse(read(historyPath, 'utf8'))[0].items[0].status, 'succeeded');
    assert.equal(changedDuringRead, true);
    assert.equal(renameCount, 1, 'Verification must never repeat the atomic write.');
  } finally {
    reader.mock.restore(); renamedFile.mock.restore(); syncBuiltinESMExports();
  }
});

test('cold reads retain a raw-byte baseline and do not chmod an already secure ledger', () => {
  const raw = JSON.stringify({ jobs: [job()] }) + ' \n';
  writeFileSync(historyPath, raw, { mode: 0o600 });
  const before = statSync(historyPath, { bigint: true });
  assert.equal(listJobs()[0].id, job().id);
  assert.equal(statSync(historyPath, { bigint: true }).ctimeNs, before.ctimeNs);
  chmodSync(historyPath, 0o600);
  assert.equal(listJobs()[0].id, job().id);
  assert.equal(readFileSync(historyPath, 'utf8'), raw);
});

for (const change of ['valid JSON value', 'JSON whitespace'] as const) {
  test(`warm cache rejects same-size ${change} changes even with restored mtime`, () => {
    insertJob(job());
    const fixedTime = new Date('2025-01-02T03:04:05.000Z');
    utimesSync(historyPath, fixedTime, fixedTime);
    getJob(job().id);
    const original = readFileSync(historyPath, 'utf8');
    const before = statSync(historyPath, { bigint: true });
    const changed = change === 'valid JSON value'
      ? original.replace('Example source', 'Changed source') : original.replace('  ', ' \t');
    assert.notEqual(changed, original);
    assert.equal(Buffer.byteLength(changed), Buffer.byteLength(original));
    assert.doesNotThrow(() => JSON.parse(changed));
    writeFileSync(historyPath, changed);
    utimesSync(historyPath, fixedTime, fixedTime);
    assert.equal(statSync(historyPath, { bigint: true }).mtimeNs, before.mtimeNs);
    assertAllStoreAccessBlocked();
    assert.equal(readFileSync(historyPath, 'utf8'), changed);
  });
}

for (const change of ['replacement', 'symlink', 'permissions'] as const) {
  test(`warm cache rejects unchanged bytes after a file ${change}`, () => {
    insertJob(job());
    const raw = readFileSync(historyPath);
    if (change === 'replacement') {
      const replacement = join(root, 'replacement.json');
      writeFileSync(replacement, raw, { mode: 0o600 });
      renameSync(replacement, historyPath);
    } else if (change === 'symlink') {
      const relocated = join(root, 'relocated.json');
      renameSync(historyPath, relocated);
      symlinkSync(relocated, historyPath);
    } else chmodSync(historyPath, 0o640);
    assertAllStoreAccessBlocked();
    assert.deepEqual(readFileSync(historyPath), raw);
    if (change === 'permissions') assert.equal(statSync(historyPath).mode & 0o777, 0o640, 'Warm reads must not repair changed permissions.');
  });
}

test('warm cache rejects changed ownership metadata without requiring privileged fixture ownership changes', (t) => {
  insertJob(job());
  const original = fs.lstatSync;
  const mocked = t.mock.method(fs, 'lstatSync', (...args: Parameters<typeof fs.lstatSync>) => {
    const result = Reflect.apply(original, fs, args);
    if (args[0] === historyPath && typeof result.uid === 'bigint') result.uid += 1n;
    return result;
  });
  syncBuiltinESMExports();
  try { assertAllStoreAccessBlocked(); }
  finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test('warm cache reverifies timestamp-only drift during a read without recovering or rewriting jobs', (t) => {
  insertJob(job());
  const firstTime = new Date('2025-01-02T03:04:05.000Z');
  utimesSync(historyPath, firstTime, firstTime);
  const original = fs.readFileSync;
  let changedDuringRead = false;
  const mocked = t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
    const result = Reflect.apply(original, fs, args);
    if (typeof args[0] === 'number' && !changedDuringRead) {
      changedDuringRead = true;
      const laterTime = new Date('2025-01-02T03:04:06.000Z');
      utimesSync(historyPath, laterTime, laterTime);
    }
    return result;
  });
  syncBuiltinESMExports();
  try { assert.equal(getJob(job().id)?.status, 'failed'); }
  finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(changedDuringRead, true);
});

for (const change of ['content', 'replacement', 'permissions', 'read failure', 'persistent timestamps'] as const) {
  test(`post-rename verification blocks ${change} without repeating the write or trusting stale cache`, (t) => {
    insertJob(job());
    const read = fs.readFileSync;
    const rename = fs.renameSync;
    let renameCount = 0;
    let verificationReads = 0;
    const renamedFile = t.mock.method(fs, 'renameSync', (...args: Parameters<typeof fs.renameSync>) => {
      const result = Reflect.apply(rename, fs, args);
      if (args[1] === historyPath) renameCount += 1;
      return result;
    });
    const reader = t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
      if (!renameCount || typeof args[0] !== 'number') return Reflect.apply(read, fs, args);
      verificationReads += 1;
      if (change === 'read failure') throw new Error('fixture-only filesystem detail');
      if (change === 'content') writeFileSync(historyPath, read(historyPath, 'utf8').replace('Example source', 'Changed source'));
      const result = Reflect.apply(read, fs, args);
      if (change === 'replacement') {
        const replacement = join(root, 'replacement.json');
        writeFileSync(replacement, read(historyPath), { mode: 0o600 });
        rename(replacement, historyPath);
      } else if (change === 'permissions') chmodSync(historyPath, 0o640);
      else if (change === 'persistent timestamps') {
        const date = new Date(Date.UTC(2025, 0, 1, 0, 0, verificationReads));
        utimesSync(historyPath, date, date);
      }
      return result;
    });
    syncBuiltinESMExports();
    try {
      const diagnostic = {
        content: 'content_changed', replacement: 'file_identity_changed', permissions: 'permissions_changed',
        'read failure': 'read_failed', 'persistent timestamps': 'timestamps_unstable',
      }[change];
      assert.throws(() => updateJobItem({ ...job().items[0], status: 'succeeded' }), error => {
        assert.ok(unavailable(error));
        assert.equal((error as JobHistoryUnavailableError).diagnostic, diagnostic);
        assert.doesNotMatch((error as Error).message, /fixture-only/);
        return true;
      });
      assert.equal(renameCount, 1);
      assert.equal(verificationReads, change === 'persistent timestamps' ? 3 : 1);
    } finally {
      reader.mock.restore(); renamedFile.mock.restore(); syncBuiltinESMExports();
    }
    const retained = read(historyPath);
    assertAllStoreAccessBlocked();
    assert.deepEqual(read(historyPath), retained, 'Rejected evidence must not be overwritten.');
  });
}

test('changing paths never reuses a healthy cache for a damaged store', () => {
  insertJob(job());
  const corruptPath = join(root, 'corrupt.json');
  writeFileSync(corruptPath, '{');
  process.env.OMNIKIT_JOB_HISTORY_PATH = corruptPath;
  assertAllStoreAccessBlocked();
  process.env.OMNIKIT_JOB_HISTORY_PATH = historyPath;
  assert.equal(listJobs()[0].id, job().id);
});

test('restart recovery retains dispatched writes as unresolved and releases only prewrite claims', () => {
  const pending = job();
  pending.status = 'running';
  pending.items = ['claimed', 'dispatched'].map((state) => ({
    ...job().items[0], id: `lease-${state}`, kind: 'destination_model_mutation', status: 'running',
    details: {
      migrationDestinationModelMutation: true, migrationMutationState: state,
      migrationMutationOperation: 'model_job', migrationMutationUpdatedAt: 1,
    },
  }));
  writeFileSync(historyPath, JSON.stringify([pending]));
  const recovered = getJob(pending.id)!;
  assert.equal(recovered.items[0].details?.migrationMutationState, 'failed_prewrite');
  assert.equal(recovered.items[1].details?.migrationMutationState, 'uncertain');
  assert.equal(migrationJobHasUnresolvedDestinationModelMutation(recovered), true);
});

test('corrupt history leaves vault usable but blocks reset, clear, job preparation, and remote refresh', async (t) => {
  let externalCalls = 0;
  t.mock.method(OmniClient.prototype, 'refreshModel', async () => {
    externalCalls += 1;
    throw new Error('Unexpected external write');
  });
  t.mock.method(globalThis, 'fetch', async () => {
    externalCalls += 1;
    throw new Error('Unexpected external request');
  });
  unlockVault('example test passphrase');
  upsertInstance({
    id: 'example-destination', label: 'Example destination', role: 'destination',
    baseUrl: 'https://example-destination.omniapp.co', apiKey: 'fictional-test-key',
    metricFilter: { connectionDatabaseContains: [], connectionDatabaseExact: [], embedExternalIdContains: [], embedExternalIdExact: [] },
    postMigrationActions: [],
  });
  lockVault();
  writeFileSync(historyPath, '{');
  const unlock = await vaultHandler(new Request('http://127.0.0.1/api/vault/unlock', {
    method: 'POST', body: JSON.stringify({ passphrase: 'example test passphrase' }),
  }));
  assert.equal(unlock.status, 200);
  assert.equal((await unlock.json()).code, 'MIGRATION_HISTORY_UNAVAILABLE');
  assert.equal(isVaultUnlocked(), true);
  assert.equal((await vaultHandler(new Request('http://127.0.0.1/api/vault/status'))).status, 200);

  for (const [handler, route, method] of [
    [migrationJobsHandler, '/api/migration-jobs', 'GET'],
    [migrationJobsHandler, '/api/migration-jobs', 'DELETE'],
    [vaultHandler, '/api/vault/reset', 'DELETE'],
  ] as const) {
    const response = await handler(new Request(`http://127.0.0.1${route}`, { method }));
    assert.equal(response.status, 503);
    const payload = await response.json();
    assert.equal(payload.code, 'MIGRATION_HISTORY_UNAVAILABLE');
    assert.equal(JSON.stringify(payload).includes(root), false);
  }
  let preparations = 0;
  assert.throws(() => createDashboardSafeCopyJob({
    profile: 'safe_copy_v1', requestId: '12345678-1234-4234-8234-123456789abc',
    source: { instanceId: 'example-source', connectionId: 'example-source-connection', documentIds: ['example-dashboard'] },
    destinations: [{ targetId: 'example-target', instanceId: 'example-destination', connectionId: 'example-connection', modelId: 'example-model' }],
  }, { prepare: () => { preparations += 1; } }), unavailable);
  await assert.rejects(() => runTrackedSchemaRefresh('example-destination', 'example-model'), unavailable);
  assert.equal(preparations, 0);
  assert.equal(externalCalls, 0);
  assert.ok(getInstance('example-destination'));
  assert.equal(readFileSync(historyPath, 'utf8'), '{');
});

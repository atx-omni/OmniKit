import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { afterEach, beforeEach, test } from 'node:test';
import { apiMiddleware } from '../server/apiMiddleware';
import { closeJobStoreForTests, insertJob } from '../server/services/jobStore';
import { cancelMigrationJob, retryMigrationJob, runMigrationJob } from '../server/services/migrationJobs';
import { lockVault, resetVault, unlockVault } from '../server/services/nativeVault';

const keys = ['OMNIKIT_VAULT_PATH', 'OMNIKIT_JOB_HISTORY_PATH', 'OMNIKIT_JOBS_PATH'] as const;
let prior: Array<string | undefined>, directory: string;
beforeEach(t => {
  directory = mkdtempSync(path.join(tmpdir(), 'omnikit-blobby-routing-'));
  prior = keys.map(key => process.env[key]);
  keys.forEach((key, index) => { process.env[key] = path.join(directory, `state-${index}`); });
  closeJobStoreForTests(); resetVault(); unlockVault('fictional routing test passphrase');
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('These route checks must not contact Omni.'); });
});
afterEach(() => {
  closeJobStoreForTests(); lockVault();
  keys.forEach((key, index) => { if (prior[index] === undefined) delete process.env[key]; else process.env[key] = prior[index]; });
  rmSync(directory, { recursive: true, force: true });
});

async function request(route: string, method = 'POST', body = '{}', origin = 'http://127.0.0.1:5174') {
  const req = Readable.from(method === 'GET' ? [] : [Buffer.from(body)]) as IncomingMessage;
  req.method = method; req.url = '/api/model-migrator/' + route;
  req.headers = { host: '127.0.0.1:5174', origin, 'content-type': 'application/json' };
  const chunks: Buffer[] = [];
  const res = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } }) as unknown as ServerResponse;
  res.statusCode = 200; res.setHeader = (() => res) as ServerResponse['setHeader'];
  const done = once(res, 'finish');
  await apiMiddleware()(req, res); await done;
  return { status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
}

test('Blobby routes preserve production middleware origin, vault, verb, and body boundaries', async () => {
  assert.equal((await request('blobby-repairs/example/start', 'POST', '{}', 'https://unrelated.example')).status, 403);
  lockVault();
  assert.equal((await request('blobby-repairs/example', 'GET')).status, 423);
  unlockVault('fictional routing test passphrase');
  assert.equal((await request('blobby-repairs/example/start', 'GET')).status, 404);
  assert.equal((await request('blobby-repairs/example/publish')).status, 404);
  assert.equal((await request('blobby-repairs/example/start', 'POST', '{')).status, 400);
  assert.equal((await request('blobby-repairs/example/start', 'POST', '{"approve":false}')).status, 400);
  assert.equal((await request('blobby-repairs/example/inspect', 'POST', '{"branchId":"other"}')).status, 400);
  assert.equal((await request('topic-plan/example/blobby-repairs', 'POST', '{"branchId":"other"}')).status, 400);
  assert.equal((await request('blobby-repairs/example', 'GET')).status, 404);
});

test('Blobby jobs cannot be replayed or falsely canceled through generic migration history', async () => {
  insertJob({ id: 'example-blobby-job', workflow: 'model', sourceId: 'example-source', sourceLabel: 'Example source',
    destinationIds: ['example-target'], documentIds: [], emptyFirst: false, replaceSameNamed: false, deleteSourceOnSuccess: false,
    postMigrationActions: [], status: 'running', createdAt: Date.now(), items: [], details: { blobbyRepairId: 'example-repair' } });
  assert.throws(() => cancelMigrationJob('example-blobby-job'), /Stop Blobby/);
  await assert.rejects(runMigrationJob('example-blobby-job'), /cannot run through the migration replay/);
  await assert.rejects(retryMigrationJob('example-blobby-job'), /cannot be replayed/);
});

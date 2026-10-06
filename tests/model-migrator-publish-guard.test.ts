import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test, type TestContext } from 'node:test';

import {
  createModelMigrationJob,
  mergeModelMigrationJob,
  type JobItemKind,
  type MigrationJob,
  type ModelMigrationJobInput,
  type ModelMigrationModelInput,
} from '../server/services/migrationJobs';
import { closeJobStoreForTests, getJob, insertJob, listJobs } from '../server/services/jobStore';
import { lockVault, resetVault, unlockVault, upsertInstance } from '../server/services/nativeVault';
import { OmniClient } from '../server/services/omniClient';

let temporaryRoot: string;
const environmentKeys = ['OMNIKIT_VAULT_PATH', 'OMNIKIT_JOB_HISTORY_PATH', 'OMNIKIT_JOBS_PATH'] as const;
let originalEnvironment: Array<string | undefined>;

beforeEach((t) => {
  originalEnvironment = environmentKeys.map((key) => process.env[key]);
  temporaryRoot = mkdtempSync(path.join(tmpdir(), 'omnikit-model-publish-test-'));
  process.env.OMNIKIT_VAULT_PATH = path.join(temporaryRoot, 'vault.enc');
  process.env.OMNIKIT_JOB_HISTORY_PATH = path.join(temporaryRoot, 'jobs.json');
  process.env.OMNIKIT_JOBS_PATH = path.join(temporaryRoot, 'legacy.json');
  closeJobStoreForTests();
  resetVault();
  unlockVault('fictional model publish test passphrase');
  for (const role of ['source', 'destination'] as const) {
    upsertInstance({
      id: role,
      label: 'Example ' + role,
      role,
      baseUrl: 'https://' + role + '.example.omniapp.co',
      apiKey: 'fictional-test-credential',
      metricFilter: {
        connectionDatabaseContains: [], connectionDatabaseExact: [],
        embedExternalIdContains: [], embedExternalIdExact: [],
      },
      postMigrationActions: [],
    });
  }
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Unexpected network request in isolated publish guard test.');
  });
});

afterEach(() => {
  lockVault();
  closeJobStoreForTests();
  resetVault();
  rmSync(temporaryRoot, { recursive: true, force: true });
  environmentKeys.forEach((key, index) => {
    const value = originalEnvironment[index];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
});

function model(suffix = 'one', patch: Partial<ModelMigrationModelInput> = {}): ModelMigrationModelInput {
  return {
    sourceModelId: 'source-model-' + suffix,
    targetModelId: 'target-model-' + suffix,
    targetConnectionId: 'target-connection',
    mode: 'translate',
    branchName: 'requested-branch-' + suffix,
    acceptedFiles: [{ fileName: 'example.view', yaml: 'dimensions: {}' }],
    ...patch,
  };
}

function completedJob(models = [model()]): MigrationJob {
  const id = randomUUID();
  const input: ModelMigrationJobInput = {
    sourceId: 'source', targetId: 'destination', models, content: [],
    replaceSameNamed: false, postMigrationActions: [],
  };
  return {
    id, workflow: 'model', sourceId: input.sourceId, sourceLabel: 'Example source',
    destinationIds: [input.targetId], documentIds: [], emptyFirst: false,
    replaceSameNamed: false, deleteSourceOnSuccess: false, postMigrationActions: [],
    status: 'succeeded', createdAt: 1, endedAt: 10,
    details: { targetId: input.targetId, retryInput: input },
    items: models.flatMap((entry) => {
      const kinds: JobItemKind[] = entry.mode === 'impact_report'
        ? ['model_impact_report', 'model_validate', 'content_validate']
        : entry.mode === 'fast'
          ? ['model_fast_path', 'model_validate', 'content_validate']
          : ['model_translate', 'model_branch_create', 'model_yaml_write', 'model_validate', 'content_validate'];
      return kinds.map((kind, index) => ({
        id: randomUUID(), jobId: id, destinationId: input.targetId,
        destinationLabel: 'Example destination', targetModelId: entry.targetModelId,
        kind, status: 'succeeded' as const, startedAt: index + 1, endedAt: index + 2,
        details: {
          ...entry,
          branchName: 'staged-' + entry.targetModelId,
          branchId: entry.mode === 'impact_report' ? undefined : 'branch-' + entry.targetModelId,
          ...(entry.mode === 'impact_report' ? { impactOnly: true } : {}),
        },
      }));
    }),
  };
}

function publishSpies(t: TestContext) {
  const find = t.mock.method(OmniClient.prototype, 'findModelBranch', async (modelId: string, name: string) => ({
    id: 'branch-' + modelId, name, raw: {},
  }));
  const merge = t.mock.method(OmniClient.prototype, 'mergeModelBranch', async () => ({}));
  const pr = t.mock.method(OmniClient.prototype, 'createOrUpdateModelBranchPullRequest', async () => ({}));
  return { find, merge, pr };
}

function expectRetiredPublication(error: unknown): boolean {
  assert.ok(error instanceof Error);
  assert.equal((error as Error & { statusCode?: number }).statusCode, 410);
  assert.match(error.message, /Model publication is no longer available/);
  return true;
}

function validation(job: MigrationJob, kind: JobItemKind) {
  const item = job.items.find((entry) => entry.kind === kind);
  assert.ok(item);
  return item;
}

for (const kind of ['model_validate', 'content_validate'] as const) {
  for (const status of ['failed', 'warning', 'skipped', 'pending', 'running', 'missing'] as const) {
    test('branch retirement publication rejects ' + kind + ' that is ' + status + ' before any tenant call', async (t) => {
      const job = completedJob();
      job.status = 'partial';
      if (status === 'missing') job.items = job.items.filter((item) => item.kind !== kind);
      else validation(job, kind).status = status;
      insertJob(job);
      const calls = publishSpies(t);
      await assert.rejects(() => mergeModelMigrationJob(job.id), expectRetiredPublication);
      assert.equal(calls.find.mock.callCount(), 0);
      assert.equal(calls.merge.mock.callCount(), 0);
      assert.equal(calls.pr.mock.callCount(), 0);
      assert.deepEqual(JSON.parse(JSON.stringify(getJob(job.id))), JSON.parse(JSON.stringify(job)));
    });
  }
}

const invalidEvidence: Array<[string, (job: MigrationJob) => void]> = [
  ['a check for a different branch', (job) => { validation(job, 'content_validate').details!.branchId = 'other-branch'; }],
  ['a main-model check without a branch', (job) => { delete validation(job, 'model_validate').details!.branchId; }],
  ['a check for a different destination', (job) => { validation(job, 'content_validate').destinationId = 'other-destination'; }],
  ['a check for a different source', (job) => { validation(job, 'content_validate').details!.sourceModelId = 'other-source'; }],
  ['a check for a different target', (job) => { validation(job, 'content_validate').targetModelId = 'other-target'; }],
  ['duplicate checks', (job) => { job.items.push({ ...validation(job, 'model_validate'), id: randomUUID() }); }],
  ['an error on a nominally successful check', (job) => { validation(job, 'content_validate').error = 'incomplete validation'; }],
  ['failed YAML staging', (job) => { validation(job, 'model_yaml_write').status = 'failed'; }],
  ['missing YAML staging', (job) => { job.items = job.items.filter((item) => item.kind !== 'model_yaml_write'); }],
  ['YAML staged to a different branch', (job) => { validation(job, 'model_yaml_write').details!.branchId = 'other-branch'; }],
  ['a warning instead of successful translation', (job) => { validation(job, 'model_translate').status = 'warning'; }],
  ['missing branch staging', (job) => { job.items = job.items.filter((item) => item.kind !== 'model_branch_create'); }],
  ['a branch without its returned identity', (job) => { delete validation(job, 'model_branch_create').details!.branchId; }],
  ['a missing requested content repair', (job) => {
    const input = job.details!.retryInput as ModelMigrationJobInput;
    input.models[0].contentRepairActions = [{ id: 'repair', kind: 'field', find: 'example.old', replacement: 'example.new', approved: true }];
  }],
  ['a failed content stage', (job) => {
    job.items.push({ ...validation(job, 'content_validate'), id: randomUUID(), kind: 'import', status: 'failed', error: 'copy failed' });
  }],
];
for (const [description, mutate] of invalidEvidence) {
  test('branch retirement publication rejects ' + description, async (t) => {
    const job = completedJob();
    mutate(job);
    insertJob(job);
    const calls = publishSpies(t);
    await assert.rejects(() => mergeModelMigrationJob(job.id), expectRetiredPublication);
    assert.equal(calls.find.mock.callCount(), 0);
    assert.equal(calls.merge.mock.callCount(), 0);
    assert.equal(calls.pr.mock.callCount(), 0);
  });
}

test('branch retirement all staged targets remain read-only even with partial validation', async (t) => {
  const job = completedJob([model('one'), model('two')]);
  job.items = job.items.filter((item) => !(item.targetModelId === 'target-model-two' && item.kind === 'content_validate'));
  insertJob(job);
  const calls = publishSpies(t);
  await assert.rejects(() => mergeModelMigrationJob(job.id), expectRetiredPublication);
  assert.equal(calls.find.mock.callCount(), 0);
  assert.equal(calls.merge.mock.callCount(), 0);
});

test('branch retirement impact reports cannot publish or acquire publication leases', async (t) => {
  const job = completedJob([model('report', { mode: 'impact_report' })]);
  insertJob(job);
  const calls = publishSpies(t);
  await assert.rejects(() => mergeModelMigrationJob(job.id), expectRetiredPublication);
  assert.equal(calls.find.mock.callCount(), 0);
  assert.equal(calls.merge.mock.callCount(), 0);
  assert.equal(calls.pr.mock.callCount(), 0);
  assert.deepEqual(JSON.parse(JSON.stringify(getJob(job.id))), JSON.parse(JSON.stringify(job)));
});

test('branch retirement mixed impact and staged histories cannot publish or acquire new operations', async (t) => {
  const job = completedJob([model(), model('report', { mode: 'impact_report' })]);
  job.status = 'partial';
  for (const item of job.items.filter((entry) => entry.targetModelId === 'target-model-report')) item.status = 'failed';
  insertJob(job);
  const calls = publishSpies(t);
  await assert.rejects(() => mergeModelMigrationJob(job.id), expectRetiredPublication);
  assert.equal(calls.find.mock.callCount(), 0);
  assert.equal(calls.merge.mock.callCount(), 0);
  assert.equal(calls.pr.mock.callCount(), 0);
  assert.deepEqual(JSON.parse(JSON.stringify(getJob(job.id))), JSON.parse(JSON.stringify(job)));
});

for (const mode of ['translate', 'fast'] as const) {
  test('branch retirement fully validated ' + mode + ' history stays read-only', async (t) => {
    const job = completedJob([model('one', { mode })]);
    insertJob(job);
    const calls = publishSpies(t);
    await assert.rejects(() => mergeModelMigrationJob(job.id, { publishDrafts: true, deleteBranch: true }), expectRetiredPublication);
    assert.equal(calls.find.mock.callCount(), 0);
    assert.equal(calls.merge.mock.callCount(), 0);
    assert.equal(calls.pr.mock.callCount(), 0);
    assert.deepEqual(JSON.parse(JSON.stringify(getJob(job.id))), JSON.parse(JSON.stringify(job)));
  });
}

test('branch retirement protected history cannot create a pull request or merge', async (t) => {
  const job = completedJob([model('one', { mergeHandoffRequired: true })]);
  insertJob(job);
  const calls = publishSpies(t);
  await assert.rejects(() => mergeModelMigrationJob(job.id), expectRetiredPublication);
  assert.equal(calls.find.mock.callCount(), 0);
  assert.equal(calls.merge.mock.callCount(), 0);
  assert.equal(calls.pr.mock.callCount(), 0);
});

test('branch retirement never reuses historical branch validation for a replaced live identity', async (t) => {
  for (const mergeHandoffRequired of [false, true]) {
    const job = completedJob([model(mergeHandoffRequired ? 'protected' : 'direct', { mergeHandoffRequired })]);
    insertJob(job);
    const calls = publishSpies(t);
    calls.find.mock.mockImplementation(async (_modelId: string, name: string) => ({ id: 'replacement-branch', name, raw: {} }));
    await assert.rejects(() => mergeModelMigrationJob(job.id), expectRetiredPublication);
    assert.equal(calls.find.mock.callCount(), 0);
    assert.equal(calls.merge.mock.callCount(), 0);
    assert.equal(calls.pr.mock.callCount(), 0);
    t.mock.restoreAll();
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network request.'); });
  }
});

for (const status of ['canceled', 'failed'] as const) {
  test('branch retirement ' + status + ' jobs cannot publish despite historical successful validation', async (t) => {
    const job = completedJob();
    job.status = status;
    insertJob(job);
    const calls = publishSpies(t);
    await assert.rejects(() => mergeModelMigrationJob(job.id), expectRetiredPublication);
    assert.equal(calls.merge.mock.callCount(), 0);
    assert.equal(calls.pr.mock.callCount(), 0);
  });
}

test('branch retirement generic creation cannot use replacement flags to bypass saved approval', async (t) => {
  const validate = t.mock.method(OmniClient.prototype, 'validateModel', async () => []);
  const content = t.mock.method(OmniClient.prototype, 'validateModelContent', async () => ({}));
  for (const value of [undefined, false, true]) {
    const input = completedJob([model('report', { mode: 'impact_report' })]).details!.retryInput as ModelMigrationJobInput;
    input.replaceSameNamed = value as boolean;
    await assert.rejects(() => createModelMigrationJob(input), (error: Error & { statusCode?: number }) => {
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /exact saved additive branch preparation/);
      return true;
    });
  }
  assert.equal(validate.mock.callCount(), 0);
  assert.equal(content.mock.callCount(), 0);
  assert.deepEqual(listJobs(), []);
});

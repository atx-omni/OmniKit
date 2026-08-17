import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import {
  createModelMigrationJob,
  mergeModelMigrationJob,
  runMigrationJob,
  type MigrationJob,
  type ModelMigrationJobInput,
} from '../server/services/migrationJobs';
import {
  dashboardSafeCopyHasUnresolvedDestinationModelOverlap,
} from '../server/services/dashboardSafeCopyJobs';
import {
  closeJobStoreForTests,
  getJob,
  insertJob,
  listJobs,
} from '../server/services/jobStore';
import {
  lockVault,
  resetVault,
  unlockVault,
  upsertInstance,
} from '../server/services/nativeVault';
import { OmniClient } from '../server/services/omniClient';

let temporaryRoot = '';

beforeEach(() => {
  temporaryRoot = mkdtempSync(path.join(tmpdir(), 'omnikit-model-safe-copy-boundary-'));
  process.env.OMNIKIT_VAULT_PATH = path.join(temporaryRoot, 'vault.enc');
  process.env.OMNIKIT_JOB_HISTORY_PATH = path.join(temporaryRoot, 'jobs.json');
  closeJobStoreForTests();
  resetVault();
  unlockVault('model safe-copy boundary passphrase');
});

afterEach(() => {
  resetVault();
  lockVault();
  closeJobStoreForTests();
  rmSync(temporaryRoot, { recursive: true, force: true });
  delete process.env.OMNIKIT_VAULT_PATH;
  delete process.env.OMNIKIT_JOB_HISTORY_PATH;
});

function saveModelInstances() {
  const source = upsertInstance({
    id: 'model-source-instance',
    label: 'Model source',
    role: 'source',
    baseUrl: 'https://model-source.example.omniapp.co',
    apiKey: 'model-source-credential',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
  const target = upsertInstance({
    id: 'model-target-instance',
    label: 'Model target',
    role: 'destination',
    baseUrl: 'https://model-target.example.omniapp.co',
    apiKey: 'model-target-credential',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
  return { source, target };
}

function modelInput(sourceId: string, targetId: string): ModelMigrationJobInput {
  return {
    sourceId,
    targetId,
    models: [{
      sourceModelId: 'source-model',
      targetModelId: 'target-model',
      targetConnectionId: 'target-connection',
      mode: 'impact_report',
      branchName: 'safe-copy-overlap-review',
    }],
    content: [],
    replaceSameNamed: false,
    mergeAfterValidation: false,
    publishDrafts: false,
    deleteBranch: false,
    postMigrationActions: [],
  };
}

function unresolvedSafeCopyJob(targetId: string, targetModelId = 'target-model'): MigrationJob {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    workflow: 'dashboard',
    sourceId: 'safe-copy-source',
    sourceLabel: 'Safe-copy source',
    sourceConnectionId: 'safe-copy-source-connection',
    destinationIds: [targetId],
    targets: [{
      id: 'safe-copy-target',
      destinationInstanceId: targetId,
      destinationLabel: 'Model target',
      targetConnectionId: 'target-connection',
      targetModelId,
    }],
    documentIds: ['source-dashboard'],
    emptyFirst: false,
    replaceSameNamed: false,
    deleteSourceOnSuccess: false,
    postMigrationActions: [],
    status: 'partial',
    createdAt: 1,
    details: {
      safeCopyProfile: 'safe_copy_v1',
      operationMode: 'safe_copy',
      safeCopyRequestId: '22222222-2222-4222-8222-222222222222',
    },
    items: [{
      id: 'safe-copy-uncertain-attempt',
      jobId: '11111111-1111-4111-8111-111111111111',
      targetId: 'safe-copy-target',
      destinationId: targetId,
      destinationLabel: 'Model target',
      targetModelId,
      kind: 'import',
      status: 'warning',
      details: {
        safeCopyAttempt: true,
        safeCopyAttemptState: 'uncertain',
        safeCopyDestinationInstanceId: targetId,
        safeCopyModelId: targetModelId,
      },
    }],
  };
}

function pendingModelJob(input: ModelMigrationJobInput): MigrationJob {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    workflow: 'model',
    sourceId: input.sourceId,
    sourceLabel: 'Model source',
    destinationIds: [input.targetId],
    documentIds: [],
    emptyFirst: false,
    replaceSameNamed: false,
    deleteSourceOnSuccess: false,
    postMigrationActions: [],
    status: 'pending',
    createdAt: 2,
    details: { targetId: input.targetId, retryInput: input },
    items: [{
      id: 'model-impact-step',
      jobId: '33333333-3333-4333-8333-333333333333',
      destinationId: input.targetId,
      destinationLabel: 'Model target',
      targetModelId: 'target-model',
      kind: 'model_impact_report',
      status: 'pending',
    }],
  };
}

function expectScopeConflict(error: unknown): boolean {
  assert.ok(error instanceof Error);
  const bounded = error as Error & { statusCode?: number; code?: string };
  assert.equal(bounded.statusCode, 409);
  assert.equal(bounded.code, 'MODEL_MIGRATOR_SAFE_COPY_SCOPE_CONFLICT');
  assert.match(bounded.message, /requires reconciliation before Model Migrator can write or publish/);
  return true;
}

function expectRoleConflict(usage: 'source' | 'destination') {
  return (error: unknown): boolean => {
    assert.ok(error instanceof Error);
    const bounded = error as Error & { statusCode?: number; code?: string };
    assert.equal(bounded.statusCode, 403);
    assert.equal(bounded.code, usage === 'source'
      ? 'MODEL_MIGRATOR_SOURCE_ROLE_REQUIRED'
      : 'MODEL_MIGRATOR_DESTINATION_ROLE_REQUIRED');
    assert.match(bounded.message, new RegExp(`not authorized for Model Migrator ${usage} operations`));
    return true;
  };
}

function withJobId(job: MigrationJob, id: string): MigrationJob {
  return {
    ...job,
    id,
    items: job.items.map((item) => ({ ...item, jobId: id })),
  };
}

function validatedModelJob(input: ModelMigrationJobInput, id: string): MigrationJob {
  const job = withJobId(pendingModelJob(input), id);
  return {
    ...job,
    status: 'succeeded',
    items: [{
      ...job.items[0],
      id: `${id}-validation`,
      kind: 'model_validate',
      status: 'succeeded',
    }],
  };
}

test('Model Migrator service create, execute, and merge boundaries recheck saved-instance roles before tenant work', async (t) => {
  const { source, target } = saveModelInstances();
  let tenantCalls = 0;
  t.mock.method(OmniClient.prototype, 'getModelYaml', async () => {
    tenantCalls += 1;
    return { files: {}, checksums: {} };
  });
  t.mock.method(OmniClient.prototype, 'findModelBranch', async () => {
    tenantCalls += 1;
    return { id: 'branch-id', name: 'branch-name', raw: {} };
  });

  await assert.rejects(
    () => createModelMigrationJob(modelInput(target.id, target.id)),
    expectRoleConflict('source'),
  );
  await assert.rejects(
    () => createModelMigrationJob(modelInput(source.id, source.id)),
    expectRoleConflict('destination'),
  );

  const runWrongSource = withJobId(
    pendingModelJob(modelInput(target.id, target.id)),
    '44444444-4444-4444-8444-444444444444',
  );
  insertJob(runWrongSource);
  await runMigrationJob(runWrongSource.id);
  assert.equal(getJob(runWrongSource.id)?.status, 'failed');
  assert.match(getJob(runWrongSource.id)?.items[0]?.error || '', /not authorized for Model Migrator source operations/);

  const runWrongTarget = withJobId(
    pendingModelJob(modelInput(source.id, source.id)),
    '55555555-5555-4555-8555-555555555555',
  );
  insertJob(runWrongTarget);
  await runMigrationJob(runWrongTarget.id);
  assert.equal(getJob(runWrongTarget.id)?.status, 'failed');
  assert.match(getJob(runWrongTarget.id)?.items[0]?.error || '', /not authorized for Model Migrator destination operations/);

  const mergeWrongSource = validatedModelJob(
    modelInput(target.id, target.id),
    '66666666-6666-4666-8666-666666666666',
  );
  insertJob(mergeWrongSource);
  await assert.rejects(
    () => mergeModelMigrationJob(mergeWrongSource.id),
    expectRoleConflict('source'),
  );

  const mergeWrongTarget = validatedModelJob(
    modelInput(source.id, source.id),
    '77777777-7777-4777-8777-777777777777',
  );
  insertJob(mergeWrongTarget);
  await assert.rejects(
    () => mergeModelMigrationJob(mergeWrongTarget.id),
    expectRoleConflict('destination'),
  );
  assert.equal(tenantCalls, 0);
});

test('Model Migrator creation rejects only an exact unresolved safe-copy destination-model overlap', async () => {
  const { source, target } = saveModelInstances();
  const safeCopy = unresolvedSafeCopyJob(target.id);
  insertJob(safeCopy);
  assert.equal(dashboardSafeCopyHasUnresolvedDestinationModelOverlap(target.id, ['target-model']), true);
  assert.equal(dashboardSafeCopyHasUnresolvedDestinationModelOverlap(target.id, ['other-model']), false);
  assert.equal(dashboardSafeCopyHasUnresolvedDestinationModelOverlap(source.id, ['target-model']), false);

  await assert.rejects(
    () => createModelMigrationJob(modelInput(source.id, target.id)),
    expectScopeConflict,
  );
  assert.deepEqual(listJobs().map((job) => job.id), [safeCopy.id]);
});

test('Model Migrator execution fails before any tenant operation when safe-copy reconciliation overlaps', async (t) => {
  const { source, target } = saveModelInstances();
  const input = modelInput(source.id, target.id);
  insertJob(unresolvedSafeCopyJob(target.id));
  const modelJob = pendingModelJob(input);
  insertJob(modelJob);
  let tenantCalls = 0;
  t.mock.method(OmniClient.prototype, 'getModelYaml', async () => {
    tenantCalls += 1;
    return { files: {}, checksums: {} };
  });

  await runMigrationJob(modelJob.id);

  const stored = getJob(modelJob.id);
  assert.equal(stored?.status, 'failed');
  assert.match(stored?.items[0]?.error || '', /requires reconciliation before Model Migrator can write or publish/);
  assert.equal(tenantCalls, 0);
});

test('Model Migrator merge rejects an exact unresolved safe-copy overlap before publish work', async (t) => {
  const { source, target } = saveModelInstances();
  const input = modelInput(source.id, target.id);
  insertJob(unresolvedSafeCopyJob(target.id));
  const modelJob = pendingModelJob(input);
  modelJob.status = 'succeeded';
  modelJob.items = [{
    ...modelJob.items[0],
    id: 'model-validation-succeeded',
    kind: 'model_validate',
    status: 'succeeded',
  }];
  insertJob(modelJob);
  let publishCalls = 0;
  t.mock.method(OmniClient.prototype, 'findModelBranch', async () => {
    publishCalls += 1;
    return { id: 'branch-id', name: 'branch-name', raw: {} };
  });

  await assert.rejects(
    () => mergeModelMigrationJob(modelJob.id, { publishDrafts: true, deleteBranch: true }),
    expectScopeConflict,
  );
  assert.equal(publishCalls, 0);
  assert.equal(getJob(modelJob.id)?.status, 'succeeded');
});

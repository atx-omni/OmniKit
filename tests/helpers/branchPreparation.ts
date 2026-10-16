import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { TestContext } from 'node:test';

import { createModelMigrationJob } from '../../server/services/migrationJobs';
import { OmniClient } from '../../server/services/omniClient';
import { createTopicMigrationPlan, stageTopicMigrationPlan } from '../../server/services/topicMigrationPlans';

/** Fictional, additive-only branch fixture using the real server-owned approval path. */
export async function reviewedBranchPreparation(t: TestContext, scope: {
  sourceId: string;
  targetId: string;
  sourceModelId: string;
  targetModelId: string;
}) {
  const sourceConnectionId = 'fixture-source-connection';
  const targetConnectionId = 'fixture-target-connection';
  const sourceFiles = {
    model: '{}\n',
    'example.topic': 'base_view: records\nfields: [records.id]\njoins: {}\n',
    'records.view': 'schema: PUBLIC\ntable_name: records\ndimensions:\n  id:\n    sql: ${TABLE}."ID"\n',
  };
  const targetFiles = { model: '{}\n' };
  const branchFiles: Record<string, string> = { ...targetFiles };
  let branchName: string | undefined;
  const calls = { creates: 0, writes: 0, forbidden: [] as string[] };
  t.mock.method(globalThis, 'fetch', async () => {
    calls.forbidden.push('fetch');
    throw new Error('Unexpected network request in branch preparation fixture.');
  });
  t.mock.method(OmniClient.prototype, 'listConnections', async () => [
    { id: sourceConnectionId, name: 'Example source', dialect: 'snowflake' },
    { id: targetConnectionId, name: 'Example destination', dialect: 'snowflake' },
  ]);
  t.mock.method(OmniClient.prototype, 'listModels', async (options: { connectionId?: string } = {}) => [
    { id: scope.sourceModelId, name: 'Example source model', connectionId: sourceConnectionId },
    { id: scope.targetModelId, name: 'Example destination model', connectionId: targetConnectionId },
  ].filter(model => !options.connectionId || model.connectionId === options.connectionId));
  t.mock.method(OmniClient.prototype, 'listModelSchemas', async () => []);
  t.mock.method(OmniClient.prototype, 'getModelYaml', async (modelId: string, options: { branchId?: string } = {}) => {
    if (options.branchId) assert.equal(options.branchId, 'fixture-prepared-branch');
    const files = options.branchId ? branchFiles : modelId === scope.sourceModelId ? sourceFiles : targetFiles;
    return {
      files: { ...files },
      checksums: Object.fromEntries(Object.entries(files).map(([name, yaml]) => [name, createHash('sha256').update(yaml).digest('hex')])),
      raw: { files: { ...files }, viewNames: Object.fromEntries(Object.keys(files).map(name => [name, name.endsWith('.view') ? name.slice(0, -5) : ''])) },
    };
  });
  t.mock.method(OmniClient.prototype, 'createModelBranch', async (input: { branchName: string }) => {
    calls.creates += 1;
    branchName = input.branchName;
    return { id: 'fixture-prepared-branch', name: branchName, raw: {} };
  });
  t.mock.method(OmniClient.prototype, 'findModelBranch', async (_modelId: string, name: string) => (
    name === branchName ? { id: 'fixture-prepared-branch', name, raw: {} } : null
  ));
  t.mock.method(OmniClient.prototype, 'updateModelYamlFiles', async (input: { branchId?: string; files: Array<{ fileName: string; yaml: string }> }) => {
    assert.equal(input.branchId, 'fixture-prepared-branch');
    calls.writes += 1;
    for (const file of input.files) branchFiles[file.fileName] = file.yaml;
    return {};
  });
  for (const method of ['migrateModel', 'mergeModelBranch', 'createOrUpdateModelBranchPullRequest', 'deleteModelBranch',
    'refreshModel', 'validateModel', 'validateModelContent', 'findAndReplaceModelContent', 'createWorkbookDocument'] as const) {
    t.mock.method(OmniClient.prototype, method, async () => {
      calls.forbidden.push(method);
      throw new Error('Branch preparation must not call ' + method);
    });
  }
  const plan = await createTopicMigrationPlan({
    sourceInstanceId: scope.sourceId, sourceConnectionId, sourceModelId: scope.sourceModelId,
    targetInstanceId: scope.targetId, targetConnectionId, targetModelId: scope.targetModelId,
    topicIds: ['example.topic'], schemaMapText: '',
  });
  assert.equal(plan.status, 'ready', JSON.stringify(plan.issues));
  assert.equal(plan.executionProfile, 'branch_preparation_v1');
  return {
    calls,
    plan,
    targetFiles,
    stage: () => stageTopicMigrationPlan(plan.id, { revision: plan.revision, approve: true }, createModelMigrationJob),
  };
}

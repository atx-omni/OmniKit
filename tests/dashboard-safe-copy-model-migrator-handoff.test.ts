import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  dashboardSafeCopyModelMigratorHandoffMatchesJob,
  createDashboardSafeCopyModelMigratorHandoff,
  parseDashboardSafeCopyModelMigratorHandoff,
  resolveDashboardSafeCopyModelMigratorHandoff,
} from '../src/services/modelMigratorHandoff';
import type { MigrationJob } from '../src/services/opsConsole';

const JOB_ID = '22222222-2222-4222-8222-222222222222';

function handoff() {
  return createDashboardSafeCopyModelMigratorHandoff({
    jobId: JOB_ID,
    targetId: 'target-c',
    sourceInstanceId: 'source-a',
    sourceConnectionId: 'source-connection',
    targetInstanceId: 'destination-c',
    targetConnectionId: 'target-connection',
    targetModelId: 'target-model',
  });
}

function instance(id: string, role: 'source' | 'destination' | 'both') {
  return { id, role };
}

function sourceJob(): MigrationJob {
  return {
    id: JOB_ID,
    workflow: 'dashboard',
    sourceId: 'source-a',
    sourceLabel: 'Source A',
    sourceConnectionId: 'source-connection',
    destinationIds: ['destination-c'],
    targets: [{
      id: 'target-c',
      destinationInstanceId: 'destination-c',
      destinationLabel: 'Destination C',
      targetConnectionId: 'target-connection',
      targetModelId: 'target-model',
    }],
    documentIds: ['dashboard-1'],
    emptyFirst: false,
    replaceSameNamed: false,
    deleteSourceOnSuccess: false,
    postMigrationActions: [],
    status: 'partial',
    createdAt: 1,
    details: {
      safeCopyProfile: 'safe_copy_v1',
      operationMode: 'safe_copy',
    },
    items: [{
      id: 'target-result-c',
      jobId: JOB_ID,
      targetId: 'target-c',
      destinationId: 'destination-c',
      destinationLabel: 'Destination C',
      kind: 'semantic_validate',
      status: 'failed',
      details: {
        safeCopyTargetExecutionSummary: true,
        safeCopyTargetStatus: 'needs_attention',
        safeCopyRecommendedActions: ['open_model_migrator'],
      },
    }],
  };
}

test('safe-copy creates and parses one exact Model Migrator repair scope', () => {
  const value = handoff();
  assert.deepEqual(value, {
    version: 1,
    source: 'dashboard_safe_copy_v1',
    jobId: JOB_ID,
    targetId: 'target-c',
    sourceInstanceId: 'source-a',
    sourceConnectionId: 'source-connection',
    targetInstanceId: 'destination-c',
    targetConnectionId: 'target-connection',
    targetModelId: 'target-model',
  });
  assert.deepEqual(parseDashboardSafeCopyModelMigratorHandoff(value), value);
});

test('malformed, expanded, or whitespace-altered repair route state fails closed', () => {
  const value = handoff();
  for (const invalid of [
    null,
    [],
    { ...value, version: 2 },
    { ...value, source: 'legacy_dashboard_migrator' },
    { ...value, jobId: 'not-a-canonical-job-id' },
    { ...value, targetId: ' target-c' },
    { ...value, targetModelId: '' },
    { ...value, unexpected: 'must-not-be-accepted' },
  ]) {
    assert.equal(parseDashboardSafeCopyModelMigratorHandoff(invalid), null);
  }
});

test('repair route state resolves only for distinct saved instances with eligible roles', () => {
  const value = handoff();
  assert.deepEqual(resolveDashboardSafeCopyModelMigratorHandoff(value, [
    instance('source-a', 'source'),
    instance('destination-c', 'destination'),
  ]), { status: 'ready', handoff: value });

  for (const instances of [
    [instance('source-a', 'source')],
    [instance('source-a', 'destination'), instance('destination-c', 'destination')],
    [instance('source-a', 'source'), instance('destination-c', 'source')],
  ]) {
    const resolution = resolveDashboardSafeCopyModelMigratorHandoff(value, instances);
    assert.equal(resolution.status, 'invalid');
    assert.equal(resolution.handoff, undefined);
  }

  const sameInstance = { ...value, targetInstanceId: value.sourceInstanceId };
  const sameInstanceResolution = resolveDashboardSafeCopyModelMigratorHandoff(sameInstance, [
    instance('source-a', 'both'),
  ]);
  assert.equal(sameInstanceResolution.status, 'invalid');
  assert.equal(sameInstanceResolution.handoff, undefined);
});

test('repair scope must still match the exact safe-copy job and one actionable target', () => {
  const value = handoff();
  const job = sourceJob();
  assert.equal(dashboardSafeCopyModelMigratorHandoffMatchesJob(value, job), true);

  for (const invalidJob of [
    { ...job, id: '33333333-3333-4333-8333-333333333333' },
    { ...job, workflow: 'model' as const },
    { ...job, sourceId: 'source-b' },
    { ...job, sourceConnectionId: 'other-source-connection' },
    { ...job, targets: [{ ...job.targets![0], id: 'other-target' }] },
    { ...job, targets: [{ ...job.targets![0], destinationInstanceId: 'destination-d' }] },
    { ...job, targets: [{ ...job.targets![0], targetConnectionId: 'other-target-connection' }] },
    { ...job, targets: [{ ...job.targets![0], targetModelId: 'other-target-model' }] },
    { ...job, items: [{
      ...job.items[0],
      details: { ...job.items[0].details, safeCopyRecommendedActions: [] },
    }] },
    { ...job, items: [...job.items, {
      ...job.items[0],
      id: 'uncertain-attempt-c',
      kind: 'import' as const,
      status: 'warning' as const,
      details: { safeCopyAttempt: true, safeCopyAttemptState: 'uncertain' },
    }] },
  ]) {
    assert.equal(dashboardSafeCopyModelMigratorHandoffMatchesJob(value, invalidJob), false);
  }
});

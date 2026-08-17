import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { migrationJobsHandler } from '../server/handlers/migration-jobs';
import {
  isDashboardSafeCopyV1Enabled,
  isLegacyDashboardMigratorInternalEnabled,
} from '../server/services/dashboardMigrationFeatureFlags';
import {
  closeJobStoreForTests,
  getJob,
  insertJob,
} from '../server/services/jobStore';
import type { MigrationJob } from '../server/services/migrationJobs';
import { OmniClient } from '../server/services/omniClient';
import {
  lockVault,
  resetVault,
  unlockVault,
  upsertInstance,
} from '../server/services/nativeVault';

let temporaryRoot = '';

function saveInstance(id: string): void {
  upsertInstance({
    id,
    label: `Example ${id}`,
    role: 'both',
    baseUrl: `https://${id}.example.test`,
    apiKey: `${id}-test-credential`,
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
}

function legacyJob(
  id: string,
  options: { status?: MigrationJob['status']; itemStatus?: MigrationJob['items'][number]['status']; workflow?: MigrationJob['workflow'] } = {},
): MigrationJob {
  const status = options.status || 'failed';
  return {
    id,
    ...(options.workflow ? { workflow: options.workflow } : {}),
    sourceId: 'source-instance',
    sourceLabel: 'Source instance',
    sourceConnectionId: 'source-connection',
    destinationIds: ['destination-instance'],
    documentIds: ['dashboard-1'],
    emptyFirst: false,
    replaceSameNamed: false,
    deleteSourceOnSuccess: false,
    postMigrationActions: [],
    status,
    createdAt: Date.now(),
    items: [{
      id: `${id}-item`,
      jobId: id,
      destinationId: 'destination-instance',
      destinationLabel: 'Destination instance',
      targetModelId: 'destination-model',
      kind: 'metadata',
      documentId: 'dashboard-1',
      documentName: 'Example dashboard',
      status: options.itemStatus || (status === 'pending' ? 'pending' : 'failed'),
    }],
  };
}

function post(route: string, body: unknown = {}): Promise<Response> {
  return migrationJobsHandler(new Request(`http://localhost/api/migration-jobs${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

beforeEach(() => {
  temporaryRoot = mkdtempSync(path.join(tmpdir(), 'omnikit-safe-copy-release-'));
  process.env.OMNIKIT_VAULT_PATH = path.join(temporaryRoot, 'vault.enc');
  process.env.OMNIKIT_JOB_HISTORY_PATH = path.join(temporaryRoot, 'jobs.json');
  process.env.OMNIKIT_JOBS_PATH = path.join(temporaryRoot, 'legacy-jobs.json');
  delete process.env.OMNIKIT_SAFE_COPY_V1_INTERNAL;
  delete process.env.OMNIKIT_LEGACY_DASHBOARD_MIGRATOR_INTERNAL;
  closeJobStoreForTests();
  unlockVault('safe-copy release test passphrase');
  saveInstance('source-instance');
  saveInstance('destination-instance');
});

afterEach(() => {
  closeJobStoreForTests();
  resetVault();
  lockVault();
  rmSync(temporaryRoot, { recursive: true, force: true });
  delete process.env.OMNIKIT_VAULT_PATH;
  delete process.env.OMNIKIT_JOB_HISTORY_PATH;
  delete process.env.OMNIKIT_JOBS_PATH;
  delete process.env.OMNIKIT_SAFE_COPY_V1_INTERNAL;
  delete process.env.OMNIKIT_LEGACY_DASHBOARD_MIGRATOR_INTERNAL;
});

test('cutover flags default to safe-copy and require exact explicit rollback values', () => {
  assert.equal(isDashboardSafeCopyV1Enabled({}), true);
  assert.equal(isDashboardSafeCopyV1Enabled({ OMNIKIT_SAFE_COPY_V1_INTERNAL: 'true' }), true);
  assert.equal(isDashboardSafeCopyV1Enabled({ OMNIKIT_SAFE_COPY_V1_INTERNAL: 'false' }), false);
  assert.equal(isDashboardSafeCopyV1Enabled({ OMNIKIT_SAFE_COPY_V1_INTERNAL: 'FALSE' }), true);

  assert.equal(isLegacyDashboardMigratorInternalEnabled({}), false);
  assert.equal(isLegacyDashboardMigratorInternalEnabled({ OMNIKIT_LEGACY_DASHBOARD_MIGRATOR_INTERNAL: 'false' }), false);
  assert.equal(isLegacyDashboardMigratorInternalEnabled({ OMNIKIT_LEGACY_DASHBOARD_MIGRATOR_INTERNAL: 'TRUE' }), false);
  assert.equal(isLegacyDashboardMigratorInternalEnabled({ OMNIKIT_LEGACY_DASHBOARD_MIGRATOR_INTERNAL: 'true' }), true);
});

test('legacy dashboard create, preview, and patch validation are rollback-only', async () => {
  const routes = ['', '/preview', '/validate-patches'];
  for (const route of routes) {
    const disabled = await post(route);
    assert.equal(disabled.status, 404, route || '/');
    assert.deepEqual(await disabled.json(), {
      error: 'Legacy dashboard migration workflow is not enabled.',
    });
  }

  process.env.OMNIKIT_LEGACY_DASHBOARD_MIGRATOR_INTERNAL = 'true';
  const rollbackResponses = await Promise.all(routes.map((route) => post(route)));
  for (const response of rollbackResponses) assert.equal(response.status, 400);
  assert.match((await rollbackResponses[0].json() as { error: string }).error, /Select one source/);
  assert.match((await rollbackResponses[1].json() as { error: string }).error, /Select one source/);
  assert.match((await rollbackResponses[2].json() as { error: string }).error, /Select a source/);
});

test('historical jobs without a workflow discriminator cannot bypass the rollback-only retry gate', async () => {
  const job = legacyJob('historical-dashboard-job');
  insertJob(job);

  const disabled = await post(`/${job.id}/retry`);
  assert.equal(disabled.status, 404);
  assert.deepEqual(await disabled.json(), {
    error: 'Legacy dashboard migration workflow is not enabled.',
  });

  process.env.OMNIKIT_LEGACY_DASHBOARD_MIGRATOR_INTERNAL = 'true';
  const rollback = await post(`/${job.id}/retry`);
  assert.equal(rollback.status, 500);
  assert.match((await rollback.json() as { error: string }).error, /No failed import\/export items to retry/);
});

test('migration POST routes require exact path shapes', async () => {
  process.env.OMNIKIT_SAFE_COPY_V1_INTERNAL = 'false';
  process.env.OMNIKIT_LEGACY_DASHBOARD_MIGRATOR_INTERNAL = 'true';
  const routes = [
    '/safe-copy/extra',
    '/preview/extra',
    '/validate-patches/extra',
    '/historical-dashboard-job/retry/extra',
    '/historical-dashboard-job/targets/B/retry/extra',
    '/actions/run/extra',
  ];
  for (const route of routes) {
    const response = await post(route);
    assert.equal(response.status, 404, route);
    assert.match((await response.json() as { error: string }).error, /Unknown migration jobs route/);
  }
});

test('legacy history, restart recovery, and cancellation remain available after cutover', async () => {
  process.env.OMNIKIT_SAFE_COPY_V1_INTERNAL = 'false';
  const interrupted = legacyJob('legacy-interrupted-job', { status: 'pending', itemStatus: 'pending' });
  insertJob(interrupted);
  closeJobStoreForTests();

  const detail = await migrationJobsHandler(new Request(
    `http://localhost/api/migration-jobs/${interrupted.id}`,
  ));
  assert.equal(detail.status, 200);
  const recovered = (await detail.json() as { job: MigrationJob }).job;
  assert.equal(recovered.status, 'failed');
  assert.equal(recovered.items[0].status, 'failed');
  assert.match(recovered.items[0].error || '', /Interrupted by server restart/);

  const list = await migrationJobsHandler(new Request('http://localhost/api/migration-jobs'));
  assert.equal(list.status, 200);
  assert.ok((await list.json() as { jobs: MigrationJob[] }).jobs.some((job) => job.id === interrupted.id));

  const cancelable = legacyJob('legacy-cancelable-job', { status: 'pending', itemStatus: 'pending' });
  insertJob(cancelable);
  lockVault();
  const canceled = await post(`/${cancelable.id}/cancel`);
  assert.equal(canceled.status, 200);
  assert.equal((await canceled.json() as { job: MigrationJob }).job.status, 'canceled');
});

test('Model Migrator retry remains available when safe-copy is disabled and legacy rollback is off', async () => {
  process.env.OMNIKIT_SAFE_COPY_V1_INTERNAL = 'false';
  const parent: MigrationJob = {
    ...legacyJob('model-parent-job', { workflow: 'model' }),
    workflow: 'model',
    details: {
      retryInput: {
        sourceId: 'source-instance',
        targetId: 'destination-instance',
        models: [{
          sourceModelId: 'source-model',
          targetModelId: 'destination-model',
          targetConnectionId: 'destination-connection',
          mode: 'impact_report',
          branchName: 'safe-copy-release-test',
        }],
        content: [],
        replaceSameNamed: false,
        postMigrationActions: [],
      },
    },
    items: [{
      ...legacyJob('model-parent-item').items[0],
      id: 'model-parent-item',
      jobId: 'model-parent-job',
      kind: 'model_impact_report',
      targetModelId: 'destination-model',
      status: 'failed',
    }],
  };
  insertJob(parent);

  const originalValidateModel = OmniClient.prototype.validateModel;
  const originalValidateModelContent = OmniClient.prototype.validateModelContent;
  try {
    OmniClient.prototype.validateModel = async () => [];
    OmniClient.prototype.validateModelContent = async () => ({ issues: [] });
    const response = await post(`/${parent.id}/retry`);
    assert.equal(response.status, 200);
    const child = (await response.json() as { job: MigrationJob }).job;
    assert.equal(child.workflow, 'model');
    assert.equal(child.parentJobId, parent.id);
    assert.notEqual(child.id, parent.id);

    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (['succeeded', 'partial', 'failed', 'canceled'].includes(getJob(child.id)?.status || '')) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(getJob(child.id)?.status, 'succeeded');
  } finally {
    OmniClient.prototype.validateModel = originalValidateModel;
    OmniClient.prototype.validateModelContent = originalValidateModelContent;
  }
});

test('Instances post-actions remain routed outside both dashboard workflow gates', async () => {
  process.env.OMNIKIT_SAFE_COPY_V1_INTERNAL = 'false';
  const response = await post('/actions/run', { actions: [] });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { results: [] });

  const instancesPage = readFileSync(new URL('../src/pages/InstancesPage.tsx', import.meta.url), 'utf8');
  const opsConsole = readFileSync(new URL('../src/services/opsConsole.ts', import.meta.url), 'utf8');
  assert.match(instancesPage, /runPostMigrationActions\(/);
  assert.match(opsConsole, /\/api\/migration-jobs\/actions\/run/);
});

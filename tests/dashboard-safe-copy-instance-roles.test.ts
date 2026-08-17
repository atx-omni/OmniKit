import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import {
  assertDashboardSafeCopyInstanceRoles,
  createDashboardSafeCopyJob,
} from '../server/services/dashboardSafeCopyJobs';
import { closeJobStoreForTests, listJobs } from '../server/services/jobStore';
import {
  lockVault,
  resetVault,
  unlockVault,
  upsertInstance,
  type InstanceRole,
} from '../server/services/nativeVault';
import {
  DASHBOARD_SAFE_COPY_PROFILE,
  type DashboardSafeCopyIntent,
} from '../shared/dashboardSafeCopyContract';

const SOURCE_ID = 'role-source';
const DESTINATION_ID = 'role-destination';

let temporaryRoot = '';

function safeCopyIntent(requestId: string): DashboardSafeCopyIntent {
  return {
    profile: DASHBOARD_SAFE_COPY_PROFILE,
    requestId,
    source: {
      instanceId: SOURCE_ID,
      connectionId: 'source-connection',
      documentIds: ['source-dashboard'],
    },
    destinations: [{
      targetId: 'B',
      instanceId: DESTINATION_ID,
      connectionId: 'destination-connection',
      modelId: 'destination-model',
    }],
  };
}

function saveInstance(id: string, role: InstanceRole): void {
  upsertInstance({
    id,
    label: id,
    role,
    baseUrl: `https://${id}.example.omniapp.co`,
    apiKey: `${id}-credential`,
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
}

async function flushPreparationQueue(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  temporaryRoot = mkdtempSync(path.join(tmpdir(), 'omnikit-safe-copy-roles-'));
  process.env.OMNIKIT_VAULT_PATH = path.join(temporaryRoot, 'vault.enc');
  process.env.OMNIKIT_JOB_HISTORY_PATH = path.join(temporaryRoot, 'jobs.json');
  process.env.OMNIKIT_JOBS_PATH = path.join(temporaryRoot, 'legacy-jobs.json');
  closeJobStoreForTests();
  unlockVault('safe copy role test passphrase');
});

afterEach(() => {
  closeJobStoreForTests();
  resetVault();
  lockVault();
  rmSync(temporaryRoot, { recursive: true, force: true });
  delete process.env.OMNIKIT_VAULT_PATH;
  delete process.env.OMNIKIT_JOB_HISTORY_PATH;
  delete process.env.OMNIKIT_JOBS_PATH;
});

test('safe-copy creation rejects a source-only destination instance', () => {
  saveInstance(SOURCE_ID, 'both');
  saveInstance(DESTINATION_ID, 'source');

  assert.throws(
    () => createDashboardSafeCopyJob(safeCopyIntent('10000000-0000-4000-8000-000000000001')),
    (error: unknown) => (
      error instanceof Error
      && 'code' in error
      && error.code === 'SAFE_COPY_INVALID_DESTINATION'
    ),
  );
  assert.equal(listJobs().length, 0);
});

test('safe-copy creation rejects a destination-only source instance', () => {
  saveInstance(SOURCE_ID, 'destination');
  saveInstance(DESTINATION_ID, 'both');

  assert.throws(
    () => createDashboardSafeCopyJob(safeCopyIntent('10000000-0000-4000-8000-000000000002')),
    (error: unknown) => (
      error instanceof Error
      && 'code' in error
      && error.code === 'SAFE_COPY_INVALID_SOURCE'
    ),
  );
  assert.equal(listJobs().length, 0);
});

test('safe-copy creation accepts both-role source and destination instances', async () => {
  saveInstance(SOURCE_ID, 'both');
  saveInstance(DESTINATION_ID, 'both');
  const intent = safeCopyIntent('10000000-0000-4000-8000-000000000003');

  assert.doesNotThrow(() => assertDashboardSafeCopyInstanceRoles(intent));
  const created = createDashboardSafeCopyJob(intent, { prepare: () => undefined });
  await flushPreparationQueue();

  assert.equal(created.replayed, false);
  assert.equal(listJobs().length, 1);
});

test('fresh safe-copy role authority rejects destination role drift after preparation', async () => {
  saveInstance(SOURCE_ID, 'both');
  saveInstance(DESTINATION_ID, 'both');
  const intent = safeCopyIntent('10000000-0000-4000-8000-000000000004');
  createDashboardSafeCopyJob(intent, { prepare: () => undefined });
  await flushPreparationQueue();

  upsertInstance({ id: DESTINATION_ID, role: 'source' });

  assert.throws(
    () => assertDashboardSafeCopyInstanceRoles(intent),
    (error: unknown) => (
      error instanceof Error
      && 'code' in error
      && error.code === 'SAFE_COPY_INVALID_DESTINATION'
    ),
  );
  assert.equal(listJobs().length, 1);
});

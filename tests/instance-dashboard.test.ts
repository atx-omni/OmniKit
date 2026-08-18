import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';

import instanceDashboardHandler, { buildEmbedActivity, explicitEmbedEntityName, instanceReadFailure } from '../server/handlers/instance-dashboard';
import { OmniClientError, type OmniEmbedUserRecord } from '../server/services/omniClient';
import { resetVault, unlockVault, upsertInstance } from '../server/services/nativeVault';
import { buildUserHealth } from '../src/services/userHealth';

const testRoot = mkdtempSync(join(tmpdir(), 'omnikit-instance-dashboard-'));
const originalFetch = globalThis.fetch;
process.env.OMNIKIT_VAULT_PATH = join(testRoot, 'vault.enc');

beforeEach(() => {
  globalThis.fetch = originalFetch;
  resetVault();
});

after(() => {
  globalThis.fetch = originalFetch;
  resetVault();
  rmSync(testRoot, { recursive: true, force: true });
  delete process.env.OMNIKIT_VAULT_PATH;
});

function user(
  id: string,
  patch: Partial<OmniEmbedUserRecord> & { filtered?: boolean },
): OmniEmbedUserRecord & { filtered: boolean } {
  return {
    id,
    displayName: id,
    userName: `${id}@example.com`,
    active: true,
    embedExternalId: id,
    embedEntity: '',
    groups: [],
    lastLogin: null,
    createdAt: new Date().toISOString(),
    filtered: false,
    ...patch,
  };
}

test('embed-user activity excludes filtered users and counts login windows', () => {
  const now = Date.now();
  const daysAgo = (days: number) => new Date(now - days * 24 * 60 * 60 * 1000).toISOString();

  const activity = buildEmbedActivity([
    user('active-7d', { lastLogin: daysAgo(2), createdAt: daysAgo(20) }),
    user('active-30d', { lastLogin: daysAgo(20), createdAt: daysAgo(40) }),
    user('active-90d', { lastLogin: daysAgo(70), createdAt: daysAgo(80) }),
    user('never', { lastLogin: null, createdAt: daysAgo(5) }),
    user('filtered', { lastLogin: daysAgo(1), filtered: true }),
  ]);

  assert.equal(activity.active7d, 1);
  assert.equal(activity.active30d, 2);
  assert.equal(activity.active90d, 3);
  assert.equal(activity.neverLoggedIn, 1);
  assert.equal(activity.weeklyLogins.reduce((sum, row) => sum + row.count, 0), 3);
  assert.ok(activity.monthlySignups.reduce((sum, row) => sum + row.count, 0) >= 3);
});

test('embed-user entity attribution uses only explicit source metadata', () => {
  assert.equal(explicitEmbedEntityName(user('coffee', {
    groups: [
      { display: 'All Users', value: 'all' },
      { display: 'ATX - Coffee Shop Demo', value: 'coffee-group' },
    ],
  })), '');

  assert.equal(explicitEmbedEntityName(user('explicit', {
    embedEntity: '  Source Entity 42  ',
    groups: [{ display: 'Beta Co :: Viewers', value: 'beta-group' }],
  })), 'Source Entity 42');
});

test('instance read failures expose structured source states without message inference', () => {
  assert.deepEqual(
    instanceReadFailure(new OmniClientError(
      403,
      'https://private-person@example.omniapp.co/api/scim/v2/embed/users',
      'private-person@example.invalid raw-upstream-marker',
    )),
    {
      error: 'Omni denied this instance read.',
      errorStatus: 'unauthorized',
      errorReasonCode: 'UPSTREAM_PERMISSION_DENIED',
    },
  );
  assert.deepEqual(instanceReadFailure(new Error('403 appeared in an unrelated message')), {
    error: 'The instance read failed.',
    errorStatus: 'failed',
    errorReasonCode: 'INSTANCE_READ_FAILED',
  });
  const serialized = JSON.stringify(instanceReadFailure(new OmniClientError(
    500,
    'https://private-person@example.omniapp.co/api/v1/folders',
    'private-person@example.invalid raw-upstream-marker',
  )));
  assert.equal(serialized.includes('private-person'), false);
  assert.equal(serialized.includes('raw-upstream-marker'), false);
});

test('embed-user handler preserves structured failure evidence through user health', async () => {
  unlockVault('instance-dashboard-contract-passphrase');
  upsertInstance({
    label: 'Restricted example workspace',
    role: 'both',
    baseUrl: 'https://1.1.1.1',
    apiKey: 'omni-instance-dashboard-test-key-not-real',
  });
  globalThis.fetch = async () => new Response(JSON.stringify({ message: 'Access denied' }), {
    status: 403,
    headers: { 'Content-Type': 'application/json' },
  });

  const response = await instanceDashboardHandler(new Request('http://localhost/api/instance-dashboard/embed-users'));
  assert.equal(response.status, 200);
  const body = await response.json() as { instances: import('../src/services/opsConsole').InstanceEmbedUserStats[] };
  assert.equal(body.instances[0]?.errorStatus, 'unauthorized');
  assert.equal(body.instances[0]?.errorReasonCode, 'UPSTREAM_PERMISSION_DENIED');
  assert.deepEqual(body.instances[0]?.users, []);
  assert.equal(body.instances[0]?.activity.neverLoggedIn, 0);

  const health = buildUserHealth(body.instances, new Set(), new Date('2026-08-09T12:00:00.000Z'), {
    asOf: '2026-08-09T12:00:00.000Z',
    provenance: 'live_scan',
  });
  assert.deepEqual(health.entities, []);
  assert.equal(health.coverage.status, 'unavailable');
  assert.equal(health.sourceFailures[0]?.reason, 'unauthorized');
  assert.equal(health.sourceFailures[0]?.reasonCode, 'UPSTREAM_PERMISSION_DENIED');
});

test('selected-instance embed-user route scans only the requested saved instance', async () => {
  unlockVault('instance-dashboard-selected-scope-passphrase');
  const selected = upsertInstance({
    label: 'Selected example workspace',
    role: 'both',
    baseUrl: 'https://1.1.1.1',
    apiKey: 'omni-selected-instance-test-key-not-real',
  });
  const other = upsertInstance({
    label: 'Other example workspace',
    role: 'both',
    baseUrl: 'https://8.8.8.8',
    apiKey: 'omni-other-instance-test-key-not-real',
  });
  const upstreamUrls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    upstreamUrls.push(url);
    if (url.startsWith(other.baseUrl)) throw new Error('The unselected instance must not be scanned.');
    return new Response(JSON.stringify({
      Resources: [],
      totalResults: 0,
      startIndex: 1,
      itemsPerPage: 0,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const response = await instanceDashboardHandler(new Request(
    `http://localhost/api/instance-dashboard/${encodeURIComponent(selected.id)}/embed-users`,
  ));
  assert.equal(response.status, 200);
  const body = await response.json() as { instances: import('../src/services/opsConsole').InstanceEmbedUserStats[] };
  assert.deepEqual(body.instances.map((instance) => instance.instanceId), [selected.id]);
  assert.equal(upstreamUrls.length, 1);
  assert.equal(upstreamUrls[0]?.startsWith(selected.baseUrl), true);
  assert.equal(upstreamUrls.some((url) => url.startsWith(other.baseUrl)), false);

  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    upstreamUrls.push(url);
    if (url.startsWith(other.baseUrl)) throw new Error('The unselected instance must not be scanned.');
    return new Response(JSON.stringify({ message: 'Access denied' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const failed = await instanceDashboardHandler(new Request(
    `http://localhost/api/instance-dashboard/${encodeURIComponent(selected.id)}/embed-users`,
  ));
  assert.equal(failed.status, 200);
  const failedBody = await failed.json() as { instances: import('../src/services/opsConsole').InstanceEmbedUserStats[] };
  assert.equal(failedBody.instances[0]?.instanceId, selected.id);
  assert.equal(failedBody.instances[0]?.errorStatus, 'unauthorized');
  assert.equal(failedBody.instances[0]?.activity.neverLoggedIn, 0);
  assert.equal(upstreamUrls.length, 2);
  assert.equal(upstreamUrls.every((url) => url.startsWith(selected.baseUrl)), true);

  const missing = await instanceDashboardHandler(new Request(
    'http://localhost/api/instance-dashboard/missing-instance/embed-users',
  ));
  assert.equal(missing.status, 404);
  assert.equal(upstreamUrls.length, 2);
});

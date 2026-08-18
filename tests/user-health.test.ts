import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildUserHealth, entityHealthKey, readExpectedInactiveEntityKeys, writeExpectedInactiveEntityKeys } from '../src/services/userHealth';
import {
  loadEmbedUserMetricsForInstance,
  USER_HEALTH_SELECTED_INSTANCE_RESPONSE_INVALID,
  type EmbedUserMetricRecord,
  type InstanceEmbedUserStats,
} from '../src/services/opsConsole';
import { getConnectionCacheKey } from '../src/services/connectionGuards';

const NOW = new Date('2026-06-18T00:00:00.000Z');

function activity() {
  return {
    active7d: 0,
    active30d: 1,
    active90d: 1,
    neverLoggedIn: 1,
    weeklyLogins: [],
    monthlySignups: [],
  };
}

function successfulInstance(users?: EmbedUserMetricRecord[]): InstanceEmbedUserStats {
  const records = users ?? [
    {
      id: 'beta-inactive',
      displayName: 'Beta Inactive',
      userName: 'beta-inactive@example.com',
      active: false,
      embedExternalId: 'beta-inactive',
      entityName: 'Beta Co',
      filtered: false,
      lastLogin: '2026-05-01T00:00:00.000Z',
    },
    {
      id: 'beta-never',
      displayName: 'Beta Never',
      userName: 'beta-never@example.com',
      active: false,
      embedExternalId: 'beta-never',
      entityName: 'Beta Co',
      filtered: false,
      lastLogin: null,
    },
    {
      id: 'filtered-user',
      displayName: 'Filtered',
      userName: 'filtered@example.com',
      active: false,
      embedExternalId: 'filtered',
      entityName: 'Internal',
      filtered: true,
      lastLogin: null,
    },
  ];
  return {
    instanceId: 'prod',
    instanceLabel: 'Production',
    instanceRole: 'both',
    baseUrl: 'https://prod.omniapp.co',
    totalUsers: records.filter((user) => !user.filtered).length,
    activeUsers: records.filter((user) => !user.filtered && user.active).length,
    inactiveUsers: records.filter((user) => !user.filtered && !user.active).length,
    filteredCount: records.filter((user) => user.filtered).length,
    entityCount: new Set(records.filter((user) => !user.filtered && user.entityName).map((user) => user.entityName)).size,
    activity: activity(),
    users: records,
  };
}

function failedInstance(
  message: string,
  id = 'failed',
  errorStatus: InstanceEmbedUserStats['errorStatus'] = 'failed',
): InstanceEmbedUserStats {
  return {
    instanceId: id,
    instanceLabel: `Instance ${id}`,
    instanceRole: 'both',
    baseUrl: `https://${id}.omniapp.co`,
    totalUsers: 0,
    activeUsers: 0,
    inactiveUsers: 0,
    filteredCount: 0,
    entityCount: 0,
    activity: activity(),
    users: [],
    error: message,
    errorStatus,
    errorReasonCode: 'TEST_SOURCE_FAILURE',
  };
}

test('user health creates entity rows only from explicit source entity metadata', () => {
  const result = buildUserHealth([successfulInstance()], new Set(), NOW);

  assert.deepEqual(result.entities.map((row) => row.entityName), ['Beta Co']);
  assert.equal(result.entities[0]?.assignment, 'explicit_source');
  assert.equal(result.entities[0]?.finding, 'no_active_users');
  assert.equal(result.summary.totalEntities, 1);
  assert.equal(result.summary.noActiveUserEntities, 1);
});

test('user health preserves inactive and last-login activity without claiming access', () => {
  const result = buildUserHealth([successfulInstance()], new Set(), NOW);
  const beta = result.entities.find((row) => row.entityName === 'Beta Co');

  assert.ok(beta);
  assert.equal(beta.totalUsers, 2);
  assert.equal(beta.inactiveUsers, 2);
  assert.equal(beta.neverLoggedInUsers, 1);
  assert.equal(result.summary.inactiveUsers, 2);
  assert.equal(result.summary.neverLoggedInUsers, 1);
  assert.deepEqual(result.summary.lastLoginBuckets, {
    last30d: 0,
    last31To90d: 1,
    olderThan90d: 0,
    neverLoggedIn: 1,
  });
});

test('external IDs and identity text cannot heuristically assign an entity', () => {
  const result = buildUserHealth([successfulInstance([{
    id: 'acme-active',
    displayName: 'Acme Co Administrator',
    userName: 'admin@acme-co.example',
    active: true,
    embedExternalId: 'customer-acme-co-portal-user',
    entityName: '',
    filtered: false,
    lastLogin: '2026-06-10T00:00:00.000Z',
  }])], new Set(), NOW);

  assert.equal(result.entities.some((row) => row.entityName === 'Acme Co'), false);
  assert.equal(result.entities[0]?.entityName, 'Unassigned');
  assert.equal(result.entities[0]?.assignment, 'unassigned');
  assert.equal(result.entities[0]?.finding, 'unassigned');
  assert.equal(result.entities[0]?.actionNeeded, true);
  assert.equal(result.summary.unassignedUsers, 1);
});

test('explicit source entity metadata is preserved without connection matching', () => {
  const result = buildUserHealth([successfulInstance([{
    id: 'source-entity-user',
    displayName: 'Example User',
    userName: 'example@example.com',
    active: true,
    embedExternalId: 'unrelated-external-id',
    entityName: '  Source Entity 42  ',
    filtered: false,
    lastLogin: '2026-06-10T00:00:00.000Z',
  }])], new Set(), NOW);

  assert.equal(result.entities[0]?.entityName, 'Source Entity 42');
  assert.equal(result.entities[0]?.assignment, 'explicit_source');
  assert.equal(result.entities[0]?.finding, 'active');
});

test('failed and unauthorized reads never create zero-user or no-active-user findings', () => {
  const result = buildUserHealth(
    [failedInstance('403 Forbidden: organization API key required', 'failed', 'unauthorized')],
    new Set(),
    NOW,
    { asOf: '2026-06-18T01:00:00.000Z', provenance: 'live_scan' },
  );

  assert.deepEqual(result.entities, []);
  assert.deepEqual(result.inactiveUsers, []);
  assert.equal(result.summary.noActiveUserEntities, 0);
  assert.equal(result.coverage.status, 'unavailable');
  assert.equal(result.coverage.reportingInstances, 0);
  assert.equal(result.coverage.unavailableInstances, 1);
  assert.deepEqual(result.sourceFailures, [{
    instanceId: 'failed',
    instanceLabel: 'Instance failed',
    baseUrl: 'https://failed.omniapp.co',
    reason: 'unauthorized',
    reasonCode: 'TEST_SOURCE_FAILURE',
    message: '403 Forbidden: organization API key required',
  }]);
});

test('partial coverage preserves successful totals and exact failed-instance evidence', () => {
  const result = buildUserHealth(
    [successfulInstance(), failedInstance('Endpoint unsupported', 'legacy', 'unsupported')],
    new Set(),
    NOW,
    { asOf: '2026-06-18T01:00:00.000Z', provenance: 'browser_cache' },
  );

  assert.equal(result.coverage.status, 'partial');
  assert.equal(result.coverage.totalInstances, 2);
  assert.equal(result.coverage.reportingInstances, 1);
  assert.equal(result.coverage.unavailableInstances, 1);
  assert.equal(result.coverage.filteredRecords, 1);
  assert.equal(result.summary.totalEntities, 1);
  assert.equal(result.entities[0]?.totalUsers, 2);
  assert.equal(result.sourceFailures[0]?.reason, 'unsupported');
  assert.equal(result.sourceFailures[0]?.reasonCode, 'TEST_SOURCE_FAILURE');
  assert.equal(result.sourceFailures[0]?.message, 'Endpoint unsupported');
  assert.equal(result.coverage.asOf, '2026-06-18T01:00:00.000Z');
  assert.equal(result.coverage.provenance, 'browser_cache');
});

test('expected-inactive markers apply only to explicitly attributed source entities', () => {
  const users = successfulInstance().users.concat({
    id: 'unknown-inactive',
    displayName: 'Unknown',
    userName: 'unknown@example.com',
    active: false,
    embedExternalId: 'unknown',
    entityName: '',
    filtered: false,
    lastLogin: null,
  });
  const expected = new Set([
    entityHealthKey('prod', 'Beta Co'),
    entityHealthKey('prod', 'Unassigned'),
  ]);
  const result = buildUserHealth([successfulInstance(users)], expected, NOW);
  const explicit = result.entities.find((row) => row.assignment === 'explicit_source');
  const unassigned = result.entities.find((row) => row.assignment === 'unassigned');

  assert.equal(explicit?.expectedInactive, true);
  assert.equal(explicit?.actionNeeded, false);
  assert.equal(unassigned?.expectedInactive, false);
  assert.equal(unassigned?.actionNeeded, true);
  assert.equal(result.summary.expectedInactiveEntities, 1);
  assert.equal(result.summary.actionNeededEntities, 1);
});

test('an empty input is not presented as a completed zero-result scan', () => {
  const result = buildUserHealth([], new Set(), NOW);

  assert.equal(result.coverage.status, 'not_scanned');
  assert.equal(result.coverage.provenance, 'unknown');
  assert.equal(result.coverage.asOf, null);
});

test('expected inactive marker storage is stable and tolerant of invalid payloads', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) || null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  const keys = new Set([entityHealthKey('prod', 'Beta Co')]);

  writeExpectedInactiveEntityKeys(keys, storage);
  assert.deepEqual(readExpectedInactiveEntityKeys(storage), keys);

  storage.setItem('omnikit:userHealthExpectedInactive:v1', '{not json');
  assert.deepEqual(readExpectedInactiveEntityKeys(storage), new Set());
});

test('selected-instance user health client rejects mismatched and malformed scope evidence', async () => {
  const production = successfulInstance();
  const productionScope = getConnectionCacheKey({
    instanceId: production.instanceId,
    baseUrl: production.baseUrl,
    apiKey: `__omnikit_vault_instance__:${production.instanceId}`,
  });
  const requestedUrls: string[] = [];
  let responseBody: unknown = { instances: [production] };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (init?.signal?.aborted) throw init.signal.reason;
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    requestedUrls.push(url);
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const result = await loadEmbedUserMetricsForInstance(production.instanceId, productionScope);
    assert.deepEqual(result.instances.map((instance) => instance.instanceId), ['prod']);
    assert.deepEqual(requestedUrls, ['/api/instance-dashboard/prod/embed-users']);

    responseBody = { instances: [{ ...production, baseUrl: 'https://other.omniapp.co' }] };
    await assert.rejects(
      loadEmbedUserMetricsForInstance(production.instanceId, productionScope),
      (error: unknown) => error instanceof Error
        && (error as Error & { code?: string }).code === USER_HEALTH_SELECTED_INSTANCE_RESPONSE_INVALID,
    );

    responseBody = { instances: [{ instanceId: production.instanceId, baseUrl: production.baseUrl }] };
    await assert.rejects(
      loadEmbedUserMetricsForInstance(production.instanceId, productionScope),
      (error: unknown) => error instanceof Error
        && (error as Error & { code?: string }).code === USER_HEALTH_SELECTED_INSTANCE_RESPONSE_INVALID,
    );

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      loadEmbedUserMetricsForInstance(production.instanceId, productionScope, { signal: controller.signal }),
      (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

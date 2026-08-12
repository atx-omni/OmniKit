import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createUnavailablePortfolioOverview,
  parsePortfolioOverview,
} from '../src/services/portfolioOverview';

const ORIGINAL_AS_OF = '2026-08-08T15:00:00.000Z';

function metric(
  value: number | null,
  status: string,
  reasonCode: string | null = null,
  overrides: Record<string, unknown> = {},
) {
  return {
    value,
    status,
    asOf: ORIGINAL_AS_OF,
    coverage: { included: value === null ? 0 : 1, total: 2, unit: 'instances', ratio: value === null ? 0 : 0.5 },
    coverageLabel: '1 of 2 instances',
    exclusions: ['EXCLUDED_TEST_SOURCE'],
    reasonCode,
    reasonLabel: reasonCode ? `Reason: ${reasonCode}` : undefined,
    source: 'derived_instance_aggregate',
    ...overrides,
  };
}

function metricSet(overrides: Record<string, unknown> = {}) {
  return {
    internalMemberships: metric(0, 'available'),
    estimatedUniquePeople: metric(7, 'partial', 'ESTIMATED_FROM_NORMALIZED_EMAIL'),
    embedUsers: metric(0, 'permission_denied', 'UPSTREAM_PERMISSION_DENIED'),
    embedEntities: metric(0, 'failed', 'UPSTREAM_REQUEST_FAILED'),
    active7d: metric(0, 'unsupported', 'LAST_LOGIN_EVIDENCE_UNAVAILABLE'),
    active30d: metric(null, 'unsupported', 'LAST_LOGIN_EVIDENCE_UNAVAILABLE'),
    active90d: metric(null, 'unsupported', 'LAST_LOGIN_EVIDENCE_UNAVAILABLE'),
    staleUsers90d: metric(0, 'available', 'ACTIVE_USER_RECORDS_STALE_90D', {
      coverage: { included: 2, total: 2, unit: 'endpoints', ratio: 1 },
      coverageLabel: '2 of 2 endpoints',
      exclusions: ['ACTIVE_USER_RECORDS_NOT_UNIQUE_PEOPLE', 'INACTIVE_USER_RECORDS'],
      reasonLabel: 'Active source records with a parseable last-login timestamp older than 90 days',
      source: 'derived_identity_activity',
    }),
    neverLoggedInUsers: metric(0, 'unsupported', 'LEGACY_SNAPSHOT_METRIC_UNAVAILABLE', {
      coverage: { included: 0, total: 2, unit: 'endpoints', ratio: 0 },
      coverageLabel: '0 of 2 endpoints',
      exclusions: ['ACTIVE_USER_RECORDS_NOT_UNIQUE_PEOPLE', 'LEGACY_SNAPSHOT_METRIC_UNAVAILABLE'],
      reasonLabel: 'This legacy snapshot predates the source-record lifecycle metric',
      source: 'legacy_snapshot_unknown',
    }),
    dashboards: metric(5, 'stale', 'STALE_WHILE_REVALIDATE'),
    models: metric(3, 'available'),
    topics: metric(2, 'available', 'TOPIC_MODEL_RECORDS'),
    aiChats: metric(null, 'not_configured', 'AI_CONVERSATIONS_ORG_KEY_CONFIRMATION_REQUIRED'),
    apps: metric(null, 'not_configured', 'APP_INVENTORY_LABEL_REQUIRED'),
    ...overrides,
  };
}

test('frontend portfolio contract preserves exact evidence without flattening failed reads to zero', () => {
  const parsed = parsePortfolioOverview({
    schemaVersion: 1,
    generatedAt: ORIGINAL_AS_OF,
    servedAt: '2026-08-09T16:30:00.000Z',
    cache: { state: 'stale', cachedAt: '2026-08-08T15:05:00.000Z' },
    coverage: {
      totalInstances: 2,
      reportingInstances: 1,
      partialInstances: 1,
      staleInstances: 1,
      unavailableInstances: 1,
      savedInstances: 3,
      duplicateSavedOrigins: 1,
    },
    metrics: {
      reportingInstances: metric(1, 'partial', 'PARTIAL_INSTANCE_COVERAGE'),
      ...metricSet(),
    },
    instances: [{
      id: 'instance-a',
      label: 'Instance A',
      health: 'attention',
      statusLabel: 'Refreshing previous snapshot',
      freshness: 'stale',
      asOf: ORIGINAL_AS_OF,
      duplicateSavedOrigin: true,
      duplicateSavedOriginCount: 2,
      duplicateInstanceLabels: ['Instance A', 'Instance A backup'],
      metrics: metricSet(),
      connections: [{
        id: 'connection-a',
        name: 'Connection A',
        instanceId: 'instance-a',
        instanceLabel: 'Instance A',
        readiness: 'attention',
        statusLabel: 'Attribution inferred',
        freshness: 'failed',
        asOf: ORIGINAL_AS_OF,
        attribution: 'inferred',
        dashboards: metric(0, 'failed', 'UPSTREAM_REQUEST_FAILED'),
        models: metric(1, 'partial', 'INFERRED_CONNECTION_ATTRIBUTION'),
        topics: metric(null, 'unsupported', 'UPSTREAM_ENDPOINT_UNSUPPORTED'),
      }],
    }],
    duplicateSavedOrigins: [{
      canonicalInstanceId: 'instance-a',
      instanceLabels: ['Instance A', 'Instance A backup'],
      savedInstanceCount: 2,
    }],
    failures: [{
      id: 'failure-a',
      code: 'INSTANCE_SCAN_FAILED',
      status: 'failed',
      reasonCode: 'UPSTREAM_REQUEST_FAILED',
      reasonLabel: 'Instance scan failed',
      exclusions: ['FAILED_INSTANCE'],
      metric: 'dashboards',
      asOf: ORIGINAL_AS_OF,
      source: 'omni_documents_api',
      coverage: { included: 0, total: 1, unit: 'endpoints', ratio: 0 },
      message: 'One instance could not be read.',
      instanceId: 'instance-b',
      instanceLabel: 'Instance B',
    }],
    partial: true,
    stale: true,
  });

  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.generatedAt, ORIGINAL_AS_OF);
  assert.equal(parsed.servedAt, '2026-08-09T16:30:00.000Z');
  assert.deepEqual(parsed.cache, { state: 'stale', cachedAt: '2026-08-08T15:05:00.000Z' });
  assert.equal(parsed.coverage.savedInstances, 3);
  assert.equal(parsed.coverage.duplicateSavedOrigins, 1);

  assert.equal(parsed.metrics.internalMemberships.value, 0, 'an available zero remains a real zero');
  assert.equal(parsed.metrics.internalMemberships.status, 'available');
  for (const key of ['embedUsers', 'embedEntities', 'active7d', 'neverLoggedInUsers'] as const) {
    assert.equal(parsed.metrics[key].value, null, `${key} cannot expose a failed read as zero`);
    assert.equal(parsed.metrics[key].state, 'unavailable');
  }
  assert.equal(parsed.metrics.embedUsers.status, 'permission_denied');
  assert.equal(parsed.metrics.embedEntities.status, 'failed');
  assert.equal(parsed.metrics.active7d.status, 'unsupported');

  assert.deepEqual(parsed.metrics.staleUsers90d, {
    value: 0,
    status: 'available',
    state: 'partial',
    coverage: { included: 2, total: 2, unit: 'endpoints', ratio: 1 },
    coverageLabel: '2 of 2 endpoints',
    asOf: ORIGINAL_AS_OF,
    exclusions: ['ACTIVE_USER_RECORDS_NOT_UNIQUE_PEOPLE', 'INACTIVE_USER_RECORDS'],
    reasonCode: 'ACTIVE_USER_RECORDS_STALE_90D',
    reasonLabel: 'Active source records with a parseable last-login timestamp older than 90 days',
    source: 'derived_identity_activity',
    detail: 'Active source records with a parseable last-login timestamp older than 90 days',
  }, 'an available stale-user zero preserves the server evidence exactly');
  assert.deepEqual(parsed.metrics.neverLoggedInUsers, {
    value: null,
    status: 'unsupported',
    state: 'unavailable',
    coverage: { included: 0, total: 2, unit: 'endpoints', ratio: 0 },
    coverageLabel: '0 of 2 endpoints',
    asOf: ORIGINAL_AS_OF,
    exclusions: ['ACTIVE_USER_RECORDS_NOT_UNIQUE_PEOPLE', 'LEGACY_SNAPSHOT_METRIC_UNAVAILABLE'],
    reasonCode: 'LEGACY_SNAPSHOT_METRIC_UNAVAILABLE',
    reasonLabel: 'This legacy snapshot predates the source-record lifecycle metric',
    source: 'legacy_snapshot_unknown',
    detail: 'This legacy snapshot predates the source-record lifecycle metric',
  }, 'an unsupported numeric zero is quarantined without dropping its evidence');

  assert.deepEqual(parsed.metrics.estimatedUniquePeople.coverage, {
    included: 1,
    total: 2,
    unit: 'instances',
    ratio: 0.5,
  });
  assert.deepEqual(parsed.metrics.estimatedUniquePeople.exclusions, ['EXCLUDED_TEST_SOURCE']);
  assert.equal(parsed.metrics.estimatedUniquePeople.reasonCode, 'ESTIMATED_FROM_NORMALIZED_EMAIL');
  assert.equal(parsed.metrics.estimatedUniquePeople.reasonLabel, 'Reason: ESTIMATED_FROM_NORMALIZED_EMAIL');
  assert.equal(parsed.metrics.estimatedUniquePeople.source, 'derived_instance_aggregate');

  const instance = parsed.instances[0]!;
  assert.equal(instance.asOf, ORIGINAL_AS_OF, 'retained data keeps its original evidence time');
  assert.equal(instance.freshnessStatus, 'stale');
  assert.equal(instance.duplicateSavedOrigin, true);
  assert.equal(instance.duplicateSavedOriginCount, 2);
  assert.deepEqual(instance.duplicateInstanceLabels, ['Instance A', 'Instance A backup']);

  const connection = instance.connections[0]!;
  assert.equal(connection.attribution, 'inferred');
  assert.equal(connection.freshnessStatus, 'failed');
  assert.equal(connection.freshness, 'unavailable');
  assert.equal(connection.asOf, ORIGINAL_AS_OF);
  assert.equal(connection.dashboards.value, null);
  assert.equal(connection.dashboards.status, 'failed');

  assert.deepEqual(parsed.duplicateSavedOrigins, [{
    canonicalInstanceId: 'instance-a',
    instanceLabels: ['Instance A', 'Instance A backup'],
    savedInstanceCount: 2,
  }]);
  assert.deepEqual(parsed.failures[0], {
    id: 'failure-a',
    message: 'One instance could not be read.',
    code: 'INSTANCE_SCAN_FAILED',
    metric: 'dashboards',
    status: 'failed',
    reasonCode: 'UPSTREAM_REQUEST_FAILED',
    reasonLabel: 'Instance scan failed',
    exclusions: ['FAILED_INSTANCE'],
    asOf: ORIGINAL_AS_OF,
    source: 'omni_documents_api',
    coverage: { included: 0, total: 1, unit: 'endpoints', ratio: 0 },
    instanceId: 'instance-b',
    instanceLabel: 'Instance B',
  });
});

test('frontend portfolio contract aggregates only canonical instance lifecycle metrics', () => {
  const parsed = parsePortfolioOverview({
    coverage: {
      totalInstances: 2,
      reportingInstances: 2,
      partialInstances: 0,
      staleInstances: 0,
      unavailableInstances: 0,
    },
    metrics: {
      reportingInstances: metric(2, 'available', null, {
        coverage: { included: 2, total: 2, unit: 'instances', ratio: 1 },
      }),
    },
    stale90d: metric(500, 'available'),
    neverLoggedIn: metric(500, 'available'),
    totals: {
      inactiveUsers90d: metric(500, 'available'),
      usersNeverLoggedIn: metric(500, 'available'),
    },
    instances: [
      {
        id: 'instance-a',
        label: 'Instance A',
        metrics: {
          staleUsers90d: metric(0, 'available'),
          neverLoggedInUsers: metric(1, 'available'),
          activity: {
            staleUsers90d: metric(500, 'available'),
            neverLoggedInUsers: metric(500, 'available'),
          },
        },
        activity: {
          staleUsers90d: metric(500, 'available'),
          neverLoggedInUsers: metric(500, 'available'),
        },
      },
      {
        id: 'instance-b',
        label: 'Instance B',
        metrics: {
          staleUsers90d: metric(2, 'available'),
          neverLoggedInUsers: metric(0, 'available'),
        },
        userMetrics: {
          inactiveUsers90d: metric(500, 'available'),
          usersNeverLoggedIn: metric(500, 'available'),
        },
      },
    ],
  });

  assert.equal(parsed.instances[0]?.metrics.staleUsers90d.value, 0);
  assert.equal(parsed.instances[0]?.metrics.neverLoggedInUsers.value, 1);
  assert.equal(parsed.instances[1]?.metrics.staleUsers90d.value, 2);
  assert.equal(parsed.instances[1]?.metrics.neverLoggedInUsers.value, 0);
  assert.deepEqual(parsed.metrics.staleUsers90d, {
    value: 2,
    status: 'available',
    state: 'available',
    coverageLabel: undefined,
    asOf: ORIGINAL_AS_OF,
  });
  assert.deepEqual(parsed.metrics.neverLoggedInUsers, {
    value: 1,
    status: 'available',
    state: 'available',
    coverageLabel: undefined,
    asOf: ORIGINAL_AS_OF,
  });
});

test('ambiguous legacy and empty browser payloads keep lifecycle metrics unavailable instead of guessing', () => {
  const parsed = parsePortfolioOverview({
    coverage: {
      totalInstances: 1,
      reportingInstances: 1,
      partialInstances: 0,
      staleInstances: 0,
      unavailableInstances: 0,
    },
    staleUsers90d: metric(90, 'available'),
    neverLoggedInUsers: metric(91, 'available'),
    metrics: {
      reportingInstances: metric(1, 'available', null, {
        coverage: { included: 1, total: 1, unit: 'instances', ratio: 1 },
      }),
      active90d: 0,
      stale90d: metric(92, 'available'),
      inactiveUsers90d: metric(93, 'available'),
      usersNeverLoggedIn: metric(94, 'available'),
      activity: {
        staleUsers90d: metric(95, 'available'),
        neverLoggedInUsers: metric(96, 'available'),
      },
    },
    totals: {
      staleUsers90d: metric(97, 'available'),
      neverLoggedInUsers: metric(98, 'available'),
    },
    instances: [{
      id: 'legacy-instance',
      label: 'Legacy instance',
      staleUsers90d: metric(99, 'available'),
      neverLoggedInUsers: metric(100, 'available'),
      metrics: {
        active90d: 0,
        stale90d: metric(101, 'available'),
        activity: {
          staleUsers90d: metric(102, 'available'),
          neverLoggedInUsers: metric(103, 'available'),
        },
      },
      userMetrics: {
        staleUsers90d: metric(104, 'available'),
        usersNeverLoggedIn: metric(105, 'available'),
      },
      activity: {
        staleUsers90d: metric(106, 'available'),
        neverLoggedInUsers: metric(107, 'available'),
      },
    }],
  });
  const unavailable = { value: null, state: 'unavailable' };

  assert.deepEqual(parsed.metrics.staleUsers90d, unavailable);
  assert.deepEqual(parsed.metrics.neverLoggedInUsers, unavailable);
  assert.deepEqual(parsed.instances[0]?.metrics.staleUsers90d, unavailable);
  assert.deepEqual(parsed.instances[0]?.metrics.neverLoggedInUsers, unavailable);

  const empty = createUnavailablePortfolioOverview();
  assert.deepEqual(empty.metrics.staleUsers90d, unavailable);
  assert.deepEqual(empty.metrics.neverLoggedInUsers, unavailable);
});

test('portfolio contract rejects impossible coverage and malformed reporting counts', () => {
  const invalidPayloads = [
    {},
    {
      coverage: {
        totalInstances: 0,
        reportingInstances: 0,
        partialInstances: 0,
        staleInstances: 0,
        unavailableInstances: 0,
      },
      metrics: {},
    },
    { coverage: { totalInstances: 1, reportingInstances: 2 } },
    { coverage: { totalInstances: 2, reportingInstances: 1, partialInstances: 2 } },
    { coverage: { totalInstances: 2, reportingInstances: 1, unavailableInstances: 2 } },
    { coverage: { totalInstances: 1, reportingInstances: 'malformed' } },
    { coverage: { totalInstances: -1, reportingInstances: 0 } },
    {
      coverage: { totalInstances: 1, reportingInstances: 1 },
      metrics: {
        reportingInstances: metric(0, 'available', null, {
          coverage: { included: 0, total: 1, unit: 'instances', ratio: 0 },
        }),
      },
    },
    {
      coverage: { totalInstances: 1, reportingInstances: 1 },
      metrics: {
        reportingInstances: metric(1, 'available', null, {
          coverage: { included: 2, total: 1, unit: 'instances', ratio: 2 },
        }),
      },
    },
    {
      coverage: { totalInstances: 1, reportingInstances: 1 },
      metrics: {
        reportingInstances: metric(1, 'available', null, {
          coverage: { included: 1, total: 1, unit: 'instances', ratio: 0 },
        }),
      },
    },
  ];

  for (const payload of invalidPayloads) {
    assert.throws(() => parsePortfolioOverview(payload), /Invalid portfolio overview response/);
  }
});

test('portfolio contract preserves an exact available zero with reconciled zero coverage', () => {
  const parsed = parsePortfolioOverview({
    coverage: {
      totalInstances: 0,
      reportingInstances: 0,
      partialInstances: 0,
      staleInstances: 0,
      unavailableInstances: 0,
    },
    metrics: {
      reportingInstances: metric(0, 'available', null, {
        coverage: { included: 0, total: 0, unit: 'instances', ratio: null },
        coverageLabel: undefined,
      }),
    },
  });

  assert.deepEqual(parsed.coverage, {
    totalInstances: 0,
    reportingInstances: 0,
    partialInstances: 0,
    staleInstances: 0,
    unavailableInstances: 0,
  });
  assert.equal(parsed.metrics.reportingInstances.value, 0);
  assert.equal(parsed.metrics.reportingInstances.status, 'available');
  assert.equal(parsed.metrics.reportingInstances.state, 'available');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DashboardSafeCopyError,
  dashboardSafeCopyCanonicalJson,
  parseDashboardSafeCopyIntent,
} from '../shared/dashboardSafeCopyContract';
import { dashboardSafeCopyIntentHash } from '../server/services/dashboardSafeCopyJobs';

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';

function intent() {
  return {
    profile: 'safe_copy_v1',
    requestId: REQUEST_ID,
    source: {
      instanceId: 'source-instance',
      connectionId: 'source-connection',
      documentIds: ['dashboard-b', 'dashboard-a', 'dashboard-a'],
    },
    destinations: [
      {
        targetId: 'target-b',
        instanceId: 'destination-b',
        connectionId: 'connection-b',
        modelId: 'model-b',
      },
      {
        targetId: 'target-a',
        instanceId: 'destination-a',
        connectionId: 'connection-a',
        modelId: 'model-a',
        folderPath: 'Shared/Migrated',
      },
    ],
  };
}

function expectCode(run: () => unknown, code: DashboardSafeCopyError['code']): void {
  assert.throws(run, (error) => error instanceof DashboardSafeCopyError && error.code === code);
}

test('safe-copy contract canonicalizes A to B,C,D without carrying workflow decisions', () => {
  const parsed = parseDashboardSafeCopyIntent(intent());
  assert.deepEqual(parsed.source.documentIds, ['dashboard-a', 'dashboard-b']);
  assert.deepEqual(parsed.destinations.map((destination) => destination.targetId), ['target-a', 'target-b']);
  assert.deepEqual(Object.keys(parsed), ['profile', 'requestId', 'source', 'destinations']);
  assert.equal('emptyFirst' in parsed, false);
  assert.equal('fieldMappings' in parsed, false);
  assert.equal('postMigrationActions' in parsed, false);
});

test('canonical JSON and intent hashes are stable across harmless ordering and exact duplicates', () => {
  const first = parseDashboardSafeCopyIntent(intent());
  const reordered = intent();
  reordered.source.documentIds = ['dashboard-a', 'dashboard-b'];
  reordered.destinations = [
    reordered.destinations[1],
    reordered.destinations[0],
    { ...reordered.destinations[1] },
  ];
  const second = parseDashboardSafeCopyIntent(reordered);
  assert.equal(dashboardSafeCopyCanonicalJson(first), dashboardSafeCopyCanonicalJson(second));
  assert.equal(dashboardSafeCopyIntentHash(first), dashboardSafeCopyIntentHash(second));
  assert.equal(second.destinations.length, 2);
});

test('safe-copy contract rejects conflicting duplicate target identities', () => {
  const input = intent();
  input.destinations.push({
    ...input.destinations[0],
    modelId: 'different-model',
  });
  expectCode(() => parseDashboardSafeCopyIntent(input), 'SAFE_COPY_DUPLICATE_TARGET');
});

test('safe-copy contract rejects two folders on the same destination instance and model', () => {
  const input = intent();
  input.destinations = [
    {
      targetId: 'same-model-folder-a',
      instanceId: 'destination-a',
      connectionId: 'connection-a',
      modelId: 'model-a',
      folderPath: 'Shared/Folder A',
    },
    {
      targetId: 'same-model-folder-b',
      instanceId: 'destination-a',
      connectionId: 'connection-a',
      modelId: 'model-a',
      folderPath: 'Shared/Folder B',
    },
  ];
  expectCode(() => parseDashboardSafeCopyIntent(input), 'SAFE_COPY_DUPLICATE_TARGET');
});

test('safe-copy contract rejects malformed roots, missing scope, and noncanonical request IDs', () => {
  for (const value of [null, [], 'request', 42]) {
    expectCode(() => parseDashboardSafeCopyIntent(value), 'SAFE_COPY_INVALID_BODY');
  }
  expectCode(
    () => parseDashboardSafeCopyIntent({ ...intent(), requestId: 'retry-me' }),
    'SAFE_COPY_INVALID_REQUEST_ID',
  );
  expectCode(
    () => parseDashboardSafeCopyIntent({ ...intent(), source: { ...intent().source, documentIds: [] } }),
    'SAFE_COPY_INVALID_SOURCE',
  );
  expectCode(
    () => parseDashboardSafeCopyIntent({ ...intent(), destinations: [] }),
    'SAFE_COPY_INVALID_DESTINATION',
  );
});

test('safe-copy contract rejects unknown and legacy decision fields at every boundary', () => {
  const legacyRootFields = [
    'emptyFirst',
    'replaceSameNamed',
    'deleteSourceOnSuccess',
    'postMigrationActions',
    'routeGroups',
    'targets',
    'fieldMappings',
    'queryViewMappings',
    'topicMappings',
    'permissionDecisions',
    'semanticPatches',
    'queryValidationWaivers',
  ];
  for (const field of legacyRootFields) {
    expectCode(() => parseDashboardSafeCopyIntent({ ...intent(), [field]: [] }), 'SAFE_COPY_UNKNOWN_FIELD');
  }

  expectCode(() => parseDashboardSafeCopyIntent({
    ...intent(),
    source: { ...intent().source, apiKey: 'must-not-pass' },
  }), 'SAFE_COPY_UNKNOWN_FIELD');
  expectCode(() => parseDashboardSafeCopyIntent({
    ...intent(),
    destinations: [{ ...intent().destinations[0], semanticPatches: [] }],
  }), 'SAFE_COPY_UNKNOWN_FIELD');
});

test('safe-copy contract bounds identifiers and rejects control-character injection', () => {
  expectCode(() => parseDashboardSafeCopyIntent({
    ...intent(),
    source: { ...intent().source, instanceId: `source\nsecret` },
  }), 'SAFE_COPY_INVALID_SOURCE');
  expectCode(() => parseDashboardSafeCopyIntent({
    ...intent(),
    destinations: [{ ...intent().destinations[0], folderPath: `Shared\nInjected` }],
  }), 'SAFE_COPY_INVALID_DESTINATION');
  expectCode(() => parseDashboardSafeCopyIntent({
    ...intent(),
    destinations: [{ ...intent().destinations[0], modelId: 'x'.repeat(257) }],
  }), 'SAFE_COPY_LIMIT_EXCEEDED');
});

test('safe-copy contract accepts 1,000 copy cells and rejects the exact 1,001-cell boundary', () => {
  const matrixIntent = (documentCount: number, destinationCount: number) => ({
    profile: 'safe_copy_v1',
    requestId: REQUEST_ID,
    source: {
      instanceId: 'source-instance',
      connectionId: 'source-connection',
      documentIds: Array.from({ length: documentCount }, (_, index) => `dashboard-${index + 1}`),
    },
    destinations: Array.from({ length: destinationCount }, (_, index) => ({
      targetId: `target-${index + 1}`,
      instanceId: `destination-${index + 1}`,
      connectionId: `connection-${index + 1}`,
      modelId: `model-${index + 1}`,
    })),
  });

  assert.equal(parseDashboardSafeCopyIntent(matrixIntent(500, 2)).source.documentIds.length, 500);
  expectCode(() => parseDashboardSafeCopyIntent(matrixIntent(143, 7)), 'SAFE_COPY_LIMIT_EXCEEDED');
});

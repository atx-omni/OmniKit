import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  buildDashboardSearchResults,
  dashboardConnectionLabel,
  dashboardOptionIdentity,
  dashboardOptionLabel,
} from '../src/components/deckBuilder/dashboardSearchModel';
import { DashboardSearch } from '../src/components/deckBuilder/DashboardSearch';
import { dashboardCache, type CachedDashboard } from '../src/services/deckBuilder/localCache';

const dashboards: CachedDashboard[] = [
  {
    id: 'dashboard-a',
    name: 'Executive overview',
    folderPath: 'Finance / Leadership',
    connectionId: 'a1b2c3d4-1111-2222-3333-444455556666',
    connectionName: 'Finance warehouse',
  },
  {
    id: 'dashboard-b',
    name: 'Executive overview',
    folderPath: 'Operations / Leadership',
    connectionId: 'b1c2d3e4-1111-2222-3333-444455556666',
  },
  {
    id: 'dashboard-c',
    name: 'Pipeline detail',
    folderPath: 'Sales',
    connectionId: 'a1b2c3d4-1111-2222-3333-444455556666',
    connectionName: 'Finance warehouse',
  },
];

test('dashboard search groups by immutable connection and uses deterministic unknown labels', () => {
  const result = buildDashboardSearchResults(dashboards, '', undefined, 100);

  assert.equal(result.groups.length, 2);
  assert.deepEqual(result.groups.map((group) => group.key), [
    'b1c2d3e4-1111-2222-3333-444455556666',
    'a1b2c3d4-1111-2222-3333-444455556666',
  ]);
  assert.equal(result.groups[0].label, 'Connection b1c2d3e4');
  assert.equal(result.groups[1].label, 'Finance warehouse');
  assert.equal(result.groups[1].matchCount, 2);
  assert.equal(dashboardConnectionLabel(dashboards[1]), 'Connection b1c2d3e4');
});

test('dashboard search matches dashboard, folder, connection name, and connection id', () => {
  assert.deepEqual(
    buildDashboardSearchResults(dashboards, 'operations', undefined).visibleDashboards.map((item) => item.id),
    ['dashboard-b'],
  );
  assert.deepEqual(
    buildDashboardSearchResults(dashboards, 'finance warehouse', undefined).visibleDashboards.map((item) => item.id),
    ['dashboard-a', 'dashboard-c'],
  );
  assert.deepEqual(
    buildDashboardSearchResults(dashboards, 'b1c2d3e4', undefined).visibleDashboards.map((item) => item.id),
    ['dashboard-b'],
  );
});

test('bounded results retain an existing selection and expose more matches progressively', () => {
  const largeInventory: CachedDashboard[] = Array.from({ length: 105 }, (_, index) => ({
    id: `dashboard-${String(index).padStart(3, '0')}`,
    name: `Dashboard ${String(index).padStart(3, '0')}`,
    connectionId: 'connection-large',
  }));
  const result = buildDashboardSearchResults(
    largeInventory,
    '',
    'dashboard-104',
    100,
  );

  assert.equal(result.totalMatches, 105);
  assert.equal(result.visibleMatchCount, 101);
  assert.equal(result.visibleDashboards.length, 101);
  assert.equal(result.visibleDashboards.some((item) => item.id === 'dashboard-104'), true);
  assert.equal(result.hasMore, true);
});

test('duplicate dashboard names have folder and connection identity in their accessible label', () => {
  const first = dashboardOptionLabel(dashboards[0]);
  const second = dashboardOptionLabel(dashboards[1]);
  assert.notEqual(first, second);
  assert.match(first, /Finance \/ Leadership/);
  assert.match(first, /a1b2c3d4-1111-2222-3333-444455556666/);
  assert.match(second, /Operations \/ Leadership/);
  assert.match(second, /b1c2d3e4-1111-2222-3333-444455556666/);

  const markup = renderToStaticMarkup(
    createElement(DashboardSearch, {
      dashboards,
      loading: false,
      lastSyncedAt: null,
      onRefresh: () => undefined,
      onPick: () => undefined,
      showInlineResults: true,
    }),
  );
  assert.match(markup, /Finance warehouse/);
  assert.match(markup, /Connection b1c2d3e4/);
  assert.doesNotMatch(markup, />a1b2c3d4<\/span>/);
  assert.match(markup, /role="group" aria-label="Finance warehouse dashboards, connection ID a1b2c3d4-1111-2222-3333-444455556666"/);
  assert.match(markup, /aria-label="Select dashboard Executive overview in Finance \/ Leadership on Finance warehouse, connection ID a1b2c3d4-1111-2222-3333-444455556666"/);
});

test('a connection-qualified selection marks exactly one row when dashboard ids collide', () => {
  const collidingDashboards: CachedDashboard[] = [
    { ...dashboards[0], id: 'shared-dashboard-id' },
    { ...dashboards[1], id: 'shared-dashboard-id' },
    { ...dashboards[1], id: 'shared-dashboard-id' },
  ];
  const selectedConnectionId = collidingDashboards[1].connectionId;
  const result = buildDashboardSearchResults(
    collidingDashboards,
    '',
    'shared-dashboard-id',
    100,
    selectedConnectionId,
  );

  assert.equal(result.visibleDashboards.length, 2, 'exact duplicate records should collapse to one option');
  assert.equal(result.selectedOptionIdentity, dashboardOptionIdentity(collidingDashboards[1]));

  const markup = renderToStaticMarkup(
    createElement(DashboardSearch, {
      dashboards: collidingDashboards,
      loading: false,
      lastSyncedAt: null,
      onRefresh: () => undefined,
      onPick: () => undefined,
      selectedDashboardId: 'shared-dashboard-id',
      selectedDashboardConnectionId: selectedConnectionId,
      showInlineResults: true,
    }),
  );

  assert.equal(markup.match(/aria-pressed="true"/g)?.length, 1);
  assert.equal(markup.match(/data-dashboard-selected="true"/g)?.length, 1);
  assert.equal(markup.match(/data-dashboard-selected="false"/g)?.length, 1);
  assert.equal(markup.match(/>Selected</g)?.length, 1);
});

test('dashboard inventory cache refreshes the connection-aware segment without bumping other deck caches', () => {
  class MemoryStorage {
    private readonly values = new Map<string, string>();

    get length() { return this.values.size; }
    clear() { this.values.clear(); }
    getItem(key: string) { return this.values.get(key) ?? null; }
    key(index: number) { return Array.from(this.values.keys())[index] ?? null; }
    removeItem(key: string) { this.values.delete(key); }
    setItem(key: string, value: string) { this.values.set(key, value); }
  }

  const localStorage = new MemoryStorage();
  const baseUrl = 'https://tenant.example';
  const legacyDashboardKey = 'omnikit:deck:tenant.example:dashboards';
  const currentDashboardKey = 'omnikit:deck:tenant.example:dashboards-v2';
  const unrelatedKey = 'omnikit:deck:tenant.example:batchHistory';
  localStorage.setItem(legacyDashboardKey, JSON.stringify({ data: dashboards, savedAt: 1, version: 1 }));
  localStorage.setItem(unrelatedKey, JSON.stringify({ data: [], savedAt: 1, version: 1 }));
  (globalThis as typeof globalThis & { window: { localStorage: MemoryStorage } }).window = { localStorage };

  try {
    assert.equal(dashboardCache.load(baseUrl), null);
    dashboardCache.save(baseUrl, dashboards);
    assert.ok(localStorage.getItem(currentDashboardKey));
    assert.ok(localStorage.getItem(unrelatedKey));
    dashboardCache.clear(baseUrl);
    assert.equal(localStorage.getItem(currentDashboardKey), null);
    assert.ok(localStorage.getItem(unrelatedKey));
  } finally {
    delete (globalThis as typeof globalThis & { window?: unknown }).window;
  }
});

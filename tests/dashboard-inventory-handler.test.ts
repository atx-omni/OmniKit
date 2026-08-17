import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';

import instancesHandler from '../server/handlers/instances';
import {
  OmniClient,
  OmniPaginationError,
  type OmniDocumentInventoryResult,
  type OmniDocumentRecord,
} from '../server/services/omniClient';
import {
  lockVault,
  resetVault,
  unlockVault,
  upsertInstance,
} from '../server/services/nativeVault';
import { clearReadThroughCache } from '../server/services/readThroughCache';

let tempDir = '';

function saveSource(apiKey = 'source-key') {
  upsertInstance({
    id: 'source-1',
    label: 'Source',
    role: 'source',
    baseUrl: 'https://source.example.omniapp.co',
    apiKey,
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
}

function completeInventory(documents: OmniDocumentRecord[]): OmniDocumentInventoryResult {
  return {
    documents,
    pagination: {
      complete: true,
      pages: 1,
      pageSize: 100,
      returnedRecords: documents.length,
      reportedTotalRecords: documents.length,
      responseBytes: 512,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  clearReadThroughCache();
  tempDir = mkdtempSync(path.join(tmpdir(), 'omnikit-dashboard-inventory-'));
  process.env.OMNIKIT_VAULT_PATH = path.join(tempDir, 'vault.enc');
  unlockVault('inventory passphrase');
  saveSource();
});

afterEach(() => {
  clearReadThroughCache();
  mock.restoreAll();
  resetVault();
  lockVault();
  rmSync(tempDir, { recursive: true, force: true });
});

test('dashboard inventory is shared across connections and filters ownership and dashboard evidence fail closed', async () => {
  let calls = 0;
  const requestedOptions: unknown[] = [];
  mock.method(OmniClient.prototype, 'listDocumentInventory', async (options?: unknown) => {
    calls += 1;
    requestedOptions.push(options);
    return completeInventory([
      { id: 'a-dashboard', identifier: 'a-dashboard', name: 'A', connectionId: 'connection-a', hasDashboard: true },
      { id: 'b-dashboard', identifier: 'b-dashboard', name: 'B', connectionId: 'connection-b', hasDashboard: true },
      { id: 'unknown-owner', identifier: 'unknown-owner', name: 'Unknown', hasDashboard: true },
      { id: 'not-dashboard', identifier: 'not-dashboard', name: 'Workbook', connectionId: 'connection-a', hasDashboard: false },
    ]);
  });

  const first = await instancesHandler(new Request(
    'http://localhost/api/instances/source-1/documents?allFolders=true&connectionId=connection-a',
  ));
  assert.equal(first.status, 200);
  const firstBody = await first.json() as {
    documents: Array<{ id: string }>;
    inventory: {
      complete: boolean;
      cache: { status: string };
      excluded: Record<string, number>;
    };
  };
  assert.deepEqual(firstBody.documents.map((document) => document.id), ['a-dashboard']);
  assert.equal(firstBody.inventory.complete, true);
  assert.equal(firstBody.inventory.cache.status, 'miss');
  assert.deepEqual(firstBody.inventory.excluded, {
    missingConnectionId: 1,
    otherConnection: 1,
    missingDashboardEvidence: 1,
  });

  const second = await instancesHandler(new Request(
    'http://localhost/api/instances/source-1/documents?allFolders=true&connectionId=connection-b',
  ));
  const secondBody = await second.json() as {
    documents: Array<{ id: string }>;
    inventory: { cache: { status: string } };
  };
  assert.equal(second.status, 200);
  assert.deepEqual(secondBody.documents.map((document) => document.id), ['b-dashboard']);
  assert.equal(secondBody.inventory.cache.status, 'hit');
  assert.equal(calls, 1);
  assert.deepEqual(requestedOptions, [{ includeLabels: true, folderId: undefined }]);
});

test('explicit refresh replaces the completed canonical snapshot and remains credential bound', async () => {
  let calls = 0;
  mock.method(OmniClient.prototype, 'listDocumentInventory', async () => {
    calls += 1;
    return completeInventory([{
      id: `dashboard-${calls}`,
      identifier: `dashboard-${calls}`,
      name: `Dashboard ${calls}`,
      connectionId: 'connection-a',
      hasDashboard: true,
    }]);
  });

  const load = (suffix = '') => instancesHandler(new Request(
    `http://localhost/api/instances/source-1/documents?allFolders=true&connectionId=connection-a${suffix}`,
  ));
  await load();
  const refreshed = await load('&forceRefresh=true');
  const refreshedBody = await refreshed.json() as {
    documents: Array<{ id: string }>;
    inventory: { cache: { status: string } };
  };
  assert.deepEqual(refreshedBody.documents.map((document) => document.id), ['dashboard-2']);
  assert.equal(refreshedBody.inventory.cache.status, 'miss');

  saveSource('replacement-source-key');
  const replacementCredential = await load();
  const replacementBody = await replacementCredential.json() as {
    documents: Array<{ id: string }>;
    inventory: { cache: { status: string } };
  };
  assert.deepEqual(replacementBody.documents.map((document) => document.id), ['dashboard-3']);
  assert.equal(replacementBody.inventory.cache.status, 'miss');
  assert.equal(calls, 3);
});

test('documented folderId stays upstream scoped while connectionId stays local', async () => {
  let requestedOptions: unknown;
  mock.method(OmniClient.prototype, 'listDocumentInventory', async (options?: unknown) => {
    requestedOptions = options;
    return completeInventory([{
      id: 'folder-dashboard',
      identifier: 'folder-dashboard',
      name: 'Folder dashboard',
      connectionId: 'connection-a',
      folderId: 'folder-1',
      hasDashboard: true,
    }]);
  });

  const response = await instancesHandler(new Request(
    'http://localhost/api/instances/source-1/documents?folderId=folder-1&connectionId=connection-a',
  ));
  const body = await response.json() as {
    documents: Array<{ id: string }>;
    inventory: { folderScoped: boolean };
  };
  assert.equal(response.status, 200);
  assert.deepEqual(body.documents.map((document) => document.id), ['folder-dashboard']);
  assert.equal(body.inventory.folderScoped, true);
  assert.deepEqual(requestedOptions, { includeLabels: true, folderId: 'folder-1' });
});

test('a forced refresh coalesces concurrent normal readers onto one new canonical crawl', async () => {
  const refresh = deferred<OmniDocumentInventoryResult>();
  let calls = 0;
  mock.method(OmniClient.prototype, 'listDocumentInventory', async () => {
    calls += 1;
    if (calls === 2) return refresh.promise;
    return completeInventory([{
      id: 'initial-dashboard',
      identifier: 'initial-dashboard',
      name: 'Initial dashboard',
      connectionId: 'connection-a',
      hasDashboard: true,
    }]);
  });

  await instancesHandler(new Request(
    'http://localhost/api/instances/source-1/documents?allFolders=true&connectionId=connection-a',
  ));
  const forcedResponse = instancesHandler(new Request(
    'http://localhost/api/instances/source-1/documents?allFolders=true&connectionId=connection-a&forceRefresh=true',
  ));
  const normalResponse = instancesHandler(new Request(
    'http://localhost/api/instances/source-1/documents?allFolders=true&connectionId=connection-b',
  ));
  await Promise.resolve();
  assert.equal(calls, 2);

  refresh.resolve(completeInventory([{
    id: 'refreshed-dashboard-a',
    identifier: 'refreshed-dashboard-a',
    name: 'Refreshed dashboard A',
    connectionId: 'connection-a',
    hasDashboard: true,
  }, {
    id: 'refreshed-dashboard-b',
    identifier: 'refreshed-dashboard-b',
    name: 'Refreshed dashboard B',
    connectionId: 'connection-b',
    hasDashboard: true,
  }]));

  const [forced, normal] = await Promise.all([forcedResponse, normalResponse]);
  const forcedBody = await forced.json() as {
    documents: Array<{ id: string }>;
    inventory: { cache: { status: string } };
  };
  const normalBody = await normal.json() as {
    documents: Array<{ id: string }>;
    inventory: { cache: { status: string } };
  };
  assert.equal(forcedBody.inventory.cache.status, 'miss');
  assert.equal(normalBody.inventory.cache.status, 'shared');
  assert.deepEqual(forcedBody.documents.map((document) => document.id), ['refreshed-dashboard-a']);
  assert.deepEqual(normalBody.documents.map((document) => document.id), ['refreshed-dashboard-b']);
  assert.equal(calls, 2);
});

test('an incomplete crawl fails closed and its next request starts a fresh inventory', async () => {
  let calls = 0;
  mock.method(OmniClient.prototype, 'listDocumentInventory', async () => {
    calls += 1;
    if (calls === 1) throw new OmniPaginationError();
    return completeInventory([{
      id: 'dashboard-after-retry',
      identifier: 'dashboard-after-retry',
      name: 'Dashboard after retry',
      connectionId: 'connection-a',
      hasDashboard: true,
    }]);
  });

  const incomplete = await instancesHandler(new Request(
    'http://localhost/api/instances/source-1/documents?allFolders=true&connectionId=connection-a',
  ));
  const incompleteBody = await incomplete.json() as {
    documents?: unknown[];
    inventory: { complete: boolean };
  };
  assert.equal(incomplete.status, 502);
  assert.equal(incompleteBody.inventory.complete, false);
  assert.equal(incompleteBody.documents, undefined);

  const retry = await instancesHandler(new Request(
    'http://localhost/api/instances/source-1/documents?allFolders=true&connectionId=connection-a',
  ));
  const retryBody = await retry.json() as {
    documents: Array<{ id: string }>;
    inventory: { complete: boolean; cache: { status: string } };
  };
  assert.equal(retry.status, 200);
  assert.equal(retryBody.inventory.complete, true);
  assert.equal(retryBody.inventory.cache.status, 'miss');
  assert.deepEqual(retryBody.documents.map((document) => document.id), ['dashboard-after-retry']);
  assert.equal(calls, 2);
});

test('cancelling one endpoint subscriber preserves the shared upstream crawl for the remaining reader', async () => {
  const crawl = deferred<OmniDocumentInventoryResult>();
  const firstController = new AbortController();
  const secondController = new AbortController();
  let calls = 0;
  let upstreamSignal: AbortSignal | undefined;
  mock.method(OmniClient.prototype, 'listDocumentInventory', async (_options, signal) => {
    calls += 1;
    upstreamSignal = signal;
    return crawl.promise;
  });

  const firstResponse = instancesHandler(new Request(
    'http://localhost/api/instances/source-1/documents?allFolders=true&connectionId=connection-a',
    { signal: firstController.signal },
  ));
  const secondResponse = instancesHandler(new Request(
    'http://localhost/api/instances/source-1/documents?allFolders=true&connectionId=connection-b',
    { signal: secondController.signal },
  ));
  await Promise.resolve();
  assert.equal(calls, 1);

  firstController.abort(new DOMException('The first reader left.', 'AbortError'));
  const cancelled = await firstResponse;
  assert.equal(cancelled.status, 499);
  assert.equal(upstreamSignal?.aborted, false);

  crawl.resolve(completeInventory([{
    id: 'shared-dashboard-b',
    identifier: 'shared-dashboard-b',
    name: 'Shared dashboard B',
    connectionId: 'connection-b',
    hasDashboard: true,
  }]));
  const shared = await secondResponse;
  const sharedBody = await shared.json() as {
    documents: Array<{ id: string }>;
    inventory: { cache: { status: string } };
  };
  assert.equal(shared.status, 200);
  assert.equal(sharedBody.inventory.cache.status, 'shared');
  assert.deepEqual(sharedBody.documents.map((document) => document.id), ['shared-dashboard-b']);
  assert.equal(calls, 1);
});

test('large catalogs are indexed once and reused across connections without exposing credentials', async () => {
  const documents: OmniDocumentRecord[] = Array.from({ length: 10_000 }, (_, index) => ({
    id: `example-dashboard-${index}`,
    identifier: `example-dashboard-${index}`,
    name: `Example dashboard ${index}`,
    connectionId: index % 2 === 0 ? 'connection-a' : 'connection-b',
    hasDashboard: true,
  }));
  let calls = 0;
  mock.method(OmniClient.prototype, 'listDocumentInventory', async () => {
    calls += 1;
    return completeInventory(documents);
  });

  const first = await instancesHandler(new Request(
    'http://localhost/api/instances/source-1/documents?allFolders=true&connectionId=connection-a',
  ));
  const firstText = await first.text();
  const firstBody = JSON.parse(firstText) as {
    documents: Array<{ connectionId?: string }>;
    performance: { timings: Array<{ name: string }> };
  };
  const second = await instancesHandler(new Request(
    'http://localhost/api/instances/source-1/documents?allFolders=true&connectionId=connection-b',
  ));
  const secondText = await second.text();
  const secondBody = JSON.parse(secondText) as {
    documents: Array<{ connectionId?: string }>;
    inventory: { cache: { status: string } };
  };

  assert.equal(calls, 1);
  assert.equal(firstBody.documents.length, 5_000);
  assert.equal(secondBody.documents.length, 5_000);
  assert.ok(firstBody.documents.every((document) => document.connectionId === 'connection-a'));
  assert.ok(secondBody.documents.every((document) => document.connectionId === 'connection-b'));
  assert.equal(secondBody.inventory.cache.status, 'hit');
  assert.ok(firstBody.performance.timings.some((timing) => timing.name === 'select-connection-partition'));
  assert.equal(firstBody.performance.timings.some((timing) => timing.name === 'filter-connection'), false);
  assert.equal(firstText.includes('source-key'), false);
  assert.equal(secondText.includes('source-key'), false);
});

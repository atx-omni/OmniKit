import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import {
  OmniClient,
  OmniPaginationError,
  resetOmniClientRateLimitStateForTests,
} from '../server/services/omniClient';
import {
  DashboardSafeCopyContentError,
  type DashboardSafeCopyDocumentContent,
} from '../server/services/dashboardSafeCopyContent';
import {
  getInstance,
  lockVault,
  resetVault,
  unlockVault,
  upsertInstance,
} from '../server/services/nativeVault';

interface CapturedRequest {
  url: URL;
  method: string;
  body?: unknown;
}

let clientSequence = 0;

afterEach(() => {
  resetOmniClientRateLimitStateForTests();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function client(fetchImpl: typeof fetch): OmniClient {
  clientSequence += 1;
  return new OmniClient({
    label: 'Fictional safe-copy workspace',
    baseUrl: 'https://93.184.216.34',
    apiKey: `fictional-safe-copy-key-${clientSequence}`,
  }, {
    fetchImpl,
    maxReadRetries: 0,
  });
}

function pageInfo(input: {
  totalRecords: number;
  hasNextPage: boolean;
  nextCursor?: string;
}) {
  return {
    totalRecords: input.totalRecords,
    pageSize: 100,
    hasNextPage: input.hasNextPage,
    nextCursor: input.nextCursor ?? null,
  };
}

function validContent(): DashboardSafeCopyDocumentContent {
  return {
    name: 'Source dashboard',
    description: 'Content-only safe-copy fixture.',
    queryPresentations: {
      data: {
        '1': {
          type: 'query',
          name: 'Orders',
          query: { fields: ['orders.order_id'] },
          visConfig: { type: 'table' },
        },
      },
      order: ['1'],
    },
    controls: [],
    settings: {
      interactionMode: 'cross-filter',
      accessibilityLabel: 'Orders dashboard',
    },
    containers: [{ type: 'grid', queryPresentationKeys: ['1'] }],
  };
}

test('safe-copy folder inventory follows every cursor and proves one complete exact catalog', async () => {
  const requests: CapturedRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push({ url, method: String(init?.method || 'GET') });
    const cursor = url.searchParams.get('cursor');
    return cursor
      ? jsonResponse({
          folders: [{ id: 'folder-b', name: 'Safe copies', path: 'Shared/Safe copies' }],
          pageInfo: pageInfo({ totalRecords: 2, hasNextPage: false }),
        })
      : jsonResponse({
          folders: [{ id: 'folder-a', name: 'Shared', path: 'Shared' }],
          pageInfo: pageInfo({ totalRecords: 2, hasNextPage: true, nextCursor: 'folder-page-2' }),
        });
  };

  const result = await client(fetchImpl).listFolderInventory();

  assert.deepEqual(result.folders.map((folder) => folder.id), ['folder-a', 'folder-b']);
  assert.equal(result.pagination.complete, true);
  assert.equal(result.pagination.pages, 2);
  assert.equal(result.pagination.returnedRecords, 2);
  assert.equal(result.pagination.reportedTotalRecords, 2);
  assert.equal(requests.length, 2);
  for (const [index, request] of requests.entries()) {
    assert.equal(request.method, 'GET');
    assert.equal(request.url.pathname, '/api/v1/folders');
    assert.equal(request.url.searchParams.get('pageSize'), '100');
    assert.equal(request.url.searchParams.get('include'), 'labels');
    assert.equal(request.url.searchParams.get('cursor'), index === 0 ? null : 'folder-page-2');
  }
});

test('safe-copy folder inventory rejects a terminal page that does not reconcile to its exact total', async () => {
  const fetchImpl: typeof fetch = async () => jsonResponse({
    records: [{ id: 'folder-a', name: 'Shared', path: 'Shared' }],
    pageInfo: pageInfo({ totalRecords: 2, hasNextPage: false }),
  });

  await assert.rejects(
    client(fetchImpl).listFolderInventory(),
    OmniPaginationError,
  );
});

test('safe-copy folder inventory rejects an unkeyed folder instead of treating an incomplete scope as canonical', async () => {
  const fetchImpl: typeof fetch = async () => jsonResponse({
    folders: [{ name: 'Folder without an authoritative identity' }],
    pageInfo: pageInfo({ totalRecords: 1, hasNextPage: false }),
  });

  await assert.rejects(
    client(fetchImpl).listFolderInventory(),
    OmniPaginationError,
  );
});

test('safe-copy direct-access inventory is complete, cursor-bound, and explicitly scoped to direct grants', async () => {
  const requests: CapturedRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push({ url, method: String(init?.method || 'GET') });
    const cursor = url.searchParams.get('cursor');
    return cursor
      ? jsonResponse({
          principals: [{
            id: 'group-a',
            name: 'Analysts',
            type: 'userGroup',
            role: 'VIEWER',
            accessSource: 'direct',
            accessBoost: false,
            isOwner: false,
          }],
          pageInfo: pageInfo({ totalRecords: 2, hasNextPage: false }),
        })
      : jsonResponse({
          principals: [{
            id: 'user-owner',
            name: 'Destination owner',
            email: 'owner@example.test',
            type: 'user',
            role: 'MANAGER',
            accessSource: 'direct',
            accessBoost: false,
            isOwner: true,
          }],
          pageInfo: pageInfo({ totalRecords: 2, hasNextPage: true, nextCursor: 'access-page-2' }),
        });
  };

  const result = await client(fetchImpl).listDocumentAccessInventory(
    'document-a',
    { accessSource: 'direct' },
  );

  assert.deepEqual(result.principals.map((principal) => principal.id), ['user-owner', 'group-a']);
  assert.ok(result.principals.every((principal) => principal.accessSource === 'direct'));
  assert.equal(result.pagination.complete, true);
  assert.equal(result.pagination.returnedRecords, 2);
  assert.equal(requests.length, 2);
  for (const [index, request] of requests.entries()) {
    assert.equal(request.method, 'GET');
    assert.equal(request.url.pathname, '/api/v1/documents/document-a/access-list');
    assert.equal(request.url.searchParams.get('accessSource'), 'direct');
    assert.equal(request.url.searchParams.get('pageSize'), '100');
    assert.equal(request.url.searchParams.get('cursor'), index === 0 ? null : 'access-page-2');
  }
});

test('safe-copy direct-access inventory fails closed when Omni returns a folder grant or unsupported role', async () => {
  for (const principal of [{
    id: 'folder-user',
    name: 'Folder user',
    type: 'user',
    role: 'VIEWER',
    accessSource: 'folder',
    accessBoost: false,
    isOwner: false,
  }, {
    id: 'unsupported-role',
    name: 'Unsupported role',
    type: 'user',
    role: 'ADMIN',
    accessSource: 'direct',
    accessBoost: false,
    isOwner: false,
  }]) {
    const fetchImpl: typeof fetch = async () => jsonResponse({
      principals: [principal],
      pageInfo: pageInfo({ totalRecords: 1, hasNextPage: false }),
    });
    await assert.rejects(
      client(fetchImpl).listDocumentAccessInventory(
        'document-a',
        { accessSource: 'direct' },
      ),
      OmniPaginationError,
    );
  }
});

test('safe-copy strict inventory adapters honor a caller abort before issuing any request', async () => {
  let requestCount = 0;
  const fetchImpl: typeof fetch = async () => {
    requestCount += 1;
    return jsonResponse({});
  };
  const controller = new AbortController();
  const reason = new Error('Fictional caller canceled the inventory.');
  controller.abort(reason);
  const omni = client(fetchImpl);

  await assert.rejects(omni.listFolderInventory(controller.signal), reason);
  await assert.rejects(
    omni.listDocumentAccessInventory(
      'document-a',
      { accessSource: 'direct' },
      controller.signal,
    ),
    reason,
  );
  assert.equal(requestCount, 0);
});

test('legacy folder and access readers retain their permissive non-telemetry response contracts', async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/v1/folders') {
      return jsonResponse({ data: [{ id: 'legacy-folder', name: 'Legacy folder' }] });
    }
    if (url.pathname === '/api/v1/documents/document-a/access-list') {
      return jsonResponse({
        principals: [{
          id: 'legacy-user',
          name: 'Legacy user',
          type: 'user',
          role: 'VIEWER',
          accessSource: 'direct',
          accessBoost: false,
          isOwner: false,
        }],
      });
    }
    return jsonResponse({}, 404);
  };
  const omni = client(fetchImpl);

  assert.deepEqual(await omni.listFolders(), [{
    id: 'legacy-folder',
    name: 'Legacy folder',
    identifier: undefined,
    path: undefined,
    parentId: undefined,
    children: undefined,
  }]);
  assert.deepEqual(
    (await omni.listDocumentAccess('document-a', { accessSource: 'direct' }))
      .map((principal) => principal.id),
    ['legacy-user'],
  );
});

test('safe-copy document creation sends only the materialized Documents V2 content allowlist', async () => {
  const requests: CapturedRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    requests.push({ url, method: String(init?.method || 'GET'), body });
    if (init?.method === 'POST') {
      return jsonResponse({ id: 'created-document-id', identifier: 'created-document' }, 201);
    }
    return jsonResponse({
      id: 'created-document-id',
      identifier: 'created-document',
      modelId: 'model-a',
      queryPresentations: validContent().queryPresentations,
    });
  };

  const result = await client(fetchImpl).createDashboardSafeCopyDocument({
    modelId: 'model-a',
    name: 'Orders dashboard (Copy)',
    folderId: 'folder-a',
    content: validContent(),
  });

  assert.equal(result.identifier, 'created-document');
  assert.deepEqual(requests.map((request) => `${request.method} ${request.url.pathname}`), [
    'POST /api/v2/documents',
    'GET /api/v2/documents/created-document',
  ]);
  const sent = requests[0].body as Record<string, unknown>;
  assert.deepEqual(Object.keys(sent).sort(), [
    'containers',
    'controls',
    'description',
    'folderId',
    'modelId',
    'name',
    'queryPresentations',
    'settings',
    'summary',
  ]);
  assert.equal(sent.name, 'Orders dashboard (Copy)');
  assert.equal(sent.modelId, 'model-a');
  assert.equal(sent.folderId, 'folder-a');
  assert.doesNotMatch(
    JSON.stringify(sent),
    /"(?:access|sharing|owner|permissions|schedule|subscription|alert|webhook)"/i,
  );
});

test('hostile access, sharing, and owner metadata is rejected before any create request is sent', async () => {
  const hostileMutations: Array<(content: Record<string, unknown>) => void> = [
    (content) => { content.owner = { id: 'source-owner' }; },
    (content) => {
      (content.settings as Record<string, unknown>).sharing = { public: true };
    },
    (content) => {
      const data = (content.queryPresentations as {
        data: Record<string, { query?: Record<string, unknown> }>;
      }).data;
      data['1'].query!.access = [{ principal: 'everyone' }];
    },
  ];

  for (const mutate of hostileMutations) {
    let requestCount = 0;
    const fetchImpl: typeof fetch = async () => {
      requestCount += 1;
      return jsonResponse({});
    };
    const content = validContent() as unknown as Record<string, unknown>;
    mutate(content);
    await assert.rejects(
      client(fetchImpl).createDashboardSafeCopyDocument({
        modelId: 'model-a',
        name: 'Orders dashboard (Copy)',
        folderId: 'folder-a',
        content: content as unknown as DashboardSafeCopyDocumentContent,
      }),
      DashboardSafeCopyContentError,
    );
    assert.equal(requestCount, 0);
  }
});

test('a successful Documents V2 create response without an identifier remains an uncertain post-write error', async () => {
  const requests: CapturedRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push({ url, method: String(init?.method || 'GET') });
    return jsonResponse({ id: 'possibly-created-document' }, 201);
  };

  await assert.rejects(
    client(fetchImpl).createDashboardSafeCopyDocument({
      modelId: 'model-a',
      name: 'Orders dashboard (Copy)',
      content: validContent(),
    }),
    /created the document but did not return its identifier/i,
  );
  assert.deepEqual(requests.map((request) => `${request.method} ${request.url.pathname}`), [
    'POST /api/v2/documents',
  ]);
});

test('locking the vault aborts an in-flight read and permanently invalidates the cached credential client', async () => {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'omnikit-safe-copy-vault-session-'));
  const previousVaultPath = process.env.OMNIKIT_VAULT_PATH;
  const passphrase = 'safe-copy vault-session boundary passphrase';
  process.env.OMNIKIT_VAULT_PATH = path.join(temporaryRoot, 'vault.enc');
  let fetchCalls = 0;
  let observedSignal: AbortSignal | undefined;
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  try {
    lockVault();
    unlockVault(passphrase);
    const saved = upsertInstance({
      id: 'safe-copy-vault-bound-instance',
      label: 'Vault-bound safe-copy instance',
      role: 'both',
      baseUrl: 'https://93.184.216.34',
      apiKey: 'fictional-vault-bound-safe-copy-key',
      metricFilter: {
        connectionDatabaseContains: [],
        connectionDatabaseExact: [],
        embedExternalIdContains: [],
        embedExternalIdExact: [],
      },
      postMigrationActions: [],
    });
    const boundInstance = getInstance(saved.id);
    assert.ok(boundInstance);
    const fetchImpl: typeof fetch = async (_input, init) => {
      fetchCalls += 1;
      observedSignal = init?.signal || undefined;
      markStarted?.();
      return new Promise<Response>((_resolve, reject) => {
        if (observedSignal?.aborted) {
          reject(observedSignal.reason);
          return;
        }
        observedSignal?.addEventListener('abort', () => reject(observedSignal?.reason), { once: true });
      });
    };
    const cachedClient = new OmniClient(boundInstance, {
      fetchImpl,
      maxReadRetries: 2,
      requestTimeoutMs: 30_000,
    });
    const inFlight = cachedClient.listFolderInventory();
    await started;

    lockVault();

    await assert.rejects(inFlight, /vault was locked/i);
    assert.equal(observedSignal?.aborted, true);
    assert.equal(fetchCalls, 1);
    unlockVault(passphrase);
    await assert.rejects(cachedClient.listFolderInventory(), /vault was locked/i);
    assert.equal(fetchCalls, 1, 'an old cached client must not issue another request after a new vault session begins');
  } finally {
    resetVault();
    if (previousVaultPath === undefined) delete process.env.OMNIKIT_VAULT_PATH;
    else process.env.OMNIKIT_VAULT_PATH = previousVaultPath;
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

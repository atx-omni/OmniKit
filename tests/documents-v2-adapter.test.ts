import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';

import {
  buildDocumentV2QueryPresentations,
  documentV2PresentationOrder,
  DocumentsV2Adapter,
  projectDocumentV2Queries,
  type DocumentV2Requester,
} from '../server/services/documentsV2';
import { OmniClient, OmniClientError } from '../server/services/omniClient';

afterEach(() => mock.restoreAll());

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('builds V2 query presentation data and replaces the seed tile at key 1', () => {
  const presentations = buildDocumentV2QueryPresentations([
    { name: 'Revenue', query: { table: 'orders', fields: ['orders.revenue'] } },
    { name: 'Margin', query: { table: 'orders', fields: ['orders.margin'] } },
  ]);

  assert.deepEqual(presentations.order, ['1', '2']);
  assert.deepEqual(Object.keys(presentations.data), ['1', '2']);
  assert.equal((presentations.data['1'] as Record<string, unknown>).name, 'Revenue');
});

test('projects document queries in authoritative V2 order and appends undeclared records', () => {
  const state = {
    queryPresentations: {
      data: {
        alpha: { name: 'Alpha', query: { fields: ['orders.alpha'] } },
        beta: { name: 'Beta', query: { fields: ['orders.beta'] } },
        gamma: { name: 'Gamma', query: { fields: ['orders.gamma'] } },
      },
      order: ['beta', 'alpha', 'missing'],
    },
  };

  assert.deepEqual(documentV2PresentationOrder(state), ['beta', 'alpha', 'gamma']);
  assert.deepEqual(projectDocumentV2Queries(state).map((query) => query.name), ['Beta', 'Alpha', 'Gamma']);
});

test('creates a V2 document and verifies its immutable model binding', async () => {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const request: DocumentV2Requester = async (method, path, options) => {
    calls.push({ method, path, body: options?.body });
    if (method === 'POST') return jsonResponse({ identifier: 'revenue-review', name: 'Revenue review' }, 201);
    return jsonResponse({ identifier: 'revenue-review', modelId: 'model-a', queryPresentations: { data: {}, order: [] } });
  };

  const result = await new DocumentsV2Adapter(request).create({
    modelId: 'model-a',
    name: 'Revenue review',
  });

  assert.equal(result.identifier, 'revenue-review');
  assert.deepEqual(calls.map(({ method, path }) => `${method} ${path}`), [
    'POST /api/v2/documents',
    'GET /api/v2/documents/revenue-review',
  ]);
});

test('fails closed when create verification returns a different model binding', async () => {
  const request: DocumentV2Requester = async (method) => method === 'POST'
    ? jsonResponse({ identifier: 'revenue-review' }, 201)
    : jsonResponse({ identifier: 'revenue-review', modelId: 'model-b' });

  await assert.rejects(
    () => new DocumentsV2Adapter(request).create({ modelId: 'model-a', name: 'Revenue review' }),
    /model binding mismatch/i,
  );
});

test('fails closed when create verification returns a different workbook tab order', async () => {
  const request: DocumentV2Requester = async (method) => method === 'POST'
    ? jsonResponse({ identifier: 'revenue-review' }, 201)
    : jsonResponse({
      identifier: 'revenue-review',
      modelId: 'model-a',
      queryPresentations: {
        data: {
          '1': { name: 'Revenue', query: {} },
          '2': { name: 'Margin', query: {} },
        },
        order: ['2', '1'],
      },
    });

  await assert.rejects(
    () => new DocumentsV2Adapter(request).create({
      modelId: 'model-a',
      name: 'Revenue review',
      queryPresentations: buildDocumentV2QueryPresentations([
        { name: 'Revenue', query: {} },
        { name: 'Margin', query: {} },
      ]),
    }),
    /different workbook tab order/i,
  );
});

test('updates metadata through create-draft, publish, and post-publish verification', async () => {
  const calls: string[] = [];
  const request: DocumentV2Requester = async (method, path) => {
    calls.push(`${method} ${path}`);
    if (method === 'PATCH') {
      return jsonResponse({ identifier: 'revenue-review', draftIdentifier: 'revenue-review-draft' });
    }
    if (method === 'POST') return jsonResponse({ ok: true });
    return jsonResponse({ identifier: 'revenue-review', description: 'Reviewed' });
  };

  await new DocumentsV2Adapter(request).updateDescription('revenue-review', 'Reviewed');

  assert.deepEqual(calls, [
    'PATCH /api/v2/documents/revenue-review/draft',
    'POST /api/v2/documents/revenue-review/draft/publish',
    'GET /api/v2/documents/revenue-review',
  ]);
});

test('preserves an existing draft conflict and never publishes metadata over it', async () => {
  let publishCalled = false;
  const request: DocumentV2Requester = async (method, path) => {
    if (method === 'PATCH') {
      throw new OmniClientError(409, `https://example.omniapp.co${path}`, 'draft exists');
    }
    if (method === 'POST') publishCalled = true;
    return jsonResponse({ ok: true });
  };

  await assert.rejects(
    () => new DocumentsV2Adapter(request).updateDescription('revenue-review', 'Reviewed'),
    (error: unknown) => error instanceof OmniClientError && error.status === 409,
  );
  assert.equal(publishCalled, false);
});

test('resolves non-default document folder paths to an ID and fails closed when resolution is ambiguous or missing', async () => {
  mock.method(OmniClient.prototype, 'listFolders', async () => [{
    id: 'shared',
    name: 'Shared',
    path: 'Shared',
    children: [{ id: 'finance', name: 'Finance', path: 'Shared/Finance' }],
  }, {
    id: 'other',
    name: 'Other',
    path: 'Other',
    children: [{ id: 'other-finance', name: 'Finance', path: 'Other/Finance' }],
  }]);
  const client = new OmniClient({
    label: 'Destination',
    baseUrl: 'https://example.omniapp.co',
    apiKey: 'test-key',
  });

  assert.equal(await client.resolveDocumentFolderId(undefined, 'Shared/Finance'), 'finance');
  assert.equal(await client.resolveDocumentFolderId(undefined, 'My Documents'), undefined);
  await assert.rejects(
    () => client.resolveDocumentFolderId(undefined, 'Shared/Unknown'),
    /could not be resolved to an Omni folder ID/i,
  );
  await assert.rejects(
    () => client.resolveDocumentFolderId(undefined, 'Finance'),
    /matched multiple Omni folders/i,
  );
});

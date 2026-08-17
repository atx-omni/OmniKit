import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';

import listDocumentsHandler from '../server/handlers/list-documents';

afterEach(() => mock.restoreAll());

test('list documents requests labels and preserves known-empty versus unavailable label state', async () => {
  let requestedUrl = '';
  mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({
      records: [
        {
          identifier: 'known-empty',
          name: 'Known empty',
          labels: [],
          hasDashboard: true,
          connectionId: 'connection-123',
          baseModelId: 'model-456',
        },
        { identifier: 'known-labels', name: 'Known labels', labels: ['Finance'], hasDashboard: true },
        { identifier: 'unavailable', name: 'Unavailable', hasDashboard: true },
      ],
      pageInfo: { hasNextPage: false, nextCursor: null, pageSize: 3, totalRecords: 3 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });

  const response = await listDocumentsHandler(new Request('http://localhost/api/list-documents', {
    method: 'POST',
    body: JSON.stringify({
      base_url: 'https://8.8.8.8',
      api_key: 'test-key',
      all_pages: true,
    }),
  }));
  const body = await response.json() as {
    documents: Array<{
      id: string;
      labels?: string[];
      connectionId?: string;
      baseModelId?: string;
    }>;
  };

  assert.equal(response.status, 200);
  assert.equal(new URL(requestedUrl).searchParams.get('include'), 'labels');
  assert.deepEqual(body.documents.find((doc) => doc.id === 'known-empty')?.labels, []);
  assert.equal(body.documents.find((doc) => doc.id === 'known-empty')?.connectionId, 'connection-123');
  assert.equal(body.documents.find((doc) => doc.id === 'known-empty')?.baseModelId, 'model-456');
  assert.deepEqual(body.documents.find((doc) => doc.id === 'known-labels')?.labels, ['Finance']);
  assert.equal('labels' in (body.documents.find((doc) => doc.id === 'unavailable') || {}), false);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import listDocumentsHandler from '../server/handlers/list-documents';
import listFoldersHandler from '../server/handlers/list-folders';

const BASE_URL = 'https://neutral-content.omniapp.co';
const API_KEY = 'private-test-key';

function localRequest(body: Record<string, unknown>): Request {
  return new Request('http://127.0.0.1/api/content', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base_url: BASE_URL, api_key: API_KEY, ...body }),
  });
}

test('content collection handlers preserve legitimate empty reads and fail closed on malformed or hostile responses', async (t) => {
  const privateMarker = 'raw-upstream-private-marker';
  const upstreamResponses = [
    new Response(JSON.stringify({ errors: [] }), { status: 200 }),
    new Response(JSON.stringify({ errors: [] }), { status: 200 }),
    new Response(`${privateMarker}:${API_KEY}`, { status: 403 }),
    new Response(JSON.stringify({
      records: [],
      pageInfo: { hasNextPage: false, nextCursor: null, pageSize: 100, totalRecords: 0 },
    }), { status: 200 }),
    new Response(JSON.stringify({
      records: [],
      pageInfo: { hasNextPage: false, nextCursor: null, pageSize: 100, totalRecords: 0 },
    }), { status: 200 }),
  ];
  let requestIndex = 0;
  t.mock.method(globalThis, 'fetch', async () => upstreamResponses[requestIndex++]);

  const malformedFolders = await listFoldersHandler(localRequest({ all_pages: true }));
  const malformedDocuments = await listDocumentsHandler(localRequest({ folder_id: 'folder-1', all_pages: true }));
  const deniedFolders = await listFoldersHandler(localRequest({ all_pages: true }));
  const emptyFolders = await listFoldersHandler(localRequest({ all_pages: true }));
  const emptyDocuments = await listDocumentsHandler(localRequest({ folder_id: 'folder-1', all_pages: true }));

  assert.equal(malformedFolders.status, 502);
  assert.equal(malformedDocuments.status, 502);
  assert.equal(deniedFolders.status, 403);
  for (const response of [malformedFolders, malformedDocuments, deniedFolders]) {
    const serialized = JSON.stringify(await response.json());
    assert.equal(serialized.includes(privateMarker), false);
    assert.equal(serialized.includes(API_KEY), false);
    assert.equal(serialized.includes('rawResponse'), false);
    assert.equal(serialized.includes('detail'), false);
  }

  assert.equal(emptyFolders.status, 200);
  assert.equal(emptyDocuments.status, 200);
  const emptyFolderBody = await emptyFolders.json() as { folders: unknown[]; complete: boolean; loadedResults: number; totalResults: number };
  const emptyDocumentBody = await emptyDocuments.json() as { documents: unknown[]; complete: boolean; loadedResults: number; totalResults: number };
  assert.deepEqual(emptyFolderBody.folders, []);
  assert.deepEqual(emptyDocumentBody.documents, []);
  assert.deepEqual(
    [emptyFolderBody.complete, emptyFolderBody.loadedResults, emptyFolderBody.totalResults],
    [true, 0, 0],
  );
  assert.deepEqual(
    [emptyDocumentBody.complete, emptyDocumentBody.loadedResults, emptyDocumentBody.totalResults],
    [true, 0, 0],
  );
  assert.equal(requestIndex, upstreamResponses.length);
});

test('content collection handlers preserve partial evidence at the pagination safety limit', async (t) => {
  const requestCounts = { folders: 0, documents: 0 };
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const kind = url.pathname.endsWith('/folders') ? 'folders' : 'documents';
    requestCounts[kind] += 1;
    const ordinal = requestCounts[kind];
    const record = kind === 'folders'
      ? { id: `folder-${ordinal}`, name: `Folder ${ordinal}` }
      : { identifier: `document-${ordinal}`, name: `Document ${ordinal}`, hasDashboard: true };
    return new Response(JSON.stringify({
      records: [record],
      pageInfo: {
        hasNextPage: ordinal < 51,
        nextCursor: ordinal < 51 ? `cursor-${ordinal + 1}` : null,
        pageSize: 1,
        totalRecords: 51,
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });

  const folderResponse = await listFoldersHandler(localRequest({ all_pages: true, page_size: 1 }));
  const documentResponse = await listDocumentsHandler(localRequest({ all_pages: true, page_size: 1 }));
  const folderBody = await folderResponse.json() as Record<string, unknown>;
  const documentBody = await documentResponse.json() as Record<string, unknown>;

  for (const body of [folderBody, documentBody]) {
    assert.equal(body.complete, false);
    assert.equal(body.loadedResults, 50);
    assert.equal(body.totalResults, 51);
    assert.equal(body.pagesFetched, 50);
    assert.equal(body.reasonCode, 'PAGINATION_SAFETY_LIMIT_REACHED');
  }
  assert.deepEqual(requestCounts, { folders: 50, documents: 50 });
});

test('content collection handlers reject malformed and duplicate record identities', async (t) => {
  const responses = [
    { records: [{ id: 7 }], pageInfo: { hasNextPage: false, nextCursor: null, pageSize: 1, totalRecords: 1 } },
    { records: [{ identifier: { unsafe: true } }], pageInfo: { hasNextPage: false, nextCursor: null, pageSize: 1, totalRecords: 1 } },
    { records: [{ id: 'folder-bad-name', name: { unsafe: true } }], pageInfo: { hasNextPage: false, nextCursor: null, pageSize: 1, totalRecords: 1 } },
    { records: [{ identifier: 'document-bad-name', name: { unsafe: true } }], pageInfo: { hasNextPage: false, nextCursor: null, pageSize: 1, totalRecords: 1 } },
    { records: [{ id: 'folder-repeat', name: 'Folder repeat' }], pageInfo: { hasNextPage: true, nextCursor: 'folder-next', pageSize: 1, totalRecords: 2 } },
    { records: [{ id: 'folder-repeat', name: 'Folder repeat' }], pageInfo: { hasNextPage: false, nextCursor: null, pageSize: 1, totalRecords: 2 } },
    { records: [{ identifier: 'document-repeat', name: 'Document repeat' }], pageInfo: { hasNextPage: true, nextCursor: 'document-next', pageSize: 1, totalRecords: 2 } },
    { records: [{ identifier: 'document-repeat', name: 'Document repeat' }], pageInfo: { hasNextPage: false, nextCursor: null, pageSize: 1, totalRecords: 2 } },
  ];
  let responseIndex = 0;
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(responses[responseIndex++]), { status: 200 }));

  assert.equal((await listFoldersHandler(localRequest({ all_pages: true }))).status, 502);
  assert.equal((await listDocumentsHandler(localRequest({ all_pages: true }))).status, 502);
  assert.equal((await listFoldersHandler(localRequest({ all_pages: true }))).status, 502);
  assert.equal((await listDocumentsHandler(localRequest({ all_pages: true }))).status, 502);
  assert.equal((await listFoldersHandler(localRequest({ all_pages: true, page_size: 1 }))).status, 502);
  assert.equal((await listDocumentsHandler(localRequest({ all_pages: true, page_size: 1 }))).status, 502);
  assert.equal(responseIndex, responses.length);
});

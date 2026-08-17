import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  OmniClient,
  OmniClientError,
  OmniDocumentInventoryDeadlineError,
  OmniPaginationError,
  OmniRequestDeadlineError,
  OmniResponseLimitError,
  OmniResponseReadDeadlineError,
} from '../server/services/omniClient';

function inventoryClient(apiKeySuffix = ''): OmniClient {
  return new OmniClient({
    label: 'Fictional inventory workspace',
    baseUrl: 'https://93.184.216.34',
    apiKey: `fictional-inventory-key${apiKeySuffix}`,
  });
}

function pagedDocument(index: number) {
  return {
    id: `example-document-${index}`,
    identifier: `example-document-${index}`,
    name: `Example dashboard ${index}`,
    connectionId: 'example-connection-a',
    hasDashboard: true,
  };
}

function documentPage(input: {
  records: ReturnType<typeof pagedDocument>[];
  totalRecords: number;
  hasNextPage: boolean;
  nextCursor: string | null;
}): Response {
  return new Response(JSON.stringify({
    records: input.records,
    pageInfo: {
      hasNextPage: input.hasNextPage,
      nextCursor: input.nextCursor,
      pageSize: 100,
      totalRecords: input.totalRecords,
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

test('canonical document inventory crawls the complete tenant catalog without an upstream connection filter', async (t) => {
  const requestedUrls: URL[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = new URL(String(input));
    requestedUrls.push(url);
    const cursor = url.searchParams.get('cursor');
    const records = cursor
      ? [{
          id: 'example-document-c',
          identifier: 'example-document-c',
          name: 'Example dashboard C',
          connectionId: 'example-connection-b',
          hasDashboard: true,
        }]
      : [{
          id: 'example-document-a',
          identifier: 'example-document-a',
          name: 'Example dashboard A',
          connectionId: 'example-connection-a',
          hasDashboard: true,
        }, {
          id: 'example-document-b',
          identifier: 'example-document-b',
          name: 'Example dashboard B',
          connectionId: 'example-connection-b',
          hasDashboard: true,
        }];
    return new Response(JSON.stringify({
      records,
      pageInfo: cursor
        ? { hasNextPage: false, nextCursor: null, pageSize: 100, totalRecords: 3 }
        : { hasNextPage: true, nextCursor: 'example-cursor-two', pageSize: 100, totalRecords: 3 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  const result = await inventoryClient().listDocumentInventory({ includeLabels: true });

  assert.equal(requestedUrls.length, 2);
  for (const url of requestedUrls) {
    assert.equal(url.pathname, '/api/v1/documents');
    assert.equal(url.searchParams.has('connectionId'), false);
    assert.equal(url.searchParams.has('folderId'), false);
    assert.equal(url.searchParams.get('include'), 'labels');
  }
  assert.deepEqual(result.documents.map((document) => document.id), [
    'example-document-a',
    'example-document-b',
    'example-document-c',
  ]);
  assert.deepEqual(result.pagination, {
    complete: true,
    pages: 2,
    pageSize: 100,
    returnedRecords: 3,
    reportedTotalRecords: 3,
    responseBytes: result.pagination.responseBytes,
  });
  assert.ok((result.pagination.responseBytes ?? 0) > 0);
});

test('canonical document inventory accepts the live remaining-record total contract', async (t) => {
  const catalogSize = 3_336;
  const observedReportedTotals: number[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const offset = Number(url.searchParams.get('cursor') ?? 0);
    const recordsOnPage = Math.min(100, catalogSize - offset);
    const nextOffset = offset + recordsOnPage;
    const hasNextPage = nextOffset < catalogSize;
    const reportedRemainingRecords = catalogSize - offset;
    observedReportedTotals.push(reportedRemainingRecords);
    return documentPage({
      records: Array.from({ length: recordsOnPage }, (_, index) => pagedDocument(offset + index)),
      totalRecords: reportedRemainingRecords,
      hasNextPage,
      nextCursor: hasNextPage ? String(nextOffset) : null,
    });
  });

  const result = await inventoryClient('-remaining-live-contract').listDocumentInventory({ includeLabels: true });

  assert.deepEqual(observedReportedTotals.slice(0, 3), [3_336, 3_236, 3_136]);
  assert.equal(observedReportedTotals.at(-1), 36);
  assert.equal(result.documents.length, catalogSize);
  assert.deepEqual(result.pagination, {
    complete: true,
    pages: 34,
    pageSize: 100,
    returnedRecords: catalogSize,
    reportedTotalRecords: catalogSize,
    responseBytes: result.pagination.responseBytes,
  });
});

test('canonical document inventory retains stable-total pagination after mode detection', async (t) => {
  let requestCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    const page = requestCount;
    requestCount += 1;
    return documentPage({
      records: [pagedDocument(page)],
      totalRecords: 3,
      hasNextPage: page < 2,
      nextCursor: page < 2 ? `stable-cursor-${page + 1}` : null,
    });
  });

  const result = await inventoryClient('-stable-contract').listDocumentInventory({ includeLabels: true });

  assert.equal(requestCount, 3);
  assert.deepEqual(result.documents.map((document) => document.id), [
    'example-document-0',
    'example-document-1',
    'example-document-2',
  ]);
  assert.equal(result.pagination.reportedTotalRecords, 3);
});

test('canonical document inventory rejects incoherent remaining-record totals', async (t) => {
  let requestCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    const page = requestCount;
    requestCount += 1;
    return documentPage({
      records: [pagedDocument(page)],
      totalRecords: page === 0 ? 3 : 1,
      hasNextPage: true,
      nextCursor: `incoherent-cursor-${page + 1}`,
    });
  });

  await assert.rejects(
    inventoryClient('-incoherent-remaining').listDocumentInventory({ includeLabels: true }),
    OmniPaginationError,
  );
  assert.equal(requestCount, 2);
});

test('canonical document inventory rejects a remaining-total sequence that switches to stable totals', async (t) => {
  const reportedTotals = [3, 2, 3];
  let requestCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    const page = requestCount;
    requestCount += 1;
    return documentPage({
      records: [pagedDocument(page)],
      totalRecords: reportedTotals[page],
      hasNextPage: page < 2,
      nextCursor: page < 2 ? `remaining-switch-cursor-${page + 1}` : null,
    });
  });

  await assert.rejects(
    inventoryClient('-remaining-to-stable-switch').listDocumentInventory({ includeLabels: true }),
    OmniPaginationError,
  );
  assert.equal(requestCount, 3);
});

test('canonical document inventory rejects a stable-total sequence that switches to remaining totals', async (t) => {
  const reportedTotals = [3, 3, 1];
  let requestCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    const page = requestCount;
    requestCount += 1;
    return documentPage({
      records: [pagedDocument(page)],
      totalRecords: reportedTotals[page],
      hasNextPage: page < 2,
      nextCursor: page < 2 ? `stable-switch-cursor-${page + 1}` : null,
    });
  });

  await assert.rejects(
    inventoryClient('-stable-to-remaining-switch').listDocumentInventory({ includeLabels: true }),
    OmniPaginationError,
  );
  assert.equal(requestCount, 3);
});

test('canonical document inventory rejects an underfilled terminal page in remaining-total mode', async (t) => {
  let requestCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    const page = requestCount;
    requestCount += 1;
    return documentPage({
      records: [pagedDocument(page)],
      totalRecords: page === 0 ? 3 : 2,
      hasNextPage: page === 0,
      nextCursor: page === 0 ? 'underfilled-terminal-cursor' : null,
    });
  });

  await assert.rejects(
    inventoryClient('-underfilled-terminal').listDocumentInventory({ includeLabels: true }),
    OmniPaginationError,
  );
  assert.equal(requestCount, 2);
});

test('canonical document inventory fails closed when a terminal page does not reconcile to the reported total', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    records: [{
      id: 'example-document-a',
      identifier: 'example-document-a',
      name: 'Example dashboard A',
      connectionId: 'example-connection-a',
      hasDashboard: true,
    }],
    pageInfo: {
      hasNextPage: false,
      nextCursor: null,
      pageSize: 100,
      totalRecords: 2,
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

  await assert.rejects(
    inventoryClient().listDocumentInventory({ includeLabels: true }),
    OmniPaginationError,
  );
});

test('canonical document inventory requires a reported total on its first page', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    records: [{
      id: 'example-document-a',
      identifier: 'example-document-a',
      name: 'Example dashboard A',
      connectionId: 'example-connection-a',
      hasDashboard: true,
    }],
    pageInfo: {
      hasNextPage: false,
      nextCursor: null,
      pageSize: 100,
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

  await assert.rejects(
    inventoryClient().listDocumentInventory({ includeLabels: true }),
    OmniPaginationError,
  );
});

test('canonical document inventory rejects a reported total that changes across pages', async (t) => {
  let requestCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requestCount += 1;
    return new Response(JSON.stringify(requestCount === 1
      ? {
          records: [{
            id: 'example-document-a',
            identifier: 'example-document-a',
            name: 'Example dashboard A',
            connectionId: 'example-connection-a',
            hasDashboard: true,
          }, {
            id: 'example-document-b',
            identifier: 'example-document-b',
            name: 'Example dashboard B',
            connectionId: 'example-connection-b',
            hasDashboard: true,
          }],
          pageInfo: {
            hasNextPage: true,
            nextCursor: 'example-cursor-two',
            pageSize: 100,
            totalRecords: 3,
          },
        }
      : {
          records: [{
            id: 'example-document-c',
            identifier: 'example-document-c',
            name: 'Example dashboard C',
            connectionId: 'example-connection-b',
            hasDashboard: true,
          }],
          pageInfo: {
            hasNextPage: false,
            nextCursor: null,
            pageSize: 100,
            totalRecords: 2,
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  await assert.rejects(
    inventoryClient().listDocumentInventory({ includeLabels: true }),
    OmniPaginationError,
  );
  assert.equal(requestCount, 2);
});

test('canonical document inventory rejects records without a stable identifier', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    records: [{ name: 'Unidentified document', connectionId: 'example-connection-a', hasDashboard: true }],
    pageInfo: { hasNextPage: false, nextCursor: null, pageSize: 100, totalRecords: 1 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

  await assert.rejects(
    inventoryClient().listDocumentInventory({ includeLabels: true }),
    OmniPaginationError,
  );
});

test('canonical document inventory rejects a page whose declared body exceeds the response bound', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(2 * 1024 * 1024 + 1),
    },
  }));

  await assert.rejects(
    inventoryClient().listDocumentInventory({ includeLabels: true }),
    OmniResponseLimitError,
  );
});

test('canonical document inventory bounds a stalled page body read', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{'));
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const client = new OmniClient({
    label: 'Fictional bounded inventory workspace',
    baseUrl: 'https://93.184.216.34',
    apiKey: 'fictional-bounded-inventory-key',
  }, { requestTimeoutMs: 10, maxReadRetries: 0 });

  await assert.rejects(
    client.listDocumentInventory({ includeLabels: true }),
    OmniResponseReadDeadlineError,
  );
});

test('canonical document inventory bounds a stalled response-header request', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => (
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    })
  ));
  const client = new OmniClient({
    label: 'Fictional bounded header workspace',
    baseUrl: 'https://93.184.216.34',
    apiKey: 'fictional-bounded-header-key',
  }, { requestTimeoutMs: 10, maxReadRetries: 0 });

  await assert.rejects(
    client.listDocumentInventory({ includeLabels: true }),
    OmniRequestDeadlineError,
  );
});

test('canonical document inventory propagates request cancellation to its upstream read', async (t) => {
  const controller = new AbortController();
  let upstreamSignal: AbortSignal | null | undefined;
  let markFetchStarted!: () => void;
  const fetchStarted = new Promise<void>((resolve) => {
    markFetchStarted = resolve;
  });
  t.mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
    upstreamSignal = init?.signal;
    markFetchStarted();
    return new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted) {
        reject(init.signal.reason);
        return;
      }
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
  });

  const pending = inventoryClient().listDocumentInventory({ includeLabels: true }, controller.signal);
  await fetchStarted;
  controller.abort(new DOMException('The caller left.', 'AbortError'));

  await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === 'AbortError');
  assert.equal(upstreamSignal?.aborted, true);
});

test('canonical document inventory arms its total deadline before the first response arrives', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => (
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    })
  ));
  const client = new OmniClient({
    label: 'Fictional first-page deadline workspace',
    baseUrl: 'https://93.184.216.34',
    apiKey: 'fictional-first-page-deadline-key',
  }, {
    requestTimeoutMs: 5_000,
    maxReadRetries: 0,
    documentInventoryInitialDeadlineMs: 10,
  });

  await assert.rejects(
    client.listDocumentInventory({ includeLabels: true }),
    OmniDocumentInventoryDeadlineError,
  );
});

test('canonical document inventory total deadline bounds Retry-After backoff before page one', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', {
    status: 429,
    headers: { 'Retry-After': '60' },
  }));
  const client = new OmniClient({
    label: 'Fictional retry-after deadline workspace',
    baseUrl: 'https://93.184.216.34',
    apiKey: 'fictional-retry-after-deadline-key',
  }, {
    requestTimeoutMs: 5_000,
    maxReadRetries: 1,
    documentInventoryInitialDeadlineMs: 10,
  });

  await assert.rejects(
    client.listDocumentInventory({ includeLabels: true }),
    OmniDocumentInventoryDeadlineError,
  );
});

test('the active request deadline bounds an extreme Retry-After independently of the inventory deadline', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', {
    status: 429,
    headers: { 'Retry-After': '86400' },
  }));
  const client = new OmniClient({
    label: 'Fictional bounded retry-after workspace',
    baseUrl: 'https://93.184.216.34',
    apiKey: 'fictional-bounded-retry-after-key',
  }, {
    requestTimeoutMs: 10,
    maxReadRetries: 1,
    documentInventoryInitialDeadlineMs: 5_000,
  });
  const startedAt = Date.now();

  await assert.rejects(
    client.listDocumentInventory({ includeLabels: true }),
    (error: unknown) => error instanceof OmniClientError && error.status === 429,
  );
  assert.ok(Date.now() - startedAt < 2_000, 'Retry-After must remain inside the active request deadline');
});

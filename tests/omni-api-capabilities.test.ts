import assert from 'node:assert/strict';
import { test } from 'node:test';

import handler from '../server/handlers/omni-api-capabilities';
import { probeOmniApiCapabilities } from '../server/services/omniApiCapabilities';
import {
  OMNI_API_WRITE_CANARY_CONFIRMATION,
  runOmniApiLabelCanary,
} from '../server/services/omniApiCanary';

const baseInput = {
  baseUrl: 'https://example.omniapp.co',
  apiKey: 'test-key',
};

function mockFetch(statuses: Record<string, number>, calls: string[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const entry = Object.entries(statuses).find(([suffix]) => url.includes(suffix));
    const body = url.includes('/folders')
      ? { records: [], pageInfo: { hasNextPage: false, totalRecords: 0 } }
      : url.includes('/connections')
        ? { records: [] }
        : url.includes('/models/') && url.includes('/yaml')
          ? { files: {} }
          : url.includes('/models/') && url.includes('/validate')
            ? { valid: true }
            : url.includes('/models/') && url.includes('/schemas')
              ? { schemas: [] }
              : url.includes('/models')
                ? { records: [] }
                : url.includes('/documents/') && url.includes('/queries')
                  ? { queries: [] }
                  : url.includes('/api/v2/documents/')
                    ? { id: 'document' }
                    : url.includes('/documents')
                      ? { records: [] }
                      : url.includes('/labels')
                        ? { records: [] }
                        : { records: [] };
    return new Response(JSON.stringify(body), { status: entry?.[1] ?? 200 });
  }) as typeof fetch;
}

test('read-only capability probe classifies success without exposing credentials or response bodies', async () => {
  const calls: string[] = [];
  const report = await probeOmniApiCapabilities(baseInput, {
    fetchImpl: mockFetch({}, calls),
    assertSafeUrl: async () => undefined,
    now: () => new Date('2026-08-04T12:00:00.000Z'),
  });

  assert.equal(report.overall, 'compatible');
  assert.equal(report.host, 'example.omniapp.co');
  assert.equal(report.checkedAt, '2026-08-04T12:00:00.000Z');
  assert.equal(report.summary.available, 6);
  assert.equal(report.summary.notTested, 5);
  assert.ok(calls.every((url) => !url.includes('test-key')));
  assert.ok(calls.every((url) => url.startsWith('https://example.omniapp.co/api/')));
  assert.equal(JSON.stringify(report).includes('test-key'), false);
  assert.equal(JSON.stringify(report).includes('{}'), false);
});

test('required contract failures are incompatible and are not retried', async () => {
  const calls: string[] = [];
  const report = await probeOmniApiCapabilities(baseInput, {
    fetchImpl: mockFetch({ '/api/v1/documents?': 410 }, calls),
    assertSafeUrl: async () => undefined,
  });

  const documents = report.probes.find((probe) => probe.id === 'documents-list');
  assert.equal(documents?.status, 'contract_failed');
  assert.equal(documents?.httpStatus, 410);
  assert.equal(report.overall, 'incompatible');
  assert.equal(calls.filter((url) => url.includes('/api/v1/documents?')).length, 1);
});

test('authentication, request, and transient failures remain distinct', async () => {
  const report = await probeOmniApiCapabilities({ ...baseInput, modelId: 'model-1' }, {
    fetchImpl: mockFetch({
      '/api/v1/folders?': 401,
      '/api/v1/models/model-1/yaml': 422,
      '/api/v1/uploads': 503,
    }, []),
    assertSafeUrl: async () => undefined,
  });

  assert.equal(report.overall, 'authentication_failed');
  assert.equal(report.probes.find((probe) => probe.id === 'folders')?.status, 'authentication_failed');
  assert.equal(report.probes.find((probe) => probe.id === 'model-yaml')?.status, 'request_failed');
  assert.equal(report.probes.find((probe) => probe.id === 'uploads')?.status, 'transient_failure');
});

test('redirects and malformed successful responses never count as available', async () => {
  const report = await probeOmniApiCapabilities(baseInput, {
    fetchImpl: (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/v1/folders?')) {
        return new Response(JSON.stringify({ records: [] }), {
          status: 302,
          headers: { Location: 'https://example.omniapp.co/login' },
        });
      }
      if (url.includes('/api/v1/connections')) return new Response('{}', { status: 200 });
      return mockFetch({}, [])(input);
    }) as typeof fetch,
    assertSafeUrl: async () => undefined,
  });

  assert.equal(report.probes.find((probe) => probe.id === 'folders')?.status, 'request_failed');
  assert.equal(report.probes.find((probe) => probe.id === 'connections')?.status, 'request_failed');
  assert.equal(report.overall, 'degraded');
});

test('resource-scoped probes run only when identifiers are explicitly supplied', async () => {
  const withoutIds = await probeOmniApiCapabilities(baseInput, {
    fetchImpl: mockFetch({}, []),
    assertSafeUrl: async () => undefined,
  });
  assert.equal(withoutIds.probes.find((probe) => probe.id === 'model-yaml')?.status, 'not_tested');
  assert.equal(withoutIds.probes.find((probe) => probe.id === 'documents-v2-state')?.status, 'not_tested');

  const calls: string[] = [];
  const withIds = await probeOmniApiCapabilities({ ...baseInput, modelId: 'model / 1', documentId: 'doc / 1' }, {
    fetchImpl: mockFetch({}, calls),
    assertSafeUrl: async () => undefined,
  });
  assert.equal(withIds.summary.available, 11);
  assert.ok(calls.some((url) => url.includes('/models/model%20%2F%201/yaml')));
  assert.ok(calls.some((url) => url.includes('/documents/doc%20%2F%201/queries')));
});

test('capability handler is POST-only and validates input before probing', async () => {
  const methodResponse = await handler(new Request('http://localhost/api/omni-api-capabilities'));
  assert.equal(methodResponse.status, 405);

  const invalidResponse = await handler(new Request('http://localhost/api/omni-api-capabilities', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base_url: 'http://localhost', api_key: '' }),
  }));
  assert.equal(invalidResponse.status, 400);
  assert.match(JSON.stringify(await invalidResponse.json()), /HTTPS|API key/i);
});

test('controlled write canary requires a dedicated temporary label and explicit absence confirmation', async () => {
  await assert.rejects(
    runOmniApiLabelCanary({
      ...baseInput,
      documentId: 'sentinel-document',
      label: 'production-label',
      confirmation: OMNI_API_WRITE_CANARY_CONFIRMATION,
      labelWasAbsent: true,
    }),
    /must start with omnikit-canary-/,
  );

  await assert.rejects(
    runOmniApiLabelCanary({
      ...baseInput,
      documentId: 'sentinel-document',
      label: 'omnikit-canary-contract-check',
      confirmation: OMNI_API_WRITE_CANARY_CONFIRMATION,
      labelWasAbsent: false,
    }),
    /not currently attached/,
  );
});

test('controlled write canary attaches and removes the temporary label', async () => {
  const calls: Array<{ url: string; method: string }> = [];
  const result = await runOmniApiLabelCanary({
    ...baseInput,
    documentId: 'sentinel/document',
    label: 'omnikit-canary-contract-check',
    confirmation: OMNI_API_WRITE_CANARY_CONFIRMATION,
    labelWasAbsent: true,
  }, {
    assertSafeUrl: async () => undefined,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), method: String(init?.method) });
      return init?.method === 'PUT'
        ? new Response('{}', { status: 200 })
        : new Response(null, { status: 204 });
    }) as typeof fetch,
  });

  assert.deepEqual(calls.map(({ method }) => method), ['PUT', 'DELETE']);
  assert.ok(calls.every(({ url }) => url.includes('/sentinel%2Fdocument/labels/omnikit-canary-contract-check')));
  assert.deepEqual(result, {
    attached: true,
    cleaned: true,
    attachStatus: 200,
    cleanupStatus: 204,
    failureClass: undefined,
  });
});

test('controlled write canary reports cleanup failure instead of claiming a clean round trip', async () => {
  const result = await runOmniApiLabelCanary({
    ...baseInput,
    documentId: 'sentinel-document',
    label: 'omnikit-canary-contract-check',
    confirmation: OMNI_API_WRITE_CANARY_CONFIRMATION,
    labelWasAbsent: true,
  }, {
    assertSafeUrl: async () => undefined,
    fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => (
      new Response('{}', { status: init?.method === 'PUT' ? 200 : 503 })
    )) as typeof fetch,
  });

  assert.equal(result.attached, true);
  assert.equal(result.cleaned, false);
  assert.equal(result.failureClass, 'transient');
});

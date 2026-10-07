import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { ApiError, listConnections, listFolders, listModels, patchGroup } from '../src/services/omniApi';
import { allowsAutomaticRetry, CONNECTION_INVENTORY_REQUEST_POLICY, MODEL_INVENTORY_REQUEST_POLICY, type ApiRequestPolicy } from '../src/services/apiRequestPolicy';
import { clearApiRequestTimings, getApiRequestTimings, startConnectionInventoryTiming, startModelInventoryTiming } from '../src/services/apiRequestTimings';

beforeEach(clearApiRequestTimings);
let sequence = 0;
const scope = () => ({ baseUrl: `https://inventory-${++sequence}.example.invalid`, apiKey: `fictional-key-${sequence}` });
const response = (body: unknown = { models: [] }, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Retry-After': '0.001' },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('explicit retry policy is logical, fail-closed for writes, and inventory remains single-attempt', () => {
  for (const policy of [MODEL_INVENTORY_REQUEST_POLICY, CONNECTION_INVENTORY_REQUEST_POLICY]) {
    assert.deepEqual(policy, { kind: 'read', retry: 'none' });
    assert.equal(Object.isFrozen(policy), true);
    assert.equal(allowsAutomaticRetry(policy), false);
  }
  assert.equal(allowsAutomaticRetry({ kind: 'read', retry: 'transient-http' }), true);
  assert.equal(allowsAutomaticRetry({ kind: 'write', retry: 'none' }), false);
  assert.equal(allowsAutomaticRetry({ kind: 'write', retry: 'transient-http' } as unknown as ApiRequestPolicy), false);
});

test('timings separate queue/spacing wait, fetch settlement, and whole-operation duration', async (t) => {
  let clock = 100;
  t.mock.method(performance, 'now', () => clock);
  const timing = startModelInventoryTiming();
  clock = 110;
  timing.queued();
  clock = 140;
  timing.dispatched();
  clock = 145;
  await timing.measureRequest(async () => { clock = 200; return response(); });
  timing.response(200);
  clock = 240; // Includes time after fetch, such as JSON decoding.
  timing.finish('success');
  assert.deepEqual(getApiRequestTimings(), [{
    operation: 'model-inventory', source: 'network', outcome: 'success',
    queueWaitMs: 30, requestMs: 55, totalMs: 140, attempts: 1, status: 200,
  }]);
});

test('timings are bounded, copied, clearable, and tolerate an unavailable clock', async (t) => {
  t.mock.method(performance, 'now', () => { throw new Error('Unavailable clock'); });
  for (let index = 0; index < 105; index += 1) {
    const timing = index % 2 === 0 ? startModelInventoryTiming() : startConnectionInventoryTiming();
    timing.cacheHit();
    timing.finish('success');
    timing.finish('error'); // A record cannot be emitted twice.
  }
  const snapshot = getApiRequestTimings();
  assert.equal(snapshot.length, 100);
  assert.deepEqual([...new Set(snapshot.map((sample) => sample.operation))].sort(), ['connection-inventory', 'model-inventory']);
  assert.equal(snapshot[0].totalMs, 0);
  snapshot[0].outcome = 'error';
  assert.equal(getApiRequestTimings()[0].outcome, 'success');
  clearApiRequestTimings();
  assert.deepEqual(getApiRequestTimings(), []);
  const { baseUrl, apiKey } = scope();
  t.mock.method(globalThis, 'fetch', async () => response());
  assert.deepEqual(await listModels(baseUrl, apiKey), { models: [] });
});

test('inventory preserves payload and caches without recording tenant or credential data', { timeout: 5000 }, async (t) => {
  const { baseUrl, apiKey } = scope();
  let calls = 0;
  const payload = { models: [{ id: 'private-model-id', name: 'Private model' }] };
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls += 1;
    assert.equal(url, '/api/list-models');
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), {
      base_url: baseUrl, api_key: apiKey, model_kind: 'SHARED', connection_id: 'private-connection-id', all_pages: true,
    });
    return response(payload);
  });
  const options = { modelKind: 'SHARED', connectionId: 'private-connection-id', allPages: true };
  assert.deepEqual(await listModels(baseUrl, apiKey, options), payload);
  assert.deepEqual(await listModels(baseUrl, apiKey, options), payload);
  assert.equal(calls, 1);
  const [network, cached] = getApiRequestTimings();
  assert.equal(network.source, 'network');
  assert.equal(network.attempts, 1);
  assert.ok(network.queueWaitMs !== null && network.queueWaitMs >= 0);
  assert.ok(network.requestMs !== null && network.requestMs >= 0);
  assert.equal(cached.source, 'cache');
  assert.equal(cached.attempts, 0);
  assert.equal(cached.queueWaitMs, null);
  assert.equal(cached.requestMs, null);
  assert.equal(cached.status, null);
  const serialized = JSON.stringify(getApiRequestTimings());
  for (const secret of [baseUrl, apiKey, 'private-model-id', 'Private model', 'private-connection-id', 'SHARED']) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.deepEqual(Object.keys(network).sort(), [
    'attempts', 'operation', 'outcome', 'queueWaitMs', 'requestMs', 'source', 'status', 'totalMs',
  ]);
});

test('simultaneous observers share one request and report no duplicate network timing', { timeout: 5000 }, async (t) => {
  const { baseUrl, apiKey } = scope();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls += 1; return response({ models: [{ id: 'example-model' }] }); });
  const results = await Promise.all([listModels(baseUrl, apiKey), listModels(baseUrl, apiKey)]);
  assert.equal(calls, 1);
  assert.deepEqual(results[0], results[1]);
  assert.notEqual(results[0], results[1], 'each observer parses its own response clone');
  const samples = getApiRequestTimings();
  assert.deepEqual(samples.map((sample) => sample.source).sort(), ['network', 'shared']);
  const shared = samples.find((sample) => sample.source === 'shared')!;
  assert.equal(shared.attempts, 0);
  assert.equal(shared.queueWaitMs, null);
  assert.equal(shared.requestMs, null);
  assert.equal(shared.status, 200);
});

test('host, credential, and option boundaries never share inventory requests or cached results', { timeout: 5000 }, async (t) => {
  const { baseUrl, apiKey } = scope();
  const tuples = [
    [baseUrl, apiKey, { modelKind: 'SHARED' }],
    [`${baseUrl}/other`, apiKey, { modelKind: 'SHARED' }],
    [baseUrl, `${apiKey}-rotated`, { modelKind: 'SHARED' }],
    [baseUrl, apiKey, { modelKind: 'WORKBOOK' }],
  ] as const;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    calls += 1;
    return response({ request: JSON.parse(String(init?.body)) });
  });
  const results = await Promise.all(tuples.map(([url, key, options]) => listModels(url, key, options)));
  assert.equal(calls, 4);
  assert.equal(getApiRequestTimings().every((sample) => sample.source === 'network'), true);
  const cached = await Promise.all(tuples.map(([url, key, options]) => listModels(url, key, options)));
  assert.deepEqual(results, cached);
  assert.equal(calls, 4);
});

for (const [inventory, loadInventory] of [['model', listModels], ['connection', listConnections]] as const) {
test(`${inventory} signal-owned requests stay independent and cancellation does not affect a sibling`, { timeout: 5000 }, async (t) => {
  const { baseUrl, apiKey } = scope();
  const controller = new AbortController();
  const sibling = new AbortController();
  const started = deferred<void>();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    calls += 1;
    if (init?.signal === controller.signal) {
      started.resolve();
      return new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(new DOMException('Canceled', 'AbortError')), { once: true });
      });
    }
    return response();
  });
  const canceled = assert.rejects(loadInventory(baseUrl, apiKey, { signal: controller.signal }), { name: 'AbortError' });
  const success = loadInventory(baseUrl, apiKey, { signal: sibling.signal });
  await started.promise;
  controller.abort();
  await canceled;
  assert.deepEqual(await success, { models: [] });
  assert.equal(calls, 2);
  assert.equal(getApiRequestTimings().every((sample) => sample.source === 'network'), true);
  assert.equal(getApiRequestTimings().every((sample) => sample.operation === `${inventory}-inventory`), true);
  assert.deepEqual(getApiRequestTimings().map((sample) => sample.outcome).sort(), ['aborted', 'success']);
});

test(`aborted queued ${inventory} inventory never dispatches and records no request duration`, { timeout: 5000 }, async (t) => {
  const blockerStarted = deferred<void>();
  const releaseBlockers = deferred<Response>();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    if (calls === 2) blockerStarted.resolve();
    return releaseBlockers.promise;
  });
  const blockers = [scope(), scope()].map(({ baseUrl, apiKey }) => loadInventory(baseUrl, apiKey));
  try {
    await blockerStarted.promise;
    const controller = new AbortController();
    const { baseUrl, apiKey } = scope();
    const pending = assert.rejects(loadInventory(baseUrl, apiKey, { signal: controller.signal }), { name: 'AbortError' });
    controller.abort();
    await pending;
    assert.equal(calls, 2);
    const sample = getApiRequestTimings()[0];
    assert.equal(sample.operation, `${inventory}-inventory`);
    assert.equal(sample.outcome, 'aborted');
    assert.equal(sample.attempts, 0);
    assert.equal(sample.requestMs, null);
    assert.ok(sample.queueWaitMs !== null && sample.queueWaitMs >= 0);
  } finally {
    releaseBlockers.resolve(response());
    await Promise.allSettled(blockers);
  }
});

test(`${inventory} inventory never retries rate limits, server errors, or lost responses and records safe outcomes`, { timeout: 5000 }, async (t) => {
  let calls = 0;
  let status = 429;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    if (status === 0) throw new TypeError('private-host-or-credential');
    return response({ error: 'private-host-or-credential' }, status);
  });
  for (status of [429, 503, 0]) {
    const { baseUrl, apiKey } = scope();
    await assert.rejects(loadInventory(baseUrl, apiKey, status === 503 ? { signal: new AbortController().signal } : {}),
      (error: unknown) => error instanceof ApiError && error.status === status);
  }
  assert.equal(calls, 3);
  assert.equal(getApiRequestTimings().every((sample) => sample.attempts === 1 && sample.outcome === 'error'), true);
  assert.equal(JSON.stringify(getApiRequestTimings()).includes('private-host-or-credential'), false);
});
}

test('connection inventory preserves its proxied GET and raw response while sharing and caching safely', { timeout: 5000 }, async (t) => {
  const { baseUrl, apiKey } = scope();
  const payload = [{ id: 'private-connection-id', name: 'Private connection', dialect: 'example' }];
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls += 1;
    assert.equal(url, '/api/omni-proxy');
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), {
      base_url: baseUrl, api_key: apiKey, method: 'GET', endpoint: '/v1/connections',
    });
    return response(payload);
  });
  const results = await Promise.all([listConnections(baseUrl, apiKey), listConnections(baseUrl, apiKey)]);
  assert.equal(calls, 1);
  assert.deepEqual(results, [payload, payload]);
  assert.notEqual(results[0], results[1]);
  const [network, shared] = [...getApiRequestTimings()].sort((a, b) => a.source.localeCompare(b.source));
  assert.equal(network.source, 'network');
  assert.equal(network.attempts, 1);
  assert.equal(shared.source, 'shared');
  assert.equal(shared.attempts, 0);
  assert.equal(shared.queueWaitMs, null);
  assert.equal(shared.requestMs, null);
  assert.deepEqual(await listConnections(baseUrl, apiKey), payload);
  // Preserve the existing warm-cache behavior even for an already canceled caller.
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await listConnections(baseUrl, apiKey, { signal: controller.signal }), payload);
  assert.equal(calls, 1);
  const samples = getApiRequestTimings();
  assert.equal(samples.every((sample) => sample.operation === 'connection-inventory'), true);
  assert.equal(samples[3].source, 'cache');
  assert.equal(samples[3].attempts, 0);
  assert.equal(samples[3].requestMs, null);
  const serialized = JSON.stringify(samples);
  for (const secret of [baseUrl, apiKey, 'private-connection-id', 'Private connection', '/v1/connections']) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('connection cache and in-flight work stay separate across hosts and credentials', { timeout: 5000 }, async (t) => {
  const original = scope();
  const tuples = [original, scope(), { ...original, apiKey: `${original.apiKey}-rotated` }];
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    calls += 1;
    return response({ request: JSON.parse(String(init?.body)) });
  });
  const results = await Promise.all(tuples.map(({ baseUrl, apiKey }) => listConnections(baseUrl, apiKey)));
  assert.equal(calls, 3);
  assert.equal(getApiRequestTimings().every((sample) => sample.source === 'network'), true);
  const cached = await Promise.all(tuples.map(({ baseUrl, apiKey }) => listConnections(baseUrl, apiKey)));
  assert.deepEqual(cached, results);
  assert.equal(calls, 3);
});

for (const completionOrder of ['stale-first', 'fresh-first'] as const) {
  test(`connection force refresh preserves its generation when responses complete ${completionOrder}`, { timeout: 5000 }, async (t) => {
    const { baseUrl, apiKey } = scope();
    const staleStarted = deferred<void>();
    const freshStarted = deferred<void>();
    const staleResponse = deferred<Response>();
    const freshResponse = deferred<Response>();
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      calls += 1;
      assert.ok(calls <= 2);
      if (calls === 1) { staleStarted.resolve(); return staleResponse.promise; }
      freshStarted.resolve();
      return freshResponse.promise;
    });
    const stale = listConnections(baseUrl, apiKey);
    await staleStarted.promise;
    const fresh = listConnections(baseUrl, apiKey, { forceRefresh: true });
    await freshStarted.promise;
    const joined = listConnections(baseUrl, apiKey);
    if (completionOrder === 'stale-first') {
      staleResponse.resolve(response([{ id: 'stale' }]));
      await stale;
      freshResponse.resolve(response([{ id: 'fresh' }]));
    } else {
      freshResponse.resolve(response([{ id: 'fresh' }]));
      await fresh;
      staleResponse.resolve(response([{ id: 'stale' }]));
    }
    assert.deepEqual(await stale, [{ id: 'stale' }]);
    assert.deepEqual(await fresh, [{ id: 'fresh' }]);
    assert.deepEqual(await joined, [{ id: 'fresh' }]);
    assert.deepEqual(await listConnections(baseUrl, apiKey), [{ id: 'fresh' }]);
    assert.equal(calls, 2);
    assert.deepEqual(getApiRequestTimings().map((sample) => sample.source).sort(), ['cache', 'network', 'network', 'shared']);
  });
}

test('legacy read retries and explicit no-retry writes retain their behavior and stay uninstrumented', { timeout: 5000 }, async (t) => {
  let folderCalls = 0;
  let writeCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url === '/api/list-folders') {
      folderCalls += 1;
      return folderCalls === 1 ? response({}, 503) : response({ folders: [] });
    }
    assert.equal(url, '/api/manage-groups');
    writeCalls += 1;
    return response({}, 503);
  });
  const { baseUrl, apiKey } = scope();
  assert.deepEqual(await listFolders(baseUrl, apiKey), { folders: [] });
  await assert.rejects(patchGroup(baseUrl, apiKey, 'example-group', { Operations: [] }),
    (error: unknown) => error instanceof ApiError && error.status === 503);
  assert.equal(folderCalls, 2);
  assert.equal(writeCalls, 1);
  assert.deepEqual(getApiRequestTimings(), []);
});

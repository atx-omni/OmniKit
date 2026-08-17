import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import {
  clearReadThroughCache,
  readThroughCacheResult,
} from '../server/services/readThroughCache';

afterEach(() => {
  clearReadThroughCache();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

test('tenant inventory coalesces concurrent readers and preserves independent cancellation', async () => {
  const upstream = deferred<{ documentIds: string[] }>();
  const firstController = new AbortController();
  const secondController = new AbortController();
  let loaderCalls = 0;
  let upstreamSignal: AbortSignal | undefined;
  const loader = (signal: AbortSignal) => {
    loaderCalls += 1;
    upstreamSignal = signal;
    return upstream.promise;
  };

  const first = readThroughCacheResult('example-tenant:credential-a:documents', loader, {
    signal: firstController.signal,
  });
  const second = readThroughCacheResult('example-tenant:credential-a:documents', loader, {
    signal: secondController.signal,
  });
  await Promise.resolve();

  assert.equal(loaderCalls, 1);
  firstController.abort(new DOMException('First reader left.', 'AbortError'));
  await assert.rejects(first, isAbortError);
  assert.equal(upstreamSignal?.aborted, false, 'one cancelled reader must not cancel a shared tenant crawl');

  upstream.resolve({ documentIds: ['example-document-a', 'example-document-b'] });
  const shared = await second;
  assert.deepEqual(shared.value.documentIds, ['example-document-a', 'example-document-b']);
  assert.equal(shared.cache.status, 'shared');
  assert.equal(shared.cache.fresh, true);

  const cached = await readThroughCacheResult(
    'example-tenant:credential-a:documents',
    async () => {
      throw new Error('A fresh cache hit must not start another crawl.');
    },
  );
  assert.equal(cached.cache.status, 'hit');
  assert.equal(loaderCalls, 1);
});

test('tenant inventory aborts its upstream crawl after every subscriber cancels', async () => {
  const firstController = new AbortController();
  const secondController = new AbortController();
  let loaderCalls = 0;
  let upstreamSignal: AbortSignal | undefined;
  const loader = (signal: AbortSignal) => {
    loaderCalls += 1;
    upstreamSignal = signal;
    return new Promise<{ complete: true }>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };

  const first = readThroughCacheResult('example-tenant:all-cancelled', loader, {
    signal: firstController.signal,
  });
  const second = readThroughCacheResult('example-tenant:all-cancelled', loader, {
    signal: secondController.signal,
  });
  await Promise.resolve();

  firstController.abort(new DOMException('First reader left.', 'AbortError'));
  secondController.abort(new DOMException('Second reader left.', 'AbortError'));

  await assert.rejects(first, isAbortError);
  await assert.rejects(second, isAbortError);
  assert.equal(loaderCalls, 1);
  assert.equal(upstreamSignal?.aborted, true);
});

test('a retry after the sole subscriber cancels starts a new generation instead of joining the aborted crawl', async () => {
  const firstController = new AbortController();
  const upstreamSignals: AbortSignal[] = [];
  let loaderCalls = 0;
  const loader = async (signal: AbortSignal) => {
    loaderCalls += 1;
    upstreamSignals.push(signal);
    if (loaderCalls === 2) {
      return { complete: true, documentIds: ['example-document-retry'] };
    }
    return new Promise<{ complete: true; documentIds: string[] }>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };

  const cancelled = readThroughCacheResult('example-tenant:cancel-then-retry', loader, {
    signal: firstController.signal,
  });
  await Promise.resolve();
  assert.equal(loaderCalls, 1);

  firstController.abort(new DOMException('The only reader left.', 'AbortError'));
  await assert.rejects(cancelled, isAbortError);
  const retry = await readThroughCacheResult('example-tenant:cancel-then-retry', loader);

  assert.equal(loaderCalls, 2);
  assert.equal(upstreamSignals[0]?.aborted, true);
  assert.equal(upstreamSignals[1]?.aborted, false);
  assert.equal(retry.cache.status, 'miss');
  assert.deepEqual(retry.value.documentIds, ['example-document-retry']);
});

test('tenant inventory TTL begins only after a complete crawl resolves', async (t) => {
  let now = 1_000;
  t.mock.method(Date, 'now', () => now);
  const crawl = deferred<{ complete: true; documentIds: string[] }>();
  let loaderCalls = 0;
  const first = readThroughCacheResult(
    'example-tenant:completion-ttl',
    async () => {
      loaderCalls += 1;
      return crawl.promise;
    },
    { ttlMs: 50 },
  );

  now = 50_000;
  crawl.resolve({ complete: true, documentIds: ['example-document-a'] });
  const completed = await first;
  assert.equal(completed.cache.status, 'miss');
  assert.equal(completed.cache.fetchedAt, new Date(50_000).toISOString());
  assert.equal(completed.cache.expiresAt, new Date(50_050).toISOString());

  now = 50_049;
  const hit = await readThroughCacheResult(
    'example-tenant:completion-ttl',
    async () => {
      loaderCalls += 1;
      return { complete: true as const, documentIds: ['unexpected'] };
    },
    { ttlMs: 50 },
  );
  assert.equal(hit.cache.status, 'hit');
  assert.equal(hit.cache.ageMs, 49);
  assert.equal(loaderCalls, 1);

  now = 50_050;
  const refreshed = await readThroughCacheResult(
    'example-tenant:completion-ttl',
    async () => {
      loaderCalls += 1;
      return { complete: true as const, documentIds: ['example-document-b'] };
    },
    { ttlMs: 50 },
  );
  assert.equal(refreshed.cache.status, 'miss');
  assert.deepEqual(refreshed.value.documentIds, ['example-document-b']);
  assert.equal(loaderCalls, 2);
});

test('failed or incomplete tenant crawls are never cached as a complete catalog', async () => {
  let loaderCalls = 0;
  await assert.rejects(
    readThroughCacheResult('example-tenant:complete-only', async () => {
      loaderCalls += 1;
      throw new Error('Pagination ended before the reported catalog total.');
    }),
    /Pagination ended/,
  );

  const retry = await readThroughCacheResult('example-tenant:complete-only', async () => {
    loaderCalls += 1;
    return { complete: true, documentIds: ['example-document-a'] };
  });
  assert.equal(loaderCalls, 2);
  assert.equal(retry.cache.status, 'miss');
  assert.equal(retry.value.complete, true);
});

test('tenant inventory cache keys preserve saved-credential boundaries', async () => {
  let loaderCalls = 0;
  const load = async () => {
    loaderCalls += 1;
    return { complete: true, documentIds: ['example-document-a'] };
  };

  const credentialA = await readThroughCacheResult('example-tenant:credential-revision-a:documents', load);
  const credentialB = await readThroughCacheResult('example-tenant:credential-revision-b:documents', load);
  const credentialAHit = await readThroughCacheResult('example-tenant:credential-revision-a:documents', load);

  assert.equal(credentialA.cache.status, 'miss');
  assert.equal(credentialB.cache.status, 'miss');
  assert.equal(credentialAHit.cache.status, 'hit');
  assert.equal(loaderCalls, 2);
});

test('explicit force refresh starts one new canonical crawl that normal readers share', async () => {
  const key = 'example-tenant:credential-a:force-refresh';
  const refreshCrawl = deferred<{ complete: true; generation: number }>();
  let loaderCalls = 0;
  const load = async () => {
    loaderCalls += 1;
    if (loaderCalls === 2) return refreshCrawl.promise;
    return { complete: true, generation: loaderCalls };
  };

  const initial = await readThroughCacheResult(key, load);
  const reused = await readThroughCacheResult(key, load);
  assert.equal(initial.cache.status, 'miss');
  assert.equal(reused.cache.status, 'hit');
  assert.equal(loaderCalls, 1);

  const forcedRefresh = readThroughCacheResult(key, load, { forceRefresh: true });
  const normalReader = readThroughCacheResult(key, load);
  await Promise.resolve();
  assert.equal(loaderCalls, 2);

  refreshCrawl.resolve({ complete: true, generation: 2 });
  const [refreshed, shared] = await Promise.all([forcedRefresh, normalReader]);
  assert.equal(refreshed.cache.status, 'miss');
  assert.equal(refreshed.value.generation, 2);
  assert.equal(shared.cache.status, 'shared');
  assert.equal(shared.value.generation, 2);

  const refreshedHit = await readThroughCacheResult(key, load);
  assert.equal(refreshedHit.cache.status, 'hit');
  assert.equal(refreshedHit.value.generation, 2);
  assert.equal(loaderCalls, 2);
});

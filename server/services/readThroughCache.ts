const DEFAULT_TTL_MS = 180_000;
const MAX_ENTRIES = 250;

interface CacheEntry<T> {
  storedAt: number;
  expiresAt: number;
  value: T;
}

interface InFlightEntry<T> {
  controller: AbortController;
  generation: number;
  promise: Promise<CacheEntry<T>>;
  settled: boolean;
  subscribers: number;
}

export type ReadThroughCacheStatus = 'hit' | 'miss' | 'shared';

export interface ReadThroughCacheMetadata {
  status: ReadThroughCacheStatus;
  fetchedAt: string;
  expiresAt: string;
  ageMs: number;
  fresh: true;
}

export interface ReadThroughCacheResult<T> {
  value: T;
  cache: ReadThroughCacheMetadata;
}

export interface ReadThroughCacheOptions {
  ttlMs?: number;
  enabled?: boolean;
  signal?: AbortSignal;
  forceRefresh?: boolean;
}

const cache = new Map<string, CacheEntry<unknown>>();
const inFlight = new Map<string, InFlightEntry<unknown>>();
const generations = new Map<string, number>();

function cloneValue<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      // Fall through to JSON cloning for plain API payloads.
    }
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted.', 'AbortError');
}

function metadata(entry: CacheEntry<unknown>, status: ReadThroughCacheStatus): ReadThroughCacheMetadata {
  return {
    status,
    fetchedAt: new Date(entry.storedAt).toISOString(),
    expiresAt: new Date(entry.expiresAt).toISOString(),
    ageMs: Math.max(0, Date.now() - entry.storedAt),
    fresh: true,
  };
}

function pruneExpired(now = Date.now()) {
  for (const [key, entry] of cache.entries()) {
    if (entry.expiresAt <= now) {
      cache.delete(key);
      if (!inFlight.has(key)) generations.delete(key);
    }
  }
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    cache.delete(oldest);
    if (!inFlight.has(oldest)) generations.delete(oldest);
  }
}

function generationFor(key: string): number {
  return generations.get(key) ?? 0;
}

function startLoad<T>(
  key: string,
  loader: (signal: AbortSignal) => Promise<T>,
  ttlMs: number,
): InFlightEntry<T> {
  const controller = new AbortController();
  const generation = generationFor(key);
  const entry = {
    controller,
    generation,
    settled: false,
    subscribers: 0,
  } as InFlightEntry<T>;

  entry.promise = Promise.resolve()
    .then(() => loader(controller.signal))
    .then((value) => {
      if (controller.signal.aborted) throw abortError(controller.signal);
      const storedAt = Date.now();
      const completed: CacheEntry<T> = {
        storedAt,
        expiresAt: storedAt + ttlMs,
        value: cloneValue(value),
      };
      if (generationFor(key) === generation) {
        cache.set(key, completed as CacheEntry<unknown>);
        pruneExpired(storedAt);
      }
      return completed;
    })
    .finally(() => {
      entry.settled = true;
      if (inFlight.get(key) === entry as InFlightEntry<unknown>) inFlight.delete(key);
      if (
        generationFor(key) === generation
        && !cache.has(key)
        && !inFlight.has(key)
      ) generations.delete(key);
    });

  // Each subscriber observes the promise. This guard also prevents a loader
  // rejection from becoming unhandled during a same-tick invalidation.
  void entry.promise.catch(() => undefined);
  inFlight.set(key, entry as InFlightEntry<unknown>);
  return entry;
}

async function waitForLoad<T>(
  key: string,
  entry: InFlightEntry<T>,
  status: Extract<ReadThroughCacheStatus, 'miss' | 'shared'>,
  signal?: AbortSignal,
): Promise<ReadThroughCacheResult<T>> {
  if (signal?.aborted) throw abortError(signal);
  entry.subscribers += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    entry.subscribers = Math.max(0, entry.subscribers - 1);
    if (!entry.settled && entry.subscribers === 0) {
      if (inFlight.get(key) === entry as InFlightEntry<unknown>) inFlight.delete(key);
      entry.controller.abort(new DOMException('All cache subscribers cancelled.', 'AbortError'));
    }
  };

  return new Promise<ReadThroughCacheResult<T>>((resolve, reject) => {
    const onAbort = () => {
      signal?.removeEventListener('abort', onAbort);
      release();
      reject(abortError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    entry.promise.then(
      (completed) => {
        signal?.removeEventListener('abort', onAbort);
        if (released) return;
        release();
        resolve({
          value: cloneValue(completed.value),
          cache: metadata(completed, status),
        });
      },
      (error: unknown) => {
        signal?.removeEventListener('abort', onAbort);
        if (released) return;
        release();
        reject(error);
      },
    );
  });
}

export async function readThroughCacheResult<T>(
  key: string,
  loader: (signal: AbortSignal) => Promise<T>,
  options: ReadThroughCacheOptions = {},
): Promise<ReadThroughCacheResult<T>> {
  if (options.signal?.aborted) throw abortError(options.signal);
  const ttlMs = Number.isFinite(options.ttlMs)
    ? Math.max(1, Math.floor(options.ttlMs!))
    : DEFAULT_TTL_MS;

  if (options.enabled === false) {
    const value = await loader(options.signal ?? new AbortController().signal);
    const storedAt = Date.now();
    const entry: CacheEntry<T> = { storedAt, expiresAt: storedAt + ttlMs, value };
    return { value: cloneValue(value), cache: metadata(entry, 'miss') };
  }

  const now = Date.now();
  pruneExpired(now);
  if (options.forceRefresh === true) {
    const refreshing = inFlight.get(key) as InFlightEntry<T> | undefined;
    if (refreshing) return waitForLoad(key, refreshing, 'shared', options.signal);
    // There is no active generation to race. Dropping only the completed value
    // makes the refresh caller the canonical new single-flight loader.
    cache.delete(key);
  }
  const existing = cache.get(key) as CacheEntry<T> | undefined;
  if (existing && existing.expiresAt > now) {
    return {
      value: cloneValue(existing.value),
      cache: metadata(existing, 'hit'),
    };
  }

  const shared = inFlight.get(key) as InFlightEntry<T> | undefined;
  if (shared) return waitForLoad(key, shared, 'shared', options.signal);

  return waitForLoad(key, startLoad(key, loader, ttlMs), 'miss', options.signal);
}

export async function readThroughCache<T>(
  key: string,
  loader: () => Promise<T>,
  options: ReadThroughCacheOptions = {},
): Promise<T> {
  const result = await readThroughCacheResult(key, () => loader(), options);
  return result.value;
}

export function clearReadThroughCache(prefix?: string): void {
  const matches = (key: string) => !prefix || key.startsWith(prefix);
  const keys = new Set([
    ...cache.keys(),
    ...inFlight.keys(),
    ...generations.keys(),
  ].filter(matches));

  for (const key of keys) {
    cache.delete(key);
    generations.set(key, generationFor(key) + 1);
    const pending = inFlight.get(key);
    if (pending) {
      inFlight.delete(key);
      const invalidatedGeneration = generationFor(key);
      pending.controller.abort(new DOMException('Cache entry invalidated.', 'AbortError'));
      void pending.promise.finally(() => {
        if (
          generationFor(key) === invalidatedGeneration
          && !cache.has(key)
          && !inFlight.has(key)
        ) generations.delete(key);
      }).catch(() => undefined);
    } else {
      generations.delete(key);
    }
  }
}

export interface ApiRequestTimingSample {
  operation: 'model-inventory' | 'connection-inventory';
  source: 'network' | 'cache' | 'shared';
  outcome: 'success' | 'error' | 'aborted';
  /** Slot and spacing wait; null when this caller did not own a request. */
  queueWaitMs: number | null;
  /** Fetch settlement (headers on success), excluding body parsing and backoff. */
  requestMs: number | null;
  /** Whole caller operation, including body parsing or waiting on shared work. */
  totalMs: number;
  attempts: number;
  status: number | null;
}

const MAX_SAMPLES = 100;
const samples: ApiRequestTimingSample[] = [];

function now(): number {
  try {
    return performance.now();
  } catch {
    // Diagnostics must not break a request when timing is unavailable.
    return 0;
  }
}

function elapsed(start: number): number {
  const value = now() - start;
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/** Local, bounded diagnostics only. Never stores URLs, scope keys, or payloads. */
export function getApiRequestTimings(): ApiRequestTimingSample[] {
  return samples.map((sample) => ({ ...sample }));
}

export function clearApiRequestTimings(): void {
  samples.length = 0;
}

export interface ApiRequestTiming {
  cacheHit(): void;
  shared(): void;
  queued(): void;
  dispatched(): void;
  response(status: number): void;
  measureRequest(work: () => Promise<Response>): Promise<Response>;
  finish(outcome: ApiRequestTimingSample['outcome']): void;
}

export function startModelInventoryTiming(): ApiRequestTiming {
  return startInventoryTiming('model-inventory');
}

export function startConnectionInventoryTiming(): ApiRequestTiming {
  return startInventoryTiming('connection-inventory');
}

function startInventoryTiming(operation: ApiRequestTimingSample['operation']): ApiRequestTiming {
  const started = now();
  let source: ApiRequestTimingSample['source'] = 'network';
  let queuedAt: number | undefined;
  let queueWaitMs: number | null = null;
  let requestMs: number | null = null;
  let attempts = 0;
  let status: number | null = null;
  let finished = false;

  return {
    cacheHit() { source = 'cache'; },
    shared() { source = 'shared'; },
    queued() { queuedAt = now(); },
    dispatched() { queueWaitMs = queuedAt === undefined ? 0 : elapsed(queuedAt); },
    response(value) {
      if (Number.isInteger(value) && value >= 100 && value <= 599) status = value;
    },
    async measureRequest(work) {
      const start = now();
      attempts += 1;
      try {
        return await work();
      } finally {
        requestMs = (requestMs ?? 0) + elapsed(start);
      }
    },
    finish(outcome) {
      if (finished) return;
      finished = true;
      samples.push({
        operation, source, outcome,
        queueWaitMs: queueWaitMs ?? (queuedAt === undefined ? null : elapsed(queuedAt)),
        requestMs, totalMs: elapsed(started), attempts, status,
      });
      if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
    },
  };
}

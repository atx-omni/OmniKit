export interface AsyncJobConnection {
  baseUrl: string;
  apiKey: string;
}

export interface AsyncJobScope {
  key: string;
  isCurrent: (key: string) => boolean;
}

export interface AsyncJobTransport<TCreateInput, TJob, TResult> {
  create: (
    connection: Readonly<AsyncJobConnection>,
    input: TCreateInput,
    signal: AbortSignal,
  ) => Promise<TJob>;
  getJob: (
    connection: Readonly<AsyncJobConnection>,
    jobId: string,
    signal: AbortSignal,
  ) => Promise<TJob>;
  getResult: (
    connection: Readonly<AsyncJobConnection>,
    jobId: string,
    signal: AbortSignal,
  ) => Promise<TResult>;
  cancel?: (
    connection: Readonly<AsyncJobConnection>,
    jobId: string,
    signal: AbortSignal,
  ) => Promise<unknown>;
}

export interface RunAsyncJobLifecycleInput<TCreateInput, TJob, TResult> {
  connection: AsyncJobConnection;
  createInput: TCreateInput;
  transport: AsyncJobTransport<TCreateInput, TJob, TResult>;
  getJobId: (job: TJob) => string;
  getState: (job: TJob) => string;
  isTerminalState: (state: string) => boolean;
  isSuccessfulState: (state: string) => boolean;
  isResultReady: (result: TResult, terminalJob: TJob) => boolean;
  fallbackResult?: (terminalJob: TJob) => TResult | null | undefined;
  isCreateAcceptanceUnknown?: (error: unknown) => boolean;
  shouldRetryRead?: (error: unknown, phase: 'poll' | 'result') => boolean;
  signal?: AbortSignal;
  scope?: AsyncJobScope;
  deadlineMs?: number;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
  maxConsecutivePollFailures?: number;
  resultRetryIntervalMs?: number;
  maxResultAttempts?: number;
  scopeCheckIntervalMs?: number;
  cancelDeadlineMs?: number;
  cancelOnCallerAbort?: boolean;
  onCreated?: (jobId: string, created: TJob) => void;
  onPoll?: (attempt: number, latest: TJob) => void;
  onPollRetry?: (attempt: number, error: unknown) => void;
  onResultRetry?: (attempt: number, error?: unknown) => void;
  onTerminal?: (jobId: string, state: string, terminalJob: TJob) => void;
}

export interface AsyncJobLifecycleOutcome<TJob, TResult> {
  jobId: string;
  created: TJob;
  terminalJob: TJob;
  result: TResult;
  connection: Readonly<AsyncJobConnection>;
}

export class AsyncJobLifecycleError extends Error {
  readonly jobId: string;

  constructor(message: string, jobId = '') {
    super(message);
    this.name = 'AsyncJobLifecycleError';
    this.jobId = jobId;
  }
}

export class AsyncJobCreateAcceptanceUnknownError extends AsyncJobLifecycleError {
  readonly underlyingError: unknown;

  constructor(cause?: unknown) {
    super('The job submission outcome is unknown. The create request was not resubmitted.');
    this.name = 'AsyncJobCreateAcceptanceUnknownError';
    this.underlyingError = cause;
  }
}

export class AsyncJobCancelledError extends AsyncJobLifecycleError {
  constructor(jobId = '') {
    super('The job run was cancelled.', jobId);
    this.name = 'AsyncJobCancelledError';
  }
}

export class AsyncJobDeadlineError extends AsyncJobLifecycleError {
  constructor(jobId = '') {
    super('The job did not finish before the overall deadline.', jobId);
    this.name = 'AsyncJobDeadlineError';
  }
}

export class AsyncJobStaleScopeError extends AsyncJobLifecycleError {
  constructor(jobId = '') {
    super('The job result was rejected because its execution scope changed.', jobId);
    this.name = 'AsyncJobStaleScopeError';
  }
}

export class AsyncJobReadUnavailableError extends AsyncJobLifecycleError {
  readonly phase: 'poll' | 'result';
  readonly underlyingError: unknown;

  constructor(phase: 'poll' | 'result', jobId: string, cause?: unknown) {
    super(`The job ${phase === 'poll' ? 'status' : 'result'} could not be confirmed.`, jobId);
    this.name = 'AsyncJobReadUnavailableError';
    this.phase = phase;
    this.underlyingError = cause;
  }
}

export class AsyncJobTerminalStateError extends AsyncJobLifecycleError {
  readonly state: string;

  constructor(jobId: string, state: string) {
    super(`The job ended in ${state || 'an unknown terminal'} state.`, jobId);
    this.name = 'AsyncJobTerminalStateError';
    this.state = state;
  }
}

type StopReason = 'caller' | 'deadline' | 'scope';

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value || 0) > 0 ? Math.floor(value as number) : fallback;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value || 0) >= 0 ? Math.floor(value as number) : fallback;
}

function normalizeState(value: string): string {
  return value.trim().toUpperCase();
}

/**
 * Runs the contract-neutral parts of an asynchronous write job safely.
 *
 * The create call is issued once. Only status and result reads may retry. The
 * connection is copied before submission so cancellation cannot drift to a new
 * tenant or credential if the caller's UI state changes during the run.
 */
export async function runAsyncJobLifecycle<TCreateInput, TJob, TResult>(
  input: RunAsyncJobLifecycleInput<TCreateInput, TJob, TResult>,
): Promise<AsyncJobLifecycleOutcome<TJob, TResult>> {
  const originalConnection = Object.freeze({
    baseUrl: input.connection.baseUrl,
    apiKey: input.connection.apiKey,
  });
  const deadlineMs = positiveInteger(input.deadlineMs, 4 * 60_000);
  const pollIntervalMs = nonNegativeInteger(input.pollIntervalMs, 2_000);
  const maxPollAttempts = positiveInteger(input.maxPollAttempts, 120);
  const maxConsecutivePollFailures = positiveInteger(input.maxConsecutivePollFailures, 5);
  const resultRetryIntervalMs = nonNegativeInteger(input.resultRetryIntervalMs, 2_000);
  const maxResultAttempts = positiveInteger(input.maxResultAttempts, 8);
  const scopeCheckIntervalMs = Math.max(25, positiveInteger(input.scopeCheckIntervalMs, 250));
  const cancelDeadlineMs = positiveInteger(input.cancelDeadlineMs, 10_000);
  const shouldRetryRead = input.shouldRetryRead || (() => false);
  const lifecycleController = new AbortController();
  let stopReason: StopReason | null = null;
  let jobId = '';
  let terminalReached = false;
  let createStarted = false;
  let cancellationAttempted = false;

  const stop = (reason: StopReason) => {
    if (stopReason) return;
    stopReason = reason;
    lifecycleController.abort();
  };
  const scopeIsCurrent = () => {
    try {
      return !input.scope || input.scope.isCurrent(input.scope.key);
    } catch {
      return false;
    }
  };
  const onCallerAbort = () => stop('caller');
  if (input.signal?.aborted) stop('caller');
  else input.signal?.addEventListener('abort', onCallerAbort, { once: true });

  const deadlineTimer = globalThis.setTimeout(() => stop('deadline'), deadlineMs);
  const scopeTimer = input.scope
    ? globalThis.setInterval(() => {
        if (!scopeIsCurrent()) stop('scope');
      }, scopeCheckIntervalMs)
    : null;

  function stopError(): AsyncJobLifecycleError {
    if (stopReason === 'deadline') return new AsyncJobDeadlineError(jobId);
    if (stopReason === 'scope') return new AsyncJobStaleScopeError(jobId);
    return new AsyncJobCancelledError(jobId);
  }

  function assertActive(): void {
    if (!stopReason && !scopeIsCurrent()) stop('scope');
    if (stopReason || lifecycleController.signal.aborted) throw stopError();
  }

  async function boundedCall<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    assertActive();
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        reject(stopError());
      };
      lifecycleController.signal.addEventListener('abort', onAbort, { once: true });
      let operationPromise: Promise<T>;
      try {
        operationPromise = operation(lifecycleController.signal);
      } catch (error) {
        settled = true;
        lifecycleController.signal.removeEventListener('abort', onAbort);
        reject(error);
        return;
      }
      operationPromise.then(
        (value) => {
          if (settled) return;
          settled = true;
          lifecycleController.signal.removeEventListener('abort', onAbort);
          try {
            assertActive();
            resolve(value);
          } catch (error) {
            reject(error);
          }
        },
        (error) => {
          if (settled) return;
          settled = true;
          lifecycleController.signal.removeEventListener('abort', onAbort);
          reject(stopReason ? stopError() : error);
        },
      );
    });
  }

  async function wait(ms: number): Promise<void> {
    if (ms <= 0) {
      assertActive();
      return;
    }
    await boundedCall((signal) => new Promise<void>((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        globalThis.clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        reject(stopError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }));
  }

  async function cancelOriginalJob(): Promise<void> {
    if (!jobId || terminalReached || cancellationAttempted || !input.transport.cancel) return;
    cancellationAttempted = true;
    const cancelController = new AbortController();
    const cancelTimer = globalThis.setTimeout(() => cancelController.abort(), cancelDeadlineMs);
    try {
      await input.transport.cancel(originalConnection, jobId, cancelController.signal);
    } catch {
      // Cancellation is best effort. The original lifecycle error remains authoritative.
    } finally {
      globalThis.clearTimeout(cancelTimer);
      cancelController.abort();
    }
  }

  try {
    assertActive();
    let created: TJob;
    try {
      createStarted = true;
      created = await boundedCall((signal) => input.transport.create(
        originalConnection,
        input.createInput,
        signal,
      ));
    } catch (error) {
      if (
        createStarted
        && (
          error instanceof AsyncJobLifecycleError
          || (input.isCreateAcceptanceUnknown?.(error) ?? true)
        )
      ) {
        throw new AsyncJobCreateAcceptanceUnknownError(error);
      }
      throw error;
    }

    jobId = input.getJobId(created).trim();
    if (!jobId) throw new AsyncJobCreateAcceptanceUnknownError();
    input.onCreated?.(jobId, created);

    let latest = created;
    let state = normalizeState(input.getState(latest));
    let pollAttempts = 0;
    let consecutivePollFailures = 0;

    while (!input.isTerminalState(state)) {
      if (pollAttempts >= maxPollAttempts) throw new AsyncJobDeadlineError(jobId);
      if (pollIntervalMs > 0) await wait(pollIntervalMs);
      pollAttempts += 1;
      try {
        latest = await boundedCall((signal) => input.transport.getJob(
          originalConnection,
          jobId,
          signal,
        ));
        consecutivePollFailures = 0;
        state = normalizeState(input.getState(latest));
        input.onPoll?.(pollAttempts, latest);
      } catch (error) {
        if (error instanceof AsyncJobLifecycleError) throw error;
        consecutivePollFailures += 1;
        if (
          !shouldRetryRead(error, 'poll')
          || consecutivePollFailures > maxConsecutivePollFailures
          || pollAttempts >= maxPollAttempts
        ) {
          throw new AsyncJobReadUnavailableError('poll', jobId, error);
        }
        input.onPollRetry?.(pollAttempts, error);
      }
    }

    terminalReached = true;
    input.onTerminal?.(jobId, state, latest);
    if (!input.isSuccessfulState(state)) throw new AsyncJobTerminalStateError(jobId, state);

    let lastResultError: unknown;
    for (let resultAttempt = 1; resultAttempt <= maxResultAttempts; resultAttempt += 1) {
      try {
        const result = await boundedCall((signal) => input.transport.getResult(
          originalConnection,
          jobId,
          signal,
        ));
        if (input.isResultReady(result, latest)) {
          return { jobId, created, terminalJob: latest, result, connection: originalConnection };
        }
        lastResultError = undefined;
      } catch (error) {
        if (error instanceof AsyncJobLifecycleError) throw error;
        lastResultError = error;
        if (!shouldRetryRead(error, 'result')) {
          throw new AsyncJobReadUnavailableError('result', jobId, error);
        }
      }
      if (resultAttempt < maxResultAttempts) {
        input.onResultRetry?.(resultAttempt, lastResultError);
        await wait(resultRetryIntervalMs);
      }
    }

    const fallback = input.fallbackResult?.(latest);
    if (fallback != null && input.isResultReady(fallback, latest)) {
      return { jobId, created, terminalJob: latest, result: fallback, connection: originalConnection };
    }
    throw new AsyncJobReadUnavailableError('result', jobId, lastResultError);
  } catch (error) {
    if (
      (error instanceof AsyncJobCancelledError && input.cancelOnCallerAbort !== false)
      || error instanceof AsyncJobDeadlineError
      || error instanceof AsyncJobStaleScopeError
    ) {
      await cancelOriginalJob();
    }
    throw error;
  } finally {
    globalThis.clearTimeout(deadlineTimer);
    if (scopeTimer !== null) globalThis.clearInterval(scopeTimer);
    input.signal?.removeEventListener('abort', onCallerAbort);
  }
}

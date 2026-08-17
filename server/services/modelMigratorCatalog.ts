import { createHash } from 'node:crypto';

import type { SavedInstance } from './nativeVault';
import {
  OmniClient,
  OmniClientError,
  OmniPaginationError,
  OmniRequestDeadlineError,
  type OmniConnectionRecord,
  type OmniDocumentRecord,
  type OmniModelRecord,
} from './omniClient';
import { clearReadThroughCache, readThroughCacheResult } from './readThroughCache';

export const MODEL_MIGRATOR_CATALOG_CACHE_PREFIX = 'model-migrator-catalog:';
export const MODEL_MIGRATOR_CATALOG_TTL_MS = 60_000;
export const MODEL_MIGRATOR_INTERACTIVE_DEADLINE_MS = 30_000;
export const MODEL_MIGRATOR_UPSTREAM_REQUEST_TIMEOUT_MS = 10_000;
export const MODEL_MIGRATOR_MAX_READ_RETRIES = 1;
export const MODEL_MIGRATOR_INSTANCE_CONCURRENCY = 2;
export const MODEL_MIGRATOR_SCHEMA_CONCURRENCY = 4;

export type ModelMigratorFailureCode =
  | 'MODEL_MIGRATOR_REQUEST_CANCELLED'
  | 'MODEL_MIGRATOR_READINESS_TIMEOUT'
  | 'MODEL_MIGRATOR_UPSTREAM_TIMEOUT'
  | 'MODEL_MIGRATOR_UPSTREAM_RATE_LIMITED'
  | 'MODEL_MIGRATOR_CREDENTIAL_REJECTED'
  | 'MODEL_MIGRATOR_CATALOG_INCOMPLETE'
  | 'MODEL_MIGRATOR_UPSTREAM_FAILED'
  | 'MODEL_MIGRATOR_REQUEST_FAILED';

export class ModelMigratorRequestError extends Error {
  constructor(
    readonly code: ModelMigratorFailureCode,
    readonly statusCode: number,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ModelMigratorRequestError';
  }
}

export interface ModelMigratorCatalogOptions {
  signal?: AbortSignal;
  forceRefresh?: boolean;
}

export interface ModelMigratorInstanceCatalog {
  instanceId: string;
  connections: OmniConnectionRecord[];
  sharedModels: OmniModelRecord[];
  schemaModels: OmniModelRecord[];
}

export interface ModelMigratorSchemaRequest {
  instance: SavedInstance;
  modelId: string;
}

export interface ModelMigratorSchemaResult {
  instanceId: string;
  modelId: string;
  schemas: string[];
}

function abortReason(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted.', 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function credentialScope(instance: Pick<SavedInstance, 'id' | 'baseUrl' | 'apiKey'>): string {
  const baseUrl = instance.baseUrl.trim().replace(/\/+$/, '');
  return createHash('sha256')
    .update(instance.id)
    .update('\0')
    .update(baseUrl)
    .update('\0')
    .update(instance.apiKey)
    .digest('hex');
}

function catalogCacheKey(
  instance: Pick<SavedInstance, 'id' | 'baseUrl' | 'apiKey'>,
  scope: string,
): string {
  return `${MODEL_MIGRATOR_CATALOG_CACHE_PREFIX}${instance.id}:${credentialScope(instance)}:${scope}`;
}

export function clearModelMigratorCatalogCache(): void {
  clearReadThroughCache(MODEL_MIGRATOR_CATALOG_CACHE_PREFIX);
}

export function createModelMigratorReadClient(instance: SavedInstance): OmniClient {
  return new OmniClient(instance, {
    requestTimeoutMs: MODEL_MIGRATOR_UPSTREAM_REQUEST_TIMEOUT_MS,
    maxReadRetries: MODEL_MIGRATOR_MAX_READ_RETRIES,
  });
}

async function cachedCatalogRead<T>(
  instance: SavedInstance,
  scope: string,
  loader: (client: OmniClient, signal: AbortSignal) => Promise<T>,
  options: ModelMigratorCatalogOptions = {},
): Promise<T> {
  const result = await readThroughCacheResult(
    catalogCacheKey(instance, scope),
    (signal) => loader(createModelMigratorReadClient(instance), signal),
    {
      ttlMs: MODEL_MIGRATOR_CATALOG_TTL_MS,
      signal: options.signal,
      forceRefresh: options.forceRefresh,
    },
  );
  return result.value;
}

export async function loadModelMigratorConnections(
  instance: SavedInstance,
  options: ModelMigratorCatalogOptions = {},
): Promise<OmniConnectionRecord[]> {
  return cachedCatalogRead(
    instance,
    'connections',
    (client, signal) => client.listConnections(signal),
    options,
  );
}

export async function loadModelMigratorSharedModels(
  instance: SavedInstance,
  connectionId?: string,
  options: ModelMigratorCatalogOptions = {},
): Promise<OmniModelRecord[]> {
  const normalizedConnectionId = connectionId?.trim() || '';
  return cachedCatalogRead(
    instance,
    `models:SHARED:connection:${normalizedConnectionId || 'all'}`,
    (client, signal) => client.listModels({
      modelKind: 'SHARED',
      ...(normalizedConnectionId ? { connectionId: normalizedConnectionId } : {}),
    }, signal),
    options,
  );
}

export async function loadModelMigratorSchemaModels(
  instance: SavedInstance,
  options: ModelMigratorCatalogOptions = {},
): Promise<OmniModelRecord[]> {
  return cachedCatalogRead(
    instance,
    'models:SCHEMA:connection:all',
    (client, signal) => client.listModels({ modelKind: 'SCHEMA' }, signal),
    options,
  );
}

export async function loadModelMigratorDocumentInventory(
  instance: SavedInstance,
  options: ModelMigratorCatalogOptions = {},
): Promise<OmniDocumentRecord[]> {
  return cachedCatalogRead(
    instance,
    'documents:all:include-labels:true',
    (client, signal) => client.listFolderDocuments(undefined, true, signal),
    options,
  );
}

export async function loadModelMigratorModelSchemas(
  instance: SavedInstance,
  modelId: string,
  options: ModelMigratorCatalogOptions = {},
): Promise<string[]> {
  const normalizedModelId = modelId.trim();
  if (!normalizedModelId) return [];
  return cachedCatalogRead(
    instance,
    `model:${encodeURIComponent(normalizedModelId)}:schemas`,
    (client, signal) => client.listModelSchemas(normalizedModelId, undefined, signal),
    options,
  );
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  signal: AbortSignal | undefined,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (values.length === 0) return [];
  const output = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      throwIfAborted(signal);
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      output[index] = await mapper(values[index], index);
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(values.length, Math.max(1, concurrency)) },
    () => worker(),
  ));
  return output;
}

async function withSubscriberGroup<T>(
  parentSignal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  throwIfAborted(parentSignal);
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(abortReason(parentSignal));
  parentSignal?.addEventListener('abort', forwardAbort, { once: true });
  try {
    return await operation(controller.signal);
  } catch (error) {
    if (!controller.signal.aborted) {
      controller.abort(error instanceof Error ? error : new Error('Model Migrator catalog load failed.'));
    }
    throw error;
  } finally {
    parentSignal?.removeEventListener('abort', forwardAbort);
  }
}

export async function loadModelMigratorInstanceCatalogs(
  instances: SavedInstance[],
  options: ModelMigratorCatalogOptions = {},
): Promise<Map<string, ModelMigratorInstanceCatalog>> {
  const unique = new Map<string, SavedInstance>();
  for (const instance of instances) {
    const key = `${instance.id}:${credentialScope(instance)}`;
    if (!unique.has(key)) unique.set(key, instance);
  }
  return withSubscriberGroup(options.signal, async (groupSignal) => {
    const catalogs = await mapWithConcurrency(
      [...unique.values()],
      MODEL_MIGRATOR_INSTANCE_CONCURRENCY,
      groupSignal,
      async (instance) => withSubscriberGroup(groupSignal, async (instanceSignal) => {
        const scopedOptions = { ...options, signal: instanceSignal };
        const [connections, sharedModels, schemaModels] = await Promise.all([
          loadModelMigratorConnections(instance, scopedOptions),
          loadModelMigratorSharedModels(instance, undefined, scopedOptions),
          loadModelMigratorSchemaModels(instance, scopedOptions),
        ]);
        return {
          instanceId: instance.id,
          connections,
          sharedModels,
          schemaModels,
        } satisfies ModelMigratorInstanceCatalog;
      }),
    );
    return new Map(catalogs.map((catalog) => [catalog.instanceId, catalog]));
  });
}

export async function loadModelMigratorSchemaLists(
  requests: ModelMigratorSchemaRequest[],
  options: ModelMigratorCatalogOptions = {},
): Promise<ModelMigratorSchemaResult[]> {
  const unique = new Map<string, ModelMigratorSchemaRequest>();
  for (const request of requests) {
    const modelId = request.modelId.trim();
    if (!modelId) continue;
    const key = `${request.instance.id}:${credentialScope(request.instance)}:${modelId}`;
    if (!unique.has(key)) unique.set(key, { ...request, modelId });
  }
  return withSubscriberGroup(options.signal, (groupSignal) => mapWithConcurrency(
    [...unique.values()],
    MODEL_MIGRATOR_SCHEMA_CONCURRENCY,
    groupSignal,
    async ({ instance, modelId }) => ({
      instanceId: instance.id,
      modelId,
      schemas: await loadModelMigratorModelSchemas(instance, modelId, {
        ...options,
        signal: groupSignal,
      }),
    }),
  ));
}

export async function runModelMigratorInteractiveOperation<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  if (options.signal?.aborted) {
    throw new ModelMigratorRequestError(
      'MODEL_MIGRATOR_REQUEST_CANCELLED',
      499,
      'The Model Migrator request was cancelled.',
      true,
    );
  }
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(1, Math.floor(options.timeoutMs!))
    : MODEL_MIGRATOR_INTERACTIVE_DEADLINE_MS;
  const controller = new AbortController();
  let deadlineReached = false;
  const cancel = () => controller.abort(abortReason(options.signal));
  options.signal?.addEventListener('abort', cancel, { once: true });
  let rejectInterruption: ((reason: unknown) => void) | undefined;
  const interruption = new Promise<never>((_resolve, reject) => {
    rejectInterruption = reject;
  });
  const onInterrupted = () => rejectInterruption?.(abortReason(controller.signal));
  controller.signal.addEventListener('abort', onInterrupted, { once: true });
  const timeout = setTimeout(() => {
    deadlineReached = true;
    controller.abort(new ModelMigratorRequestError(
      'MODEL_MIGRATOR_READINESS_TIMEOUT',
      504,
      `Model Migrator readiness exceeded its ${timeoutMs}ms interactive deadline.`,
      true,
    ));
  }, timeoutMs);
  try {
    const operationPromise = Promise.resolve().then(() => operation(controller.signal));
    // The race enforces the overall deadline even if a future operation forgets
    // to observe the signal. The catch keeps the losing branch handled.
    void operationPromise.catch(() => undefined);
    return await Promise.race([operationPromise, interruption]);
  } catch (error) {
    if (deadlineReached) {
      throw new ModelMigratorRequestError(
        'MODEL_MIGRATOR_READINESS_TIMEOUT',
        504,
        `Model Migrator readiness exceeded its ${timeoutMs}ms interactive deadline.`,
        true,
      );
    }
    if (options.signal?.aborted) {
      throw new ModelMigratorRequestError(
        'MODEL_MIGRATOR_REQUEST_CANCELLED',
        499,
        'The Model Migrator request was cancelled.',
        true,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    controller.signal.removeEventListener('abort', onInterrupted);
    options.signal?.removeEventListener('abort', cancel);
  }
}

export function normalizeModelMigratorRequestError(
  error: unknown,
  requestSignal?: AbortSignal,
): ModelMigratorRequestError {
  if (error instanceof ModelMigratorRequestError) return error;
  if (requestSignal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
    return new ModelMigratorRequestError(
      'MODEL_MIGRATOR_REQUEST_CANCELLED',
      499,
      'The Model Migrator request was cancelled.',
      true,
    );
  }
  if (error instanceof OmniRequestDeadlineError
    || (error as { code?: unknown })?.code === 'OMNI_REQUEST_TIMEOUT'
    || (error as { statusCode?: unknown })?.statusCode === 504) {
    return new ModelMigratorRequestError(
      'MODEL_MIGRATOR_UPSTREAM_TIMEOUT',
      504,
      'Omni did not return the Model Migrator catalog within the interactive request deadline.',
      true,
    );
  }
  if (error instanceof OmniPaginationError
    || (error as { code?: unknown })?.code === 'OMNI_PAGINATION_INCOMPLETE') {
    return new ModelMigratorRequestError(
      'MODEL_MIGRATOR_CATALOG_INCOMPLETE',
      502,
      'Omni returned an incomplete Model Migrator catalog, so readiness was not inferred.',
      true,
    );
  }
  if (error instanceof OmniClientError) {
    if (error.status === 401 || error.status === 403) {
      return new ModelMigratorRequestError(
        'MODEL_MIGRATOR_CREDENTIAL_REJECTED',
        error.status,
        'The saved Omni credential was rejected while loading the Model Migrator catalog.',
        false,
      );
    }
    if (error.status === 429) {
      return new ModelMigratorRequestError(
        'MODEL_MIGRATOR_UPSTREAM_RATE_LIMITED',
        429,
        'Omni is rate limiting Model Migrator catalog reads. Wait briefly, then retry readiness.',
        true,
      );
    }
    return new ModelMigratorRequestError(
      'MODEL_MIGRATOR_UPSTREAM_FAILED',
      502,
      'Omni could not return a verified Model Migrator catalog.',
      error.status >= 500,
    );
  }
  return new ModelMigratorRequestError(
    'MODEL_MIGRATOR_REQUEST_FAILED',
    500,
    'The Model Migrator request failed before a verified result was available.',
    false,
  );
}

import { lookup as dnsLookup } from 'node:dns';
import type { LookupAddress, LookupOptions } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { LookupFunction } from 'node:net';
import { isIP } from 'node:net';
import {
  assertSafeOutboundUrl,
  isPrivateOrLocalAddress,
  validateBaseUrl,
  jsonHeaders,
} from '../security';

interface PageInfo {
  hasNextPage: boolean;
  nextCursor: string | null;
  pageSize: number;
  totalRecords: number;
}

interface ModelPage {
  records: Record<string, unknown>[];
  pageInfo: PageInfo;
}

interface NormalizedModel {
  id: string;
  name: string;
  identifier?: string;
  connectionId?: string;
  connectionName?: string;
  baseModelId?: string;
  kind?: string;
  gitConfigured?: boolean;
  pullRequestRequired?: boolean;
  gitProtected?: boolean;
  gitFollower?: boolean;
  createdAt?: string;
  updatedAt?: string;
  deletedAt: string | null;
  branches?: NormalizedModel[];
}

const MAX_PAGES = 50;
const PAGE_TIMEOUT_MS = 15_000;
const OVERALL_TIMEOUT_MS = 45_000;
const MAX_UPSTREAM_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_INVENTORY_RESPONSE_BYTES = 16 * 1024 * 1024;
const GENERIC_UPSTREAM_ERROR = 'The Omni model inventory could not be verified.';

export interface ListModelsDependencies {
  fetch?: typeof fetch;
  validateOutbound?: (url: string) => Promise<void>;
  pageTimeoutMs?: number;
  overallTimeoutMs?: number;
  maxInventoryResponseBytes?: number;
  lookup?: typeof dnsLookup;
}

class ModelInventoryDeadlineError extends Error {
  constructor(readonly code: 'MODEL_INVENTORY_TIMEOUT' | 'MODEL_INVENTORY_PAGE_TIMEOUT') {
    super(code === 'MODEL_INVENTORY_TIMEOUT'
      ? 'The model inventory exceeded its overall deadline.'
      : 'A model inventory page exceeded its deadline.');
    this.name = 'ModelInventoryDeadlineError';
  }
}

class ModelInventoryCancelledError extends Error {
  readonly code = 'MODEL_INVENTORY_CANCELLED';

  constructor() {
    super('The model inventory was cancelled.');
    this.name = 'ModelInventoryCancelledError';
  }
}

class ModelInventoryOutboundRejectedError extends Error {
  readonly code = 'MODEL_INVENTORY_OUTBOUND_REJECTED';

  constructor() {
    super('The model inventory destination could not be validated safely.');
    this.name = 'ModelInventoryOutboundRejectedError';
  }
}

class ModelInventoryResponseError extends Error {
  constructor() {
    super('The Omni model inventory returned an invalid or oversized response.');
    this.name = 'ModelInventoryResponseError';
  }
}

class ModelInventoryNetworkError extends Error {
  readonly code = 'MODEL_INVENTORY_UPSTREAM_UNAVAILABLE';

  constructor() {
    super('The Omni model inventory host could not be reached.');
    this.name = 'ModelInventoryNetworkError';
  }
}

interface UpstreamModelResponse {
  status: number;
  body?: unknown;
  bytesRead: number;
}

function unsafeResolutionError(): NodeJS.ErrnoException {
  return Object.assign(new Error('The Omni model inventory host resolved to a local or private address.'), {
    code: 'EACCES',
  });
}

function publicOnlyLookup(resolver: typeof dnsLookup = dnsLookup): LookupFunction {
  return (hostname, options, callback) => {
    const requestedAll = options.all === true;
    const lookupOptions: LookupOptions = { ...options, all: true, verbatim: true };
    resolver(hostname, lookupOptions, (error, records) => {
      if (error) {
        callback(error, '', 0);
        return;
      }
      const addresses = records as LookupAddress[];
      if (addresses.length === 0) {
        callback(Object.assign(new Error('The Omni model inventory host could not be resolved.'), {
          code: 'ENOTFOUND',
        }), '', 0);
        return;
      }
      if (addresses.some((record) => isPrivateOrLocalAddress(record.address))) {
        callback(unsafeResolutionError(), '', 0);
        return;
      }
      if (requestedAll) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

function declaredResponseBytes(value: string | string[] | null | undefined): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseBoundedJson(bytes: Uint8Array): unknown {
  if (bytes.byteLength > MAX_UPSTREAM_RESPONSE_BYTES) throw new ModelInventoryResponseError();
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ModelInventoryResponseError();
  }
}

async function readBoundedFetchJson(response: Response): Promise<{ body: unknown; bytesRead: number }> {
  const declared = declaredResponseBytes(response.headers.get('content-length'));
  if (declared !== null && declared > MAX_UPSTREAM_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new ModelInventoryResponseError();
  }
  if (!response.body) throw new ModelInventoryResponseError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > MAX_UPSTREAM_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new ModelInventoryResponseError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body: parseBoundedJson(body), bytesRead };
}

async function readBoundedNodeJson(
  response: IncomingMessage,
  signal: AbortSignal,
): Promise<{ body: unknown; bytesRead: number }> {
  const declared = declaredResponseBytes(response.headers['content-length']);
  if (declared !== null && declared > MAX_UPSTREAM_RESPONSE_BYTES) {
    response.destroy();
    throw new ModelInventoryResponseError();
  }
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  for await (const value of response) {
    if (signal.aborted) {
      response.destroy();
      throw new ModelInventoryCancelledError();
    }
    const chunk = typeof value === 'string' ? Buffer.from(value) : new Uint8Array(value);
    bytesRead += chunk.byteLength;
    if (bytesRead > MAX_UPSTREAM_RESPONSE_BYTES) {
      response.destroy();
      throw new ModelInventoryResponseError();
    }
    chunks.push(chunk);
  }
  const body = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body: parseBoundedJson(body), bytesRead };
}

async function requestPinnedModelPage(
  url: string,
  apiKey: string,
  signal: AbortSignal,
  dependencies: ListModelsDependencies,
): Promise<UpstreamModelResponse> {
  try {
    await (dependencies.validateOutbound
      || ((candidate: string) => assertSafeOutboundUrl(candidate, { label: 'base_url' })))(url);
  } catch {
    throw new ModelInventoryOutboundRejectedError();
  }
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const outbound = httpsRequest(parsed, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      agent: false,
      lookup: publicOnlyLookup(dependencies.lookup),
      ...(isIP(parsed.hostname) ? {} : { servername: parsed.hostname }),
      signal,
    }, (response) => {
      const status = response.statusCode || 0;
      if (status < 200 || status >= 300) {
        response.destroy();
        resolve({ status, bytesRead: 0 });
        return;
      }
      void readBoundedNodeJson(response, signal)
        .then(({ body, bytesRead }) => resolve({ status, body, bytesRead }), reject);
    });
    outbound.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EACCES') reject(new ModelInventoryOutboundRejectedError());
      else if (signal.aborted) reject(new ModelInventoryCancelledError());
      else reject(new ModelInventoryNetworkError());
    });
    outbound.end();
  });
}

async function requestModelPage(
  url: string,
  apiKey: string,
  signal: AbortSignal,
  dependencies: ListModelsDependencies,
): Promise<UpstreamModelResponse> {
  if (!dependencies.fetch) return requestPinnedModelPage(url, apiKey, signal, dependencies);
  try {
    await (dependencies.validateOutbound
      || ((candidate: string) => assertSafeOutboundUrl(candidate, { label: 'base_url' })))(url);
  } catch {
    throw new ModelInventoryOutboundRejectedError();
  }
  const response = await dependencies.fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
    redirect: 'manual',
    signal,
  });
  if (!response.ok) return { status: response.status, bytesRead: 0 };
  const { body, bytesRead } = await readBoundedFetchJson(response);
  return { status: response.status, body, bytesRead };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

function upstreamFailure(status = 502): Response {
  const safeStatus = status >= 400 && status <= 599 ? status : 502;
  return json({ error: GENERIC_UPSTREAM_ERROR }, safeStatus);
}

async function runWithDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: { timeoutMs: number; signal?: AbortSignal; timeoutCode: ModelInventoryDeadlineError['code'] },
): Promise<T> {
  if (options.signal?.aborted) throw new ModelInventoryCancelledError();
  const controller = new AbortController();
  let rejectDeadline: ((error: Error) => void) | undefined;
  let settled = false;
  const interruption = new Promise<never>((_resolve, reject) => {
    rejectDeadline = (error) => {
      if (settled) return;
      settled = true;
      controller.abort(error);
      reject(error);
    };
  });
  const cancel = () => rejectDeadline?.(new ModelInventoryCancelledError());
  options.signal?.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(() => {
    rejectDeadline?.(new ModelInventoryDeadlineError(options.timeoutCode));
  }, options.timeoutMs);
  const operationPromise = Promise.resolve().then(() => operation(controller.signal));
  void operationPromise.catch(() => undefined);
  try {
    return await Promise.race([operationPromise, interruption]);
  } finally {
    settled = true;
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', cancel);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validOptionalString(value: unknown, nullable = true): boolean {
  return value === undefined
    || (nullable && value === null)
    || isNonBlankString(value);
}

function validOptionalTimestamp(value: unknown): boolean {
  return value === undefined
    || value === null
    || (isNonBlankString(value) && Number.isFinite(Date.parse(value)));
}

function validBranchSummary(value: unknown): value is Record<string, unknown> {
  if (
    !isRecord(value)
    || !isNonBlankString(value.id)
    || !isNonBlankString(value.name)
    || value.branches !== undefined
  ) return false;
  if (
    !validOptionalString(value.baseModelId)
    || !validOptionalString(value.connectionId)
    || !validOptionalString(value.connectionName)
    || !validOptionalString(value.modelKind)
    || !validOptionalTimestamp(value.createdAt)
    || !validOptionalTimestamp(value.updatedAt)
    || !validOptionalTimestamp(value.deletedAt)
  ) return false;

  for (const field of ['gitConfigured', 'pullRequestRequired', 'gitProtected', 'gitFollower']) {
    if (value[field] !== undefined && typeof value[field] !== 'boolean') return false;
  }
  return true;
}

function validModelRecord(value: unknown): value is Record<string, unknown> {
  if (
    !isRecord(value)
    || !isNonBlankString(value.id)
    || !Object.prototype.hasOwnProperty.call(value, 'name')
    || (value.name !== null && !isNonBlankString(value.name))
    || !Object.prototype.hasOwnProperty.call(value, 'modelKind')
    || (value.modelKind !== null && !isNonBlankString(value.modelKind))
  ) return false;
  if (
    !validOptionalString(value.identifier, false)
    || !validOptionalString(value.baseModelId)
    || !validOptionalString(value.connectionId)
    || !validOptionalString(value.connectionName)
    || !validOptionalTimestamp(value.createdAt)
    || !validOptionalTimestamp(value.updatedAt)
    || !validOptionalTimestamp(value.deletedAt)
  ) return false;

  for (const field of ['gitConfigured', 'pullRequestRequired', 'gitProtected', 'gitFollower']) {
    if (value[field] !== undefined && typeof value[field] !== 'boolean') return false;
  }

  if (value.branches !== undefined) {
    if (!Array.isArray(value.branches)) return false;
    const seenBranchIds = new Set<string>();
    for (const branch of value.branches) {
      if (!validBranchSummary(branch)) return false;
      const branchId = String(branch.id).trim();
      if (seenBranchIds.has(branchId)) return false;
      seenBranchIds.add(branchId);
    }
  }
  return true;
}

function parseModelPage(value: unknown): ModelPage | null {
  if (
    !isRecord(value)
    || Object.prototype.hasOwnProperty.call(value, 'error')
    || Object.prototype.hasOwnProperty.call(value, 'errors')
    || value.ok === false
    || value.success === false
  ) return null;
  if (!Array.isArray(value.records) || !isRecord(value.pageInfo)) return null;
  const { hasNextPage, nextCursor, pageSize, totalRecords } = value.pageInfo;
  if (
    typeof hasNextPage !== 'boolean'
    || !Number.isSafeInteger(pageSize)
    || Number(pageSize) < 1
    || Number(pageSize) > 100
    || !isNonNegativeInteger(totalRecords)
    || value.records.length > Number(pageSize)
    || value.records.length > totalRecords
    || (hasNextPage && value.records.length === 0)
  ) return null;
  if (hasNextPage) {
    if (!isNonBlankString(nextCursor)) return null;
  } else if (nextCursor !== undefined && nextCursor !== null) {
    return null;
  }

  const records: Record<string, unknown>[] = [];
  const seenPageIds = new Set<string>();
  for (const record of value.records) {
    if (!validModelRecord(record)) return null;
    const id = String(record.id).trim();
    if (seenPageIds.has(id)) return null;
    seenPageIds.add(id);
    records.push(record);
  }

  return {
    records,
    pageInfo: {
      hasNextPage,
      nextCursor: typeof nextCursor === 'string' ? nextCursor : null,
      pageSize: Number(pageSize),
      totalRecords,
    },
  };
}

function optionalString(value: unknown): string | undefined {
  return isNonBlankString(value) ? value.trim() : undefined;
}

function normalizeModel(raw: Record<string, unknown>): NormalizedModel {
  const id = String(raw.id).trim();
  return {
    id,
    name: optionalString(raw.name) || optionalString(raw.identifier) || id,
    identifier: optionalString(raw.identifier),
    connectionId: optionalString(raw.connectionId),
    connectionName: optionalString(raw.connectionName),
    baseModelId: optionalString(raw.baseModelId),
    kind: optionalString(raw.modelKind),
    gitConfigured: typeof raw.gitConfigured === 'boolean' ? raw.gitConfigured : undefined,
    pullRequestRequired: typeof raw.pullRequestRequired === 'boolean' ? raw.pullRequestRequired : undefined,
    gitProtected: typeof raw.gitProtected === 'boolean' ? raw.gitProtected : undefined,
    gitFollower: typeof raw.gitFollower === 'boolean' ? raw.gitFollower : undefined,
    createdAt: optionalString(raw.createdAt),
    updatedAt: optionalString(raw.updatedAt),
    deletedAt: optionalString(raw.deletedAt) || null,
    branches: Array.isArray(raw.branches)
      ? raw.branches.map((branch) => normalizeModel(branch as Record<string, unknown>))
      : undefined,
  };
}

async function handleRequest(
  req: Request,
  signal: AbortSignal,
  dependencies: ListModelsDependencies,
): Promise<Response> {
  try {
    const {
      base_url,
      api_key,
      model_id,
      model_kind,
      connection_id,
      include_deleted,
      include,
      sort_field,
      sort_direction,
      page_size,
      cursor,
      all_pages,
    } = await req.json();

    const urlError = validateBaseUrl(base_url);
    if (urlError) return json({ error: urlError }, 400);
    if (!api_key) return json({ error: 'Base URL and API key are required.' }, 400);

    const cleanUrl = base_url.replace(/\/+$/, '');
    const requestedPageSize = Number(page_size);
    const pageSize = Number.isSafeInteger(requestedPageSize) && requestedPageSize > 0
      ? Math.min(requestedPageSize, 100)
      : 100;
    const initialCursor = isNonBlankString(cursor) ? cursor : undefined;
    const requestedModelKind = model_kind === undefined
      ? undefined
      : isNonBlankString(model_kind)
        ? model_kind.trim()
        : null;
    const requestedModelId = model_id === undefined
      ? undefined
      : isNonBlankString(model_id)
        ? model_id.trim()
        : null;
    const requestedConnectionId = connection_id === undefined
      ? undefined
      : isNonBlankString(connection_id)
        ? connection_id.trim()
        : null;
    if (
      requestedModelKind === null
      || requestedModelId === null
      || requestedConnectionId === null
    ) {
      return json({ error: 'Model filters must be nonblank strings.' }, 400);
    }
    let nextCursor = initialCursor;
    let lastPageInfo: PageInfo | null = null;
    let responsePageSize: number | null = null;
    let totalRecords: number | null = null;
    let pagesFetched = 0;
    let responseBytesRead = 0;
    let reachedSafetyLimit = false;
    const allRaw: Record<string, unknown>[] = [];
    const seenCursors = new Set<string>();
    const seenModelIds = new Set<string>();
    if (nextCursor) seenCursors.add(nextCursor);

    while (pagesFetched < MAX_PAGES) {
      const params = new URLSearchParams();
      if (requestedModelId) params.set('modelId', requestedModelId);
      if (requestedModelKind) params.set('modelKind', requestedModelKind);
      if (requestedConnectionId) params.set('connectionId', requestedConnectionId);
      if (include_deleted === true) params.set('includeDeleted', 'true');
      if (include) params.set('include', include);
      params.set('pageSize', String(pageSize));
      params.set('sortField', sort_field || 'name');
      params.set('sortDirection', sort_direction || 'asc');
      if (nextCursor) params.set('cursor', nextCursor);

      const targetUrl = `${cleanUrl}/api/v1/models?${params.toString()}`;
      const response = await runWithDeadline(
        (pageSignal) => requestModelPage(targetUrl, api_key, pageSignal, dependencies),
        {
          timeoutMs: dependencies.pageTimeoutMs || PAGE_TIMEOUT_MS,
          signal,
          timeoutCode: 'MODEL_INVENTORY_PAGE_TIMEOUT',
        },
      );

      if (response.status < 200 || response.status >= 300) return upstreamFailure(response.status);
      responseBytesRead += response.bytesRead;
      if (responseBytesRead > (dependencies.maxInventoryResponseBytes || MAX_INVENTORY_RESPONSE_BYTES)) {
        return upstreamFailure();
      }
      const page = parseModelPage(response.body);
      if (!page) return upstreamFailure();

      if (responsePageSize === null) responsePageSize = page.pageInfo.pageSize;
      if (page.pageInfo.pageSize !== responsePageSize) return upstreamFailure();
      if (totalRecords === null) totalRecords = page.pageInfo.totalRecords;
      if (page.pageInfo.totalRecords !== totalRecords) return upstreamFailure();
      for (const record of page.records) {
        if (requestedModelId && record.id !== requestedModelId) return upstreamFailure();
        if (requestedModelKind && record.modelKind !== requestedModelKind) return upstreamFailure();
        if (requestedConnectionId && record.connectionId !== requestedConnectionId) return upstreamFailure();
        const id = String(record.id).trim();
        if (seenModelIds.has(id)) return upstreamFailure();
        seenModelIds.add(id);
        allRaw.push(record);
      }
      if (allRaw.length > totalRecords) return upstreamFailure();

      lastPageInfo = page.pageInfo;
      pagesFetched += 1;
      if (!page.pageInfo.hasNextPage || all_pages !== true) break;
      if (!page.pageInfo.nextCursor || seenCursors.has(page.pageInfo.nextCursor)) return upstreamFailure();
      if (allRaw.length >= totalRecords) return upstreamFailure();
      if (pagesFetched >= MAX_PAGES) {
        reachedSafetyLimit = true;
        break;
      }
      seenCursors.add(page.pageInfo.nextCursor);
      nextCursor = page.pageInfo.nextCursor;
    }

    const startedAtBeginning = initialCursor === undefined;
    const reachedEnd = lastPageInfo?.hasNextPage === false;
    const complete = startedAtBeginning
      && reachedEnd
      && !reachedSafetyLimit
      && allRaw.length === totalRecords;
    if (startedAtBeginning && reachedEnd && !reachedSafetyLimit && !complete) return upstreamFailure();

    return json({
      models: allRaw.map(normalizeModel),
      pageInfo: lastPageInfo,
      pagesFetched,
      complete,
      loadedResults: allRaw.length,
      totalResults: totalRecords,
      ...(reachedSafetyLimit ? { reasonCode: 'PAGINATION_SAFETY_LIMIT_REACHED' } : {}),
    });
  } catch (error) {
    if (error instanceof ModelInventoryDeadlineError) throw error;
    if (error instanceof ModelInventoryCancelledError) throw error;
    if (error instanceof ModelInventoryOutboundRejectedError) throw error;
    if (error instanceof ModelInventoryNetworkError) throw error;
    if (error instanceof ModelInventoryResponseError) return upstreamFailure();
    return json({ error: 'The Omni model inventory could not be loaded.' }, 500);
  }
}

export default async function handler(
  req: Request,
  dependencies: ListModelsDependencies = {},
): Promise<Response> {
  try {
    return await runWithDeadline(
      (signal) => handleRequest(req, signal, dependencies),
      {
        timeoutMs: dependencies.overallTimeoutMs || OVERALL_TIMEOUT_MS,
        signal: req.signal,
        timeoutCode: 'MODEL_INVENTORY_TIMEOUT',
      },
    );
  } catch (error) {
    if (error instanceof ModelInventoryCancelledError || req.signal.aborted) {
      return json({
        error: 'The Omni model inventory request was cancelled.',
        code: 'MODEL_INVENTORY_CANCELLED',
      }, 499);
    }
    if (error instanceof ModelInventoryDeadlineError) {
      return json({
        error: error.code === 'MODEL_INVENTORY_TIMEOUT'
          ? 'The Omni model inventory did not complete within 45 seconds.'
          : 'An Omni model inventory page did not respond within 15 seconds.',
        code: error.code,
      }, 408);
    }
    if (error instanceof ModelInventoryOutboundRejectedError) {
      return json({
        error: 'The saved Omni instance could not be reached through a safe public network path.',
        code: error.code,
      }, 400);
    }
    if (error instanceof ModelInventoryNetworkError) {
      return json({
        error: 'The saved Omni instance could not be reached while loading its model inventory.',
        code: error.code,
      }, 502);
    }
    return json({ error: 'The Omni model inventory could not be loaded.' }, 500);
  }
}

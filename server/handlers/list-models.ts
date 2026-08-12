import { validateBaseUrl, jsonHeaders } from '../security';

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
const GENERIC_UPSTREAM_ERROR = 'The Omni model inventory could not be verified.';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

function upstreamFailure(status = 502): Response {
  return json({ error: GENERIC_UPSTREAM_ERROR }, status);
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

export default async function handler(req: Request): Promise<Response> {
  try {
    const {
      base_url,
      api_key,
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
    const requestedConnectionId = connection_id === undefined
      ? undefined
      : isNonBlankString(connection_id)
        ? connection_id.trim()
        : null;
    if (requestedModelKind === null || requestedConnectionId === null) {
      return json({ error: 'Model filters must be nonblank strings.' }, 400);
    }
    let nextCursor = initialCursor;
    let lastPageInfo: PageInfo | null = null;
    let responsePageSize: number | null = null;
    let totalRecords: number | null = null;
    let pagesFetched = 0;
    let reachedSafetyLimit = false;
    const allRaw: Record<string, unknown>[] = [];
    const seenCursors = new Set<string>();
    const seenModelIds = new Set<string>();
    if (nextCursor) seenCursors.add(nextCursor);

    while (pagesFetched < MAX_PAGES) {
      const params = new URLSearchParams();
      if (requestedModelKind) params.set('modelKind', requestedModelKind);
      if (requestedConnectionId) params.set('connectionId', requestedConnectionId);
      if (include_deleted === true) params.set('includeDeleted', 'true');
      if (include) params.set('include', include);
      params.set('pageSize', String(pageSize));
      params.set('sortField', sort_field || 'name');
      params.set('sortDirection', sort_direction || 'asc');
      if (nextCursor) params.set('cursor', nextCursor);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      let response: Response;
      try {
        response = await fetch(`${cleanUrl}/api/v1/models?${params.toString()}`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${api_key}`,
            'Content-Type': 'application/json',
          },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) return upstreamFailure(response.status);
      let rawPage: unknown;
      try {
        rawPage = await response.json();
      } catch {
        return upstreamFailure();
      }
      const page = parseModelPage(rawPage);
      if (!page) return upstreamFailure();

      if (responsePageSize === null) responsePageSize = page.pageInfo.pageSize;
      if (page.pageInfo.pageSize !== responsePageSize) return upstreamFailure();
      if (totalRecords === null) totalRecords = page.pageInfo.totalRecords;
      if (page.pageInfo.totalRecords !== totalRecords) return upstreamFailure();
      for (const record of page.records) {
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
  } catch {
    return json({ error: 'The Omni model inventory could not be loaded.' }, 500);
  }
}

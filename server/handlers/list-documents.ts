import { validateBaseUrl, jsonHeaders } from '../security';

interface PageInfo {
  hasNextPage: boolean;
  nextCursor: string | null;
  pageSize: number;
  totalRecords: number;
}

interface DocumentPage {
  records: unknown[];
  pageInfo: PageInfo;
}

const MAX_PAGES = 50;

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function parseDocumentPage(data: unknown): DocumentPage | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const row = data as Record<string, unknown>;
  if (!Array.isArray(row.records)) return null;
  const pageInfo = row.pageInfo;
  if (!pageInfo || typeof pageInfo !== "object" || Array.isArray(pageInfo)) return null;
  const info = pageInfo as Record<string, unknown>;
  if (
    typeof info.hasNextPage !== "boolean"
    || !Number.isSafeInteger(info.pageSize)
    || Number(info.pageSize) < 1
    || !isNonNegativeInteger(info.totalRecords)
    || row.records.length > Number(info.pageSize)
    || row.records.length > Number(info.totalRecords)
    || (info.hasNextPage && row.records.length === 0)
  ) return null;
  const nextCursor = info.nextCursor;
  if (info.hasNextPage) {
    if (typeof nextCursor !== "string" || nextCursor.trim().length === 0) return null;
  } else if (nextCursor !== undefined && nextCursor !== null) {
    return null;
  }
  return {
    records: row.records,
    pageInfo: {
      hasNextPage: info.hasNextPage,
      nextCursor: typeof nextCursor === "string" ? nextCursor : null,
      pageSize: Number(info.pageSize),
      totalRecords: Number(info.totalRecords),
    },
  };
}

function collectDocumentIds(records: unknown[], seen: Set<string>): boolean {
  for (const value of records) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    const id = typeof record.identifier === "string" ? record.identifier.trim() : "";
    if (
      !id
      || seen.has(id)
      || typeof record.name !== "string"
      || record.name.trim().length === 0
      || (record.hasDashboard !== undefined && typeof record.hasDashboard !== "boolean")
      || (record.type !== undefined && typeof record.type !== "string")
      || (record.kind !== undefined && typeof record.kind !== "string")
    ) return false;
    seen.add(id);
  }
  return true;
}

function firstString(...candidates: unknown[]): string | undefined {
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return undefined;
}

function nested(obj: unknown, ...keys: string[]): unknown {
  let cur: unknown = obj;
  for (const k of keys) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

function normalizeDocument(raw: Record<string, unknown>) {
  const content = (raw.content && typeof raw.content === "object" && !Array.isArray(raw.content))
    ? raw.content as Record<string, unknown>
    : null;
  const metadata = (raw.metadata && typeof raw.metadata === "object" && !Array.isArray(raw.metadata))
    ? raw.metadata as Record<string, unknown>
    : null;

  const docId = String(raw.identifier ?? raw.id ?? raw.slug ?? "");

  const baseModelId = firstString(
    raw.sharedModelId, raw.shared_model_id,
    raw.base_model_id, raw.baseModelId,
    content?.sharedModelId, content?.shared_model_id,
    content?.base_model_id, content?.baseModelId,
    metadata?.sharedModelId, metadata?.shared_model_id,
    metadata?.base_model_id, metadata?.baseModelId,
    nested(raw, "baseModel", "id"),
    nested(raw, "model", "id"),
    nested(content, "baseModel", "id"),
  );

  return {
    id: docId,
    name: String(raw.name ?? ""),
    identifier: docId,
    hasDashboard: typeof raw.hasDashboard === "boolean" ? raw.hasDashboard : undefined,
    connectionId: firstString(raw.connectionId),
    baseModelId,
    folderId: firstString(raw.folder_id, raw.folderId, nested(raw, "folder", "id")),
    folderPath: firstString(raw.folder_path, raw.folderPath, raw.path, nested(raw, "folder", "path")),
    type: String(raw.type ?? raw.kind ?? "") || undefined,
    description: typeof raw.description === "string" ? raw.description : undefined,
    labels: Array.isArray(raw.labels)
      ? raw.labels.flatMap((label) => {
          if (typeof label === "string" && label.trim()) return [label.trim()];
          if (label && typeof label === "object" && !Array.isArray(label)) {
            const name = firstString((label as Record<string, unknown>).name);
            return name ? [name] : [];
          }
          return [];
        })
      : undefined,
  };
}

export default async function handler(req: Request): Promise<Response> {
  try {
    const { base_url, api_key, folder_id, page_size, cursor, all_pages } = await req.json();

    const urlError = validateBaseUrl(base_url);
    if (urlError) {
      return new Response(JSON.stringify({ error: urlError }), { status: 400, headers: jsonHeaders });
    }

    if (!api_key) {
      return new Response(
        JSON.stringify({ error: "Base URL and API key are required." }),
        { status: 400, headers: jsonHeaders }
      );
    }

    const cleanUrl = base_url.replace(/\/+$/, "");
    const requestedPageSize = Number(page_size);
    const pageSize = Number.isSafeInteger(requestedPageSize) && requestedPageSize > 0
      ? Math.min(requestedPageSize, 100)
      : 100;
    const allRaw: unknown[] = [];
    const initialCursor = typeof cursor === "string" && cursor.length > 0 ? cursor : undefined;
    let nextCursor = initialCursor;
    let lastPageInfo: PageInfo | null = null;
    let totalRecords: number | null = null;
    let pagesFetched = 0;
    let reachedSafetyLimit = false;
    const seenCursors = new Set<string>();
    const seenDocumentIds = new Set<string>();
    if (nextCursor) seenCursors.add(nextCursor);

    while (pagesFetched < MAX_PAGES) {
      const params = new URLSearchParams();
      params.set("pageSize", String(pageSize));
      params.set("sortField", "name");
      params.set("sortDirection", "asc");
      params.set("include", "labels");
      if (folder_id) params.set("folderId", folder_id);
      if (nextCursor) params.set("cursor", nextCursor);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const response = await fetch(
        `${cleanUrl}/api/v1/documents?${params.toString()}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${api_key}`,
            "Content-Type": "application/json",
          },
          signal: controller.signal,
        }
      );
      clearTimeout(timeout);

      if (!response.ok) {
        return new Response(
          JSON.stringify({
            error: `Omni document read failed with HTTP ${response.status}.`,
          }),
          { status: response.status, headers: jsonHeaders }
        );
      }

      const page = parseDocumentPage(await response.json());
      if (page === null) {
        return new Response(
          JSON.stringify({
            error: "Omni returned an unsupported document response shape.",
          }),
          { status: 502, headers: jsonHeaders }
        );
      }

      if (totalRecords === null) totalRecords = page.pageInfo.totalRecords;
      if (page.pageInfo.totalRecords !== totalRecords) {
        return new Response(
          JSON.stringify({ error: "Omni returned inconsistent document pagination evidence." }),
          { status: 502, headers: jsonHeaders }
        );
      }
      if (!collectDocumentIds(page.records, seenDocumentIds)) {
        return new Response(
          JSON.stringify({ error: "Omni returned malformed or duplicate document records." }),
          { status: 502, headers: jsonHeaders }
        );
      }
      allRaw.push(...page.records);
      lastPageInfo = page.pageInfo;
      pagesFetched += 1;
      if (!page.pageInfo.hasNextPage || all_pages !== true) break;
      const returnedCursor = page.pageInfo.nextCursor;
      if (!returnedCursor || seenCursors.has(returnedCursor)) {
        return new Response(
          JSON.stringify({ error: "Omni returned non-advancing document pagination evidence." }),
          { status: 502, headers: jsonHeaders }
        );
      }
      if (pagesFetched >= MAX_PAGES) {
        reachedSafetyLimit = true;
        break;
      }
      seenCursors.add(returnedCursor);
      nextCursor = returnedCursor;
    }

    const startedAtBeginning = initialCursor === undefined;
    const reachedEnd = lastPageInfo?.hasNextPage === false;
    const complete = startedAtBeginning
      && reachedEnd
      && !reachedSafetyLimit
      && allRaw.length === totalRecords;
    if (startedAtBeginning && reachedEnd && !reachedSafetyLimit && !complete) {
      return new Response(
        JSON.stringify({ error: "Omni returned inconsistent document collection totals." }),
        { status: 502, headers: jsonHeaders }
      );
    }

    const documents = allRaw
      .map((item) => normalizeDocument(item as Record<string, unknown>))
      .filter((d) => d.hasDashboard !== false && (!d.type || d.type === "dashboard" || d.type === "document"));

    return new Response(JSON.stringify({
      documents,
      pageInfo: lastPageInfo,
      pagesFetched,
      complete,
      loadedResults: allRaw.length,
      totalResults: totalRecords,
      ...(reachedSafetyLimit ? { reasonCode: "PAGINATION_SAFETY_LIMIT_REACHED" } : {}),
    }), {
      headers: jsonHeaders,
    });
  } catch {
    return new Response(JSON.stringify({ error: "The Omni document read could not be completed." }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
}

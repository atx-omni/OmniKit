export type DocumentV2JsonRecord = Record<string, unknown>;

export interface DocumentV2Patch {
  name?: string;
  description?: string | null;
  summary?: string;
  branchId?: string;
  queryPresentations?: unknown;
  controls?: unknown;
  settings?: unknown;
  containers?: unknown;
}

export interface DocumentV2CreateInput extends DocumentV2Patch {
  modelId: string;
  name: string;
  identifier?: string;
  folderId?: string | null;
}

export interface DocumentV2CreateResult {
  id: string;
  identifier: string;
  url?: string;
  raw: DocumentV2JsonRecord;
}

export interface DocumentV2DraftResult {
  identifier: string;
  draftIdentifier: string;
  raw: DocumentV2JsonRecord;
}

export interface DocumentV2QueryProjection {
  id: string;
  name: string;
  url?: string;
  query: DocumentV2JsonRecord;
  visConfig?: DocumentV2JsonRecord;
  description?: string;
}

export type DocumentV2Requester = (
  method: string,
  path: string,
  options?: { body?: unknown },
) => Promise<Response>;

function isRecord(value: unknown): value is DocumentV2JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function nested(value: unknown, ...keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function stateRecord(raw: unknown): DocumentV2JsonRecord {
  if (!isRecord(raw)) return {};
  for (const key of ['document', 'state']) {
    const candidate = raw[key];
    if (isRecord(candidate) && (
      'queryPresentations' in candidate
      || 'modelId' in candidate
      || 'workbookModelId' in candidate
    )) return candidate;
  }
  return raw;
}

export function documentV2ModelId(raw: unknown): string | undefined {
  const state = stateRecord(raw);
  return firstString(
    state.modelId,
    state.workbookModelId,
    state.baseModelId,
    nested(state, 'model', 'id'),
  );
}

export function assertDocumentV2Model(raw: unknown, expectedModelId: string, context: string): void {
  const actualModelId = documentV2ModelId(raw);
  if (!actualModelId) {
    throw new Error(`${context} could not verify the destination model binding.`);
  }
  if (actualModelId !== expectedModelId) {
    throw new Error(`${context} model binding mismatch: expected ${expectedModelId}, received ${actualModelId}.`);
  }
}

export function documentV2PresentationData(raw: unknown): DocumentV2JsonRecord {
  const presentations = stateRecord(raw).queryPresentations;
  if (!isRecord(presentations) || !isRecord(presentations.data)) return {};
  return presentations.data;
}

export function documentV2PresentationOrder(raw: unknown): string[] {
  const state = stateRecord(raw);
  const presentations = state.queryPresentations;
  const data = documentV2PresentationData(state);
  const declaredOrder = isRecord(presentations) && Array.isArray(presentations.order)
    ? presentations.order.filter((value): value is string => typeof value === 'string' && value in data)
    : [];
  const seen = new Set(declaredOrder);
  return [
    ...declaredOrder,
    ...Object.keys(data).filter((key) => !seen.has(key)),
  ];
}

export function projectDocumentV2Queries(raw: unknown): DocumentV2QueryProjection[] {
  const data = documentV2PresentationData(raw);
  return documentV2PresentationOrder(raw).flatMap((recordKey) => {
    const value = data[recordKey];
    if (!isRecord(value)) return [];
    const query = isRecord(value.query) ? value.query : {};
    const visConfig = isRecord(value.visConfig)
      ? value.visConfig
      : isRecord(value.vis_config)
        ? value.vis_config
        : undefined;
    return [{
      id: recordKey,
      name: firstString(value.name, value.title) || 'Workbook tab',
      url: firstString(value.url),
      query,
      visConfig,
      description: firstString(value.description),
    }];
  });
}

export function buildDocumentV2QueryPresentations(
  presentations: Array<{
    name: string;
    description?: string | null;
    query: DocumentV2JsonRecord;
    visConfig?: DocumentV2JsonRecord;
  }>,
): { data: DocumentV2JsonRecord; order: string[] } {
  const data: DocumentV2JsonRecord = {};
  const order: string[] = [];
  presentations.forEach((presentation, index) => {
    // New documents contain an empty seed tile at key "1". Reusing that key
    // replaces the seed instead of leaving a blank tab ahead of migrated tabs.
    const key = String(index + 1);
    order.push(key);
    data[key] = {
      name: presentation.name,
      ...(presentation.description !== undefined ? { description: presentation.description } : {}),
      query: presentation.query,
      ...(presentation.visConfig ? { visConfig: presentation.visConfig } : {}),
    };
  });
  return { data, order };
}

export class DocumentsV2Adapter {
  constructor(private readonly request: DocumentV2Requester) {}

  async getState(documentId: string): Promise<DocumentV2JsonRecord> {
    const response = await this.request('GET', `/api/v2/documents/${encodeURIComponent(documentId)}`);
    return stateRecord(await response.json().catch(() => ({})));
  }

  async getDraftState(documentId: string, draftId: string): Promise<DocumentV2JsonRecord> {
    const response = await this.request(
      'GET',
      `/api/v2/documents/${encodeURIComponent(documentId)}/draft/${encodeURIComponent(draftId)}`,
    );
    return stateRecord(await response.json().catch(() => ({})));
  }

  async create(input: DocumentV2CreateInput): Promise<DocumentV2CreateResult> {
    const response = await this.request('POST', '/api/v2/documents', { body: input });
    const raw = stateRecord(await response.json().catch(() => ({})));
    const identifier = firstString(raw.identifier, nested(raw, 'document', 'identifier')) || '';
    const id = firstString(raw.id, raw.documentId, raw.document_id, nested(raw, 'document', 'id')) || identifier;
    if (!identifier) throw new Error('Omni created the document but did not return its identifier.');

    const published = await this.getState(identifier);
    assertDocumentV2Model(published, input.modelId, 'Created document verification');
    if (isRecord(input.queryPresentations) && Array.isArray(input.queryPresentations.order)) {
      const expectedOrder = input.queryPresentations.order.filter((value): value is string => typeof value === 'string');
      const actualOrder = documentV2PresentationOrder(published);
      if (expectedOrder.length !== actualOrder.length || expectedOrder.some((key, index) => actualOrder[index] !== key)) {
        throw new Error('Created document verification returned a different workbook tab order.');
      }
    }
    return {
      id,
      identifier,
      url: firstString(raw.url, nested(raw, 'document', 'url')),
      raw,
    };
  }

  async createDraft(documentId: string, patch: DocumentV2Patch): Promise<DocumentV2DraftResult> {
    const response = await this.request(
      'PATCH',
      `/api/v2/documents/${encodeURIComponent(documentId)}/draft`,
      { body: patch },
    );
    const raw = stateRecord(await response.json().catch(() => ({})));
    const draftIdentifier = firstString(
      raw.draftIdentifier,
      raw.draft_identifier,
      nested(raw, 'draft', 'identifier'),
      nested(raw, 'draft', 'id'),
    ) || '';
    if (!draftIdentifier) throw new Error('Omni created a draft but did not return its identifier.');
    return {
      identifier: firstString(raw.identifier, raw.documentIdentifier, raw.document_identifier) || documentId,
      draftIdentifier,
      raw,
    };
  }

  async patchDraft(documentId: string, draftId: string, patch: DocumentV2Patch): Promise<void> {
    await this.request(
      'PATCH',
      `/api/v2/documents/${encodeURIComponent(documentId)}/draft/${encodeURIComponent(draftId)}`,
      { body: patch },
    );
  }

  async publishDraft(documentId: string): Promise<void> {
    await this.request('POST', `/api/v2/documents/${encodeURIComponent(documentId)}/draft/publish`);
  }

  async updateDescription(documentId: string, description: string | null): Promise<void> {
    await this.createDraft(documentId, {
      description,
      summary: 'Updated document metadata with OmniKit',
    });
    await this.publishDraft(documentId);
    const published = await this.getState(documentId);
    if (published.description !== description) {
      throw new Error('Published document verification did not return the requested description.');
    }
  }
}

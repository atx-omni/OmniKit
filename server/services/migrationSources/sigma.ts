import { createHash } from 'node:crypto';
import type {
  MigrationDashboardEvidence,
  MigrationField,
  MigrationInventory,
  MigrationMeasure,
  MigrationRelationship,
  MigrationSourceArtifactProvenance,
  MigrationSourceDependencyEvidence,
  MigrationView,
} from '../../../src/services/semanticMigration/types';
import type {
  MigrationPreparedEvidenceResult,
  MigrationSourceCollectorContext,
  MigrationSourceEvidenceCollector,
} from './contracts';

const SIGMA_AUTH_DOCUMENTATION = 'https://help.sigmacomputing.com/reference/post-token';
const SIGMA_DATA_MODEL_SPEC_DOCUMENTATION = 'https://help.sigmacomputing.com/reference/get-data-model-spec';
const SIGMA_WORKBOOK_DOCUMENTATION = 'https://help.sigmacomputing.com/reference/get-workbook';
const MAX_SELECTED_DATA_MODELS = 100;
const MAX_SELECTED_WORKBOOKS = 100;
const MAX_PAGES = 250;
const MAX_ELEMENTS = 2_000;
const MAX_REQUESTS = 500;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_REFERENCE_SCAN_RECORDS = 20_000;
const MAX_REFERENCE_SCAN_DEPTH = 16;
const REQUEST_DEADLINE_MS = 30_000;

type JsonRecord = Record<string, unknown>;

interface SigmaScope {
  dataModelIds: string[];
  workbookIds: string[];
}

interface SigmaStats {
  requestsMade: number;
  pagesFetched: number;
  bytesRead: number;
  itemsObserved: number;
  truncated: boolean;
  permissionGaps: string[];
  warnings: string[];
  errors: string[];
}

export interface SigmaDiscoveryInventoryResult {
  inventory: MigrationInventory;
  items: Array<{
    id: string;
    name: string;
    kind: 'semantic_model' | 'workbook';
    updatedAt?: string;
  }>;
  diagnostics: { requestsMade: number; pagesFetched: number; bytesRead: number; truncated: boolean; warnings: string[] };
}

interface SigmaDataModelEvidence {
  id: string;
  spec: JsonRecord;
  sources: JsonRecord[];
  columns: JsonRecord[];
  lineage: JsonRecord[];
  grants: JsonRecord[];
  materializationSchedules: JsonRecord[];
}

interface SigmaWorkbookEvidence {
  id: string;
  definition: JsonRecord;
  pages: JsonRecord[];
  controls: JsonRecord[];
  lineage: JsonRecord[];
  grants: JsonRecord[];
  schedules: JsonRecord[];
  materializationSchedules: JsonRecord[];
}

type SigmaPaginationMode = 'page' | 'page_token' | 'none';

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter((item): item is JsonRecord => Boolean(item) && typeof item === 'object' && !Array.isArray(item)) : [];
}

function stringValue(...values: unknown[]): string {
  const value = values.find((item) => typeof item === 'string' && item.trim());
  return typeof value === 'string' ? value.trim() : '';
}

function sourceId(record: JsonRecord, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if ((typeof value === 'string' && value.trim()) || (typeof value === 'number' && Number.isFinite(value))) return String(value).trim();
  }
  return '';
}

function canonicalize(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(Object.entries(item as JsonRecord).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, normalize(child)]));
  };
  return JSON.stringify(normalize(value));
}

function fingerprint(value: unknown): { sha256: string; sizeBytes: number } {
  const encoded = canonicalize(value);
  return { sha256: createHash('sha256').update(encoded).digest('hex'), sizeBytes: Buffer.byteLength(encoded, 'utf8') };
}

function sigmaApiRoot(raw: string): string {
  const url = new URL(raw);
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/v2(?:\.1)?\/?$/i, '').replace(/\/+$/, '');
  return url.toString().replace(/\/+$/, '');
}

function parseScope(selectedRootIds: readonly string[]): SigmaScope {
  if (selectedRootIds.length === 0) throw Object.assign(new Error('Select at least one Sigma Data Model or workbook.'), { statusCode: 400 });
  const scope: SigmaScope = { dataModelIds: [], workbookIds: [] };
  selectedRootIds.forEach((raw) => {
    const value = raw.trim();
    if (!value) return;
    if (value.startsWith('data_model:')) scope.dataModelIds.push(value.slice('data_model:'.length));
    else if (value.startsWith('semantic_model:')) scope.dataModelIds.push(value.slice('semantic_model:'.length));
    else if (value.startsWith('workbook:')) scope.workbookIds.push(value.slice('workbook:'.length));
    else scope.workbookIds.push(value);
  });
  scope.dataModelIds = Array.from(new Set(scope.dataModelIds.filter(Boolean))).sort();
  scope.workbookIds = Array.from(new Set(scope.workbookIds.filter(Boolean))).sort();
  if (scope.dataModelIds.length > MAX_SELECTED_DATA_MODELS) throw Object.assign(new Error(`Select ${MAX_SELECTED_DATA_MODELS} or fewer Sigma Data Models.`), { statusCode: 400 });
  if (scope.workbookIds.length > MAX_SELECTED_WORKBOOKS) throw Object.assign(new Error(`Select ${MAX_SELECTED_WORKBOOKS} or fewer Sigma workbooks.`), { statusCode: 400 });
  return scope;
}

function pageRows(payload: unknown): { recognized: boolean; rows: JsonRecord[] } {
  if (Array.isArray(payload)) {
    const normalized = records(payload);
    return { recognized: normalized.length === payload.length, rows: normalized };
  }
  const root = asRecord(payload);
  for (const container of [root, asRecord(root.data), asRecord(root.result)]) {
    for (const key of ['entries', 'items', 'dataModels', 'workbooks', 'pages', 'elements', 'sources', 'columns', 'lineage', 'grants', 'schedules']) {
      if (Array.isArray(container[key])) {
        const rawRows = container[key] as unknown[];
        const normalized = records(rawRows);
        return { recognized: normalized.length === rawRows.length, rows: normalized };
      }
    }
  }
  return { recognized: false, rows: [] };
}

function nextPage(payload: unknown, currentUrl: string, mode: SigmaPaginationMode): string | undefined {
  const root = asRecord(payload);
  const containers = [root, asRecord(root.data), asRecord(root.result)];
  for (const container of containers) {
    const links = asRecord(container.links);
    const rawLink = container.next || links.next;
    const link = typeof rawLink === 'string' ? rawLink : stringValue(asRecord(rawLink).href);
    if (link) {
      const target = new URL(link, currentUrl);
      const current = new URL(currentUrl);
      if (target.origin !== current.origin) throw Object.assign(new Error('Sigma pagination returned a continuation on another origin.'), { statusCode: 502 });
      return target.toString();
    }
    const continuation = mode === 'page_token'
      ? stringValue(container.nextPageToken, container.next_page_token)
      : mode === 'page'
        ? stringValue(container.nextPage, container.next_page)
        : '';
    if (continuation) {
      const target = new URL(currentUrl);
      target.searchParams.set(mode === 'page_token' ? 'pageToken' : 'page', continuation);
      return target.toString();
    }
    if (mode !== 'none' && container.hasMore === true) throw Object.assign(new Error('Sigma pagination reported more results without a continuation.'), { statusCode: 502 });
  }
  return undefined;
}

async function sigmaRequest(
  context: MigrationSourceCollectorContext,
  stats: SigmaStats,
  url: string,
  accessToken: string | undefined,
  label: string,
  options: { method?: 'GET' | 'POST'; body?: string; allowStatuses?: readonly number[] } = {},
): Promise<{ status: number; body: unknown; finalUrl: string }> {
  if (stats.requestsMade >= MAX_REQUESTS) {
    stats.truncated = true;
    throw Object.assign(new Error(`Sigma evidence collection reached the ${MAX_REQUESTS}-request safety bound.`), { statusCode: 413 });
  }
  const response = await context.transport.request({
    url,
    method: options.method,
    headers: {
      Accept: 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(options.body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: options.body,
    responseType: 'json',
    label,
    allowStatuses: options.allowStatuses,
    maxResponseBytes: MAX_RESPONSE_BYTES,
    deadlineMs: REQUEST_DEADLINE_MS,
    signal: context.signal,
  });
  stats.requestsMade += response.requestCount;
  stats.bytesRead += response.bytesRead;
  if (stats.bytesRead > MAX_TOTAL_BYTES) {
    stats.truncated = true;
    throw Object.assign(new Error('Sigma evidence collection exceeded the 50 MB aggregate response limit.'), { statusCode: 413 });
  }
  return { status: response.status, body: response.body, finalUrl: response.finalUrl };
}

async function sigmaList(
  context: MigrationSourceCollectorContext,
  stats: SigmaStats,
  firstUrl: string,
  accessToken: string,
  label: string,
  options: { optional?: boolean; pagination: SigmaPaginationMode },
): Promise<JsonRecord[]> {
  const rows: JsonRecord[] = [];
  const seen = new Set<string>();
  const seenPages = new Set<string>();
  let url: string | undefined = firstUrl;
  for (let page = 0; url && page < MAX_PAGES; page += 1) {
    if (seen.has(url)) throw Object.assign(new Error(`Sigma ${label} pagination repeated a continuation.`), { statusCode: 502 });
    seen.add(url);
    const response = await sigmaRequest(context, stats, url, accessToken, label, { allowStatuses: options.optional ? [200, 400, 403, 404, 405, 422, 501] : undefined });
    stats.pagesFetched += 1;
    if (response.status !== 200) {
      const message = `${label} was unavailable with status ${response.status}.`;
      if (response.status === 403) stats.permissionGaps.push(message);
      else stats.warnings.push(message);
      return rows;
    }
    const parsedPage = pageRows(response.body);
    if (!parsedPage.recognized) {
      throw Object.assign(new Error(`Sigma ${label} returned an unrecognized success response.`), { statusCode: 502 });
    }
    const pageItems = parsedPage.rows;
    rows.push(...pageItems);
    stats.itemsObserved += pageItems.length;
    const next = nextPage(response.body, response.finalUrl, options.pagination);
    if (next && pageItems.length === 0) {
      throw Object.assign(new Error(`Sigma ${label} returned an empty page while reporting another page.`), { statusCode: 502 });
    }
    const pageFingerprint = fingerprint(pageItems).sha256;
    if (next && seenPages.has(pageFingerprint)) throw Object.assign(new Error(`Sigma ${label} pagination repeated a response page.`), { statusCode: 502 });
    seenPages.add(pageFingerprint);
    url = next;
  }
  if (url) {
    stats.truncated = true;
    throw Object.assign(new Error(`Sigma ${label} exceeded the ${MAX_PAGES}-page safety bound.`), { statusCode: 413 });
  }
  return rows;
}

async function optionalObject(
  context: MigrationSourceCollectorContext,
  stats: SigmaStats,
  url: string,
  accessToken: string,
  label: string,
): Promise<JsonRecord | undefined> {
  const response = await sigmaRequest(context, stats, url, accessToken, label, { allowStatuses: [200, 400, 403, 404, 405, 422, 501] });
  stats.pagesFetched += 1;
  if (response.status !== 200) {
    const message = `${label} was unavailable with status ${response.status}.`;
    if (response.status === 403) stats.permissionGaps.push(message);
    else stats.warnings.push(message);
    return undefined;
  }
  const body = asRecord(response.body);
  stats.itemsObserved += 1;
  return body;
}

async function sigmaAccessToken(context: MigrationSourceCollectorContext, stats: SigmaStats, base: string): Promise<string> {
  const { connection } = context;
  if (connection.authMode !== 'oauth_client_credentials' || !connection.clientId || !connection.credential) {
    throw Object.assign(new Error('Sigma Saved API requires an API client ID and client secret.'), { statusCode: 409 });
  }
  const tokenResponse = await sigmaRequest(context, stats, `${base}/v2/auth/token`, undefined, 'Sigma OAuth token exchange', {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: connection.clientId, client_secret: connection.credential }).toString(),
  });
  const accessToken = stringValue(asRecord(tokenResponse.body).access_token);
  if (!accessToken) throw Object.assign(new Error('Sigma OAuth token exchange did not return an access token.'), { statusCode: 502 });
  context.registerSensitiveValue?.(accessToken, 'Sigma OAuth token exchange');
  return accessToken;
}

export async function listSigmaDiscoveryInventory(context: MigrationSourceCollectorContext): Promise<SigmaDiscoveryInventoryResult> {
  const { connection } = context;
  if (connection.platform !== 'sigma') throw Object.assign(new Error('The Sigma discovery helper requires a Sigma connection.'), { statusCode: 400 });
  const stats: SigmaStats = { requestsMade: 0, pagesFetched: 0, bytesRead: 0, itemsObserved: 0, truncated: false, permissionGaps: [], warnings: [], errors: [] };
  const base = sigmaApiRoot(connection.baseUrl);
  const accessToken = await sigmaAccessToken(context, stats, base);
  const [dataModels, workbooks] = await Promise.all([
    sigmaList(context, stats, `${base}/v2/dataModels?limit=100`, accessToken, 'Sigma Data Model discovery', { pagination: 'page' }),
    sigmaList(context, stats, `${base}/v2/workbooks?limit=100`, accessToken, 'Sigma workbook discovery', { pagination: 'page' }),
  ]);
  const items: SigmaDiscoveryInventoryResult['items'] = [
    ...dataModels.flatMap((item) => {
      const id = sourceId(item, 'dataModelId', 'id');
      return id ? [{ id: `data_model:${id}`, name: stringValue(item.name, item.title, id), kind: 'semantic_model' as const, updatedAt: stringValue(item.updatedAt, item.updated_at) || undefined }] : [];
    }),
    ...workbooks.flatMap((item) => {
      const id = sourceId(item, 'workbookId', 'id');
      return id ? [{ id: `workbook:${id}`, name: stringValue(item.name, item.title, id), kind: 'workbook' as const, updatedAt: stringValue(item.updatedAt, item.updated_at) || undefined }] : [];
    }),
  ];
  const inventory: MigrationInventory = {
    sourceTool: 'sigma', artifactCount: 0, artifacts: [], views: [], explores: [], relationships: [], dashboards: workbooks.flatMap((workbook) => {
      const id = sourceId(workbook, 'workbookId', 'id');
      return id ? [{ sourceId: `sigma:workbook:${id}`, sourceLocator: `workbook:${id}`, name: stringValue(workbook.name, workbook.title, id), fields: [], filters: [], assetKind: 'dashboard' as const }] : [];
    }), metrics: [],
    warnings: ['This is discovery metadata only. Prepare selected Data Model specs and workbook evidence before Analyze.', ...stats.warnings],
    summary: `${dataModels.length} Data Model${dataModels.length === 1 ? '' : 's'} · ${workbooks.length} workbook${workbooks.length === 1 ? '' : 's'} · discovery only`,
  };
  return { inventory, items, diagnostics: { requestsMade: stats.requestsMade, pagesFetched: stats.pagesFetched, bytesRead: stats.bytesRead, truncated: stats.truncated, warnings: [...stats.warnings] } };
}

function sigmaColumnType(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (value && typeof value === 'object') return canonicalize(value);
  }
  return undefined;
}

function sigmaColumn(raw: JsonRecord): MigrationField {
  const id = sourceId(raw, 'columnId', 'id');
  const name = stringValue(raw.name, raw.label, id) || 'unnamed_column';
  return {
    sourceId: id ? `sigma:column:${id}` : undefined,
    sourceLocator: id ? `column:${id}` : undefined,
    name,
    label: stringValue(raw.label) || undefined,
    type: sigmaColumnType(raw.dataType, raw.type),
    sql: stringValue(raw.formula) || undefined,
    hidden: raw.hidden === true,
  };
}

function specElements(spec: JsonRecord): JsonRecord[] {
  const pages = records(spec.pages);
  const pageElements = pages.flatMap((page) => records(page.elements));
  return pageElements.length > 0 ? pageElements : records(spec.elements);
}

function normalizeDataModel(evidence: SigmaDataModelEvidence): { views: MigrationView[]; metrics: MigrationMeasure[]; relationships: MigrationRelationship[]; dependencies: MigrationSourceDependencyEvidence[] } {
  const columnsByElement = new Map<string, JsonRecord[]>();
  evidence.columns.forEach((column) => {
    const elementId = sourceId(column, 'elementId', 'sourceId');
    if (!elementId) return;
    columnsByElement.set(elementId, [...(columnsByElement.get(elementId) || []), column]);
  });
  const elements = specElements(evidence.spec);
  const views: MigrationView[] = [];
  const metrics: MigrationMeasure[] = [];
  const relationships: MigrationRelationship[] = [];
  const dependencies: MigrationSourceDependencyEvidence[] = [{
    sourceId: `sigma:data-model:${evidence.id}`,
    category: 'semantic_model',
    required: true,
    status: 'resolved',
    reason: 'The authoritative Data Model spec was acquired from the documented /v2/dataModels/{id}/spec endpoint.',
  }];
  const viewByElementId = new Map<string, string>();
  const fieldByColumnId = new Map<string, { view: string; field: string }>();
  elements.forEach((element, index) => {
    const id = sourceId(element, 'elementId', 'id') || `${evidence.id}:element:${index}`;
    const kind = stringValue(element.kind, element.type).toLowerCase();
    if (kind && !['table', 'dataset', 'data_model_table', 'pivot', 'crosstab'].some((value) => kind.includes(value))) return;
    const source = asRecord(element.source);
    const path = Array.isArray(source.path) ? source.path.map(String) : [];
    const viewName = stringValue(element.name, element.label) || `Element ${id}`;
    viewByElementId.set(id, viewName);
    const rawColumns = [...records(element.columns), ...(columnsByElement.get(id) || [])];
    const seen = new Set<string>();
    const fields = rawColumns.flatMap((column) => {
      const key = sourceId(column, 'columnId', 'id') || stringValue(column.name, column.label);
      if (!key || seen.has(key)) return [];
      seen.add(key);
      const field = sigmaColumn(column);
      if (key) fieldByColumnId.set(key, { view: viewName, field: field.name });
      const type = stringValue(column.type, column.kind).toLowerCase();
      if (type.includes('metric') || column.isMetric === true) {
        metrics.push({ ...field, aggregateType: 'sigma_metric', sourceArtifact: `data-model:${evidence.id}` });
        return [];
      }
      return [field];
    });
    const nestedMetrics = records(element.metrics).map((metric) => ({ ...sigmaColumn(metric), aggregateType: 'sigma_metric', sourceArtifact: `data-model:${evidence.id}` }));
    metrics.push(...nestedMetrics);
    views.push({
      sourceId: `sigma:data-model:${evidence.id}:element:${id}`,
      sourceLocator: `data-model:${evidence.id}/element:${id}`,
      name: viewName,
      label: stringValue(element.label) || undefined,
      kind: 'dataset',
      annotations: {
        ...(path.length > 0 ? { sourcePath: path.join('.') } : {}),
        dataModelId: evidence.id,
      },
      fields,
      measures: nestedMetrics,
      warnings: [],
      sourceArtifact: `data-model:${evidence.id}`,
    });
  });
  const relationshipRows: Array<{ sourceElementId?: string; relationship: JsonRecord }> = [
    ...elements.flatMap((element) => {
      const sourceElementId = sourceId(element, 'elementId', 'id') || undefined;
      return records(element.relationships).map((relationship) => ({ sourceElementId, relationship }));
    }),
    ...records(evidence.spec.relationships).map((relationship) => ({
      sourceElementId: sourceId(relationship, 'fromElementId', 'sourceElementId') || undefined,
      relationship,
    })),
  ];
  relationshipRows.forEach(({ sourceElementId, relationship }) => {
    const relationshipId = sourceId(relationship, 'relationshipId', 'id') || fingerprint(relationship).sha256.slice(0, 16);
    const targetElementId = sourceId(relationship, 'targetElementId', 'toElementId');
    const fromView = sourceElementId ? viewByElementId.get(sourceElementId) : undefined;
    const toView = targetElementId ? viewByElementId.get(targetElementId) : undefined;
    const keys = records(relationship.keys).length > 0
      ? records(relationship.keys)
      : [{ sourceColumnId: relationship.fromColumnId, targetColumnId: relationship.toColumnId }];
    const conditions = keys.flatMap((key) => {
      const sourceColumn = fieldByColumnId.get(sourceId(key, 'sourceColumnId', 'fromColumnId'));
      const targetColumn = fieldByColumnId.get(sourceId(key, 'targetColumnId', 'toColumnId'));
      return sourceColumn && targetColumn && sourceColumn.view === fromView && targetColumn.view === toView
        ? [`\${${sourceColumn.view}.${sourceColumn.field}} = \${${targetColumn.view}.${targetColumn.field}}`]
        : [];
    });
    if (!fromView || !toView || conditions.length !== keys.length || conditions.length === 0) {
      dependencies.push({ sourceId: `sigma:data-model:${evidence.id}`, dependencySourceId: `sigma:relationship:${relationshipId}`, category: 'relationship', required: true, status: 'review_required', reason: 'A Sigma relationship or join key did not resolve exactly and was not emitted.' });
      return;
    }
    const rawType = stringValue(relationship.relationshipType, relationship.type).toLowerCase();
    relationships.push({
      sourceId: `sigma:relationship:${relationshipId}`,
      sourceLocator: `data-model:${evidence.id}/relationship:${relationshipId}`,
      from: fromView,
      to: toView,
      relationshipType: rawType === '1:1' || rawType === 'one-to-one' || rawType === 'one_to_one' || rawType === 'one to one' ? 'one_to_one' : 'many_to_one',
      sql: conditions.join(' AND '),
      sourceArtifact: `data-model:${evidence.id}`,
    });
    dependencies.push({ sourceId: `sigma:data-model:${evidence.id}`, dependencySourceId: `sigma:relationship:${relationshipId}`, category: 'relationship', required: true, status: 'resolved', reason: 'The Sigma relationship endpoints and key IDs resolved exactly within the selected Data Model spec.' });
  });
  evidence.sources.forEach((source) => {
    const id = sourceId(source, 'sourceId', 'elementId', 'inodeId', 'id');
    if (!id) return;
    dependencies.push({ sourceId: `sigma:data-model:${evidence.id}`, dependencySourceId: `sigma:data-source:${id}`, category: 'data_source', required: true, status: 'resolved', reason: 'Sigma reported this Data Model source through the documented sources endpoint.' });
  });
  evidence.lineage.forEach((lineage) => {
    const id = sourceId(lineage, 'sourceId', 'inodeId', 'elementId', 'id');
    if (!id) return;
    dependencies.push({ sourceId: `sigma:data-model:${evidence.id}`, dependencySourceId: `sigma:lineage:${id}`, category: 'relationship', required: true, status: 'resolved', reason: 'Sigma lineage evidence was acquired for the selected Data Model.' });
  });
  return { views, metrics, relationships, dependencies };
}

function workbookDataModelReferences(workbook: SigmaWorkbookEvidence): string[] {
  const references = new Set<string>();
  let recordsScanned = 0;
  const add = (value: unknown): void => {
    const id = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
    if (id && id !== workbook.id && id.length <= 300) references.add(id);
  };
  const visit = (value: unknown, depth: number): void => {
    if (depth > MAX_REFERENCE_SCAN_DEPTH) throw Object.assign(new Error(`Sigma workbook ${workbook.id} dependency scanning exceeded the ${MAX_REFERENCE_SCAN_DEPTH}-level safety bound.`), { statusCode: 413 });
    if (Array.isArray(value)) {
      value.forEach((child) => visit(child, depth + 1));
      return;
    }
    if (!value || typeof value !== 'object') return;
    recordsScanned += 1;
    if (recordsScanned > MAX_REFERENCE_SCAN_RECORDS) throw Object.assign(new Error(`Sigma workbook ${workbook.id} dependency scanning exceeded the ${MAX_REFERENCE_SCAN_RECORDS}-record safety bound.`), { statusCode: 413 });
    const record = value as JsonRecord;
    const isDataModelIdentity = [record.type, record.kind, record.sourceType, record.inodeType].some((candidate) => (
      typeof candidate === 'string'
      && candidate.trim().toLowerCase().replace(/[\s_-]+/g, '') === 'datamodel'
    ));
    Object.entries(record).forEach(([key, child]) => {
      if (/^(?:dataModelId|data_model_id)$/i.test(key)) add(child);
      else if (isDataModelIdentity && /^id$/i.test(key)) add(child);
      visit(child, depth + 1);
    });
  };
  visit(workbook.definition, 0);
  visit(workbook.pages, 0);
  visit(workbook.lineage, 0);
  return Array.from(references).sort();
}

function normalizeWorkbook(
  workbook: SigmaWorkbookEvidence,
  referencedDataModelIds: readonly string[],
  acquiredDataModelIds: ReadonlySet<string>,
): { dashboards: MigrationDashboardEvidence[]; dependencies: MigrationSourceDependencyEvidence[] } {
  const dashboards = workbook.pages.map((page, index) => {
    const pageId = sourceId(page, 'pageId', 'id') || `${workbook.id}:page:${index}`;
    const elements = records(page.elements);
    const fields = Array.from(new Set(elements.flatMap((element) => records(element.columns).map((column) => stringValue(column.name, column.label, sourceId(column, 'columnId', 'id'))).filter(Boolean)))).sort();
    const controls = [...records(page.controls), ...workbook.controls];
    const filters = Array.from(new Set(controls.map((control) => stringValue(control.name, control.label, sourceId(control, 'controlId', 'id'))).filter(Boolean))).sort();
    return {
      sourceId: `sigma:workbook:${workbook.id}:page:${pageId}`,
      sourceLocator: `workbook:${workbook.id}/page:${pageId}`,
      parentId: `sigma:workbook:${workbook.id}`,
      name: stringValue(page.name, page.title) || `Page ${pageId}`,
      fields,
      filters,
      assetKind: 'page' as const,
      dependencyIds: referencedDataModelIds.map((id) => `sigma:data-model:${id}`),
      featureFlags: elements.map((element) => stringValue(element.type, element.kind)).filter(Boolean),
      riskFlags: elements.flatMap((element) => {
        const type = stringValue(element.type, element.kind).toLowerCase();
        return [
          ...(type.includes('input') ? ['input_table_or_writeback_requires_handoff'] : []),
          ...(type.includes('action') || type.includes('button') ? ['action_requires_handoff'] : []),
        ];
      }),
      sourceArtifact: `workbook:${workbook.id}`,
    };
  });
  const dependencies: MigrationSourceDependencyEvidence[] = [{
    sourceId: `sigma:workbook:${workbook.id}`,
    category: 'content',
    required: true,
    status: 'resolved',
    reason: 'Workbook pages, elements, controls, generated queries, lineage, grants, and schedules were collected as content evidence.',
  }, {
    sourceId: `sigma:workbook:${workbook.id}`,
    category: 'content',
    required: true,
    status: 'review_required',
    reason: 'Sigma does not provide a documented workbook portable model-spec equivalent; workbook layout and unsupported interactions require human validation.',
  }];
  if (referencedDataModelIds.length === 0) {
    dependencies.push({
      sourceId: `sigma:workbook:${workbook.id}`,
      category: 'semantic_model',
      required: true,
      status: 'manual_required',
      reason: 'The workbook evidence did not expose an unambiguous Data Model ID. Supply the authoritative Data Model spec before migration.',
    });
  }
  referencedDataModelIds.forEach((id) => {
    const acquired = acquiredDataModelIds.has(id);
    dependencies.push({
      sourceId: `sigma:workbook:${workbook.id}`,
      dependencySourceId: `sigma:data-model:${id}`,
      category: 'semantic_model',
      required: true,
      status: acquired ? 'resolved' : 'missing',
      reason: acquired
        ? 'The workbook-referenced Data Model was resolved through the authoritative documented /spec endpoint.'
        : 'The workbook references this Data Model/source ID, but its authoritative /spec definition was unavailable. Add the Data Model or supply it manually.',
    });
  });
  if (workbook.grants.length > 0) dependencies.push({ sourceId: `sigma:workbook:${workbook.id}`, category: 'security', required: true, status: 'review_required', reason: 'Sigma grants require target identity and permission reconciliation.' });
  if (workbook.schedules.length > 0 || workbook.materializationSchedules.length > 0) dependencies.push({ sourceId: `sigma:workbook:${workbook.id}`, category: 'schedule', required: true, status: 'manual_required', reason: 'Workbook delivery and materialization schedules require an operational handoff.' });
  return { dashboards, dependencies };
}

async function collectDataModel(context: MigrationSourceCollectorContext, stats: SigmaStats, base: string, token: string, id: string): Promise<SigmaDataModelEvidence | undefined> {
  const prefix = `${base}/v2/dataModels/${encodeURIComponent(id)}`;
  const specResponse = await sigmaRequest(context, stats, `${prefix}/spec?format=json`, token, 'Sigma Data Model spec', { allowStatuses: [200, 403, 404] });
  stats.pagesFetched += 1;
  if (specResponse.status !== 200) {
    const message = `Sigma Data Model ${id} spec was unavailable with status ${specResponse.status}.`;
    if (specResponse.status === 403) stats.permissionGaps.push(message);
    else stats.errors.push(message);
    return undefined;
  }
  const spec = asRecord(specResponse.body);
  if (Object.keys(spec).length === 0) {
    stats.errors.push(`Sigma Data Model ${id} returned an empty spec.`);
    return undefined;
  }
  stats.itemsObserved += 1;
  const [sources, columns, lineage, grants, materializationSchedules] = await Promise.all([
    sigmaList(context, stats, `${prefix}/sources?pageSize=100`, token, 'Sigma Data Model sources', { optional: true, pagination: 'page_token' }),
    sigmaList(context, stats, `${prefix}/columns?limit=100`, token, 'Sigma Data Model columns', { optional: true, pagination: 'page' }),
    sigmaList(context, stats, `${prefix}/lineage?limit=100`, token, 'Sigma Data Model lineage', { optional: true, pagination: 'page' }),
    sigmaList(context, stats, `${base}/v2/grants?inodeId=${encodeURIComponent(id)}&directGrantsOnly=true&limit=100`, token, 'Sigma Data Model grants', { optional: true, pagination: 'page' }),
    sigmaList(context, stats, `${prefix}/materializationSchedules?pageSize=100`, token, 'Sigma Data Model materialization schedules', { optional: true, pagination: 'page_token' }),
  ]);
  return { id, spec, sources, columns, lineage, grants, materializationSchedules };
}

async function collectWorkbook(context: MigrationSourceCollectorContext, stats: SigmaStats, base: string, token: string, id: string): Promise<SigmaWorkbookEvidence | undefined> {
  const prefix = `${base}/v2/workbooks/${encodeURIComponent(id)}`;
  const definitionResponse = await sigmaRequest(context, stats, prefix, token, 'Sigma workbook definition', { allowStatuses: [200, 403, 404] });
  stats.pagesFetched += 1;
  if (definitionResponse.status !== 200) {
    const message = `Sigma workbook ${id} was unavailable with status ${definitionResponse.status}.`;
    if (definitionResponse.status === 403) stats.permissionGaps.push(message);
    else stats.errors.push(message);
    return undefined;
  }
  const definition = asRecord(definitionResponse.body);
  const pages = await sigmaList(context, stats, `${prefix}/pages?limit=100`, token, 'Sigma workbook pages', { pagination: 'page' });
  if (pages.length > MAX_PAGES) throw Object.assign(new Error(`Sigma workbook ${id} exceeds the ${MAX_PAGES}-page selected-scope limit.`), { statusCode: 413 });
  let elementCount = 0;
  for (const page of pages) {
    const pageId = sourceId(page, 'pageId', 'id');
    if (!pageId) {
      stats.errors.push(`Sigma workbook ${id} returned a page without pageId.`);
      continue;
    }
    const elements = await sigmaList(context, stats, `${prefix}/pages/${encodeURIComponent(pageId)}/elements?limit=100`, token, 'Sigma workbook page elements', { pagination: 'page' });
    elementCount += elements.length;
    if (elementCount > MAX_ELEMENTS) throw Object.assign(new Error(`Sigma workbook ${id} exceeds the ${MAX_ELEMENTS}-element selected-scope limit.`), { statusCode: 413 });
    for (const element of elements) {
      const elementId = sourceId(element, 'elementId', 'id');
      if (!elementId) continue;
      const elementType = stringValue(element.type, element.kind).toLowerCase();
      if (!Array.isArray(element.columns) && !elementType.includes('control')) {
        element.columns = await sigmaList(context, stats, `${prefix}/elements/${encodeURIComponent(elementId)}/columns?limit=100`, token, 'Sigma workbook element columns', { optional: true, pagination: 'page' });
      }
      if (!elementType.includes('control')) {
        const query = await optionalObject(context, stats, `${prefix}/elements/${encodeURIComponent(elementId)}/query`, token, 'Sigma workbook generated query');
        if (query) element.generatedQuery = query;
      }
    }
    page.elements = elements;
  }
  const [controls, lineage, grants, schedules, materializationSchedules] = await Promise.all([
    sigmaList(context, stats, `${prefix}/controls?limit=100`, token, 'Sigma workbook controls', { optional: true, pagination: 'page' }),
    sigmaList(context, stats, `${prefix}/lineage?limit=100`, token, 'Sigma workbook lineage', { optional: true, pagination: 'page' }),
    sigmaList(context, stats, `${base}/v2/grants?inodeId=${encodeURIComponent(id)}&directGrantsOnly=true&limit=100`, token, 'Sigma workbook grants', { optional: true, pagination: 'page' }),
    sigmaList(context, stats, `${prefix}/schedules?limit=100`, token, 'Sigma workbook schedules', { optional: true, pagination: 'page' }),
    sigmaList(context, stats, `${prefix}/materialization-schedules?limit=100`, token, 'Sigma workbook materialization schedules', { optional: true, pagination: 'page' }),
  ]);
  return { id, definition, pages, controls, lineage, grants, schedules, materializationSchedules };
}

export async function prepareSigmaEvidence(context: MigrationSourceCollectorContext): Promise<MigrationPreparedEvidenceResult> {
  const { connection } = context;
  if (connection.platform !== 'sigma') throw Object.assign(new Error('The Sigma collector requires a Sigma connection.'), { statusCode: 400 });
  if (connection.authMode !== 'oauth_client_credentials' || !connection.clientId || !connection.credential) {
    throw Object.assign(new Error('Sigma Saved API requires an API client ID and client secret.'), { statusCode: 409 });
  }
  const scope = parseScope(context.selectedRootIds);
  const stats: SigmaStats = { requestsMade: 0, pagesFetched: 0, bytesRead: 0, itemsObserved: 0, truncated: false, permissionGaps: [], warnings: [], errors: [] };
  const base = sigmaApiRoot(connection.baseUrl);
  const accessToken = await sigmaAccessToken(context, stats, base);

  const dataModelsById = new Map<string, SigmaDataModelEvidence>();
  for (const id of scope.dataModelIds) {
    const evidence = await collectDataModel(context, stats, base, accessToken, id);
    if (evidence) dataModelsById.set(id, evidence);
  }
  const workbooks: SigmaWorkbookEvidence[] = [];
  for (const id of scope.workbookIds) {
    const evidence = await collectWorkbook(context, stats, base, accessToken, id);
    if (evidence) workbooks.push(evidence);
  }
  const workbookReferences = new Map<string, string[]>();
  for (const workbook of workbooks) {
    const references = workbookDataModelReferences(workbook);
    workbookReferences.set(workbook.id, references);
  }
  const referencedDataModelIds = Array.from(new Set(Array.from(workbookReferences.values()).flat())).sort();
  if (referencedDataModelIds.length > MAX_SELECTED_DATA_MODELS) {
    throw Object.assign(new Error(`The selected Sigma workbooks reference more than ${MAX_SELECTED_DATA_MODELS} Data Models. Narrow the workbook scope.`), { statusCode: 413 });
  }
  for (const id of referencedDataModelIds) {
    if (dataModelsById.has(id)) continue;
    const evidence = await collectDataModel(context, stats, base, accessToken, id);
    if (evidence) dataModelsById.set(id, evidence);
  }
  const dataModels = Array.from(dataModelsById.values()).sort((left, right) => left.id.localeCompare(right.id));

  const artifacts: MigrationSourceArtifactProvenance[] = [];
  const dependencies: MigrationSourceDependencyEvidence[] = [];
  const views: MigrationView[] = [];
  const metrics: MigrationMeasure[] = [];
  const relationships: MigrationRelationship[] = [];
  dataModels.forEach((model) => {
    const artifactPayload = {
      spec: model.spec,
      sources: model.sources,
      columns: model.columns,
      lineage: model.lineage,
      grants: model.grants,
      materializationSchedules: model.materializationSchedules,
    };
    const digest = fingerprint(artifactPayload);
    artifacts.push({ id: `sigma:data-model:${model.id}`, name: `Data Model ${model.id}`, sourceId: `sigma:data-model:${model.id}`, locator: `data-model:${model.id}/spec-and-closure`, mediaType: 'application/json', evidenceClass: 'authoritative_definition', ...digest, documentationIds: [SIGMA_DATA_MODEL_SPEC_DOCUMENTATION], rawContentIncluded: false });
    const normalized = normalizeDataModel(model);
    views.push(...normalized.views);
    metrics.push(...normalized.metrics);
    relationships.push(...normalized.relationships);
    dependencies.push(...normalized.dependencies);
    if (model.grants.length > 0) dependencies.push({ sourceId: `sigma:data-model:${model.id}`, category: 'security', required: true, status: 'review_required', reason: 'Sigma Data Model grants require target identity reconciliation.' });
    if (model.materializationSchedules.length > 0) dependencies.push({ sourceId: `sigma:data-model:${model.id}`, category: 'schedule', required: true, status: 'manual_required', reason: 'Data Model materialization schedules require an operational handoff.' });
  });
  const dashboards: MigrationDashboardEvidence[] = [];
  const acquiredDataModelIds = new Set(dataModels.map((model) => model.id));
  workbooks.forEach((workbook) => {
    const artifactPayload = { definition: workbook.definition, pages: workbook.pages, controls: workbook.controls, lineage: workbook.lineage, grants: workbook.grants, schedules: workbook.schedules, materializationSchedules: workbook.materializationSchedules };
    const digest = fingerprint(artifactPayload);
    artifacts.push({ id: `sigma:workbook:${workbook.id}`, name: stringValue(workbook.definition.name, workbook.definition.title) || `Workbook ${workbook.id}`, sourceId: `sigma:workbook:${workbook.id}`, locator: `workbook:${workbook.id}`, mediaType: 'application/json', evidenceClass: 'compiled_definition', ...digest, documentationIds: [SIGMA_WORKBOOK_DOCUMENTATION], rawContentIncluded: false });
    const normalized = normalizeWorkbook(workbook, workbookReferences.get(workbook.id) || [], acquiredDataModelIds);
    dashboards.push(...normalized.dashboards);
    dependencies.push(...normalized.dependencies);
  });

  const unresolved = stats.errors.length + stats.permissionGaps.length;
  const reviewCount = dependencies.filter((dependency) => dependency.status === 'review_required' || dependency.status === 'manual_required').length + stats.warnings.length;
  const missingCount = dependencies.filter((dependency) => dependency.status === 'missing').length + unresolved;
  const resolvedCount = dependencies.filter((dependency) => dependency.status === 'resolved').length;
  const collectedWorkbookIds = new Set(workbooks.map((workbook) => workbook.id));
  const collectionComplete = !stats.truncated
    && stats.errors.length === 0
    && stats.permissionGaps.length === 0
    && scope.dataModelIds.every((id) => dataModelsById.has(id))
    && scope.workbookIds.every((id) => collectedWorkbookIds.has(id))
    && workbooks.every((workbook) => (workbookReferences.get(workbook.id)?.length || 0) > 0)
    && referencedDataModelIds.every((id) => dataModelsById.has(id));
  const manualRequirements = [
    ...(workbooks.length > 0 ? ['Validate workbook layout, unsupported interactions, and operational behavior manually; Sigma workbook endpoints are content evidence and not a portable model specification.'] : []),
    ...(stats.warnings.length > 0 ? ['Review optional Sigma endpoint gaps before treating the selected scope as complete.'] : []),
    ...(reviewCount > 0 ? ['Resolve security, schedule, layout, and interaction handoffs before Apply to Dev.'] : []),
  ];
  const status: MigrationPreparedEvidenceResult['status'] = stats.truncated
    ? 'bounded'
    : missingCount > 0
      ? 'partial'
      : reviewCount > 0
        ? 'partial'
        : 'complete';
  const inventory: MigrationInventory = {
    sourceTool: 'sigma',
    artifactCount: artifacts.length,
    artifacts: [],
    views,
    explores: [],
    relationships,
    dashboards,
    metrics,
    warnings: Array.from(new Set([...stats.warnings, ...stats.permissionGaps, ...manualRequirements])).sort(),
    summary: `${dataModels.length} authoritative Data Model spec${dataModels.length === 1 ? '' : 's'} · ${workbooks.length} workbook content bundle${workbooks.length === 1 ? '' : 's'} · ${dashboards.length} page${dashboards.length === 1 ? '' : 's'}`,
  };
  const evidenceContract: MigrationPreparedEvidenceResult['evidenceContract'] = {
    schemaVersion: 'omnikit.source-evidence.v2',
    sourceTool: 'sigma',
    parser: { name: 'OmniKit Sigma API normalizer', version: '2' },
    acquisition: { mode: 'api', runId: context.scopeFingerprint, selectedScopeIds: [...context.selectedRootIds].sort() },
    collection: { observedArtifactCount: artifacts.length, complete: collectionComplete && missingCount === 0, truncated: stats.truncated, permissionGaps: Array.from(new Set(stats.permissionGaps)).sort() },
    dependencyClosure: { status: missingCount > 0 ? 'blocked' : reviewCount > 0 ? 'partial' : 'complete', resolvedCount, missingCount, reviewCount },
    artifactFingerprints: artifacts.map((artifact) => ({ name: artifact.name, sha256: artifact.sha256, sizeBytes: artifact.sizeBytes })),
    documentationIds: [SIGMA_AUTH_DOCUMENTATION, SIGMA_DATA_MODEL_SPEC_DOCUMENTATION, SIGMA_WORKBOOK_DOCUMENTATION],
    diagnostics: Array.from(new Set([...stats.errors, ...stats.warnings, ...stats.permissionGaps, ...manualRequirements])).sort(),
  };
  inventory.sourceEvidence = evidenceContract;
  return {
    schemaVersion: 'omnikit.prepared-source-evidence.v1',
    platform: 'sigma',
    connectionId: connection.id,
    connectionUpdatedAt: connection.updatedAt,
    selectedRootIds: [...context.selectedRootIds].sort(),
    scopeFingerprint: context.scopeFingerprint,
    preparedAt: new Date().toISOString(),
    status,
    evidenceContract,
    inventory,
    artifacts,
    dependencies,
    diagnostics: {
      complete: collectionComplete && missingCount === 0,
      verifiedEmpty: false,
      truncated: stats.truncated,
      requestsMade: stats.requestsMade,
      pagesFetched: stats.pagesFetched,
      itemsObserved: stats.itemsObserved,
      bytesRead: stats.bytesRead,
      limits: { maxRequests: MAX_REQUESTS, maxPages: MAX_PAGES, maxItems: MAX_ELEMENTS, maxBytes: MAX_TOTAL_BYTES },
      permissionGaps: Array.from(new Set(stats.permissionGaps)).sort(),
      manualRequirements,
      errors: Array.from(new Set(stats.errors)).sort(),
      warnings: Array.from(new Set(stats.warnings)).sort(),
    },
  };
}

export const sigmaEvidenceCollector: MigrationSourceEvidenceCollector = {
  platform: 'sigma',
  prepareEvidence: prepareSigmaEvidence,
};

import { createHash } from 'node:crypto';
import type {
  MigrationArtifact,
  MigrationDashboardEvidence,
  MigrationInventory,
  MigrationMeasure,
  MigrationSourceArtifactProvenance,
  MigrationSourceDependencyEvidence,
} from '../../../src/services/semanticMigration/types';
import { parseMicroStrategyManualArtifacts } from '../semanticMigration/microStrategyManualParser';
import type {
  MigrationPreparedEvidenceResult,
  MigrationSourceCollectorContext,
  MigrationSourceEvidenceCollector,
} from './contracts';

const STRATEGY_LOGIN_DOCUMENTATION = 'https://microstrategy.github.io/rest-api-docs/getting-started/authentication/';
const STRATEGY_PROJECT_DOCUMENTATION = 'https://microstrategy.github.io/rest-api-docs/common-workflows/analytics/project-management/';
const STRATEGY_REPORT_DOCUMENTATION = 'https://microstrategy.github.io/rest-api-docs/common-workflows/analytics/manage-reports/manage-report-objects/retrieve-a-reports-definition/';
const STRATEGY_DOSSIER_DOCUMENTATION = 'https://microstrategy.github.io/rest-api-docs/common-workflows/analytics/filter-data/filter-dossier-instances/apply-filters-to-a-dossier/';
const STRATEGY_METRIC_DOCUMENTATION = 'https://microstrategy.github.io/rest-api-docs/common-workflows/modeling/manage-metric-objects/retrieve-a-metrics-definition/';
const STRATEGY_FILTER_DOCUMENTATION = 'https://microstrategy.github.io/rest-api-docs/common-workflows/modeling/manage-filter-objects/retrieve-a-filters-definition/';
const MAX_SELECTED_ROOTS = 200;
const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
const MAX_SCAN_RECORDS = 12_000;
const MAX_SCAN_DEPTH = 14;
const REQUEST_DEADLINE_MS = 30_000;
const DISCOVERY_PAGE_SIZE = 200;
const MAX_DISCOVERY_ITEMS_PER_KIND = 1_000;
// Five data pages plus one terminal probe prove an exact 1,000-item boundary.
const MAX_DISCOVERY_PAGES_PER_KIND = Math.ceil(MAX_DISCOVERY_ITEMS_PER_KIND / DISCOVERY_PAGE_SIZE) + 1;

type JsonRecord = Record<string, unknown>;
type StrategyRootKind = 'project' | 'report' | 'dossier' | 'metric' | 'filter' | 'unknown';

interface StrategyRoot {
  kind: StrategyRootKind;
  id: string;
}

interface CollectedDefinition {
  kind: Exclude<StrategyRootKind, 'unknown'>;
  id: string;
  body: JsonRecord;
}

interface CollectionStats {
  requestsMade: number;
  bytesRead: number;
  permissionGaps: string[];
  warnings: string[];
  errors: string[];
}

export interface MicroStrategyDiscoveryResult {
  platform: 'microstrategy';
  connectionId: string;
  connectionUpdatedAt: string;
  projectId: string;
  items: Array<{
    id: string;
    name: string;
    kind: 'project' | 'report' | 'dashboard' | 'metric' | 'filter';
    parentId?: string;
  }>;
  complete: boolean;
  truncated: boolean;
  requestsMade: number;
  pagesFetched: number;
  bytesRead: number;
  warnings: string[];
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value)
    ? value.filter((item): item is JsonRecord => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];
}

function stringValue(...values: unknown[]): string {
  const value = values.find((item) => typeof item === 'string' && item.trim());
  return typeof value === 'string' ? value.trim() : '';
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort();
}

function canonicalize(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(Object.entries(item as JsonRecord)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, normalize(child)]));
  };
  return JSON.stringify(normalize(value));
}

function fingerprint(value: unknown): { sha256: string; sizeBytes: number; normalized: string } {
  const normalized = canonicalize(value);
  const sizeBytes = Buffer.byteLength(normalized, 'utf8');
  if (sizeBytes > MAX_ARTIFACT_BYTES) {
    throw Object.assign(new Error('A selected Strategy definition exceeded the 10 MB normalized evidence limit.'), { statusCode: 413 });
  }
  return { sha256: createHash('sha256').update(normalized).digest('hex'), sizeBytes, normalized };
}

function strategyApiBase(raw: string): string {
  const url = new URL(raw);
  url.hash = '';
  url.search = '';
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = /\/api$/i.test(path) ? path : `${path}/api`;
  return url.toString().replace(/\/+$/, '');
}

function parseScope(selectedRootIds: readonly string[], projectId: string): StrategyRoot[] {
  if (selectedRootIds.length === 0) throw Object.assign(new Error('Select at least one Strategy report, dashboard, metric, filter, or project.'), { statusCode: 400 });
  if (selectedRootIds.length > MAX_SELECTED_ROOTS) throw Object.assign(new Error(`Select ${MAX_SELECTED_ROOTS} or fewer Strategy roots.`), { statusCode: 400 });
  const roots = selectedRootIds.map((raw): StrategyRoot => {
    const value = raw.trim();
    const separator = value.indexOf(':');
    const rawKind = separator > 0 ? value.slice(0, separator).toLowerCase() : 'unknown';
    const id = separator > 0 ? value.slice(separator + 1).trim() : value;
    if (!id || id.length > 300) throw Object.assign(new Error('A Strategy source identifier is invalid.'), { statusCode: 400 });
    const aliases: Record<string, StrategyRootKind> = {
      project: 'project',
      report: 'report',
      dossier: 'dossier',
      dashboard: 'dossier',
      document: 'dossier',
      metric: 'metric',
      filter: 'filter',
      unknown: 'unknown',
    };
    const kind = aliases[rawKind];
    if (!kind) throw Object.assign(new Error(`Unsupported Strategy source kind: ${rawKind}.`), { statusCode: 400 });
    if (kind === 'project' && id !== projectId) {
      throw Object.assign(new Error('The selected Strategy project does not match the project bound to this saved connection.'), { statusCode: 409 });
    }
    return { kind, id };
  });
  return Array.from(new Map(roots.map((root) => [`${root.kind}:${root.id}`, root])).values())
    .sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`));
}

function responseHeader(headers: Readonly<Record<string, string>>, name: string): string {
  const expected = name.toLowerCase();
  return Object.entries(headers).find(([key]) => key.toLowerCase() === expected)?.[1]?.trim() || '';
}

async function strategyLogin(
  context: MigrationSourceCollectorContext,
  stats: CollectionStats,
  apiBase: string,
): Promise<string> {
  const { connection } = context;
  if (connection.authMode !== 'username_password_session' || !connection.username || connection.credential === undefined || !connection.projectId) {
    throw Object.assign(new Error('Strategy Saved API requires a username, password, and project ID for standard session login.'), { statusCode: 409 });
  }
  const login = await context.transport.request<string>({
    url: `${apiBase}/auth/login`,
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: connection.username, password: connection.credential, loginMode: 1 }),
    responseType: 'text',
    label: 'Strategy standard session login',
    allowStatuses: [200, 204],
    maxResponseBytes: 64 * 1024,
    deadlineMs: REQUEST_DEADLINE_MS,
    signal: context.signal,
  });
  stats.requestsMade += login.requestCount;
  stats.bytesRead += login.bytesRead;
  const token = responseHeader(login.headers, 'x-mstr-authtoken');
  if (!token) throw Object.assign(new Error('Strategy login did not return an ephemeral authorization token.'), { statusCode: 502 });
  context.registerSensitiveValue?.(token, 'Strategy session login');
  return token;
}

async function strategyLogout(
  context: MigrationSourceCollectorContext,
  stats: CollectionStats,
  apiBase: string,
  token: string,
): Promise<void> {
  try {
    const logout = await context.transport.request<string>({
      url: `${apiBase}/auth/logout`,
      method: 'POST',
      headers: { Accept: 'application/json', 'X-MSTR-AuthToken': token },
      responseType: 'text',
      label: 'Strategy session logout',
      allowStatuses: [200, 204, 401, 403],
      maxResponseBytes: 64 * 1024,
      deadlineMs: REQUEST_DEADLINE_MS,
      signal: context.signal,
    });
    stats.requestsMade += logout.requestCount;
    stats.bytesRead += logout.bytesRead;
    if (logout.status !== 200 && logout.status !== 204) stats.warnings.push('Strategy did not confirm that the ephemeral session was closed.');
  } catch {
    stats.warnings.push('Strategy session logout could not be confirmed; no session token was retained by OmniKit.');
  }
}

type StrategyDiscoveryKind = 'report' | 'dashboard' | 'metric' | 'filter';

interface StrategyDiscoveryPageResult {
  items: MicroStrategyDiscoveryResult['items'];
  pagesFetched: number;
  truncated: boolean;
}

function strategySearchRows(payload: unknown): { recognized: boolean; rows: JsonRecord[] } {
  const body = asRecord(payload);
  const rawRows = Array.isArray(payload)
    ? payload
    : (['result', 'results', 'objects'] as const)
      .map((key) => body[key])
      .find(Array.isArray);
  if (!Array.isArray(rawRows)) return { recognized: false, rows: [] };
  const normalized = records(rawRows);
  return normalized.length === rawRows.length
    ? { recognized: true, rows: normalized }
    : { recognized: false, rows: [] };
}

function strategyDiscoveryRowId(row: JsonRecord): string {
  const info = asRecord(row.information || row.info);
  return stringValue(row.id, row.objectId, info.objectId, info.id);
}

async function discoverStrategyKind(
  context: MigrationSourceCollectorContext,
  stats: CollectionStats,
  apiBase: string,
  token: string,
  projectId: string,
  search: { type: number; kind: StrategyDiscoveryKind },
): Promise<StrategyDiscoveryPageResult> {
  const collected = new Map<string, MicroStrategyDiscoveryResult['items'][number]>();
  let offset = 0;
  let pagesFetched = 0;
  let terminalPageObserved = false;
  let truncated = false;
  let permissionDenied = false;
  let previousPageSignature = '';

  for (let page = 0; page < MAX_DISCOVERY_PAGES_PER_KIND; page += 1) {
    const query = new URLSearchParams({
      pattern: '*',
      type: String(search.type),
      limit: String(DISCOVERY_PAGE_SIZE),
      offset: String(offset),
    });
    const response = await requestStrategyJson(
      context,
      stats,
      apiBase,
      token,
      projectId,
      `/searches/results?${query.toString()}`,
      `Strategy ${search.kind} discovery page ${page + 1}`,
    );
    pagesFetched += 1;
    if (response.status !== 200) {
      permissionDenied = true;
      stats.permissionGaps.push(`Strategy ${search.kind} catalog was not accessible to the saved session.`);
      break;
    }

    const parsed = strategySearchRows(response.body);
    if (!parsed.recognized) {
      truncated = true;
      stats.errors.push(`Strategy ${search.kind} discovery returned an unrecognized page shape; the catalog is incomplete.`);
      break;
    }
    if (parsed.rows.length > DISCOVERY_PAGE_SIZE) {
      truncated = true;
      stats.errors.push(`Strategy ${search.kind} discovery returned more rows than its documented page limit; the catalog is incomplete.`);
      break;
    }
    if (parsed.rows.length === 0) {
      terminalPageObserved = true;
      break;
    }

    const identified = parsed.rows.map((row) => ({ id: strategyDiscoveryRowId(row), row }));
    if (identified.some((item) => !item.id)) {
      truncated = true;
      stats.errors.push(`Strategy ${search.kind} discovery returned a row without an ID; the catalog is incomplete.`);
      break;
    }
    const pageSignature = identified.map((item) => item.id).join('\u0000');
    if (pageSignature === previousPageSignature) {
      truncated = true;
      stats.warnings.push(`Strategy ${search.kind} discovery repeated a page without advancing; narrow the project scope before planning.`);
      break;
    }
    previousPageSignature = pageSignature;

    const uniquePage = new Map<string, JsonRecord>();
    identified.forEach((item) => uniquePage.set(item.id, item.row));
    const newRows = Array.from(uniquePage.entries()).filter(([id]) => !collected.has(id));
    const duplicateCount = identified.length - newRows.length;
    if (newRows.length === 0) {
      truncated = true;
      stats.warnings.push(`Strategy ${search.kind} discovery made no ID progress; narrow the project scope before planning.`);
      break;
    }

    const remaining = MAX_DISCOVERY_ITEMS_PER_KIND - collected.size;
    newRows.slice(0, Math.max(0, remaining)).forEach(([id, row]) => {
      const info = asRecord(row.information || row.info);
      const rootKind = search.kind === 'dashboard' ? 'dossier' : search.kind;
      collected.set(id, {
        id: `${rootKind}:${id}`,
        name: stringValue(row.name, row.title, info.name) || id,
        kind: search.kind,
        parentId: `project:${projectId}`,
      });
    });
    if (duplicateCount > 0) {
      truncated = true;
      stats.warnings.push(`Strategy ${search.kind} discovery returned overlapping IDs across a page boundary; the deduplicated catalog is incomplete.`);
      break;
    }
    if (newRows.length > remaining || (remaining === 0 && newRows.length > 0)) {
      truncated = true;
      stats.warnings.push(`Strategy ${search.kind} discovery exceeded the ${MAX_DISCOVERY_ITEMS_PER_KIND}-item safety bound; narrow the project scope before planning.`);
      break;
    }
    if (parsed.rows.length < DISCOVERY_PAGE_SIZE) {
      terminalPageObserved = true;
      break;
    }
    offset += parsed.rows.length;
  }

  if (!terminalPageObserved && !truncated && !permissionDenied) {
    truncated = true;
    stats.warnings.push(`Strategy ${search.kind} discovery reached the ${MAX_DISCOVERY_PAGES_PER_KIND}-page safety bound without terminal evidence.`);
  }
  return { items: Array.from(collected.values()), pagesFetched, truncated };
}

/**
 * Authenticated Strategy catalog discovery. Search results are selection
 * metadata only; selected definitions are fetched again by the evidence path.
 */
export async function discoverMicroStrategySource(context: MigrationSourceCollectorContext): Promise<MicroStrategyDiscoveryResult> {
  const { connection } = context;
  if (connection.platform !== 'microstrategy' || !connection.projectId) {
    throw Object.assign(new Error('The Strategy discovery helper requires a project-bound Strategy connection.'), { statusCode: 400 });
  }
  const apiBase = strategyApiBase(connection.baseUrl);
  const stats: CollectionStats = { requestsMade: 0, bytesRead: 0, permissionGaps: [], warnings: [], errors: [] };
  const token = await strategyLogin(context, stats, apiBase);
  const items: MicroStrategyDiscoveryResult['items'] = [];
  let pagesFetched = 0;
  let truncated = false;
  try {
    const projectsResponse = await requestStrategyJson(context, stats, apiBase, token, connection.projectId, '/projects', 'Strategy project inventory');
    pagesFetched += 1;
    const projectRows = Array.isArray(projectsResponse.body) ? records(projectsResponse.body) : records(asRecord(projectsResponse.body).projects);
    const selectedProject = projectRows.find((project) => stringValue(project.id, asRecord(project.information).objectId) === connection.projectId);
    if (!selectedProject) throw Object.assign(new Error('The configured Strategy project was not visible to the authenticated session.'), { statusCode: 403 });
    items.push({ id: `project:${connection.projectId}`, name: definitionName(selectedProject, connection.name), kind: 'project' });

    const searches: Array<{ type: number; kind: StrategyDiscoveryKind }> = [
      { type: 3, kind: 'report' },
      { type: 55, kind: 'dashboard' },
      { type: 4, kind: 'metric' },
      { type: 1, kind: 'filter' },
    ];
    for (const search of searches) {
      const discovered = await discoverStrategyKind(
        context,
        stats,
        apiBase,
        token,
        connection.projectId,
        search,
      );
      items.push(...discovered.items);
      pagesFetched += discovered.pagesFetched;
      truncated = truncated || discovered.truncated;
    }
  } finally {
    await strategyLogout(context, stats, apiBase, token);
  }
  const deduplicatedItems = Array.from(new Map(items.map((item) => [item.id, item])).values());
  return {
    platform: 'microstrategy',
    connectionId: connection.id,
    connectionUpdatedAt: connection.updatedAt,
    projectId: connection.projectId,
    items: deduplicatedItems,
    complete: stats.permissionGaps.length === 0 && stats.errors.length === 0 && !truncated,
    truncated,
    requestsMade: stats.requestsMade,
    pagesFetched,
    bytesRead: stats.bytesRead,
    warnings: unique([...stats.warnings, ...stats.permissionGaps, ...stats.errors]),
  };
}

function definitionInfo(definition: JsonRecord): JsonRecord {
  return asRecord(definition.information || definition.info);
}

function definitionName(definition: JsonRecord, fallback: string): string {
  const info = definitionInfo(definition);
  return stringValue(info.name, definition.name, definition.title) || fallback;
}

function definitionDocumentation(kind: Exclude<StrategyRootKind, 'unknown'>): string {
  if (kind === 'project') return STRATEGY_PROJECT_DOCUMENTATION;
  if (kind === 'report') return STRATEGY_REPORT_DOCUMENTATION;
  if (kind === 'dossier') return STRATEGY_DOSSIER_DOCUMENTATION;
  if (kind === 'metric') return STRATEGY_METRIC_DOCUMENTATION;
  return STRATEGY_FILTER_DOCUMENTATION;
}

function wrappedDefinition(definition: CollectedDefinition): unknown {
  if (definition.kind === 'project') return { projects: [definition.body] };
  if (definition.kind === 'report') return { reports: [definition.body] };
  if (definition.kind === 'dossier') return { dossiers: [definition.body] };
  if (definition.kind === 'metric') return { metrics: [definition.body] };
  return { filters: [definition.body] };
}

function sourceArtifact(definition: CollectedDefinition): { migrationArtifact: MigrationArtifact; provenance: MigrationSourceArtifactProvenance } {
  const wrapped = wrappedDefinition(definition);
  const digest = fingerprint(wrapped);
  const name = definitionName(definition.body, `${definition.kind} ${definition.id}`);
  const locator = `${definition.kind}:${definition.id}`;
  return {
    migrationArtifact: {
      id: `strategy:${locator}`,
      sourceTool: 'microstrategy',
      name: `${definition.kind}-${definition.id}.json`,
      kind: 'json',
      content: digest.normalized,
      sizeBytes: digest.sizeBytes,
      parseWarnings: definition.kind === 'dossier'
        ? ['Strategy dossier API evidence is limited to the documented filter, selector, and dataset projection; it is not a complete visual, layout, or document package.']
        : [],
    },
    provenance: {
      id: `strategy:${locator}`,
      name,
      sourceId: `strategy:${locator}`,
      locator,
      mediaType: 'application/json',
      evidenceClass: definition.kind === 'dossier' ? 'compiled_definition' : 'authoritative_definition',
      sha256: digest.sha256,
      sizeBytes: digest.sizeBytes,
      documentationIds: [definitionDocumentation(definition.kind)],
      rawContentIncluded: false,
    },
  };
}

async function requestStrategyJson(
  context: MigrationSourceCollectorContext,
  stats: CollectionStats,
  apiBase: string,
  token: string,
  projectId: string,
  path: string,
  label: string,
): Promise<{ status: number; body: unknown }> {
  const response = await context.transport.request<string>({
    url: `${apiBase}${path}`,
    method: 'GET',
    headers: { Accept: 'application/json', 'X-MSTR-AuthToken': token, 'X-MSTR-ProjectID': projectId },
    responseType: 'text',
    label,
    allowStatuses: [200, 403, 404],
    maxResponseBytes: MAX_ARTIFACT_BYTES,
    deadlineMs: REQUEST_DEADLINE_MS,
    signal: context.signal,
  });
  stats.requestsMade += response.requestCount;
  stats.bytesRead += response.bytesRead;
  if (response.status !== 200) return { status: response.status, body: {} };
  try {
    return { status: response.status, body: response.body.trim() ? JSON.parse(response.body) as unknown : {} };
  } catch {
    throw Object.assign(new Error(`${label} returned an unrecognized non-JSON success response.`), { statusCode: 502 });
  }
}

function recordsWithNames(value: unknown): JsonRecord[] {
  const output: JsonRecord[] = [];
  let seen = 0;
  const visit = (item: unknown, depth: number): void => {
    if (depth > MAX_SCAN_DEPTH || seen >= MAX_SCAN_RECORDS) return;
    if (Array.isArray(item)) {
      item.forEach((child) => visit(child, depth + 1));
      return;
    }
    if (!item || typeof item !== 'object') return;
    seen += 1;
    const record = item as JsonRecord;
    const info = definitionInfo(record);
    if (stringValue(record.name, record.title, info.name)) output.push(record);
    Object.values(record).forEach((child) => visit(child, depth + 1));
  };
  visit(value, 0);
  return output;
}

function objectFields(value: unknown): string[] {
  return unique(recordsWithNames(value).flatMap((record) => {
    const info = definitionInfo(record);
    const subtype = stringValue(record.subType, record.type, info.subType, info.type).toLowerCase();
    return /attribute|metric|form|column|field/.test(subtype)
      ? [stringValue(record.name, record.title, info.name)]
      : [];
  })).slice(0, 500);
}

function objectFilters(value: unknown): string[] {
  return unique(recordsWithNames(value).flatMap((record) => {
    const info = definitionInfo(record);
    const subtype = stringValue(record.subType, record.type, info.subType, info.type).toLowerCase();
    return /filter|prompt|selector|limit|qualification/.test(subtype)
      ? [stringValue(record.name, record.title, info.name, record.summary)]
      : [];
  })).slice(0, 200);
}

function directMetric(definition: CollectedDefinition): MigrationMeasure | undefined {
  if (definition.kind !== 'metric') return undefined;
  const info = definitionInfo(definition.body);
  const expression = asRecord(definition.body.expression);
  const id = stringValue(info.objectId, definition.body.id) || definition.id;
  return {
    sourceId: `strategy:metric:${id}`,
    sourceLocator: `metric:${id}`,
    name: definitionName(definition.body, `Metric ${id}`),
    sql: stringValue(expression.text, definition.body.formula, definition.body.expression) || undefined,
    aggregateType: stringValue(info.subType, definition.body.subType) || 'Strategy metric',
    sourceArtifact: `metric-${definition.id}.json`,
  };
}

function directDashboard(definition: CollectedDefinition): MigrationDashboardEvidence | undefined {
  if (definition.kind !== 'report' && definition.kind !== 'dossier') return undefined;
  const dossierProjection = definition.kind === 'dossier';
  return {
    sourceId: `strategy:${definition.kind}:${definition.id}`,
    sourceLocator: `${definition.kind}:${definition.id}`,
    name: definitionName(definition.body, `${definition.kind} ${definition.id}`),
    fields: objectFields(definition.body),
    filters: objectFilters(definition.body),
    assetKind: 'dashboard',
    sourceArtifact: `${definition.kind}-${definition.id}.json`,
    ...(dossierProjection ? {
      featureFlags: ['Strategy dossier filter, selector, and dataset API projection'],
      riskFlags: ['Full dossier visuals, layout, formatting, interactions, and document package require manual evidence'],
      metadata: { evidenceScope: 'filter_selector_dataset_projection', completeVisualDefinition: false },
    } : {}),
  };
}

function referenceDependencies(definition: CollectedDefinition): MigrationSourceDependencyEvidence[] {
  const rootId = definition.id;
  const candidates = recordsWithNames(definition.body).flatMap((record) => {
    const info = definitionInfo(record);
    const id = stringValue(record.objectId, record.id, info.objectId);
    const subtype = stringValue(record.subType, record.type, info.subType, info.type).toLowerCase();
    if (!id || id === rootId || !subtype) return [];
    const category: MigrationSourceDependencyEvidence['category'] = /metric/.test(subtype)
      ? 'calculation'
      : /filter|prompt|selector|limit|qualification/.test(subtype)
        ? 'filter'
        : /attribute|form|field/.test(subtype)
          ? 'field'
          : /cube|dataset|table/.test(subtype)
            ? 'data_source'
            : 'unknown';
    return [{
      sourceId: `strategy:${definition.kind}:${rootId}`,
      dependencySourceId: `strategy:${subtype}:${id}`,
      category,
      required: true,
      status: 'review_required' as const,
      reason: `The ${definition.kind} definition references ${stringValue(record.name, info.name) || subtype}; retrieve its definition when source fidelity depends on it.`,
    }];
  });
  return Array.from(new Map(candidates.map((item) => [`${item.sourceId}:${item.dependencySourceId}:${item.category}`, item])).values());
}

function mergeDashboards(values: MigrationDashboardEvidence[]): MigrationDashboardEvidence[] {
  return Array.from(new Map(values.map((item) => [item.sourceId || `${item.name}:${item.sourceArtifact}`, item])).values());
}

function mergeMetrics(values: MigrationMeasure[]): MigrationMeasure[] {
  return Array.from(new Map(values.map((item) => [item.sourceId || `${item.name}:${item.sourceArtifact}`, item])).values());
}

export async function prepareMicroStrategyEvidence(context: MigrationSourceCollectorContext): Promise<MigrationPreparedEvidenceResult> {
  const { connection } = context;
  if (connection.platform !== 'microstrategy') throw Object.assign(new Error('The Strategy collector requires a Strategy connection.'), { statusCode: 400 });
  if (connection.authMode !== 'username_password_session' || !connection.username || connection.credential === undefined || !connection.projectId) {
    throw Object.assign(new Error('Strategy Saved API requires a username, password, and project ID for standard session login.'), { statusCode: 409 });
  }
  const projectId = connection.projectId;
  const roots = parseScope(context.selectedRootIds, connection.projectId);
  const apiBase = strategyApiBase(connection.baseUrl);
  const stats: CollectionStats = { requestsMade: 0, bytesRead: 0, permissionGaps: [], warnings: [], errors: [] };
  const token = await strategyLogin(context, stats, apiBase);

  const collected: CollectedDefinition[] = [];
  try {
    const projectsResponse = await requestStrategyJson(context, stats, apiBase, token, connection.projectId, '/projects', 'Strategy project inventory');
    const projectRows = Array.isArray(projectsResponse.body) ? records(projectsResponse.body) : records(asRecord(projectsResponse.body).projects);
    const selectedProject = projectRows.find((project) => stringValue(project.id, asRecord(project.information).objectId) === connection.projectId);
    if (!selectedProject) {
      throw Object.assign(new Error('The configured Strategy project was not visible to the authenticated session.'), { statusCode: 403 });
    }
    collected.push({ kind: 'project', id: connection.projectId, body: selectedProject });

    const fetchTyped = async (kind: Exclude<StrategyRootKind, 'project' | 'unknown'>, id: string): Promise<boolean> => {
      const paths: Record<typeof kind, string> = {
        report: `/model/reports/${encodeURIComponent(id)}?showExpressionAs=tree&showFilterTokens=true&showAdvancedProperties=true`,
        dossier: `/dossiers/${encodeURIComponent(id)}/definition`,
        metric: `/model/metrics/${encodeURIComponent(id)}?showExpressionAs=tree&showFilterTokens=true&showAdvancedProperties=true`,
        filter: `/model/filters/${encodeURIComponent(id)}?showExpressionAs=tree&showFilterTokens=true`,
      };
      const definitionPath = paths[kind];
      if (!definitionPath) {
        throw Object.assign(new Error(`Strategy ${kind} does not have a bounded definition endpoint.`), { statusCode: 500 });
      }
      const response = await requestStrategyJson(
        context,
        stats,
        apiBase,
        token,
        projectId,
        definitionPath,
        kind === 'dossier' ? 'Strategy dossier filter, selector, and dataset projection' : `Strategy ${kind} definition`,
      );
      if (response.status !== 200) return false;
      const body = asRecord(response.body);
      if (Object.keys(body).length === 0) {
        stats.errors.push(`Strategy ${kind} ${id} returned an empty definition.`);
        return false;
      }
      collected.push({ kind, id, body });
      return true;
    };

    for (const root of roots) {
      if (root.kind === 'project') continue;
      if (root.kind === 'unknown') {
        const reportFound = await fetchTyped('report', root.id);
        const dossierFound = reportFound ? false : await fetchTyped('dossier', root.id);
        if (!reportFound && !dossierFound) stats.permissionGaps.push(`Selected Strategy content ${root.id} was not available as a report definition or dossier filter/selector projection.`);
        continue;
      }
      const found = await fetchTyped(root.kind, root.id);
      if (!found) stats.permissionGaps.push(`Selected Strategy ${root.kind} ${root.id} was not accessible through the configured session.`);
    }
  } finally {
    await strategyLogout(context, stats, apiBase, token);
  }

  const sourceArtifacts = collected.map(sourceArtifact);
  // The dossier endpoint is not a portable visual/layout definition contract.
  // Keep it fingerprinted as a compiled API projection, but do not feed it to
  // the manual package parser, which expects a complete dossier/document bundle.
  const parserArtifacts = sourceArtifacts
    .filter((_item, index) => collected[index]?.kind !== 'dossier')
    .map((item) => item.migrationArtifact);
  const parsed = parseMicroStrategyManualArtifacts(parserArtifacts);
  const artifacts = sourceArtifacts.map((item) => item.provenance);
  const dependencies: MigrationSourceDependencyEvidence[] = [
    ...collected.map((definition): MigrationSourceDependencyEvidence => ({
      sourceId: `strategy:${definition.kind}:${definition.id}`,
      category: definition.kind === 'project' ? 'semantic_model' : definition.kind === 'metric' ? 'calculation' : definition.kind === 'filter' ? 'filter' : 'content',
      required: true,
      status: definition.kind === 'dossier' ? 'review_required' : 'resolved',
      reason: definition.kind === 'dossier'
        ? 'The selected dossier contributed only the documented filter, selector, and dataset API projection; it does not establish complete visual or layout fidelity.'
        : `The selected ${definition.kind} definition was acquired through the documented project-scoped Strategy API.`,
    })),
    ...collected.filter((definition) => definition.kind === 'dossier').map((definition): MigrationSourceDependencyEvidence => ({
      sourceId: `strategy:dossier:${definition.id}:visual-package`,
      dependencySourceId: `strategy:dossier:${definition.id}`,
      category: 'content',
      required: true,
      status: 'manual_required',
      reason: 'Supply the official dossier/document migration package or equivalent manual evidence for visuals, layout, formatting, interactions, panels, and document-level behavior.',
    })),
    ...collected.flatMap(referenceDependencies),
    ...stats.permissionGaps.map((gap, index): MigrationSourceDependencyEvidence => ({
      sourceId: `strategy:missing:${index + 1}`,
      category: 'unknown',
      required: true,
      status: 'missing',
      reason: gap,
    })),
    {
      sourceId: `strategy:scope:${context.scopeFingerprint}`,
      category: 'security',
      required: true,
      status: 'manual_required',
      reason: 'ACLs, schedules, prompt answer behavior, and unavailable referenced definitions require explicit migration evidence and review.',
    },
  ];
  const directDashboards = collected.map(directDashboard).filter((item): item is MigrationDashboardEvidence => Boolean(item));
  const directMetrics = collected.map(directMetric).filter((item): item is MigrationMeasure => Boolean(item));
  const metrics = mergeMetrics([...parsed.inventory.metrics, ...directMetrics]);
  const dashboards = mergeDashboards([...parsed.inventory.dashboards, ...directDashboards]);
  const manualRequirements = [
    'Provide definitions for every referenced object that the selected report, metric, filter, or dashboard depends on.',
    'Review prompts, selectors, derived elements, security filters, report limits, and metric dimensionality explicitly.',
    'Acquire ACLs and schedules separately when they are in migration scope; object definitions do not prove governance closure.',
    ...(collected.some((definition) => definition.kind === 'dossier')
      ? ['Provide an official dossier/document migration package or equivalent Manual Files for complete visuals, layout, formatting, interactions, panels, and document behavior.']
      : []),
  ];
  const warnings = unique([...parsed.inventory.warnings, ...stats.warnings, ...manualRequirements]);
  const inventory: MigrationInventory = {
    ...parsed.inventory,
    artifactCount: artifacts.length,
    artifacts: [],
    dashboards,
    metrics,
    warnings,
    summary: `${collected.filter((item) => item.kind === 'report').length} report definition${collected.filter((item) => item.kind === 'report').length === 1 ? '' : 's'} · ${collected.filter((item) => item.kind === 'dossier').length} dossier filter/selector projection${collected.filter((item) => item.kind === 'dossier').length === 1 ? '' : 's'} · ${collected.filter((item) => item.kind === 'metric').length} metric${collected.filter((item) => item.kind === 'metric').length === 1 ? '' : 's'} · ${collected.filter((item) => item.kind === 'filter').length} filter${collected.filter((item) => item.kind === 'filter').length === 1 ? '' : 's'}`,
  };
  const missingCount = dependencies.filter((dependency) => dependency.status === 'missing').length;
  const resolvedCount = dependencies.filter((dependency) => dependency.status === 'resolved').length;
  const reviewCount = dependencies.filter((dependency) => dependency.status === 'review_required' || dependency.status === 'manual_required').length;
  const dossierManualRequired = collected.some((definition) => definition.kind === 'dossier');
  const collectionComplete = stats.permissionGaps.length === 0 && stats.errors.length === 0;
  const documentationIds = [
    STRATEGY_LOGIN_DOCUMENTATION,
    STRATEGY_PROJECT_DOCUMENTATION,
    STRATEGY_REPORT_DOCUMENTATION,
    STRATEGY_DOSSIER_DOCUMENTATION,
    STRATEGY_METRIC_DOCUMENTATION,
    STRATEGY_FILTER_DOCUMENTATION,
  ];
  const evidenceContract: MigrationPreparedEvidenceResult['evidenceContract'] = {
    schemaVersion: 'omnikit.source-evidence.v2',
    sourceTool: 'microstrategy',
    parser: { name: 'OmniKit Strategy project-scoped definition normalizer', version: '1' },
    acquisition: { mode: 'api', runId: context.scopeFingerprint, selectedScopeIds: [...context.selectedRootIds].sort() },
    collection: { observedArtifactCount: artifacts.length, complete: collectionComplete, truncated: false, permissionGaps: unique(stats.permissionGaps) },
    dependencyClosure: { status: missingCount > 0 ? 'blocked' : reviewCount > 0 ? 'partial' : 'complete', resolvedCount, missingCount, reviewCount },
    artifactFingerprints: artifacts.map((item) => ({ name: item.name, sha256: item.sha256, sizeBytes: item.sizeBytes })),
    documentationIds,
    diagnostics: unique([...stats.errors, ...stats.permissionGaps, ...warnings]),
  };
  inventory.sourceEvidence = evidenceContract;
  return {
    schemaVersion: 'omnikit.prepared-source-evidence.v1',
    platform: 'microstrategy',
    connectionId: connection.id,
    connectionUpdatedAt: connection.updatedAt,
    selectedRootIds: [...context.selectedRootIds].sort(),
    scopeFingerprint: context.scopeFingerprint,
    preparedAt: new Date().toISOString(),
    status: artifacts.length === 0 ? 'failed' : dossierManualRequired || missingCount > 0 ? 'manual_required' : 'partial',
    evidenceContract,
    inventory,
    artifacts,
    dependencies,
    diagnostics: {
      complete: collectionComplete,
      verifiedEmpty: false,
      truncated: false,
      requestsMade: stats.requestsMade,
      pagesFetched: stats.requestsMade,
      itemsObserved: artifacts.length,
      bytesRead: stats.bytesRead,
      limits: { maxRequests: 3 + (MAX_SELECTED_ROOTS * 2), maxPages: 3 + (MAX_SELECTED_ROOTS * 2), maxItems: MAX_SELECTED_ROOTS * 4, maxBytes: MAX_ARTIFACT_BYTES },
      permissionGaps: unique(stats.permissionGaps),
      manualRequirements,
      errors: unique(stats.errors),
      warnings: unique(stats.warnings),
    },
  };
}

export const microStrategyEvidenceCollector: MigrationSourceEvidenceCollector = {
  platform: 'microstrategy',
  prepareEvidence: prepareMicroStrategyEvidence,
};

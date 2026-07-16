import { assertSafeOutboundUrl } from '../security';
import type { MigrationInventory, MigrationSourceTool, MigrationView } from '../../src/services/semanticMigration/types';
import { redactSensitiveText } from './jobSanitizer';
import type { MigrationPlatformKind, SavedPlatformConnection } from './nativeVault';
import { migrationSourceHostAllowlist } from './semanticMigrationAudit';

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_INVENTORY_ITEMS = 1_000;
const MAX_INVENTORY_PAGES = 25;
const MAX_PARENT_EXPANSIONS = 100;
const MAX_CHILD_EXPANSIONS = 500;
const MAX_INVENTORY_REQUESTS = 500;

export type SourceAssetKind =
  | 'workspace'
  | 'project'
  | 'semantic_model'
  | 'data_source'
  | 'dataset'
  | 'report'
  | 'dashboard'
  | 'workbook'
  | 'page'
  | 'view'
  | 'tile'
  | 'visual'
  | 'card'
  | 'cube'
  | 'metric'
  | 'attribute'
  | 'calculation'
  | 'filter'
  | 'permission'
  | 'schedule'
  | 'repository_item';

export interface SourceConnectorCapabilities {
  apiInventory: boolean;
  semanticDefinitions: 'full' | 'partial' | 'export_required';
  contentDefinitions: 'full' | 'partial' | 'export_required';
  usage: boolean;
  permissions: boolean;
  schedules: boolean;
  queryValidation: boolean;
  visualEvidence: boolean;
}

export type SourceMigrationCoverageStatus = 'full' | 'partial' | 'export_required' | 'unsupported';
export type SourceMigrationCoverage = Record<'semantic_objects' | 'dashboards' | 'filters' | 'layout' | 'permissions' | 'schedules', SourceMigrationCoverageStatus>;

export interface SourceConnectorDefinition {
  platform: MigrationPlatformKind;
  label: string;
  authGuidance: string;
  capabilities: SourceConnectorCapabilities;
  migrationCoverage: SourceMigrationCoverage;
  limitations: string[];
}

export interface SourceInventoryItem {
  id: string;
  name: string;
  kind: SourceAssetKind;
  parentId?: string;
  path?: string;
  owner?: string;
  updatedAt?: string;
  usageCount?: number;
  dependencyIds: string[];
  featureFlags: string[];
  riskFlags: string[];
  metadata: Record<string, string | number | boolean | null>;
}

export interface SourceInventoryResult {
  platform: MigrationPlatformKind;
  connectionId: string;
  connector: SourceConnectorDefinition;
  items: SourceInventoryItem[];
  dashboardCatalog: SourceDashboardCatalogItem[];
  warnings: string[];
  truncated: boolean;
  collection: {
    scope: 'all_accessible' | 'saved_parent';
    scopeLabel: string;
    pagesFetched: number;
    parentsExpanded: number;
    requestsMade: number;
    maxPages: number;
    maxItems: number;
  };
}

function migrationSourceTool(platform: MigrationPlatformKind): MigrationSourceTool {
  const supported: Partial<Record<MigrationPlatformKind, MigrationSourceTool>> = {
    domo: 'domo',
    looker: 'looker',
    metabase: 'metabase',
    microstrategy: 'microstrategy',
    power_bi: 'power_bi',
    sigma: 'sigma',
    tableau: 'tableau',
    webfocus: 'webfocus',
  };
  const sourceTool = supported[platform];
  if (!sourceTool) throw Object.assign(new Error(`${platform} cannot produce a BI migration parity baseline.`), { statusCode: 400 });
  return sourceTool;
}

/**
 * Convert the local connector's server-fetched inventory into the deliberately smaller parity
 * projection used to compare it with the embedded engine. This never claims that catalog metadata
 * is equivalent to a full semantic export: absent fields, joins, queries, or layout remain absent and
 * therefore lower the differential score instead of being guessed into the baseline.
 */
export function sourceInventoryToMigrationInventory(
  source: SourceInventoryResult,
  selectedDashboardIds: string[] = [],
): MigrationInventory {
  const requested = new Set(selectedDashboardIds.map(String).filter(Boolean));
  const inScope = requested.size === 0
    ? new Set(source.items.map((item) => item.id))
    : new Set(Array.from(requested).flatMap((id) => [id, ...sourceDashboardDependencyClosure(id, source.items)]));
  const items = source.items.filter((item) => inScope.has(item.id));
  const semanticKinds = new Set<SourceAssetKind>(['semantic_model', 'data_source', 'dataset', 'view', 'cube']);
  const fieldKinds = new Set<SourceAssetKind>(['attribute']);
  const measureKinds = new Set<SourceAssetKind>(['metric', 'calculation']);
  const children = new Map<string, SourceInventoryItem[]>();
  items.forEach((item) => {
    if (!item.parentId) return;
    children.set(item.parentId, [...(children.get(item.parentId) || []), item]);
  });
  const views: MigrationView[] = items.filter((item) => semanticKinds.has(item.kind)).map((item) => {
    const nested = children.get(item.id) || [];
    return {
      sourceId: `${source.platform}:${item.kind}:${item.id}`,
      sourceLocator: item.path || `${item.kind}:${item.id}`,
      name: item.name,
      description: typeof item.metadata.description === 'string' ? item.metadata.description : undefined,
      kind: item.kind === 'view' ? 'query_view' : 'dataset',
      sourceArtifact: `server:${source.platform}:inventory`,
      fields: nested.filter((child) => fieldKinds.has(child.kind)).map((field) => ({
        sourceId: `${source.platform}:${field.kind}:${field.id}`,
        sourceLocator: field.path || `${field.kind}:${field.id}`,
        name: field.name,
        sourceArtifact: `server:${source.platform}:inventory`,
      })),
      measures: nested.filter((child) => measureKinds.has(child.kind)).map((measure) => ({
        sourceId: `${source.platform}:${measure.kind}:${measure.id}`,
        sourceLocator: measure.path || `${measure.kind}:${measure.id}`,
        name: measure.name,
        aggregateType: measure.kind,
        sourceArtifact: `server:${source.platform}:inventory`,
      })),
      warnings: [],
    };
  });
  const dashboards = source.dashboardCatalog.filter((dashboard) => requested.size === 0 || requested.has(dashboard.id)).map((dashboard) => ({
    sourceId: `${source.platform}:${dashboard.kind}:${dashboard.id}`,
    sourceLocator: dashboard.path || `${dashboard.kind}:${dashboard.id}`,
    name: dashboard.name,
    fields: [],
    filters: [],
    sourceArtifact: `server:${source.platform}:inventory`,
  }));
  const metrics = views.flatMap((view) => view.measures);
  const parityLimitations = 'Native API inventory is a metadata differential baseline. Missing semantic definitions, joins, queries, filters, or layout lower parity and are never inferred.';
  return {
    sourceTool: migrationSourceTool(source.platform),
    artifactCount: 0,
    artifacts: [],
    views,
    explores: [],
    relationships: [],
    dashboards,
    metrics,
    warnings: [...source.warnings, ...(source.truncated ? ['Native source inventory was truncated and cannot qualify as complete parity evidence.'] : []), parityLimitations],
    summary: `${views.length} server-fetched semantic catalog item${views.length === 1 ? '' : 's'} · ${dashboards.length} selected dashboard${dashboards.length === 1 ? '' : 's'} · native differential baseline`,
  };
}

export type SourceDependencyCategory = 'semantic_model' | 'data_source' | 'field' | 'calculation' | 'relationship' | 'filter' | 'security' | 'schedule' | 'content' | 'unknown';

export interface SourceDependencyReference {
  assetId: string;
  name: string;
  kind: SourceAssetKind;
  category: SourceDependencyCategory;
  required: boolean;
  reason: string;
}

export interface SourceDashboardCatalogItem {
  id: string;
  name: string;
  kind: SourceAssetKind;
  path?: string;
  owner?: string;
  updatedAt?: string;
  usageCount?: number;
  dependencyIds: string[];
  dependencies: SourceDependencyReference[];
  dependencyCounts: Partial<Record<SourceDependencyCategory, number>>;
  complexity: 'low' | 'medium' | 'high';
  coverage: 'complete' | 'partial' | 'export_required';
  coverageNotes: string[];
  riskFlags: string[];
}

const CONNECTORS: Record<string, SourceConnectorDefinition> = {
  domo: {
    platform: 'domo', label: 'Domo', authGuidance: 'Use a Domo OAuth access token for API inventory.',
    capabilities: { apiInventory: true, semanticDefinitions: 'partial', contentDefinitions: 'partial', usage: false, permissions: false, schedules: false, queryValidation: true, visualEvidence: false },
    migrationCoverage: { semantic_objects: 'partial', dashboards: 'partial', filters: 'partial', layout: 'unsupported', permissions: 'unsupported', schedules: 'unsupported' },
    limitations: ['Magic ETL, App Studio, Workbench, and complete Beast Mode extraction may require customer exports.'],
  },
  power_bi: {
    platform: 'power_bi', label: 'Power BI', authGuidance: 'Use a Microsoft Entra access token with workspace/report/dataset permissions.',
    capabilities: { apiInventory: true, semanticDefinitions: 'partial', contentDefinitions: 'partial', usage: true, permissions: true, schedules: true, queryValidation: true, visualEvidence: true },
    migrationCoverage: { semantic_objects: 'export_required', dashboards: 'partial', filters: 'partial', layout: 'export_required', permissions: 'unsupported', schedules: 'unsupported' },
    limitations: ['PBIX/TMDL or scanner API exports are required for complete DAX, visual, and semantic definitions.'],
  },
  tableau: {
    platform: 'tableau', label: 'Tableau', authGuidance: 'Use a Tableau REST access token and configured site ID.',
    capabilities: { apiInventory: true, semanticDefinitions: 'partial', contentDefinitions: 'partial', usage: true, permissions: true, schedules: true, queryValidation: false, visualEvidence: true },
    migrationCoverage: { semantic_objects: 'export_required', dashboards: 'partial', filters: 'partial', layout: 'export_required', permissions: 'unsupported', schedules: 'unsupported' },
    limitations: ['Metadata API GraphQL or TWB/TDS exports are required for complete lineage and calculations.'],
  },
  sigma: {
    platform: 'sigma', label: 'Sigma', authGuidance: 'Use a Sigma bearer token with workbook read access.',
    capabilities: { apiInventory: true, semanticDefinitions: 'partial', contentDefinitions: 'full', usage: false, permissions: true, schedules: false, queryValidation: false, visualEvidence: true },
    migrationCoverage: { semantic_objects: 'partial', dashboards: 'partial', filters: 'partial', layout: 'unsupported', permissions: 'unsupported', schedules: 'unsupported' },
    limitations: ['Input tables, writeback, and some workbook formulas require explicit redesign decisions.'],
  },
  looker: {
    platform: 'looker', label: 'Looker', authGuidance: 'Use a Looker API 4.0 access token with see_lookml/develop permissions where needed.',
    capabilities: { apiInventory: true, semanticDefinitions: 'full', contentDefinitions: 'full', usage: true, permissions: true, schedules: true, queryValidation: true, visualEvidence: true },
    migrationCoverage: { semantic_objects: 'full', dashboards: 'partial', filters: 'partial', layout: 'partial', permissions: 'unsupported', schedules: 'unsupported' },
    limitations: ['Complete LookML requires project file access; user-defined dashboards and LookML dashboards use different APIs.'],
  },
  metabase: {
    platform: 'metabase', label: 'Metabase', authGuidance: 'Use a Metabase API key, or save a session-compatible credential for the local engine.',
    capabilities: { apiInventory: true, semanticDefinitions: 'full', contentDefinitions: 'full', usage: false, permissions: false, schedules: false, queryValidation: true, visualEvidence: true },
    migrationCoverage: { semantic_objects: 'partial', dashboards: 'full', filters: 'full', layout: 'full', permissions: 'unsupported', schedules: 'unsupported' },
    limitations: ['Native SQL cards, ad-hoc aggregations, permissions, and subscriptions require explicit review.'],
  },
  webfocus: {
    platform: 'webfocus', label: 'WebFOCUS', authGuidance: 'Use a WebFOCUS Repository REST session/token and repository path.',
    capabilities: { apiInventory: true, semanticDefinitions: 'export_required', contentDefinitions: 'partial', usage: false, permissions: false, schedules: false, queryValidation: false, visualEvidence: false },
    migrationCoverage: { semantic_objects: 'export_required', dashboards: 'partial', filters: 'partial', layout: 'unsupported', permissions: 'unsupported', schedules: 'unsupported' },
    limitations: ['Version-specific Change Management, FEX/MAS/ACX, ReportCaster, and portal exports may be required.'],
  },
  microstrategy: {
    platform: 'microstrategy', label: 'MicroStrategy', authGuidance: 'Use an X-MSTR-AuthToken and project ID from the Strategy REST login flow.',
    capabilities: { apiInventory: true, semanticDefinitions: 'partial', contentDefinitions: 'partial', usage: false, permissions: true, schedules: true, queryValidation: true, visualEvidence: true },
    migrationCoverage: { semantic_objects: 'partial', dashboards: 'partial', filters: 'partial', layout: 'partial', permissions: 'unsupported', schedules: 'unsupported' },
    limitations: ['Prompted reports, cubes, dossiers, documents, and security filters require project-scoped follow-up calls.'],
  },
};

export function sourceConnectorDefinitions(): SourceConnectorDefinition[] {
  return Object.values(CONNECTORS).map((connector) => ({ ...connector, capabilities: { ...connector.capabilities }, migrationCoverage: { ...connector.migrationCoverage }, limitations: [...connector.limitations] }));
}

export function sourceConnectorDefinition(platform: string): SourceConnectorDefinition | undefined {
  const connector = CONNECTORS[platform];
  return connector ? { ...connector, capabilities: { ...connector.capabilities }, migrationCoverage: { ...connector.migrationCoverage }, limitations: [...connector.limitations] } : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function firstArray(value: unknown, keys: string[]): unknown[] {
  if (Array.isArray(value)) return value;
  const root = asRecord(value);
  const containers = [root, ...['data', 'result', 'results', 'tsResponse'].map((key) => asRecord(root[key]))];
  for (const container of containers) {
    for (const key of keys) {
      if (Array.isArray(container[key])) return container[key] as unknown[];
      const nested = asRecord(container[key]);
      for (const childKey of keys) if (Array.isArray(nested[childKey])) return nested[childKey] as unknown[];
    }
  }
  return [];
}

function firstString(...values: unknown[]): string {
  return values.find((value) => typeof value === 'string' && value.trim()) as string || '';
}

function firstNumber(...values: unknown[]): number | undefined {
  const value = values.find((item) => typeof item === 'number' && Number.isFinite(item));
  return typeof value === 'number' ? value : undefined;
}

function safeMetadata(record: Record<string, unknown>, keys: string[]): Record<string, string | number | boolean | null> {
  return Object.fromEntries(keys.flatMap((key) => {
    const value = record[key];
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null
      ? [[key, value] as const]
      : [];
  }));
}

const DEFAULT_METADATA_KEYS = [
  'description', 'type', 'subtype', 'createdAt', 'updatedAt', 'datasetId', 'dataset_id', 'modelId', 'model_id',
  'lookmlModelId', 'queryId', 'query_id', 'workbookId', 'workbook_id', 'pageId', 'page_id', 'datasourceId',
  'dataSourceId', 'data_source_id', 'cardId', 'card_id', 'reportId', 'report_id', 'cubeId', 'cube_id',
  'projectId', 'project_id', 'folderId', 'folder_id', 'spaceId', 'space_id', 'contentType', 'content_type',
];

function cleanBaseUrl(value?: string): string {
  if (!value) throw Object.assign(new Error('Platform base URL is required.'), { statusCode: 400 });
  return value.trim().replace(/\/+$/, '');
}

function connectorHeaders(connection: SavedPlatformConnection): Record<string, string> {
  if (connection.platform === 'microstrategy') {
    return {
      Accept: 'application/json',
      'X-MSTR-AuthToken': connection.credential,
      ...(connection.projectId ? { 'X-MSTR-ProjectID': connection.projectId } : {}),
    };
  }
  if (connection.platform === 'metabase') {
    return { Accept: 'application/json', 'X-API-KEY': connection.credential };
  }
  return { Accept: 'application/json', Authorization: `Bearer ${connection.credential}` };
}

async function fetchConnectorJson(connection: SavedPlatformConnection, url: string): Promise<unknown> {
  await assertSafeOutboundUrl(url, { label: `${connection.platform} connection URL`, allowlist: migrationSourceHostAllowlist() });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { method: 'GET', headers: connectorHeaders(connection), redirect: 'manual', signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      throw Object.assign(new Error(`${connection.platform} returned ${response.status}: ${redactSensitiveText(text.slice(0, 500) || response.statusText)}`), { statusCode: 502 });
    }
    if (!text) return {};
    try { return JSON.parse(text); } catch { return { content: text }; }
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeRows(input: {
  rows: unknown[];
  kind: SourceAssetKind;
  parentId?: string;
  idKeys?: string[];
  nameKeys?: string[];
  metadataKeys?: string[];
  indexOffset?: number;
}): SourceInventoryItem[] {
  return input.rows.slice(0, MAX_INVENTORY_ITEMS).map((raw, index) => {
    const row = asRecord(raw);
    const id = firstString(...(input.idKeys || ['id']).map((key) => row[key])) || `${input.kind}-${(input.indexOffset || 0) + index + 1}`;
    const name = firstString(...(input.nameKeys || ['name', 'title']).map((key) => row[key])) || id;
    const dependencies = firstArray(row, ['dependencies', 'upstream', 'downstream']).map((value) => firstString(asRecord(value).id, value)).filter(Boolean);
    return {
      id,
      name,
      kind: input.kind,
      parentId: input.parentId,
      path: firstString(row.path, row.webUrl, row.web_url, row.url),
      owner: firstString(row.owner, row.ownerName, row.owner_id, row.configuredBy),
      updatedAt: firstString(row.updatedAt, row.updated_at, row.modifiedAt, row.lastUpdatedDate),
      usageCount: firstNumber(row.usageCount, row.viewCount, row.views, row.hits),
      dependencyIds: dependencies,
      featureFlags: [],
      riskFlags: [],
      metadata: safeMetadata(row, input.metadataKeys || DEFAULT_METADATA_KEYS),
    };
  });
}

function dependencyCategory(kind: SourceAssetKind): SourceDependencyCategory {
  if (['semantic_model', 'cube'].includes(kind)) return 'semantic_model';
  if (['data_source', 'dataset'].includes(kind)) return 'data_source';
  if (kind === 'attribute') return 'field';
  if (['metric', 'calculation'].includes(kind)) return 'calculation';
  if (kind === 'filter') return 'filter';
  if (kind === 'permission') return 'security';
  if (kind === 'schedule') return 'schedule';
  if (['report', 'dashboard', 'workbook', 'page', 'view', 'tile', 'visual', 'card', 'repository_item'].includes(kind)) return 'content';
  return 'unknown';
}

function dashboardUnit(platform: MigrationPlatformKind, item: SourceInventoryItem): boolean {
  if (platform === 'power_bi') return ['dashboard', 'report'].includes(item.kind);
  if (platform === 'sigma') return item.kind === 'workbook';
  if (platform === 'looker') return ['dashboard', 'report'].includes(item.kind);
  if (platform === 'metabase') return item.kind === 'dashboard';
  if (platform === 'tableau') return item.kind === 'workbook';
  if (platform === 'domo') return ['page', 'card'].includes(item.kind);
  if (platform === 'webfocus') return item.kind === 'repository_item';
  if (platform === 'microstrategy') return ['dashboard', 'report'].includes(item.kind);
  return false;
}

const REFERENCE_METADATA_KEYS = ['datasetId', 'dataset_id', 'modelId', 'model_id', 'lookmlModelId', 'queryId', 'query_id', 'workbookId', 'workbook_id', 'pageId', 'page_id', 'datasourceId', 'dataSourceId', 'data_source_id', 'cardId', 'card_id', 'reportId', 'report_id', 'cubeId', 'cube_id'];

export function sourceDashboardDependencyClosure(rootId: string, items: SourceInventoryItem[]): string[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const children = new Map<string, string[]>();
  items.forEach((item) => {
    if (!item.parentId) return;
    children.set(item.parentId, [...(children.get(item.parentId) || []), item.id]);
  });
  const closure = new Set<string>();
  const queue = [rootId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (closure.has(id)) continue;
    closure.add(id);
    const item = byId.get(id);
    if (!item) continue;
    item.dependencyIds.forEach((dependencyId) => {
      if (byId.has(dependencyId) && !closure.has(dependencyId)) queue.push(dependencyId);
    });
    REFERENCE_METADATA_KEYS.forEach((key) => {
      const reference = item.metadata[key];
      if (typeof reference === 'string' && byId.has(reference) && !closure.has(reference)) queue.push(reference);
    });
    (children.get(id) || []).forEach((childId) => {
      if (!closure.has(childId)) queue.push(childId);
    });
  }
  closure.delete(rootId);
  return Array.from(closure).sort();
}

function sourceCoverage(connector: SourceConnectorDefinition): SourceDashboardCatalogItem['coverage'] {
  if (connector.capabilities.semanticDefinitions === 'export_required' || connector.capabilities.contentDefinitions === 'export_required') return 'export_required';
  return connector.capabilities.semanticDefinitions === 'full' && connector.capabilities.contentDefinitions === 'full' ? 'complete' : 'partial';
}

export function buildSourceDashboardCatalog(platform: MigrationPlatformKind, items: SourceInventoryItem[], connector: SourceConnectorDefinition): SourceDashboardCatalogItem[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  return items.filter((item) => dashboardUnit(platform, item)).map((item) => {
    const dependencyIds = sourceDashboardDependencyClosure(item.id, items);
    const dependencies = dependencyIds.flatMap((assetId) => {
      const dependency = byId.get(assetId);
      return dependency ? [{
        assetId,
        name: dependency.name,
        kind: dependency.kind,
        category: dependencyCategory(dependency.kind),
        required: true,
        reason: dependency.parentId === item.id ? 'Contained by the selected dashboard asset.' : 'Referenced by the selected dashboard dependency graph.',
      } satisfies SourceDependencyReference] : [];
    });
    const dependencyCounts = dependencies.reduce<Partial<Record<SourceDependencyCategory, number>>>((counts, dependency) => ({ ...counts, [dependency.category]: (counts[dependency.category] || 0) + 1 }), {});
    const complexityScore = dependencies.length + item.riskFlags.length * 5 + item.featureFlags.length * 2;
    const coverage = sourceCoverage(connector);
    const complexity: SourceDashboardCatalogItem['complexity'] = complexityScore > 20 ? 'high' : complexityScore > 7 ? 'medium' : 'low';
    return {
      id: item.id,
      name: item.name,
      kind: item.kind,
      path: item.path,
      owner: item.owner,
      updatedAt: item.updatedAt,
      usageCount: item.usageCount,
      dependencyIds,
      dependencies,
      dependencyCounts,
      complexity,
      coverage,
      coverageNotes: coverage === 'complete' ? [] : [...connector.limitations],
      riskFlags: [...item.riskFlags],
    };
  }).sort((a, b) => (b.usageCount || 0) - (a.usageCount || 0) || a.name.localeCompare(b.name));
}

type InventoryPaginationStyle = 'none' | 'odata' | 'sigma' | 'offset' | 'tableau';

interface InventoryTracker {
  scope: 'all_accessible' | 'saved_parent';
  scopeLabel: string;
  pagesFetched: number;
  parentsExpanded: number;
  requestsMade: number;
  truncated: boolean;
}

function tracker(scope: InventoryTracker['scope'] = 'all_accessible', scopeLabel = 'All accessible content'): InventoryTracker {
  return { scope, scopeLabel, pagesFetched: 0, parentsExpanded: 0, requestsMade: 0, truncated: false };
}

function numericValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

export function migrationInventoryNextPageUrl(input: {
  currentUrl: string;
  payload: unknown;
  style: InventoryPaginationStyle;
  rowsOnPage: number;
  pageSize: number;
}): string | null {
  const root = asRecord(input.payload);
  const data = asRecord(root.data);
  const links = asRecord(root.links);
  const explicitNext = firstString(root['@odata.nextLink'], root.next, links.next, data['@odata.nextLink'], data.next);
  if ((input.style === 'odata' || input.style === 'sigma') && explicitNext) {
    return new URL(explicitNext, input.currentUrl).toString();
  }
  const nextUrl = new URL(input.currentUrl);
  if (input.style === 'sigma') {
    const nextPage = firstString(root.nextPage, data.nextPage);
    if (!nextPage) return null;
    nextUrl.searchParams.set('page', nextPage);
    return nextUrl.toString();
  }
  if (input.style === 'offset') {
    if (input.rowsOnPage < input.pageSize) return null;
    const currentOffset = numericValue(nextUrl.searchParams.get('offset'), nextUrl.searchParams.get('$skip')) || 0;
    const parameter = nextUrl.searchParams.has('$skip') ? '$skip' : 'offset';
    nextUrl.searchParams.set(parameter, String(currentOffset + input.pageSize));
    return nextUrl.toString();
  }
  if (input.style === 'tableau') {
    const response = asRecord(root.tsResponse);
    const pagination = Object.keys(asRecord(root.pagination)).length > 0 ? asRecord(root.pagination) : asRecord(response.pagination);
    const pageNumber = numericValue(pagination.pageNumber, nextUrl.searchParams.get('pageNumber')) || 1;
    const pageSize = numericValue(pagination.pageSize, nextUrl.searchParams.get('pageSize')) || input.pageSize;
    const total = numericValue(pagination.totalAvailable);
    if (total === undefined ? input.rowsOnPage < pageSize : pageNumber * pageSize >= total) return null;
    nextUrl.searchParams.set('pageSize', String(pageSize));
    nextUrl.searchParams.set('pageNumber', String(pageNumber + 1));
    return nextUrl.toString();
  }
  return null;
}

async function collect(connection: SavedPlatformConnection, input: {
  url: string;
  keys: string[];
  kind: SourceAssetKind;
  warnings: string[];
  tracker: InventoryTracker;
  parentId?: string;
  idKeys?: string[];
  pagination?: InventoryPaginationStyle;
  pageSize?: number;
}): Promise<SourceInventoryItem[]> {
  const items: SourceInventoryItem[] = [];
  const seenUrls = new Set<string>();
  const seenPageSignatures = new Set<string>();
  const pageSize = input.pageSize || 100;
  let nextUrl: string | null = input.url;
  let page = 0;
  while (nextUrl && page < MAX_INVENTORY_PAGES && items.length < MAX_INVENTORY_ITEMS) {
    if (seenUrls.has(nextUrl) || input.tracker.requestsMade >= MAX_INVENTORY_REQUESTS) {
      input.tracker.truncated = true;
      break;
    }
    seenUrls.add(nextUrl);
    input.tracker.requestsMade += 1;
    try {
      const payload = await fetchConnectorJson(connection, nextUrl);
      input.tracker.pagesFetched += 1;
      const rows = firstArray(payload, input.keys);
      const pageSignature = `${rows.length}:${rows.slice(0, 20).map((row) => {
        const record = asRecord(row);
        return firstString(...(input.idKeys || ['id']).map((key) => record[key]), record.name, record.title);
      }).join('|')}`;
      if (page > 0 && rows.length > 0 && seenPageSignatures.has(pageSignature)) {
        input.tracker.truncated = true;
        input.warnings.push(`${input.kind} inventory returned a repeated page. OmniKit stopped instead of presenting duplicate or misleading scope.`);
        break;
      }
      seenPageSignatures.add(pageSignature);
      items.push(...normalizeRows({ rows, kind: input.kind, parentId: input.parentId, idKeys: input.idKeys, indexOffset: items.length }));
      page += 1;
      const candidate = migrationInventoryNextPageUrl({ currentUrl: nextUrl, payload, style: input.pagination || 'none', rowsOnPage: rows.length, pageSize });
      if (candidate && (page >= MAX_INVENTORY_PAGES || items.length >= MAX_INVENTORY_ITEMS)) input.tracker.truncated = true;
      nextUrl = candidate;
    } catch (error) {
      input.warnings.push(error instanceof Error ? error.message : `${input.kind} inventory failed.`);
      return items;
    }
  }
  if (input.tracker.truncated) {
    const warning = `Inventory reached a safety bound (${MAX_INVENTORY_PAGES} pages, ${MAX_INVENTORY_ITEMS} items per collection, or ${MAX_INVENTORY_REQUESTS} requests). Narrow the saved source scope before planning.`;
    if (!input.warnings.includes(warning)) input.warnings.push(warning);
  }
  return items;
}

function result(connection: SavedPlatformConnection, items: SourceInventoryItem[], warnings: string[], collection: InventoryTracker): SourceInventoryResult {
  const connector = sourceConnectorDefinition(connection.platform);
  if (!connector) throw Object.assign(new Error(`${connection.platform} is not a supported BI migration source.`), { statusCode: 400 });
  const unique = Array.from(new Map(items.map((item) => [`${item.kind}:${item.id}`, item])).values()).slice(0, MAX_INVENTORY_ITEMS);
  const truncated = collection.truncated || items.length > unique.length;
  const boundedWarning = `Only the first ${MAX_INVENTORY_ITEMS} unique source items are shown. Save a narrower workspace, project, site, or repository scope to continue safely.`;
  if (truncated && !warnings.includes(boundedWarning)) warnings.push(boundedWarning);
  return {
    platform: connection.platform,
    connectionId: connection.id,
    connector,
    items: unique,
    dashboardCatalog: buildSourceDashboardCatalog(connection.platform, unique, connector),
    warnings: [...connector.limitations, ...warnings],
    truncated,
    collection: {
      scope: collection.scope,
      scopeLabel: collection.scopeLabel,
      pagesFetched: collection.pagesFetched,
      parentsExpanded: collection.parentsExpanded,
      requestsMade: collection.requestsMade,
      maxPages: MAX_INVENTORY_PAGES,
      maxItems: MAX_INVENTORY_ITEMS,
    },
  };
}

async function powerBiInventory(connection: SavedPlatformConnection): Promise<SourceInventoryResult> {
  const base = cleanBaseUrl(connection.baseUrl).replace(/\/v1\.0\/myorg$/i, '');
  const api = `${base}/v1.0/myorg`;
  const warnings: string[] = [];
  const collection = connection.workspaceId
    ? tracker('saved_parent', `Power BI workspace ${connection.workspaceId}`)
    : tracker();
  const workspaces = connection.workspaceId
    ? normalizeRows({ rows: [{ id: connection.workspaceId, name: `Workspace ${connection.workspaceId}` }], kind: 'workspace' })
    : await collect(connection, { url: `${api}/groups?$top=100&$skip=0`, keys: ['value', 'groups'], kind: 'workspace', warnings, tracker: collection, pagination: 'offset', pageSize: 100 });
  const expandedWorkspaces = workspaces.slice(0, MAX_PARENT_EXPANSIONS);
  collection.parentsExpanded = expandedWorkspaces.length;
  const children = await Promise.all(expandedWorkspaces.flatMap((workspace) => [
    collect(connection, { url: `${api}/groups/${encodeURIComponent(workspace.id)}/reports`, keys: ['value', 'reports'], kind: 'report', warnings, tracker: collection, parentId: workspace.id, pagination: 'odata' }),
    collect(connection, { url: `${api}/groups/${encodeURIComponent(workspace.id)}/datasets`, keys: ['value', 'datasets'], kind: 'semantic_model', warnings, tracker: collection, parentId: workspace.id, pagination: 'odata' }),
    collect(connection, { url: `${api}/groups/${encodeURIComponent(workspace.id)}/dashboards`, keys: ['value', 'dashboards'], kind: 'dashboard', warnings, tracker: collection, parentId: workspace.id, pagination: 'odata' }),
  ]));
  if (workspaces.length > MAX_PARENT_EXPANSIONS) {
    collection.truncated = true;
    warnings.push(`Expanded ${MAX_PARENT_EXPANSIONS} of ${workspaces.length} accessible workspaces. Save a specific Power BI workspace ID or use the scanner API for a tenant-wide migration.`);
  }
  return result(connection, [...workspaces, ...children.flat()], warnings, collection);
}

async function sigmaInventory(connection: SavedPlatformConnection): Promise<SourceInventoryResult> {
  const base = /\/v2$/i.test(cleanBaseUrl(connection.baseUrl)) ? cleanBaseUrl(connection.baseUrl) : `${cleanBaseUrl(connection.baseUrl)}/v2`;
  const warnings: string[] = [];
  const collection = tracker();
  const workbooks = await collect(connection, { url: `${base}/workbooks?limit=100`, keys: ['entries', 'workbooks', 'items'], kind: 'workbook', warnings, tracker: collection, idKeys: ['workbookId', 'id', 'workbook_id'], pagination: 'sigma', pageSize: 100 });
  const expandedWorkbooks = workbooks.slice(0, MAX_PARENT_EXPANSIONS);
  collection.parentsExpanded = expandedWorkbooks.length;
  const pages = (await Promise.all(expandedWorkbooks.map((workbook) => collect(connection, { url: `${base}/workbooks/${encodeURIComponent(workbook.id)}/pages?limit=100`, keys: ['entries', 'pages', 'items'], kind: 'page', warnings, tracker: collection, parentId: workbook.id, idKeys: ['pageId', 'id'], pagination: 'sigma', pageSize: 100 })))).flat();
  const expandedPages = pages.slice(0, MAX_CHILD_EXPANSIONS);
  const elements = (await Promise.all(expandedPages.map((page) => collect(connection, { url: `${base}/workbooks/${encodeURIComponent(page.parentId || '')}/pages/${encodeURIComponent(page.id)}/elements?limit=100`, keys: ['entries', 'elements', 'items'], kind: 'visual', warnings, tracker: collection, parentId: page.id, idKeys: ['elementId', 'id'], pagination: 'sigma', pageSize: 100 })))).flat();
  if (workbooks.length > expandedWorkbooks.length || pages.length > expandedPages.length) {
    collection.truncated = true;
    warnings.push('Sigma child expansion reached its bounded scope. Select fewer workbooks and reload before planning.');
  }
  return result(connection, [...workbooks, ...pages, ...elements], warnings, collection);
}

async function lookerInventory(connection: SavedPlatformConnection): Promise<SourceInventoryResult> {
  const base = /\/api\/4\.0$/i.test(cleanBaseUrl(connection.baseUrl)) ? cleanBaseUrl(connection.baseUrl) : `${cleanBaseUrl(connection.baseUrl)}/api/4.0`;
  const warnings: string[] = [];
  const collection = tracker();
  const [projects, models, dashboards, looks] = await Promise.all([
    collect(connection, { url: `${base}/projects`, keys: ['projects'], kind: 'project', warnings, tracker: collection }),
    collect(connection, { url: `${base}/lookml_models?limit=200&offset=0`, keys: ['lookml_models'], kind: 'semantic_model', warnings, tracker: collection, pagination: 'offset', pageSize: 200 }),
    collect(connection, { url: `${base}/dashboards?limit=200&offset=0`, keys: ['dashboards'], kind: 'dashboard', warnings, tracker: collection, pagination: 'offset', pageSize: 200 }),
    collect(connection, { url: `${base}/looks?limit=200&offset=0`, keys: ['looks'], kind: 'report', warnings, tracker: collection, pagination: 'offset', pageSize: 200 }),
  ]);
  return result(connection, [...projects, ...models, ...dashboards, ...looks], warnings, collection);
}

async function metabaseInventory(connection: SavedPlatformConnection): Promise<SourceInventoryResult> {
  const base = cleanBaseUrl(connection.baseUrl).replace(/\/api$/i, '');
  const warnings: string[] = [];
  const collection = tracker();
  const [databases, tables, cards, dashboards, collections] = await Promise.all([
    collect(connection, { url: `${base}/api/database`, keys: ['data', 'databases'], kind: 'data_source', warnings, tracker: collection }),
    collect(connection, { url: `${base}/api/table`, keys: ['data', 'tables'], kind: 'dataset', warnings, tracker: collection, idKeys: ['id'] }),
    collect(connection, { url: `${base}/api/card`, keys: ['data', 'cards'], kind: 'report', warnings, tracker: collection, idKeys: ['id'] }),
    collect(connection, { url: `${base}/api/dashboard`, keys: ['data', 'dashboards'], kind: 'dashboard', warnings, tracker: collection, idKeys: ['id'] }),
    collect(connection, { url: `${base}/api/collection`, keys: ['data', 'collections'], kind: 'project', warnings, tracker: collection, idKeys: ['id'] }),
  ]);
  return result(connection, [...databases, ...tables, ...cards, ...dashboards, ...collections], warnings, collection);
}

async function tableauInventory(connection: SavedPlatformConnection): Promise<SourceInventoryResult> {
  if (!connection.siteId) throw Object.assign(new Error('Tableau site ID is required for API inventory.'), { statusCode: 400 });
  const base = cleanBaseUrl(connection.baseUrl);
  const site = encodeURIComponent(connection.siteId);
  const warnings: string[] = [];
  const collection = tracker('saved_parent', `Tableau site ${connection.siteId}`);
  const [workbooks, views, sources, projects] = await Promise.all([
    collect(connection, { url: `${base}/sites/${site}/workbooks?pageSize=100&pageNumber=1`, keys: ['workbooks', 'workbook'], kind: 'workbook', warnings, tracker: collection, pagination: 'tableau', pageSize: 100 }),
    collect(connection, { url: `${base}/sites/${site}/views?pageSize=100&pageNumber=1`, keys: ['views', 'view'], kind: 'view', warnings, tracker: collection, pagination: 'tableau', pageSize: 100 }),
    collect(connection, { url: `${base}/sites/${site}/datasources?pageSize=100&pageNumber=1`, keys: ['datasources', 'datasource'], kind: 'data_source', warnings, tracker: collection, pagination: 'tableau', pageSize: 100 }),
    collect(connection, { url: `${base}/sites/${site}/projects?pageSize=100&pageNumber=1`, keys: ['projects', 'project'], kind: 'project', warnings, tracker: collection, pagination: 'tableau', pageSize: 100 }),
  ]);
  return result(connection, [...projects, ...workbooks, ...views, ...sources], warnings, collection);
}

async function domoInventory(connection: SavedPlatformConnection): Promise<SourceInventoryResult> {
  const base = cleanBaseUrl(connection.baseUrl);
  const warnings: string[] = [];
  const collection = tracker();
  const [datasets, cards, pages] = await Promise.all([
    collect(connection, { url: `${base}/v1/datasets?limit=100&offset=0`, keys: ['data', 'datasets'], kind: 'dataset', warnings, tracker: collection, pagination: 'offset', pageSize: 100 }),
    collect(connection, { url: `${base}/v1/cards?limit=100&offset=0`, keys: ['data', 'cards'], kind: 'card', warnings, tracker: collection, pagination: 'offset', pageSize: 100 }),
    collect(connection, { url: `${base}/v1/pages?limit=100&offset=0`, keys: ['data', 'pages'], kind: 'page', warnings, tracker: collection, pagination: 'offset', pageSize: 100 }),
  ]);
  return result(connection, [...datasets, ...cards, ...pages], warnings, collection);
}

async function webfocusInventory(connection: SavedPlatformConnection): Promise<SourceInventoryResult> {
  const base = cleanBaseUrl(connection.baseUrl);
  const path = connection.repositoryPath || '/WFC/Repository';
  const url = new URL(`${base}/getContent`);
  url.searchParams.set('path', path);
  const warnings: string[] = [];
  const collection = tracker('saved_parent', `WebFOCUS repository ${path}`);
  collection.requestsMade += 1;
  const payload = await fetchConnectorJson(connection, url.toString());
  collection.pagesFetched += 1;
  const entries = firstArray(payload, ['items', 'entries', 'resources', 'children']);
  const items = normalizeRows({ rows: entries, kind: 'repository_item', idKeys: ['id', 'itemId', 'path'] });
  if (firstString(asRecord(payload).content) && items.length === 0) warnings.push('The configured path returned content directly. Add the exported FEX/MAS/ACX definition to the migration scope.');
  return result(connection, items, warnings, collection);
}

async function microStrategyInventory(connection: SavedPlatformConnection): Promise<SourceInventoryResult> {
  if (!connection.projectId) throw Object.assign(new Error('MicroStrategy project ID is required for project-scoped inventory.'), { statusCode: 400 });
  const base = cleanBaseUrl(connection.baseUrl);
  const warnings: string[] = [];
  const collection = tracker('saved_parent', `MicroStrategy project ${connection.projectId}`);
  const search = async (type: number, kind: SourceAssetKind) => collect(connection, { url: `${base}/api/searches/results?pattern=*&type=${type}&limit=200&offset=0`, keys: ['result', 'results', 'objects'], kind, warnings, tracker: collection, pagination: 'offset', pageSize: 200 });
  const [reports, dashboards, cubes, metrics, attributes] = await Promise.all([
    search(3, 'report'),
    search(55, 'dashboard'),
    search(71, 'cube'),
    search(4, 'metric'),
    search(12, 'attribute'),
  ]);
  return result(connection, [...reports, ...dashboards, ...cubes, ...metrics, ...attributes], warnings, collection);
}

export async function testPlatformConnection(connection: SavedPlatformConnection): Promise<{ ok: true; platform: MigrationPlatformKind; itemCount: number }> {
  const inventory = await listSourceInventory(connection);
  return { ok: true, platform: connection.platform, itemCount: inventory.items.length };
}

export async function listSourceInventory(connection: SavedPlatformConnection): Promise<SourceInventoryResult> {
  if (!connection.enabled) throw Object.assign(new Error('This platform connection is disabled.'), { statusCode: 409 });
  if (connection.platform === 'power_bi') return powerBiInventory(connection);
  if (connection.platform === 'sigma') return sigmaInventory(connection);
  if (connection.platform === 'looker') return lookerInventory(connection);
  if (connection.platform === 'metabase') return metabaseInventory(connection);
  if (connection.platform === 'tableau') return tableauInventory(connection);
  if (connection.platform === 'domo') return domoInventory(connection);
  if (connection.platform === 'webfocus') return webfocusInventory(connection);
  if (connection.platform === 'microstrategy') return microStrategyInventory(connection);
  throw Object.assign(new Error(`${connection.platform} is not a supported BI migration source.`), { statusCode: 400 });
}

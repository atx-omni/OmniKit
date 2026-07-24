import { assertSafeOutboundUrl } from '../security';
import { createHash } from 'node:crypto';
import type {
  DomoApiEvidenceResult,
  DomoManualParseResult,
  MigrationArtifact,
  MigrationInventory,
  MigrationSourceTool,
  MigrationView,
} from '../../src/services/semanticMigration/types';
import { redactSensitiveText } from './jobSanitizer';
import type { MigrationPlatformKind, SavedPlatformConnection } from './nativeVault';
import { migrationSourceHostAllowlist } from './semanticMigrationAudit';
import { parseDomoManualArtifacts } from './semanticMigration/domoManualParser';

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_INVENTORY_ITEMS = 1_000;
const MAX_INVENTORY_PAGES = 25;
const MAX_PARENT_EXPANSIONS = 100;
const MAX_CHILD_EXPANSIONS = 500;
const MAX_INVENTORY_REQUESTS = 500;
const MAX_VALIDATION_ROWS = 50;
const MAX_VALIDATION_COLUMNS = 100;
const MAX_VALIDATION_STRING_CHARS = 2_000;
const MAX_LOOKER_PROBE_QUEUE = 20;
const LOOKER_PROBE_CONCURRENCY = 2;
const DOMO_PLATFORM_API_BASE = 'https://api.domo.com';
const MAX_DOMO_SELECTED_DASHBOARDS = 50;
const MAX_DOMO_EVIDENCE_CARDS = 500;
const MAX_DOMO_EVIDENCE_DATASETS = 250;
const MAX_DOMO_EVIDENCE_BEAST_MODES = 5_000;
const MAX_DOMO_PRODUCT_RESPONSE_CHARS = 5 * 1024 * 1024;

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
    platform: 'domo', label: 'Domo', authGuidance: 'Use a scoped Domo OAuth client for standard inventory. Add a separate Product API developer token only when deep inventory is required.',
    capabilities: { apiInventory: true, semanticDefinitions: 'partial', contentDefinitions: 'partial', usage: false, permissions: false, schedules: false, queryValidation: true, visualEvidence: false },
    migrationCoverage: { semantic_objects: 'partial', dashboards: 'partial', filters: 'partial', layout: 'unsupported', permissions: 'unsupported', schedules: 'unsupported' },
    limitations: ['Complete Analyzer queries, Variables, drill layers, Filter Views, Magic ETL, Workflows, App Studio, Workbench, and governance behavior may require focused customer exports.'],
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
    platform: 'looker', label: 'Looker', authGuidance: 'Use a Looker API 4.0 client ID and client secret. OmniKit exchanges them server-side for a short-lived access token.',
    capabilities: { apiInventory: true, semanticDefinitions: 'partial', contentDefinitions: 'partial', usage: true, permissions: true, schedules: true, queryValidation: true, visualEvidence: true },
    migrationCoverage: { semantic_objects: 'partial', dashboards: 'partial', filters: 'partial', layout: 'partial', permissions: 'unsupported', schedules: 'unsupported' },
    limitations: ['Complete LookML requires project file access; parameters, runtime calculations, PDTs, and dashboard filter wiring require explicit translation or review.'],
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
  'view_count', 'user_name', 'model',
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

function lookerApiBase(connection: SavedPlatformConnection): string {
  const base = cleanBaseUrl(connection.baseUrl);
  return /\/api\/4\.0$/i.test(base) ? base : `${base}/api/4.0`;
}

async function fetchWithTimeout(url: string, init: RequestInit, label: string): Promise<Response> {
  await assertSafeOutboundUrl(url, { label, allowlist: migrationSourceHostAllowlist() });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, redirect: 'manual', signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function lookerAuthenticatedConnection(connection: SavedPlatformConnection): Promise<SavedPlatformConnection> {
  if (!connection.clientId) return connection;
  const loginUrl = `${lookerApiBase(connection)}/login`;
  const response = await fetchWithTimeout(loginUrl, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: connection.clientId, client_secret: connection.credential }),
  }, 'Looker API login URL');
  const text = await response.text();
  if (!response.ok) {
    throw Object.assign(new Error(`Looker login returned ${response.status}: ${redactSensitiveText(text.slice(0, 500) || response.statusText)}`), { statusCode: 502 });
  }
  const payload = text ? asRecord(JSON.parse(text)) : {};
  const accessToken = firstString(payload.access_token);
  if (!accessToken) throw Object.assign(new Error('Looker login did not return an access token.'), { statusCode: 502 });
  return { ...connection, credential: accessToken };
}

async function domoAuthenticatedConnection(connection: SavedPlatformConnection): Promise<SavedPlatformConnection> {
  if (connection.authMode !== 'oauth_client_credentials') {
    return { ...connection, baseUrl: DOMO_PLATFORM_API_BASE };
  }
  if (!connection.clientId) {
    throw Object.assign(new Error('Domo client ID is required for OAuth client credentials.'), { statusCode: 400 });
  }
  const tokenUrl = new URL(`${DOMO_PLATFORM_API_BASE}/oauth/token`);
  tokenUrl.searchParams.set('grant_type', 'client_credentials');
  tokenUrl.searchParams.set('scope', 'data dashboard');
  const response = await fetchWithTimeout(tokenUrl.toString(), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Basic ${Buffer.from(`${connection.clientId}:${connection.credential}`).toString('base64')}`,
    },
  }, 'Domo OAuth token URL');
  const text = await response.text();
  if (!response.ok) {
    throw Object.assign(new Error(`Domo OAuth returned ${response.status}: ${redactSensitiveText(text.slice(0, 500) || response.statusText)}`), { statusCode: 502 });
  }
  const payload = text ? asRecord(JSON.parse(text)) : {};
  const accessToken = firstString(payload.access_token);
  if (!accessToken) throw Object.assign(new Error('Domo OAuth did not return an access token.'), { statusCode: 502 });
  return { ...connection, baseUrl: DOMO_PLATFORM_API_BASE, credential: accessToken };
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

function domoTenantBaseUrl(connection: SavedPlatformConnection): string {
  const parsed = new URL(cleanBaseUrl(connection.baseUrl));
  const hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'https:' || hostname === 'api.domo.com' || (!hostname.endsWith('.domo.com') && hostname !== 'domo.com')) {
    throw Object.assign(new Error('Domo Deep inventory requires the HTTPS URL for the customer Domo instance, such as https://customer.domo.com.'), { statusCode: 400 });
  }
  return parsed.origin;
}

async function fetchDomoProductJson(
  connection: SavedPlatformConnection,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  if (!connection.productApiToken) {
    throw Object.assign(new Error('Domo Deep inventory requires a server-side Product API developer token. Add one to the saved Domo source or use Manual Files.'), { statusCode: 409 });
  }
  const base = domoTenantBaseUrl(connection);
  const url = new URL(path, `${base}/`);
  if (url.origin !== base) throw Object.assign(new Error('Domo Product API request escaped the saved tenant boundary.'), { statusCode: 400 });
  const response = await fetchWithTimeout(url.toString(), {
    ...init,
    headers: {
      Accept: 'application/json',
      'X-DOMO-Developer-Token': connection.productApiToken,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  }, 'Domo Product API URL');
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > MAX_DOMO_PRODUCT_RESPONSE_CHARS) {
    throw Object.assign(new Error('Domo Product API response exceeded the 5 MB evidence limit. Narrow the selected dashboard scope.'), { statusCode: 413 });
  }
  const text = await response.text();
  if (text.length > MAX_DOMO_PRODUCT_RESPONSE_CHARS) {
    throw Object.assign(new Error('Domo Product API response exceeded the 5 MB evidence limit. Narrow the selected dashboard scope.'), { statusCode: 413 });
  }
  if (!response.ok) {
    throw Object.assign(new Error(`Domo Product API returned ${response.status}: ${redactSensitiveText(text.slice(0, 500) || response.statusText)}`), { statusCode: response.status === 401 || response.status === 403 ? 409 : 502 });
  }
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw Object.assign(new Error('Domo Product API returned a non-JSON response.'), { statusCode: 502 }); }
}

function domoReferenceValues(value: unknown, keys: Set<string>, limit = 1_000): string[] {
  const values: string[] = [];
  const walk = (current: unknown, parentKey: string, depth: number) => {
    if (depth > 10 || values.length >= limit || current == null) return;
    if (typeof current === 'string' || typeof current === 'number') {
      if (keys.has(parentKey.toLowerCase()) && String(current).trim()) values.push(String(current).trim());
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((item) => walk(item, parentKey, depth + 1));
      return;
    }
    if (typeof current !== 'object') return;
    Object.entries(current as Record<string, unknown>).forEach(([key, item]) => walk(item, key, depth + 1));
  };
  walk(value, '', 0);
  return Array.from(new Set(values));
}

function domoIdAliases(value: unknown): string[] {
  const ids = domoReferenceValues(value, new Set(['id', 'urn', 'cardid', 'cardurn', 'pageid', 'datasourceid', 'datasetid', 'dataset_id', 'data_source_id']), 100);
  return Array.from(new Set(ids.flatMap((id) => [id, ...(id.includes(':') ? [id.split(':').pop() || ''] : [])]).filter(Boolean)));
}

function domoObjectIdAliases(value: unknown): string[] {
  const record = asRecord(value);
  const ids = [record.id, record.urn, record.cardId, record.cardUrn, record.pageId]
    .flatMap((item) => typeof item === 'string' || typeof item === 'number' ? [String(item).trim()] : [])
    .filter(Boolean);
  return Array.from(new Set(ids.flatMap((id) => [id, ...(id.includes(':') ? [id.split(':').pop() || ''] : [])]).filter(Boolean)));
}

function domoDatasetIds(value: unknown): string[] {
  return domoReferenceValues(value, new Set(['datasourceid', 'datasetid', 'dataset_id', 'data_source_id']), MAX_DOMO_EVIDENCE_DATASETS + 1);
}

function domoCardIds(value: unknown): string[] {
  const direct = domoReferenceValues(value, new Set(['cardid', 'cardurn', 'cardids', 'card_ids']), MAX_DOMO_EVIDENCE_CARDS + 1);
  const record = asRecord(value);
  const nested = [...firstArray(record.cards, ['cards']), ...firstArray(record.children, ['children'])]
    .flatMap((item) => domoIdAliases(item));
  return Array.from(new Set([...direct, ...nested].flatMap((id) => [id, ...(id.includes(':') ? [id.split(':').pop() || ''] : [])]).filter(Boolean)));
}

function domoSearchRows(payload: unknown): unknown[] {
  const direct = firstArray(payload, ['searchObjects', 'results', 'items']);
  if (direct.length > 0) return direct;
  const map = asRecord(asRecord(payload).searchResultsMap);
  return Object.values(map).flatMap((value) => firstArray(value, ['searchObjects', 'results', 'items']));
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, operation: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), Math.max(1, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await operation(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function domoEvidenceArtifact(name: string, payload: unknown): MigrationArtifact {
  const content = JSON.stringify(payload);
  return {
    id: `domo-api-${createHash('sha256').update(name).digest('hex').slice(0, 16)}`,
    sourceTool: 'domo',
    name,
    kind: 'json',
    content,
    sizeBytes: Buffer.byteLength(content),
    parseWarnings: [],
  };
}

function normalizeRows(input: {
  rows: unknown[];
  kind: SourceAssetKind;
  parentId?: string;
  idKeys?: string[];
  nameKeys?: string[];
  parentIdKeys?: string[];
  dependencyKeys?: string[];
  metadataKeys?: string[];
  indexOffset?: number;
}): SourceInventoryItem[] {
  return input.rows.slice(0, MAX_INVENTORY_ITEMS).map((raw, index) => {
    const row = asRecord(raw);
    const explicitId = firstString(...(input.idKeys || ['id']).map((key) => row[key]));
    const id = explicitId || `${input.kind}-${(input.indexOffset || 0) + index + 1}`;
    const name = firstString(...(input.nameKeys || ['name', 'title']).map((key) => row[key])) || id;
    const dependencyKeys = input.dependencyKeys || ['dependencies', 'upstream', 'downstream'];
    const dependencies = Array.from(new Set(dependencyKeys.flatMap((key) => {
      const value = row[key];
      const values = Array.isArray(value) ? value : value == null ? [] : [value];
      return values.map((item) => {
        const record = asRecord(item);
        return firstString(record.id, record.urn, record.cardId, record.cardUrn, record.datasetId, record.dataSourceId, item);
      }).filter(Boolean);
    })));
    return {
      id,
      name,
      kind: input.kind,
      parentId: input.parentId || firstString(...(input.parentIdKeys || []).map((key) => row[key])) || undefined,
      path: firstString(row.path, row.webUrl, row.web_url, row.url),
      owner: firstString(row.owner, row.ownerName, row.owner_id, row.configuredBy, row.user_name),
      updatedAt: firstString(row.updatedAt, row.updated_at, row.modifiedAt, row.lastUpdatedDate),
      usageCount: firstNumber(row.usageCount, row.viewCount, row.view_count, row.views, row.hits),
      dependencyIds: dependencies,
      featureFlags: [],
      riskFlags: [],
      metadata: {
        ...safeMetadata(row, input.metadataKeys || DEFAULT_METADATA_KEYS),
        ...(!explicitId ? { syntheticId: true } : {}),
      },
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
  nameKeys?: string[];
  parentIdKeys?: string[];
  dependencyKeys?: string[];
  metadataKeys?: string[];
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
      items.push(...normalizeRows({
        rows,
        kind: input.kind,
        parentId: input.parentId,
        idKeys: input.idKeys,
        nameKeys: input.nameKeys,
        parentIdKeys: input.parentIdKeys,
        dependencyKeys: input.dependencyKeys,
        metadataKeys: input.metadataKeys,
        indexOffset: items.length,
      }));
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
  const authenticated = await lookerAuthenticatedConnection(connection);
  const base = lookerApiBase(connection);
  const warnings: string[] = [];
  if (!connection.clientId) warnings.push('This saved Looker source uses legacy bearer-token authentication. Save a client ID and client secret to use short-lived server-side access tokens.');
  const collection = tracker();
  const [projects, models, dashboards, looks] = await Promise.all([
    collect(authenticated, { url: `${base}/projects`, keys: ['projects'], kind: 'project', warnings, tracker: collection }),
    collect(authenticated, { url: `${base}/lookml_models?limit=200&offset=0`, keys: ['lookml_models'], kind: 'semantic_model', warnings, tracker: collection, pagination: 'offset', pageSize: 200 }),
    collect(authenticated, { url: `${base}/dashboards?limit=200&offset=0`, keys: ['dashboards'], kind: 'dashboard', warnings, tracker: collection, pagination: 'offset', pageSize: 200 }),
    collect(authenticated, { url: `${base}/looks?limit=200&offset=0`, keys: ['looks'], kind: 'report', warnings, tracker: collection, pagination: 'offset', pageSize: 200 }),
  ]);
  return result(connection, [...projects, ...models, ...dashboards, ...looks], warnings, collection);
}

export interface LookerSourceValidationProbeInput {
  dashboardPlanId: string;
  tileId: string;
  queryOrigin?: 'inline' | 'result_maker' | 'saved_look' | 'query_id' | 'unknown';
  lookId?: string;
  queryId?: string;
  model?: string;
  explore?: string;
  fields?: string[];
  filters?: Record<string, string>;
  sorts?: string[];
  pivots?: string[];
  filterExpression?: string;
  limit?: number;
}

export interface LookerSourceValidationProbeResult {
  dashboardPlanId: string;
  tileId: string;
  source: 'saved_look' | 'query_id' | 'inline';
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  returnedRowCount: number;
  fieldNames: string[];
  fingerprint: string;
  truncated: boolean;
}

let activeLookerProbes = 0;
const lookerProbeQueue: Array<() => void> = [];

async function withLookerProbePermit<T>(operation: () => Promise<T>): Promise<T> {
  if (activeLookerProbes >= LOOKER_PROBE_CONCURRENCY) {
    if (lookerProbeQueue.length >= MAX_LOOKER_PROBE_QUEUE) {
      throw Object.assign(new Error('Looker validation is busy. Wait for the active probes to finish, then retry.'), { statusCode: 429 });
    }
    await new Promise<void>((resolve) => lookerProbeQueue.push(resolve));
  }
  activeLookerProbes += 1;
  try {
    return await operation();
  } finally {
    activeLookerProbes -= 1;
    lookerProbeQueue.shift()?.();
  }
}

function boundedProbeString(value: unknown, label: string, maximum = 500): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum) {
    throw Object.assign(new Error(`${label} is invalid.`), { statusCode: 400 });
  }
  return value.trim();
}

function boundedProbeStrings(value: unknown, label: string, maximum = 200): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maximum) throw Object.assign(new Error(`${label} is invalid.`), { statusCode: 400 });
  return value.map((item) => boundedProbeString(item, label) as string);
}

function boundedProbeFilters(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('Looker probe filters are invalid.'), { statusCode: 400 });
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 100) throw Object.assign(new Error('Looker probe filters exceed the 100-filter limit.'), { statusCode: 400 });
  return Object.fromEntries(entries.map(([key, item]) => [
    boundedProbeString(key, 'Looker filter field', 500) as string,
    boundedProbeString(item, 'Looker filter expression', 2_000) as string,
  ]));
}

function sanitizeProbeValue(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.slice(0, MAX_VALIDATION_STRING_CHARS);
  try {
    return JSON.stringify(value).slice(0, MAX_VALIDATION_STRING_CHARS);
  } catch {
    return String(value).slice(0, MAX_VALIDATION_STRING_CHARS);
  }
}

function lookerProbeRows(payload: unknown): Array<Record<string, unknown>> {
  const rows = Array.isArray(payload)
    ? payload
    : firstArray(payload, ['data', 'rows', 'result', 'results']);
  return rows.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const entries = Object.entries(item as Record<string, unknown>).slice(0, MAX_VALIDATION_COLUMNS);
    return [Object.fromEntries(entries.map(([key, value]) => [key.slice(0, 500), sanitizeProbeValue(value)]))];
  });
}

async function fetchLookerProbeJson(connection: SavedPlatformConnection, url: string, init: RequestInit): Promise<unknown> {
  const retryStatuses = new Set([429, 500, 502, 503, 504]);
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, {
        ...init,
        headers: { Accept: 'application/json', Authorization: `Bearer ${connection.credential}`, ...(init.headers || {}) },
      }, 'Looker validation query URL');
      const text = await response.text();
      if (!response.ok) {
        const error = Object.assign(new Error(`Looker validation returned ${response.status}: ${redactSensitiveText(text.slice(0, 500) || response.statusText)}`), { statusCode: 502 });
        if (!retryStatuses.has(response.status) || attempt === 2) throw error;
        lastError = error;
      } else {
        return text ? JSON.parse(text) : [];
      }
    } catch (error) {
      lastError = error;
      if (attempt === 2 || (error as { statusCode?: number })?.statusCode === 400) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** attempt)));
  }
  throw lastError instanceof Error ? lastError : new Error('Looker validation failed.');
}

export async function runLookerSourceValidationProbe(
  connection: SavedPlatformConnection,
  raw: LookerSourceValidationProbeInput,
): Promise<LookerSourceValidationProbeResult> {
  if (!connection.enabled) throw Object.assign(new Error('This platform connection is disabled.'), { statusCode: 409 });
  if (connection.platform !== 'looker') throw Object.assign(new Error('Source query validation currently requires a saved Looker connection.'), { statusCode: 400 });
  const dashboardPlanId = boundedProbeString(raw.dashboardPlanId, 'Dashboard plan ID', 300) as string;
  const tileId = boundedProbeString(raw.tileId, 'Tile ID', 300) as string;
  const lookId = boundedProbeString(raw.lookId, 'Look ID', 300);
  const queryId = boundedProbeString(raw.queryId, 'Query ID', 300);
  const model = boundedProbeString(raw.model, 'Looker model', 500);
  const explore = boundedProbeString(raw.explore, 'Looker Explore', 500);
  const fields = boundedProbeStrings(raw.fields, 'Looker fields');
  const filters = boundedProbeFilters(raw.filters);
  const sorts = boundedProbeStrings(raw.sorts, 'Looker sorts', 100);
  const pivots = boundedProbeStrings(raw.pivots, 'Looker pivots', 100);
  const filterExpression = boundedProbeString(raw.filterExpression, 'Looker filter expression', 4_000);
  const limit = Number.isFinite(raw.limit) ? Math.max(1, Math.min(Number(raw.limit), MAX_VALIDATION_ROWS)) : MAX_VALIDATION_ROWS;

  return withLookerProbePermit(async () => {
    const authenticated = await lookerAuthenticatedConnection(connection);
    const base = lookerApiBase(connection);
    const query = new URLSearchParams({ limit: String(limit), apply_formatting: 'false', apply_vis: 'false', cache: 'false' });
    let source: LookerSourceValidationProbeResult['source'];
    let payload: unknown;
    if (lookId) {
      source = 'saved_look';
      payload = await fetchLookerProbeJson(authenticated, `${base}/looks/${encodeURIComponent(lookId)}/run/json?${query}`, { method: 'GET' });
    } else if (queryId) {
      source = 'query_id';
      payload = await fetchLookerProbeJson(authenticated, `${base}/queries/${encodeURIComponent(queryId)}/run/json?${query}`, { method: 'GET' });
    } else {
      if (!model || !explore || fields.length === 0) {
        throw Object.assign(new Error('Inline Looker validation requires a source model, Explore, and at least one field.'), { statusCode: 400 });
      }
      source = 'inline';
      payload = await fetchLookerProbeJson(authenticated, `${base}/queries/run/json?${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, view: explore, fields, filters, sorts, pivots, limit, ...(filterExpression ? { filter_expression: filterExpression } : {}) }),
      });
    }
    const sourceRows = lookerProbeRows(payload);
    const rows = sourceRows.slice(0, MAX_VALIDATION_ROWS);
    const fieldNames = Array.from(new Set(rows.flatMap((row) => Object.keys(row)))).sort().slice(0, MAX_VALIDATION_COLUMNS);
    const stableRows = rows.map((row) => Object.fromEntries(fieldNames.map((field) => [field, row[field] ?? null])));
    const fingerprint = createHash('sha256').update(JSON.stringify(stableRows)).digest('hex');
    return {
      dashboardPlanId,
      tileId,
      source,
      rows: stableRows,
      rowCount: sourceRows.length,
      returnedRowCount: stableRows.length,
      fieldNames,
      fingerprint,
      truncated: sourceRows.length > stableRows.length,
    };
  });
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

async function domoInventoryFromAuthenticatedConnection(
  connection: SavedPlatformConnection,
  platformConnection: SavedPlatformConnection,
): Promise<SourceInventoryResult> {
  const base = DOMO_PLATFORM_API_BASE;
  const warnings: string[] = [];
  const collection = tracker();
  const [datasets, cards, pages] = await Promise.all([
    collect(platformConnection, {
      url: `${base}/v1/datasets?limit=100&offset=0`, keys: ['data', 'datasets'], kind: 'dataset', warnings, tracker: collection,
      idKeys: ['id', 'dataSourceId', 'datasetId'], nameKeys: ['name', 'displayName'], pagination: 'offset', pageSize: 100,
      metadataKeys: ['description', 'type', 'createdAt', 'updatedAt', 'rows', 'columns', 'ownerId'],
    }),
    collect(platformConnection, {
      url: `${base}/v1/cards?limit=100&offset=0`, keys: ['data', 'cards'], kind: 'card', warnings, tracker: collection,
      idKeys: ['cardUrn', 'urn', 'id'], nameKeys: ['cardTitle', 'title', 'name'], dependencyKeys: ['datasourceId', 'dataSourceId', 'datasetId'],
      pagination: 'offset', pageSize: 100,
      metadataKeys: ['cardUrn', 'type', 'chartType', 'datasourceId', 'dataSourceId', 'datasetId', 'ownerId', 'lastModified'],
    }),
    collect(platformConnection, {
      url: `${base}/v1/pages?limit=100&offset=0`, keys: ['data', 'pages'], kind: 'page', warnings, tracker: collection,
      idKeys: ['id', 'pageId'], nameKeys: ['name', 'title'], parentIdKeys: ['parentId'], dependencyKeys: ['cardIds', 'card_ids'],
      pagination: 'offset', pageSize: 100,
      metadataKeys: ['parentId', 'visibility', 'locked', 'createdAt', 'updatedAt'],
    }),
  ]);
  const unstable = [...cards, ...pages].filter((item) => item.metadata.syntheticId === true);
  if (unstable.length > 0) {
    collection.truncated = true;
    warnings.push(`${unstable.length} Domo content item${unstable.length === 1 ? '' : 's'} did not include a stable source ID and cannot be selected safely.`);
  }
  return result(connection, [...datasets, ...cards, ...pages], warnings, collection);
}

async function domoInventory(connection: SavedPlatformConnection): Promise<SourceInventoryResult> {
  const platformConnection = await domoAuthenticatedConnection(connection);
  return domoInventoryFromAuthenticatedConnection(connection, platformConnection);
}

interface DomoEvidenceState {
  requests: number;
  warnings: string[];
  blockers: string[];
  truncated: boolean;
}

async function domoProductSearch(
  connection: SavedPlatformConnection,
  entity: 'alert' | 'app' | 'beast_mode' | 'card' | 'connector' | 'data_app' | 'dataflow' | 'dataset' | 'page',
  state: DomoEvidenceState,
  maximum: number,
  query = '*',
): Promise<unknown[]> {
  const rows: unknown[] = [];
  const pageSize = Math.min(500, maximum);
  let offset = 0;
  while (rows.length < maximum) {
    state.requests += 1;
    const payload = await fetchDomoProductJson(connection, '/api/search/v1/query', {
      method: 'POST',
      body: JSON.stringify({
        count: Math.min(pageSize, maximum - rows.length),
        offset,
        query,
        filters: [],
        sort: {},
        facetValuesToInclude: [],
        facetValueLimit: 0,
        facetValueOffset: 0,
        includePhonetic: false,
        entityList: [[entity]],
      }),
    });
    const page = domoSearchRows(payload);
    rows.push(...page);
    const root = asRecord(payload);
    const total = numericValue(root.totalResultCount, root.totalHits);
    const hasMore = root.hasMore === true || (total != null && rows.length < total);
    if (page.length === 0 || !hasMore) break;
    offset += page.length;
  }
  const rootCountExceeded = rows.length >= maximum;
  if (rootCountExceeded) {
    state.truncated = true;
    state.blockers.push(`Domo ${entity.replace('_', ' ')} evidence reached the ${maximum.toLocaleString()}-item safety limit. Narrow the selected dashboard scope or use focused Manual Files.`);
  }
  return rows.slice(0, maximum);
}

function domoLinkedResourceIds(value: unknown, expectedType?: 'CARD' | 'DATA_SOURCE'): string[] {
  const result: string[] = [];
  const walk = (current: unknown, depth: number) => {
    if (depth > 8 || current == null) return;
    if (Array.isArray(current)) {
      current.forEach((item) => walk(item, depth + 1));
      return;
    }
    if (typeof current !== 'object') return;
    const record = current as Record<string, unknown>;
    const resource = asRecord(record.resource);
    const type = firstString(resource.type, record.resourceType, record.type).toUpperCase();
    const id = firstString(resource.id, record.resourceId);
    if (id && (!expectedType || type === expectedType)) result.push(id);
    Object.values(record).forEach((item) => walk(item, depth + 1));
  };
  walk(value, 0);
  return Array.from(new Set(result));
}

function recordName(value: unknown, fallback: string): string {
  const record = asRecord(value);
  return firstString(record.name, record.title, record.cardTitle, record.displayName, record.dataSourceName) || fallback;
}

function mergeDomoRecords(...values: unknown[]): Record<string, unknown> {
  return Object.assign({}, ...values.map(asRecord));
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

export async function prepareDomoApiEvidence(
  connection: SavedPlatformConnection,
  selectedDashboardIds: string[],
): Promise<DomoApiEvidenceResult> {
  if (!connection.enabled) throw Object.assign(new Error('This platform connection is disabled.'), { statusCode: 409 });
  if (connection.platform !== 'domo') throw Object.assign(new Error('Domo evidence preparation requires a saved Domo source.'), { statusCode: 400 });
  if (!connection.productApiToken) {
    throw Object.assign(new Error('Domo Deep inventory is not configured. Add a Product API developer token to the saved source, or switch to Manual Files for the selected dashboards.'), { statusCode: 409 });
  }
  const selected = uniqueStrings(selectedDashboardIds.map(String));
  if (selected.length === 0) throw Object.assign(new Error('Select at least one Domo Page or Card before preparing migration evidence.'), { statusCode: 400 });
  if (selected.length > MAX_DOMO_SELECTED_DASHBOARDS) {
    throw Object.assign(new Error(`Prepare no more than ${MAX_DOMO_SELECTED_DASHBOARDS} Domo Pages or Cards at a time.`), { statusCode: 413 });
  }

  // One OAuth exchange supports the bounded Platform catalog and selected Page/Card details.
  const platformConnection = await domoAuthenticatedConnection(connection);
  const inventory = await domoInventoryFromAuthenticatedConnection(connection, platformConnection);
  const state: DomoEvidenceState = {
    requests: inventory.collection.requestsMade,
    warnings: [...inventory.warnings],
    blockers: [],
    truncated: inventory.truncated,
  };
  const aliases = new Map<string, SourceDashboardCatalogItem>();
  inventory.dashboardCatalog.forEach((item) => {
    [item.id, ...(item.id.includes(':') ? [item.id.split(':').pop() || ''] : [])].filter(Boolean).forEach((id) => aliases.set(id, item));
  });
  const selectedItems = selected.flatMap((id) => {
    const item = aliases.get(id);
    if (!item) state.blockers.push(`Selected Domo content ${id} was not found in the current saved-source catalog.`);
    return item ? [item] : [];
  });

  const selectedPages = selectedItems.filter((item) => item.kind === 'page');
  const selectedCards = selectedItems.filter((item) => item.kind === 'card');
  const pageDetails = (await mapWithConcurrency(selectedPages, 5, async (item) => {
    state.requests += 1;
    try {
      const detail = await fetchConnectorJson(platformConnection, `${DOMO_PLATFORM_API_BASE}/v1/pages/${encodeURIComponent(item.id)}`);
      return { item, detail };
    } catch (error) {
      state.blockers.push(`Could not load Domo Page ${item.name}: ${error instanceof Error ? error.message : 'request failed'}`);
      return { item, detail: null };
    }
  })).filter((entry) => entry.detail != null);

  const cardIds = uniqueStrings([
    ...selectedCards.map((item) => item.id),
    ...pageDetails.flatMap((entry) => domoCardIds(entry.detail)),
  ]).slice(0, MAX_DOMO_EVIDENCE_CARDS + 1);
  if (cardIds.length > MAX_DOMO_EVIDENCE_CARDS) {
    state.truncated = true;
    state.blockers.push(`Selected Domo Pages contain more than ${MAX_DOMO_EVIDENCE_CARDS} Cards. Split this migration into smaller waves.`);
  }
  const boundedCardIds = cardIds.slice(0, MAX_DOMO_EVIDENCE_CARDS);

  let productCardRows: unknown[] = [];
  try {
    productCardRows = await domoProductSearch(connection, 'card', state, MAX_DOMO_EVIDENCE_CARDS);
  } catch (error) {
    state.blockers.push(`Domo Card dependency search failed: ${error instanceof Error ? error.message : 'request failed'}`);
  }
  const productCardsByAlias = new Map<string, unknown>();
  productCardRows.forEach((row) => domoObjectIdAliases(row).forEach((id) => productCardsByAlias.set(id, row)));

  const platformCardDetails = await mapWithConcurrency(boundedCardIds, 5, async (cardId) => {
    state.requests += 1;
    try {
      return await fetchConnectorJson(platformConnection, `${DOMO_PLATFORM_API_BASE}/v1/cards/${encodeURIComponent(cardId)}`);
    } catch (error) {
      state.blockers.push(`Could not load Domo Card ${cardId}: ${error instanceof Error ? error.message : 'request failed'}`);
      return null;
    }
  });
  const cards = boundedCardIds.flatMap((cardId, index) => {
    const platform = platformCardDetails[index];
    if (!platform) return [];
    const product = [cardId, ...(cardId.includes(':') ? [cardId.split(':').pop() || ''] : [])]
      .map((id) => productCardsByAlias.get(id)).find(Boolean);
    const merged = mergeDomoRecords(platform, product, { id: cardId, cardId, objectType: 'card' });
    return [merged];
  });
  const datasetIds = uniqueStrings(cards.flatMap(domoDatasetIds)).slice(0, MAX_DOMO_EVIDENCE_DATASETS + 1);
  if (datasetIds.length > MAX_DOMO_EVIDENCE_DATASETS) {
    state.truncated = true;
    state.blockers.push(`Selected Domo Cards reference more than ${MAX_DOMO_EVIDENCE_DATASETS} DataSets. Split this migration into smaller waves.`);
  }
  const boundedDatasetIds = datasetIds.slice(0, MAX_DOMO_EVIDENCE_DATASETS);

  const datasetEvidence = await mapWithConcurrency(boundedDatasetIds, 4, async (datasetId) => {
    const load = async (label: string, path: string, product = true) => {
      state.requests += 1;
      try {
        return product
          ? await fetchDomoProductJson(connection, path)
          : await fetchConnectorJson(platformConnection, path);
      } catch (error) {
        state.warnings.push(`${label} for Domo DataSet ${datasetId} was unavailable: ${error instanceof Error ? error.message : 'request failed'}`);
        return null;
      }
    };
    const [metadata, schema, permissions, policies, datasetCards] = await Promise.all([
      load('Metadata', `/api/data/v3/datasources/${encodeURIComponent(datasetId)}?part=core,permission`),
      load('Schema', `/api/data/v2/datasources/${encodeURIComponent(datasetId)}/schemas/latest`),
      load('Access list', `/api/data/v3/datasources/${encodeURIComponent(datasetId)}/permissions`),
      load('PDP policies', `${DOMO_PLATFORM_API_BASE}/v1/datasets/${encodeURIComponent(datasetId)}/policies`, false),
      load('Card bindings', `/api/content/v1/datasources/${encodeURIComponent(datasetId)}/cards?drill=true`),
    ]);
    if (!schema) state.blockers.push(`Domo DataSet ${datasetId} has no readable schema evidence.`);
    return { datasetId, metadata, schema, permissions, policies, datasetCards };
  });

  // Dataset-to-Card bindings are authoritative when Product Search omits datasourceId.
  datasetEvidence.forEach(({ datasetId, datasetCards }) => {
    firstArray(datasetCards, ['cards', 'items']).forEach((row) => {
      domoObjectIdAliases(row).forEach((alias) => {
        const card = cards.find((item) => domoObjectIdAliases(item).includes(alias));
        if (card) {
          Object.assign(card, mergeDomoRecords(row, card));
          if (!domoDatasetIds(card).includes(datasetId)) card.datasourceId = datasetId;
        }
      });
    });
  });

  const beastModeSearch: unknown[] = [];
  try {
    const pageSize = 500;
    let offset = 0;
    while (beastModeSearch.length < MAX_DOMO_EVIDENCE_BEAST_MODES) {
      state.requests += 1;
      const payload = await fetchDomoProductJson(connection, '/api/query/v1/functions/search', {
        method: 'POST',
        body: JSON.stringify({ name: '', filters: [{ field: 'notvariable' }], sort: { field: 'name', ascending: true }, limit: pageSize, offset }),
      });
      const rows = firstArray(payload, ['results']);
      beastModeSearch.push(...rows);
      if (rows.length === 0 || asRecord(payload).hasMore !== true) break;
      offset += rows.length;
    }
    if (beastModeSearch.length >= MAX_DOMO_EVIDENCE_BEAST_MODES) {
      state.truncated = true;
      state.blockers.push(`Domo Beast Mode search reached the ${MAX_DOMO_EVIDENCE_BEAST_MODES.toLocaleString()}-item safety limit. Use focused Manual Files for complete formula evidence.`);
    }
  } catch (error) {
    state.blockers.push(`Domo Beast Mode discovery failed: ${error instanceof Error ? error.message : 'request failed'}`);
  }
  const cardAliases = new Set(cards.flatMap(domoObjectIdAliases));
  const datasetAliasSet = new Set(boundedDatasetIds);
  const scopedBeastModeRows = beastModeSearch.filter((row) => {
    const linkedCards = domoLinkedResourceIds(row, 'CARD').flatMap((id) => [id, ...(id.includes(':') ? [id.split(':').pop() || ''] : [])]);
    const linkedDatasets = domoLinkedResourceIds(row, 'DATA_SOURCE');
    return linkedCards.some((id) => cardAliases.has(id)) || linkedDatasets.some((id) => datasetAliasSet.has(id));
  });
  const beastModes = (await mapWithConcurrency(scopedBeastModeRows, 5, async (row) => {
    const beastModeId = firstString(asRecord(row).id) || (typeof asRecord(row).id === 'number' ? String(asRecord(row).id) : '');
    if (!beastModeId) return null;
    state.requests += 1;
    try {
      const detail = await fetchDomoProductJson(connection, `/api/query/v1/functions/template/${encodeURIComponent(beastModeId)}`);
      const linkedDataset = domoLinkedResourceIds(detail, 'DATA_SOURCE').find((id) => datasetAliasSet.has(id));
      return mergeDomoRecords(detail, linkedDataset ? { dataSourceId: linkedDataset } : {});
    } catch (error) {
      state.warnings.push(`Domo Beast Mode ${recordName(row, beastModeId)} could not be hydrated: ${error instanceof Error ? error.message : 'request failed'}`);
      return null;
    }
  })).filter((row): row is Record<string, unknown> => row != null);

  const scopedIds = new Set([...selected, ...boundedCardIds, ...boundedDatasetIds]);
  const handoffArtifacts: MigrationArtifact[] = [];
  for (const entity of ['dataflow', 'connector', 'app', 'data_app', 'alert'] as const) {
    try {
      const rows = await domoProductSearch(connection, entity, state, 500);
      const related = rows.filter((row) => {
        const references = uniqueStrings([...domoReferenceValues(row, new Set(['cardid', 'pageid', 'datasourceid', 'datasetid', 'dataset_id', 'data_source_id'])), ...domoLinkedResourceIds(row)]);
        return references.some((id) => scopedIds.has(id) || scopedIds.has(id.split(':').pop() || ''));
      });
      if (related.length > 0) {
        const wrapper = entity === 'alert' ? 'alerts' : entity === 'dataflow' ? 'dataflows' : entity === 'connector' ? 'connectors' : 'customApps';
        handoffArtifacts.push(domoEvidenceArtifact(`domo-api-${entity}-handoffs.json`, { [wrapper]: related.map((row) => ({ ...asRecord(row), objectType: entity === 'dataflow' ? 'Domo DataFlow' : entity })) }));
      }
    } catch (error) {
      state.warnings.push(`Domo ${entity.replace('_', ' ')} dependency search was unavailable: ${error instanceof Error ? error.message : 'request failed'}`);
    }
  }

  const artifacts: MigrationArtifact[] = [
    domoEvidenceArtifact('domo-api-pages.json', { pages: pageDetails.map(({ item, detail }) => ({ ...asRecord(detail), id: item.id, name: item.name, cardIds: domoCardIds(detail) })) }),
    domoEvidenceArtifact('domo-api-cards.json', { cards }),
    ...datasetEvidence.flatMap(({ datasetId, metadata, schema, permissions, policies }) => [
      domoEvidenceArtifact(`domo-api-dataset-${datasetId}.json`, {
        datasets: [{ ...asRecord(metadata), id: datasetId, dataSourceId: datasetId, name: recordName(metadata, `Domo DataSet ${datasetId}`), schema: asRecord(schema).schema || schema }],
        datasetAccess: permissions ? [{ datasetId, dataSourceId: datasetId, permissions }] : [],
        pdpPolicies: firstArray(policies, ['policies', 'data']).map((policy) => ({ ...asRecord(policy), datasetId, dataSourceId: datasetId, policyType: 'PDP' })),
      }),
    ]),
    ...(beastModes.length > 0 ? [domoEvidenceArtifact('domo-api-beast-modes.json', { beastModes })] : []),
    ...handoffArtifacts,
  ];
  const parseResult = parseDomoManualArtifacts(artifacts);
  const parsedCards = parseResult.inventory.dashboards.filter((dashboard) => dashboard.assetKind === 'card');
  const parsedPages = parseResult.inventory.dashboards.filter((dashboard) => dashboard.assetKind === 'page');
  parsedCards.forEach((card) => {
    if (!card.sourceDatasetId) state.blockers.push(`Domo Card ${card.name} has no DataSet binding in the documented API evidence.`);
    if (card.fields.length === 0) state.blockers.push(`Domo Card ${card.name} has no field bindings in the documented API evidence. Add its Analyzer/Card JSON through Manual Files or explicitly redesign the Card.`);
  });
  if (parsedCards.some((card) => card.featureFlags?.includes('variable_controls')) && !parseResult.mappings.some((mapping) => mapping.sourceKind === 'variable')) {
    state.blockers.push('Selected Domo Cards use Variables, but Variable type/default/control evidence was not resolved. Add the relevant Variable export through Manual Files before planning.');
  }
  if (parsedCards.length === 0) state.blockers.push('The selected Domo scope did not resolve any Card definitions.');
  if (parseResult.inventory.views.every((view) => view.fields.length === 0)) state.blockers.push('The selected Domo scope did not resolve a typed DataSet schema.');
  state.blockers = uniqueStrings(state.blockers);
  state.warnings = uniqueStrings(state.warnings);
  const scopeFingerprint = createHash('sha256').update(JSON.stringify({
    connectionId: connection.id,
    updatedAt: connection.updatedAt,
    selected: [...selected].sort(),
    cards: parsedCards.map((card) => card.sourceId).sort(),
    datasets: boundedDatasetIds.sort(),
    beastModes: beastModes.map((row) => String(row.id || '')).sort(),
  })).digest('hex');
  const resolvedDashboardIds = uniqueStrings([...parsedPages, ...parsedCards].flatMap((dashboard) => dashboard.sourceId ? [dashboard.sourceId] : []));
  const browserSafeParseResult: DomoManualParseResult = {
    ...parseResult,
    inventory: {
      ...parseResult.inventory,
      artifacts: parseResult.inventory.artifacts.map((artifact) => ({ ...artifact, content: '' })),
    },
  };
  return {
    parseResult: browserSafeParseResult,
    selectedDashboardIds: selected,
    resolvedDashboardIds,
    scopeFingerprint,
    preparedAt: new Date().toISOString(),
    diagnostics: {
      schemaVersion: 'omnikit.domo.api.v1',
      status: state.blockers.length === 0 ? 'ready' : 'blocked',
      access: 'deep',
      selectedDashboardCount: selected.length,
      resolvedPageCount: parsedPages.length,
      resolvedCardCount: parsedCards.length,
      resolvedDatasetCount: parseResult.inventory.views.filter((view) => view.kind === 'dataset').length,
      resolvedBeastModeCount: parseResult.mappings.filter((mapping) => mapping.sourceKind === 'beast_mode').length,
      requestCount: state.requests,
      truncated: state.truncated,
      blockers: state.blockers,
      warnings: state.warnings,
    },
  };
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

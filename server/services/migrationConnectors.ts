import { createHash } from 'node:crypto';
import { STATUS_CODES } from 'node:http';
import type {
  DomoApiEvidenceLimitation,
  DomoApiMissingDependency,
  DomoApiMissingDependencyKind,
  DomoApiEvidenceResult,
  DomoManualParseResult,
  MigrationArtifact,
  MigrationBiSourceTool,
  MigrationPreparedEvidenceResult,
} from '../../src/services/semanticMigration/types';
import { redactSensitiveText } from './jobSanitizer';
import { savedSourceAuthenticationIssue, type MigrationPlatformKind, type SavedPlatformConnection } from './nativeVault';
import { parseDomoManualArtifacts } from './semanticMigration/domoManualParser';
import type {
  MigrationSourceCollectorContext,
  MigrationSourceConnectionSnapshot,
  MigrationSourceTransport,
} from './migrationSources/contracts';
import { createMigrationSourceTransport } from './migrationSources/secureTransport';
import { listLookerDiscoveryInventory } from './migrationSources/looker';
import { listSigmaDiscoveryInventory } from './migrationSources/sigma';
import { discoverTableauSource } from './migrationSources/tableau';
import { discoverPowerBiSource } from './migrationSources/powerBi';
import { discoverMicroStrategySource } from './migrationSources/microStrategy';
import { discoverMetabaseSource } from './migrationSources/metabase';

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_INVENTORY_ITEMS = 1_000;
const MAX_INVENTORY_PAGES = 25;
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
const MAX_DOMO_PRODUCT_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_DOMO_OAUTH_RESPONSE_BYTES = 5 * 1024 * 1024;
const DOMO_HTTP_ERROR_STATUSES = Array.from({ length: 200 }, (_value, index) => index + 400);
const DOMO_PRODUCT_CARD_ANALYZER_DEFINITION_LIMITATION: DomoApiEvidenceLimitation = {
  code: 'domo_product_card_analyzer_definition_manual_validation_required',
  message: 'Domo Product Search proves Card discovery, not a complete Analyzer/Card definition. Supply and validate OAuth Chart Card definitions or reviewed Manual Files for every selected Card before Apply to Dev or release.',
};
const DOMO_PRODUCT_CARD_DRILL_LIMITATION: DomoApiEvidenceLimitation = {
  code: 'domo_product_card_drill_manual_validation_required',
  message: 'Domo Product API does not prove complete Analyzer drill paths. When the documented OAuth drill-properties response is unavailable, denied, or invalid for a selected Card, validate that Card drill path manually before release.',
};
const DOMO_PRODUCT_DATASET_PDP_LIMITATION: DomoApiEvidenceLimitation = {
  code: 'domo_product_dataset_pdp_manual_validation_required',
  message: 'Domo Product API does not prove complete DataSet PDP policy lists. Validate PDP behavior and access manually before release.',
};
const DOMO_PLATFORM_DATASET_DEFINITION_LIMITATION: DomoApiEvidenceLimitation = {
  code: 'domo_platform_dataset_definition_manual_validation_required',
  message: 'Domo Platform OAuth does not replace Product API DataSet metadata, typed schema, access, and Card-binding evidence. Add a Product API developer token or reviewed Manual Files.',
};
const DOMO_PLATFORM_BEAST_MODE_LIMITATION: DomoApiEvidenceLimitation = {
  code: 'domo_platform_beast_mode_manual_validation_required',
  message: 'Domo Platform OAuth does not replace Product API Beast Mode search and exact formula definitions. Add a Product API developer token or reviewed Manual Files.',
};

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
  queryValidationMode: 'source_and_target' | 'target_only' | 'manual_source_evidence';
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
  connectionUpdatedAt: string;
  connector: SourceConnectorDefinition;
  items: SourceInventoryItem[];
  dashboardCatalog: SourceDashboardCatalogItem[];
  warnings: string[];
  truncated: boolean;
  collection: {
    scope: 'all_accessible' | 'saved_parent';
    scopeLabel: string;
    complete: boolean;
    status: 'complete' | 'partial' | 'failed' | 'bounded';
    errors: string[];
    pagesFetched: number;
    parentsExpanded: number;
    requestsMade: number;
    maxPages: number;
    maxItems: number;
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
  status?: 'resolved' | 'missing';
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
    platform: 'domo', label: 'Domo', authGuidance: 'Use a tenant-bound Product API developer token and optionally add Platform OAuth client credentials for Chart Card and PDP definitions.',
    capabilities: { apiInventory: true, semanticDefinitions: 'partial', contentDefinitions: 'partial', usage: false, permissions: false, schedules: false, queryValidation: false, queryValidationMode: 'manual_source_evidence', visualEvidence: false },
    migrationCoverage: { semantic_objects: 'partial', dashboards: 'partial', filters: 'partial', layout: 'unsupported', permissions: 'unsupported', schedules: 'unsupported' },
    limitations: ['Complete Analyzer queries, Variables, drill layers, Filter Views, Magic ETL, Workflows, App Studio, Workbench, and governance behavior may require focused customer exports.'],
  },
  power_bi: {
    platform: 'power_bi', label: 'Power BI', authGuidance: 'Use Microsoft Entra OAuth or service-principal client credentials for Fabric definition APIs.',
    capabilities: { apiInventory: true, semanticDefinitions: 'partial', contentDefinitions: 'partial', usage: true, permissions: true, schedules: true, queryValidation: false, queryValidationMode: 'manual_source_evidence', visualEvidence: true },
    migrationCoverage: { semantic_objects: 'export_required', dashboards: 'partial', filters: 'partial', layout: 'export_required', permissions: 'unsupported', schedules: 'unsupported' },
    limitations: ['PBIX/TMDL or scanner API exports are required for complete DAX, visual, and semantic definitions.'],
  },
  tableau: {
    platform: 'tableau', label: 'Tableau', authGuidance: 'Use a Tableau PAT name and secret. OmniKit exchanges it server-side for an ephemeral X-Tableau-Auth session.',
    capabilities: { apiInventory: true, semanticDefinitions: 'partial', contentDefinitions: 'partial', usage: true, permissions: true, schedules: true, queryValidation: false, queryValidationMode: 'manual_source_evidence', visualEvidence: true },
    migrationCoverage: { semantic_objects: 'export_required', dashboards: 'partial', filters: 'partial', layout: 'export_required', permissions: 'unsupported', schedules: 'unsupported' },
    limitations: ['Metadata API GraphQL or TWB/TDS exports are required for complete lineage and calculations.'],
  },
  sigma: {
    platform: 'sigma', label: 'Sigma', authGuidance: 'Use a Sigma API client ID and secret; OmniKit exchanges it server-side and retrieves Data Model specifications for selected models.',
    capabilities: { apiInventory: true, semanticDefinitions: 'partial', contentDefinitions: 'partial', usage: false, permissions: true, schedules: true, queryValidation: false, queryValidationMode: 'manual_source_evidence', visualEvidence: false },
    migrationCoverage: { semantic_objects: 'partial', dashboards: 'partial', filters: 'partial', layout: 'unsupported', permissions: 'unsupported', schedules: 'unsupported' },
    limitations: ['Input tables, writeback, actions, layout, permissions, schedules, and unsupported workbook formulas remain explicit review or handoff decisions.'],
  },
  looker: {
    platform: 'looker', label: 'Looker', authGuidance: 'Use a documented Looker API 4.0 client ID and client secret. OmniKit exchanges them server-side for a short-lived API token.',
    capabilities: { apiInventory: true, semanticDefinitions: 'partial', contentDefinitions: 'partial', usage: true, permissions: false, schedules: false, queryValidation: true, queryValidationMode: 'source_and_target', visualEvidence: true },
    migrationCoverage: { semantic_objects: 'partial', dashboards: 'partial', filters: 'partial', layout: 'partial', permissions: 'unsupported', schedules: 'unsupported' },
    limitations: ['Compiled API evidence does not include raw LookML includes, refinements, Liquid, manifests, tests, or PDT source SQL. Use authorized Git or Manual Files for raw-source fidelity.'],
  },
  metabase: {
    platform: 'metabase', label: 'Metabase', authGuidance: 'Use a scoped Metabase API key. Saved user sessions are not supported.',
    capabilities: { apiInventory: true, semanticDefinitions: 'partial', contentDefinitions: 'partial', usage: false, permissions: false, schedules: false, queryValidation: false, queryValidationMode: 'manual_source_evidence', visualEvidence: true },
    migrationCoverage: { semantic_objects: 'partial', dashboards: 'partial', filters: 'partial', layout: 'partial', permissions: 'unsupported', schedules: 'unsupported' },
    limitations: ['Native SQL cards, ad-hoc aggregations, unsupported visual behavior, permissions, and subscriptions require explicit review.'],
  },
  webfocus: {
    platform: 'webfocus', label: 'WebFOCUS', authGuidance: 'Saved API is disabled pending approval of a secure stored WebFOCUS session-credential flow. Use Manual Files.',
    capabilities: { apiInventory: false, semanticDefinitions: 'export_required', contentDefinitions: 'export_required', usage: false, permissions: false, schedules: false, queryValidation: false, queryValidationMode: 'manual_source_evidence', visualEvidence: false },
    migrationCoverage: { semantic_objects: 'export_required', dashboards: 'partial', filters: 'partial', layout: 'unsupported', permissions: 'unsupported', schedules: 'unsupported' },
    limitations: ['Version-specific Change Management, FEX/MAS/ACX, ReportCaster, and portal exports may be required.'],
  },
  microstrategy: {
    platform: 'microstrategy', label: 'Strategy', authGuidance: 'Use a supported project-bound username/password session. SAML-only or unsupported versions remain Manual Files-only.',
    capabilities: { apiInventory: true, semanticDefinitions: 'partial', contentDefinitions: 'partial', usage: false, permissions: false, schedules: false, queryValidation: false, queryValidationMode: 'manual_source_evidence', visualEvidence: true },
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

function firstIdentifier(...values: unknown[]): string {
  const value = values.find((item) => (
    (typeof item === 'string' && item.trim().length > 0)
    || (typeof item === 'number' && Number.isFinite(item))
  ));
  return value == null ? '' : String(value).trim();
}

function identifierAliases(value: unknown): string[] {
  const id = firstIdentifier(value);
  if (!id) return [];
  return Array.from(new Set([id, ...(id.includes(':') ? [id.split(':').pop() || ''] : [])].filter(Boolean)));
}

function identifiersMatch(expected: unknown, actual: unknown): boolean {
  const expectedAliases = new Set(identifierAliases(expected));
  return identifierAliases(actual).some((alias) => expectedAliases.has(alias));
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
  'view_count', 'user_name', 'model', 'label', 'formula', 'valueType', 'vizualizationType', 'visualizationType',
  'permission', 'memberId', 'teamId', 'inodeId', 'inodeType', 'scheduledNotificationId', 'isSuspended',
];

function cleanBaseUrl(value?: string): string {
  if (!value) throw Object.assign(new Error('Platform base URL is required.'), { statusCode: 400 });
  return value.trim().replace(/\/+$/, '');
}

function assertSavedSourceAuthentication(connection: SavedPlatformConnection): void {
  const issue = savedSourceAuthenticationIssue(connection);
  if (issue) throw Object.assign(new Error(issue), { statusCode: 409 });
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
  if (connection.platform === 'looker') {
    return { Accept: 'application/json', Authorization: `token ${connection.credential}` };
  }
  return { Accept: 'application/json', Authorization: `Bearer ${connection.credential}` };
}

function lookerApiBase(connection: SavedPlatformConnection): string {
  const base = cleanBaseUrl(connection.baseUrl);
  return /\/api\/4\.0$/i.test(base) ? base : `${base}/api/4.0`;
}

function exactSecretVariants(secret: string): string[] {
  if (!secret) return [];
  return [
    secret,
    encodeURIComponent(secret),
    Buffer.from(secret).toString('base64'),
    Buffer.from(secret).toString('base64url'),
  ];
}

function replaceExactSecretVariants(value: string, secrets: string[]): string {
  return Array.from(new Set(secrets.flatMap(exactSecretVariants)))
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .reduce((message, secret) => message.split(secret).join('[redacted]'), value);
}

function redactExactSecrets(value: string, secrets: string[]): string {
  return replaceExactSecretVariants(redactSensitiveText(value), secrets);
}

function domoOAuthTimeoutError(): Error {
  return Object.assign(new Error('Domo OAuth timed out before a complete token response was received. Retry the connection test.'), { statusCode: 504 });
}

function assertDomoRequestActive(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw Object.assign(new Error('Domo API evidence request was cancelled.'), { name: 'AbortError', statusCode: 499 });
}

async function domoOAuthAccessToken(
  connection: SavedPlatformConnection,
  signal?: AbortSignal,
  transport: MigrationSourceTransport = createMigrationSourceTransport(),
): Promise<string> {
  assertDomoRequestActive(signal);
  if (!connection.clientId) {
    throw Object.assign(new Error('Domo client ID is required for OAuth client credentials.'), { statusCode: 400 });
  }
  const tokenUrl = new URL(`${DOMO_PLATFORM_API_BASE}/oauth/token`);
  tokenUrl.searchParams.set('grant_type', 'client_credentials');
  tokenUrl.searchParams.set('scope', 'data dashboard');
  const basicValue = Buffer.from(`${connection.clientId}:${connection.credential}`).toString('base64');
  const authorization = `Basic ${basicValue}`;
  const sensitiveValues = [connection.credential, basicValue, authorization];
  try {
    const response = await transport.request<string>({
      url: tokenUrl.toString(),
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: authorization },
      responseType: 'text',
      label: 'Domo OAuth token response',
      allowStatuses: DOMO_HTTP_ERROR_STATUSES,
      maxResponseBytes: MAX_DOMO_OAUTH_RESPONSE_BYTES,
      deadlineMs: REQUEST_TIMEOUT_MS,
      signal,
    });
    const text = response.body;
    if (response.status < 200 || response.status >= 300) {
      const safeErrorText = redactExactSecrets(text || STATUS_CODES[response.status] || 'request failed', sensitiveValues);
      throw Object.assign(new Error(`Domo OAuth returned ${response.status}: ${safeErrorText.slice(0, 500)}`), { statusCode: response.status === 401 || response.status === 403 ? 409 : 502 });
    }
    let payload: Record<string, unknown>;
    try {
      payload = text ? asRecord(JSON.parse(text)) : {};
    } catch {
      throw Object.assign(new Error('Domo OAuth returned a non-JSON token response.'), { statusCode: 502 });
    }
    const accessToken = firstString(payload.access_token);
    if (!accessToken) throw Object.assign(new Error('Domo OAuth did not return an access token.'), { statusCode: 502 });
    return accessToken;
  } catch (error) {
    assertDomoRequestActive(signal);
    const statusCode = typeof (error as { statusCode?: unknown })?.statusCode === 'number'
      ? (error as { statusCode: number }).statusCode
      : 502;
    const rawMessage = error instanceof Error ? error.message : 'Domo OAuth token exchange failed.';
    if (statusCode === 504 && /timed out/i.test(rawMessage)) throw domoOAuthTimeoutError();
    if (statusCode === 413 && /response-size limit/i.test(rawMessage)) {
      throw Object.assign(new Error('Domo OAuth token response exceeded the 5 MB safety limit.'), { statusCode: 413 });
    }
    throw Object.assign(new Error(redactExactSecrets(rawMessage, sensitiveValues)), { statusCode });
  }
}

async function lookerAuthenticatedConnection(connection: SavedPlatformConnection): Promise<SavedPlatformConnection> {
  assertSavedSourceAuthentication(connection);
  if (connection.platform !== 'looker' || connection.authMode !== 'api_client_credentials' || !connection.clientId || !connection.credential) {
    throw Object.assign(new Error('Looker Saved API requires an API client ID and client secret.'), { statusCode: 409 });
  }
  const loginUrl = `${lookerApiBase(connection)}/login`;
  const response = await createMigrationSourceTransport().request<Record<string, unknown>>({
    url: loginUrl,
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: connection.clientId, client_secret: connection.credential }).toString(),
    responseType: 'json',
    label: 'Looker API login',
    maxResponseBytes: 1024 * 1024,
    deadlineMs: REQUEST_TIMEOUT_MS,
  });
  const payload = asRecord(response.body);
  const accessToken = firstString(payload.access_token);
  if (!accessToken) throw Object.assign(new Error('Looker login did not return an access token.'), { statusCode: 502 });
  return { ...connection, credential: accessToken };
}

async function domoAuthenticatedConnection(
  connection: SavedPlatformConnection,
  signal?: AbortSignal,
  transport: MigrationSourceTransport = createMigrationSourceTransport(),
): Promise<SavedPlatformConnection> {
  if (!connection.clientId || !connection.credential) {
    throw Object.assign(new Error('Domo Platform API access requires an OAuth client ID and client secret.'), { statusCode: 409 });
  }
  const accessToken = await domoOAuthAccessToken(connection, signal, transport);
  return { ...connection, baseUrl: DOMO_PLATFORM_API_BASE, credential: accessToken };
}

async function fetchConnectorJson(
  connection: SavedPlatformConnection,
  url: string,
  signal?: AbortSignal,
  transport: MigrationSourceTransport = createMigrationSourceTransport(),
): Promise<unknown> {
  const response = await transport.request({
    url,
    method: 'GET',
    headers: connectorHeaders(connection),
    responseType: 'json',
    label: `${connection.platform} API response`,
    maxResponseBytes: 5 * 1024 * 1024,
    deadlineMs: REQUEST_TIMEOUT_MS,
    signal,
  });
  return response.body;
}

async function fetchDomoPlatformJson(
  connection: SavedPlatformConnection,
  url: string,
  signal?: AbortSignal,
  transport: MigrationSourceTransport = createMigrationSourceTransport(),
): Promise<unknown> {
  try {
    return await fetchConnectorJson(connection, url, signal, transport);
  } catch (error) {
    assertDomoRequestActive(signal);
    const statusCode = typeof (error as { statusCode?: unknown })?.statusCode === 'number'
      ? (error as { statusCode: number }).statusCode
      : 502;
    const message = error instanceof Error ? error.message : 'Domo Platform API request failed.';
    throw Object.assign(new Error(redactExactSecrets(message, [connection.credential])), { statusCode });
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

function domoProductTimeoutError(): Error {
  return Object.assign(new Error('Domo Product API evidence timed out before a complete response was received. Retry the request or narrow the selected Page or Card scope.'), { statusCode: 504 });
}

function redactDomoProductErrorText(value: string, productApiToken: string): string {
  return redactExactSecrets(value, [productApiToken]);
}

function redactDomoProductPayload(value: unknown, productApiToken: string): unknown {
  if (typeof value === 'string') return replaceExactSecretVariants(value, [productApiToken]);
  if (Array.isArray(value)) return value.map((item) => redactDomoProductPayload(item, productApiToken));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    replaceExactSecretVariants(key, [productApiToken]),
    redactDomoProductPayload(item, productApiToken),
  ]));
}

function redactDomoProductResponseText(value: string, productApiToken: string): string {
  return exactSecretVariants(productApiToken)
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .reduce((text, secret) => {
      const jsonEscapedSecret = JSON.stringify(secret).slice(1, -1);
      const jsonEscapedReplacement = JSON.stringify('[redacted]').slice(1, -1);
      return [jsonEscapedSecret, jsonEscapedSecret.replaceAll('/', '\\/')]
        .reduce((safeText, encodedSecret) => safeText.split(encodedSecret).join(jsonEscapedReplacement), text);
    }, value);
}

const DOMO_PRODUCT_SEARCH_ENTITIES = new Set([
  'account', 'alert', 'app', 'beast_mode', 'card', 'connector', 'data_app', 'dataset', 'dataflow', 'group', 'page', 'user',
]);

function domoProductContractError(message: string): Error {
  return Object.assign(new Error(`Domo Product API request was blocked by the documented endpoint contract: ${message}`), { statusCode: 400 });
}

function assertDomoProductIdentifier(value: string, label: string, integerOnly = false): void {
  const hasControlCharacter = Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) || 0;
    return codePoint <= 31 || codePoint === 127;
  });
  if (!value || /[\\/]/.test(value) || hasControlCharacter || value === '.' || value === '..') {
    throw domoProductContractError(`${label} is invalid.`);
  }
  if (integerOnly && !/^\d+$/.test(value)) {
    throw domoProductContractError(`${label} must be a documented integer identifier.`);
  }
}

function parseDomoProductBody(init: RequestInit): Record<string, unknown> {
  if (typeof init.body !== 'string') throw domoProductContractError('POST requests require one JSON object body.');
  try {
    const parsed = JSON.parse(init.body) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as Record<string, unknown>;
  } catch {
    throw domoProductContractError('POST requests require one valid JSON object body.');
  }
}

function assertExactDomoProductKeys(body: Record<string, unknown>, allowed: string[]): void {
  const unexpected = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) throw domoProductContractError(`unsupported request field ${unexpected[0]}.`);
}

function assertDomoProductSearchBody(body: Record<string, unknown>): void {
  assertExactDomoProductKeys(body, [
    'count', 'offset', 'query', 'filters', 'orFilters', 'notFilters', 'sort', 'facets', 'includePhonetic', 'fieldsToReturn',
    // These documented Product Search facet controls remain accepted for the connector's bounded requests.
    'facetValuesToInclude', 'facetValueLimit', 'facetValueOffset',
    'entityList',
  ]);
  if (typeof body.query !== 'string' || !body.query.trim()) throw domoProductContractError('Product Search query must be a non-empty string.');
  if (!Number.isSafeInteger(body.count) || Number(body.count) <= 0) throw domoProductContractError('Product Search count must be a positive integer.');
  if (!Number.isSafeInteger(body.offset) || Number(body.offset) < 0) throw domoProductContractError('Product Search offset must be a non-negative integer.');
  if (Number(body.count) + Number(body.offset) > 10_000) throw domoProductContractError('Product Search count plus offset exceeds Domo\'s 10,000-result bound.');
  if (!Array.isArray(body.entityList) || body.entityList.length !== 1 || !Array.isArray(body.entityList[0]) || body.entityList[0].length !== 1) {
    throw domoProductContractError('Product Search entityList must contain exactly one entity group and one entity.');
  }
  const entity = body.entityList[0][0];
  if (typeof entity !== 'string' || !DOMO_PRODUCT_SEARCH_ENTITIES.has(entity)) throw domoProductContractError('Product Search entity is not documented.');
  for (const key of ['filters', 'orFilters', 'notFilters', 'facets', 'fieldsToReturn', 'facetValuesToInclude']) {
    if (Object.hasOwn(body, key) && !Array.isArray(body[key])) throw domoProductContractError(`Product Search ${key} must be an array.`);
  }
  if (Object.hasOwn(body, 'sort') && (!body.sort || typeof body.sort !== 'object' || Array.isArray(body.sort))) throw domoProductContractError('Product Search sort must be an object.');
  if (Object.hasOwn(body, 'includePhonetic') && typeof body.includePhonetic !== 'boolean') throw domoProductContractError('Product Search includePhonetic must be boolean.');
  for (const key of ['facetValueLimit', 'facetValueOffset']) {
    if (Object.hasOwn(body, key) && (!Number.isSafeInteger(body[key]) || Number(body[key]) < 0)) throw domoProductContractError(`Product Search ${key} must be a non-negative integer.`);
  }
}

function assertDomoBeastModeSearchBody(body: Record<string, unknown>): void {
  assertExactDomoProductKeys(body, ['name', 'filters', 'sort', 'limit', 'offset']);
  const filters = body.filters;
  const sort = asRecord(body.sort);
  if (body.name !== ''
    || !Array.isArray(filters) || filters.length !== 1 || asRecord(filters[0]).field !== 'notvariable'
    || Object.keys(asRecord(filters[0])).length !== 1
    || sort.field !== 'name' || sort.ascending !== true || Object.keys(sort).length !== 2
    || !Number.isSafeInteger(body.limit) || Number(body.limit) <= 0 || Number(body.limit) > MAX_DOMO_EVIDENCE_BEAST_MODES
    || !Number.isSafeInteger(body.offset) || Number(body.offset) < 0) {
    throw domoProductContractError('Beast Mode search must match Domo\'s documented name, filter, sort, limit, and offset contract.');
  }
}

function assertDomoProductRequestContract(url: URL, init: RequestInit): { method: 'GET' | 'POST'; guideOnly: boolean } {
  const method = String(init.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'POST') throw domoProductContractError(`HTTP ${method} is not allowed.`);
  if (url.username || url.password || url.hash) throw domoProductContractError('credentials and fragments are not allowed in Product API URLs.');
  const queryEntries = Array.from(url.searchParams.entries());
  const noQuery = () => {
    if (queryEntries.length > 0) throw domoProductContractError(`${url.pathname} does not accept query parameters.`);
  };
  const requireGet = () => {
    if (method !== 'GET') throw domoProductContractError(`${url.pathname} requires GET.`);
    if (init.body != null) throw domoProductContractError('GET requests cannot include a body.');
  };
  const requirePost = () => {
    if (method !== 'POST') throw domoProductContractError(`${url.pathname} requires POST.`);
  };

  if (url.pathname === '/api/search/v1/query') {
    requirePost(); noQuery(); assertDomoProductSearchBody(parseDomoProductBody(init));
    return { method: 'POST', guideOnly: false };
  }
  if (url.pathname === '/api/query/v1/functions/search') {
    requirePost(); noQuery(); assertDomoBeastModeSearchBody(parseDomoProductBody(init));
    return { method: 'POST', guideOnly: false };
  }

  let match = url.pathname.match(/^\/api\/query\/v1\/functions\/template\/([^/]+)$/);
  if (match) {
    requireGet(); noQuery(); assertDomoProductIdentifier(decodeURIComponent(match[1]), 'Beast Mode ID', true);
    return { method: 'GET', guideOnly: false };
  }
  match = url.pathname.match(/^\/api\/data\/v3\/datasources\/([^/]+)$/);
  if (match) {
    requireGet(); assertDomoProductIdentifier(decodeURIComponent(match[1]), 'DataSet ID');
    if (queryEntries.length !== 1 || queryEntries[0][0] !== 'part' || queryEntries[0][1] !== 'core,permission') {
      throw domoProductContractError('DataSet metadata requires exactly part=core,permission.');
    }
    return { method: 'GET', guideOnly: false };
  }
  match = url.pathname.match(/^\/api\/data\/v2\/datasources\/([^/]+)\/schemas\/latest$/);
  if (match) {
    requireGet(); noQuery(); assertDomoProductIdentifier(decodeURIComponent(match[1]), 'DataSet ID');
    return { method: 'GET', guideOnly: false };
  }
  match = url.pathname.match(/^\/api\/data\/v3\/datasources\/([^/]+)\/permissions$/);
  if (match) {
    requireGet(); noQuery(); assertDomoProductIdentifier(decodeURIComponent(match[1]), 'DataSet ID');
    return { method: 'GET', guideOnly: false };
  }
  match = url.pathname.match(/^\/api\/content\/v1\/datasources\/([^/]+)\/cards$/);
  if (match) {
    requireGet(); assertDomoProductIdentifier(decodeURIComponent(match[1]), 'DataSet ID');
    if (queryEntries.length !== 1 || queryEntries[0][0] !== 'drill' || queryEntries[0][1] !== 'true') {
      throw domoProductContractError('DataSet Card membership requires exactly drill=true.');
    }
    return { method: 'GET', guideOnly: false };
  }
  match = url.pathname.match(/^\/api\/content\/v1\/pages\/([^/]+)\/cards$/);
  if (match) {
    requireGet(); assertDomoProductIdentifier(decodeURIComponent(match[1]), 'Page ID');
    if (queryEntries.length !== 1 || queryEntries[0][0] !== 'parts' || queryEntries[0][1] !== 'metadata,metadataOverrides') {
      throw domoProductContractError('Page Card membership requires exactly parts=metadata,metadataOverrides.');
    }
    return { method: 'GET', guideOnly: true };
  }
  throw domoProductContractError(`${method} ${url.pathname} is not allowlisted.`);
}

async function fetchDomoProductJson(
  connection: SavedPlatformConnection,
  path: string,
  init: RequestInit = {},
  signal?: AbortSignal,
  transport: MigrationSourceTransport = createMigrationSourceTransport(),
): Promise<unknown> {
  assertDomoRequestActive(signal);
  if (!connection.productApiToken) {
    throw Object.assign(new Error('Domo Deep inventory requires a server-side Product API developer token. Add one to the saved Domo source or use Manual Files.'), { statusCode: 409 });
  }
  if (/[\r\n]/.test(connection.productApiToken)) {
    throw Object.assign(new Error('Domo Product API developer token contains invalid header characters. Replace the saved token and retry.'), { statusCode: 409 });
  }
  const base = domoTenantBaseUrl(connection);
  const url = new URL(path, `${base}/`);
  if (url.origin !== base) throw Object.assign(new Error('Domo Product API request escaped the saved tenant boundary.'), { statusCode: 400 });
  const contract = assertDomoProductRequestContract(url, init);
  let headers: Headers;
  try {
    headers = new Headers(init.headers);
    headers.delete('Authorization');
    headers.set('Accept', 'application/json');
    if (init.body) headers.set('Content-Type', 'application/json');
    else headers.delete('Content-Type');
    headers.set('X-DOMO-Developer-Token', connection.productApiToken);
  } catch {
    throw Object.assign(new Error('Domo Product API developer token could not be used as a request header. Replace the saved token and retry.'), { statusCode: 409 });
  }
  const transportHeaders: Record<string, string> = {};
  headers.forEach((value, key) => {
    transportHeaders[key] = value;
  });
  try {
    const response = await transport.request<string>({
      url: url.toString(),
      method: contract.method,
      headers: transportHeaders,
      ...(typeof init.body === 'string' ? { body: init.body } : {}),
      responseType: 'text',
      label: 'Domo Product API response',
      allowStatuses: DOMO_HTTP_ERROR_STATUSES,
      maxResponseBytes: MAX_DOMO_PRODUCT_RESPONSE_BYTES,
      deadlineMs: REQUEST_TIMEOUT_MS,
      signal,
    });
    let text = response.body;
    if (response.status < 200 || response.status >= 300) {
      const safeErrorText = redactDomoProductErrorText(text || STATUS_CODES[response.status] || 'request failed', connection.productApiToken);
      throw Object.assign(new Error(`Domo Product API returned ${response.status}: ${safeErrorText.slice(0, 500)}`), { statusCode: response.status === 401 || response.status === 403 ? 409 : 502 });
    }
    if (!text) return {};
    const safeText = redactDomoProductResponseText(text, connection.productApiToken);
    text = '';
    try {
      return redactDomoProductPayload(JSON.parse(safeText), connection.productApiToken);
    } catch {
      throw Object.assign(new Error('Domo Product API returned a non-JSON response.'), { statusCode: 502 });
    }
  } catch (error) {
    assertDomoRequestActive(signal);
    const statusCode = typeof (error as { statusCode?: unknown })?.statusCode === 'number'
      ? (error as { statusCode: number }).statusCode
      : 502;
    const rawMessage = error instanceof Error ? error.message : 'Domo Product API request failed before a complete response was received.';
    if (statusCode === 504 && /timed out/i.test(rawMessage)) throw domoProductTimeoutError();
    if (statusCode === 413 && /response-size limit/i.test(rawMessage)) {
      throw Object.assign(new Error('Domo Product API response exceeded the 5 MB evidence limit. Narrow the selected dashboard scope.'), { statusCode: 413 });
    }
    const safeMessage = redactDomoProductErrorText(rawMessage, connection.productApiToken);
    throw Object.assign(new Error(safeMessage || 'Domo Product API request failed before a complete response was received.'), { statusCode });
  }
}

function domoReferenceValues(value: unknown, keys: Set<string>, limit = 1_000): string[] {
  const values: string[] = [];
  const walk = (current: unknown, parentKey: string, depth: number) => {
    if (depth > 10 || values.length >= limit || current == null) return;
    if (typeof current === 'string' || (typeof current === 'number' && Number.isFinite(current))) {
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

function domoObjectIdAliases(value: unknown): string[] {
  const record = asRecord(value);
  const ids = [record.id, record.urn, record.cardId, record.cardUrn, record.pageId]
    .flatMap(identifierAliases)
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
    .flatMap((item) => domoObjectIdAliases(item));
  return Array.from(new Set([...direct, ...nested].flatMap((id) => [id, ...(id.includes(':') ? [id.split(':').pop() || ''] : [])]).filter(Boolean)));
}

function domoKnownSearchArray(value: unknown): { recognized: boolean; rows: unknown[] } {
  if (Array.isArray(value)) return { recognized: true, rows: value };
  const root = asRecord(value);
  const containers = [root, ...['data', 'result', 'results', 'tsResponse'].map((key) => asRecord(root[key]))];
  for (const container of containers) {
    for (const key of ['searchObjects', 'results', 'items']) {
      if (Array.isArray(container[key])) return { recognized: true, rows: container[key] as unknown[] };
      const nested = asRecord(container[key]);
      for (const childKey of ['searchObjects', 'results', 'items']) {
        if (Array.isArray(nested[childKey])) return { recognized: true, rows: nested[childKey] as unknown[] };
      }
    }
  }
  return { recognized: false, rows: [] };
}

function domoProductSearchEnvelopeError(): Error {
  return Object.assign(new Error('Domo Product Search returned an unrecognized success response. Verify the saved credential and tenant API compatibility, then retry.'), { statusCode: 502 });
}

function domoSearchRows(payload: unknown): { rows: unknown[]; hasMore?: boolean; total?: number } {
  const root = asRecord(payload);
  let recognized = false;
  let rows: unknown[] = [];
  if (Array.isArray(root.searchObjects)) {
    recognized = true;
    rows = root.searchObjects;
  } else if (Object.hasOwn(root, 'searchResultsMap')) {
    if (!root.searchResultsMap || typeof root.searchResultsMap !== 'object' || Array.isArray(root.searchResultsMap)) {
      throw domoProductSearchEnvelopeError();
    }
    recognized = true;
    const entries = Object.values(root.searchResultsMap as Record<string, unknown>);
    const collections = entries.map(domoKnownSearchArray);
    if (collections.some((collection) => !collection.recognized)) throw domoProductSearchEnvelopeError();
    rows = collections.flatMap((collection) => collection.rows);
  }
  const total = numericValue(root.totalResultCount);
  if (total == null || !Number.isSafeInteger(total) || total < 0) {
    throw domoProductSearchEnvelopeError();
  }
  if (!recognized) {
    throw domoProductSearchEnvelopeError();
  }
  if (Object.hasOwn(root, 'hasMore') && typeof root.hasMore !== 'boolean') throw domoProductSearchEnvelopeError();
  return {
    rows,
    hasMore: typeof root.hasMore === 'boolean' ? root.hasMore : undefined,
    total,
  };
}

function domoBeastModeSearchRows(payload: unknown): { rows: unknown[]; hasMore: boolean; total: number } {
  const root = asRecord(payload);
  if (!Array.isArray(root.results)) {
    throw Object.assign(new Error('Domo Beast Mode search returned an unrecognized success response. Verify the saved credential and tenant API compatibility, then retry.'), { statusCode: 502 });
  }
  if (typeof root.hasMore !== 'boolean'
    || typeof root.degraded !== 'boolean'
    || !Number.isSafeInteger(root.totalHits)
    || Number(root.totalHits) < 0) {
    throw Object.assign(new Error('Domo Beast Mode search returned invalid pagination metadata. Verify the saved credential and tenant API compatibility, then retry.'), { statusCode: 502 });
  }
  if (root.degraded) {
    throw Object.assign(new Error('Domo Beast Mode search reported degraded=true, so the result cannot establish complete formula discovery. Retry or use focused Manual Files.'), { statusCode: 502 });
  }
  root.results.forEach((value, index) => {
    const row = asRecord(value);
    if (!Number.isSafeInteger(row.id) || Number(row.id) < 0 || !firstString(row.name) || !Array.isArray(row.links)) {
      throw Object.assign(new Error(`Domo Beast Mode search returned an invalid documented result at index ${index}. Verify the saved credential and tenant API compatibility, then retry.`), { statusCode: 502 });
    }
  });
  return {
    rows: root.results as unknown[],
    hasMore: root.hasMore,
    total: Number(root.totalHits),
  };
}

function domoPdpPolicyElement(value: unknown, index: number): Record<string, unknown> {
  const policy = asRecord(value);
  const hasIdentity = Boolean(
    firstIdentifier(policy.id, policy.policyId, policy.policy_id)
    || firstString(policy.name, policy.title, policy.displayName),
  );
  const nestedCollections = ['filters', 'columns', 'users', 'groups', 'principals', 'permissions', 'rules'];
  const invalidCollection = nestedCollections.find((key) => Object.hasOwn(policy, key) && !Array.isArray(policy[key]));
  if (Object.keys(policy).length === 0 || !hasIdentity || invalidCollection) {
    throw Object.assign(new Error(`Domo DataSet PDP evidence returned an invalid policy element at index ${index}. Verify PDP policy access and retry.`), { statusCode: 502 });
  }
  return policy;
}

function domoPdpPolicyRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload.map(domoPdpPolicyElement);
  const root = asRecord(payload);
  const containers = [root, asRecord(root.data), asRecord(root.result)];
  for (const container of containers) {
    if (!Object.hasOwn(container, 'policies')) continue;
    if (!Array.isArray(container.policies)) {
      throw Object.assign(new Error('Domo DataSet PDP evidence returned an invalid policies collection. Verify PDP policy access and retry.'), { statusCode: 502 });
    }
    return container.policies.map(domoPdpPolicyElement);
  }
  if (Object.hasOwn(root, 'data')) {
    if (!Array.isArray(root.data)) {
      throw Object.assign(new Error('Domo DataSet PDP evidence returned an unrecognized success response. Verify PDP policy access and retry.'), { statusCode: 502 });
    }
    return root.data.map(domoPdpPolicyElement);
  }
  throw Object.assign(new Error('Domo DataSet PDP evidence returned an unrecognized success response. Verify PDP policy access and retry.'), { statusCode: 502 });
}

function domoCardChartEvidence(payload: unknown, expectedCardId: string): Record<string, unknown> {
  const root = asRecord(payload);
  const candidates = [root, asRecord(root.data), asRecord(root.result), asRecord(root.card), asRecord(root.chart)];
  const chart = candidates.find((candidate) => (
    Object.hasOwn(candidate, 'chartBody')
    || Object.hasOwn(candidate, 'query')
    || Object.hasOwn(candidate, 'columns')
  ));
  if (!chart) {
    throw Object.assign(new Error('Domo Analyzer Card definition returned an unrecognized success response. Verify Card chart access and retry.'), { statusCode: 502 });
  }
  const chartIds = domoObjectIdAliases(chart);
  if (chartIds.length === 0 || !chartIds.some((id) => identifiersMatch(expectedCardId, id))) {
    throw Object.assign(new Error(`Domo Analyzer Card definition did not match requested Card ${expectedCardId}. Verify the saved source and retry.`), { statusCode: 502 });
  }
  if (!firstString(chart.name, chart.title, chart.cardTitle, chart.displayName)) {
    throw Object.assign(new Error(`Domo Analyzer Card definition for ${expectedCardId} did not include a Card name.`), { statusCode: 502 });
  }
  const chartBody = Object.hasOwn(chart, 'chartBody')
    ? asRecord(chart.chartBody)
    : Object.hasOwn(chart, 'query')
      ? asRecord(chart.query)
      : chart;
  const columns = [chartBody.columns, chartBody.fields].find(Array.isArray);
  if (!columns || columns.length === 0) {
    throw Object.assign(new Error(`Domo Analyzer Card definition for ${expectedCardId} did not include a recognized non-empty query field collection.`), { statusCode: 502 });
  }
  if (domoDatasetIds(chart).length === 0) {
    throw Object.assign(new Error(`Domo Analyzer Card definition for ${expectedCardId} did not include a DataSet binding.`), { statusCode: 502 });
  }
  return chart;
}

function domoCardDrillEvidence(payload: unknown, expectedCardId: string): {
  normalized: Record<string, unknown>;
  cardProjection: Record<string, unknown>;
} {
  const drillProperties = asRecord(payload);
  const keys = Object.keys(drillProperties);
  if (keys.length !== 2
    || !Object.hasOwn(drillProperties, 'allowTableDrill')
    || !Object.hasOwn(drillProperties, 'drillOrder')) {
    throw Object.assign(new Error(`Domo drill properties for Card ${expectedCardId} did not match the documented allowTableDrill and drillOrder response.`), { statusCode: 502 });
  }
  const allowTableDrill = drillProperties.allowTableDrill;
  if (allowTableDrill !== null && typeof allowTableDrill !== 'boolean') {
    throw Object.assign(new Error(`Domo drill properties for Card ${expectedCardId} returned an invalid allowTableDrill value.`), { statusCode: 502 });
  }
  const rawDrillOrder = drillProperties.drillOrder;
  if (rawDrillOrder !== null && !Array.isArray(rawDrillOrder)) {
    throw Object.assign(new Error(`Domo drill properties for Card ${expectedCardId} returned an invalid drillOrder collection.`), { statusCode: 502 });
  }
  const drillOrder = rawDrillOrder === null
    ? null
    : rawDrillOrder.map((value, index) => {
      if (typeof value !== 'string' || !value.trim()) {
        throw Object.assign(new Error(`Domo drill properties for Card ${expectedCardId} returned an invalid drillOrder value at index ${index}.`), { statusCode: 502 });
      }
      return value.trim();
    });
  if (drillOrder && new Set(drillOrder).size !== drillOrder.length) {
    throw Object.assign(new Error(`Domo drill properties for Card ${expectedCardId} returned duplicate drillOrder identifiers.`), { statusCode: 502 });
  }
  if (drillOrder && drillOrder.length > MAX_DOMO_EVIDENCE_CARDS) {
    throw Object.assign(new Error(`Domo drill properties for Card ${expectedCardId} exceeded the ${MAX_DOMO_EVIDENCE_CARDS}-Card evidence bound.`), { statusCode: 413 });
  }
  const sourceEndpoint = `/v1/cards/chart/${expectedCardId}/drillpath`;
  const normalizedDrillOrder = drillOrder || [];
  const hasDrillBehavior = allowTableDrill === true || normalizedDrillOrder.length > 0;
  return {
    normalized: {
      cardId: expectedCardId,
      allowTableDrill,
      drillOrder,
      sourceEndpoint,
      definitionComplete: true,
    },
    cardProjection: hasDrillBehavior
      ? {
        drillProperties: { allowTableDrill, drillOrder },
        drillPath: normalizedDrillOrder.map((cardId, order) => ({ id: cardId, cardId, order })),
        drillDefinitionComplete: true,
        drillEvidenceSource: sourceEndpoint,
      }
      : {
        apiDefinitionEvidence: [{ type: 'domo_card_drill_properties', endpoint: sourceEndpoint, definitionComplete: true, observedBehavior: 'none' }],
      },
  };
}

function domoDrillRequestAllowsManualFallback(error: unknown): boolean {
  const statusCode = typeof (error as { statusCode?: unknown })?.statusCode === 'number'
    ? (error as { statusCode: number }).statusCode
    : 502;
  const message = error instanceof Error ? error.message : '';
  return statusCode === 401
    || statusCode === 403
    || statusCode === 404
    || statusCode === 409
    || /\bHTTP (?:401|403|404)\b/.test(message)
    || /unrecognized non-JSON success response/i.test(message);
}

function domoProductDatasetMetadataEvidence(payload: unknown, expectedDatasetId: string): Record<string, unknown> {
  const metadata = asRecord(payload);
  const datasetId = firstIdentifier(metadata.id);
  if (!datasetId || !identifiersMatch(expectedDatasetId, datasetId) || !firstString(metadata.name)) {
    throw Object.assign(new Error(`Domo DataSet metadata did not match requested DataSet ${expectedDatasetId} or omitted its documented name.`), { statusCode: 502 });
  }
  return metadata;
}

function domoProductDatasetSchemaEvidence(payload: unknown, expectedDatasetId: string): Record<string, unknown> {
  const root = asRecord(payload);
  const schema = asRecord(root.schema);
  if (!Array.isArray(schema.columns)) {
    throw Object.assign(new Error(`Domo DataSet schema for ${expectedDatasetId} omitted the documented schema.columns collection.`), { statusCode: 502 });
  }
  schema.columns.forEach((value, index) => {
    const column = asRecord(value);
    if (!firstString(column.name) || !firstString(column.type)) {
      throw Object.assign(new Error(`Domo DataSet schema for ${expectedDatasetId} returned an invalid column at index ${index}.`), { statusCode: 502 });
    }
  });
  return root;
}

function domoProductDatasetCardRows(payload: unknown, expectedDatasetId: string): Record<string, unknown>[] {
  if (!Array.isArray(payload)) {
    throw Object.assign(new Error(`Domo DataSet Card membership for ${expectedDatasetId} omitted the documented Card array.`), { statusCode: 502 });
  }
  return payload.map((value, index) => {
    const card = asRecord(value);
    const cardId = firstIdentifier(card.id, card.urn);
    const datasetIds = domoDatasetIds(card);
    if (!cardId || datasetIds.length === 0 || !datasetIds.some((id) => identifiersMatch(expectedDatasetId, id))) {
      throw Object.assign(new Error(`Domo DataSet Card membership for ${expectedDatasetId} returned an invalid or mismatched Card at index ${index}.`), { statusCode: 502 });
    }
    return card;
  });
}

function domoGuidePageCardRows(payload: unknown, expectedPageId: string): Record<string, unknown>[] {
  if (!Array.isArray(payload)) {
    throw Object.assign(new Error(`Domo guide-grade Page Card membership for ${expectedPageId} omitted the documented Card array.`), { statusCode: 502 });
  }
  return payload.map((value, index) => {
    const card = asRecord(value);
    if (!firstIdentifier(card.id, card.urn, card.cardId, card.cardUrn)) {
      throw Object.assign(new Error(`Domo guide-grade Page Card membership for ${expectedPageId} returned an invalid Card at index ${index}.`), { statusCode: 502 });
    }
    return card;
  });
}

function domoDatasetAccessEvidence(payload: unknown, expectedDatasetId: string): unknown {
  const root = asRecord(payload);
  const referencedDatasetIds = domoDatasetIds(payload);
  if (referencedDatasetIds.length > 0 && !referencedDatasetIds.some((id) => identifiersMatch(expectedDatasetId, id))) {
    throw Object.assign(new Error(`Domo DataSet access evidence did not match requested DataSet ${expectedDatasetId}. Verify the saved source and retry.`), { statusCode: 502 });
  }
  const validateAccessElements = (rows: unknown[], key: string) => {
    rows.forEach((value, index) => {
      const principal = asRecord(value);
      const principalId = firstIdentifier(principal.id, principal.principalId, principal.userId, principal.groupId, principal.memberId);
      const officialListElement = key !== 'list' || (
        firstString(principal.type)
        && firstString(principal.accessLevel)
        && (!Object.hasOwn(principal, 'name') || typeof principal.name === 'string')
      );
      if (Object.keys(principal).length === 0 || !principalId || !officialListElement) {
        throw Object.assign(new Error(`Domo DataSet access evidence for ${expectedDatasetId} returned an invalid ${key} element at index ${index}.`), { statusCode: 502 });
      }
    });
  };
  if (Object.hasOwn(root, 'list')) {
    if (!Array.isArray(root.list)
      || !Number.isSafeInteger(root.totalUserCount) || Number(root.totalUserCount) < 0
      || !Number.isSafeInteger(root.totalGroupCount) || Number(root.totalGroupCount) < 0) {
      throw Object.assign(new Error(`Domo DataSet access evidence for ${expectedDatasetId} returned an invalid documented access-list envelope.`), { statusCode: 502 });
    }
    validateAccessElements(root.list, 'list');
    const documentedCount = Number(root.totalUserCount) + Number(root.totalGroupCount);
    if (documentedCount !== root.list.length) {
      throw Object.assign(new Error(`Domo DataSet access evidence for ${expectedDatasetId} returned counts that do not match the documented access list.`), { statusCode: 502 });
    }
    return payload;
  }
  if (Array.isArray(payload)) {
    validateAccessElements(payload, 'principals');
    return { principals: payload };
  }
  const containers = [root, asRecord(root.data), asRecord(root.result)];
  const keys = ['principals', 'permissions', 'users', 'groups', 'access', 'entries'];
  for (const container of containers) {
    for (const key of keys) {
      if (!Object.hasOwn(container, key)) continue;
      if (!Array.isArray(container[key])) {
        throw Object.assign(new Error(`Domo DataSet access evidence for ${expectedDatasetId} returned an invalid ${key} collection.`), { statusCode: 502 });
      }
      validateAccessElements(container[key] as unknown[], key);
      return payload;
    }
  }
  if (Object.hasOwn(root, 'data')) {
    if (!Array.isArray(root.data)) {
      throw Object.assign(new Error(`Domo DataSet access evidence for ${expectedDatasetId} returned an unrecognized success response.`), { statusCode: 502 });
    }
    validateAccessElements(root.data, 'data');
    return payload;
  }
  throw Object.assign(new Error(`Domo DataSet access evidence for ${expectedDatasetId} returned an unrecognized success response.`), { statusCode: 502 });
}

function domoBeastModeDetailEvidence(input: {
  payload: unknown;
  expectedBeastModeId: string;
  selectedCardAliases: Set<string>;
  selectedDatasetAliases: Set<string>;
}): Record<string, unknown> {
  const detail = asRecord(input.payload);
  if (!/^\d+$/.test(input.expectedBeastModeId)
    || !Number.isSafeInteger(detail.id)
    || !identifiersMatch(input.expectedBeastModeId, detail.id)
    || !Array.isArray(detail.links)) {
    throw Object.assign(new Error(`Domo Beast Mode definition did not match the documented response contract for requested Beast Mode ${input.expectedBeastModeId}.`), { statusCode: 502 });
  }
  if (!Object.hasOwn(detail, 'expression')) {
    throw Object.assign(new Error(`Domo Beast Mode ${input.expectedBeastModeId} returned an unrecognized success response without a formula definition.`), { statusCode: 502 });
  }
  if (!firstString(detail.name)) {
    throw Object.assign(new Error(`Domo Beast Mode ${input.expectedBeastModeId} did not include a name.`), { statusCode: 502 });
  }
  if (!firstString(detail.expression)) {
    throw Object.assign(new Error(`Domo Beast Mode ${input.expectedBeastModeId} did not include a non-empty formula.`), { statusCode: 502 });
  }
  const linkedCards = uniqueStrings([
    ...domoCardIds(detail),
    ...domoLinkedResourceIds(detail, 'CARD'),
  ]).flatMap(identifierAliases);
  const linkedDatasets = uniqueStrings([
    ...domoDatasetIds(detail),
    ...domoLinkedResourceIds(detail, 'DATA_SOURCE'),
  ]).flatMap(identifierAliases);
  const linkedCard = linkedCards.find((id) => input.selectedCardAliases.has(id));
  const linkedDataset = linkedDatasets.find((id) => input.selectedDatasetAliases.has(id));
  if (!linkedCard && !linkedDataset) {
    throw Object.assign(new Error(`Domo Beast Mode ${input.expectedBeastModeId} did not prove a selected Card or DataSet scope linkage.`), { statusCode: 502 });
  }
  return mergeDomoRecords(detail, linkedDataset ? { dataSourceId: linkedDataset } : {});
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
    id: `domo-api-${createHash('sha256').update(`${name}\0${content}`).digest('hex').slice(0, 16)}`,
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
    const explicitId = firstIdentifier(...(input.idKeys || ['id']).map((key) => row[key]));
    const id = explicitId || `${input.kind}-${(input.indexOffset || 0) + index + 1}`;
    const name = firstString(...(input.nameKeys || ['name', 'title']).map((key) => row[key])) || id;
    const dependencyKeys = input.dependencyKeys || ['dependencies', 'upstream', 'downstream'];
    const dependencies = Array.from(new Set(dependencyKeys.flatMap((key) => {
      const value = row[key];
      const values = Array.isArray(value) ? value : value == null ? [] : [value];
      return values.map((item) => {
        const record = asRecord(item);
        return firstIdentifier(record.id, record.urn, record.cardId, record.cardUrn, record.datasetId, record.dataSourceId, item);
      }).filter(Boolean);
    })));
    return {
      id,
      name,
      kind: input.kind,
      parentId: input.parentId || firstIdentifier(...(input.parentIdKeys || []).map((key) => row[key])) || undefined,
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
  return sourceDashboardDependencyClosureDetail(rootId, items).resolvedIds;
}

export function sourceDashboardDependencyClosureDetail(rootId: string, items: SourceInventoryItem[]): {
  resolvedIds: string[];
  missingIds: string[];
} {
  const byId = new Map(items.map((item) => [item.id, item]));
  const children = new Map<string, string[]>();
  items.forEach((item) => {
    if (!item.parentId) return;
    children.set(item.parentId, [...(children.get(item.parentId) || []), item.id]);
  });
  const closure = new Set<string>();
  const missing = new Set<string>();
  const queue = [rootId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (closure.has(id)) continue;
    closure.add(id);
    const item = byId.get(id);
    if (!item) {
      missing.add(id);
      continue;
    }
    item.dependencyIds.forEach((dependencyId) => {
      if (!closure.has(dependencyId)) queue.push(dependencyId);
    });
    REFERENCE_METADATA_KEYS.forEach((key) => {
      const reference = item.metadata[key];
      if (typeof reference === 'string' && !closure.has(reference)) queue.push(reference);
    });
    (children.get(id) || []).forEach((childId) => {
      if (!closure.has(childId)) queue.push(childId);
    });
  }
  closure.delete(rootId);
  missing.delete(rootId);
  return {
    resolvedIds: Array.from(closure).filter((id) => byId.has(id)).sort(),
    missingIds: Array.from(missing).sort(),
  };
}

function sourceCoverage(connector: SourceConnectorDefinition): SourceDashboardCatalogItem['coverage'] {
  if (connector.capabilities.semanticDefinitions === 'export_required' || connector.capabilities.contentDefinitions === 'export_required') return 'export_required';
  return connector.capabilities.semanticDefinitions === 'full' && connector.capabilities.contentDefinitions === 'full' ? 'complete' : 'partial';
}

export function buildSourceDashboardCatalog(platform: MigrationPlatformKind, items: SourceInventoryItem[], connector: SourceConnectorDefinition): SourceDashboardCatalogItem[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  return items.filter((item) => dashboardUnit(platform, item)).map((item) => {
    const closure = sourceDashboardDependencyClosureDetail(item.id, items);
    const dependencyIds = [...closure.resolvedIds, ...closure.missingIds].sort();
    const dependencies: SourceDependencyReference[] = dependencyIds.map((assetId) => {
      const dependency = byId.get(assetId);
      return dependency ? {
        assetId,
        name: dependency.name,
        kind: dependency.kind,
        category: dependencyCategory(dependency.kind),
        required: true,
        reason: dependency.parentId === item.id ? 'Contained by the selected dashboard asset.' : 'Referenced by the selected dashboard dependency graph.',
        status: 'resolved',
      } : {
        assetId,
        name: assetId,
        kind: 'repository_item',
        category: 'unknown',
        required: true,
        reason: 'Referenced by the selected dashboard but absent from the collected API inventory.',
        status: 'missing',
      };
    });
    const dependencyCounts = dependencies.reduce<Partial<Record<SourceDependencyCategory, number>>>((counts, dependency) => ({ ...counts, [dependency.category]: (counts[dependency.category] || 0) + 1 }), {});
    const complexityScore = dependencies.length + item.riskFlags.length * 5 + item.featureFlags.length * 2;
    const baseCoverage = sourceCoverage(connector);
    const coverage = closure.missingIds.length > 0 && baseCoverage === 'complete' ? 'partial' : baseCoverage;
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
      coverageNotes: coverage === 'complete' ? [] : [
        ...connector.limitations,
        ...(closure.missingIds.length > 0 ? [`${closure.missingIds.length} required dependency reference${closure.missingIds.length === 1 ? '' : 's'} were absent from the collected API inventory.`] : []),
      ],
      riskFlags: [...item.riskFlags, ...closure.missingIds.map((id) => `missing_dependency:${id}`)],
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
  failures: string[];
  integrityIssues: string[];
}

function tracker(scope: InventoryTracker['scope'] = 'all_accessible', scopeLabel = 'All accessible content'): InventoryTracker {
  return {
    scope,
    scopeLabel,
    pagesFetched: 0,
    parentsExpanded: 0,
    requestsMade: 0,
    truncated: false,
    failures: [],
    integrityIssues: [],
  };
}

function safeInventoryFailure(platform: MigrationPlatformKind, kind: SourceAssetKind, error: unknown): string {
  const raw = redactSensitiveText(error instanceof Error ? error.message : '').slice(0, 500);
  const upstreamStatus = raw.match(/\b(?:returned|response)\s+(\d{3})\b/i)?.[1];
  const status = upstreamStatus ? ` (upstream ${upstreamStatus})` : '';
  const label = sourceConnectorDefinition(platform)?.label || platform;
  return `${label} ${kind.replaceAll('_', ' ')} inventory could not be verified${status}. Check the saved credential and source permissions, then retry.`;
}

function numericValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

function effectivePort(url: URL): string {
  if (url.port) return url.port;
  if (url.protocol === 'https:') return '443';
  if (url.protocol === 'http:') return '80';
  return '';
}

function safeContinuationUrl(originUrl: string, currentUrl: string, continuation: string): string {
  const origin = new URL(originUrl);
  const current = new URL(currentUrl);
  const next = new URL(continuation, current);
  const preservesOrigin = (candidate: URL) => origin.protocol === candidate.protocol
    && origin.hostname.toLowerCase() === candidate.hostname.toLowerCase()
    && effectivePort(origin) === effectivePort(candidate);
  if (
    !preservesOrigin(current)
    || !preservesOrigin(next)
    || origin.username
    || origin.password
    || current.username
    || current.password
    || next.username
    || next.password
  ) {
    throw Object.assign(new Error('Source inventory returned an unsafe cross-origin pagination URL. OmniKit stopped before forwarding source credentials.'), { statusCode: 502 });
  }
  next.hash = '';
  return next.toString();
}

export function migrationInventoryNextPageUrl(input: {
  originUrl?: string;
  currentUrl: string;
  payload: unknown;
  style: InventoryPaginationStyle;
  rowsOnPage: number;
  pageSize: number;
}): string | null {
  const root = asRecord(input.payload);
  const data = asRecord(root.data);
  const links = asRecord(root.links);
  const originUrl = input.originUrl || input.currentUrl;
  const explicitNext = firstString(root['@odata.nextLink'], root.next, links.next, data['@odata.nextLink'], data.next);
  if ((input.style === 'odata' || input.style === 'sigma') && explicitNext) {
    return safeContinuationUrl(originUrl, input.currentUrl, explicitNext);
  }
  const nextUrl = new URL(input.currentUrl);
  if (input.style === 'sigma') {
    const nextPageToken = firstString(root.nextPageToken, data.nextPageToken);
    const nextPage = firstString(root.nextPage, data.nextPage, nextPageToken);
    if (!nextPage) return null;
    nextUrl.searchParams.set(nextPageToken ? 'pageToken' : 'page', nextPage);
    return safeContinuationUrl(originUrl, input.currentUrl, nextUrl.toString());
  }
  if (input.style === 'offset') {
    if (input.rowsOnPage < input.pageSize) return null;
    const currentOffset = numericValue(nextUrl.searchParams.get('offset'), nextUrl.searchParams.get('$skip')) || 0;
    const parameter = nextUrl.searchParams.has('$skip') ? '$skip' : 'offset';
    nextUrl.searchParams.set(parameter, String(currentOffset + input.pageSize));
    return safeContinuationUrl(originUrl, input.currentUrl, nextUrl.toString());
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
    return safeContinuationUrl(originUrl, input.currentUrl, nextUrl.toString());
  }
  return null;
}

function flattenNestedInventoryRows(input: {
  rows: unknown[];
  childKey: string;
  idKeys: string[];
  limit?: number;
}): { rows: unknown[]; truncated: boolean } {
  const flattened: unknown[] = [];
  const limit = input.limit || MAX_INVENTORY_ITEMS;
  let truncated = false;

  const visit = (value: unknown, parentId: string | undefined, depth: number): void => {
    if (flattened.length >= limit || depth > 24) {
      truncated = true;
      return;
    }
    const record = asRecord(value);
    if (Object.keys(record).length === 0) return;
    const id = firstIdentifier(...input.idKeys.map((key) => record[key]));
    flattened.push(parentId && !firstIdentifier(record.parentId) ? { ...record, parentId } : record);
    const children = Array.isArray(record[input.childKey]) ? record[input.childKey] as unknown[] : [];
    children.forEach((child) => visit(child, id || parentId, depth + 1));
  };

  input.rows.forEach((row) => visit(row, undefined, 0));
  return { rows: flattened, truncated };
}

function domoPlatformInventoryRows(
  payload: unknown,
  kind: 'DataSet' | 'Card' | 'Page',
  keys: string[],
): unknown[] {
  if (Array.isArray(payload)) return payload;
  const root = asRecord(payload);
  const containers = [root, asRecord(root.data), asRecord(root.result), asRecord(root.results)];
  for (const container of containers) {
    for (const key of keys) {
      if (!Object.hasOwn(container, key)) continue;
      const value = container[key];
      if (Array.isArray(value)) return value;
      if (key === 'data' && value && typeof value === 'object' && !Array.isArray(value)) continue;
      throw Object.assign(new Error(`Domo ${kind} inventory returned an invalid ${key} collection. Verify the saved credential and Domo Platform API compatibility, then retry.`), { statusCode: 502 });
    }
  }
  throw Object.assign(new Error(`Domo ${kind} inventory returned an unrecognized success response. Verify the saved credential and Domo Platform API compatibility, then retry.`), { statusCode: 502 });
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
  nestedChildrenKey?: string;
  rowsDecoder?: (payload: unknown) => unknown[];
  signal?: AbortSignal;
  transport?: MigrationSourceTransport;
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
      const payload = connection.platform === 'domo'
        ? await fetchDomoPlatformJson(connection, nextUrl, input.signal, input.transport)
        : await fetchConnectorJson(connection, nextUrl, input.signal, input.transport);
      input.tracker.pagesFetched += 1;
      const responseRows = input.rowsDecoder ? input.rowsDecoder(payload) : firstArray(payload, input.keys);
      const expanded = input.nestedChildrenKey
        ? flattenNestedInventoryRows({
          rows: responseRows,
          childKey: input.nestedChildrenKey,
          idKeys: input.idKeys || ['id'],
        })
        : { rows: responseRows, truncated: false };
      if (expanded.truncated) input.tracker.truncated = true;
      const pageSignature = `${responseRows.length}:${responseRows.slice(0, 20).map((row) => {
        const record = asRecord(row);
        return firstIdentifier(...(input.idKeys || ['id']).map((key) => record[key]), record.name, record.title);
      }).join('|')}`;
      if (page > 0 && responseRows.length > 0 && seenPageSignatures.has(pageSignature)) {
        input.tracker.truncated = true;
        input.warnings.push(`${input.kind} inventory returned a repeated page. OmniKit stopped instead of presenting duplicate or misleading scope.`);
        break;
      }
      seenPageSignatures.add(pageSignature);
      items.push(...normalizeRows({
        rows: expanded.rows,
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
      const candidate = migrationInventoryNextPageUrl({ originUrl: input.url, currentUrl: nextUrl, payload, style: input.pagination || 'none', rowsOnPage: responseRows.length, pageSize });
      if (candidate && (page >= MAX_INVENTORY_PAGES || items.length >= MAX_INVENTORY_ITEMS)) input.tracker.truncated = true;
      nextUrl = candidate;
    } catch (error) {
      assertDomoRequestActive(input.signal);
      const failure = safeInventoryFailure(connection.platform, input.kind, error);
      if (!input.tracker.failures.includes(failure)) input.tracker.failures.push(failure);
      if (!input.warnings.includes(failure)) input.warnings.push(failure);
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
  const reconciled = Array.from(new Map(items.map((item) => [`${item.kind}:${item.id}`, item])).values());
  const secrets = [connection.credential, connection.productApiToken]
    .filter((value): value is string => Boolean(value && value.length >= 4))
    .sort((left, right) => right.length - left.length);
  const redactValue = (value: string): string => secrets.reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), value);
  const unique = reconciled.slice(0, MAX_INVENTORY_ITEMS).map((item) => ({
    ...item,
    id: redactValue(item.id),
    name: redactValue(item.name),
    parentId: item.parentId ? redactValue(item.parentId) : undefined,
    path: item.path ? redactValue(item.path) : undefined,
    owner: item.owner ? redactValue(item.owner) : undefined,
    dependencyIds: item.dependencyIds.map(redactValue),
    metadata: Object.fromEntries(Object.entries(item.metadata).map(([key, value]) => [key, typeof value === 'string' ? redactValue(value) : value])),
  }));
  const duplicateCount = Math.max(0, items.length - reconciled.length);
  if (duplicateCount > 0) {
    const issue = `${duplicateCount} duplicate source item${duplicateCount === 1 ? '' : 's'} could not be reconciled to a unique inventory identity.`;
    if (!collection.integrityIssues.includes(issue)) collection.integrityIssues.push(issue);
    if (!warnings.includes(issue)) warnings.push(issue);
  }
  const truncated = collection.truncated || reconciled.length > MAX_INVENTORY_ITEMS;
  const boundedWarning = `Only the first ${MAX_INVENTORY_ITEMS} unique source items are shown. Save a narrower workspace, project, site, or repository scope to continue safely.`;
  if (truncated && !warnings.includes(boundedWarning)) warnings.push(boundedWarning);
  const errors = Array.from(new Set([...collection.failures, ...collection.integrityIssues]));
  const status: SourceInventoryResult['collection']['status'] = errors.length > 0
    ? unique.length === 0 && collection.failures.length > 0
      ? 'failed'
      : 'partial'
    : truncated
      ? 'bounded'
      : 'complete';
  return {
    platform: connection.platform,
    connectionId: connection.id,
    connectionUpdatedAt: connection.updatedAt,
    connector,
    items: unique,
    dashboardCatalog: buildSourceDashboardCatalog(connection.platform, unique, connector),
    warnings: [...connector.limitations, ...warnings],
    truncated,
    collection: {
      scope: collection.scope,
      scopeLabel: collection.scopeLabel,
      complete: status === 'complete',
      status,
      errors,
      pagesFetched: collection.pagesFetched,
      parentsExpanded: collection.parentsExpanded,
      requestsMade: collection.requestsMade,
      maxPages: MAX_INVENTORY_PAGES,
      maxItems: MAX_INVENTORY_ITEMS,
    },
  };
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
      const requestHeaders: Record<string, string> = { Accept: 'application/json', Authorization: `token ${connection.credential}` };
      new Headers(init.headers).forEach((value, key) => { requestHeaders[key] = value; });
      const response = await createMigrationSourceTransport().request({
        url,
        method: init.method === 'POST' ? 'POST' : 'GET',
        headers: requestHeaders,
        body: typeof init.body === 'string' ? init.body : undefined,
        responseType: 'json',
        label: 'Looker validation query',
        maxResponseBytes: 5 * 1024 * 1024,
        deadlineMs: REQUEST_TIMEOUT_MS,
      });
      return response.body;
    } catch (error) {
      lastError = error;
      const statusCode = (error as { statusCode?: number })?.statusCode;
      if (attempt === 2 || statusCode === 400 || statusCode === 409 || (statusCode && !retryStatuses.has(statusCode))) throw error;
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



async function domoInventoryFromAuthenticatedConnection(
  connection: SavedPlatformConnection,
  platformConnection: SavedPlatformConnection,
  signal?: AbortSignal,
  transport: MigrationSourceTransport = createMigrationSourceTransport(),
): Promise<SourceInventoryResult> {
  const base = DOMO_PLATFORM_API_BASE;
  const warnings: string[] = [];
  const collection = tracker();
  const [datasets, cards, pages] = await Promise.all([
    collect(platformConnection, {
      url: `${base}/v1/datasets?limit=50&offset=0`, keys: ['data', 'datasets'], kind: 'dataset', warnings, tracker: collection,
      idKeys: ['id', 'dataSourceId', 'datasetId'], nameKeys: ['name', 'displayName'], pagination: 'offset', pageSize: 50,
      metadataKeys: ['description', 'type', 'createdAt', 'updatedAt', 'rows', 'columns', 'ownerId'],
      rowsDecoder: (payload) => domoPlatformInventoryRows(payload, 'DataSet', ['data', 'datasets']),
      signal, transport,
    }),
    collect(platformConnection, {
      url: `${base}/v1/cards?limit=100&offset=0`, keys: ['data', 'cards'], kind: 'card', warnings, tracker: collection,
      idKeys: ['cardUrn', 'urn', 'id'], nameKeys: ['cardTitle', 'title', 'name'], dependencyKeys: ['datasourceId', 'dataSourceId', 'datasetId'],
      pagination: 'offset', pageSize: 100,
      metadataKeys: ['cardUrn', 'type', 'chartType', 'datasourceId', 'dataSourceId', 'datasetId', 'ownerId', 'lastModified'],
      rowsDecoder: (payload) => domoPlatformInventoryRows(payload, 'Card', ['data', 'cards']),
      signal, transport,
    }),
    collect(platformConnection, {
      url: `${base}/v1/pages?limit=100&offset=0`, keys: ['data', 'pages'], kind: 'page', warnings, tracker: collection,
      idKeys: ['id', 'pageId'], nameKeys: ['name', 'title'], parentIdKeys: ['parentId'], dependencyKeys: ['cardIds', 'card_ids'],
      pagination: 'offset', pageSize: 100,
      nestedChildrenKey: 'children',
      metadataKeys: ['parentId', 'visibility', 'locked', 'createdAt', 'updatedAt'],
      rowsDecoder: (payload) => domoPlatformInventoryRows(payload, 'Page', ['data', 'pages']),
      signal, transport,
    }),
  ]);
  const unstable = [...datasets, ...cards, ...pages].filter((item) => item.metadata.syntheticId === true);
  if (unstable.length > 0) {
    const issue = `${unstable.length} Domo content item${unstable.length === 1 ? '' : 's'} did not include a stable source ID and cannot be selected safely.`;
    collection.integrityIssues.push(issue);
    warnings.push(issue);
  }
  return result(connection, [...datasets, ...cards, ...pages], warnings, collection);
}

async function domoProductInventory(
  connection: SavedPlatformConnection,
  signal?: AbortSignal,
  transport: MigrationSourceTransport = createMigrationSourceTransport(),
): Promise<SourceInventoryResult> {
  const warnings: string[] = [];
  const collection = tracker('all_accessible', 'All accessible Product API content');
  const state: DomoEvidenceState = {
    requests: 0,
    warnings: [],
    blockers: [],
    missingDependencies: [],
    truncated: false,
    requestBudgetExhausted: false,
    signal,
  };
  const load = async (
    entity: 'card' | 'dataset' | 'page',
    kind: Extract<SourceAssetKind, 'card' | 'dataset' | 'page'>,
  ): Promise<unknown[]> => {
    const requestCountBefore = state.requests;
    const blockerCountBefore = state.blockers.length;
    try {
      const rows = await domoProductSearch(connection, entity, state, MAX_INVENTORY_ITEMS, '*', signal, transport);
      collection.pagesFetched += state.requests - requestCountBefore;
      collection.requestsMade = state.requests;
      if (state.truncated) collection.truncated = true;
      state.blockers.slice(blockerCountBefore).forEach((warning) => {
        if (!warnings.includes(warning)) warnings.push(warning);
      });
      return rows;
    } catch (error) {
      assertDomoRequestActive(signal);
      collection.requestsMade = state.requests;
      const failure = safeInventoryFailure('domo', kind, error);
      if (!collection.failures.includes(failure)) collection.failures.push(failure);
      if (!warnings.includes(failure)) warnings.push(failure);
      return [];
    }
  };

  // Keep these sequential so collection page/request evidence remains exact even
  // when one Product Search collection fails and the other visible rows survive.
  const datasetRows = await load('dataset', 'dataset');
  const cardRows = await load('card', 'card');
  const pageRows = await load('page', 'page');
  const datasets = normalizeRows({
    rows: datasetRows,
    kind: 'dataset',
    idKeys: ['id', 'dataSourceId', 'datasourceId', 'datasetId'],
    nameKeys: ['name', 'displayName', 'title'],
    metadataKeys: ['description', 'type', 'createdAt', 'updatedAt', 'rows', 'columns', 'ownerId'],
  });
  const cards = normalizeRows({
    rows: cardRows,
    kind: 'card',
    idKeys: ['cardUrn', 'urn', 'id', 'cardId'],
    nameKeys: ['cardTitle', 'title', 'name'],
    dependencyKeys: ['datasourceId', 'dataSourceId', 'datasetId'],
    metadataKeys: ['cardUrn', 'type', 'chartType', 'datasourceId', 'dataSourceId', 'datasetId', 'ownerId', 'lastModified'],
  });
  const pages = normalizeRows({
    rows: pageRows,
    kind: 'page',
    idKeys: ['id', 'pageId'],
    nameKeys: ['name', 'title'],
    parentIdKeys: ['parentId'],
    dependencyKeys: ['cardIds', 'card_ids'],
    metadataKeys: ['parentId', 'visibility', 'locked', 'createdAt', 'updatedAt'],
  }).map((page, index) => ({
    ...page,
    dependencyIds: Array.from(new Set([...page.dependencyIds, ...domoCardIds(pageRows[index])])),
  }));
  const unstable = [...datasets, ...cards, ...pages].filter((item) => item.metadata.syntheticId === true);
  if (unstable.length > 0) {
    const issue = `${unstable.length} Domo Product API content item${unstable.length === 1 ? '' : 's'} did not include a stable source ID and cannot be selected safely.`;
    collection.integrityIssues.push(issue);
    warnings.push(issue);
  }
  return result(connection, [...datasets, ...cards, ...pages], warnings, collection);
}

async function domoInventory(
  connection: SavedPlatformConnection,
  signal?: AbortSignal,
  transport: MigrationSourceTransport = createMigrationSourceTransport(),
): Promise<SourceInventoryResult> {
  if (connection.productApiToken) return domoProductInventory(connection, signal, transport);
  const platformConnection = await domoAuthenticatedConnection(connection, signal, transport);
  return domoInventoryFromAuthenticatedConnection(connection, platformConnection, signal, transport);
}

interface DomoEvidenceState {
  requests: number;
  warnings: string[];
  blockers: string[];
  missingDependencies: DomoApiMissingDependency[];
  truncated: boolean;
  requestBudgetExhausted: boolean;
  signal?: AbortSignal;
}

const DOMO_EVIDENCE_REQUEST_BUDGET_BLOCKER = `Domo API evidence reached the ${MAX_INVENTORY_REQUESTS}-request safety limit. Narrow the selected Page or Card scope, or use focused Manual Files, then prepare evidence again.`;

function consumeDomoEvidenceRequests(state: DomoEvidenceState, count = 1): boolean {
  assertDomoRequestActive(state.signal);
  if (state.requestBudgetExhausted) return false;
  if (count < 1) return true;
  if (!Number.isSafeInteger(count) || state.requests > MAX_INVENTORY_REQUESTS - count) {
    state.requestBudgetExhausted = true;
    state.truncated = true;
    if (!state.blockers.includes(DOMO_EVIDENCE_REQUEST_BUDGET_BLOCKER)) {
      state.blockers.push(DOMO_EVIDENCE_REQUEST_BUDGET_BLOCKER);
    }
    return false;
  }
  state.requests += count;
  return true;
}

function domoEvidenceFailureReason(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : 'request failed').slice(0, 500);
}

function recordDomoMissingDependency(
  state: DomoEvidenceState,
  input: {
    kind: DomoApiMissingDependencyKind;
    label: string;
    sourceId?: string;
    sourceName?: string;
    error: unknown;
  },
): void {
  assertDomoRequestActive(state.signal);
  const dependency: DomoApiMissingDependency = {
    kind: input.kind,
    sourceId: input.sourceId || undefined,
    sourceName: input.sourceName ? redactSensitiveText(input.sourceName).slice(0, 200) : undefined,
    reason: domoEvidenceFailureReason(input.error),
  };
  const key = `${dependency.kind}:${dependency.sourceId || ''}:${dependency.sourceName || ''}:${dependency.reason}`;
  if (!state.missingDependencies.some((item) => `${item.kind}:${item.sourceId || ''}:${item.sourceName || ''}:${item.reason}` === key)) {
    state.missingDependencies.push(dependency);
  }
  state.blockers.push(`${input.label}${dependency.sourceId ? ` ${dependency.sourceId}` : ''} is missing from the collected Domo dependency closure: ${dependency.reason}`);
}

async function domoProductSearch(
  connection: SavedPlatformConnection,
  entity: 'alert' | 'app' | 'beast_mode' | 'card' | 'connector' | 'data_app' | 'dataflow' | 'dataset' | 'page',
  state: DomoEvidenceState,
  maximum: number,
  query = '*',
  signal?: AbortSignal,
  transport: MigrationSourceTransport = createMigrationSourceTransport(),
): Promise<unknown[]> {
  const rows: unknown[] = [];
  const pageSize = Math.min(500, maximum);
  let offset = 0;
  let moreAvailable = false;
  let pagesFetched = 0;
  let oversizedPage = false;
  while (rows.length < maximum && pagesFetched < MAX_INVENTORY_PAGES) {
    if (!consumeDomoEvidenceRequests(state)) break;
    pagesFetched += 1;
    const requestedCount = Math.min(pageSize, maximum - rows.length);
    const payload = await fetchDomoProductJson(connection, '/api/search/v1/query', {
      method: 'POST',
      body: JSON.stringify({
        count: requestedCount,
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
    }, signal, transport);
    const searchPage = domoSearchRows(payload);
    const page = searchPage.rows;
    rows.push(...page);
    if (page.length > requestedCount || rows.length > maximum) {
      oversizedPage = true;
      state.truncated = true;
      state.blockers.push(`Domo ${entity.replace('_', ' ')} Product Search returned ${page.length.toLocaleString()} rows for a ${requestedCount.toLocaleString()}-row request and cannot be treated as complete. Narrow the selected dashboard scope or use focused Manual Files.`);
      break;
    }
    if (searchPage.total != null && searchPage.total < rows.length) {
      throw Object.assign(new Error(`Domo ${entity.replace('_', ' ')} Product Search returned inconsistent pagination metadata. Verify the saved credential and tenant API compatibility, then retry.`), { statusCode: 502 });
    }
    if (searchPage.hasMore === false && searchPage.total != null && searchPage.total > rows.length) {
      throw Object.assign(new Error(`Domo ${entity.replace('_', ' ')} Product Search returned inconsistent pagination metadata. Verify the saved credential and tenant API compatibility, then retry.`), { statusCode: 502 });
    }
    if (searchPage.hasMore === true && searchPage.total != null && searchPage.total <= rows.length) {
      throw Object.assign(new Error(`Domo ${entity.replace('_', ' ')} Product Search returned inconsistent pagination metadata. Verify the saved credential and tenant API compatibility, then retry.`), { statusCode: 502 });
    }
    const paginationKnown = searchPage.hasMore != null || searchPage.total != null;
    if (page.length === requestedCount && !paginationKnown) {
      if (rows.length >= maximum) {
        moreAvailable = true;
        break;
      }
      throw Object.assign(new Error(`Domo ${entity.replace('_', ' ')} Product Search returned a full page without terminal pagination evidence. Retry with a narrower scope or use focused Manual Files.`), { statusCode: 502 });
    }
    const hasMore = searchPage.hasMore === true || (searchPage.total != null && rows.length < searchPage.total);
    moreAvailable = hasMore;
    if (page.length === 0 && hasMore) {
      throw Object.assign(new Error(`Domo ${entity.replace('_', ' ')} Product Search returned an empty page while pagination metadata reported more rows. Verify the saved credential and tenant API compatibility, then retry.`), { statusCode: 502 });
    }
    if (page.length === 0 || !hasMore) break;
    offset += page.length;
  }
  if (!oversizedPage && moreAvailable && (rows.length >= maximum || pagesFetched >= MAX_INVENTORY_PAGES)) {
    state.truncated = true;
    const bound = rows.length >= maximum
      ? `${maximum.toLocaleString()}-item`
      : `${MAX_INVENTORY_PAGES}-request`;
    state.blockers.push(`Domo ${entity.replace('_', ' ')} evidence reached the ${bound} Product Search safety limit while more rows remained. Narrow the selected dashboard scope or use focused Manual Files.`);
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
    const id = firstIdentifier(resource.id, record.resourceId);
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

function domoApiScopeFingerprint(input: {
  connectionId: string;
  connectionUpdatedAt: string;
  selectedDashboardIds: string[];
  resolvedDashboardIds: string[];
  resolvedCardIds: string[];
  resolvedDatasetIds: string[];
  resolvedBeastModeIds: string[];
  parser: { name: string; version: string };
  artifactFingerprints: Array<{ name: string; sha256?: string; sizeBytes: number }>;
  limitationCodes: string[];
  permissionGaps: string[];
}): string {
  const sorted = (values: string[]) => uniqueStrings(values).sort();
  const artifactFingerprints = input.artifactFingerprints
    .map((artifact) => ({ name: artifact.name, sha256: artifact.sha256 || '', sizeBytes: artifact.sizeBytes }))
    .sort((left, right) => {
      const nameOrder = left.name === right.name ? 0 : left.name < right.name ? -1 : 1;
      const hashOrder = left.sha256 === right.sha256 ? 0 : left.sha256 < right.sha256 ? -1 : 1;
      return nameOrder || hashOrder || left.sizeBytes - right.sizeBytes;
    });
  return createHash('sha256').update(JSON.stringify({
    connection: { id: input.connectionId, updatedAt: input.connectionUpdatedAt },
    selectedDashboardIds: sorted(input.selectedDashboardIds),
    resolvedDashboardIds: sorted(input.resolvedDashboardIds),
    resolvedCardIds: sorted(input.resolvedCardIds),
    resolvedDatasetIds: sorted(input.resolvedDatasetIds),
    resolvedBeastModeIds: sorted(input.resolvedBeastModeIds),
    parser: { name: input.parser.name, version: input.parser.version },
    artifactFingerprints,
    limitationCodes: sorted(input.limitationCodes),
    permissionGaps: sorted(input.permissionGaps),
  })).digest('hex');
}

export async function prepareDomoApiEvidence(
  connection: SavedPlatformConnection,
  selectedDashboardIds: string[],
  signal?: AbortSignal,
  transport: MigrationSourceTransport = createMigrationSourceTransport(),
): Promise<DomoApiEvidenceResult> {
  assertDomoRequestActive(signal);
  if (connection.platform !== 'domo') throw Object.assign(new Error('Domo evidence preparation requires a saved Domo source.'), { statusCode: 400 });
  assertSavedSourceAuthentication(connection);
  const selected = uniqueStrings(selectedDashboardIds.map(String));
  if (selected.length === 0) throw Object.assign(new Error('Select at least one Domo Page or Card before preparing migration evidence.'), { statusCode: 400 });
  if (selected.length > MAX_DOMO_SELECTED_DASHBOARDS) {
    throw Object.assign(new Error(`Prepare no more than ${MAX_DOMO_SELECTED_DASHBOARDS} Domo Pages or Cards at a time.`), { statusCode: 413 });
  }

  const productApiAvailable = Boolean(connection.productApiToken);
  const platformOAuthAvailable = Boolean(connection.clientId && connection.credential);
  const productTokenOnly = productApiAvailable && !platformOAuthAvailable;
  if (!productApiAvailable && !platformOAuthAvailable) {
    throw Object.assign(new Error('Domo evidence preparation requires a Product API developer token, Platform OAuth client credentials, or both.'), { statusCode: 409 });
  }
  const platformConnection = platformOAuthAvailable ? await domoAuthenticatedConnection(connection, signal, transport) : null;
  const inventory = productApiAvailable
    ? await domoProductInventory(connection, signal, transport)
    : await domoInventoryFromAuthenticatedConnection(connection, platformConnection!, signal, transport);
  const state: DomoEvidenceState = {
    requests: inventory.collection.requestsMade,
    warnings: [...inventory.warnings],
    blockers: [],
    missingDependencies: [],
    truncated: inventory.truncated,
    requestBudgetExhausted: false,
    signal,
  };
  if (!inventory.collection.complete) {
    state.blockers.push(...(inventory.collection.errors.length > 0
      ? inventory.collection.errors
      : ['Domo source inventory is incomplete. Resolve the collection failure or narrow a genuinely bounded scope before preparing migration evidence.']));
  }
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
    if (!consumeDomoEvidenceRequests(state)) return { item, detail: null };
    try {
      const detail = platformOAuthAvailable
        ? await fetchDomoPlatformJson(platformConnection!, `${DOMO_PLATFORM_API_BASE}/v1/pages/${encodeURIComponent(item.id)}`, signal, transport)
        : await fetchDomoProductJson(connection, `/api/content/v1/pages/${encodeURIComponent(item.id)}/cards?parts=metadata,metadataOverrides`, {}, signal, transport);
      const normalizedDetail = platformOAuthAvailable
        ? detail
        : {
          id: item.id,
          name: item.name,
          objectType: 'page',
          pageMembershipEvidenceSource: '/api/content/v1/pages/{pageId}/cards?parts=metadata,metadataOverrides',
          pageMembershipEvidenceGrade: 'official_guide_preview_only',
          cards: domoGuidePageCardRows(detail, item.id),
        };
      return { item, detail: normalizedDetail };
    } catch (error) {
      recordDomoMissingDependency(state, {
        kind: 'page_detail',
        label: 'Domo Page detail',
        sourceId: item.id,
        sourceName: item.name,
        error,
      });
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
  if (productApiAvailable) {
    try {
      productCardRows = await domoProductSearch(connection, 'card', state, MAX_DOMO_EVIDENCE_CARDS, '*', signal, transport);
    } catch (error) {
      recordDomoMissingDependency(state, { kind: 'card_search', label: 'Domo Card dependency search', error });
    }
  }
  const productCardsByAlias = new Map<string, unknown>();
  productCardRows.forEach((row) => domoObjectIdAliases(row).forEach((id) => productCardsByAlias.set(id, row)));
  pageDetails.flatMap((entry) => firstArray(entry.detail, ['cards', 'items'])).forEach((row) => {
    domoObjectIdAliases(row).forEach((id) => {
      productCardsByAlias.set(id, mergeDomoRecords(productCardsByAlias.get(id), row));
    });
  });
  const oauthDrillFallbackReasons = new Map<string, string>();
  const oauthDrillEvidenceByCardId = new Map<string, Record<string, unknown>>();

  const collectPlatformCardDetail = async (cardId: string): Promise<{ detail: Record<string, unknown> | null; drillChildIds: string[] }> => {
    if (!platformOAuthAvailable) {
      const product = [cardId, ...(cardId.includes(':') ? [cardId.split(':').pop() || ''] : [])]
        .map((id) => productCardsByAlias.get(id)).find(Boolean);
      if (!product) {
        recordDomoMissingDependency(state, {
          kind: 'card_chart',
          label: 'Domo Product API Card definition',
          sourceId: cardId,
          error: new Error('The tenant-scoped Product Search and Page/Card membership responses did not return this Card.'),
        });
        return { detail: null, drillChildIds: [] };
      }
      return {
        detail: mergeDomoRecords(product, {
          id: cardId,
          cardId,
          objectType: 'card',
          analyzerEvidenceSource: 'product_search_discovery_only',
          analyzerDefinitionComplete: false,
          drillPath: [],
          drillDefinitionComplete: false,
          drillEvidenceSource: 'oauth_or_manual_export_required',
        }),
        drillChildIds: [],
      };
    }
    const encodedCardId = encodeURIComponent(cardId);
    if (!consumeDomoEvidenceRequests(state, 3)) return { detail: null, drillChildIds: [] };
    const [metadataResult, chartResult, drillResult] = await Promise.allSettled([
      fetchDomoPlatformJson(platformConnection!, `${DOMO_PLATFORM_API_BASE}/v1/cards/${encodedCardId}`, signal, transport),
      fetchDomoPlatformJson(platformConnection!, `${DOMO_PLATFORM_API_BASE}/v1/cards/chart/${encodedCardId}`, signal, transport),
      fetchDomoPlatformJson(platformConnection!, `${DOMO_PLATFORM_API_BASE}/v1/cards/chart/${encodedCardId}/drillpath`, signal, transport),
    ]);
    let chartEvidence: Record<string, unknown> | null = null;
    if (chartResult.status === 'rejected') {
      recordDomoMissingDependency(state, {
        kind: 'card_chart',
        label: 'Domo Analyzer Card definition',
        sourceId: cardId,
        error: chartResult.reason,
      });
      return { detail: null, drillChildIds: [] };
    } else {
      try {
        chartEvidence = domoCardChartEvidence(chartResult.value, cardId);
      } catch (error) {
        recordDomoMissingDependency(state, {
          kind: 'card_chart',
          label: 'Domo Analyzer Card definition',
          sourceId: cardId,
          error,
        });
        return { detail: null, drillChildIds: [] };
      }
    }
    let drillEvidence: Record<string, unknown>;
    let drillChildIds: string[] = [];
    if (drillResult.status === 'rejected') {
      const reason = domoEvidenceFailureReason(drillResult.reason);
      if (domoDrillRequestAllowsManualFallback(drillResult.reason)) {
        oauthDrillFallbackReasons.set(cardId, reason);
        state.warnings.push(`Domo Card ${cardId} drill properties require manual validation because the documented OAuth endpoint was missing or permission-denied: ${reason}`);
        drillEvidence = {
          drillPath: [],
          drillDefinitionComplete: false,
          drillEvidenceSource: 'manual_validation_required',
          drillEvidenceGap: reason,
        };
      } else {
        if ((drillResult.reason as { statusCode?: unknown })?.statusCode === 413) state.truncated = true;
        recordDomoMissingDependency(state, {
          kind: 'card_drill',
          label: 'Domo Card drill properties',
          sourceId: cardId,
          error: drillResult.reason,
        });
        drillEvidence = {
          drillPath: [],
          drillDefinitionComplete: false,
          drillEvidenceSource: 'collection_failed',
          drillEvidenceGap: reason,
        };
      }
    } else {
      try {
        const decodedDrillEvidence = domoCardDrillEvidence(drillResult.value, cardId);
        oauthDrillEvidenceByCardId.set(cardId, decodedDrillEvidence.normalized);
        drillEvidence = decodedDrillEvidence.cardProjection;
        const rawDrillOrder = decodedDrillEvidence.normalized.drillOrder;
        drillChildIds = Array.isArray(rawDrillOrder) ? rawDrillOrder.map(String) : [];
      } catch (error) {
        const reason = domoEvidenceFailureReason(error);
        const statusCode = typeof (error as { statusCode?: unknown })?.statusCode === 'number'
          ? (error as { statusCode: number }).statusCode
          : 502;
        if (statusCode === 413) {
          state.truncated = true;
          recordDomoMissingDependency(state, {
            kind: 'card_drill',
            label: 'Domo Card drill properties',
            sourceId: cardId,
            error,
          });
          drillEvidence = {
            drillPath: [],
            drillDefinitionComplete: false,
            drillEvidenceSource: 'collection_failed',
            drillEvidenceGap: reason,
          };
        } else {
          oauthDrillFallbackReasons.set(cardId, reason);
          state.warnings.push(`Domo Card ${cardId} drill properties require manual validation because the documented OAuth response was ambiguous: ${reason}`);
          drillEvidence = {
            drillPath: [],
            drillDefinitionComplete: false,
            drillEvidenceSource: 'manual_validation_required',
            drillEvidenceGap: reason,
          };
        }
      }
    }
    if (metadataResult.status === 'rejected') {
      recordDomoMissingDependency(state, {
        kind: 'card_metadata',
        label: 'Domo Card metadata',
        sourceId: cardId,
        error: metadataResult.reason,
      });
    }
    return {
      detail: mergeDomoRecords(
        metadataResult.status === 'fulfilled' ? metadataResult.value : {},
        chartEvidence,
        drillEvidence,
        {
          id: cardId,
          cardId,
          objectType: 'card',
          analyzerEvidenceSource: `/v1/cards/chart/${cardId}`,
        },
      ),
      drillChildIds,
    };
  };
  const platformCardDetails = new Map<string, Record<string, unknown>>();
  const queuedCardAliases = new Set(boundedCardIds.flatMap(identifierAliases));
  let cardCursor = 0;
  let drillClosureBoundReported = false;
  while (cardCursor < boundedCardIds.length) {
    assertDomoRequestActive(signal);
    const batchCardIds = boundedCardIds.slice(cardCursor, cardCursor + 5);
    cardCursor += batchCardIds.length;
    const batchResults = await mapWithConcurrency(batchCardIds, 5, collectPlatformCardDetail);
    batchCardIds.forEach((cardId, index) => {
      const result = batchResults[index];
      if (result?.detail) platformCardDetails.set(cardId, result.detail);
      result?.drillChildIds.forEach((drillChildId) => {
        const aliases = identifierAliases(drillChildId);
        if (aliases.length === 0 || aliases.some((alias) => queuedCardAliases.has(alias))) return;
        if (boundedCardIds.length >= MAX_DOMO_EVIDENCE_CARDS) {
          state.truncated = true;
          if (!drillClosureBoundReported) {
            state.blockers.push(`Domo Card drill closure exceeded the ${MAX_DOMO_EVIDENCE_CARDS}-Card safety bound. Split this migration into smaller waves or use focused Manual Files.`);
            drillClosureBoundReported = true;
          }
          return;
        }
        boundedCardIds.push(drillChildId);
        aliases.forEach((alias) => queuedCardAliases.add(alias));
      });
    });
  }
  const cards = boundedCardIds.flatMap((cardId) => {
    const platform = platformCardDetails.get(cardId);
    if (!platform) return [];
    const product = [cardId, ...(cardId.includes(':') ? [cardId.split(':').pop() || ''] : [])]
      .map((id) => productCardsByAlias.get(id)).find(Boolean);
    // Product Search and guide-grade Page membership are discovery inputs only.
    // The OAuth Platform Chart Card definition remains authoritative when both exist.
    const merged = mergeDomoRecords(product, platform, { id: cardId, cardId, objectType: 'card' });
    return [merged];
  });
  const datasetIds = uniqueStrings(cards.flatMap(domoDatasetIds)).slice(0, MAX_DOMO_EVIDENCE_DATASETS + 1);
  if (datasetIds.length > MAX_DOMO_EVIDENCE_DATASETS) {
    state.truncated = true;
    state.blockers.push(`Selected Domo Cards reference more than ${MAX_DOMO_EVIDENCE_DATASETS} DataSets. Split this migration into smaller waves.`);
  }
  const boundedDatasetIds = datasetIds.slice(0, MAX_DOMO_EVIDENCE_DATASETS);

  const datasetEvidence = await mapWithConcurrency(boundedDatasetIds, 4, async (datasetId) => {
    const requestCount = productApiAvailable ? (platformOAuthAvailable ? 5 : 4) : 2;
    if (!consumeDomoEvidenceRequests(state, requestCount)) {
      return { datasetId, metadata: null, schema: null, permissions: null, policies: null, datasetCards: null };
    }
    const load = async (kind: DomoApiMissingDependencyKind, label: string, path: string, product = true) => {
      try {
        return product
          ? await fetchDomoProductJson(connection, path, {}, signal, transport)
          : await fetchDomoPlatformJson(platformConnection!, path, signal, transport);
      } catch (error) {
        recordDomoMissingDependency(state, {
          kind,
          label: `${label} for Domo DataSet`,
          sourceId: datasetId,
          error,
        });
        return null;
      }
    };
    const loadPdpPolicies = async (): Promise<unknown[] | null> => {
      const payload = await load('dataset_pdp', 'PDP policies', `${DOMO_PLATFORM_API_BASE}/v1/datasets/${encodeURIComponent(datasetId)}/policies`, false);
      if (payload == null) return null;
      try {
        return domoPdpPolicyRows(payload);
      } catch (error) {
        recordDomoMissingDependency(state, {
          kind: 'dataset_pdp',
          label: 'PDP policies for Domo DataSet',
          sourceId: datasetId,
          error,
        });
        return null;
      }
    };
    const loadAccess = async (): Promise<unknown | null> => {
      const payload = await load('dataset_access', 'Access list', `/api/data/v3/datasources/${encodeURIComponent(datasetId)}/permissions`);
      if (payload == null) return null;
      try {
        return domoDatasetAccessEvidence(payload, datasetId);
      } catch (error) {
        recordDomoMissingDependency(state, {
          kind: 'dataset_access',
          label: 'Access list for Domo DataSet',
          sourceId: datasetId,
          error,
        });
        return null;
      }
    };
    if (!productApiAvailable) {
      state.blockers.push(`Domo DataSet ${datasetId} is missing Product API metadata, typed schema, access, and Card-binding evidence. Add a tenant-bound Product API developer token or reviewed Manual Files.`);
    }
    const [rawMetadata, rawSchema, permissions, policies, rawDatasetCards] = productApiAvailable
      ? await Promise.all([
        load('dataset_metadata', 'Metadata', `/api/data/v3/datasources/${encodeURIComponent(datasetId)}?part=core,permission`),
        load('dataset_schema', 'Schema', `/api/data/v2/datasources/${encodeURIComponent(datasetId)}/schemas/latest`),
        loadAccess(),
        platformOAuthAvailable ? loadPdpPolicies() : Promise.resolve(null),
        load('dataset_card_bindings', 'Card bindings', `/api/content/v1/datasources/${encodeURIComponent(datasetId)}/cards?drill=true`),
      ])
      : await Promise.all([
        load('dataset_metadata', 'Metadata', `${DOMO_PLATFORM_API_BASE}/v1/datasets/${encodeURIComponent(datasetId)}`, false),
        Promise.resolve(null),
        Promise.resolve(null),
        loadPdpPolicies(),
        Promise.resolve(null),
      ]);
    const decode = <T>(kind: DomoApiMissingDependencyKind, label: string, payload: unknown, decoder: (value: unknown) => T): T | null => {
      if (payload == null) return null;
      try {
        return decoder(payload);
      } catch (error) {
        recordDomoMissingDependency(state, { kind, label: `${label} for Domo DataSet`, sourceId: datasetId, error });
        return null;
      }
    };
    const metadata = decode('dataset_metadata', 'Metadata', rawMetadata, (value) => domoProductDatasetMetadataEvidence(value, datasetId));
    const schema = decode('dataset_schema', 'Schema', rawSchema, (value) => domoProductDatasetSchemaEvidence(value, datasetId));
    const datasetCards = decode('dataset_card_bindings', 'Card bindings', rawDatasetCards, (value) => domoProductDatasetCardRows(value, datasetId));
    return { datasetId, metadata, schema, permissions, policies, datasetCards };
  });

  // Dataset-to-Card bindings are authoritative when Product Search omits datasourceId.
  datasetEvidence.forEach(({ datasetId, datasetCards }) => {
    (datasetCards || []).forEach((row) => {
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
  if (productApiAvailable) try {
    const pageSize = 500;
    let offset = 0;
    let pagesFetched = 0;
    let moreAvailable = false;
    while (beastModeSearch.length < MAX_DOMO_EVIDENCE_BEAST_MODES && pagesFetched < MAX_INVENTORY_PAGES) {
      if (!consumeDomoEvidenceRequests(state)) break;
      pagesFetched += 1;
      const requestedCount = Math.min(pageSize, MAX_DOMO_EVIDENCE_BEAST_MODES - beastModeSearch.length);
      const payload = await fetchDomoProductJson(connection, '/api/query/v1/functions/search', {
        method: 'POST',
        body: JSON.stringify({ name: '', filters: [{ field: 'notvariable' }], sort: { field: 'name', ascending: true }, limit: requestedCount, offset }),
      }, signal, transport);
      const searchPage = domoBeastModeSearchRows(payload);
      const rows = searchPage.rows;
      beastModeSearch.push(...rows);
      if (rows.length > requestedCount || beastModeSearch.length > MAX_DOMO_EVIDENCE_BEAST_MODES) {
        state.truncated = true;
        state.blockers.push(`Domo Beast Mode search returned ${rows.length.toLocaleString()} rows for a ${requestedCount.toLocaleString()}-row request and cannot be treated as complete. Use focused Manual Files for complete formula evidence.`);
        break;
      }
      if (searchPage.total != null && searchPage.total < beastModeSearch.length) {
        throw Object.assign(new Error('Domo Beast Mode search returned inconsistent pagination metadata. Verify the saved credential and tenant API compatibility, then retry.'), { statusCode: 502 });
      }
      if (searchPage.hasMore === false && searchPage.total != null && searchPage.total > beastModeSearch.length) {
        throw Object.assign(new Error('Domo Beast Mode search returned inconsistent pagination metadata. Verify the saved credential and tenant API compatibility, then retry.'), { statusCode: 502 });
      }
      if (searchPage.hasMore === true && searchPage.total != null && searchPage.total <= beastModeSearch.length) {
        throw Object.assign(new Error('Domo Beast Mode search returned inconsistent pagination metadata. Verify the saved credential and tenant API compatibility, then retry.'), { statusCode: 502 });
      }
      const paginationKnown = searchPage.hasMore != null || searchPage.total != null;
      if (rows.length === requestedCount && !paginationKnown) {
        if (beastModeSearch.length >= MAX_DOMO_EVIDENCE_BEAST_MODES) {
          moreAvailable = true;
          break;
        }
        throw Object.assign(new Error('Domo Beast Mode search returned a full page without terminal pagination evidence. Retry with a narrower scope or use focused Manual Files.'), { statusCode: 502 });
      }
      const hasMore = searchPage.hasMore === true || (searchPage.total != null && beastModeSearch.length < searchPage.total);
      moreAvailable = hasMore;
      if (rows.length === 0 && hasMore) {
        throw Object.assign(new Error('Domo Beast Mode search returned an empty page while pagination metadata reported more rows. Verify the saved credential and tenant API compatibility, then retry.'), { statusCode: 502 });
      }
      if (rows.length === 0 || !hasMore) break;
      offset += rows.length;
    }
    if (moreAvailable && (beastModeSearch.length >= MAX_DOMO_EVIDENCE_BEAST_MODES || pagesFetched >= MAX_INVENTORY_PAGES)) {
      state.truncated = true;
      const bound = beastModeSearch.length >= MAX_DOMO_EVIDENCE_BEAST_MODES
        ? `${MAX_DOMO_EVIDENCE_BEAST_MODES.toLocaleString()}-item`
        : `${MAX_INVENTORY_PAGES}-request`;
      state.blockers.push(`Domo Beast Mode search reached the ${bound} safety limit while more rows remained. Use focused Manual Files for complete formula evidence.`);
    }
  } catch (error) {
    recordDomoMissingDependency(state, { kind: 'beast_mode_search', label: 'Domo Beast Mode discovery', error });
  }
  const cardAliases = new Set(cards.flatMap(domoObjectIdAliases));
  const datasetAliasSet = new Set(boundedDatasetIds.flatMap(identifierAliases));
  const scopedBeastModeRows = beastModeSearch.flatMap((row) => {
    const beastModeId = firstString(asRecord(row).id) || (typeof asRecord(row).id === 'number' ? String(asRecord(row).id) : '');
    const linkedCards = domoLinkedResourceIds(row, 'CARD').flatMap((id) => [id, ...(id.includes(':') ? [id.split(':').pop() || ''] : [])]);
    const linkedDatasets = domoLinkedResourceIds(row, 'DATA_SOURCE');
    // Product Beast Mode search is tenant-wide. A row without a documented
    // Card or DataSet link has not been proven relevant to the selected scope,
    // so it is discovery noise rather than a missing selected dependency.
    if (linkedCards.length === 0 && linkedDatasets.length === 0) return [];
    if (!beastModeId) {
      recordDomoMissingDependency(state, {
        kind: 'beast_mode_identity',
        label: 'Domo Beast Mode stable identity',
        sourceName: recordName(row, 'unnamed Beast Mode'),
        error: new Error('The search result did not include a stable Beast Mode ID.'),
      });
      return [];
    }
    return linkedCards.some((id) => cardAliases.has(id)) || linkedDatasets.some((id) => datasetAliasSet.has(id)) ? [row] : [];
  });
  const beastModes = (await mapWithConcurrency(scopedBeastModeRows, 5, async (row) => {
    const beastModeId = firstString(asRecord(row).id) || (typeof asRecord(row).id === 'number' ? String(asRecord(row).id) : '');
    if (!beastModeId) {
      recordDomoMissingDependency(state, {
        kind: 'beast_mode_identity',
        label: 'Domo Beast Mode stable identity',
        sourceName: recordName(row, 'unnamed Beast Mode'),
        error: new Error('The search result did not include a stable Beast Mode ID.'),
      });
      return null;
    }
    if (!consumeDomoEvidenceRequests(state)) return null;
    try {
      const payload = await fetchDomoProductJson(connection, `/api/query/v1/functions/template/${encodeURIComponent(beastModeId)}`, {}, signal, transport);
      return domoBeastModeDetailEvidence({
        payload,
        expectedBeastModeId: beastModeId,
        selectedCardAliases: cardAliases,
        selectedDatasetAliases: datasetAliasSet,
      });
    } catch (error) {
      recordDomoMissingDependency(state, {
        kind: 'beast_mode_detail',
        label: 'Domo Beast Mode definition',
        sourceId: beastModeId,
        sourceName: recordName(row, beastModeId),
        error,
      });
      return null;
    }
  })).filter((row): row is Record<string, unknown> => row != null);

  const scopedIds = new Set([...selected, ...boundedCardIds, ...boundedDatasetIds]);
  const handoffArtifacts: MigrationArtifact[] = [];
  if (productApiAvailable) for (const entity of ['dataflow', 'connector', 'app', 'data_app', 'alert'] as const) {
    try {
      const rows = await domoProductSearch(connection, entity, state, 500, '*', signal, transport);
      const related = rows.filter((row) => {
        const references = uniqueStrings([...domoReferenceValues(row, new Set(['cardid', 'pageid', 'datasourceid', 'datasetid', 'dataset_id', 'data_source_id'])), ...domoLinkedResourceIds(row)]);
        return references.some((id) => scopedIds.has(id) || scopedIds.has(id.split(':').pop() || ''));
      });
      if (related.length > 0) {
        const wrapper = entity === 'alert' ? 'alerts' : entity === 'dataflow' ? 'dataflows' : entity === 'connector' ? 'connectors' : 'customApps';
        handoffArtifacts.push(domoEvidenceArtifact(`domo-api-${entity}-handoffs.json`, { [wrapper]: related.map((row) => ({ ...asRecord(row), objectType: entity === 'dataflow' ? 'Domo DataFlow' : entity })) }));
      }
    } catch (error) {
      recordDomoMissingDependency(state, {
        kind: `${entity}_search` as DomoApiMissingDependencyKind,
        label: `Domo ${entity.replace('_', ' ')} dependency search`,
        error,
      });
    }
  }

  const drillFallbackCardIds = platformOAuthAvailable
    ? boundedCardIds.filter((cardId) => oauthDrillFallbackReasons.has(cardId))
    : boundedCardIds;
  const apiCoverageGaps = [
    ...(!platformOAuthAvailable ? boundedCardIds.map((cardId) => `card_analyzer_definition:${cardId}:oauth_or_manual_export_required`) : []),
    ...drillFallbackCardIds.map((cardId) => `card_drill:${cardId}:manual_validation_required`),
    ...(!platformOAuthAvailable ? boundedDatasetIds.map((datasetId) => `dataset_pdp:${datasetId}:oauth_or_manual_export_required`) : []),
    ...(!productApiAvailable ? boundedDatasetIds.map((datasetId) => `dataset_definition:${datasetId}:product_api_or_manual_export_required`) : []),
    ...(!productApiAvailable ? ['beast_mode_definitions:selected_scope:product_api_or_manual_export_required'] : []),
  ];
  const evidenceLimitations: DomoApiEvidenceLimitation[] = [
    ...(!platformOAuthAvailable && boundedCardIds.length > 0 ? [DOMO_PRODUCT_CARD_ANALYZER_DEFINITION_LIMITATION] : []),
    ...(drillFallbackCardIds.length > 0 ? [DOMO_PRODUCT_CARD_DRILL_LIMITATION] : []),
    ...(!platformOAuthAvailable && boundedDatasetIds.length > 0 ? [DOMO_PRODUCT_DATASET_PDP_LIMITATION] : []),
    ...(!productApiAvailable && boundedDatasetIds.length > 0 ? [DOMO_PLATFORM_DATASET_DEFINITION_LIMITATION] : []),
    ...(!productApiAvailable ? [DOMO_PLATFORM_BEAST_MODE_LIMITATION] : []),
  ];
  if (evidenceLimitations.length > 0) {
    state.warnings.push('The prepared Domo scope retains explicit API coverage gaps. Supply the missing credential family or reviewed Manual Files before any target write or release.');
  }
  if (productTokenOnly && selectedPages.length > 0) {
    state.warnings.push('Domo Page/Card membership uses an official Domo tutorial endpoint rather than a formal Product API reference contract. It supports Preview discovery only and never establishes write eligibility.');
  }

  const artifacts: MigrationArtifact[] = [
    domoEvidenceArtifact('domo-api-pages.json', { pages: pageDetails.map(({ item, detail }) => ({ ...asRecord(detail), id: item.id, name: item.name, cardIds: domoCardIds(detail) })) }),
    domoEvidenceArtifact('domo-api-cards.json', { cards }),
    ...(oauthDrillEvidenceByCardId.size > 0 ? [domoEvidenceArtifact('domo-api-card-drill-properties.json', {
      cardDrillProperties: boundedCardIds.flatMap((cardId) => {
        const evidence = oauthDrillEvidenceByCardId.get(cardId);
        return evidence ? [evidence] : [];
      }),
    })] : []),
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
  if (parseResult.diagnostics.traversalLimitHit) {
    state.truncated = true;
    state.blockers.push('Normalized Domo API evidence exceeded a deterministic parser traversal limit. Narrow the selected scope before retrying.');
  }
  if (parseResult.diagnostics.missingStableIdCount > 0) {
    state.blockers.push(`${parseResult.diagnostics.missingStableIdCount} normalized Domo source object${parseResult.diagnostics.missingStableIdCount === 1 ? '' : 's'} lack a stable source ID.`);
  }
  if (parseResult.diagnostics.unresolvedDependencyCount > 0) {
    state.blockers.push(`${parseResult.diagnostics.unresolvedDependencyCount} normalized Domo dependency reference${parseResult.diagnostics.unresolvedDependencyCount === 1 ? '' : 's'} could not be resolved from the collected API evidence.`);
  }
  const parsedCards = parseResult.inventory.dashboards.filter((dashboard) => dashboard.assetKind === 'card');
  const parsedPages = parseResult.inventory.dashboards.filter((dashboard) => dashboard.assetKind === 'page');
  boundedDatasetIds.forEach((datasetId) => {
    const datasetView = parseResult.inventory.views.find((view) => view.kind === 'dataset' && view.sourceId === datasetId);
    const hasTypedField = datasetView?.fields.some((field) => typeof field.type === 'string' && field.type.trim().length > 0) === true;
    if (!hasTypedField) {
      state.blockers.push(`Domo DataSet ${datasetId} did not resolve a typed schema from the collected API evidence. Retry after verifying DataSet schema access or add its schema through Manual Files.`);
    }
  });
  parsedCards.forEach((card) => {
    if (!card.sourceDatasetId) state.blockers.push(`Domo Card ${card.name} has no DataSet binding in the documented API evidence.`);
    if (card.fields.length === 0) state.blockers.push(`Domo Card ${card.name} has no field bindings in the documented API evidence. Add its Analyzer/Card JSON through Manual Files or explicitly redesign the Card.`);
  });
  if (parsedCards.some((card) => card.featureFlags?.includes('variable_controls')) && !parseResult.mappings.some((mapping) => mapping.sourceKind === 'variable')) {
    state.blockers.push('Selected Domo Cards use Variables, but Variable type/default/control evidence was not resolved. Add the relevant Variable export through Manual Files before planning.');
  }
  if (parsedCards.length === 0) state.blockers.push('The selected Domo scope did not resolve any Card definitions.');
  if (parseResult.inventory.views.every((view) => view.fields.length === 0)) state.blockers.push('The selected Domo scope did not resolve a typed DataSet schema.');
  const parsedBeastModeIds = new Set(parseResult.mappings
    .filter((mapping) => mapping.sourceKind === 'beast_mode')
    .flatMap((mapping) => mapping.sourceId ? identifierAliases(mapping.sourceId) : []));
  scopedBeastModeRows.forEach((row) => {
    const beastModeId = firstIdentifier(asRecord(row).id);
    if (beastModeId && !identifierAliases(beastModeId).some((id) => parsedBeastModeIds.has(id))) {
      state.blockers.push(`Domo Beast Mode ${beastModeId} did not reconcile to one parsed formula definition for the selected scope.`);
    }
  });
  state.blockers = uniqueStrings(state.blockers);
  state.warnings = uniqueStrings(state.warnings);
  const evidenceComplete = state.blockers.length === 0
    && state.missingDependencies.length === 0
    && !state.truncated
    && evidenceLimitations.length === 0;
  const limitationOnlyEvidence = evidenceLimitations.length > 0
    && state.blockers.length === 0
    && state.missingDependencies.length === 0
    && !state.truncated;
  const resolvedDashboardIds = uniqueStrings([...parsedPages, ...parsedCards].flatMap((dashboard) => dashboard.sourceId ? [dashboard.sourceId] : []));
  const resolvedDatasetIds = uniqueStrings(parseResult.inventory.views
    .filter((view) => view.kind === 'dataset')
    .flatMap((view) => view.sourceId ? [view.sourceId] : []));
  const permissionGaps = uniqueStrings([
    ...state.missingDependencies
      .filter((dependency) => dependency.kind === 'dataset_access' || dependency.kind === 'dataset_pdp')
      .map((dependency) => `${dependency.kind}:${dependency.sourceId || 'unknown'}`),
    ...apiCoverageGaps,
  ]).sort();
  const parsedSourceEvidence = parseResult.inventory.sourceEvidence!;
  const scopeFingerprint = domoApiScopeFingerprint({
    connectionId: connection.id,
    connectionUpdatedAt: connection.updatedAt,
    selectedDashboardIds: selected,
    resolvedDashboardIds,
    resolvedCardIds: parsedCards.flatMap((card) => card.sourceId ? [card.sourceId] : []),
    resolvedDatasetIds,
    resolvedBeastModeIds: beastModes.map((row) => String(row.id || '')),
    parser: parsedSourceEvidence.parser,
    artifactFingerprints: parsedSourceEvidence.artifactFingerprints,
    limitationCodes: evidenceLimitations.map((limitation) => limitation.code),
    permissionGaps,
  });
  const browserSafeParseResult: DomoManualParseResult = {
    ...parseResult,
    inventory: {
      ...parseResult.inventory,
      sourceEvidence: {
        ...parseResult.inventory.sourceEvidence!,
        acquisition: {
          mode: 'api',
          runId: scopeFingerprint,
          selectedScopeIds: [...selected].sort(),
        },
        collection: {
          expectedArtifactCount: artifacts.length,
          observedArtifactCount: artifacts.length,
          complete: evidenceComplete,
          truncated: state.truncated,
          permissionGaps,
        },
        dependencyClosure: {
          status: evidenceComplete ? 'complete' : 'blocked',
          resolvedCount: parseResult.mappings.length,
          missingCount: Math.max(state.blockers.length, state.missingDependencies.length),
          reviewCount: parseResult.conflicts.length + parseResult.diagnostics.handoffCount,
        },
        diagnostics: [
          ...state.blockers,
          ...evidenceLimitations.map((limitation) => `${limitation.code}: ${limitation.message}`),
          ...state.warnings,
        ],
      },
      artifacts: parseResult.inventory.artifacts.map((artifact) => ({ ...artifact, content: '' })),
    },
  };
  assertDomoRequestActive(signal);
  return {
    parseResult: browserSafeParseResult,
    selectedDashboardIds: selected,
    resolvedDashboardIds,
    connectionUpdatedAt: connection.updatedAt,
    scopeFingerprint,
    preparedAt: new Date().toISOString(),
    diagnostics: {
      schemaVersion: 'omnikit.domo.api.v1',
      status: evidenceComplete ? 'ready' : limitationOnlyEvidence ? 'ready_with_gaps' : 'blocked',
      access: 'deep',
      limitationDispositionRequired: limitationOnlyEvidence,
      limitations: evidenceLimitations,
      selectedDashboardCount: selected.length,
      resolvedPageCount: parsedPages.length,
      resolvedCardCount: parsedCards.length,
      resolvedDatasetCount: parseResult.inventory.views.filter((view) => view.kind === 'dataset').length,
      resolvedBeastModeCount: parseResult.mappings.filter((mapping) => mapping.sourceKind === 'beast_mode').length,
      requestCount: state.requests,
      truncated: state.truncated,
      missingDependencies: state.missingDependencies,
      blockers: state.blockers,
      warnings: state.warnings,
    },
  };
}

/**
 * Adapter from the Domo-specific compatibility contract to the shared
 * prepared-source evidence boundary used by every Saved API connector.
 */
export async function prepareDomoSourceEvidence(
  connection: SavedPlatformConnection,
  selectedRootIds: string[],
  signal?: AbortSignal,
  transport: MigrationSourceTransport = createMigrationSourceTransport(),
): Promise<MigrationPreparedEvidenceResult> {
  const result = await prepareDomoApiEvidence(connection, selectedRootIds, signal, transport);
  return domoApiEvidenceToPreparedSourceEvidence(connection, result);
}

/**
 * Preserve the Domo compatibility DTO while projecting it into the shared
 * prepared-evidence contract used for content-bound review tokens.
 */
export function domoApiEvidenceToPreparedSourceEvidence(
  connection: SavedPlatformConnection,
  result: DomoApiEvidenceResult,
): MigrationPreparedEvidenceResult {
  const inventory = result.parseResult.inventory;
  const evidenceContract = inventory.sourceEvidence!;
  const contentByName = new Map(inventory.artifacts.map((artifact) => [artifact.name, artifact]));
  const artifacts = evidenceContract.artifactFingerprints.map((fingerprint) => {
    const artifact = contentByName.get(fingerprint.name);
    const sha256 = fingerprint.sha256 || (artifact ? createHash('sha256').update(artifact.content).digest('hex') : '');
    return {
      id: artifact?.id || `domo-${sha256.slice(0, 16)}`,
      name: fingerprint.name,
      sourceId: artifact?.id || fingerprint.name,
      mediaType: 'application/json',
      evidenceClass: 'authoritative_definition' as const,
      sha256,
      sizeBytes: fingerprint.sizeBytes,
      documentationIds: [...evidenceContract.documentationIds],
      rawContentIncluded: false as const,
    };
  });
  const dependencies = result.diagnostics.missingDependencies.map((dependency) => ({
    sourceId: dependency.sourceId || dependency.sourceName || dependency.kind,
    category: dependency.kind.includes('pdp') || dependency.kind.includes('access') ? 'security' as const
      : dependency.kind.includes('beast') ? 'calculation' as const
        : dependency.kind.includes('dataset') ? 'data_source' as const
          : 'content' as const,
    required: true,
    status: 'missing' as const,
    reason: dependency.reason,
  }));
  return {
    schemaVersion: 'omnikit.prepared-source-evidence.v1',
    platform: 'domo',
    connectionId: connection.id,
    connectionUpdatedAt: result.connectionUpdatedAt,
    selectedRootIds: [...result.selectedDashboardIds],
    scopeFingerprint: result.scopeFingerprint,
    preparedAt: result.preparedAt,
    status: result.diagnostics.status === 'ready' ? 'complete'
      : result.diagnostics.truncated ? 'bounded'
        : result.diagnostics.status === 'ready_with_gaps' ? 'partial'
          : 'failed',
    evidenceContract,
    inventory,
    artifacts,
    dependencies,
    diagnostics: {
      complete: result.diagnostics.status === 'ready',
      verifiedEmpty: result.diagnostics.status === 'ready' && artifacts.length === 0,
      truncated: result.diagnostics.truncated,
      requestsMade: result.diagnostics.requestCount,
      pagesFetched: 0,
      itemsObserved: result.diagnostics.resolvedPageCount + result.diagnostics.resolvedCardCount + result.diagnostics.resolvedDatasetCount + result.diagnostics.resolvedBeastModeCount,
      bytesRead: artifacts.reduce((sum, artifact) => sum + artifact.sizeBytes, 0),
      limits: { maxRequests: MAX_INVENTORY_REQUESTS, maxPages: MAX_INVENTORY_PAGES, maxItems: MAX_INVENTORY_ITEMS, maxBytes: MAX_DOMO_PRODUCT_RESPONSE_BYTES },
      permissionGaps: [...evidenceContract.collection.permissionGaps],
      manualRequirements: result.diagnostics.limitations.map((limitation) => `${limitation.code}: ${limitation.message}`),
      errors: [...result.diagnostics.blockers],
      warnings: [...result.diagnostics.warnings],
    },
  };
}


function migrationSourceDiscoveryContext(
  connection: SavedPlatformConnection,
  signal?: AbortSignal,
  transport: MigrationSourceTransport = createMigrationSourceTransport(),
): MigrationSourceCollectorContext {
  const platform = connection.platform as MigrationBiSourceTool;
  const snapshot: MigrationSourceConnectionSnapshot = {
    id: connection.id,
    name: connection.name,
    platform,
    baseUrl: connection.baseUrl || '',
    updatedAt: connection.updatedAt,
    authMode: connection.authMode || 'api_key',
    clientId: connection.clientId,
    credential: connection.credential,
    productApiToken: connection.productApiToken,
    accountIdentifier: connection.accountIdentifier,
    workspaceId: connection.workspaceId,
    projectId: connection.projectId,
    siteId: connection.siteId,
    username: connection.username,
    repositoryPath: connection.repositoryPath,
    credentialExpiresAt: connection.credentialExpiresAt,
  };
  return {
    connection: snapshot,
    selectedRootIds: [],
    scopeFingerprint: createHash('sha256').update(JSON.stringify({
      connectionId: connection.id,
      connectionUpdatedAt: connection.updatedAt,
      platform,
      purpose: 'catalog-discovery',
    })).digest('hex'),
    transport,
    signal,
  };
}

function discoveryInventoryResult(input: {
  connection: SavedPlatformConnection;
  items: SourceInventoryItem[];
  warnings: string[];
  complete: boolean;
  truncated: boolean;
  requestsMade: number;
  pagesFetched: number;
  scopeLabel: string;
}): SourceInventoryResult {
  const collection = tracker('saved_parent', input.scopeLabel);
  collection.requestsMade = input.requestsMade;
  collection.pagesFetched = input.pagesFetched;
  collection.truncated = input.truncated;
  if (!input.complete && !input.truncated) {
    collection.failures.push(`${sourceConnectorDefinition(input.connection.platform)?.label || input.connection.platform} catalog discovery was incomplete. Check the saved credential and source permissions, then retry.`);
  }
  return result(input.connection, input.items, [...input.warnings], collection);
}

function discoveryItem(input: {
  id: string;
  name: string;
  kind: SourceAssetKind;
  parentId?: string;
  updatedAt?: string;
  usageCount?: number;
  metadata?: Record<string, string | number | boolean | null>;
}): SourceInventoryItem {
  return {
    id: input.id,
    name: input.name,
    kind: input.kind,
    parentId: input.parentId,
    updatedAt: input.updatedAt,
    usageCount: input.usageCount,
    dependencyIds: [],
    featureFlags: [],
    riskFlags: [],
    metadata: input.metadata || {},
  };
}

async function authenticatedLookerInventory(connection: SavedPlatformConnection, signal?: AbortSignal, transport?: MigrationSourceTransport): Promise<SourceInventoryResult> {
  const discovery = await listLookerDiscoveryInventory(migrationSourceDiscoveryContext(connection, signal, transport));
  const items = discovery.items.map((item) => discoveryItem({
    id: item.id,
    name: item.name,
    kind: item.kind === 'explore' ? 'semantic_model' : item.kind,
    parentId: item.parentId,
    updatedAt: item.updatedAt,
    usageCount: item.usageCount,
    metadata: item.kind === 'explore' ? { compiledExplore: true } : {},
  }));
  return discoveryInventoryResult({
    connection,
    items,
    warnings: discovery.diagnostics.warnings,
    complete: !discovery.diagnostics.truncated,
    truncated: discovery.diagnostics.truncated,
    requestsMade: discovery.diagnostics.requestsMade,
    pagesFetched: discovery.diagnostics.pagesFetched,
    scopeLabel: 'Looker accessible compiled content',
  });
}

async function authenticatedSigmaInventory(connection: SavedPlatformConnection, signal?: AbortSignal, transport?: MigrationSourceTransport): Promise<SourceInventoryResult> {
  const discovery = await listSigmaDiscoveryInventory(migrationSourceDiscoveryContext(connection, signal, transport));
  const items = discovery.items.map((item) => discoveryItem({ id: item.id, name: item.name, kind: item.kind === 'semantic_model' ? 'semantic_model' : 'workbook', updatedAt: item.updatedAt }));
  return discoveryInventoryResult({
    connection,
    items,
    warnings: discovery.diagnostics.warnings,
    complete: !discovery.diagnostics.truncated,
    truncated: discovery.diagnostics.truncated,
    requestsMade: discovery.diagnostics.requestsMade,
    pagesFetched: discovery.diagnostics.pagesFetched,
    scopeLabel: 'Sigma accessible Data Models and workbooks',
  });
}

async function authenticatedTableauInventory(connection: SavedPlatformConnection, signal?: AbortSignal, transport: MigrationSourceTransport = createMigrationSourceTransport()): Promise<SourceInventoryResult> {
  const discovery = await discoverTableauSource(migrationSourceDiscoveryContext(connection, signal, transport).connection, transport, signal);
  const items = discovery.items.map((item) => discoveryItem({
    id: item.kind === 'data_source' ? `datasource:${item.id}` : item.id,
    name: item.name,
    kind: item.kind,
    parentId: item.parentId,
    updatedAt: item.updatedAt,
    metadata: item.contentUrl ? { contentUrl: item.contentUrl } : {},
  }));
  return discoveryInventoryResult({ connection, items, warnings: discovery.warnings, complete: discovery.complete, truncated: discovery.truncated, requestsMade: discovery.requestsMade, pagesFetched: discovery.pagesFetched, scopeLabel: `Tableau site ${discovery.siteContentUrl || 'Default'}` });
}

async function authenticatedPowerBiInventory(connection: SavedPlatformConnection, signal?: AbortSignal, transport: MigrationSourceTransport = createMigrationSourceTransport()): Promise<SourceInventoryResult> {
  const discovery = await discoverPowerBiSource(migrationSourceDiscoveryContext(connection, signal, transport).connection, transport, signal);
  const items = discovery.items.flatMap((item) => {
    const normalizedType = item.type.toLowerCase().replaceAll(' ', '');
    const semantic = normalizedType === 'semanticmodel' || normalizedType === 'dataset';
    const report = normalizedType === 'report';
    if (!semantic && !report) return [];
    return [discoveryItem({
      id: semantic ? `semantic_model:${item.id}` : `report:${item.id}`,
      name: item.displayName,
      kind: semantic ? 'semantic_model' : 'report',
      parentId: discovery.workspaceId,
      metadata: { fabricItemType: item.type },
    })];
  });
  return discoveryInventoryResult({ connection, items, warnings: discovery.warnings, complete: discovery.complete, truncated: discovery.truncated, requestsMade: discovery.requestsMade, pagesFetched: discovery.pagesFetched, scopeLabel: `Fabric workspace ${discovery.workspaceId}` });
}

async function authenticatedMetabaseInventory(connection: SavedPlatformConnection, signal?: AbortSignal, transport?: MigrationSourceTransport): Promise<SourceInventoryResult> {
  const discovery = await discoverMetabaseSource(migrationSourceDiscoveryContext(connection, signal, transport));
  const items = discovery.items.map((item) => ({
    ...discoveryItem({
      id: item.id,
      name: item.name,
      kind: item.kind,
      parentId: item.parentId,
      updatedAt: item.updatedAt,
      metadata: item.metadata,
    }),
    dependencyIds: item.dependencyIds,
  }));
  return discoveryInventoryResult({
    connection,
    items,
    warnings: discovery.warnings,
    complete: discovery.complete,
    truncated: discovery.truncated,
    requestsMade: discovery.requestsMade,
    pagesFetched: discovery.pagesFetched,
    scopeLabel: 'Metabase accessible databases, tables, questions, dashboards, and collections',
  });
}

async function authenticatedMicroStrategyInventory(connection: SavedPlatformConnection, signal?: AbortSignal, transport?: MigrationSourceTransport): Promise<SourceInventoryResult> {
  const discovery = await discoverMicroStrategySource(migrationSourceDiscoveryContext(connection, signal, transport));
  const items = discovery.items.map((item) => discoveryItem({
    id: item.id,
    name: item.name,
    kind: item.kind === 'project' ? 'project' : item.kind,
    parentId: item.parentId,
  }));
  return discoveryInventoryResult({ connection, items, warnings: discovery.warnings, complete: discovery.complete, truncated: discovery.truncated, requestsMade: discovery.requestsMade, pagesFetched: discovery.pagesFetched, scopeLabel: `Strategy project ${discovery.projectId}` });
}

/**
 * Catalog completeness is not evidence completeness. A clean bounded catalog
 * proves authentication and tenant access, while exact selected-root evidence
 * remains independently revision-bound and fail-closed.
 */
export function sourceInventoryAuthenticationVerified(inventory: SourceInventoryResult): boolean {
  if (inventory.collection.errors.length > 0) return false;
  if (inventory.collection.status === 'bounded') {
    return inventory.truncated && !inventory.collection.complete;
  }
  if (inventory.truncated) return false;
  return inventory.collection.status === 'complete' && inventory.collection.complete;
}

export async function listSourceInventory(
  connection: SavedPlatformConnection,
  signal?: AbortSignal,
  transport?: MigrationSourceTransport,
): Promise<SourceInventoryResult> {
  assertSavedSourceAuthentication(connection);
  if (connection.platform === 'power_bi') return authenticatedPowerBiInventory(connection, signal, transport);
  if (connection.platform === 'sigma') return authenticatedSigmaInventory(connection, signal, transport);
  if (connection.platform === 'looker') return authenticatedLookerInventory(connection, signal, transport);
  if (connection.platform === 'metabase') return authenticatedMetabaseInventory(connection, signal, transport);
  if (connection.platform === 'tableau') return authenticatedTableauInventory(connection, signal, transport);
  if (connection.platform === 'domo') return domoInventory(connection, signal, transport);
  if (connection.platform === 'webfocus') {
    throw Object.assign(new Error('WebFOCUS Saved API is not enabled. Use a bounded Change Management ZIP or reviewed FEX/MAS/ACX Manual Files.'), { statusCode: 409 });
  }
  if (connection.platform === 'microstrategy') return authenticatedMicroStrategyInventory(connection, signal, transport);
  throw Object.assign(new Error(`${connection.platform} is not a supported BI migration source.`), { statusCode: 400 });
}

import { ApiError } from '@/services/omniApi';
import { emitVaultLocked } from '@/services/vaultEvents';

export type PortfolioMetricState = 'available' | 'partial' | 'stale' | 'unavailable' | 'not_configured';
export type PortfolioMetricStatus =
  | 'available'
  | 'partial'
  | 'permission_denied'
  | 'unsupported'
  | 'not_configured'
  | 'stale'
  | 'failed';
export type PortfolioCoverageUnit = 'instances' | 'connections' | 'endpoints' | 'model_kinds';
export type PortfolioHealth = 'healthy' | 'attention' | 'unavailable' | 'unknown';
export type PortfolioConnectionReadiness = 'ready' | 'attention' | 'unavailable' | 'unknown';
export type PortfolioConnectionAttribution = 'explicit' | 'inferred' | 'unknown';
export type PortfolioAttentionSeverity = 'critical' | 'warning' | 'info';

export interface PortfolioMetricCoverageDTO {
  included: number;
  total: number;
  unit: PortfolioCoverageUnit;
  ratio: number | null;
}

export interface PortfolioMetricDTO {
  value: number | null;
  /** Exact server evidence status. `state` is the backwards-compatible display grouping. */
  status?: PortfolioMetricStatus;
  state: PortfolioMetricState;
  coverage?: PortfolioMetricCoverageDTO;
  coverageLabel?: string;
  asOf?: string;
  exclusions?: string[];
  reasonCode?: string | null;
  reasonLabel?: string;
  source?: string;
  detail?: string;
}

export interface PortfolioMetricSetDTO {
  internalMemberships: PortfolioMetricDTO;
  estimatedUniquePeople: PortfolioMetricDTO;
  embedUsers: PortfolioMetricDTO;
  embedEntities: PortfolioMetricDTO;
  active7d: PortfolioMetricDTO;
  active30d: PortfolioMetricDTO;
  active90d: PortfolioMetricDTO;
  staleUsers90d: PortfolioMetricDTO;
  neverLoggedInUsers: PortfolioMetricDTO;
  dashboards: PortfolioMetricDTO;
  models: PortfolioMetricDTO;
  topics: PortfolioMetricDTO;
  aiChats: PortfolioMetricDTO;
  apps: PortfolioMetricDTO;
}

export interface PortfolioOverviewMetricsDTO extends PortfolioMetricSetDTO {
  reportingInstances: PortfolioMetricDTO;
}

export interface PortfolioConnectionDTO {
  id: string;
  name: string;
  instanceId: string;
  instanceLabel: string;
  readiness: PortfolioConnectionReadiness;
  statusLabel: string;
  freshness: PortfolioMetricState;
  freshnessStatus?: PortfolioMetricStatus;
  asOf?: string;
  attribution: PortfolioConnectionAttribution;
  dashboards: PortfolioMetricDTO;
  models: PortfolioMetricDTO;
  topics: PortfolioMetricDTO;
  detail?: string;
}

export interface PortfolioInstanceDTO {
  id: string;
  label: string;
  role?: string;
  health: PortfolioHealth;
  statusLabel: string;
  freshness: PortfolioMetricState;
  freshnessStatus?: PortfolioMetricStatus;
  asOf?: string;
  duplicateSavedOrigin: boolean;
  duplicateSavedOriginCount: number;
  duplicateInstanceLabels: string[];
  detail?: string;
  metrics: PortfolioMetricSetDTO;
  connections: PortfolioConnectionDTO[];
}

export interface PortfolioCoverageDTO {
  totalInstances: number;
  reportingInstances: number;
  partialInstances: number;
  staleInstances: number;
  unavailableInstances: number;
  savedInstances?: number;
  duplicateSavedOrigins?: number;
}

export interface DuplicateSavedOriginDTO {
  canonicalInstanceId: string;
  instanceLabels: string[];
  savedInstanceCount: number;
}

export interface PortfolioAttentionItemDTO {
  id: string;
  severity: PortfolioAttentionSeverity;
  title: string;
  detail?: string;
  instanceId?: string;
  instanceLabel?: string;
  route: string;
  actionLabel: string;
}

export interface PortfolioFailureDTO {
  id: string;
  message: string;
  code?: string;
  metric?: string;
  status?: PortfolioMetricStatus;
  reasonCode?: string | null;
  reasonLabel?: string;
  exclusions?: string[];
  asOf?: string;
  source?: string;
  coverage?: PortfolioMetricCoverageDTO;
  instanceId?: string;
  instanceLabel?: string;
}

export interface PortfolioCacheDTO {
  state: 'fresh' | 'stale';
  cachedAt?: string;
}

export interface PortfolioRefreshDTO {
  state: 'idle' | 'running';
  startedAt?: string;
  completedAt?: string;
  completedInstances: number;
  totalInstances: number;
}

export interface PortfolioOverviewDTO {
  schemaVersion?: number;
  generatedAt?: string;
  servedAt?: string;
  cache?: PortfolioCacheDTO;
  coverage: PortfolioCoverageDTO;
  metrics: PortfolioOverviewMetricsDTO;
  instances: PortfolioInstanceDTO[];
  connections: PortfolioConnectionDTO[];
  attention: PortfolioAttentionItemDTO[];
  failures: PortfolioFailureDTO[];
  duplicateSavedOrigins: DuplicateSavedOriginDTO[];
  warnings: string[];
  partial: boolean;
  stale: boolean;
  refresh: PortfolioRefreshDTO;
}

interface PortfolioRequestOptions {
  signal?: AbortSignal;
}

type UnknownRecord = Record<string, unknown>;

export class PortfolioOverviewContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PortfolioOverviewContractError';
  }
}

function contractFail(label: string): never {
  throw new PortfolioOverviewContractError(`Invalid portfolio overview response: ${label}.`);
}

const METRIC_ALIASES = {
  internalMemberships: ['internalMemberships', 'internalUserMemberships', 'internalUsers', 'memberships.internal'],
  estimatedUniquePeople: ['estimatedUniquePeople', 'estimatedInternalUsers', 'uniqueInternalUsers'],
  embedUsers: ['embedUsers', 'embeddedUsers', 'users.embed', 'users.embedUsers'],
  embedEntities: ['embedEntities', 'embeddedEntities', 'users.embedEntities'],
  active7d: ['active7d', 'activeUsers7d', 'usersActive7d', 'activity.active7d'],
  active30d: ['active30d', 'activeUsers30d', 'usersActive30d', 'activity.active30d'],
  active90d: ['active90d', 'activeUsers90d', 'usersActive90d', 'activity.active90d'],
  dashboards: ['dashboards', 'dashboardCount', 'documents', 'content.dashboards'],
  models: ['models', 'modelCount', 'semanticModels', 'content.models'],
  topics: ['topics', 'topicCount', 'content.topics'],
  aiChats: ['aiChats', 'aiChatCount', 'chatCount', 'chats', 'users.aiChats'],
  apps: ['apps', 'appCount'],
  reportingInstances: ['reportingInstances', 'instancesReporting', 'reporting', 'instanceCount'],
} as const;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null;
}

function readPath(record: UnknownRecord, path: string): unknown {
  let current: unknown = record;
  for (const part of path.split('.')) {
    const row = asRecord(current);
    if (!row || !(part in row)) return undefined;
    current = row[part];
  }
  return current;
}

function firstValue(sources: Array<UnknownRecord | null>, aliases: readonly string[]): unknown {
  for (const source of sources) {
    if (!source) continue;
    for (const alias of aliases) {
      const value = readPath(source, alias);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

function firstString(sources: Array<UnknownRecord | null>, aliases: readonly string[]): string | undefined {
  const value = firstValue(sources, aliases);
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Number(value.replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function toBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1) return true;
  if (value === 'false' || value === 0) return false;
  return null;
}

function normalizedToken(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/[ -]+/g, '_') : '';
}

function parseMetricStatus(value: unknown): PortfolioMetricStatus | undefined {
  const token = normalizedToken(value);
  return [
    'available',
    'partial',
    'permission_denied',
    'unsupported',
    'not_configured',
    'stale',
    'failed',
  ].includes(token) ? token as PortfolioMetricStatus : undefined;
}

function normalizeMetricState(value: unknown, metricValue: number | null, row?: UnknownRecord | null): PortfolioMetricState {
  const token = normalizedToken(value);
  if (['not_configured', 'unconfigured', 'not_supported', 'excluded'].includes(token)) return 'not_configured';
  if (['unavailable', 'failed', 'error', 'offline', 'missing', 'unknown', 'unauthorized', 'permission_denied', 'unsupported'].includes(token)) return 'unavailable';
  if (['partial', 'degraded', 'incomplete', 'warning'].includes(token)) return 'partial';
  if (['stale', 'expired', 'outdated'].includes(token)) return 'stale';
  if (['available', 'complete', 'fresh', 'ready', 'success', 'ok', 'healthy'].includes(token)) return 'available';

  if (row) {
    if (toBoolean(row.configured) === false) return 'not_configured';
    if (toBoolean(row.available) === false || row.error) return 'unavailable';
    if (toBoolean(row.partial) === true) return 'partial';
    if (toBoolean(row.stale) === true) return 'stale';
  }
  return metricValue === null ? 'unavailable' : 'available';
}

function parseStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap((entry) => (
    typeof entry === 'string' && entry.trim() ? [entry.trim()] : []
  )))];
}

function parseMetricCoverage(value: unknown): PortfolioMetricCoverageDTO | undefined {
  if (value === undefined) return undefined;
  const row = asRecord(value);
  if (!row) contractFail('metric coverage');
  const included = row.included;
  const total = row.total;
  const unit = firstString([row], ['unit']);
  if (
    !Number.isSafeInteger(included)
    || (included as number) < 0
    || !Number.isSafeInteger(total)
    || (total as number) < 0
    || (included as number) > (total as number)
    || !['instances', 'connections', 'endpoints', 'model_kinds'].includes(unit || '')
  ) {
    contractFail('metric coverage');
  }
  const expectedRatio = (total as number) === 0 ? null : (included as number) / (total as number);
  const ratioValue = row.ratio === null ? null : typeof row.ratio === 'number' && Number.isFinite(row.ratio) ? row.ratio : undefined;
  if (
    ratioValue === undefined
    || (expectedRatio === null ? ratioValue !== null : ratioValue === null || Math.abs(ratioValue - expectedRatio) > 1e-12)
  ) {
    contractFail('metric coverage ratio');
  }
  return {
    included: included as number,
    total: total as number,
    unit: unit as PortfolioCoverageUnit,
    ratio: ratioValue,
  };
}

function parseMetric(value: unknown): PortfolioMetricDTO {
  const directValue = toFiniteNumber(value);
  if (directValue !== null) return { value: directValue, status: 'available', state: 'available' };

  const row = asRecord(value);
  if (!row) return { value: null, state: 'unavailable' };
  const rawMetricValue = toFiniteNumber(firstValue([row], ['value', 'count', 'total', 'metricValue']));
  const coverageValue = firstValue([row], ['coverageLabel', 'qualifier', 'coverage', 'coverageText']);
  const coverageLabel = typeof coverageValue === 'string' && coverageValue.trim() ? coverageValue.trim() : undefined;
  const reasonLabel = firstString([row], ['reasonLabel']);
  const detail = firstString([row], ['detail', 'message', 'reasonLabel', 'reason', 'error']);
  const asOf = firstString([row], ['asOf', 'refreshedAt', 'updatedAt', 'generatedAt', 'collectedAt']);
  const stateValue = firstValue([row], ['state', 'availability', 'quality', 'status', 'freshness']);
  const status = parseMetricStatus(firstValue([row], ['status', 'state', 'availability', 'quality']));
  const state = normalizeMetricState(status || stateValue, rawMetricValue, row);
  const metricValue = ['unavailable', 'unauthorized', 'permission_denied', 'unsupported', 'not_configured', 'failed'].includes(status || normalizedToken(stateValue))
    ? null
    : rawMetricValue;
  const metricCoverage = parseMetricCoverage(row.coverage);
  const reasonCodeValue = firstValue([row], ['reasonCode', 'reason_code']);
  const reasonCode = reasonCodeValue === null
    ? null
    : typeof reasonCodeValue === 'string' && reasonCodeValue.trim()
      ? reasonCodeValue.trim()
      : undefined;

  return {
    value: metricValue,
    ...(status ? { status } : {}),
    state,
    ...(metricCoverage ? { coverage: metricCoverage } : {}),
    coverageLabel,
    asOf,
    exclusions: parseStringList(row.exclusions),
    ...(reasonCode !== undefined ? { reasonCode } : {}),
    reasonLabel,
    source: firstString([row], ['source', 'evidenceSource', 'provenance']),
    detail,
  };
}

function metricFromSources(sources: Array<UnknownRecord | null>, aliases: readonly string[]): PortfolioMetricDTO {
  return parseMetric(firstValue(sources, aliases));
}

function canonicalLifecycleMetric(row: UnknownRecord, key: 'staleUsers90d' | 'neverLoggedInUsers'): PortfolioMetricDTO {
  return parseMetric(asRecord(row.metrics)?.[key]);
}

function emptyMetricSet(): PortfolioMetricSetDTO {
  const unavailable = (): PortfolioMetricDTO => ({ value: null, state: 'unavailable' });
  return {
    internalMemberships: unavailable(),
    estimatedUniquePeople: unavailable(),
    embedUsers: unavailable(),
    embedEntities: unavailable(),
    active7d: unavailable(),
    active30d: unavailable(),
    active90d: unavailable(),
    staleUsers90d: unavailable(),
    neverLoggedInUsers: unavailable(),
    dashboards: unavailable(),
    models: unavailable(),
    topics: unavailable(),
    aiChats: unavailable(),
    apps: unavailable(),
  };
}

function parseMetricSet(row: UnknownRecord): PortfolioMetricSetDTO {
  const sources = [
    asRecord(row.metrics),
    asRecord(row.totals),
    asRecord(row.userMetrics),
    asRecord(row.users),
    asRecord(row.engagement),
    asRecord(row.activity),
    asRecord(row.content),
    row,
  ];
  return {
    internalMemberships: metricFromSources(sources, METRIC_ALIASES.internalMemberships),
    estimatedUniquePeople: metricFromSources(sources, METRIC_ALIASES.estimatedUniquePeople),
    embedUsers: metricFromSources(sources, METRIC_ALIASES.embedUsers),
    embedEntities: metricFromSources(sources, METRIC_ALIASES.embedEntities),
    active7d: metricFromSources(sources, METRIC_ALIASES.active7d),
    active30d: metricFromSources(sources, METRIC_ALIASES.active30d),
    active90d: metricFromSources(sources, METRIC_ALIASES.active90d),
    staleUsers90d: canonicalLifecycleMetric(row, 'staleUsers90d'),
    neverLoggedInUsers: canonicalLifecycleMetric(row, 'neverLoggedInUsers'),
    dashboards: metricFromSources(sources, METRIC_ALIASES.dashboards),
    models: metricFromSources(sources, METRIC_ALIASES.models),
    topics: metricFromSources(sources, METRIC_ALIASES.topics),
    aiChats: metricFromSources(sources, METRIC_ALIASES.aiChats),
    apps: metricFromSources(sources, METRIC_ALIASES.apps),
  };
}

function rowsFromValue(value: unknown): UnknownRecord[] {
  if (Array.isArray(value)) return value.map(asRecord).filter((row): row is UnknownRecord => Boolean(row));
  const record = asRecord(value);
  if (!record) return [];
  return Object.entries(record).flatMap(([key, entry]) => {
    const row = asRecord(entry);
    return row ? [{ id: key, ...row }] : [];
  });
}

function rowsAtPaths(root: UnknownRecord, paths: readonly string[]): UnknownRecord[] {
  for (const path of paths) {
    const rows = rowsFromValue(readPath(root, path));
    if (rows.length > 0) return rows;
  }
  return [];
}

function normalizeHealth(value: unknown, hasError: boolean): PortfolioHealth {
  if (hasError) return 'unavailable';
  const token = typeof value === 'string' ? value.trim().toLowerCase().replace(/[ -]+/g, '_') : '';
  if (['healthy', 'ready', 'success', 'ok', 'complete', 'available'].includes(token)) return 'healthy';
  if (['attention', 'warning', 'partial', 'degraded', 'stale', 'incomplete'].includes(token)) return 'attention';
  if (['unavailable', 'offline', 'failed', 'error', 'blocked'].includes(token)) return 'unavailable';
  return 'unknown';
}

function normalizeFreshness(value: unknown, asOf?: string): PortfolioMetricState {
  const state = normalizeMetricState(value, asOf ? 1 : null);
  return state === 'not_configured' ? 'unavailable' : state;
}

function parseConnectionAttribution(value: unknown): PortfolioConnectionAttribution {
  const token = normalizedToken(value);
  if (token === 'explicit' || token === 'inferred') return token;
  return 'unknown';
}

function normalizeReadiness(value: unknown, hasError: boolean): PortfolioConnectionReadiness {
  if (hasError) return 'unavailable';
  const token = typeof value === 'string' ? value.trim().toLowerCase().replace(/[ -]+/g, '_') : '';
  if (['ready', 'healthy', 'success', 'ok', 'complete'].includes(token)) return 'ready';
  if (['attention', 'warning', 'partial', 'degraded', 'missing_schema_model', 'schema_model_stuck', 'incomplete'].includes(token)) return 'attention';
  if (['unavailable', 'offline', 'failed', 'error', 'blocked'].includes(token)) return 'unavailable';
  return 'unknown';
}

function readinessLabel(readiness: PortfolioConnectionReadiness): string {
  if (readiness === 'ready') return 'Ready';
  if (readiness === 'attention') return 'Needs attention';
  if (readiness === 'unavailable') return 'Unavailable';
  return 'Unknown';
}

function healthLabel(health: PortfolioHealth): string {
  if (health === 'healthy') return 'Healthy';
  if (health === 'attention') return 'Needs attention';
  if (health === 'unavailable') return 'Unavailable';
  return 'Unknown';
}

function parseConnection(row: UnknownRecord, fallbackInstance?: { id: string; label: string }): PortfolioConnectionDTO {
  const nested = asRecord(row.connection);
  const sources = [nested, row];
  const id = firstString(sources, ['id', 'connectionId', 'identifier', 'name']) || 'unknown-connection';
  const name = firstString(sources, ['name', 'label', 'connectionName', 'database']) || 'Unnamed connection';
  const instanceId = firstString(sources, ['instanceId', 'savedInstanceId']) || fallbackInstance?.id || 'unknown-instance';
  const instanceLabel = firstString(sources, ['instanceLabel', 'savedInstanceLabel']) || fallbackInstance?.label || 'Unknown instance';
  const detail = firstString(sources, ['detail', 'message', 'reason', 'error']);
  const readinessValue = firstValue(sources, ['readiness', 'health', 'status', 'state']);
  const readiness = normalizeReadiness(readinessValue, Boolean(detail && firstValue(sources, ['error'])));
  const asOf = firstString(sources, ['asOf', 'refreshedAt', 'updatedAt', 'collectedAt']);
  const freshnessValue = firstValue(sources, ['freshness', 'quality']);
  const metrics = parseMetricSet(row);

  return {
    id,
    name,
    instanceId,
    instanceLabel,
    readiness,
    statusLabel: firstString(sources, ['statusLabel', 'readinessLabel', 'healthLabel']) || readinessLabel(readiness),
    freshness: normalizeFreshness(freshnessValue, asOf),
    freshnessStatus: parseMetricStatus(freshnessValue),
    asOf,
    attribution: parseConnectionAttribution(firstValue(sources, ['attribution', 'attributionConfidence'])),
    dashboards: metrics.dashboards,
    models: metrics.models,
    topics: metrics.topics,
    detail,
  };
}

function parseInstance(row: UnknownRecord): PortfolioInstanceDTO {
  const nested = asRecord(row.instance);
  const sources = [nested, row];
  const id = firstString(sources, ['id', 'instanceId', 'savedInstanceId', 'identifier']) || 'unknown-instance';
  const label = firstString(sources, ['label', 'name', 'instanceLabel']) || 'Unnamed instance';
  const detail = firstString(sources, ['detail', 'message', 'reason', 'error']);
  const healthValue = firstValue(sources, ['health', 'status', 'state']);
  const health = normalizeHealth(healthValue, Boolean(firstValue(sources, ['error'])));
  const asOf = firstString(sources, ['asOf', 'refreshedAt', 'updatedAt', 'collectedAt']);
  const freshnessValue = firstValue(sources, ['freshness', 'quality']);
  const connections = rowsAtPaths(row, ['connections', 'contentByConnection', 'connectionMetrics'])
    .map((connection) => parseConnection(connection, { id, label }));

  return {
    id,
    label,
    role: firstString(sources, ['role', 'instanceRole']),
    health,
    statusLabel: firstString(sources, ['statusLabel', 'healthLabel']) || healthLabel(health),
    freshness: normalizeFreshness(freshnessValue, asOf),
    freshnessStatus: parseMetricStatus(freshnessValue),
    asOf,
    duplicateSavedOrigin: toBoolean(firstValue(sources, ['duplicateSavedOrigin'])) === true,
    duplicateSavedOriginCount: Math.max(1, Math.trunc(toFiniteNumber(firstValue(sources, ['duplicateSavedOriginCount'])) ?? 1)),
    duplicateInstanceLabels: parseStringList(firstValue(sources, ['duplicateInstanceLabels'])),
    detail,
    metrics: parseMetricSet(row),
    connections,
  };
}

function parseCoverage(root: UnknownRecord, instances: PortfolioInstanceDTO[]): PortfolioCoverageDTO {
  const coverage = asRecord(root.coverage);
  if (!coverage) contractFail('coverage');
  for (const key of ['totalInstances', 'reportingInstances', 'partialInstances', 'staleInstances', 'unavailableInstances']) {
    if (!Object.prototype.hasOwnProperty.call(coverage, key) || coverage[key] === undefined) {
      contractFail(`coverage.${key}`);
    }
  }
  const sources = [coverage, asRecord(root.summary), root];
  const inferredReporting = instances.filter((instance) => (
    instance.health !== 'unavailable'
    && Object.values(instance.metrics).some((metric) => metric.value !== null)
  )).length;

  const count = (aliases: readonly string[], label: string, fallback?: number): number | undefined => {
    const value = firstValue(sources, aliases);
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || (value as number) < 0) contractFail(`coverage.${label}`);
    return value as number;
  };

  const total = count(['totalInstances', 'configuredInstances', 'instancesTotal', 'total'], 'totalInstances', instances.length)!;
  const reporting = count(['reportingInstances', 'instancesReporting', 'reporting'], 'reportingInstances', inferredReporting)!;
  const partial = count(['partialInstances', 'instancesPartial', 'partial'], 'partialInstances', instances.filter((instance) => instance.health === 'attention').length)!;
  const stale = count(['staleInstances', 'instancesStale', 'stale'], 'staleInstances', instances.filter((instance) => instance.freshness === 'stale').length)!;
  const unavailable = count(['unavailableInstances', 'failedInstances', 'instancesUnavailable', 'unavailable', 'failed'], 'unavailableInstances', instances.filter((instance) => instance.health === 'unavailable').length)!;
  const saved = count(['savedInstances', 'configuredSavedInstances'], 'savedInstances');
  const duplicateOrigins = count(['duplicateSavedOrigins', 'duplicateOrigins'], 'duplicateSavedOrigins');

  if (
    reporting > total
    || partial > reporting
    || stale > reporting
    || unavailable > total
    || reporting + unavailable > total
    || (saved !== undefined && saved < total)
    || (duplicateOrigins !== undefined && (duplicateOrigins > total || duplicateOrigins > (saved ?? total)))
  ) {
    contractFail('coverage partitions');
  }

  return {
    totalInstances: total,
    reportingInstances: reporting,
    partialInstances: partial,
    staleInstances: stale,
    unavailableInstances: unavailable,
    ...(saved !== undefined ? { savedInstances: saved } : {}),
    ...(duplicateOrigins !== undefined ? { duplicateSavedOrigins: duplicateOrigins } : {}),
  };
}

function oldestTimestamp(metrics: PortfolioMetricDTO[]): string | undefined {
  const timestamps = metrics
    .map((metric) => metric.asOf)
    .filter((value): value is string => Boolean(value))
    .filter((value) => Number.isFinite(new Date(value).getTime()))
    .sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
  return timestamps[0];
}

function aggregateMetric(metrics: PortfolioMetricDTO[], expectedCount: number): PortfolioMetricDTO {
  const reporting = metrics.filter((metric) => metric.value !== null && metric.state !== 'not_configured');
  if (reporting.length === 0) return { value: null, state: 'unavailable' };
  const hasPartial = reporting.some((metric) => metric.state === 'partial') || reporting.length < expectedCount;
  const hasStale = reporting.some((metric) => metric.state === 'stale');
  const status: PortfolioMetricStatus = hasPartial ? 'partial' : hasStale ? 'stale' : 'available';
  return {
    value: reporting.reduce((sum, metric) => sum + (metric.value ?? 0), 0),
    status,
    state: status,
    coverageLabel: reporting.length < expectedCount ? `${reporting.length} of ${expectedCount} instances` : undefined,
    asOf: oldestTimestamp(reporting),
  };
}

function globalMetric(
  sources: Array<UnknownRecord | null>,
  aliases: readonly string[],
  instances: PortfolioInstanceDTO[],
  select: (metrics: PortfolioMetricSetDTO) => PortfolioMetricDTO,
): PortfolioMetricDTO {
  const raw = firstValue(sources, aliases);
  if (raw !== undefined) return parseMetric(raw);
  return aggregateMetric(instances.map((instance) => select(instance.metrics)), instances.length);
}

function globalLifecycleMetric(
  root: UnknownRecord,
  key: 'staleUsers90d' | 'neverLoggedInUsers',
  instances: PortfolioInstanceDTO[],
): PortfolioMetricDTO {
  const raw = asRecord(root.metrics)?.[key];
  if (raw !== undefined) return parseMetric(raw);
  return aggregateMetric(instances.map((instance) => instance.metrics[key]), instances.length);
}

function qualifyForCoverage(metric: PortfolioMetricDTO, coverage: PortfolioCoverageDTO): PortfolioMetricDTO {
  if (metric.state !== 'available' || coverage.totalInstances <= coverage.reportingInstances) return metric;
  return {
    ...metric,
    ...(!metric.status ? { status: 'partial' as const } : {}),
    state: 'partial',
    coverageLabel: metric.coverageLabel || `${coverage.reportingInstances} of ${coverage.totalInstances} instances`,
  };
}

function parseMessages(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === 'string' && entry.trim()) return [entry.trim()];
    const row = asRecord(entry);
    const message = row ? firstString([row], ['message', 'detail', 'error', 'reason', 'title']) : undefined;
    return message ? [message] : [];
  });
}

function parseFailures(root: UnknownRecord): PortfolioFailureDTO[] {
  const rows = rowsAtPaths(root, ['failures', 'errors', 'coverage.failures', 'coverage.errors']);
  return rows.map((row, index) => {
    const code = firstString([row], ['code']);
    const reasonCodeValue = firstValue([row], ['reasonCode', 'reason_code']);
    const reasonCode = reasonCodeValue === null
      ? null
      : typeof reasonCodeValue === 'string' && reasonCodeValue.trim()
        ? reasonCodeValue.trim()
        : undefined;
    const status = parseMetricStatus(firstValue([row], ['status', 'state']));
    return {
      id: firstString([row], ['id', 'code']) || `failure-${index + 1}`,
      message: firstString([row], ['message', 'detail', 'error', 'reasonLabel', 'reason', 'title']) || 'A portfolio source could not be read.',
      code,
      metric: firstString([row], ['metric', 'metricKey']),
      ...(status ? { status } : {}),
      ...(reasonCode !== undefined ? { reasonCode } : {}),
      reasonLabel: firstString([row], ['reasonLabel']),
      exclusions: parseStringList(row.exclusions),
      asOf: firstString([row], ['asOf', 'collectedAt', 'generatedAt']),
      source: firstString([row], ['source', 'evidenceSource', 'provenance']),
      coverage: parseMetricCoverage(row.coverage),
      instanceId: firstString([row], ['instanceId', 'savedInstanceId']),
      instanceLabel: firstString([row], ['instanceLabel', 'savedInstanceLabel']),
    };
  });
}

function parseDuplicateSavedOrigins(root: UnknownRecord): DuplicateSavedOriginDTO[] {
  return rowsAtPaths(root, ['duplicateSavedOrigins']).map((row) => ({
    canonicalInstanceId: firstString([row], ['canonicalInstanceId', 'instanceId']) || 'unknown-instance',
    instanceLabels: parseStringList(firstValue([row], ['instanceLabels', 'labels'])),
    savedInstanceCount: Math.max(0, Math.trunc(toFiniteNumber(firstValue([row], ['savedInstanceCount', 'count'])) ?? 0)),
  }));
}

function parseCache(root: UnknownRecord): PortfolioCacheDTO | undefined {
  const row = asRecord(root.cache);
  if (!row) return undefined;
  const state = normalizedToken(row.state);
  if (state !== 'fresh' && state !== 'stale') return undefined;
  return {
    state,
    cachedAt: firstString([row], ['cachedAt', 'storedAt']),
  };
}

const SAFE_ATTENTION_ROUTE_PATHS: Readonly<Record<string, string>> = {
  '/instances': '/admin/fleet/instances',
  '/connections': '/admin/fleet/connections',
  '/users': '/admin/identity/users',
  '/content-health': '/admin/content/health',
  '/admin/fleet/instances': '/admin/fleet/instances',
  '/admin/fleet/connections': '/admin/fleet/connections',
  '/admin/identity/users': '/admin/identity/users',
  '/admin/content/health': '/admin/content/health',
  '/models': '/models',
  '/topics': '/topics',
  '/dashboards/operations': '/dashboards/operations',
};

function normalizeSafeAttentionRoute(value: unknown): { route: string; pathname: string } | null {
  const route = typeof value === 'string' ? value.trim() : '';
  if (!route.startsWith('/') || route.startsWith('//')) return null;

  try {
    const parsed = new URL(route, 'https://omnikit.local');
    if (parsed.origin !== 'https://omnikit.local') return null;
    const pathname = SAFE_ATTENTION_ROUTE_PATHS[parsed.pathname];
    if (!pathname) return null;
    return {
      route: `${pathname}${parsed.search}${parsed.hash}`,
      pathname,
    };
  } catch {
    return null;
  }
}

function safeRoute(value: unknown, area?: string): { route: string; label: string } {
  const normalized = normalizeSafeAttentionRoute(value);
  if (normalized) {
    return {
      route: normalized.route,
      label: normalized.pathname === '/admin/fleet/instances' ? 'Manage instances' : 'Review details',
    };
  }
  const token = (area || '').toLowerCase();
  if (token.includes('connection')) return { route: '/admin/fleet/connections', label: 'Review connections' };
  if (token.includes('model')) return { route: '/models', label: 'Review models' };
  if (token.includes('topic')) return { route: '/topics', label: 'Review topics' };
  if (token.includes('content') || token.includes('dashboard')) return { route: '/admin/content/health', label: 'Review content' };
  if (token.includes('user') || token.includes('chat') || token.includes('membership')) return { route: '/admin/identity/users?tab=health', label: 'Review users' };
  return { route: '/admin/fleet/instances', label: 'Manage instances' };
}

function parseAttention(root: UnknownRecord): PortfolioAttentionItemDTO[] {
  const source = firstValue([root, asRecord(root.summary)], ['attention', 'needsAttention', 'attentionItems', 'issues']);
  const entries = Array.isArray(source) ? source : [];
  return entries.flatMap<PortfolioAttentionItemDTO>((entry, index) => {
    if (typeof entry === 'string' && entry.trim()) {
      return [{
        id: `attention-${index + 1}`,
        severity: 'warning' as const,
        title: entry.trim(),
        route: '/admin/fleet/instances',
        actionLabel: 'Manage instances',
      }];
    }
    const row = asRecord(entry);
    if (!row) return [];
    const severityValue = firstString([row], ['severity', 'level', 'status'])?.toLowerCase();
    const severity: PortfolioAttentionSeverity = severityValue === 'critical' || severityValue === 'error'
      ? 'critical'
      : severityValue === 'info'
        ? 'info'
        : 'warning';
    const area = firstString([row], ['area', 'metric', 'type', 'scope']);
    const target = safeRoute(firstValue([row], ['route', 'href', 'path']), area);
    return [{
      id: firstString([row], ['id', 'code']) || `attention-${index + 1}`,
      severity,
      title: firstString([row], ['title', 'message', 'label']) || 'Portfolio data needs review',
      detail: firstString([row], ['detail', 'description', 'reason']),
      instanceId: firstString([row], ['instanceId', 'savedInstanceId']),
      instanceLabel: firstString([row], ['instanceLabel', 'savedInstanceLabel']),
      route: target.route,
      actionLabel: firstString([row], ['actionLabel', 'ctaLabel']) || target.label,
    }];
  });
}

function unwrapPayload(payload: unknown): UnknownRecord {
  const root = asRecord(payload) || {};
  const overview = asRecord(root.overview);
  if (overview) return overview;
  const data = asRecord(root.data);
  if (data) return asRecord(data.overview) || data;
  return root;
}

function parseRefresh(
  payload: unknown,
  root: UnknownRecord,
  coverage: PortfolioCoverageDTO,
): PortfolioRefreshDTO {
  const envelope = asRecord(payload);
  const data = envelope ? asRecord(envelope.data) : null;
  const meta = asRecord(root.meta);
  const sources = [
    asRecord(root.refresh),
    envelope ? asRecord(envelope.refresh) : null,
    data ? asRecord(data.refresh) : null,
    meta ? asRecord(meta.refresh) : null,
  ];
  const stateToken = firstString(sources, ['state', 'status'])?.toLowerCase().replace(/[ -]+/g, '_');
  const state: PortfolioRefreshDTO['state'] = ['running', 'refreshing', 'in_progress', 'collecting'].includes(stateToken || '')
    ? 'running'
    : 'idle';
  const parsedTotal = toFiniteNumber(firstValue(sources, ['totalInstances', 'total', 'instanceCount']));
  const totalInstances = Math.max(0, Math.trunc(parsedTotal ?? coverage.totalInstances));
  const parsedCompleted = toFiniteNumber(firstValue(sources, ['completedInstances', 'completed', 'instancesCompleted']));
  const completedDefault = state === 'idle' ? totalInstances : 0;
  const completedInstances = Math.min(
    totalInstances,
    Math.max(0, Math.trunc(parsedCompleted ?? completedDefault)),
  );

  return {
    state,
    startedAt: firstString(sources, ['startedAt', 'refreshStartedAt']),
    completedAt: firstString(sources, ['completedAt', 'refreshCompletedAt']),
    completedInstances,
    totalInstances,
  };
}

export function parsePortfolioOverview(payload: unknown): PortfolioOverviewDTO {
  const root = unwrapPayload(payload);
  const canonicalMetrics = asRecord(root.metrics);
  if (!canonicalMetrics || !Object.prototype.hasOwnProperty.call(canonicalMetrics, 'reportingInstances')) {
    contractFail('metrics.reportingInstances');
  }
  const instances = rowsAtPaths(root, ['instances', 'instanceMetrics', 'byInstance', 'breakdowns.instances'])
    .map(parseInstance);

  const connectionRows = rowsAtPaths(root, ['connections', 'contentByConnection', 'connectionMetrics', 'byConnection', 'breakdowns.connections']);
  const connectionMap = new Map<string, PortfolioConnectionDTO>();
  for (const instance of instances) {
    for (const connection of instance.connections) {
      connectionMap.set(`${connection.instanceId}:${connection.id}`, connection);
    }
  }
  for (const row of connectionRows) {
    const connection = parseConnection(row);
    connectionMap.set(`${connection.instanceId}:${connection.id}`, connection);
  }
  const connections = [...connectionMap.values()];
  const coverage = parseCoverage(root, instances);
  const metricSources = [asRecord(root.metrics), asRecord(root.kpis), asRecord(root.totals), asRecord(root.summary), root];
  const reportingMetric = parseMetric(canonicalMetrics.reportingInstances);
  if (
    reportingMetric.value === null
    || !Number.isSafeInteger(reportingMetric.value)
    || reportingMetric.value < 0
    || reportingMetric.value !== coverage.reportingInstances
    || (reportingMetric.coverage !== undefined && (
      reportingMetric.coverage.unit !== 'instances'
      || reportingMetric.coverage.included !== coverage.reportingInstances
      || reportingMetric.coverage.total !== coverage.totalInstances
    ))
  ) {
    contractFail('metrics.reportingInstances');
  }
  const metrics: PortfolioOverviewMetricsDTO = {
    reportingInstances: reportingMetric,
    internalMemberships: qualifyForCoverage(globalMetric(metricSources, METRIC_ALIASES.internalMemberships, instances, (row) => row.internalMemberships), coverage),
    estimatedUniquePeople: qualifyForCoverage(globalMetric(metricSources, METRIC_ALIASES.estimatedUniquePeople, instances, (row) => row.estimatedUniquePeople), coverage),
    embedUsers: qualifyForCoverage(globalMetric(metricSources, METRIC_ALIASES.embedUsers, instances, (row) => row.embedUsers), coverage),
    embedEntities: qualifyForCoverage(globalMetric(metricSources, METRIC_ALIASES.embedEntities, instances, (row) => row.embedEntities), coverage),
    active7d: qualifyForCoverage(globalMetric(metricSources, METRIC_ALIASES.active7d, instances, (row) => row.active7d), coverage),
    active30d: qualifyForCoverage(globalMetric(metricSources, METRIC_ALIASES.active30d, instances, (row) => row.active30d), coverage),
    active90d: qualifyForCoverage(globalMetric(metricSources, METRIC_ALIASES.active90d, instances, (row) => row.active90d), coverage),
    staleUsers90d: qualifyForCoverage(globalLifecycleMetric(root, 'staleUsers90d', instances), coverage),
    neverLoggedInUsers: qualifyForCoverage(globalLifecycleMetric(root, 'neverLoggedInUsers', instances), coverage),
    dashboards: qualifyForCoverage(globalMetric(metricSources, METRIC_ALIASES.dashboards, instances, (row) => row.dashboards), coverage),
    models: qualifyForCoverage(globalMetric(metricSources, METRIC_ALIASES.models, instances, (row) => row.models), coverage),
    topics: qualifyForCoverage(globalMetric(metricSources, METRIC_ALIASES.topics, instances, (row) => row.topics), coverage),
    aiChats: qualifyForCoverage(globalMetric(metricSources, METRIC_ALIASES.aiChats, instances, (row) => row.aiChats), coverage),
    apps: qualifyForCoverage(globalMetric(metricSources, METRIC_ALIASES.apps, instances, (row) => row.apps), coverage),
  };
  const failures = parseFailures(root);
  const warnings = [
    ...parseMessages(root.warnings),
    ...parseMessages(readPath(root, 'coverage.warnings')),
  ];
  const partial = toBoolean(root.partial) === true
    || failures.length > 0
    || coverage.reportingInstances < coverage.totalInstances
    || coverage.partialInstances > 0
    || coverage.unavailableInstances > 0;
  const stale = toBoolean(root.stale) === true
    || coverage.staleInstances > 0
    || Object.values(metrics).some((metric) => metric.state === 'stale');
  const refresh = parseRefresh(payload, root, coverage);
  const schemaVersion = toFiniteNumber(root.schemaVersion);

  return {
    ...(schemaVersion !== null ? { schemaVersion: Math.trunc(schemaVersion) } : {}),
    generatedAt: firstString([root, asRecord(root.meta)], ['generatedAt', 'refreshedAt', 'asOf', 'updatedAt']),
    servedAt: firstString([root, asRecord(root.meta)], ['servedAt']),
    cache: parseCache(root),
    coverage,
    metrics,
    instances,
    connections,
    attention: parseAttention(root),
    failures,
    duplicateSavedOrigins: parseDuplicateSavedOrigins(root),
    warnings: [...new Set(warnings)],
    partial,
    stale,
    refresh,
  };
}

async function portfolioRequest(refresh: boolean, options: PortfolioRequestOptions = {}): Promise<PortfolioOverviewDTO> {
  const path = refresh ? '/api/portfolio-overview?refresh=true' : '/api/portfolio-overview';
  const response = await fetch(path, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: options.signal,
  });

  if (!response.ok) {
    let message = `Portfolio overview failed (HTTP ${response.status})`;
    let detail = '';
    try {
      const body = await response.json() as { error?: string; message?: string; detail?: string };
      message = body.error || body.message || message;
      detail = body.detail || '';
    } catch {
      detail = await response.text().catch(() => '');
    }
    if (response.status === 423) emitVaultLocked(message);
    throw new ApiError(response.status, message, detail || undefined);
  }

  return parsePortfolioOverview(await response.json() as unknown);
}

export function getPortfolioOverview(options: PortfolioRequestOptions = {}): Promise<PortfolioOverviewDTO> {
  return portfolioRequest(false, options);
}

export function refreshPortfolioOverview(options: PortfolioRequestOptions = {}): Promise<PortfolioOverviewDTO> {
  return portfolioRequest(true, options);
}

export function createUnavailablePortfolioOverview(): PortfolioOverviewDTO {
  return {
    coverage: {
      totalInstances: 0,
      reportingInstances: 0,
      partialInstances: 0,
      staleInstances: 0,
      unavailableInstances: 0,
    },
    metrics: {
      reportingInstances: { value: null, state: 'unavailable' },
      ...emptyMetricSet(),
    },
    instances: [],
    connections: [],
    attention: [],
    failures: [],
    duplicateSavedOrigins: [],
    warnings: [],
    partial: false,
    stale: false,
    refresh: {
      state: 'idle',
      completedInstances: 0,
      totalInstances: 0,
    },
  };
}

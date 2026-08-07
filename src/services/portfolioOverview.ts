import { ApiError } from '@/services/omniApi';
import { emitVaultLocked } from '@/services/vaultEvents';

export type PortfolioMetricState = 'available' | 'partial' | 'stale' | 'unavailable' | 'not_configured';
export type PortfolioHealth = 'healthy' | 'attention' | 'unavailable' | 'unknown';
export type PortfolioConnectionReadiness = 'ready' | 'attention' | 'unavailable' | 'unknown';
export type PortfolioAttentionSeverity = 'critical' | 'warning' | 'info';

export interface PortfolioMetricDTO {
  value: number | null;
  state: PortfolioMetricState;
  coverageLabel?: string;
  asOf?: string;
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
  asOf?: string;
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
  asOf?: string;
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
  instanceId?: string;
  instanceLabel?: string;
}

export interface PortfolioRefreshDTO {
  state: 'idle' | 'running';
  startedAt?: string;
  completedAt?: string;
  completedInstances: number;
  totalInstances: number;
}

export interface PortfolioOverviewDTO {
  generatedAt?: string;
  coverage: PortfolioCoverageDTO;
  metrics: PortfolioOverviewMetricsDTO;
  instances: PortfolioInstanceDTO[];
  connections: PortfolioConnectionDTO[];
  attention: PortfolioAttentionItemDTO[];
  failures: PortfolioFailureDTO[];
  warnings: string[];
  partial: boolean;
  stale: boolean;
  refresh: PortfolioRefreshDTO;
}

interface PortfolioRequestOptions {
  signal?: AbortSignal;
}

type UnknownRecord = Record<string, unknown>;

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

function normalizeMetricState(value: unknown, metricValue: number | null, row?: UnknownRecord | null): PortfolioMetricState {
  const token = typeof value === 'string' ? value.trim().toLowerCase().replace(/[ -]+/g, '_') : '';
  if (['not_configured', 'unconfigured', 'not_supported', 'excluded'].includes(token)) return 'not_configured';
  if (['unavailable', 'failed', 'error', 'offline', 'missing', 'unknown', 'permission_denied', 'unsupported'].includes(token)) return 'unavailable';
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

function parseMetric(value: unknown): PortfolioMetricDTO {
  const directValue = toFiniteNumber(value);
  if (directValue !== null) return { value: directValue, state: 'available' };

  const row = asRecord(value);
  if (!row) return { value: null, state: 'unavailable' };
  const metricValue = toFiniteNumber(firstValue([row], ['value', 'count', 'total', 'metricValue']));
  const coverageValue = firstValue([row], ['coverageLabel', 'qualifier', 'coverage', 'coverageText']);
  const coverageLabel = typeof coverageValue === 'string' && coverageValue.trim() ? coverageValue.trim() : undefined;
  const detail = firstString([row], ['detail', 'message', 'reasonLabel', 'reason', 'error']);
  const asOf = firstString([row], ['asOf', 'refreshedAt', 'updatedAt', 'generatedAt', 'collectedAt']);
  const stateValue = firstValue([row], ['state', 'availability', 'quality', 'status', 'freshness']);

  return {
    value: metricValue,
    state: normalizeMetricState(stateValue, metricValue, row),
    coverageLabel,
    asOf,
    detail,
  };
}

function metricFromSources(sources: Array<UnknownRecord | null>, aliases: readonly string[]): PortfolioMetricDTO {
  return parseMetric(firstValue(sources, aliases));
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
  const metrics = parseMetricSet(row);

  return {
    id,
    name,
    instanceId,
    instanceLabel,
    readiness,
    statusLabel: firstString(sources, ['statusLabel', 'readinessLabel', 'healthLabel']) || readinessLabel(readiness),
    freshness: normalizeFreshness(firstValue(sources, ['freshness', 'quality']), asOf),
    asOf,
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
  const connections = rowsAtPaths(row, ['connections', 'contentByConnection', 'connectionMetrics'])
    .map((connection) => parseConnection(connection, { id, label }));

  return {
    id,
    label,
    role: firstString(sources, ['role', 'instanceRole']),
    health,
    statusLabel: firstString(sources, ['statusLabel', 'healthLabel']) || healthLabel(health),
    freshness: normalizeFreshness(firstValue(sources, ['freshness', 'quality']), asOf),
    asOf,
    detail,
    metrics: parseMetricSet(row),
    connections,
  };
}

function parseCoverage(root: UnknownRecord, instances: PortfolioInstanceDTO[]): PortfolioCoverageDTO {
  const coverage = asRecord(root.coverage);
  const sources = [coverage, asRecord(root.summary), root];
  const total = toFiniteNumber(firstValue(sources, ['totalInstances', 'configuredInstances', 'instancesTotal', 'total']));
  const reporting = toFiniteNumber(firstValue(sources, ['reportingInstances', 'instancesReporting', 'reporting']));
  const partial = toFiniteNumber(firstValue(sources, ['partialInstances', 'instancesPartial', 'partial']));
  const stale = toFiniteNumber(firstValue(sources, ['staleInstances', 'instancesStale', 'stale']));
  const unavailable = toFiniteNumber(firstValue(sources, ['unavailableInstances', 'failedInstances', 'instancesUnavailable', 'unavailable', 'failed']));
  const inferredReporting = instances.filter((instance) => (
    instance.health !== 'unavailable'
    && Object.values(instance.metrics).some((metric) => metric.value !== null)
  )).length;

  return {
    totalInstances: Math.max(0, Math.trunc(total ?? instances.length)),
    reportingInstances: Math.max(0, Math.trunc(reporting ?? inferredReporting)),
    partialInstances: Math.max(0, Math.trunc(partial ?? instances.filter((instance) => instance.health === 'attention').length)),
    staleInstances: Math.max(0, Math.trunc(stale ?? instances.filter((instance) => instance.freshness === 'stale').length)),
    unavailableInstances: Math.max(0, Math.trunc(unavailable ?? instances.filter((instance) => instance.health === 'unavailable').length)),
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
  return {
    value: reporting.reduce((sum, metric) => sum + (metric.value ?? 0), 0),
    state: hasPartial ? 'partial' : hasStale ? 'stale' : 'available',
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

function qualifyForCoverage(metric: PortfolioMetricDTO, coverage: PortfolioCoverageDTO): PortfolioMetricDTO {
  if (metric.state !== 'available' || coverage.totalInstances <= coverage.reportingInstances) return metric;
  return {
    ...metric,
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
  return rows.map((row, index) => ({
    id: firstString([row], ['id', 'code']) || `failure-${index + 1}`,
    message: firstString([row], ['message', 'detail', 'error', 'reason', 'title']) || 'A portfolio source could not be read.',
    instanceId: firstString([row], ['instanceId', 'savedInstanceId']),
    instanceLabel: firstString([row], ['instanceLabel', 'savedInstanceLabel']),
  }));
}

function safeRoute(value: unknown, area?: string): { route: string; label: string } {
  const route = typeof value === 'string' ? value.trim() : '';
  const allowed = ['/users', '/connections', '/models', '/topics', '/content-health', '/dashboards/operations', '/instances'];
  if (route.startsWith('/') && allowed.some((prefix) => route === prefix || route.startsWith(`${prefix}?`))) {
    return { route, label: route === '/instances' ? 'Manage instances' : 'Review details' };
  }
  const token = (area || '').toLowerCase();
  if (token.includes('connection')) return { route: '/connections', label: 'Review connections' };
  if (token.includes('model')) return { route: '/models', label: 'Review models' };
  if (token.includes('topic')) return { route: '/topics', label: 'Review topics' };
  if (token.includes('content') || token.includes('dashboard')) return { route: '/content-health', label: 'Review content' };
  if (token.includes('user') || token.includes('chat') || token.includes('membership')) return { route: '/users?tab=health', label: 'Review users' };
  return { route: '/instances', label: 'Manage instances' };
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
        route: '/instances',
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
  const reportingRaw = firstValue(metricSources, METRIC_ALIASES.reportingInstances);
  const reportingMetric = reportingRaw === undefined
    ? {
        value: coverage.reportingInstances,
        state: coverage.reportingInstances < coverage.totalInstances ? 'partial' as const : 'available' as const,
        coverageLabel: coverage.totalInstances > 0 ? `${coverage.reportingInstances} of ${coverage.totalInstances} instances` : undefined,
      }
    : parseMetric(reportingRaw);
  const metrics: PortfolioOverviewMetricsDTO = {
    reportingInstances: reportingMetric,
    internalMemberships: qualifyForCoverage(globalMetric(metricSources, METRIC_ALIASES.internalMemberships, instances, (row) => row.internalMemberships), coverage),
    estimatedUniquePeople: qualifyForCoverage(globalMetric(metricSources, METRIC_ALIASES.estimatedUniquePeople, instances, (row) => row.estimatedUniquePeople), coverage),
    embedUsers: qualifyForCoverage(globalMetric(metricSources, METRIC_ALIASES.embedUsers, instances, (row) => row.embedUsers), coverage),
    embedEntities: qualifyForCoverage(globalMetric(metricSources, METRIC_ALIASES.embedEntities, instances, (row) => row.embedEntities), coverage),
    active7d: qualifyForCoverage(globalMetric(metricSources, METRIC_ALIASES.active7d, instances, (row) => row.active7d), coverage),
    active30d: qualifyForCoverage(globalMetric(metricSources, METRIC_ALIASES.active30d, instances, (row) => row.active30d), coverage),
    active90d: qualifyForCoverage(globalMetric(metricSources, METRIC_ALIASES.active90d, instances, (row) => row.active90d), coverage),
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

  return {
    generatedAt: firstString([root, asRecord(root.meta)], ['generatedAt', 'refreshedAt', 'asOf', 'updatedAt']),
    coverage,
    metrics,
    instances,
    connections,
    attention: parseAttention(root),
    failures,
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

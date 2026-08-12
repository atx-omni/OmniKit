import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  Activity,
  AlertTriangle,
  AppWindow,
  ArrowRight,
  ArrowUpDown,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  CircleSlash2,
  Database,
  Filter,
  LayoutDashboard,
  Link2,
  ListChecks,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Sparkles,
  Tags,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Blobby } from '@/components/ui/Blobby';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import {
  getPortfolioOverview,
  refreshPortfolioOverview,
  type PortfolioAttentionItemDTO,
  type PortfolioConnectionDTO,
  type PortfolioHealth,
  type PortfolioInstanceDTO,
  type PortfolioMetricDTO,
  type PortfolioMetricSetDTO,
  type PortfolioMetricState,
  type PortfolioMetricStatus,
  type PortfolioOverviewDTO,
  type PortfolioOverviewMetricsDTO,
  type PortfolioRefreshDTO,
} from '@/services/portfolioOverview';

type ActivityWindow = 7 | 30 | 90;
type HealthFilter = 'all' | 'healthy' | 'attention' | 'unavailable' | 'stale';
type FreshnessFilter = 'all' | 'fresh' | 'stale' | 'unavailable';
type FleetView = 'overview' | 'operational' | 'adoption' | 'content' | 'exceptions';
type ComparisonSortKey =
  | 'label'
  | 'health'
  | 'active'
  | 'internalMemberships'
  | 'embedUsers'
  | 'aiChats'
  | 'dashboards'
  | 'models'
  | 'topics';

interface KpiDefinition {
  key: keyof PortfolioOverviewMetricsDTO;
  label: string;
  route: string;
  icon: LucideIcon;
  iconClassName: string;
}

interface FleetViewDefinition {
  key: FleetView;
  label: string;
  description: string;
  icon: LucideIcon;
}

const FLEET_VIEW_DEFINITIONS: FleetViewDefinition[] = [
  {
    key: 'overview',
    label: 'Overview',
    description: 'Portfolio KPIs, collection coverage, freshness, and prioritized exceptions.',
    icon: LayoutDashboard,
  },
  {
    key: 'operational',
    label: 'Operational',
    description: 'Instance reachability, authorization evidence, connection readiness, and refresh failures.',
    icon: Activity,
  },
  {
    key: 'adoption',
    label: 'Adoption',
    description: 'Internal, embed, activity-window, and AI engagement signals without mixing in operational readiness.',
    icon: Users,
  },
  {
    key: 'content',
    label: 'Content',
    description: 'Dashboard, model, topic, App, and AI inventory with explicit connection attribution.',
    icon: Database,
  },
  {
    key: 'exceptions',
    label: 'Exceptions',
    description: 'Unavailable, unauthorized, unsupported, stale, failed, and duplicate-origin findings.',
    icon: ListChecks,
  },
];

const FLEET_VIEW_KEYS = new Set<FleetView>(FLEET_VIEW_DEFINITIONS.map((definition) => definition.key));
const HEALTH_FILTERS = new Set<HealthFilter>(['all', 'healthy', 'attention', 'unavailable', 'stale']);
const FRESHNESS_FILTERS = new Set<FreshnessFilter>(['all', 'fresh', 'stale', 'unavailable']);
const INITIAL_ROW_LIMIT = 25;

const KPI_DEFINITIONS: KpiDefinition[] = [
  { key: 'reportingInstances', label: 'Reporting instances', route: '/admin/fleet/instances', icon: Server, iconClassName: 'bg-surface-tertiary text-content-primary' },
  { key: 'estimatedUniquePeople', label: 'Estimated internal users', route: '/admin/identity/users', icon: ShieldCheck, iconClassName: 'bg-omni-50 text-omni-700' },
  { key: 'embedUsers', label: 'Embed users', route: '/admin/identity/users?tab=health', icon: Link2, iconClassName: 'bg-omni-100 text-omni-700' },
  { key: 'active30d', label: 'Active 30d', route: '/admin/identity/users?tab=health', icon: Activity, iconClassName: 'bg-success-light text-success' },
  { key: 'dashboards', label: 'Dashboards', route: '/dashboards/operations', icon: LayoutDashboard, iconClassName: 'bg-omni-50 text-omni-700' },
  { key: 'models', label: 'Models', route: '/models', icon: Database, iconClassName: 'bg-omni-100 text-omni-800' },
  { key: 'topics', label: 'Topics', route: '/topics', icon: BookOpen, iconClassName: 'bg-warning-light text-amber-800' },
  { key: 'aiChats', label: 'AI conversations', route: '/admin/fleet/instances', icon: Sparkles, iconClassName: 'bg-omni-50 text-omni-700' },
  { key: 'apps', label: 'Apps', route: '/admin/fleet/instances', icon: AppWindow, iconClassName: 'bg-surface-tertiary text-content-secondary' },
];

const ADOPTION_LIFECYCLE_KPI_DEFINITIONS: KpiDefinition[] = [
  {
    key: 'staleUsers90d',
    label: 'Stale active user records (90d)',
    route: '/admin/identity/users?tab=health',
    icon: Activity,
    iconClassName: 'bg-warning-light text-amber-800',
  },
  {
    key: 'neverLoggedInUsers',
    label: 'Active records without a login timestamp',
    route: '/admin/identity/users?tab=health',
    icon: Users,
    iconClassName: 'bg-surface-tertiary text-content-secondary',
  },
];

const ENGAGEMENT_SEGMENTS = [
  { key: 'internalMemberships', label: 'Internal', color: '#4D122C' },
  { key: 'embedUsers', label: 'Embed', color: '#FF5FA2' },
  { key: 'active', label: 'Active', color: '#80C501' },
  { key: 'aiChats', label: 'AI conversations', color: '#0F9BFF' },
] as const;

const HEALTH_ORDER: Record<PortfolioHealth, number> = {
  unavailable: 0,
  attention: 1,
  unknown: 2,
  healthy: 3,
};

function parseFleetView(value: string | null): FleetView {
  return value && FLEET_VIEW_KEYS.has(value as FleetView) ? value as FleetView : 'overview';
}

function parseActivityWindow(value: string | null): ActivityWindow {
  return value === '7' || value === '90' ? Number(value) as ActivityWindow : 30;
}

function parseHealthFilter(value: string | null): HealthFilter {
  return value && HEALTH_FILTERS.has(value as HealthFilter) ? value as HealthFilter : 'all';
}

function parseFreshnessFilter(value: string | null): FreshnessFilter {
  return value && FRESHNESS_FILTERS.has(value as FreshnessFilter) ? value as FreshnessFilter : 'all';
}

function connectionKey(connection: Pick<PortfolioConnectionDTO, 'instanceId' | 'id'>): string {
  return `${connection.instanceId}:${connection.id}`;
}

function updatedFleetHref(
  searchParams: URLSearchParams,
  updates: Record<string, string | null>,
): string {
  const next = new URLSearchParams(searchParams);
  for (const [key, value] of Object.entries(updates)) {
    if (value) next.set(key, value);
    else next.delete(key);
  }
  const query = next.toString();
  return query ? `/?${query}` : '/';
}

function workflowHref(
  route: string,
  searchParams: URLSearchParams,
  context?: { instanceId?: string; connectionId?: string },
): string {
  const parsed = new URL(route, 'https://omnikit.local');
  const mapping: Array<[string, string | null]> = [
    ['fleetView', parseFleetView(searchParams.get('view'))],
    ['fleetInstances', context?.instanceId || searchParams.get('instances')],
    ['fleetConnection', context?.connectionId || searchParams.get('connection')],
    ['fleetState', searchParams.get('state')],
    ['fleetFreshness', searchParams.get('freshness')],
    ['fleetWindow', String(parseActivityWindow(searchParams.get('window')))],
    ['fleetSearch', searchParams.get('q')],
  ];
  for (const [key, value] of mapping) {
    if (value) parsed.searchParams.set(key, value);
  }
  return `${parsed.pathname}${parsed.search}`;
}

function exactMetricStatus(metric: PortfolioMetricDTO): string {
  return (metric.status || metric.state).replace(/_/g, ' ');
}

function freshnessMatches(state: PortfolioMetricState, filter: FreshnessFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'stale') return state === 'stale';
  if (filter === 'unavailable') return state === 'unavailable' || state === 'not_configured';
  return state === 'available' || state === 'partial';
}

function instanceStateMatches(
  instance: PortfolioInstanceDTO,
  filter: HealthFilter,
  currentView: FleetView,
  activityWindow: ActivityWindow,
): boolean {
  if (filter === 'all') return true;
  if (currentView === 'adoption') {
    const state = activeMetric(instance.metrics, activityWindow).state;
    if (filter === 'healthy') return state === 'available';
    if (filter === 'attention') return state === 'partial';
    if (filter === 'stale') return state === 'stale';
    return state === 'unavailable' || state === 'not_configured';
  }
  if (filter === 'stale') return instance.freshness === 'stale';
  return instance.health === filter;
}

function instanceFreshnessState(
  instance: PortfolioInstanceDTO,
  currentView: FleetView,
  activityWindow: ActivityWindow,
): PortfolioMetricState {
  return currentView === 'adoption'
    ? activeMetric(instance.metrics, activityWindow).state
    : instance.freshness;
}

function formatNumber(value: number | null): string {
  return value === null ? 'Unavailable' : new Intl.NumberFormat().format(value);
}

function formatTimestamp(value?: string): string {
  if (!value) return 'Freshness unavailable';
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return 'Freshness unavailable';
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (elapsedMinutes < 1) return 'Updated just now';
  if (elapsedMinutes < 60) return `Updated ${elapsedMinutes}m ago`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `Updated ${elapsedHours}h ago`;
  return `Updated ${Math.floor(elapsedHours / 24)}d ago`;
}

function metricStateLabel(state: PortfolioMetricState): string {
  if (state === 'available') return 'Complete';
  if (state === 'partial') return 'Partial';
  if (state === 'stale') return 'Stale';
  if (state === 'not_configured') return 'Setup required';
  return 'Unavailable';
}

function metricStateClasses(state: PortfolioMetricState): string {
  if (state === 'available') return 'border-emerald-200 bg-emerald-50 text-emerald-800';
  if (state === 'partial') return 'border-amber-200 bg-amber-50 text-amber-900';
  if (state === 'stale') return 'border-orange-200 bg-orange-50 text-orange-900';
  if (state === 'not_configured') return 'border-gray-200 bg-gray-50 text-gray-700';
  return 'border-red-200 bg-red-50 text-red-800';
}

function compactMetricStateLabel(metric: PortfolioMetricDTO): string {
  if (metric.state === 'partial' && metric.coverageLabel) {
    const ratio = metric.coverageLabel.match(/(\d+)\s+of\s+(\d+)/i);
    if (ratio) return `Partial ${ratio[1]}/${ratio[2]}`;
  }
  return metricStateLabel(metric.state);
}

function metricAccessibleSummary(metric: PortfolioMetricDTO): string {
  if (metric.value === null && metric.state === 'unavailable') return 'Unavailable';
  return `${formatNumber(metric.value)}, ${metricStateLabel(metric.state)}`;
}

function healthLabel(health: PortfolioHealth): string {
  if (health === 'healthy') return 'Healthy';
  if (health === 'attention') return 'Needs attention';
  if (health === 'unavailable') return 'Unavailable';
  return 'Unknown';
}

function healthClasses(health: PortfolioHealth): string {
  if (health === 'healthy') return 'border-emerald-200 bg-emerald-50 text-emerald-800';
  if (health === 'attention') return 'border-amber-200 bg-amber-50 text-amber-900';
  if (health === 'unavailable') return 'border-red-200 bg-red-50 text-red-800';
  return 'border-gray-200 bg-gray-50 text-gray-700';
}

function connectionReadinessClasses(readiness: PortfolioConnectionDTO['readiness']): string {
  if (readiness === 'ready') return 'border-emerald-200 bg-emerald-50 text-emerald-800';
  if (readiness === 'attention') return 'border-amber-200 bg-amber-50 text-amber-900';
  if (readiness === 'unavailable') return 'border-red-200 bg-red-50 text-red-800';
  return 'border-gray-200 bg-gray-50 text-gray-700';
}

function MetricStateBadge({ metric }: { metric: PortfolioMetricDTO }) {
  const label = compactMetricStateLabel(metric);
  return (
    <span
      className={`inline-flex max-w-full items-center whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[9px] font-semibold ${metricStateClasses(metric.state)}`}
      title={metric.coverageLabel || label}
    >
      <span>{label}</span>
    </span>
  );
}

function HealthBadge({ health, label }: { health: PortfolioHealth; label?: string }) {
  return (
    <span className={`inline-flex w-fit max-w-full self-start items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${healthClasses(health)}`}>
      <span className="truncate">{label || healthLabel(health)}</span>
    </span>
  );
}

function activeMetric(metrics: PortfolioMetricSetDTO, windowDays: ActivityWindow): PortfolioMetricDTO {
  if (windowDays === 7) return metrics.active7d;
  if (windowDays === 90) return metrics.active90d;
  return metrics.active30d;
}

function aggregateMetrics(metrics: PortfolioMetricDTO[], expectedCount: number): PortfolioMetricDTO {
  if (expectedCount === 1 && metrics.length === 1) return { ...metrics[0] };

  const reporting = metrics.filter((metric) => metric.value !== null && metric.state !== 'not_configured');
  const exclusions = [...new Set(metrics.flatMap((metric) => metric.exclusions || []))];
  const sources = [...new Set(metrics.flatMap((metric) => metric.source ? [metric.source] : []))];
  const asOf = metrics
    .flatMap((metric) => metric.asOf ? [metric.asOf] : [])
    .filter((value) => Number.isFinite(new Date(value).getTime()))
    .sort((left, right) => new Date(left).getTime() - new Date(right).getTime())[0];
  const coverage = {
    included: reporting.length,
    total: expectedCount,
    unit: 'instances' as const,
    ratio: expectedCount > 0 ? reporting.length / expectedCount : null,
  };

  if (reporting.length === 0) {
    const unavailableStatuses = metrics.flatMap((metric) => (
      metric.status && !['available', 'partial', 'stale'].includes(metric.status) ? [metric.status] : []
    ));
    const uniqueUnavailableStatuses = [...new Set(unavailableStatuses)];
    const consistentExactStatus = metrics.length > 0
      && unavailableStatuses.length === metrics.length
      && uniqueUnavailableStatuses.length === 1;
    const mixedUnavailableStatuses = metrics.length > 1 && !consistentExactStatus;
    const unavailable = consistentExactStatus
      ? metrics.find((metric) => metric.status === uniqueUnavailableStatuses[0])
      : undefined;
    const reasonCode = expectedCount === 0
      ? 'FILTERED_SCOPE_EMPTY'
      : mixedUnavailableStatuses
        ? 'FILTERED_SCOPE_MIXED_UNAVAILABLE_STATUSES'
        : unavailable?.reasonCode || 'FILTERED_SCOPE_UNAVAILABLE';
    const reasonLabel = expectedCount === 0
      ? 'No instances match the current filters'
      : mixedUnavailableStatuses
        ? 'Filtered instances returned different or incomplete unavailable statuses; inspect instance drilldowns for exact evidence'
        : unavailable?.reasonLabel || 'No instance in the filtered scope returned this metric';
    return {
      value: null,
      ...(mixedUnavailableStatuses ? { status: 'failed' as const } : unavailable?.status ? { status: unavailable.status } : {}),
      state: mixedUnavailableStatuses ? 'unavailable' : unavailable?.state || 'unavailable',
      coverage,
      coverageLabel: `0 of ${expectedCount} instances`,
      asOf,
      exclusions,
      reasonCode,
      reasonLabel,
      source: sources.length === 1 ? sources[0] : 'derived_multiple_api_reads',
      detail: 'Filtered aggregate; constituent metric evidence remains available in instance drilldowns.',
    };
  }

  const partial = reporting.length < expectedCount
    || metrics.some((metric) => metric.state === 'partial' || metric.state === 'unavailable' || metric.state === 'not_configured');
  const stale = metrics.some((metric) => metric.state === 'stale');
  const status: PortfolioMetricStatus = stale ? 'stale' : partial ? 'partial' : 'available';
  return {
    value: reporting.reduce((sum, metric) => sum + (metric.value || 0), 0),
    status,
    state: status,
    coverage,
    coverageLabel: `${reporting.length} of ${expectedCount} instances`,
    asOf,
    exclusions,
    ...(partial || stale ? {
      reasonCode: stale && partial ? 'FILTERED_SCOPE_PARTIAL_STALE' : stale ? 'FILTERED_SCOPE_STALE' : 'FILTERED_SCOPE_PARTIAL',
      reasonLabel: stale && partial
        ? 'Filtered aggregate has partial coverage and retains older evidence'
        : stale
          ? 'Filtered aggregate retains older evidence'
          : 'Filtered aggregate excludes unavailable evidence',
    } : {}),
    source: sources.length === 1 ? sources[0] : 'derived_multiple_api_reads',
    detail: 'Filtered aggregate; constituent metric evidence remains available in instance drilldowns.',
  };
}

function metricsForInstances(instances: PortfolioInstanceDTO[]): PortfolioOverviewMetricsDTO {
  const count = instances.length;
  const reporting = instances.filter((instance) => instance.health !== 'unavailable');
  const scopedUniquePeople: PortfolioMetricDTO = count === 1
    ? instances[0]!.metrics.estimatedUniquePeople
    : {
        value: null,
        status: 'unsupported',
        state: 'unavailable',
        coverage: { included: 0, total: count, unit: 'instances', ratio: null },
        exclusions: ['FILTERED_CROSS_INSTANCE_IDENTITY_DEDUP_UNAVAILABLE'],
        reasonCode: 'FILTERED_CROSS_INSTANCE_IDENTITY_DEDUP_UNAVAILABLE',
        reasonLabel: count === 0
          ? 'No instances match the current filters'
          : 'A filtered multi-instance identity estimate is hidden because per-instance totals can double-count the same person',
        source: 'derived_normalized_identity',
      };
  return {
    reportingInstances: {
      value: reporting.length,
      status: reporting.length < count ? 'partial' : 'available',
      state: reporting.length < count ? 'partial' : 'available',
      coverage: {
        included: reporting.length,
        total: count,
        unit: 'instances',
        ratio: count > 0 ? reporting.length / count : null,
      },
      coverageLabel: `${reporting.length} of ${count} instances`,
      asOf: instances
        .flatMap((instance) => instance.asOf ? [instance.asOf] : [])
        .filter((value) => Number.isFinite(new Date(value).getTime()))
        .sort((left, right) => new Date(left).getTime() - new Date(right).getTime())[0],
      exclusions: reporting.length < count ? ['FILTERED_SCOPE_INSTANCE_UNAVAILABLE'] : [],
      ...(reporting.length < count ? {
        reasonCode: 'FILTERED_SCOPE_PARTIAL',
        reasonLabel: 'One or more filtered instances did not report portfolio evidence',
      } : {}),
      source: 'derived_instance_aggregate',
    },
    internalMemberships: aggregateMetrics(instances.map((instance) => instance.metrics.internalMemberships), count),
    estimatedUniquePeople: scopedUniquePeople,
    embedUsers: aggregateMetrics(instances.map((instance) => instance.metrics.embedUsers), count),
    embedEntities: aggregateMetrics(instances.map((instance) => instance.metrics.embedEntities), count),
    active7d: aggregateMetrics(instances.map((instance) => instance.metrics.active7d), count),
    active30d: aggregateMetrics(instances.map((instance) => instance.metrics.active30d), count),
    active90d: aggregateMetrics(instances.map((instance) => instance.metrics.active90d), count),
    staleUsers90d: aggregateMetrics(instances.map((instance) => instance.metrics.staleUsers90d), count),
    neverLoggedInUsers: aggregateMetrics(instances.map((instance) => instance.metrics.neverLoggedInUsers), count),
    dashboards: aggregateMetrics(instances.map((instance) => instance.metrics.dashboards), count),
    models: aggregateMetrics(instances.map((instance) => instance.metrics.models), count),
    topics: aggregateMetrics(instances.map((instance) => instance.metrics.topics), count),
    aiChats: aggregateMetrics(instances.map((instance) => instance.metrics.aiChats), count),
    apps: aggregateMetrics(instances.map((instance) => instance.metrics.apps), count),
  };
}

function unsupportedConnectionMetric(
  connection: PortfolioConnectionDTO,
  metricLabel: string,
): PortfolioMetricDTO {
  return {
    value: null,
    status: 'unsupported',
    state: 'unavailable',
    coverage: { included: 0, total: 1, unit: 'connections', ratio: null },
    asOf: connection.asOf,
    exclusions: ['CONNECTION_RELATIONSHIP_UNAVAILABLE'],
    reasonCode: 'CONNECTION_RELATIONSHIP_UNAVAILABLE',
    reasonLabel: `${metricLabel} has no documented explicit relationship to this connection in portfolio evidence`,
    source: 'portfolio_relationship_contract',
  };
}

function metricsForConnection(connection: PortfolioConnectionDTO): PortfolioOverviewMetricsDTO {
  return {
    reportingInstances: {
      value: null,
      status: 'unsupported',
      state: 'unavailable',
      coverage: { included: 0, total: 1, unit: 'connections', ratio: null },
      asOf: connection.asOf,
      exclusions: ['CONNECTION_SCOPE_INSTANCE_REPORTING_UNAVAILABLE'],
      reasonCode: 'CONNECTION_SCOPE_INSTANCE_REPORTING_UNAVAILABLE',
      reasonLabel: 'Instance reporting coverage is not a connection-scoped metric; use the parent instance drilldown for collection evidence',
      source: 'portfolio_relationship_contract',
      detail: 'Connection filters do not imply that the parent instance reported connection-scoped evidence.',
    },
    internalMemberships: unsupportedConnectionMetric(connection, 'Internal memberships'),
    estimatedUniquePeople: unsupportedConnectionMetric(connection, 'Estimated internal people'),
    embedUsers: unsupportedConnectionMetric(connection, 'Embed users'),
    embedEntities: unsupportedConnectionMetric(connection, 'Embed entities'),
    active7d: unsupportedConnectionMetric(connection, 'Active users (7d)'),
    active30d: unsupportedConnectionMetric(connection, 'Active users (30d)'),
    active90d: unsupportedConnectionMetric(connection, 'Active users (90d)'),
    staleUsers90d: unsupportedConnectionMetric(connection, 'Stale active user records (90d)'),
    neverLoggedInUsers: unsupportedConnectionMetric(connection, 'Active records without a login timestamp'),
    dashboards: connection.dashboards,
    models: connection.models,
    topics: connection.topics,
    aiChats: unsupportedConnectionMetric(connection, 'AI conversations'),
    apps: unsupportedConnectionMetric(connection, 'Apps'),
  };
}

function SectionHeading({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h2 className="text-base font-semibold text-content-primary">{title}</h2>
        <p className="mt-1 max-w-2xl text-xs leading-5 text-content-secondary">{description}</p>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

function KpiCard({ definition, metric, route }: { definition: KpiDefinition; metric: PortfolioMetricDTO; route?: string }) {
  const Icon = definition.icon;
  const displayValue = metric.state === 'not_configured' ? 'Setup required' : formatNumber(metric.value);
  return (
    <Link
      to={route || definition.route}
      className="group flex min-h-[126px] min-w-0 flex-col justify-between rounded-[8px] border border-border bg-white p-3 transition-colors hover:border-border-strong hover:bg-surface-secondary"
      aria-label={`${definition.label}: ${displayValue}. ${metric.coverageLabel || metricStateLabel(metric.state)}. Open details.`}
      title={metric.detail || metric.coverageLabel || undefined}
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <span className={`min-w-0 break-normal font-semibold leading-4 text-content-secondary ${definition.label.length > 18 ? 'text-[9px]' : 'text-[10px]'}`}>{definition.label}</span>
        <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] ${definition.iconClassName}`} aria-hidden="true">
          <Icon size={13} />
        </span>
      </div>
      <div className="mt-3 min-w-0">
        <div className={`${metric.state === 'not_configured' ? 'text-sm leading-5' : 'text-2xl leading-none'} break-words font-semibold tabular-nums text-content-primary`}>
          {displayValue}
        </div>
        <div className="mt-2">
          <MetricStateBadge metric={metric} />
        </div>
      </div>
    </Link>
  );
}

function PortfolioSkeleton({ reducedMotion }: { reducedMotion: boolean }) {
  const pulse = reducedMotion ? '' : 'animate-pulse';
  return (
    <div className={`space-y-6 ${pulse}`} aria-label="Loading portfolio overview" aria-busy="true">
      <div className="h-[78px] rounded-[8px] border border-border bg-white p-3">
        <div className="h-3 w-24 max-w-full rounded bg-gray-200" />
        <div className="mt-3 h-9 w-full rounded bg-gray-100" />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-9">
        {Array.from({ length: 9 }).map((_, index) => (
          <div key={index} className="min-h-[126px] rounded-[8px] border border-border bg-white p-3">
            <div className="flex justify-between gap-2">
              <div className="h-3 w-20 max-w-[70%] rounded bg-gray-200" />
              <div className="h-7 w-7 rounded-[7px] bg-gray-100" />
            </div>
            <div className="mt-8 h-6 w-14 max-w-full rounded bg-gray-200" />
            <div className="mt-2 h-4 w-20 max-w-full rounded bg-gray-100" />
          </div>
        ))}
      </div>
      <div className="grid gap-6 xl:grid-cols-2">
        {[0, 1].map((index) => (
          <div key={index} className="min-h-[260px] border-t border-border pt-5">
            <div className="h-4 w-40 max-w-full rounded bg-gray-200" />
            <div className="mt-5 space-y-5">
              {[0, 1, 2].map((row) => (
                <div key={row}>
                  <div className="h-3 w-24 max-w-full rounded bg-gray-100" />
                  <div className="mt-2 h-3 w-full rounded bg-gray-200" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function refreshProgressLabel(refresh: PortfolioRefreshDTO, requestPending = false): string {
  if (refresh.state !== 'running') return requestPending ? 'Starting portfolio refresh' : '';
  if (refresh.totalInstances > 0) {
    return `Refreshing ${refresh.completedInstances} of ${refresh.totalInstances} instances`;
  }
  return 'Refreshing saved instances';
}

function hasUsableSnapshot(overview: PortfolioOverviewDTO | null): boolean {
  if (!overview) return false;
  if (overview.instances.length > 0 || overview.connections.length > 0) return true;
  if (overview.attention.length > 0 || overview.failures.length > 0) return true;
  if (overview.coverage.reportingInstances > 0) return true;
  return Object.entries(overview.metrics).some(([key, metric]) => key !== 'reportingInstances' && metric.value !== null);
}

function CollectingFirstSnapshotState({
  refresh,
  error,
}: {
  refresh: PortfolioRefreshDTO;
  error: string;
}) {
  const progress = refreshProgressLabel(refresh);
  return (
    <section className="border-y border-omni-200 bg-omni-50 px-4 py-10 text-center" aria-busy="true">
      <RefreshCw size={24} className="mx-auto text-omni-700" aria-hidden="true" />
      <h2 className="mt-3 text-base font-semibold text-content-primary">Collecting your first portfolio snapshot</h2>
      <p className="mx-auto mt-2 max-w-xl text-sm text-content-secondary">
        {progress || 'OmniKit is checking saved instances. Portfolio analytics will appear as soon as the first results are ready.'}
      </p>
      {error && (
        <p className="mx-auto mt-3 max-w-xl text-xs text-red-800" role="alert">
          A status check failed, but OmniKit will keep trying. {error}
        </p>
      )}
    </section>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <section className="border-y border-red-200 bg-red-50 px-4 py-10 text-center" role="alert">
      <AlertTriangle size={24} className="mx-auto text-red-700" aria-hidden="true" />
      <h2 className="mt-3 text-base font-semibold text-red-900">Portfolio overview is unavailable</h2>
      <p className="mx-auto mt-2 max-w-xl break-words text-sm text-red-800">{message}</p>
      <div className="mt-5 flex flex-col justify-center gap-2 sm:flex-row">
        <button type="button" onClick={onRetry} className="btn-secondary justify-center px-3">
          <RefreshCw size={14} />
          Retry
        </button>
        <Link to="/admin/fleet/instances" className="btn-secondary justify-center px-3">
          <Server size={14} />
          Manage instances
        </Link>
      </div>
    </section>
  );
}

function NoRecordsState({ onRefresh, hasConfiguredInstances }: { onRefresh: () => void; hasConfiguredInstances: boolean }) {
  return (
    <section className="border-y border-border bg-white px-4 py-10 text-center">
      <Database size={24} className="mx-auto text-content-tertiary" aria-hidden="true" />
      <h2 className="mt-3 text-base font-semibold text-content-primary">
        {hasConfiguredInstances ? 'No portfolio records yet' : 'No saved instances configured'}
      </h2>
      <p className="mx-auto mt-2 max-w-lg text-sm text-content-secondary">
        {hasConfiguredInstances
          ? 'Saved instances are available, but the latest collection did not return aggregate records.'
          : 'Add an Omni instance to begin building a cross-instance portfolio overview.'}
      </p>
      <div className="mt-5 flex flex-col justify-center gap-2 sm:flex-row">
        <button type="button" onClick={onRefresh} className="btn-secondary justify-center px-3">
          <RefreshCw size={14} />
          Refresh overview
        </button>
        <Link to="/admin/fleet/instances" className="btn-secondary justify-center px-3">
          <Server size={14} />
          Manage instances
        </Link>
      </div>
    </section>
  );
}

function FilterBar({
  currentView,
  instances,
  explicitConnections,
  unfilterableConnectionCount,
  activityWindow,
  selectedInstanceIds,
  selectedConnectionKey,
  healthFilter,
  freshnessFilter,
  searchText,
  onActivityWindowChange,
  onToggleInstance,
  onSelectAllInstances,
  onConnectionChange,
  onHealthFilterChange,
  onFreshnessFilterChange,
  onSearchTextChange,
  onClear,
  hasFilters,
}: {
  currentView: FleetView;
  instances: PortfolioInstanceDTO[];
  explicitConnections: PortfolioConnectionDTO[];
  unfilterableConnectionCount: number;
  activityWindow: ActivityWindow;
  selectedInstanceIds: string[] | null;
  selectedConnectionKey: string;
  healthFilter: HealthFilter;
  freshnessFilter: FreshnessFilter;
  searchText: string;
  onActivityWindowChange: (value: ActivityWindow) => void;
  onToggleInstance: (id: string) => void;
  onSelectAllInstances: () => void;
  onConnectionChange: (value: string) => void;
  onHealthFilterChange: (value: HealthFilter) => void;
  onFreshnessFilterChange: (value: FreshnessFilter) => void;
  onSearchTextChange: (value: string) => void;
  onClear: () => void;
  hasFilters: boolean;
}) {
  const [instanceMenuOpen, setInstanceMenuOpen] = useState(false);
  const instanceMenuButtonRef = useRef<HTMLButtonElement>(null);
  const selectedCount = selectedInstanceIds === null ? instances.length : selectedInstanceIds.length;

  function closeInstanceMenu() {
    setInstanceMenuOpen(false);
    instanceMenuButtonRef.current?.focus();
  }

  return (
    <section className="border-y border-border bg-white px-3 py-3" aria-label="Fleet filters">
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex items-center gap-2 text-xs font-semibold text-content-primary">
          <Filter size={14} className="text-omni-700" aria-hidden="true" />
          Filter fleet evidence
        </div>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <fieldset className="min-w-0">
            <legend className="mb-1 text-[11px] font-semibold text-content-secondary">Activity window</legend>
            <div className="grid grid-cols-3 gap-1 rounded-[8px] border border-border bg-surface-secondary p-1" aria-label="Activity window">
              {([7, 30, 90] as const).map((windowDays) => (
                <button
                  key={windowDays}
                  type="button"
                  onClick={() => onActivityWindowChange(windowDays)}
                  aria-pressed={activityWindow === windowDays}
                  className={`min-h-8 rounded-[6px] px-2 text-xs font-semibold transition-colors ${
                    activityWindow === windowDays
                      ? 'bg-white text-omni-700 shadow-sm'
                      : 'text-content-secondary hover:bg-white hover:text-content-primary'
                  }`}
                >
                  {windowDays}d
                </button>
              ))}
            </div>
          </fieldset>

          <div className="min-w-0">
            <div className="mb-1 text-[11px] font-semibold text-content-secondary">Instances</div>
            <div className="relative min-w-0">
              <button
                ref={instanceMenuButtonRef}
                type="button"
                onClick={() => setInstanceMenuOpen((current) => !current)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && instanceMenuOpen) {
                    event.preventDefault();
                    closeInstanceMenu();
                  }
                }}
                aria-expanded={instanceMenuOpen}
                aria-controls="portfolio-instance-filter-menu"
                className="flex min-h-10 w-full min-w-0 items-center justify-between gap-2 rounded-[7px] border border-border-strong bg-white px-3 text-left text-sm text-content-primary"
              >
                <span className="min-w-0 truncate">{selectedCount} of {instances.length} selected</span>
                <ChevronDown size={14} className={`shrink-0 text-content-secondary transition-transform ${instanceMenuOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
              </button>
              {instanceMenuOpen && <div
                id="portfolio-instance-filter-menu"
                role="group"
                aria-label="Filter by instance"
                onKeyDown={(event) => {
                  if (event.key === 'Escape') closeInstanceMenu();
                }}
                className="mt-2 min-w-0 rounded-[8px] border border-border bg-white p-2 shadow-dropdown sm:absolute sm:left-0 sm:z-30 sm:w-64"
              >
                <div className="flex items-center justify-end gap-2 border-b border-border px-1 pb-2">
                  <button type="button" onClick={() => { onSelectAllInstances(); setInstanceMenuOpen(false); }} className="text-xs font-semibold text-omni-700 hover:text-omni-800">
                    Select all
                  </button>
                </div>
                <div className="mt-1 max-h-56 overflow-y-auto">
                  {instances.map((instance) => {
                    const checked = selectedInstanceIds === null || selectedInstanceIds.includes(instance.id);
                    return (
                      <label key={instance.id} className="flex cursor-pointer items-start gap-2 rounded-[6px] px-1 py-2 hover:bg-surface-secondary">
                        <input type="checkbox" checked={checked} onChange={() => onToggleInstance(instance.id)} aria-label={`Include ${instance.label}`} />
                        <span className="min-w-0 break-words text-xs text-content-primary">{instance.label}</span>
                      </label>
                    );
                  })}
                </div>
              </div>}
            </div>
          </div>

          <label className="min-w-0">
            <span className="mb-1 block text-[11px] font-semibold text-content-secondary">
              Operational/adoption state <span className="sr-only">(Health and status)</span>
            </span>
            <select
              value={healthFilter}
              onChange={(event) => onHealthFilterChange(event.target.value as HealthFilter)}
              className="input-field min-h-10 py-2 text-sm"
            >
              <option value="all">All {currentView === 'adoption' ? 'adoption' : 'operational'} states</option>
              <option value="healthy">{currentView === 'adoption' ? 'Activity reporting' : 'Ready'}</option>
              <option value="attention">{currentView === 'adoption' ? 'Partial activity evidence' : 'Needs attention'}</option>
              <option value="unavailable">Unavailable</option>
              <option value="stale">Stale</option>
            </select>
          </label>

          <label className="min-w-0">
            <span className="mb-1 block text-[11px] font-semibold text-content-secondary">Connection</span>
            <select
              value={selectedConnectionKey}
              onChange={(event) => onConnectionChange(event.target.value)}
              className="input-field min-h-10 py-2 text-sm"
            >
              <option value="">All explicitly attributed connections</option>
              {explicitConnections.map((connection) => (
                <option key={connectionKey(connection)} value={connectionKey(connection)}>
                  {connection.name} — {connection.instanceLabel}
                </option>
              ))}
            </select>
            {unfilterableConnectionCount > 0 && (
              <span className="mt-1 block text-[10px] leading-4 text-content-tertiary">
                {unfilterableConnectionCount} unknown-attribution {unfilterableConnectionCount === 1 ? 'connection is' : 'connections are'} visible in evidence but excluded from this filter.
              </span>
            )}
          </label>

          <label className="min-w-0">
            <span className="mb-1 block text-[11px] font-semibold text-content-secondary">Freshness</span>
            <select
              value={freshnessFilter}
              onChange={(event) => onFreshnessFilterChange(event.target.value as FreshnessFilter)}
              className="input-field min-h-10 py-2 text-sm"
            >
              <option value="all">All freshness states</option>
              <option value="fresh">Current or partial</option>
              <option value="stale">Stale</option>
              <option value="unavailable">Unavailable</option>
            </select>
          </label>

          <label className="min-w-0 xl:col-span-2">
            <span className="mb-1 block text-[11px] font-semibold text-content-secondary">Search fleet</span>
            <span className="relative block">
              <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-content-tertiary" aria-hidden="true" />
              <input
                type="search"
                value={searchText}
                onChange={(event) => onSearchTextChange(event.target.value)}
                placeholder="Instance, connection, status, or exception"
                className="input-field min-h-10 pl-9 text-sm"
              />
            </span>
          </label>

          <label className="min-w-0">
            <span className="mb-1 block text-[11px] font-semibold text-content-secondary">Environment / tags</span>
            <span className="relative block">
              <Tags size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-content-tertiary" aria-hidden="true" />
              <input
                type="text"
                value="Unsupported — governed metadata required"
                disabled
                aria-describedby="fleet-environment-filter-note"
                className="input-field min-h-10 cursor-not-allowed pl-9 text-xs"
              />
            </span>
          </label>

          <div className="flex min-w-0 items-end justify-start xl:justify-end">
            <button
              type="button"
              onClick={onClear}
              disabled={!hasFilters}
              className="btn-ghost min-h-10 justify-center px-2 text-xs"
              title="Clear filters"
            >
              <X size={14} />
              Clear filters
            </button>
          </div>
        </div>
        <p id="fleet-environment-filter-note" className="text-[10px] leading-4 text-content-tertiary">
          Environment and tag filtering stays unavailable until OmniKit has a documented, governed metadata source.
        </p>
      </div>
    </section>
  );
}

function CoverageBanner({ overview, refreshError }: { overview: PortfolioOverviewDTO; refreshError: string }) {
  if (refreshError) {
    return (
      <div className="border-y border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-800" role="alert">
        <span className="font-semibold">Refresh failed.</span> Showing the previous overview. {refreshError}
      </div>
    );
  }
  if (overview.partial) {
    const unavailable = overview.coverage.unavailableInstances;
    const partial = overview.coverage.partialInstances;
    return (
      <div className={`border-y px-3 py-2.5 text-sm ${overview.stale ? 'border-orange-200 bg-orange-50 text-orange-900' : 'border-amber-200 bg-amber-50 text-amber-900'}`} role="status">
        <span className="font-semibold">{overview.stale ? 'Partial portfolio coverage with stale evidence.' : 'Partial portfolio coverage.'}</span>{' '}
        {unavailable > 0 ? `${unavailable} unavailable. ` : ''}
        {partial > 0 ? `${partial} partially reporting. ` : ''}
        {overview.stale ? 'Original evidence timestamps are retained. ' : ''}
        Each metric below retains its own coverage state.
      </div>
    );
  }
  if (overview.stale) {
    return (
      <div className="border-y border-orange-200 bg-orange-50 px-3 py-2.5 text-sm text-orange-900" role="status">
        <span className="font-semibold">Some portfolio data is stale.</span> Refresh to request a current read from saved instances.
      </div>
    );
  }
  return null;
}

function FleetViewNavigation({
  currentView,
  searchParams,
  exceptionCount,
}: {
  currentView: FleetView;
  searchParams: URLSearchParams;
  exceptionCount: number;
}) {
  return (
    <nav aria-label="Fleet views" className="overflow-x-auto border-y border-border bg-white" data-testid="fleet-view-navigation">
      <div className="flex min-w-max px-2 sm:min-w-0 sm:flex-wrap">
        {FLEET_VIEW_DEFINITIONS.map((definition) => {
          const Icon = definition.icon;
          const active = currentView === definition.key;
          const count = definition.key === 'exceptions' && exceptionCount > 0 ? exceptionCount : null;
          return (
            <Link
              key={definition.key}
              to={updatedFleetHref(searchParams, { view: definition.key === 'overview' ? null : definition.key, drilldown: null })}
              aria-current={active ? 'page' : undefined}
              className={`inline-flex min-h-11 items-center gap-2 border-b-2 px-3 text-xs font-semibold transition-colors ${
                active
                  ? 'border-omni-700 text-omni-800'
                  : 'border-transparent text-content-secondary hover:border-border-strong hover:text-content-primary'
              }`}
            >
              <Icon size={14} aria-hidden="true" />
              {definition.label}
              {count !== null && (
                <span className="rounded-full bg-red-100 px-1.5 py-0.5 text-[9px] text-red-800" aria-label={`${count} exceptions`}>
                  {count > 99 ? '99+' : count}
                </span>
              )}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

function FleetViewIntro({ currentView }: { currentView: FleetView }) {
  const definition = FLEET_VIEW_DEFINITIONS.find((candidate) => candidate.key === currentView)!;
  const title = currentView === 'overview'
    ? 'Portfolio Overview'
    : currentView === 'operational'
      ? 'Operational Readiness'
      : currentView === 'content'
        ? 'Content & Semantic Inventory'
        : definition.label;
  return (
    <div className="min-w-0">
      <h2 className="text-lg font-semibold text-content-primary">{title}</h2>
      <p className="mt-1 max-w-3xl text-sm leading-5 text-content-secondary">{definition.description}</p>
    </div>
  );
}

function coverageEvidence(metric: PortfolioMetricDTO): string {
  if (metric.coverage) {
    return `${metric.coverage.included} of ${metric.coverage.total} ${metric.coverage.unit}`;
  }
  return metric.coverageLabel || 'Coverage unavailable';
}

function MetricEvidence({ label, metric }: { label: string; metric: PortfolioMetricDTO }) {
  return (
    <div className="min-w-0 rounded-[7px] border border-border bg-white p-3" data-testid="metric-evidence">
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h4 className="break-words text-xs font-semibold text-content-primary">{label}</h4>
          <div className="mt-1 text-lg font-semibold tabular-nums text-content-primary">{formatNumber(metric.value)}</div>
        </div>
        <MetricStateBadge metric={metric} />
      </div>
      <dl className="mt-3 grid gap-x-4 gap-y-2 text-[10px] sm:grid-cols-2">
        <div><dt className="font-semibold text-content-secondary">Exact status</dt><dd className="mt-0.5 break-words text-content-primary">{exactMetricStatus(metric)}</dd></div>
        <div><dt className="font-semibold text-content-secondary">Coverage</dt><dd className="mt-0.5 break-words text-content-primary">{coverageEvidence(metric)}</dd></div>
        <div><dt className="font-semibold text-content-secondary">Evidence source</dt><dd className="mt-0.5 break-all text-content-primary">{metric.source || 'Source unavailable'}</dd></div>
        <div><dt className="font-semibold text-content-secondary">As of</dt><dd className="mt-0.5 break-words text-content-primary">{metric.asOf || 'Freshness unavailable'}</dd></div>
        {(metric.reasonCode || metric.reasonLabel) && (
          <div className="sm:col-span-2"><dt className="font-semibold text-content-secondary">Reason</dt><dd className="mt-0.5 break-words text-content-primary">{metric.reasonCode || 'No reason code'}{metric.reasonLabel ? ` — ${metric.reasonLabel}` : ''}</dd></div>
        )}
        {metric.exclusions && metric.exclusions.length > 0 && (
          <div className="sm:col-span-2"><dt className="font-semibold text-content-secondary">Exclusions</dt><dd className="mt-0.5 break-words text-content-primary">{metric.exclusions.join(', ')}</dd></div>
        )}
      </dl>
    </div>
  );
}

function drilldownMetricEntries(
  metrics: PortfolioMetricSetDTO,
  currentView: FleetView,
  activityWindow: ActivityWindow,
): Array<[string, PortfolioMetricDTO]> {
  if (currentView === 'operational') {
    return [
      ['Dashboard collection', metrics.dashboards],
      ['Model collection', metrics.models],
      ['Topic collection', metrics.topics],
    ];
  }
  if (currentView === 'adoption') {
    return [
      ['Estimated internal people', metrics.estimatedUniquePeople],
      ['Internal memberships', metrics.internalMemberships],
      ['Embed users', metrics.embedUsers],
      [`Active ${activityWindow}d`, activeMetric(metrics, activityWindow)],
      ['Stale active user records (90d)', metrics.staleUsers90d],
      ['Active records without a login timestamp', metrics.neverLoggedInUsers],
      ['AI conversations', metrics.aiChats],
    ];
  }
  if (currentView === 'content') {
    return [
      ['Dashboards', metrics.dashboards],
      ['Models', metrics.models],
      ['Topics', metrics.topics],
      ['Apps', metrics.apps],
      ['AI conversations', metrics.aiChats],
    ];
  }
  return [
    ['Internal memberships', metrics.internalMemberships],
    [`Active ${activityWindow}d`, activeMetric(metrics, activityWindow)],
    ['Dashboards', metrics.dashboards],
    ['Models', metrics.models],
    ['Topics', metrics.topics],
  ];
}

function FleetDrilldown({
  overview,
  currentView,
  activityWindow,
  searchParams,
}: {
  overview: PortfolioOverviewDTO;
  currentView: FleetView;
  activityWindow: ActivityWindow;
  searchParams: URLSearchParams;
}) {
  const selection = searchParams.get('drilldown');
  if (!selection) return null;

  const closeHref = updatedFleetHref(searchParams, { drilldown: null });
  if (selection.startsWith('instance:')) {
    const instanceId = selection.slice('instance:'.length);
    const instance = overview.instances.find((candidate) => candidate.id === instanceId);
    if (!instance) return null;
    const entries = drilldownMetricEntries(instance.metrics, currentView, activityWindow);
    return (
      <section className="border-y border-omni-200 bg-omni-50 px-3 py-4" aria-label={`Instance drilldown: ${instance.label}`} data-testid="fleet-instance-drilldown">
        <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-omni-700">Lazy instance evidence</div>
            <h3 className="mt-1 break-words text-base font-semibold text-content-primary">{instance.label}</h3>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <HealthBadge health={instance.health} label={instance.statusLabel} />
              <span className="text-[10px] text-content-secondary">Freshness: {metricStateLabel(instance.freshness)}</span>
              <span className="text-[10px] text-content-secondary">As of: {instance.asOf || 'Unavailable'}</span>
              {instance.duplicateSavedOrigin && (
                <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-900">Duplicate saved origin</span>
              )}
            </div>
          </div>
          <Link to={closeHref} className="btn-ghost btn-sm shrink-0 justify-center"><X size={13} /> Close</Link>
        </div>
        <div className="mt-4 grid min-w-0 gap-3 lg:grid-cols-2 xl:grid-cols-3">
          {entries.map(([label, metric]) => <MetricEvidence key={label} label={label} metric={metric} />)}
        </div>
        <div className="mt-4">
          <Link to={workflowHref('/admin/fleet/instances', searchParams, { instanceId: instance.id })} className="inline-flex items-center gap-1 text-xs font-semibold text-omni-700 hover:text-omni-800">
            Open instance workflow with Fleet context <ArrowRight size={12} />
          </Link>
        </div>
      </section>
    );
  }

  if (selection.startsWith('connection:')) {
    const key = selection.slice('connection:'.length);
    const connection = overview.connections.find((candidate) => connectionKey(candidate) === key);
    if (!connection) return null;
    const attributionLabel = connection.attribution === 'explicit'
      ? 'Explicitly attributed'
      : connection.attribution === 'inferred'
        ? 'Inferred attribution — not permission evidence'
        : 'Unknown attribution — not filterable or permission evidence';
    return (
      <section className="border-y border-omni-200 bg-omni-50 px-3 py-4" aria-label={`Connection drilldown: ${connection.name}`} data-testid="fleet-connection-drilldown">
        <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-omni-700">Lazy connection evidence</div>
            <h3 className="mt-1 break-words text-base font-semibold text-content-primary">{connection.name}</h3>
            <p className="mt-1 break-words text-xs text-content-secondary">{connection.instanceLabel}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${connectionReadinessClasses(connection.readiness)}`}>{connection.statusLabel}</span>
              <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${connection.attribution === 'explicit' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-amber-200 bg-amber-50 text-amber-900'}`}>{attributionLabel}</span>
              <span className="text-[10px] text-content-secondary">As of: {connection.asOf || 'Unavailable'}</span>
            </div>
          </div>
          <Link to={closeHref} className="btn-ghost btn-sm shrink-0 justify-center"><X size={13} /> Close</Link>
        </div>
        <div className="mt-4 grid min-w-0 gap-3 lg:grid-cols-3">
          <MetricEvidence label="Dashboards" metric={connection.dashboards} />
          <MetricEvidence label="Models" metric={connection.models} />
          <MetricEvidence label="Topics" metric={connection.topics} />
        </div>
        <div className="mt-4">
          <Link to={workflowHref('/admin/fleet/connections', searchParams, { instanceId: connection.instanceId, connectionId: key })} className="inline-flex items-center gap-1 text-xs font-semibold text-omni-700 hover:text-omni-800">
            Open connection workflow with Fleet context <ArrowRight size={12} />
          </Link>
        </div>
      </section>
    );
  }
  return null;
}

function UnsupportedEvidence({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <section className="flex min-w-0 items-start gap-3 border-y border-border bg-surface-secondary px-3 py-4" aria-label={title} data-testid="unsupported-evidence">
      <CircleSlash2 size={18} className="mt-0.5 shrink-0 text-content-tertiary" aria-hidden="true" />
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-content-primary">{title}</h3>
        <p className="mt-1 text-xs leading-5 text-content-secondary">{description}</p>
        <span className="mt-2 inline-flex rounded-full border border-gray-200 bg-white px-2 py-0.5 text-[10px] font-semibold text-gray-700">Unsupported in portfolio evidence</span>
      </div>
    </section>
  );
}

function StructuredFailures({
  overview,
  instanceIds,
  searchText,
}: {
  overview: PortfolioOverviewDTO;
  instanceIds: Set<string>;
  searchText: string;
}) {
  const failures = overview.failures.filter((failure) => {
    if (failure.instanceId && !instanceIds.has(failure.instanceId)) return false;
    if (!searchText) return true;
    const evidence = `${failure.instanceLabel || ''} ${failure.metric || ''} ${failure.message} ${failure.status || ''} ${failure.reasonCode || ''} ${failure.reasonLabel || ''} ${failure.source || ''} ${(failure.exclusions || []).join(' ')}`.toLocaleLowerCase();
    return evidence.includes(searchText);
  });
  const rowLimit = useBoundedRowCount(failures.length);
  const visibleFailures = failures.slice(0, rowLimit.visibleCount);
  return (
    <section className="min-w-0 border-t border-border pt-5" aria-label="Structured scan failures" data-testid="fleet-structured-failures">
      <SectionHeading
        title="Structured scan failures"
        description="Exact server evidence. Unauthorized, unsupported, and failed reads remain distinct and never become zero."
      />
      {failures.length === 0 ? (
        <div className="flex items-start gap-3 border-y border-emerald-200 bg-emerald-50 px-3 py-4 text-emerald-900">
          <CheckCircle2 size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
          <div><div className="text-sm font-semibold">No structured scan failures in scope</div><div className="mt-1 text-xs text-emerald-800">Collection evidence may still be partial or stale; inspect metric badges and coverage.</div></div>
        </div>
      ) : (
        <>
          <div className="divide-y divide-border border-y border-border">
            {visibleFailures.map((failure) => (
              <article key={failure.id} className="min-w-0 px-3 py-4">
                <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <h3 className="break-words text-sm font-semibold text-content-primary">{failure.instanceLabel || 'Portfolio'} — {failure.metric || 'collection'}</h3>
                    <p className="mt-1 break-words text-xs text-content-secondary">{failure.message}</p>
                  </div>
                  <span className="w-fit rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[10px] font-semibold text-red-800">{(failure.status || 'failed').replace(/_/g, ' ')}</span>
                </div>
                <dl className="mt-3 grid gap-x-4 gap-y-2 text-[10px] sm:grid-cols-2 lg:grid-cols-4">
                  <div><dt className="font-semibold text-content-secondary">Reason code</dt><dd className="mt-0.5 break-all text-content-primary">{failure.reasonCode || failure.code || 'Unavailable'}</dd></div>
                  <div><dt className="font-semibold text-content-secondary">Source</dt><dd className="mt-0.5 break-all text-content-primary">{failure.source || 'Unavailable'}</dd></div>
                  <div><dt className="font-semibold text-content-secondary">Coverage</dt><dd className="mt-0.5 text-content-primary">{failure.coverage ? `${failure.coverage.included} of ${failure.coverage.total} ${failure.coverage.unit}` : 'Unavailable'}</dd></div>
                  <div><dt className="font-semibold text-content-secondary">As of</dt><dd className="mt-0.5 break-words text-content-primary">{failure.asOf || 'Unavailable'}</dd></div>
                  {failure.reasonLabel && <div className="sm:col-span-2"><dt className="font-semibold text-content-secondary">Reason</dt><dd className="mt-0.5 break-words text-content-primary">{failure.reasonLabel}</dd></div>}
                  {failure.exclusions && failure.exclusions.length > 0 && <div className="sm:col-span-2"><dt className="font-semibold text-content-secondary">Exclusions</dt><dd className="mt-0.5 break-words text-content-primary">{failure.exclusions.join(', ')}</dd></div>}
                </dl>
              </article>
            ))}
          </div>
          <ShowMoreRows label="failures" visibleCount={rowLimit.visibleCount} totalCount={failures.length} onShowMore={rowLimit.showMore} />
        </>
      )}
    </section>
  );
}

function DuplicateOriginEvidence({
  overview,
  instanceIds,
}: {
  overview: PortfolioOverviewDTO;
  instanceIds: Set<string>;
}) {
  const duplicates = overview.duplicateSavedOrigins.filter((duplicate) => instanceIds.has(duplicate.canonicalInstanceId));
  const rowLimit = useBoundedRowCount(duplicates.length);
  const visibleDuplicates = duplicates.slice(0, rowLimit.visibleCount);
  return (
    <section className="min-w-0 border-t border-border pt-5" aria-label="Duplicate saved origins" data-testid="fleet-duplicate-origins">
      <SectionHeading
        title="Duplicate saved origins"
        description="Saved profiles that resolve to the same canonical Omni origin are collected once and retained as explicit evidence."
      />
      {duplicates.length === 0 ? (
        <div className="border-y border-border bg-surface-secondary px-3 py-4 text-sm text-content-secondary">No duplicate saved origins in the current scope.</div>
      ) : (
        <>
          <div className="divide-y divide-border border-y border-border">
            {visibleDuplicates.map((duplicate) => (
              <article key={duplicate.canonicalInstanceId} className="px-3 py-4">
                <div className="text-sm font-semibold text-content-primary">{duplicate.savedInstanceCount} saved profiles share one collected origin</div>
                <div className="mt-1 break-words text-xs text-content-secondary">{duplicate.instanceLabels.join(', ')}</div>
                <div className="mt-2 text-[10px] text-content-tertiary">Canonical instance evidence id: {duplicate.canonicalInstanceId}</div>
              </article>
            ))}
          </div>
          <ShowMoreRows label="duplicate origins" visibleCount={rowLimit.visibleCount} totalCount={duplicates.length} onShowMore={rowLimit.showMore} />
        </>
      )}
    </section>
  );
}

function OperationalSummary({
  overview,
  instances,
  connection,
}: {
  overview: PortfolioOverviewDTO;
  instances: PortfolioInstanceDTO[];
  connection?: PortfolioConnectionDTO;
}) {
  const scopedIds = new Set(instances.map((instance) => instance.id));
  const reporting = instances.filter((instance) => instance.health !== 'unavailable').length;
  const unavailable = instances.filter((instance) => instance.health === 'unavailable').length;
  const stale = instances.filter((instance) => instance.freshness === 'stale').length;
  const failures = overview.failures.filter((failure) => !failure.instanceId || scopedIds.has(failure.instanceId)).length;
  const cards: ReadonlyArray<readonly [string, number, string]> = connection
    ? [
        ['Connections in scope', 1, 'Explicitly attributed connection'],
        ['Parent instance context', instances.length, 'Instance context, not connection totals'],
        ['Ready', connection.readiness === 'ready' ? 1 : 0, 'Connection readiness evidence'],
        ['Unavailable', connection.readiness === 'unavailable' ? 1 : 0, 'Unavailable does not become zero inventory'],
        ['Stale evidence', connection.freshness === 'stale' ? 1 : 0, 'Original connection freshness retained'],
      ]
    : [
        ['Instances in scope', instances.length, 'Selected saved-instance records'],
        ['Collection reporting', reporting, `${instances.length === 0 ? 0 : Math.round((reporting / instances.length) * 100)}% of scoped instances`],
        ['Unavailable', unavailable, 'Counted in coverage, excluded from aggregate metric totals'],
        ['Stale evidence', stale, 'Original evidence freshness retained'],
        ['Failed reads', failures, 'Exact structured failures'],
      ];
  return (
    <section aria-label="Operational collection summary">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {cards.map(([label, value, detail]) => (
          <article key={label} className="min-w-0 rounded-[8px] border border-border bg-white p-3">
            <div className="text-[10px] font-semibold text-content-secondary">{label}</div>
            <div className="mt-2 text-2xl font-semibold tabular-nums text-content-primary">{value}</div>
            <div className="mt-2 text-[10px] leading-4 text-content-tertiary">{detail}</div>
          </article>
        ))}
      </div>
    </section>
  );
}

function useBoundedRowCount(itemCount: number) {
  const [visibleCount, setVisibleCount] = useState(INITIAL_ROW_LIMIT);
  useEffect(() => setVisibleCount(INITIAL_ROW_LIMIT), [itemCount]);
  return {
    visibleCount: Math.min(visibleCount, itemCount),
    hasMore: visibleCount < itemCount,
    showMore: () => setVisibleCount((current) => Math.min(itemCount, current + INITIAL_ROW_LIMIT)),
  };
}

function ShowMoreRows({
  label,
  visibleCount,
  totalCount,
  onShowMore,
}: {
  label: string;
  visibleCount: number;
  totalCount: number;
  onShowMore: () => void;
}) {
  if (visibleCount >= totalCount) return null;
  return (
    <div className="border-t border-border pt-3 text-center">
      <button type="button" onClick={onShowMore} className="btn-secondary btn-sm justify-center">
        Show more {label} ({visibleCount} of {totalCount})
      </button>
    </div>
  );
}

function FleetInspectLink({
  label,
  selection,
  searchParams,
}: {
  label: string;
  selection: string;
  searchParams: URLSearchParams;
}) {
  return (
    <Link
      to={updatedFleetHref(searchParams, { drilldown: selection })}
      className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-omni-700 hover:text-omni-800"
      aria-label={`Inspect ${label}`}
    >
      Inspect <ArrowRight size={12} />
    </Link>
  );
}

function EngagementMix({
  instances,
  activityWindow,
  searchParams,
}: {
  instances: PortfolioInstanceDTO[];
  activityWindow: ActivityWindow;
  searchParams: URLSearchParams;
}) {
  const rowLimit = useBoundedRowCount(instances.length);
  const visibleInstances = instances.slice(0, rowLimit.visibleCount);
  return (
    <section className="min-w-0 border-t border-border pt-5">
      <SectionHeading
        title="Engagement mix by instance"
        description={`Aggregate membership, embed, active ${activityWindow}d, and AI chat signals by saved instance.`}
        action={(
          <Link to={workflowHref('/admin/identity/users?tab=health', searchParams)} className="inline-flex items-center gap-1 text-xs font-semibold text-omni-700 hover:text-omni-800">
            Review users <ArrowRight size={12} />
          </Link>
        )}
      />

      <div className="mb-4 flex flex-wrap gap-x-4 gap-y-2" aria-label="Engagement mix legend">
        {ENGAGEMENT_SEGMENTS.map((segment) => (
          <span key={segment.key} className="inline-flex items-center gap-1.5 text-[11px] text-content-secondary">
            <span className="h-2.5 w-2.5 rounded-[2px]" style={{ backgroundColor: segment.color }} aria-hidden="true" />
            {segment.label}
          </span>
        ))}
      </div>

      {instances.length === 0 ? (
        <div className="border-y border-border bg-surface-secondary px-3 py-8 text-center text-sm text-content-secondary">
          No instances match the current filters.
        </div>
      ) : (
        <div className="divide-y divide-border">
          {visibleInstances.map((instance) => {
            const active = activeMetric(instance.metrics, activityWindow);
            const segmentMetrics: Record<(typeof ENGAGEMENT_SEGMENTS)[number]['key'], PortfolioMetricDTO> = {
              internalMemberships: instance.metrics.internalMemberships,
              embedUsers: instance.metrics.embedUsers,
              active,
              aiChats: instance.metrics.aiChats,
            };
            const total = ENGAGEMENT_SEGMENTS.reduce((sum, segment) => sum + Math.max(0, segmentMetrics[segment.key].value || 0), 0);
            const available = ENGAGEMENT_SEGMENTS.some((segment) => segmentMetrics[segment.key].value !== null);
            const barLabel = ENGAGEMENT_SEGMENTS
              .map((segment) => `${segment.label} ${formatNumber(segmentMetrics[segment.key].value)}`)
              .join(', ');
            return (
              <div key={instance.id} className="min-w-0 py-4 first:pt-0">
                <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="min-w-0 break-words text-sm font-semibold text-content-primary">{instance.label}</span>
                    <FleetInspectLink label={`${instance.label} instance evidence`} selection={`instance:${instance.id}`} searchParams={searchParams} />
                  </div>
                  <HealthBadge health={instance.health} label={instance.statusLabel} />
                </div>
                <div
                  className="mt-2 flex h-3 w-full overflow-hidden rounded-full bg-gray-100"
                  role="img"
                  aria-label={`${instance.label} engagement mix: ${barLabel}`}
                >
                  {available && total > 0 ? ENGAGEMENT_SEGMENTS.map((segment) => {
                    const value = Math.max(0, segmentMetrics[segment.key].value || 0);
                    return value > 0 ? (
                      <span
                        key={segment.key}
                        style={{ width: `${(value / total) * 100}%`, backgroundColor: segment.color }}
                        title={`${segment.label}: ${formatNumber(value)}`}
                      />
                    ) : null;
                  }) : (
                    <span className="h-full w-full bg-gray-200" />
                  )}
                </div>
                <div className="mt-2 grid grid-cols-1 gap-x-3 gap-y-1 text-[11px] sm:grid-cols-2">
                  {ENGAGEMENT_SEGMENTS.map((segment) => {
                    const metric = segmentMetrics[segment.key];
                    return (
                      <div key={segment.key} className="flex min-w-0 items-baseline justify-between gap-2 text-content-secondary">
                        <span className="min-w-0 break-words">{segment.label}</span>
                        <span className="shrink-0 text-right tabular-nums text-content-primary">
                          {formatNumber(metric.value)}
                          {metric.state !== 'available' && !(metric.value === null && metric.state === 'unavailable') && (
                            <span className="ml-1 text-content-tertiary">({metricStateLabel(metric.state)})</span>
                          )}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
          <ShowMoreRows label="instances" visibleCount={rowLimit.visibleCount} totalCount={instances.length} onShowMore={rowLimit.showMore} />
        </div>
      )}
    </section>
  );
}

function ConnectionReadiness({ connections, searchParams }: { connections: PortfolioConnectionDTO[]; searchParams: URLSearchParams }) {
  const rowLimit = useBoundedRowCount(connections.length);
  const visibleConnections = connections.slice(0, rowLimit.visibleCount);
  const counts = useMemo(() => ({
    ready: connections.filter((connection) => connection.readiness === 'ready').length,
    attention: connections.filter((connection) => connection.readiness === 'attention').length,
    unavailable: connections.filter((connection) => connection.readiness === 'unavailable').length,
    unknown: connections.filter((connection) => connection.readiness === 'unknown').length,
  }), [connections]);
  const total = connections.length;

  return (
    <section className="min-w-0 border-t border-border pt-5 xl:border-l xl:pl-6">
      <SectionHeading
        title="Connection readiness"
        description="Schema-model readiness and collection coverage across the selected instances."
        action={(
          <Link to={workflowHref('/admin/fleet/connections', searchParams)} className="inline-flex items-center gap-1 text-xs font-semibold text-omni-700 hover:text-omni-800">
            Review connections <ArrowRight size={12} />
          </Link>
        )}
      />

      {total === 0 ? (
        <div className="border-y border-border bg-surface-secondary px-3 py-8 text-center text-sm text-content-secondary">
          Connection readiness is unavailable for the current filters.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
            <div className="min-w-0 border-b-2 border-emerald-500 pb-2">
              <div className="text-lg font-semibold tabular-nums text-content-primary">{counts.ready}</div>
              <div className="break-words text-[10px] text-content-secondary">Ready</div>
            </div>
            <div className="min-w-0 border-b-2 border-amber-500 pb-2">
              <div className="text-lg font-semibold tabular-nums text-content-primary">{counts.attention}</div>
              <div className="break-words text-[10px] text-content-secondary">Attention</div>
            </div>
            <div className="min-w-0 border-b-2 border-gray-400 pb-2">
              <div className="text-lg font-semibold tabular-nums text-content-primary">{counts.unavailable}</div>
              <div className="break-words text-[10px] text-content-secondary">Unavailable</div>
            </div>
            <div className="min-w-0 border-b-2 border-slate-300 pb-2">
              <div className="text-lg font-semibold tabular-nums text-content-primary">{counts.unknown}</div>
              <div className="break-words text-[10px] text-content-secondary">Unknown</div>
            </div>
          </div>
          <div className="mt-4 flex h-3 overflow-hidden rounded-full bg-gray-100" role="img" aria-label={`${counts.ready} ready, ${counts.attention} need attention, ${counts.unavailable} unavailable, ${counts.unknown} unknown`}>
            {counts.ready > 0 && <span className="bg-emerald-500" style={{ width: `${(counts.ready / total) * 100}%` }} />}
            {counts.attention > 0 && <span className="bg-amber-500" style={{ width: `${(counts.attention / total) * 100}%` }} />}
            {counts.unavailable > 0 && <span className="bg-gray-400" style={{ width: `${(counts.unavailable / total) * 100}%` }} />}
            {counts.unknown > 0 && <span className="bg-slate-300" style={{ width: `${(counts.unknown / total) * 100}%` }} />}
          </div>
          <div className="mt-4 max-h-[320px] divide-y divide-border overflow-y-auto border-y border-border">
            {visibleConnections.map((connection) => (
              <div key={`${connection.instanceId}:${connection.id}`} className="flex min-w-0 flex-col gap-2 px-2 py-3 hover:bg-surface-secondary sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <Link to={updatedFleetHref(searchParams, { drilldown: `connection:${connectionKey(connection)}` })} className="break-words text-sm font-semibold text-content-primary hover:text-omni-700">{connection.name}</Link>
                  <div className="mt-0.5 break-words text-[11px] text-content-secondary">{connection.instanceLabel}</div>
                  <div className={`mt-1 text-[10px] ${connection.attribution === 'explicit' ? 'text-emerald-800' : 'text-amber-800'}`}>
                    {connection.attribution === 'explicit' ? 'Explicit attribution' : connection.attribution === 'inferred' ? 'Inferred attribution — not permission evidence' : 'Unknown attribution — not filterable'}
                  </div>
                </div>
                <span className={`inline-flex max-w-full self-start rounded-full border px-2 py-0.5 text-[10px] font-semibold sm:self-center ${connectionReadinessClasses(connection.readiness)}`}>
                  <span className="truncate">{connection.statusLabel}</span>
                </span>
              </div>
            ))}
            <ShowMoreRows label="connections" visibleCount={rowLimit.visibleCount} totalCount={connections.length} onShowMore={rowLimit.showMore} />
          </div>
        </>
      )}
    </section>
  );
}

function CompactMetric({ metric }: { metric: PortfolioMetricDTO }) {
  return (
    <span className="inline-flex min-w-0 flex-col items-end">
      <span className="tabular-nums text-content-primary">{formatNumber(metric.value)}</span>
      {metric.state !== 'available' && !(metric.value === null && metric.state === 'unavailable') && (
        <span className="text-[9px] text-content-tertiary">{metricStateLabel(metric.state)}</span>
      )}
    </span>
  );
}

function ContentByConnection({ connections, searchParams }: { connections: PortfolioConnectionDTO[]; searchParams: URLSearchParams }) {
  const rowLimit = useBoundedRowCount(connections.length);
  const visibleConnections = connections.slice(0, rowLimit.visibleCount);
  return (
    <section className="min-w-0 border-t border-border pt-5">
      <SectionHeading
        title="Content by connection"
        description="Dashboard, model, and topic inventory attributed to each reporting connection."
        action={(
          <Link to={workflowHref('/admin/content/health', searchParams)} className="inline-flex items-center gap-1 text-xs font-semibold text-omni-700 hover:text-omni-800">
            Review content <ArrowRight size={12} />
          </Link>
        )}
      />

      {connections.length === 0 ? (
        <div className="border-y border-border bg-surface-secondary px-3 py-8 text-center text-sm text-content-secondary">
          Connection-level content metrics are unavailable for the current filters.
        </div>
      ) : (
        <>
          <div className="divide-y divide-border border-y border-border sm:hidden">
            {visibleConnections.map((connection) => (
              <div key={`${connection.instanceId}:${connection.id}`} className="min-w-0 py-3">
                <Link to={updatedFleetHref(searchParams, { drilldown: `connection:${connectionKey(connection)}` })} className="break-words text-sm font-semibold text-content-primary hover:text-omni-700">{connection.name}</Link>
                <div className="mt-0.5 break-words text-[11px] text-content-secondary">{connection.instanceLabel}</div>
                <div className={`mt-1 text-[10px] ${connection.attribution === 'explicit' ? 'text-emerald-800' : 'text-amber-800'}`}>{connection.attribution === 'explicit' ? 'Explicit attribution' : `${connection.attribution === 'inferred' ? 'Inferred' : 'Unknown'} attribution — not filterable`}</div>
                <dl className="mt-3 grid grid-cols-1 gap-2 text-xs">
                  <div className="flex min-w-0 justify-between gap-2"><dt className="text-content-secondary">Dashboards</dt><dd><CompactMetric metric={connection.dashboards} /></dd></div>
                  <div className="flex min-w-0 justify-between gap-2"><dt className="text-content-secondary">Models</dt><dd><CompactMetric metric={connection.models} /></dd></div>
                  <div className="flex min-w-0 justify-between gap-2"><dt className="text-content-secondary">Topics</dt><dd><CompactMetric metric={connection.topics} /></dd></div>
                </dl>
              </div>
            ))}
          </div>
          <div className="hidden max-w-full overflow-x-auto sm:block">
            <table className="w-full min-w-[680px] border-collapse text-left text-xs">
              <thead>
                <tr className="border-y border-border bg-surface-secondary text-content-secondary">
                  <th scope="col" className="px-3 py-2 font-semibold">Connection</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Instance</th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">Dashboards</th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">Models</th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">Topics</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Readiness</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {visibleConnections.map((connection) => (
                  <tr key={`${connection.instanceId}:${connection.id}`} className="hover:bg-surface-secondary">
                    <th scope="row" className="max-w-[240px] px-3 py-3 font-semibold text-content-primary">
                      <Link to={updatedFleetHref(searchParams, { drilldown: `connection:${connectionKey(connection)}` })} className="block truncate hover:text-omni-700">{connection.name}</Link>
                    </th>
                    <td className="max-w-[220px] px-3 py-3 text-content-secondary"><span className="block truncate">{connection.instanceLabel}</span></td>
                    <td className="px-3 py-3 text-right"><Link to={workflowHref('/dashboards/operations', searchParams, { instanceId: connection.instanceId, connectionId: connectionKey(connection) })} aria-label={`Open dashboards for ${connection.name}`}><CompactMetric metric={connection.dashboards} /></Link></td>
                    <td className="px-3 py-3 text-right"><Link to={workflowHref('/models', searchParams, { instanceId: connection.instanceId, connectionId: connectionKey(connection) })} aria-label={`Open models for ${connection.name}`}><CompactMetric metric={connection.models} /></Link></td>
                    <td className="px-3 py-3 text-right"><Link to={workflowHref('/topics', searchParams, { instanceId: connection.instanceId, connectionId: connectionKey(connection) })} aria-label={`Open topics for ${connection.name}`}><CompactMetric metric={connection.topics} /></Link></td>
                    <td className="px-3 py-3">
                      <div className="flex min-w-0 flex-col items-start gap-1">
                        <span className={`inline-flex max-w-[150px] rounded-full border px-2 py-0.5 text-[10px] font-semibold ${connectionReadinessClasses(connection.readiness)}`}>
                          <span className="truncate">{connection.statusLabel}</span>
                        </span>
                        <span className={`max-w-[170px] truncate text-[9px] ${connection.attribution === 'explicit' ? 'text-emerald-800' : 'text-amber-800'}`} title={`${connection.attribution} attribution`}>
                          {connection.attribution === 'explicit' ? 'Explicit attribution' : `${connection.attribution === 'inferred' ? 'Inferred' : 'Unknown'} attribution`}
                        </span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ShowMoreRows label="connections" visibleCount={rowLimit.visibleCount} totalCount={connections.length} onShowMore={rowLimit.showMore} />
        </>
      )}
    </section>
  );
}

function buildAttentionQueue(
  overview: PortfolioOverviewDTO,
  instances: PortfolioInstanceDTO[],
  connections: PortfolioConnectionDTO[],
): PortfolioAttentionItemDTO[] {
  const selectedIds = new Set(instances.map((instance) => instance.id));
  const explicit = overview.attention.filter((item) => !item.instanceId || selectedIds.has(item.instanceId));
  const derived: PortfolioAttentionItemDTO[] = [];

  for (const instance of instances) {
    if (instance.health === 'unavailable') {
      derived.push({
        id: `instance-unavailable-${instance.id}`,
        severity: 'critical',
        title: `${instance.label} could not report portfolio metrics.`,
        detail: instance.detail || 'Its totals are excluded until the saved connection can be reached again.',
        instanceId: instance.id,
        instanceLabel: instance.label,
        route: '/admin/fleet/instances',
        actionLabel: 'Manage instance',
      });
    } else if (instance.freshness === 'stale') {
      derived.push({
        id: `instance-stale-${instance.id}`,
        severity: 'warning',
        title: `${instance.label} has older portfolio data.`,
        detail: 'Refresh the overview or validate the saved instance before using its totals.',
        instanceId: instance.id,
        instanceLabel: instance.label,
        route: '/admin/fleet/instances',
        actionLabel: 'Review instance',
      });
    } else if (instance.health === 'attention' && !connections.some((connection) => connection.instanceId === instance.id && connection.readiness !== 'ready')) {
      derived.push({
        id: `instance-partial-${instance.id}`,
        severity: 'warning',
        title: `${instance.label} reported only part of its portfolio.`,
        detail: instance.detail || 'One or more aggregate metrics are partial or unavailable.',
        instanceId: instance.id,
        instanceLabel: instance.label,
        route: '/admin/fleet/instances',
        actionLabel: 'Review instance',
      });
    }

    const missingPortfolioSetup = [
      instance.metrics.apps.state === 'not_configured' ? 'App inventory label' : '',
    ].filter(Boolean);
    if (missingPortfolioSetup.length > 0) {
      derived.push({
        id: `instance-portfolio-setup-${instance.id}`,
        severity: 'info',
        title: `${instance.label} has optional portfolio analytics to configure.`,
        detail: `Setup required: ${missingPortfolioSetup.join(' and ')}.`,
        instanceId: instance.id,
        instanceLabel: instance.label,
        route: '/admin/fleet/instances',
        actionLabel: 'Configure analytics',
      });
    }
  }

  for (const connection of connections) {
    if (connection.readiness === 'attention') {
      derived.push({
        id: `connection-attention-${connection.instanceId}-${connection.id}`,
        severity: 'warning',
        title: `${connection.name} needs connection readiness review.`,
        detail: connection.detail || `Content reporting is incomplete on ${connection.instanceLabel}.`,
        instanceId: connection.instanceId,
        instanceLabel: connection.instanceLabel,
        route: '/admin/fleet/connections',
        actionLabel: 'Review connection',
      });
    } else if (connection.readiness === 'unavailable') {
      derived.push({
        id: `connection-unavailable-${connection.instanceId}-${connection.id}`,
        severity: 'critical',
        title: `${connection.name} could not be checked.`,
        detail: connection.detail || `Connection metrics are unavailable on ${connection.instanceLabel}.`,
        instanceId: connection.instanceId,
        instanceLabel: connection.instanceLabel,
        route: '/admin/fleet/connections',
        actionLabel: 'Review connection',
      });
    }
  }

  const deduped = new Map<string, PortfolioAttentionItemDTO>();
  for (const item of [...explicit, ...derived]) {
    const key = `${item.instanceId || 'portfolio'}:${item.title.toLowerCase()}`;
    if (!deduped.has(key)) deduped.set(key, item);
  }
  const severityOrder: Record<PortfolioAttentionItemDTO['severity'], number> = { critical: 0, warning: 1, info: 2 };
  return [...deduped.values()].sort((left, right) => severityOrder[left.severity] - severityOrder[right.severity]);
}

function NeedsAttention({ items, searchParams }: { items: PortfolioAttentionItemDTO[]; searchParams: URLSearchParams }) {
  const rowLimit = useBoundedRowCount(items.length);
  const visibleItems = items.slice(0, rowLimit.visibleCount);
  return (
    <section className="min-w-0 border-t border-border pt-5">
      <SectionHeading
        title="Needs attention"
        description="Plain-language exceptions that can change portfolio coverage or readiness."
      />
      {items.length === 0 ? (
        <div className="flex min-w-0 items-start gap-3 border-y border-border bg-surface-secondary px-3 py-4 text-content-primary">
          <ListChecks size={18} className="mt-0.5 shrink-0 text-content-tertiary" aria-hidden="true" />
          <div className="min-w-0">
            <div className="text-sm font-semibold">No plain-language attention items in scope</div>
            <div className="mt-0.5 text-xs leading-5 text-content-secondary">Structured failures, unsupported metrics, and collection coverage remain separate evidence below.</div>
          </div>
        </div>
      ) : (
        <div className="divide-y divide-border border-y border-border">
          {visibleItems.map((item) => (
            <div key={item.id} className="flex min-w-0 flex-col gap-3 px-2 py-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex min-w-0 items-start gap-3">
                <AlertTriangle
                  size={17}
                  className={`mt-0.5 shrink-0 ${item.severity === 'critical' ? 'text-red-700' : item.severity === 'warning' ? 'text-amber-700' : 'text-omni-700'}`}
                  aria-hidden="true"
                />
                <div className="min-w-0">
                  <div className="break-words text-sm font-semibold text-content-primary">{item.title}</div>
                  {item.detail && <p className="mt-1 break-words text-xs leading-5 text-content-secondary">{item.detail}</p>}
                </div>
              </div>
              <div className="flex shrink-0 flex-col items-start gap-2">
                {item.instanceId && <FleetInspectLink label={`${item.instanceLabel || 'instance'} evidence`} selection={`instance:${item.instanceId}`} searchParams={searchParams} />}
                <Link to={workflowHref(item.route, searchParams, item.instanceId ? { instanceId: item.instanceId } : undefined)} className="inline-flex shrink-0 items-center gap-1 self-start text-xs font-semibold text-omni-700 hover:text-omni-800">
                  {item.actionLabel} <ArrowRight size={12} />
                </Link>
              </div>
            </div>
          ))}
          <ShowMoreRows label="exceptions" visibleCount={rowLimit.visibleCount} totalCount={items.length} onShowMore={rowLimit.showMore} />
        </div>
      )}
    </section>
  );
}

function comparisonValue(instance: PortfolioInstanceDTO, key: ComparisonSortKey, windowDays: ActivityWindow): string | number {
  if (key === 'label') return instance.label;
  if (key === 'health') return HEALTH_ORDER[instance.health];
  if (key === 'active') return activeMetric(instance.metrics, windowDays).value ?? -1;
  return instance.metrics[key].value ?? -1;
}

function SortableHeader({
  label,
  sortKey,
  activeSortKey,
  direction,
  align = 'left',
  onSort,
}: {
  label: string;
  sortKey: ComparisonSortKey;
  activeSortKey: ComparisonSortKey;
  direction: 'asc' | 'desc';
  align?: 'left' | 'right';
  onSort: (key: ComparisonSortKey) => void;
}) {
  const active = sortKey === activeSortKey;
  return (
    <th
      scope="col"
      aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={`px-3 py-2 font-semibold ${align === 'right' ? 'text-right' : 'text-left'}`}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-1 hover:text-omni-700 ${align === 'right' ? 'justify-end' : ''}`}
      >
        <span>{label}</span>
        <ArrowUpDown size={11} className={active ? 'text-omni-700' : 'text-content-tertiary'} aria-hidden="true" />
      </button>
    </th>
  );
}

function MetricDrillLink({ metric, route, label }: { metric: PortfolioMetricDTO; route: string; label: string }) {
  return (
    <Link to={route} aria-label={`${label}: ${metricAccessibleSummary(metric)}`} className="inline-flex justify-end hover:text-omni-700">
      <CompactMetric metric={metric} />
    </Link>
  );
}

function InstanceComparison({
  instances,
  activityWindow,
  searchParams,
}: {
  instances: PortfolioInstanceDTO[];
  activityWindow: ActivityWindow;
  searchParams: URLSearchParams;
}) {
  const [sortKey, setSortKey] = useState<ComparisonSortKey>('health');
  const [direction, setDirection] = useState<'asc' | 'desc'>('asc');
  const sortedInstances = useMemo(() => [...instances].sort((left, right) => {
    const leftValue = comparisonValue(left, sortKey, activityWindow);
    const rightValue = comparisonValue(right, sortKey, activityWindow);
    const comparison = typeof leftValue === 'number' && typeof rightValue === 'number'
      ? leftValue - rightValue
      : String(leftValue).localeCompare(String(rightValue), undefined, { numeric: true });
    return direction === 'asc' ? comparison : -comparison;
  }), [activityWindow, direction, instances, sortKey]);
  const rowLimit = useBoundedRowCount(sortedInstances.length);
  const visibleInstances = sortedInstances.slice(0, rowLimit.visibleCount);

  function sortBy(key: ComparisonSortKey) {
    if (key === sortKey) setDirection((current) => current === 'asc' ? 'desc' : 'asc');
    else {
      setSortKey(key);
      setDirection(key === 'label' ? 'asc' : 'desc');
    }
  }

  return (
    <section className="min-w-0 border-t border-border pt-5">
      <SectionHeading
        title="Instance comparison"
        description={`Sortable aggregate comparison with active-user counts for the selected ${activityWindow}-day window.`}
      />

      <div className="divide-y divide-border border-y border-border sm:hidden">
        {visibleInstances.map((instance) => (
          <div key={instance.id} className="min-w-0 py-4">
            <div className="flex min-w-0 flex-col gap-2">
              <Link to={updatedFleetHref(searchParams, { drilldown: `instance:${instance.id}` })} className="break-words text-sm font-semibold text-content-primary hover:text-omni-700">{instance.label}</Link>
              <HealthBadge health={instance.health} label={instance.statusLabel} />
            </div>
            <dl className="mt-3 space-y-2 text-xs">
              <div className="flex min-w-0 justify-between gap-2"><dt className="text-content-secondary">Active {activityWindow}d</dt><dd><CompactMetric metric={activeMetric(instance.metrics, activityWindow)} /></dd></div>
              <div className="flex min-w-0 justify-between gap-2"><dt className="text-content-secondary">Internal</dt><dd><CompactMetric metric={instance.metrics.internalMemberships} /></dd></div>
              <div className="flex min-w-0 justify-between gap-2"><dt className="text-content-secondary">Embed</dt><dd><CompactMetric metric={instance.metrics.embedUsers} /></dd></div>
              <div className="flex min-w-0 justify-between gap-2"><dt className="text-content-secondary">AI conversations</dt><dd><CompactMetric metric={instance.metrics.aiChats} /></dd></div>
              <div className="flex min-w-0 justify-between gap-2"><dt className="text-content-secondary">Dashboards</dt><dd><CompactMetric metric={instance.metrics.dashboards} /></dd></div>
              <div className="flex min-w-0 justify-between gap-2"><dt className="text-content-secondary">Models</dt><dd><CompactMetric metric={instance.metrics.models} /></dd></div>
              <div className="flex min-w-0 justify-between gap-2"><dt className="text-content-secondary">Topics</dt><dd><CompactMetric metric={instance.metrics.topics} /></dd></div>
            </dl>
          </div>
        ))}
      </div>

      <div className="hidden max-w-full overflow-x-auto sm:block">
        <table className="w-full min-w-[1040px] border-collapse text-xs">
          <thead>
            <tr className="border-y border-border bg-surface-secondary text-content-secondary">
              <SortableHeader label="Instance" sortKey="label" activeSortKey={sortKey} direction={direction} onSort={sortBy} />
              <SortableHeader label="Status" sortKey="health" activeSortKey={sortKey} direction={direction} onSort={sortBy} />
              <SortableHeader label={`Active ${activityWindow}d`} sortKey="active" activeSortKey={sortKey} direction={direction} align="right" onSort={sortBy} />
              <SortableHeader label="Internal" sortKey="internalMemberships" activeSortKey={sortKey} direction={direction} align="right" onSort={sortBy} />
              <SortableHeader label="Embed" sortKey="embedUsers" activeSortKey={sortKey} direction={direction} align="right" onSort={sortBy} />
              <SortableHeader label="AI conversations" sortKey="aiChats" activeSortKey={sortKey} direction={direction} align="right" onSort={sortBy} />
              <SortableHeader label="Dashboards" sortKey="dashboards" activeSortKey={sortKey} direction={direction} align="right" onSort={sortBy} />
              <SortableHeader label="Models" sortKey="models" activeSortKey={sortKey} direction={direction} align="right" onSort={sortBy} />
              <SortableHeader label="Topics" sortKey="topics" activeSortKey={sortKey} direction={direction} align="right" onSort={sortBy} />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {visibleInstances.map((instance) => (
              <tr key={instance.id} className="hover:bg-surface-secondary">
                <th scope="row" className="max-w-[220px] px-3 py-3 text-left font-semibold text-content-primary">
                  <Link to={updatedFleetHref(searchParams, { drilldown: `instance:${instance.id}` })} className="block truncate hover:text-omni-700">{instance.label}</Link>
                </th>
                <td className="px-3 py-3"><HealthBadge health={instance.health} label={instance.statusLabel} /></td>
                <td className="px-3 py-3 text-right"><MetricDrillLink metric={activeMetric(instance.metrics, activityWindow)} route={workflowHref('/admin/identity/users?tab=health', searchParams, { instanceId: instance.id })} label={`${instance.label} active users`} /></td>
                <td className="px-3 py-3 text-right"><MetricDrillLink metric={instance.metrics.internalMemberships} route={workflowHref('/admin/identity/users?tab=groups', searchParams, { instanceId: instance.id })} label={`${instance.label} internal memberships`} /></td>
                <td className="px-3 py-3 text-right"><MetricDrillLink metric={instance.metrics.embedUsers} route={workflowHref('/admin/identity/users?tab=health', searchParams, { instanceId: instance.id })} label={`${instance.label} embed users`} /></td>
                <td className="px-3 py-3 text-right"><MetricDrillLink metric={instance.metrics.aiChats} route={workflowHref('/admin/fleet/instances', searchParams, { instanceId: instance.id })} label={`${instance.label} AI conversations`} /></td>
                <td className="px-3 py-3 text-right"><MetricDrillLink metric={instance.metrics.dashboards} route={workflowHref('/dashboards/operations', searchParams, { instanceId: instance.id })} label={`${instance.label} dashboards`} /></td>
                <td className="px-3 py-3 text-right"><MetricDrillLink metric={instance.metrics.models} route={workflowHref('/models', searchParams, { instanceId: instance.id })} label={`${instance.label} models`} /></td>
                <td className="px-3 py-3 text-right"><MetricDrillLink metric={instance.metrics.topics} route={workflowHref('/topics', searchParams, { instanceId: instance.id })} label={`${instance.label} topics`} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ShowMoreRows label="instances" visibleCount={rowLimit.visibleCount} totalCount={sortedInstances.length} onShowMore={rowLimit.showMore} />
    </section>
  );
}

function FilterEmptyState({ onClear }: { onClear: () => void }) {
  return (
    <section className="border-y border-border bg-surface-secondary px-3 py-9 text-center">
      <Users size={22} className="mx-auto text-content-tertiary" aria-hidden="true" />
      <h2 className="mt-3 text-sm font-semibold text-content-primary">No instances match these filters</h2>
      <p className="mt-1 text-xs text-content-secondary">The underlying overview is still available.</p>
      <button type="button" onClick={onClear} className="btn-secondary btn-sm mt-4 justify-center">
        <X size={13} />
        Clear filters
      </button>
    </section>
  );
}

export function PortfolioOverviewPage() {
  const reducedMotion = useReducedMotion();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryString = searchParams.toString();
  const requestIdRef = useRef(0);
  const previousRefreshStateRef = useRef<PortfolioRefreshDTO['state']>('idle');
  const [overview, setOverview] = useState<PortfolioOverviewDTO | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshRequestPending, setRefreshRequestPending] = useState(false);
  const [initialError, setInitialError] = useState('');
  const [refreshError, setRefreshError] = useState('');
  const [refreshAnnouncement, setRefreshAnnouncement] = useState('');
  const currentView = parseFleetView(searchParams.get('view'));
  const activityWindow = parseActivityWindow(searchParams.get('window'));
  const healthFilter = parseHealthFilter(searchParams.get('state'));
  const freshnessFilter = parseFreshnessFilter(searchParams.get('freshness'));
  const searchText = searchParams.get('q') || '';
  const normalizedSearch = searchText.trim().toLocaleLowerCase();
  const selectedInstanceIds = useMemo(() => {
    const value = searchParams.get('instances');
    if (!value) return null;
    const ids = [...new Set(value.split(',').map((id) => id.trim()).filter(Boolean))];
    return ids.length > 0 ? ids : null;
  }, [searchParams]);
  const selectedConnectionKey = searchParams.get('connection') || '';

  const load = useCallback(async (forceRefresh: boolean, signal?: AbortSignal) => {
    const requestId = ++requestIdRef.current;
    if (forceRefresh) setRefreshRequestPending(true);
    else setInitialLoading(true);
    if (forceRefresh) setRefreshError('');
    else setInitialError('');

    try {
      const result = forceRefresh
        ? await refreshPortfolioOverview({ signal })
        : await getPortfolioOverview({ signal });
      if (requestId !== requestIdRef.current) return;
      setOverview(result);
      setInitialError('');
      setRefreshError('');
    } catch (error) {
      if (signal?.aborted || requestId !== requestIdRef.current) return;
      const message = error instanceof Error ? error.message : 'Could not load the portfolio overview.';
      if (forceRefresh) setRefreshError(message);
      else setInitialError(message);
    } finally {
      if (requestId === requestIdRef.current) {
        setInitialLoading(false);
        setRefreshRequestPending(false);
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(false, controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    if (overview?.refresh.state !== 'running') return undefined;

    let stopped = false;
    let timer: number | undefined;
    let controller: AbortController | null = null;

    const poll = () => {
      timer = window.setTimeout(async () => {
        controller = new AbortController();
        try {
          const result = await getPortfolioOverview({ signal: controller.signal });
          if (stopped) return;
          setOverview(result);
          setRefreshError('');
          if (result.refresh.state === 'running') poll();
        } catch (error) {
          if (stopped || controller.signal.aborted) return;
          setRefreshError(error instanceof Error ? error.message : 'Could not check refresh progress.');
          poll();
        }
      }, 2_000);
    };

    poll();
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
      controller?.abort();
    };
  }, [overview?.refresh.state]);

  const explicitConnections = useMemo(() => (overview?.connections || [])
    .filter((connection) => connection.attribution === 'explicit'), [overview]);
  const availableInstanceIds = useMemo(() => new Set(overview?.instances.map((instance) => instance.id) || []), [overview]);
  const instanceScopedExplicitConnections = useMemo(() => explicitConnections.filter((connection) => (
    selectedInstanceIds === null || selectedInstanceIds.includes(connection.instanceId)
  )), [explicitConnections, selectedInstanceIds]);
  const scopedConnectionCount = (overview?.connections || []).filter((connection) => (
    selectedInstanceIds === null || selectedInstanceIds.includes(connection.instanceId)
  )).length;
  const unfilterableConnectionCount = scopedConnectionCount - instanceScopedExplicitConnections.length;
  const selectedConnection = instanceScopedExplicitConnections.find((connection) => connectionKey(connection) === selectedConnectionKey);

  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    let changed = false;
    const remove = (key: string) => {
      if (next.has(key)) {
        next.delete(key);
        changed = true;
      }
    };

    const rawView = next.get('view');
    if (rawView === 'overview' || (rawView && !FLEET_VIEW_KEYS.has(rawView as FleetView))) remove('view');
    const rawWindow = next.get('window');
    if (rawWindow === '30' || (rawWindow && rawWindow !== '7' && rawWindow !== '90')) remove('window');
    const rawState = next.get('state');
    if (rawState === 'all' || (rawState && !HEALTH_FILTERS.has(rawState as HealthFilter))) remove('state');
    const rawFreshness = next.get('freshness');
    if (rawFreshness === 'all' || (rawFreshness && !FRESHNESS_FILTERS.has(rawFreshness as FreshnessFilter))) remove('freshness');
    const rawSearch = next.get('q');
    if (rawSearch !== null && rawSearch.trim() !== rawSearch) {
      if (rawSearch.trim()) next.set('q', rawSearch.trim());
      else next.delete('q');
      changed = true;
    }

    if (overview) {
      const rawInstances = next.get('instances');
      if (rawInstances) {
        const validIds = [...new Set(rawInstances.split(',').filter((id) => availableInstanceIds.has(id)))];
        if (validIds.length === 0 || validIds.length === overview.instances.length) remove('instances');
        else {
          const normalized = validIds.join(',');
          if (normalized !== rawInstances) {
            next.set('instances', normalized);
            changed = true;
          }
        }
      }

      const rawConnection = next.get('connection');
      if (rawConnection && !instanceScopedExplicitConnections.some((connection) => connectionKey(connection) === rawConnection)) remove('connection');

      const drilldown = next.get('drilldown');
      if (drilldown) {
        const instanceScope = new Set(selectedInstanceIds || overview.instances.map((instance) => instance.id));
        const activeConnectionKey = next.get('connection');
        const validInstance = drilldown.startsWith('instance:')
          && instanceScope.has(drilldown.slice('instance:'.length));
        const drilldownConnectionKey = drilldown.startsWith('connection:')
          ? drilldown.slice('connection:'.length)
          : '';
        const drilldownConnection = overview.connections.find((connection) => connectionKey(connection) === drilldownConnectionKey);
        const validConnection = Boolean(
          drilldownConnection
          && instanceScope.has(drilldownConnection.instanceId)
          && (!activeConnectionKey || activeConnectionKey === drilldownConnectionKey),
        );
        if (!validInstance && !validConnection) remove('drilldown');
      }
    }

    if (changed && next.toString() !== queryString) setSearchParams(next, { replace: true });
  }, [availableInstanceIds, instanceScopedExplicitConnections, overview, queryString, searchParams, selectedInstanceIds, setSearchParams]);

  const hasFilters = activityWindow !== 30
    || selectedInstanceIds !== null
    || Boolean(selectedConnection)
    || healthFilter !== 'all'
    || freshnessFilter !== 'all'
    || Boolean(normalizedSearch);
  const filteredInstances = useMemo(() => {
    if (!overview) return [];
    return overview.instances.filter((instance) => {
      if (selectedInstanceIds !== null && !selectedInstanceIds.includes(instance.id)) return false;
      if (selectedConnection && instance.id !== selectedConnection.instanceId) return false;
      if (!instanceStateMatches(instance, healthFilter, currentView, activityWindow)) return false;
      if (!freshnessMatches(instanceFreshnessState(instance, currentView, activityWindow), freshnessFilter)) return false;
      if (normalizedSearch) {
        const instanceEvidence = [instance.label, instance.role, instance.statusLabel, instance.detail]
          .filter(Boolean)
          .join(' ')
          .toLocaleLowerCase();
        const connectionEvidence = overview.connections
          .filter((connection) => connection.instanceId === instance.id)
          .map((connection) => `${connection.name} ${connection.statusLabel} ${connection.attribution}`)
          .join(' ')
          .toLocaleLowerCase();
        const exceptionEvidence = [
          ...overview.attention.filter((item) => item.instanceId === instance.id).map((item) => `${item.title} ${item.detail || ''}`),
          ...overview.failures.filter((failure) => failure.instanceId === instance.id).map((failure) => `${failure.metric || ''} ${failure.message} ${failure.status || ''} ${failure.reasonCode || ''} ${failure.source || ''}`),
        ].join(' ').toLocaleLowerCase();
        if (!instanceEvidence.includes(normalizedSearch) && !connectionEvidence.includes(normalizedSearch) && !exceptionEvidence.includes(normalizedSearch)) return false;
      }
      return true;
    });
  }, [activityWindow, currentView, freshnessFilter, healthFilter, normalizedSearch, overview, selectedConnection, selectedInstanceIds]);
  const filteredInstanceIds = useMemo(() => new Set(filteredInstances.map((instance) => instance.id)), [filteredInstances]);
  const filteredConnections = useMemo(() => {
    if (!overview) return [];
    return overview.connections.filter((connection) => {
      if (!filteredInstanceIds.has(connection.instanceId)) return false;
      if (selectedConnection && connectionKey(connection) !== connectionKey(selectedConnection)) return false;
      if (healthFilter === 'stale' && connection.freshness !== 'stale') return false;
      if (healthFilter === 'healthy' && connection.readiness !== 'ready') return false;
      if (healthFilter === 'attention' && connection.readiness !== 'attention') return false;
      if (healthFilter === 'unavailable' && connection.readiness !== 'unavailable') return false;
      if (!freshnessMatches(connection.freshness, freshnessFilter)) return false;
      if (normalizedSearch) {
        const evidence = `${connection.name} ${connection.instanceLabel} ${connection.statusLabel} ${connection.attribution} ${connection.detail || ''}`.toLocaleLowerCase();
        if (!evidence.includes(normalizedSearch)) {
          const instance = overview.instances.find((candidate) => candidate.id === connection.instanceId);
          if (!instance?.label.toLocaleLowerCase().includes(normalizedSearch)) return false;
        }
      }
      return true;
    });
  }, [filteredInstanceIds, freshnessFilter, healthFilter, normalizedSearch, overview, selectedConnection]);
  const filtersChangeInstanceScope = selectedInstanceIds !== null
    || Boolean(selectedConnection)
    || healthFilter !== 'all'
    || freshnessFilter !== 'all'
    || Boolean(normalizedSearch);
  const displayMetrics = useMemo(() => {
    if (!overview) return null;
    if (selectedConnection) return metricsForConnection(selectedConnection);
    return filtersChangeInstanceScope ? metricsForInstances(filteredInstances) : overview.metrics;
  }, [filteredInstances, filtersChangeInstanceScope, overview, selectedConnection]);
  const attentionItems = useMemo(() => {
    if (!overview) return [];
    const items = buildAttentionQueue(overview, selectedConnection ? [] : filteredInstances, filteredConnections);
    if (!normalizedSearch) return items;
    return items.filter((item) => `${item.title} ${item.detail || ''} ${item.instanceLabel || ''}`.toLocaleLowerCase().includes(normalizedSearch));
  }, [filteredConnections, filteredInstances, normalizedSearch, overview, selectedConnection]);

  const setFilter = useCallback((key: string, value: string | null, replace = false) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete('drilldown');
    setSearchParams(next, { replace });
  }, [searchParams, setSearchParams]);

  function clearFilters() {
    const next = new URLSearchParams(searchParams);
    for (const key of ['instances', 'connection', 'state', 'freshness', 'window', 'q', 'drilldown']) next.delete(key);
    setSearchParams(next);
  }

  function toggleInstance(id: string) {
    if (!overview) return;
    const allIds = overview.instances.map((instance) => instance.id);
    const selected = selectedInstanceIds === null ? allIds : selectedInstanceIds;
    const next = selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id];
    if (next.length === 0) return;
    setFilter('instances', next.length === allIds.length ? null : next.join(','));
  }

  const refreshProgress = overview ? refreshProgressLabel(overview.refresh, refreshRequestPending) : '';
  const refreshing = refreshRequestPending || overview?.refresh.state === 'running';
  const usableSnapshot = hasUsableSnapshot(overview);
  const collectingFirstSnapshot = Boolean(overview) && !usableSnapshot && overview!.refresh.state === 'running';
  const coverageDescription = overview
    ? `${overview.coverage.reportingInstances} of ${overview.coverage.totalInstances} instances reporting | ${formatTimestamp(overview.generatedAt)}${refreshProgress ? ` | ${refreshProgress}` : ''}`
    : initialLoading
      ? 'Loading coverage and freshness'
      : 'Coverage and freshness unavailable';
  const noRecords = Boolean(overview) && !usableSnapshot && overview!.refresh.state === 'idle';
  const exceptionCount = overview
    ? overview.attention.length + overview.failures.length + overview.duplicateSavedOrigins.length
    : 0;

  useEffect(() => {
    const state = overview?.refresh.state || 'idle';
    if (refreshError) setRefreshAnnouncement('Portfolio refresh failed. Previous data remains visible.');
    else if (refreshProgress) setRefreshAnnouncement(refreshProgress);
    else if (previousRefreshStateRef.current === 'running' && state === 'idle') {
      setRefreshAnnouncement('Portfolio refresh complete.');
    }
    previousRefreshStateRef.current = state;
  }, [overview?.refresh.state, refreshError, refreshProgress]);

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        title="Fleet Command Center"
        description={coverageDescription}
        icon={<Blobby mood="dashboard" size={58} className="animate-float" style={{ animationDuration: '3.5s' }} />}
        actions={(
          <>
            <button
              type="button"
              onClick={() => void load(true)}
              disabled={initialLoading || refreshing}
              className="btn-secondary h-10 w-10 justify-center p-0"
              aria-label={refreshing ? 'Refreshing portfolio overview' : 'Refresh portfolio overview'}
              title="Refresh portfolio overview"
            >
              <RefreshCw size={15} className={refreshing && !reducedMotion ? 'animate-spin' : ''} />
            </button>
            <Link to={workflowHref('/admin/fleet/instances', searchParams)} className="btn-secondary min-h-10 min-w-0 justify-center px-3 text-xs">
              <Server size={14} className="shrink-0" />
              <span className="break-words">Manage instances</span>
            </Link>
          </>
        )}
      />

      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {refreshAnnouncement}
      </div>

      <FleetViewNavigation currentView={currentView} searchParams={searchParams} exceptionCount={exceptionCount} />

      {refreshProgress && usableSnapshot && (
        <div className="border-y border-omni-200 bg-omni-50 px-3 py-2 text-xs font-medium text-omni-800" aria-hidden="true">
          {refreshProgress}. Current portfolio data remains available while collection continues.
        </div>
      )}

      {initialLoading && !overview ? (
        <PortfolioSkeleton reducedMotion={reducedMotion} />
      ) : initialError && !overview ? (
        <ErrorState message={initialError} onRetry={() => void load(false)} />
      ) : collectingFirstSnapshot && overview ? (
        <CollectingFirstSnapshotState refresh={overview.refresh} error={refreshError} />
      ) : noRecords ? (
        <NoRecordsState
          onRefresh={() => void load(true)}
          hasConfiguredInstances={Boolean(overview && overview.coverage.totalInstances > 0)}
        />
      ) : overview && displayMetrics ? (
        <>
          <FleetViewIntro currentView={currentView} />

          <FilterBar
            currentView={currentView}
            instances={overview.instances}
            explicitConnections={instanceScopedExplicitConnections}
            unfilterableConnectionCount={unfilterableConnectionCount}
            activityWindow={activityWindow}
            selectedInstanceIds={selectedInstanceIds}
            selectedConnectionKey={selectedConnection ? selectedConnectionKey : ''}
            healthFilter={healthFilter}
            freshnessFilter={freshnessFilter}
            searchText={searchText}
            onActivityWindowChange={(value) => setFilter('window', value === 30 ? null : String(value))}
            onToggleInstance={toggleInstance}
            onSelectAllInstances={() => setFilter('instances', null)}
            onConnectionChange={(value) => setFilter('connection', value || null)}
            onHealthFilterChange={(value) => setFilter('state', value === 'all' ? null : value)}
            onFreshnessFilterChange={(value) => setFilter('freshness', value === 'all' ? null : value)}
            onSearchTextChange={(value) => setFilter('q', value || null, true)}
            onClear={clearFilters}
            hasFilters={hasFilters}
          />

          <CoverageBanner overview={overview} refreshError={refreshError} />

          <FleetDrilldown overview={overview} currentView={currentView} activityWindow={activityWindow} searchParams={searchParams} />

          {filteredInstances.length === 0 && currentView !== 'exceptions' ? (
            <FilterEmptyState onClear={clearFilters} />
          ) : (
            <>
              {currentView === 'overview' && (
                <>
                  <section aria-label="Portfolio key performance indicators">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-9">
                      {KPI_DEFINITIONS.map((definition) => (
                        <KpiCard
                          key={definition.key}
                          definition={definition}
                          metric={displayMetrics[definition.key]}
                          route={workflowHref(definition.route, searchParams)}
                        />
                      ))}
                    </div>
                  </section>

                  <div className="grid min-w-0 gap-6 xl:grid-cols-2">
                    {selectedConnection ? (
                      <UnsupportedEvidence
                        title="Connection-level adoption attribution"
                        description="User, embed, App, AI, and activity totals are instance-level evidence. The active connection filter does not re-label those totals as connection-scoped."
                      />
                    ) : (
                      <EngagementMix instances={filteredInstances} activityWindow={activityWindow} searchParams={searchParams} />
                    )}
                    <ConnectionReadiness connections={filteredConnections} searchParams={searchParams} />
                  </div>

                  <NeedsAttention items={attentionItems} searchParams={searchParams} />
                  {!selectedConnection && <InstanceComparison instances={filteredInstances} activityWindow={activityWindow} searchParams={searchParams} />}
                </>
              )}

              {currentView === 'operational' && (
                <>
                  <OperationalSummary overview={overview} instances={filteredInstances} connection={selectedConnection} />
                  <div className="grid min-w-0 gap-6 xl:grid-cols-2">
                    <ConnectionReadiness connections={filteredConnections} searchParams={searchParams} />
                    <section className="min-w-0 border-t border-border pt-5 xl:border-l xl:pl-6" aria-label="Refresh evidence">
                      <SectionHeading title="Refresh evidence" description="Refresh progress and freshness describe collection coverage only; connection readiness is reported separately." />
                      <dl className="grid gap-3 text-xs sm:grid-cols-2">
                        <div className="rounded-[7px] border border-border bg-white p-3"><dt className="font-semibold text-content-secondary">Refresh state</dt><dd className="mt-1 text-content-primary">{overview.refresh.state}</dd></div>
                        <div className="rounded-[7px] border border-border bg-white p-3"><dt className="font-semibold text-content-secondary">Completed instances</dt><dd className="mt-1 text-content-primary">{overview.refresh.completedInstances} of {overview.refresh.totalInstances}</dd></div>
                        <div className="rounded-[7px] border border-border bg-white p-3"><dt className="font-semibold text-content-secondary">Generated at</dt><dd className="mt-1 break-words text-content-primary">{overview.generatedAt || 'Unavailable'}</dd></div>
                        <div className="rounded-[7px] border border-border bg-white p-3"><dt className="font-semibold text-content-secondary">Cache state</dt><dd className="mt-1 text-content-primary">{overview.cache?.state || 'Unavailable'}</dd></div>
                      </dl>
                    </section>
                  </div>
                  {selectedConnection ? (
                    <UnsupportedEvidence
                      title="Connection-scoped instance failure attribution"
                      description="Structured scan failures are currently attributed to instances and metric reads, not to a specific connection. They are hidden while a connection filter is active to avoid implying a relationship."
                    />
                  ) : (
                    <StructuredFailures overview={overview} instanceIds={filteredInstanceIds} searchText={normalizedSearch} />
                  )}
                  {!selectedConnection && <InstanceComparison instances={filteredInstances} activityWindow={activityWindow} searchParams={searchParams} />}
                </>
              )}

              {currentView === 'adoption' && (
                <>
                  <section aria-label="Adoption key performance indicators">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
                      {KPI_DEFINITIONS.filter((definition) => ['estimatedUniquePeople', 'embedUsers', 'active30d', 'aiChats'].includes(definition.key)).map((definition) => {
                        const metric = definition.key === 'active30d' ? activeMetric(displayMetrics, activityWindow) : displayMetrics[definition.key];
                        const scopedDefinition = definition.key === 'active30d' ? { ...definition, label: `Active ${activityWindow}d` } : definition;
                        return <KpiCard key={definition.key} definition={scopedDefinition} metric={metric} route={workflowHref(definition.route, searchParams)} />;
                      })}
                      <KpiCard
                        definition={{ key: 'internalMemberships', label: 'Internal memberships', route: '/admin/identity/users?tab=groups', icon: Users, iconClassName: 'bg-surface-tertiary text-content-primary' }}
                        metric={displayMetrics.internalMemberships}
                        route={workflowHref('/admin/identity/users?tab=groups', searchParams)}
                      />
                      {ADOPTION_LIFECYCLE_KPI_DEFINITIONS.map((definition) => (
                        <KpiCard
                          key={definition.key}
                          definition={definition}
                          metric={displayMetrics[definition.key]}
                          route={workflowHref(definition.route, searchParams)}
                        />
                      ))}
                    </div>
                    <div className="mt-3 flex min-w-0 items-start gap-3 border-y border-border bg-surface-secondary px-3 py-3 text-content-primary" aria-label="Adoption record count interpretation">
                      <Users size={17} className="mt-0.5 shrink-0 text-content-tertiary" aria-hidden="true" />
                      <p className="min-w-0 text-xs leading-5 text-content-secondary">
                        When available, the stale and never-login metrics count active internal and embed user records returned by their source APIs. These are record counts, not unique people; one person can appear more than once across sources or instances. Each card retains its exact coverage and freshness state.
                      </p>
                    </div>
                  </section>
                  {selectedConnection ? (
                    <UnsupportedEvidence
                      title="Connection-level adoption metrics"
                      description="The selected connection has explicit content attribution, but portfolio user and activity metrics have no documented connection relationship. Those metrics remain unavailable rather than inheriting parent-instance totals."
                    />
                  ) : (
                    <EngagementMix instances={filteredInstances} activityWindow={activityWindow} searchParams={searchParams} />
                  )}
                  {!selectedConnection && <InstanceComparison instances={filteredInstances} activityWindow={activityWindow} searchParams={searchParams} />}
                </>
              )}

              {currentView === 'content' && (
                <>
                  <section aria-label="Content key performance indicators">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
                      {KPI_DEFINITIONS.filter((definition) => ['dashboards', 'models', 'topics', 'aiChats', 'apps'].includes(definition.key)).map((definition) => (
                        <KpiCard key={definition.key} definition={definition} metric={displayMetrics[definition.key]} route={workflowHref(definition.route, searchParams)} />
                      ))}
                    </div>
                  </section>
                  <ContentByConnection connections={filteredConnections} searchParams={searchParams} />
                  <ConnectionReadiness connections={filteredConnections} searchParams={searchParams} />
                </>
              )}

              {currentView === 'exceptions' && (
                <>
                  <NeedsAttention items={attentionItems} searchParams={searchParams} />
                  {selectedConnection ? (
                    <UnsupportedEvidence
                      title="Instance-only exception attribution"
                      description="Failed reads and duplicate saved origins are instance-scoped evidence. They are not shown as connection findings while an explicit connection filter is active."
                    />
                  ) : (
                    <>
                      <StructuredFailures overview={overview} instanceIds={filteredInstanceIds} searchText={normalizedSearch} />
                      <DuplicateOriginEvidence overview={overview} instanceIds={filteredInstanceIds} />
                    </>
                  )}
                </>
              )}
            </>
          )}
        </>
      ) : null}
    </div>
  );
}

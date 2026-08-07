import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Link } from 'react-router';
import {
  Activity,
  AlertTriangle,
  AppWindow,
  ArrowRight,
  ArrowUpDown,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  Database,
  LayoutDashboard,
  Link2,
  RefreshCw,
  Server,
  ShieldCheck,
  Sparkles,
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
  type PortfolioOverviewDTO,
  type PortfolioOverviewMetricsDTO,
  type PortfolioRefreshDTO,
} from '@/services/portfolioOverview';

type ActivityWindow = 7 | 30 | 90;
type HealthFilter = 'all' | 'healthy' | 'attention' | 'unavailable' | 'stale';
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

const KPI_DEFINITIONS: KpiDefinition[] = [
  { key: 'reportingInstances', label: 'Reporting instances', route: '/instances', icon: Server, iconClassName: 'bg-surface-tertiary text-content-primary' },
  { key: 'estimatedUniquePeople', label: 'Estimated internal users', route: '/users', icon: ShieldCheck, iconClassName: 'bg-omni-50 text-omni-700' },
  { key: 'embedUsers', label: 'Embed users', route: '/users?tab=health', icon: Link2, iconClassName: 'bg-omni-100 text-omni-700' },
  { key: 'active30d', label: 'Active 30d', route: '/users?tab=health', icon: Activity, iconClassName: 'bg-success-light text-success' },
  { key: 'dashboards', label: 'Dashboards', route: '/dashboards/operations', icon: LayoutDashboard, iconClassName: 'bg-omni-50 text-omni-700' },
  { key: 'models', label: 'Models', route: '/models', icon: Database, iconClassName: 'bg-omni-100 text-omni-800' },
  { key: 'topics', label: 'Topics', route: '/topics', icon: BookOpen, iconClassName: 'bg-warning-light text-amber-800' },
  { key: 'aiChats', label: 'AI conversations', route: '/instances', icon: Sparkles, iconClassName: 'bg-omni-50 text-omni-700' },
  { key: 'apps', label: 'Apps', route: '/instances', icon: AppWindow, iconClassName: 'bg-surface-tertiary text-content-secondary' },
];

const ENGAGEMENT_SEGMENTS = [
  { key: 'internalMemberships', label: 'Internal', color: '#404754' },
  { key: 'embedUsers', label: 'Embed', color: '#FF5789' },
  { key: 'active', label: 'Active', color: '#48CFAE' },
  { key: 'aiChats', label: 'AI conversations', color: '#FFB84D' },
] as const;

const HEALTH_ORDER: Record<PortfolioHealth, number> = {
  unavailable: 0,
  attention: 1,
  unknown: 2,
  healthy: 3,
};

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
  const reporting = metrics.filter((metric) => metric.value !== null && metric.state !== 'not_configured');
  if (reporting.length === 0) return { value: null, state: 'unavailable' };
  const partial = reporting.length < expectedCount || reporting.some((metric) => metric.state === 'partial' || metric.state === 'unavailable');
  const stale = reporting.some((metric) => metric.state === 'stale');
  return {
    value: reporting.reduce((sum, metric) => sum + (metric.value || 0), 0),
    state: partial ? 'partial' : stale ? 'stale' : 'available',
    coverageLabel: reporting.length < expectedCount ? `${reporting.length} of ${expectedCount} instances` : undefined,
  };
}

function metricsForInstances(instances: PortfolioInstanceDTO[]): PortfolioOverviewMetricsDTO {
  const count = instances.length;
  const reporting = instances.filter((instance) => instance.health !== 'unavailable');
  return {
    reportingInstances: {
      value: reporting.length,
      state: reporting.length < count ? 'partial' : 'available',
      coverageLabel: count > 0 ? `${reporting.length} of ${count} instances` : undefined,
    },
    internalMemberships: aggregateMetrics(instances.map((instance) => instance.metrics.internalMemberships), count),
    estimatedUniquePeople: aggregateMetrics(instances.map((instance) => instance.metrics.estimatedUniquePeople), count),
    embedUsers: aggregateMetrics(instances.map((instance) => instance.metrics.embedUsers), count),
    embedEntities: aggregateMetrics(instances.map((instance) => instance.metrics.embedEntities), count),
    active7d: aggregateMetrics(instances.map((instance) => instance.metrics.active7d), count),
    active30d: aggregateMetrics(instances.map((instance) => instance.metrics.active30d), count),
    active90d: aggregateMetrics(instances.map((instance) => instance.metrics.active90d), count),
    dashboards: aggregateMetrics(instances.map((instance) => instance.metrics.dashboards), count),
    models: aggregateMetrics(instances.map((instance) => instance.metrics.models), count),
    topics: aggregateMetrics(instances.map((instance) => instance.metrics.topics), count),
    aiChats: aggregateMetrics(instances.map((instance) => instance.metrics.aiChats), count),
    apps: aggregateMetrics(instances.map((instance) => instance.metrics.apps), count),
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

function KpiCard({ definition, metric }: { definition: KpiDefinition; metric: PortfolioMetricDTO }) {
  const Icon = definition.icon;
  const displayValue = metric.state === 'not_configured' ? 'Setup required' : formatNumber(metric.value);
  return (
    <Link
      to={definition.route}
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
        <Link to="/instances" className="btn-secondary justify-center px-3">
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
        <Link to="/instances" className="btn-secondary justify-center px-3">
          <Server size={14} />
          Manage instances
        </Link>
      </div>
    </section>
  );
}

function FilterBar({
  instances,
  activityWindow,
  selectedInstanceIds,
  healthFilter,
  onActivityWindowChange,
  onToggleInstance,
  onSelectAllInstances,
  onClearInstances,
  onHealthFilterChange,
  onClear,
  hasFilters,
}: {
  instances: PortfolioInstanceDTO[];
  activityWindow: ActivityWindow;
  selectedInstanceIds: string[] | null;
  healthFilter: HealthFilter;
  onActivityWindowChange: (value: ActivityWindow) => void;
  onToggleInstance: (id: string) => void;
  onSelectAllInstances: () => void;
  onClearInstances: () => void;
  onHealthFilterChange: (value: HealthFilter) => void;
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
    <div className="border-y border-border bg-white px-3 py-3">
      <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-2 xl:grid-cols-[auto_minmax(180px,260px)_minmax(150px,190px)]">
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
                <div className="flex items-center justify-between gap-2 border-b border-border px-1 pb-2">
                  <button type="button" onClick={() => { onSelectAllInstances(); setInstanceMenuOpen(false); }} className="text-xs font-semibold text-omni-700 hover:text-omni-800">
                    Select all
                  </button>
                  <button type="button" onClick={() => { onClearInstances(); setInstanceMenuOpen(false); }} className="text-xs font-semibold text-content-secondary hover:text-content-primary">
                    Select none
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
            <span className="mb-1 block text-[11px] font-semibold text-content-secondary">Health and status</span>
            <select
              value={healthFilter}
              onChange={(event) => onHealthFilterChange(event.target.value as HealthFilter)}
              className="input-field min-h-10 py-2 text-sm"
            >
              <option value="all">All statuses</option>
              <option value="healthy">Healthy</option>
              <option value="attention">Needs attention</option>
              <option value="unavailable">Unavailable</option>
              <option value="stale">Stale</option>
            </select>
          </label>
        </div>

        <button
          type="button"
          onClick={onClear}
          disabled={!hasFilters}
          className="btn-ghost min-h-10 justify-center px-2 text-xs lg:shrink-0"
          title="Clear filters"
        >
          <X size={14} />
          Clear filters
        </button>
      </div>
    </div>
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
      <div className="border-y border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900" role="status">
        <span className="font-semibold">Partial portfolio coverage.</span>{' '}
        {unavailable > 0 ? `${unavailable} unavailable. ` : ''}
        {partial > 0 ? `${partial} partially reporting. ` : ''}
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

function EngagementMix({ instances, activityWindow }: { instances: PortfolioInstanceDTO[]; activityWindow: ActivityWindow }) {
  return (
    <section className="min-w-0 border-t border-border pt-5">
      <SectionHeading
        title="Engagement mix by instance"
        description={`Aggregate membership, embed, active ${activityWindow}d, and AI chat signals by saved instance.`}
        action={(
          <Link to="/users?tab=health" className="inline-flex items-center gap-1 text-xs font-semibold text-omni-700 hover:text-omni-800">
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
          {instances.map((instance) => {
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
                  <Link to="/instances" className="min-w-0 break-words text-sm font-semibold text-content-primary hover:text-omni-700">
                    {instance.label}
                  </Link>
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
        </div>
      )}
    </section>
  );
}

function ConnectionReadiness({ connections }: { connections: PortfolioConnectionDTO[] }) {
  const counts = useMemo(() => ({
    ready: connections.filter((connection) => connection.readiness === 'ready').length,
    attention: connections.filter((connection) => connection.readiness === 'attention').length,
    unavailable: connections.filter((connection) => connection.readiness === 'unavailable' || connection.readiness === 'unknown').length,
  }), [connections]);
  const total = connections.length;

  return (
    <section className="min-w-0 border-t border-border pt-5 xl:border-l xl:pl-6">
      <SectionHeading
        title="Connection readiness"
        description="Schema-model readiness and collection coverage across the selected instances."
        action={(
          <Link to="/connections" className="inline-flex items-center gap-1 text-xs font-semibold text-omni-700 hover:text-omni-800">
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
          <div className="grid grid-cols-3 gap-2 text-center">
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
          </div>
          <div className="mt-4 flex h-3 overflow-hidden rounded-full bg-gray-100" role="img" aria-label={`${counts.ready} ready, ${counts.attention} need attention, ${counts.unavailable} unavailable`}>
            {counts.ready > 0 && <span className="bg-emerald-500" style={{ width: `${(counts.ready / total) * 100}%` }} />}
            {counts.attention > 0 && <span className="bg-amber-500" style={{ width: `${(counts.attention / total) * 100}%` }} />}
            {counts.unavailable > 0 && <span className="bg-gray-400" style={{ width: `${(counts.unavailable / total) * 100}%` }} />}
          </div>
          <div className="mt-4 max-h-[320px] divide-y divide-border overflow-y-auto border-y border-border">
            {connections.map((connection) => (
              <Link key={`${connection.instanceId}:${connection.id}`} to="/connections" className="flex min-w-0 flex-col gap-2 px-2 py-3 hover:bg-surface-secondary sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="break-words text-sm font-semibold text-content-primary">{connection.name}</div>
                  <div className="mt-0.5 break-words text-[11px] text-content-secondary">{connection.instanceLabel}</div>
                </div>
                <span className={`inline-flex max-w-full self-start rounded-full border px-2 py-0.5 text-[10px] font-semibold sm:self-center ${connectionReadinessClasses(connection.readiness)}`}>
                  <span className="truncate">{connection.statusLabel}</span>
                </span>
              </Link>
            ))}
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

function ContentByConnection({ connections }: { connections: PortfolioConnectionDTO[] }) {
  return (
    <section className="min-w-0 border-t border-border pt-5">
      <SectionHeading
        title="Content by connection"
        description="Dashboard, model, and topic inventory attributed to each reporting connection."
        action={(
          <Link to="/content-health" className="inline-flex items-center gap-1 text-xs font-semibold text-omni-700 hover:text-omni-800">
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
            {connections.map((connection) => (
              <div key={`${connection.instanceId}:${connection.id}`} className="min-w-0 py-3">
                <Link to="/connections" className="break-words text-sm font-semibold text-content-primary hover:text-omni-700">{connection.name}</Link>
                <div className="mt-0.5 break-words text-[11px] text-content-secondary">{connection.instanceLabel}</div>
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
                {connections.map((connection) => (
                  <tr key={`${connection.instanceId}:${connection.id}`} className="hover:bg-surface-secondary">
                    <th scope="row" className="max-w-[240px] px-3 py-3 font-semibold text-content-primary">
                      <Link to="/connections" className="block truncate hover:text-omni-700">{connection.name}</Link>
                    </th>
                    <td className="max-w-[220px] px-3 py-3 text-content-secondary"><span className="block truncate">{connection.instanceLabel}</span></td>
                    <td className="px-3 py-3 text-right"><Link to="/dashboards/operations" aria-label={`Open dashboards for ${connection.name}`}><CompactMetric metric={connection.dashboards} /></Link></td>
                    <td className="px-3 py-3 text-right"><Link to="/models" aria-label={`Open models for ${connection.name}`}><CompactMetric metric={connection.models} /></Link></td>
                    <td className="px-3 py-3 text-right"><Link to="/topics" aria-label={`Open topics for ${connection.name}`}><CompactMetric metric={connection.topics} /></Link></td>
                    <td className="px-3 py-3">
                      <span className={`inline-flex max-w-[150px] rounded-full border px-2 py-0.5 text-[10px] font-semibold ${connectionReadinessClasses(connection.readiness)}`}>
                        <span className="truncate">{connection.statusLabel}</span>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
        route: '/instances',
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
        route: '/instances',
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
        route: '/instances',
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
        route: '/instances',
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
        route: '/connections',
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
        route: '/connections',
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

function NeedsAttention({ items }: { items: PortfolioAttentionItemDTO[] }) {
  return (
    <section className="min-w-0 border-t border-border pt-5">
      <SectionHeading
        title="Needs attention"
        description="Plain-language exceptions that can change portfolio coverage or readiness."
      />
      {items.length === 0 ? (
        <div className="flex min-w-0 items-start gap-3 border-y border-emerald-200 bg-emerald-50 px-3 py-4 text-emerald-900">
          <CheckCircle2 size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
          <div className="min-w-0">
            <div className="text-sm font-semibold">No current exceptions</div>
            <div className="mt-0.5 text-xs leading-5 text-emerald-800">All selected sources reported without a portfolio-level warning.</div>
          </div>
        </div>
      ) : (
        <div className="divide-y divide-border border-y border-border">
          {items.map((item) => (
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
              <Link to={item.route} className="inline-flex shrink-0 items-center gap-1 self-start text-xs font-semibold text-omni-700 hover:text-omni-800">
                {item.actionLabel} <ArrowRight size={12} />
              </Link>
            </div>
          ))}
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

function InstanceComparison({ instances, activityWindow }: { instances: PortfolioInstanceDTO[]; activityWindow: ActivityWindow }) {
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
        {sortedInstances.map((instance) => (
          <div key={instance.id} className="min-w-0 py-4">
            <div className="flex min-w-0 flex-col gap-2">
              <Link to="/instances" className="break-words text-sm font-semibold text-content-primary hover:text-omni-700">{instance.label}</Link>
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
            {sortedInstances.map((instance) => (
              <tr key={instance.id} className="hover:bg-surface-secondary">
                <th scope="row" className="max-w-[220px] px-3 py-3 text-left font-semibold text-content-primary">
                  <Link to="/instances" className="block truncate hover:text-omni-700">{instance.label}</Link>
                </th>
                <td className="px-3 py-3"><HealthBadge health={instance.health} label={instance.statusLabel} /></td>
                <td className="px-3 py-3 text-right"><MetricDrillLink metric={activeMetric(instance.metrics, activityWindow)} route="/users?tab=health" label={`${instance.label} active users`} /></td>
                <td className="px-3 py-3 text-right"><MetricDrillLink metric={instance.metrics.internalMemberships} route="/users?tab=groups" label={`${instance.label} internal memberships`} /></td>
                <td className="px-3 py-3 text-right"><MetricDrillLink metric={instance.metrics.embedUsers} route="/users?tab=health" label={`${instance.label} embed users`} /></td>
                <td className="px-3 py-3 text-right"><MetricDrillLink metric={instance.metrics.aiChats} route="/instances" label={`${instance.label} AI conversations`} /></td>
                <td className="px-3 py-3 text-right"><MetricDrillLink metric={instance.metrics.dashboards} route="/dashboards/operations" label={`${instance.label} dashboards`} /></td>
                <td className="px-3 py-3 text-right"><MetricDrillLink metric={instance.metrics.models} route="/models" label={`${instance.label} models`} /></td>
                <td className="px-3 py-3 text-right"><MetricDrillLink metric={instance.metrics.topics} route="/topics" label={`${instance.label} topics`} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
  const requestIdRef = useRef(0);
  const previousRefreshStateRef = useRef<PortfolioRefreshDTO['state']>('idle');
  const [overview, setOverview] = useState<PortfolioOverviewDTO | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshRequestPending, setRefreshRequestPending] = useState(false);
  const [initialError, setInitialError] = useState('');
  const [refreshError, setRefreshError] = useState('');
  const [refreshAnnouncement, setRefreshAnnouncement] = useState('');
  const [activityWindow, setActivityWindow] = useState<ActivityWindow>(30);
  const [selectedInstanceIds, setSelectedInstanceIds] = useState<string[] | null>(null);
  const [healthFilter, setHealthFilter] = useState<HealthFilter>('all');

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

  useEffect(() => {
    if (!overview) return;
    setSelectedInstanceIds((current) => {
      if (current === null) return null;
      const availableIds = new Set(overview.instances.map((instance) => instance.id));
      const next = current.filter((id) => availableIds.has(id));
      return next.length === overview.instances.length ? null : next;
    });
  }, [overview]);

  const hasFilters = activityWindow !== 30 || selectedInstanceIds !== null || healthFilter !== 'all';
  const filteredInstances = useMemo(() => {
    if (!overview) return [];
    return overview.instances.filter((instance) => {
      if (selectedInstanceIds !== null && !selectedInstanceIds.includes(instance.id)) return false;
      if (healthFilter === 'stale') return instance.freshness === 'stale';
      if (healthFilter !== 'all' && instance.health !== healthFilter) return false;
      return true;
    });
  }, [healthFilter, overview, selectedInstanceIds]);
  const filteredInstanceIds = useMemo(() => new Set(filteredInstances.map((instance) => instance.id)), [filteredInstances]);
  const filteredConnections = useMemo(() => {
    if (!overview) return [];
    return overview.connections.filter((connection) => filteredInstanceIds.has(connection.instanceId));
  }, [filteredInstanceIds, overview]);
  const filtersChangeInstanceScope = selectedInstanceIds !== null || healthFilter !== 'all';
  const displayMetrics = useMemo(() => {
    if (!overview) return null;
    return filtersChangeInstanceScope ? metricsForInstances(filteredInstances) : overview.metrics;
  }, [filteredInstances, filtersChangeInstanceScope, overview]);
  const attentionItems = useMemo(() => overview
    ? buildAttentionQueue(overview, filteredInstances, filteredConnections)
    : [], [filteredConnections, filteredInstances, overview]);

  function clearFilters() {
    setActivityWindow(30);
    setSelectedInstanceIds(null);
    setHealthFilter('all');
  }

  function toggleInstance(id: string) {
    if (!overview) return;
    setSelectedInstanceIds((current) => {
      const allIds = overview.instances.map((instance) => instance.id);
      const selected = current === null ? allIds : current;
      const next = selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id];
      return next.length === allIds.length ? null : next;
    });
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
        title="Portfolio Overview"
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
            <Link to="/instances" className="btn-secondary min-h-10 min-w-0 justify-center px-3 text-xs">
              <Server size={14} className="shrink-0" />
              <span className="break-words">Manage instances</span>
            </Link>
          </>
        )}
      />

      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {refreshAnnouncement}
      </div>

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
          <FilterBar
            instances={overview.instances}
            activityWindow={activityWindow}
            selectedInstanceIds={selectedInstanceIds}
            healthFilter={healthFilter}
            onActivityWindowChange={setActivityWindow}
            onToggleInstance={toggleInstance}
            onSelectAllInstances={() => setSelectedInstanceIds(null)}
            onClearInstances={() => setSelectedInstanceIds([])}
            onHealthFilterChange={setHealthFilter}
            onClear={clearFilters}
            hasFilters={hasFilters}
          />

          <CoverageBanner overview={overview} refreshError={refreshError} />

          {filteredInstances.length === 0 ? (
            <FilterEmptyState onClear={clearFilters} />
          ) : (
            <>
              <section aria-label="Portfolio key performance indicators">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-9">
                  {KPI_DEFINITIONS.map((definition) => (
                    <KpiCard key={definition.key} definition={definition} metric={displayMetrics[definition.key]} />
                  ))}
                </div>
              </section>

              <div className="grid min-w-0 gap-6 xl:grid-cols-2">
                <EngagementMix instances={filteredInstances} activityWindow={activityWindow} />
                <ConnectionReadiness connections={filteredConnections} />
              </div>

              <ContentByConnection connections={filteredConnections} />
              <NeedsAttention items={attentionItems} />
              <InstanceComparison instances={filteredInstances} activityWindow={activityWindow} />
            </>
          )}
        </>
      ) : null}
    </div>
  );
}

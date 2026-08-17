import type { CachedDashboard } from '@/services/deckBuilder/localCache';

export const DASHBOARD_PAGE_SIZE = 100;
const UNKNOWN_CONNECTION_KEY = '__connection-unavailable__';

export function cleanDashboardText(value: string | undefined): string {
  return value?.trim() || '';
}

export function shortConnectionId(connectionId: string): string {
  return connectionId.length <= 8 ? connectionId : connectionId.slice(0, 8);
}

export function dashboardConnectionLabel(dashboard: CachedDashboard): string {
  const name = cleanDashboardText(dashboard.connectionName);
  if (name) return name;
  const connectionId = cleanDashboardText(dashboard.connectionId);
  return connectionId
    ? `Connection ${shortConnectionId(connectionId)}`
    : 'Connection unavailable';
}

function dashboardConnectionKey(dashboard: CachedDashboard): string {
  return cleanDashboardText(dashboard.connectionId) || UNKNOWN_CONNECTION_KEY;
}

export function dashboardOptionIdentity(dashboard: CachedDashboard): string {
  return `${encodeURIComponent(dashboardConnectionKey(dashboard))}::${encodeURIComponent(dashboard.id)}`;
}

export function dashboardOptionLabel(dashboard: CachedDashboard): string {
  const folder = cleanDashboardText(dashboard.folderPath) || 'No folder';
  const connectionId = cleanDashboardText(dashboard.connectionId);
  const connection = dashboardConnectionLabel(dashboard);
  const connectionIdentity = connectionId
    ? `${connection}, connection ID ${connectionId}`
    : connection;
  return `Select dashboard ${dashboard.name} in ${folder} on ${connectionIdentity}`;
}

function compareDashboards(a: CachedDashboard, b: CachedDashboard): number {
  return dashboardConnectionLabel(a).localeCompare(dashboardConnectionLabel(b))
    || dashboardConnectionKey(a).localeCompare(dashboardConnectionKey(b))
    || a.name.localeCompare(b.name)
    || cleanDashboardText(a.folderPath).localeCompare(cleanDashboardText(b.folderPath))
    || a.id.localeCompare(b.id);
}

function matchesDashboard(dashboard: CachedDashboard, query: string): boolean {
  if (!query) return true;
  return [
    dashboard.name,
    dashboard.folderPath,
    dashboard.connectionName,
    dashboard.connectionId,
    dashboardConnectionLabel(dashboard),
  ].some((value) => cleanDashboardText(value).toLocaleLowerCase().includes(query));
}

export interface DashboardSearchGroup {
  key: string;
  label: string;
  connectionId?: string;
  connectionName?: string;
  matchCount: number;
  dashboards: CachedDashboard[];
}

export interface DashboardSearchResults {
  groups: DashboardSearchGroup[];
  visibleDashboards: CachedDashboard[];
  selectedOptionIdentity?: string;
  totalMatches: number;
  visibleMatchCount: number;
  hasMore: boolean;
}

export function buildDashboardSearchResults(
  dashboards: CachedDashboard[],
  query: string,
  selectedDashboardId: string | undefined,
  visibleLimit = DASHBOARD_PAGE_SIZE,
  selectedDashboardConnectionId?: string,
): DashboardSearchResults {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const sortedMatches = dashboards
    .filter((dashboard) => matchesDashboard(dashboard, normalizedQuery))
    .sort(compareDashboards);
  const matchesByIdentity = new Map<string, CachedDashboard>();
  for (const dashboard of sortedMatches) {
    const identity = dashboardOptionIdentity(dashboard);
    if (!matchesByIdentity.has(identity)) matchesByIdentity.set(identity, dashboard);
  }
  const matches = Array.from(matchesByIdentity.values());
  const selectedConnectionId = cleanDashboardText(selectedDashboardConnectionId);
  const selectedDashboard = selectedDashboardId
    ? matches.find((dashboard) => dashboard.id === selectedDashboardId
      && (!selectedConnectionId || dashboardConnectionKey(dashboard) === selectedConnectionId))
    : undefined;
  const selectedOptionIdentity = selectedDashboard
    ? dashboardOptionIdentity(selectedDashboard)
    : undefined;
  const boundedLimit = Math.max(1, Math.floor(visibleLimit));
  const visibleIdentities = new Set(matches.slice(0, boundedLimit).map(dashboardOptionIdentity));

  // A selection made lower in a large inventory remains visible after the picker
  // returns to its bounded initial state. Search itself is expanded via Show more.
  if (selectedOptionIdentity) visibleIdentities.add(selectedOptionIdentity);

  const visibleDashboards = matches.filter((dashboard) => visibleIdentities.has(dashboardOptionIdentity(dashboard)));
  const matchCounts = new Map<string, number>();
  for (const dashboard of matches) {
    const key = dashboardConnectionKey(dashboard);
    matchCounts.set(key, (matchCounts.get(key) || 0) + 1);
  }

  const groupsByKey = new Map<string, DashboardSearchGroup>();
  for (const dashboard of visibleDashboards) {
    const key = dashboardConnectionKey(dashboard);
    const existing = groupsByKey.get(key);
    if (existing) {
      existing.dashboards.push(dashboard);
      continue;
    }
    groupsByKey.set(key, {
      key,
      label: dashboardConnectionLabel(dashboard),
      connectionId: cleanDashboardText(dashboard.connectionId) || undefined,
      connectionName: cleanDashboardText(dashboard.connectionName) || undefined,
      matchCount: matchCounts.get(key) || 0,
      dashboards: [dashboard],
    });
  }

  return {
    groups: Array.from(groupsByKey.values()),
    visibleDashboards,
    selectedOptionIdentity,
    totalMatches: matches.length,
    visibleMatchCount: visibleDashboards.length,
    hasMore: matches.length > visibleDashboards.length,
  };
}

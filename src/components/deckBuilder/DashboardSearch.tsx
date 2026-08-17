import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Search, RefreshCcw, Loader2, Folder, Database } from 'lucide-react';
import { selectedBadgeClass, selectedRowClass, unselectedRowClass } from '@/components/ui/selectionStyles';
import type { CachedDashboard } from '@/services/deckBuilder/localCache';
import {
  buildDashboardSearchResults,
  cleanDashboardText,
  DASHBOARD_PAGE_SIZE,
  dashboardOptionIdentity,
  dashboardOptionLabel,
} from './dashboardSearchModel';

interface Props {
  dashboards: CachedDashboard[];
  loading: boolean;
  lastSyncedAt: number | null;
  onRefresh: () => void;
  onPick: (d: CachedDashboard) => void;
  selectedDashboardId?: string;
  selectedDashboardConnectionId?: string;
  disabled?: boolean;
  showInlineResults?: boolean;
}

function timeAgo(ts: number | null): string {
  if (!ts) return 'never synced';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function DashboardSearch({ dashboards, loading, lastSyncedAt, onRefresh, onPick, selectedDashboardId, selectedDashboardConnectionId, disabled, showInlineResults = false }: Props) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState<number | null>(null);
  const [visibleLimit, setVisibleLimit] = useState(DASHBOARD_PAGE_SIZE);
  const containerRef = useRef<HTMLDivElement>(null);

  const searchResults = useMemo(
    () => buildDashboardSearchResults(
      dashboards,
      query,
      selectedDashboardId,
      visibleLimit,
      selectedDashboardConnectionId,
    ),
    [dashboards, query, selectedDashboardConnectionId, selectedDashboardId, visibleLimit],
  );
  const { groups, visibleDashboards, selectedOptionIdentity, totalMatches, visibleMatchCount, hasMore } = searchResults;
  const visibleIndexByIdentity = useMemo(
    () => new Map(visibleDashboards.map((dashboard, index) => [dashboardOptionIdentity(dashboard), index])),
    [visibleDashboards],
  );

  useEffect(() => {
    setHighlight(null);
  }, [query, open]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((current) => visibleDashboards.length === 0
        ? null
        : Math.min((current ?? -1) + 1, visibleDashboards.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((current) => visibleDashboards.length === 0
        ? null
        : Math.max((current ?? 1) - 1, 0));
    } else if (e.key === 'Enter' && highlight !== null && visibleDashboards[highlight]) {
      e.preventDefault();
      onPick(visibleDashboards[highlight]);
      setOpen(false);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-content-tertiary" />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setVisibleLimit(DASHBOARD_PAGE_SIZE);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={handleKey}
            placeholder={loading ? 'Loading dashboards…' : `Search ${dashboards.length} dashboard${dashboards.length === 1 ? '' : 's'}…`}
            disabled={disabled || loading}
            className="input-field pl-9"
          />
        </div>
        <button
          onClick={onRefresh}
          disabled={loading || disabled}
          className="btn-ghost btn-sm"
          type="button"
          title="Refresh dashboard list from Omni"
        >
          {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCcw size={13} />}
          Refresh
        </button>
      </div>
      <div className="text-[11px] text-content-tertiary mt-1.5 flex items-center gap-2">
        <span>
          {dashboards.length} fetched · cached locally · last synced {timeAgo(lastSyncedAt)}
          {hasMore ? ` · showing ${visibleMatchCount} of ${totalMatches} matches` : ''}
        </span>
      </div>

      {(open || showInlineResults) && visibleDashboards.length > 0 && (
        <div className={`${showInlineResults ? 'mt-2' : 'absolute z-30 left-0 right-0 mt-1 shadow-dropdown'} bg-white border border-border rounded-card max-h-80 overflow-y-auto`}>
          {groups.map((group) => (
            <section
              key={group.key}
              role="group"
              aria-label={group.connectionId
                ? `${group.label} dashboards, connection ID ${group.connectionId}`
                : `${group.label} dashboards`}
              title={group.connectionId || undefined}
            >
              <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-border bg-surface-secondary px-3 py-2 text-[11px] font-semibold text-content-secondary">
                <span className="flex min-w-0 items-center gap-1.5 truncate">
                  <Database size={11} aria-hidden="true" />
                  <span className="truncate">{group.label}</span>
                </span>
                <span className="shrink-0 font-normal text-content-tertiary">
                  {group.dashboards.length < group.matchCount
                    ? `${group.dashboards.length} of ${group.matchCount}`
                    : `${group.matchCount} dashboard${group.matchCount === 1 ? '' : 's'}`}
                </span>
              </div>
              {group.dashboards.map((d) => {
                const optionIdentity = dashboardOptionIdentity(d);
                const idx = visibleIndexByIdentity.get(optionIdentity) ?? 0;
                const selected = selectedOptionIdentity === optionIdentity;
                const active = idx === highlight;
                return (
                  <button
                    key={optionIdentity}
                    type="button"
                    onMouseEnter={() => setHighlight(idx)}
                    onMouseLeave={() => setHighlight((current) => current === idx ? null : current)}
                    onClick={() => {
                      setHighlight(idx);
                      onPick(d);
                      setOpen(false);
                    }}
                    aria-label={dashboardOptionLabel(d)}
                    aria-pressed={selected}
                    data-dashboard-selected={selected}
                    data-dashboard-active={active}
                    className={`w-full text-left px-3 py-2.5 border-b border-border/40 last:border-0 transition-all ${
                      selected
                        ? selectedRowClass
                        : active
                          ? 'border-l-4 border-l-border-strong bg-surface-secondary text-content-primary ring-1 ring-inset ring-border-strong'
                          : unselectedRowClass
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-[13px] font-medium text-content-primary truncate">{d.name}</div>
                        <div className="text-[11px] text-content-tertiary truncate flex items-center gap-1 mt-0.5">
                          <Folder size={10} aria-hidden="true" />
                          {cleanDashboardText(d.folderPath) || 'No folder'}
                        </div>
                      </div>
                      {selected && (
                        <span className={selectedBadgeClass}>
                          <CheckCircle2 size={12} />
                          Selected
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </section>
          ))}
          {hasMore && (
            <div className="border-t border-border p-2">
              <button
                type="button"
                className="btn-ghost btn-sm w-full justify-center"
                onClick={() => setVisibleLimit((limit) => limit + DASHBOARD_PAGE_SIZE)}
              >
                Show more dashboards
              </button>
            </div>
          )}
        </div>
      )}
      {(open || showInlineResults) && !loading && visibleDashboards.length === 0 && dashboards.length > 0 && (
        <div className={`${showInlineResults ? 'mt-2' : 'absolute z-30 left-0 right-0 mt-1 shadow-dropdown'} bg-white border border-border rounded-card px-3 py-3 text-sm text-content-tertiary`}>
          No dashboards match.
        </div>
      )}
    </div>
  );
}

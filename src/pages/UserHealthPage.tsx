import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, Loader2, RefreshCw, ShieldCheck, Users } from 'lucide-react';
import { SearchInput } from '@/components/ui/SearchInput';
import { StatusChip } from '@/components/ui/StatusChip';
import { useConnection } from '@/hooks/useConnection';
import { useConnectionRequestGuard } from '@/hooks/useConnectionRequestGuard';
import {
  loadEmbedUserMetricsForInstance,
  USER_HEALTH_SELECTED_INSTANCE_RESPONSE_INVALID,
  type InstanceEmbedUserStats,
} from '@/services/opsConsole';
import {
  buildUserHealth,
  readExpectedInactiveEntityKeys,
  writeExpectedInactiveEntityKeys,
  type UserHealthEntityRow,
  type UserHealthFinding,
  type UserHealthInactiveUserRow,
  type UserHealthProvenance,
  type UserHealthResult,
} from '@/services/userHealth';
import { csvRowsToText } from '@/utils/csvExport';

type EntityFilter = 'all' | 'review_needed' | 'no_active_users' | 'active' | 'expected_inactive' | 'unassigned';
type UserFilter = 'all' | 'inactive' | 'never_logged_in' | 'inactive_never_logged_in' | 'unassigned';

const ENTITY_FILTER_OPTIONS: Array<{ value: EntityFilter; label: string }> = [
  { value: 'all', label: 'All entities' },
  { value: 'review_needed', label: 'Review needed' },
  { value: 'no_active_users', label: 'No active users' },
  { value: 'active', label: 'Active entities' },
  { value: 'expected_inactive', label: 'Expected inactive' },
  { value: 'unassigned', label: 'Unassigned records' },
];

const USER_FILTER_OPTIONS: Array<{ value: UserFilter; label: string }> = [
  { value: 'all', label: 'All reviews' },
  { value: 'inactive', label: 'Inactive' },
  { value: 'never_logged_in', label: 'Never logged in' },
  { value: 'inactive_never_logged_in', label: 'Inactive + never' },
  { value: 'unassigned', label: 'Unassigned records' },
];

function errorText(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function formatDate(value?: string | null) {
  if (!value) return 'Never';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleDateString();
}

function formatDateTime(value?: string | null) {
  if (!value) return 'Unknown';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString();
}

function findingLabel(finding: UserHealthFinding) {
  if (finding === 'no_active_users') return 'No active users';
  if (finding === 'unassigned') return 'Unassigned';
  return 'Active';
}

function findingStatus(row: UserHealthEntityRow) {
  if (row.expectedInactive) return { status: 'skipped', label: 'Expected inactive' };
  if (row.finding === 'active') return { status: 'success', label: 'Active' };
  if (row.finding === 'unassigned') return { status: 'warning', label: 'Unassigned' };
  return { status: 'warning', label: 'No active users' };
}

function provenanceLabel(provenance: UserHealthProvenance) {
  if (provenance === 'live_scan') return 'Live embed-user scan';
  if (provenance === 'browser_cache') return 'Retained browser cache';
  return 'Source not yet established';
}

function coverageValue(value: number, health: UserHealthResult) {
  return health.coverage.status === 'unavailable' || health.coverage.status === 'not_scanned' ? '—' : value;
}

function userReasonLabel(row: UserHealthInactiveUserRow) {
  if (row.reason === 'inactive_never_logged_in') return 'Inactive, never logged in';
  if (row.reason === 'inactive') return 'Inactive';
  return 'Never logged in';
}

function exportEntityCsv(rows: UserHealthEntityRow[], health: UserHealthResult) {
  const header = [
    'instance',
    'source_entity',
    'assignment',
    'total_embed_user_records',
    'active_embed_user_records',
    'inactive_embed_user_records',
    'never_logged_in_users',
    'last_login',
    'finding',
    'expected_inactive',
    'review_needed',
    'coverage',
    'source_as_of',
    'provenance',
  ];
  const body = rows.map((row) => [
    row.instanceLabel,
    row.entityName,
    row.assignment,
    row.totalUsers,
    row.activeUsers,
    row.inactiveUsers,
    row.neverLoggedInUsers,
    row.lastLogin || '',
    row.finding,
    row.expectedInactive,
    row.actionNeeded,
    health.coverage.status,
    health.coverage.asOf || '',
    health.coverage.provenance,
  ]);
  const csv = csvRowsToText([header, ...body]);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `omnikit-user-health-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function rowMatchesSearch(row: UserHealthEntityRow, search: string) {
  const value = search.trim().toLowerCase();
  if (!value) return true;
  return [
    row.instanceLabel,
    row.baseUrl,
    row.entityName,
    row.assignment,
    findingLabel(row.finding),
  ].some((part) => part.toLowerCase().includes(value));
}

function rowMatchesEntityFilter(row: UserHealthEntityRow, filter: EntityFilter) {
  if (filter === 'all') return true;
  if (filter === 'review_needed') return row.actionNeeded;
  if (filter === 'expected_inactive') return row.expectedInactive;
  if (filter === 'unassigned') return row.assignment === 'unassigned';
  return row.finding === filter;
}

function userMatchesSearch(row: UserHealthInactiveUserRow, search: string) {
  const value = search.trim().toLowerCase();
  if (!value) return true;
  return [
    row.instanceLabel,
    row.entityName,
    row.displayName,
    row.userName,
    userReasonLabel(row),
  ].some((part) => part.toLowerCase().includes(value));
}

function userMatchesFilter(row: UserHealthInactiveUserRow, filter: UserFilter) {
  if (filter === 'all') return true;
  if (filter === 'inactive') return !row.active;
  if (filter === 'never_logged_in') return !row.lastLogin;
  if (filter === 'unassigned') return row.assignment === 'unassigned';
  return row.reason === filter;
}

export function UserHealthPage() {
  const { connection } = useConnection();
  const { connectionKey, isActiveConnectionRequest } = useConnectionRequestGuard(connection);
  const selectedInstanceId = connection.instanceId?.trim() || '';
  const selectedInstanceLabel = connection.instanceLabel?.trim() || selectedInstanceId;
  const selectedInstanceReady = Boolean(
    selectedInstanceId
    && connection.connectionMode === 'vault'
    && connection.status === 'success',
  );
  const [embedUserStats, setEmbedUserStats] = useState<InstanceEmbedUserStats[]>([]);
  const [sourceAsOf, setSourceAsOf] = useState('');
  const [provenance, setProvenance] = useState<UserHealthProvenance>('unknown');
  const [expectedInactiveKeys, setExpectedInactiveKeys] = useState(() => readExpectedInactiveEntityKeys());
  const [search, setSearch] = useState('');
  const [entityFilter, setEntityFilter] = useState<EntityFilter>('all');
  const [userFilter, setUserFilter] = useState<UserFilter>('all');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const refreshSequenceRef = useRef(0);
  const refreshAbortRef = useRef<AbortController | null>(null);

  useLayoutEffect(() => {
    refreshSequenceRef.current += 1;
    refreshAbortRef.current?.abort();
    refreshAbortRef.current = null;
    setEmbedUserStats([]);
    setSourceAsOf('');
    setProvenance('unknown');
    setSearch('');
    setEntityFilter('all');
    setUserFilter('all');
    setLoading(false);
    setError('');
    return () => refreshAbortRef.current?.abort();
  }, [connectionKey, selectedInstanceId, selectedInstanceReady]);

  const refresh = useCallback(async () => {
    const requestKey = connectionKey;
    if (!selectedInstanceReady) {
      setError('Select and connect a validated saved Omni instance before refreshing User Health.');
      return;
    }
    const requestSequence = refreshSequenceRef.current + 1;
    refreshSequenceRef.current = requestSequence;
    refreshAbortRef.current?.abort();
    const controller = new AbortController();
    refreshAbortRef.current = controller;
    const isCurrentRequest = () => (
      refreshSequenceRef.current === requestSequence
      && !controller.signal.aborted
      && isActiveConnectionRequest(requestKey)
    );
    setLoading(true);
    setError('');
    try {
      const users = await loadEmbedUserMetricsForInstance(selectedInstanceId, requestKey, {
        signal: controller.signal,
      });
      if (!isCurrentRequest()) return;
      setEmbedUserStats(users.instances);
      setSourceAsOf(users.savedAt);
      setProvenance('live_scan');
    } catch (err) {
      if (!isCurrentRequest()) return;
      if ((err as { code?: unknown })?.code === USER_HEALTH_SELECTED_INSTANCE_RESPONSE_INVALID) {
        setEmbedUserStats([]);
        setSourceAsOf('');
        setProvenance('unknown');
      }
      setError(errorText(err, 'Could not load user health metrics.'));
    } finally {
      if (isCurrentRequest()) {
        refreshAbortRef.current = null;
        setLoading(false);
      }
    }
  }, [connectionKey, isActiveConnectionRequest, selectedInstanceId, selectedInstanceReady]);

  const health = useMemo(
    () => buildUserHealth(embedUserStats, expectedInactiveKeys, new Date(), { asOf: sourceAsOf, provenance }),
    [embedUserStats, expectedInactiveKeys, provenance, sourceAsOf],
  );
  const visibleEntities = useMemo(
    () => health.entities.filter((row) => (
      rowMatchesEntityFilter(row, entityFilter)
      && rowMatchesSearch(row, search)
    )),
    [entityFilter, health.entities, search],
  );
  const visibleUsers = useMemo(
    () => health.inactiveUsers.filter((row) => (
      userMatchesFilter(row, userFilter)
      && userMatchesSearch(row, search)
    )).slice(0, 80),
    [health.inactiveUsers, search, userFilter],
  );

  function toggleExpected(row: UserHealthEntityRow) {
    if (row.assignment !== 'explicit_source') return;
    setExpectedInactiveKeys((current) => {
      const next = new Set(current);
      if (next.has(row.key)) next.delete(row.key);
      else next.add(row.key);
      writeExpectedInactiveEntityKeys(next);
      return next;
    });
  }

  return (
    <div className="space-y-5">
      <div className="card p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <h2 className="text-base font-semibold text-content-primary">Embed entity activity</h2>
            <p className="mt-1 text-sm text-content-secondary">
              Review source-reported embed-user activity and entity attribution for the currently selected Omni instance. This is readiness evidence, not permission or access proof.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => exportEntityCsv(health.entities, health)} disabled={health.entities.length === 0} className="btn-secondary inline-flex items-center gap-2">
              <Download size={15} />
              Export CSV
            </button>
            <button type="button" onClick={() => void refresh()} disabled={loading || !selectedInstanceReady} className="btn-primary inline-flex items-center gap-2">
              {loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
              Refresh
            </button>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-content-secondary">
          <span>Instance: {selectedInstanceLabel || 'No saved instance selected'}</span>
          <span>Source: {provenanceLabel(health.coverage.provenance)}</span>
          <span>As of: {formatDateTime(health.coverage.asOf)}</span>
          <span>Coverage: {health.coverage.status.replace('_', ' ')}</span>
          <span>Filtered records: {coverageValue(health.coverage.filteredRecords, health)}</span>
        </div>
        {error && (
          <div className="mt-4 rounded-card border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            <AlertTriangle size={14} className="mr-1 inline-block" />
            {error} Retained results, if shown, remain at the source timestamp above.
          </div>
        )}
        {!error && embedUserStats.length === 0 && (
          <div className="mt-4 rounded-card border border-dashed border-border-subtle p-4 text-sm text-content-secondary">
            {selectedInstanceReady
              ? 'Refresh to load embed-user activity for the selected instance from the native vault.'
              : 'Select and connect a validated saved Omni instance to load User Health.'}
          </div>
        )}
        {health.coverage.status === 'partial' && (
          <div className="mt-4 rounded-card border border-yellow-200 bg-yellow-50 px-3 py-2 text-sm text-yellow-800">
            <AlertTriangle size={14} className="mr-1 inline-block" />
            The selected-instance scan returned partial coverage. Totals exclude failed reads; failed reads are not counted as zero.
          </div>
        )}
        {health.coverage.status === 'unavailable' && (
          <div className="mt-4 rounded-card border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            <AlertTriangle size={14} className="mr-1 inline-block" />
            Embed-user activity is unavailable for the selected instance. No zero-user or no-active-user finding was inferred.
          </div>
        )}
        {health.sourceFailures.length > 0 && (
          <div className="mt-3 space-y-2">
            {health.sourceFailures.map((failure) => (
              <div key={failure.instanceId} className="rounded-card border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                <span className="font-semibold">{failure.instanceLabel}</span>: {failure.reason.replace('_', ' ')} ({failure.reasonCode}) — {failure.message}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
        <div className="rounded-card border border-border-subtle bg-white p-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-content-secondary">
            <AlertTriangle size={14} />
            Review needed
          </div>
          <div className="mt-2 text-2xl font-semibold text-content-primary">{coverageValue(health.summary.actionNeededEntities, health)}</div>
        </div>
        <div className="rounded-card border border-border-subtle bg-white p-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-content-secondary">
            <Users size={14} />
            Source entities
          </div>
          <div className="mt-2 text-2xl font-semibold text-content-primary">{coverageValue(health.summary.totalEntities, health)}</div>
        </div>
        <div className="rounded-card border border-border-subtle bg-white p-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-content-secondary">
            <ShieldCheck size={14} />
            No active records
          </div>
          <div className="mt-2 text-2xl font-semibold text-content-primary">{coverageValue(health.summary.noActiveUserEntities, health)}</div>
        </div>
        <div className="rounded-card border border-border-subtle bg-white p-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-content-secondary">
            <CheckCircle2 size={14} />
            Expected inactive
          </div>
          <div className="mt-2 text-2xl font-semibold text-content-primary">{coverageValue(health.summary.expectedInactiveEntities, health)}</div>
        </div>
        <div className="rounded-card border border-border-subtle bg-white p-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-content-secondary">
            <Users size={14} />
            Inactive records
          </div>
          <div className="mt-2 text-2xl font-semibold text-content-primary">{coverageValue(health.summary.inactiveUsers, health)}</div>
        </div>
        <div className="rounded-card border border-border-subtle bg-white p-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-content-secondary">
            <Users size={14} />
            Unassigned records
          </div>
          <div className="mt-2 text-2xl font-semibold text-content-primary">{coverageValue(health.summary.unassignedUsers, health)}</div>
        </div>
      </div>

      <div className="card p-5">
        <h3 className="text-base font-semibold text-content-primary">Last-login aging</h3>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-card bg-surface-secondary p-3">
            <div className="text-xs font-semibold uppercase tracking-[0.14em] text-content-secondary">Last 30 days</div>
            <div className="mt-2 text-xl font-semibold text-content-primary">{coverageValue(health.summary.lastLoginBuckets.last30d, health)}</div>
          </div>
          <div className="rounded-card bg-surface-secondary p-3">
            <div className="text-xs font-semibold uppercase tracking-[0.14em] text-content-secondary">31-90 days</div>
            <div className="mt-2 text-xl font-semibold text-content-primary">{coverageValue(health.summary.lastLoginBuckets.last31To90d, health)}</div>
          </div>
          <div className="rounded-card bg-surface-secondary p-3">
            <div className="text-xs font-semibold uppercase tracking-[0.14em] text-content-secondary">Over 90 days</div>
            <div className="mt-2 text-xl font-semibold text-content-primary">{coverageValue(health.summary.lastLoginBuckets.olderThan90d, health)}</div>
          </div>
          <div className="rounded-card bg-surface-secondary p-3">
            <div className="text-xs font-semibold uppercase tracking-[0.14em] text-content-secondary">Never</div>
            <div className="mt-2 text-xl font-semibold text-content-primary">{coverageValue(health.summary.lastLoginBuckets.neverLoggedIn, health)}</div>
          </div>
        </div>
      </div>

      <div className="card p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <h3 className="text-base font-semibold text-content-primary">Source entity activity</h3>
          <div className="w-full md:max-w-sm">
            <SearchInput value={search} onChange={setSearch} placeholder="Search source entities and records..." />
          </div>
        </div>
        <div className="mt-3 max-w-sm">
          <select value={entityFilter} onChange={(event) => setEntityFilter(event.target.value as EntityFilter)} className="input-field text-sm">
            {ENTITY_FILTER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full divide-y divide-border-subtle text-sm">
            <thead>
              <tr className="text-left text-xs font-semibold uppercase tracking-[0.14em] text-content-secondary">
                <th className="px-3 py-2">Instance</th>
                <th className="px-3 py-2">Entity</th>
                <th className="px-3 py-2">Embed-user records</th>
                <th className="px-3 py-2">Last login</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 text-right">Marker</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {visibleEntities.map((row) => {
                const status = findingStatus(row);
                return (
                  <tr key={row.key} className={row.actionNeeded ? 'bg-red-50/30' : ''}>
                    <td className="px-3 py-3 align-top">
                      <div className="font-semibold text-content-primary">{row.instanceLabel}</div>
                      <div className="max-w-[220px] truncate text-xs text-content-secondary">{row.baseUrl}</div>
                    </td>
                    <td className="px-3 py-3 align-top">
                      <div className="font-semibold text-content-primary">{row.entityName}</div>
                      <div className="max-w-[280px] truncate text-xs text-content-secondary">
                        {row.assignment === 'explicit_source' ? 'Explicit source entity metadata' : 'No source entity attribution'}
                      </div>
                    </td>
                    <td className="px-3 py-3 align-top text-content-secondary">
                      <span className="font-semibold text-content-primary">{row.activeUsers}</span> active / {row.totalUsers} total
                      <div className="text-xs">{row.inactiveUsers} inactive · {row.neverLoggedInUsers} never logged in</div>
                    </td>
                    <td className="px-3 py-3 align-top text-content-secondary">{formatDate(row.lastLogin)}</td>
                    <td className="px-3 py-3 align-top"><StatusChip status={status.status} label={status.label} /></td>
                    <td className="px-3 py-3 align-top text-right">
                      <button type="button" onClick={() => toggleExpected(row)} disabled={row.assignment === 'unassigned'} className="btn-secondary text-xs">
                        {row.assignment === 'unassigned' ? 'Needs attribution' : row.expectedInactive ? 'Unmark' : 'Expected inactive'}
                      </button>
                    </td>
                  </tr>
                );
              })}
              {visibleEntities.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-sm text-content-secondary">
                    {health.coverage.status === 'unavailable' ? 'Source entity activity is unavailable.' : 'No source-entity activity rows match this view.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <h3 className="text-base font-semibold text-content-primary">Inactive and never-seen embed-user records</h3>
          <div className="flex items-center gap-3">
            <select value={userFilter} onChange={(event) => setUserFilter(event.target.value as UserFilter)} className="input-field text-sm">
              {USER_FILTER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <span className="text-xs text-content-secondary">{visibleUsers.length}/{health.inactiveUsers.length}</span>
          </div>
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full divide-y divide-border-subtle text-sm">
            <thead>
              <tr className="text-left text-xs font-semibold uppercase tracking-[0.14em] text-content-secondary">
                <th className="px-3 py-2">Embed-user record</th>
                <th className="px-3 py-2">Instance</th>
                <th className="px-3 py-2">Entity</th>
                <th className="px-3 py-2">Last login</th>
                <th className="px-3 py-2">Reason</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {visibleUsers.map((row) => (
                <tr key={row.key}>
                  <td className="px-3 py-3">
                    <div className="font-semibold text-content-primary">{row.displayName || row.userName}</div>
                    <div className="text-xs text-content-secondary">{row.userName}</div>
                  </td>
                  <td className="px-3 py-3 text-content-secondary">{row.instanceLabel}</td>
                  <td className="px-3 py-3 text-content-secondary">{row.entityName}</td>
                  <td className="px-3 py-3 text-content-secondary">{formatDate(row.lastLogin)}</td>
                  <td className="px-3 py-3"><StatusChip status={row.expectedInactive ? 'skipped' : 'warning'} label={userReasonLabel(row)} /></td>
                </tr>
              ))}
              {visibleUsers.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-center text-sm text-content-secondary">
                    {health.coverage.status === 'unavailable' ? 'Embed-user activity is unavailable.' : 'No inactive or never-seen records match this view.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

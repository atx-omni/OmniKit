import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { ArrowRight, AlertTriangle, CheckCircle2, Database, RefreshCw, GitBranch, Clock, Loader2 } from 'lucide-react';
import { useConnection } from '@/hooks/useConnection';
import { ApiError, listModels, omniProxy } from '@/services/omniApi';
import { PageHeader } from '@/components/layout/PageHeader';
import { SearchInput } from '@/components/ui/SearchInput';
import { Blobby } from '@/components/ui/Blobby';
import { getConnectionCacheKey } from '@/services/connectionGuards';
import {
  classifyCollectionReadFailure,
  parseConnectionDbtConfig,
  parseConnectionRefreshSchedules,
  parseConnectionsCollection,
  parseSchemaModelsCollection,
  type ConnectionDbtEvidence,
  type ConnectionRefreshSchedule,
} from '@/services/collectionContracts';
import type { OmniConnection, OmniModel } from '@/types';

const DIALECT_COLORS: Record<string, string> = {
  bigquery: 'bg-blue-100 text-blue-800',
  snowflake: 'bg-cyan-100 text-cyan-800',
  redshift: 'bg-red-100 text-red-800',
  postgres: 'bg-sky-100 text-sky-800',
  mysql: 'bg-orange-100 text-orange-800',
  databricks: 'bg-rose-100 text-rose-800',
  trino: 'bg-sky-100 text-sky-800',
  clickhouse: 'bg-yellow-100 text-yellow-800',
  duckdb: 'bg-amber-100 text-amber-800',
  motherduck: 'bg-amber-100 text-amber-800',
};

type DetailEvidenceState = 'not_checked' | 'loading' | 'available' | 'unauthorized' | 'unsupported' | 'unavailable' | 'failed';

interface ConnectionDetail {
  dbt?: ConnectionDbtEvidence;
  dbtState: DetailEvidenceState;
  dbtError?: string;
  schedules?: ConnectionRefreshSchedule[];
  schedulesState: DetailEvidenceState;
  schedulesError?: string;
}

function evidenceFailure(error: unknown): { state: Exclude<DetailEvidenceState, 'not_checked' | 'loading' | 'available'>; message: string } {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return { state: 'unauthorized', message: 'The saved credential is not authorized to read this evidence.' };
    }
    if (error.status === 404 || error.status === 405 || error.status === 501) {
      return { state: 'unsupported', message: 'This evidence read is not supported by the connected instance.' };
    }
    if (error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500) {
      return { state: 'unavailable', message: 'This evidence is temporarily unavailable.' };
    }
  }
  return { state: 'failed', message: 'The evidence read failed.' };
}

function evidenceLabel(state: DetailEvidenceState): string {
  if (state === 'not_checked') return 'Not inspected';
  if (state === 'loading') return 'Inspecting';
  if (state === 'available') return 'Available';
  if (state === 'unauthorized') return 'Unauthorized';
  if (state === 'unsupported') return 'Unsupported';
  if (state === 'unavailable') return 'Unavailable';
  return 'Failed';
}

export function ConnectionsPage() {
  const { connection } = useConnection();
  const navigate = useNavigate();
  const connectionKey = getConnectionCacheKey(connection);
  const activeConnectionKeyRef = useRef(connectionKey);
  const [connections, setConnections] = useState<OmniConnection[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [dialectFilter, setDialectFilter] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'dbt' | 'schedules'>('dbt');
  const [details, setDetails] = useState<Record<string, ConnectionDetail>>({});
  const [schemaModels, setSchemaModels] = useState<OmniModel[]>([]);
  const [schemaModelError, setSchemaModelError] = useState('');
  const [connectionsLoaded, setConnectionsLoaded] = useState(false);
  const [schemaModelState, setSchemaModelState] = useState<DetailEvidenceState>('not_checked');

  useLayoutEffect(() => {
    activeConnectionKeyRef.current = connectionKey;
    setConnections([]);
    setConnectionsLoaded(false);
    setSchemaModels([]);
    setSchemaModelState('not_checked');
    setSchemaModelError('');
    setDetails({});
    setExpandedId(null);
    setActiveTab('dbt');
    setError('');
    setLoading(false);
  }, [connectionKey]);

  useEffect(() => {
    async function load() {
      const requestKey = connectionKey;
      setLoading(true);
      setError('');
      setSchemaModelError('');
      setConnectionsLoaded(false);
      setSchemaModelState('loading');
      try {
        const [connectionRes, schemaRes] = await Promise.allSettled([
          omniProxy<unknown>(
            connection.baseUrl, connection.apiKey, 'GET', '/v1/connections'
          ),
          listModels(connection.baseUrl, connection.apiKey, {
            modelKind: 'SCHEMA',
            allPages: true,
            pageSize: 100,
            sortField: 'updatedAt',
            sortDirection: 'desc',
          }),
        ]);

        if (connectionRes.status === 'rejected') {
          throw connectionRes.reason;
        }
        if (activeConnectionKeyRef.current !== requestKey) return;

        setConnections(parseConnectionsCollection(connectionRes.value));
        setConnectionsLoaded(true);

        if (schemaRes.status === 'fulfilled') {
          try {
            setSchemaModels(parseSchemaModelsCollection(schemaRes.value));
            setSchemaModelState('available');
          } catch (schemaError) {
            const failure = evidenceFailure(schemaError);
            setSchemaModels([]);
            setSchemaModelError(failure.message);
            setSchemaModelState(failure.state);
          }
        } else {
          const failure = evidenceFailure(schemaRes.reason);
          setSchemaModels([]);
          setSchemaModelError(failure.message);
          setSchemaModelState(failure.state);
        }
      } catch (err) {
        if (activeConnectionKeyRef.current !== requestKey) return;
        const failure = classifyCollectionReadFailure(err, 'Connection inventory');
        setConnections([]);
        setConnectionsLoaded(false);
        setSchemaModels([]);
        setSchemaModelState('not_checked');
        setError(failure.message);
      } finally {
        if (activeConnectionKeyRef.current === requestKey) setLoading(false);
      }
    }
    load();
  }, [connection.baseUrl, connection.apiKey, connectionKey]);

  async function loadDetail(connId: string) {
    const existing = details[connId];
    if (existing && existing.dbtState !== 'loading' && existing.schedulesState !== 'loading') return;
    const requestKey = connectionKey;
    setDetails((prev) => ({
      ...prev,
      [connId]: { dbtState: 'loading', schedulesState: 'loading' },
    }));

    const [dbtRes, schedRes] = await Promise.allSettled([
      omniProxy<unknown>(connection.baseUrl, connection.apiKey, 'GET', `/v1/connections/${connId}/dbt`),
      omniProxy<unknown>(
        connection.baseUrl,
        connection.apiKey,
        'GET',
        `/v1/connections/${connId}/schedules`,
      ),
    ]);

    if (activeConnectionKeyRef.current !== requestKey) return;
    let dbt: ConnectionDbtEvidence | undefined;
    let dbtFailure: ReturnType<typeof evidenceFailure> | null = null;
    if (dbtRes.status === 'rejected') {
      dbtFailure = evidenceFailure(dbtRes.reason);
    } else {
      try {
        dbt = parseConnectionDbtConfig(dbtRes.value);
      } catch (detailError) {
        dbtFailure = evidenceFailure(detailError);
      }
    }

    let scheduleRows: ConnectionRefreshSchedule[] | undefined;
    let schedulesFailure: ReturnType<typeof evidenceFailure> | null = null;
    if (schedRes.status === 'rejected') {
      schedulesFailure = evidenceFailure(schedRes.reason);
    } else {
      try {
        scheduleRows = parseConnectionRefreshSchedules(schedRes.value, connId);
      } catch (detailError) {
        schedulesFailure = evidenceFailure(detailError);
      }
    }
    setDetails((prev) => ({
      ...prev,
      [connId]: {
        dbt,
        dbtState: dbtFailure?.state || 'available',
        dbtError: dbtFailure?.message,
        schedules: scheduleRows,
        schedulesState: schedulesFailure?.state || 'available',
        schedulesError: schedulesFailure?.message,
      },
    }));
  }

  function toggleExpand(id: string) {
    if (expandedId === id) {
      setExpandedId(null);
    } else {
      setExpandedId(id);
      loadDetail(id);
    }
  }

  const dialects = [...new Set(connections.map((c) => c.dialect).filter(Boolean))].sort();
  const activeConnections = connections.filter((c) => !c.deletedAt);
  const activeConnectionIds = new Set(activeConnections.map((connection) => connection.id));
  const activeConnectionDetails = Object.entries(details)
    .filter(([connectionId]) => activeConnectionIds.has(connectionId))
    .map(([, detail]) => detail);
  const schemaModelByConnectionId = new Map(
    schemaModels
      .filter((model) => !model.deletedAt && model.connectionId)
      .map((model) => [model.connectionId!, model])
  );
  const schemaModelCoverageCount = activeConnections.filter((c) => schemaModelByConnectionId.has(c.id)).length;
  const latestSchemaModelUpdate = schemaModels
    .filter((model) => !model.deletedAt && model.updatedAt)
    .map((model) => Date.parse(model.updatedAt!))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => b - a)[0];
  const dbtConfigured = activeConnectionDetails.filter((detail) => detail.dbtState === 'available' && detail.dbt?.state === 'configured').length;
  const scheduleConfigured = activeConnectionDetails.filter((detail) => detail.schedulesState === 'available' && (detail.schedules || []).length > 0).length;
  const dbtReportingCount = activeConnectionDetails.filter((detail) => detail.dbtState === 'available').length;
  const scheduleReportingCount = activeConnectionDetails.filter((detail) => detail.schedulesState === 'available').length;
  const detailUnavailableCount = activeConnectionDetails.reduce((count, detail) => (
    count
    + (['unauthorized', 'unsupported', 'unavailable', 'failed'].includes(detail.dbtState) ? 1 : 0)
    + (['unauthorized', 'unsupported', 'unavailable', 'failed'].includes(detail.schedulesState) ? 1 : 0)
  ), 0);
  const missingSchemaCount = schemaModelState === 'available' ? activeConnections.length - schemaModelCoverageCount : 0;
  const detailReviewCount = activeConnectionDetails.filter((detail) => {
    const missingDbt = detail.dbtState === 'available' && detail.dbt?.state !== 'configured';
    const missingSchedule = detail.schedulesState === 'available' && (detail.schedules || []).length === 0;
    return missingDbt || missingSchedule;
  }).length;
  const reviewQueueCount = missingSchemaCount + detailReviewCount;
  const detailCoverageComplete = connectionsLoaded
    && dbtReportingCount === activeConnections.length
    && scheduleReportingCount === activeConnections.length;
  const evidenceIsPartial = schemaModelState !== 'available'
    || detailUnavailableCount > 0
    || !detailCoverageComplete;

  const filtered = connections.filter((c) => {
    const matchSearch = !search || c.name?.toLowerCase().includes(search.toLowerCase()) || c.database?.toLowerCase().includes(search.toLowerCase());
    const matchDialect = !dialectFilter || c.dialect === dialectFilter;
    return matchSearch && matchDialect;
  });

  function cronToHuman(cron: string): string {
    const parts = cron.split(' ');
    if (parts.length < 5) return cron;
    const [min, hour] = parts;
    if (min === '0' && hour !== '*') return `Daily at ${hour}:00 UTC`;
    return cron;
  }

  function connectionValue(conn: OmniConnection, ...keys: string[]): string {
    const record = conn as unknown as Record<string, unknown>;
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value;
    }
    return '';
  }

  function healthForConnection(conn: OmniConnection, detail?: ConnectionDetail, schemaModel?: OmniModel) {
    if (conn.deletedAt) {
      return { label: 'Inactive', className: 'bg-gray-100 text-gray-600', detail: 'Deleted or inactive' };
    }
    if (schemaModelState !== 'available') {
      return { label: `Schema ${evidenceLabel(schemaModelState).toLowerCase()}`, className: 'bg-surface-secondary text-content-secondary', detail: schemaModelError || 'Schema evidence has not been collected' };
    }
    if (!schemaModel) {
      return { label: 'Needs schema model', className: 'bg-yellow-100 text-yellow-800', detail: 'No schema model found for this connection' };
    }
    if (!detail) {
      return { label: 'Not inspected', className: 'bg-surface-secondary text-content-secondary', detail: 'Expand for dbt and refresh' };
    }
    if (detail.dbtState === 'loading' || detail.schedulesState === 'loading') {
      return { label: 'Inspecting', className: 'bg-omni-50 text-omni-700', detail: 'Loading details' };
    }

    const dbtUnavailable = detail.dbtState !== 'available';
    const schedulesUnavailable = detail.schedulesState !== 'available';
    const missingDbt = !dbtUnavailable && detail.dbt?.state !== 'configured';
    const dbtNotSupported = detail.dbt?.state === 'not_supported';
    const missingSchedule = !schedulesUnavailable && (detail.schedules || []).length === 0;
    if (dbtUnavailable || schedulesUnavailable) {
      const unavailable = [
        dbtUnavailable ? `dbt ${evidenceLabel(detail.dbtState).toLowerCase()}` : '',
        schedulesUnavailable ? `refresh ${evidenceLabel(detail.schedulesState).toLowerCase()}` : '',
      ].filter(Boolean).join(' · ');
      return { label: 'Partial evidence', className: 'bg-surface-secondary text-content-secondary', detail: unavailable };
    }
    if (missingDbt && missingSchedule) {
      return { label: 'Review', className: 'bg-yellow-100 text-yellow-800', detail: 'No dbt config or refresh schedule' };
    }
    if (missingSchedule) {
      return { label: 'No refresh', className: 'bg-yellow-100 text-yellow-800', detail: 'No schema refresh schedule' };
    }
    if (missingDbt) {
      return dbtNotSupported
        ? { label: 'No dbt support', className: 'bg-blue-100 text-blue-800', detail: 'Connection dialect does not support dbt' }
        : { label: 'No dbt', className: 'bg-blue-100 text-blue-800', detail: 'Optional, not configured' };
    }
    return { label: 'Configuration evidence', className: 'bg-green-100 text-green-800', detail: 'dbt and refresh metadata found' };
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Connection Readiness"
        description="Review connection inventory and documented configuration evidence for schema models, dbt, and refresh schedules."
        icon={<Blobby mood="connections" size={58} className="animate-float" style={{ animationDuration: '3.6s' }} />}
      />

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-card">{error}</div>
      )}

      <div className="grid grid-cols-2 xl:grid-cols-6 gap-3">
        <div className="card p-4">
          <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Active Connections</div>
          <div className="mt-2 text-2xl font-semibold text-content-primary">{connectionsLoaded ? activeConnections.length : '-'}</div>
          <div className="mt-1 text-xs text-content-secondary">{connectionsLoaded ? `${connections.length - activeConnections.length} deleted or inactive` : 'Inventory unavailable'}</div>
        </div>
        <div className="card p-4">
          <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Dialects</div>
          <div className="mt-2 text-2xl font-semibold text-content-primary">{connectionsLoaded ? dialects.length : '-'}</div>
          <div className="mt-1 text-xs text-content-secondary">{connectionsLoaded ? 'Warehouse platforms represented' : 'Inventory unavailable'}</div>
        </div>
        <div className="card p-4">
          <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Schema Models</div>
          <div className="mt-2 text-2xl font-semibold text-content-primary">
            {schemaModelState === 'available' ? `${schemaModelCoverageCount}/${activeConnections.length}` : '-'}
          </div>
          <div className="mt-1 text-xs text-content-secondary">
            {schemaModelState !== 'available'
              ? `${evidenceLabel(schemaModelState)} schema evidence`
              : latestSchemaModelUpdate
                ? `Latest update ${new Date(latestSchemaModelUpdate).toLocaleDateString()}`
                : 'Connection coverage'}
          </div>
        </div>
        <div className="card p-4">
          <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">dbt Configured</div>
          <div className="mt-2 text-2xl font-semibold text-content-primary">{dbtReportingCount > 0 ? dbtConfigured : '-'}</div>
          <div className="mt-1 text-xs text-content-secondary">
            {dbtReportingCount > 0
              ? `${dbtConfigured} configured · ${dbtReportingCount} of ${activeConnections.length} active connections checked`
              : 'No active connections checked'}
          </div>
        </div>
        <div className="card p-4">
          <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Connections with Refresh</div>
          <div className="mt-2 text-2xl font-semibold text-content-primary">{scheduleReportingCount > 0 ? scheduleConfigured : '-'}</div>
          <div className="mt-1 text-xs text-content-secondary">
            {scheduleReportingCount > 0
              ? `${scheduleConfigured} with refresh · ${scheduleReportingCount} of ${activeConnections.length} active connections checked`
              : 'No active connections checked'}
          </div>
        </div>
        <div className="card p-4">
          <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Review Queue</div>
          <div className="mt-2 text-2xl font-semibold text-content-primary">
            {connectionsLoaded && (!evidenceIsPartial || reviewQueueCount > 0) ? reviewQueueCount : '-'}
          </div>
          <div className="mt-1 text-xs text-content-secondary">Schema coverage + inspected details · {detailUnavailableCount} detail checks unavailable</div>
        </div>
      </div>

      <div className="card p-4">
        <div className="grid gap-4 lg:grid-cols-[1fr_auto] lg:items-center">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold text-content-primary">
              {reviewQueueCount > 0 || !connectionsLoaded || evidenceIsPartial
                ? <AlertTriangle size={16} className="text-yellow-600" />
                : <CheckCircle2 size={16} className="text-green-600" />}
              Connection configuration pre-flight
            </div>
            <div className="mt-1 text-sm text-content-secondary">
              Review configuration evidence here first, then scan model settings, relationships, views, and topics for semantic impact.
            </div>
          </div>
          <button onClick={() => navigate('/models')} className="btn-secondary text-sm inline-flex items-center gap-2 justify-center">
            Open Model & Topic Health
            <ArrowRight size={14} />
          </button>
        </div>
      </div>

      <div className="flex gap-3">
        <div className="flex-1">
          <SearchInput value={search} onChange={setSearch} placeholder="Search connections..." />
        </div>
        <select aria-label="Connection dialect" value={dialectFilter} onChange={(e) => setDialectFilter(e.target.value)} className="input-field w-auto">
          <option value="">All Dialects</option>
          {dialects.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 size={24} className="text-omni-500 animate-spin" />
        </div>
      ) : (
        <div className="card p-0 overflow-hidden">
          <div className="px-4 py-3 border-b border-border bg-white">
            <div className="text-sm font-semibold text-content-primary">Connection readiness inventory</div>
            <div className="text-xs text-content-secondary mt-0.5">Use this as a pre-flight check before model, topic, upload, and content workflows.</div>
          </div>
          <div className="bg-surface-secondary px-4 py-2.5 border-b border-border grid grid-cols-12 gap-2">
            <div className="col-span-1 text-xs font-medium text-content-secondary uppercase tracking-wider" />
            <div className="col-span-3 text-xs font-medium text-content-secondary uppercase tracking-wider">Name</div>
            <div className="col-span-2 text-xs font-medium text-content-secondary uppercase tracking-wider">Dialect</div>
            <div className="col-span-2 text-xs font-medium text-content-secondary uppercase tracking-wider">Database</div>
            <div className="col-span-2 text-xs font-medium text-content-secondary uppercase tracking-wider">Default Schema</div>
            <div className="col-span-2 text-xs font-medium text-content-secondary uppercase tracking-wider">Configuration evidence</div>
          </div>

          <div className="max-h-[500px] overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 animate-fadeIn">
                <img
                  src="/blobby-no-results.png"
                  alt="No connections found"
                  className="w-16 h-16 object-contain animate-float mb-3"
                  style={{ animationDuration: '3s' }}
                />
                <p className="text-sm text-content-secondary">{error ? 'Connection inventory is unavailable.' : 'No connections found.'}</p>
              </div>
            ) : (
              filtered.map((conn) => {
                const isExpanded = expandedId === conn.id;
                const detail = details[conn.id];
                const dialectClass = DIALECT_COLORS[conn.dialect?.toLowerCase()] || 'bg-gray-100 text-gray-800';
                const schemaModel = schemaModelByConnectionId.get(conn.id);
                const defaultSchema = connectionValue(conn, 'defaultSchema', 'default_schema', 'default_schema_name', 'schema');
                const health = healthForConnection(conn, detail, schemaModel);

                return (
                  <div key={conn.id}>
                    <button
                      type="button"
                      className="w-full px-4 py-3 border-b border-border/50 grid grid-cols-12 gap-2 items-center hover:bg-surface-secondary transition-colors cursor-pointer text-left"
                      onClick={() => toggleExpand(conn.id)}
                      aria-expanded={isExpanded}
                      aria-controls={`connection-detail-${conn.id}`}
                      aria-label={`${isExpanded ? 'Collapse' : 'Expand'} configuration evidence for ${conn.name || conn.id}`}
                    >
                      <span className="col-span-1">
                        <Database size={16} className="text-content-secondary" />
                      </span>
                      <span className="col-span-3 text-sm text-content-primary font-medium truncate">{conn.name}</span>
                      <span className="col-span-2">
                        <span className={`text-xs font-medium px-2 py-0.5 rounded-chip ${dialectClass}`}>
                          {conn.dialect}
                        </span>
                      </span>
                      <span className="col-span-2 text-sm text-content-secondary truncate">{conn.database || '-'}</span>
                      <span className="col-span-2 text-sm text-content-secondary truncate font-mono text-xs">{defaultSchema || '-'}</span>
                      <span className="col-span-2 min-w-0">
                        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-chip ${health.className}`}>{health.label}</span>
                        <span className="mt-1 block text-[10px] text-content-tertiary truncate">{health.detail}</span>
                      </span>
                    </button>

                    {isExpanded && (
                      <div id={`connection-detail-${conn.id}`} className="px-4 py-4 bg-surface-secondary border-b border-border/50 animate-fadeIn">
                        <div className="text-xs text-content-secondary mb-1">
                          <span className="font-medium text-content-primary">ID:</span>{' '}
                          <span className="font-mono">{conn.id}</span>
                        </div>
                        {conn.baseRole && (
                          <div className="text-xs text-content-secondary mb-3">
                            <span className="font-medium text-content-primary">Base Role:</span> {conn.baseRole}
                          </div>
                        )}
                        <div className="text-xs text-content-secondary mb-3">
                          <span className="font-medium text-content-primary">Schema model:</span>{' '}
                          {schemaModel ? (
                            <>
                              <span className="font-mono">{schemaModel.id}</span>
                              {schemaModel.updatedAt && <span> · updated {new Date(schemaModel.updatedAt).toLocaleString()}</span>}
                            </>
                          ) : schemaModelState !== 'available' ? (
                            <span title={schemaModelError}>{evidenceLabel(schemaModelState)}</span>
                          ) : (
                            <span className="text-yellow-700">None found for this connection</span>
                          )}
                        </div>

                        <div className="flex gap-1 mb-3">
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); setActiveTab('dbt'); }}
                            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-button text-xs font-medium transition-colors ${activeTab === 'dbt' ? 'bg-omni-700 text-white' : 'text-content-secondary hover:bg-white'}`}
                          >
                            <GitBranch size={12} />
                            dbt
                          </button>
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); setActiveTab('schedules'); }}
                            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-button text-xs font-medium transition-colors ${activeTab === 'schedules' ? 'bg-omni-700 text-white' : 'text-content-secondary hover:bg-white'}`}
                          >
                            <Clock size={12} />
                            Schema Refresh
                          </button>
                        </div>

                        {detail && (detail.dbtState === 'loading' || detail.schedulesState === 'loading') ? (
                          <div className="flex items-center gap-2 py-4 text-content-secondary text-xs">
                            <Loader2 size={14} className="animate-spin" /> Loading details...
                          </div>
                        ) : activeTab === 'dbt' ? (
                          detail?.dbtState !== 'available' ? (
                            <p className="text-xs text-content-secondary py-2" title={detail?.dbtError}>
                              dbt evidence {evidenceLabel(detail?.dbtState || 'not_checked').toLowerCase()}. {detail?.dbtError || 'Expand the row to inspect this configuration.'}
                            </p>
                          ) : detail.dbt?.state === 'configured' ? (
                            <div className="grid grid-cols-2 gap-2 text-xs">
                              {Object.entries(detail.dbt).filter(([key]) => key !== 'state').map(([key, val]) => (
                                <div key={key}>
                                  <span className="font-medium text-content-primary">{key}:</span>{' '}
                                  <span className="text-content-secondary font-mono">{typeof val === 'boolean' ? (val ? 'Yes' : 'No') : String(val ?? '-')}</span>
                                </div>
                              ))}
                            </div>
                          ) : detail.dbt?.state === 'not_supported' ? (
                            <p className="text-xs text-content-secondary py-2">This connection dialect does not support dbt.</p>
                          ) : (
                            <p className="text-xs text-content-secondary py-2">Omni reports no dbt configuration for this connection.</p>
                          )
                        ) : (
                          detail?.schedulesState !== 'available' ? (
                            <p className="text-xs text-content-secondary py-2" title={detail?.schedulesError}>
                              Refresh schedule evidence {evidenceLabel(detail?.schedulesState || 'not_checked').toLowerCase()}. {detail?.schedulesError || 'Expand the row to inspect this configuration.'}
                            </p>
                          ) : detail.schedules && detail.schedules.length > 0 ? (
                            <div className="space-y-2">
                              {detail.schedules.map((sched, i) => (
                                <div key={i} className="flex items-center gap-3 bg-white rounded-button px-3 py-2 text-xs">
                                  <RefreshCw size={12} className="text-omni-700 flex-shrink-0" />
                                  <span className="font-medium text-content-primary">{cronToHuman(String(sched.schedule || ''))}</span>
                                  <span className="text-content-secondary">{String(sched.timezone || '')}</span>
                                  <span className={`ml-auto px-2 py-0.5 rounded-chip text-[10px] font-medium ${sched.disabledAt ? 'bg-gray-100 text-gray-600' : 'bg-green-100 text-green-800'}`}>
                                    {sched.disabledAt ? 'Paused' : 'Configured'}
                                  </span>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <p className="text-xs text-content-secondary py-2">No schema refresh schedules configured.</p>
                          )
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

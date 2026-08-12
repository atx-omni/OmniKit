import { useState, useEffect, useCallback, useLayoutEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { AlertTriangle, ArrowRight, ArrowUpDown, Database, FileUp, RefreshCw, ShieldCheck, User } from 'lucide-react';
import { useConnection } from '@/hooks/useConnection';
import { omniProxy } from '@/services/omniApi';
import { PageHeader } from '@/components/layout/PageHeader';
import { SearchInput } from '@/components/ui/SearchInput';
import { Blobby } from '@/components/ui/Blobby';
import { WorkflowStatusScene } from '@/components/ui/WorkflowStatusScene';
import { getConnectionCacheKey } from '@/services/connectionGuards';
import { classifyCollectionReadFailure, CollectionContractError, parseUploadsCollection } from '@/services/collectionContracts';
import type { OmniUpload, PageInfo } from '@/types';

interface UploadPageEvidence {
  cumulativeLoaded: number;
  cursorHistory: string[];
  recordIds: string[];
  totalRecords: number;
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(dateStr: string | undefined): string {
  if (!dateStr) return '-';
  try {
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return dateStr; }
}

export function UploadsPage() {
  const { connection } = useConnection();
  const navigate = useNavigate();
  const connectionKey = getConnectionCacheKey(connection);
  const activeConnectionKeyRef = useRef(connectionKey);
  const [uploads, setUploads] = useState<OmniUpload[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [searchDraft, setSearchDraft] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [connectionDraft, setConnectionDraft] = useState('');
  const [appliedConnectionId, setAppliedConnectionId] = useState('');
  const [modelDraft, setModelDraft] = useState('');
  const [appliedModelId, setAppliedModelId] = useState('');
  const [typeFilter, setTypeFilter] = useState('csv');
  const [sortField, setSortField] = useState<'updatedAt' | 'createdAt' | 'fileName'>('updatedAt');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(1);
  const [pageInfo, setPageInfo] = useState<PageInfo | null>(null);
  const [uploadsLoaded, setUploadsLoaded] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const cursorsRef = useRef<Record<number, string>>({});
  const paginationEvidenceRef = useRef<Record<number, UploadPageEvidence>>({});
  const requestGenerationRef = useRef(0);

  useLayoutEffect(() => {
    requestGenerationRef.current += 1;
    activeConnectionKeyRef.current = connectionKey;
    setUploads([]);
    setPageInfo(null);
    setUploadsLoaded(false);
    setPage(1);
    cursorsRef.current = {};
    paginationEvidenceRef.current = {};
    setLoading(false);
    setRefreshing(false);
    setError('');
  }, [connectionKey]);

  const fetchUploads = useCallback(async (pageNum: number, options?: { keepRows?: boolean }) => {
    const requestKey = connectionKey;
    const requestGeneration = ++requestGenerationRef.current;
    if (options?.keepRows) {
      setRefreshing(true);
    } else {
      setLoading(true);
      setUploadsLoaded(false);
    }
    setError('');
    try {
      if (pageNum === 1) {
        cursorsRef.current = {};
        paginationEvidenceRef.current = {};
      }
      const currentCursor = pageNum > 1 ? cursorsRef.current[pageNum] : undefined;
      const priorEvidence = pageNum > 1 ? paginationEvidenceRef.current[pageNum - 1] : undefined;
      if (pageNum > 1 && (!currentCursor || !priorEvidence)) {
        throw new CollectionContractError('Upload inventory');
      }
      const params: Record<string, string> = {
        type: typeFilter,
        pageSize: String(pageSize),
        sortField,
        sortDirection,
      };
      if (appliedSearch) params.searchTerm = appliedSearch;
      if (appliedConnectionId) params.connectionId = appliedConnectionId;
      if (appliedModelId) params.modelId = appliedModelId;
      if (currentCursor) params.cursor = currentCursor;

      const res = await omniProxy<unknown>(
        connection.baseUrl, connection.apiKey, 'GET', '/v1/uploads',
        { queryParams: params }
      );
      if (activeConnectionKeyRef.current !== requestKey || requestGenerationRef.current !== requestGeneration) return;
      const verified = parseUploadsCollection(res, {
        pageNumber: pageNum,
        previouslyLoaded: priorEvidence?.cumulativeLoaded || 0,
        previousRecordIds: priorEvidence?.recordIds || [],
        previousCursors: priorEvidence?.cursorHistory || [],
        expectedTotalRecords: priorEvidence?.totalRecords,
        currentCursor,
      });
      setUploads(verified.records);
      setPageInfo(verified.pageInfo);
      setUploadsLoaded(true);
      paginationEvidenceRef.current = {
        ...paginationEvidenceRef.current,
        [pageNum]: {
          cumulativeLoaded: verified.cumulativeLoaded,
          cursorHistory: verified.cursorHistory,
          recordIds: verified.cumulativeRecordIds,
          totalRecords: verified.pageInfo.totalRecords,
        },
      };
      if (verified.pageInfo.nextCursor) {
        cursorsRef.current = { ...cursorsRef.current, [pageNum + 1]: verified.pageInfo.nextCursor };
      } else {
        const nextCursors = { ...cursorsRef.current };
        delete nextCursors[pageNum + 1];
        cursorsRef.current = nextCursors;
      }
    } catch (err) {
      if (activeConnectionKeyRef.current !== requestKey || requestGenerationRef.current !== requestGeneration) return;
      const failure = classifyCollectionReadFailure(err, 'Upload inventory');
      setUploads([]);
      setPageInfo(null);
      setUploadsLoaded(false);
      cursorsRef.current = {};
      paginationEvidenceRef.current = {};
      setError(failure.message);
    } finally {
      if (activeConnectionKeyRef.current === requestKey && requestGenerationRef.current === requestGeneration) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [connection.baseUrl, connection.apiKey, connectionKey, appliedSearch, appliedConnectionId, appliedModelId, pageSize, sortDirection, sortField, typeFilter]);

  useEffect(() => {
    fetchUploads(page);
  }, [fetchUploads, page, refreshNonce]);

  const cumulativeLoaded = paginationEvidenceRef.current[page]?.cumulativeLoaded ?? uploads.length;
  const showPagination = uploadsLoaded && Boolean(pageInfo) && (page > 1 || Boolean(pageInfo?.hasNextPage));
  const showPaginationRecovery = !uploadsLoaded && Boolean(error) && page > 1;
  const hasActiveFilter = appliedSearch.length > 0 || appliedConnectionId.length > 0 || appliedModelId.length > 0 || typeFilter !== 'csv';
  const uniqueConnectionsOnPage = new Set(uploads.map((upload) => upload.connection_id).filter(Boolean)).size;
  const uniqueModelsOnPage = new Set(uploads.map((upload) => upload.model_id).filter(Boolean)).size;
  const largestUploadOnPage = uploads.reduce((max, upload) => Math.max(max, upload.size_bytes || 0), 0);
  const staleUploadsOnPage = uploads.filter((upload) => daysSince(upload.updated_at) > 90).length;
  const unscopedUploadsOnPage = uploads.filter((upload) => !upload.model_id && !upload.connection_id).length;
  const ownerlessUploadsOnPage = uploads.filter((upload) => !upload.uploaded_by_user).length;
  const largeUploadsOnPage = uploads.filter((upload) => (upload.size_bytes || 0) >= 50 * 1024 * 1024).length;
  const reviewQueueOnPage = uploads.filter((upload) => uploadSignals(upload).length > 0).length;

  function resetPagination() {
    requestGenerationRef.current += 1;
    setPage(1);
    setUploads([]);
    setPageInfo(null);
    setUploadsLoaded(false);
    cursorsRef.current = {};
    paginationEvidenceRef.current = {};
    setRefreshNonce((value) => value + 1);
  }

  function changePage(nextPage: number) {
    requestGenerationRef.current += 1;
    setUploads([]);
    setPageInfo(null);
    setUploadsLoaded(false);
    setError('');
    setLoading(true);
    setPage(nextPage);
  }

  function applySearch() {
    resetPagination();
    setAppliedSearch(searchDraft.trim());
    setAppliedConnectionId(connectionDraft.trim());
    setAppliedModelId(modelDraft.trim());
  }

  function clearSearch() {
    setSearchDraft('');
    setAppliedSearch('');
    setConnectionDraft('');
    setAppliedConnectionId('');
    setModelDraft('');
    setAppliedModelId('');
    setTypeFilter('csv');
    resetPagination();
  }

  function daysSince(dateStr: string | undefined): number {
    if (!dateStr) return Number.POSITIVE_INFINITY;
    const timestamp = new Date(dateStr).getTime();
    if (Number.isNaN(timestamp)) return Number.POSITIVE_INFINITY;
    return Math.floor((Date.now() - timestamp) / (1000 * 60 * 60 * 24));
  }

  function uploadSignals(upload: OmniUpload): Array<{ label: string; className: string }> {
    const signals: Array<{ label: string; className: string }> = [];
    if (!upload.model_id && !upload.connection_id) {
      signals.push({ label: 'Unscoped', className: 'bg-red-100 text-red-800' });
    }
    if (!upload.uploaded_by_user) {
      signals.push({ label: 'No owner', className: 'bg-yellow-100 text-yellow-800' });
    }
    if (daysSince(upload.updated_at) > 90) {
      signals.push({ label: 'Stale', className: 'bg-yellow-100 text-yellow-800' });
    }
    if ((upload.size_bytes || 0) >= 50 * 1024 * 1024) {
      signals.push({ label: 'Large', className: 'bg-blue-100 text-blue-800' });
    }
    return signals;
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Upload Governance"
        description="Find high-volume uploads without page thrash, filter by documented upload metadata, and inspect ownership before cleanup."
        icon={<Blobby mood="upload" size={58} className="animate-float" style={{ animationDuration: '3.5s' }} />}
      />

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-card">{error}</div>
      )}

      <div className="grid grid-cols-2 xl:grid-cols-5 gap-3">
        <div className="card p-4">
          <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Matching Uploads</div>
          <div className="mt-2 text-2xl font-semibold text-content-primary">{uploadsLoaded ? (pageInfo?.totalRecords ?? uploads.length).toLocaleString() : '-'}</div>
          <div className="mt-1 text-xs text-content-secondary">{uploadsLoaded ? 'Server-side paginated' : 'Upload inventory unavailable'}</div>
        </div>
        <div className="card p-4">
          <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Current Page</div>
          <div className="mt-2 text-2xl font-semibold text-content-primary">{uploadsLoaded ? uploads.length : '-'}</div>
          <div className="mt-1 text-xs text-content-secondary">{uploadsLoaded ? 'Rows rendered at once' : 'No current evidence'}</div>
        </div>
        <div className="card p-4">
          <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Scope On Page</div>
          <div className="mt-2 text-2xl font-semibold text-content-primary">{uploadsLoaded ? `${uniqueConnectionsOnPage}/${uniqueModelsOnPage}` : '-'}</div>
          <div className="mt-1 text-xs text-content-secondary">Connections / models</div>
        </div>
        <div className="card p-4">
          <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Largest On Page</div>
          <div className="mt-2 text-2xl font-semibold text-content-primary">{uploadsLoaded ? formatBytes(largestUploadOnPage) : '-'}</div>
          <div className="mt-1 text-xs text-content-secondary">Useful for cleanup review</div>
        </div>
        <div className="card p-4">
          <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Review Queue</div>
          <div className="mt-2 text-2xl font-semibold text-content-primary">{uploadsLoaded ? reviewQueueOnPage : '-'}</div>
          <div className="mt-1 text-xs text-content-secondary">{uploadsLoaded ? `${staleUploadsOnPage} stale / ${unscopedUploadsOnPage} unscoped / ${ownerlessUploadsOnPage} ownerless / ${largeUploadsOnPage} large` : 'No current evidence'}</div>
        </div>
      </div>

      <div className="card p-4">
        <div className="grid gap-4 lg:grid-cols-[1fr_auto] lg:items-center">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold text-content-primary">
              {uploadsLoaded && reviewQueueOnPage === 0 ? <ShieldCheck size={16} className="text-green-600" /> : <AlertTriangle size={16} className="text-yellow-600" />}
              Upload governance review
            </div>
            <div className="mt-1 text-sm text-content-secondary">
              Page-level signals flag stale, large, ownerless, or unscoped uploads. Use Content Health for dashboard/workbook dependency review.
            </div>
          </div>
          <button onClick={() => navigate('/admin/content/health')} className="btn-secondary text-sm inline-flex items-center gap-2 justify-center">
            Open Content Health
            <ArrowRight size={14} />
          </button>
        </div>
      </div>

      <div className="card p-4 space-y-3">
        <div className="grid grid-cols-1 xl:grid-cols-5 gap-3">
          <div className="xl:col-span-2">
            <SearchInput value={searchDraft} onChange={setSearchDraft} placeholder="Search by file name..." />
          </div>
          <input
            value={connectionDraft}
            onChange={(e) => setConnectionDraft(e.target.value)}
            className="input-field font-mono text-xs"
            placeholder="Connection ID"
          />
          <input
            value={modelDraft}
            onChange={(e) => setModelDraft(e.target.value)}
            className="input-field font-mono text-xs"
            placeholder="Model ID"
          />
          <select value={typeFilter} onChange={(e) => { setTypeFilter(e.target.value); resetPagination(); }} className="input-field">
            <option value="csv">CSV</option>
            <option value="spreadsheet">Spreadsheet</option>
          </select>
        </div>
        <div className="flex flex-wrap gap-3 items-center">
          <div className="flex items-center gap-2 text-xs text-content-secondary">
            <ArrowUpDown size={13} />
            <select value={sortField} onChange={(e) => { setSortField(e.target.value as typeof sortField); resetPagination(); }} className="input-field w-auto py-1.5 text-xs">
              <option value="updatedAt">Updated date</option>
              <option value="createdAt">Created date</option>
              <option value="fileName">File name</option>
            </select>
            <select value={sortDirection} onChange={(e) => { setSortDirection(e.target.value as typeof sortDirection); resetPagination(); }} className="input-field w-auto py-1.5 text-xs">
              <option value="desc">Descending</option>
              <option value="asc">Ascending</option>
            </select>
          </div>
          <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); resetPagination(); }} className="input-field w-auto py-1.5 text-xs">
            <option value={25}>25 rows</option>
            <option value={50}>50 rows</option>
            <option value={100}>100 rows</option>
          </select>
          <button onClick={applySearch} className="btn-secondary text-sm">Apply filters</button>
          {hasActiveFilter && (
            <button onClick={clearSearch} className="btn-secondary text-sm">Clear</button>
          )}
          {refreshing && (
            <span className="text-xs text-omni-700 flex items-center gap-1">
              <RefreshCw size={12} className="animate-spin" />
              Updating results...
            </span>
          )}
        </div>
      </div>

      {loading ? (
        <WorkflowStatusScene
          variant="upload-governance"
          title="Loading upload governance"
          detail="Pulling upload metadata and scope signals without rendering the whole estate at once."
          statusLabel="Loading"
          compact
        />
      ) : (
        <div className="card p-0 overflow-hidden">
          {refreshing && (
            <div className="p-3 border-b border-border bg-omni-50">
              <WorkflowStatusScene
                variant="upload-governance"
                title="Updating upload results"
                detail="Refreshing the current filters and governance signals."
                statusLabel="Updating"
                compact
              />
            </div>
          )}
          <div className="px-4 py-3 border-b border-border bg-white">
            <div className="text-sm font-semibold text-content-primary">Upload inventory</div>
            <div className="text-xs text-content-secondary mt-0.5">Filters use Omni's upload list metadata: type, connection ID, model ID, search term, cursor pagination, and sort options.</div>
          </div>
          <div className="bg-surface-secondary px-4 py-2.5 border-b border-border grid grid-cols-12 gap-2 text-xs font-medium text-content-secondary uppercase tracking-wider">
            <div className="col-span-3">File Name</div>
            <div className="col-span-2">View / Table</div>
            <div className="col-span-1">Size</div>
            <div className="col-span-2">Uploaded By</div>
            <div className="col-span-2">Updated</div>
            <div className="col-span-2">Governance</div>
          </div>

          <div className="max-h-[500px] overflow-y-auto">
            {uploads.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 animate-fadeIn">
                <img
                  src="/blobby-no-results.png"
                  alt="Blobby searching"
                  className="w-16 h-16 object-contain animate-float mb-3"
                  style={{ animationDuration: '3s' }}
                />
                <p className="text-sm text-content-secondary">{error ? 'Upload inventory is unavailable.' : 'No uploads found.'}</p>
              </div>
            ) : (
              uploads.map((upload) => {
                const signals = uploadSignals(upload);

                return (
                  <div key={upload.id} className="px-4 py-2.5 border-b border-border/50 grid grid-cols-12 gap-2 items-center hover:bg-surface-secondary transition-colors">
                    <div className="col-span-3 text-sm text-content-primary font-medium truncate flex items-center gap-2" title={upload.file_name}>
                      <FileUp size={16} className="text-content-secondary flex-shrink-0" />
                      <span className="truncate">{upload.file_name}</span>
                    </div>
                    <div className="col-span-2 text-xs text-content-secondary truncate font-mono" title={upload.in_db_as_table_name || upload.view_name}>
                      {upload.view_name || upload.in_db_as_table_name || '-'}
                    </div>
                    <div className="col-span-1 text-xs text-content-secondary">{formatBytes(upload.size_bytes)}</div>
                    <div className="col-span-2 text-xs text-content-secondary truncate flex items-center gap-1">
                      {upload.uploaded_by_user ? (
                        <>
                          <User size={10} className="flex-shrink-0" />
                          {upload.uploaded_by_user.name}
                        </>
                      ) : '-'}
                    </div>
                    <div className="col-span-2 text-xs text-content-secondary">
                      <div>{formatDate(upload.updated_at)}</div>
                      <div className="flex items-center gap-1 font-mono text-[10px] text-content-tertiary truncate">
                        <Database size={10} />
                        {upload.model_id || upload.connection_id || 'No model scope'}
                      </div>
                    </div>
                    <div className="col-span-2 flex flex-wrap gap-1">
                      {signals.length === 0 ? (
                        <span className="text-[10px] font-semibold px-2 py-0.5 rounded-chip bg-green-100 text-green-800">Clear</span>
                      ) : (
                        signals.slice(0, 2).map((signal) => (
                          <span key={signal.label} className={`text-[10px] font-semibold px-2 py-0.5 rounded-chip ${signal.className}`}>{signal.label}</span>
                        ))
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {showPagination && (
            <div className="flex items-center justify-center gap-2 px-4 py-2.5 border-t border-border bg-surface-secondary">
              <button type="button" onClick={() => changePage(Math.max(1, page - 1))} disabled={page <= 1} className="btn-secondary text-xs px-3 py-1.5">Previous</button>
              <span className="text-xs text-content-secondary">
                {pageInfo
                  ? `Page ${page} · ${cumulativeLoaded.toLocaleString()} of ${pageInfo.totalRecords.toLocaleString()} loaded`
                  : `Page ${page} · evidence unavailable`}
              </span>
              <button type="button" onClick={() => changePage(page + 1)} disabled={!pageInfo?.hasNextPage} className="btn-secondary text-xs px-3 py-1.5">Next</button>
            </div>
          )}
          {showPaginationRecovery && (
            <div className="flex items-center justify-center px-4 py-2.5 border-t border-border bg-surface-secondary">
              <button type="button" onClick={resetPagination} className="btn-secondary text-xs px-3 py-1.5">
                Return to first page
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

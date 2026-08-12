import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { AlertTriangle, ArrowRight, CheckCircle2, FolderOpen, Loader2, RefreshCw } from 'lucide-react';
import { enrichDocuments, listDocuments, listFolders } from '@/services/omniApi';
import { useConnection } from '@/hooks/useConnection';
import { PageHeader } from '@/components/layout/PageHeader';
import { Blobby } from '@/components/ui/Blobby';
import { SearchInput } from '@/components/ui/SearchInput';
import { WorkflowStatusScene } from '@/components/ui/WorkflowStatusScene';
import { AdminReadinessPanel } from '@/components/admin/CapabilityStatus';
import { getConnectionCacheKey } from '@/services/connectionGuards';
import { friendlyApiError } from '@/utils/apiErrors';
import type { OmniDocument, OmniFolder } from '@/types';

interface FolderOption {
  id: string;
  name: string;
  path: string;
}

function flattenFolders(folders: OmniFolder[], parentPath = ''): FolderOption[] {
  const rows: FolderOption[] = [];
  for (const folder of folders) {
    const path = parentPath ? `${parentPath} / ${folder.name}` : folder.name;
    rows.push({ id: folder.id, name: folder.name, path });
    if (folder.children?.length) {
      rows.push(...flattenFolders(folder.children, path));
    }
  }
  return rows;
}

function contentSignals(doc: OmniDocument): Array<{ label: string; className: string }> {
  const signals: Array<{ label: string; className: string }> = [];
  if (doc.enrichmentError) {
    return [{ label: 'Enrichment unavailable', className: 'bg-red-100 text-red-800' }];
  }
  if (!doc.baseModelId && !doc.baseModelName) {
    signals.push({ label: 'No model', className: 'bg-yellow-100 text-yellow-800' });
  }
  if (!doc.topicNames || doc.topicNames.length === 0) {
    signals.push({ label: 'No topic', className: 'bg-yellow-100 text-yellow-800' });
  }
  return signals;
}

export function ContentHealthPage() {
  const { connection } = useConnection();
  const navigate = useNavigate();
  const connectionKey = getConnectionCacheKey(connection);
  const activeConnectionKeyRef = useRef(connectionKey);
  const activeFolderIdRef = useRef('');
  const [folders, setFolders] = useState<OmniFolder[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState('');
  const [documents, setDocuments] = useState<OmniDocument[]>([]);
  const [search, setSearch] = useState('');
  const [loadingFolders, setLoadingFolders] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState('');
  const [folderNotice, setFolderNotice] = useState('');
  const [scanNotice, setScanNotice] = useState('');
  const [lastScanAt, setLastScanAt] = useState<string | null>(null);
  const [scanState, setScanState] = useState<'not_scanned' | 'loading' | 'available' | 'partial' | 'unavailable'>('not_scanned');
  const [enrichedDocumentIds, setEnrichedDocumentIds] = useState<Set<string>>(() => new Set());

  const folderOptions = useMemo(() => flattenFolders(folders), [folders]);
  const selectedFolder = folderOptions.find((folder) => folder.id === selectedFolderId) || null;

  useLayoutEffect(() => {
    activeConnectionKeyRef.current = connectionKey;
    activeFolderIdRef.current = '';
    setFolders([]);
    setSelectedFolderId('');
    setDocuments([]);
    setEnrichedDocumentIds(new Set());
    setLastScanAt(null);
    setScanState('not_scanned');
    setScanNotice('');
    setFolderNotice('');
    setSearch('');
    setError('');
    setLoadingFolders(false);
    setScanning(false);
  }, [connectionKey]);

  useEffect(() => {
    async function loadFolders() {
      const requestKey = connectionKey;
      setLoadingFolders(true);
      setError('');
      setFolderNotice('');
      try {
        const res = await listFolders(connection.baseUrl, connection.apiKey, { allPages: true, pageSize: 100 });
        if (activeConnectionKeyRef.current !== requestKey) return;
        if (res?.error || !Array.isArray(res?.folders)) {
          throw new Error('Omni returned no verified folder collection.');
        }
        const nextFolders = res.folders as OmniFolder[];
        setFolders(nextFolders);
        if (res.complete !== true) {
          const loaded = Number.isSafeInteger(res.loadedResults) ? res.loadedResults : nextFolders.length;
          const total = Number.isSafeInteger(res.totalResults) ? res.totalResults : 'an unknown total';
          setFolderNotice(`Folder collection is partial: ${loaded} of ${total} source records were read.`);
        }
        const first = flattenFolders(nextFolders)[0];
        if (first) {
          activeFolderIdRef.current = first.id;
          setSelectedFolderId(first.id);
        }
      } catch (err) {
        if (activeConnectionKeyRef.current !== requestKey) return;
        setFolders([]);
        setFolderNotice('');
        activeFolderIdRef.current = '';
        setSelectedFolderId('');
        setError(friendlyApiError(err, 'Failed to load folders'));
      } finally {
        if (activeConnectionKeyRef.current === requestKey) setLoadingFolders(false);
      }
    }
    loadFolders();
  }, [connection.baseUrl, connection.apiKey, connectionKey]);

  async function scanSelectedFolder() {
    if (!selectedFolderId) return;
    const requestKey = connectionKey;
    const folderId = selectedFolderId;
    const folderPath = selectedFolder?.path;
    setScanning(true);
    setScanState('loading');
    setError('');
    setScanNotice('');
    setDocuments([]);
    setEnrichedDocumentIds(new Set());
    setLastScanAt(null);
    try {
      const res = await listDocuments(connection.baseUrl, connection.apiKey, folderId, { allPages: true, pageSize: 100 });
      if (res?.error || !Array.isArray(res?.documents)) {
        throw new Error('Omni returned no verified document collection.');
      }
      const docs = res.documents as OmniDocument[];
      const collectionComplete = res.complete === true;
      const collectionLoaded = Number.isSafeInteger(res.loadedResults) ? res.loadedResults : docs.length;
      const collectionTotal = Number.isSafeInteger(res.totalResults) ? res.totalResults : 'an unknown total';
      const enrichmentById: Record<string, Partial<OmniDocument>> = {};
      const enrichmentFailures: string[] = [];

      for (let i = 0; i < docs.length; i += 25) {
        if (activeConnectionKeyRef.current !== requestKey || activeFolderIdRef.current !== folderId) return;
        const batch = docs.slice(i, i + 25);
        try {
          const enriched = await enrichDocuments(connection.baseUrl, connection.apiKey, batch.map((doc) => doc.id));
          Object.assign(enrichmentById, enriched);
        } catch {
          enrichmentFailures.push('Metadata enrichment failed for one or more content records.');
        }
      }

      if (activeConnectionKeyRef.current !== requestKey || activeFolderIdRef.current !== folderId) return;
      const availableEnrichmentIds = new Set(
        Object.entries(enrichmentById)
          .filter(([, enrichment]) => !enrichment.enrichmentError)
          .map(([id]) => id),
      );
      const nextDocuments = docs.map((doc) => {
        const enrichment = enrichmentById[doc.id];
        return {
          ...doc,
          ...(enrichment || {}),
          folderPath,
          enrichmentError: enrichment?.enrichmentError || (!enrichment ? 'Metadata enrichment was unavailable for this content.' : null),
        };
      });
      setDocuments(nextDocuments);
      setEnrichedDocumentIds(availableEnrichmentIds);
      setLastScanAt(new Date().toISOString());
      const enrichmentPartial = availableEnrichmentIds.size < docs.length;
      const partial = !collectionComplete || enrichmentPartial;
      setScanState(partial ? 'partial' : 'available');
      if (partial) {
        const notices: string[] = [];
        if (!collectionComplete) {
          notices.push(`Content collection is partial: ${collectionLoaded} of ${collectionTotal} source records were read.`);
        }
        if (enrichmentPartial) {
          const detail = enrichmentFailures[0] ? ` ${enrichmentFailures[0]}` : '';
          notices.push(`Metadata enrichment is partial: ${availableEnrichmentIds.size} of ${docs.length} content records were enriched.${detail}`);
        }
        setScanNotice(notices.join(' '));
      }
    } catch (err) {
      if (activeConnectionKeyRef.current !== requestKey || activeFolderIdRef.current !== folderId) return;
      setDocuments([]);
      setEnrichedDocumentIds(new Set());
      setLastScanAt(null);
      setScanState('unavailable');
      setError(friendlyApiError(err, 'Failed to scan content health'));
    } finally {
      if (activeConnectionKeyRef.current === requestKey && activeFolderIdRef.current === folderId) setScanning(false);
    }
  }

  const filteredDocuments = documents.filter((doc) => {
    if (!search) return true;
    const haystack = [
      doc.name,
      doc.baseModelName,
      doc.connectionName,
      doc.topicNames?.join(' '),
      doc.folderPath,
    ].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(search.toLowerCase());
  });
  const missingModelCount = documents.filter((doc) => !doc.enrichmentError && !doc.baseModelId && !doc.baseModelName).length;
  const missingTopicCount = documents.filter((doc) => !doc.enrichmentError && (!doc.topicNames || doc.topicNames.length === 0)).length;
  const enrichmentErrorCount = documents.filter((doc) => doc.enrichmentError).length;
  const reviewQueueCount = documents.filter((doc) => contentSignals(doc).length > 0).length;
  const uniqueModelCount = new Set(documents.map((doc) => doc.baseModelId || doc.baseModelName).filter(Boolean)).size;
  const hasCollectionEvidence = scanState === 'available' || scanState === 'partial';

  function selectFolder(folderId: string) {
    activeFolderIdRef.current = folderId;
    setSelectedFolderId(folderId);
    setScanning(false);
    setDocuments([]);
    setEnrichedDocumentIds(new Set());
    setLastScanAt(null);
    setScanState('not_scanned');
    setScanNotice('');
    setError('');
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Content Health"
        description="Review selected-folder dashboard and workbook dependency evidence separately from model, topic, and upload workflows."
        icon={<Blobby mood="content" size={58} className="animate-float" style={{ animationDuration: '3.6s' }} />}
      />

      <AdminReadinessPanel
        workspace="content"
        instanceId={connection.instanceId}
        baseUrl={connection.baseUrl}
      />

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-card">{error}</div>
      )}
      {folderNotice && (
        <div className="bg-yellow-50 border border-yellow-200 text-yellow-800 text-sm px-4 py-3 rounded-card">{folderNotice}</div>
      )}
      {scanNotice && (
        <div className="bg-yellow-50 border border-yellow-200 text-yellow-800 text-sm px-4 py-3 rounded-card">{scanNotice}</div>
      )}

      <div className="grid grid-cols-2 xl:grid-cols-5 gap-3">
        <div className="card p-4">
          <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Collected Content</div>
          <div className="mt-2 text-2xl font-semibold text-content-primary">{hasCollectionEvidence ? documents.length : '-'}</div>
          <div className="mt-1 text-xs text-content-secondary">{lastScanAt ? new Date(lastScanAt).toLocaleTimeString() : 'No successful collection yet'}</div>
        </div>
        <div className="card p-4">
          <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Models represented</div>
          <div className="mt-2 text-2xl font-semibold text-content-primary">{hasCollectionEvidence ? uniqueModelCount : '-'}</div>
          <div className="mt-1 text-xs text-content-secondary">{hasCollectionEvidence ? `${missingModelCount} enriched records without a model` : 'Requires a successful scan'}</div>
        </div>
        <div className="card p-4">
          <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Enrichment coverage</div>
          <div className="mt-2 text-2xl font-semibold text-content-primary">{hasCollectionEvidence ? `${enrichedDocumentIds.size}/${documents.length}` : '-'}</div>
          <div className="mt-1 text-xs text-content-secondary">Collection and metadata reads reported separately</div>
        </div>
        <div className="card p-4">
          <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Topic findings</div>
          <div className="mt-2 text-2xl font-semibold text-content-primary">{hasCollectionEvidence ? missingTopicCount : '-'}</div>
          <div className="mt-1 text-xs text-content-secondary">{hasCollectionEvidence ? `${enrichmentErrorCount} records unavailable for enrichment` : 'Requires enriched evidence'}</div>
        </div>
        <div className="card p-4">
          <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Review Queue</div>
          <div className="mt-2 text-2xl font-semibold text-content-primary">{hasCollectionEvidence ? reviewQueueCount : '-'}</div>
          <div className="mt-1 text-xs text-content-secondary">Known dependency or evidence findings</div>
        </div>
      </div>

      <div className="card p-4 space-y-3">
        <div className="grid grid-cols-1 xl:grid-cols-[minmax(280px,1fr)_minmax(260px,1fr)_auto] gap-3 items-center">
          <select
            value={selectedFolderId}
            onChange={(e) => selectFolder(e.target.value)}
            className="input-field"
            disabled={loadingFolders || folderOptions.length === 0}
            aria-label="Content folder"
          >
            {folderOptions.length === 0 ? (
              <option value="">No folders loaded</option>
            ) : (
              folderOptions.map((folder) => (
                <option key={folder.id} value={folder.id}>{folder.path}</option>
              ))
            )}
          </select>
          <SearchInput value={search} onChange={setSearch} placeholder="Search scanned content..." />
          <button
            onClick={scanSelectedFolder}
            disabled={loadingFolders || scanning || !selectedFolderId}
            className="btn-primary text-sm inline-flex items-center justify-center gap-2 min-w-[150px]"
          >
            {scanning ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            Scan Folder
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs text-content-secondary">
          <span className="inline-flex items-center gap-1.5"><FolderOpen size={13} /> {selectedFolder?.path || 'Select a folder'}</span>
          <span>This is read-only triage. It does not block AI Semantic Studio unless the content depends on the active model or topic.</span>
          <button onClick={() => navigate('/dashboards/operations')} className="text-omni-700 font-medium inline-flex items-center gap-1">
            Open Dashboard Operations <ArrowRight size={12} />
          </button>
        </div>
      </div>

      {loadingFolders && (
        <WorkflowStatusScene
          variant="content-scan"
          title="Loading content folders"
          detail="Preparing the folder list before dependency scanning starts."
          statusLabel="Loading"
          compact
        />
      )}

      <div className="card p-0 overflow-hidden">
        <div className="px-4 py-3 border-b border-border bg-white">
          <div className="text-sm font-semibold text-content-primary">Content dependency evidence</div>
          <div className="text-xs text-content-secondary mt-0.5">Collection and enrichment coverage are shown separately for the selected folder.</div>
        </div>
        <div className="bg-surface-secondary px-4 py-2.5 border-b border-border grid grid-cols-12 gap-2 text-xs font-medium text-content-secondary uppercase tracking-wider">
          <div className="col-span-4">Content</div>
          <div className="col-span-3">Model</div>
          <div className="col-span-3">Topics</div>
          <div className="col-span-2">Evidence</div>
        </div>
        <div className="max-h-[500px] overflow-y-auto">
          {scanning ? (
            <div className="p-4">
              <WorkflowStatusScene
                variant="content-scan"
                title="Scanning content dependencies"
                detail="Checking dashboards and workbooks for model, topic, and enrichment signals."
                statusLabel="Scanning"
                compact
              />
            </div>
          ) : filteredDocuments.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 animate-fadeIn">
              <img
                src="/blobby-no-results.png"
                alt="No content found"
                className="w-16 h-16 object-contain animate-float mb-3"
                style={{ animationDuration: '3s' }}
              />
              <p className="text-sm text-content-secondary">
                {documents.length === 0
                  ? scanState === 'unavailable'
                    ? 'Content collection is unavailable for this folder.'
                    : lastScanAt
                    ? 'No dashboard or workbook content was found in this folder.'
                    : 'Select a folder and scan dependency evidence.'
                  : 'No scanned content matches this search.'}
              </p>
            </div>
          ) : (
            filteredDocuments.map((doc) => {
              const signals = contentSignals(doc);
              return (
                <div key={doc.id} className="px-4 py-2.5 border-b border-border/50 grid grid-cols-12 gap-2 items-center hover:bg-surface-secondary transition-colors">
                  <div className="col-span-4 min-w-0">
                    <div className="text-sm text-content-primary font-medium truncate">{doc.name}</div>
                    <div className="text-[10px] text-content-tertiary truncate font-mono">{doc.id}</div>
                  </div>
                  <div className="col-span-3 text-xs text-content-secondary truncate">{doc.baseModelName || doc.baseModelId || '-'}</div>
                  <div className="col-span-3 text-xs text-content-secondary truncate">{doc.topicNames?.length ? doc.topicNames.join(', ') : '-'}</div>
                  <div className="col-span-2 flex flex-wrap gap-1">
                    {signals.length === 0 ? (
                      <span className="text-[10px] font-semibold px-2 py-0.5 rounded-chip bg-green-100 text-green-800 inline-flex items-center gap-1">
                        <CheckCircle2 size={10} /> Mapped
                      </span>
                    ) : (
                      signals.slice(0, 2).map((signal) => (
                        <span key={signal.label} className={`text-[10px] font-semibold px-2 py-0.5 rounded-chip ${signal.className}`}>{signal.label}</span>
                      ))
                    )}
                    {signals.length > 2 && <span className="text-[10px] text-content-tertiary">+{signals.length - 2}</span>}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {hasCollectionEvidence && reviewQueueCount > 0 && (
        <div className="bg-yellow-50 border border-yellow-200 text-yellow-800 text-sm px-4 py-3 rounded-card flex items-start gap-2">
          <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
          <div>These are content dependency findings, not deployment blockers for a single topic or model unless the reviewed content depends on that same semantic asset.</div>
        </div>
      )}
    </div>
  );
}

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useConnection } from '@/hooks/useConnection';
import { ApiError } from '@/services/omniApi';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Copy,
  Database,
  ExternalLink,
  FileText,
  FolderInput,
  Loader2,
  RefreshCw,
  RotateCcw,
} from 'lucide-react';

import { SavedInstanceRequiredEmptyState } from '@/components/layout/RequireConnection';
import { ComboBox } from '@/components/ui/ComboBox';
import { SearchInput } from '@/components/ui/SearchInput';
import { StatusChip } from '@/components/ui/StatusChip';
import {
  createDashboardSafeCopyJob,
  getMigrationJob,
  getVaultStatus,
  listInstanceDocuments,
  listInstanceModelTopics,
  listMigrationJobs,
  listModelMigratorConnections,
  listModelMigratorModels,
  listSavedInstances,
  retryDashboardSafeCopyTarget,
  subscribeMigrationJob,
  type InstanceDocument,
  type InstanceDocumentInventory,
  type InstanceModel,
  type MigrationJob,
  type ModelMigratorConnection,
  type SavedInstancePublic,
  type VaultStatus,
} from '@/services/opsConsole';
import { modelDisplayLabel, sortDocuments, sortModels, sortSavedInstances } from '@/utils/catalogSort';
// Shared with DashboardMigrationWizard so both flows disambiguate connections
// that share a name, rather than each rendering its own option shape.
import { buildConnectionComboBoxOptions } from './dashboardMigrationUtils';
import { createDashboardSafeCopyModelMigratorHandoff } from '@/services/modelMigratorHandoff';
import {
  createDashboardSafeCopyDraft,
  DASHBOARD_SAFE_COPY_MAX_MATRIX_CELLS,
  dashboardSafeCopyDraftReducer,
  dashboardSafeCopyIntentFromDraft,
  dashboardSafeCopyJobProgress,
  dashboardSafeCopyTargetActions,
  isDashboardSafeCopyJobForRequest,
  isDashboardSafeCopyTerminal,
  newDashboardSafeCopyRequestId,
  readDashboardSafeCopyDraft,
  resolveDashboardSafeCopyDestinationDefaults,
  shouldApplyDashboardSafeCopyJobSnapshot,
  writeDashboardSafeCopyDraft,
  type DashboardSafeCopyDestinationDraft,
  type DashboardSafeCopyDocumentPhase,
  type DashboardSafeCopyStep,
  type DashboardSafeCopyTargetStage,
  type DashboardSafeCopyTargetPhase,
  type DashboardSafeCopyTargetProgress,
} from './dashboardSafeCopyFlowState';

const MAX_SELECTED_DASHBOARDS = 500;
const MAX_DESTINATIONS = 100;
const DASHBOARD_PAGE_SIZE = 100;
const PROGRESS_DOCUMENT_PAGE_SIZE = 20;
const TRACKING_REFRESH_MS = 4_000;
const STEP_LABELS = ['Choose dashboards', 'Choose destinations', 'Review dependencies', 'Move & track'] as const;

interface DestinationCatalog {
  connections: ModelMigratorConnection[];
  models: InstanceModel[];
  loading: boolean;
  loaded: boolean;
  error: string;
}

const EMPTY_DESTINATION_CATALOG: DestinationCatalog = {
  connections: [],
  models: [],
  loading: false,
  loaded: false,
  error: '',
};

const TARGET_PHASE_LABELS: Record<DashboardSafeCopyTargetPhase, string> = {
  preparing: 'Preparing destination',
  ready: 'Ready to copy',
  copying: 'Copying dashboards',
  verifying: 'Verifying dashboards',
  reconciliation_required: 'Reconciliation required',
  succeeded: 'Complete',
  canceled: 'Canceled before copy',
  needs_attention: 'Needs attention',
};

const TARGET_PHASE_CHIPS: Record<DashboardSafeCopyTargetPhase, string> = {
  preparing: 'pending',
  ready: 'ready',
  copying: 'in_progress',
  verifying: 'in_progress',
  reconciliation_required: 'warning',
  succeeded: 'success',
  canceled: 'skipped',
  needs_attention: 'failed',
};

const TARGET_STAGES: Array<{ id: DashboardSafeCopyTargetStage; label: string }> = [
  { id: 'prepare', label: 'Prepare' },
  { id: 'copy', label: 'Copy' },
  { id: 'verify', label: 'Verify' },
  { id: 'complete', label: 'Complete' },
];

const DOCUMENT_PHASE_LABELS: Record<DashboardSafeCopyDocumentPhase, string> = {
  waiting: 'Waiting',
  copying: 'Copying',
  verifying: 'Verifying',
  complete: 'Complete',
  reconciliation_required: 'Reconciliation required',
  canceled: 'Canceled',
  needs_attention: 'Needs attention',
};

const DOCUMENT_PHASE_CHIPS: Record<DashboardSafeCopyDocumentPhase, string> = {
  waiting: 'pending',
  copying: 'in_progress',
  verifying: 'in_progress',
  complete: 'success',
  reconciliation_required: 'warning',
  canceled: 'skipped',
  needs_attention: 'failed',
};

function instanceSupportsSource(instance: SavedInstancePublic): boolean {
  return instance.role === 'source' || instance.role === 'both';
}

function instanceSupportsDestination(instance: SavedInstancePublic): boolean {
  return instance.role === 'destination' || instance.role === 'both';
}

function sourceDocumentId(document: InstanceDocument): string {
  return document.identifier || document.id;
}

function verifiedDashboardUrl(baseUrl: string | undefined, identifier: string | undefined): string {
  if (!baseUrl || !identifier) return '';
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    url.username = '';
    url.password = '';
    url.pathname = `/dashboards/${encodeURIComponent(identifier)}`;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function documentSearchText(document: InstanceDocument): string {
  return [
    document.name,
    document.identifier,
    document.baseModelName,
    document.baseModelId,
    document.folderPath,
    ...(document.labels || []),
  ].filter(Boolean).join(' ').toLocaleLowerCase('en-US');
}

const DESTINATION_ACCESS_NOTICE = 'Source sharing is not copied. Inherited access follows the destination folder shown here; OmniKit verifies that the copied dashboard has no unexpected non-owner direct grant.';

function destinationFolderLabel(folderPath?: string, folderId?: string): string {
  const path = (folderPath || '').normalize('NFKC').trim().slice(0, 512);
  if (path) return path;
  const id = (folderId || '').normalize('NFKC').trim().slice(0, 128);
  return id ? `Saved destination folder (${id})` : 'Top level';
}

function jobStatusLabel(job: MigrationJob): string {
  if (job.status === 'pending') return 'Preparing destinations';
  if (job.status === 'running') return 'Copying and verifying';
  if (job.status === 'succeeded') return 'Move complete';
  if (job.status === 'partial') return 'Completed with exceptions';
  if (job.status === 'failed') return 'Needs attention';
  return 'Canceled';
}

function jobStatusChip(job: MigrationJob): string {
  if (job.status === 'succeeded') return 'success';
  if (job.status === 'pending') return 'pending';
  if (job.status === 'running') return 'in_progress';
  if (job.status === 'partial') return 'warning';
  return 'failed';
}

function sameDestinationResolution(
  row: DashboardSafeCopyDestinationDraft,
  connectionId: string,
  modelId: string,
): boolean {
  return row.connectionId === connectionId && row.modelId === modelId;
}

export function DashboardSafeCopyFlow() {
  const navigate = useNavigate();
  const { connection } = useConnection();
  const [draft, dispatchDraft] = useReducer(
    dashboardSafeCopyDraftReducer,
    undefined,
    readDashboardSafeCopyDraft,
  );
  const [vaultStatus, setVaultStatus] = useState<VaultStatus | null>(null);
  const [instances, setInstances] = useState<SavedInstancePublic[]>([]);
  const [sourceConnections, setSourceConnections] = useState<ModelMigratorConnection[]>([]);
  const [documents, setDocuments] = useState<InstanceDocument[]>([]);
  const [dashboardInventory, setDashboardInventory] = useState<InstanceDocumentInventory | null>(null);
  const [destinationCatalogs, setDestinationCatalogs] = useState<Record<string, DestinationCatalog>>({});
  const [job, setJob] = useState<MigrationJob | null>(null);
  const [search, setSearch] = useState('');
  const [visibleDashboardCount, setVisibleDashboardCount] = useState(DASHBOARD_PAGE_SIZE);
  const [loading, setLoading] = useState(true);
  const [loadingSourceConnections, setLoadingSourceConnections] = useState(false);
  const [loadingDashboards, setLoadingDashboards] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [retryingTargetIds, setRetryingTargetIds] = useState<string[]>([]);
  const [trackingRevision, setTrackingRevision] = useState(0);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [progressAnnouncement, setProgressAnnouncement] = useState('');
  const [visibleProgressDocuments, setVisibleProgressDocuments] = useState<Record<string, number>>({});
  const [expandedProgressTargetId, setExpandedProgressTargetId] = useState('');
  const headingRef = useRef<HTMLHeadingElement>(null);
  const submitGuardRef = useRef(false);
  const retryGuardRef = useRef(new Set<string>());
  const sourceConnectionRequestRef = useRef(0);
  const dashboardRequestRef = useRef(0);
  const destinationRequestRef = useRef<Record<string, number>>({});
  const sourceConnectionAbortRef = useRef<AbortController | null>(null);
  const dashboardAbortRef = useRef<AbortController | null>(null);
  const destinationAbortRef = useRef<Record<string, AbortController>>({});
  const jobRef = useRef<MigrationJob | null>(null);
  const announcedProgressRef = useRef<{ jobId: string; values: Map<string, string> }>({
    jobId: '',
    values: new Map(),
  });

  const sourceInstances = useMemo(
    () => sortSavedInstances(instances.filter(instanceSupportsSource)),
    [instances],
  );
  const destinationInstances = useMemo(
    () => sortSavedInstances(instances.filter(instanceSupportsDestination)),
    [instances],
  );
  const sourceInstance = instances.find((instance) => instance.id === draft.sourceId);
  const selectedDestinationIds = useMemo(
    () => new Set(draft.destinations.map((row) => row.instanceId)),
    [draft.destinations],
  );
  const selectedDocumentIds = useMemo(() => new Set(draft.selectedDocumentIds), [draft.selectedDocumentIds]);
  const filteredDocuments = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('en-US');
    const sorted = sortDocuments(documents);
    return query ? sorted.filter((document) => documentSearchText(document).includes(query)) : sorted;
  }, [documents, search]);
  const visibleDocuments = useMemo(
    () => filteredDocuments.slice(0, visibleDashboardCount),
    [filteredDocuments, visibleDashboardCount],
  );
  const sourceLabelByDocumentId = useMemo(() => Object.fromEntries(documents.flatMap((document) => {
    const ids = new Set([document.id, document.identifier].filter((value): value is string => Boolean(value)));
    return [...ids].map((id) => [id, document.name]);
  })), [documents]);
  const progress = useMemo(() => job ? dashboardSafeCopyJobProgress(job, {
    defaultDocumentLimit: 0,
    sourceLabelByDocumentId,
    documentLimitByTarget: expandedProgressTargetId ? {
      [expandedProgressTargetId]: visibleProgressDocuments[expandedProgressTargetId] || PROGRESS_DOCUMENT_PAGE_SIZE,
    } : {},
  }) : [], [expandedProgressTargetId, job, sourceLabelByDocumentId, visibleProgressDocuments]);
  const strictlyVerifiedMove = Boolean(
    job
    && job.status === 'succeeded'
    && (job.targets?.length || 0) > 0
    && progress.length === job.targets?.length
    && progress.every((target) => target.phase === 'succeeded'),
  );
  const globalReconciliationHold = job?.details?.safeCopyExecutionState === 'reconciliation_required'
    || progress.some((target) => target.blocksNewScope);
  const globalEvidenceHold = progress.some((target) => target.globalHold);
  const unresolvedWriteEvidence = globalReconciliationHold || progress.some((target) => (
    target.phase === 'copying'
    || target.phase === 'verifying'
    || target.phase === 'reconciliation_required'
  ));
  const canStartAnotherMove = strictlyVerifiedMove || Boolean(
    job
    && isDashboardSafeCopyTerminal(job.status)
    && !unresolvedWriteEvidence,
  );
  const displayedJobStatus = globalReconciliationHold
    ? { label: 'Reconciliation required', chip: 'warning' }
    : globalEvidenceHold
    ? { label: 'Verification evidence incomplete', chip: 'warning' }
    : job?.status === 'succeeded' && !strictlyVerifiedMove
    ? { label: 'Verification evidence incomplete', chip: 'warning' }
    : job ? { label: jobStatusLabel(job), chip: jobStatusChip(job) } : undefined;
  const instanceById = useMemo(
    () => new Map(instances.map((instance) => [instance.id, instance])),
    [instances],
  );

  useEffect(() => {
    setVisibleProgressDocuments({});
    setExpandedProgressTargetId('');
  }, [job?.id]);

  useEffect(() => {
    if (!job) {
      announcedProgressRef.current = { jobId: '', values: new Map() };
      setProgressAnnouncement('');
      return;
    }
    const next = new Map<string, string>();
    for (const target of progress) {
      next.set(`target:${target.targetId}`, target.phase);
      for (const document of target.documents) {
        next.set(`document:${target.targetId}:${document.sourceDocumentId}`, document.phase);
      }
    }
    const previous = announcedProgressRef.current;
    if (previous.jobId !== job.id) {
      announcedProgressRef.current = { jobId: job.id, values: next };
      setProgressAnnouncement('');
      return;
    }
    const changes: string[] = [];
    for (const target of progress) {
      const targetKey = `target:${target.targetId}`;
      if (previous.values.get(targetKey) !== undefined && previous.values.get(targetKey) !== target.phase) {
        changes.push(`${target.destinationLabel}: ${TARGET_PHASE_LABELS[target.phase]}.`);
      }
      for (const document of target.documents) {
        const documentKey = `document:${target.targetId}:${document.sourceDocumentId}`;
        if (previous.values.get(documentKey) !== undefined && previous.values.get(documentKey) !== document.phase) {
          changes.push(`${target.destinationLabel}, dashboard ${document.chosenTargetName || document.sourceLabel}: ${DOCUMENT_PHASE_LABELS[document.phase]}.`);
        }
      }
    }
    announcedProgressRef.current = { jobId: job.id, values: next };
    if (changes.length > 0) {
      const visible = changes.slice(0, 4);
      const remaining = changes.length - visible.length;
      setProgressAnnouncement(`${visible.join(' ')}${remaining > 0 ? ` ${remaining} more status changes.` : ''}`);
    }
  }, [job, progress]);

  useEffect(() => {
    writeDashboardSafeCopyDraft(draft);
  }, [draft]);

  useEffect(() => {
    // headingRef is shared by the three per-step headings, so a re-render
    // between this effect and the frame callback can replace the node the focus
    // was applied to and silently drop it — and this effect will not run again,
    // leaving the step change unannounced. Confirm the focus actually landed and
    // retry on the next frames rather than firing once and hoping.
    const focusHeading = () => {
      const node = headingRef.current;
      if (!node) return false;
      if (document.activeElement !== node) node.focus();
      return document.activeElement === node;
    };
    if (focusHeading()) return;
    let frame = window.requestAnimationFrame(() => {
      if (focusHeading()) return;
      frame = window.requestAnimationFrame(() => {
        focusHeading();
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [draft.jobId, draft.step, loading]);

  useEffect(() => {
    let active = true;
    void Promise.all([getVaultStatus(), listSavedInstances()])
      .then(async ([status, saved]) => {
        if (!active) return;
        const nextInstances = sortSavedInstances(saved.instances);
        setVaultStatus(status);
        setInstances(nextInstances);
        if (draft.jobId) return;
        if (status.unlocked) {
          try {
            const history = await listMigrationJobs();
            if (!active) return;
            const matches = history.jobs.filter((candidate) => (
              isDashboardSafeCopyJobForRequest(candidate, draft.requestId)
            ));
            if (matches.length === 1) {
              const recovered = { ...draft, step: 2 as const, jobId: matches[0].id };
              writeDashboardSafeCopyDraft(recovered);
              dispatchDraft({ type: 'attach_job', jobId: matches[0].id });
              setMessage('Recovered the prior dashboard move from its durable request identity.');
              return;
            }
            if (matches.length > 1) {
              setError('More than one job matched the saved move identity, so none was opened. Choose dashboards to start a new move.');
            }
          } catch {
            if (active) setMessage('Prior move recovery is temporarily unavailable. You can still start a new move.');
          }
        }
        const eligibleSources = nextInstances.filter(instanceSupportsSource);
        const sourceStillEligible = eligibleSources.some((instance) => instance.id === draft.sourceId);
        const activeSourceId = connection.instanceId
          && eligibleSources.some((instance) => instance.id === connection.instanceId)
          ? connection.instanceId
          : '';
        const nextSourceId = sourceStillEligible
          ? draft.sourceId
          : activeSourceId || (eligibleSources.length === 1 ? eligibleSources[0].id : '');
        if (nextSourceId !== draft.sourceId) {
          dispatchDraft({
            type: 'choose_source',
            sourceId: nextSourceId,
            requestId: newDashboardSafeCopyRequestId(),
          });
        }
      })
      .catch((loadError) => {
        if (active) setError(loadError instanceof Error ? loadError.message : 'Could not load saved Omni instances.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  // Initial boot intentionally uses the identity-only restored draft snapshot.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => {
    sourceConnectionRequestRef.current += 1;
    dashboardRequestRef.current += 1;
    sourceConnectionAbortRef.current?.abort();
    dashboardAbortRef.current?.abort();
    Object.entries(destinationAbortRef.current).forEach(([instanceId, controller]) => {
      destinationRequestRef.current[instanceId] = (destinationRequestRef.current[instanceId] || 0) + 1;
      controller.abort();
    });
  }, []);

  const loadSourceConnections = useCallback(async (instanceId: string) => {
    if (!instanceId) return;
    sourceConnectionAbortRef.current?.abort();
    const controller = new AbortController();
    sourceConnectionAbortRef.current = controller;
    const request = sourceConnectionRequestRef.current + 1;
    sourceConnectionRequestRef.current = request;
    setLoadingSourceConnections(true);
    setError('');
    try {
      const response = await listModelMigratorConnections(instanceId, controller.signal);
      if (sourceConnectionRequestRef.current !== request) return;
      const connections = response.connections.filter((row) => !row.deletedAt);
      setSourceConnections(connections);
      dispatchDraft({
        type: 'resolve_source_connections',
        sourceId: instanceId,
        connectionIds: connections.map((row) => row.id),
        requestId: newDashboardSafeCopyRequestId(),
      });
    } catch (loadError) {
      if (controller.signal.aborted) return;
      if (sourceConnectionRequestRef.current === request) {
        setSourceConnections([]);
        setError(loadError instanceof Error ? loadError.message : 'Could not load source connections.');
      }
    } finally {
      if (sourceConnectionRequestRef.current === request) setLoadingSourceConnections(false);
    }
  }, []);

  useEffect(() => {
    if (!draft.jobId && draft.sourceId) void loadSourceConnections(draft.sourceId);
  }, [draft.jobId, draft.sourceId, loadSourceConnections]);

  const loadDashboards = useCallback(async (forceRefresh = false) => {
    if (!draft.sourceId || !draft.sourceConnectionId) return;
    dashboardAbortRef.current?.abort();
    const controller = new AbortController();
    dashboardAbortRef.current = controller;
    const request = dashboardRequestRef.current + 1;
    dashboardRequestRef.current = request;
    setLoadingDashboards(true);
    setError('');
    try {
      const response = await listInstanceDocuments(draft.sourceId, {
        connectionId: draft.sourceConnectionId,
        allFolders: true,
        includeModelDetails: false,
        forceRefresh,
        signal: controller.signal,
      });
      if (dashboardRequestRef.current !== request) return;
      setDocuments(response.documents);
      setDashboardInventory(response.inventory);
      dispatchDraft({
        type: 'prune_documents',
        sourceId: draft.sourceId,
        sourceConnectionId: draft.sourceConnectionId,
        availableDocumentIds: response.documents.map(sourceDocumentId),
        requestId: newDashboardSafeCopyRequestId(),
      });
      if (!response.inventory.complete) {
        setError('Omni returned an incomplete dashboard inventory. Refresh before selecting dashboards.');
      }
    } catch (loadError) {
      if (controller.signal.aborted) return;
      if (dashboardRequestRef.current === request) {
        setDocuments([]);
        setDashboardInventory(null);
        setError(loadError instanceof Error ? loadError.message : 'Could not load the complete dashboard inventory.');
      }
    } finally {
      if (dashboardRequestRef.current === request) setLoadingDashboards(false);
    }
  }, [draft.sourceConnectionId, draft.sourceId]);

  useEffect(() => {
    if (!draft.jobId && draft.sourceId && draft.sourceConnectionId) void loadDashboards(false);
  }, [draft.jobId, draft.sourceConnectionId, draft.sourceId, loadDashboards]);

  const loadDestinationCatalog = useCallback(async (instanceId: string) => {
    const instance = instances.find((row) => row.id === instanceId);
    if (!instance) return;
    const request = (destinationRequestRef.current[instanceId] || 0) + 1;
    destinationRequestRef.current[instanceId] = request;
    destinationAbortRef.current[instanceId]?.abort();
    const controller = new AbortController();
    destinationAbortRef.current[instanceId] = controller;
    setDestinationCatalogs((current) => ({
      ...current,
      [instanceId]: { ...(current[instanceId] || EMPTY_DESTINATION_CATALOG), loading: true, error: '' },
    }));
    try {
      const [connectionResponse, modelResponse] = await Promise.all([
        listModelMigratorConnections(instanceId, controller.signal),
        listModelMigratorModels(instanceId, { signal: controller.signal }),
      ]);
      if (destinationRequestRef.current[instanceId] !== request) return;
      const catalog: DestinationCatalog = {
        connections: connectionResponse.connections.filter((row) => !row.deletedAt),
        models: sortModels(modelResponse.models.filter((row) => !row.deletedAt)),
        loading: false,
        loaded: true,
        error: '',
      };
      setDestinationCatalogs((current) => ({ ...current, [instanceId]: catalog }));
      const destination = draft.destinations.find((row) => row.instanceId === instanceId);
      if (destination) {
        const resolution = resolveDashboardSafeCopyDestinationDefaults({
          instance,
          connections: catalog.connections,
          models: catalog.models,
          current: destination,
        });
        const modelId = destination.requiresModelChoice ? '' : resolution.modelId;
        if (!sameDestinationResolution(destination, resolution.connectionId, modelId)) {
          dispatchDraft({
            type: 'resolve_destination',
            instanceId,
            connectionId: resolution.connectionId,
            modelId,
            requestId: newDashboardSafeCopyRequestId(),
          });
        }
      }
    } catch (loadError) {
      if (controller.signal.aborted) return;
      if (destinationRequestRef.current[instanceId] !== request) return;
      setDestinationCatalogs((current) => ({
        ...current,
        [instanceId]: {
          ...(current[instanceId] || EMPTY_DESTINATION_CATALOG),
          loading: false,
          loaded: false,
          error: loadError instanceof Error ? loadError.message : 'Could not load destination connections and models.',
        },
      }));
    }
  }, [draft.destinations, instances]);

  useEffect(() => {
    if (draft.jobId) return;
    for (const destination of draft.destinations) {
      const catalog = destinationCatalogs[destination.instanceId];
      if (!catalog?.loading && !catalog?.loaded) void loadDestinationCatalog(destination.instanceId);
    }
  }, [destinationCatalogs, draft.destinations, draft.jobId, loadDestinationCatalog]);

  // Dependency detection: when entering the dependency step, auto-populate topic mappings
  useEffect(() => {
    if (draft.step !== 2 || draft.jobId) return;
    const selectedDocs = documents.filter((doc) => draft.selectedDocumentIds.includes(doc.id));
    const sourceTopicNames = [...new Set(
      selectedDocs.flatMap((doc) => doc.topicNames || []).filter(Boolean),
    )];
    if (sourceTopicNames.length === 0) return;
    const needsUpdate = draft.destinations.some((dest) => !dest.topicMappings || dest.topicMappings.length === 0);
    if (!needsUpdate) return;
    const updatedDestinations = draft.destinations.map((dest) => {
      if (dest.topicMappings && dest.topicMappings.length > 0) return dest;
      return {
        ...dest,
        topicMappings: sourceTopicNames.map((name) => ({
          sourceTopicName: name,
          action: 'copy_source' as const,
          targetTopicName: name,
        })),
      };
    });
    dispatchDraft({ type: 'patch_plan', patch: { destinations: updatedDestinations }, requestId: draft.requestId });
    // Also attempt to check destination topics for auto-mapping
    for (const dest of draft.destinations) {
      if (!dest.modelId || !dest.instanceId) continue;
      listInstanceModelTopics(dest.instanceId, dest.modelId)
        .then(({ topics }) => {
          if (topics.length === 0) return;
          const targetTopicNames = new Set(topics.map((t) => t.name.toLowerCase()));
          const autoMapped = sourceTopicNames.map((name) => ({
            sourceTopicName: name,
            action: targetTopicNames.has(name.toLowerCase()) ? 'map_existing' as const : 'copy_source' as const,
            targetTopicName: name,
          }));
          dispatchDraft({
            type: 'patch_plan',
            patch: {
              destinations: draft.destinations.map((d) => d.targetId === dest.targetId ? { ...d, topicMappings: autoMapped } : d),
            },
            requestId: draft.requestId,
          });
        })
        .catch(() => { /* destination topic lookup is best-effort */ });
    }
  }, [draft.step, draft.jobId, draft.selectedDocumentIds, documents, draft.destinations, draft.requestId]);

  useEffect(() => {
    const jobId = draft.jobId;
    if (!jobId) return undefined;
    let active = true;
    let terminal = false;
    let rejected = false;
    let subscribed = false;
    let unsubscribe: () => void = () => {};
    const rejectRestoredJob = (reason: string) => {
      if (!active || rejected) return;
      rejected = true;
      const next = createDashboardSafeCopyDraft();
      writeDashboardSafeCopyDraft(next);
      jobRef.current = null;
      setJob(null);
      dispatchDraft({ type: 'reject_restored_job', draft: next });
      setError(reason);
      setMessage('Choose dashboards to start a new move. No stored migration scope was trusted.');
    };
    const applyJob = (next: MigrationJob): boolean => {
      if (!active || rejected) return false;
      if (next.id !== jobId || !isDashboardSafeCopyJobForRequest(next, draft.requestId)) {
        rejectRestoredJob('The saved job did not match this safe dashboard move and was not opened.');
        return false;
      }
      const current = jobRef.current;
      if (current) {
        if (!shouldApplyDashboardSafeCopyJobSnapshot(current, next)) return false;
      }
      jobRef.current = next;
      setJob(next);
      terminal = isDashboardSafeCopyTerminal(next.status);
      if (terminal) {
        window.clearInterval(refreshTimer);
        unsubscribe();
        subscribed = false;
      }
      return true;
    };
    const refresh = async () => {
      if (!active || terminal || rejected) return;
      try {
        const response = await getMigrationJob(jobId);
        if (!applyJob(response.job) || terminal || subscribed) return;
        subscribed = true;
        unsubscribe = subscribeMigrationJob(jobId, (event) => {
          if (event.type === 'snapshot') applyJob(event.job);
          else if (event.type === 'job' && event.job) applyJob(event.job);
          else if (event.type === 'item') void refresh();
        }, () => {
          void refresh();
        });
      } catch (loadError) {
        if (!active) return;
        if (loadError instanceof ApiError && loadError.status === 404) {
          rejectRestoredJob('The saved dashboard move no longer exists. Its local recovery identity was cleared.');
          return;
        }
        setError(loadError instanceof Error ? loadError.message : 'Could not refresh migration progress.');
      }
    };
    const refreshTimer = window.setInterval(() => void refresh(), TRACKING_REFRESH_MS);
    void refresh();
    return () => {
      active = false;
      unsubscribe();
      window.clearInterval(refreshTimer);
    };
  }, [draft.jobId, draft.requestId, trackingRevision]);

  function chooseSource(instanceId: string) {
    // Re-selecting the instance that is already chosen must not disturb an
    // in-flight load. This function invalidates the pending source-connection
    // request and clears the list, but the reload is driven by an effect keyed
    // on draft.sourceId — so when the id has not changed the effect cannot
    // re-fire, the arriving response is dropped by the stale-request guard, and
    // the connection picker stays permanently empty with no error shown.
    if (instanceId === draft.sourceId) return;
    sourceConnectionAbortRef.current?.abort();
    dashboardAbortRef.current?.abort();
    sourceConnectionRequestRef.current += 1;
    dashboardRequestRef.current += 1;
    setSourceConnections([]);
    setDocuments([]);
    setDashboardInventory(null);
    setVisibleDashboardCount(DASHBOARD_PAGE_SIZE);
    dispatchDraft({
      type: 'choose_source',
      sourceId: instanceId,
      requestId: newDashboardSafeCopyRequestId(),
    });
    setError('');
  }

  function chooseSourceConnection(connectionId: string) {
    dashboardAbortRef.current?.abort();
    dashboardRequestRef.current += 1;
    setDocuments([]);
    setDashboardInventory(null);
    setVisibleDashboardCount(DASHBOARD_PAGE_SIZE);
    dispatchDraft({
      type: 'choose_source_connection',
      connectionId,
      requestId: newDashboardSafeCopyRequestId(),
    });
    setError('');
  }

  function toggleDocument(documentId: string) {
    if (!dashboardInventory?.complete) return;
    if (!selectedDocumentIds.has(documentId) && draft.selectedDocumentIds.length >= MAX_SELECTED_DASHBOARDS) {
      setError(`A move supports at most ${MAX_SELECTED_DASHBOARDS} dashboards.`);
      return;
    }
    if (
      !selectedDocumentIds.has(documentId)
      && draft.destinations.length > 0
      && (draft.selectedDocumentIds.length + 1) * draft.destinations.length > DASHBOARD_SAFE_COPY_MAX_MATRIX_CELLS
    ) {
      setError(`A move supports at most ${DASHBOARD_SAFE_COPY_MAX_MATRIX_CELLS.toLocaleString()} dashboard-destination copies.`);
      return;
    }
    dispatchDraft({
      type: 'toggle_document',
      documentId,
      limit: MAX_SELECTED_DASHBOARDS,
      requestId: newDashboardSafeCopyRequestId(),
    });
  }

  function selectAllMatching() {
    const ids = filteredDocuments.map(sourceDocumentId);
    const documentLimit = draft.destinations.length > 0
      ? Math.min(MAX_SELECTED_DASHBOARDS, Math.floor(DASHBOARD_SAFE_COPY_MAX_MATRIX_CELLS / draft.destinations.length))
      : MAX_SELECTED_DASHBOARDS;
    const bounded = [...new Set([...draft.selectedDocumentIds, ...ids])].slice(0, documentLimit).sort();
    dispatchDraft({
      type: 'patch_plan',
      patch: { selectedDocumentIds: bounded },
      requestId: newDashboardSafeCopyRequestId(),
    });
    if (bounded.length < new Set([...draft.selectedDocumentIds, ...ids]).size) {
      setMessage(`Selected the first ${documentLimit} dashboards within the safe copy limit.`);
    }
  }

  function toggleDestination(instanceId: string) {
    if (selectedDestinationIds.has(instanceId)) {
      destinationAbortRef.current[instanceId]?.abort();
      delete destinationAbortRef.current[instanceId];
      setDestinationCatalogs((current) => {
        const next = { ...current };
        delete next[instanceId];
        return next;
      });
    }
    if (!selectedDestinationIds.has(instanceId) && draft.destinations.length >= MAX_DESTINATIONS) {
      setError(`A move supports at most ${MAX_DESTINATIONS} destinations.`);
      return;
    }
    if (
      !selectedDestinationIds.has(instanceId)
      && draft.selectedDocumentIds.length * (draft.destinations.length + 1) > DASHBOARD_SAFE_COPY_MAX_MATRIX_CELLS
    ) {
      setError(`A move supports at most ${DASHBOARD_SAFE_COPY_MAX_MATRIX_CELLS.toLocaleString()} dashboard-destination copies.`);
      return;
    }
    dispatchDraft({
      type: 'toggle_destination',
      instanceId,
      limit: MAX_DESTINATIONS,
      requestId: newDashboardSafeCopyRequestId(),
    });
    setError('');
  }

  function setDestinationConnection(instanceId: string, connectionId: string) {
    const catalog = destinationCatalogs[instanceId] || EMPTY_DESTINATION_CATALOG;
    const instance = instances.find((row) => row.id === instanceId);
    if (!instance) return;
    const resolution = resolveDashboardSafeCopyDestinationDefaults({
      instance,
      connections: catalog.connections,
      models: catalog.models,
      current: { connectionId, modelId: '' },
    });
    dispatchDraft({
      type: 'resolve_destination',
      instanceId,
      connectionId: resolution.connectionId,
      modelId: resolution.modelId,
      requestId: newDashboardSafeCopyRequestId(),
      manual: true,
    });
  }

  function setDestinationModel(instanceId: string, modelId: string) {
    const catalog = destinationCatalogs[instanceId] || EMPTY_DESTINATION_CATALOG;
    const model = catalog.models.find((row) => row.id === modelId);
    const destination = draft.destinations.find((row) => row.instanceId === instanceId);
    if (!destination) return;
    dispatchDraft({
      type: 'resolve_destination',
      instanceId,
      modelId,
      connectionId: model?.connectionId || destination.connectionId,
      requestId: newDashboardSafeCopyRequestId(),
      manual: true,
    });
  }

  function goToStep(step: DashboardSafeCopyStep) {
    if (draft.jobId) return;
    dispatchDraft({ type: 'set_step', step });
    setError('');
    setMessage('');
  }

  async function startMove() {
    if (submitGuardRef.current || submitting) return;
    const completeDestinations = draft.destinations.every((row) => row.connectionId && row.modelId);
    if (
      !draft.sourceId
      || !draft.sourceConnectionId
      || draft.selectedDocumentIds.length === 0
      || draft.destinations.length === 0
      || !completeDestinations
    ) {
      setError('Complete the source, dashboard, and destination choices before moving.');
      return;
    }
    if (draft.selectedDocumentIds.length * draft.destinations.length > DASHBOARD_SAFE_COPY_MAX_MATRIX_CELLS) {
      setError(`Reduce the move to ${DASHBOARD_SAFE_COPY_MAX_MATRIX_CELLS.toLocaleString()} dashboard-destination copies or fewer.`);
      return;
    }
    submitGuardRef.current = true;
    setSubmitting(true);
    setError('');
    setMessage('Starting one safe copy to every selected destination...');
    const requestDraft = { ...draft, step: 2 as const };
    writeDashboardSafeCopyDraft(requestDraft);
    try {
      const response = await createDashboardSafeCopyJob(dashboardSafeCopyIntentFromDraft(requestDraft, instances));
      if (!isDashboardSafeCopyJobForRequest(response.job, requestDraft.requestId)) {
        throw new Error('The server returned a job that did not match this safe dashboard move. Nothing was attached locally.');
      }
      const attachedDraft = { ...requestDraft, jobId: response.job.id };
      writeDashboardSafeCopyDraft(attachedDraft);
      const current = jobRef.current;
      if (!current || shouldApplyDashboardSafeCopyJobSnapshot(current, response.job, { allowTerminalReopen: true })) {
        jobRef.current = response.job;
        setJob(response.job);
      }
      dispatchDraft({ type: 'attach_job', jobId: response.job.id });
      setMessage(response.replayed ? 'Resumed the existing move.' : 'Move started. You can leave this page and return to the same job.');
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : 'Could not start the dashboard move.');
      setMessage('');
    } finally {
      submitGuardRef.current = false;
      setSubmitting(false);
    }
  }

  async function retryTarget(targetId: string) {
    if (!job || retryGuardRef.current.has(targetId)) return;
    retryGuardRef.current.add(targetId);
    setRetryingTargetIds((current) => [...current, targetId]);
    setError('');
    try {
      const response = await retryDashboardSafeCopyTarget(job.id, targetId, newDashboardSafeCopyRequestId());
      if (response.job.id !== job.id || !isDashboardSafeCopyJobForRequest(response.job, draft.requestId)) {
        throw new Error('The retry response did not match this safe dashboard move and was not applied.');
      }
      const current = jobRef.current;
      if (current && shouldApplyDashboardSafeCopyJobSnapshot(current, response.job, { allowTerminalReopen: true })) {
        jobRef.current = response.job;
        setJob(response.job);
      }
      setTrackingRevision((revision) => revision + 1);
      setMessage('Destination retry accepted. OmniKit will reconcile prior evidence before any new write.');
    } catch (retryError) {
      setError(retryError instanceof Error ? retryError.message : 'Could not retry this destination.');
    } finally {
      retryGuardRef.current.delete(targetId);
      setRetryingTargetIds((current) => current.filter((id) => id !== targetId));
    }
  }

  function chooseAnotherModel(targetId: string) {
    if (!job || !isDashboardSafeCopyJobForRequest(job, draft.requestId)) return;
    const action = {
      type: 'replan_target' as const,
      job,
      targetId,
      requestId: newDashboardSafeCopyRequestId(),
    };
    const next = dashboardSafeCopyDraftReducer(draft, action);
    if (next === draft) {
      setError('Only a destination that needs attention can be replanned with another model.');
      return;
    }
    writeDashboardSafeCopyDraft(next);
    dispatchDraft(action);
    jobRef.current = null;
    setJob(null);
    setDocuments([]);
    setDashboardInventory(null);
    setDestinationCatalogs({});
    setSourceConnections([]);
    setSearch('');
    setVisibleDashboardCount(DASHBOARD_PAGE_SIZE);
    setError('');
    setMessage('Only this destination will be retried. Successful destinations stay untouched. Choose a different model.');
  }

  function openModelMigrator(target: DashboardSafeCopyTargetProgress) {
    if (!job || !isDashboardSafeCopyJobForRequest(job, draft.requestId)) return;
    const persistedTarget = job.targets?.find((row) => row.id === target.targetId);
    try {
      const handoff = createDashboardSafeCopyModelMigratorHandoff({
        jobId: job.id,
        targetId: target.targetId,
        sourceInstanceId: job.sourceId,
        sourceConnectionId: job.sourceConnectionId || '',
        targetInstanceId: target.destinationId,
        targetConnectionId: persistedTarget?.targetConnectionId || '',
        targetModelId: target.modelId || '',
      });
      navigate('/models/migrate', { state: handoff });
    } catch (handoffError) {
      setError(handoffError instanceof Error
        ? handoffError.message
        : 'The Model Migrator repair scope could not be opened safely.');
    }
  }

  function startAnotherMove() {
    const next = createDashboardSafeCopyDraft();
    writeDashboardSafeCopyDraft(next);
    dispatchDraft({ type: 'reset', draft: next });
    jobRef.current = null;
    setJob(null);
    setDocuments([]);
    setDashboardInventory(null);
    setDestinationCatalogs({});
    setSourceConnections([]);
    setSearch('');
    setError('');
    setMessage('');
  }

  const sourceReady = Boolean(
    draft.sourceId
    && draft.sourceConnectionId
    && dashboardInventory?.complete
    && draft.selectedDocumentIds.length > 0,
  );
  const destinationsReady = draft.destinations.length > 0
    && draft.destinations.every((row) => row.connectionId && row.modelId);

  if (loading && !job) {
    return (
      <div className="card flex items-center justify-center gap-2 p-8 text-content-secondary" role="status">
        <Loader2 size={18} className="motion-safe:animate-spin" aria-hidden="true" />
        Preparing the safe dashboard move...
      </div>
    );
  }

  if (!vaultStatus?.unlocked && !draft.jobId) {
    return (
      <>
        {error && <div role="alert" className="rounded-card border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
        <SavedInstanceRequiredEmptyState toolName="Dashboard Migrator" />
      </>
    );
  }

  return (
    <div className="space-y-5">
      <nav className="card p-3" aria-label="Dashboard move steps">
        <ol className="grid gap-2 sm:grid-cols-3">
          {STEP_LABELS.map((label, index) => {
            const step = index as DashboardSafeCopyStep;
            const enabled = !draft.jobId && (
              step === 0
              || (step === 1 && sourceReady)
              || (step === 2 && sourceReady && destinationsReady)
              || (step === 3 && sourceReady && destinationsReady)
            );
            return (
              <li key={label}>
                <button
                  type="button"
                  onClick={() => enabled && goToStep(step)}
                  disabled={!enabled}
                  aria-current={draft.step === step ? 'step' : undefined}
                  className={`w-full rounded-button px-3 py-2.5 text-left transition motion-reduce:transition-none ${
                    draft.step === step
                      ? 'bg-omni-600 text-white'
                      : enabled ? 'bg-surface-secondary text-content-secondary hover:bg-omni-50' : 'bg-surface-secondary text-content-tertiary opacity-60'
                  }`}
                >
                  <span className="block text-[10px] font-bold uppercase tracking-[0.16em] opacity-80">Step {index + 1}</span>
                  <span className="block text-sm font-semibold">{label}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </nav>

      {error && <div role="alert" className="rounded-card border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      {message && <div role="status" aria-live="polite" className="rounded-card border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">{message}</div>}

      {draft.step === 0 && !draft.jobId && (
        <section className="space-y-5" aria-labelledby="safe-copy-dashboards-heading">
          <div className="card p-5">
            <h2 ref={headingRef} tabIndex={-1} id="safe-copy-dashboards-heading" className="text-lg font-semibold text-content-primary">
              Choose dashboards
            </h2>
            <p className="mt-1 text-sm text-content-secondary">
              Choose one source connection, then select dashboards from its complete inventory. Folder boundaries are discovered automatically.
            </p>
            <div className="mt-5 grid gap-4 md:grid-cols-2">
              <div>
                <label className="mb-1.5 block text-sm font-semibold text-content-primary">Source instance</label>
                <ComboBox
                  options={sourceInstances.map((instance) => ({
                    value: instance.id,
                    label: instance.label,
                    subtitle: instance.baseUrl.replace(/^https?:\/\//, ''),
                  }))}
                  value={draft.sourceId}
                  onChange={chooseSource}
                  allowFreeText={false}
                  placeholder="Choose a source instance"
                  emptyLabel="No source-eligible saved instances found"
                  ariaLabel="Source instance"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-semibold text-content-primary">Source connection</label>
                <ComboBox
                  options={buildConnectionComboBoxOptions(sourceConnections)}
                  value={draft.sourceConnectionId}
                  onChange={chooseSourceConnection}
                  allowFreeText={false}
                  disabled={!draft.sourceId}
                  isLoading={loadingSourceConnections}
                  loadingLabel="Loading source connections..."
                  placeholder="Choose a source connection"
                  emptyLabel="No active source connections found"
                  ariaLabel="Source connection"
                  optionLayout="stacked"
                />
              </div>
            </div>
          </div>

          <div className="card p-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h3 className="text-base font-semibold text-content-primary">Dashboards</h3>
                <p className="mt-1 text-xs text-content-secondary">
                  {dashboardInventory?.complete
                    ? `${dashboardInventory.matchedRecordCount} dashboards in a complete connection-scoped inventory.`
                    : draft.sourceConnectionId ? 'Loading a complete connection-scoped inventory.' : 'Choose a source connection to load dashboards.'}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={selectAllMatching}
                  disabled={!dashboardInventory?.complete || filteredDocuments.length === 0}
                  className="btn-secondary btn-sm"
                >
                  Select matching
                </button>
                <button
                  type="button"
                  onClick={() => dispatchDraft({
                    type: 'patch_plan',
                    patch: { selectedDocumentIds: [] },
                    requestId: newDashboardSafeCopyRequestId(),
                  })}
                  disabled={draft.selectedDocumentIds.length === 0}
                  className="btn-secondary btn-sm"
                >
                  Clear
                </button>
                <button
                  type="button"
                  onClick={() => void loadDashboards(true)}
                  disabled={!draft.sourceConnectionId || loadingDashboards}
                  className="btn-secondary btn-sm"
                >
                  {loadingDashboards ? <Loader2 size={13} className="motion-safe:animate-spin" aria-hidden="true" /> : <RefreshCw size={13} aria-hidden="true" />}
                  Refresh
                </button>
              </div>
            </div>
            <div className="mt-4">
              <SearchInput
                value={search}
                onChange={(value) => {
                  setSearch(value);
                  setVisibleDashboardCount(DASHBOARD_PAGE_SIZE);
                }}
                placeholder="Search dashboards, folders, models, or labels"
              />
            </div>
            {loadingDashboards && (
              <div role="status" className="mt-4 flex items-center gap-2 rounded-card bg-surface-secondary px-3 py-3 text-sm text-content-secondary">
                <Loader2 size={15} className="motion-safe:animate-spin" aria-hidden="true" />
                Loading every dashboard in this connection...
              </div>
            )}
            {!loadingDashboards && dashboardInventory?.complete && (
              <div className="mt-4 max-h-[32rem] overflow-y-auto rounded-card border border-border" aria-label="Available dashboards">
                {visibleDocuments.map((document) => {
                  const documentId = sourceDocumentId(document);
                  const selected = selectedDocumentIds.has(documentId);
                  return (
                    <label
                      key={documentId}
                      className={`flex cursor-pointer items-start gap-3 border-b border-border-subtle px-4 py-3 last:border-b-0 ${selected ? 'bg-omni-50' : 'bg-white hover:bg-surface-secondary'}`}
                    >
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => toggleDocument(documentId)}
                        className="mt-0.5 h-4 w-4 accent-omni-600"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-content-primary">{document.name}</span>
                        <span className="mt-0.5 block truncate text-xs text-content-secondary">
                          {document.folderPath || 'Top level'}
                          {(document.baseModelName || document.baseModelId) ? ` · ${document.baseModelName || document.baseModelId}` : ''}
                        </span>
                      </span>
                    </label>
                  );
                })}
                {filteredDocuments.length === 0 && (
                  <div className="px-4 py-8 text-center text-sm text-content-secondary">No dashboards match this search.</div>
                )}
                {visibleDocuments.length < filteredDocuments.length && (
                  <div className="flex justify-center border-t border-border-subtle bg-white p-3">
                    <button
                      type="button"
                      onClick={() => setVisibleDashboardCount((count) => count + DASHBOARD_PAGE_SIZE)}
                      className="btn-secondary btn-sm"
                    >
                      Show {Math.min(DASHBOARD_PAGE_SIZE, filteredDocuments.length - visibleDocuments.length)} more
                    </button>
                  </div>
                )}
              </div>
            )}
            <div className="mt-4 flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-sm font-semibold text-content-primary">
                {draft.selectedDocumentIds.length} dashboard{draft.selectedDocumentIds.length === 1 ? '' : 's'} selected
              </div>
              <button
                type="button"
                onClick={() => goToStep(1)}
                disabled={!sourceReady}
                className="btn-primary justify-center"
              >
                Choose destinations
                <ArrowRight size={15} aria-hidden="true" />
              </button>
            </div>
          </div>
        </section>
      )}

      {draft.step === 1 && !draft.jobId && (
        <section className="space-y-5" aria-labelledby="safe-copy-destinations-heading">
          <div className="card p-5">
            <h2 ref={headingRef} tabIndex={-1} id="safe-copy-destinations-heading" className="text-lg font-semibold text-content-primary">
              Choose destinations
            </h2>
            <p className="mt-1 text-sm text-content-secondary">
              Every selected dashboard moves to every selected destination. Saved defaults and sole choices are applied automatically.
            </p>
            <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {destinationInstances.map((instance) => {
                const selected = selectedDestinationIds.has(instance.id);
                return (
                  <label
                    key={instance.id}
                    className={`flex cursor-pointer items-start gap-3 rounded-card border p-4 ${selected ? 'border-omni-300 bg-omni-50' : 'border-border bg-white hover:bg-surface-secondary'}`}
                  >
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => toggleDestination(instance.id)}
                      className="mt-0.5 h-4 w-4 accent-omni-600"
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold text-content-primary">{instance.label}</span>
                      <span className="mt-1 block truncate text-xs text-content-secondary">{instance.baseUrl.replace(/^https?:\/\//, '')}</span>
                      {instance.id === draft.sourceId && <span className="mt-1 block text-[11px] font-semibold text-amber-700">Same saved instance</span>}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>

          {draft.destinations.map((destination, destinationIndex) => {
            const instance = instances.find((row) => row.id === destination.instanceId);
            const catalog = destinationCatalogs[destination.instanceId] || EMPTY_DESTINATION_CATALOG;
            const automaticResolution = instance ? resolveDashboardSafeCopyDestinationDefaults({
              instance,
              connections: catalog.connections,
              models: catalog.models,
              current: destination,
            }) : { connectionId: '', modelId: '', needsConnection: true, needsModel: true };
            const resolution = destination.requiresModelChoice && !destination.modelId
              ? { ...automaticResolution, modelId: '', needsModel: true }
              : automaticResolution;
            const selectedConnection = catalog.connections.find((row) => row.id === destination.connectionId);
            const selectedModel = catalog.models.find((row) => row.id === destination.modelId);
            const modelOptions = catalog.models.filter((model) => (
              !destination.connectionId || !model.connectionId || model.connectionId === destination.connectionId
            ));
            return (
              <article key={destination.targetId} className="card p-5" aria-labelledby={`destination-${destination.targetId}`}>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h3 id={`destination-${destination.targetId}`} className="text-base font-semibold text-content-primary">
                      {instance?.label || destination.instanceId}
                    </h3>
                    <p className="mt-1 text-xs text-content-secondary">
                      Folder: {destinationFolderLabel(instance?.defaultFolderPath, instance?.defaultFolderId)}
                    </p>
                  </div>
                  {catalog.loading
                    ? <StatusChip status="in_progress" label="Resolving defaults" size="xs" />
                    : destination.connectionId && destination.modelId
                      ? <StatusChip status="ready" label="Ready" size="xs" />
                      : <StatusChip status="warning" label="Choice needed" size="xs" />}
                </div>

                {catalog.error && (
                  <div role="alert" className="mt-4 rounded-card border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                    {catalog.error}
                    <button type="button" onClick={() => void loadDestinationCatalog(destination.instanceId)} className="btn-secondary btn-sm mt-2">
                      <RefreshCw size={13} aria-hidden="true" /> Retry
                    </button>
                  </div>
                )}

                {!catalog.error && catalog.loaded && (
                  <div className="mt-4 grid gap-4 md:grid-cols-2">
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-[0.12em] text-content-secondary">Connection</div>
                      {resolution.needsConnection ? (
                        <div className="mt-1.5">
                          <ComboBox
                            options={buildConnectionComboBoxOptions(catalog.connections)}
                            value={destination.connectionId}
                            onChange={(value) => setDestinationConnection(destination.instanceId, value)}
                            allowFreeText={false}
                            placeholder="Choose connection"
                            emptyLabel="No active destination connections"
                            // Named then numbered, and ending in "connection":
                            // the tenant says where the write lands, the index
                            // disambiguates two rows for the same instance, and
                            // ComboBox derives the listbox name by appending
                            // " options" — so the trailing word has to be
                            // "connection" for that derived name to read.
                            ariaLabel={`${instance?.label || destination.instanceId} destination ${destinationIndex + 1} connection`}
                            optionLayout="stacked"
                          />
                        </div>
                      ) : (
                        <div className="mt-1.5 flex items-start gap-2 rounded-card bg-surface-secondary px-3 py-2 text-sm text-content-primary">
                          <Check size={14} className="mt-0.5 flex-shrink-0 text-green-700" aria-hidden="true" />
                          <span className="min-w-0">
                            <span className="block">{selectedConnection?.name || destination.connectionId}</span>
                            {/* Two connections on one instance can share a name. Once
                                the picker is replaced by this summary the name alone
                                no longer identifies which one will be written to, so
                                keep the database and the id visible here. */}
                            {selectedConnection?.database && (
                              <span className="mt-0.5 block break-words text-xs text-content-secondary">
                                {selectedConnection.database}
                              </span>
                            )}
                            {destination.connectionId && selectedConnection?.name !== destination.connectionId && (
                              <span className="mt-0.5 block break-all font-mono text-[10px] text-content-tertiary">
                                {destination.connectionId}
                              </span>
                            )}
                          </span>
                        </div>
                      )}
                    </div>
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-[0.12em] text-content-secondary">Model</div>
                      {resolution.needsModel ? (
                        <div className="mt-1.5">
                          <ComboBox
                            options={modelOptions.map((model) => ({
                              value: model.id,
                              label: modelDisplayLabel(model),
                              subtitle: model.connectionName || model.connectionId,
                            }))}
                            value={destination.modelId}
                            onChange={(value) => setDestinationModel(destination.instanceId, value)}
                            allowFreeText={false}
                            disabled={!destination.connectionId}
                            placeholder={destination.connectionId ? 'Choose model' : 'Choose connection first'}
                            emptyLabel="No shared models for this connection"
                            ariaLabel={`Destination model for ${instance?.label || destination.instanceId}`}
                            optionLayout="stacked"
                          />
                        </div>
                      ) : (
                        <div className="mt-1.5 flex items-center gap-2 rounded-card bg-surface-secondary px-3 py-2 text-sm text-content-primary">
                          <Check size={14} className="text-green-700" aria-hidden="true" />
                          {selectedModel ? modelDisplayLabel(selectedModel) : destination.modelId}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </article>
            );
          })}

          <details className="card p-5">
            <summary className="cursor-pointer text-sm font-semibold text-content-primary">
              Advanced options
            </summary>
            <div className="mt-4 space-y-3">
              <label className="flex items-center gap-3 text-sm text-content-primary">
                <input
                  type="checkbox"
                  checked={draft.emptyFirst || false}
                  onChange={() => dispatchDraft({ type: 'patch_plan', patch: { emptyFirst: !draft.emptyFirst }, requestId: draft.requestId })}
                  className="h-4 w-4 accent-omni-600"
                />
                Empty destination folder before deploying
              </label>
              <label className="flex items-center gap-3 text-sm text-content-primary">
                <input
                  type="checkbox"
                  checked={draft.deleteSourceOnSuccess || false}
                  onChange={() => dispatchDraft({ type: 'patch_plan', patch: { deleteSourceOnSuccess: !draft.deleteSourceOnSuccess }, requestId: draft.requestId })}
                  className="h-4 w-4 accent-omni-600"
                />
                Delete source dashboards after successful migration
              </label>
              <label className="flex items-center gap-3 text-sm text-content-primary">
                <input
                  type="checkbox"
                  checked={draft.refreshSchemaOnComplete || false}
                  onChange={() => dispatchDraft({ type: 'patch_plan', patch: { refreshSchemaOnComplete: !draft.refreshSchemaOnComplete }, requestId: draft.requestId })}
                  className="h-4 w-4 accent-omni-600"
                />
                Trigger schema refresh after landing
              </label>
            </div>
          </details>

          <div className="card p-5">
            <div className="rounded-card border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
              <div className="font-semibold">Safe defaults</div>
              <div className="mt-1 text-xs leading-5">
                Existing dashboards are never overwritten. Same-name copies receive a deterministic suffix, and required model content is prepared automatically.
              </div>
              <div className="mt-1 text-xs leading-5">{DESTINATION_ACCESS_NOTICE}</div>
            </div>
            <div className="mt-4 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
              <button type="button" onClick={() => goToStep(0)} className="btn-secondary justify-center">
                <ArrowLeft size={15} aria-hidden="true" /> Back
              </button>
              <button type="button" onClick={() => goToStep(2)} disabled={!destinationsReady} className="btn-primary justify-center">
                Review dependencies <ArrowRight size={15} aria-hidden="true" />
              </button>
            </div>
          </div>
        </section>
      )}

      {draft.step === 2 && !draft.jobId && (
        <section className="space-y-5" aria-labelledby="safe-copy-dependencies-heading">
          <div className="card p-5">
            <h2 ref={headingRef} tabIndex={-1} id="safe-copy-dependencies-heading" className="text-lg font-semibold text-content-primary">
              Review dependencies
            </h2>
            <p className="mt-1 text-sm text-content-secondary">
              If selected dashboards reference topics or query views in the source model, map them to existing targets or copy them to the destination.
            </p>

            {draft.destinations.map((destination) => {
              const instance = instances.find((row) => row.id === destination.instanceId);
              const topicMappings = destination.topicMappings || [];
              const queryViewMappings = destination.queryViewMappings || [];
              const hasDependencies = topicMappings.length > 0 || queryViewMappings.length > 0;
              return (
                <article key={destination.targetId} className="mt-5 rounded-card border border-border p-4">
                  <h3 className="text-sm font-semibold text-content-primary">
                    {instance?.label || destination.instanceId}
                  </h3>
                  {!hasDependencies && (
                    <p className="mt-2 text-xs text-content-secondary">
                      No topic or query view dependencies detected. The dashboards can be moved without additional mapping.
                    </p>
                  )}
                  {topicMappings.length > 0 && (
                    <div className="mt-3">
                      <div className="text-xs font-semibold uppercase tracking-wider text-content-secondary">Topic mappings</div>
                      <div className="mt-2 space-y-2">
                        {topicMappings.map((mapping, index) => (
                          <div key={mapping.sourceTopicName} className="flex items-center gap-3 rounded-card border border-border bg-surface-secondary p-3">
                            <span className="min-w-0 flex-1 truncate text-sm text-content-primary">{mapping.sourceTopicName}</span>
                            <select
                              value={mapping.action}
                              onChange={(event) => {
                                const updated = [...topicMappings];
                                updated[index] = { ...mapping, action: event.target.value as typeof mapping.action, targetTopicName: event.target.value === 'copy_source' ? mapping.sourceTopicName : mapping.targetTopicName };
                                dispatchDraft({ type: 'patch_plan', patch: { destinations: draft.destinations.map((d) => d.targetId === destination.targetId ? { ...d, topicMappings: updated } : d) }, requestId: draft.requestId });
                              }}
                              className="rounded border border-border bg-white px-2 py-1 text-xs"
                            >
                              <option value="copy_source">Copy from source</option>
                              <option value="map_existing">Map to existing</option>
                            </select>
                            {mapping.action === 'map_existing' && (
                              <input
                                type="text"
                                value={mapping.targetTopicName}
                                onChange={(event) => {
                                  const updated = [...topicMappings];
                                  updated[index] = { ...mapping, targetTopicName: event.target.value };
                                  dispatchDraft({ type: 'patch_plan', patch: { destinations: draft.destinations.map((d) => d.targetId === destination.targetId ? { ...d, topicMappings: updated } : d) }, requestId: draft.requestId });
                                }}
                                placeholder="Target topic name"
                                className="w-40 rounded border border-border px-2 py-1 text-xs"
                              />
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {queryViewMappings.length > 0 && (
                    <div className="mt-3">
                      <div className="text-xs font-semibold uppercase tracking-wider text-content-secondary">Query view mappings</div>
                      <div className="mt-2 space-y-2">
                        {queryViewMappings.map((mapping, index) => (
                          <div key={mapping.sourceQueryViewName} className="flex items-center gap-3 rounded-card border border-border bg-surface-secondary p-3">
                            <span className="min-w-0 flex-1 truncate text-sm text-content-primary">{mapping.sourceQueryViewName}</span>
                            <select
                              value={mapping.action}
                              onChange={(event) => {
                                const updated = [...queryViewMappings];
                                updated[index] = { ...mapping, action: event.target.value as typeof mapping.action, targetQueryViewName: event.target.value === 'copy_source' ? mapping.sourceQueryViewName : mapping.targetQueryViewName };
                                dispatchDraft({ type: 'patch_plan', patch: { destinations: draft.destinations.map((d) => d.targetId === destination.targetId ? { ...d, queryViewMappings: updated } : d) }, requestId: draft.requestId });
                              }}
                              className="rounded border border-border bg-white px-2 py-1 text-xs"
                            >
                              <option value="copy_source">Copy from source</option>
                              <option value="map_existing">Map to existing</option>
                            </select>
                            {mapping.action === 'map_existing' && (
                              <input
                                type="text"
                                value={mapping.targetQueryViewName}
                                onChange={(event) => {
                                  const updated = [...queryViewMappings];
                                  updated[index] = { ...mapping, targetQueryViewName: event.target.value };
                                  dispatchDraft({ type: 'patch_plan', patch: { destinations: draft.destinations.map((d) => d.targetId === destination.targetId ? { ...d, queryViewMappings: updated } : d) }, requestId: draft.requestId });
                                }}
                                placeholder="Target query view name"
                                className="w-40 rounded border border-border px-2 py-1 text-xs"
                              />
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </article>
              );
            })}
          </div>

          <div className="card p-5">
            <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
              <button type="button" onClick={() => goToStep(1)} className="btn-secondary justify-center">
                <ArrowLeft size={15} aria-hidden="true" /> Back
              </button>
              <button type="button" onClick={() => goToStep(3)} className="btn-primary justify-center">
                Confirm &amp; deploy <ArrowRight size={15} aria-hidden="true" />
              </button>
            </div>
          </div>
        </section>
      )}

      {draft.step === 3 && (
        <section className="space-y-5" aria-labelledby="safe-copy-track-heading">
          <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {progressAnnouncement}
          </p>
          <div className="card p-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h2 ref={headingRef} tabIndex={-1} id="safe-copy-track-heading" className="text-lg font-semibold text-content-primary">
                  Move &amp; track
                </h2>
                <p className="mt-1 text-sm text-content-secondary">
                  {job ? 'This progress is backed by the durable migration job.' : 'Confirm the simple A-to-every-destination move below.'}
                </p>
              </div>
              {job && displayedJobStatus && (
                <StatusChip status={displayedJobStatus.chip} label={displayedJobStatus.label} />
              )}
            </div>

            {!job && (
              <>
                <div className="mt-5 grid gap-3 sm:grid-cols-3">
                  <div className="rounded-card bg-surface-secondary p-4">
                    <FileText size={17} className="text-omni-700" aria-hidden="true" />
                    <div className="mt-2 text-2xl font-semibold text-content-primary">{draft.selectedDocumentIds.length}</div>
                    <div className="text-xs text-content-secondary">Dashboards</div>
                  </div>
                  <div className="rounded-card bg-surface-secondary p-4">
                    <Database size={17} className="text-omni-700" aria-hidden="true" />
                    <div className="mt-2 text-2xl font-semibold text-content-primary">{draft.destinations.length}</div>
                    <div className="text-xs text-content-secondary">Destinations</div>
                  </div>
                  <div className="rounded-card bg-surface-secondary p-4">
                    <Copy size={17} className="text-omni-700" aria-hidden="true" />
                    <div className="mt-2 text-2xl font-semibold text-content-primary">{draft.selectedDocumentIds.length * draft.destinations.length}</div>
                    <div className="text-xs text-content-secondary">Planned copies</div>
                  </div>
                </div>
                <div className="mt-5 rounded-card border border-border p-4">
                  <div className="text-sm font-semibold text-content-primary">
                    {sourceInstance?.label || draft.sourceId} → {draft.destinations.map((row) => instances.find((instance) => instance.id === row.instanceId)?.label || row.instanceId).join(', ')}
                  </div>
                  <ul className="mt-2 space-y-1 text-xs text-content-secondary" aria-label="Destination folders">
                    {draft.destinations.map((destination) => (
                      <li key={destination.targetId}>
                        {instances.find((instance) => instance.id === destination.instanceId)?.label || destination.instanceId}: Folder {destinationFolderLabel(
                          instances.find((instance) => instance.id === destination.instanceId)?.defaultFolderPath,
                          instances.find((instance) => instance.id === destination.instanceId)?.defaultFolderId,
                        )}
                      </li>
                    ))}
                  </ul>
                  <div className="mt-2 text-xs leading-5 text-content-secondary">
                    Existing content is not replaced or deleted. {DESTINATION_ACCESS_NOTICE}
                  </div>
                </div>
                <div className="mt-5 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <button type="button" onClick={() => goToStep(1)} className="btn-secondary justify-center">
                    <ArrowLeft size={15} aria-hidden="true" /> Back
                  </button>
                  <button type="button" onClick={() => void startMove()} disabled={submitting} className="btn-primary justify-center">
                    {submitting ? <Loader2 size={15} className="motion-safe:animate-spin" aria-hidden="true" /> : <FolderInput size={15} aria-hidden="true" />}
                    {submitting ? 'Starting move...' : 'Move dashboards'}
                  </button>
                </div>
              </>
            )}

            {job && (
              <div className="mt-5 rounded-card border border-border bg-surface-secondary p-4">
                {globalReconciliationHold && (
                  <div role="alert" className="mb-3 rounded-card border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-950">
                    This move is paused for reconciliation. Retry the affected destination before starting another move.
                  </div>
                )}
                <p className="text-xs leading-5 text-content-secondary">
                  Each destination advances independently through prepare, copy, verify, and complete.
                </p>
                <details className="mt-3 text-xs text-content-secondary">
                  <summary className="cursor-pointer font-semibold">Technical details</summary>
                  <div className="mt-2 break-all font-mono text-[10px] text-content-primary">Job {job.id}</div>
                </details>
              </div>
            )}
          </div>

          {job && progress.map((target, targetIndex) => {
            const retrying = retryingTargetIds.includes(target.targetId);
            const actions = dashboardSafeCopyTargetActions(target);
            const destinationInstance = instanceById.get(target.destinationId);
            const targetScope = job.targets?.find((candidate) => candidate.id === target.targetId);
            const visibleDocumentCount = visibleProgressDocuments[target.targetId] || PROGRESS_DOCUMENT_PAGE_SIZE;
            const visibleTargetDocuments = target.documents;
            const documentsExpanded = expandedProgressTargetId === target.targetId;
            const targetHeadingId = `safe-copy-progress-target-${targetIndex + 1}`;
            return (
              <article key={target.targetId} className="card min-w-0 p-4 sm:p-5" aria-labelledby={targetHeadingId}>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <h3 id={targetHeadingId} className="break-words text-base font-semibold text-content-primary">{target.destinationLabel}</h3>
                    <p className="mt-1 break-words text-xs text-content-secondary">
                      {target.modelName ? `Model ${target.modelName}` : 'Destination model selected'}
                    </p>
                    <p className="mt-1 break-words text-xs text-content-secondary">
                      Folder {destinationFolderLabel(targetScope?.targetFolderPath, targetScope?.targetFolderId)}
                    </p>
                  </div>
                  <StatusChip status={TARGET_PHASE_CHIPS[target.phase]} label={TARGET_PHASE_LABELS[target.phase]} />
                </div>

                <ol
                  className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4"
                  aria-label={`${target.destinationLabel} move stages`}
                >
                  {TARGET_STAGES.map((stage, index) => {
                    const active = target.activeStage === stage.id;
                    const complete = target.completedStages.includes(stage.id);
                    const attention = active && (
                      target.phase === 'needs_attention' || target.phase === 'reconciliation_required'
                    );
                    const canceled = active && target.phase === 'canceled';
                    const tone = complete && (!active || target.phase === 'succeeded')
                      ? 'border-green-200 bg-green-50 text-green-900'
                      : attention
                        ? 'border-amber-300 bg-amber-50 text-amber-950'
                        : canceled
                          ? 'border-border bg-surface-secondary text-content-secondary'
                          : active
                            ? 'border-omni-300 bg-omni-50 text-omni-900'
                            : 'border-border bg-white text-content-secondary';
                    const stageState = complete && (!active || target.phase === 'succeeded')
                      ? 'Complete'
                      : active ? TARGET_PHASE_LABELS[target.phase] : 'Not started';
                    return (
                      <li
                        key={stage.id}
                        aria-current={active ? 'step' : undefined}
                        className={`min-w-0 rounded-card border px-2 py-2 ${tone}`}
                      >
                        <div className="flex items-center gap-1.5 text-[11px] font-semibold">
                          {complete && <Check size={12} aria-hidden="true" />}
                          <span className="break-words">{index + 1}. {stage.label}</span>
                        </div>
                        <span className="sr-only">: {stageState}</span>
                      </li>
                    );
                  })}
                </ol>
                {(target.message || target.exceptionCodes.length > 0) && (
                  <div className={`mt-4 rounded-card border px-3 py-2 text-xs ${actions.canRetry ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-border bg-surface-secondary text-content-secondary'}`}>
                    {target.message || 'This destination returned a bounded migration exception.'}
                    {target.exceptionCodes.length > 0 && (
                      <details className="mt-2">
                        <summary className="cursor-pointer font-semibold">Technical details</summary>
                        <div className="mt-1 break-words font-mono text-[10px]">{target.exceptionCodes.join(' · ')}</div>
                      </details>
                    )}
                  </div>
                )}

                {target.documentCount > 0 && (
                  <details
                    open={documentsExpanded}
                    onToggle={(event) => {
                      if (event.currentTarget.open) setExpandedProgressTargetId(target.targetId);
                      else setExpandedProgressTargetId((current) => current === target.targetId ? '' : current);
                    }}
                    className="mt-4 rounded-card border border-border bg-surface-secondary"
                  >
                    <summary className="cursor-pointer px-3 py-3 text-sm font-semibold text-content-primary sm:px-4">
                      Dashboard results ({target.documentCount})
                    </summary>
                    {documentsExpanded && <div className="border-t border-border p-3 sm:p-4">
                      <ul className="space-y-2" aria-label={`Dashboard progress for ${target.destinationLabel}`}>
                        {visibleTargetDocuments.map((document) => {
                          const dashboardUrl = document.phase === 'complete'
                            ? verifiedDashboardUrl(destinationInstance?.baseUrl, document.verifiedDestinationIdentifier)
                            : '';
                          return (
                            <li
                              key={document.sourceDocumentId}
                              className="min-w-0 rounded-card border border-border bg-white p-3"
                            >
                              <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                                <div className="min-w-0">
                                  <div className="break-words text-sm font-semibold text-content-primary">
                                    {document.sourceLabel}
                                  </div>
                                  {document.chosenTargetName && (
                                    <div className="mt-1 break-words text-xs text-content-secondary">
                                      Copied as {document.chosenTargetName}
                                    </div>
                                  )}
                                </div>
                                <StatusChip
                                  status={DOCUMENT_PHASE_CHIPS[document.phase]}
                                  label={DOCUMENT_PHASE_LABELS[document.phase]}
                                  size="xs"
                                />
                              </div>
                              <div className="mt-3 flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                                {dashboardUrl ? (
                                  <a
                                    href={dashboardUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="btn-secondary btn-sm w-full justify-center sm:w-auto"
                                    aria-label={`Open ${document.chosenTargetName || document.sourceLabel} in ${target.destinationLabel}`}
                                  >
                                    <ExternalLink size={13} aria-hidden="true" /> Open verified dashboard
                                  </a>
                                ) : <span />}
                                <details className="min-w-0 text-xs text-content-secondary">
                                  <summary className="cursor-pointer font-semibold">Technical details</summary>
                                  <div className="mt-1 break-all font-mono text-[10px]">
                                    Source dashboard {document.sourceDocumentId}
                                    {document.exceptionCode ? ` · ${document.exceptionCode}` : ''}
                                  </div>
                                </details>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                      {visibleTargetDocuments.length < target.documentCount && (
                        <button
                          type="button"
                          onClick={() => setVisibleProgressDocuments((current) => ({
                            ...current,
                            [target.targetId]: Math.min(
                              target.documentCount,
                              visibleDocumentCount + PROGRESS_DOCUMENT_PAGE_SIZE,
                            ),
                          }))}
                          className="btn-secondary btn-sm mt-3 w-full justify-center sm:w-auto"
                        >
                          Show {Math.min(PROGRESS_DOCUMENT_PAGE_SIZE, target.documentCount - visibleTargetDocuments.length)} more
                        </button>
                      )}
                    </div>}
                  </details>
                )}
                {(actions.canRetry || actions.canChooseAnotherModel || actions.canOpenModelMigrator) && (
                  <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                    {actions.canRetry && (
                      <button
                        type="button"
                        onClick={() => void retryTarget(target.targetId)}
                        disabled={retrying}
                        className="btn-secondary btn-sm w-full justify-center sm:w-auto"
                      >
                        {retrying ? <Loader2 size={13} className="motion-safe:animate-spin" aria-hidden="true" /> : <RotateCcw size={13} aria-hidden="true" />}
                        {retrying ? 'Reconciling...' : 'Retry destination'}
                      </button>
                    )}
                    {actions.canChooseAnotherModel && (
                      <button
                        type="button"
                        onClick={() => chooseAnotherModel(target.targetId)}
                        disabled={retrying}
                        className="btn-secondary btn-sm w-full justify-center sm:w-auto"
                      >
                        <Database size={13} aria-hidden="true" /> Choose another model
                      </button>
                    )}
                    {actions.canOpenModelMigrator && (
                      <button
                        type="button"
                        onClick={() => openModelMigrator(target)}
                        disabled={retrying}
                        className="btn-secondary btn-sm w-full justify-center sm:w-auto"
                      >
                        <ExternalLink size={13} aria-hidden="true" /> Open Model Migrator
                      </button>
                    )}
                  </div>
                )}
              </article>
            );
          })}

          {job && isDashboardSafeCopyTerminal(job.status) && (
            <div className={`card p-5 ${strictlyVerifiedMove ? 'border-green-200 bg-green-50' : ''}`}>
              <div className="flex items-start gap-3">
                {strictlyVerifiedMove
                  ? <CheckCircle2 size={21} className="mt-0.5 text-green-700" aria-hidden="true" />
                  : <AlertTriangle size={21} className="mt-0.5 text-amber-700" aria-hidden="true" />}
                <div>
                  <h3 className="text-base font-semibold text-content-primary">
                    {strictlyVerifiedMove ? 'Move complete' : displayedJobStatus?.label || 'Needs attention'}
                  </h3>
                  <p className="mt-1 text-sm text-content-secondary">
                    {strictlyVerifiedMove
                      ? `Every destination passed content, query, and direct-access verification. ${DESTINATION_ACCESS_NOTICE}`
                      : 'Successful destinations are preserved. Only destinations shown above as needing attention should be retried or opened in Model Migrator.'}
                  </p>
                </div>
              </div>
              {canStartAnotherMove && (
                <button type="button" onClick={startAnotherMove} className="btn-primary mt-4 justify-center">
                  Start another move
                </button>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

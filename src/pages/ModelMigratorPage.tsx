import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  CheckCircle2,
  Database,
  FileText,
  GitBranch,
  Layers3,
  Loader2,
  PlayCircle,
  RefreshCw,
  Server,
  ShieldCheck,
  X,
  Workflow,
} from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { SavedInstanceRequiredEmptyState } from '@/components/layout/RequireConnection';
import { Blobby } from '@/components/ui/Blobby';
import { useConnection } from '@/contexts/ConnectionContext';
import { useLogOperation } from '@/contexts/OperationLogContext';
import {
  cancelOpsMigrationJob,
  createModelMigratorJob,
  getVaultStatus,
  getMigrationJob,
  listModelMigratorConnections,
  listModelMigratorModels,
  listSavedInstances,
  loadModelMigratorInventory,
  loadModelMigratorReadiness,
  mergeModelMigratorJob,
  preflightModelMigratorWorkbooks,
  retryOpsMigrationJob,
  subscribeMigrationJob,
  translateModelMigratorYaml,
  type InstanceModel,
  type ModelMigratorConnection,
  type ModelMigratorContentRepairAction,
  type ModelMigratorInventoryDocument,
  type ModelMigratorInventoryRow,
  type ModelMigratorJobContentInput,
  type ModelMigratorSemanticDecision,
  type ModelMigratorReadiness,
  type ModelMigratorReadinessPair,
  type ModelMigratorTranslatedFile,
  type ModelMigratorWorkbookPreflight,
  type MigrationJob,
  type MigrationJobItem,
  type PostMigrationAction,
  type SavedInstancePublic,
  type VaultStatus,
} from '@/services/opsConsole';
import {
  sanitizeModelMigratorDraftForStorage,
} from '@/services/modelMigratorDraft';
import {
  parseSchemaMappingRows,
  recommendModelMigrationStrategy,
  scoreTargetModelMatch,
  serializeSchemaMappingRows,
  type SchemaMappingRow,
} from '@/services/modelMigratorAdvisor';

const MODEL_MIGRATOR_DRAFT_KEY = 'omnikit:modelMigratorDraft:v1';
const WIZARD_STEPS = ['Source', 'Target match', 'Migration path', 'Resolve differences', 'Content impact', 'Publish', 'Results'];
const WORKBOOK_FIDELITY_DISCLOSURE = 'Workbook migration ports query presentations, tab names, descriptions, and visConfig where Omni APIs expose them. Schedules, alerts, permissions, sharing, favorites, workbook-level filters or parameters, and unexposed workbook artifacts are not moved automatically.';

type ModelPath = 'fast' | 'translate' | 'impact_report';

interface TranslationState {
  files: ModelMigratorTranslatedFile[];
  checksums: Record<string, string>;
  semanticDecisions: ModelMigratorSemanticDecision[];
  prompts: Array<{ fileName: string; prompt: string }>;
}

function errorText(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function roleLabel(role: SavedInstancePublic['role']) {
  if (role === 'both') return 'Source + destination';
  return role === 'source' ? 'Source' : 'Destination';
}

function hostLabel(baseUrl: string) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  }
}

function connectionLabel(connection: ModelMigratorConnection) {
  const database = connection.database ? ` · ${connection.database}` : '';
  return `${connection.name || connection.id}${database}`;
}

function modelLabel(model: InstanceModel) {
  const identifier = model.identifier && model.identifier !== model.name ? ` · ${model.identifier}` : '';
  return `${model.name || model.id}${identifier}`;
}

function shortDate(value?: string) {
  if (!value) return 'Unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return date.toLocaleDateString();
}

function selectedModelName(models: InstanceModel[], id: string) {
  return models.find((model) => model.id === id)?.name || id;
}

function modelSupportsFastPath(model: InstanceModel) {
  return model.gitConfigured === true;
}

function modelRequiresMergeHandoff(model?: InstanceModel) {
  return Boolean(model?.pullRequestRequired || model?.gitProtected);
}

function diffLineClass(original: string | undefined, translated: string | undefined) {
  if (original === translated) return 'text-content-secondary';
  if (original === undefined) return 'bg-green-50 text-green-800';
  if (translated === undefined) return 'bg-red-50 text-red-800';
  return 'bg-amber-50 text-amber-900';
}

function fileDraft(file: ModelMigratorTranslatedFile) {
  return file.aiDraft || file.translated || file.deterministic || file.original;
}

function reviewLines(value: string | undefined) {
  return (value || '').split('\n');
}

function statusCounts(job: MigrationJob) {
  return {
    succeeded: job.items.filter((item) => item.status === 'succeeded' || item.status === 'warning').length,
    failed: job.items.filter((item) => item.status === 'failed').length,
  };
}

function modelItemLogDescription(item: MigrationJobItem): string | null {
  if (!['succeeded', 'failed', 'warning'].includes(item.status)) return null;
  const subject = item.documentName || item.targetModelName || item.targetModelId || 'step';
  if (item.kind === 'model_validate') return `Model validation ${item.status}: ${subject}`;
  if (item.kind === 'content_validate') return `Content validation ${item.status}: ${subject}`;
  if (item.kind === 'model_impact_report') return `Impact report ${item.status}: ${subject}`;
  if (item.kind === 'content_repair') return `Content repair ${item.status}: ${subject}`;
  if (item.kind === 'model_pr') return `Model pull request ${item.status}: ${subject}`;
  if (item.kind === 'model_merge') return `Model branch merge ${item.status}: ${subject}`;
  if (item.kind === 'workbook_create') return `Workbook create ${item.status}: ${subject}`;
  if (item.kind === 'import') return `Dashboard import ${item.status}: ${subject}`;
  if (item.kind === 'post_action') return `Post-action ${item.status}: ${subject}`;
  return null;
}

function jobCanMerge(job: MigrationJob | null) {
  if (!job || job.workflow !== 'model') return false;
  if (job.items.some((item) => item.kind === 'model_merge' || item.kind === 'model_pr')) return false;
  const validations = job.items.filter((item) => item.kind === 'model_validate');
  return validations.length > 0
    && validations.every((item) => item.status === 'succeeded')
    && ['succeeded', 'partial'].includes(job.status);
}

function readinessTone(status?: 'ready' | 'warning' | 'blocked' | 'unknown') {
  if (status === 'ready') return 'border-green-200 bg-green-50 text-green-800';
  if (status === 'warning') return 'border-amber-200 bg-amber-50 text-amber-900';
  if (status === 'blocked') return 'border-red-200 bg-red-50 text-red-800';
  return 'border-border-subtle bg-surface-secondary text-content-secondary';
}

function readinessLabel(status?: 'ready' | 'warning' | 'blocked' | 'unknown') {
  if (status === 'ready') return 'Ready';
  if (status === 'warning') return 'Review';
  if (status === 'blocked') return 'Blocked';
  return 'Checking';
}

function confidenceTone(confidence: 'strong' | 'likely' | 'manual') {
  if (confidence === 'strong') return 'bg-green-50 text-green-700';
  if (confidence === 'likely') return 'bg-blue-50 text-blue-700';
  return 'bg-surface-secondary text-content-secondary';
}

function defaultBranchName(model: InstanceModel) {
  const base = (model.identifier || model.name || model.id)
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `omnikit-model-migration-${base || 'model'}`;
}

function contentKey(document: ModelMigratorInventoryDocument) {
  return `${document.kind}:${document.id}`;
}

function documentMatchesSearch(document: ModelMigratorInventoryDocument, search: string) {
  const value = search.trim().toLowerCase();
  if (!value) return true;
  return [document.name, document.id, document.folderPath, document.kind].filter(Boolean).join(' ').toLowerCase().includes(value);
}

function canUseAsSource(instance: SavedInstancePublic) {
  return instance.role === 'source' || instance.role === 'both';
}

function canUseAsTarget(instance: SavedInstancePublic) {
  return instance.role === 'destination' || instance.role === 'both';
}

function SelectField({
  label,
  value,
  onChange,
  disabled,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-content-secondary">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        className="input-field"
      >
        {children}
      </select>
    </label>
  );
}

function EmptyValue({ children }: { children: React.ReactNode }) {
  return <option value="">{children}</option>;
}

function StepPill({ index, label, active }: { index: number; label: string; active: boolean }) {
  return (
    <div className={`rounded-card border px-3 py-2 ${active ? 'border-omni-200 bg-omni-50 text-omni-800' : 'border-border-subtle bg-white text-content-secondary'}`}>
      <div className="flex items-center gap-2">
        <span className={`flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-bold ${active ? 'bg-omni-600 text-white' : 'bg-surface-secondary text-content-tertiary'}`}>
          {index}
        </span>
        <span className="text-xs font-semibold">{label}</span>
      </div>
    </div>
  );
}

function LoadingLine({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-card border border-border-subtle bg-surface-secondary px-3 py-2 text-xs text-content-secondary">
      <Loader2 size={13} className="animate-spin" />
      {label}
    </div>
  );
}

export function ModelMigratorPage() {
  const navigate = useNavigate();
  const { connection } = useConnection();
  const logOperation = useLogOperation();
  const activeVaultInstanceId = connection.connectionMode === 'vault' ? connection.instanceId || '' : '';
  const [vaultStatus, setVaultStatus] = useState<VaultStatus | null>(null);
  const [instances, setInstances] = useState<SavedInstancePublic[]>([]);
  const [sourceInstanceId, setSourceInstanceId] = useState('');
  const [targetInstanceId, setTargetInstanceId] = useState('');
  const [sourceConnections, setSourceConnections] = useState<ModelMigratorConnection[]>([]);
  const [targetConnections, setTargetConnections] = useState<ModelMigratorConnection[]>([]);
  const [sourceConnectionId, setSourceConnectionId] = useState('');
  const [targetConnectionId, setTargetConnectionId] = useState('');
  const [sourceModels, setSourceModels] = useState<InstanceModel[]>([]);
  const [targetModels, setTargetModels] = useState<InstanceModel[]>([]);
  const [selectedSourceModelIds, setSelectedSourceModelIds] = useState<string[]>([]);
  const [targetModelBySourceId, setTargetModelBySourceId] = useState<Record<string, string>>({});
  const [inventory, setInventory] = useState<ModelMigratorInventoryRow[]>([]);
  const [loadingVault, setLoadingVault] = useState(true);
  const [loadingInstances, setLoadingInstances] = useState(false);
  const [loadingSource, setLoadingSource] = useState(false);
  const [loadingTarget, setLoadingTarget] = useState(false);
  const [loadingInventory, setLoadingInventory] = useState(false);
  const [loadingReadiness, setLoadingReadiness] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [preflighting, setPreflighting] = useState(false);
  const [startingJob, setStartingJob] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [schemaMapText, setSchemaMapText] = useState('');
  const [contentSearch, setContentSearch] = useState('');
  const [selectedContentKeys, setSelectedContentKeys] = useState<string[]>([]);
  const [pathByModelId, setPathByModelId] = useState<Record<string, ModelPath>>({});
  const [branchNameByModelId, setBranchNameByModelId] = useState<Record<string, string>>({});
  const [gitRefByModelId, setGitRefByModelId] = useState<Record<string, string>>({});
  const [fastPathConfirmedByModelId, setFastPathConfirmedByModelId] = useState<Record<string, boolean>>({});
  const [translationsByModelId, setTranslationsByModelId] = useState<Record<string, TranslationState>>({});
  const [acceptedFilesByModelId, setAcceptedFilesByModelId] = useState<Record<string, Record<string, string>>>({});
  const [skippedFilesByModelId, setSkippedFilesByModelId] = useState<Record<string, string[]>>({});
  const [approvedRepairDecisionIds, setApprovedRepairDecisionIds] = useState<string[]>([]);
  const [workbookPreflights, setWorkbookPreflights] = useState<ModelMigratorWorkbookPreflight[]>([]);
  const [readiness, setReadiness] = useState<ModelMigratorReadiness | null>(null);
  const [replaceSameNamed, setReplaceSameNamed] = useState(true);
  const [runAiDialectPass, setRunAiDialectPass] = useState(false);
  const [publishDrafts, setPublishDrafts] = useState(false);
  const [deleteBranch, setDeleteBranch] = useState(true);
  const [refreshSchemaAfterMigration, setRefreshSchemaAfterMigration] = useState(false);
  const [selectedPostActionIndexes, setSelectedPostActionIndexes] = useState<number[]>([]);
  const [job, setJob] = useState<MigrationJob | null>(null);
  const loggedTerminalJobs = useRef(new Set<string>());
  const loggedItemEvents = useRef(new Set<string>());
  const jobActive = job?.status === 'pending' || job?.status === 'running';

  const sourceInstances = useMemo(() => instances.filter(canUseAsSource), [instances]);
  const targetInstances = useMemo(() => instances.filter(canUseAsTarget), [instances]);
  const selectedSourceModels = useMemo(
    () => sourceModels.filter((model) => selectedSourceModelIds.includes(model.id)),
    [sourceModels, selectedSourceModelIds],
  );
  const inventoryByModel = useMemo(
    () => new Map(inventory.map((row) => [row.modelId, row])),
    [inventory],
  );
  const totals = useMemo(() => inventory.reduce((sum, row) => ({
    dashboardCount: sum.dashboardCount + row.dashboardCount,
    workbookCount: sum.workbookCount + row.workbookCount,
    unknownCount: sum.unknownCount + row.unknownCount,
  }), { dashboardCount: 0, workbookCount: 0, unknownCount: 0 }), [inventory]);
  const allDocuments = useMemo(() => inventory.flatMap((row) => (
    row.documents.map((document) => ({ ...document, sourceModelId: row.modelId }))
  )), [inventory]);
  const visibleDocuments = useMemo(() => allDocuments.filter((document) => documentMatchesSearch(document, contentSearch)), [allDocuments, contentSearch]);
  const selectedDocuments = useMemo(() => allDocuments.filter((document) => selectedContentKeys.includes(contentKey(document))), [allDocuments, selectedContentKeys]);
  const selectedWorkbookDocs = selectedDocuments.filter((document) => document.kind === 'workbook');
  const selectedDashboardDocs = selectedDocuments.filter((document) => document.kind === 'dashboard');
  const translateReviewComplete = selectedSourceModels.every((model) => {
    if ((pathByModelId[model.id] || 'translate') === 'fast') return true;
    if ((pathByModelId[model.id] || 'translate') === 'impact_report') return true;
    const translation = translationsByModelId[model.id];
    if (!translation?.files.length) return false;
    const accepted = acceptedFilesByModelId[model.id] || {};
    const skipped = new Set(skippedFilesByModelId[model.id] || []);
    return Object.keys(accepted).length > 0
      && translation.files.every((file) => file.blocked === true || accepted[file.fileName] !== undefined || skipped.has(file.fileName));
  });
  const targetInstance = targetInstances.find((instance) => instance.id === targetInstanceId);
  const selectedSourceConnection = sourceConnections.find((row) => row.id === sourceConnectionId);
  const selectedTargetConnection = targetConnections.find((row) => row.id === targetConnectionId);
  const readinessPairBySourceId = useMemo(() => new Map((readiness?.pairs || []).map((pair) => [pair.sourceModelId, pair])), [readiness]);
  const targetMatchBySourceId = useMemo(() => {
    const out: Record<string, ReturnType<typeof scoreTargetModelMatch>> = {};
    for (const sourceModel of selectedSourceModels) {
      const targetModel = targetModels.find((model) => model.id === targetModelBySourceId[sourceModel.id]);
      if (!targetModel) continue;
      out[sourceModel.id] = scoreTargetModelMatch(
        sourceModel,
        targetModel,
        selectedSourceConnection,
        selectedTargetConnection,
        readinessPairBySourceId.get(sourceModel.id)?.schemaOverlap,
      );
    }
    return out;
  }, [readinessPairBySourceId, selectedSourceModels, selectedSourceConnection, selectedTargetConnection, targetModelBySourceId, targetModels]);
  const strategyBySourceId = useMemo(() => {
    const out: Record<string, ReturnType<typeof recommendModelMigrationStrategy>> = {};
    for (const sourceModel of selectedSourceModels) {
      const targetModel = targetModels.find((model) => model.id === targetModelBySourceId[sourceModel.id]);
      out[sourceModel.id] = recommendModelMigrationStrategy({
        sourceModel,
        targetModel,
        sourceConnection: selectedSourceConnection,
        targetConnection: selectedTargetConnection,
        readinessPair: readinessPairBySourceId.get(sourceModel.id),
        contentSelected: selectedDocuments.some((document) => document.sourceModelId === sourceModel.id),
      });
    }
    return out;
  }, [readinessPairBySourceId, selectedDocuments, selectedSourceConnection, selectedSourceModels, selectedTargetConnection, targetModelBySourceId, targetModels]);
  const schemaMappingRows = useMemo(() => parseSchemaMappingRows(schemaMapText), [schemaMapText]);
  const reviewSummary = useMemo(() => {
    const semanticDecisionCount = selectedSourceModels.reduce((sum, model) => (
      sum + (translationsByModelId[model.id]?.semanticDecisions.length || 0)
    ), 0);
    const approvedRepairCount = selectedSourceModels.reduce((sum, model) => (
      sum + contentRepairActionsForModel(model.id).length
    ), 0);
    const impactOnlyCount = selectedSourceModels.filter((model) => (pathByModelId[model.id] || 'translate') === 'impact_report').length;
    const prHandoffCount = selectedSourceModels.filter((model) => {
      const targetModel = targetModels.find((row) => row.id === targetModelBySourceId[model.id]);
      return modelRequiresMergeHandoff(targetModel);
    }).length;
    return {
      semanticDecisionCount,
      approvedRepairCount,
      impactOnlyCount,
      prHandoffCount,
    };
  // contentRepairActionsForModel intentionally derives from dependencies below.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approvedRepairDecisionIds, pathByModelId, selectedSourceModels, targetModelBySourceId, targetModels, translationsByModelId]);
  const selectedPostMigrationActions = useMemo(() => {
    const actions: PostMigrationAction[] = [];
    if (refreshSchemaAfterMigration) {
      for (const sourceModel of selectedSourceModels) {
        const targetModelId = targetModelBySourceId[sourceModel.id];
        if (!targetModelId || !targetInstance) continue;
        const targetModel = targetModels.find((model) => model.id === targetModelId);
        actions.push({
          kind: 'refresh-schema',
          name: `${targetInstance.label}: refresh schema model ${targetModel?.name || targetModelId}`,
          method: 'POST',
          url: '',
          headers: {},
          body: '',
          destinationInstanceId: targetInstance.id,
          targetModelId,
          targetModelName: targetModel?.name || targetModelId,
        });
      }
    }
    if (targetInstance) {
      for (const actionIndex of selectedPostActionIndexes) {
        const action = targetInstance.postMigrationActions[actionIndex];
        if (!action) continue;
        actions.push({ ...action, name: `${targetInstance.label}: ${action.name}` });
      }
    }
    return actions;
  }, [refreshSchemaAfterMigration, selectedPostActionIndexes, selectedSourceModels, targetInstance, targetModelBySourceId, targetModels]);
  const workbookBlockerCount = workbookPreflights.reduce((sum, row) => sum + row.blockerCount, 0);
  const canStartJob = selectedSourceModels.length > 0
    && selectedSourceModels.every((model) => targetModelBySourceId[model.id])
    && selectedSourceModels.every((model) => branchNameByModelId[model.id]?.trim())
    && selectedSourceModels.every((model) => pathByModelId[model.id] !== 'fast' || (modelSupportsFastPath(model) && fastPathConfirmedByModelId[model.id] === true))
    && translateReviewComplete
    && workbookBlockerCount === 0
    && !jobActive
    && !startingJob;
  async function refreshVault() {
    setLoadingVault(true);
    setError('');
    try {
      const status = await getVaultStatus();
      setVaultStatus(status);
      if (status.unlocked) await refreshInstances();
    } catch (err) {
      setError(errorText(err, 'Failed to read vault status.'));
    } finally {
      setLoadingVault(false);
    }
  }

  async function refreshInstances() {
    setLoadingInstances(true);
    try {
      const result = await listSavedInstances();
      setInstances(result.instances);
    } catch (err) {
      setError(errorText(err, 'Failed to load saved instances.'));
    } finally {
      setLoadingInstances(false);
    }
  }

  function clearModelScopedWorkflowState() {
    setSelectedSourceModelIds([]);
    setTargetModelBySourceId({});
    setInventory([]);
    setSelectedContentKeys([]);
    setPathByModelId({});
    setBranchNameByModelId({});
    setGitRefByModelId({});
    setFastPathConfirmedByModelId({});
    setTranslationsByModelId({});
    setAcceptedFilesByModelId({});
    setSkippedFilesByModelId({});
    setApprovedRepairDecisionIds([]);
    setWorkbookPreflights([]);
  }

  function clearTargetScopedWorkflowState() {
    setTargetModelBySourceId({});
    setWorkbookPreflights([]);
  }

  useEffect(() => {
    if (!activeVaultInstanceId) {
      setVaultStatus(null);
      setInstances([]);
      setLoadingVault(false);
      return;
    }
    void refreshVault();
    // Runs when the workflow opens or the active saved instance changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeVaultInstanceId]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.sessionStorage.getItem(MODEL_MIGRATOR_DRAFT_KEY);
      if (!raw) return;
      const parsed = sanitizeModelMigratorDraftForStorage(JSON.parse(raw));
      setSchemaMapText(parsed.schemaMapText || '');
      setSelectedContentKeys(Array.isArray(parsed.selectedContentKeys) ? parsed.selectedContentKeys : []);
      setPathByModelId(parsed.pathByModelId || {});
      setBranchNameByModelId(parsed.branchNameByModelId || {});
      setGitRefByModelId(parsed.gitRefByModelId || {});
      setFastPathConfirmedByModelId(parsed.fastPathConfirmedByModelId || {});
      setTranslationsByModelId(parsed.translationsByModelId || {});
      setAcceptedFilesByModelId(parsed.acceptedFilesByModelId || {});
      setSkippedFilesByModelId(parsed.skippedFilesByModelId || {});
      setApprovedRepairDecisionIds(Array.isArray(parsed.approvedRepairDecisionIds) ? parsed.approvedRepairDecisionIds : []);
      setReplaceSameNamed(parsed.replaceSameNamed !== false);
      setRunAiDialectPass(parsed.runAiDialectPass === true);
      setPublishDrafts(parsed.publishDrafts === true);
      setDeleteBranch(parsed.deleteBranch !== false);
      setRefreshSchemaAfterMigration(parsed.refreshSchemaAfterMigration === true);
      setSelectedPostActionIndexes(Array.isArray(parsed.selectedPostActionIndexes) ? parsed.selectedPostActionIndexes.filter((row): row is number => typeof row === 'number') : []);
    } catch {
      // Draft restore is convenience only.
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const draft = {
      schemaMapText,
      selectedContentKeys,
      pathByModelId,
      branchNameByModelId,
      gitRefByModelId,
      fastPathConfirmedByModelId,
      translationsByModelId,
      acceptedFilesByModelId,
      skippedFilesByModelId,
      approvedRepairDecisionIds,
      replaceSameNamed,
      runAiDialectPass,
      publishDrafts,
      deleteBranch,
      refreshSchemaAfterMigration,
      selectedPostActionIndexes,
    };
    try {
      window.sessionStorage.setItem(MODEL_MIGRATOR_DRAFT_KEY, JSON.stringify(sanitizeModelMigratorDraftForStorage(draft)));
    } catch {
      // Draft persistence is best-effort.
    }
  }, [schemaMapText, selectedContentKeys, pathByModelId, branchNameByModelId, gitRefByModelId, fastPathConfirmedByModelId, translationsByModelId, acceptedFilesByModelId, skippedFilesByModelId, approvedRepairDecisionIds, replaceSameNamed, runAiDialectPass, publishDrafts, deleteBranch, refreshSchemaAfterMigration, selectedPostActionIndexes]);

  useEffect(() => {
    if (!sourceInstanceId && sourceInstances.length > 0) setSourceInstanceId(sourceInstances[0].id);
    if (!targetInstanceId && targetInstances.length > 0) {
      const target = targetInstances.find((instance) => instance.id !== sourceInstanceId) || targetInstances[0];
      setTargetInstanceId(target.id);
    }
  }, [sourceInstances, targetInstances, sourceInstanceId, targetInstanceId]);

  useEffect(() => {
    let active = true;
    setSourceConnections([]);
    setSourceConnectionId('');
    setSourceModels([]);
    clearModelScopedWorkflowState();
    if (!sourceInstanceId) return () => { active = false; };
    setLoadingSource(true);
    listModelMigratorConnections(sourceInstanceId)
      .then((result) => {
        if (!active) return;
        setSourceConnections(result.connections);
        setSourceConnectionId(result.connections[0]?.id || '');
      })
      .catch((err) => {
        if (active) setError(errorText(err, 'Failed to load source connections.'));
      })
      .finally(() => {
        if (active) setLoadingSource(false);
      });
    return () => { active = false; };
  }, [sourceInstanceId]);

  useEffect(() => {
    let active = true;
    setTargetConnections([]);
    setTargetConnectionId('');
    setTargetModels([]);
    clearTargetScopedWorkflowState();
    if (!targetInstanceId) return () => { active = false; };
    setLoadingTarget(true);
    listModelMigratorConnections(targetInstanceId)
      .then((result) => {
        if (!active) return;
        setTargetConnections(result.connections);
        setTargetConnectionId(result.connections[0]?.id || '');
      })
      .catch((err) => {
        if (active) setError(errorText(err, 'Failed to load target connections.'));
      })
      .finally(() => {
        if (active) setLoadingTarget(false);
      });
    return () => { active = false; };
  }, [targetInstanceId]);

  useEffect(() => {
    let active = true;
    setSourceModels([]);
    clearModelScopedWorkflowState();
    if (!sourceInstanceId || !sourceConnectionId) return () => { active = false; };
    setLoadingSource(true);
    listModelMigratorModels(sourceInstanceId, { connectionId: sourceConnectionId })
      .then((result) => {
        if (!active) return;
        setSourceModels(result.models);
      })
      .catch((err) => {
        if (active) setError(errorText(err, 'Failed to load source models.'));
      })
      .finally(() => {
        if (active) setLoadingSource(false);
      });
    return () => { active = false; };
  }, [sourceInstanceId, sourceConnectionId]);

  useEffect(() => {
    let active = true;
    setTargetModels([]);
    clearTargetScopedWorkflowState();
    if (!targetInstanceId || !targetConnectionId) return () => { active = false; };
    setLoadingTarget(true);
    listModelMigratorModels(targetInstanceId, { connectionId: targetConnectionId })
      .then((result) => {
        if (active) setTargetModels(result.models);
      })
      .catch((err) => {
        if (active) setError(errorText(err, 'Failed to load target models.'));
      })
      .finally(() => {
        if (active) setLoadingTarget(false);
      });
    return () => { active = false; };
  }, [targetInstanceId, targetConnectionId]);

  useEffect(() => {
    setSelectedSourceModelIds((current) => current.filter((id) => sourceModels.some((model) => model.id === id)));
  }, [sourceModels]);

  useEffect(() => {
    setTargetModelBySourceId((current) => {
      const next: Record<string, string> = {};
      for (const sourceModel of selectedSourceModels) {
        const existing = current[sourceModel.id];
        if (existing && targetModels.some((model) => model.id === existing)) {
          next[sourceModel.id] = existing;
          continue;
        }
        const ranked = targetModels
          .map((model) => ({
            model,
            match: scoreTargetModelMatch(sourceModel, model, selectedSourceConnection, selectedTargetConnection),
          }))
          .sort((a, b) => b.match.score - a.match.score);
        next[sourceModel.id] = ranked[0]?.match.score >= 35 ? ranked[0].model.id : '';
      }
      return next;
    });
  }, [selectedSourceModels, selectedSourceConnection, selectedTargetConnection, targetModels]);

  useEffect(() => {
    setPathByModelId((current) => {
      const next: Record<string, ModelPath> = {};
      for (const model of selectedSourceModels) next[model.id] = current[model.id] || 'translate';
      return next;
    });
    setBranchNameByModelId((current) => {
      const next: Record<string, string> = {};
      for (const model of selectedSourceModels) next[model.id] = current[model.id] || defaultBranchName(model);
      return next;
    });
  }, [selectedSourceModels]);

  useEffect(() => {
    let active = true;
    if (!sourceInstanceId || selectedSourceModelIds.length === 0) {
      setInventory([]);
      return () => { active = false; };
    }
    setLoadingInventory(true);
    loadModelMigratorInventory(sourceInstanceId, selectedSourceModelIds)
      .then((result) => {
        if (active) setInventory(result.models);
      })
      .catch((err) => {
        if (active) setError(errorText(err, 'Failed to load source content inventory.'));
      })
      .finally(() => {
        if (active) setLoadingInventory(false);
      });
    return () => { active = false; };
  }, [sourceInstanceId, selectedSourceModelIds]);

  useEffect(() => {
    let active = true;
    if (!sourceInstanceId) {
      setReadiness(null);
      return () => { active = false; };
    }
    setLoadingReadiness(true);
    loadModelMigratorReadiness({
      sourceInstanceId,
      targetInstanceId,
      sourceModelIds: selectedSourceModelIds,
      targetModelBySourceId,
    })
      .then((result) => {
        if (active) setReadiness(result.readiness);
      })
      .catch((err) => {
        if (active) setError(errorText(err, 'Failed to load model migration readiness.'));
      })
      .finally(() => {
        if (active) setLoadingReadiness(false);
      });
    return () => { active = false; };
  }, [sourceInstanceId, targetInstanceId, selectedSourceModelIds, targetModelBySourceId]);

  useEffect(() => {
    setPathByModelId((current) => {
      const next = { ...current };
      let changed = false;
      for (const model of selectedSourceModels) {
        const recommendation = strategyBySourceId[model.id]?.modelPath;
        if (recommendation && !next[model.id]) {
          next[model.id] = recommendation;
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [selectedSourceModels, strategyBySourceId]);

  function toggleSourceModel(modelId: string) {
    if (jobActive) return;
    setSelectedSourceModelIds((current) => (
      current.includes(modelId) ? current.filter((id) => id !== modelId) : [...current, modelId]
    ));
  }

  function selectAllSourceModels() {
    if (jobActive) return;
    setSelectedSourceModelIds(sourceModels.map((model) => model.id));
  }

  function clearSourceModels() {
    if (jobActive) return;
    setSelectedSourceModelIds([]);
  }

  function toggleContent(document: ModelMigratorInventoryDocument) {
    if (jobActive) return;
    const key = contentKey(document);
    setSelectedContentKeys((current) => (
      current.includes(key) ? current.filter((item) => item !== key) : [...current, key]
    ));
  }

  function selectVisibleContent(kind?: 'dashboard' | 'workbook') {
    if (jobActive) return;
    const keys = visibleDocuments
      .filter((document) => !kind || document.kind === kind)
      .map(contentKey);
    setSelectedContentKeys((current) => [...new Set([...current, ...keys])]);
  }

  function clearContentSelection() {
    if (jobActive) return;
    setSelectedContentKeys([]);
  }

  function updateSchemaMappingRows(rows: SchemaMappingRow[]) {
    setSchemaMapText(serializeSchemaMappingRows(rows));
  }

  function updateSchemaMappingRow(rowId: string, patch: Partial<Pick<SchemaMappingRow, 'source' | 'target'>>) {
    const rows = schemaMappingRows.length > 0 ? schemaMappingRows : [{ id: 'schema-map-0', source: '', target: '' }];
    updateSchemaMappingRows(rows.map((row) => row.id === rowId ? { ...row, ...patch } : row));
  }

  function addSchemaMappingRow() {
    updateSchemaMappingRows([...schemaMappingRows, { id: `schema-map-${Date.now()}`, source: 'SOURCE_SCHEMA', target: 'TARGET_SCHEMA' }]);
  }

  function removeSchemaMappingRow(rowId: string) {
    updateSchemaMappingRows(schemaMappingRows.filter((row) => row.id !== rowId));
  }

  function updateSemanticDecision(modelId: string, decisionId: string, patch: Partial<ModelMigratorSemanticDecision>) {
    setTranslationsByModelId((current) => {
      const existing = current[modelId];
      if (!existing) return current;
      return {
        ...current,
        [modelId]: {
          ...existing,
          semanticDecisions: existing.semanticDecisions.map((decision) => (
            decision.id === decisionId ? { ...decision, ...patch } : decision
          )),
        },
      };
    });
  }

  async function translateSelectedModels() {
    if (jobActive) return;
    setTranslating(true);
    setError('');
    setMessage('');
    try {
      const nextTranslations: Record<string, TranslationState> = { ...translationsByModelId };
      const nextAccepted: Record<string, Record<string, string>> = { ...acceptedFilesByModelId };
      const nextSkipped: Record<string, string[]> = { ...skippedFilesByModelId };
      const sourceDialect = sourceConnections.find((connection) => connection.id === sourceConnectionId)?.dialect || '';
      const targetDialect = targetConnections.find((connection) => connection.id === targetConnectionId)?.dialect || '';
      for (const model of selectedSourceModels.filter((row) => {
        const mode = pathByModelId[row.id] || 'translate';
        return mode !== 'fast' && mode !== 'impact_report';
      })) {
        const result = await translateModelMigratorYaml({
          sourceInstanceId,
          targetInstanceId,
          modelId: model.id,
          targetModelId: targetModelBySourceId[model.id],
          schemaMapText,
          sourceDialect,
          targetDialect,
          runAi: runAiDialectPass,
        });
        nextTranslations[model.id] = result;
        nextAccepted[model.id] = {};
        nextSkipped[model.id] = [];
      }
      setTranslationsByModelId(nextTranslations);
      setAcceptedFilesByModelId(nextAccepted);
      setSkippedFilesByModelId(nextSkipped);
      setMessage('Model YAML translated. Accept, edit, or skip each file before running.');
    } catch (err) {
      setError(errorText(err, 'Failed to translate selected models.'));
    } finally {
      setTranslating(false);
    }
  }

  async function preflightWorkbooks() {
    if (jobActive) return;
    setPreflighting(true);
    setError('');
    try {
      const rows: ModelMigratorWorkbookPreflight[] = [];
      for (const model of selectedSourceModels) {
        const targetModelId = targetModelBySourceId[model.id];
        const docs = selectedWorkbookDocs.filter((document) => document.sourceModelId === model.id);
        if (!targetModelId || docs.length === 0) continue;
        const result = await preflightModelMigratorWorkbooks({
          sourceInstanceId,
          targetInstanceId,
          sourceModelId: model.id,
          targetModelId,
          documentIds: docs.map((document) => document.id),
        });
        rows.push(...result.workbooks);
      }
      setWorkbookPreflights(rows);
      const blockers = rows.reduce((sum, row) => sum + row.blockerCount, 0);
      setMessage(blockers > 0 ? `${blockers} workbook blocker${blockers === 1 ? '' : 's'} found.` : 'Workbook preflight passed.');
    } catch (err) {
      setError(errorText(err, 'Failed to preflight workbook queries.'));
    } finally {
      setPreflighting(false);
    }
  }

  function acceptedFilesForModel(modelId: string) {
    const accepted = acceptedFilesByModelId[modelId] || {};
    const checksums = translationsByModelId[modelId]?.checksums || {};
    return Object.entries(accepted).map(([fileName, yaml]) => ({
      fileName,
      yaml,
      previousChecksum: checksums[fileName],
    }));
  }

  function contentRepairActionsForModel(modelId: string): ModelMigratorContentRepairAction[] {
    return (translationsByModelId[modelId]?.semanticDecisions || [])
      .filter((decision) => (
        approvedRepairDecisionIds.includes(decision.id)
        && decision.action === 'map_existing'
        && Boolean(decision.targetName)
        && (decision.kind === 'field' || decision.kind === 'view' || decision.kind === 'topic')
      ))
      .map((decision) => ({
        id: decision.id,
        kind: decision.kind as 'field' | 'view' | 'topic',
        find: decision.sourceName,
        replacement: decision.targetName || '',
        approved: true,
        includePersonalFolders: false,
      }));
  }

  function contentInputs(): ModelMigratorJobContentInput[] {
    return selectedDocuments
      .filter((document) => document.kind === 'dashboard' || document.kind === 'workbook')
      .map((document) => {
        const targetModelId = targetModelBySourceId[document.sourceModelId] || '';
        const targetModel = targetModels.find((model) => model.id === targetModelId);
        const kind: 'dashboard' | 'workbook' = document.kind === 'dashboard' ? 'dashboard' : 'workbook';
        return {
          documentId: document.id,
          documentName: document.name,
          kind,
          sourceModelId: document.sourceModelId,
          targetModelId,
          targetModelName: targetModel?.name,
          targetFolderPath: document.folderPath,
        };
      })
      .filter((row) => row.targetModelId);
  }

  async function startModelMigrationJob() {
    if (!canStartJob) return;
    setStartingJob(true);
    setError('');
    try {
      const result = await createModelMigratorJob({
        sourceId: sourceInstanceId,
        targetId: targetInstanceId,
        targetLabel: targetInstances.find((instance) => instance.id === targetInstanceId)?.label,
        replaceSameNamed,
        mergeAfterValidation: false,
        publishDrafts,
        deleteBranch,
        models: selectedSourceModels.map((model) => {
          const targetModelId = targetModelBySourceId[model.id];
          const targetModel = targetModels.find((row) => row.id === targetModelId);
          const mode = pathByModelId[model.id] || 'translate';
          return {
            sourceModelId: model.id,
            sourceModelName: model.name,
            targetModelId,
            targetModelName: targetModel?.name,
            targetConnectionId,
            mode,
            branchName: branchNameByModelId[model.id],
            gitRef: gitRefByModelId[model.id]?.trim() || undefined,
            fastPathSchemaConfirmed: mode === 'fast' ? fastPathConfirmedByModelId[model.id] === true : undefined,
            orgApiKeyConfirmed: mode === 'fast' ? fastPathConfirmedByModelId[model.id] === true : undefined,
            mergeHandoffRequired: modelRequiresMergeHandoff(targetModel),
            acceptedFiles: mode === 'translate' ? acceptedFilesForModel(model.id) : undefined,
            semanticDecisions: translationsByModelId[model.id]?.semanticDecisions || [],
            contentRepairActions: contentRepairActionsForModel(model.id),
          };
        }),
        content: contentInputs(),
        postMigrationActions: selectedSourceModels.every((model) => (pathByModelId[model.id] || 'translate') === 'impact_report') ? [] : selectedPostMigrationActions,
      });
      setJob(result.job);
      setMessage('Model migration job started.');
      logOperation('model_migration', 'Model Migrator job started', {
        itemCount: result.job.items.length,
        successCount: 0,
        failureCount: 0,
      });
    } catch (err) {
      setError(errorText(err, 'Failed to start model migration job.'));
    } finally {
      setStartingJob(false);
    }
  }

  async function cancelJob() {
    if (!job) return;
    const result = await cancelOpsMigrationJob(job.id);
    setJob(result.job);
    logOperation('model_migration', 'Model Migrator job canceled', {
      itemCount: result.job.items.length,
      successCount: result.job.items.filter((item) => item.status === 'succeeded' || item.status === 'warning').length,
      failureCount: result.job.items.filter((item) => item.status === 'failed').length,
    });
  }

  async function retryJob() {
    if (!job) return;
    const result = await retryOpsMigrationJob(job.id);
    setJob(result.job);
    logOperation('model_migration', 'Model Migrator retry started', {
      itemCount: result.job.items.length,
      successCount: 0,
      failureCount: 0,
    });
  }

  async function mergeValidatedJob() {
    if (!job || !jobCanMerge(job)) return;
    setStartingJob(true);
    setError('');
    try {
      const result = await mergeModelMigratorJob(job.id, { publishDrafts, deleteBranch });
      setJob(result.job);
      logOperation('model_migration', 'Model Migrator merge requested', {
        itemCount: result.job.items.filter((item) => item.kind === 'model_merge').length,
        successCount: result.job.items.filter((item) => item.kind === 'model_merge' && (item.status === 'succeeded' || item.status === 'warning')).length,
        failureCount: result.job.items.filter((item) => item.kind === 'model_merge' && item.status === 'failed').length,
      });
    } catch (err) {
      setError(errorText(err, 'Failed to merge validated branches.'));
    } finally {
      setStartingJob(false);
    }
  }

  const activeJobId = job?.id;

  useEffect(() => {
    if (!activeJobId) return undefined;
    const unsubscribe = subscribeMigrationJob(
      activeJobId,
      (event) => {
        if (event.type === 'snapshot' || event.type === 'job') {
          if (event.job) {
            setJob(event.job);
            if (['succeeded', 'partial', 'failed', 'canceled'].includes(event.job.status) && !loggedTerminalJobs.current.has(event.job.id)) {
              loggedTerminalJobs.current.add(event.job.id);
              const counts = statusCounts(event.job);
              logOperation('model_migration', `Model Migrator job ${event.job.status}`, {
                itemCount: event.job.items.length,
                successCount: counts.succeeded,
                failureCount: counts.failed,
                durationMs: event.job.startedAt ? Date.now() - event.job.startedAt : 0,
              });
            }
          }
          return;
        }
        if (event.type === 'item') {
          if (event.item) {
            const description = modelItemLogDescription(event.item);
            const key = `${event.item.id}:${event.item.status}`;
            if (description && !loggedItemEvents.current.has(key)) {
              loggedItemEvents.current.add(key);
              logOperation('model_migration', description, {
                itemCount: 1,
                successCount: event.item.status === 'succeeded' || event.item.status === 'warning' ? 1 : 0,
                failureCount: event.item.status === 'failed' ? 1 : 0,
                durationMs: event.item.startedAt ? (event.item.endedAt || Date.now()) - event.item.startedAt : 0,
              });
            }
          }
          void getMigrationJob(activeJobId).then((result) => setJob(result.job)).catch(() => undefined);
        }
      },
      () => undefined,
    );
    return unsubscribe;
  }, [activeJobId, logOperation]);

  if (!activeVaultInstanceId) {
    return (
      <SavedInstanceRequiredEmptyState
        toolName="Model Migrator"
        description="Model Migrator runs through saved Omni instances only. Unlock Home, then choose and test the saved Omni instance this workflow should use."
      />
    );
  }

  if (loadingVault) {
    return (
      <div className="card flex items-center justify-center gap-2 p-8 text-content-secondary">
        <Loader2 size={16} className="animate-spin" />
        Loading vault status
      </div>
    );
  }

  const unlocked = Boolean(vaultStatus?.unlocked);

  if (!unlocked) {
    return (
      <>
        {error && <div role="alert" className="rounded-card border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
        <SavedInstanceRequiredEmptyState toolName="Model Migrator" />
      </>
    );
  }

  return (
    <div className="space-y-5 pb-12">
      <PageHeader
        title="Model Migrator"
        description="Safely move semantic models between saved Omni instances: match a target, resolve differences, check content impact, then publish or hand off review."
        icon={<Blobby mood="migration" size={58} className="animate-float" style={{ animationDuration: '3.4s' }} />}
        actions={(
          <button type="button" onClick={refreshVault} className="btn-secondary inline-flex items-center gap-2 text-sm">
            <RefreshCw size={14} />
            Refresh
          </button>
        )}
      />

      {error && <div role="alert" className="rounded-card border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      {message && <div aria-live="polite" className="rounded-card border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">{message}</div>}

      <div className="grid gap-3 lg:grid-cols-7">
        {WIZARD_STEPS.map((step, index) => (
          <StepPill key={step} index={index + 1} label={step} active={index < 2 || selectedSourceModels.length > 0} />
        ))}
      </div>

      <section className={`rounded-card border p-4 ${readinessTone(readiness?.summary.status)}`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold">
              {loadingReadiness ? <Loader2 size={15} className="animate-spin" /> : <ShieldCheck size={15} />}
              Migration readiness
            </div>
            <p className="mt-1 text-xs">
              {readiness?.summary.label || 'OmniKit is checking source and target capabilities before any migration action runs.'}
            </p>
          </div>
          <span className="rounded-chip bg-white/70 px-3 py-1 text-xs font-semibold">
            {readinessLabel(readiness?.summary.status)}
            {readiness ? ` · ${readiness.summary.blockers} blockers · ${readiness.summary.warnings} review items` : ''}
          </span>
        </div>
        {readiness && (
          <div className="mt-3 grid gap-3 lg:grid-cols-3">
            {[readiness.source, readiness.target].filter(Boolean).map((row) => (
              <div key={row!.instanceId} className="rounded-card border border-white/60 bg-white/70 p-3 text-xs">
                <div className="font-semibold text-content-primary">{row!.label}</div>
                <div className="mt-1 text-content-secondary">{row!.baseUrlHost} · {row!.connections} connections · {row!.sharedModels} shared models</div>
                <div className="mt-2 space-y-1">
                  {row!.checks.slice(0, 3).map((item) => (
                    <div key={item.id} className="flex items-start gap-2">
                      <span className={`mt-1 h-1.5 w-1.5 rounded-full ${item.status === 'blocked' ? 'bg-red-500' : item.status === 'warning' ? 'bg-amber-500' : 'bg-green-500'}`} />
                      <span>{item.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            <div className="rounded-card border border-white/60 bg-white/70 p-3 text-xs">
              <div className="font-semibold text-content-primary">Selected migration paths</div>
              <div className="mt-1 text-content-secondary">
                {readiness.pairs.length === 0 ? 'Select source and target models to get a path recommendation.' : `${readiness.pairs.length} model pair${readiness.pairs.length === 1 ? '' : 's'} checked.`}
              </div>
              <div className="mt-2 space-y-1">
                {readiness.pairs.slice(0, 4).map((pair) => (
                  <div key={pair.sourceModelId} className="flex items-center justify-between gap-2">
                    <span className="truncate">{selectedModelName(sourceModels, pair.sourceModelId)}</span>
                    <span className="rounded-chip bg-white px-2 py-0.5 font-semibold">{pair.releaseMode === 'pr' ? 'PR review' : pair.recommendedPath === 'fast' ? 'Auto copy' : pair.recommendedPath === 'translate' ? 'Review changes' : 'Impact only'}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </section>

      {loadingInstances ? (
        <LoadingLine label="Loading saved instances" />
      ) : instances.length === 0 ? (
        <div className="card p-5">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-card bg-surface-secondary text-content-secondary">
              <Server size={18} />
            </span>
            <div className="flex-1">
              <h2 className="text-base font-semibold text-content-primary">No saved Omni instances yet</h2>
              <p className="mt-1 text-sm text-content-secondary">
                Add at least one source and one destination profile in Instance Manager before starting model migration.
              </p>
            </div>
            <button type="button" onClick={() => navigate('/instances')} className="btn-primary inline-flex items-center gap-2 text-sm">
              Instance Manager
              <ArrowRight size={14} />
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="grid gap-5 xl:grid-cols-2">
            <section className="card p-5">
              <div className="mb-4 flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 text-sm font-semibold text-content-primary">
                    <Database size={16} />
                    Source
                  </div>
                  <p className="mt-1 text-xs text-content-secondary">Choose the saved instance, connection, and source models you want to move.</p>
                </div>
                {loadingSource && <Loader2 size={16} className="animate-spin text-content-secondary" />}
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <SelectField label="Source instance" value={sourceInstanceId} onChange={setSourceInstanceId} disabled={jobActive}>
                  <EmptyValue>Choose source instance</EmptyValue>
                  {sourceInstances.map((instance) => (
                    <option key={instance.id} value={instance.id}>{instance.label} · {roleLabel(instance.role)} · {hostLabel(instance.baseUrl)}</option>
                  ))}
                </SelectField>
                <SelectField label="Source connection" value={sourceConnectionId} onChange={setSourceConnectionId} disabled={jobActive || !sourceInstanceId || sourceConnections.length === 0}>
                  <EmptyValue>{sourceConnections.length === 0 ? 'No connections loaded' : 'Choose connection'}</EmptyValue>
                  {sourceConnections.map((connection) => (
                    <option key={connection.id} value={connection.id}>{connectionLabel(connection)}</option>
                  ))}
                </SelectField>
              </div>

              <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs text-content-secondary">
                  {sourceModels.length} models loaded · {selectedSourceModelIds.length} selected
                </div>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={selectAllSourceModels} disabled={jobActive || sourceModels.length === 0} className="btn-secondary text-xs disabled:opacity-50">Select all</button>
                  <button type="button" onClick={clearSourceModels} disabled={jobActive || selectedSourceModelIds.length === 0} className="btn-secondary text-xs disabled:opacity-50">Clear</button>
                </div>
              </div>

              <div className="mt-3 max-h-[360px] overflow-auto rounded-card border border-border-subtle">
                {sourceModels.length === 0 ? (
                  <div className="p-5 text-sm text-content-secondary">No source models are available for the selected connection.</div>
                ) : sourceModels.map((model) => {
                  const selected = selectedSourceModelIds.includes(model.id);
                  const row = inventoryByModel.get(model.id);
                  return (
                    <button
                      type="button"
                      key={model.id}
                      onClick={() => toggleSourceModel(model.id)}
                      disabled={jobActive}
                      aria-pressed={selected}
                      className={`block w-full border-l-4 px-4 py-3 text-left transition ${selected ? 'border-l-omni-500 bg-omni-50' : 'border-l-transparent hover:bg-surface-secondary'}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-content-primary">{model.name || model.id}</div>
                          <div className="mt-0.5 truncate font-mono text-[11px] text-content-tertiary">{model.id}</div>
                          <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-content-secondary">
                            <span>{model.kind || 'SHARED'}</span>
                            <span>Updated {shortDate(model.updatedAt)}</span>
                            <span>{model.gitConfigured ? 'Git-backed fast path eligible' : 'Git status unknown'}</span>
                          </div>
                        </div>
                        <span className={`mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border ${selected ? 'border-omni-600 bg-omni-600 text-white' : 'border-border-strong bg-white text-transparent'}`}>
                          <CheckCircle2 size={13} />
                        </span>
                      </div>
                      {selected && row && (
                        <div className="mt-2 grid grid-cols-3 gap-2 text-center text-[11px]">
                          <div className="rounded-card bg-white px-2 py-1 text-content-secondary"><span className="font-semibold text-content-primary">{row.dashboardCount}</span><br />Dashboards</div>
                          <div className="rounded-card bg-white px-2 py-1 text-content-secondary"><span className="font-semibold text-content-primary">{row.workbookCount}</span><br />Workbooks</div>
                          <div className="rounded-card bg-white px-2 py-1 text-content-secondary"><span className="font-semibold text-content-primary">{row.unknownCount}</span><br />Unknown</div>
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="card p-5">
              <div className="mb-4 flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 text-sm font-semibold text-content-primary">
                    <GitBranch size={16} />
                    Target match
                  </div>
                  <p className="mt-1 text-xs text-content-secondary">Match each source model to the destination model OmniKit should prepare.</p>
                </div>
                {loadingTarget && <Loader2 size={16} className="animate-spin text-content-secondary" />}
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <SelectField label="Target instance" value={targetInstanceId} onChange={setTargetInstanceId} disabled={jobActive}>
                  <EmptyValue>Choose target instance</EmptyValue>
                  {targetInstances.map((instance) => (
                    <option key={instance.id} value={instance.id}>{instance.label} · {roleLabel(instance.role)} · {hostLabel(instance.baseUrl)}</option>
                  ))}
                </SelectField>
                <SelectField label="Target connection" value={targetConnectionId} onChange={setTargetConnectionId} disabled={jobActive || !targetInstanceId || targetConnections.length === 0}>
                  <EmptyValue>{targetConnections.length === 0 ? 'No connections loaded' : 'Choose connection'}</EmptyValue>
                  {targetConnections.map((connection) => (
                    <option key={connection.id} value={connection.id}>{connectionLabel(connection)}</option>
                  ))}
                </SelectField>
              </div>

              <div className="mt-3 space-y-3">
                {selectedSourceModels.length === 0 ? (
                  <div className="rounded-card border border-dashed border-border-subtle p-5 text-sm text-content-secondary">
                    Select one or more source models to map target models.
                  </div>
                ) : selectedSourceModels.map((sourceModel) => {
                  const match = targetMatchBySourceId[sourceModel.id];
                  const strategy = strategyBySourceId[sourceModel.id];
                  const readinessPair: ModelMigratorReadinessPair | undefined = readinessPairBySourceId.get(sourceModel.id);
                  return (
                  <div key={sourceModel.id} className="rounded-card border border-border-subtle p-3">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-content-primary">{sourceModel.name || sourceModel.id}</div>
                        <div className="truncate text-[11px] text-content-tertiary">{sourceModel.identifier || sourceModel.connectionName || sourceModel.id}</div>
                      </div>
                      <ArrowRight size={14} className="flex-shrink-0 text-content-tertiary" />
                    </div>
                    <select
                      value={targetModelBySourceId[sourceModel.id] || ''}
                      onChange={(event) => setTargetModelBySourceId((current) => ({ ...current, [sourceModel.id]: event.target.value }))}
                      disabled={jobActive || targetModels.length === 0}
                      className="input-field"
                    >
                      <option value="">{targetModels.length === 0 ? 'No target models loaded' : 'Choose target model'}</option>
                      {targetModels.map((model) => (
                        <option key={model.id} value={model.id}>{modelLabel(model)}</option>
                      ))}
                    </select>
                    {match && strategy && (
                      <div className="mt-3 grid gap-2 lg:grid-cols-[1fr_1.3fr]">
                        <div className={`rounded-card px-3 py-2 text-xs ${confidenceTone(match.confidence)}`}>
                          <div className="font-semibold">{match.confidence === 'strong' ? 'Strong target match' : match.confidence === 'likely' ? 'Likely target match' : 'Manual match'}</div>
                          <div className="mt-1">{match.score}/100 · {match.reasons.slice(0, 2).join(', ') || 'Selected manually'}</div>
                          {readinessPair?.schemaOverlap && (
                            <div className="mt-1">
                              {readinessPair.schemaOverlap.overlappingSchemas.length} schema overlap
                              {readinessPair.schemaOverlap.overlappingSchemas.length > 0 ? ` · ${readinessPair.schemaOverlap.overlappingSchemas.slice(0, 3).join(', ')}` : ''}
                            </div>
                          )}
                        </div>
                        <div className={`rounded-card border px-3 py-2 text-xs ${readinessTone(readinessPair?.status)}`}>
                          <div className="font-semibold">{strategy.label}</div>
                          <div className="mt-1">{strategy.description}</div>
                        </div>
                      </div>
                    )}
	                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      <label className="block">
                        <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-content-secondary">Migration path</span>
                        <select
                          value={pathByModelId[sourceModel.id] || 'translate'}
                          onChange={(event) => setPathByModelId((current) => ({ ...current, [sourceModel.id]: event.target.value as ModelPath }))}
                          className="input-field"
                          disabled={jobActive}
                        >
                          <option value="translate">Review and adapt model changes</option>
                          <option value="fast" disabled={!modelSupportsFastPath(sourceModel)}>Copy model automatically {modelSupportsFastPath(sourceModel) ? '' : '(git-backed source required)'}</option>
                          <option value="impact_report">Impact report only - no changes</option>
                        </select>
                      </label>
	                      <label className="block">
	                        <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-content-secondary">Safe working copy</span>
	                        <input
                          value={branchNameByModelId[sourceModel.id] || ''}
                          onChange={(event) => setBranchNameByModelId((current) => ({ ...current, [sourceModel.id]: event.target.value }))}
                          className="input-field"
                          disabled={jobActive}
                          placeholder={defaultBranchName(sourceModel)}
	                        />
	                      </label>
	                    </div>
	                    {(pathByModelId[sourceModel.id] || 'translate') === 'fast' && (
	                      <div className="mt-3 space-y-2 rounded-card border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
	                        <label className="flex items-start gap-2">
	                          <input
	                            type="checkbox"
	                            className="mt-0.5"
	                            checked={fastPathConfirmedByModelId[sourceModel.id] === true}
	                            onChange={(event) => setFastPathConfirmedByModelId((current) => ({ ...current, [sourceModel.id]: event.target.checked }))}
                              disabled={jobActive}
	                          />
	                        <span>I confirm the source and target data locations are compatible and the saved credential is an Omni Organization API key. OmniKit will still validate before publish.</span>
	                        </label>
	                        <label className="block">
	                          <span className="mb-1 block font-semibold uppercase tracking-wide">Git ref</span>
	                          <input
	                            value={gitRefByModelId[sourceModel.id] || ''}
	                            onChange={(event) => setGitRefByModelId((current) => ({ ...current, [sourceModel.id]: event.target.value }))}
	                            className="input-field bg-white"
                              disabled={jobActive}
	                            placeholder="Optional source git ref"
	                          />
	                        </label>
	                      </div>
	                    )}
	                    {modelRequiresMergeHandoff(targetModels.find((model) => model.id === targetModelBySourceId[sourceModel.id])) && (
	                      <div className="mt-3 rounded-card border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
	                        Target model appears protected. OmniKit will stage and validate changes, then prepare a review handoff instead of forcing a direct publish.
	                      </div>
	                    )}
	                  </div>
                  );
                })}
              </div>
            </section>
          </div>

          <section className="card p-5">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 text-sm font-semibold text-content-primary">
                  <FileText size={16} />
                  Content impact
                </div>
                <p className="mt-1 text-xs text-content-secondary">Select affected dashboards and workbooks that should move with the model migration.</p>
              </div>
              {loadingInventory ? (
                <span className="inline-flex items-center gap-2 text-xs text-content-secondary"><Loader2 size={13} className="animate-spin" />Loading inventory</span>
              ) : (
                <div className="grid grid-cols-3 gap-2 text-center text-xs">
                  <div className="rounded-card bg-surface-secondary px-3 py-2"><div className="font-semibold text-content-primary">{totals.dashboardCount}</div><div className="text-content-secondary">Dashboards</div></div>
                  <div className="rounded-card bg-surface-secondary px-3 py-2"><div className="font-semibold text-content-primary">{totals.workbookCount}</div><div className="text-content-secondary">Workbooks</div></div>
                  <div className="rounded-card bg-surface-secondary px-3 py-2"><div className="font-semibold text-content-primary">{totals.unknownCount}</div><div className="text-content-secondary">Unknown</div></div>
                </div>
              )}
            </div>
            <div className="mb-4 grid gap-3 lg:grid-cols-[1fr_auto]">
              <input
                value={contentSearch}
                onChange={(event) => setContentSearch(event.target.value)}
                className="input-field"
                placeholder="Search content by name, folder, or kind"
              />
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={() => selectVisibleContent()} disabled={jobActive} className="btn-secondary text-xs disabled:opacity-50">Select visible</button>
                <button type="button" onClick={() => selectVisibleContent('workbook')} disabled={jobActive} className="btn-secondary text-xs disabled:opacity-50">Workbooks</button>
                <button type="button" onClick={() => selectVisibleContent('dashboard')} disabled={jobActive} className="btn-secondary text-xs disabled:opacity-50">Dashboards</button>
                <button type="button" onClick={clearContentSelection} disabled={jobActive} className="btn-secondary text-xs disabled:opacity-50">Clear</button>
              </div>
            </div>
            <div className="mb-4 rounded-card border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
              {WORKBOOK_FIDELITY_DISCLOSURE}
            </div>

            {selectedSourceModelIds.length === 0 ? (
              <div className="rounded-card border border-dashed border-border-subtle p-5 text-sm text-content-secondary">
                Model selection will populate content inventory.
              </div>
            ) : (
              <div className="grid gap-3 lg:grid-cols-2">
                {selectedSourceModelIds.map((modelId) => {
                  const row = inventoryByModel.get(modelId);
                  const documents = row?.documents || [];
                  return (
                    <div key={modelId} className="rounded-card border border-border-subtle p-4">
                      <div className="mb-3">
                        <div className="text-sm font-semibold text-content-primary">{selectedModelName(sourceModels, modelId)}</div>
                        <div className="font-mono text-[11px] text-content-tertiary">{modelId}</div>
                      </div>
                      <div className="mb-3 grid grid-cols-3 gap-2 text-center text-[11px]">
                        <div className="rounded-card bg-surface-secondary px-2 py-1 text-content-secondary"><span className="font-semibold text-content-primary">{row?.dashboardCount || 0}</span><br />Dashboards</div>
                        <div className="rounded-card bg-surface-secondary px-2 py-1 text-content-secondary"><span className="font-semibold text-content-primary">{row?.workbookCount || 0}</span><br />Workbooks</div>
                        <div className="rounded-card bg-surface-secondary px-2 py-1 text-content-secondary"><span className="font-semibold text-content-primary">{row?.unknownCount || 0}</span><br />Unknown</div>
                      </div>
                      {documents.length === 0 ? (
                        <div className="rounded-card border border-dashed border-border-subtle px-3 py-2 text-xs text-content-secondary">No documents found for this model.</div>
                      ) : (
                        <div className="max-h-48 overflow-auto rounded-card border border-border-subtle">
                          {documents.filter((document) => documentMatchesSearch(document, contentSearch)).map((document) => (
                            <label key={document.id} className="flex cursor-pointer items-start gap-2 border-b border-border-subtle px-3 py-2 last:border-b-0 hover:bg-surface-secondary">
                              <input
                                type="checkbox"
                                className="mt-1"
                                checked={selectedContentKeys.includes(contentKey(document))}
                                onChange={() => toggleContent(document)}
                                disabled={jobActive}
                              />
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
	                                  <div className="truncate text-xs font-semibold text-content-primary">{document.name}</div>
	                                  <div className="truncate text-[11px] text-content-tertiary">{document.folderPath || 'No folder path'}</div>
	                                  <div className="mt-1 flex flex-wrap gap-1 text-[10px] text-content-secondary">
	                                    {document.description ? <span className="rounded-chip bg-surface-secondary px-1.5 py-0.5">description</span> : <span className="rounded-chip bg-amber-50 px-1.5 py-0.5 text-amber-800">missing description</span>}
	                                    {document.labels?.length ? <span className="rounded-chip bg-surface-secondary px-1.5 py-0.5">{document.labels.length} label{document.labels.length === 1 ? '' : 's'}</span> : <span className="rounded-chip bg-amber-50 px-1.5 py-0.5 text-amber-800">no labels</span>}
	                                  </div>
	                                </div>
                                <span className={`rounded-chip px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                                  document.kind === 'dashboard'
                                    ? 'bg-green-50 text-green-700'
                                    : document.kind === 'workbook'
                                      ? 'bg-blue-50 text-blue-700'
                                      : 'bg-surface-secondary text-content-secondary'
                                }`}
                                >
                                  {document.kind}
                                </span>
                              </div>
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className="grid gap-5 xl:grid-cols-2">
            <div className="card p-5">
              <div className="mb-4 flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 text-sm font-semibold text-content-primary">
                    <Layers3 size={16} />
                    Resolve model differences
                  </div>
                  <p className="mt-1 text-xs text-content-secondary">Map data locations, review semantic YAML changes, and choose which files should be staged on the safe working copy. Main branches are never written by this step.</p>
                </div>
	                <button type="button" onClick={translateSelectedModels} disabled={jobActive || translating || selectedSourceModels.length === 0} className="btn-primary inline-flex items-center gap-2 text-xs disabled:opacity-60">
	                  {translating ? <Loader2 size={13} className="animate-spin" /> : <Workflow size={13} />}
	                  Prepare differences
	                </button>
	              </div>
	              <label className="mb-3 flex items-start gap-2 rounded-card border border-border-subtle bg-surface-secondary p-3 text-xs text-content-secondary">
	                <input
	                  type="checkbox"
	                  className="mt-0.5"
	                  checked={runAiDialectPass}
	                  onChange={(event) => setRunAiDialectPass(event.target.checked)}
                    disabled={jobActive}
	                />
	                <span>Run Omni AI dialect pass after deterministic schema rewrites. AI output is a reviewed draft and never writes until accepted.</span>
	              </label>
              <div className="rounded-card border border-border-subtle p-3">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wide text-content-secondary">Data-location mappings</div>
                    <p className="mt-1 text-xs text-content-secondary">Tell OmniKit how source schemas or database paths should land in the target model.</p>
                  </div>
                  <button type="button" onClick={addSchemaMappingRow} disabled={jobActive} className="btn-secondary text-xs disabled:opacity-50">Add mapping</button>
                </div>
                <div className="space-y-2">
                  {(schemaMappingRows.length > 0 ? schemaMappingRows : [{ id: 'schema-map-0', source: '', target: '' }]).map((row) => (
                    <div key={row.id} className="grid gap-2 md:grid-cols-[1fr_1fr_auto]">
                      <input
                        value={row.source}
                        onChange={(event) => updateSchemaMappingRow(row.id, { source: event.target.value })}
                        className="input-field"
                        disabled={jobActive}
                        placeholder="Source schema, database, or path"
                      />
                      <input
                        value={row.target}
                        onChange={(event) => updateSchemaMappingRow(row.id, { target: event.target.value })}
                        className="input-field"
                        disabled={jobActive}
                        placeholder="Target schema, database, or path"
                      />
                      <button
                        type="button"
                        onClick={() => removeSchemaMappingRow(row.id)}
                        disabled={jobActive || schemaMappingRows.length === 0}
                        className="btn-secondary text-xs disabled:opacity-50"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
                <details className="mt-3">
                  <summary className="cursor-pointer text-xs font-semibold text-content-secondary">Advanced raw mapping text</summary>
                  <textarea
                    value={schemaMapText}
                    onChange={(event) => setSchemaMapText(event.target.value)}
                    className="input-field mt-2 min-h-[88px]"
                    disabled={jobActive}
                    placeholder="ANALYTICS.PUBLIC -> main.analytics"
                  />
                </details>
              </div>
              <div className="mt-4 space-y-3">
                {selectedSourceModels.filter((model) => pathByModelId[model.id] !== 'fast').length === 0 ? (
                  <div className="rounded-card border border-dashed border-border-subtle p-4 text-sm text-content-secondary">Translate pipeline models will appear here.</div>
                ) : selectedSourceModels.filter((model) => pathByModelId[model.id] !== 'fast').map((model) => {
                  const translation = translationsByModelId[model.id];
                  return (
                    <div key={model.id} className="rounded-card border border-border-subtle p-3">
                      <div className="mb-2 text-sm font-semibold text-content-primary">{model.name}</div>
                      {!translation ? (
                        <div className="text-xs text-content-secondary">Run Translate to load YAML and prepare accepted files.</div>
                      ) : (
                        <div className="space-y-2">
                          {translation.semanticDecisions.length > 0 && (
                            <div className="rounded-card border border-blue-200 bg-blue-50 p-3">
                              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-blue-800">Semantic decisions</div>
                              <div className="space-y-2">
                                {translation.semanticDecisions.slice(0, 12).map((decision) => (
                                  <div key={decision.id} className="rounded-card border border-blue-100 bg-white p-2 text-xs">
                                    <div className="flex flex-wrap items-start justify-between gap-2">
                                      <div>
                                        <div className="font-semibold text-content-primary">{decision.kind}: {decision.sourceName}</div>
                                        <div className="text-content-secondary">{decision.sourceFileName || 'model YAML'}{decision.required ? ' · required before publish' : ''}</div>
                                      </div>
                                      <select
                                        value={decision.action}
                                        onChange={(event) => updateSemanticDecision(model.id, decision.id, { action: event.target.value as ModelMigratorSemanticDecision['action'] })}
                                        className="input-field max-w-[220px] bg-white text-xs"
                                        disabled={jobActive}
                                      >
                                        <option value="create_from_source">Create from source</option>
                                        <option value="map_existing">Map to existing</option>
                                        <option value="keep_target">Keep target</option>
                                        <option value="ignore">Ignore</option>
                                        <option value="custom_edit">Edit code</option>
                                      </select>
                                    </div>
                                    {decision.action === 'map_existing' && (
                                      <div className="mt-2 space-y-2">
                                        <input
                                          value={decision.targetName || ''}
                                          onChange={(event) => updateSemanticDecision(model.id, decision.id, { targetName: event.target.value })}
                                          className="input-field bg-white text-xs"
                                          disabled={jobActive}
                                          placeholder="Target view, field, topic, or relationship name"
                                        />
                                        {['field', 'view', 'topic'].includes(decision.kind) && (
                                          <label className="flex items-start gap-2 rounded-card border border-blue-100 bg-blue-50 px-2 py-1 text-blue-900">
                                            <input
                                              type="checkbox"
                                              className="mt-0.5"
                                              checked={approvedRepairDecisionIds.includes(decision.id)}
                                              disabled={jobActive || !decision.targetName}
                                              onChange={(event) => setApprovedRepairDecisionIds((current) => (
                                                event.target.checked
                                                  ? [...new Set([...current, decision.id])]
                                                  : current.filter((id) => id !== decision.id)
                                              ))}
                                            />
                                            <span>Also repair existing content references from {decision.sourceName} to {decision.targetName || 'the selected target'} before validation.</span>
                                          </label>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                ))}
                              </div>
                              {translation.semanticDecisions.length > 12 && (
                                <div className="mt-2 text-xs text-blue-800">Showing 12 of {translation.semanticDecisions.length} detected differences. Use YAML review below for the full file-level detail.</div>
                              )}
                            </div>
                          )}
	                          {translation.files.map((file) => {
	                            const accepted = acceptedFilesByModelId[model.id]?.[file.fileName] !== undefined;
	                            const skipped = (skippedFilesByModelId[model.id] || []).includes(file.fileName);
                              const acceptedValue = acceptedFilesByModelId[model.id]?.[file.fileName];
                              const activeDraft = fileDraft(file);
                              const edited = accepted && acceptedValue !== activeDraft;
	                            const decision = file.blocked ? 'Blocked' : skipped ? 'Skipped' : accepted ? edited ? 'Edited' : 'Accepted' : 'Needs decision';
	                            return (
	                              <details key={file.fileName} className="rounded-card border border-border-subtle bg-white">
	                                <summary className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-xs font-semibold text-content-primary">
	                                  <span>{file.fileName}</span>
                                    <span className="flex flex-wrap items-center justify-end gap-2">
                                      {file.aiDraft && !skipped && (
                                        <span className="rounded-chip bg-amber-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800">
                                          AI draft needs review
                                        </span>
                                      )}
	                                    <span className={file.blocked ? 'text-red-700' : skipped ? 'text-content-secondary' : accepted ? 'text-green-700' : 'text-amber-700'}>{decision}</span>
                                    </span>
	                                </summary>
	                                <div className="border-t border-border-subtle p-3">
	                                  {file.warnings.map((warning) => <div key={warning} className="mb-2 rounded-card bg-amber-50 px-2 py-1 text-xs text-amber-800">{warning}</div>)}
                                    {file.aiJobId && <div className="mb-2 rounded-card bg-blue-50 px-2 py-1 text-xs text-blue-800">Omni AI job: {file.aiJobId}</div>}
                                    {file.aiRefusal && <div className="mb-2 rounded-card bg-red-50 px-2 py-1 text-xs text-red-800">{file.aiRefusal}</div>}
	                                  <div className="mb-2 flex flex-wrap gap-2 text-xs">
	                                    <button
	                                      type="button"
	                                      className="btn-secondary text-xs"
                                        disabled={file.blocked}
	                                      onClick={() => {
	                                        setAcceptedFilesByModelId((current) => ({
	                                          ...current,
	                                          [model.id]: { ...(current[model.id] || {}), [file.fileName]: file.deterministic || file.translated },
	                                        }));
	                                        setSkippedFilesByModelId((current) => ({
	                                          ...current,
	                                          [model.id]: (current[model.id] || []).filter((item) => item !== file.fileName),
	                                        }));
	                                      }}
	                                    >
	                                      Accept deterministic
	                                    </button>
                                      {file.aiDraft && (
                                        <button
                                          type="button"
                                          className="btn-secondary text-xs"
                                          disabled={file.blocked}
                                          onClick={() => {
                                            setAcceptedFilesByModelId((current) => ({
                                              ...current,
                                              [model.id]: { ...(current[model.id] || {}), [file.fileName]: file.aiDraft || file.translated },
                                            }));
                                            setSkippedFilesByModelId((current) => ({
                                              ...current,
                                              [model.id]: (current[model.id] || []).filter((item) => item !== file.fileName),
                                            }));
                                          }}
                                        >
                                          Accept AI draft
                                        </button>
                                      )}
                                      <button
                                        type="button"
                                        className="btn-secondary text-xs"
                                        disabled={file.blocked}
                                        onClick={() => {
                                          setAcceptedFilesByModelId((current) => ({
                                            ...current,
                                            [model.id]: { ...(current[model.id] || {}), [file.fileName]: current[model.id]?.[file.fileName] ?? activeDraft },
                                          }));
                                          setSkippedFilesByModelId((current) => ({
                                            ...current,
                                            [model.id]: (current[model.id] || []).filter((item) => item !== file.fileName),
                                          }));
                                        }}
                                      >
                                        Accept current
	                                    </button>
	                                    <button
	                                      type="button"
	                                      className="btn-secondary text-xs"
                                        disabled={file.blocked}
	                                      onClick={() => {
	                                        setAcceptedFilesByModelId((current) => {
	                                          const modelFiles = { ...(current[model.id] || {}) };
	                                          delete modelFiles[file.fileName];
	                                          return { ...current, [model.id]: modelFiles };
	                                        });
	                                        setSkippedFilesByModelId((current) => ({
	                                          ...current,
	                                          [model.id]: [...new Set([...(current[model.id] || []), file.fileName])],
	                                        }));
	                                      }}
	                                    >
	                                      Skip file
	                                    </button>
	                                  </div>
	                                  <div className="grid gap-3 xl:grid-cols-2">
	                                    <div>
	                                      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-content-secondary">Original</div>
	                                      <pre className="max-h-72 overflow-auto rounded-card border border-border-subtle bg-surface-secondary p-3 font-mono text-[11px] leading-5 text-content-secondary">
	                                        {reviewLines(file.original).map((line, index) => {
	                                          const deterministicLine = reviewLines(file.deterministic || file.translated)[index];
	                                          return <div key={`${file.fileName}:orig:${index}`} className={diffLineClass(line, deterministicLine)}>{line || ' '}</div>;
	                                        })}
	                                      </pre>
	                                    </div>
                                      <div>
                                        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-content-secondary">Deterministic draft</div>
                                        <pre className="max-h-72 overflow-auto rounded-card border border-border-subtle bg-surface-secondary p-3 font-mono text-[11px] leading-5 text-content-secondary">
                                          {reviewLines(file.deterministic || file.translated).map((line, index) => {
                                            const originalLine = reviewLines(file.original)[index];
                                            return <div key={`${file.fileName}:det:${index}`} className={diffLineClass(originalLine, line)}>{line || ' '}</div>;
                                          })}
                                        </pre>
                                      </div>
                                      <div>
                                        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-content-secondary">AI draft</div>
                                        {file.aiDraft ? (
                                          <pre className="max-h-72 overflow-auto rounded-card border border-border-subtle bg-surface-secondary p-3 font-mono text-[11px] leading-5 text-content-secondary">
                                            {reviewLines(file.aiDraft).map((line, index) => {
                                              const deterministicLine = reviewLines(file.deterministic || file.translated)[index];
                                              return <div key={`${file.fileName}:ai:${index}`} className={diffLineClass(deterministicLine, line)}>{line || ' '}</div>;
                                            })}
                                          </pre>
                                        ) : (
                                          <div className="rounded-card border border-dashed border-border-subtle bg-surface-secondary p-3 text-xs text-content-secondary">
                                            {file.aiRefusal ? 'AI did not return a YAML draft. Review the deterministic draft instead.' : 'AI pass was not run for this file.'}
                                          </div>
                                        )}
                                      </div>
	                                    <label className="block">
	                                      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-content-secondary">Accepted output</span>
	                                      <textarea
	                                        value={acceptedFilesByModelId[model.id]?.[file.fileName] ?? activeDraft}
	                                        onChange={(event) => setAcceptedFilesByModelId((current) => ({
	                                          ...current,
	                                          [model.id]: { ...(current[model.id] || {}), [file.fileName]: event.target.value },
	                                        }))}
	                                        onFocus={() => setSkippedFilesByModelId((current) => ({
	                                          ...current,
	                                          [model.id]: (current[model.id] || []).filter((item) => item !== file.fileName),
	                                        }))}
	                                        className="input-field min-h-[288px] font-mono text-[11px]"
	                                        disabled={skipped || file.blocked}
	                                      />
	                                    </label>
	                                  </div>
	                                </div>
                              </details>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="card p-5">
              <div className="mb-4 flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 text-sm font-semibold text-content-primary">
                    <ShieldCheck size={16} />
                    Content impact and publish
                  </div>
                  <p className="mt-1 text-xs text-content-secondary">Check affected workbooks and dashboards, then stage the model changes. Apply and validate writes only to safe working copies; publish after validation.</p>
                </div>
                <button type="button" onClick={preflightWorkbooks} disabled={jobActive || preflighting || selectedWorkbookDocs.length === 0} className="btn-secondary inline-flex items-center gap-2 text-xs disabled:opacity-60">
                  {preflighting ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
                  Check workbook impact
                </button>
              </div>
              <div className="grid gap-2 text-xs text-content-secondary sm:grid-cols-2">
	                <label className="flex items-start gap-2 rounded-card border border-border-subtle p-3">
	                  <input type="checkbox" checked={replaceSameNamed} onChange={(event) => setReplaceSameNamed(event.target.checked)} disabled={jobActive} />
	                  <span>Replace same-named workbook documents in the target folder.</span>
	                </label>
	                <label className="flex items-start gap-2 rounded-card border border-border-subtle p-3">
	                  <input type="checkbox" checked={publishDrafts} onChange={(event) => setPublishDrafts(event.target.checked)} disabled={jobActive} />
	                  <span>Publish drafts when validated model changes are published.</span>
	                </label>
	                <label className="flex items-start gap-2 rounded-card border border-border-subtle p-3">
		                  <input type="checkbox" checked={deleteBranch} onChange={(event) => setDeleteBranch(event.target.checked)} disabled={jobActive} />
		                  <span>Delete the safe working copy after publish.</span>
		                </label>
	                <label className="flex items-start gap-2 rounded-card border border-border-subtle p-3">
	                  <input type="checkbox" checked={refreshSchemaAfterMigration} onChange={(event) => setRefreshSchemaAfterMigration(event.target.checked)} disabled={jobActive} />
	                  <span>Refresh target schema models after migration completes.</span>
	                </label>
	              </div>
	              {targetInstance?.postMigrationActions.length ? (
	                <div className="mt-4 rounded-card border border-border-subtle p-3">
	                  <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-content-secondary">Saved post-actions</div>
	                  <div className="space-y-2">
	                    {targetInstance.postMigrationActions.map((action, actionIndex) => (
	                      <label key={`${action.name}:${actionIndex}`} className="flex items-start gap-2 text-xs text-content-secondary">
	                          <input
	                            type="checkbox"
	                          checked={selectedPostActionIndexes.includes(actionIndex)}
                            disabled={jobActive}
	                          onChange={(event) => setSelectedPostActionIndexes((current) => (
	                            event.target.checked
	                              ? [...new Set([...current, actionIndex])]
	                              : current.filter((row) => row !== actionIndex)
	                          ))}
	                        />
	                        <span><span className="font-semibold text-content-primary">{action.name}</span> · {action.kind || 'webhook'} {action.url ? `· ${action.url}` : ''}</span>
	                      </label>
	                    ))}
	                  </div>
	                </div>
	              ) : null}
	              <div className="mt-4 grid grid-cols-3 gap-2 text-center text-xs">
                <div className="rounded-card bg-surface-secondary px-3 py-2"><div className="font-semibold text-content-primary">{selectedSourceModels.length}</div><div className="text-content-secondary">Models</div></div>
                <div className="rounded-card bg-surface-secondary px-3 py-2"><div className="font-semibold text-content-primary">{selectedDashboardDocs.length}</div><div className="text-content-secondary">Dashboards</div></div>
                <div className="rounded-card bg-surface-secondary px-3 py-2"><div className="font-semibold text-content-primary">{selectedWorkbookDocs.length}</div><div className="text-content-secondary">Workbooks</div></div>
              </div>
              <div className="mt-4 rounded-card border border-border-subtle bg-surface-secondary p-3 text-xs">
                <div className="mb-2 font-semibold text-content-primary">Review before run</div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="rounded-card bg-white px-3 py-2">
                    <div className="font-semibold text-content-primary">{reviewSummary.impactOnlyCount > 0 ? `${reviewSummary.impactOnlyCount} impact-only` : 'Publishing path'}</div>
                    <div className="text-content-secondary">{reviewSummary.impactOnlyCount === selectedSourceModels.length && selectedSourceModels.length > 0 ? 'No branches, YAML writes, imports, merges, or post-actions will run.' : 'Selected publishing paths will stage changes on safe working copies first.'}</div>
                  </div>
                  <div className="rounded-card bg-white px-3 py-2">
                    <div className="font-semibold text-content-primary">{reviewSummary.semanticDecisionCount} semantic decisions</div>
                    <div className="text-content-secondary">Detected model differences are recorded with the run.</div>
                  </div>
                  <div className="rounded-card bg-white px-3 py-2">
                    <div className="font-semibold text-content-primary">{reviewSummary.approvedRepairCount} approved repairs</div>
                    <div className="text-content-secondary">Find/replace repairs run only for explicitly approved mappings.</div>
                  </div>
                  <div className="rounded-card bg-white px-3 py-2">
                    <div className="font-semibold text-content-primary">{reviewSummary.prHandoffCount} PR handoffs</div>
                    <div className="text-content-secondary">Protected targets will create/update a pull request instead of direct publish.</div>
                  </div>
                </div>
              </div>
              {workbookPreflights.length > 0 && (
                <div className="mt-4 max-h-48 overflow-auto rounded-card border border-border-subtle">
                  {workbookPreflights.map((row) => (
                    <div key={row.documentId} className="border-b border-border-subtle px-3 py-2 text-xs last:border-b-0">
                      <div className="font-semibold text-content-primary">{row.documentId}</div>
                      <div className={row.blockerCount > 0 ? 'text-red-700' : 'text-green-700'}>{row.tabCount} tab{row.tabCount === 1 ? '' : 's'} · {row.blockerCount} blocker{row.blockerCount === 1 ? '' : 's'}</div>
                      {row.tabs.flatMap((tab) => tab.blockers.map((blocker) => <div key={`${tab.id}:${blocker}`} className="mt-1 text-red-700">{tab.name}: {blocker}</div>))}
                    </div>
                  ))}
                </div>
              )}
              <button type="button" onClick={startModelMigrationJob} disabled={!canStartJob} className="btn-primary mt-4 inline-flex w-full items-center justify-center gap-2 disabled:opacity-60">
                {startingJob ? <Loader2 size={14} className="animate-spin" /> : <PlayCircle size={14} />}
                Stage and validate migration
              </button>
            </div>
          </section>

          {job && (
            <section className="card p-5">
              <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 text-sm font-semibold text-content-primary">
                    <Workflow size={16} />
                    Run results
                  </div>
                  <p className="mt-1 text-xs text-content-secondary">Job {job.id} · {job.status}</p>
                </div>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={mergeValidatedJob} disabled={!jobCanMerge(job) || startingJob} className="btn-primary inline-flex items-center gap-2 text-xs disabled:opacity-50">
                    {startingJob ? <Loader2 size={13} className="animate-spin" /> : <GitBranch size={13} />}
                    Publish validated
                  </button>
                  <button type="button" onClick={retryJob} className="btn-secondary inline-flex items-center gap-2 text-xs">Retry failed</button>
                  <button type="button" onClick={cancelJob} disabled={['succeeded', 'partial', 'failed', 'canceled'].includes(job.status)} className="btn-secondary inline-flex items-center gap-2 text-xs disabled:opacity-50">
                    <X size={13} />
                    Cancel
                  </button>
                </div>
              </div>
              <div className="mb-4 rounded-card border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
                Model Migrator stages semantic YAML and dashboard metadata where Omni APIs expose them. {WORKBOOK_FIDELITY_DISCLOSURE}
              </div>
              <div className="max-h-[420px] overflow-auto rounded-card border border-border-subtle">
                {job.items.map((item) => (
                  <div key={item.id} className="border-b border-border-subtle px-3 py-2 text-xs last:border-b-0">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-semibold uppercase tracking-wide text-content-primary">{item.kind}</div>
                        <div className="mt-0.5 truncate text-content-secondary">{item.documentName || item.targetModelName || item.targetModelId || 'Model step'}</div>
                      </div>
                      <span className={`rounded-chip px-2 py-0.5 font-semibold ${item.status === 'succeeded' ? 'bg-green-100 text-green-700' : item.status === 'failed' ? 'bg-red-100 text-red-700' : item.status === 'warning' ? 'bg-yellow-100 text-yellow-800' : 'bg-surface-secondary text-content-secondary'}`}>
                        {item.status}
                      </span>
                    </div>
                    {item.importedDocumentId && <div className="mt-1 text-content-secondary">Created document: {item.importedDocumentId}</div>}
                    {typeof item.details?.url === 'string' && (
                      <a href={item.details.url} target="_blank" rel="noreferrer" className="mt-1 inline-flex text-omni-700 underline">
                        Open created document
                      </a>
                    )}
                    {item.warnings?.map((warning) => <div key={warning} className="mt-1 text-amber-700">{warning}</div>)}
                    {item.error && <div className="mt-1 text-red-700">{item.error}</div>}
                    {item.kind === 'content_validate' && Array.isArray(item.details?.issues) && item.details.issues.length > 0 ? (
	                      <details className="mt-2 rounded-card border border-border-subtle bg-surface-secondary p-2">
	                        <summary className="cursor-pointer font-semibold text-content-primary">Content validation punch list</summary>
	                        <div className="mt-2 max-h-48 space-y-2 overflow-auto">
	                          {(item.details.issues as Array<{ severity?: string; message?: string; documentName?: string; documentId?: string; field?: string; view?: string; status?: string; targetUrl?: string }>).map((issue, issueIndex) => (
	                            <div key={`${item.id}:issue:${issueIndex}`} className="rounded-card bg-white p-2">
	                              <div className={issue.severity === 'warning' ? 'font-semibold text-amber-700' : issue.severity === 'info' ? 'font-semibold text-content-secondary' : 'font-semibold text-red-700'}>
	                                {issue.severity || 'error'} · {issue.status || 'blocking'} · {issue.message || 'Validation issue'}
	                              </div>
	                              <div className="mt-1 text-content-secondary">
	                                {[issue.documentName || issue.documentId, issue.view, issue.field].filter(Boolean).join(' · ') || 'No document detail returned'}
	                              </div>
                                {issue.targetUrl && <a href={issue.targetUrl} target="_blank" rel="noreferrer" className="mt-1 inline-flex text-omni-700 underline">Open target</a>}
	                            </div>
	                          ))}
	                        </div>
	                      </details>
	                    ) : item.kind === 'content_validate' && item.details?.result ? (
	                      <details className="mt-2 rounded-card border border-border-subtle bg-surface-secondary p-2">
	                        <summary className="cursor-pointer font-semibold text-content-primary">Content validation raw result</summary>
	                        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-content-secondary">{JSON.stringify(item.details.result, null, 2)}</pre>
	                      </details>
	                    ) : null}
                    {item.kind === 'workbook_create' && Array.isArray(item.details?.tabs) ? (
                      <div className="mt-2 rounded-card border border-border-subtle bg-surface-secondary p-2">
                        <div className="mb-1 font-semibold text-content-primary">Workbook tabs</div>
                        {(item.details.tabs as Array<{ name?: string; status?: string; carried?: string[]; retryBoundary?: string }>).map((tab, tabIndex) => (
                          <div key={`${item.id}:tab:${tabIndex}`} className="flex items-center justify-between gap-2 py-0.5 text-content-secondary">
                            <span>{tab.name || `Tab ${tabIndex + 1}`}</span>
                            <span>{tab.status || 'created'} · {(tab.carried || []).join(', ') || 'query'}{tab.retryBoundary ? ` · retry: ${tab.retryBoundary}` : ''}</span>
                          </div>
                        ))}
                        {Array.isArray(item.details.limitations) && (
                          <div className="mt-2 text-content-secondary">
                            {(item.details.limitations as string[]).join(' ')}
                          </div>
                        )}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

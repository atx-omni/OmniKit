import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ArrowLeft, ArrowRight, CheckCircle2, Loader2, RefreshCw } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { SavedInstanceRequiredEmptyState } from '@/components/layout/RequireConnection';
import { ComboBox } from '@/components/ui/ComboBox';
import { useConnection } from '@/hooks/useConnection';
import { onVaultChanged, onVaultLocked } from '@/services/vaultEvents';
import { cancelOpsMigrationJob, getMigrationJob, getVaultStatus, listSavedInstances, subscribeMigrationJob, type MigrationJob, type SavedInstancePublic } from '@/services/opsConsole';
import { getTopicMigrationPlan, loadMigrationTopics, prepareDashboardTopicMigration, prepareTopicMigration, stageTopicMigration, verifyTopicMigrationBranch } from '@/services/topicMigration';
import { canRequestTopicNoWriteReview, canStageTopicPlan, canVerifyTopicBranch, chooseTopicDestinationDefinitions, groupTopicMigrationIssues, isMigrationHistoryUnavailable, latestBranchVerification, MIGRATION_HISTORY_BLOCKED_MESSAGE, readTopicMigrationDraft, reconcileTopicDestinationChoices, TOPIC_MIGRATION_DRAFT_KEY, topicJobMatchesPlan, topicMigrationReport, topicRequestFingerprint } from '@/services/topicMigrationFlow';
import { parseSchemaMappingRows, serializeSchemaMappingRows } from '@/services/modelMigratorAdvisor';
import { getDashboardDeploymentPlan, type DashboardDeploymentHandoff } from '@/services/dashboardDeploymentPlans';
import { resolveDashboardDeploymentModelMigratorHandoff, type DashboardModelRepairScope } from '@/services/modelMigratorHandoff';
import { TopicMigrationPairPicker, type TopicMigrationSide } from './TopicMigrationPairPicker';
import { TopicMigrationComparisonNotice, TopicMigrationReview, TopicMigrationScopeSummary } from './TopicMigrationReview';
import { TopicMigrationIssues } from './TopicMigrationIssues';
import { ModelBranchOutcome } from './ModelBranchOutcome';
import { TopicBlobbyRepair } from './TopicBlobbyRepair';
import { clearTopicBranchCorrectionReference } from '@/services/topicBranchCorrection';
import { clearTopicBlobbyRepairReference } from '@/services/topicBlobbyRepair';
import type { TopicMigrationPlan, TopicMigrationRequest, TopicMigrationTopic } from '../../../shared/topicMigration';

const steps = ['Connections', 'Topics', 'Review differences', 'Prepare review branch'];
const initialRequest = (sourceInstanceId = ''): TopicMigrationRequest => ({ sourceInstanceId, sourceConnectionId: '', sourceModelId: '', targetInstanceId: '', targetConnectionId: '', targetModelId: '', topicIds: [], schemaMapText: '' });
const errorText = (error: unknown) => error instanceof Error ? error.message : 'The request could not be completed.';
const busyJob = (job: MigrationJob | null) => Boolean(job && ['pending', 'running'].includes(job.status));
function saveReference(planId: string, jobId?: string) {
  try { localStorage.setItem(TOPIC_MIGRATION_DRAFT_KEY, JSON.stringify({ version: 1, planId, ...(jobId ? { jobId } : {}) })); } catch { /* Reference storage is optional. */ }
}

export function TopicMigrationWizard({ dashboardHandoff }: { dashboardHandoff?: DashboardDeploymentHandoff }) {
  const { connection } = useConnection();
  const activeId = connection.connectionMode === 'vault' ? connection.instanceId || '' : '';
  const [request, setRequest] = useState<TopicMigrationRequest>(() => initialRequest(activeId));
  const [instances, setInstances] = useState<SavedInstancePublic[]>([]);
  const [unlocked, setUnlocked] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [topics, setTopics] = useState<TopicMigrationTopic[]>([]);
  const [loadingTopics, setLoadingTopics] = useState(false);
  const [topicError, setTopicError] = useState('');
  const [search, setSearch] = useState('');
  const [step, setStep] = useState(0);
  const [plan, setPlan] = useState<TopicMigrationPlan | null>(null);
  const [comparisonOfPlanId, setComparisonOfPlanId] = useState<string | undefined>();
  const [restored, setRestored] = useState(false);
  const [approved, setApproved] = useState(false);
  const [dashboardScope, setDashboardScope] = useState<DashboardModelRepairScope | null>(null);
  const [job, setJob] = useState<MigrationJob | null>(null);
  const [busy, setBusy] = useState<'prepare' | 'stage' | 'cancel' | 'reconcile' | 'verify' | null>(null);
  const [error, setError] = useState('');
  const [streamError, setStreamError] = useState(false);
  const [historyUnavailable, setHistoryUnavailable] = useState(false);
  const [stageAttempted, setStageAttempted] = useState(false);
  const [topicLoadVersion, setTopicLoadVersion] = useState(0);
  const [vaultVersion, setVaultVersion] = useState(0);
  const analysisController = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const initializationController = useRef<AbortController | null>(null);
  const previousActiveId = useRef(activeId);
  const writeInFlight = useRef(false);
  const verificationAttempt = useRef<{ planId: string; revision: string; jobId: string; requestId: string } | null>(null);
  const submitted = useRef(false);
  submitted.current = stageAttempted || Boolean(job);
  const dashboardKey = dashboardHandoff ? `${dashboardHandoff.planId}:${dashboardHandoff.targetId}` : '';
  const returnPath = dashboardHandoff ? `/dashboards/migrate?${new URLSearchParams({ planId: dashboardHandoff.planId })}` : '';

  function reportError(reason: unknown) {
    setError(errorText(reason));
    if (isMigrationHistoryUnavailable(reason)) { setHistoryUnavailable(true); setApproved(false); }
  }

  useEffect(() => {
    const stopLocked = onVaultLocked(() => {
      generation.current += 1; analysisController.current?.abort(); initializationController.current?.abort();
      clearTopicBranchCorrectionReference();
      clearTopicBlobbyRepairReference();
      setInitializing(false); setUnlocked(false); setBusy(current => current === 'prepare' ? null : current); setApproved(false); setRestored(true);
    });
    const stopChanged = onVaultChanged(() => { clearTopicBranchCorrectionReference(); clearTopicBlobbyRepairReference(); setVaultVersion(value => value + 1); });
    return () => { stopLocked(); stopChanged(); };
  }, []);

  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    const revision = ++generation.current; initializationController.current = controller;
    const isCurrent = () => live && !controller.signal.aborted && revision === generation.current;
    const activeChanged = previousActiveId.current !== activeId; previousActiveId.current = activeId;
    if (activeChanged) clearTopicBranchCorrectionReference();
    if (activeChanged) clearTopicBlobbyRepairReference();
    analysisController.current?.abort(); setApproved(false); setInitializing(true);
    if (activeChanged && !submitted.current && !dashboardHandoff) {
      setComparisonOfPlanId(undefined);
      setPlan(null); setRequest(initialRequest(activeId)); setStep(0); setRestored(false);
      try { localStorage.removeItem(TOPIC_MIGRATION_DRAFT_KEY); } catch { /* Optional storage. */ }
    }
    if (!activeId) { setUnlocked(false); setInitializing(false); return; }
    void Promise.all([getVaultStatus(), listSavedInstances()]).then(async ([vault, saved]) => {
      if (!isCurrent()) return;
      setUnlocked(vault.unlocked); setInstances(saved.instances);
      if (!vault.unlocked) return;
      if (dashboardHandoff) {
        const result = await getDashboardDeploymentPlan(dashboardHandoff.planId, controller.signal);
        if (!isCurrent()) return;
        const scope = resolveDashboardDeploymentModelMigratorHandoff(dashboardHandoff, result.plan, saved.instances);
        setDashboardScope(scope);
        setRequest({ sourceInstanceId: scope.sourceInstanceId, sourceConnectionId: scope.sourceConnectionId, sourceModelId: scope.sourceModelIds[0] || '', targetInstanceId: scope.targetInstanceId, targetConnectionId: scope.targetConnectionId, targetModelId: scope.targetModelId, topicIds: [], schemaMapText: '' });
        setStep(2);
        if (scope.readiness.repairJobId) {
          const recovered = await getMigrationJob(scope.readiness.repairJobId);
          if (isCurrent()) { setJob(recovered.job); setStageAttempted(true); setStep(3); }
        } else if (scope.scopeReviewRequired) setError(scope.scopeReviewRequired);
        return;
      }
      if (submitted.current) { setRestored(true); return; }
      let draft = null;
      try { draft = readTopicMigrationDraft(localStorage.getItem(TOPIC_MIGRATION_DRAFT_KEY)); } catch { /* Optional storage. */ }
      if (!draft?.planId) { setRequest(initialRequest(activeId)); setPlan(null); setStep(0); return; }
      const result = await getTopicMigrationPlan(draft.planId, controller.signal);
      if (!isCurrent()) return;
      // Dashboard scopes must be restored through their owning dashboard, never as standalone topics.
      if (result.plan.dashboardRepair) { setRequest(initialRequest(activeId)); setStep(0); return; }
      setRequest(result.plan.request); setPlan(result.plan); setRestored(true);
      setComparisonOfPlanId(result.plan.comparisonOnly?.ofPlanId);
      if (result.plan.jobId) {
        const recovered = await getMigrationJob(result.plan.jobId);
        if (isCurrent()) { setJob(recovered.job); setStageAttempted(true); setStep(3); }
      } else { setStageAttempted(result.plan.status === 'submitted'); setStep(result.plan.status === 'submitted' ? 3 : 2); }
    }).catch(reason => { if (isCurrent()) reportError(reason); }).finally(() => { if (isCurrent()) setInitializing(false); });
    return () => { live = false; controller.abort(); analysisController.current?.abort(); generation.current += 1; };
    // A dashboard's durable identifiers, not a newly allocated prop object, bind the effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, vaultVersion, dashboardKey]);

  useEffect(() => {
    const controller = new AbortController(); setTopics([]); setTopicError('');
    if (dashboardHandoff || !unlocked || !request.sourceInstanceId || !request.sourceConnectionId || !request.sourceModelId) { setLoadingTopics(false); return; }
    setLoadingTopics(true);
    void loadMigrationTopics(request, controller.signal).then(result => { if (!controller.signal.aborted) setTopics(result.topics); })
      .catch(reason => { if (!controller.signal.aborted) setTopicError(errorText(reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoadingTopics(false); });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unlocked, dashboardKey, request.sourceInstanceId, request.sourceConnectionId, request.sourceModelId, topicLoadVersion]);

  const jobId = job?.id;
  useEffect(() => {
    if (!jobId || !unlocked) return;
    setStreamError(false);
    return subscribeMigrationJob(jobId, event => {
      if (event.type === 'history-unavailable' && event.jobId === jobId) { setHistoryUnavailable(true); setApproved(false); setError(MIGRATION_HISTORY_BLOCKED_MESSAGE); }
      else if ('job' in event && event.job?.id === jobId) setJob(event.job);
      else if ('item' in event && event.item) {
        const item = event.item;
        setJob(current => !current || current.id !== jobId ? current : { ...current, items: current.items.some(row => row.id === item.id) ? current.items.map(row => row.id === item.id ? item : row) : [...current.items, item] });
      }
    }, () => setStreamError(true));
  }, [jobId, unlocked]);

  const locked = Boolean(busy || busyJob(job) || stageAttempted || writeInFlight.current || historyUnavailable);
  const pairComplete = Boolean(request.sourceInstanceId && request.sourceConnectionId && request.sourceModelId && request.targetInstanceId && request.targetConnectionId && request.targetModelId && !(request.sourceInstanceId === request.targetInstanceId && request.sourceModelId === request.targetModelId));
  const selectionComplete = request.topicIds.length > 0 && !loadingTopics && !topicError && request.topicIds.every(id => topics.some(topic => topic.id === id && !topic.unavailableReason));
  const currentPlan = plan && topicRequestFingerprint(plan.request) === topicRequestFingerprint(request) ? plan : null;
  const dashboardBinding = job?.details?.dashboardRepair as { planId?: string; targetId?: string; revision?: number } | undefined;
  const jobRequest = (job?.details?.topicMigration as { request?: TopicMigrationRequest } | undefined)?.request;
  const branchProfile = (job?.details?.branchPreparation as { profile?: string } | undefined)?.profile;
  const jobBound = dashboardHandoff && job ? Boolean(dashboardScope && dashboardBinding?.planId === dashboardHandoff.planId
    && dashboardBinding.targetId === dashboardHandoff.targetId && Number.isSafeInteger(dashboardBinding.revision)
    && dashboardBinding.revision! <= dashboardScope.revision && branchProfile === 'branch_preparation_v1'
    && (currentPlan?.jobId === job.id || dashboardScope.readiness.repairJobId === job.id)
    && jobRequest?.sourceInstanceId === dashboardScope.sourceInstanceId && jobRequest?.sourceConnectionId === dashboardScope.sourceConnectionId
    && dashboardScope.sourceModelIds.includes(jobRequest?.sourceModelId || '')
    && jobRequest?.targetInstanceId === dashboardScope.targetInstanceId && jobRequest?.targetConnectionId === dashboardScope.targetConnectionId
    && jobRequest?.targetModelId === dashboardScope.targetModelId
    && job.sourceId === request.sourceInstanceId && job.destinationIds.length === 1 && job.destinationIds[0] === request.targetInstanceId)
    : topicJobMatchesPlan(currentPlan, request, job);
  const blockers = currentPlan?.issues.filter(issue => issue.severity === 'blocker') || [];
  const warnings = currentPlan?.issues.filter(issue => issue.severity === 'review') || [];
  const readyToStage = !busy && !job && !stageAttempted && !historyUnavailable && canStageTopicPlan(currentPlan, request, approved, restored);
  const verificationEligible = !dashboardHandoff && jobBound && canVerifyTopicBranch(currentPlan, request, job);
  const targetLabel = instances.find(instance => instance.id === request.targetInstanceId)?.label || 'the selected destination';

  function changeRequest(next: TopicMigrationRequest) {
    if (locked || dashboardHandoff) return;
    next = reconcileTopicDestinationChoices(request, next);
    if (['sourceInstanceId', 'sourceConnectionId', 'sourceModelId', 'targetInstanceId', 'targetConnectionId', 'targetModelId'].some(key => next[key as keyof TopicMigrationRequest] !== request[key as keyof TopicMigrationRequest])
      || JSON.stringify([...next.topicIds].sort()) !== JSON.stringify([...request.topicIds].sort())) setComparisonOfPlanId(undefined);
    generation.current += 1; analysisController.current?.abort();
    clearTopicBranchCorrectionReference();
    clearTopicBlobbyRepairReference();
    setRequest(next); setPlan(null); setApproved(false); setRestored(false); setError('');
    try { localStorage.removeItem(TOPIC_MIGRATION_DRAFT_KEY); } catch { /* Optional storage. */ }
  }
  function changeSide(side: 'source' | 'target', value: TopicMigrationSide) {
    changeRequest({ ...request, [`${side}InstanceId`]: value.instanceId, [`${side}ConnectionId`]: value.connectionId, [`${side}ModelId`]: value.modelId, topicIds: side === 'source' ? [] : request.topicIds, schemaMapText: '', fileMappings: undefined, reviewedSqlFiles: undefined, tableMappings: undefined });
  }
  async function changeDestinationChoice(sourceFileName: string, keep: boolean) {
    if (locked || dashboardHandoff || comparisonOfPlanId) return;
    let next: TopicMigrationRequest | null = null;
    if (keep) next = currentPlan ? chooseTopicDestinationDefinitions(currentPlan, request, sourceFileName, true) : null;
    else if (request.keepDestinationDefinitions?.[sourceFileName]) {
      const remaining = { ...request.keepDestinationDefinitions }; delete remaining[sourceFileName];
      next = { ...request, keepDestinationDefinitions: Object.keys(remaining).length ? remaining : undefined };
    }
    if (!next) return;
    changeRequest(next);
    await analyze(next);
  }
  async function analyze(reviewRequest: TopicMigrationRequest = request) {
    if ((!dashboardHandoff && (!pairComplete || !selectionComplete)) || locked) return;
    analysisController.current?.abort();
    const controller = new AbortController(); analysisController.current = controller;
    const revision = ++generation.current; setBusy('prepare'); setError(''); setPlan(null); setApproved(false); setRestored(false);
    try {
      const cleanRequest = { ...reviewRequest, fileMappings: undefined, reviewedSqlFiles: undefined, tableMappings: undefined };
      const result = dashboardHandoff ? await prepareDashboardTopicMigration({ planId: dashboardHandoff.planId, targetId: dashboardHandoff.targetId }, controller.signal) : await prepareTopicMigration(cleanRequest, controller.signal, comparisonOfPlanId);
      if (revision !== generation.current || controller.signal.aborted) return;
      setRequest(result.plan.request); setPlan(result.plan);
      setComparisonOfPlanId(result.plan.comparisonOnly?.ofPlanId);
      if (dashboardHandoff && result.plan.dashboardRepair) setDashboardScope(current => current ? { ...current, revision: result.plan.dashboardRepair!.revision } : current);
      if (!dashboardHandoff) saveReference(result.plan.id);
      setStep(2);
      if (result.plan.status === 'submitted') {
        setStageAttempted(true); setStep(3);
        if (result.plan.jobId) { const recovered = await getMigrationJob(result.plan.jobId); if (revision === generation.current) setJob(recovered.job); }
      }
    } catch (reason) { if (!controller.signal.aborted && revision === generation.current) reportError(reason); }
    finally { if (revision === generation.current) setBusy(null); }
  }
  async function stage() {
    if (!currentPlan || !readyToStage || writeInFlight.current) return;
    const revision = generation.current; writeInFlight.current = true; setBusy('stage'); setStageAttempted(true); setError(''); setApproved(false);
    try {
      const result = await stageTopicMigration(currentPlan);
      if (revision !== generation.current) return;
      setPlan(result.plan); setJob(result.job); if (!dashboardHandoff) saveReference(result.plan.id, result.job.id);
    } catch (reason) { if (revision === generation.current) { reportError(reason); setError(`${errorText(reason)} Check the saved run. A disconnected response does not prove no writes occurred.`); } }
    finally { setBusy(null); writeInFlight.current = false; }
  }
  async function reconcile() {
    if (writeInFlight.current) return;
    const revision = generation.current; writeInFlight.current = true; setBusy('reconcile'); setError('');
    try {
      let savedJobId = job?.id;
      if (plan) { const result = await getTopicMigrationPlan(plan.id); if (revision !== generation.current) return; setPlan(result.plan); savedJobId = result.plan.jobId; setStageAttempted(result.plan.status === 'submitted'); }
      else if (dashboardHandoff) { const result = await getDashboardDeploymentPlan(dashboardHandoff.planId); savedJobId = result.plan.targets.find(target => target.targetId === dashboardHandoff.targetId)?.repairJobId; }
      if (savedJobId) {
        const recovered = await getMigrationJob(savedJobId); if (revision !== generation.current) return;
        setJob(recovered.job); setStageAttempted(true); setHistoryUnavailable(false);
        const attempt = verificationAttempt.current;
        const audits = recovered.job.details?.branchVerifications;
        // A lost response may already have saved its observation. A new check needs a new request ID.
        if (attempt?.jobId === recovered.job.id && Array.isArray(audits)
          && audits.some(audit => audit && typeof audit === 'object' && audit.requestId === attempt.requestId)) verificationAttempt.current = null;
      }
      else { setRestored(true); setApproved(false); }
      setStreamError(false);
    } catch (reason) { if (revision === generation.current) reportError(reason); }
    finally { setBusy(null); writeInFlight.current = false; }
  }
  async function verifyExistingBranch() {
    if (!currentPlan || !job || !unlocked || !verificationEligible || busy || writeInFlight.current || historyUnavailable || streamError) return;
    const revision = generation.current;
    const previous = verificationAttempt.current;
    const attempt = previous?.planId === currentPlan.id && previous.revision === currentPlan.revision && previous.jobId === job.id
      ? previous : { planId: currentPlan.id, revision: currentPlan.revision, jobId: job.id, requestId: crypto.randomUUID() };
    verificationAttempt.current = attempt; writeInFlight.current = true; setBusy('verify'); setError('');
    try {
      const result = await verifyTopicMigrationBranch(currentPlan, attempt.requestId);
      if (revision !== generation.current) return;
      if (result.plan.id !== currentPlan.id || result.plan.revision !== currentPlan.revision || result.job.id !== job.id
        || !canVerifyTopicBranch(result.plan, request, result.job)
        || latestBranchVerification(result.job)?.requestId !== attempt.requestId || result.verification.requestId !== attempt.requestId) {
        throw new Error('The verification response is not bound to this saved run. Check the saved run before continuing.');
      }
      setPlan(result.plan); setJob(result.job); verificationAttempt.current = null;
      saveReference(result.plan.id, result.job.id);
    } catch (reason) {
      if (revision === generation.current) { reportError(reason); setStreamError(true); }
    } finally { setBusy(null); writeInFlight.current = false; }
  }
  async function cancelJob() {
    if (!job || !jobBound || !busyJob(job) || busy || writeInFlight.current || historyUnavailable) return;
    const revision = generation.current; setBusy('cancel');
    try { const result = await cancelOpsMigrationJob(job.id); if (revision === generation.current) setJob(result.job); }
    catch (reason) { if (revision === generation.current) reportError(reason); } finally { setBusy(null); }
  }
  function newPlan(comparison: boolean) {
    if (busy || busyJob(job) || writeInFlight.current || dashboardHandoff || historyUnavailable) return;
    setComparisonOfPlanId(comparison ? plan?.comparisonOnly?.ofPlanId || plan?.id : undefined);
    clearTopicBranchCorrectionReference();
    clearTopicBlobbyRepairReference();
    generation.current += 1; verificationAttempt.current = null; setJob(null); setStageAttempted(false); setPlan(null); setApproved(false); setRestored(false); setStep(1);
    setStreamError(false); setError('');
    try { localStorage.removeItem(TOPIC_MIGRATION_DRAFT_KEY); } catch { /* Optional storage. */ }
  }
  async function openPriorRun(id: string) {
    if (busy || writeInFlight.current || dashboardHandoff) return;
    const revision = ++generation.current; analysisController.current?.abort();
    setBusy('reconcile'); setApproved(false); setError('');
    try {
      const result = await getTopicMigrationPlan(id);
      const recovered = result.plan.jobId ? await getMigrationJob(result.plan.jobId) : null;
      if (revision !== generation.current) return;
      setRequest(result.plan.request); setPlan(result.plan); setJob(recovered?.job || null);
      setStageAttempted(true); setRestored(true); setStep(3); setComparisonOfPlanId(undefined);
      setStreamError(false); verificationAttempt.current = null;
      saveReference(result.plan.id, result.plan.jobId);
    } catch (reason) { if (revision === generation.current) reportError(reason); }
    finally { setBusy(null); }
  }
  function exportReport() {
    if (!currentPlan || (job && !jobBound) || historyUnavailable || streamError) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(topicMigrationReport(currentPlan, job), null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `branch-review-${currentPlan.id}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  if (!activeId || (!initializing && !unlocked)) return <SavedInstanceRequiredEmptyState toolName="Model Migrator" />;
  if (initializing) return <div className="card flex items-center gap-2 p-6" role="status"><Loader2 className="animate-spin motion-reduce:animate-none" size={18} />Loading migration workspace…</div>;
  return <div className="space-y-5 pb-12">
    <PageHeader title="Model Migrator" description="Choose topics, prepare a branch, then review a scoped Blobby repair." />
    <p className="text-sm text-content-secondary">OmniKit copies semantic definitions, not warehouse data. It never publishes these changes or copies dashboards. Existing destination definitions stay intact.</p>
    {dashboardHandoff ? <div className="card space-y-2 p-4"><strong>Dependencies for your dashboard plan</strong><p className="text-sm">This package stays bound to the selected dashboard and destination. Preparing a branch does not make the dashboard ready.</p><Link className="text-sm underline" to={returnPath}>Return to dashboard migration</Link></div> : <nav className="grid grid-cols-2 gap-2 md:grid-cols-4" aria-label="Topic migration steps">{steps.map((label, index) => <button key={label} className={`rounded-card border p-3 text-left text-sm ${step === index ? 'border-omni-600 bg-omni-50 font-semibold' : 'border-border'}`} aria-current={step === index ? 'step' : undefined} disabled={Boolean(busy) || (index > 0 && !pairComplete) || (index > 1 && !selectionComplete && !job) || (index === 3 && !currentPlan && !job)} onClick={() => setStep(index)}>{index + 1}. {label}</button>)}</nav>}
    {error && <div role="alert" className="rounded-card border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</div>}
    {restored && !job && <div role="status" className="rounded-card border border-amber-200 bg-amber-50 p-3 text-sm">Saved choices restored, not approval. Review differences again to create a fresh branch-preparation package.</div>}
    {busy === 'prepare' && <div role="status" className="card flex items-center justify-between gap-3 p-4"><span className="flex items-center gap-2"><Loader2 size={18} className="animate-spin motion-reduce:animate-none" />Reading authored definitions and comparing required dependencies…</span><button className="btn-secondary" onClick={() => { analysisController.current?.abort(); generation.current += 1; setBusy(null); }}>Cancel review</button></div>}
    {step === 0 && !dashboardHandoff && <>
      <div className="grid gap-4 lg:grid-cols-2"><TopicMigrationPairPicker label="Source" disabled={locked} instances={instances.filter(row => row.role !== 'destination')} value={{ instanceId: request.sourceInstanceId, connectionId: request.sourceConnectionId, modelId: request.sourceModelId }} onChange={value => changeSide('source', value)} />
        <TopicMigrationPairPicker label="Destination" disabled={locked} instances={instances.filter(row => row.role !== 'source')} value={{ instanceId: request.targetInstanceId, connectionId: request.targetConnectionId, modelId: request.targetModelId }} onChange={value => changeSide('target', value)} /></div>
      {request.sourceInstanceId === request.targetInstanceId && request.sourceModelId && request.sourceModelId === request.targetModelId && <p role="alert" className="text-sm text-red-700">Choose a different destination model.</p>}
      <button className="btn-primary inline-flex items-center gap-2" disabled={!pairComplete || locked} onClick={() => setStep(1)}>Choose topics <ArrowRight size={16} /></button>
    </>}
    {step === 1 && !dashboardHandoff && <section className="card space-y-4 p-5" aria-label="Choose topics">
      <h2 className="text-lg font-semibold">Which topics should move?</h2><p className="text-sm text-content-secondary">Required views, fields, and relationship entries are included automatically. Unrelated topics and relationships stay out.</p>
      <label className="block text-sm">Find a topic<input className="input-field mt-1 w-full" value={search} onChange={event => setSearch(event.target.value)} placeholder="Topic name" /></label>
      {loadingTopics && <p role="status">Reading source topics…</p>}{topicError && <p role="alert">{topicError}</p>}
      <div className="max-h-96 space-y-2 overflow-auto">{topics.filter(topic => `${topic.name} ${topic.fileName}`.toLowerCase().includes(search.toLowerCase())).map(topic => <label className="flex items-start gap-3 rounded border border-border p-3" key={topic.id}><input type="checkbox" className="mt-1" disabled={locked || Boolean(topic.unavailableReason)} checked={request.topicIds.includes(topic.id)} onChange={event => changeRequest({ ...request, topicIds: event.target.checked ? [...request.topicIds, topic.id] : request.topicIds.filter(id => id !== topic.id) })} /><span><strong className="text-sm">{topic.name}</strong><span className="block break-all text-xs text-content-secondary">{topic.fileName}</span>{topic.unavailableReason && <span className="block text-sm text-amber-900">{topic.unavailableReason}</span>}</span></label>)}</div>
      {!loadingTopics && !topicError && !topics.length && <p>No authored topics were returned. Check the selected source model in Omni.</p>}
      <div className="flex gap-2"><button className="btn-secondary" disabled={locked || loadingTopics} onClick={() => setTopicLoadVersion(value => value + 1)}>Reload topics</button><button className="btn-primary" disabled={!selectionComplete || locked} onClick={() => void analyze()}>Review differences · {request.topicIds.length} selected</button></div>
    </section>}
    {step === 2 && <section className="space-y-4" aria-label="Review differences">
      {!dashboardHandoff && <details className="card p-4"><summary className="cursor-pointer text-sm font-semibold">Optional location mappings</summary><div className="mt-3"><TopicLocationMappings value={request.schemaMapText} sourceLocations={currentPlan?.dataLocations?.source} targetLocations={currentPlan?.dataLocations?.target} disabled={locked} onChange={schemaMapText => changeRequest({ ...request, schemaMapText })} /></div></details>}
      {!dashboardHandoff && !comparisonOfPlanId && !job && !stageAttempted && Object.keys(request.keepDestinationDefinitions || {}).length > 0 && <details className="card p-4"><summary className="cursor-pointer text-sm font-semibold">Selected destination-preserving choices · {Object.keys(request.keepDestinationDefinitions || {}).length}</summary><p className="mt-2 text-sm text-content-secondary">These choices apply only to the reviewed snapshots. Rechecking keeps them until you remove one or change the connection pair, topics, or location mappings.</p><ul className="mt-3 space-y-2">{Object.entries(request.keepDestinationDefinitions || {}).map(([sourceFileName, choice]) => <li key={sourceFileName} className="flex flex-wrap items-center justify-between gap-2 text-sm"><span className="break-all">{sourceFileName} → {choice.destinationFileName}</span><button className="btn-secondary" disabled={locked} onClick={() => void changeDestinationChoice(sourceFileName, false)}>Remove choice and recheck</button></li>)}</ul></details>}
      <button className="btn-secondary inline-flex items-center gap-2" disabled={(!dashboardHandoff && !selectionComplete) || locked} onClick={() => void analyze()}><RefreshCw size={14} />{currentPlan ? 'Recheck differences' : 'Review differences'}</button>
      {!currentPlan ? <p className="card p-5 text-sm">Read current source and destination definitions to prepare a review. Nothing is written during this step.</p> : <>
        {currentPlan.comparisonOnly ? <TopicMigrationComparisonNotice plan={currentPlan} disabled={locked} onOpenRun={id => void openPriorRun(id)} /> : <div role="status" className="card p-4"><strong>{stageAttempted || job || currentPlan.status === 'submitted' ? 'Submitted package — read-only review' : blockers.length ? `${groupTopicMigrationIssues(blockers).length} conflicts to resolve` : currentPlan.status === 'unchanged' ? currentPlan.files.some(file => file.destinationPreservation) ? 'Destination definitions retained — no missing additions' : 'Everything selected is already present' : 'Additive package ready for review'}</strong><p className="mt-1 text-sm text-content-secondary">{currentPlan.topics.length} topics · {currentPlan.dependencies.length} required files · {warnings.length} follow-ups for Omni. {stageAttempted || job || currentPlan.status === 'submitted' ? 'Check the saved run for actual write outcomes; this package cannot be submitted again.' : 'No files have been written.'}</p></div>}
        {blockers.length > 0 && <TopicMigrationIssues issues={blockers} plan={currentPlan} disabled={locked || Boolean(dashboardHandoff)} request={request} onChange={changeRequest} />}
        {warnings.length > 0 && <details className="card p-4"><summary className="cursor-pointer font-semibold">Finish in Omni · {groupTopicMigrationIssues(warnings).length} review groups</summary><div className="mt-3"><TopicMigrationIssues issues={warnings} plan={currentPlan} disabled={locked || Boolean(dashboardHandoff)} request={request} onChange={changeRequest} /></div></details>}
        <TopicMigrationReview plan={currentPlan} disabled={locked || Boolean(dashboardHandoff)} onKeepDestination={!dashboardHandoff ? (fileName, keep) => void changeDestinationChoice(fileName, keep) : undefined} />
        <button className="btn-primary inline-flex items-center gap-2" disabled={Boolean(currentPlan.comparisonOnly) || blockers.length > 0 || restored || currentPlan.version !== 2 || currentPlan.status === 'submitted' || Boolean(busy)} onClick={() => setStep(3)}>Continue to branch preparation <ArrowRight size={16} /></button>
        <p className="text-sm text-content-secondary">{currentPlan.comparisonOnly ? 'Fresh comparison only. Existing branches and saved outcomes are unchanged.' : blockers.length ? 'Resolve conflicts in Omni and recheck, or hold affected topics. Existing definitions will not be overwritten.' : 'After preparation, use the scoped Blobby repair to adapt the branch, review its actual changes, and validate before publication in Omni.'}</p>
      </>}
    </section>}
    {step === 3 && <section className="card space-y-5 p-5" aria-label="Prepare review branch">
      <h2 className="text-lg font-semibold">Review branch for {targetLabel}</h2>
      <TopicMigrationScopeSummary request={request} sourceLabel={instances.find(instance => instance.id === request.sourceInstanceId)?.label} targetLabel={instances.find(instance => instance.id === request.targetInstanceId)?.label} />
      {currentPlan && <><button className="btn-secondary text-sm" disabled={(Boolean(job) && !jobBound) || historyUnavailable || streamError} onClick={exportReport}>Export review and outcome report</button><TopicMigrationReview plan={currentPlan} />
        {!job && (currentPlan.comparisonOnly ? <TopicMigrationComparisonNotice plan={currentPlan} disabled={locked} onOpenRun={id => void openPriorRun(id)} /> : <><p className="text-sm">A new branch will contain only the approved additions. Then prepare a scoped Blobby repair, inspect the actual file changes, and validate. Publication stays in Omni.</p>
          {currentPlan.status === 'unchanged' ? <p className="flex items-center gap-2"><CheckCircle2 size={16} />No branch or writes are needed for this scope.</p> : <><label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={approved} disabled={locked || restored || blockers.length > 0 || currentPlan.version !== 2} onChange={event => setApproved(event.target.checked)} />I reviewed these exact additions and follow-ups. Prepare a review branch in {targetLabel}; do not publish it.</label><button className="btn-primary" disabled={!readyToStage} onClick={() => void stage()}>{busy === 'stage' ? 'Starting branch preparation…' : 'Create review branch'}</button></>}
          {(stageAttempted || restored || currentPlan.expiresAt <= Date.now()) && <p className="text-sm text-amber-900">Check the saved run after a submission. Restored, expired, and older reviews cannot be resubmitted. For an existing review branch, use Prepare Blobby repair; Start fresh comparison remains read-only.</p>}
        </>)}
      </>}
      {(stageAttempted || job || streamError) && <button className="btn-secondary" disabled={Boolean(busy)} onClick={() => void reconcile()}>Check saved run</button>}
      {job && <>{!dashboardHandoff && <h3 className="font-semibold">Original preparation outcome</h3>}<ModelBranchOutcome job={job} bound={jobBound} streamError={streamError} historyUnavailable={historyUnavailable} destinationUrl={instances.find(instance => instance.id === request.targetInstanceId)?.baseUrl}
        onVerify={verificationEligible ? () => void verifyExistingBranch() : undefined} verifying={busy === 'verify'} verifyDisabled={Boolean(busy) || !unlocked} />
        {busyJob(job) && <button className="btn-secondary" disabled={Boolean(busy) || !jobBound || historyUnavailable} onClick={() => void cancelJob()}>Stop remaining work</button>}
        {!busyJob(job) && !dashboardHandoff && jobBound && currentPlan && !currentPlan.comparisonOnly && Boolean(job.endedAt) && <TopicBlobbyRepair
          key={`${currentPlan.id}:${activeId}:${vaultVersion}`} originPlanId={currentPlan.id} targetLabel={targetLabel}
          destinationUrl={instances.find(instance => instance.id === request.targetInstanceId)?.baseUrl}
          disabled={Boolean(busy) || !unlocked || historyUnavailable || streamError} />}
        {!busyJob(job) && !dashboardHandoff && <button className="btn-secondary" disabled={Boolean(busy) || historyUnavailable || streamError} onClick={() => newPlan(true)}>Start fresh comparison</button>}
        {!dashboardHandoff && jobBound && canRequestTopicNoWriteReview(job) && <div className="space-y-2">
          <p className="text-sm">Saved evidence indicates no files were applied. The server will recheck this before allowing a new, separately approved plan.</p>
          <button className="btn-secondary" disabled={Boolean(busy) || historyUnavailable || streamError} onClick={() => newPlan(false)}>Review again after no-write recovery</button>
        </div>}
      </>}
      {dashboardHandoff && <p className="text-sm">After you publish the reviewed changes in Omni, <Link className="underline" to={returnPath}>return to dashboard migration</Link> and explicitly recheck readiness. Branch preparation alone never enables dashboard deployment.</p>}
    </section>}
    {step > 0 && !dashboardHandoff && <button className="btn-secondary inline-flex items-center gap-2" disabled={Boolean(busy)} onClick={() => setStep(value => Math.max(0, value - 1))}><ArrowLeft size={14} />Back</button>}
  </div>;
}

function TopicLocationMappings({ value, sourceLocations, targetLocations, disabled, onChange }: { value: string; sourceLocations?: string[]; targetLocations?: string[]; disabled: boolean; onChange: (text: string) => void }) {
  const rows = parseSchemaMappingRows(value);
  const [source, setSource] = useState(''); const [target, setTarget] = useState('');
  return <div className="space-y-3">
    <p className="text-sm">Optional catalog/schema substitutions only. Every change appears in the file differences. Leave blank to preserve source references for editing in Omni.</p>
    {rows.map((row, index) => <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-border p-2 text-sm" key={row.id}><span>{row.source} → {row.target}</span><button disabled={disabled} className="btn-secondary" onClick={() => onChange(serializeSchemaMappingRows(rows.filter((_, i) => i !== index)))}>Remove mapping</button></div>)}
    <div className="grid gap-2 md:grid-cols-[1fr_1fr_auto]"><ComboBox ariaLabel="Source data location" value={source} onChange={setSource} disabled={disabled} allowFreeText placeholder="Source catalog.schema" options={(sourceLocations || []).map(location => ({ value: location, label: location }))} />
      <ComboBox ariaLabel="Destination data location" value={target} onChange={setTarget} disabled={disabled} allowFreeText placeholder="Destination catalog.schema" options={(targetLocations || []).map(location => ({ value: location, label: location }))} />
      <button className="btn-secondary" disabled={disabled || !source.trim() || !target.trim() || rows.some(row => row.source === source.trim())} onClick={() => { onChange(serializeSchemaMappingRows([...rows, { id: `mapping-${rows.length}`, source: source.trim(), target: target.trim() }])); setSource(''); setTarget(''); }}>Add mapping</button></div>
    <p className="text-xs text-content-secondary">Suggestions are names only, not evidence of compatible tables or columns. Check those in Omni before publishing.</p>
  </div>;
}

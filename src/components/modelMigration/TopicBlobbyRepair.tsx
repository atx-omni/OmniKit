import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { lineDiff } from '@/utils/lineDiff';
import { onVaultChanged, onVaultLocked } from '@/services/vaultEvents';
import { canAcceptTopicBlobbyRepair, canStartTopicBlobbyRepair, clearTopicBlobbyRepairReference, getTopicBlobbyRepair, hasCurrentTopicBlobbyPrompt,
  prepareTopicBlobbyRepair, readTopicBlobbyRepairReference, runTopicBlobbyRepairAction, saveTopicBlobbyRepairReference,
  TOPIC_BLOBBY_REPAIR_REFERENCE_KEY, topicBlobbyRepairReport, type TopicBlobbyRepairAction } from '@/services/topicBlobbyRepair';
import type { TopicBlobbyRepair as Repair } from '../../../shared/topicBlobbyRepair';

type Action = 'prepare' | 'next' | 'get' | TopicBlobbyRepairAction;
const POLL_INTERVAL_MS = 2000;
const POLL_LIMIT = 30;
const actionLabels: Record<Action, string> = { prepare: 'Reading the branch and preparing scoped Blobby instructions…', next: 'Preparing another scoped repair pass…', get: 'Reading the saved repair…',
  start: 'Starting the approved repair session…', inspect: 'Reading Blobby’s actual branch changes…', validate: 'Validating this branch model…',
  accept: 'Checking the reviewed branch before recording acceptance…', cancel: 'Recording the stop or close request…' };
const errorText = (reason: unknown) => reason instanceof Error ? reason.message : 'The request could not be completed.';

function safeOmniUrl(value?: string) {
  try { const url = new URL(value || ''); return url.protocol === 'https:' && !url.username && !url.password ? url.origin : undefined; } catch { return undefined; }
}

export function TopicBlobbyRepair({ originPlanId, targetLabel, destinationUrl, disabled }: {
  originPlanId: string; targetLabel: string; destinationUrl?: string; disabled: boolean;
}) {
  const [repair, setRepair] = useState<Repair | null>(null);
  const [referenceId, setReferenceId] = useState<string>();
  const [busy, setBusy] = useState<Action | null>(null);
  const [fresh, setFresh] = useState(false);
  const [approved, setApproved] = useState(false);
  const [startAttempted, setStartAttempted] = useState(false);
  const [acceptApproved, setAcceptApproved] = useState(false);
  const [reviewedFiles, setReviewedFiles] = useState<string[]>([]);
  const [unverified, setUnverified] = useState(false);
  const [pollPaused, setPollPaused] = useState(false);
  const [pollCycle, setPollCycle] = useState(0);
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState('');
  const [copyStatus, setCopyStatus] = useState('');
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const actionInFlight = useRef(false);
  const previousOrigin = useRef(originPlanId);
  const evidenceKey = useRef('');
  const disabledRef = useRef(disabled); disabledRef.current = disabled;

  function receive(next: Repair, expectedId?: string) {
    if (next.originPlanId !== originPlanId || (expectedId && next.id !== expectedId) || next.branch.modelId !== next.request.targetModelId
      || !['native', 'api'].includes(next.mode)) throw new Error('The saved repair does not match this reviewed branch. Check the saved repair before continuing.');
    const nextEvidence = `${next.id}:${next.revision}:${next.branchHash || ''}`;
    if (evidenceKey.current !== nextEvidence) { setReviewedFiles([]); setAcceptApproved(false); evidenceKey.current = nextEvidence; }
    setRepair(next); setReferenceId(next.id); saveTopicBlobbyRepairReference(next); setUnverified(false);
  }

  useEffect(() => {
    const invalidate = () => {
      generation.current += 1; controller.current?.abort(); actionInFlight.current = false; evidenceKey.current = '';
      setRepair(null); setReferenceId(undefined); setApproved(false); setAcceptApproved(false); setReviewedFiles([]);
      setFresh(false); setStartAttempted(false); setBusy(null); setError(''); setCopyStatus(''); clearTopicBlobbyRepairReference();
    };
    const stopLocked = onVaultLocked(invalidate), stopChanged = onVaultChanged(invalidate);
    return () => { stopLocked(); stopChanged(); generation.current += 1; controller.current?.abort(); };
  }, []);

  useEffect(() => {
    if (previousOrigin.current !== originPlanId) clearTopicBlobbyRepairReference();
    previousOrigin.current = originPlanId;
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort; const revision = ++generation.current;
    setRepair(null); setReferenceId(undefined); setFresh(false); setApproved(false); setAcceptApproved(false); setReviewedFiles([]);
    setStartAttempted(false); setBusy(null); setError(''); setCopyStatus(''); setUnverified(false); setPollPaused(false); actionInFlight.current = false;
    let reference = null;
    try { reference = readTopicBlobbyRepairReference(localStorage.getItem(TOPIC_BLOBBY_REPAIR_REFERENCE_KEY), originPlanId); } catch { /* Optional reference storage. */ }
    if (!reference || disabled) return;
    setReferenceId(reference.id); setBusy('get'); actionInFlight.current = true;
    void getTopicBlobbyRepair(reference.id, abort.signal).then(result => {
      if (revision !== generation.current || abort.signal.aborted) return;
      receive(result.repair, reference.id);
    }).catch(reason => {
      if (revision !== generation.current || abort.signal.aborted) return;
      setError(errorText(reason)); setUnverified(true);
    }).finally(() => { if (revision === generation.current) { setBusy(null); actionInFlight.current = false; } });
    return () => { abort.abort(); generation.current += 1; };
    // Restoration reads saved state only. It never submits Blobby work or restores approval.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [originPlanId, disabled]);

  const repairId = repair?.id, repairStatus = repair?.status, repairMode = repair?.mode;
  useEffect(() => {
    if (!repairId || repairMode !== 'api' || repairStatus !== 'running' || disabled || busy || pollPaused) return;
    const abort = new AbortController(), revision = generation.current;
    let timer: ReturnType<typeof setTimeout>, attempts = 0;
    const deadline = setTimeout(() => { abort.abort(); setPollPaused(true); }, POLL_INTERVAL_MS * POLL_LIMIT);
    const poll = async () => {
      if (abort.signal.aborted || revision !== generation.current || disabledRef.current) return;
      try {
        const result = await runTopicBlobbyRepairAction({ id: repairId, revision: '' }, 'inspect', abort.signal);
        if (abort.signal.aborted || revision !== generation.current) return;
        receive(result.repair, repairId);
        if (result.repair.status !== 'running') return;
        if (++attempts >= POLL_LIMIT) { setPollPaused(true); return; }
        timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
      } catch (reason) {
        if (abort.signal.aborted || revision !== generation.current) return;
        setError(errorText(reason)); setUnverified(true); setPollPaused(true); setAcceptApproved(false);
      }
    };
    timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    return () => { abort.abort(); clearTimeout(timer); clearTimeout(deadline); };
    // Only a server-returned API running state enables this bounded read-only inspection loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repairId, repairStatus, repairMode, disabled, busy, pollPaused, pollCycle]);

  useEffect(() => {
    const expiry = repair?.expiresAt; setExpired(Boolean(expiry && expiry <= Date.now()));
    if (!expiry || expiry <= Date.now()) return;
    const timer = setTimeout(() => { setExpired(true); setApproved(false); }, Math.min(expiry - Date.now(), 2_147_483_647));
    return () => clearTimeout(timer);
  }, [repair?.expiresAt]);

  async function run(action: Action) {
    if (disabled || actionInFlight.current || (action !== 'prepare' && !referenceId)) return;
    if (action === 'start' && (!repair || unverified || !canStartTopicBlobbyRepair(repair, approved, fresh, startAttempted))) return;
    if (action === 'accept' && (!repair || !canAcceptTopicBlobbyRepair(repair, acceptApproved, reviewedFiles, unverified))) return;
    if (action === 'next' && (!repair?.canPrepareNext || unverified)) return;
    if (!['prepare', 'get'].includes(action) && !repair) return;
    actionInFlight.current = true; controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    const revision = ++generation.current; setBusy(action); setError(''); setApproved(false); setAcceptApproved(false); setCopyStatus('');
    if (action === 'start') { setStartAttempted(true); setFresh(false); }
    try {
      const result = action === 'prepare' || action === 'next' ? await prepareTopicBlobbyRepair(originPlanId, abort.signal, action === 'next' ? repair!.id : undefined)
        : action === 'get' ? await getTopicBlobbyRepair(referenceId!, abort.signal)
          : await runTopicBlobbyRepairAction(repair!, action, abort.signal);
      if (revision !== generation.current || abort.signal.aborted || disabledRef.current) return;
      receive(result.repair, action === 'prepare' || action === 'next' ? undefined : referenceId);
      if (action === 'prepare' || action === 'next') { setFresh(true); if (result.repair.id !== referenceId) setStartAttempted(false); }
      setPollPaused(false); setPollCycle(value => value + 1);
    } catch (reason) {
      if (revision !== generation.current || abort.signal.aborted) return;
      setError(`${errorText(reason)}${action === 'start' ? ' The submission outcome is unknown. Check the saved repair; do not start another session.' : ''}`);
      if (action !== 'prepare' && action !== 'next') setUnverified(true);
      setFresh(false); setPollPaused(true);
    } finally { if (revision === generation.current) { setBusy(null); actionInFlight.current = false; } }
  }

  async function copyInstructions() {
    if (!repair || disabled || unverified || !hasCurrentTopicBlobbyPrompt(repair)) return;
    const revision = generation.current;
    try { await navigator.clipboard.writeText(repair.nativePrompt); if (revision === generation.current) setCopyStatus('Scoped instructions copied.'); }
    catch { if (revision === generation.current) setCopyStatus('Select and copy the instructions below.'); }
  }

  function exportSummary() {
    if (!repair) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify({ ...topicBlobbyRepairReport(repair), snapshotUnverified: unverified }, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `blobby-repair-${repair.id}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const locked = disabled || Boolean(busy);
  const canPrepare = !repair || (repair.status === 'ready' && !startAttempted);
  const started = Boolean(repair && repair.status !== 'ready');
  const canInspect = repair && (started || startAttempted);
  const canValidate = repair && !unverified && ['review', 'needs_input'].includes(repair.status) && Boolean(repair.branchHash);
  const startReady = repair && !locked && !unverified && !expired && canStartTopicBlobbyRepair(repair, approved, fresh, startAttempted);
  const acceptReady = repair && !locked && canAcceptTopicBlobbyRepair(repair, acceptApproved, reviewedFiles, unverified);

  return <section className="space-y-4 rounded-card border border-border p-4" aria-label="Blobby branch repair">
    <div><h3 className="text-lg font-semibold">Repair this branch with Blobby</h3><p className="mt-1 text-sm text-content-secondary">Use Blobby to adapt the reviewed files for {targetLabel}, inspect the actual changes, and accept the branch result before finishing in Omni. The original preparation outcome remains separate.</p></div>
    {canPrepare && <button className="btn-primary" disabled={locked || unverified} onClick={() => void run('prepare')}>{repair ? 'Recheck Blobby repair context' : 'Prepare Blobby repair'}</button>}
    {busy && <p role="status" className="flex items-center gap-2 text-sm"><Loader2 size={16} className="animate-spin motion-reduce:animate-none" />{actionLabels[busy]}</p>}
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    {referenceId && <button className="btn-secondary" disabled={locked} onClick={() => void run('get')}>Check saved repair</button>}
    {repair && <>
      <TopicBlobbyRepairReview repair={repair} unverified={unverified} reviewedFiles={reviewedFiles}
        onReviewFile={fileName => {
          if (evidenceKey.current === `${repair.id}:${repair.revision}:${repair.branchHash || ''}`) setReviewedFiles(current => current.includes(fileName) ? current : [...current, fileName]);
        }} />
      {repair.status === 'ready' && <div className="space-y-3">
        {!fresh && <p className="text-sm text-amber-900">Saved context restored without approval. Recheck the repair context before starting.</p>}
        {expired && <p className="text-sm text-amber-900">This context expired. Recheck the branch before approving.</p>}
        <p className="text-sm">{repair.mode === 'native' ? 'Begin the handoff to record the branch baseline. Then run Blobby yourself in Omni using the scoped instructions below.' : 'This approval starts one Blobby repair session on the exact branch and file scope above.'}</p>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={approved} disabled={locked || !fresh || expired || unverified || startAttempted} onChange={event => setApproved(event.target.checked)} />I reviewed this branch and file scope. Begin one Blobby repair session on this review branch; keep the shared model unchanged.</label>
        <button className="btn-primary" disabled={!startReady} onClick={() => void run('start')}>{repair.mode === 'native' ? 'Begin Blobby handoff' : 'Run Blobby on this branch'}</button>
      </div>}
      {repair.mode === 'native' && !['accepted', 'canceled'].includes(repair.status) && <NativeBlobbyHandoff repair={repair} destinationUrl={destinationUrl} active={started} disabled={locked || unverified}
        copyStatus={copyStatus} onCopy={() => void copyInstructions()} />}
      {canInspect && <div className="space-y-2"><button className="btn-primary" disabled={locked} onClick={() => void run('inspect')}>Check Blobby’s changes</button><p className="text-xs text-content-secondary">Reads the actual branch and any saved job state. It does not submit another Blobby request.</p></div>}
      {(pollPaused || unverified || repair.status === 'uncertain') && <p className="text-sm text-amber-900">Automatic checks are paused or the outcome is unconfirmed. Inspect the saved repair and branch before continuing. Blobby may still be working; do not submit another repair.</p>}
      {canValidate && <button className="btn-secondary" disabled={locked} onClick={() => void run('validate')}>Validate branch model</button>}
      {repair.status === 'review' && <div className="space-y-3 rounded border border-border p-3">
        <p className="text-sm">{repair.changes.length ? 'Open every changed file and run branch model validation.' : 'No file changes were found. Validate the inspected branch and review the unchanged result.'} Acceptance records your review of the read-back result; it does not publish the model.</p>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={acceptApproved} disabled={locked || unverified} onChange={event => setAcceptApproved(event.target.checked)} />I reviewed the actual file changes and validation result. Accept this exact branch result.</label>
        <button className="btn-primary" disabled={!acceptReady} onClick={() => void run('accept')}>Accept reviewed branch result</button>
      </div>}
      {repair.status === 'accepted' && !unverified && <div className="space-y-2 rounded border border-border p-3 text-sm"><p>Branch result accepted. In Omni, complete affected-content checks and representative query and access tests, then publish or request review manually. Nothing has been published by this workflow.</p>{safeOmniUrl(destinationUrl) && <a className="btn-primary inline-block" href={safeOmniUrl(destinationUrl)} target="_blank" rel="noopener noreferrer">Open Omni to finish review</a>}</div>}
      <div className="flex flex-wrap gap-2">
        {repair.canPrepareNext && <button className="btn-secondary" disabled={locked || unverified} onClick={() => void run('next')}>Prepare another repair pass</button>}
        {['running', 'uncertain', 'needs_input', 'review'].includes(repair.status) && <button className="btn-secondary" disabled={locked} onClick={() => void run('cancel')}>{repair.mode === 'native' ? 'Close this handoff' : 'Request Blobby stop'}</button>}
        <button className="btn-secondary" disabled={locked} onClick={exportSummary}>Export repair summary</button>
      </div>
      <p className="text-xs text-content-secondary">{repair.mode === 'native' ? 'Closing this handoff closes local tracking only; it does not stop Blobby in Omni. Finish any work in Omni and inspect the result.' : 'A stop request may allow Blobby’s current iteration to finish. Inspect the remote result until it is terminal.'} Neither action undoes edits or rolls back the branch.</p>
    </>}
  </section>;
}

export function NativeBlobbyHandoff({ repair, destinationUrl, active, disabled, copyStatus, onCopy }: {
  repair: Repair; destinationUrl?: string; active: boolean; disabled: boolean; copyStatus?: string; onCopy: () => void;
}) {
  const url = safeOmniUrl(destinationUrl);
  const currentPrompt = hasCurrentTopicBlobbyPrompt(repair);
  return <div className="space-y-3 rounded border border-border p-4" aria-label="Run Blobby in Omni">
    <h4 className="font-semibold">Run Blobby in Omni</h4>
    <p className="text-sm text-content-secondary">Automated Blobby branch controls are not enabled for this destination. Use the scoped handoff in Omni; you can still inspect and validate the resulting changes here.</p>
    <p className="text-sm">{active ? 'The baseline is recorded. Open Omni, select this exact model and branch, and give Blobby the scoped instructions. Return here after it finishes to check the actual changes.' : 'Begin the Blobby handoff above before making changes. That records the branch baseline used for review.'}</p>
    <ol className="list-decimal space-y-1 pl-5 text-sm"><li>Open the destination instance and its model editor.</li><li>Select the existing branch <strong>{repair.branch.branchName}</strong>. Do not create another branch.</li><li>Confirm the model and branch IDs below, then paste the instructions. Ask Blobby to confirm the active branch before editing.</li></ol>
    <p className="text-sm text-content-secondary">Use Blobby’s Sandbox mode in Omni to review proposed edits before applying them to this branch. Keep publication as a separate manual step.</p>
    <p className="break-all text-sm">Model: {repair.branch.modelId} · Branch: {repair.branch.branchName} · Branch ID: {repair.branch.branchId}</p>
    {currentPrompt && repair.nativePromptSnapshot?.validationCheckedAt && <p className="text-xs text-content-secondary">Instructions match validation checked {new Date(repair.nativePromptSnapshot.validationCheckedAt).toISOString()}. If you edit the branch in Omni, check its changes and validate again before copying a new prompt.</p>}
    {!currentPrompt && <p role="status" className="text-sm text-amber-900">Instructions need fresh branch validation. {active ? 'Check Blobby’s changes, then Validate branch model to refresh the instructions.' : 'Recheck Blobby repair context above.'}</p>}
    <div className="flex flex-wrap gap-2"><button className="btn-secondary" disabled={disabled || !active || !currentPrompt} onClick={onCopy}>Copy scoped repair instructions</button>
      {url && active && <a className="btn-primary" href={url} target="_blank" rel="noopener noreferrer">Open Omni — select branch</a>}</div>
    {copyStatus && <p role="status" className="text-sm">{copyStatus}</p>}
    {currentPrompt && <details><summary className="cursor-pointer text-sm font-semibold">Scoped instructions for Blobby</summary><textarea className="input-field mt-2 min-h-48 w-full font-mono text-xs" aria-label="Scoped Blobby repair instructions" readOnly value={repair.nativePrompt} onFocus={event => event.currentTarget.select()} /></details>}
    <p className="text-xs text-content-secondary">Select the recorded branch in Omni’s model editor. The instance link does not select a branch for you.</p>
  </div>;
}

export function TopicBlobbyRepairReview({ repair, unverified = false, reviewedFiles = [], onReviewFile = () => {} }: {
  repair: Repair; unverified?: boolean; reviewedFiles?: string[]; onReviewFile?: (fileName: string) => void;
}) {
  const validationLabels = { not_run: 'Not run', passed: 'Passed', issues: 'Issues found', unavailable: 'Unavailable — not validated' };
  const statusLabels = { ready: 'Review repair scope', running: repair.mode === 'native' ? 'Awaiting Blobby in Omni' : 'Blobby is working',
    uncertain: 'Outcome unconfirmed', review: 'Review Blobby’s changes', needs_input: 'Needs your input', accepted: 'Branch result accepted',
    canceled: repair.mode === 'native' ? 'Handoff closed' : 'Repair stopped' };
  return <div className="space-y-3">
    <dl className="space-y-1 break-all text-sm"><div><dt className="inline font-semibold">Exact branch: </dt><dd className="inline">{repair.branch.branchName}</dd></div>
      <div><dt className="inline">Branch ID: </dt><dd className="inline">{repair.branch.branchId}</dd></div><div><dt className="inline">Model ID: </dt><dd className="inline">{repair.branch.modelId}</dd></div></dl>
    <div role="status" className="space-y-1 text-sm"><p className="font-semibold">{unverified ? 'Last received repair state' : 'Repair state'}: {statusLabels[repair.status]}</p>
      <p className="flex items-center gap-2">{repair.status === 'running' && repair.mode === 'api' && !unverified && <Loader2 size={16} className="animate-spin motion-reduce:animate-none" />}{unverified ? 'Current outcome is unverified. ' : ''}{repair.progress}</p>
      <p>Shared model unchanged: {unverified || repair.mainUnchanged === undefined ? 'not verified' : repair.mainUnchanged ? 'verified' : 'not confirmed'}.</p>
    </div>
    <p className="text-sm">Source dialect: {repair.sourceDialect || 'Unknown'} · Destination dialect: {repair.targetDialect || 'Unknown'}.</p>
    <details><summary className="cursor-pointer text-sm font-semibold">Reviewed file scope · {repair.scopeFiles.length}</summary><ul className="mt-2 space-y-1 break-all text-sm">{repair.scopeFiles.map(fileName => <li key={fileName}>{fileName}</li>)}</ul></details>
    {repair.findings.length > 0 && <GroupedRepairIssues label="Branch inspection findings" issues={repair.findings.map(finding => ({ code: finding.code, fileName: finding.fileName, warning: finding.severity === 'warning', message: finding.message }))} />}
    {repair.changes.length > 0 && <section className="space-y-2" aria-label="Actual Blobby file changes"><h4 className="font-semibold">Before Blobby → Actual branch now</h4><p className="text-xs text-content-secondary">{reviewedFiles.length}/{repair.changes.length} changed files opened. These are read-back changes, not an AI summary.</p>
      {repair.changes.map(change => <ActualChange key={`${repair.branchHash}:${change.fileName}`} change={change} onReview={() => onReviewFile(change.fileName)} />)}</section>}
    {repair.status === 'needs_input' && !repair.changes.length && <p className="text-sm text-amber-900">No branch changes were confirmed. Review the findings and continue the same scoped session in Omni, then check again.</p>}
    {repair.status === 'review' && !repair.changes.length && <p className="text-sm">No repair changes were found on this branch. Acceptance records the inspected, validated branch state; it does not claim that Blobby authored a change.</p>}
    <div className="space-y-2 rounded border border-border p-3 text-sm"><h4 className="font-semibold">Branch model validation: {unverified ? `Last received: ${validationLabels[repair.validation.status]}; current state unverified` : validationLabels[repair.validation.status]}</h4>
      {repair.validation.message && <p>{repair.validation.message}</p>}{repair.validation.checkedAt && <p className="text-xs">Checked {new Date(repair.validation.checkedAt).toISOString()}</p>}
      {repair.validation.issues.length > 0 && <GroupedRepairIssues label="Model validation findings" issues={repair.validation.issues} />}
      <p className="text-xs text-content-secondary">Model validation is separate from file readback, affected-content checks, warehouse query results, and publication.</p>
    </div>
  </div>;
}

export function GroupedRepairIssues({ label, issues }: { label: string; issues: Array<{ code?: string; fileName?: string; warning: boolean; message: string }> }) {
  type Cause = { count: number; messages: Set<string> };
  const groups = new Map<string, { errors: Map<string, Cause>; warnings: Map<string, Cause> }>();
  for (const issue of issues) {
    const name = issue.fileName || 'General', cause = issue.code || issue.message;
    const group = groups.get(name) || { errors: new Map<string, Cause>(), warnings: new Map<string, Cause>() };
    const category = group[issue.warning ? 'warnings' : 'errors'], finding = category.get(cause) || { count: 0, messages: new Set<string>() };
    finding.count += 1; finding.messages.add(issue.message); category.set(cause, finding); groups.set(name, group);
  }
  return <details open={issues.some(issue => !issue.warning)} className="rounded border border-border p-3"><summary className="cursor-pointer text-sm font-semibold">{label} · {issues.filter(issue => !issue.warning).length} errors/blockers · {issues.filter(issue => issue.warning).length} warnings</summary>
    {[...groups].map(([name, group]) => <section key={name} className="mt-3 space-y-2 text-sm" aria-label={`${label} for ${name}`}><h5 className="break-all font-semibold">{name}</h5>
      {(['errors', 'warnings'] as const).map(kind => group[kind].size > 0 && <div key={kind}><h6 className="font-semibold">{kind === 'errors' ? 'Errors / blockers' : 'Warnings'}</h6><ul className="list-disc space-y-1 pl-5">{[...group[kind]].map(([cause, finding]) => <li key={cause}>{[...finding.messages][0]}{finding.count > 1 && <span className="text-content-secondary"> · {finding.count} related findings</span>}{finding.messages.size > 1 && <details className="mt-1"><summary className="cursor-pointer">Related details</summary><ul className="mt-1 list-disc pl-5">{[...finding.messages].slice(1).map(message => <li key={message}>{message}</li>)}</ul></details>}</li>)}</ul></div>)}
    </section>)}
  </details>;
}

function ActualChange({ change, onReview }: { change: Repair['changes'][number]; onReview: () => void }) {
  const [open, setOpen] = useState(false);
  return <details className="rounded border border-border p-3" onToggle={event => { setOpen(event.currentTarget.open); if (event.currentTarget.open) onReview(); }}><summary className="cursor-pointer break-all text-sm">{change.fileName} · {change.before === null ? 'Created' : change.after === null ? 'Deleted' : 'Changed'}</summary>
    {open && <div className="mt-3"><BlobbyActualFileDiff before={change.before} after={change.after} /></div>}
  </details>;
}

export function BlobbyActualFileDiff({ before, after }: { before: string | null; after: string | null }) {
  const tooLarge = ((before?.split('\n').length || 0) + 1) * ((after?.split('\n').length || 0) + 1) > 2_000_000;
  const lines = useMemo(() => tooLarge ? [] : lineDiff(before || '', after || ''), [before, after, tooLarge]);
  if (tooLarge) return <div className="space-y-2"><p className="text-xs">Full files are shown without line highlighting because this comparison exceeds the aligned-display limit.</p><div className="grid gap-2 lg:grid-cols-2">{[{ label: 'Before Blobby', value: before }, { label: 'Actual branch now', value: after }].map(column => <div key={column.label}><h5 className="mb-1 text-xs font-semibold">{column.label}</h5><pre className="max-h-96 overflow-auto rounded border border-border p-3 text-[11px]">{column.value ?? 'File not present.'}</pre></div>)}</div></div>;
  return <div className="max-h-96 overflow-auto rounded border border-border text-[11px]" role="table" aria-label="Full actual branch changes after Blobby">
    <div className="sticky top-0 grid grid-cols-2 border-b border-border bg-surface-secondary font-semibold" role="row"><div role="columnheader" className="p-2">Before Blobby{before === null ? ' — absent' : ''}</div><div role="columnheader" className="p-2">Actual branch now{after === null ? ' — deleted' : ''}</div></div>
    {lines.map((line, index) => <div key={index} role="row" className="grid grid-cols-2 font-mono"><div role="cell" className={`min-w-0 whitespace-pre-wrap break-words border-r border-border p-1 ${line.type === 'remove' ? 'bg-red-50 text-red-900' : ''}`}>{line.type === 'add' ? '' : `${line.oldLineNumber || ''} ${line.type === 'remove' ? '− ' : '  '}${line.text}`}</div><div role="cell" className={`min-w-0 whitespace-pre-wrap break-words p-1 ${line.type === 'add' ? 'bg-green-50 text-green-900' : ''}`}>{line.type === 'remove' ? '' : `${line.newLineNumber || ''} ${line.type === 'add' ? '+ ' : '  '}${line.text}`}</div></div>)}
    {!lines.length && <p className="p-3 text-content-secondary">No line differences.</p>}
  </div>;
}

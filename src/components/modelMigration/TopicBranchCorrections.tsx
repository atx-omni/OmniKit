import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { lineDiff } from '@/utils/lineDiff';
import { onVaultChanged, onVaultLocked } from '@/services/vaultEvents';
import { applyTopicBranchCorrection, canApplyTopicBranchCorrection, clearTopicBranchCorrectionReference, getTopicBranchCorrection,
  inspectTopicBranchCorrection, prepareTopicBranchCorrection, readTopicBranchCorrectionReference, saveTopicBranchCorrectionReference,
  TOPIC_BRANCH_CORRECTION_DRAFT_KEY, topicBranchCorrectionReport, type TopicBranchCorrectionAction } from '@/services/topicBranchCorrection';
import type { TopicBranchCorrectionPlan, TopicBranchValidation } from '../../../shared/topicBranchCorrection';
import type { TopicMigrationFile } from '../../../shared/topicMigration';

const POLL_INTERVAL_MS = 2000;
const POLL_LIMIT = 30;
type Action = 'prepare' | 'apply' | 'check' | TopicBranchCorrectionAction;
const progressLabels: Record<Action, string> = { prepare: 'Reading this branch and current correction evidence…', apply: 'Starting approved branch corrections…',
  check: 'Checking saved correction result…', reconcile: 'Reading the branch to classify interrupted writes…', validate: 'Validating this branch model…',
  'content-validation': 'Validating affected content for this branch…', cancel: 'Stopping remaining correction work…' };

function safeOmniUrl(value?: string) {
  try { const url = new URL(value || ''); return url.protocol === 'https:' && !url.username && !url.password ? url.origin : undefined; } catch { return undefined; }
}

export function TopicBranchCorrections({ originPlanId, targetLabel, destinationUrl, disabled }: {
  originPlanId: string; targetLabel: string; destinationUrl?: string; disabled: boolean;
}) {
  const [correction, setCorrection] = useState<TopicBranchCorrectionPlan | null>(null);
  const [referenceId, setReferenceId] = useState<string>();
  const [busy, setBusy] = useState<Action | null>(null);
  const [approved, setApproved] = useState(false);
  const [fresh, setFresh] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState('');
  const [unverified, setUnverified] = useState(false);
  const [pollPaused, setPollPaused] = useState(false);
  const [pollCycle, setPollCycle] = useState(0);
  const [reconciled, setReconciled] = useState(false);
  const [expired, setExpired] = useState(false);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const actionInFlight = useRef(false);
  const disabledRef = useRef(disabled); disabledRef.current = disabled;
  const previousOrigin = useRef(originPlanId);

  function accept(result: TopicBranchCorrectionPlan, expectedId?: string) {
    if (result.originPlanId !== originPlanId || (expectedId && result.id !== expectedId)
      || result.branch.modelId !== result.request.targetModelId) throw new Error('This response does not match the selected branch review. Check the saved result.');
    setCorrection(result); setReferenceId(result.id); saveTopicBranchCorrectionReference(result); setUnverified(false);
  }

  useEffect(() => {
    const invalidate = () => {
      generation.current += 1; controller.current?.abort(); actionInFlight.current = false;
      setCorrection(null); setReferenceId(undefined); setApproved(false); setFresh(false); setAttempted(false);
      setBusy(null); setError(''); setPollPaused(false); clearTopicBranchCorrectionReference();
    };
    const stopLock = onVaultLocked(invalidate), stopChange = onVaultChanged(invalidate);
    return () => { stopLock(); stopChange(); generation.current += 1; controller.current?.abort(); };
  }, []);

  useEffect(() => {
    const changed = previousOrigin.current !== originPlanId; previousOrigin.current = originPlanId;
    if (changed) clearTopicBranchCorrectionReference();
    const revision = ++generation.current;
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    setApproved(false); setFresh(false); setCorrection(null); setAttempted(false); setReferenceId(undefined); setError('');
    setReconciled(false); setUnverified(false); setBusy(null); actionInFlight.current = false;
    let reference = null;
    try { reference = readTopicBranchCorrectionReference(localStorage.getItem(TOPIC_BRANCH_CORRECTION_DRAFT_KEY), originPlanId); } catch { /* Optional reference storage. */ }
    if (!reference || disabled) return;
    setReferenceId(reference.id); setBusy('check'); actionInFlight.current = true;
    void getTopicBranchCorrection(reference.id, abort.signal).then(result => {
      if (revision !== generation.current || abort.signal.aborted) return;
      accept(result.correction, reference.id);
    }).catch(reason => {
      if (revision !== generation.current || abort.signal.aborted) return;
      setError(reason instanceof Error ? reason.message : 'Saved corrections could not be read.'); setUnverified(true);
    }).finally(() => {
      if (revision === generation.current) { setBusy(null); actionInFlight.current = false; }
    });
    return () => { abort.abort(); generation.current += 1; };
    // Restoration is a read of the durable reference, never a new approval or automatic write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [originPlanId, disabled]);

  const correctionId = correction?.id, correctionStatus = correction?.status;
  useEffect(() => {
    if (!correctionId || correctionStatus !== 'running' || disabled || busy || pollPaused) return;
    const abort = new AbortController(); const revision = generation.current;
    let attempts = 0; let timer: ReturnType<typeof setTimeout>;
    const deadlineTimer = setTimeout(() => { abort.abort(); setPollPaused(true); }, POLL_INTERVAL_MS * POLL_LIMIT);
    const poll = async () => {
      if (abort.signal.aborted || revision !== generation.current || disabledRef.current) return;
      try {
        const result = await getTopicBranchCorrection(correctionId, abort.signal);
        if (abort.signal.aborted || revision !== generation.current) return;
        accept(result.correction, correctionId);
        if (result.correction.status !== 'running') return;
        attempts += 1;
        if (attempts >= POLL_LIMIT) { setPollPaused(true); return; }
        timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
      } catch (reason) {
        if (abort.signal.aborted || revision !== generation.current) return;
        setError(reason instanceof Error ? reason.message : 'Correction updates disconnected.');
        setUnverified(true); setPollPaused(true); setApproved(false);
      }
    };
    timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    return () => { abort.abort(); clearTimeout(timer); clearTimeout(deadlineTimer); };
    // Status/id drive this bounded loop; each snapshot does not restart its polling budget.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [correctionId, correctionStatus, disabled, busy, pollCycle, pollPaused]);

  useEffect(() => {
    const expiry = correction?.expiresAt;
    setExpired(Boolean(expiry && expiry <= Date.now()));
    if (!expiry || expiry <= Date.now()) return;
    const timer = setTimeout(() => { setExpired(true); setApproved(false); }, Math.min(expiry - Date.now(), 2_147_483_647));
    return () => clearTimeout(timer);
  }, [correction?.expiresAt]);

  async function run(action: Action) {
    if (disabled || actionInFlight.current || (action !== 'prepare' && !referenceId)) return;
    if (action === 'apply' && (!correction || !canApplyTopicBranchCorrection(correction, approved, fresh, attempted) || unverified)) return;
    actionInFlight.current = true; controller.current?.abort();
    const abort = new AbortController(); controller.current = abort; const revision = ++generation.current;
    setBusy(action); setError(''); setApproved(false);
    if (action === 'apply') { setAttempted(true); setFresh(false); }
    try {
      const result = action === 'prepare' ? await prepareTopicBranchCorrection(originPlanId, referenceId, abort.signal)
        : action === 'apply' ? await applyTopicBranchCorrection(correction!, abort.signal)
          : action === 'check' ? await getTopicBranchCorrection(referenceId!, abort.signal)
            : await inspectTopicBranchCorrection(referenceId!, action, abort.signal);
      if (revision !== generation.current || abort.signal.aborted || disabledRef.current) return;
      accept(result.correction, action === 'prepare' ? undefined : referenceId);
      if (action === 'prepare') { setFresh(true); setAttempted(false); setReconciled(false); }
      if (action === 'reconcile') setReconciled(true);
      setPollPaused(false); setPollCycle(value => value + 1);
    } catch (reason) {
      if (revision !== generation.current || abort.signal.aborted) return;
      setError(`${reason instanceof Error ? reason.message : 'The request could not be completed.'}${action === 'apply' ? ' Check result before any further action; a disconnected response does not prove that writes stopped.' : ''}`);
      if (action !== 'prepare') setUnverified(true);
      setFresh(false); setPollPaused(true);
    } finally {
      if (revision === generation.current) { setBusy(null); actionInFlight.current = false; }
    }
  }

  function exportSummary() {
    if (!correction) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify({ ...topicBranchCorrectionReport(correction), snapshotUnverified: unverified }, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `branch-corrections-${correction.id}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const locked = disabled || Boolean(busy);
  const running = correction?.status === 'running';
  const recovery = correction?.status === 'partial' || correction?.status === 'uncertain';
  const canRecheck = !running && !unverified && (!recovery || (reconciled && correction.status !== 'uncertain'
    && !correction.outcomes.some(item => item.status === 'unknown' || item.status === 'writing')));
  const applyReady = correction && !locked && !unverified && !expired && canApplyTopicBranchCorrection(correction, approved, fresh, attempted);
  const canValidate = correction && !running && !unverified && (correction.filesVerified || correction.status === 'unchanged');
  const omniUrl = safeOmniUrl(destinationUrl);

  return <section className="space-y-4 rounded-card border border-border p-4" aria-label="Existing branch corrections">
    <h3 className="font-semibold">Correct this review branch</h3>
    <p className="text-sm text-content-secondary">Review supported table and SQL corrections for the existing branch in {targetLabel}. The outcome above records the original preparation; correction results are reported separately below. This separate approval updates only the reviewed files on that branch.</p>
    <button className="btn-primary" disabled={locked || !canRecheck} onClick={() => void run('prepare')}>{correction || referenceId ? 'Recheck branch corrections' : 'Review branch corrections'}</button>
    {busy && <p role="status" className="flex items-center gap-2 text-sm"><Loader2 size={16} className="animate-spin motion-reduce:animate-none" />{progressLabels[busy]}</p>}
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    {referenceId && <button className="btn-secondary" disabled={locked} onClick={() => void run('check')}>Check result</button>}
    {correction && <>
      <TopicBranchCorrectionReview correction={correction} unverified={unverified} />
      {!fresh && correction.status === 'ready' && <p className="text-sm text-amber-900">Saved review restored without approval. Recheck branch corrections before approving a new review.</p>}
      {expired && ['ready', 'blocked'].includes(correction.status) && <p className="text-sm text-amber-900">This review expired. Recheck branch corrections to review current branch evidence and approve a fresh package.</p>}
      {fresh && correction.status === 'ready' && <div className="space-y-3">
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={approved} disabled={locked || expired || unverified || attempted} onChange={event => setApproved(event.target.checked)} />I reviewed these exact changes to branch {correction.branch.branchName}. Apply them once to this review branch.</label>
        <button className="btn-primary" disabled={!applyReady} onClick={() => void run('apply')}>Update this review branch</button>
      </div>}
      {running && <button className="btn-secondary" disabled={locked} onClick={() => void run('cancel')}>Stop remaining corrections</button>}
      {(pollPaused || unverified) && <p className="text-sm text-amber-900">Automatic checks stopped. Check result for the saved outcome; work may still be running. Do not repeat the update.</p>}
      {recovery && <div className="space-y-2"><p className="text-sm text-amber-900">Some writes are partial or unconfirmed. Reconcile the branch first, then request a fresh review of remaining differences and approve it separately.</p><button className="btn-secondary" disabled={locked || unverified} onClick={() => void run('reconcile')}>Reconcile branch result</button></div>}
      <div className="flex flex-wrap gap-2">
        <button className="btn-secondary" disabled={locked || !canValidate} onClick={() => void run('validate')}>Validate branch model</button>
        <button className="btn-secondary" disabled={locked || !canValidate} onClick={() => void run('content-validation')}>Validate affected content</button>
        <button className="btn-secondary" disabled={locked} onClick={exportSummary}>Export correction summary</button>
        {omniUrl && <a className="btn-secondary" href={omniUrl} target="_blank" rel="noopener noreferrer">Open Omni</a>}
      </div>
      <p className="text-xs text-content-secondary">Model validation runs once after all correction files are verified. Content validation runs only when requested. In Omni, select the exact branch above and test representative queries and access behavior before publication. Stopping work is not rollback.</p>
    </>}
  </section>;
}

export function TopicBranchCorrectionReview({ correction, unverified = false }: { correction: TopicBranchCorrectionPlan; unverified?: boolean }) {
  const applied = correction.outcomes.filter(item => item.status === 'applied').length;
  return <div className="space-y-3">
    <dl className="space-y-1 break-all text-sm"><div><dt className="inline font-semibold">Exact branch: </dt><dd className="inline">{correction.branch.branchName}</dd></div>
      <div><dt className="inline">Branch ID: </dt><dd className="inline">{correction.branch.branchId}</dd></div><div><dt className="inline">Model ID: </dt><dd className="inline">{correction.branch.modelId}</dd></div></dl>
    <div role="status" className="space-y-1 text-sm"><p className="font-semibold">{unverified ? 'Last received correction outcome' : 'Correction outcome'}: {correction.status}</p>
      <p>{unverified ? 'Current outcome is unverified. ' : ''}{correction.progress}</p>
      <p>{applied}/{correction.outcomes.length} files recorded as applied · {correction.noops} unchanged. Unchanged files may still have findings without a supported automatic correction.</p>
      {correction.status === 'running' && !unverified && <progress className="h-2 w-full" value={applied} max={Math.max(correction.outcomes.length, 1)} aria-label="Correction files recorded as applied" />}
      <p>File readback: {unverified ? 'current state unverified' : correction.filesVerified ? 'verified' : 'not verified'}. Shared model unchanged: {unverified || correction.mainUnchanged === undefined ? 'not verified' : correction.mainUnchanged ? 'verified' : 'not confirmed'}.</p>
      <p>These corrections do not publish the model or change the original preparation outcome.</p>
    </div>
    <p className="text-sm">SQL compatibility: {correction.sourceDialect || 'Unknown source'} → {correction.targetDialect || 'Unknown destination'}. Unsupported expressions remain for review in Omni.</p>
    {correction.issues.length > 0 && <details open={correction.issues.some(issue => issue.severity === 'blocker')} className="rounded border border-border p-3"><summary className="cursor-pointer text-sm font-semibold">{correction.issues.filter(issue => issue.severity === 'blocker').length} blockers · {correction.issues.filter(issue => issue.severity !== 'blocker').length} follow-ups</summary>
      <ul className="mt-2 space-y-2 text-sm">{correction.issues.map((issue, index) => <li key={index}><h5 className="font-semibold">{issue.severity}: {issue.title}</h5>{issue.fileName && <p className="break-all">{issue.fileName}</p>}<p>{issue.message}</p>{issue.severity === 'blocker' && issue.nextAction && <div className="mt-2"><h6 className="font-semibold">Next action</h6><p>{issue.nextAction}</p></div>}</li>)}</ul></details>}
    <h4 className="text-sm font-semibold">Current branch → Proposed corrections</h4>
    {correction.files.map(file => <CorrectionFile key={file.fileName} file={file} />)}
    {correction.outcomes.length > 0 && <details><summary className="cursor-pointer text-sm font-semibold">Correction file outcomes</summary><ul className="mt-2 space-y-1 text-sm">{correction.outcomes.map(item => <li className="break-all" key={item.fileName}>{item.fileName} · {item.status}</li>)}</ul></details>}
    <ValidationResult label="Branch model validation" result={correction.validation} unverified={unverified} />
    <ValidationResult label="Affected content validation" result={correction.contentValidation} unverified={unverified} />
  </div>;
}

function CorrectionFile({ file }: { file: TopicMigrationFile }) {
  const [open, setOpen] = useState(false);
  return <details className="rounded border border-border p-3" onToggle={event => setOpen(event.currentTarget.open)}><summary className="cursor-pointer break-all text-sm">{file.destinationFileName || file.fileName} · {file.status === 'reuse' ? file.sqlDialectReview?.findings.length ? 'Unchanged — no supported automatic correction' : 'Already corrected' : file.status === 'blocked' ? 'Blocked' : 'Proposed correction'}</summary>
    {open && <div className="mt-3"><TopicBranchCorrectionDiff before={file.before} after={file.proposed} /></div>}
  </details>;
}

export function TopicBranchCorrectionDiff({ before, after }: { before: string | null; after: string }) {
  const tooLarge = ((before?.split('\n').length || 0) + 1) * (after.split('\n').length + 1) > 2_000_000;
  const lines = useMemo(() => tooLarge ? [] : lineDiff(before || '', after), [before, after, tooLarge]);
  if (tooLarge) return <div className="space-y-2"><p className="text-xs text-content-secondary">Full files are shown without line highlighting because this comparison exceeds the aligned-display limit.</p>
    <div className="grid gap-2 lg:grid-cols-2">{[{ label: 'Current branch', value: before }, { label: 'Proposed corrections', value: after }].map(column => <div key={column.label}><h5 className="mb-1 text-xs font-semibold">{column.label}</h5><pre className="max-h-96 overflow-auto rounded border border-border p-3 text-[11px]">{column.value ?? 'Not present on this branch.'}</pre></div>)}</div></div>;
  return <div className="max-h-96 overflow-auto rounded border border-border text-[11px]" role="table" aria-label="Current branch and proposed corrections diff">
    <div className="sticky top-0 grid grid-cols-2 border-b border-border bg-surface-secondary font-semibold" role="row"><div role="columnheader" className="p-2">Current branch</div><div role="columnheader" className="p-2">Proposed corrections</div></div>
    {lines.map((line, index) => <div key={index} role="row" className="grid grid-cols-2 font-mono">
      <div role="cell" className={`flex min-w-0 gap-2 border-r border-border px-2 py-0.5 ${line.type === 'remove' ? 'bg-red-50 text-red-900' : 'text-content-secondary'}`}><span className="w-8 shrink-0 text-right">{line.oldLineNumber}</span><span className="whitespace-pre-wrap break-words">{line.type === 'add' ? '' : `${line.type === 'remove' ? '− ' : '  '}${line.text}`}</span></div>
      <div role="cell" className={`flex min-w-0 gap-2 px-2 py-0.5 ${line.type === 'add' ? 'bg-green-50 text-green-900' : 'text-content-secondary'}`}><span className="w-8 shrink-0 text-right">{line.newLineNumber}</span><span className="whitespace-pre-wrap break-words">{line.type === 'remove' ? '' : `${line.type === 'add' ? '+ ' : '  '}${line.text}`}</span></div>
    </div>)}
    {!lines.length && <p className="p-3 text-content-secondary">Both files are empty.</p>}
  </div>;
}

function ValidationResult({ label, result, unverified }: { label: string; result: TopicBranchValidation; unverified: boolean }) {
  const labels = { not_run: 'Not run', passed: 'Passed', issues: 'Issues found', unavailable: 'Unavailable — not validated' };
  const files = new Map<string, { errors: string[]; warnings: string[] }>();
  for (const issue of result.issues) {
    const name = issue.fileName || 'General validation';
    const group = files.get(name) || { errors: [], warnings: [] };
    group[issue.warning ? 'warnings' : 'errors'].push(issue.message); files.set(name, group);
  }
  return <div className="rounded border border-border p-3 text-sm"><p className="font-semibold">{label}: {unverified ? `Last received: ${labels[result.status]}; current state unverified` : labels[result.status]}</p>
    {result.message && <p className="mt-1">{result.message}</p>}{result.checkedAt && <p className="mt-1 text-xs">Checked {new Date(result.checkedAt).toISOString()}</p>}
    {[...files].map(([fileName, group]) => <section className="mt-3 space-y-2 rounded border border-border p-3" key={fileName} aria-label={`${label} findings for ${fileName}`}>
      <h5 className="break-all font-semibold">{fileName}</h5>
      {(['errors', 'warnings'] as const).map(kind => group[kind].length > 0 && <div key={kind}><h6 className="font-semibold">{kind === 'errors' ? 'Errors' : 'Warnings'} · {group[kind].length}</h6>
        <ul className="mt-1 list-disc space-y-1 pl-5">{group[kind].map((message, index) => <li key={index}>{message}</li>)}</ul></div>)}
    </section>)}
  </div>;
}

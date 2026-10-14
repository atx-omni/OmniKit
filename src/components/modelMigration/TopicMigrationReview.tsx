import { useState } from 'react';
import { DashboardRepairFileDiff } from '@/components/dashboardMigration/DashboardTopicRepairReview';
import { canChooseTopicDestinationDefinitions } from '@/services/topicMigrationFlow';
import type { TopicMigrationFile, TopicMigrationPlan, TopicMigrationRequest } from '../../../shared/topicMigration';

const action = { create: 'New file', add: 'Additions', reuse: 'Already present', blocked: 'Conflict' };

export function TopicMigrationComparisonNotice({ plan, disabled, onOpenRun }: {
  plan: TopicMigrationPlan; disabled: boolean; onOpenRun: (planId: string) => void;
}) {
  if (!plan.comparisonOnly) return null;
  return <div role="status" className="card space-y-3 p-4">
    <strong>Fresh comparison — no new writes authorized</strong>
    <p className="text-sm text-content-secondary">These differences use current source and destination definitions and current compatibility rules. They do not change or replace the existing branch. The prior approval remains consumed, even if its copied files were verified.</p>
    <p className="text-sm">Review the new differences below. Open the saved run to inspect its outcome; this comparison cannot create another branch or replay writes.</p>
    {plan.comparisonOnly.priorRuns.map(run => <div key={run.planId} className="flex flex-wrap items-center gap-2 text-sm">
      <span className="break-all">Prior review branch: {run.branchName}</span>
      <button className="btn-secondary" disabled={disabled} onClick={() => onOpenRun(run.planId)}>Open saved run</button>
    </div>)}
  </div>;
}

export function TopicMigrationReview({ plan, disabled = false, onKeepDestination }: {
  plan: TopicMigrationPlan; disabled?: boolean; onKeepDestination?: (sourceFileName: string, keep: boolean) => void;
}) {
  const [search, setSearch] = useState('');
  const [showUnchanged, setShowUnchanged] = useState(false);
  const corrections = plan.files.filter(file => file.tableNameCorrection && file.status !== 'blocked');
  const dialectCorrections = plan.files.filter(file => file.status !== 'blocked').reduce((total, file) => total + (file.sqlDialectReview?.corrections.length || 0), 0);
  const dialectFindings = plan.files.reduce((total, file) => total + (file.sqlDialectReview?.findings.length || 0), 0);
  const preserved = plan.files.filter(file => file.destinationPreservation);
  const editable = Boolean(onKeepDestination && !plan.dashboardRepair && !plan.comparisonOnly && plan.status !== 'submitted' && !plan.jobId);
  const files = plan.files.filter(file => (showUnchanged || file.status !== 'reuse' || file.destinationPreservation)
    && [file.sourceFileName, file.fileName, file.destinationFileName || ''].some(name => name.toLowerCase().includes(search.toLowerCase())));
  return <section className="space-y-3" aria-label="Proposed topic changes">
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{(['create', 'add', 'reuse', 'blocked'] as const).map(status => <div className="rounded-card border border-border p-3" key={status}><p className="text-xl font-semibold">{plan.files.filter(file => file.status === status).length}</p><p className="text-sm text-content-secondary">{action[status]}</p></div>)}</div>
    {!plan.sqlDialectPolicy && !corrections.length && !plan.dashboardRepair && <p className="rounded-card border border-border p-3 text-sm">These additions preserve the reviewed definitions and location mappings, including any explicit choices to keep destination definitions. After branch preparation, Blobby can adapt the scoped files for the destination. Review its actual branch changes and validation separately.</p>}
    {preserved.length > 0 && <p role="status" className="rounded-card border border-amber-200 bg-amber-50 p-3 text-sm">Destination definitions retained for {preserved.length} view{preserved.length === 1 ? '' : 's'}. Only missing items are proposed as additions. Retaining destination behavior does not prove equivalence to the source; review dependent topics and validate results.</p>}
    {corrections.length > 0 && <p role="status" className="rounded-card border border-border p-3 text-sm">{corrections.length} table name{corrections.length === 1 ? '' : 's'} matched to destination spelling. These case-only corrections are included in the reviewed differences. SQL, columns, and query behavior still need validation in Omni.</p>}
    {plan.sqlDialectPolicy && <div role="status" className="rounded-card border border-border p-3 text-sm">
      <p className="font-semibold">SQL compatibility · {plan.sqlDialectPolicy.sourceDialect || 'Unknown source'} → {plan.sqlDialectPolicy.targetDialect || 'Unknown destination'}</p>
      <p>{dialectCorrections} supported identifier {dialectCorrections === 1 ? 'fix' : 'fixes'} included in the diff · {dialectFindings} compatibility {dialectFindings === 1 ? 'finding needs' : 'findings need'} review.</p>
      <p className="mt-1 text-content-secondary">This saved package records the earlier identifier-only compatibility check. Complex or unsupported SQL stays unchanged. This is not full SQL or query validation. New branch repairs use the separate Blobby review; the saved package and approval remain unchanged.</p>
    </div>}
    <label className="block text-sm">Find a change<input className="input-field mt-1 w-full" value={search} onChange={event => setSearch(event.target.value)} placeholder="View, topic, or file name" /></label>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={showUnchanged} onChange={event => setShowUnchanged(event.target.checked)} />Show unchanged definitions</label>
    {files.map(file => <TopicMigrationFileReview file={file} plan={plan} disabled={disabled} onKeepDestination={editable ? onKeepDestination : undefined} key={`${plan.revision}:${file.fileName}`} />)}
    {!files.length && <p className="text-sm text-content-secondary">No changes match this filter. Filtering does not change migration scope.</p>}
    <details className="rounded-card border border-border p-3"><summary className="cursor-pointer text-sm font-semibold">Included automatically · {plan.dependencies.length} dependencies</summary>
      <ul className="mt-3 space-y-3">{plan.dependencies.map(item => <li key={item.fileName} className="text-sm"><p className="break-all font-medium">{item.fileName}</p><p className="text-content-secondary">{item.reasons.join(' · ')}</p><p className="text-xs text-content-tertiary">Required by {item.topicIds.map(id => plan.topics.find(topic => topic.id === id)?.name || id).join(', ')}</p></li>)}</ul>
    </details>
  </section>;
}

function TopicMigrationFileReview({ file, plan, disabled, onKeepDestination }: {
  file: TopicMigrationFile; plan: TopicMigrationPlan; disabled: boolean; onKeepDestination?: (sourceFileName: string, keep: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const destinationFileName = file.destinationFileName || file.fileName;
  const candidate = canChooseTopicDestinationDefinitions(plan, file);
  return <details className="rounded-card border border-border p-3" onToggle={event => setOpen(event.currentTarget.open)}><summary className="cursor-pointer text-sm"><span className="font-semibold">{file.destinationPreservation && file.status === 'reuse' ? 'Destination retained' : action[file.status]}</span> · <span className="break-all">{file.sourceFileName}{file.sourceFileName !== destinationFileName && <> → {destinationFileName}</>}</span>{candidate && !file.destinationPreservation && <span className="block text-xs text-content-secondary">Destination-preserving option available after reviewing this file</span>}</summary>
    {file.sourceFileName !== destinationFileName && <p className="mt-2 break-all text-xs text-content-secondary">Source path → destination path. This path mapping is part of the exact reviewed package.</p>}
    {file.destinationPreservation && <DestinationPreservationSummary preservation={file.destinationPreservation} />}
    {file.tableNameCorrection && <p className="mt-2 break-all text-xs text-content-secondary">Destination table spelling: {file.tableNameCorrection.namespace}.{file.tableNameCorrection.from} → {file.tableNameCorrection.to}. Only the table-name case changes.</p>}
    {file.sqlDialectReview && (file.sqlDialectReview.corrections.length > 0 || file.sqlDialectReview.findings.length > 0) && <div className="mt-2 text-xs text-content-secondary">
      <p>{file.sqlDialectReview.corrections.length} identifier fixes · {file.sqlDialectReview.findings.length} compatibility findings to review.</p>
      {open && <details className="mt-2"><summary className="cursor-pointer">SQL compatibility details</summary><ul className="mt-2 max-h-64 space-y-1 overflow-auto">
        {file.sqlDialectReview.corrections.map(item => <li key={item.path}>{item.path}: <code>{item.from}</code> → <code>{item.to}</code></li>)}
        {file.sqlDialectReview.findings.map(item => <li key={item.path}>{item.path}: {item.reason}</li>)}
      </ul></details>}
    </div>}
    {open && <div className="mt-3 space-y-3">{candidate && !file.destinationPreservation && <p className="text-xs text-content-secondary">Inspect the current destination and incoming comparison first. Choosing to keep destination definitions will generate a fresh diff; this blocked comparison is not approval to overwrite them.</p>}<DashboardRepairFileDiff before={file.before} after={file.proposed} />
      {candidate && !file.destinationPreservation && onKeepDestination && <TopicDestinationPreservationChoice fileName={destinationFileName} inspected={open} disabled={disabled} onChoose={() => onKeepDestination(file.sourceFileName, true)} />}
      {file.destinationPreservation && onKeepDestination && <button className="btn-secondary text-sm" disabled={disabled} onClick={() => onKeepDestination(file.sourceFileName, false)}>Review without this choice</button>}
    </div>}
  </details>;
}

export function TopicDestinationPreservationChoice({ fileName, inspected, disabled, onChoose }: {
  fileName: string; inspected: boolean; disabled: boolean; onChoose: () => void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  return <div className="space-y-3 rounded border border-border p-3" aria-label={`Keep destination definitions for ${fileName}`}>
    <h4 className="font-semibold">Keep destination definitions; add only missing items</h4>
    <p className="text-sm">Keep this view’s existing field definitions and properties intact. Add only complete missing fields; do not fill gaps inside an existing field. This choice does not prove that the source and destination behave equivalently.</p>
    <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} disabled={disabled || !inspected} onChange={event => setConfirmed(event.target.checked)} />I inspected this view’s current destination definition and incoming differences.</label>
    <button className="btn-secondary" disabled={disabled || !inspected || !confirmed} onClick={() => { if (!disabled && inspected && confirmed) onChoose(); }}>Keep destination definitions and recheck</button>
    <p className="text-xs text-content-secondary">This chooses a review policy for this view only. Rechecking reads current evidence and resets branch-preparation approval; it writes no model files.</p>
  </div>;
}

export function DestinationPreservationSummary({ preservation }: { preservation: NonNullable<TopicMigrationFile['destinationPreservation']> }) {
  return <div className="mt-2 space-y-2 rounded border border-border p-3 text-sm"><h4 className="font-semibold">Destination definitions retained</h4>
    <p>{preservation.keptPaths.length} retained paths · {preservation.addedPaths.length} missing items proposed as additions.</p>
    <details><summary className="cursor-pointer text-xs font-semibold">Retained versus added items</summary><div className="mt-2 grid gap-3 md:grid-cols-2"><div><h5 className="font-semibold">Retained from destination</h5><ul className="mt-1 space-y-1 break-all">{preservation.keptPaths.map(path => <li key={path}>{path}</li>)}</ul></div><div><h5 className="font-semibold">Missing items added from source</h5>{preservation.addedPaths.length ? <ul className="mt-1 space-y-1 break-all">{preservation.addedPaths.map(path => <li key={path}>{path}</li>)}</ul> : <p>No missing items to add.</p>}</div></div></details>
    {Boolean(preservation.omittedSourcePaths?.length) && <details><summary className="cursor-pointer text-xs font-semibold">Source properties not copied · {preservation.omittedSourcePaths!.length}</summary><ul className="mt-2 space-y-1 break-all">{preservation.omittedSourcePaths!.map(path => <li key={path}>{path}</li>)}</ul><p className="mt-2 text-xs text-content-secondary">These source-only properties are intentionally excluded to retain complete destination definitions. Review their effect on business behavior.</p></details>}
    <p className="text-xs text-content-secondary">This preserves existing destination definitions. It does not establish source equivalence or successful queries.</p>
  </div>;
}

export function TopicMigrationScopeSummary({ request, sourceLabel, targetLabel }: { request: TopicMigrationRequest; sourceLabel?: string; targetLabel?: string }) {
  return <section className="rounded-card border border-border p-4" aria-label="Exact preparation scope">
    <h3 className="text-sm font-semibold">Confirm the exact source and destination</h3>
    <div className="mt-3 grid gap-4 md:grid-cols-2">{(['source', 'target'] as const).map(side => <div key={side} className="min-w-0 text-sm">
      <h4 className="font-semibold">{side === 'source' ? 'Source' : 'Destination'}</h4>
      <dl className="mt-1 space-y-1 break-all"><div><dt className="inline text-content-secondary">Instance: </dt><dd className="inline">{side === 'source' ? sourceLabel : targetLabel} <span className="text-xs">{request[`${side}InstanceId`]}</span></dd></div>
        <div><dt className="inline text-content-secondary">Connection ID: </dt><dd className="inline">{request[`${side}ConnectionId`]}</dd></div>
        <div><dt className="inline text-content-secondary">Model ID: </dt><dd className="inline">{request[`${side}ModelId`]}</dd></div></dl>
    </div>)}</div>
  </section>;
}

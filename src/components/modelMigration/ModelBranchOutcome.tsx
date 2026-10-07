import type { MigrationJob } from '@/services/opsConsole';
import { createdReviewBranch, latestBranchVerification, MIGRATION_HISTORY_BLOCKED_MESSAGE, preparedBranchReceipt, reconciledBranchFilesNotApplied, topicJobPhase, topicJobProgress } from '@/services/topicMigrationFlow';

function safeOmniUrl(value?: string): string | undefined {
  try { const url = new URL(value || ''); return url.protocol === 'https:' && !url.username && !url.password ? url.origin : undefined; } catch { return undefined; }
}

const driftFindingLabels: Record<string, string> = {
  SOURCE_MODEL_CHANGED: 'Source changed since approval',
  DESTINATION_FILE_ADDED: 'Destination file added',
  DESTINATION_FILE_REMOVED: 'Destination file removed',
  DESTINATION_FILE_CHANGED: 'Destination file changed',
  DESTINATION_CHANGES_TRUNCATED: 'Additional destination changes are not listed',
  DESTINATION_CHECKSUM_CHANGED: 'Destination checksum changed',
  APPROVED_AUTHORITY_CHANGED: 'Approved authority changed',
};

export function ModelBranchOutcome({ job, bound, streamError, historyUnavailable = false, destinationUrl, onVerify, verifying = false, verifyDisabled = false }: { job: MigrationJob; bound: boolean; streamError: boolean; historyUnavailable?: boolean; destinationUrl?: string; onVerify?: () => void; verifying?: boolean; verifyDisabled?: boolean }) {
  const outcomeUnverified = historyUnavailable || streamError;
  const lastVerified = bound ? preparedBranchReceipt(job) : null;
  const receipt = !outcomeUnverified ? lastVerified : null;
  const lastVerification = bound ? latestBranchVerification(job) : null;
  const branchRead = Boolean(lastVerification?.actualHash);
  // Older unsuccessful records could contain placeholder mismatches despite no branch read.
  const comparedFiles = branchRead ? lastVerification?.files || [] : [];
  const mismatches = comparedFiles.filter(file => file.classification === 'mismatch').length;
  const matches = comparedFiles.length - mismatches;
  const sourceChanged = lastVerification?.findings.some(finding => finding.code === 'SOURCE_MODEL_CHANGED');
  const destinationChanged = lastVerification?.findings.some(finding => finding.code.startsWith('DESTINATION_') && driftFindingLabels[finding.code]);
  const comparisonNeedsReview = Boolean(lastVerification && !lastVerification.verified);
  const comparisonHeading = !branchRead ? 'Branch comparison unavailable — review required'
    : !comparedFiles.length ? 'Branch read — file comparison incomplete'
      : mismatches ? 'Copied-file differences — review required' : 'Copied files match — overall review required';
  const verificationCount = bound && Array.isArray(job.details?.branchVerifications) ? job.details.branchVerifications.length : 0;
  const created = bound ? createdReviewBranch(job) : null;
  const lastReconciled = bound ? reconciledBranchFilesNotApplied(job) : null;
  const reconciled = !outcomeUnverified ? lastReconciled : null;
  const branchName = receipt?.branchName || created?.branchName || lastVerified?.branchName;
  const omniUrl = bound ? safeOmniUrl(destinationUrl) : undefined;
  const { completed, total } = topicJobProgress(job);
  return <div className="space-y-4 rounded-card border border-border p-4" aria-live="polite">
    {!bound && <p role="alert" className="text-sm text-red-700">This run is not bound to the current reviewed destination. Check the saved run before taking action.</p>}
    <h3 className="font-semibold">{historyUnavailable ? created && !lastVerified ? 'Branch created — copied files unverified' : 'Preparation blocked — history unavailable' : streamError ? 'Connection lost — outcome unverified' : comparisonNeedsReview ? comparisonHeading : bound ? topicJobPhase(job) : 'Historical run — scope not verified'}</h3>
    <p className="text-sm text-content-secondary">{outcomeUnverified ? `Last received: ${completed}/${total} steps completed. Current outcome is unverified.` : `${verificationCount ? 'Original preparation: ' : ''}${completed}/${total} steps completed`}</p>
    {!outcomeUnverified && <progress className="h-2 w-full accent-[#86234f]" max={Math.max(total, 1)} value={completed} aria-label="Branch preparation steps completed" />}
    {historyUnavailable ? <p role="alert" className="text-sm text-red-700">{MIGRATION_HISTORY_BLOCKED_MESSAGE}</p> : streamError && <p className="text-sm text-amber-900">Live updates disconnected. Check the saved run; do not assume the work stopped.</p>}
    {outcomeUnverified && (created || lastVerified) && <p className="text-sm">{lastReconciled
      ? 'The last received snapshot recorded that the reviewed file write was reconciled as not applied. This is historical evidence; the current branch state is unverified.' : lastVerified
      ? 'The last received snapshot confirmed the branch and copied-file verification. This is historical evidence, not a verified current receipt.'
      : 'The last received snapshot confirmed branch creation, but the copied files were not verified. The current branch state is unverified.'}</p>}
    {branchName && <p className="break-all text-sm"><strong>{outcomeUnverified ? 'Last received review branch:' : 'Review branch:'}</strong> {branchName}</p>}
    {receipt && <p className="text-sm">The approved file additions were read back from this branch. They are not published or validated for warehouse queries.</p>}
    {verificationCount > 0 && <div className="space-y-2 rounded border border-border p-3 text-sm">
      <p className="font-semibold">{outcomeUnverified ? 'Last received verification attempts' : 'Separate verification attempts'}: {verificationCount}</p>
      <p>{outcomeUnverified ? 'These are historical verification records, not a current receipt.' : lastVerification?.verified ? 'The latest read-only verification passed. The original run status and failed step remain unchanged.' : 'The latest verification did not establish a verified-file receipt. No files were changed by this check.'}</p>
      {lastVerification && <div className="space-y-2">
        <p>{outcomeUnverified ? 'Last recorded comparison: ' : 'Copied-file comparison: '}{branchRead && comparedFiles.length
          ? `${matches} matched · ${mismatches} mismatched.`
          : branchRead ? 'Branch bytes were read, but no copied-file comparisons are available. A file match is not established.'
            : 'Branch bytes were not read. No file match or mismatch is established.'}</p>
        {(sourceChanged || destinationChanged) && <p>{sourceChanged ? 'The source changed since the original approval. ' : ''}{destinationChanged ? 'The destination model changed since the original approval. ' : ''}These changes require review; they do not by themselves show that the copied files failed to arrive.</p>}
        {comparisonNeedsReview && <p>The original approval remains consumed. This comparison does not retry writes, change the original run, or establish publication or query acceptance.</p>}
        {lastVerification.findings.length > 0 && <ul className="list-disc space-y-1 pl-5">{lastVerification.findings.slice(0, 5).map((finding, index) => <li key={`summary:${finding.code}:${index}`}><strong>{driftFindingLabels[finding.code] || finding.code.replace(/_/g, ' ')}</strong>{finding.fileName && <span className="break-all"> · {finding.fileName}</span>}: {finding.message}</li>)}</ul>}
        {lastVerification.findings.length > 5 && <p className="text-xs text-content-secondary">{lastVerification.findings.length - 5} additional findings are shown in verification details.</p>}
      </div>}
      {lastVerification && <details><summary className="cursor-pointer font-medium">Verification details</summary>
        <p className="mt-2">Recorded at {new Date(lastVerification.verifiedAt).toISOString()}</p>
        {lastVerification.findings.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-5">{lastVerification.findings.map((finding, index) => <li key={`${finding.code}:${index}`}><strong>{finding.code}</strong>{finding.fileName && <> · {finding.fileName}</>}: {finding.message}</li>)}</ul>}
        {comparedFiles.length > 0 && <ul className="mt-2 space-y-1">{comparedFiles.map(file => <li className="break-all" key={file.destinationFileName}>{file.sourceFileName} → {file.destinationFileName} · {file.classification.replace(/_/g, ' ')}</li>)}</ul>}
      </details>}
    </div>}
    {onVerify && bound && !outcomeUnverified && !receipt && <div className="space-y-2"><button className="btn-primary" disabled={verifyDisabled || verifying} onClick={onVerify}>{verifying ? 'Verifying existing branch…' : 'Verify existing branch'}</button><p className="text-xs text-content-secondary">Reads this existing branch and records the comparison. Does not create a branch, rewrite files, retry failed writes, validate queries, or publish.</p></div>}
    {reconciled && <p className="text-sm">An operator inspected the destination and recorded that the reviewed file write did not apply. The created branch is retained for inspection; it is not a prepared-file receipt.</p>}
    {omniUrl && branchName && <div className="space-y-2"><a className="btn-primary inline-block" href={omniUrl} target="_blank" rel="noopener noreferrer">Open Omni</a>
      <p className="text-sm">In the destination model editor, select the review branch named above. OmniKit does not yet have a verified direct branch link.</p>
      {receipt ? <p className="text-sm">Review the copied topic, view, and relationship additions. For standalone migrations, continue with the scoped Blobby repair below, inspect its actual changes, and validate the branch. Complete content, query, and access checks. Publish or request review in Omni after human review.</p>
        : <p className="text-sm text-amber-900">{reconciled ? 'Inspect the retained branch in Omni. No copied-file verification or publication is claimed for this run.' : !outcomeUnverified && comparisonNeedsReview && matches > 0 && !mismatches ? 'The compared copied files match. Review the source and destination findings in Omni; the overall verification remains incomplete. Do not repeat the migration.' : 'Inspect the recorded branch and confirm which files arrived. Do not repeat the migration or treat this unverified branch as ready to publish.'}</p>}</div>}
    <details><summary className="cursor-pointer text-sm font-semibold">{outcomeUnverified ? 'Last received operation details' : 'Operation details'}</summary><p className="mt-3 text-sm">{outcomeUnverified ? 'Last received run status' : 'Run status'}: {job.status}{verificationCount > 0 ? ' (original preparation record)' : ''}</p>{comparisonNeedsReview && <p className="mt-2 text-sm">The comparison findings do not rewrite this original status or prove deployment failed.</p>}<ul className="mt-3 space-y-2 text-sm">{job.items.map(item => <li key={item.id}><span className="font-medium">{lastReconciled?.leaseItemId === item.id ? `${outcomeUnverified ? 'Last received file-copy reconciliation' : 'File-copy reconciliation'} · files not applied` : `${item.kind.replace(/_/g, ' ')} · ${item.status}`}</span>{item.error && <p className="text-red-700">{item.error}</p>}</li>)}</ul></details>
    {!receipt && !['running', 'pending'].includes(job.status) && <p className="text-sm text-amber-900">{reconciled ? 'This approval remains used. Any further preparation requires a fresh review and separate approval; this status does not retry the old run.' : 'Do not repeat a write with an uncertain outcome. Inspect the recorded branch in Omni. Successful writes remain; cancellation or failure is not rollback.'}</p>}
    <p className="text-xs text-content-secondary">This workflow does not merge, publish, delete branches, refresh schemas, or copy dashboards.</p>
  </div>;
}

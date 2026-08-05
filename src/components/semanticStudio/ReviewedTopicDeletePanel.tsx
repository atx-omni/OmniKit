import { useState } from 'react';
import { AlertTriangle, ExternalLink, Loader2, RotateCcw, ShieldCheck, Trash2 } from 'lucide-react';
import {
  discardReviewedModelBranch,
  publishReviewedModelBranch,
  stageGovernedTopicMutation,
  startReviewedModelBranch,
  type GovernedTopicMutationEvidence,
  type ModelWriteCapability,
  type ReviewedModelBranch,
} from '@/services/reviewedModelWrite';
import { getModelYaml } from '@/services/omniApi';
import { findAuthoredTopicYamlFile } from '@/services/topicYamlGovernance';
import type { ConnectionConfig, OmniModel } from '@/types';

type ReviewedTopicDeletePanelProps = {
  connection: ConnectionConfig;
  model: OmniModel;
  topicName: string;
  capability: ModelWriteCapability | null;
  capabilityLoading: boolean;
};

function normalizeTopicName(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export function ReviewedTopicDeletePanel({
  connection,
  model,
  topicName,
  capability,
  capabilityLoading,
}: ReviewedTopicDeletePanelProps) {
  const [confirmation, setConfirmation] = useState('');
  const [status, setStatus] = useState<'idle' | 'staging' | 'ready' | 'blocked' | 'discarding' | 'discarded' | 'failed'>('idle');
  const [error, setError] = useState('');
  const [branch, setBranch] = useState<ReviewedModelBranch | null>(null);
  const [evidence, setEvidence] = useState<GovernedTopicMutationEvidence | null>(null);
  const [reviewAcknowledged, setReviewAcknowledged] = useState(false);
  const [handoff, setHandoff] = useState<{ status: 'idle' | 'creating' | 'ready' | 'failed'; message: string; url: string }>({
    status: 'idle',
    message: '',
    url: '',
  });

  const confirmed = confirmation.trim() === topicName;
  const busy = status === 'staging' || status === 'discarding';
  const canStage = capability?.editable === true && confirmed && !busy && !evidence && !branch;

  async function handleStageRemoval() {
    if (!canStage) return;
    setStatus('staging');
    setError('');
    let nextBranch: ReviewedModelBranch | null = null;
    try {
      const sourceYaml = await getModelYaml(connection.baseUrl, connection.apiKey, model.id, {
        includeChecksums: true,
        fullyResolved: false,
      });
      const sourceTopicFile = findAuthoredTopicYamlFile(sourceYaml, topicName);
      if (!sourceTopicFile) {
        throw new Error(`OmniKit could not resolve one exact authored .topic file for ${topicName}. Resolve missing or duplicate paths before removal.`);
      }
      nextBranch = await startReviewedModelBranch(connection, model, `omnikit-topic-remove-${normalizeTopicName(topicName)}`);
      setBranch(nextBranch);
      const nextEvidence = await stageGovernedTopicMutation(connection, nextBranch, {
        action: 'delete',
        fileName: sourceTopicFile.fileName,
        commitMessage: `Stage reviewed removal of ${sourceTopicFile.fileName}`,
      });
      setEvidence(nextEvidence);
      setStatus(nextEvidence.validation.blocking ? 'blocked' : 'ready');
    } catch (stageError) {
      let cleanupError = '';
      if (nextBranch) {
        try {
          await discardReviewedModelBranch(connection, nextBranch);
          setBranch(null);
        } catch (cleanupFailure) {
          setBranch(nextBranch);
          cleanupError = ` Review branch ${nextBranch.branchName} could not be discarded automatically: ${cleanupFailure instanceof Error ? cleanupFailure.message : 'unknown cleanup failure'}`;
        }
      }
      setStatus('failed');
      setError(`${stageError instanceof Error ? stageError.message : 'The reviewed topic removal could not be staged.'}${cleanupError}`);
    }
  }

  async function handleDiscard() {
    if (!branch || busy) return;
    setStatus('discarding');
    setError('');
    try {
      await discardReviewedModelBranch(connection, branch);
      setEvidence(null);
      setBranch(null);
      setConfirmation('');
      setReviewAcknowledged(false);
      setHandoff({ status: 'idle', message: '', url: '' });
      setStatus('discarded');
    } catch (discardError) {
      setStatus('failed');
      setError(discardError instanceof Error ? discardError.message : 'The review branch could not be discarded.');
    }
  }

  async function handleCreatePullRequest() {
    if (!branch || !evidence || evidence.validation.blocking || !reviewAcknowledged || !branch.capability.pullRequestRequired) return;
    setHandoff({ status: 'creating', message: '', url: '' });
    try {
      const result = await publishReviewedModelBranch(
        connection,
        branch,
        `Reviewed topic removal: ${evidence.fileName}`,
      );
      if (result.mode !== 'pull_request') {
        throw new Error('Protected-model handoff did not return a pull request. No merge was attempted.');
      }
      setHandoff({
        status: 'ready',
        message: result.message,
        url: result.url || branch.capability.webUrl || connection.baseUrl,
      });
    } catch (handoffError) {
      setHandoff({
        status: 'failed',
        message: handoffError instanceof Error ? handoffError.message : 'The pull-request handoff could not be created.',
        url: '',
      });
    }
  }

  return (
    <details className="rounded-card border border-border bg-white overflow-hidden">
      <summary className="cursor-pointer px-3 py-2 bg-surface-secondary border-b border-border">
        <span className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-content-secondary">
          <Trash2 size={14} /> Remove topic
        </span>
      </summary>
      <div className="p-4 space-y-4">
        <div className="rounded-card border border-amber-100 bg-amber-50 p-3 text-sm text-amber-900">
          <div className="flex items-start gap-2">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <div>
              <div className="font-semibold">Removal is staged for review</div>
              <div className="mt-1 text-xs leading-relaxed">
                OmniKit creates a dev branch, removes the exact authored topic file there, and validates the result. The shared model is not changed automatically.
              </div>
            </div>
          </div>
        </div>

        {capabilityLoading ? (
          <div className="text-xs text-content-secondary inline-flex items-center gap-2">
            <Loader2 size={14} className="animate-spin" /> Checking model write policy...
          </div>
        ) : !capability?.editable ? (
          <div className="rounded-button border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700">
            {capability?.reason || 'OmniKit could not verify that this model supports reviewed branch changes.'}
          </div>
        ) : evidence && branch ? (
          <div className="space-y-3">
            <div className={`rounded-card border p-3 text-sm ${
              evidence.validation.blocking
                ? 'border-red-100 bg-red-50 text-red-800'
                : 'border-green-100 bg-green-50 text-green-800'
            }`}>
              <div className="font-semibold">
                {evidence.validation.blocking ? 'Branch validation needs attention' : 'Removal is ready for human review'}
              </div>
              <div className="mt-1 text-xs leading-relaxed">
                Branch <span className="font-mono">{branch.branchName}</span> · file <span className="font-mono">{evidence.fileName}</span> · {evidence.validation.modelIssues.length} model issues · {evidence.validation.contentIssueCount} content issues
              </div>
              <div className="mt-1 text-xs">
                {branch.capability.pullRequestRequired
                  ? 'This model requires a pull request before the shared model can change.'
                  : 'Review the diff in Omni and choose whether to merge it. OmniKit has not published this branch.'}
              </div>
            </div>
            <details className="rounded-button border border-border bg-white overflow-hidden">
              <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-content-primary">
                Review exact file removal ({evidence.diff.beforeYaml.split('\n').length} lines)
              </summary>
              <pre className="max-h-64 overflow-auto border-t border-border bg-surface-secondary p-3 text-[11px] leading-relaxed text-content-secondary whitespace-pre-wrap">
                {evidence.diff.beforeYaml}
              </pre>
            </details>
            {!evidence.validation.blocking && (
              <label className="flex items-start gap-2 rounded-button border border-omni-100 bg-omni-50 px-3 py-2 text-xs text-omni-700">
                <input
                  type="checkbox"
                  checked={reviewAcknowledged}
                  onChange={(event) => setReviewAcknowledged(event.target.checked)}
                  className="mt-0.5 rounded border-omni-300 text-omni-700 focus:ring-omni-500"
                />
                <span>I reviewed the complete topic file removal and validation results.</span>
              </label>
            )}
            <div className="flex flex-wrap gap-2">
              {branch.capability.pullRequestRequired ? (
                handoff.status === 'ready' ? (
                  <a href={handoff.url} target="_blank" rel="noreferrer" className="btn-primary text-xs">
                    <ExternalLink size={14} /> Open pull request
                  </a>
                ) : (
                  <button
                    type="button"
                    onClick={handleCreatePullRequest}
                    disabled={!reviewAcknowledged || evidence.validation.blocking || handoff.status === 'creating'}
                    className="btn-primary text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {handoff.status === 'creating' ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
                    Create pull request handoff
                  </button>
                )
              ) : (
                <a
                  href={branch.capability.webUrl || connection.baseUrl}
                  target="_blank"
                  rel="noreferrer"
                  aria-disabled={!reviewAcknowledged || evidence.validation.blocking}
                  className={`btn-primary text-xs ${!reviewAcknowledged || evidence.validation.blocking ? 'pointer-events-none opacity-50' : ''}`}
                >
                  <ExternalLink size={14} /> Open Omni review
                </a>
              )}
              <button type="button" onClick={handleDiscard} disabled={busy} className="btn-secondary text-xs">
                {status === 'discarding' ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
                Discard review branch
              </button>
            </div>
            {handoff.message && (
              <div className={`rounded-button border px-3 py-2 text-xs ${
                handoff.status === 'failed'
                  ? 'border-red-100 bg-red-50 text-red-700'
                  : 'border-green-100 bg-green-50 text-green-800'
              }`}>
                {handoff.message}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <label className="block text-xs font-semibold text-content-primary">
              Type <span className="font-mono">{topicName}</span> to confirm
              <input
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                className="input-field mt-1 font-mono text-xs"
                autoComplete="off"
              />
            </label>
            <button type="button" onClick={handleStageRemoval} disabled={!canStage} className="btn-secondary text-xs disabled:opacity-50 disabled:cursor-not-allowed">
              {status === 'staging' ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
              Stage removal on dev branch
            </button>
            {status === 'discarded' && (
              <div className="rounded-button border border-green-100 bg-green-50 px-3 py-2 text-xs text-green-800">
                The review branch was discarded. The shared model was never changed.
              </div>
            )}
            {status === 'failed' && branch && (
              <div className="rounded-button border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                <div className="font-semibold">Review branch cleanup is still required</div>
                <div className="mt-1 font-mono break-all">{branch.branchName}</div>
                <button type="button" onClick={handleDiscard} disabled={busy} className="btn-secondary text-xs mt-2">
                  <RotateCcw size={14} />
                  Retry branch cleanup
                </button>
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="rounded-button border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </div>
        )}
      </div>
    </details>
  );
}

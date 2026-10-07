import { apiFetch } from './opsConsole';
import type { TopicBlobbyRepair } from '../../shared/topicBlobbyRepair';

export const TOPIC_BLOBBY_REPAIR_REFERENCE_KEY = 'omnikit:topicBlobbyRepair:v1';
export interface TopicBlobbyRepairReference { version: 1; id: string; originPlanId: string }

/** Store references only, never prompts, definitions, credentials, or approval. */
export function readTopicBlobbyRepairReference(text: string | null, originPlanId: string): TopicBlobbyRepairReference | null {
  try {
    const value: unknown = JSON.parse(text || 'null');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    const safe = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id);
    return row.version === 1 && row.originPlanId === originPlanId && safe(row.id) && safe(row.originPlanId)
      ? { version: 1, id: row.id, originPlanId: row.originPlanId } : null;
  } catch { return null; }
}

export function clearTopicBlobbyRepairReference() {
  try { localStorage.removeItem(TOPIC_BLOBBY_REPAIR_REFERENCE_KEY); } catch { /* Optional reference storage. */ }
}

export function saveTopicBlobbyRepairReference(repair: Pick<TopicBlobbyRepair, 'id' | 'originPlanId'>) {
  try { localStorage.setItem(TOPIC_BLOBBY_REPAIR_REFERENCE_KEY, JSON.stringify({ version: 1, id: repair.id, originPlanId: repair.originPlanId })); } catch { /* Optional reference storage. */ }
}

export function prepareTopicBlobbyRepair(originPlanId: string, signal?: AbortSignal, predecessorId?: string) {
  return apiFetch<{ repair: TopicBlobbyRepair }>(`/api/model-migrator/topic-plan/${encodeURIComponent(originPlanId)}/blobby-repairs`, {
    method: 'POST', body: JSON.stringify(predecessorId ? { predecessorId } : {}), signal,
  });
}

export function getTopicBlobbyRepair(id: string, signal?: AbortSignal) {
  return apiFetch<{ repair: TopicBlobbyRepair }>(`/api/model-migrator/blobby-repairs/${encodeURIComponent(id)}`, { signal });
}

export type TopicBlobbyRepairAction = 'start' | 'inspect' | 'cancel' | 'validate' | 'accept';
export function runTopicBlobbyRepairAction(repair: Pick<TopicBlobbyRepair, 'id' | 'revision'>, action: TopicBlobbyRepairAction, signal?: AbortSignal) {
  return apiFetch<{ repair: TopicBlobbyRepair }>(`/api/model-migrator/blobby-repairs/${encodeURIComponent(repair.id)}/${action}`, {
    method: 'POST', body: JSON.stringify(action === 'start' || action === 'accept' ? { revision: repair.revision, approve: true } : {}), signal,
  });
}

export function canStartTopicBlobbyRepair(repair: TopicBlobbyRepair, approved: boolean, fresh: boolean, attempted: boolean, now = Date.now()) {
  return approved && fresh && !attempted && repair.status === 'ready' && repair.expiresAt > now
    && ['native', 'api'].includes(repair.mode) && !repair.jobId && !repair.remoteJobId
    && !repair.findings.some(finding => finding.severity === 'blocker');
}

export function canAcceptTopicBlobbyRepair(repair: TopicBlobbyRepair, approved: boolean, reviewedFiles: string[], unverified: boolean) {
  return approved && !unverified && repair.status === 'review' && repair.mainUnchanged === true && Boolean(repair.branchHash)
    && repair.validation.status === 'passed' && repair.validation.branchHash === repair.branchHash
    && !repair.findings.some(finding => finding.severity === 'blocker')
    && repair.changes.every(change => reviewedFiles.includes(change.fileName));
}

export function hasCurrentTopicBlobbyPrompt(repair: TopicBlobbyRepair) {
  return Boolean(repair.nativePrompt && repair.nativePromptSnapshot?.branchHash
    && repair.mainUnchanged !== false && !repair.findings.some(finding => finding.severity === 'blocker')
    && repair.nativePromptSnapshot.branchHash === repair.branchHash
    && repair.validation.branchHash === repair.branchHash
    && repair.nativePromptSnapshot.validationCheckedAt === repair.validation.checkedAt
    && repair.validation.status !== 'not_run');
}

export function topicBlobbyRepairReport(repair: TopicBlobbyRepair) {
  return {
    version: 1, id: repair.id, originPlanId: repair.originPlanId, originJobId: repair.originJobId, predecessorId: repair.predecessorId, revision: repair.revision,
    mode: repair.mode, status: repair.status, branch: { modelId: repair.branch.modelId, branchId: repair.branch.branchId, branchName: repair.branch.branchName },
    destination: { instanceId: repair.request.targetInstanceId, connectionId: repair.request.targetConnectionId, modelId: repair.request.targetModelId },
    sourceDialect: repair.sourceDialect, targetDialect: repair.targetDialect, scopeFiles: [...repair.scopeFiles],
    changes: repair.changes.map(change => ({ fileName: change.fileName, action: change.before === null ? 'created' : change.after === null ? 'deleted' : 'changed' })),
    findings: repair.findings.map(finding => ({ code: finding.code, severity: finding.severity, fileName: finding.fileName })),
    validation: { status: repair.validation.status, checkedAt: repair.validation.checkedAt, branchHash: repair.validation.branchHash,
      errors: repair.validation.issues.filter(issue => !issue.warning).length, warnings: repair.validation.issues.filter(issue => issue.warning).length },
    mainUnchanged: repair.mainUnchanged, branchHash: repair.branchHash, remoteJobId: repair.remoteJobId, jobId: repair.jobId,
    acceptedAt: repair.acceptedAt, acceptedBranchHash: repair.acceptedBranchHash,
    publication: 'Not performed by this workflow. Acceptance records review of branch changes only.',
  };
}

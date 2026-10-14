import { apiFetch } from './opsConsole';
import type { TopicBranchCorrectionPlan, TopicBranchValidation } from '../../shared/topicBranchCorrection';

export const TOPIC_BRANCH_CORRECTION_DRAFT_KEY = 'omnikit:topicBranchCorrection:v1';
export interface TopicBranchCorrectionReference { version: 1; originPlanId: string; id: string }

/** References only. Never restore YAML, credentials, approval, or an apply decision. */
export function readTopicBranchCorrectionReference(text: string | null, originPlanId: string): TopicBranchCorrectionReference | null {
  try {
    const value: unknown = JSON.parse(text || 'null');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    const safeId = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id);
    return row.version === 1 && row.originPlanId === originPlanId && safeId(row.originPlanId) && safeId(row.id)
      ? { version: 1, originPlanId: row.originPlanId, id: row.id } : null;
  } catch { return null; }
}

export function clearTopicBranchCorrectionReference() {
  try { localStorage.removeItem(TOPIC_BRANCH_CORRECTION_DRAFT_KEY); } catch { /* Optional reference storage. */ }
}

export function saveTopicBranchCorrectionReference(correction: Pick<TopicBranchCorrectionPlan, 'id' | 'originPlanId'>) {
  try { localStorage.setItem(TOPIC_BRANCH_CORRECTION_DRAFT_KEY, JSON.stringify({ version: 1, originPlanId: correction.originPlanId, id: correction.id })); } catch { /* Optional reference storage. */ }
}

export function prepareTopicBranchCorrection(originPlanId: string, predecessorId?: string, signal?: AbortSignal) {
  return apiFetch<{ correction: TopicBranchCorrectionPlan }>(`/api/model-migrator/topic-plan/${encodeURIComponent(originPlanId)}/corrections`, {
    method: 'POST', body: JSON.stringify(predecessorId ? { predecessorId } : {}), signal,
  });
}

export function getTopicBranchCorrection(id: string, signal?: AbortSignal) {
  return apiFetch<{ correction: TopicBranchCorrectionPlan }>(`/api/model-migrator/branch-corrections/${encodeURIComponent(id)}`, { signal });
}

export function applyTopicBranchCorrection(correction: Pick<TopicBranchCorrectionPlan, 'id' | 'revision'>, signal?: AbortSignal) {
  return apiFetch<{ correction: TopicBranchCorrectionPlan }>(`/api/model-migrator/branch-corrections/${encodeURIComponent(correction.id)}/apply`, {
    method: 'POST', body: JSON.stringify({ revision: correction.revision, approve: true }), signal,
  });
}

export type TopicBranchCorrectionAction = 'reconcile' | 'validate' | 'content-validation' | 'cancel';
export function inspectTopicBranchCorrection(id: string, action: TopicBranchCorrectionAction, signal?: AbortSignal) {
  return apiFetch<{ correction: TopicBranchCorrectionPlan }>(`/api/model-migrator/branch-corrections/${encodeURIComponent(id)}/${action}`, {
    method: 'POST', body: '{}', signal,
  });
}

export function canApplyTopicBranchCorrection(correction: TopicBranchCorrectionPlan, approved: boolean, fresh: boolean, attempted: boolean, now = Date.now()): boolean {
  return approved && fresh && !attempted && correction.status === 'ready' && !correction.jobId && correction.expiresAt > now
    && !correction.issues.some(issue => issue.severity === 'blocker')
    && !correction.files.some(file => file.status === 'blocked')
    && correction.files.some(file => file.status === 'add' || file.status === 'create');
}

/** Whitelist report fields: free-form diagnostics and raw definitions stay out of exported summaries. */
export function topicBranchCorrectionReport(correction: TopicBranchCorrectionPlan) {
  const validation = (value: TopicBranchValidation) => ({ status: value.status, checkedAt: value.checkedAt, branchHash: value.branchHash,
    issueCount: value.issues.length, warningCount: value.issues.filter(issue => issue.warning).length });
  return {
    version: 1, id: correction.id, originPlanId: correction.originPlanId, originJobId: correction.originJobId,
    predecessorId: correction.predecessorId, revision: correction.revision, jobId: correction.jobId,
    status: correction.status, createdAt: correction.createdAt, expiresAt: correction.expiresAt,
    branch: { modelId: correction.branch.modelId, branchId: correction.branch.branchId, branchName: correction.branch.branchName },
    destination: { instanceId: correction.request.targetInstanceId, connectionId: correction.request.targetConnectionId, modelId: correction.request.targetModelId },
    sourceDialect: correction.sourceDialect, targetDialect: correction.targetDialect,
    files: correction.files.map(file => ({ fileName: file.fileName, destinationFileName: file.destinationFileName, status: file.status,
      correctedFields: file.sqlDialectReview?.corrections.map(item => item.path), compatibilityFindingCount: file.sqlDialectReview?.findings.length || 0 })),
    findings: correction.issues.map(issue => ({ severity: issue.severity, kind: issue.kind, fileName: issue.fileName })),
    noops: correction.noops, outcomes: correction.outcomes.map(item => ({ fileName: item.fileName, status: item.status })),
    filesVerified: correction.filesVerified, mainUnchanged: correction.mainUnchanged,
    validation: validation(correction.validation), contentValidation: validation(correction.contentValidation),
    publication: 'Not performed by this workflow. Original preparation outcome remains separate.',
  };
}

import type { TopicMigrationIssue, TopicMigrationPlan, TopicMigrationRequest } from '../../shared/topicMigration';
import type { MigrationJob } from './opsConsole';
import type { BranchPreparationReceipt, BranchVerificationRecord } from '../../shared/topicMigration';

export const TOPIC_MIGRATION_DRAFT_KEY = 'omnikit:topicMigrationDraft:v1';
export const MIGRATION_HISTORY_BLOCKED_MESSAGE = 'Migration history is unavailable, so no further writes are allowed. The displayed operations are the last received snapshot, not a verified current outcome. Preserve the history file and resolve the history error before checking the saved run; do not repeat the migration.';
export function isMigrationHistoryUnavailable(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'MIGRATION_HISTORY_UNAVAILABLE');
}
export interface TopicMigrationDraft { version: 1; planId?: string; jobId?: string }

/** Store references only: no YAML, credentials, approvals, or user-supplied SQL. */
export function readTopicMigrationDraft(text: string | null): TopicMigrationDraft | null {
  try {
    const value: unknown = JSON.parse(text || 'null');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    const safeId = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id);
    if (row.version !== 1 || !safeId(row.planId)) return null;
    return { version: 1, planId: row.planId, ...(safeId(row.jobId) ? { jobId: row.jobId } : {}) };
  } catch { return null; }
}

export function topicRequestFingerprint(request: TopicMigrationRequest): string {
  const ordered = (value: Record<string, string> | undefined) => Object.entries(value || {}).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([request.sourceInstanceId, request.sourceConnectionId, request.sourceModelId,
    request.targetInstanceId, request.targetConnectionId, request.targetModelId,
    [...request.topicIds].sort(), request.schemaMapText, ordered(request.fileMappings), ordered(request.reviewedSqlFiles),
    Object.entries(request.tableMappings || {}).sort(([a], [b]) => a.localeCompare(b))
      .map(([file, mapping]) => [file, mapping.targetTable, ordered(mapping.columnMappings)])]);
}

/** Group presentation only: every original finding and its severity stays authoritative. */
export function groupTopicMigrationIssues(issues: TopicMigrationIssue[]) {
  const groups = new Map<string, { id: string; title: string; sql: boolean; fileName?: string; issues: TopicMigrationIssue[] }>();
  for (const issue of issues) {
    const sql = issue.kind === 'sql' || /^(?:SQL physical lineage|Column lineage|Local physical lineage)/.test(issue.title);
    const cause = sql ? 'Review SQL' : issue.title.split(':')[0];
    const id = JSON.stringify([sql ? 'sql' : issue.kind, sql ? (issue.severity === 'info' ? 'info' : 'actionable') : issue.severity, issue.fileName || '', cause]);
    const group = groups.get(id) || { id, title: cause, sql, fileName: issue.fileName, issues: [] };
    group.issues.push(issue); groups.set(id, group);
  }
  return [...groups.values()];
}

export function canStageTopicPlan(plan: TopicMigrationPlan | null, request: TopicMigrationRequest, approved: boolean, restored: boolean, now = Date.now()): boolean {
  return Boolean(plan && plan.version === 2 && plan.executionProfile === 'branch_preparation_v1' && approved && !restored && plan.status === 'ready' && !plan.jobId
    && plan.expiresAt > now && topicRequestFingerprint(plan.request) === topicRequestFingerprint(request)
    && !plan.issues.some(issue => issue.severity === 'blocker')
    && plan.files.some(file => file.status === 'create' || file.status === 'add')
    && !plan.files.some(file => file.status === 'blocked'));
}

export function topicJobMatchesPlan(plan: TopicMigrationPlan | null, request: TopicMigrationRequest, job: MigrationJob | null): boolean {
  if (!plan || !job || plan.status !== 'submitted' || plan.jobId !== job.id
    || topicRequestFingerprint(plan.request) !== topicRequestFingerprint(request)
    || job.sourceId !== request.sourceInstanceId || job.destinationIds.length !== 1 || job.destinationIds[0] !== request.targetInstanceId) return false;
  const binding = job.details?.topicMigration;
  return Boolean(binding && typeof binding === 'object' && 'planId' in binding && 'revision' in binding
    && binding.planId === plan.id && binding.revision === plan.revision);
}

export function topicJobPhase(job: MigrationJob): string {
  const branchPreparation = (job.details?.branchPreparation as { profile?: string } | undefined)?.profile === 'branch_preparation_v1';
  if (branchPreparation) {
    const labels: Record<string, string> = { model_branch_create: 'Creating review branch', model_yaml_write: 'Copying approved files',
      model_branch_verify: 'Verifying copied files' };
    const active = job.items.find(item => item.status === 'running' && item.kind in labels);
    if (active) return labels[active.kind];
    if (latestBranchVerification(job)?.verified) return 'Files verified — ready to review in Omni';
    if (preparedBranchReceipt(job)) return 'Ready to review in Omni';
    if (reconciledBranchFilesNotApplied(job)) return 'Reconciled — files not applied';
    if (job.status === 'running' || job.status === 'pending') return 'Preparing review branch';
    return createdReviewBranch(job) ? 'Branch created — copied files unverified' : 'Preparation not verified — check the saved run';
  }
  const labels: Record<string, string> = {
    model_translate: 'Checking approved scope', model_branch_create: 'Creating review branch',
    model_yaml_write: 'Adding approved definitions', model_validate: 'Validating model',
    model_branch_verify: 'Verifying the prepared branch',
    content_validate: 'Validating affected content', model_merge: 'Publishing changes', model_pr: 'Preparing review handoff',
  };
  const active = job.items.find(item => item.status === 'running');
  if (active) return labels[active.kind] || 'Processing migration';
  if (job.items.some(item => item.kind === 'model_pr' && item.status === 'succeeded')) return 'Review handoff created — not published';
  if (job.items.some(item => item.kind === 'model_merge' && item.status === 'succeeded')) return 'Published — verify destination behavior';
  if (preparedBranchReceipt(job)) return 'Review branch prepared';
  if (job.status === 'running' || job.status === 'pending') return 'Preparing review branch';
  if (job.items.some(item => item.kind === 'model_branch_create' && item.status === 'succeeded')) return 'Branch partially prepared — review required';
  return 'Preparation not verified — check the saved run';
}

/** Creation is useful historical evidence, but is never a prepared-file receipt. */
export function createdReviewBranch(job: MigrationJob): BranchPreparationReceipt | null {
  const profile = job.details?.branchPreparation as { profile?: string } | undefined;
  const request = (job.details?.topicMigration as { request?: TopicMigrationRequest } | undefined)?.request;
  const creates = job.items.filter(item => item.kind === 'model_branch_create');
  if (profile?.profile !== 'branch_preparation_v1' || !request || creates.length !== 1
    || job.sourceId !== request.sourceInstanceId || job.destinationIds.length !== 1 || job.destinationIds[0] !== request.targetInstanceId) return null;
  const item = creates[0];
  const branchId = item.details?.branchId, branchName = item.details?.branchName;
  const exactText = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 1024
    && value === value.trim() && ![...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
  if (item.jobId !== job.id || item.status !== 'succeeded' || item.error || item.destinationId !== request.targetInstanceId
    || item.targetModelId !== request.targetModelId || item.details?.targetModelId !== request.targetModelId
    || !exactText(request.targetModelId) || !exactText(branchId) || !exactText(branchName)) return null;
  return { modelId: request.targetModelId, branchId, branchName };
}

/** UI eligibility only. The server independently proves scope, unchanged evidence, and exclusive ownership. */
export function branchVerificationCandidate(job: MigrationJob): BranchPreparationReceipt | null {
  const branch = createdReviewBranch(job);
  const binding = job.details?.topicMigration as { planId?: string; revision?: string } | undefined;
  if (!branch || job.workflow !== 'model' || !['failed', 'partial'].includes(job.status)
    || !Number.isSafeInteger(job.endedAt) || (job.endedAt || 0) <= job.createdAt
    || job.details?.dashboardRepair || job.details?.branchReceipt || job.details?.migrationMutationAdjudications
    || !binding?.planId || !binding.revision || new Set(job.items.map(item => item.id)).size !== job.items.length) return null;
  const writes = job.items.filter(item => item.kind === 'model_yaml_write');
  const verifies = job.items.filter(item => item.kind === 'model_branch_verify');
  const owners = job.items.filter(item => item.kind === 'destination_model_mutation'
    || Object.prototype.hasOwnProperty.call(item.details || {}, 'migrationDestinationModelMutation'));
  if (writes.length !== 1 || verifies.length !== 1 || owners.length !== 1
    || job.items.some(item => item.jobId !== job.id || item.destinationId !== job.destinationIds[0] || item.targetModelId !== branch.modelId
      || !['model_translate', 'model_branch_create', 'model_yaml_write', 'model_branch_verify', 'destination_model_mutation'].includes(item.kind)
      || (item === verifies[0] ? item.status !== 'failed' : item.status !== 'succeeded' || Boolean(item.error)))) return null;
  const write = writes[0], owner = owners[0], lease = owner.details;
  if (write.details?.targetModelId !== branch.modelId || write.details?.branchId !== branch.branchId || write.details?.branchName !== branch.branchName
    || owner.kind !== 'destination_model_mutation' || lease?.migrationDestinationModelMutation !== true
    || lease.migrationMutationOperation !== 'model_job' || lease.migrationMutationState !== 'resolved'
    || lease.migrationMutationDispatchItemId !== write.id || lease.migrationMutationDispatchItemKind !== 'model_yaml_write'
    || typeof lease.migrationMutationDispatchFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(lease.migrationMutationDispatchFingerprint)
    || Object.prototype.hasOwnProperty.call(lease, 'migrationMutationResolutionKind')
    || Object.prototype.hasOwnProperty.call(lease, 'migrationMutationExternalJobId')) return null;
  return branch;
}

export function canVerifyTopicBranch(plan: TopicMigrationPlan | null, request: TopicMigrationRequest, job: MigrationJob | null): boolean {
  const binding = job?.details?.topicMigration as { request?: TopicMigrationRequest; sourceHash?: string; targetHash?: string } | undefined;
  return Boolean(plan?.version === 2 && plan.executionProfile === 'branch_preparation_v1' && !plan.dashboardRepair
    && job && topicJobMatchesPlan(plan, request, job) && branchVerificationCandidate(job)
    && binding?.request && topicRequestFingerprint(binding.request) === topicRequestFingerprint(request)
    && binding.sourceHash === plan.sourceHash && binding.targetHash === plan.targetHash);
}

/** Only the latest exact audit can supply a recovery receipt. Never fall back past a failed/malformed latest record. */
export function latestBranchVerification(job: MigrationJob): BranchVerificationRecord | null {
  const branch = branchVerificationCandidate(job);
  const audits = job.details?.branchVerifications;
  const binding = job.details?.topicMigration as { planId?: string; revision?: string; sourceHash?: string; targetHash?: string } | undefined;
  if (!branch || !Array.isArray(audits) || !audits.length) return null;
  const record = audits[audits.length - 1] as BranchVerificationRecord | undefined;
  const digest = (value: unknown): value is string => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
  const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 2048
    && value === value.trim() && ![...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
  if (!record || record.version !== 1 || record.policy !== 'topic_branch_readback_v1' || typeof record.verified !== 'boolean'
    || !text(record.requestId) || record.planId !== binding?.planId || record.planRevision !== binding?.revision || record.jobId !== job.id
    || record.targetInstanceId !== job.destinationIds[0] || record.modelId !== branch.modelId
    || record.branchId !== branch.branchId || record.branchName !== branch.branchName
    || !Number.isSafeInteger(record.verifiedAt) || record.verifiedAt < (job.endedAt || 0)
    || ![record.expectedHash, record.sourceHash, record.mainHash, record.jobEvidenceHash].every(digest)
    || record.sourceHash !== binding.sourceHash || record.mainHash !== binding.targetHash
    || !(digest(record.actualHash) || (!record.verified && record.actualHash === null))
    || !Array.isArray(record.files) || !Array.isArray(record.findings)
    || record.files.some(file => !file || ![file.sourceFileName, file.submittedFileName, file.destinationFileName].every(text)
      || !['exact', 'mapped_path', 'formatting_only', 'mapped_path_and_formatting', 'mismatch'].includes(file.classification))
    || new Set(record.files.map(file => file.destinationFileName)).size !== record.files.length
    || record.findings.some(finding => !finding || !text(finding.code) || !text(finding.message)
      || (finding.fileName !== undefined && !text(finding.fileName)))
    || (record.verified && (!record.files.length || record.files.some(file => file.classification === 'mismatch') || record.findings.length > 0))) return null;
  return record;
}

/** Presentation evidence only: an audited non-write never authorizes replay or supplies a ready receipt. */
export function reconciledBranchFilesNotApplied(job: MigrationJob): { leaseItemId: string } | null {
  const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
  const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
  const digest = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
  const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 1024
    && value === value.trim() && ![...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
  const branch = createdReviewBranch(job);
  const binding = record(job.details?.topicMigration);
  if (!branch || job.workflow !== 'model' || !['failed', 'canceled', 'partial'].includes(job.status)
    || !positive(job.endedAt) || job.endedAt < job.createdAt || job.details?.branchReceipt !== undefined
    || !text(binding?.planId) || !text(binding?.revision) || new Set(job.items.map(item => item.id)).size !== job.items.length) return null;
  const owners = job.items.filter(item => item.kind === 'destination_model_mutation' || Object.prototype.hasOwnProperty.call(item.details || {}, 'migrationDestinationModelMutation'));
  const writes = job.items.filter(item => item.kind === 'model_yaml_write');
  const verifies = job.items.filter(item => item.kind === 'model_branch_verify');
  if (owners.length !== 1 || writes.length !== 1 || verifies.length !== 1
    || job.items.some(item => item.jobId !== job.id || item.destinationId !== job.destinationIds[0] || item.targetModelId !== branch.modelId
      || item.details?.branchReceipt !== undefined
      || !['model_translate', 'model_branch_create', 'model_yaml_write', 'model_branch_verify', 'destination_model_mutation'].includes(item.kind)
      || ['pending', 'running', 'warning'].includes(item.status))) return null;
  const owner = owners[0], write = writes[0], verify = verifies[0], lease = record(owner.details);
  const audits = job.details?.migrationMutationAdjudications;
  const audit = Array.isArray(audits) && audits.length === 1 ? record(audits[0]) : undefined;
  if (!lease || !audit || owner.kind !== 'destination_model_mutation' || owner.status !== 'succeeded' || owner.error
    || write.status !== 'failed' || !['failed', 'skipped'].includes(verify.status)
    || write.details?.targetModelId !== branch.modelId || write.details?.branchName !== branch.branchName
    || (write.details?.branchId !== undefined && write.details.branchId !== branch.branchId)
    || lease.migrationDestinationModelMutation !== true || lease.migrationMutationState !== 'resolved'
    || lease.migrationMutationOperation !== 'model_job' || Object.prototype.hasOwnProperty.call(lease, 'migrationMutationExternalJobId')
    || lease.migrationMutationDispatchItemId !== write.id || lease.migrationMutationDispatchItemKind !== 'model_yaml_write'
    || !digest(lease.migrationMutationDispatchFingerprint) || !digest(lease.migrationMutationResolutionRequestHash)
    || typeof lease.migrationMutationResolutionRequestId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(lease.migrationMutationResolutionRequestId)
    || lease.migrationMutationResolutionKind !== 'operator_adjudication' || lease.migrationMutationResolutionActor !== 'local_unlocked_operator'
    || lease.migrationMutationResolutionOutcome !== 'verified_not_applied'
    || !['omni_ui', 'omni_api', 'external_system'].includes(String(lease.migrationMutationResolutionEvidenceSource))
    || !positive(lease.migrationMutationRevision) || !positive(lease.migrationMutationResolutionExpectedRevision)
    || lease.migrationMutationRevision !== lease.migrationMutationResolutionExpectedRevision + 1
    || !positive(lease.migrationMutationDispatchedAt) || !positive(lease.migrationMutationResolutionExpectedUpdatedAt)
    || !positive(lease.migrationMutationUpdatedAt) || !positive(write.endedAt)
    || lease.migrationMutationDispatchedAt > write.endedAt || write.endedAt > job.endedAt
    || lease.migrationMutationDispatchedAt > lease.migrationMutationResolutionExpectedUpdatedAt
    || lease.migrationMutationResolutionExpectedUpdatedAt > lease.migrationMutationUpdatedAt
    || job.endedAt > lease.migrationMutationUpdatedAt || owner.endedAt !== lease.migrationMutationUpdatedAt
    || lease.migrationMutationResolutionConfirmedAt !== lease.migrationMutationUpdatedAt) return null;
  const expectedAudit = { requestId: lease.migrationMutationResolutionRequestId, requestHash: lease.migrationMutationResolutionRequestHash,
    leaseItemId: owner.id, priorRevision: lease.migrationMutationResolutionExpectedRevision, resolvedRevision: lease.migrationMutationRevision,
    priorUpdatedAt: lease.migrationMutationResolutionExpectedUpdatedAt, destinationInstanceId: owner.destinationId, targetModelId: branch.modelId,
    operation: 'model_job', dispatchItemId: write.id, dispatchItemKind: write.kind, dispatchFingerprint: lease.migrationMutationDispatchFingerprint,
    outcome: 'verified_not_applied', evidenceSource: lease.migrationMutationResolutionEvidenceSource,
    actor: 'local_unlocked_operator', adjudicatedAt: lease.migrationMutationUpdatedAt };
  return Object.entries(expectedAudit).every(([key, value]) => audit[key] === value) ? { leaseItemId: owner.id } : null;
}

/** Keep ownership/scope bookkeeping in details, not the three-step branch progress. */
export function topicJobProgress(job: MigrationJob): { completed: number; total: number } {
  const branchPreparation = (job.details?.branchPreparation as { profile?: string } | undefined)?.profile === 'branch_preparation_v1';
  const items = branchPreparation ? job.items.filter(item => ['model_branch_create', 'model_yaml_write', 'model_branch_verify'].includes(item.kind)) : job.items;
  return { completed: items.filter(item => branchPreparation ? item.status === 'succeeded' && !item.error
    : ['succeeded', 'failed', 'warning', 'skipped'].includes(item.status)).length, total: items.length };
}

/** A job status alone is not evidence of exact branch readback. */
export function preparedBranchReceipt(job: MigrationJob): BranchPreparationReceipt | null {
  const verification = latestBranchVerification(job);
  if (verification?.verified) return { modelId: verification.modelId, branchId: verification.branchId, branchName: verification.branchName };
  const profile = job.details?.branchPreparation as { profile?: string } | undefined;
  const receipt = job.details?.branchReceipt as BranchPreparationReceipt | undefined;
  const request = (job.details?.topicMigration as { request?: TopicMigrationRequest } | undefined)?.request;
  if (profile?.profile !== 'branch_preparation_v1' || job.status !== 'succeeded' || !receipt
    || ![receipt.modelId, receipt.branchId, receipt.branchName].every(value => typeof value === 'string' && value.length > 0)
    || (request && request.targetModelId !== receipt.modelId)
    || job.items.some(item => item.error || item.status !== 'succeeded'
      || !['model_translate', 'model_branch_create', 'model_yaml_write', 'model_branch_verify', 'destination_model_mutation'].includes(item.kind))) return null;
  const checks = job.items.filter(item => item.kind === 'model_branch_verify');
  return checks.length === 1 && checks[0].details?.modelId === receipt.modelId
    && checks[0].details?.branchId === receipt.branchId && checks[0].details?.branchName === receipt.branchName ? receipt : null;
}

/** Metadata-only report: never serialize the full job input, YAML, SQL corrections or vault data. */
export function topicMigrationReport(plan: TopicMigrationPlan, job: MigrationJob | null) {
  const verification = job ? latestBranchVerification(job) : null;
  return {
    version: 2, planId: plan.id, revision: plan.revision,
    source: { instanceId: plan.request.sourceInstanceId, connectionId: plan.request.sourceConnectionId, modelId: plan.request.sourceModelId },
    destination: { instanceId: plan.request.targetInstanceId, connectionId: plan.request.targetConnectionId, modelId: plan.request.targetModelId },
    topics: plan.topics.map(topic => ({ id: topic.id, name: topic.name })),
    files: plan.files.map(file => ({ sourceFileName: file.sourceFileName, fileName: file.fileName, destinationFileName: file.destinationFileName || file.fileName, status: file.status, topicIds: file.topicIds })),
    issues: plan.issues.map(issue => ({ id: issue.id, title: issue.title, kind: issue.kind, severity: issue.severity, topicIds: issue.topicIds, fileName: issue.fileName, nextAction: issue.nextAction })),
    branch: job ? preparedBranchReceipt(job) : null,
    verification: verification ? { requestId: verification.requestId, verifiedAt: verification.verifiedAt, policy: verification.policy,
      verified: verification.verified, files: verification.files.map(file => ({ sourceFileName: file.sourceFileName, destinationFileName: file.destinationFileName, classification: file.classification })),
      findings: verification.findings.map(finding => ({ code: finding.code, fileName: finding.fileName })) } : null,
    job: job ? { id: job.id, status: job.status, phase: topicJobPhase(job),
      operations: job.items.map(item => ({ id: item.id, kind: item.kind, status: item.status })) } : null,
    acceptance: 'Branch preparation is not publication or warehouse query/business-equivalence acceptance. Finalize, validate, and publish manually in Omni.',
  };
}

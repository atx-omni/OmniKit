import assert from 'node:assert/strict';
import { test } from 'node:test';
import { branchVerificationCandidate, canStageTopicPlan, canVerifyTopicBranch, createdReviewBranch, groupTopicMigrationIssues, isMigrationHistoryUnavailable, latestBranchVerification, preparedBranchReceipt, readTopicMigrationDraft, reconciledBranchFilesNotApplied, topicJobMatchesPlan, topicJobPhase, topicJobProgress, topicMigrationReport, topicRequestFingerprint } from '../src/services/topicMigrationFlow';
import { verifyTopicMigrationBranch } from '../src/services/topicMigration';
import { subscribeMigrationJob, type MigrationJobStreamEvent } from '../src/services/opsConsole';
import type { BranchVerificationRecord, TopicMigrationPlan, TopicMigrationRequest } from '../shared/topicMigration';
import type { MigrationJob } from '../src/services/opsConsole';

const request: TopicMigrationRequest = { sourceInstanceId: 'source', sourceConnectionId: 'connection-a', sourceModelId: 'model-a', targetInstanceId: 'target', targetConnectionId: 'connection-b', targetModelId: 'model-b', topicIds: ['topic-b', 'topic-a'], schemaMapText: '' };
const plan: TopicMigrationPlan = { version: 2, executionProfile: 'branch_preparation_v1', id: 'plan', revision: 'revision', request, status: 'ready', createdAt: 100, expiresAt: 200, topics: [], dependencies: [], issues: [], sourceHash: 'source-hash', targetHash: 'target-hash', files: [{ sourceFileName: 'topic-a.topic', fileName: 'topic-a.topic', kind: 'topic', topicIds: ['topic-a'], before: null, proposed: 'base_view: example', status: 'create' }] };
const receipt = { modelId: 'model-b', branchId: 'review-branch', branchName: 'topic-review' };
const job = (): MigrationJob => ({ id: 'job', sourceId: 'source', sourceLabel: 'Source', destinationIds: ['target'], documentIds: [], emptyFirst: false, replaceSameNamed: false, deleteSourceOnSuccess: false, postMigrationActions: [], status: 'succeeded', createdAt: 100, details: { branchPreparation: { profile: 'branch_preparation_v1' }, topicMigration: { request }, branchReceipt: receipt }, items: (['model_branch_create', 'model_yaml_write', 'model_branch_verify'] as const).map(kind => ({ id: kind, jobId: 'job', destinationId: 'target', destinationLabel: 'Destination', targetModelId: request.targetModelId, kind, status: 'succeeded', details: kind === 'model_branch_verify' ? receipt : kind === 'model_branch_create' ? { ...receipt, targetModelId: request.targetModelId } : {} })) });

const recoveryPlan: TopicMigrationPlan = { ...plan, status: 'submitted', jobId: 'job', sourceHash: 'sha256:' + 'a'.repeat(64), targetHash: 'sha256:' + 'b'.repeat(64) };
function recoveryJob(): MigrationJob {
  const value = job(); value.workflow = 'model'; value.status = 'partial'; value.endedAt = 200;
  value.details = { branchPreparation: { profile: 'branch_preparation_v1' }, topicMigration: { request, planId: plan.id, revision: plan.revision,
    sourceHash: recoveryPlan.sourceHash, targetHash: recoveryPlan.targetHash } };
  value.items[1].details = { ...receipt, targetModelId: receipt.modelId };
  value.items[2] = { ...value.items[2], status: 'failed', error: 'Initial branch readback did not match.', details: {} };
  value.items.push({ id: 'lease', jobId: value.id, destinationId: 'target', destinationLabel: 'Target', targetModelId: receipt.modelId,
    kind: 'destination_model_mutation', status: 'succeeded', details: { migrationDestinationModelMutation: true,
      migrationMutationState: 'resolved', migrationMutationOperation: 'model_job', migrationMutationDispatchItemId: value.items[1].id,
      migrationMutationDispatchItemKind: 'model_yaml_write', migrationMutationDispatchFingerprint: 'c'.repeat(64) } });
  return value;
}
const verification: BranchVerificationRecord = { version: 1, policy: 'topic_branch_readback_v1', requestId: '11111111-1111-4111-8111-111111111111',
  planId: plan.id, planRevision: plan.revision, jobId: 'job', targetInstanceId: 'target', ...receipt, verifiedAt: 300,
  sourceHash: recoveryPlan.sourceHash, mainHash: recoveryPlan.targetHash, jobEvidenceHash: 'sha256:' + 'c'.repeat(64),
  expectedHash: 'sha256:' + 'd'.repeat(64), actualHash: 'sha256:' + 'e'.repeat(64), verified: true,
  files: [{ sourceFileName: 'source.records.view', submittedFileName: 'source.records.view', destinationFileName: 'target.records.view', classification: 'mapped_path_and_formatting' }], findings: [] };

test('branch recovery requires an exact standalone saved plan and a confirmed normally resolved write', () => {
  assert.equal(canVerifyTopicBranch(recoveryPlan, request, recoveryJob()), true);
  assert.equal(canVerifyTopicBranch({ ...recoveryPlan, version: 1 }, request, recoveryJob()), false);
  assert.equal(canVerifyTopicBranch({ ...recoveryPlan, dashboardRepair: { planId: 'dashboard', targetId: 'target', revision: 1 } }, request, recoveryJob()), false);
  assert.equal(canVerifyTopicBranch(recoveryPlan, { ...request, targetConnectionId: 'other' }, recoveryJob()), false);
  const mutations: Array<(value: MigrationJob) => void> = [
    value => { value.status = 'running'; }, value => { value.status = 'canceled'; }, value => { value.items[1].status = 'failed'; },
    value => { value.items[1].details!.branchId = 'other'; }, value => { value.items[2].status = 'skipped'; },
    value => { value.items[3].details!.migrationMutationState = 'uncertain'; },
    value => { value.items[3].details!.migrationMutationResolutionKind = 'operator_adjudication'; },
    value => { value.items[3].details!.migrationMutationExternalJobId = 'external'; },
    value => { value.items[3].details!.migrationMutationDispatchItemId = value.items[0].id; },
    value => { value.items.push({ ...value.items[1], id: 'duplicate' }); },
    value => { value.details!.dashboardRepair = {}; },
    value => { value.details!.topicMigration = { request: { ...request, sourceConnectionId: 'other' }, planId: plan.id, revision: plan.revision }; },
  ];
  for (const mutate of mutations) { const value = recoveryJob(); mutate(value); assert.equal(canVerifyTopicBranch(recoveryPlan, request, value), false); }
});

test('branch recovery uses only the latest exact verification while preserving the original failed run and progress', () => {
  const value = recoveryJob(); const originalItems = structuredClone(value.items);
  value.details!.branchVerifications = [verification];
  assert.deepEqual(latestBranchVerification(value), verification);
  assert.deepEqual(preparedBranchReceipt(value), receipt);
  assert.equal(topicJobPhase(value), 'Files verified — ready to review in Omni');
  assert.deepEqual(topicJobProgress(value), { completed: 2, total: 3 });
  assert.equal(value.status, 'partial'); assert.deepEqual(value.items, originalItems);
  for (const patch of [{ branchId: 'other' }, { planRevision: 'stale' }, { jobId: 'other' }, { mainHash: 'sha256:' + 'f'.repeat(64) },
    { actualHash: null }, { jobEvidenceHash: 'invalid' }, { verifiedAt: 100 }, { findings: [{ code: 'mismatch', message: 'Changed formula.' }] }]) {
    value.details!.branchVerifications = [verification, { ...verification, ...patch }];
    assert.equal(latestBranchVerification(value), null); assert.equal(preparedBranchReceipt(value), null);
  }
  value.details!.branchVerifications = [verification, { ...verification, verified: false, actualHash: null, files: [], findings: [{ code: 'read_failed', message: 'Authoritative files unavailable.' }] }];
  assert.equal(latestBranchVerification(value)?.verified, false); assert.equal(preparedBranchReceipt(value), null);
  assert.deepEqual(branchVerificationCandidate(value), receipt);
});

test('branch recovery API sends only exact revision and request ID without resubmitting files or approving writes', async () => {
  const previous = globalThis.fetch; const calls: Array<{ path: string; options?: RequestInit }> = [];
  globalThis.fetch = (async (input, options) => { calls.push({ path: String(input), options }); return new Response(JSON.stringify({ plan: recoveryPlan, job: recoveryJob(), verification })); }) as typeof fetch;
  try {
    await verifyTopicMigrationBranch({ id: 'plan/with path', revision: plan.revision }, verification.requestId);
    assert.equal(calls.length, 1); assert.equal(calls[0].path, '/api/model-migrator/topic-plan/plan%2Fwith%20path/verify');
    assert.equal(calls[0].options?.method, 'POST');
    assert.deepEqual(JSON.parse(String(calls[0].options?.body)), { revision: plan.revision, requestId: verification.requestId });
  } finally { globalThis.fetch = previous; }
});

function reconciledJob(): MigrationJob {
  const value = job(); value.workflow = 'model'; value.status = 'partial'; value.endedAt = 300;
  const audit = { requestId: '11111111-1111-4111-8111-111111111111', requestHash: 'a'.repeat(64), leaseItemId: 'lease',
    priorRevision: 3, resolvedRevision: 4, priorUpdatedAt: 300, destinationInstanceId: 'target', targetModelId: 'model-b',
    operation: 'model_job', dispatchItemId: 'model_yaml_write', dispatchItemKind: 'model_yaml_write', dispatchFingerprint: 'b'.repeat(64),
    outcome: 'verified_not_applied', evidenceSource: 'omni_ui', actor: 'local_unlocked_operator', adjudicatedAt: 400 };
  value.details = { branchPreparation: { profile: 'branch_preparation_v1' }, topicMigration: { request, planId: 'plan', revision: 'revision' }, migrationMutationAdjudications: [audit] };
  value.items[1] = { ...value.items[1], status: 'failed', endedAt: 290, details: { targetModelId: 'model-b', branchName: receipt.branchName } };
  value.items[2] = { ...value.items[2], status: 'skipped', details: {} };
  value.items.push({ id: 'lease', jobId: value.id, destinationId: 'target', destinationLabel: 'Destination', targetModelId: 'model-b',
    kind: 'destination_model_mutation', status: 'succeeded', endedAt: 400, details: {
      migrationDestinationModelMutation: true, migrationMutationState: 'resolved', migrationMutationOperation: 'model_job',
      migrationMutationRevision: 4, migrationMutationUpdatedAt: 400, migrationMutationDispatchItemId: 'model_yaml_write',
      migrationMutationDispatchItemKind: 'model_yaml_write', migrationMutationDispatchedAt: 200, migrationMutationDispatchFingerprint: audit.dispatchFingerprint,
      migrationMutationResolutionKind: 'operator_adjudication', migrationMutationResolutionActor: audit.actor,
      migrationMutationResolutionRequestId: audit.requestId, migrationMutationResolutionRequestHash: audit.requestHash,
      migrationMutationResolutionOutcome: audit.outcome, migrationMutationResolutionEvidenceSource: audit.evidenceSource,
      migrationMutationResolutionConfirmedAt: 400, migrationMutationResolutionExpectedRevision: 3, migrationMutationResolutionExpectedUpdatedAt: 300,
    } });
  return value;
}

test('history guard stream events reach the caller and terminal streams close without false disconnects', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'EventSource');
  const streams: FakeEventSource[] = [];
  class FakeEventSource {
    listeners = new Map<string, (event: MessageEvent<string>) => void>();
    closed = false;
    onerror?: (event: Event) => void;
    constructor() { streams.push(this); }
    addEventListener(type: string, listener: (event: MessageEvent<string>) => void) { this.listeners.set(type, listener); }
    close() { this.closed = true; }
    send(type: string, data: unknown) { this.listeners.get(type)?.({ data: JSON.stringify(data) } as MessageEvent<string>); }
  }
  Object.defineProperty(globalThis, 'EventSource', { configurable: true, value: FakeEventSource });
  try {
    const events: MigrationJobStreamEvent[] = [];
    let errors = 0;
    const stop = subscribeMigrationJob('job', event => events.push(event), () => { errors += 1; });
    streams[0].send('history-unavailable', { jobId: 'job', code: 'MIGRATION_HISTORY_UNAVAILABLE', at: 1 });
    assert.equal(events[0].type, 'history-unavailable');
    assert.equal(isMigrationHistoryUnavailable(events[0]), true);
    assert.equal(isMigrationHistoryUnavailable(new Error('Migration history')), false);
    assert.equal(streams[0].closed, true);
    stop();
    const stopTerminal = subscribeMigrationJob('job', event => events.push(event), () => { errors += 1; });
    streams[1].send('snapshot', { job: job() });
    assert.equal(streams[1].closed, true);
    assert.equal(errors, 0);
    stopTerminal();
  } finally {
    if (previous) Object.defineProperty(globalThis, 'EventSource', previous);
    else Reflect.deleteProperty(globalThis, 'EventSource');
  }
});

test('branch approval binds current pair/topics/mappings and never accepts legacy or stale evidence', () => {
  assert.equal(canStageTopicPlan(plan, request, true, false, 150), true);
  assert.equal(topicRequestFingerprint(request), topicRequestFingerprint({ ...request, topicIds: [...request.topicIds].reverse() }));
  for (const changed of [{ targetModelId: 'other' }, { sourceConnectionId: 'other' }, { topicIds: ['topic-a'] }, { schemaMapText: 'a=b' }]) assert.equal(canStageTopicPlan(plan, { ...request, ...changed }, true, false, 150), false);
  assert.equal(canStageTopicPlan(plan, request, false, false, 150), false);
  assert.equal(canStageTopicPlan(plan, request, true, true, 150), false);
  assert.equal(canStageTopicPlan(plan, request, true, false, 200), false);
  assert.equal(canStageTopicPlan({ ...plan, version: 1 }, request, true, false, 150), false);
  for (const status of ['submitted', 'unchanged', 'blocked'] as const) assert.equal(canStageTopicPlan({ ...plan, status }, request, true, false, 150), false);
});

test('warnings do not block preparation while missing definitions and collisions still do', () => {
  const issue = { id: 'sql', kind: 'sql' as const, severity: 'review' as const, title: 'SQL review', message: 'Finish in Omni', nextAction: 'Review', topicIds: ['topic-a'], fileName: 'example.view' };
  assert.equal(canStageTopicPlan({ ...plan, issues: [issue] }, request, true, false, 150), true);
  assert.equal(canStageTopicPlan({ ...plan, issues: [{ ...issue, severity: 'blocker', kind: 'conflict' }] }, request, true, false, 150), false);
  assert.equal(canStageTopicPlan({ ...plan, files: [{ ...plan.files[0], status: 'blocked' }] }, request, true, false, 150), false);
  assert.equal(groupTopicMigrationIssues([issue, { ...issue, id: 'field-b' }]).length, 1);
});

test('only exact branch readback enables a prepared receipt and partial writes remain visible', () => {
  assert.deepEqual(preparedBranchReceipt(job()), receipt);
  assert.equal(topicJobPhase(job()), 'Ready to review in Omni');
  const value = job(); value.items[2].details = { ...receipt, branchId: 'wrong' };
  assert.equal(preparedBranchReceipt(value), null);
  value.items[2].details = receipt; value.items[2].status = 'failed'; value.status = 'failed';
  assert.equal(preparedBranchReceipt(value), null);
  assert.match(topicJobPhase(value), /copied files unverified/);
  const old = job(); old.details = {}; assert.equal(preparedBranchReceipt(old), null);
  const duplicate = job(); duplicate.items.push({ ...duplicate.items[2] }); assert.equal(preparedBranchReceipt(duplicate), null);
});

test('branch phases describe the three user-facing steps without counting lease or scope bookkeeping', () => {
  for (const [index, label] of [[0, 'Creating review branch'], [1, 'Copying approved files'], [2, 'Verifying copied files']] as const) {
    const value = job(); value.status = 'running';
    value.items.forEach((item, itemIndex) => { item.status = itemIndex < index ? 'succeeded' : itemIndex === index ? 'running' : 'pending'; });
    value.items.unshift({ ...value.items[0], id: 'scope', kind: 'model_translate', status: 'succeeded' },
      { ...value.items[0], id: 'lease', kind: 'destination_model_mutation', status: 'running' });
    assert.equal(topicJobPhase(value), label);
    assert.deepEqual(topicJobProgress(value), { completed: index, total: 3 });
  }
  const value = job(); value.items[1].status = 'failed'; value.items[2].status = 'skipped'; value.status = 'partial';
  assert.deepEqual(topicJobProgress(value), { completed: 1, total: 3 });
  const legacy = job(); legacy.details = {};
  legacy.items = [{ ...legacy.items[0], kind: 'model_merge' }];
  assert.equal(topicJobPhase(legacy), 'Published — verify destination behavior');
  legacy.items[0].kind = 'model_pr';
  assert.equal(topicJobPhase(legacy), 'Review handoff created — not published');
});

test('created-branch evidence requires an exact unique creation result and never implies copied-file verification', () => {
  const value = job(); value.status = 'running'; value.items[1].status = 'running'; value.items[2].status = 'pending';
  assert.deepEqual(createdReviewBranch(value), receipt);
  assert.equal(preparedBranchReceipt(value), null);
  for (const patch of [{ branchId: undefined }, { branchName: '' }, { targetModelId: 'wrong-model' }]) {
    const invalid = structuredClone(value); invalid.items[0].details = { ...invalid.items[0].details, ...patch };
    assert.equal(createdReviewBranch(invalid), null);
  }
  const duplicate = structuredClone(value); duplicate.items.push({ ...duplicate.items[0], id: 'duplicate' });
  assert.equal(createdReviewBranch(duplicate), null);
  const wrongDestination = structuredClone(value); wrongDestination.items[0].destinationId = 'other';
  assert.equal(createdReviewBranch(wrongDestination), null);
  const legacy = structuredClone(value); legacy.details = {};
  assert.equal(createdReviewBranch(legacy), null);
});

test('only a fully bound terminal YAML non-write adjudication shows reconciled without a prepared receipt', () => {
  for (const status of ['failed', 'canceled', 'partial'] as const) {
    const value = reconciledJob(); value.status = status;
    assert.deepEqual(reconciledBranchFilesNotApplied(value), { leaseItemId: 'lease' });
    assert.equal(topicJobPhase(value), 'Reconciled — files not applied');
    assert.equal(preparedBranchReceipt(value), null);
    assert.deepEqual(createdReviewBranch(value), receipt);
  }
  const corruptions: Array<(value: MigrationJob) => void> = [
    value => { value.status = 'running'; }, value => { value.workflow = 'dashboard'; },
    value => { value.details!.branchPreparation = { profile: 'legacy' }; }, value => { value.details!.branchReceipt = receipt; },
    value => { value.items[1].status = 'succeeded'; }, value => { value.items[1].details!.branchName = 'other'; },
    value => { value.items[1].jobId = 'other'; }, value => { value.items[2].status = 'succeeded'; },
    value => { value.items[3].details!.migrationMutationState = 'uncertain'; },
    value => { value.items[3].details!.migrationMutationResolutionOutcome = 'verified_applied'; },
    value => { value.items[3].details!.migrationMutationResolutionOutcome = 'verified_partial_terminal'; },
    value => { value.items[3].details!.migrationMutationResolutionRequestHash = 'malformed'; },
    value => { value.items[3].details!.migrationMutationResolutionRequestId = 'malformed'; },
    value => { value.items[3].details!.migrationMutationResolutionExpectedRevision = 4; },
    value => { value.items[3].details!.migrationMutationDispatchedAt = 500; },
    value => { value.items[3].details!.migrationMutationExternalJobId = 'external'; },
    value => { value.items[3].details!.migrationMutationDispatchItemId = value.items[0].id; },
    value => { value.items[3].targetModelId = 'other'; }, value => { value.items[3].endedAt = 399; },
    value => { value.details!.migrationMutationAdjudications = []; },
    value => { const audits = value.details!.migrationMutationAdjudications as Record<string, unknown>[]; audits.push({ ...audits[0] }); },
    value => { const audits = value.details!.migrationMutationAdjudications as Record<string, unknown>[]; audits[0].dispatchFingerprint = 'c'.repeat(64); },
    value => { const audits = value.details!.migrationMutationAdjudications as Record<string, unknown>[]; audits[0].destinationInstanceId = 'other'; },
    value => { const audits = value.details!.migrationMutationAdjudications as Record<string, unknown>[]; audits[0].actor = 'unknown'; },
    value => { value.items.push({ ...value.items[3], id: 'second-lease' }); },
  ];
  for (const [index, corrupt] of corruptions.entries()) {
    const invalid = reconciledJob(); corrupt(invalid);
    assert.equal(reconciledBranchFilesNotApplied(invalid), null, `invalid evidence ${index}`);
    assert.notEqual(topicJobPhase(invalid), 'Reconciled — files not applied');
  }
});

test('resume and reports retain references but not secrets, definitions, or approvals', () => {
  assert.deepEqual(readTopicMigrationDraft(JSON.stringify({ version: 1, planId: 'plan', jobId: 'job', approved: true, apiKey: 'fixture-only', yaml: 'private' })), { version: 1, planId: 'plan', jobId: 'job' });
  for (const value of ['not json', '{}', '{"version":1,"planId":"../path"}', 'null']) assert.equal(readTopicMigrationDraft(value), null);
  const value = job(); value.details = { retryInput: { apiKey: 'fixture-secret' } };
  const report = JSON.stringify(topicMigrationReport(plan, value));
  for (const excluded of ['fixture-secret', 'base_view', 'retryInput']) assert.equal(report.includes(excluded), false);
  assert.match(report, /publish manually in Omni/);
});

test('a prepared job still requires its exact submitted plan and destination', () => {
  const current = { ...plan, status: 'submitted' as const, jobId: 'job' }; const value = job();
  value.details = { ...value.details, topicMigration: { planId: current.id, revision: current.revision } };
  assert.equal(topicJobMatchesPlan(current, request, value), true);
  assert.equal(topicJobMatchesPlan(current, { ...request, targetInstanceId: 'elsewhere' }, value), false);
  assert.equal(topicJobMatchesPlan({ ...current, revision: 'stale' }, request, value), false);
  assert.equal(topicJobMatchesPlan(plan, request, value), false);
});

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TopicBranchCorrectionPlan, TopicBranchValidation } from '../../shared/topicBranchCorrection';
import type { MigrationJob, MigrationJobItem } from './migrationJobs';
import { getJob, getJobsDbPath, insertJob, listJobs, updateJobAtomically } from './jobStore';
import { sanitizeJob } from './jobSanitizer';
import { getInstance, isVaultUnlocked, listInstances } from './nativeVault';
import { OmniClient, OmniClientError, OmniWriteNotDispatchedError, type OmniModelYamlResponse } from './omniClient';
import { getTopicBranchCorrectionOrigin } from './topicMigrationPlans';
import { buildTopicBranchCorrections } from './topicBranchCorrectionPlanner';
import { readTopicMigrationTableNameEvidence } from './topicMigrationTableNameEvidence';
import { compareTopicMigrationBranch, topicMigrationDestinationPath } from './topicMigrationVerification';
import { topicMigrationSnapshotHash } from './topicMigrationPlanner';
import { migrationDestinationModelMutationLease, reserveMigrationDestinationModels, type MigrationDestinationModelScope } from './migrationScopeReservation';
import { dashboardSafeCopyHasUnresolvedDestinationModelOverlap } from './dashboardSafeCopyJobs';
import { validateTopicCorrectionBranch } from './topicBranchValidation';

const TTL = 15 * 60_000;
const RULE = 'review_branch_corrections_v1';
const active = new Map<string, AbortController>();
const busy = new Set<string>();
type Row = {
  plan: TopicBranchCorrectionPlan;
  boundaryHash: string;
  originRevision: string;
  sourceHash: string;
  mainFiles: Record<string, string>;
  baseline: Record<string, string>;
  evidenceHash: string;
  scopeHash: string;
  claim?: string;
  cancelRequested?: boolean;
  /** Persisted before network dispatch; ambiguous requests are never replayed. */
  dispatched?: string[];
  acknowledged?: string[];
  rejected?: string[];
};
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const emptyValidation = (): TopicBranchValidation => ({ status: 'not_run', issues: [] });
const path = () => getJobsDbPath() + '.branch-corrections.json';
function fail(message: string, statusCode = 409): never {
  throw Object.assign(new Error(message), { statusCode, code: 'TOPIC_BRANCH_CORRECTION_REVIEW_REQUIRED' });
}
function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function keys(value: unknown, allowed: string[]): asserts value is Record<string, unknown> {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('Unsupported correction request.', 400);
}
function proof(row: Row) {
  const mutable = new Set(['revision', 'status', 'jobId', 'progress', 'outcomes', 'filesVerified', 'mainUnchanged', 'validation', 'contentValidation']);
  return hash({ rule: RULE, plan: Object.fromEntries(Object.entries(row.plan).filter(([key]) => !mutable.has(key))),
    boundaryHash: row.boundaryHash, originRevision: row.originRevision, sourceHash: row.sourceHash,
    mainFiles: row.mainFiles, baseline: row.baseline, evidenceHash: row.evidenceHash, scopeHash: row.scopeHash });
}
function rows(): Row[] {
  if (!existsSync(path())) return [];
  let data: unknown;
  try { data = JSON.parse(readFileSync(path(), 'utf8')); } catch { fail('Correction history is unavailable. Preserve it and restore access before continuing.', 503); }
  if (!Array.isArray(data) || data.length > 500) fail('Correction history is invalid.', 503);
  try {
    if (data.some(row => !object(row) || !object(row.plan) || row.plan.version !== 1 || row.plan.revision !== proof(row as Row))
      || new Set(data.map(row => row.plan.id)).size !== data.length) fail('Correction evidence changed or is incomplete.', 503);
  } catch { fail('Correction evidence changed or is incomplete.', 503); }
  return data as Row[];
}
function save(row: Row) {
  const all = rows(), index = all.findIndex(item => item.plan.id === row.plan.id);
  if (index < 0) { if (all.length >= 500) fail('Correction history capacity reached.'); all.push(row); } else all[index] = row;
  mkdirSync(dirname(path()), { recursive: true, mode: 0o700 });
  const temporary = path() + '.' + randomUUID() + '.tmp';
  writeFileSync(temporary, JSON.stringify(all), { mode: 0o600, flag: 'wx' }); renameSync(temporary, path());
}
function load(id: string): Row {
  const row = rows().find(candidate => candidate.plan.id === id);
  if (!row) fail('Correction review not found.', 404);
  const origin = getTopicBranchCorrectionOrigin(row.plan.originPlanId);
  if (origin.boundaryHash !== row.boundaryHash || origin.plan.revision !== row.originRevision
    || hash(origin.branch) !== hash(row.plan.branch) || origin.jobId !== row.plan.originJobId) fail('The original migration authority changed.');
  return row;
}
function scopes(row: { plan: { request: { targetInstanceId: string }; branch: { modelId: string } } }): MigrationDestinationModelScope[] {
  const target = getInstance(row.plan.request.targetInstanceId);
  if (!target || !isVaultUnlocked()) fail('Unlock the saved destination before continuing.', 423);
  const origin = new URL(target.baseUrl).origin;
  return listInstances().filter(instance => new URL(instance.baseUrl).origin === origin)
    .map(instance => ({ destinationInstanceId: instance.id, targetModelId: row.plan.branch.modelId }))
    .sort((a, b) => a.destinationInstanceId.localeCompare(b.destinationInstanceId));
}
function idle(scope: MigrationDestinationModelScope[], excludeJobId?: string) {
  const aliases = new Set(scope.map(item => item.destinationInstanceId)), model = scope[0]?.targetModelId;
  const jobs = listJobs(Number.MAX_SAFE_INTEGER).filter(job => job.id !== excludeJobId);
  const knownInstances = new Set(listInstances().map(instance => instance.id));
  for (const alias of aliases) if (dashboardSafeCopyHasUnresolvedDestinationModelOverlap(alias, [model], jobs)) fail('Another destination write requires reconciliation.');
  for (const job of jobs) for (const item of job.items) {
    if ((item.destinationId && !aliases.has(item.destinationId) && knownInstances.has(item.destinationId))
      || (item.targetModelId && item.targetModelId !== model)) continue;
    const lease = migrationDestinationModelMutationLease(item);
    if (['pending', 'running'].includes(item.status) || (item.details?.migrationDestinationModelMutation === true
      && (!lease || !['resolved', 'failed_prewrite'].includes(lease.state)))) fail('Another operation owns this destination. Reconcile it first.');
  }
}
function yaml(response: OmniModelYamlResponse) {
  if (!object(response.raw) || !object(response.raw.files) || Object.keys(response.raw.files).length > 5000
    || Object.values(response.raw.files).some(value => typeof value !== 'string')
    || topicMigrationSnapshotHash(response.raw.files as Record<string, string>) !== topicMigrationSnapshotHash(response.files)) fail('Authoritative YAML is incomplete. No changes are allowed.');
  return response;
}
async function evidence(origin: ReturnType<typeof getTopicBranchCorrectionOrigin>, signal?: AbortSignal, includeTableNames = true) {
  const request = origin.plan.request, source = getInstance(request.sourceInstanceId), target = getInstance(request.targetInstanceId);
  if (!source || !target || !isVaultUnlocked()) fail('Unlock the source and destination.', 423);
  const sourceClient = new OmniClient(source, { signal, requestTimeoutMs: 10_000, maxReadRetries: 1 });
  const client = new OmniClient(target, { signal, requestTimeoutMs: 10_000, maxReadRetries: 1 });
  const [sourceConnections, targetConnections, sourceModels, targetModels, branches] = await Promise.all([
    sourceClient.listConnections(signal), client.listConnections(signal),
    sourceClient.listModels({ modelKind: 'SHARED', connectionId: request.sourceConnectionId }, signal),
    client.listModels({ modelKind: 'SHARED', connectionId: request.targetConnectionId }, signal), client.listModels('BRANCH'),
  ]);
  const sc = sourceConnections.filter(c => c.id === request.sourceConnectionId && !c.deletedAt);
  const tc = targetConnections.filter(c => c.id === request.targetConnectionId && !c.deletedAt);
  const sm = sourceModels.filter(m => m.id === request.sourceModelId && m.connectionId === request.sourceConnectionId && !m.deletedAt);
  const tm = targetModels.filter(m => m.id === request.targetModelId && m.connectionId === request.targetConnectionId && !m.deletedAt);
  const branch = branches.filter(b => b.id === origin.branch.branchId && b.baseModelId === request.targetModelId
    && b.name === origin.branch.branchName && b.connectionId === request.targetConnectionId && !b.deletedAt);
  if (sc.length !== 1 || tc.length !== 1 || sm.length !== 1 || tm.length !== 1 || branch.length !== 1 || tm[0].gitFollower) fail('The exact editable destination branch and model ownership could not be verified.');
  const [sourceYaml, mainYaml, branchYaml] = await Promise.all([
    sourceClient.getModelYaml(request.sourceModelId, { fullyResolved: false, includeChecksums: true, signal }),
    client.getModelYaml(request.targetModelId, { fullyResolved: false, includeChecksums: true, signal }),
    client.getModelYaml(request.targetModelId, { branchId: origin.branch.branchId, fullyResolved: false, includeChecksums: true, signal }),
  ]);
  yaml(sourceYaml); yaml(mainYaml); yaml(branchYaml);
  const candidates = origin.plan.files.filter(file => ['create', 'add'].includes(file.status)).map(file => {
    const name = topicMigrationDestinationPath(file, request.schemaMapText);
    return { ...file, fileName: name, proposed: branchYaml.files[name] || file.proposed };
  });
  const tableNames = includeTableNames ? await readTopicMigrationTableNameEvidence(candidates, async (namespace, readSignal) => yaml(await client.getModelYaml(request.targetModelId,
    { branchId: origin.branch.branchId, includeSchemas: namespace, fullyResolved: true, signal: readSignal })), signal, { includeColumns: true }) : [];
  if (getTopicBranchCorrectionOrigin(origin.plan.id).boundaryHash !== origin.boundaryHash) fail('Saved instance authority changed while reading.');
  const sourceDialect = sc[0].dialect || '', targetDialect = tc[0].dialect || '';
  return { client, mainYaml, branchYaml, sourceHash: topicMigrationSnapshotHash(sourceYaml.files), sourceDialect, targetDialect, tableNames,
    evidenceHash: hash({ tableNames, sourceDialect, targetDialect, protected: [tm[0].gitFollower, tm[0].gitProtected, tm[0].pullRequestRequired] }) };
}

// Shared read/ownership checks only. Omitting the flag preserves legacy correction evidence exactly.
export { evidence as readTopicBranchCorrectionEvidence, scopes as topicBranchCorrectionScopes,
  idle as assertTopicBranchCorrectionScopeIdle, yaml as requireTopicBranchCorrectionYaml };

export async function prepareTopicBranchCorrection(originPlanId: string, value: unknown, signal?: AbortSignal) {
  keys(value, ['predecessorId']);
  if (value.predecessorId !== undefined && typeof value.predecessorId !== 'string') fail('Invalid prior correction identity.', 400);
  const origin = getTopicBranchCorrectionOrigin(originPlanId);
  if (value.predecessorId) {
    const prior = load(value.predecessorId as string);
    if (prior.plan.originPlanId !== originPlanId || ['running', 'uncertain'].includes(prior.plan.status)) fail('Check and reconcile the prior correction before a fresh review.');
  }
  const release = reserveMigrationDestinationModels('correction-review:' + randomUUID(), origin.scopes);
  try {
    idle(origin.scopes);
    const current = await evidence(origin, signal);
    const analysis = buildTopicBranchCorrections({ originalFiles: origin.plan.files, schemaMapText: origin.plan.request.schemaMapText,
      branchFiles: current.branchYaml.files, branchChecksums: current.branchYaml.checksums || {}, sourceDialect: current.sourceDialect,
      targetDialect: current.targetDialect, tableNames: current.tableNames });
    const changed = analysis.files.filter(file => file.status === 'add');
    if (changed.length > 200) fail('Split this correction into fewer than 200 changed files.');
    signal?.throwIfAborted();
    const plan: TopicBranchCorrectionPlan = { version: 1, id: randomUUID(), revision: '', originPlanId, originJobId: origin.jobId,
      ...(value.predecessorId ? { predecessorId: value.predecessorId as string } : {}), branch: origin.branch, request: origin.plan.request,
      createdAt: Date.now(), expiresAt: Date.now() + TTL, ...analysis, sourceDialect: current.sourceDialect, targetDialect: current.targetDialect,
      status: analysis.issues.some(issue => issue.severity === 'blocker') || analysis.files.some(file => file.status === 'blocked') ? 'blocked' : changed.length ? 'ready' : 'unchanged',
      progress: 'Review current branch → proposed corrections. Nothing has been written.',
      outcomes: changed.map(file => ({ fileName: file.fileName, status: 'pending' })), filesVerified: false,
      validation: emptyValidation(), contentValidation: emptyValidation() };
    const row: Row = { plan, boundaryHash: origin.boundaryHash, originRevision: origin.plan.revision, sourceHash: current.sourceHash,
      mainFiles: current.mainYaml.files, baseline: current.branchYaml.files, evidenceHash: current.evidenceHash, scopeHash: hash(origin.scopes) };
    plan.revision = proof(row); save(row); return plan;
  } finally { release(); }
}

function mirror(row: Row, leaseState: 'claimed' | 'dispatched' | 'uncertain' | 'resolved' | 'failed_prewrite') {
  if (!row.plan.jobId) return;
  const now = Date.now();
  const updated = updateJobAtomically(row.plan.jobId, job => {
    const isRunning = row.plan.status === 'running';
    return { ...job, status: isRunning ? 'running' : row.plan.status === 'applied' ? 'succeeded' : row.plan.status === 'canceled' ? 'canceled' : 'partial',
      ...(isRunning ? {} : { endedAt: now }), items: job.items.map(item => item.kind === 'destination_model_mutation'
        ? { ...item, status: ['resolved', 'failed_prewrite'].includes(leaseState) ? 'succeeded' : 'running',
          ...(leaseState === 'resolved' || leaseState === 'failed_prewrite' ? { endedAt: now } : {}),
          details: { ...item.details, migrationMutationState: leaseState, migrationMutationUpdatedAt: now,
            migrationMutationRevision: Number(item.details?.migrationMutationRevision || 0) + 1 } }
        : { ...item, status: isRunning ? 'running' : row.plan.filesVerified ? 'succeeded' : 'failed',
          ...(isRunning ? {} : { endedAt: now }) }) };
  });
  if (!updated) fail('The correction job history disappeared. No further writes are allowed.', 503);
}
function lease(row: Row) {
  const job = row.plan.jobId ? getJob(row.plan.jobId) : undefined;
  if (!job || job.parentJobId !== row.plan.originJobId || job.details?.branchCorrectionId !== row.plan.id) fail('The correction job binding is missing.');
  return job;
}
export function getTopicBranchCorrection(id: string) {
  const row = load(id);
  if (row.plan.status === 'running' && !active.has(id)) {
    row.plan.status = 'uncertain'; row.plan.progress = 'Work was interrupted. Check the branch outcome before continuing; no writes will replay.';
    save(row); mirror(row, 'uncertain');
  }
  return row.plan;
}
function verifyBranch(row: Row, actual: Record<string, string>, files = row.plan.files.filter(file => file.status === 'add'), baseline = row.baseline) {
  // Paths are already destination identities for this update, not source-to-main additions.
  return compareTopicMigrationBranch({ files: files.map(file => ({ ...file, sourceFileName: file.fileName, destinationFileName: file.fileName })),
    schemaMapText: '', baseline, actual });
}
function stillAuthorized(row: Row) {
  const latest = load(row.plan.id), job = lease(latest);
  if (!latest.claim || latest.claim !== row.claim || latest.plan.revision !== row.plan.revision || latest.plan.status !== 'running'
    || latest.cancelRequested || job.status !== 'running' || hash(scopes(latest)) !== latest.scopeHash) fail('This correction is canceled, consumed, or no longer running.');
  const owner = job.items.find(item => item.kind === 'destination_model_mutation');
  if (!owner || !['claimed', 'dispatched'].includes(migrationDestinationModelMutationLease(owner)?.state || '')) fail('The correction write lease is unavailable.');
}

export async function applyTopicBranchCorrection(id: string, value: unknown, signal?: AbortSignal) {
  keys(value, ['revision', 'approve']);
  if (value.approve !== true || typeof value.revision !== 'string') fail('Approve the exact correction revision.', 400);
  if (busy.has(id)) fail('This review is already being submitted.'); busy.add(id);
  let release: (() => void) | undefined;
  try {
    const row = load(id);
    if (row.plan.revision !== value.revision) fail('Correction review changed. Recheck before approving.');
    if (row.claim) return getTopicBranchCorrection(id); // Same approval never dispatches twice.
    if (listJobs(Number.MAX_SAFE_INTEGER).some(job => job.details?.branchCorrectionId === id)) fail('A correction job already exists. Reconcile its saved result; no second job is allowed.');
    if (row.plan.status !== 'ready' || row.plan.expiresAt <= Date.now()) fail('Recheck the correction review before approving.');
    const scope = scopes(row); release = reserveMigrationDestinationModels('correction:' + id, scope); idle(scope);
    const current = await evidence(getTopicBranchCorrectionOrigin(row.plan.originPlanId), signal);
    if (hash(scopes(row)) !== row.scopeHash) fail('Destination aliases changed. Recheck the review.');
    idle(scope);
    if (current.sourceHash !== row.sourceHash || current.evidenceHash !== row.evidenceHash
      || topicMigrationSnapshotHash(current.mainYaml.files) !== topicMigrationSnapshotHash(row.mainFiles)
      || topicMigrationSnapshotHash(current.branchYaml.files) !== topicMigrationSnapshotHash(row.baseline)
      || row.plan.files.some(file => file.status === 'add' && (!file.previousChecksum || file.previousChecksum !== current.branchYaml.checksums?.[file.fileName]))) fail('The branch or approval evidence changed. Recheck and approve a new diff.');
    signal?.throwIfAborted();
    row.claim = randomUUID(); row.plan.jobId = randomUUID(); row.plan.status = 'running'; row.plan.progress = 'Checking approved branch corrections…';
    const now = Date.now(), request = row.plan.request, jobId = row.plan.jobId;
    const item = (kind: MigrationJobItem['kind']): MigrationJobItem => ({ id: randomUUID(), jobId, destinationId: request.targetInstanceId,
      destinationLabel: 'Review branch corrections', targetModelId: request.targetModelId, kind, status: 'running', startedAt: now,
      details: kind === 'destination_model_mutation' ? { migrationDestinationModelMutation: true, migrationMutationOperation: 'model_job',
        migrationMutationState: 'claimed', migrationMutationUpdatedAt: now, migrationMutationRevision: 1 } : { branchId: row.plan.branch.branchId } });
    const job: MigrationJob = { id: jobId, workflow: 'model', parentJobId: row.plan.originJobId, sourceId: request.sourceInstanceId,
      sourceLabel: 'Reviewed branch corrections', destinationIds: [request.targetInstanceId], documentIds: [], emptyFirst: false,
      replaceSameNamed: false, deleteSourceOnSuccess: false, postMigrationActions: [], status: 'running', createdAt: now, startedAt: now,
      details: { branchCorrectionId: id }, items: [item('destination_model_mutation'), item('model_yaml_write')] };
    if (hash(sanitizeJob(job)) !== hash(job)) fail('Exact correction job evidence cannot be retained.');
    save(row); // One-use claim precedes any job or tenant mutation, after the sanitizer preflight.
    try { insertJob(job); } catch (error) {
      row.plan.status = 'partial'; row.plan.progress = 'No tenant write was attempted. Restore job-history access and prepare a fresh review.';
      save(row); throw error;
    }
    const controller = new AbortController(); active.set(id, controller);
    const retainedRelease = release; release = undefined;
    void execute(row, controller, retainedRelease).catch(() => { /* Durable lease remains fail-closed if persistence fails. */ });
    return row.plan;
  } finally { release?.(); busy.delete(id); }
}

async function execute(row: Row, controller: AbortController, release: () => void) {
  let dispatchedFile: string | undefined;
  const deadline = AbortSignal.timeout(5 * 60_000), signal = AbortSignal.any([controller.signal, deadline]);
  const target = getInstance(row.plan.request.targetInstanceId)!;
  const client = new OmniClient(target, { signal, requestTimeoutMs: 15_000, maxReadRetries: 1 });
  let expected = { ...row.baseline };
  try {
    const changes = row.plan.files.filter(file => file.status === 'add');
    for (let index = 0; index < changes.length; index++) {
      stillAuthorized(row); signal.throwIfAborted();
      const file = changes[index];
      const [liveBranches, mainRead, sourceRead, branchRead] = await Promise.all([
        client.listModels('BRANCH'), client.getModelYaml(row.plan.branch.modelId, { fullyResolved: false }),
        new OmniClient(getInstance(row.plan.request.sourceInstanceId)!, { signal, requestTimeoutMs: 10_000, maxReadRetries: 1 })
          .getModelYaml(row.plan.request.sourceModelId, { fullyResolved: false }),
        client.getModelYaml(row.plan.branch.modelId, { branchId: row.plan.branch.branchId, includeChecksums: true, fullyResolved: false }),
      ]);
      if (liveBranches.filter(branch => branch.id === row.plan.branch.branchId && branch.name === row.plan.branch.branchName
        && branch.baseModelId === row.plan.branch.modelId && branch.connectionId === row.plan.request.targetConnectionId && !branch.deletedAt).length !== 1
        || topicMigrationSnapshotHash(yaml(mainRead).files) !== topicMigrationSnapshotHash(row.mainFiles)
        || topicMigrationSnapshotHash(yaml(sourceRead).files) !== row.sourceHash) fail('Branch identity, main, or source changed. Recheck before continuing.');
      const before = yaml(branchRead);
      if (topicMigrationSnapshotHash(before.files) !== topicMigrationSnapshotHash(expected) || before.checksums?.[file.fileName] !== file.previousChecksum) fail('Branch changed during correction. Remaining files were not applied.');
      row.plan.progress = `Updating file ${index + 1} of ${changes.length}: ${file.fileName}`;
      row.plan.outcomes[index].status = 'writing'; save(row);
      await client.updateModelYamlFile({ modelId: row.plan.branch.modelId, branchId: row.plan.branch.branchId,
        fileName: file.fileName, yaml: file.proposed, previousChecksum: file.previousChecksum,
        commitMessage: 'OmniKit approved review-branch corrections' }, { signal, assertCanDispatch: () => {
        stillAuthorized(row); signal.throwIfAborted();
        dispatchedFile = file.fileName; row.dispatched = [...(row.dispatched || []), file.fileName]; save(row); mirror(row, 'dispatched');
      } });
      row.acknowledged = [...(row.acknowledged || []), file.fileName]; save(row);
      row.plan.progress = `Verifying file ${index + 1} of ${changes.length}…`; save(row);
      const actual = yaml(await client.getModelYaml(row.plan.branch.modelId, { branchId: row.plan.branch.branchId, fullyResolved: false }));
      const comparison = verifyBranch(row, actual.files, [{ ...file, before: before.files[file.fileName] }], expected);
      if (!comparison.verified) fail('The branch readback did not match the approved corrections. Check the saved outcome.');
      expected = actual.files; row.plan.outcomes[index].status = 'applied'; dispatchedFile = undefined; save(row);
    }
    const main = yaml(await client.getModelYaml(row.plan.branch.modelId, { fullyResolved: false }));
    row.plan.mainUnchanged = topicMigrationSnapshotHash(main.files) === topicMigrationSnapshotHash(row.mainFiles);
    row.plan.filesVerified = true; row.plan.progress = 'Files applied. Validating this branch…'; save(row);
    row.plan.validation = await validateTopicCorrectionBranch(client, row.plan.branch.modelId, row.plan.branch.branchId,
      topicMigrationSnapshotHash(expected), 'model', row.plan.request.topicIds, signal);
    const validated = yaml(await client.getModelYaml(row.plan.branch.modelId, { branchId: row.plan.branch.branchId, fullyResolved: false }));
    if (topicMigrationSnapshotHash(validated.files) !== topicMigrationSnapshotHash(expected)) {
      row.plan.validation = { ...row.plan.validation, status: 'unavailable', message: 'The branch changed during validation. Recheck before relying on this result.' };
      row.plan.filesVerified = false; fail('Branch changed during validation.');
    }
    row.plan.status = 'applied'; row.plan.progress = row.plan.validation.status === 'passed'
      ? 'Files verified and model validation passed. Queries still need testing in Omni.' : 'Files verified. Review the model validation result before publishing in Omni.';
    if (!row.plan.mainUnchanged) row.plan.progress += ' Destination main changed independently; recheck before publication.';
    save(row); mirror(row, 'resolved');
  } catch (error) {
    const acknowledged = dispatchedFile && row.acknowledged?.includes(dispatchedFile);
    const definitive = !acknowledged && (error instanceof OmniWriteNotDispatchedError || (error instanceof OmniClientError && [400, 401, 403, 404, 409, 422, 429].includes(error.status)));
    if (dispatchedFile && definitive) row.rejected = [...(row.rejected || []), dispatchedFile];
    const unknown = Boolean(dispatchedFile && !definitive);
    row.plan.outcomes = row.plan.outcomes.map(outcome => outcome.status === 'writing' ? { ...outcome, status: unknown ? 'unknown' : 'unapplied' } : outcome);
    row.plan.status = unknown ? 'uncertain' : controller.signal.aborted ? 'canceled' : 'partial';
    row.plan.progress = unknown ? 'A write outcome is uncertain. Check branch outcome; do not repeat the write.'
      : 'Remaining work stopped. Check branch outcome, then review a new correction if needed.';
    save(row); mirror(row, unknown ? 'uncertain' : row.dispatched?.length ? 'resolved' : 'failed_prewrite');
  } finally { active.delete(row.plan.id); release(); }
}

export function cancelTopicBranchCorrection(id: string) {
  const row = load(id); row.cancelRequested = true; save(row); active.get(id)?.abort(new Error('Correction canceled'));
  return getTopicBranchCorrection(id);
}

export async function reconcileTopicBranchCorrection(id: string, signal?: AbortSignal) {
  if (active.has(id) || busy.has(id)) fail('Wait for the current correction operation to stop.');
  busy.add(id); let release: (() => void) | undefined;
  try {
    const row = load(id); if (!row.claim) return row.plan;
    lease(row); const scope = scopes(row); release = reserveMigrationDestinationModels('correction-check:' + id, scope); idle(scope, row.plan.jobId);
    const current = await evidence(getTopicBranchCorrectionOrigin(row.plan.originPlanId), signal);
    let unresolved = false;
    row.plan.outcomes = row.plan.outcomes.map(outcome => {
      const file = row.plan.files.find(file => file.fileName === outcome.fileName)!;
      const actual = current.branchYaml.files[file.fileName];
      const check = verifyBranch(row, { ...row.baseline, [file.fileName]: actual }, [file]);
      const status = check.verified ? 'applied' : actual === file.before ? 'unapplied' : 'divergent';
      if (row.dispatched?.includes(file.fileName) && !row.acknowledged?.includes(file.fileName) && !row.rejected?.includes(file.fileName)
        && status !== 'applied') unresolved = true; // A negative read cannot prove a timed-out request will never arrive.
      return { fileName: file.fileName, status };
    });
    row.plan.filesVerified = verifyBranch(row, current.branchYaml.files).verified;
    row.plan.mainUnchanged = topicMigrationSnapshotHash(current.mainYaml.files) === topicMigrationSnapshotHash(row.mainFiles);
    row.plan.status = unresolved ? 'uncertain' : row.plan.filesVerified ? 'applied' : 'partial';
    row.plan.progress = unresolved ? 'Uncertain writes are not proven terminal. Inspect the branch and reconcile the outstanding operation before another approval.'
      : row.plan.filesVerified ? 'Approved corrections are present. Run model validation before reviewing in Omni.'
      : 'Applied and remaining changes identified. Review a new correction; existing writes will not replay.';
    signal?.throwIfAborted(); save(row); mirror(row, unresolved ? 'uncertain' : 'resolved'); return row.plan;
  } finally { release?.(); busy.delete(id); }
}

export async function validateTopicBranchCorrection(id: string, kind: 'model' | 'content', signal?: AbortSignal) {
  if (active.has(id) || busy.has(id)) fail('Wait for the current operation before validating.');
  busy.add(id); let release: (() => void) | undefined;
  try {
    const row = load(id), scope = scopes(row); release = reserveMigrationDestinationModels('correction-validation:' + id, scope); idle(scope, row.plan.jobId);
    if (row.plan.status === 'uncertain') fail('Reconcile uncertain writes before validation.');
    const current = await evidence(getTopicBranchCorrectionOrigin(row.plan.originPlanId), signal);
    const branchHash = topicMigrationSnapshotHash(current.branchYaml.files);
    const result = await validateTopicCorrectionBranch(current.client, row.plan.branch.modelId, row.plan.branch.branchId, branchHash, kind, row.plan.request.topicIds, signal);
    const after = yaml(await current.client.getModelYaml(row.plan.branch.modelId, { branchId: row.plan.branch.branchId, fullyResolved: false, signal }));
    if (topicMigrationSnapshotHash(after.files) !== branchHash) { result.status = 'unavailable'; result.message = 'Branch changed during validation. Recheck the current branch.'; }
    row.plan[kind === 'model' ? 'validation' : 'contentValidation'] = result;
    row.plan.filesVerified = verifyBranch(row, after.files).verified;
    signal?.throwIfAborted(); save(row); return row.plan;
  } finally { release?.(); busy.delete(id); }
}

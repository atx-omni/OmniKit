import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs, { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { afterEach, beforeEach, test, type TestContext } from 'node:test';
import { parse, stringify } from 'yaml';
import type { DashboardTopicChoice } from '../shared/dashboardDeploymentPlan';
import type { BranchVerificationRecord, TopicMigrationPlan, TopicMigrationRequest } from '../shared/topicMigration';
import handler from '../server/handlers/model-migrator';
import historyHandler from '../server/handlers/migration-jobs';
import { createTopicMigrationPlan, getTopicMigrationPlan, stageApprovedDashboardBranchPreparation, stageTopicMigrationPlan, verifyTopicMigrationBranch } from '../server/services/topicMigrationPlans';
import { adjudicateDestinationModelMutation, cancelMigrationJob, createModelMigrationJob, mergeModelMigrationJob, retryMigrationJob, type MigrationJob, type ModelMigrationJobInput } from '../server/services/migrationJobs';
import { closeJobStoreForTests, getJob, insertJob, listJobs } from '../server/services/jobStore';
import { lockVault, resetVault, unlockVault, upsertInstance } from '../server/services/nativeVault';
import { OmniClient } from '../server/services/omniClient';
import { dashboardSafeCopyStateHash as hash } from '../server/services/dashboardSafeCopyRuntime';
import { dashboardRepairInstanceBoundaryHash } from '../server/services/dashboardRepairRuntime';
import { sanitizeJob, sanitizeJobItem } from '../server/services/jobSanitizer';
import { subscribeMigrationJobEvents, type MigrationJobEvent } from '../server/services/jobEvents';

let temporaryRoot: string;
const envKeys = ['OMNIKIT_VAULT_PATH', 'OMNIKIT_JOB_HISTORY_PATH', 'OMNIKIT_JOBS_PATH'] as const;
let oldEnvironment: Array<string | undefined>;
let sourceFiles: Record<string, string>;
let targetFiles: Record<string, string>;
let wrongConnection: boolean;
let targetFollower: boolean;
let namespaceReads: number;
let cancelAtBranchRead: boolean;
let injectUnrelatedFile: boolean;
let partialWrite: boolean;
let driftDuringCreate: boolean;
let branchCreates: number;
let yamlWrites: number;
let forbiddenWrites: string[];
let branches: Map<string, { name: string; files: Record<string, string> }>;
const state = { modelId: 'source-model', workbookModelId: 'source-workbook', name: 'Example dashboard', queries: [] };
const workbookFiles = { model: '{}\n' };
const checksum = (yaml: string) => createHash('sha256').update(yaml).digest('hex');
const request = (): TopicMigrationRequest => ({
  sourceInstanceId: 'source', sourceConnectionId: 'source-connection', sourceModelId: 'source-model',
  targetInstanceId: 'target', targetConnectionId: 'target-connection', targetModelId: 'target-model',
  topicIds: ['example.topic'], schemaMapText: '',
});
beforeEach((t) => {
  oldEnvironment = envKeys.map((key) => process.env[key]);
  temporaryRoot = mkdtempSync(path.join(tmpdir(), 'omnikit-branch-prep-test-'));
  process.env.OMNIKIT_VAULT_PATH = path.join(temporaryRoot, 'vault.enc');
  process.env.OMNIKIT_JOB_HISTORY_PATH = path.join(temporaryRoot, 'jobs.json');
  process.env.OMNIKIT_JOBS_PATH = path.join(temporaryRoot, 'legacy.json');
  closeJobStoreForTests(); resetVault(); unlockVault('fictional branch preparation passphrase');
  for (const [id, role] of [['source', 'source'], ['target', 'destination']] as const) {
    upsertInstance({ id, role, label: 'Example ' + id, baseUrl: 'https://' + id + '.example.omniapp.co',
      apiKey: 'fictional-secret-' + id, metricFilter: { connectionDatabaseContains: [], connectionDatabaseExact: [], embedExternalIdContains: [], embedExternalIdExact: [] }, postMigrationActions: [] });
  }
  sourceFiles = { model: '{}\n', 'example.topic': 'base_view: records\nfields: [records.id]\njoins: {}\n',
    'records.view': 'catalog: SOURCE\nschema: PUBLIC\ntable_name: records\ndimensions:\n  id:\n    sql: ${TABLE}."ID"\n' };
  targetFiles = { model: '{}\n' };
  wrongConnection = false; cancelAtBranchRead = false; injectUnrelatedFile = false; partialWrite = false; driftDuringCreate = false;
  targetFollower = false; namespaceReads = 0;
  branchCreates = 0; yamlWrites = 0; forbiddenWrites = []; branches = new Map();
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network request in fictional branch tests.'); });
  t.mock.method(OmniClient.prototype, 'listConnections', async () => [
    { id: 'source-connection', name: 'Example source', dialect: 'snowflake' },
    { id: 'target-connection', name: 'Example destination', dialect: 'databricks' },
  ]);
  t.mock.method(OmniClient.prototype, 'listModels', async (options: { connectionId?: string; modelKind?: string } = {}) => {
    assert.notEqual(options.modelKind, 'SCHEMA', 'Branch preparation must not require physical schema reads.');
    return ['source', 'target'].filter((side) => !options.connectionId || options.connectionId === side + '-connection').map((side) => ({
      id: side + '-model', name: 'Example ' + side, connectionId: wrongConnection ? 'unrelated' : side + '-connection',
      pullRequestRequired: side === 'target',
      gitProtected: side === 'target', gitFollower: side === 'target' && targetFollower,
    }));
  });
  t.mock.method(OmniClient.prototype, 'listModelSchemas', async () => { namespaceReads += 1; throw new Error('Optional namespace suggestions unavailable'); });
  t.mock.method(OmniClient.prototype, 'getDocumentStateV2', async () => structuredClone(state));
  t.mock.method(OmniClient.prototype, 'getModelYaml', async (modelId: string, options: { branchId?: string; fullyResolved?: boolean } = {}) => {
    assert.notEqual(options.fullyResolved, true);
    if (options.branchId && cancelAtBranchRead) {
      cancelAtBranchRead = false;
      const job = listJobs().find((candidate) => candidate.status === 'running');
      if (job) cancelMigrationJob(job.id);
    }
    const files = options.branchId ? branches.get(options.branchId)!.files
      : modelId === 'source-model' ? sourceFiles : modelId === 'source-workbook' ? workbookFiles : targetFiles;
    const raw = { files: structuredClone(files), viewNames: Object.fromEntries(Object.keys(files).map((name) => [name, name.endsWith('.view') ? name.slice(0, -5) : ''])) };
    return { files: structuredClone(files), raw, checksums: Object.fromEntries(Object.entries(files).map(([name, yaml]) => [name, checksum(yaml)])) };
  });
  t.mock.method(OmniClient.prototype, 'createModelBranch', async (input: { branchName: string }) => {
    const id = 'branch-' + ++branchCreates;
    branches.set(id, { name: input.branchName, files: structuredClone(targetFiles) });
    if (driftDuringCreate) sourceFiles['records.view'] += '# source changed\n';
    return { id, name: input.branchName, raw: {} };
  });
  t.mock.method(OmniClient.prototype, 'updateModelYamlFiles', async (input: { branchId?: string; files: Array<{ fileName: string; yaml: string }> }) => {
    yamlWrites += 1;
    const branch = branches.get(input.branchId!)!;
    for (const file of input.files) {
      branch.files[file.fileName] = file.yaml;
      if (partialWrite) throw new Error('Fictional lost response after one write');
    }
    if (injectUnrelatedFile) branch.files['unrelated.view'] = 'dimensions: {}\n';
    return {};
  });
  t.mock.method(OmniClient.prototype, 'findModelBranch', async (_modelId: string, name: string) => {
    const found = [...branches].find(([, branch]) => branch.name === name);
    return found ? { id: found[0], name, raw: {} } : null;
  });
  for (const name of ['mergeModelBranch', 'createOrUpdateModelBranchPullRequest', 'deleteModelBranch', 'validateModel', 'validateModelContent',
    'migrateModel', 'findAndReplaceModelContent', 'createWorkbook'] as const) {
    if (typeof OmniClient.prototype[name] === 'function') t.mock.method(OmniClient.prototype, name, async () => {
      forbiddenWrites.push(name); throw new Error('Forbidden branch-preparation operation: ' + name);
    });
  }
});
afterEach(() => {
  assert.deepEqual(forbiddenWrites, []);
  lockVault(); closeJobStoreForTests(); resetVault();
  rmSync(temporaryRoot, { recursive: true, force: true });
  envKeys.forEach((key, index) => oldEnvironment[index] === undefined ? delete process.env[key] : process.env[key] = oldEnvironment[index]);
});
const post = (route: string, body: unknown) => handler(new Request('http://localhost/api/model-migrator/' + route,
  { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
async function ready(): Promise<TopicMigrationPlan> {
  const plan = await createTopicMigrationPlan(request());
  assert.equal(plan.status, 'ready', JSON.stringify(plan.issues));
  assert.equal(plan.version, 2);
  assert.equal(plan.executionProfile, 'branch_preparation_v1');
  return plan;
}
async function finished(id: string): Promise<MigrationJob> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = getJob(id)!;
    if (!['pending', 'running'].includes(job.status)) return job;
    await setImmediate();
  }
  assert.fail('Mocked branch preparation did not finish');
}
const stage = (plan: TopicMigrationPlan) => stageTopicMigrationPlan(plan.id, { revision: plan.revision, approve: true }, createModelMigrationJob);
async function failedBranchReadback(reviewRequest?: TopicMigrationRequest) {
  injectUnrelatedFile = true;
  const plan = reviewRequest ? await createTopicMigrationPlan(reviewRequest) : await ready();
  assert.equal(plan.status, 'ready', JSON.stringify(plan.issues));
  const job = await finished((await stage(plan)).job.id);
  assert.equal(job.items.find(item => item.kind === 'model_yaml_write')?.status, 'succeeded');
  assert.equal(job.items.find(item => item.kind === 'model_branch_verify')?.status, 'failed');
  delete branches.get('branch-1')!.files['unrelated.view'];
  injectUnrelatedFile = false;
  return { plan, job };
}

test('branch verification recovery appends independent evidence without replay or changing original outcomes', async (t) => {
  const { plan, job } = await failedBranchReadback();
  const read = t.mock.method(OmniClient.prototype, 'getModelYaml', OmniClient.prototype.getModelYaml);
  const requestId = randomUUID();
  const response = await post(`topic-plan/${plan.id}/verify`, { revision: plan.revision, requestId });
  assert.equal(response.status, 200, await response.clone().text());
  const result = await response.json() as { job: MigrationJob; verification: BranchVerificationRecord };
  assert.equal(result.verification.verified, true);
  assert.equal(result.verification.actualHash, result.verification.expectedHash);
  assert.equal(result.verification.planRevision, plan.revision);
  assert.equal(result.job.status, job.status); assert.deepEqual(result.job.items, JSON.parse(JSON.stringify(job.items)));
  assert.equal(result.job.details?.branchReceipt, undefined);
  assert.equal(result.job.endedAt, job.endedAt);
  const readCount = read.mock.callCount();
  const duplicate = await verifyTopicMigrationBranch(plan.id, { revision: plan.revision, requestId });
  assert.equal(read.mock.callCount(), readCount, 'An idempotent request does not re-read or replay anything.');
  assert.deepEqual(duplicate.verification, result.verification);
  assert.equal((duplicate.job.details?.branchVerifications as unknown[]).length, 1);
  branches.get('branch-1')!.files['records.view'] += 'hidden: true\n';
  const failed = await verifyTopicMigrationBranch(plan.id, { revision: plan.revision, requestId: randomUUID() });
  assert.equal(failed.verification.verified, false);
  assert.equal((failed.job.details?.branchVerifications as BranchVerificationRecord[]).at(-1)?.verified, false);
  assert.deepEqual(failed.job.items, job.items);
  assert.equal(branchCreates, 1); assert.equal(yamlWrites, 1);
  assert.deepEqual(sanitizeJob(failed.job).details?.branchVerifications, failed.job.details?.branchVerifications);
});

test('branch verification recovery rejects incomplete, uncertain, adjudicated, active and dashboard jobs', async () => {
  const { plan, job } = await failedBranchReadback();
  const owner = (value: MigrationJob) => value.items.find(item => item.kind === 'destination_model_mutation')!;
  const changes: Array<(value: MigrationJob) => void> = [
    value => { value.status = 'running'; }, value => { value.status = 'canceled'; },
    value => { value.items.find(item => item.kind === 'model_yaml_write')!.status = 'failed'; },
    value => { value.items.find(item => item.kind === 'model_yaml_write')!.details!.branchId = 'other'; },
    value => { value.items.find(item => item.kind === 'model_branch_verify')!.status = 'running'; },
    value => { owner(value).details!.migrationMutationState = 'uncertain'; },
    value => { owner(value).details!.migrationMutationDispatchItemId = 'other'; },
    value => { owner(value).details!.migrationMutationResolutionKind = 'operator_adjudication'; },
    value => { owner(value).details!.migrationMutationExternalJobId = 'external'; },
    value => { value.details!.migrationMutationAdjudications = []; },
    value => { value.details!.dashboardRepair = { planId: 'other' }; },
    value => { value.items.push({ ...owner(value), id: 'duplicate' }); },
  ];
  for (const change of changes) {
    const invalid = structuredClone(job); change(invalid); insertJob(invalid);
    await assert.rejects(verifyTopicMigrationBranch(plan.id, { revision: plan.revision, requestId: randomUUID() }));
    assert.equal(getJob(job.id)?.details?.branchVerifications, undefined);
  }
  insertJob(job);
  await assert.rejects(verifyTopicMigrationBranch(plan.id, { revision: 'stale', requestId: randomUUID() }));
  await assert.rejects(verifyTopicMigrationBranch(plan.id, { revision: plan.revision, requestId: 'invalid' }));
  await assert.rejects(verifyTopicMigrationBranch(plan.id, { revision: plan.revision, requestId: randomUUID(), approve: true }));
  assert.equal(branchCreates, 1); assert.equal(yamlWrites, 1);
});

test('branch verification recovery records unavailable evidence honestly and rejects source or main drift', async (t) => {
  const { plan, job } = await failedBranchReadback();
  for (const files of [sourceFiles, targetFiles]) {
    const original = files.model; files.model += '# drift\n';
    const result = await verifyTopicMigrationBranch(plan.id, { revision: plan.revision, requestId: randomUUID() });
    assert.equal(result.verification.verified, false); assert.equal(result.verification.actualHash, null);
    files.model = original;
  }
  const name = branches.get('branch-1')!.name;
  branches.get('branch-1')!.name = 'different';
  const missing = await verifyTopicMigrationBranch(plan.id, { revision: plan.revision, requestId: randomUUID() });
  assert.equal(missing.verification.actualHash, null);
  assert.equal(missing.verification.findings[0].code, 'BRANCH_IDENTITY_CHANGED');
  branches.get('branch-1')!.name = name;
  const originalRead = OmniClient.prototype.getModelYaml;
  const read = t.mock.method(OmniClient.prototype, 'getModelYaml', async function (this: OmniClient, ...args: Parameters<OmniClient['getModelYaml']>) {
    if (args[1]?.branchId) throw new Error('Bearer fictional-untrusted-read-error');
    return originalRead.apply(this, args);
  });
  const unavailable = await verifyTopicMigrationBranch(plan.id, { revision: plan.revision, requestId: randomUUID() });
  assert.equal(unavailable.verification.actualHash, null); assert.equal(unavailable.verification.verified, false);
  assert.doesNotMatch(JSON.stringify(unavailable.verification), /fictional-untrusted/);
  read.mock.restore();
  const recovered = await verifyTopicMigrationBranch(plan.id, { revision: plan.revision, requestId: randomUUID() });
  assert.equal(recovered.verification.verified, true); assert.deepEqual(recovered.job.items, job.items);
  assert.equal(branchCreates, 1); assert.equal(yamlWrites, 1);
});

test('branch verification recovery guards same-origin writers and rereads authority after awaited evidence', async (t) => {
  const { plan, job } = await failedBranchReadback();
  upsertInstance({ id: 'target-alias', role: 'destination', label: 'Example alias', baseUrl: 'https://target.example.omniapp.co',
    apiKey: 'fictional-alias-secret', metricFilter: { connectionDatabaseContains: [], connectionDatabaseExact: [], embedExternalIdContains: [], embedExternalIdExact: [] }, postMigrationActions: [] });
  const competing = structuredClone(job); competing.id = randomUUID(); competing.details = {}; competing.status = 'running';
  competing.destinationIds = ['target-alias'];
  competing.targets = competing.targets?.map(target => ({ ...target, destinationInstanceId: 'target-alias' }));
  competing.items = competing.items.map(item => ({ ...item, jobId: competing.id, destinationId: 'target-alias' }));
  insertJob(competing);
  await assert.rejects(verifyTopicMigrationBranch(plan.id, { revision: plan.revision, requestId: randomUUID() }), /active/);
  competing.status = 'failed';
  competing.items.find(item => item.kind === 'destination_model_mutation')!.details!.migrationMutationState = 'uncertain';
  insertJob(competing);
  await assert.rejects(verifyTopicMigrationBranch(plan.id, { revision: plan.revision, requestId: randomUUID() }), /unresolved/);
  competing.items.find(item => item.kind === 'destination_model_mutation')!.details!.migrationMutationState = 'resolved';
  insertJob(competing);
  const originalRead = OmniClient.prototype.getModelYaml;
  const read = t.mock.method(OmniClient.prototype, 'getModelYaml', async function (this: OmniClient, ...args: Parameters<OmniClient['getModelYaml']>) {
    const response = await originalRead.apply(this, args);
    if (args[1]?.branchId) { competing.status = 'running'; insertJob(competing); }
    return response;
  });
  await assert.rejects(verifyTopicMigrationBranch(plan.id, { revision: plan.revision, requestId: randomUUID() }), /active/);
  assert.equal(getJob(job.id)?.details?.branchVerifications, undefined);
  read.mock.restore(); competing.status = 'failed'; insertJob(competing);
  t.mock.method(OmniClient.prototype, 'getModelYaml', async function (this: OmniClient, ...args: Parameters<OmniClient['getModelYaml']>) {
    const response = await originalRead.apply(this, args);
    if (args[1]?.branchId) { const changed = getJob(job.id)!; changed.details = { ...changed.details, changedDuringRead: true }; insertJob(changed); }
    return response;
  });
  await assert.rejects(verifyTopicMigrationBranch(plan.id, { revision: plan.revision, requestId: randomUUID() }), /changed during/);
  assert.equal(getJob(job.id)?.details?.branchVerifications, undefined);
  assert.equal(branchCreates, 1); assert.equal(yamlWrites, 1);
});

test('branch verification recovery audit sanitization preserves typed evidence but never arbitrary secrets', async () => {
  const { plan } = await failedBranchReadback();
  const { job, verification } = await verifyTopicMigrationBranch(plan.id, { revision: plan.revision, requestId: randomUUID() });
  const numeric = { ...verification, expectedHash: 'sha256:' + '1234567890'.repeat(6) + '1234', actualHash: 'sha256:' + '9'.repeat(64),
    jobEvidenceHash: 'sha256:' + '1'.repeat(64) };
  const typed = { ...job, details: { ...job.details, branchVerifications: [numeric] } };
  assert.deepEqual(sanitizeJob(typed).details?.branchVerifications, [numeric]);
  for (const invalid of [{ ...numeric, expectedHash: 'Bearer fictional-secret' }, { ...numeric, apiKey: 'fictional-secret' },
    { ...numeric, findings: [{ code: 'READ_FAILURE', message: 'Bearer fictional-secret' }] },
    { ...numeric, files: [{ sourceFileName: 'omni_fictionalCredential.view', submittedFileName: 'omni_fictionalCredential.view', destinationFileName: 'omni_fictionalCredential.view', classification: 'exact' }] }]) {
    const sanitized = sanitizeJob({ ...job, details: { ...job.details, branchVerifications: [invalid], description: 'Bearer fictional-secret' } });
    assert.doesNotMatch(JSON.stringify(sanitized.details), /fictional-secret|omni_fictionalCredential/);
  }
});

test('branch verification recovery preserves authored topic paths with spaces', async () => {
  sourceFiles['Example Domain/example.topic'] = sourceFiles['example.topic']; delete sourceFiles['example.topic'];
  const { plan, job } = await failedBranchReadback({ ...request(), topicIds: ['Example Domain/example.topic'] });
  const result = await verifyTopicMigrationBranch(plan.id, { revision: plan.revision, requestId: randomUUID() });
  assert.equal(result.verification.verified, true);
  assert.ok(result.verification.files.some(file => file.sourceFileName === 'Example Domain/example.topic'
    && file.submittedFileName === 'Example Domain/example.topic' && file.destinationFileName === 'Example Domain/example.topic'));
  assert.deepEqual(result.job.items, job.items);
});

test('branch verification normal afterWrite accepts formatting only but rejects untouched baseline changes', async (t) => {
  const write = OmniClient.prototype.updateModelYamlFiles;
  let alterBaseline = false;
  t.mock.method(OmniClient.prototype, 'updateModelYamlFiles', async function (this: OmniClient, ...args: Parameters<OmniClient['updateModelYamlFiles']>) {
    const result = await write.apply(this, args);
    const files = branches.get(args[0].branchId)!.files;
    for (const file of args[0].files) files[file.fileName] = stringify(parse(files[file.fileName]));
    if (alterBaseline) files.model += '# unrelated change\n';
    return result;
  });
  const first = await ready(), prepared = await finished((await stage(first)).job.id);
  assert.equal(prepared.status, 'succeeded', JSON.stringify(prepared.items));
  assert.equal(prepared.items.find(item => item.kind === 'model_branch_verify')?.status, 'succeeded');
  // A different current authored snapshot creates a separately approved plan.
  sourceFiles['example.topic'] += 'label: Example changed review\n'; alterBaseline = true;
  const second = await ready(), failed = await finished((await stage(second)).job.id);
  assert.equal(failed.items.find(item => item.kind === 'model_yaml_write')?.status, 'succeeded');
  assert.equal(failed.items.find(item => item.kind === 'model_branch_verify')?.status, 'failed');
  assert.equal(failed.details?.branchReceipt, undefined);
});

test('branch verification canonical mapped submission preserves only approved contextual filenames', async () => {
  sourceFiles['SOURCE.PUBLIC/records.view'] = sourceFiles['records.view']; delete sourceFiles['records.view'];
  const plan = await createTopicMigrationPlan({ ...request(), schemaMapText: 'SOURCE.PUBLIC -> omni_example.data' });
  assert.equal(plan.status, 'ready', JSON.stringify(plan.issues));
  assert.ok(plan.files.some(file => file.sourceFileName === 'SOURCE.PUBLIC/records.view' && file.fileName === 'omni_example.data/records.view'));
  const job = await finished((await stage(plan)).job.id);
  assert.equal(job.status, 'succeeded', JSON.stringify(job.items));
  assert.ok(Object.hasOwn(branches.get('branch-1')!.files, 'omni_example.data/records.view'));
  const write = job.items.find(item => item.kind === 'model_yaml_write')!;
  const approved = write.details!.files as Array<{ fileName: string; yaml: string }>;
  assert.ok(approved.some(file => file.fileName === 'omni_example.data/records.view'));
  assert.deepEqual(sanitizeJob(job).items, job.items);
  const isolated = sanitizeJobItem(write).details!.files as Array<{ fileName: string }>;
  assert.ok(isolated.some(file => file.fileName.includes('[redacted]')), 'An isolated file path has no bound namespace exception.');
  assert.equal(branchCreates, 1); assert.equal(yamlWrites, 1);
});

function dashboardFixture(requiredFiles = ['example.topic', 'records.view'], topicChoices?: DashboardTopicChoice[]) {
  const id = 'example-deployment';
  const targetId = 'example-destination';
  const repair = { planId: id, targetId, revision: 1, additiveOnly: true as const,
    sourceDocumentHashes: { 'example-document': hash(state) }, sourceWorkbookHashes: { 'source-workbook': hash(workbookFiles) },
    instanceBoundaryHash: dashboardRepairInstanceBoundaryHash('source', 'target', 'target-model', ['source-model']),
    sourceModelHashes: { 'source-model': hash(sourceFiles) }, targetModelHash: hash(targetFiles) };
  writeFileSync(process.env.OMNIKIT_JOB_HISTORY_PATH + '.deployment-plans.json', JSON.stringify([{
    id, revision: 1, evidenceVersion: 4, createdAt: Date.now(), updatedAt: Date.now(),
    intent: { source: { instanceId: 'source', connectionId: 'source-connection', documentIds: ['example-document'] },
      destinations: [{ targetId, instanceId: 'target', connectionId: 'target-connection', modelId: 'target-model', folderId: 'example-folder' }] },
    sourceHashes: repair.sourceDocumentHashes, sourceModelHashes: repair.sourceModelHashes, workbookCopies: {},
    targets: [{ targetId, status: 'model_changes_required', sourceModelIds: ['source-model'],
      requiredFiles, requiredFilesByModelId: { 'source-model': requiredFiles }, topicChoices, modelHash: hash(targetFiles), findings: [] }],
  }]));
  return repair;
}

test('branch review prepares exact additive bytes and a verified receipt, without validation or publication', async () => {
  const plan = await ready();
  assert.equal(plan.files.find((file) => file.fileName === 'records.view')?.proposed, sourceFiles['records.view']);
  const { job: submitted } = await stage(plan);
  const job = await finished(submitted.id);
  assert.equal(job.status, 'succeeded', JSON.stringify(job.items));
  assert.deepEqual(job.items.filter((item) => item.kind !== 'destination_model_mutation').map((item) => item.kind),
    ['model_translate', 'model_branch_create', 'model_yaml_write', 'model_branch_verify']);
  const verify = job.items.find((item) => item.kind === 'model_branch_verify')!;
  assert.equal(verify.status, 'succeeded');
  const ownership = job.items.find((item) => item.kind === 'destination_model_mutation')!;
  assert.equal(ownership.status, 'succeeded');
  assert.equal(ownership.details?.migrationMutationState, 'resolved');
  assert.deepEqual(job.details?.branchReceipt, { modelId: 'target-model', branchId: 'branch-1', branchName: verify.details?.branchName });
  assert.deepEqual(getTopicMigrationPlan(plan.id).branchReceipt, job.details?.branchReceipt);
  assert.deepEqual(targetFiles, { model: '{}\n' });
  const duplicate = await stage(plan);
  assert.equal(duplicate.job.id, job.id);
  assert.equal(branchCreates, 1); assert.equal(yamlWrites, 1);
});

test('timestamp drift while saving YAML dispatch intent does not replay branch creation or file writes', async (t) => {
  const plan = await ready();
  const read = fs.readFileSync;
  let timestampChanged = false;
  const reader = t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
    const result = Reflect.apply(read, fs, args);
    if (!timestampChanged && branchCreates === 1 && yamlWrites === 0 && typeof args[0] === 'number' && Buffer.isBuffer(result)) {
      const rows = JSON.parse(result.toString('utf8')) as MigrationJob[];
      if (rows.some(row => row.items.some(item => item.details?.migrationMutationDispatchItemKind === 'model_yaml_write'
        && item.details?.migrationMutationState === 'dispatched'))) {
        timestampChanged = true;
        const date = new Date('2025-01-02T03:04:05.000Z');
        utimesSync(process.env.OMNIKIT_JOB_HISTORY_PATH!, date, date);
      }
    }
    return result;
  });
  syncBuiltinESMExports();
  try {
    const submitted = await stage(plan);
    const job = await finished(submitted.job.id);
    assert.equal(timestampChanged, true);
    assert.equal(job.status, 'succeeded');
    assert.ok(job.details?.branchReceipt);
    assert.equal(branchCreates, 1);
    assert.equal(yamlWrites, 1);
    assert.deepEqual(targetFiles, { model: '{}\n' });
    assert.equal((await stage(plan)).job.id, job.id);
    assert.equal(branchCreates, 1);
    assert.equal(yamlWrites, 1);
  } finally {
    reader.mock.restore(); syncBuiltinESMExports();
  }
});

test('history guard stops before dispatch and reports an unverified outcome to current and late subscribers', { timeout: 5_000 }, async (t) => {
  const plan = await ready();
  const originalRead = OmniClient.prototype.getModelYaml;
  let releaseRead = () => {};
  const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
  let announcePaused = () => {};
  const readPaused = new Promise<void>(resolve => { announcePaused = resolve; });
  let paused = false;
  t.mock.method(OmniClient.prototype, 'getModelYaml', async function (this: OmniClient, ...args: Parameters<OmniClient['getModelYaml']>) {
    if (!paused && listJobs().some(job => job.status === 'running')) {
      paused = true;
      announcePaused();
      await readGate;
    }
    return originalRead.apply(this, args);
  });
  let unsubscribe = () => {};
  try {
    const { job } = await stage(plan);
    await readPaused;
    assert.equal(paused, true);
    const blocked = new Promise<MigrationJobEvent>(resolve => {
      unsubscribe = subscribeMigrationJobEvents(job.id, event => {
        if (event.type === 'history-unavailable') resolve(event);
      });
    });
    const historyPath = process.env.OMNIKIT_JOB_HISTORY_PATH!;
    const changedBytes = readFileSync(historyPath, 'utf8') + '\n';
    writeFileSync(historyPath, changedBytes);
    releaseRead();
    const event = await blocked;
    assert.equal(event.type, 'history-unavailable');
    if (event.type === 'history-unavailable') {
      assert.equal(event.code, 'MIGRATION_HISTORY_UNAVAILABLE');
      assert.equal(event.diagnostic, 'content_changed');
    }
    assert.equal(branchCreates, 0);
    assert.equal(yamlWrites, 0);
    assert.equal(readFileSync(historyPath, 'utf8'), changedBytes, 'The rejected journal must not be overwritten.');
    const saved = await historyHandler(new Request('http://localhost/api/migration-jobs/' + job.id));
    assert.equal(saved.status, 503);
    const savedError = await saved.json();
    assert.equal(savedError.code, 'MIGRATION_HISTORY_UNAVAILABLE');
    assert.equal(savedError.diagnostic, 'content_changed');
    const stream = await historyHandler(new Request('http://localhost/api/migration-jobs/' + job.id + '/events'));
    assert.equal(stream.status, 200);
    const body = await stream.text();
    assert.match(body, /event: history-unavailable/);
    assert.match(body, /MIGRATION_HISTORY_UNAVAILABLE/);
    assert.match(body, /"diagnostic":"content_changed"/);
    assert.doesNotMatch(body, /event: snapshot|fictional-secret|base_view/);
    // Model the supported restart recovery; never repair or clear the live store.
    closeJobStoreForTests();
    const recovered = getJob(job.id)!;
    assert.equal(recovered.status, 'failed');
    assert.equal(recovered.items.find(item => item.kind === 'destination_model_mutation')?.details?.migrationMutationState, 'failed_prewrite');
    const oldPlan = getTopicMigrationPlan(plan.id);
    const fresh = await ready();
    assert.notEqual(fresh.id, plan.id);
    assert.notEqual(fresh.revision, plan.revision);
    assert.equal(fresh.jobId, undefined);
    assert.deepEqual(getTopicMigrationPlan(plan.id), oldPlan, 'The old one-use approval is preserved.');
    assert.equal((await stage(plan)).job.id, job.id, 'The old approval never starts a replacement job.');
    assert.equal(branchCreates, 0);
    await assert.rejects(stageTopicMigrationPlan(fresh.id, { revision: fresh.revision, approve: false }, createModelMigrationJob), /approv/i);
    const replacement = await finished((await stage(fresh)).job.id);
    assert.equal(replacement.status, 'succeeded');
    assert.equal(branchCreates, 1); assert.equal(yamlWrites, 1);
    assert.equal((await createTopicMigrationPlan(request())).id, fresh.id, 'An older safe failure must not hide a later completed claim.');
  } finally {
    releaseRead();
    unsubscribe();
  }
});

test('prewrite recovery keeps ambiguous, active, malformed, and remotely written jobs as tombstones', async (t) => {
  const plan = await ready();
  const originalRead = OmniClient.prototype.getModelYaml;
  let readFailed = false;
  t.mock.method(OmniClient.prototype, 'getModelYaml', async function (this: OmniClient, ...args: Parameters<OmniClient['getModelYaml']>) {
    if (!readFailed && listJobs().some(job => job.status === 'running')) {
      readFailed = true;
      throw new Error('Fictional evidence read failed before dispatch.');
    }
    return originalRead.apply(this, args);
  });
  const stopped = await finished((await stage(plan)).job.id);
  assert.equal(stopped.items.find(item => item.kind === 'destination_model_mutation')?.details?.migrationMutationState, 'failed_prewrite');
  const owner = (job: MigrationJob) => job.items.find(item => item.kind === 'destination_model_mutation')!;
  const mutations: Array<(job: MigrationJob) => void> = [
    job => { job.status = 'running'; },
    job => { owner(job).details!.migrationMutationState = 'uncertain'; },
    job => { owner(job).details!.migrationMutationState = 'resolved'; },
    job => { owner(job).details!.migrationMutationDispatchItemId = ''; },
    job => { owner(job).details!.migrationMutationDispatchedAt = 0; },
    job => { owner(job).details!.migrationMutationBranchId = ''; },
    job => { owner(job).details!.migrationMutationResolutionKind = 'operator_adjudication'; },
    job => { job.details!.migrationMutationAdjudications = []; },
    job => { job.items.find(item => item.kind === 'model_branch_create')!.status = 'succeeded'; },
    job => { job.items.find(item => item.kind === 'model_branch_create')!.details!.branchId = 'recorded-branch'; },
    job => { owner(job).jobId = 'different-job'; },
    job => { job.items = job.items.filter(item => item.kind !== 'destination_model_mutation'); },
    job => { job.items.push({ ...owner(job), id: 'duplicate-owner' }); },
    job => { job.items.find(item => item.kind === 'model_translate')!.details!.migrationDestinationModelMutation = true; },
    job => {
      const translate = job.items.find(item => item.kind === 'model_translate')!;
      translate.details = { ...translate.details, ...owner(job).details }; translate.status = 'failed';
      job.items = job.items.filter(item => item.kind !== 'destination_model_mutation');
    },
    job => { (job.details!.topicMigration as { revision: string }).revision = 'different-review'; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(stopped); mutate(changed); insertJob(changed);
    assert.equal((await createTopicMigrationPlan(request())).id, plan.id);
  }
  insertJob(stopped);
  const fresh = await ready();
  readFailed = false;
  const otherStopped = await finished((await stage(fresh)).job.id);
  assert.equal(otherStopped.items.find(item => item.kind === 'destination_model_mutation')?.details?.migrationMutationState, 'failed_prewrite');
  const store = process.env.OMNIKIT_JOB_HISTORY_PATH + '.topic-plans.json';
  const rows = JSON.parse(readFileSync(store, 'utf8'));
  rows.find((row: { plan: TopicMigrationPlan }) => row.plan.id === plan.id).plan.jobId = otherStopped.id;
  writeFileSync(store, JSON.stringify(rows));
  assert.equal((await createTopicMigrationPlan(request())).id, plan.id, 'A different plan cannot borrow another job\'s prewrite proof.');
  assert.equal(branchCreates, 0); assert.equal(yamlWrites, 0);
});

async function reconciledNoWrite(t: TestContext) {
  const plan = await ready();
  const writer = t.mock.method(OmniClient.prototype, 'updateModelYamlFiles', async () => {
    yamlWrites += 1;
    throw new Error('Fictional request failed without applying files.');
  });
  const stopped = await finished((await stage(plan)).job.id);
  writer.mock.restore();
  const owner = stopped.items.find(item => item.kind === 'destination_model_mutation')!;
  const details = owner.details!;
  assert.equal(details.migrationMutationState, 'uncertain');
  const result = adjudicateDestinationModelMutation(stopped.id, {
    requestId: randomUUID(), itemId: owner.id, expectedRevision: details.migrationMutationRevision as number,
    expectedUpdatedAt: details.migrationMutationUpdatedAt as number, destinationInstanceId: owner.destinationId,
    targetModelId: owner.targetModelId!, operation: details.migrationMutationOperation as string,
    dispatchItemId: details.migrationMutationDispatchItemId as string, dispatchItemKind: details.migrationMutationDispatchItemKind as string,
    dispatchFingerprint: details.migrationMutationDispatchFingerprint as string,
    outcome: 'verified_not_applied', evidenceSource: 'omni_api', note: 'Fictional branch readback matches baseline; no request remains in flight.',
    confirmCurrentStateInspected: true, confirmNoOperationInFlight: true,
  });
  return { plan, resolved: result.job };
}

test('reconciled not-applied YAML permits a separately approved new plan without changing or replaying the original', async (t) => {
  const { plan, resolved } = await reconciledNoWrite(t);
  const store = process.env.OMNIKIT_JOB_HISTORY_PATH + '.topic-plans.json';
  const original = JSON.parse(readFileSync(store, 'utf8')).find((row: { plan: TopicMigrationPlan }) => row.plan.id === plan.id);
  const fresh = await ready();
  assert.notEqual(fresh.id, plan.id); assert.notEqual(fresh.revision, plan.revision);
  assert.equal(fresh.jobId, undefined);
  assert.equal(branchCreates, 1); assert.equal(yamlWrites, 1, 'A new preview must not dispatch any write.');
  const rows = JSON.parse(readFileSync(store, 'utf8'));
  assert.deepEqual(rows.find((row: { plan: TopicMigrationPlan }) => row.plan.id === plan.id), original);
  assert.deepEqual(rows.find((row: { plan: TopicMigrationPlan }) => row.plan.id === fresh.id).supersedes, [{ planId: plan.id, jobId: resolved.id }]);
  assert.deepEqual(getJob(resolved.id), resolved);
  await assert.rejects(stageTopicMigrationPlan(fresh.id, { revision: plan.revision, approve: true }, createModelMigrationJob), /revision changed/);
  await assert.rejects(stageTopicMigrationPlan(fresh.id, { revision: fresh.revision, approve: false }, createModelMigrationJob), /Approve/);
  assert.equal((await stage(plan)).job.id, resolved.id);
  assert.equal(branchCreates, 1);
  const completed = await finished((await stage(fresh)).job.id);
  assert.equal(completed.status, 'succeeded');
  assert.equal(branchCreates, 2); assert.equal(yamlWrites, 2);
  assert.deepEqual(branches.get('branch-1')!.files, targetFiles, 'The retained branch stays untouched.');
  assert.deepEqual(getJob(resolved.id), resolved);
  assert.deepEqual(targetFiles, { model: '{}\n' });
  assert.equal((await createTopicMigrationPlan(request())).id, fresh.id, 'The later successful approval must not be superseded by older recovery evidence.');
});

test('reconciled recovery rejects missing, partial, mismatched, active and ambiguous audit evidence', async (t) => {
  const { plan, resolved } = await reconciledNoWrite(t);
  const owner = (job: MigrationJob) => job.items.find(item => item.kind === 'destination_model_mutation')!;
  const audit = (job: MigrationJob) => (job.details!.migrationMutationAdjudications as Array<Record<string, unknown>>)[0];
  const mutations: Array<(job: MigrationJob) => void> = [
    job => { job.status = 'running'; },
    job => { owner(job).details!.migrationMutationState = 'uncertain'; },
    job => { owner(job).details!.migrationMutationResolutionOutcome = 'verified_applied'; },
    job => { owner(job).details!.migrationMutationResolutionOutcome = 'verified_partial_terminal'; audit(job).outcome = 'verified_partial_terminal'; },
    job => { delete job.details!.migrationMutationAdjudications; },
    job => { audit(job).dispatchFingerprint = '0'.repeat(64); },
    job => { audit(job).resolvedRevision = 999; },
    job => { audit(job).targetModelId = 'different-model'; },
    job => { audit(job).requestHash = 'invalid'; },
    job => { owner(job).details!.migrationMutationResolutionActor = 'unknown'; },
    job => { job.items.find(item => item.kind === 'model_yaml_write')!.status = 'succeeded'; },
    job => { job.items.find(item => item.kind === 'model_branch_verify')!.status = 'succeeded'; },
    job => { job.items.push({ ...owner(job), id: 'duplicate-owner' }); },
    job => { (job.details!.migrationMutationAdjudications as unknown[]).push(structuredClone(audit(job))); },
    job => { (job.details!.topicMigration as { revision: string }).revision = 'wrong-review'; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(resolved); mutate(changed); insertJob(changed);
    assert.equal((await createTopicMigrationPlan(request())).id, plan.id);
  }
  assert.equal(branchCreates, 1); assert.equal(yamlWrites, 1);
});

test('reconciled recovery rechecks branch identity, exact files and audit stability before issuing a new approval', async (t) => {
  const { plan, resolved } = await reconciledNoWrite(t);
  const retained = branches.get('branch-1')!;
  retained.files['unexpected.view'] = 'dimensions: {}\n';
  await assert.rejects(createTopicMigrationPlan(request()), /retained branch has changes/);
  retained.files = structuredClone(targetFiles);
  branches.delete('branch-1');
  await assert.rejects(createTopicMigrationPlan(request()), /branch could not be identified/);
  branches.set('branch-1', retained);
  const original = OmniClient.prototype.getModelYaml;
  const reader = t.mock.method(OmniClient.prototype, 'getModelYaml', async function (this: OmniClient, ...args: Parameters<OmniClient['getModelYaml']>) {
    const response = await original.apply(this, args);
    if (args[1]?.branchId === 'branch-1') {
      const changed = structuredClone(resolved);
      (changed.details!.migrationMutationAdjudications as Array<Record<string, unknown>>)[0].outcome = 'verified_partial_terminal';
      insertJob(changed);
    }
    return response;
  });
  assert.equal((await createTopicMigrationPlan(request())).id, plan.id);
  reader.mock.restore();
  assert.equal(branchCreates, 1); assert.equal(yamlWrites, 1);
});

test('branch review rejects drift, ownership changes, and deprecated correction request fields before writes', async () => {
  for (const key of ['reviewedSqlFiles', 'tableMappings', 'fileMappings']) await assert.rejects(createTopicMigrationPlan({ ...request(), [key]: {} }), /manually in Omni/);
  const plan = await ready();
  targetFiles['changed.view'] = 'dimensions: {}\n';
  await assert.rejects(stage(plan), /changed/);
  wrongConnection = true;
  await assert.rejects(createTopicMigrationPlan(request()), /uniquely bind/);
  assert.equal(branchCreates, 0);
});

test('branch review retains partial/unrelated branches without a success receipt or replay', async () => {
  const plan = await ready();
  partialWrite = true;
  const job = await finished((await stage(plan)).job.id);
  assert.notEqual(job.status, 'succeeded');
  assert.equal(job.details?.branchReceipt, undefined);
  assert.equal(branchCreates, 1); assert.equal(yamlWrites, 1);
  assert.equal(job.items.find((item) => item.kind === 'model_branch_verify')?.status, 'skipped');
  await assert.rejects(retryMigrationJob(job.id), /one-use|replay/);
  await assert.rejects(mergeModelMigrationJob(job.id), /no longer available/);
  assert.equal(branches.size, 1);
  assert.equal((await createTopicMigrationPlan(request())).id, plan.id);
});

test('branch review exact readback rejects unrelated edits and source drift after branch creation', async () => {
  injectUnrelatedFile = true;
  const job = await finished((await stage(await ready())).job.id);
  assert.notEqual(job.status, 'succeeded');
  assert.equal(job.details?.branchReceipt, undefined);
  assert.equal(job.items.find((item) => item.kind === 'model_branch_verify')?.status, 'failed');
});

test('branch review cancellation prevents YAML dispatch and never deletes its created branch', async () => {
  cancelAtBranchRead = true;
  const job = await finished((await stage(await ready())).job.id);
  assert.equal(job.status, 'canceled');
  assert.equal(branchCreates, 1); assert.equal(yamlWrites, 0);
  assert.equal(job.details?.branchReceipt, undefined);
});

test('branch review legacy plans and jobs are readable but cannot publish, stage, replay, or clear history', async () => {
  const plan = await ready();
  const store = process.env.OMNIKIT_JOB_HISTORY_PATH + '.topic-plans.json';
  const rows = JSON.parse(readFileSync(store, 'utf8'));
  const row = rows[0];
  row.plan.version = 1; delete row.plan.executionProfile;
  const proofPlan = Object.fromEntries(Object.entries(row.plan).filter(([key]) => !['revision', 'status', 'jobId'].includes(key)));
  row.plan.revision = checksum(JSON.stringify({ plan: proofPlan, boundaryHash: row.boundaryHash, targetFiles: row.targetFiles,
    sourceSchemaHash: row.sourceSchemaHash, targetSchemaHash: row.targetSchemaHash,
    sourceSchemaEvidenceHash: row.sourceSchemaEvidenceHash, targetSchemaEvidenceHash: row.targetSchemaEvidenceHash,
    tableMappingsHash: row.tableMappingsHash, requiresPr: row.requiresPr, branchName: row.branchName }));
  writeFileSync(store, JSON.stringify(rows));
  assert.equal(getTopicMigrationPlan(plan.id).status, 'blocked');
  await assert.rejects(stage({ ...plan, revision: row.plan.revision }), /Historical/);
  row.claim = randomUUID();
  writeFileSync(store, JSON.stringify(rows));
  assert.equal((await createTopicMigrationPlan(request())).id, plan.id, 'A legacy claim remains a deduplication tombstone.');
  const legacy: MigrationJob = { id: 'legacy-job', workflow: 'model', sourceId: 'source', sourceLabel: 'Example source', destinationIds: ['target'],
    documentIds: [], emptyFirst: false, replaceSameNamed: false, deleteSourceOnSuccess: false, postMigrationActions: [], status: 'failed', createdAt: Date.now(), items: [], details: {} };
  insertJob(legacy);
  assert.equal(getJob(legacy.id)?.id, legacy.id);
  await assert.rejects(retryMigrationJob(legacy.id), /cannot be replayed/);
  await assert.rejects(mergeModelMigrationJob(legacy.id), /no longer available/);
  assert.equal((await post('jobs/' + legacy.id + '/merge', {})).status, 410);
  assert.equal((await post('jobs', { sourceId: 'source', targetId: 'target' })).status, 410);
  const cleared = await historyHandler(new Request('http://localhost/api/migration-jobs', { method: 'DELETE' }));
  assert.equal(cleared.status, 409); assert.ok(getJob(legacy.id));
});

test('branch review history redaction blocks approval before a one-use claim exists', async () => {
  sourceFiles['records.view'] += 'description: example@example.invalid\n';
  const plan = await createTopicMigrationPlan(request());
  assert.equal(plan.status, 'blocked');
  assert.ok(plan.issues.some((issue) => issue.id === 'history-redaction-integrity'));
  await assert.rejects(stage(plan), /blockers/);
  const rows = JSON.parse(readFileSync(process.env.OMNIKIT_JOB_HISTORY_PATH + '.topic-plans.json', 'utf8'));
  assert.equal(rows[0].claim, undefined); assert.equal(branchCreates, 0);
});

test('branch review dashboard authored handoff keeps provenance and stages through the same contract', async () => {
  const repair = dashboardFixture();
  const response = await post('topic-plan/dashboard', { planId: repair.planId, targetId: repair.targetId });
  assert.equal(response.status, 200, await response.clone().text());
  const plan = (await response.json()).plan as TopicMigrationPlan;
  assert.equal(plan.status, 'ready', JSON.stringify(plan.issues));
  assert.deepEqual(plan.dashboardRepair, { planId: repair.planId, targetId: repair.targetId, revision: 1 });
  const job = await finished((await stage(plan)).job.id);
  assert.equal(job.status, 'succeeded', JSON.stringify(job.items));
  assert.equal((job.details?.dashboardRepair as Record<string, unknown>)?.planId, repair.planId);
  const protectedProof = job.details!.dashboardRepair as Record<string, unknown>;
  assert.equal(protectedProof.targetModelHash, hash(targetFiles), 'A typed digest with a phone-like digit run must remain exact.');
  for (const bad of [{ ...protectedProof, targetModelHash: 'Bearer fictional-credential' }, { ...protectedProof, apiKey: 'fictional-credential' }]) {
    const sanitized = sanitizeJob({ ...job, details: { ...job.details, dashboardRepair: bad } }).details!.dashboardRepair as Record<string, unknown>;
    assert.ok(!JSON.stringify(sanitized).includes('fictional-credential'), 'Credential-like values are never preserved as typed digests.');
  }
  const dashboard = JSON.parse(readFileSync(process.env.OMNIKIT_JOB_HISTORY_PATH + '.deployment-plans.json', 'utf8'))[0];
  assert.equal(dashboard.targets[0].repairJobId, job.id);
  assert.equal(dashboard.targets[0].status, 'needs_recheck');
  assert.equal(branchCreates, 1);
});

test('branch review proposed-topic packages retain exact approval hashes and do not replay', async () => {
  const repair = dashboardFixture();
  const files = ['records.view', 'example.topic'].map((fileName) => ({ fileName, yaml: sourceFiles[fileName], previousChecksum: undefined }));
  const input: ModelMigrationJobInput = { sourceId: 'source', targetId: 'target', models: [{ sourceModelId: 'source-model', targetModelId: 'target-model',
    targetConnectionId: 'target-connection', branchName: 'ignored-client-branch', mode: 'translate', acceptedFiles: files }],
    content: [], postMigrationActions: [], replaceSameNamed: false, mergeAfterValidation: false, publishDrafts: false, deleteBranch: false,
    dashboardRepair: { ...repair, approvedFilesHash: hash(files) } };
  const job = await finished((await stageApprovedDashboardBranchPreparation(input, createModelMigrationJob)).id);
  assert.equal(job.status, 'succeeded', JSON.stringify(job.items));
  assert.match(String((job.details?.branchReceipt as Record<string, unknown>)?.branchName), /^omnikit-topics-/);
  assert.equal((await stageApprovedDashboardBranchPreparation(input, createModelMigrationJob)).id, job.id);
  assert.equal(branchCreates, 1);
});

test('branch review refuses a source change after creating a branch before YAML dispatch', async () => {
  driftDuringCreate = true;
  const job = await finished((await stage(await ready())).job.id);
  assert.notEqual(job.status, 'succeeded');
  assert.equal(branchCreates, 1); assert.equal(yamlWrites, 0);
  assert.equal(job.details?.branchReceipt, undefined);
});

test('branch review known Git followers block preparation while protected branches skip hint reads during execution', async () => {
  targetFollower = true;
  const blocked = await createTopicMigrationPlan(request());
  assert.equal(blocked.status, 'blocked');
  assert.ok(blocked.issues.some((issue) => issue.id === 'git-follower-read-only'));
  await assert.rejects(stage(blocked), /blockers/);
  assert.equal(branchCreates, 0);
  targetFollower = false;
  const plan = await ready();
  const readsAtApproval = namespaceReads;
  const job = await finished((await stage(plan)).job.id);
  assert.equal(job.status, 'succeeded', JSON.stringify(job.items));
  assert.equal(namespaceReads, readsAtApproval, 'Namespace suggestions are not execution authority and must not be refetched.');
});

test('branch review dashboard closure excludes unrelated relationships and preserves destination model settings', async () => {
  const edge = (from: string, to: string) => ({ join_from_view: from, join_to_view: to,
    on_sql: '${' + from + '.id} = ${' + to + '.id}', relationship_type: 'many_to_one', join_type: 'always_left' });
  const requiredEdge = edge('records', 'details');
  sourceFiles.model = 'query_timezone: UTC\n';
  targetFiles.model = '# destination setting\nquery_timezone: America/Chicago\n';
  sourceFiles['example.topic'] = 'base_view: records\nfields: [records.id, details.id]\njoins:\n  details: {}\n';
  sourceFiles['details.view'] = sourceFiles['records.view'].replace('table_name: records', 'table_name: details');
  sourceFiles['relationships'] = stringify([requiredEdge, edge('unrelated', 'other')]);
  const repair = dashboardFixture(['example.topic', 'records.view', 'details.view', 'relationships', 'model']);
  const response = await post('topic-plan/dashboard', { planId: repair.planId, targetId: repair.targetId });
  assert.equal(response.status, 200, await response.clone().text());
  const plan = (await response.json()).plan as TopicMigrationPlan;
  assert.equal(plan.status, 'ready', JSON.stringify(plan.issues));
  assert.deepEqual(parse(plan.files.find((file) => file.fileName === 'relationships')!.proposed), [requiredEdge]);
  assert.ok(!plan.files.some((file) => file.kind === 'model'));
  const job = await finished((await stage(plan)).job.id);
  assert.equal(job.status, 'succeeded', JSON.stringify(job.items));
  assert.deepEqual(parse(branches.get('branch-1')!.files.relationships), [requiredEdge]);
  assert.equal(branches.get('branch-1')!.files.model, targetFiles.model);
});

test('branch review dashboard closure proves field-only topics and rejects missing, ambiguous, or wider readiness scope', async () => {
  const topicChoice: DashboardTopicChoice = { sourceTopicName: 'example', documentIds: ['example-document'], candidates: [],
    sourceCandidates: [{ name: 'example', fileName: 'example.topic' }] };
  targetFiles['example.topic'] = sourceFiles['example.topic'];
  targetFiles['records.view'] = 'catalog: SOURCE\nschema: PUBLIC\ntable_name: records\ndimensions: {}\n';
  let repair = dashboardFixture(['records.view'], [topicChoice]);
  let response = await post('topic-plan/dashboard', { planId: repair.planId, targetId: repair.targetId });
  assert.equal(response.status, 200, await response.clone().text());
  const plan = (await response.json()).plan as TopicMigrationPlan;
  assert.equal(plan.status, 'ready', JSON.stringify(plan.issues));
  assert.deepEqual(plan.request.topicIds, ['example.topic']);
  assert.deepEqual(plan.files.filter((file) => ['create', 'add'].includes(file.status)).map((file) => file.fileName), ['records.view']);
  for (const choices of [undefined, [{ ...topicChoice, sourceCandidates: [...topicChoice.sourceCandidates!, { name: 'example', fileName: 'other/example.topic' }] }]]) {
    repair = dashboardFixture(['records.view'], choices);
    response = await post('topic-plan/dashboard', { planId: repair.planId, targetId: repair.targetId });
    assert.equal(response.status, 409);
    assert.match(await response.text(), /exact authored source topics/);
  }
  delete targetFiles['example.topic'];
  repair = dashboardFixture(['records.view'], [topicChoice]);
  response = await post('topic-plan/dashboard', { planId: repair.planId, targetId: repair.targetId });
  assert.equal(response.status, 409);
  assert.match(await response.text(), /outside the saved dashboard readiness scope/);
  assert.equal(branchCreates, 0);
});

test('branch review dashboard closure retains Git follower blockers for authored and exact approved packages', async () => {
  targetFollower = true;
  const repair = dashboardFixture();
  const response = await post('topic-plan/dashboard', { planId: repair.planId, targetId: repair.targetId });
  assert.equal(response.status, 200, await response.clone().text());
  const plan = (await response.json()).plan as TopicMigrationPlan;
  assert.equal(plan.status, 'blocked');
  assert.ok(plan.issues.some((issue) => issue.id === 'git-follower-read-only'));
  const files = ['records.view', 'example.topic'].map((fileName) => ({ fileName, yaml: sourceFiles[fileName], previousChecksum: undefined }));
  const input: ModelMigrationJobInput = { sourceId: 'source', targetId: 'target', models: [{ sourceModelId: 'source-model', targetModelId: 'target-model',
    targetConnectionId: 'target-connection', branchName: 'ignored-client-branch', mode: 'translate', acceptedFiles: files }],
    content: [], postMigrationActions: [], replaceSameNamed: false, mergeAfterValidation: false, publishDrafts: false, deleteBranch: false,
    dashboardRepair: { ...repair, approvedFilesHash: hash(files) } };
  await assert.rejects(stageApprovedDashboardBranchPreparation(input, createModelMigrationJob), /blockers/);
  const saved = JSON.parse(readFileSync(process.env.OMNIKIT_JOB_HISTORY_PATH + '.topic-plans.json', 'utf8'));
  assert.ok(saved.every((row: { claim?: string; plan: TopicMigrationPlan }) => !row.claim
    && row.plan.status === 'blocked' && row.plan.issues.some((issue) => issue.id === 'git-follower-read-only')));
  assert.equal(branchCreates, 0);
});

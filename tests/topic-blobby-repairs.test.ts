import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import dns from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { afterEach, beforeEach, test } from 'node:test';
import { createTopicMigrationPlan, stageTopicMigrationPlan } from '../server/services/topicMigrationPlans';
import { createModelMigrationJob } from '../server/services/migrationJobs';
import { closeJobStoreForTests, getJob } from '../server/services/jobStore';
import { lockVault, resetVault, unlockVault, upsertInstance } from '../server/services/nativeVault';
import { OmniClient, resetOmniClientRateLimitStateForTests } from '../server/services/omniClient';
import { migrationDestinationModelMutationLease } from '../server/services/migrationScopeReservation';
import { acceptTopicBlobbyRepair, cancelTopicBlobbyRepair, getTopicBlobbyRepair, inspectTopicBlobbyRepair, prepareTopicBlobbyRepair,
  startTopicBlobbyRepair, topicBlobbyApiEnabled, validateTopicBlobbyRepair } from '../server/services/topicBlobbyRepairs';
import { reviewTopicBlobbyChanges, topicBlobbySelectedContext } from '../server/services/topicBlobbyRepairReview';

let root: string;
const keys = ['OMNIKIT_VAULT_PATH', 'OMNIKIT_JOB_HISTORY_PATH', 'OMNIKIT_JOBS_PATH', 'OMNIKIT_BLOBBY_API_TARGETS'] as const;
let old: Array<string | undefined>;
let source: Record<string, string>, main: Record<string, string>, branch: Record<string, string>, branchName: string;
let creates: number, cancels: number, yamlReads: number, state: string, missingId: boolean, failSubmit: boolean;
const file = 'records.view';
const checksum = (value: string) => createHash('sha256').update(value).digest('hex');
beforeEach(t => {
  old = keys.map(key => process.env[key]); root = mkdtempSync(path.join(tmpdir(), 'omnikit-blobby-test-'));
  process.env.OMNIKIT_VAULT_PATH = path.join(root, 'vault.enc'); process.env.OMNIKIT_JOB_HISTORY_PATH = path.join(root, 'jobs.json');
  process.env.OMNIKIT_JOBS_PATH = path.join(root, 'legacy.json'); delete process.env.OMNIKIT_BLOBBY_API_TARGETS;
  closeJobStoreForTests(); resetVault(); resetOmniClientRateLimitStateForTests(); unlockVault('fictional isolated Blobby passphrase');
  for (const [id, role] of [['source', 'source'], ['target', 'destination']] as const) upsertInstance({ id, role, label: 'Example ' + id,
    baseUrl: 'https://' + id + '.example.omniapp.co', apiKey: 'fictional-' + id,
    metricFilter: { connectionDatabaseContains: [], connectionDatabaseExact: [], embedExternalIdContains: [], embedExternalIdExact: [] }, postMigrationActions: [] });
  source = { model: '{}\n', 'example.topic': 'base_view: records\nfields: [records.id]\njoins: {}\n',
    [file]: 'schema: sample\ntable_name: records\ndimensions:\n  id:\n    sql: \'"ID"\'\n' };
  main = { model: '{}\n' }; branch = {}; branchName = ''; creates = 0; cancels = 0; yamlReads = 0; state = 'QUEUED'; missingId = false; failSubmit = false;
  t.mock.method(dns, 'lookup', async () => [{ address: '93.184.216.34', family: 4 }]); syncBuiltinESMExports();
  t.mock.method(OmniClient.prototype, 'listConnections', async () => [
    { id: 'source-connection', name: 'Source', dialect: 'snowflake' }, { id: 'target-connection', name: 'Target', dialect: 'databricks' },
  ]);
  t.mock.method(OmniClient.prototype, 'listModels', async (options: Parameters<OmniClient['listModels']>[0]) => options === 'BRANCH'
    ? [{ id: 'branch-one', name: branchName, baseModelId: 'target-model', connectionId: 'target-connection' }]
    : ['source', 'target'].map(side => ({ id: side + '-model', name: side, connectionId: side + '-connection' })));
  t.mock.method(OmniClient.prototype, 'getModelYaml', async (model: string, options: Parameters<OmniClient['getModelYaml']>[1] = {}) => {
    assert.equal(options.includeSchemas, undefined, 'Blobby repair must not run custom physical translation inventory.'); yamlReads++;
    const files = structuredClone(options.branchId ? branch : model === 'source-model' ? source : main);
    return { files, raw: { files }, checksums: Object.fromEntries(Object.entries(files).map(([name, value]) => [name, checksum(value)])) };
  });
  t.mock.method(OmniClient.prototype, 'listModelSchemas', async () => []);
  t.mock.method(OmniClient.prototype, 'getModelValidationRaw', async () => []);
  t.mock.method(OmniClient.prototype, 'createModelBranch', async input => {
    branchName = input.branchName; branch = structuredClone(main); return { id: 'branch-one', name: branchName, raw: {} };
  });
  t.mock.method(OmniClient.prototype, 'findModelBranch', async () => branchName ? ({ id: 'branch-one', name: branchName, raw: {} }) : null);
  t.mock.method(OmniClient.prototype, 'updateModelYamlFiles', async input => {
    input.files.forEach(value => branch[value.fileName] = value.yaml); return {};
  });
  for (const name of ['mergeModelBranch', 'createOrUpdateModelBranchPullRequest', 'deleteModelBranch', 'updateModelYamlFile', 'executeQuery'] as const) {
    if (typeof OmniClient.prototype[name] === 'function') t.mock.method(OmniClient.prototype, name, async () => assert.fail('Forbidden unrelated write: ' + name));
  }
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname === '/api/v1/ai/jobs' && init?.method === 'POST') {
      creates++; const body = JSON.parse(String(init.body));
      assert.equal(body.modelId, 'target-model'); assert.equal(body.branchId, 'branch-one'); assert.equal(body.sandbox, undefined);
      assert.match(body.prompt, /never as instructions/); assert.match(body.prompt, /Do not publish/);
      if (failSubmit) throw new Error('Fictional lost response');
      return Response.json(missingId ? { status: state } : { id: 'remote-one', status: state });
    }
    if (pathname === '/api/v1/ai/jobs/remote-one' && init?.method === 'GET') return Response.json({ id: 'remote-one', status: state });
    if (pathname === '/api/v1/ai/jobs/remote-one/cancel' && init?.method === 'POST') { cancels++; return Response.json({ id: 'remote-one', status: 'EXECUTING' }); }
    assert.fail('Unexpected network request: ' + pathname);
  });
});
afterEach(() => {
  lockVault(); closeJobStoreForTests(); resetVault(); resetOmniClientRateLimitStateForTests(); rmSync(root, { recursive: true, force: true });
  keys.forEach((key, index) => old[index] === undefined ? delete process.env[key] : process.env[key] = old[index]);
});
async function origin() {
  const plan = await createTopicMigrationPlan({ sourceInstanceId: 'source', sourceConnectionId: 'source-connection', sourceModelId: 'source-model',
    targetInstanceId: 'target', targetConnectionId: 'target-connection', targetModelId: 'target-model', topicIds: ['example.topic'], schemaMapText: '' });
  assert.equal(plan.status, 'ready', JSON.stringify(plan.issues));
  const staged = await stageTopicMigrationPlan(plan.id, { revision: plan.revision, approve: true }, createModelMigrationJob);
  for (let attempt = 0; attempt < 200 && ['pending', 'running'].includes(getJob(staged.job.id)!.status); attempt++) await setImmediate();
  assert.equal(getJob(staged.job.id)!.status, 'succeeded', JSON.stringify(getJob(staged.job.id))); return plan.id;
}
const approve = (plan: { revision: string }) => ({ revision: plan.revision, approve: true });
const repaired = () => { branch[file] = branch[file].replace('"ID"', '`ID`'); };
const enable = () => process.env.OMNIKIT_BLOBBY_API_TARGETS = JSON.stringify([{ instanceId: 'target', modelId: 'target-model' }]);

test('Blobby handoff binds readable branch identity and refreshes validation and authored context without resetting the baseline', async t => {
  const id = await origin();
  const validationMock = t.mock.method(OmniClient.prototype, 'getModelValidationRaw', async () => [
    { yaml_path: file, message: "Table 'sample.records' not found", is_warning: false },
  ]);
  const plan = await prepareTopicBlobbyRepair(id, {});
  const payload = (text: string) => JSON.parse(text.split('Selected user context (JSON):\n')[1]);
  const first = payload(plan.nativePrompt);
  assert.equal(first.branchName, plan.branch.branchName);
  assert.equal(first.branchId, plan.branch.branchId);
  assert.equal(first.targetModelId, plan.branch.modelId);
  assert.equal(first.validation.checkedAt, plan.validation.checkedAt);
  assert.equal(first.validation.branchHash, plan.branchHash);
  assert.equal(first.validation.issues[0].context, 'selected_scope');
  assert.equal(first.validation.issues[0].resolvedFileName, file);
  assert.match(plan.nativePrompt, /This prompt does not select a branch/);
  assert.match(plan.nativePrompt, /physical table bindings/);
  await startTopicBlobbyRepair(plan.id, approve(plan)); repaired();
  const inspected = await inspectTopicBlobbyRepair(plan.id);
  assert.equal(inspected.validation.status, 'not_run');
  assert.notEqual(inspected.nativePromptSnapshot?.branchHash, inspected.branchHash);
  validationMock.mock.mockImplementation(async () => []);
  const validated = await validateTopicBlobbyRepair(plan.id);
  const latest = payload(validated.nativePrompt);
  assert.equal(latest.validation.branchHash, validated.branchHash);
  assert.equal(latest.validation.checkedAt, validated.validation.checkedAt);
  assert.equal(latest.validation.issues.length, 0);
  assert.match(JSON.stringify(latest.selectedAuthoredContent), /`ID`/);
  assert.equal(validated.nativePromptSnapshot?.branchHash, validated.branchHash);
  assert.equal(validated.changes.length, 1, 'Refreshing a prompt must not reset the repair baseline.');
  const accepted = await acceptTopicBlobbyRepair(plan.id, approve(validated));
  assert.equal(accepted.status, 'accepted'); assert.equal(creates, 0);
});

test('Blobby handoff does not regenerate copyable context for a structural scope violation', async () => {
  const plan = await prepareTopicBlobbyRepair(await origin(), {});
  await startTopicBlobbyRepair(plan.id, approve(plan));
  branch[file] += 'access_grants: []\n';
  const inspected = await inspectTopicBlobbyRepair(plan.id);
  assert.ok(inspected.findings.some(finding => finding.severity === 'blocker'));
  const validated = await validateTopicBlobbyRepair(plan.id);
  assert.equal(validated.nativePrompt, '');
  assert.equal(validated.nativePromptSnapshot, undefined);
  assert.equal(validated.status, 'needs_input');
  assert.equal(creates, 0);
});

test('Blobby native baseline review requires inspect and exact validated acceptance without AI or publication calls', async () => {
  const id = await origin(); branch[file] += '# Native comment retained\n';
  const plan = await prepareTopicBlobbyRepair(id, {}); assert.equal(plan.mode, 'native');
  await assert.rejects(acceptTopicBlobbyRepair(plan.id, approve(plan)), /handoff/);
  const started = await startTopicBlobbyRepair(plan.id, approve(plan)); assert.equal(started.status, 'running'); repaired();
  const inspected = await inspectTopicBlobbyRepair(plan.id); assert.equal(inspected.status, 'review'); assert.equal(inspected.changes.length, 1);
  await assert.rejects(acceptTopicBlobbyRepair(plan.id, approve(inspected)), /validation/);
  const validated = await validateTopicBlobbyRepair(plan.id); assert.equal(validated.validation.branchHash, validated.branchHash);
  const accepted = await acceptTopicBlobbyRepair(plan.id, approve(validated)); assert.equal(accepted.status, 'accepted'); assert.equal(creates, 0);
  const next = await prepareTopicBlobbyRepair(id, { predecessorId: accepted.id }); assert.notEqual(next.id, accepted.id); assert.equal(next.status, 'ready');
});

test('Blobby API submits once, pending reads only status, and COMPLETE still requires authoritative diff and validation', async () => {
  enable(); const plan = await prepareTopicBlobbyRepair(await origin(), {}); assert.equal(plan.mode, 'api');
  const started = await startTopicBlobbyRepair(plan.id, approve(plan)); assert.equal(started.remoteJobId, 'remote-one');
  await startTopicBlobbyRepair(plan.id, approve(plan)); assert.equal(creates, 1);
  const reads = yamlReads; await inspectTopicBlobbyRepair(plan.id); assert.equal(yamlReads, reads);
  state = 'COMPLETE'; repaired(); const inspected = await inspectTopicBlobbyRepair(plan.id); assert.equal(inspected.status, 'review');
  assert.equal(inspected.validation.status, 'not_run'); assert.equal(migrationDestinationModelMutationLease(getJob(started.jobId!)!.items[0])?.state, 'resolved');
  const validated = await validateTopicBlobbyRepair(plan.id); branch[file] += '# newer edit\n';
  await assert.rejects(acceptTopicBlobbyRepair(plan.id, approve(validated)), /Current branch/); assert.equal(getTopicBlobbyRepair(plan.id).validation.status, 'not_run');
});

test('Blobby ambiguous submission identity remains uncertain and never replays even after branch appears changed', async () => {
  enable(); missingId = true; const plan = await prepareTopicBlobbyRepair(await origin(), {});
  const started = await startTopicBlobbyRepair(plan.id, approve(plan)); assert.equal(started.status, 'uncertain'); repaired();
  const inspected = await inspectTopicBlobbyRepair(plan.id); assert.equal(inspected.status, 'uncertain');
  await startTopicBlobbyRepair(plan.id, approve(plan)); assert.equal(creates, 1);
  await assert.rejects(prepareTopicBlobbyRepair(plan.originPlanId, { predecessorId: plan.id }), /reconcile/);
  await assert.rejects(validateTopicBlobbyRepair(plan.id), /terminal/);
});

test('Blobby cancellation calls native cancel once but retains lease until strict documented terminal status', async () => {
  enable(); const plan = await prepareTopicBlobbyRepair(await origin(), {}); const started = await startTopicBlobbyRepair(plan.id, approve(plan));
  assert.equal((await cancelTopicBlobbyRepair(plan.id)).status, 'uncertain'); await cancelTopicBlobbyRepair(plan.id); assert.equal(cancels, 1);
  state = 'success'; assert.equal((await inspectTopicBlobbyRepair(plan.id)).status, 'uncertain');
  assert.equal(migrationDestinationModelMutationLease(getJob(started.jobId!)!.items[0])?.state, 'uncertain');
  state = 'CANCELLED'; await inspectTopicBlobbyRepair(plan.id);
  assert.equal(migrationDestinationModelMutationLease(getJob(started.jobId!)!.items[0])?.state, 'resolved');
});

test('Blobby acceptance blocks main drift and full-readback out-of-scope edits without exposing unrelated YAML', async () => {
  const plan = await prepareTopicBlobbyRepair(await origin(), {}); await startTopicBlobbyRepair(plan.id, approve(plan)); repaired();
  branch['unrelated.view'] = 'description: unrelated private content\n'; main.model += '# independent change\n';
  const inspected = await inspectTopicBlobbyRepair(plan.id); assert.equal(inspected.status, 'needs_input');
  assert.ok(inspected.findings.some(value => value.code === 'OUT_OF_SCOPE_CHANGE')); assert.ok(inspected.findings.some(value => value.code === 'MAIN_CHANGED'));
  assert.equal(JSON.stringify(inspected).includes('unrelated private content'), false);
});

test('Blobby strict semantic review protects shared destination members, native-added members, security and deletions', () => {
  const sourceOnly = 'dimensions:\n  migrated:\n    sql: \'"NEW"\'\n';
  const destination = 'dimensions:\n  existing:\n    sql: old_value\n';
  const baseline = 'dimensions:\n  existing:\n    sql: old_value\n  migrated:\n    sql: \'"NEW"\'\n  native_added:\n    sql: native_value\n';
  const protection = { authored: { [file]: sourceOnly }, destination: { [file]: destination } };
  const review = (after: string) => reviewTopicBlobbyChanges({ [file]: baseline }, { [file]: after }, [file], protection);
  assert.equal(review(baseline.replace('"NEW"', '`NEW`')).findings.some(value => value.severity === 'blocker'), false);
  for (const text of [baseline.replace('old_value', 'changed'), baseline.replace('native_value', 'changed')]) assert.ok(review(text).findings.some(value => value.code === 'PREEXISTING_MEMBER_CHANGED'));
  assert.ok(review(baseline.replace('  migrated:\n    sql: \'"NEW"\'\n', '')).findings.some(value => value.code === 'AUTHORED_STRUCTURE_CHANGED'));
  assert.ok(review(baseline + 'access_grants: []\n').findings.some(value => value.severity === 'blocker'));
  assert.ok(review('dimensions: &unsafe {}\n').findings.some(value => value.code === 'YAML_UNREADABLE'));
  const context = JSON.stringify(topicBlobbySelectedContext({ [file]: baseline }, protection.authored));
  assert.equal(context.includes('existing'), false); assert.equal(context.includes('native_added'), false);
});

test('Blobby API rollout is exact-target opt-in and prompt rejects secrets instead of forwarding or logging them', async () => {
  assert.equal(topicBlobbyApiEnabled('target', 'target-model'), false); enable();
  assert.equal(topicBlobbyApiEnabled('target', 'target-model'), true); assert.equal(topicBlobbyApiEnabled('other', 'target-model'), false);
  const id = await origin(); branch[file] += 'description: "password=fictional-value"\n';
  // Current selected members only; a native-added description is deliberately excluded from AI context.
  const plan = await prepareTopicBlobbyRepair(id, {}); assert.equal(plan.nativePrompt.includes('fictional-value'), false);
  branch[file] = branch[file].replace('"ID"', 'password=fictional-value');
  await assert.rejects(prepareTopicBlobbyRepair(id, {}), /secret-shaped/);
  assert.equal(creates, 0);
});

test('Blobby no-change native branch can be validated and accepted without claiming any AI-authored changes', async () => {
  const plan = await prepareTopicBlobbyRepair(await origin(), {}); await startTopicBlobbyRepair(plan.id, approve(plan));
  await inspectTopicBlobbyRepair(plan.id); const validated = await validateTopicBlobbyRepair(plan.id);
  const accepted = await acceptTopicBlobbyRepair(plan.id, approve(validated)); assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.changes.length, 0); assert.match(accepted.progress, /No repair needed/); assert.equal(creates, 0);
});

test('Blobby relationship repair authority follows exact role-playing identity, not shared-array position', () => {
  const relation = (alias: string, sql: string) => `- join_from_view: events\n  join_to_view: teams\n  join_to_view_as: ${alias}\n  on_sql: '${sql}'\n`;
  const existing = relation('home_team', '${events.home_id} = ${home_team.id}');
  const selected = relation('away_team', 'IFF(${events.away_id} = ${away_team.id}, TRUE, FALSE)');
  const before = { relationships: existing + selected }, scope = ['relationships'];
  const protection = { authored: { relationships: selected }, destination: { relationships: existing } };
  const fixed = reviewTopicBlobbyChanges(before, { relationships: existing + selected.replace('IFF(', 'IF(') }, scope, protection);
  assert.equal(fixed.findings.some(finding => finding.severity === 'blocker'), false);
  const changedExisting = reviewTopicBlobbyChanges(before, { relationships: existing.replace(' = ', ' != ') + selected }, scope, protection);
  assert.ok(changedExisting.findings.some(finding => finding.code === 'PREEXISTING_MEMBER_CHANGED'));
  const ambiguous = reviewTopicBlobbyChanges(before, { relationships: existing + selected.replace('IFF(', 'IF(') }, scope,
    { ...protection, authored: { relationships: selected + selected } });
  assert.ok(ambiguous.findings.some(finding => finding.code === 'YAML_UNREADABLE'));
});

test('Blobby real additive-plan prompt excludes merged destination-only members and protects them on readback', async () => {
  main[file] = 'schema: sample\ntable_name: records\ndimensions:\n  destination_only:\n    sql: existing_value\n';
  const plan = await prepareTopicBlobbyRepair(await origin(), {});
  assert.equal(plan.nativePrompt.includes('destination_only'), false); assert.equal(plan.nativePrompt.includes('existing_value'), false);
  assert.match(plan.nativePrompt, /ID/); await startTopicBlobbyRepair(plan.id, approve(plan));
  branch[file] = branch[file].replace('existing_value', 'changed_value');
  const inspected = await inspectTopicBlobbyRepair(plan.id);
  assert.ok(inspected.findings.some(finding => finding.code === 'PREEXISTING_MEMBER_CHANGED'));
});

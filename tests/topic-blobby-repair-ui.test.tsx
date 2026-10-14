import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BlobbyActualFileDiff, GroupedRepairIssues, NativeBlobbyHandoff, TopicBlobbyRepair, TopicBlobbyRepairReview } from '../src/components/modelMigration/TopicBlobbyRepair';
import { canAcceptTopicBlobbyRepair, canStartTopicBlobbyRepair, getTopicBlobbyRepair, prepareTopicBlobbyRepair, hasCurrentTopicBlobbyPrompt,
  readTopicBlobbyRepairReference, runTopicBlobbyRepairAction, topicBlobbyRepairReport } from '../src/services/topicBlobbyRepair';
import type { TopicBlobbyRepair as Repair } from '../shared/topicBlobbyRepair';

function fixture(): Repair {
  return { version: 1, id: 'repair', revision: 'revision', originPlanId: 'original-plan', originJobId: 'original-job',
    request: { sourceInstanceId: 'source', sourceConnectionId: 'source-connection', sourceModelId: 'source-model', targetInstanceId: 'target',
      targetConnectionId: 'target-connection', targetModelId: 'target-model', topicIds: ['records'], schemaMapText: 'PRIVATE_MAPPING' },
    branch: { modelId: 'target-model', branchId: 'exact-branch-id', branchName: 'existing-review-branch' }, mode: 'native', status: 'ready',
    createdAt: 10, expiresAt: 1000, progress: 'Review this branch scope.', nativePrompt: 'PRIVATE_PROMPT', sourceDialect: 'snowflake', targetDialect: 'databricks',
    scopeFiles: ['records.view'], changes: [], findings: [], validation: { status: 'not_run', issues: [] } };
}

test('repair references restore identity only, bound to the original plan', () => {
  const saved = JSON.stringify({ version: 1, id: 'repair', originPlanId: 'original-plan', approved: true, mode: 'api', nativePrompt: 'PRIVATE_PROMPT', yaml: 'PRIVATE_YAML' });
  assert.deepEqual(readTopicBlobbyRepairReference(saved, 'original-plan'), { version: 1, id: 'repair', originPlanId: 'original-plan' });
  assert.equal(readTopicBlobbyRepairReference(saved, 'other-plan'), null);
  assert.equal(readTopicBlobbyRepairReference('{', 'original-plan'), null);
  assert.equal(readTopicBlobbyRepairReference(JSON.stringify({ version: 1, id: '../unsafe', originPlanId: 'original-plan' }), 'original-plan'), null);
});

test('starting either server mode needs fresh one-use approval and an unstarted unexpired context', () => {
  for (const mode of ['native', 'api'] as const) {
    const repair = { ...fixture(), mode };
    assert.equal(canStartTopicBlobbyRepair(repair, true, true, false, 100), true);
    for (const [approved, fresh, attempted] of [[false, true, false], [true, false, false], [true, true, true]]) {
      assert.equal(canStartTopicBlobbyRepair(repair, approved, fresh, attempted, 100), false);
    }
    for (const status of ['running', 'uncertain', 'review', 'needs_input', 'accepted', 'canceled'] as const) {
      assert.equal(canStartTopicBlobbyRepair({ ...repair, status }, true, true, false, 100), false);
    }
    assert.equal(canStartTopicBlobbyRepair(repair, true, true, false, 1000), false);
    assert.equal(canStartTopicBlobbyRepair({ ...repair, jobId: 'existing-job' }, true, true, false, 100), false);
    assert.equal(canStartTopicBlobbyRepair({ ...repair, remoteJobId: 'remote-job' }, true, true, false, 100), false);
    assert.equal(canStartTopicBlobbyRepair({ ...repair, findings: [{ code: 'branch_changed', severity: 'blocker', message: 'Recheck branch.' }] }, true, true, false, 100), false);
  }
});

test('native fallback supplies exact scope and usable copy/open actions after baseline approval', () => {
  const repair: Repair = { ...fixture(), status: 'running', branchHash: 'snapshot',
    nativePromptSnapshot: { branchHash: 'snapshot', generatedAt: 100, validationCheckedAt: 90 },
    validation: { status: 'issues', branchHash: 'snapshot', checkedAt: 90, issues: [] } };
  const html = renderToStaticMarkup(<NativeBlobbyHandoff repair={repair} active disabled={false} destinationUrl="https://example.invalid/model/guess?token=private" onCopy={() => {}} />);
  for (const text of ['Run Blobby in Omni', 'Copy scoped repair instructions', 'Open Omni', 'existing-review-branch', 'exact-branch-id', 'target-model', 'PRIVATE_PROMPT']) assert.ok(html.includes(text));
  assert.match(html, /href="https:\/\/example.invalid"/);
  assert.match(html, /Automated Blobby branch controls are not enabled for this destination/);
  assert.doesNotMatch(html, /token=private|\/model\/guess|disabled=""/);
  const ready = renderToStaticMarkup(<NativeBlobbyHandoff repair={fixture()} active={false} disabled={false} destinationUrl="https://example.invalid" onCopy={() => {}} />);
  assert.match(ready, /Begin the Blobby handoff above/); assert.match(ready, /disabled=""/); assert.doesNotMatch(ready, /<a /);
  const unsafe = renderToStaticMarkup(<NativeBlobbyHandoff repair={repair} active disabled={false} destinationUrl="javascript:alert(1)" onCopy={() => {}} />);
  assert.doesNotMatch(unsafe, /<a /);
  assert.match(html, /Ask Blobby to confirm the active branch before editing/);
  for (const stale of [{ ...repair, branchHash: 'changed' }, { ...repair, nativePromptSnapshot: undefined },
    { ...repair, mainUnchanged: false }, { ...repair, findings: [{ code: 'STRUCTURAL_CHANGE', severity: 'blocker' as const, message: 'Review required' }] },
    { ...repair, validation: { ...repair.validation, checkedAt: 101 } }]) {
    assert.equal(hasCurrentTopicBlobbyPrompt(stale), false);
    const staleHtml = renderToStaticMarkup(<NativeBlobbyHandoff repair={stale} active disabled={false} onCopy={() => {}} />);
    assert.match(staleHtml, /Instructions need fresh branch validation/);
    assert.doesNotMatch(staleHtml, /PRIVATE_PROMPT/);
    assert.match(staleHtml, /disabled=""/);
  }
});

test('acceptance requires reviewed actual diffs and validation of the exact unchanged-main snapshot', () => {
  const repair: Repair = { ...fixture(), status: 'review', mainUnchanged: true, branchHash: 'branch-hash',
    changes: [{ fileName: 'records.view', before: 'before', after: 'after' }], validation: { status: 'passed', branchHash: 'branch-hash', issues: [] } };
  assert.equal(canAcceptTopicBlobbyRepair(repair, true, ['records.view'], false), true);
  for (const patch of [
    { mainUnchanged: false }, { mainUnchanged: undefined }, { branchHash: undefined }, { status: 'running' as const },
    { validation: { status: 'not_run' as const, issues: [] } }, { validation: { status: 'unavailable' as const, issues: [] } },
    { validation: { status: 'issues' as const, issues: [] } }, { validation: { status: 'passed' as const, branchHash: 'other-hash', issues: [] } },
    { findings: [{ code: 'out_of_scope', severity: 'blocker' as const, message: 'Unexpected file changed.' }] },
  ]) assert.equal(canAcceptTopicBlobbyRepair({ ...repair, ...patch }, true, ['records.view'], false), false);
  assert.equal(canAcceptTopicBlobbyRepair(repair, false, ['records.view'], false), false);
  assert.equal(canAcceptTopicBlobbyRepair(repair, true, [], false), false);
  assert.equal(canAcceptTopicBlobbyRepair(repair, true, ['records.view'], true), false);
  const unchanged = { ...repair, changes: [] };
  assert.equal(canAcceptTopicBlobbyRepair(unchanged, true, [], false), true);
  assert.match(renderToStaticMarkup(<TopicBlobbyRepairReview repair={unchanged} />), /does not claim that Blobby authored a change/);
});

test('review separates actual changes, grouped findings, validation, and unverified historical state', () => {
  const repair: Repair = { ...fixture(), mode: 'api', status: 'running', progress: 'Blobby is working on the reviewed branch.',
    findings: [{ fileName: 'records.view', code: 'scope', severity: 'blocker', message: 'Unexpected scope change.' }],
    validation: { status: 'unavailable', issues: [
      { fileName: 'records.view', warning: true, message: 'Review the field label.' },
      { fileName: 'records.view', warning: false, message: 'Missing field reference.' },
      { warning: true, message: 'Check model defaults.' },
    ] } };
  const html = renderToStaticMarkup(<TopicBlobbyRepairReview repair={repair} />);
  assert.match(html, /Blobby is working on the reviewed branch/);
  const needsInput = renderToStaticMarkup(<TopicBlobbyRepairReview repair={{ ...repair, status: 'needs_input' }} />);
  assert.match(needsInput, /Needs your input/); assert.doesNotMatch(needsInput, /needs_input/);
  assert.match(html, /animate-spin/); assert.doesNotMatch(html, /<progress|[0-9]+%/);
  assert.match(html, /Branch model validation: Unavailable — not validated/);
  assert.match(html, /Model validation findings for records.view/); assert.match(html, /Model validation findings for General/);
  assert.ok(html.indexOf('Missing field reference.') < html.indexOf('Review the field label.'));
  const historical = renderToStaticMarkup(<TopicBlobbyRepairReview repair={{ ...repair, mainUnchanged: true }} unverified />);
  assert.match(historical, /Last received repair state/); assert.match(historical, /current state unverified/);
  assert.doesNotMatch(historical, /Shared model unchanged: verified|animate-spin/);
});

test('duplicate warnings are grouped by cause and file while distinct details remain available', () => {
  const html = renderToStaticMarkup(<GroupedRepairIssues label="Inspection" issues={[
    { code: 'identifier', fileName: 'records.view', warning: true, message: 'Check the identifier.' },
    { code: 'identifier', fileName: 'records.view', warning: true, message: 'Check the identifier.' },
    { code: 'identifier', fileName: 'records.view', warning: true, message: 'The second field also needs review.' },
    { code: 'identifier', fileName: 'other.view', warning: true, message: 'Check the identifier.' },
  ]} />);
  assert.equal((html.match(/Check the identifier\./g) || []).length, 2);
  assert.match(html, /3 related findings/); assert.match(html, /The second field also needs review/);
  assert.match(html, /Inspection for records.view/); assert.match(html, /Inspection for other.view/);
});

test('full readback diff displays replacement, creation, and deletion without relying on AI summary', () => {
  const changed = renderToStaticMarkup(<BlobbyActualFileDiff before={'sql: "ID"\nlabel: Preserved\n'} after={'sql: `ID`\nlabel: Preserved\n'} />);
  assert.match(changed, /Before Blobby/); assert.match(changed, /Actual branch now/);
  assert.match(changed, /− sql: &quot;ID&quot;/); assert.match(changed, /\+ sql: `ID`/); assert.match(changed, /label: Preserved/);
  const deleted = renderToStaticMarkup(<BlobbyActualFileDiff before="removed definition" after={null} />);
  assert.match(deleted, /Actual branch now — deleted/); assert.match(deleted, /− removed definition/);
  const created = renderToStaticMarkup(<BlobbyActualFileDiff before={null} after="created definition" />);
  assert.match(created, /Before Blobby — absent/); assert.match(created, /\+ created definition/);
});

test('repair exports omit prompts, raw files, SQL values, and free-form diagnostic text', () => {
  const repair: Repair = { ...fixture(), changes: [{ fileName: 'records.view', before: 'PRIVATE_BEFORE', after: 'PRIVATE_AFTER' }],
    findings: [{ code: 'finding', severity: 'warning', message: 'PRIVATE_FINDING' }],
    validation: { status: 'issues', message: 'PRIVATE_VALIDATION', issues: [{ warning: false, message: 'PRIVATE_ERROR' }] } };
  const report = topicBlobbyRepairReport(repair);
  assert.deepEqual(report.changes, [{ fileName: 'records.view', action: 'changed' }]);
  assert.equal(report.validation.errors, 1); assert.doesNotMatch(JSON.stringify(report), /PRIVATE_/);
});

test('repair routes preserve explicit approval boundaries and cancellation signals', async () => {
  const originalFetch = globalThis.fetch, calls: Array<{ url: string; options?: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
    calls.push({ url: String(url), options }); return new Response(JSON.stringify({ repair: fixture() }), { status: 200 });
  }) as typeof fetch;
  try {
    const controller = new AbortController();
    await prepareTopicBlobbyRepair('original/plan', controller.signal);
    await getTopicBlobbyRepair('repair/id', controller.signal);
    for (const action of ['start', 'inspect', 'cancel', 'validate', 'accept'] as const) await runTopicBlobbyRepairAction(fixture(), action, controller.signal);
    await prepareTopicBlobbyRepair('original-plan', controller.signal, 'prior-repair');
    assert.equal(calls[0].url, '/api/model-migrator/topic-plan/original%2Fplan/blobby-repairs'); assert.equal(calls[0].options?.body, '{}');
    assert.equal(calls[1].url, '/api/model-migrator/blobby-repairs/repair%2Fid'); assert.equal(calls[1].options?.body, undefined);
    for (const call of [calls[2], calls[6]]) assert.deepEqual(JSON.parse(String(call.options?.body)), { revision: 'revision', approve: true });
    for (const call of calls.slice(3, 6)) assert.equal(call.options?.body, '{}');
    assert.deepEqual(JSON.parse(String(calls[7].options?.body)), { predecessorId: 'prior-repair' });
    assert.ok(calls.every(call => call.options?.signal === controller.signal));
    assert.doesNotMatch(JSON.stringify(calls), /PRIVATE_PROMPT|sourceInstanceId|nativePrompt/);
  } finally { globalThis.fetch = originalFetch; }
});

test('active wizard has one Blobby repair surface and guarded bounded resume without browser refresh', () => {
  const initial = renderToStaticMarkup(<TopicBlobbyRepair originPlanId="original-plan" targetLabel="Destination" disabled={false} />);
  assert.match(initial, /Prepare Blobby repair/); assert.doesNotMatch(initial, /Run Blobby on this branch|Begin Blobby handoff/);
  const panel = readFileSync(new URL('../src/components/modelMigration/TopicBlobbyRepair.tsx', import.meta.url), 'utf8');
  assert.match(panel, /repairMode !== 'api' \|\| repairStatus !== 'running'/);
  assert.match(panel, /POLL_LIMIT = 30/); assert.match(panel, /const deadline = setTimeout/);
  assert.match(panel, /revision !== generation.current \|\| abort.signal.aborted \|\| disabledRef.current/);
  assert.match(panel, /if \(action === 'start'\) \{ setStartAttempted\(true\); setFresh\(false\); \}/);
  assert.match(panel, /actionInFlight.current = true/); assert.doesNotMatch(panel, /location\.reload|window\.location/);
  assert.match(panel, /if \(action === 'next' && \(!repair\?\.canPrepareNext \|\| unverified\)\) return/);
  assert.match(panel, /Request Blobby stop/); assert.match(panel, /current iteration to finish/);
  const wizard = readFileSync(new URL('../src/components/modelMigration/TopicMigrationWizard.tsx', import.meta.url), 'utf8');
  assert.match(wizard, /<TopicBlobbyRepair/); assert.doesNotMatch(wizard, /<TopicBranchCorrections/);
  assert.match(wizard, /if \(activeChanged\) clearTopicBlobbyRepairReference/);
  assert.match(wizard, /Review again after no-write recovery/);
});

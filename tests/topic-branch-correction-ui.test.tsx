import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TopicBranchCorrectionDiff, TopicBranchCorrectionReview, TopicBranchCorrections } from '../src/components/modelMigration/TopicBranchCorrections';
import { applyTopicBranchCorrection, canApplyTopicBranchCorrection, getTopicBranchCorrection, inspectTopicBranchCorrection,
  prepareTopicBranchCorrection, readTopicBranchCorrectionReference, topicBranchCorrectionReport } from '../src/services/topicBranchCorrection';
import type { TopicBranchCorrectionPlan } from '../shared/topicBranchCorrection';

function fixture(): TopicBranchCorrectionPlan {
  return { version: 1, id: 'correction', revision: 'review-revision', originPlanId: 'original-plan', originJobId: 'original-job',
    branch: { modelId: 'target-model', branchId: 'review-branch-id', branchName: 'existing-review-branch' },
    request: { sourceInstanceId: 'source', sourceConnectionId: 'source-connection', sourceModelId: 'source-model', targetInstanceId: 'target',
      targetConnectionId: 'target-connection', targetModelId: 'target-model', topicIds: ['records'], schemaMapText: '', reviewedSqlFiles: { 'records.view': 'PRIVATE_SQL' } },
    createdAt: 10, expiresAt: 1000, sourceDialect: 'snowflake', targetDialect: 'databricks', status: 'ready', progress: 'Review current branch differences.',
    files: [{ fileName: 'records.view', sourceFileName: 'records.view', kind: 'view', topicIds: ['records'], before: 'PRIVATE_BEFORE_YAML', proposed: 'PRIVATE_AFTER_YAML',
      status: 'add', sqlDialectReview: { corrections: [{ path: 'dimensions.id.sql', from: 'PRIVATE_FROM_SQL', to: 'PRIVATE_TO_SQL' }], findings: [] } }],
    issues: [], noops: 2, outcomes: [{ fileName: 'records.view', status: 'pending' }], filesVerified: false,
    validation: { status: 'not_run', issues: [] }, contentValidation: { status: 'unavailable', issues: [], message: 'Scoped content validation is unavailable.' } };
}

test('restoration strips approval and raw input and remains bound to the original plan', () => {
  const saved = JSON.stringify({ version: 1, id: 'correction', originPlanId: 'original-plan', approved: true, yaml: 'PRIVATE_YAML', revision: 'ignored' });
  assert.deepEqual(readTopicBranchCorrectionReference(saved, 'original-plan'), { version: 1, id: 'correction', originPlanId: 'original-plan' });
  assert.equal(readTopicBranchCorrectionReference(saved, 'other-plan'), null);
  assert.equal(readTopicBranchCorrectionReference('{', 'original-plan'), null);
  assert.equal(readTopicBranchCorrectionReference(JSON.stringify({ version: 1, id: '../unsafe', originPlanId: 'original-plan' }), 'original-plan'), null);
});

test('apply needs a fresh explicit approval, ready unblocked changes, unexpired review, and unused attempt', () => {
  const correction = fixture();
  assert.equal(canApplyTopicBranchCorrection(correction, true, true, false, 100), true);
  for (const [approved, fresh, attempted] of [[false, true, false], [true, false, false], [true, true, true]]) {
    assert.equal(canApplyTopicBranchCorrection(correction, approved, fresh, attempted, 100), false);
  }
  for (const status of ['blocked', 'unchanged', 'running', 'applied', 'partial', 'uncertain', 'canceled'] as const) {
    assert.equal(canApplyTopicBranchCorrection({ ...correction, status }, true, true, false, 100), false);
  }
  assert.equal(canApplyTopicBranchCorrection(correction, true, true, false, 1000), false);
  assert.equal(canApplyTopicBranchCorrection({ ...correction, jobId: 'already-started' }, true, true, false, 100), false);
  assert.equal(canApplyTopicBranchCorrection({ ...correction, files: [{ ...correction.files[0], status: 'reuse' }] }, true, true, false, 100), false);
  assert.equal(canApplyTopicBranchCorrection({ ...correction, issues: [{ id: 'blocker', kind: 'conflict', severity: 'blocker', title: 'Changed branch', message: '', nextAction: '', topicIds: [] }] }, true, true, false, 100), false);
});

test('correction review displays separate evidence and never promotes unavailable validation', () => {
  const correction = fixture();
  const html = renderToStaticMarkup(<TopicBranchCorrectionReview correction={correction} />);
  for (const expected of ['existing-review-branch', 'review-branch-id', 'target-model', 'Current branch → Proposed corrections', '2 unchanged',
    'Branch model validation: Not run', 'Affected content validation: Unavailable — not validated', 'File readback: not verified', 'do not publish the model or change the original preparation outcome']) {
    assert.ok(html.includes(expected), expected);
  }
  assert.doesNotMatch(html, /bg-green|text-green|Passed|PRIVATE_BEFORE_YAML|PRIVATE_AFTER_YAML/);
  const historical = renderToStaticMarkup(<TopicBranchCorrectionReview correction={{ ...correction, status: 'applied', filesVerified: true,
    mainUnchanged: true, validation: { status: 'passed', issues: [] } }} unverified />);
  assert.match(historical, /Last received correction outcome/);
  assert.match(historical, /current state unverified/);
  assert.doesNotMatch(historical, /File readback: verified|Shared model unchanged: verified/);
});

test('unchanged files with unsupported findings do not claim their SQL is corrected', () => {
  const correction = fixture(); correction.status = 'unchanged'; correction.files[0].status = 'reuse';
  correction.files[0].sqlDialectReview = { corrections: [], findings: [{ path: 'dimensions.id.sql', reason: 'Unsupported expression.' }] };
  const unresolved = renderToStaticMarkup(<TopicBranchCorrectionReview correction={correction} />);
  assert.match(unresolved, /Unchanged — no supported automatic correction/);
  assert.doesNotMatch(unresolved, /Already corrected|already correct/);
  correction.files[0].sqlDialectReview.findings = [];
  assert.match(renderToStaticMarkup(<TopicBranchCorrectionReview correction={correction} />), /Already corrected/);
});

test('blockers show next actions and validation findings are grouped by file and severity', () => {
  const correction = fixture();
  correction.issues = [{ id: 'blocker', kind: 'conflict', severity: 'blocker', title: 'Changed branch', message: 'The reviewed file changed.',
    nextAction: 'Recheck the branch before approving.', topicIds: [], fileName: 'records.view' }];
  correction.validation = { status: 'issues', issues: [
    { fileName: 'records.view', warning: true, message: 'Review a deprecated field.' },
    { fileName: 'records.view', warning: false, message: 'Missing dimension reference.' },
    { fileName: 'another.view', warning: false, message: 'Table unavailable.' },
    { warning: true, message: 'Check the model default.' },
  ] };
  const html = renderToStaticMarkup(<TopicBranchCorrectionReview correction={correction} />);
  assert.match(html, />Next action<.*Recheck the branch before approving/);
  assert.match(html, /findings for records.view/); assert.match(html, /findings for another.view/);
  assert.match(html, /findings for General validation/);
  assert.match(html, />Errors · 1</); assert.match(html, />Warnings · 1</);
  assert.ok(html.indexOf('Missing dimension reference.') < html.indexOf('Review a deprecated field.'));
});

test('correction summary exports only selected metadata, not definitions, SQL values, or diagnostic bodies', () => {
  const correction = fixture();
  correction.issues = [{ id: 'finding', kind: 'sql', severity: 'review', title: 'PRIVATE_TITLE', message: 'PRIVATE_DIAGNOSTIC', nextAction: 'PRIVATE_NEXT_ACTION', topicIds: [] }];
  correction.validation = { status: 'issues', message: 'PRIVATE_VALIDATION', issues: [{ warning: false, message: 'PRIVATE_ERROR' }] };
  const report = topicBranchCorrectionReport(correction);
  assert.deepEqual(report.files[0].correctedFields, ['dimensions.id.sql']);
  assert.equal(report.validation.issueCount, 1);
  assert.equal(report.contentValidation.status, 'unavailable');
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_/);
});

test('expanded correction diff identifies the existing branch and exact proposed replacement lines', () => {
  const html = renderToStaticMarkup(<TopicBranchCorrectionDiff before={'table_name: RECORDS\nlabel: Retained\n'} after={'table_name: records\nlabel: Retained\n'} />);
  assert.match(html, /role="columnheader"[^>]*>Current branch/);
  assert.match(html, /role="columnheader"[^>]*>Proposed corrections/);
  assert.match(html, /− table_name: RECORDS/); assert.match(html, /\+ table_name: records/);
  assert.match(html, /label: Retained/); assert.doesNotMatch(html, /Current destination|Proposed destination/);
});

test('correction APIs send exact reference and approval contracts with cancellation support', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({ correction: fixture() }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const abort = new AbortController();
    await prepareTopicBranchCorrection('original/plan', 'prior-review', abort.signal);
    await getTopicBranchCorrection('correction/id', abort.signal);
    await applyTopicBranchCorrection(fixture(), abort.signal);
    for (const action of ['reconcile', 'validate', 'content-validation', 'cancel'] as const) await inspectTopicBranchCorrection('correction', action, abort.signal);
    assert.equal(calls[0].url, '/api/model-migrator/topic-plan/original%2Fplan/corrections');
    assert.deepEqual(JSON.parse(String(calls[0].options?.body)), { predecessorId: 'prior-review' });
    assert.equal(calls[1].url, '/api/model-migrator/branch-corrections/correction%2Fid');
    assert.equal(calls[1].options?.body, undefined);
    assert.deepEqual(JSON.parse(String(calls[2].options?.body)), { revision: 'review-revision', approve: true });
    assert.ok(calls.every(call => call.options?.signal === abort.signal));
    for (const call of calls.slice(3)) assert.equal(call.options?.body, '{}');
  } finally { globalThis.fetch = originalFetch; }
});

test('initial correction UI is review-only, unsafe links are omitted, and lifecycle guards stay present', () => {
  const html = renderToStaticMarkup(<TopicBranchCorrections originPlanId="original-plan" targetLabel="Destination" disabled={false} destinationUrl="javascript:alert(1)" />);
  assert.match(html, /Review branch corrections/);
  assert.doesNotMatch(html, /Update this review branch|<a /);
  const panel = readFileSync(new URL('../src/components/modelMigration/TopicBranchCorrections.tsx', import.meta.url), 'utf8');
  assert.match(panel, /revision !== generation.current \|\| abort.signal.aborted \|\| disabledRef.current/);
  assert.match(panel, /setAttempted\(true\); setFresh\(false\)/);
  assert.match(panel, /POLL_LIMIT = 30/);
  assert.match(panel, /deadlineTimer = setTimeout/);
  assert.match(panel, /const canValidate = correction && !running && !unverified && \(correction.filesVerified \|\| correction.status === 'unchanged'\)/);
  assert.doesNotMatch(panel, /location\.reload|window\.location/);
  const wizard = readFileSync(new URL('../src/components/modelMigration/TopicMigrationWizard.tsx', import.meta.url), 'utf8');
  assert.match(wizard, /!dashboardHandoff && jobBound && currentPlan && !currentPlan.comparisonOnly/);
  assert.match(wizard, /if \(activeChanged\) clearTopicBranchCorrectionReference/);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TopicDestinationPreservationChoice, TopicMigrationReview } from '../src/components/modelMigration/TopicMigrationReview';
import { TopicMigrationIssues } from '../src/components/modelMigration/TopicMigrationIssues';
import { canChooseTopicDestinationDefinitions, canStageTopicPlan, chooseTopicDestinationDefinitions, reconcileTopicDestinationChoices,
  topicMigrationReport, topicRequestFingerprint } from '../src/services/topicMigrationFlow';
import type { TopicMigrationPlan, TopicMigrationRequest } from '../shared/topicMigration';

function fixture(): TopicMigrationPlan {
  const sourceHash = `sha256:${'a'.repeat(64)}`, targetHash = `sha256:${'b'.repeat(64)}`;
  const request: TopicMigrationRequest = { sourceInstanceId: 'source', sourceConnectionId: 'source-connection', sourceModelId: 'source-model',
    targetInstanceId: 'target', targetConnectionId: 'target-connection', targetModelId: 'target-model', topicIds: ['records.topic', 'summary.topic'], schemaMapText: '' };
  return { version: 2, executionProfile: 'branch_preparation_v1', id: 'plan', revision: 'revision', request, status: 'blocked',
    createdAt: Date.now(), expiresAt: Date.now() + 60_000, topics: [], dependencies: [], sourceHash, targetHash,
    issues: [{ id: 'conflict', kind: 'conflict', severity: 'blocker', title: 'Conflicting field', message: 'Destination field differs.', nextAction: 'Review the definitions.', fileName: 'source/records.view', topicIds: ['records.topic', 'summary.topic'] }],
    files: [{ sourceFileName: 'source/records.view', fileName: 'destination/records.view', destinationFileName: 'destination/records.view', kind: 'view',
      topicIds: ['records.topic', 'summary.topic'], before: 'PRIVATE_DESTINATION', proposed: 'PRIVATE_SOURCE', status: 'blocked',
      preservationOption: { destinationFileName: 'destination/records.view', sourceHash, targetHash } }] };
}

test('destination preservation uses only a server-nominated exact snapshot candidate', () => {
  const plan = fixture(), file = plan.files[0];
  assert.equal(canChooseTopicDestinationDefinitions(plan, file), true);
  for (const changed of [
    { ...file, preservationOption: undefined }, { ...file, kind: 'topic' as const }, { ...file, before: null },
    { ...file, preservationOption: { ...file.preservationOption!, sourceHash: 'stale' } },
    { ...file, preservationOption: { ...file.preservationOption!, targetHash: 'stale' } },
    { ...file, preservationOption: { ...file.preservationOption!, destinationFileName: 'other.view' } },
  ]) assert.equal(canChooseTopicDestinationDefinitions(plan, changed), false);
  for (const changed of [
    { ...plan, status: 'submitted' as const }, { ...plan, jobId: 'already-started' }, { ...plan, expiresAt: 0 },
    { ...plan, comparisonOnly: { ofPlanId: 'old-plan', priorRuns: [] } }, { ...plan, dashboardRepair: { planId: 'dashboard', targetId: 'target', revision: 1 } },
  ]) assert.equal(canChooseTopicDestinationDefinitions(changed, file), false);
  const request = chooseTopicDestinationDefinitions(plan, plan.request, file.sourceFileName, true)!;
  assert.deepEqual(request.keepDestinationDefinitions, { [file.sourceFileName]: file.preservationOption });
  assert.equal(plan.request.keepDestinationDefinitions, undefined);
  assert.equal(chooseTopicDestinationDefinitions(plan, { ...plan.request, schemaMapText: 'changed' }, file.sourceFileName, true), null);
});

test('preservation choices clear on pair, topic, and mapping boundaries but survive the same review', () => {
  const plan = fixture(), file = plan.files[0];
  const request = chooseTopicDestinationDefinitions(plan, plan.request, file.sourceFileName, true)!;
  const unchanged = reconcileTopicDestinationChoices(request, { ...request, topicIds: [...request.topicIds].reverse() });
  assert.deepEqual(unchanged.keepDestinationDefinitions, request.keepDestinationDefinitions);
  for (const key of ['sourceInstanceId', 'sourceConnectionId', 'sourceModelId', 'targetInstanceId', 'targetConnectionId', 'targetModelId', 'schemaMapText'] as const) {
    assert.equal(reconcileTopicDestinationChoices(request, { ...request, [key]: 'changed' }).keepDestinationDefinitions, undefined, key);
  }
  assert.equal(reconcileTopicDestinationChoices(request, { ...request, topicIds: ['records.topic'] }).keepDestinationDefinitions, undefined);
  const selectedPlan = { ...plan, request };
  assert.equal(chooseTopicDestinationDefinitions(selectedPlan, request, file.sourceFileName, false)?.keepDestinationDefinitions, undefined);
});

test('chosen destination snapshots bind the request fingerprint and final approval', () => {
  const plan = fixture(), file = plan.files[0];
  const request = chooseTopicDestinationDefinitions(plan, plan.request, file.sourceFileName, true)!;
  assert.notEqual(topicRequestFingerprint(plan.request), topicRequestFingerprint(request));
  const ready = { ...plan, status: 'ready' as const, request, issues: [], files: [{ ...file, status: 'add' as const }] };
  assert.equal(canStageTopicPlan(ready, request, true, false), true);
  assert.equal(canStageTopicPlan(ready, request, false, false), false);
  const changed = { ...request, keepDestinationDefinitions: { [file.sourceFileName]: { ...file.preservationOption!, targetHash: 'changed' } } };
  assert.equal(canStageTopicPlan(ready, changed, true, false), false);
  assert.equal(canStageTopicPlan(ready, plan.request, true, false), false);
});

test('only eligible view conflicts expose a preservation review and explicit inspection gate', () => {
  const plan = fixture();
  const eligible = renderToStaticMarkup(<TopicMigrationReview plan={plan} onKeepDestination={() => {}} />);
  assert.match(eligible, /Destination-preserving option available after reviewing this file/);
  assert.doesNotMatch(eligible, /Keep destination definitions and recheck|PRIVATE_DESTINATION|PRIVATE_SOURCE/);
  const issues = renderToStaticMarkup(<TopicMigrationIssues issues={plan.issues} plan={plan} request={plan.request} disabled={false} onChange={() => {}} />);
  assert.match(issues, /This view has an explicit option to keep destination definitions/);
  const propagated = { ...plan, files: [{ ...plan.files[0], preservationOption: undefined }] };
  assert.doesNotMatch(renderToStaticMarkup(<TopicMigrationReview plan={propagated} onKeepDestination={() => {}} />), /Destination-preserving option/);
  assert.doesNotMatch(renderToStaticMarkup(<TopicMigrationIssues issues={propagated.issues} plan={propagated} request={propagated.request} disabled={false} onChange={() => {}} />), /explicit option to keep destination/);
  const choice = renderToStaticMarkup(<TopicDestinationPreservationChoice fileName="destination/records.view" inspected={false} disabled={false} onChoose={() => {}} />);
  assert.match(choice, /Keep destination definitions; add only missing items/);
  assert.match(choice, /do not fill gaps inside an existing field/);
  assert.match(choice, /does not prove that the source and destination behave equivalently/);
  assert.equal((choice.match(/disabled=""/g) || []).length, 2);
});

test('retained versus added paths remain visible for unchanged files and export without raw definitions', () => {
  const plan = fixture(), file = plan.files[0];
  const request = chooseTopicDestinationDefinitions(plan, plan.request, file.sourceFileName, true)!;
  const preservation = { keptPaths: ['dimensions.id', 'table_name'], addedPaths: ['dimensions.new_field'], omittedSourcePaths: ['default_filters', 'dimensions.id.hidden'] };
  const result = { ...plan, request, status: 'unchanged' as const, issues: [], files: [{ ...file, status: 'reuse' as const, destinationPreservation: preservation }] };
  const html = renderToStaticMarkup(<TopicMigrationReview plan={result} />);
  for (const text of ['Destination retained', 'Retained from destination', 'Missing items added from source', 'dimensions.id', 'dimensions.new_field', 'Source properties not copied · 2', 'default_filters', 'dimensions.id.hidden', 'effect on business behavior', 'does not establish source equivalence']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /No changes match this filter|Review without this choice/);
  const report = topicMigrationReport(result, null);
  assert.deepEqual(report.files[0].destinationPreservation, preservation);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_DESTINATION|PRIVATE_SOURCE/);
});

test('wizard rechecks the exact changed choice, invalidates prior approval, and guards late responses', () => {
  const wizard = readFileSync(new URL('../src/components/modelMigration/TopicMigrationWizard.tsx', import.meta.url), 'utf8');
  assert.match(wizard, /next = reconcileTopicDestinationChoices\(request, next\)/);
  assert.match(wizard, /changeRequest\(next\);\s+await analyze\(next\)/);
  assert.match(wizard, /const cleanRequest = \{ \.\.\.reviewRequest, fileMappings: undefined/);
  assert.match(wizard, /setPlan\(null\); setApproved\(false\)/);
  assert.match(wizard, /if \(revision !== generation.current \|\| controller.signal.aborted\) return/);
  assert.match(wizard, /Remove choice and recheck/);
});

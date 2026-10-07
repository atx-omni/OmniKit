import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { TopicMigrationIssues } from '../src/components/modelMigration/TopicMigrationIssues';
import { ModelBranchOutcome } from '../src/components/modelMigration/ModelBranchOutcome';
import { TopicMigrationComparisonNotice, TopicMigrationReview, TopicMigrationScopeSummary } from '../src/components/modelMigration/TopicMigrationReview';
import type { BranchVerificationRecord, TopicMigrationPlan } from '../shared/topicMigration';
import type { MigrationJob } from '../src/services/opsConsole';
import { topicMigrationReport } from '../src/services/topicMigrationFlow';

const plan: TopicMigrationPlan = { version: 2, id: 'fixture-plan', revision: 'fixture-revision', status: 'ready', createdAt: 0, expiresAt: 100,
  request: { sourceInstanceId: 'source', sourceConnectionId: 'source-connection', sourceModelId: 'source-model', targetInstanceId: 'target', targetConnectionId: 'target-connection', targetModelId: 'target-model', topicIds: ['records.topic'], schemaMapText: '' },
  topics: [{ id: 'records.topic', name: 'Records', fileName: 'records.topic' }], dependencies: [], sourceHash: 'source', targetHash: 'target', files: [],
  issues: ['id', 'value'].map(field => ({ id: field, kind: 'sql', severity: 'review', title: `Review SQL: dimensions.${field}.sql`, message: 'Check syntax in Omni.', nextAction: 'Review in Omni.', fileName: 'records.view', topicIds: ['records.topic'] })),
};

test('fresh comparison explains current evidence separately from protected prior outcomes', () => {
  const fresh: TopicMigrationPlan = { ...plan, status: 'blocked', comparisonOnly: { ofPlanId: 'old-plan',
    priorRuns: [{ planId: 'old-plan', jobId: 'old-job', branchName: 'previous-review-branch' }] } };
  const html = renderToStaticMarkup(<TopicMigrationComparisonNotice plan={fresh} disabled={false} onOpenRun={() => {}} />);
  assert.match(html, /Fresh comparison — no new writes authorized/);
  assert.match(html, /current compatibility rules/); assert.match(html, /Open saved run/);
  assert.match(html, /previous-review-branch/); assert.match(html, /cannot create another branch/);
  assert.equal(topicMigrationReport(fresh, null).branch, null);
  assert.deepEqual(topicMigrationReport(fresh, null).comparisonOnly, fresh.comparisonOnly);
});

test('sql dialect review groups metadata-driven fixes and exports no raw SQL', () => {
  const reviewed: TopicMigrationPlan = { ...plan, sqlDialectPolicy: { version: 'column_identifiers_v1', sourceDialect: 'snowflake', targetDialect: 'databricks' },
    files: [{ sourceFileName: 'records.view', fileName: 'records.view', kind: 'view', topicIds: ['records.topic'], before: null,
      proposed: 'PRIVATE_RAW_YAML', status: 'create', sqlDialectReview: { corrections: [{ path: 'dimensions.id.sql', from: '"ID"', to: '`ID`' }],
        findings: [{ path: 'dimensions.total.sql', reason: 'unsupported_expression: Review this expression in Omni.' }] } }] };
  const html = renderToStaticMarkup(<TopicMigrationReview plan={reviewed} />);
  assert.match(html, /SQL compatibility/); assert.match(html, /snowflake.*databricks/);
  assert.match(html, /1 supported identifier fix included in the diff/);
  assert.match(html, /1 compatibility finding needs review/);
  assert.match(html, /not full SQL or query validation/);
  const report = topicMigrationReport(reviewed, null);
  assert.deepEqual(report.files[0].sqlCompatibility?.correctedFields, ['dimensions.id.sql']);
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /PRIVATE_RAW_YAML|`ID`/);
  assert.equal(report.sqlDialectPolicy?.targetDialect, 'databricks');
});

test('table-name review explains automatic case corrections without implying warehouse validation', () => {
  const corrected: TopicMigrationPlan = { ...plan, files: [{ sourceFileName: 'records.view', fileName: 'records.view', kind: 'view',
    topicIds: ['records.topic'], before: null, proposed: 'table_name: records\n', status: 'create',
    tableNameCorrection: { namespace: 'example.data', from: 'RECORDS', to: 'records' } }] };
  const html = renderToStaticMarkup(<TopicMigrationReview plan={corrected} />);
  assert.match(html, /1 table name matched to destination spelling/);
  assert.match(html, /example.data.*RECORDS/);
  assert.match(html, /SQL, columns, and query behavior still need validation in Omni/);
});

function branchJob(): MigrationJob {
  const branch = { modelId: 'target-model', targetModelId: 'target-model', branchId: 'fixture-branch', branchName: 'review-only' };
  return { id: 'job', sourceId: 'source', sourceLabel: 'Source', destinationIds: ['target'], documentIds: [], emptyFirst: false,
    replaceSameNamed: false, deleteSourceOnSuccess: false, postMigrationActions: [], createdAt: 0, status: 'running',
    details: { branchPreparation: { profile: 'branch_preparation_v1' }, topicMigration: { request: plan.request } },
    items: (['model_branch_create', 'model_yaml_write', 'model_branch_verify'] as const).map((kind, index) => ({
      id: kind, jobId: 'job', destinationId: 'target', destinationLabel: 'Target', targetModelId: 'target-model', kind,
      status: index === 0 ? 'succeeded' : index === 1 ? 'running' : 'pending', details: index === 0 ? branch : {},
    })) };
}

function recoveredBranchJob(): MigrationJob {
  const job = branchJob(); job.workflow = 'model'; job.status = 'partial'; job.endedAt = 200;
  const sourceHash = 'sha256:' + 'a'.repeat(64), mainHash = 'sha256:' + 'b'.repeat(64);
  job.details = { ...job.details, topicMigration: { request: plan.request, planId: plan.id, revision: plan.revision, sourceHash, targetHash: mainHash } };
  job.items[1] = { ...job.items[1], status: 'succeeded', details: { ...job.items[0].details } };
  job.items[2] = { ...job.items[2], status: 'failed', error: 'Original readback failure.' };
  job.items.push({ id: 'lease', jobId: job.id, destinationId: 'target', destinationLabel: 'Target', targetModelId: 'target-model', kind: 'destination_model_mutation', status: 'succeeded',
    details: { migrationDestinationModelMutation: true, migrationMutationState: 'resolved', migrationMutationOperation: 'model_job',
      migrationMutationDispatchItemId: job.items[1].id, migrationMutationDispatchItemKind: 'model_yaml_write', migrationMutationDispatchFingerprint: 'c'.repeat(64) } });
  const verification: BranchVerificationRecord = { version: 1, policy: 'topic_branch_readback_v1', requestId: '11111111-1111-4111-8111-111111111111',
    planId: plan.id, planRevision: plan.revision, jobId: job.id, targetInstanceId: 'target', modelId: 'target-model', branchId: 'fixture-branch', branchName: 'review-only',
    verifiedAt: 300, sourceHash, mainHash, jobEvidenceHash: 'sha256:' + 'c'.repeat(64), expectedHash: 'sha256:' + 'd'.repeat(64), actualHash: 'sha256:' + 'e'.repeat(64), verified: true,
    files: [{ sourceFileName: 'source/records.view', submittedFileName: 'source/records.view', destinationFileName: 'destination/records.view', classification: 'mapped_path_and_formatting' }], findings: [] };
  job.details!.branchVerifications = [verification];
  return job;
}

test('branch recovery review shows source to destination paths and the exact preparation pair without altering submitted names', () => {
  const sourceFileName = 'SOURCE.PUBLIC/records.view', destinationFileName = 'TARGET.PUBLIC/records.view';
  const current: TopicMigrationPlan = { ...plan, files: [{ sourceFileName, fileName: sourceFileName, destinationFileName,
    kind: 'view', topicIds: ['records.topic'], before: null, proposed: 'dimensions: {}', status: 'create' }] };
  const html = renderToStaticMarkup(<TopicMigrationReview plan={current} />);
  assert.match(html, /SOURCE.PUBLIC\/records.view.*→.*TARGET.PUBLIC\/records.view/);
  assert.equal(current.files[0].fileName, sourceFileName);
  const scope = renderToStaticMarkup(<TopicMigrationScopeSummary request={plan.request} sourceLabel="Source instance" targetLabel="Destination instance" />);
  for (const text of ['Source instance', 'Destination instance', 'source-connection', 'source-model', 'target-connection', 'target-model']) assert.ok(scope.includes(text));
  assert.match(scope, /Exact preparation scope/);
});

test('branch recovery displays a separate verified receipt without erasing failed steps or claiming publication', () => {
  const job = recoveredBranchJob();
  const html = renderToStaticMarkup(<ModelBranchOutcome job={job} bound streamError={false} destinationUrl="https://example.invalid" onVerify={() => {}} />);
  assert.match(html, /Files verified — ready to review in Omni/); assert.match(html, /Original preparation: 2\/3 steps completed/);
  assert.match(html, /Separate verification attempts.*1/); assert.match(html, /Original readback failure/); assert.match(html, /Run status.*partial/);
  assert.match(html, /not published or validated for warehouse queries/); assert.doesNotMatch(html, />Verify existing branch<|<button[^>]*>Publish/);
  for (const errors of [{ historyUnavailable: true, streamError: false }, { historyUnavailable: false, streamError: true }]) {
    const hidden = renderToStaticMarkup(<ModelBranchOutcome job={job} bound {...errors} onVerify={() => {}} />);
    assert.match(hidden, /historical verification records/); assert.doesNotMatch(hidden, /Files verified — ready|>Verify existing branch<|<progress/);
  }
  const unbound = renderToStaticMarkup(<ModelBranchOutcome job={job} bound={false} streamError={false} onVerify={() => {}} />);
  assert.doesNotMatch(unbound, /ready to review in Omni|Separate verification attempts|review-only|>Verify existing branch</);
});

test('branch recovery shows failed findings and the read-only action while disconnects require saved-run checks', () => {
  const job = recoveredBranchJob();
  const previous = (job.details!.branchVerifications as BranchVerificationRecord[])[0];
  job.details!.branchVerifications = [previous, { ...previous, verified: false, actualHash: null, files: [], findings: [{ code: 'branch_read_failed', fileName: 'records.view', message: 'The branch could not be read.' }] }];
  const html = renderToStaticMarkup(<ModelBranchOutcome job={job} bound streamError={false} onVerify={() => {}} />);
  assert.match(html, />Verify existing branch</); assert.match(html, /branch_read_failed/); assert.match(html, /The branch could not be read/);
  assert.match(html, /Separate verification attempts.*2/); assert.match(html, /Does not create a branch, rewrite files, retry failed writes/);
  assert.doesNotMatch(html, /Files verified — ready/);
  const wizard = readFileSync(new URL('../src/components/modelMigration/TopicMigrationWizard.tsx', import.meta.url), 'utf8');
  assert.match(wizard, /!verificationEligible \|\| busy \|\| writeInFlight.current \|\| historyUnavailable \|\| streamError/);
  assert.match(wizard, /if \(revision !== generation.current\) return;/);
  assert.match(wizard, /latestBranchVerification\(result.job\)\?\.requestId !== attempt.requestId/);
});

test('branch drift review separates matching copied files from source and destination review requirements', () => {
  const job = recoveredBranchJob();
  const original = (job.details!.branchVerifications as BranchVerificationRecord[])[0];
  job.details!.branchVerifications = [{ ...original, verified: false, findings: [
    { code: 'SOURCE_MODEL_CHANGED', message: 'The source snapshot changed after approval.' },
    { code: 'DESTINATION_FILE_CHANGED', fileName: 'existing.view', message: 'An existing destination definition changed after approval.' },
    { code: 'DESTINATION_CHECKSUM_CHANGED', fileName: 'existing.view', message: 'The destination checksum changed.' },
  ] }];
  const savedJob = structuredClone(job);
  const html = renderToStaticMarkup(<ModelBranchOutcome job={job} bound streamError={false} destinationUrl="https://example.invalid" onVerify={() => {}} />);
  assert.match(html, /Copied files match — overall review required/);
  assert.match(html, /Copied-file comparison: 1 matched · 0 mismatched/);
  assert.match(html, /The source changed since the original approval/);
  assert.match(html, /The destination model changed since the original approval/);
  assert.match(html, /Destination file changed.*existing.view/);
  assert.match(html, /original approval remains consumed/);
  assert.match(html, /Run status.*partial.*original preparation record/);
  assert.match(html, /do not rewrite this original status or prove deployment failed/);
  assert.match(html, />Verify existing branch</);
  assert.doesNotMatch(html, /Files verified — ready|approved file additions were read back|<button[^>]*>Publish/);
  assert.deepEqual(job, savedJob);
});

test('branch drift review hides legacy placeholder mismatches when authoritative branch bytes were not read', () => {
  const job = recoveredBranchJob();
  const original = (job.details!.branchVerifications as BranchVerificationRecord[])[0];
  job.details!.branchVerifications = [{ ...original, verified: false, actualHash: null,
    files: [{ ...original.files[0], destinationFileName: 'LEGACY_UNREAD_PLACEHOLDER.view', classification: 'mismatch' }],
    findings: [{ code: 'APPROVED_AUTHORITY_CHANGED', message: 'The approved authority changed; no branch read was performed.' }] }];
  const html = renderToStaticMarkup(<ModelBranchOutcome job={job} bound streamError={false} onVerify={() => {}} />);
  assert.match(html, /Branch comparison unavailable — review required/);
  assert.match(html, /Branch bytes were not read. No file match or mismatch is established/);
  assert.match(html, /Approved authority changed/);
  assert.match(html, /original approval remains consumed/);
  assert.doesNotMatch(html, /LEGACY_UNREAD_PLACEHOLDER|0 matched · 1 mismatched|Copied files match —|Files verified — ready/);
});

test('branch drift review reports real copied-file mismatches and never treats an empty comparison as success', () => {
  const job = recoveredBranchJob();
  const original = (job.details!.branchVerifications as BranchVerificationRecord[])[0];
  job.details!.branchVerifications = [{ ...original, verified: false,
    files: [...original.files, { sourceFileName: 'source/other.view', submittedFileName: 'source/other.view', destinationFileName: 'destination/other.view', classification: 'mismatch' }],
    findings: [{ code: 'DESTINATION_FILE_ADDED', fileName: 'independent.view', message: 'A destination file was added.' },
      { code: 'branch_file_mismatch', fileName: 'destination/other.view', message: 'A copied definition differs.' }] }];
  const html = renderToStaticMarkup(<ModelBranchOutcome job={job} bound streamError={false} />);
  assert.match(html, /Copied-file differences — review required/);
  assert.match(html, /1 matched · 1 mismatched/);
  assert.match(html, /destination\/other.view · mismatch/);
  assert.doesNotMatch(html, /Copied files match — overall review required|Files verified — ready/);
  job.details!.branchVerifications = [{ ...original, verified: false, files: [], findings: [] }];
  const empty = renderToStaticMarkup(<ModelBranchOutcome job={job} bound streamError={false} />);
  assert.match(empty, /Branch read — file comparison incomplete/);
  assert.match(empty, /A file match is not established/);
  assert.doesNotMatch(empty, /0 matched · 0 mismatched|Copied files match —|Files verified — ready/);
});

function reconciledJob(): MigrationJob {
  const job = branchJob(); job.workflow = 'model'; job.status = 'partial'; job.endedAt = 300;
  const audit = { requestId: '11111111-1111-4111-8111-111111111111', requestHash: 'a'.repeat(64), leaseItemId: 'lease',
    priorRevision: 3, resolvedRevision: 4, priorUpdatedAt: 300, destinationInstanceId: 'target', targetModelId: 'target-model',
    operation: 'model_job', dispatchItemId: 'model_yaml_write', dispatchItemKind: 'model_yaml_write', dispatchFingerprint: 'b'.repeat(64),
    outcome: 'verified_not_applied', evidenceSource: 'omni_ui', actor: 'local_unlocked_operator', adjudicatedAt: 400 };
  job.details = { ...job.details, topicMigration: { request: plan.request, planId: plan.id, revision: plan.revision }, migrationMutationAdjudications: [audit] };
  job.items[1] = { ...job.items[1], status: 'failed', endedAt: 290, details: { targetModelId: 'target-model', branchName: 'review-only' } };
  job.items[2].status = 'skipped';
  job.items.push({ id: 'lease', jobId: job.id, destinationId: 'target', destinationLabel: 'Target', targetModelId: 'target-model',
    kind: 'destination_model_mutation', status: 'succeeded', endedAt: 400, details: {
      migrationDestinationModelMutation: true, migrationMutationState: 'resolved', migrationMutationOperation: 'model_job',
      migrationMutationRevision: 4, migrationMutationUpdatedAt: 400, migrationMutationDispatchItemId: 'model_yaml_write',
      migrationMutationDispatchItemKind: 'model_yaml_write', migrationMutationDispatchedAt: 200, migrationMutationDispatchFingerprint: audit.dispatchFingerprint,
      migrationMutationResolutionKind: 'operator_adjudication', migrationMutationResolutionActor: audit.actor,
      migrationMutationResolutionRequestId: audit.requestId, migrationMutationResolutionRequestHash: audit.requestHash,
      migrationMutationResolutionOutcome: audit.outcome, migrationMutationResolutionEvidenceSource: audit.evidenceSource,
      migrationMutationResolutionConfirmedAt: 400, migrationMutationResolutionExpectedRevision: 3, migrationMutationResolutionExpectedUpdatedAt: 300,
    } });
  return job;
}

test('branch review collapses SQL findings, preserves detail, and has no correction editors', () => {
  const html = renderToStaticMarkup(<TopicMigrationIssues plan={plan} request={plan.request} issues={plan.issues} disabled={false} onChange={() => {}} />);
  assert.doesNotMatch(html, /<textarea|<details open|Hold affected topics/);
  assert.match(html, /dimensions.id.sql/); assert.match(html, /dimensions.value.sql/);
  assert.match(html, /2 findings/); assert.match(html, /does not block branch preparation/);
});

test('branch result never offers publication and uncertain branches stay explicitly partial', () => {
  const job = branchJob(); job.status = 'failed'; job.items[1].status = 'failed'; job.items[2].status = 'skipped';
  const html = renderToStaticMarkup(<ModelBranchOutcome job={job} bound streamError={false} destinationUrl="https://example.invalid" />);
  assert.match(html, /copied files unverified/); assert.match(html, /Open Omni/); assert.match(html, /not rollback/);
  assert.doesNotMatch(html, /<button[^>]*>Publish|href="javascript:/);
  const unsafe = renderToStaticMarkup(<ModelBranchOutcome job={job} bound streamError={false} destinationUrl="javascript:alert(1)" />);
  assert.doesNotMatch(unsafe, /<a /);
  const unbound = renderToStaticMarkup(<ModelBranchOutcome job={job} bound={false} streamError={false} destinationUrl="https://example.invalid" />);
  assert.match(unbound, /Historical run/);
  assert.doesNotMatch(unbound, /Review branch prepared|<a |review-only/);
});

test('history failure retains qualified creation evidence without promoting unverified files to a ready receipt', () => {
  const job = branchJob();
  job.items.unshift({ ...job.items[0], id: 'scope', kind: 'model_translate', status: 'succeeded' },
    { ...job.items[0], id: 'lease', kind: 'destination_model_mutation', status: 'running' });
  const html = renderToStaticMarkup(<ModelBranchOutcome job={job} bound streamError={false} historyUnavailable destinationUrl="https://example.invalid" />);
  assert.match(html, /Branch created — copied files unverified/);
  assert.match(html, /last received snapshot confirmed branch creation/i);
  assert.match(html, /Last received: 1\/3 steps completed/);
  assert.match(html, /Last received review branch/);
  assert.match(html, /Open Omni/);
  assert.match(html, /Inspect the recorded branch and confirm which files arrived/);
  assert.match(html, /destination model mutation/);
  assert.doesNotMatch(html, /<progress|Ready to review in Omni|Publish or request review|approved file additions were read back/);
  for (const bound of [true, false]) {
    const invalid = branchJob(); invalid.items[0].details = { ...invalid.items[0].details, branchId: undefined };
    const unqualified = renderToStaticMarkup(<ModelBranchOutcome job={invalid} bound={bound} streamError={false} historyUnavailable destinationUrl="https://example.invalid" />);
    assert.doesNotMatch(unqualified, /Branch created —|Last received review branch|<a /);
  }
});

test('history errors keep previously verified snapshots historical while current verified receipts enable the Omni handoff', () => {
  const job = branchJob(); job.status = 'succeeded';
  job.items.forEach(item => { item.status = 'succeeded'; });
  const receipt = { modelId: 'target-model', branchId: 'fixture-branch', branchName: 'review-only' };
  job.details = { ...job.details, branchReceipt: receipt }; job.items[2].details = receipt;
  const current = renderToStaticMarkup(<ModelBranchOutcome job={job} bound streamError={false} destinationUrl="https://example.invalid" />);
  assert.match(current, /Ready to review in Omni/);
  assert.match(current, /approved file additions were read back/);
  assert.match(current, /Publish or request review in Omni/);
  for (const errors of [{ historyUnavailable: true, streamError: false }, { historyUnavailable: false, streamError: true }]) {
    const historical = renderToStaticMarkup(<ModelBranchOutcome job={job} bound {...errors} destinationUrl="https://example.invalid" />);
    assert.match(historical, /historical evidence, not a verified current receipt/);
    assert.doesNotMatch(historical, /Ready to review in Omni|approved file additions were read back|Publish or request review|<progress/);
  }
});

test('reconciled non-write keeps the existing branch for inspection without a ready or publication claim', () => {
  const job = reconciledJob();
  const html = renderToStaticMarkup(<ModelBranchOutcome job={job} bound streamError={false} destinationUrl="https://example.invalid" />);
  assert.match(html, /Reconciled — files not applied/);
  assert.match(html, /File-copy reconciliation · files not applied/);
  assert.match(html, /review-only/); assert.match(html, /Open Omni/);
  assert.match(html, /fresh review and separate approval/);
  assert.match(html, /not a prepared-file receipt/);
  assert.doesNotMatch(html, /destination model mutation · succeeded|Ready to review in Omni|Publish or request review|approved file additions were read back/);
  for (const errors of [{ historyUnavailable: true, streamError: false }, { historyUnavailable: false, streamError: true }]) {
    const historical = renderToStaticMarkup(<ModelBranchOutcome job={job} bound {...errors} destinationUrl="https://example.invalid" />);
    assert.match(historical, /last received snapshot recorded/i);
    assert.match(historical, /historical evidence; the current branch state is unverified/);
    assert.match(historical, /Last received file-copy reconciliation/);
    assert.doesNotMatch(historical, /Reconciled — files not applied|<progress|fresh review and separate approval/);
  }
  const unbound = renderToStaticMarkup(<ModelBranchOutcome job={job} bound={false} streamError={false} destinationUrl="https://example.invalid" />);
  assert.doesNotMatch(unbound, /Reconciled —|File-copy reconciliation|review-only|<a /);
  job.items[3].details!.migrationMutationResolutionOutcome = 'verified_partial_terminal';
  const uncertain = renderToStaticMarkup(<ModelBranchOutcome job={job} bound streamError={false} />);
  assert.match(uncertain, /copied files unverified/);
  assert.doesNotMatch(uncertain, /Reconciled —|File-copy reconciliation/);
});

test('single page routes legacy advanced links to the new workflow and binds dashboard handoffs', () => {
  const page = readFileSync(new URL('../src/pages/ModelMigratorPage.tsx', import.meta.url), 'utf8');
  assert.match(page, /<Navigate replace/); assert.match(page, /dashboardHandoff=/);
  assert.doesNotMatch(page, /AdvancedModelMigratorPage|mergeModelMigratorJob/);
  const wizard = readFileSync(new URL('../src/components/modelMigration/TopicMigrationWizard.tsx', import.meta.url), 'utf8');
  assert.match(wizard, /prepareDashboardTopicMigration/); assert.match(wizard, /Create review branch/);
  assert.match(wizard, /initializationController\.current\?\.abort/);
  assert.match(wizard, /const isCurrent = \(\) => live && !controller.signal.aborted && revision === generation.current/);
  assert.match(wizard, /Submitted package — read-only review/);
  assert.doesNotMatch(wizard, /TopicPhysicalMappings|Publish validated|mergeModelMigratorJob|Stage and validate/);
});

test('history guard failure replaces stale running progress with an unverified outcome', () => {
  const job: MigrationJob = { id: 'job', sourceId: 'source', sourceLabel: 'Source', destinationIds: ['target'], documentIds: [], emptyFirst: false, replaceSameNamed: false, deleteSourceOnSuccess: false, postMigrationActions: [], createdAt: 0, status: 'running', items: [{ id: 'branch', jobId: 'job', destinationId: 'target', destinationLabel: 'Target', kind: 'model_branch_create', status: 'running' }] };
  const html = renderToStaticMarkup(<ModelBranchOutcome job={job} bound streamError={false} historyUnavailable />);
  assert.match(html, /Preparation blocked — history unavailable/);
  assert.match(html, /Last received: 0\/1/);
  assert.match(html, /not a verified current outcome/);
  assert.match(html, /do not repeat the migration/);
  assert.doesNotMatch(html, /Creating review branch|<progress|Review branch prepared/);
  const disconnected = renderToStaticMarkup(<ModelBranchOutcome job={job} bound streamError />);
  assert.match(disconnected, /Connection lost — outcome unverified/);
  assert.doesNotMatch(disconnected, /Creating review branch|<progress/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildMigrationInventory, webFocusManualEvidenceReview } from '../src/services/semanticMigration/adapters';
import type { SourceInventoryItem } from '../src/services/semanticMigration/studioApi';
import type { MigrationArtifact } from '../src/services/semanticMigration/types';
import {
  WEBFOCUS_DEVELOPMENT_CONTEXT_VERSION,
  WEBFOCUS_DEVELOPMENT_RULES,
  WEBFOCUS_DOCUMENTATION_REVIEWED_AT,
  WEBFOCUS_OFFICIAL_DOCUMENTATION,
  webFocusDevelopmentRule,
  webFocusOfficialDocumentation,
} from '../src/services/semanticMigration/webFocusDevelopmentContext';
import {
  WEBFOCUS_CLASSIFICATION_SCHEMA_VERSION,
  classifyWebFocusEvidence,
  mergeRequiredWebFocusDecisions,
  requiredWebFocusMigrationDecisions,
} from '../src/services/semanticMigration/webFocusDecisions';
import { buildManualSourceEvidence, sha256Text } from '../src/services/semanticMigration/sourceEvidence';

function artifact(name: string, content: string, parseWarnings: string[] = []): MigrationArtifact {
  const extension = name.split('.').pop()?.toLowerCase();
  return {
    id: `artifact:${name}`,
    sourceTool: 'webfocus',
    name,
    kind: extension === 'fex' ? 'dashboard' : extension === 'mas' || extension === 'acx' ? 'metadata' : 'text',
    content,
    sizeBytes: Buffer.byteLength(content),
    parseWarnings,
  };
}

function diagnosticCodes(result: ReturnType<typeof classifyWebFocusEvidence>) {
  return new Set(result.diagnostics.map((diagnostic) => diagnostic.code));
}

test('WebFOCUS development rules trace supported behavior only to official TIBCO documentation', () => {
  assert.equal(WEBFOCUS_DEVELOPMENT_CONTEXT_VERSION, 'omnikit.webfocus.development-context.v1');
  assert.equal(WEBFOCUS_DOCUMENTATION_REVIEWED_AT, '2026-08-05');
  assert.equal(new Set(WEBFOCUS_DEVELOPMENT_RULES.map((rule) => rule.sourceClass)).size, WEBFOCUS_DEVELOPMENT_RULES.length);
  assert.equal(new Set(WEBFOCUS_OFFICIAL_DOCUMENTATION.map((reference) => reference.id)).size, WEBFOCUS_OFFICIAL_DOCUMENTATION.length);
  assert.ok(WEBFOCUS_OFFICIAL_DOCUMENTATION.every((reference) => reference.url.startsWith('https://docs.tibco.com/')));
  assert.ok(WEBFOCUS_OFFICIAL_DOCUMENTATION.every((reference) => reference.behavioralClaims.length > 0));

  const knownDocumentation = new Set(WEBFOCUS_OFFICIAL_DOCUMENTATION.map((reference) => reference.id));
  WEBFOCUS_DEVELOPMENT_RULES.filter((rule) => rule.sourceClass !== 'unknown').forEach((rule) => {
    assert.ok(rule.documentationIds.length > 0, `${rule.sourceClass} must be traceable to official documentation.`);
    assert.ok(rule.documentationIds.every((id) => knownDocumentation.has(id)), `${rule.sourceClass} has an unregistered documentation reference.`);
    assert.deepEqual(webFocusDevelopmentRule(rule.sourceClass).documentationIds, rule.documentationIds);
    assert.equal(webFocusOfficialDocumentation(rule.documentationIds).length, rule.documentationIds.length);
  });
});

test('WebFOCUS manual evidence review classifies the complete upload and fails closed on incomplete evidence', () => {
  const metadata = artifact('SALES.mas', [
    'FILENAME=SALES, SUFFIX=SQL,',
    '  SEGMENT=SALES, SEGTYPE=S0,',
    '    FIELDNAME=ORDER_ID, ALIAS=ORDER_ID, USAGE=I11, ACTUAL=INTEGER,',
  ].join('\n'));
  const procedure = artifact('SALES_DASHBOARD.fex', [
    'TABLE FILE SALES',
    'PRINT ORDER_ID',
    'END',
  ].join('\n'));
  const artifacts = [metadata, procedure];
  const complete = webFocusManualEvidenceReview(artifacts, buildMigrationInventory('webfocus', artifacts));
  const completeInventory = buildMigrationInventory('webfocus', artifacts);

  assert.equal(complete.metadataArtifactCount, 1);
  assert.equal(complete.procedureArtifactCount, 1);
  assert.equal(complete.dashboardEvidenceCount, 1);
  assert.equal(complete.hasMetadataEvidence, true);
  assert.equal(complete.hasProcedureEvidence, true);
  assert.equal(complete.ready, true);
  assert.equal(complete.blockers.length, 0);
  assert.equal(complete.classificationResult.schemaVersion, WEBFOCUS_CLASSIFICATION_SCHEMA_VERSION);
  assert.equal(complete.classificationResult.dependencyEdges.some((edge) => (
    edge.kind === 'uses_master_file' && edge.status === 'resolved'
  )), true);
  assert.equal(completeInventory.sourceEvidence?.collection.complete, true);
  assert.equal(completeInventory.sourceEvidence?.dependencyClosure.status, 'complete');
  assert.equal(completeInventory.sourceEvidence?.dependencyClosure.resolvedCount, 1);
  assert.ok(completeInventory.sourceEvidence?.artifactFingerprints.every((fingerprint) => /^[a-f0-9]{64}$/.test(fingerprint.sha256 || '')));
  assert.ok(completeInventory.sourceEvidence?.documentationIds.every((url) => url.startsWith('https://docs.tibco.com/')));
  assert.deepEqual(completeInventory.sourceEvidence?.acquisition.selectedScopeIds, ['SALES', 'SALES_DASHBOARD.fex']);

  const metadataOnly = webFocusManualEvidenceReview([metadata], buildMigrationInventory('webfocus', [metadata]));
  assert.equal(metadataOnly.ready, false);
  assert.match(metadataOnly.blockers.join(' '), /\.fex report procedure/i);

  const missingDependencyProcedure = artifact('MISSING_DEPENDENCY.fex', [
    'TABLE FILE UNKNOWN_MASTER',
    'PRINT ORDER_ID',
    'END',
  ].join('\n'));
  const missingDependency = webFocusManualEvidenceReview(
    [missingDependencyProcedure],
    buildMigrationInventory('webfocus', [missingDependencyProcedure]),
  );
  const missingDependencyInventory = buildMigrationInventory('webfocus', [missingDependencyProcedure]);
  assert.equal(missingDependency.ready, false);
  assert.equal(missingDependency.classificationResult.dependencyEdges.some((edge) => edge.status === 'missing'), true);
  assert.match(missingDependency.blockers.join(' '), /dependency closure is incomplete/i);
  assert.equal(missingDependencyInventory.sourceEvidence?.collection.complete, false);
  assert.equal(missingDependencyInventory.sourceEvidence?.dependencyClosure.status, 'blocked');
  assert.equal(missingDependencyInventory.sourceEvidence?.dependencyClosure.missingCount, 1);

  const truncatedMetadata = artifact(
    'SALES.mas',
    metadata.content,
    ['Truncated SALES.mas to a bounded character limit.'],
  );
  const truncatedArtifacts = [truncatedMetadata, procedure];
  const truncated = webFocusManualEvidenceReview(
    truncatedArtifacts,
    buildMigrationInventory('webfocus', truncatedArtifacts),
  );
  const truncatedInventory = buildMigrationInventory('webfocus', truncatedArtifacts);
  assert.equal(truncated.ready, false);
  assert.equal(diagnosticCodes(truncated.classificationResult).has('WF_SOURCE_TRUNCATED'), true);
  assert.equal(truncatedInventory.sourceEvidence?.collection.complete, false);
  assert.equal(truncatedInventory.sourceEvidence?.collection.truncated, true);
  assert.equal(truncatedInventory.sourceEvidence?.dependencyClosure.status, 'blocked');
  assert.equal(truncatedInventory.sourceEvidence?.artifactFingerprints[0]?.sha256, undefined);
  assert.match(truncated.blockers.join(' '), /lacks a valid SHA-256/i);
});

test('manual SourceEvidence uses real deterministic fingerprints without claiming generic closure', () => {
  ['', 'abc', 'manual evidence ✓', 'a'.repeat(1_000)].forEach((value) => {
    assert.equal(sha256Text(value), createHash('sha256').update(value).digest('hex'));
  });
  const source = artifact('workbook.twb', '<workbook />');
  source.sourceTool = 'tableau';
  source.kind = 'xml';
  const evidence = buildManualSourceEvidence('tableau', [source]);

  assert.equal(evidence.artifactFingerprints[0]?.sha256, sha256Text(source.content));
  assert.match(evidence.acquisition.selectedScopeIds[0] || '', /^manual:workbook\.twb:[a-f0-9]{16}$/);
  assert.equal(evidence.collection.complete, false);
  assert.equal(evidence.dependencyClosure.status, 'not_evaluated');
  assert.ok(evidence.documentationIds.every((url) => url.startsWith('https://help.tableau.com/')));

  const truncatedEvidence = buildManualSourceEvidence('tableau', [{
    ...source,
    parseWarnings: ['Truncated workbook.twb at the local evidence limit.'],
  }], { collectionComplete: true });
  assert.equal(truncatedEvidence.collection.complete, false);
  assert.equal(truncatedEvidence.collection.truncated, true);
  assert.equal(truncatedEvidence.artifactFingerprints[0]?.sha256, undefined);
  assert.deepEqual(truncatedEvidence.acquisition.selectedScopeIds, ['manual:workbook.twb']);
  assert.match(truncatedEvidence.diagnostics.join(' '), /complete-file SHA-256 fingerprint is unavailable/i);
});

test('WebFOCUS field identities remain stable and segment-qualified when names repeat', () => {
  const metadata = artifact('QUALIFIED.mas', [
    'FILENAME=QUALIFIED, SUFFIX=SQL,',
    '  SEGMENT=ORDERS, SEGTYPE=S0,',
    '    FIELDNAME=ID, ALIAS=ORDER_ID, USAGE=I11, ACTUAL=INTEGER,',
    '  SEGMENT=LOCATIONS, SEGTYPE=S0,',
    '    FIELDNAME=ID, ALIAS=LOCATION_ID, USAGE=I11, ACTUAL=INTEGER,',
  ].join('\n'));
  const first = classifyWebFocusEvidence({ artifacts: [metadata] });
  const second = classifyWebFocusEvidence({ artifacts: [{ ...metadata, id: 'new-upload-id' }] });
  const fieldIds = (result: ReturnType<typeof classifyWebFocusEvidence>) => result.classifications
    .filter((classification) => classification.sourceClass === 'field')
    .map((classification) => classification.sourceIdentity.sourceId)
    .sort();

  assert.deepEqual(fieldIds(first), [
    'QUALIFIED::SEGMENT=LOCATIONS::FIELDNAME=ID',
    'QUALIFIED::SEGMENT=ORDERS::FIELDNAME=ID',
  ]);
  assert.deepEqual(fieldIds(first), fieldIds(second));
  assert.equal(new Set(fieldIds(first)).size, 2);
});

test('WebFOCUS classification preserves named source identity and builds selected procedure dependency closure', () => {
  const artifacts = [
    artifact('EXAMPLE_SALES.mas', [
      'FILENAME=EXAMPLE_SALES, SUFFIX=SQL,',
      '  SEGMENT=EXAMPLE_SALES, SEGTYPE=S0,',
      '    FIELDNAME=ORDER_ID, ALIAS=ORDER_ID, USAGE=A20, ACTUAL=A20,',
      '    FIELDNAME=REGION, ALIAS=REGION, USAGE=A12, ACTUAL=A12,',
      '    FIELDNAME=NET_VALUE, ALIAS=NET_VALUE, USAGE=D12.2, ACTUAL=DECIMAL,',
      '    DEFINE ADJUSTED_VALUE/D12.2 = NET_VALUE;',
    ].join('\n')),
    artifact('EXAMPLE_LOCATIONS.mas', [
      'FILENAME=EXAMPLE_LOCATIONS, SUFFIX=SQL,',
      '  SEGMENT=EXAMPLE_LOCATIONS, SEGTYPE=S0,',
      '    FIELDNAME=REGION, ALIAS=REGION, USAGE=A12, ACTUAL=A12,',
    ].join('\n')),
    artifact('UNRELATED.mas', [
      'FILENAME=UNRELATED, SUFFIX=SQL,',
      '  SEGMENT=UNRELATED, SEGTYPE=S0,',
      '    FIELDNAME=IGNORED_FIELD, ALIAS=IGNORED_FIELD, USAGE=A12, ACTUAL=A12,',
    ].join('\n')),
    artifact('shared_filters.fex', [
      'TABLE FILE EXAMPLE_SALES',
      'PRINT REGION',
      'END',
    ].join('\n')),
    artifact('example_report.fex', [
      "-DEFAULTH &REGION='ALL';",
      '-INCLUDE shared_filters',
      'JOIN REGION IN EXAMPLE_SALES TO UNIQUE REGION IN EXAMPLE_LOCATIONS AS J1',
      'TABLE FILE EXAMPLE_SALES',
      'SUM NET_VALUE',
      'BY REGION',
      "WHERE REGION EQ '&REGION'",
      'COMPUTE DISPLAY_VALUE/D12.2 = NET_VALUE;',
      'ON TABLE PCHOLD FORMAT HTML',
      'END',
    ].join('\n')),
  ];

  const result = classifyWebFocusEvidence({ artifacts });
  assert.equal(result.schemaVersion, WEBFOCUS_CLASSIFICATION_SCHEMA_VERSION);
  assert.equal(result.developmentContextVersion, WEBFOCUS_DEVELOPMENT_CONTEXT_VERSION);
  assert.equal(result.truncated, false);
  assert.equal(result.classifications.find((classification) => classification.sourceClass === 'master_file' && classification.sourceName === 'EXAMPLE_SALES')?.sourceIdentity.sourceId, 'EXAMPLE_SALES');
  assert.equal(result.classifications.find((classification) => classification.sourceClass === 'field' && classification.sourceName === 'NET_VALUE')?.sourceIdentity.kind, 'declared_name');
  assert.equal(result.classifications.find((classification) => classification.sourceClass === 'define')?.targetClassification, 'omni_view');
  assert.equal(result.classifications.find((classification) => classification.sourceClass === 'compute')?.targetClassification, 'dashboard_specification');
  assert.ok(result.classifications.every((classification) => Boolean(classification.sourceIdentity.sourceId)));
  assert.ok(result.classifications.filter((classification) => classification.sourceIdentity.kind === 'synthetic').every((classification) => Boolean(classification.sourceIdentity.syntheticReason)));
  assert.equal(result.dependencyEdges.filter((edge) => edge.kind === 'joins_master_file' && edge.status === 'resolved').length, 2);
  assert.equal(result.dependencyEdges.some((edge) => edge.kind === 'includes_procedure' && edge.status === 'resolved'), true);

  const codes = diagnosticCodes(result);
  assert.equal(codes.has('WF_MISSING_MASTER_FILE'), false);
  assert.equal(codes.has('WF_MISSING_INCLUDED_PROCEDURE'), false);
  assert.equal(codes.has('WF_EXPRESSION_TRANSLATION_REQUIRED'), true);
  assert.equal(codes.has('WF_PARAMETER_SEMANTICS_AMBIGUOUS'), true);
  assert.equal(codes.has('WF_JOIN_SEMANTICS_AMBIGUOUS'), true);
  assert.equal(codes.has('WF_PRESENTATION_UNSUPPORTED'), true);
  assert.equal(result.evidenceComplete, false);

  const decisions = requiredWebFocusMigrationDecisions(result, ['example_report.fex']);
  assert.ok(decisions.some((decision) => decision.sourceLabel === 'ADJUSTED_VALUE' && decision.action === 'rewrite'));
  assert.ok(decisions.some((decision) => decision.sourceLabel === 'NET_VALUE'));
  assert.ok(decisions.some((decision) => decision.sourceLabel === 'shared_filters'));
  assert.equal(decisions.some((decision) => decision.evidence.some((evidence) => evidence.sourceId.startsWith('UNRELATED'))), false);
  assert.ok(decisions.every((decision) => decision.blocking && decision.validationRequired && !decision.approvedByUser));
  assert.ok(decisions.every((decision) => decision.proposedCode === undefined));
  assert.ok(decisions.every((decision) => decision.evidence.every((evidence) => Boolean(evidence.sourceId) && Boolean(evidence.locator))));
});

test('WebFOCUS inventory keeps DEFINE in the reusable view and COMPUTE in request-scoped dashboard evidence', () => {
  const metadata = artifact('SALES.mas', [
    'FILENAME=SALES, SUFFIX=SQL,',
    '  SEGMENT=SALES, SEGTYPE=S0,',
    '    FIELDNAME=NET_VALUE, ALIAS=NET_VALUE, USAGE=D12.2, ACTUAL=DECIMAL,',
    '    DEFINE ADJUSTED_VALUE/D12.2 = NET_VALUE * 0.9;',
  ].join('\n'));
  const procedure = artifact('SALES_REPORT.fex', [
    '-* DASHBOARD: Sales performance',
    'TABLE FILE SALES',
    'SUM NET_VALUE',
    'COMPUTE DISPLAY_VALUE/D12.2 = NET_VALUE * 1.1;',
    'END',
  ].join('\n'));
  const inventory = buildMigrationInventory('webfocus', [metadata, procedure]);
  const view = inventory.views.find((candidate) => candidate.sourceId === 'SALES');
  const define = view?.fields.find((field) => field.name === 'ADJUSTED_VALUE');
  const dashboard = inventory.dashboards.find((candidate) => candidate.sourceId === 'SALES_REPORT.fex');

  assert.ok(view);
  assert.equal(view?.sourceLocator, 'SALES.mas');
  assert.equal(define?.sourceId, 'SALES::DEFINE=ADJUSTED_VALUE');
  assert.equal(define?.sourceLocator, 'SALES.mas:line:4');
  assert.equal(define?.annotations?.['webfocus.source_class'], 'DEFINE');
  assert.equal(define?.annotations?.['webfocus.scope'], 'master_file');
  assert.equal(define?.sql, 'NET_VALUE * 0.9;');
  assert.equal(view?.measures.some((measure) => measure.name === 'DISPLAY_VALUE'), false);
  assert.equal(inventory.metrics.some((measure) => measure.name === 'DISPLAY_VALUE'), false);
  assert.equal(dashboard?.name, 'Sales performance');
  assert.ok(dashboard?.fields.includes('DISPLAY_VALUE'));
  assert.ok(dashboard?.sourceEvidence?.some((evidence) => evidence.sourceId === 'SALES_REPORT.fex::COMPUTE=DISPLAY_VALUE'));
  assert.equal(inventory.sourceEvidence?.collection.complete, true);
  assert.equal(inventory.sourceEvidence?.dependencyClosure.status, 'complete');
  assert.ok(inventory.sourceEvidence?.documentationIds.some((url) => /cr_language\.pdf/.test(url)));
});

test('WebFOCUS source identities remain stable when upload session artifact IDs change', () => {
  const content = 'TABLE FILE SALES\nPRINT ORDER_ID\nEND';
  const first = artifact('pasted-source.fex', content);
  const second = { ...artifact('pasted-source.fex', content), id: 'another-upload-session-id' };
  const firstResult = classifyWebFocusEvidence({ artifacts: [first] });
  const secondResult = classifyWebFocusEvidence({ artifacts: [second] });
  const firstRoot = firstResult.classifications.find((classification) => classification.sourceClass === 'report_procedure');
  const secondRoot = secondResult.classifications.find((classification) => classification.sourceClass === 'report_procedure');

  assert.match(firstRoot?.sourceIdentity.sourceId || '', /^manual-evidence:[a-f0-9]{24}$/);
  assert.equal(firstRoot?.sourceIdentity.sourceId, secondRoot?.sourceIdentity.sourceId);
  assert.equal(firstRoot?.sourceIdentity.locator, 'pasted-source.fex');
  assert.equal(firstRoot?.sourceIdentity.kind, 'synthetic');
});

test('WebFOCUS dynamic dependencies, missing Master Files, and procedural logic remain explicit blockers', () => {
  const result = classifyWebFocusEvidence({
    artifacts: [artifact('dynamic_report.fex', [
      '-DEFAULTH &MODULE=shared_filters;',
      '-DEFAULTH &FLAG=Y;',
      '-INCLUDE &MODULE',
      "-IF &FLAG EQ 'Y' GOTO RUN_REPORT;",
      'TABLE FILE MISSING_MASTER',
      'PRINT VALUE',
      'END',
    ].join('\n'))],
  });
  const codes = diagnosticCodes(result);
  assert.equal(codes.has('WF_DYNAMIC_DEPENDENCY'), true);
  assert.equal(codes.has('WF_PROCEDURAL_LOGIC_UNSUPPORTED'), true);
  assert.equal(codes.has('WF_MISSING_MASTER_FILE'), true);
  assert.equal(codes.has('WF_PARAMETER_SEMANTICS_AMBIGUOUS'), true);
  assert.equal(result.dependencyEdges.some((edge) => edge.kind === 'includes_procedure' && edge.status === 'dynamic'), true);
  assert.equal(result.dependencyEdges.some((edge) => edge.kind === 'uses_master_file' && edge.status === 'missing'), true);
  assert.equal(result.evidenceComplete, false);

  const required = requiredWebFocusMigrationDecisions(result, ['dynamic_report.fex']);
  const reportDecision = required.find((decision) => decision.sourceLabel === 'dynamic_report')!;
  const providerProposal = [{
    ...reportDecision,
    id: 'provider-report-decision',
    action: 'map_existing' as const,
    targetId: 'existing-report',
    approvedByUser: true,
  }];
  const merged = mergeRequiredWebFocusDecisions(providerProposal, required);
  assert.ok(merged.length >= required.length);
  assert.equal(merged.find((decision) => decision.nodeId === reportDecision.nodeId)?.approvedByUser, false);
  assert.ok(merged.some((decision) => decision.sourceLabel === '&MODULE' && decision.action === 'defer'));
  assert.ok(merged.some((decision) => decision.sourceLabel === 'MISSING_MASTER' && decision.action === 'defer'));
  assert.ok(merged.every((decision) => decision.blocking && decision.validationRequired));
});

test('WebFOCUS repository inventory preserves native IDs and exposes content, schedule, security, and truncation gaps', () => {
  const repositoryItems: SourceInventoryItem[] = [
    {
      id: 'repository-handle-123',
      name: 'Example Report.fex',
      kind: 'repository_item',
      path: 'IBFS:/WFC/Repository/Examples/Example Report.fex',
      dependencyIds: [],
      featureFlags: [],
      riskFlags: [],
      metadata: { type: 'FexFile' },
    },
    {
      id: 'schedule-456',
      name: 'Example Delivery',
      kind: 'repository_item',
      path: 'IBFS:/WFC/Repository/Examples/Example Delivery',
      dependencyIds: ['repository-handle-123'],
      featureFlags: [],
      riskFlags: ['Access list requires review'],
      metadata: { type: 'ReportCaster Schedule', permission: 'repository policy present' },
    },
    {
      id: 'repository_item-3',
      name: 'Positionally Identified Item',
      kind: 'repository_item',
      dependencyIds: [],
      featureFlags: [],
      riskFlags: [],
      metadata: { syntheticId: true },
    },
  ];

  const result = classifyWebFocusEvidence({ repositoryItems, repositoryTruncated: true });
  const first = result.classifications.find((classification) => classification.sourceName === 'Example Report.fex' && classification.sourceClass === 'repository_item');
  assert.equal(first?.sourceIdentity.sourceId, 'repository-handle-123');
  assert.equal(first?.sourceIdentity.kind, 'repository_path');
  assert.ok(result.classifications.some((classification) => classification.sourceClass === 'schedule'));
  assert.ok(result.classifications.some((classification) => classification.sourceClass === 'security'));
  assert.equal(result.classifications.find((classification) => classification.sourceName === 'Positionally Identified Item')?.sourceIdentity.kind, 'synthetic');

  const codes = diagnosticCodes(result);
  assert.equal(codes.has('WF_REPOSITORY_CONTENT_REQUIRED'), true);
  assert.equal(codes.has('WF_SCHEDULE_HANDOFF_REQUIRED'), true);
  assert.equal(codes.has('WF_SECURITY_HANDOFF_REQUIRED'), true);
  assert.equal(codes.has('WF_SYNTHETIC_SOURCE_ID'), true);
  assert.equal(codes.has('WF_CLASSIFICATION_TRUNCATED'), true);
  assert.equal(result.evidenceComplete, false);
  assert.equal(result.truncated, true);
});

test('WebFOCUS upload truncation and unrecognized artifacts cannot advance silently', () => {
  const result = classifyWebFocusEvidence({
    artifacts: [artifact('unrecognized.txt', 'opaque export content', ['Truncated unrecognized.txt to a bounded character limit.'])],
  });
  const codes = diagnosticCodes(result);
  assert.equal(codes.has('WF_SOURCE_TRUNCATED'), true);
  assert.equal(codes.has('WF_UNSUPPORTED_ARTIFACT'), true);
  assert.equal(result.evidenceComplete, false);
  assert.equal(requiredWebFocusMigrationDecisions(result).every((decision) => decision.action === 'defer'), true);
});

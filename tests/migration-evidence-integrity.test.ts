import assert from 'node:assert/strict';
import test from 'node:test';
import { assessMigrationEvidenceIntegrity } from '../src/services/semanticMigration/evidenceIntegrity';
import { migrationSourceDocumentation } from '../src/services/semanticMigration/sourceDocumentation';
import type { CanonicalSemanticModel, MigrationDecision } from '../src/services/semanticMigration/types';

const receiptHash = 'a'.repeat(64);
const verificationReceipts = ['fixture', 'conformance', 'source_target_comparison', 'live_acceptance'].map((kind) => ({
  id: `verification:${kind}`,
  kind: kind as 'fixture' | 'conformance' | 'source_target_comparison' | 'live_acceptance',
  status: 'passed' as const,
  completedAt: '2026-08-05T00:00:00.000Z',
  artifactSha256: receiptHash,
  evidenceIds: [`evidence:${kind}`],
}));
const reviewReceipts = ['architecture', 'security', 'qa'].map((kind) => ({
  id: `review:${kind}`,
  kind: kind as 'architecture' | 'security' | 'qa',
  status: 'passed' as const,
  reviewedAt: '2026-08-05T00:00:00.000Z',
  reviewer: `independent-${kind}-reviewer`,
  independent: true,
  artifactSha256: receiptHash,
}));
const sourceEvidence = {
  schemaVersion: 'omnikit.source-evidence.v2' as const,
  sourceTool: 'tableau' as const,
  parser: { name: 'tableau deterministic extractor', version: '1', rulebookVersion: '1', rulebookSha256: receiptHash },
  acquisition: { mode: 'manual' as const, runId: 'run-1', selectedScopeIds: ['workbook-1'] },
  collection: { expectedArtifactCount: 1, observedArtifactCount: 1, complete: true, truncated: false, permissionGaps: [] },
  dependencyClosure: { status: 'complete' as const, resolvedCount: 1, missingCount: 0, reviewCount: 0 },
  artifactFingerprints: [{ name: 'workbook.twb', sha256: receiptHash, sizeBytes: 1024 }],
  documentationIds: migrationSourceDocumentation('tableau').map((reference) => reference.url),
  diagnostics: [],
};

const model: CanonicalSemanticModel = {
  schemaVersion: '1.0',
  sourcePlatform: 'tableau',
  generatedAt: '2026-08-05T00:00:00.000Z',
  warnings: [],
  nodes: [{
    id: 'measure:sales',
    kind: 'measure',
    name: 'Sales',
    expression: 'SUM([Sales])',
    dependencies: [],
    evidence: [{ sourceId: 'tableau:field:sales', artifactId: 'workbook.twb', role: 'direct' }],
    metadata: {},
  }],
};

const decision: MigrationDecision = {
  id: 'decision-sales',
  nodeId: 'measure:sales',
  domain: 'measure',
  sourceLabel: 'Sales',
  action: 'create_new',
  targetFileName: 'sales.view',
  proposedCode: 'measures:\n  sales:\n    sql: SUM(${sales})',
  rationale: 'Source-backed measure.',
  confidence: 0.95,
  evidence: [{ sourceId: 'tableau:field:sales', artifactId: 'workbook.twb', role: 'direct' }],
  blocking: true,
  impactAssetIds: ['dashboard:executive'],
  validationRequired: true,
  approvedByUser: true,
};

const coverageRows = ['semantic_objects', 'dashboards', 'filters', 'layout', 'permissions', 'schedules'].map((id) => ({
  id: id as 'semantic_objects' | 'dashboards' | 'filters' | 'layout' | 'permissions' | 'schedules',
  label: id,
  status: id === 'permissions' || id === 'schedules' ? 'unsupported' as const : 'partial' as const,
  evidenceClasses: ['source evidence'],
  requiresAcknowledgement: true,
}));

test('browser evidence receipts remain informational until a server attests the controlled-live gate', () => {
  const result = assessMigrationEvidenceIntegrity({
    source: 'tableau',
    sourceEvidence,
    documentation: migrationSourceDocumentation('tableau'),
    canonicalModel: model,
    decisions: [decision],
    coverageRows,
    parserMode: 'deterministic',
    inventoryTruncated: false,
    unsupportedBehaviorAcknowledged: true,
    verificationReceipts,
    reviewReceipts,
  });
  assert.equal(result.score, 100);
  assert.equal(result.readyForControlledTesting, false);
  assert.equal(result.band, 'implementation_review');
  assert.deepEqual(result.workflowBlockers, []);
  assert.ok(result.externalValidationBlockers.some((blocker) => blocker.includes('server-issued evidence attestation')));
});

test('high component scores cannot override ungrounded or unapproved generated code', () => {
  const result = assessMigrationEvidenceIntegrity({
    source: 'tableau',
    sourceEvidence,
    documentation: migrationSourceDocumentation('tableau'),
    canonicalModel: { ...model, nodes: [{ ...model.nodes[0]!, evidence: [] }] },
    decisions: [{ ...decision, evidence: [], approvedByUser: false }],
    coverageRows,
    parserMode: 'deterministic',
    inventoryTruncated: false,
    unsupportedBehaviorAcknowledged: true,
    verificationReceipts,
    reviewReceipts,
  });
  assert.equal(result.readyForControlledTesting, false);
  assert.equal(result.band, 'incomplete');
  assert.equal(result.metrics.ungroundedWriteCount, 1);
  assert.ok(result.blockers.some((blocker) => blocker.includes('lack source evidence')));
  assert.ok(result.blockers.some((blocker) => blocker.includes('explicit user approval')));
});

test('AI-only parsing and truncated inventory are automatic blockers', () => {
  const result = assessMigrationEvidenceIntegrity({
    source: 'webfocus',
    sourceEvidence: { ...sourceEvidence, sourceTool: 'webfocus', collection: { ...sourceEvidence.collection, complete: false, truncated: true }, dependencyClosure: { ...sourceEvidence.dependencyClosure, status: 'blocked' } },
    documentation: migrationSourceDocumentation('webfocus'),
    canonicalModel: model,
    decisions: [],
    coverageRows,
    parserMode: 'ai_only',
    inventoryTruncated: true,
    unsupportedBehaviorAcknowledged: false,
    verificationReceipts: verificationReceipts.filter((receipt) => receipt.kind === 'fixture'),
    reviewReceipts: [],
  });
  assert.equal(result.readyForControlledTesting, false);
  assert.ok(result.blockers.some((blocker) => blocker.includes('AI-only')));
  assert.ok(result.blockers.some((blocker) => blocker.includes('truncated')));
  assert.ok(result.notices.some((notice) => notice.includes('Live acceptance')));
});

test('acknowledged manual evidence gaps can stage on a dev branch but remain release-readiness blockers', () => {
  const incompleteManualEvidence = {
    ...sourceEvidence,
    sourceTool: 'domo' as const,
    collection: { ...sourceEvidence.collection, complete: false },
    dependencyClosure: { ...sourceEvidence.dependencyClosure, status: 'partial' as const, reviewCount: 2 },
    documentationIds: migrationSourceDocumentation('domo').map((reference) => reference.url),
  };
  const result = assessMigrationEvidenceIntegrity({
    source: 'domo',
    sourceEvidence: incompleteManualEvidence,
    documentation: migrationSourceDocumentation('domo'),
    canonicalModel: { ...model, sourcePlatform: 'domo' },
    decisions: [],
    coverageRows,
    parserMode: 'deterministic',
    inventoryTruncated: false,
    unsupportedBehaviorAcknowledged: true,
    evidenceLimitationsAcknowledged: true,
    verificationReceipts: [],
    reviewReceipts: [],
  });

  assert.deepEqual(result.analysisBlockers, []);
  assert.deepEqual(result.workflowBlockers, []);
  assert.ok(result.acquisitionBlockers.includes('Source acquisition completeness has not been proven.'));
  assert.ok(result.acquisitionBlockers.includes('Source dependency closure is incomplete.'));
  assert.ok(result.blockers.includes('Source acquisition completeness has not been proven.'));
  assert.ok(result.blockers.includes('Source dependency closure is incomplete.'));
  assert.equal(result.readyForControlledTesting, false);
  assert.equal(result.band, 'incomplete');
});

test('unacknowledged manual evidence gaps still block analysis', () => {
  const result = assessMigrationEvidenceIntegrity({
    source: 'domo',
    sourceEvidence: {
      ...sourceEvidence,
      sourceTool: 'domo',
      collection: { ...sourceEvidence.collection, complete: false },
      dependencyClosure: { ...sourceEvidence.dependencyClosure, status: 'partial' },
      documentationIds: migrationSourceDocumentation('domo').map((reference) => reference.url),
    },
    documentation: migrationSourceDocumentation('domo'),
    canonicalModel: { ...model, sourcePlatform: 'domo' },
    decisions: [],
    coverageRows,
    parserMode: 'deterministic',
    inventoryTruncated: false,
    unsupportedBehaviorAcknowledged: true,
    evidenceLimitationsAcknowledged: false,
    verificationReceipts: [],
    reviewReceipts: [],
  });

  assert.ok(result.analysisBlockers.includes('Source acquisition completeness has not been proven.'));
  assert.ok(result.analysisBlockers.includes('Source dependency closure is incomplete.'));
});

test('manual evidence acknowledgement cannot waive API acquisition gaps', () => {
  const result = assessMigrationEvidenceIntegrity({
    source: 'domo',
    sourceEvidence: {
      ...sourceEvidence,
      sourceTool: 'domo',
      acquisition: { ...sourceEvidence.acquisition, mode: 'api' },
      collection: { ...sourceEvidence.collection, complete: false },
      dependencyClosure: { ...sourceEvidence.dependencyClosure, status: 'partial' },
      documentationIds: migrationSourceDocumentation('domo').map((reference) => reference.url),
    },
    documentation: migrationSourceDocumentation('domo'),
    canonicalModel: { ...model, sourcePlatform: 'domo' },
    decisions: [],
    coverageRows,
    parserMode: 'deterministic',
    inventoryTruncated: false,
    unsupportedBehaviorAcknowledged: true,
    evidenceLimitationsAcknowledged: true,
    verificationReceipts: [],
    reviewReceipts: [],
  });

  assert.ok(result.workflowBlockers.includes('Source acquisition completeness has not been proven.'));
  assert.ok(result.workflowBlockers.includes('Source dependency closure is incomplete.'));
});

test('Domo acknowledgement cannot waive another source or truncated evidence', () => {
  const otherSource = assessMigrationEvidenceIntegrity({
    source: 'tableau',
    sourceEvidence: {
      ...sourceEvidence,
      collection: { ...sourceEvidence.collection, complete: false },
      dependencyClosure: { ...sourceEvidence.dependencyClosure, status: 'partial' },
    },
    documentation: migrationSourceDocumentation('tableau'),
    canonicalModel: model,
    decisions: [],
    coverageRows,
    parserMode: 'deterministic',
    inventoryTruncated: false,
    unsupportedBehaviorAcknowledged: true,
    evidenceLimitationsAcknowledged: true,
    verificationReceipts: [],
    reviewReceipts: [],
  });
  assert.ok(otherSource.workflowBlockers.includes('Source acquisition completeness has not been proven.'));

  const truncatedDomo = assessMigrationEvidenceIntegrity({
    source: 'domo',
    sourceEvidence: {
      ...sourceEvidence,
      sourceTool: 'domo',
      collection: { ...sourceEvidence.collection, complete: false, truncated: true },
      dependencyClosure: { ...sourceEvidence.dependencyClosure, status: 'blocked' },
      documentationIds: migrationSourceDocumentation('domo').map((reference) => reference.url),
    },
    documentation: migrationSourceDocumentation('domo'),
    canonicalModel: { ...model, sourcePlatform: 'domo' },
    decisions: [],
    coverageRows,
    parserMode: 'deterministic',
    inventoryTruncated: true,
    unsupportedBehaviorAcknowledged: true,
    evidenceLimitationsAcknowledged: true,
    verificationReceipts: [],
    reviewReceipts: [],
  });
  assert.ok(truncatedDomo.workflowBlockers.includes('Source acquisition completeness has not been proven.'));
  assert.ok(truncatedDomo.workflowBlockers.includes('Source dependency closure is incomplete.'));
  assert.ok(truncatedDomo.workflowBlockers.includes('The required source inventory is truncated.'));
});

test('documentation points reject unregistered links even when they use HTTPS', () => {
  const result = assessMigrationEvidenceIntegrity({
    source: 'tableau',
    sourceEvidence,
    documentation: [{
      title: 'Unverified migration advice',
      url: 'https://example.com/tableau-migration',
      authority: 'Claimed official source',
      artifactClasses: ['workbook'],
      reviewedAt: '2026-08-05',
    }],
    canonicalModel: model,
    decisions: [decision],
    coverageRows,
    parserMode: 'deterministic',
    inventoryTruncated: false,
    unsupportedBehaviorAcknowledged: true,
    verificationReceipts,
    reviewReceipts,
  });
  assert.equal(result.components.documentationTraceability, 0);
  assert.ok(result.blockers.some((blocker) => blocker.includes('official documentation')));
});

test('registered documentation does not count unless the source evidence cites it and covers emitted object kinds', () => {
  const uncited = assessMigrationEvidenceIntegrity({
    source: 'tableau',
    sourceEvidence: { ...sourceEvidence, documentationIds: [] },
    documentation: migrationSourceDocumentation('tableau'),
    canonicalModel: model,
    decisions: [decision],
    coverageRows,
    parserMode: 'deterministic',
    inventoryTruncated: false,
    unsupportedBehaviorAcknowledged: true,
    verificationReceipts,
    reviewReceipts,
  });
  assert.equal(uncited.components.documentationTraceability, 0);
  assert.ok(uncited.blockers.some((blocker) => blocker.includes('does not cite')));

  const undocumentedKind = assessMigrationEvidenceIntegrity({
    source: 'tableau',
    sourceEvidence,
    documentation: migrationSourceDocumentation('tableau'),
    canonicalModel: { ...model, nodes: [{ ...model.nodes[0]!, id: 'permission:sales', kind: 'permission' }] },
    decisions: [],
    coverageRows,
    parserMode: 'deterministic',
    inventoryTruncated: false,
    unsupportedBehaviorAcknowledged: true,
    verificationReceipts,
    reviewReceipts,
  });
  assert.equal(undocumentedKind.metrics.documentedNodeKindCount, 0);
  assert.ok(undocumentedKind.blockers.some((blocker) => blocker.includes('canonical kinds: permission')));
});

test('claimed passes without attributable receipt evidence do not count', () => {
  const result = assessMigrationEvidenceIntegrity({
    source: 'tableau',
    sourceEvidence,
    documentation: migrationSourceDocumentation('tableau'),
    canonicalModel: model,
    decisions: [decision],
    coverageRows,
    parserMode: 'deterministic',
    inventoryTruncated: false,
    unsupportedBehaviorAcknowledged: true,
    verificationReceipts: verificationReceipts.map((receipt) => ({ ...receipt, artifactSha256: '' })),
    reviewReceipts: reviewReceipts.map((receipt) => ({ ...receipt, independent: false })),
  });
  assert.equal(result.components.verification, 0);
  assert.equal(result.components.independentReview, 0);
  assert.equal(result.readyForControlledTesting, false);
});

test('official documentation registry uses reviewed HTTPS authorities for every BI source', () => {
  for (const source of ['domo', 'looker', 'metabase', 'microstrategy', 'power_bi', 'sigma', 'tableau', 'webfocus'] as const) {
    const references = migrationSourceDocumentation(source);
    assert.ok(references.length > 0, `${source} should have an official reference`);
    for (const reference of references) {
      assert.equal(new URL(reference.url).protocol, 'https:');
      assert.ok(reference.authority.length > 0);
      assert.match(reference.reviewedAt, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(reference.artifactClasses.length > 0);
    }
  }
});

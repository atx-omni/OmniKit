import type { MigrationCapabilityCoverageRow } from './capabilityCoverage';
import type { CanonicalSemanticModel, MigrationBiSourceTool, MigrationDecision, MigrationSourceEvidenceContract } from './types';
import { migrationSourceDocumentation, type MigrationSourceDocumentationReference } from './sourceDocumentation';

export type MigrationParserMode = 'deterministic' | 'hybrid' | 'ai_only';

export type MigrationVerificationKind = 'fixture' | 'conformance' | 'source_target_comparison' | 'live_acceptance';
export type MigrationReviewKind = 'architecture' | 'security' | 'qa';

export interface MigrationEvidenceReceipt {
  id: string;
  kind: MigrationVerificationKind;
  status: 'passed' | 'failed';
  completedAt: string;
  artifactSha256: string;
  evidenceIds: string[];
}

export interface MigrationReviewReceipt {
  id: string;
  kind: MigrationReviewKind;
  status: 'passed' | 'failed';
  reviewedAt: string;
  reviewer: string;
  independent: boolean;
  artifactSha256: string;
}

export interface MigrationEvidenceIntegrityInput {
  source: MigrationBiSourceTool;
  sourceEvidence?: MigrationSourceEvidenceContract;
  documentation: MigrationSourceDocumentationReference[];
  canonicalModel: CanonicalSemanticModel;
  decisions: MigrationDecision[];
  coverageRows: MigrationCapabilityCoverageRow[];
  parserMode: MigrationParserMode;
  inventoryTruncated: boolean;
  unsupportedBehaviorAcknowledged: boolean;
  evidenceLimitationsAcknowledged?: boolean;
  verificationReceipts: MigrationEvidenceReceipt[];
  reviewReceipts: MigrationReviewReceipt[];
}

export interface MigrationEvidenceIntegrityAssessment {
  score: number;
  band: 'controlled_live_candidate' | 'implementation_review' | 'incomplete';
  readyForControlledTesting: boolean;
  components: {
    documentationTraceability: number;
    deterministicEvidence: number;
    unsupportedBehaviorTransparency: number;
    verification: number;
    independentReview: number;
  };
  blockers: string[];
  analysisBlockers: string[];
  acquisitionBlockers: string[];
  writeBlockers: string[];
  workflowBlockers: string[];
  externalValidationBlockers: string[];
  notices: string[];
  metrics: {
    nodeCount: number;
    evidencedNodeCount: number;
    directEvidenceNodeCount: number;
    proposedWriteCount: number;
    ungroundedWriteCount: number;
    unsupportedCoverageCount: number;
    requiredDocumentationKindCount: number;
    documentedNodeKindCount: number;
  };
}

function bounded(value: number, max: number): number {
  return Math.max(0, Math.min(max, Math.round(value)));
}

function uniqueOfficialDocumentation(source: MigrationBiSourceTool, references: MigrationSourceDocumentationReference[]): MigrationSourceDocumentationReference[] {
  const registeredUrls = new Set(migrationSourceDocumentation(source).map((reference) => reference.url));
  const seen = new Set<string>();
  return references.filter((reference) => {
    let parsed: URL;
    try {
      parsed = new URL(reference.url);
    } catch {
      return false;
    }
    if (parsed.protocol !== 'https:'
      || !registeredUrls.has(parsed.toString())
      || !reference.authority.trim()
      || reference.artifactClasses.length === 0) return false;
    const key = parsed.toString();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const DOCUMENTATION_KIND_TERMS: Record<CanonicalSemanticModel['nodes'][number]['kind'], string[]> = {
  workspace: ['workspace', 'project'],
  project: ['project', 'workspace'],
  model: ['model', 'semantic'],
  view: ['view', 'table', 'dataset', 'data source'],
  field: ['field', 'column', 'attribute', 'dimension'],
  measure: ['measure', 'metric', 'calculation', 'calculated field'],
  relationship: ['relationship', 'join', 'lineage'],
  topic: ['topic', 'explore', 'model'],
  data_source: ['data source', 'datasource', 'dataset', 'table'],
  dataset: ['dataset', 'data source', 'datasource', 'table'],
  report: ['report', 'dashboard', 'content'],
  dashboard: ['dashboard', 'report', 'page', 'content'],
  workbook: ['workbook', 'dashboard', 'content'],
  page: ['page', 'dashboard', 'content'],
  tile: ['tile', 'visual', 'card', 'dashboard'],
  visual: ['visual', 'chart', 'card', 'dashboard'],
  card: ['card', 'visual', 'dashboard'],
  cube: ['cube', 'dataset', 'model'],
  metric: ['metric', 'measure', 'calculation'],
  attribute: ['attribute', 'dimension', 'field'],
  calculation: ['calculation', 'calculated field', 'measure', 'metric'],
  filter: ['filter', 'parameter'],
  permission: ['permission', 'access', 'security', 'governance'],
  schedule: ['schedule', 'subscription', 'delivery'],
  transformation: ['transformation', 'dataflow', 'sql', 'derived table', 'pdt'],
  materialization: ['materialization', 'derived table', 'pdt', 'dataflow'],
  automation: ['automation', 'workflow', 'operation'],
  policy: ['policy', 'permission', 'access', 'security', 'governance'],
  output: ['output', 'dashboard', 'report', 'card', 'content'],
};

function documentedNodeKinds(
  model: CanonicalSemanticModel,
  references: MigrationSourceDocumentationReference[],
): Set<CanonicalSemanticModel['nodes'][number]['kind']> {
  const documentedTerms = references.flatMap((reference) => reference.artifactClasses)
    .map((artifactClass) => artifactClass.trim().toLowerCase());
  return new Set(model.nodes.flatMap((node) => {
    const terms = DOCUMENTATION_KIND_TERMS[node.kind];
    return terms.some((term) => documentedTerms.some((documented) => documented.includes(term) || term.includes(documented)))
      ? [node.kind]
      : [];
  }));
}

function isWriteDecision(decision: MigrationDecision): boolean {
  return ['create_new', 'rewrite'].includes(decision.action) && Boolean(decision.proposedCode?.trim());
}

function decisionHasEvidence(decision: MigrationDecision, model: CanonicalSemanticModel): boolean {
  if (decision.evidence.length > 0) return true;
  const sourceNode = model.nodes.find((node) => node.id === decision.nodeId);
  return Boolean(sourceNode?.evidence.length);
}

function validHash(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

function validTimestamp(value: string): boolean {
  return Boolean(value) && Number.isFinite(Date.parse(value));
}

function passedVerificationKinds(receipts: MigrationEvidenceReceipt[]): Set<MigrationVerificationKind> {
  return new Set(receipts.filter((receipt) => (
    receipt.status === 'passed'
      && Boolean(receipt.id.trim())
      && validTimestamp(receipt.completedAt)
      && validHash(receipt.artifactSha256)
      && receipt.evidenceIds.some((id) => Boolean(id.trim()))
  )).map((receipt) => receipt.kind));
}

function passedReviewKinds(receipts: MigrationReviewReceipt[]): Set<MigrationReviewKind> {
  return new Set(receipts.filter((receipt) => (
    receipt.status === 'passed'
      && receipt.independent
      && Boolean(receipt.id.trim())
      && Boolean(receipt.reviewer.trim())
      && validTimestamp(receipt.reviewedAt)
      && validHash(receipt.artifactSha256)
  )).map((receipt) => receipt.kind));
}

export function assessMigrationEvidenceIntegrity(input: MigrationEvidenceIntegrityInput): MigrationEvidenceIntegrityAssessment {
  const documentation = uniqueOfficialDocumentation(input.source, input.documentation);
  const attributableDocumentation = documentation.filter((reference) => input.sourceEvidence?.documentationIds.includes(reference.url));
  const nodes = input.canonicalModel.nodes;
  const requiredDocumentationKinds = new Set(nodes.map((node) => node.kind));
  const documentedKinds = documentedNodeKinds(input.canonicalModel, attributableDocumentation);
  const documentationCoverageRatio = requiredDocumentationKinds.size === 0 ? 0 : documentedKinds.size / requiredDocumentationKinds.size;
  const evidencedNodes = nodes.filter((node) => node.evidence.some((evidence) => Boolean(evidence.sourceId.trim())));
  const directEvidenceNodes = nodes.filter((node) => node.evidence.some((evidence) => (evidence.role || 'direct') === 'direct'));
  const evidenceRatio = nodes.length === 0 ? 0 : evidencedNodes.length / nodes.length;
  const directEvidenceRatio = nodes.length === 0 ? 0 : directEvidenceNodes.length / nodes.length;
  const writeDecisions = input.decisions.filter(isWriteDecision);
  const ungroundedWrites = writeDecisions.filter((decision) => !decisionHasEvidence(decision, input.canonicalModel));
  const unapprovedWrites = writeDecisions.filter((decision) => !decision.approvedByUser);
  const unsupportedRows = input.coverageRows.filter((row) => row.status !== 'full');
  const completeCoverageMatrix = new Set(input.coverageRows.map((row) => row.id)).size === 6;
  const sourceEvidence = input.sourceEvidence;
  const fingerprintCoverage = sourceEvidence?.artifactFingerprints.length
    ? sourceEvidence.artifactFingerprints.filter((artifact) => validHash(artifact.sha256 || '')).length / sourceEvidence.artifactFingerprints.length
    : 0;
  const verificationKinds = passedVerificationKinds(input.verificationReceipts);
  const reviewKinds = passedReviewKinds(input.reviewReceipts);

  const documentationTraceability = attributableDocumentation.length === 0
    ? 0
    : bounded(8 + (attributableDocumentation.length >= 2 ? 4 : 0) + documentationCoverageRatio * 18, 30);
  const parserPoints = input.parserMode === 'deterministic' ? 10 : input.parserMode === 'hybrid' ? 5 : 0;
  const deterministicEvidence = bounded(parserPoints + evidenceRatio * 7 + directEvidenceRatio * 4 + fingerprintCoverage * 4, 25);
  const unsupportedBehaviorTransparency = bounded(
    (completeCoverageMatrix ? 8 : 0)
      + (unsupportedRows.length === 0 || input.unsupportedBehaviorAcknowledged ? 6 : 0)
      + (ungroundedWrites.length === 0 ? 6 : 0),
    20,
  );
  const verification = bounded(
    (verificationKinds.has('fixture') ? 4 : 0)
      + (verificationKinds.has('conformance') ? 4 : 0)
      + (verificationKinds.has('source_target_comparison') ? 4 : 0)
      + (verificationKinds.has('live_acceptance') ? 3 : 0),
    15,
  );
  const independentReview = bounded(
    (reviewKinds.has('architecture') ? 4 : 0)
      + (reviewKinds.has('security') ? 3 : 0)
      + (reviewKinds.has('qa') ? 3 : 0),
    10,
  );
  const score = documentationTraceability + deterministicEvidence + unsupportedBehaviorTransparency + verification + independentReview;
  const acquisitionBlockers = [
    ...(documentation.length === 0 ? ['No valid official documentation reference is registered for this source.'] : []),
    ...(documentation.length > 0 && attributableDocumentation.length === 0 ? ['The source evidence contract does not cite a registered official documentation reference.'] : []),
    ...(requiredDocumentationKinds.size > documentedKinds.size ? [`Official documentation traceability is missing for canonical kinds: ${Array.from(requiredDocumentationKinds).filter((kind) => !documentedKinds.has(kind)).sort().join(', ')}.`] : []),
    ...(input.parserMode === 'ai_only' ? ['AI-only parsing is not eligible for controlled live testing.'] : []),
    ...(!sourceEvidence ? ['The inventory has no SourceEvidenceBundleV2 contract.'] : []),
    ...(sourceEvidence && !sourceEvidence.collection.complete ? ['Source acquisition completeness has not been proven.'] : []),
    ...(sourceEvidence && !['complete', 'not_applicable'].includes(sourceEvidence.dependencyClosure.status) ? ['Source dependency closure is incomplete.'] : []),
    ...(sourceEvidence && sourceEvidence.artifactFingerprints.some((artifact) => !validHash(artifact.sha256 || '')) ? ['One or more source artifacts lack a SHA-256 evidence fingerprint.'] : []),
    ...(input.inventoryTruncated ? ['The required source inventory is truncated.'] : []),
    ...(unsupportedRows.length > 0 && !input.unsupportedBehaviorAcknowledged ? ['Partial or unsupported capability classes have not been acknowledged.'] : []),
  ];
  const manualDomoLimitationsDispositioned = input.source === 'domo'
    && sourceEvidence?.sourceTool === 'domo'
    && sourceEvidence.acquisition.mode === 'manual'
    && input.evidenceLimitationsAcknowledged === true
    && !input.inventoryTruncated
    && sourceEvidence.collection.truncated === false;
  const analysisBlockers = acquisitionBlockers.filter((blocker) => !(
    manualDomoLimitationsDispositioned
      && (blocker === 'Source acquisition completeness has not been proven.'
        || blocker === 'Source dependency closure is incomplete.')
  ));
  const writeBlockers = [
    ...(ungroundedWrites.length > 0 ? [`${ungroundedWrites.length} proposed model write${ungroundedWrites.length === 1 ? '' : 's'} lack source evidence.`] : []),
    ...(unapprovedWrites.length > 0 ? [`${unapprovedWrites.length} proposed model write${unapprovedWrites.length === 1 ? '' : 's'} lack explicit user approval.`] : []),
  ];
  const workflowBlockers = [...analysisBlockers, ...writeBlockers];
  const externalValidationBlockers = [
    ...(!verificationKinds.has('source_target_comparison') ? ['Source-to-target behavior has no valid comparison receipt.'] : []),
    ...(!reviewKinds.has('architecture') ? ['Independent Omni architecture review has no valid receipt.'] : []),
    ...(!reviewKinds.has('security') ? ['Independent security review has no valid receipt.'] : []),
    ...(!reviewKinds.has('qa') ? ['Independent QA review has no valid receipt.'] : []),
    'Controlled live testing requires a server-issued evidence attestation; browser-supplied receipts are informational only.',
  ];
  const blockers = Array.from(new Set([...acquisitionBlockers, ...writeBlockers, ...externalValidationBlockers]));
  const notices = [
    ...(!verificationKinds.has('live_acceptance') ? ['Live acceptance remains pending; local evidence does not establish release readiness.'] : []),
    ...(evidenceRatio < 1 ? [`${nodes.length - evidencedNodes.length} canonical node${nodes.length - evidencedNodes.length === 1 ? '' : 's'} lack direct source references.`] : []),
    ...(input.parserMode === 'hybrid' ? ['Hybrid parsing requires human review of every inferred decision.'] : []),
  ];

  const readyForControlledTesting = false;
  const band = score >= 85 && workflowBlockers.length === 0
      ? 'implementation_review'
      : 'incomplete';

  return {
    score,
    band,
    readyForControlledTesting,
    components: {
      documentationTraceability,
      deterministicEvidence,
      unsupportedBehaviorTransparency,
      verification,
      independentReview,
    },
    blockers,
    analysisBlockers,
    acquisitionBlockers,
    writeBlockers,
    workflowBlockers,
    externalValidationBlockers,
    notices,
    metrics: {
      nodeCount: nodes.length,
      evidencedNodeCount: evidencedNodes.length,
      directEvidenceNodeCount: directEvidenceNodes.length,
      proposedWriteCount: writeDecisions.length,
      ungroundedWriteCount: ungroundedWrites.length,
      unsupportedCoverageCount: unsupportedRows.length,
      requiredDocumentationKindCount: requiredDocumentationKinds.size,
      documentedNodeKindCount: documentedKinds.size,
    },
  };
}

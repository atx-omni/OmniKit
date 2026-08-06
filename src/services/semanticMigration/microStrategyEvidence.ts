export const MICROSTRATEGY_EVIDENCE_SCHEMA_VERSION = 'omnikit.microstrategy.evidence.v1' as const;

export type MicroStrategyArtifactClass =
  | 'project'
  | 'report'
  | 'dossier'
  | 'document'
  | 'dataset'
  | 'intelligent_cube'
  | 'attribute'
  | 'attribute_form'
  | 'metric'
  | 'filter'
  | 'prompt'
  | 'report_limit'
  | 'metric_limit'
  | 'derived_element'
  | 'sql';

export const MICROSTRATEGY_SUPPORTED_EVIDENCE_CLASSES: readonly MicroStrategyArtifactClass[] = [
  'project',
  'report',
  'dossier',
  'document',
  'dataset',
  'intelligent_cube',
  'attribute',
  'attribute_form',
  'metric',
  'filter',
  'prompt',
  'report_limit',
  'metric_limit',
  'derived_element',
  'sql',
];

export interface MicroStrategyOfficialDocument {
  id: string;
  title: string;
  url: string;
  reviewedOn: '2026-08-05';
  artifactClasses: readonly MicroStrategyArtifactClass[];
  contract: string;
}

/** Current official Strategy documentation used to interpret source response shapes. */
export const MICROSTRATEGY_OFFICIAL_DOCUMENTATION: readonly MicroStrategyOfficialDocument[] = [
  {
    id: 'strategy-rest-object-search',
    title: 'Search for objects',
    url: 'https://microstrategy.github.io/rest-api-docs/common-workflows/analytics/object-discovery/search-for-objects/',
    reviewedOn: '2026-08-05',
    artifactClasses: ['project', 'report', 'document', 'intelligent_cube', 'attribute', 'metric'],
    contract: 'Quick search is project scoped and returns typed object identities; inventory does not contain full object definitions.',
  },
  {
    id: 'strategy-rest-report-definition',
    title: "Retrieve a report's definition",
    url: 'https://microstrategy.github.io/rest-api-docs/common-workflows/analytics/manage-reports/manage-report-objects/retrieve-a-reports-definition/',
    reviewedOn: '2026-08-05',
    artifactClasses: ['report', 'filter', 'report_limit', 'metric_limit', 'derived_element'],
    contract: 'The Modeling report definition exposes source type, data and view templates, filters, limits, and referenced objects.',
  },
  {
    id: 'strategy-rest-document-hierarchy',
    title: 'Retrieve the hierarchy of a document',
    url: 'https://microstrategy.github.io/rest-api-docs/common-workflows/analytics/manage-documents/retrieve-document/retrieve-the-hierarchy-of-a-document/',
    reviewedOn: '2026-08-05',
    artifactClasses: ['document', 'dataset', 'attribute', 'attribute_form', 'metric'],
    contract: 'The document hierarchy response contains document identity, datasets, available objects, attribute forms, and layout hierarchy.',
  },
  {
    id: 'strategy-rest-dossier-selectors',
    title: "Retrieve a selector's definition",
    url: 'https://microstrategy.github.io/rest-api-docs/common-workflows/analytics/manage-selectors/retrieve-a-selectors-definition/',
    reviewedOn: '2026-08-05',
    artifactClasses: ['dossier', 'dataset', 'filter', 'attribute', 'attribute_form', 'metric'],
    contract: 'Dossier definitions expose chapters, pages, visualizations, selectors, filters, and dataset available objects.',
  },
  {
    id: 'strategy-rest-cube-definition',
    title: "Retrieve a cube's definition",
    url: 'https://microstrategy.github.io/rest-api-docs/common-workflows/analytics/manage-datasets/manage-cube-objects/retrieve-a-cube-definition/',
    reviewedOn: '2026-08-05',
    artifactClasses: ['dataset', 'intelligent_cube', 'attribute', 'metric'],
    contract: 'Cube definitions expose stable cube identity and available attributes and metrics.',
  },
  {
    id: 'strategy-rest-attribute-definition',
    title: 'Manage attribute objects',
    url: 'https://microstrategy.github.io/rest-api-docs/common-workflows/modeling/manage-attribute-objects/',
    reviewedOn: '2026-08-05',
    artifactClasses: ['attribute', 'attribute_form'],
    contract: 'Attribute definitions contain one or more forms; each form can contain typed expressions and table references.',
  },
  {
    id: 'strategy-rest-metric-definition',
    title: "Retrieve a metric's definition",
    url: 'https://microstrategy.github.io/rest-api-docs/common-workflows/modeling/manage-metric-objects/retrieve-a-metrics-definition/',
    reviewedOn: '2026-08-05',
    artifactClasses: ['metric', 'filter'],
    contract: 'Metric expression and dimty are separate fields; dimty units define calculation levels and cannot be derived from formula text.',
  },
  {
    id: 'strategy-rest-filter-definition',
    title: "Retrieve a filter's definition",
    url: 'https://microstrategy.github.io/rest-api-docs/common-workflows/modeling/manage-filter-objects/retrieve-a-filters-definition/',
    reviewedOn: '2026-08-05',
    artifactClasses: ['filter', 'attribute', 'attribute_form', 'metric', 'prompt'],
    contract: 'Filter qualifications can be represented as text, tree, and tokens with stable referenced-object identities.',
  },
  {
    id: 'strategy-rest-prompt-types',
    title: 'Prompt types',
    url: 'https://microstrategy.github.io/rest-api-docs/common-workflows/analytics/use-prompts-objects/prompt-types/',
    reviewedOn: '2026-08-05',
    artifactClasses: ['prompt'],
    contract: 'Prompt type and occurrence state are runtime behavior; prompt answers must remain explicit migration decisions.',
  },
  {
    id: 'strategy-rest-derived-element-definition',
    title: "Retrieve a derived element's definition",
    url: 'https://microstrategy.github.io/rest-api-docs/common-workflows/modeling/manage-derived-element-objects/retrieve-a-derived-elements-definition/',
    reviewedOn: '2026-08-05',
    artifactClasses: ['derived_element', 'attribute'],
    contract: 'Derived elements have their own identities, source attributes, element definitions, and behavior options.',
  },
  {
    id: 'strategy-rest-report-sql',
    title: 'Retrieve report or card SQL',
    url: 'https://microstrategy.github.io/rest-api-docs/common-workflows/analytics/retrieve-sql-statements-and-query-details/retrieve-report-or-card-sql/',
    reviewedOn: '2026-08-05',
    artifactClasses: ['sql', 'report'],
    contract: 'SQL is instance-scoped execution evidence retrieved from sqlView and is not a substitute for the report semantic definition.',
  },
];

export type MicroStrategyEvidenceLevel = 'inventory' | 'reference' | 'definition' | 'execution';
export type MicroStrategyEvidenceStatus = 'captured' | 'review_required' | 'unsupported' | 'blocked';
export type MicroStrategyCandidatePlacement =
  | 'model_context'
  | 'shared_model_view'
  | 'dimension'
  | 'shared_model_measure'
  | 'topic'
  | 'dashboard_specification'
  | 'filter'
  | 'query_view'
  | 'upstream_transformation'
  | 'governance_handoff'
  | 'explicit_exclusion'
  | 'unsupported';

export interface MicroStrategyEvidenceClassification {
  status: MicroStrategyEvidenceStatus;
  candidatePlacement: MicroStrategyCandidatePlacement;
  reasonCodes: string[];
}

export interface MicroStrategyObjectReference {
  sourceId: string;
  name?: string;
  expectedKinds: MicroStrategyArtifactClass[];
  sourcePath: string;
  requirement: 'reference' | 'definition';
}

export interface MicroStrategyMetricDimensionalityUnit {
  unitType: string;
  targetSourceId?: string;
  targetName?: string;
  aggregation?: string;
  filtering?: string;
  groupBy?: boolean;
}

export interface MicroStrategyExpressionEvidence {
  text?: string;
  hasTree: boolean;
  hasTokens: boolean;
}

interface MicroStrategyEvidenceNodeBase<K extends MicroStrategyArtifactClass, D> {
  evidenceId: string;
  kind: K;
  sourceId?: string;
  occurrenceKey?: string;
  syntheticIdentityReason?: 'source_object_id_missing';
  name: string;
  sourceArtifact: string;
  sourcePath: string;
  evidenceLevel: MicroStrategyEvidenceLevel;
  classification: MicroStrategyEvidenceClassification;
  references: MicroStrategyObjectReference[];
  details: D;
}

export type MicroStrategyEvidenceNode =
  | MicroStrategyEvidenceNodeBase<'project', { alias?: string; status?: string }>
  | MicroStrategyEvidenceNodeBase<'report', {
    sourceType?: string;
    freeformSql: boolean;
    datasetSourceIds: string[];
    attributeSourceIds: string[];
    metricSourceIds: string[];
    filterSourceIds: string[];
    promptSourceIds: string[];
    limitEvidenceIds: string[];
    derivedElementSourceIds: string[];
    sqlEvidenceIds: string[];
  }>
  | MicroStrategyEvidenceNodeBase<'dossier' | 'document', {
    datasetSourceIds: string[];
    chapterCount: number;
    pageCount: number;
    visualizationCount: number;
    filterEvidenceIds: string[];
    promptEvidenceIds: string[];
  }>
  | MicroStrategyEvidenceNodeBase<'dataset' | 'intelligent_cube', {
    sourceType?: string;
    attributeSourceIds: string[];
    metricSourceIds: string[];
    reportSourceIds: string[];
  }>
  | MicroStrategyEvidenceNodeBase<'attribute', {
    formSourceIds: string[];
    keyFormName?: string;
    lookupTableSourceId?: string;
  }>
  | MicroStrategyEvidenceNodeBase<'attribute_form', {
    parentAttributeSourceId?: string;
    category?: string;
    dataType?: string;
    expression: MicroStrategyExpressionEvidence;
  }>
  | MicroStrategyEvidenceNodeBase<'metric', {
    expression: MicroStrategyExpressionEvidence;
    dimensionalityStatus: 'explicit' | 'missing';
    dimensionalityUnits: MicroStrategyMetricDimensionalityUnit[];
    conditionalFilterSourceIds: string[];
  }>
  | MicroStrategyEvidenceNodeBase<'filter', {
    qualification: MicroStrategyExpressionEvidence;
    filterRole: 'report_filter' | 'view_filter' | 'selector' | 'standalone';
  }>
  | MicroStrategyEvidenceNodeBase<'prompt', {
    promptType?: string;
    required?: boolean;
    closed?: boolean;
    hasDefaultAnswer: boolean;
  }>
  | MicroStrategyEvidenceNodeBase<'report_limit' | 'metric_limit', {
    expression: MicroStrategyExpressionEvidence;
    ownerSourceId?: string;
  }>
  | MicroStrategyEvidenceNodeBase<'derived_element', {
    attributeSourceId?: string;
    elementCount: number;
    elementTypes: string[];
  }>
  | MicroStrategyEvidenceNodeBase<'sql', {
    ownerSourceId?: string;
    statement: string;
    executionScoped: true;
  }>;

export interface MicroStrategyDependencyEdge {
  id: string;
  sourceEvidenceId: string;
  dependencySourceId: string;
  dependencyName?: string;
  expectedKinds: MicroStrategyArtifactClass[];
  requirement: 'reference' | 'definition';
  sourcePath: string;
  resolvedEvidenceId?: string;
  status: 'resolved' | 'partial' | 'missing';
}

export interface MicroStrategyEvidenceDiagnostic {
  code: string;
  severity: 'warning' | 'blocker';
  message: string;
  sourceArtifact: string;
  sourcePath: string;
  evidenceId?: string;
  dependencySourceId?: string;
}

export interface MicroStrategyEvidenceBundle {
  schemaVersion: typeof MICROSTRATEGY_EVIDENCE_SCHEMA_VERSION;
  documentation: readonly MicroStrategyOfficialDocument[];
  nodes: MicroStrategyEvidenceNode[];
  dependencies: MicroStrategyDependencyEdge[];
  diagnostics: {
    counts: Record<MicroStrategyArtifactClass, number>;
    syntheticIdentityCount: number;
    missingDependencyCount: number;
    partialDependencyCount: number;
    unsupportedBehaviorCount: number;
    blockers: MicroStrategyEvidenceDiagnostic[];
    warnings: MicroStrategyEvidenceDiagnostic[];
  };
}

export interface MicroStrategyEvidenceIntegrityScore {
  score: number;
  band: 'controlled_live_candidate' | 'merge_only' | 'incomplete';
  eligibleForControlledLiveAcceptance: boolean;
  components: {
    documentationTraceability: number;
    deterministicParserCoverage: number;
    explicitUnsupportedBehavior: number;
    sourceToTargetVerification: number;
    independentReview: number;
  };
  automaticBlockers: string[];
  verification: 'none' | 'fixture' | 'conformance' | 'live';
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

export function calculateMicroStrategyEvidenceIntegrity(
  bundle: MicroStrategyEvidenceBundle,
  options: { verification: MicroStrategyEvidenceIntegrityScore['verification']; independentReview: boolean },
): MicroStrategyEvidenceIntegrityScore {
  const documentedClasses = new Set(bundle.documentation.flatMap((document) => document.artifactClasses));
  const documentedCount = MICROSTRATEGY_SUPPORTED_EVIDENCE_CLASSES.filter((kind) => documentedClasses.has(kind)).length;
  const documentationTraceability = rounded(30 * documentedCount / MICROSTRATEGY_SUPPORTED_EVIDENCE_CLASSES.length);

  const identityCoverage = bundle.nodes.length
    ? bundle.nodes.filter((node) => Boolean(node.sourceId || node.syntheticIdentityReason)).length / bundle.nodes.length
    : 0;
  const dependencyCoverage = bundle.dependencies.length
    ? bundle.dependencies.filter((edge) => Boolean(edge.dependencySourceId && edge.sourceEvidenceId)).length / bundle.dependencies.length
    : bundle.nodes.length ? 1 : 0;
  const typedDiagnostics = bundle.schemaVersion === MICROSTRATEGY_EVIDENCE_SCHEMA_VERSION && bundle.nodes.length ? 7 : 0;
  const deterministicParserCoverage = rounded(identityCoverage * 10 + dependencyCoverage * 8 + typedDiagnostics);

  const unsafeCapturedNodes = bundle.nodes.filter((node) => node.classification.status === 'captured'
    && node.classification.reasonCodes.some((code) => /missing|unsupported|ambiguous|inferred/i.test(code)));
  const explicitUnsupportedBehavior = unsafeCapturedNodes.length === 0 && bundle.nodes.length ? 20 : 0;
  const sourceToTargetVerification = options.verification === 'none' ? 0 : 15;
  const independentReview = options.independentReview ? 10 : 0;
  const score = Math.round(documentationTraceability + deterministicParserCoverage + explicitUnsupportedBehavior + sourceToTargetVerification + independentReview);
  const automaticBlockers = Array.from(new Set(bundle.diagnostics.blockers.map((diagnostic) => diagnostic.message)));
  const eligibleForControlledLiveAcceptance = score >= 95 && automaticBlockers.length === 0;

  return {
    score,
    band: eligibleForControlledLiveAcceptance ? 'controlled_live_candidate' : score >= 85 ? 'merge_only' : 'incomplete',
    eligibleForControlledLiveAcceptance,
    components: {
      documentationTraceability,
      deterministicParserCoverage,
      explicitUnsupportedBehavior,
      sourceToTargetVerification,
      independentReview,
    },
    automaticBlockers,
    verification: options.verification,
  };
}

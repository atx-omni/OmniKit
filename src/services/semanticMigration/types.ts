export type MigrationBiSourceTool = 'looker' | 'metabase' | 'power_bi' | 'tableau' | 'domo' | 'sigma' | 'webfocus' | 'microstrategy';

export type MigrationSourceTool = MigrationBiSourceTool | 'dbt';

export type MigrationPlatformKind = MigrationSourceTool | 'omni';

export type MigrationProviderKind =
  | 'omni_ai'
  | 'openai'
  | 'anthropic'
  | 'snowflake_cortex'
  | 'databricks_genie'
  | 'databricks_model_serving';

export type MigrationProviderAuthMode =
  | 'linked_omni_instance'
  | 'api_key'
  | 'programmatic_access_token'
  | 'oauth_access_token'
  | 'personal_access_token'
  | 'key_pair_jwt';

/**
 * Authentication modes for BI source acquisition. This is intentionally
 * separate from MigrationProviderAuthMode: a source connector and an AI
 * provider have different credential lifecycles and must not be
 * interchangeable merely because an OAuth token is involved.
 */
export type MigrationPlatformAuthMode =
  | 'api_key'
  | 'api_client_credentials'
  | 'oauth_client_credentials'
  | 'oauth_access_token'
  | 'personal_access_token'
  | 'username_password_session'
  | 'product_api_token';

export type LegacyMigrationProviderKind =
  | 'custom_openai_compatible';

export type DestinationFoundationMode =
  | 'existing_model'
  | 'existing_connection'
  | 'new_connection';

export interface MigrationProviderCapabilities {
  structuredOutput: boolean;
  toolUse: boolean;
  cancellation: boolean;
  modelDiscovery: boolean;
  usageReporting: boolean;
  supportedTasks: MigrationAiTask[];
  limitations: string[];
}

export type MigrationAiTask =
  | 'classify_inventory'
  | 'propose_mappings'
  | 'translate_expression'
  | 'draft_semantic_patch'
  | 'draft_content_spec'
  | 'explain_exception'
  | 'generate_validation_sql'
  | 'evaluate_reconciliation';

export interface MigrationProviderProfile {
  id: string;
  name: string;
  kind: MigrationProviderKind | LegacyMigrationProviderKind;
  model: string;
  baseUrl?: string;
  linkedInstanceId?: string;
  accountIdentifier?: string;
  warehouse?: string;
  database?: string;
  schema?: string;
  authMode?: MigrationProviderAuthMode;
  credentialOwner?: string;
  credentialExpiresAt?: string;
  rotationDueAt?: string;
  lastValidationStatus?: 'valid' | 'failed';
  lastValidationAttemptAt?: string;
  lastValidatedRevision?: string;
  enabled: boolean;
  capabilities: MigrationProviderCapabilities;
  credentialMasked?: string;
  lastValidatedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MigrationPlatformConnection {
  id: string;
  name: string;
  platform: MigrationPlatformKind;
  baseUrl?: string;
  accountIdentifier?: string;
  workspaceId?: string;
  projectId?: string;
  siteId?: string;
  clientId?: string;
  username?: string;
  repositoryPath?: string;
  authMode?: MigrationPlatformAuthMode;
  credentialExpiresAt?: string;
  enabled: boolean;
  hasCredential?: boolean;
  credentialMasked?: string;
  hasProductApiToken?: boolean;
  productApiTokenMasked?: string;
  hasPlatformOAuthClient?: boolean;
  inventoryAccess?: 'basic' | 'deep' | 'hybrid';
  lastValidatedAt?: string;
  lastValidatedRevision?: string;
  lastValidationStatus?: 'valid' | 'failed';
  lastValidationAttemptAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SemanticEvidenceReference {
  sourceId: string;
  artifactId?: string;
  locator?: string;
  excerpt?: string;
  artifactSha256?: string;
  contentSha256?: string;
  role?: 'direct' | 'bundle_input' | 'derived';
}

export type CanonicalSemanticNodeKind =
  | 'workspace'
  | 'project'
  | 'model'
  | 'view'
  | 'field'
  | 'measure'
  | 'relationship'
  | 'topic'
  | 'data_source'
  | 'dataset'
  | 'report'
  | 'dashboard'
  | 'workbook'
  | 'page'
  | 'tile'
  | 'visual'
  | 'card'
  | 'cube'
  | 'metric'
  | 'attribute'
  | 'calculation'
  | 'filter'
  | 'permission'
  | 'schedule'
  | 'transformation'
  | 'materialization'
  | 'automation'
  | 'policy'
  | 'output';

export interface CanonicalSemanticNode {
  id: string;
  kind: CanonicalSemanticNodeKind;
  name: string;
  description?: string;
  dataType?: string;
  expression?: string;
  parentId?: string;
  dependencies: string[];
  evidence: SemanticEvidenceReference[];
  metadata: Record<string, string | number | boolean | null>;
}

export type MigrationAssetDisposition = 'migrate' | 'consolidate' | 'redesign' | 'defer' | 'retire';

export interface MigrationAssetScopeDecision {
  assetId: string;
  disposition: MigrationAssetDisposition;
  wave: string;
  note?: string;
}

export interface CanonicalSemanticModel {
  schemaVersion: '1.0';
  sourcePlatform: MigrationPlatformKind;
  generatedAt: string;
  nodes: CanonicalSemanticNode[];
  warnings: string[];
}

export type MigrationComplexity = 'light' | 'moderate' | 'heavy' | 'unknown';

export interface MigrationExecutionCharacteristics {
  materialized: boolean;
  scheduled: boolean;
  incremental: boolean;
  stateful: boolean;
  sideEffects: boolean;
  scripting: boolean;
  reusedAcrossAssets: boolean;
  queryTimeSafe: boolean;
  estimatedComplexity: MigrationComplexity;
  sourceSignals: string[];
}

export interface CanonicalMigrationEdge {
  fromNodeId: string;
  toNodeId: string;
  kind: 'depends_on' | 'contains' | 'governs' | 'produces';
}

export interface CanonicalMigrationGraph {
  schemaVersion: '2.0';
  sourcePlatform: MigrationPlatformKind;
  generatedAt: string;
  nodes: CanonicalSemanticNode[];
  edges: CanonicalMigrationEdge[];
  executionByNodeId: Record<string, MigrationExecutionCharacteristics>;
  warnings: string[];
}

export type MigrationPlacementTarget =
  | 'upstream_transformation'
  | 'omni_view'
  | 'omni_topic'
  | 'omni_query_view'
  | 'automation_handoff'
  | 'governance_handoff'
  | 'exclude';

export type TransformationTargetKind =
  | 'generic_sql'
  | 'dbt'
  | 'snowflake'
  | 'databricks'
  | 'motherduck';

export type TransformationDeploymentMode = 'export' | 'deploy';

export interface ArtifactPlacementDecision {
  id: string;
  nodeId: string;
  sourcePlatform: MigrationPlatformKind;
  sourceKind: CanonicalSemanticNodeKind;
  sourceName: string;
  recommendedTarget: MigrationPlacementTarget;
  approvedTarget?: MigrationPlacementTarget;
  targetAdapter?: TransformationTargetKind;
  deploymentMode: TransformationDeploymentMode;
  targetObjectName?: string;
  reasonCodes: string[];
  rationale: string;
  confidence: 'high' | 'medium' | 'low';
  blocking: boolean;
  missingEvidence: string[];
  dependencies: string[];
  approvedByUser: boolean;
}

export type TransformationOperationKind =
  | 'create_view'
  | 'create_table'
  | 'create_incremental_model'
  | 'create_semantic_view'
  | 'handoff_automation'
  | 'handoff_governance';

export interface TransformationOperation {
  id: string;
  nodeId: string;
  name: string;
  kind: TransformationOperationKind;
  sql?: string;
  dependencies: string[];
  sourceEvidenceIds: string[];
  reasonCodes: string[];
  materialization: 'view' | 'table' | 'incremental' | 'none';
  idempotencyKey: string;
}

export interface TransformationPackageFile {
  id: string;
  path: string;
  content: string;
  mediaType: 'text/sql' | 'text/yaml' | 'application/json' | 'text/markdown';
  executionOrder: number;
  sha256?: string;
  operationIds: string[];
}

export interface TransformationValidationCheck {
  id: string;
  category: 'contract' | 'dependency' | 'security' | 'dialect' | 'schema' | 'grain' | 'result' | 'deployment';
  label: string;
  status: 'passed' | 'warning' | 'blocked' | 'pending';
  blocking: boolean;
  message: string;
  operationIds: string[];
}

export interface TransformationValidationReport {
  schemaVersion: '1.0';
  generatedAt: string;
  ready: boolean;
  checks: TransformationValidationCheck[];
}

export interface TransformationDeploymentPlan {
  id: string;
  target: TransformationTargetKind;
  mode: TransformationDeploymentMode;
  environmentLabel: string;
  productionLike: boolean;
  explicitlyApproved: boolean;
  orderedFileIds: string[];
  rollbackInstructions: string[];
}

export interface TransformationDeploymentResult {
  planId: string;
  status: 'exported' | 'deployed' | 'blocked' | 'failed';
  startedAt: string;
  completedAt: string;
  appliedOperationIds: string[];
  message: string;
  auditEvents: string[];
}

export interface TransformationTargetAdapterCapability {
  target: TransformationTargetKind;
  label: string;
  supportsExport: boolean;
  supportsDeployment: boolean;
  supportsRollbackAutomation: boolean;
  supportedMaterializations: Array<'view' | 'table' | 'incremental'>;
  limitations: string[];
}

export interface AutomationHandoff {
  id: string;
  nodeId: string;
  sourceName: string;
  sourcePlatform: MigrationPlatformKind;
  category: 'workflow' | 'notification' | 'form' | 'writeback' | 'script' | 'governance';
  rationale: string;
  dependencies: string[];
  recommendedOwner: string;
  acceptanceCriteria: string[];
}

export interface TransformationPackage {
  schemaVersion: '1.0';
  packageId: string;
  generatedAt: string;
  sourcePlatform: MigrationPlatformKind;
  target: TransformationTargetKind;
  placements: ArtifactPlacementDecision[];
  operations: TransformationOperation[];
  handoffs: AutomationHandoff[];
  files: TransformationPackageFile[];
  dependencyOrder: string[];
  validationQueries: string[];
  rollbackInstructions: string[];
  warnings: string[];
}

export type MigrationDecisionAction = 'map_existing' | 'create_new' | 'rewrite' | 'exclude' | 'defer';

export type MigrationSemanticDecisionKind =
  | 'data_source'
  | 'model'
  | 'view'
  | 'field'
  | 'measure'
  | 'relationship'
  | 'topic'
  | 'filter'
  | 'folder'
  | 'user'
  | 'group'
  | 'permission'
  | 'schedule'
  | 'dashboard'
  | 'visual';

export interface MigrationDecisionProposalOption {
  id: string;
  action: MigrationDecisionAction;
  targetLabel?: string;
  targetId?: string;
  targetFileName?: SemanticYamlFileName;
  proposedCode?: string;
  rationale: string;
  confidence: number;
}

export type MigrationMappingDomain =
  | 'data_source'
  | 'model'
  | 'field'
  | 'measure'
  | 'relationship'
  | 'filter'
  | 'folder'
  | 'user'
  | 'group'
  | 'permission'
  | 'schedule'
  | 'content'
  | 'visual';

export interface MigrationDecision {
  id: string;
  nodeId: string;
  providerDecisionId?: string;
  semanticKind?: MigrationSemanticDecisionKind;
  semanticKey?: string;
  identityDiagnostics?: string[];
  domain: MigrationMappingDomain;
  sourceLabel: string;
  targetLabel?: string;
  action: MigrationDecisionAction;
  targetId?: string;
  targetFileName?: SemanticYamlFileName;
  proposedCode?: string;
  rationale: string;
  confidence: number;
  evidence: SemanticEvidenceReference[];
  blocking: boolean;
  impactAssetIds: string[];
  validationRequired: boolean;
  compatibilityKey?: string;
  approvedByUser: boolean;
  resolutionOwner?: string;
  waiverReason?: string;
  proposalOptions?: MigrationDecisionProposalOption[];
  selectedProposalOptionId?: string;
  translationProvenance?: {
    engineName: string;
    engineVersion: string;
    parserVersion: string;
    rulebookVersion: string;
    rulebookSha256: string;
    suggestionSha256: string;
    severity: 'info' | 'warning' | 'blocker';
  };
}

export type SemanticPatchOperation = 'create_file' | 'update_file' | 'delete_file';

export interface SemanticPatch {
  id: string;
  operation: SemanticPatchOperation;
  fileName: SemanticYamlFileName;
  baseChecksum?: string;
  content?: string;
  decisionIds: string[];
  destructive: boolean;
}

export interface MigrationArtifact {
  id: string;
  sourceTool: MigrationSourceTool;
  name: string;
  kind: 'manifest' | 'yaml' | 'sql' | 'lookml' | 'dashboard' | 'json' | 'xml' | 'metadata' | 'text' | 'unknown';
  content: string;
  sizeBytes: number;
  parseWarnings: string[];
}

export interface MigrationField {
  sourceId?: string;
  sourceLocator?: string;
  sourceEvidence?: SemanticEvidenceReference[];
  name: string;
  type?: string;
  sql?: string;
  description?: string;
  label?: string;
  groupLabel?: string;
  sourceColumn?: string;
  formatString?: string;
  dataCategory?: string;
  hidden?: boolean;
  primaryKey?: boolean;
  timeframes?: string[];
  filters?: Record<string, Record<string, unknown>>;
  untranslatable?: string[];
  annotations?: Record<string, string>;
  sourceArtifact?: string;
}

export interface MigrationMeasure extends MigrationField {
  aggregateType?: string;
  dependencies?: string[];
  sourceId?: string;
  originalName?: string;
}

export interface MigrationView {
  name: string;
  label?: string;
  description?: string;
  sourceArtifact?: string;
  sourceId?: string;
  sourceLocator?: string;
  sourceEvidence?: SemanticEvidenceReference[];
  kind?: 'dataset' | 'query_view';
  sql?: string;
  hidden?: boolean;
  annotations?: Record<string, string>;
  partitions?: Array<{ name: string; mode?: string; sourceType?: string; expression?: string }>;
  hierarchies?: Array<{ name: string; levels: Array<{ name: string; column?: string; ordinal?: number }> }>;
  calculationItems?: Array<{ name: string; expression?: string; ordinal?: number }>;
  fields: MigrationField[];
  measures: MigrationMeasure[];
  warnings: string[];
}

export interface MigrationRelationship {
  sourceId?: string;
  sourceLocator?: string;
  sourceEvidence?: SemanticEvidenceReference[];
  from: string;
  to: string;
  joinType?: string;
  relationshipType?: string;
  sql?: string;
  active?: boolean;
  crossFilteringBehavior?: string;
  sourceArtifact?: string;
}

export interface MigrationExplore {
  sourceId?: string;
  sourceLocator?: string;
  sourceEvidence?: SemanticEvidenceReference[];
  name: string;
  baseView?: string;
  joins: MigrationRelationship[];
  fields: string[];
  filters: string[];
  sourceArtifact?: string;
}

export interface MigrationDashboardEvidence {
  name: string;
  fields: string[];
  filters: string[];
  assetKind?: 'dashboard' | 'page' | 'card';
  sourceArtifact?: string;
  sourceId?: string;
  sourceLocator?: string;
  sourceEvidence?: SemanticEvidenceReference[];
  parentId?: string;
  path?: string;
  owner?: string;
  updatedAt?: string;
  usageCount?: number;
  dependencyIds?: string[];
  childIds?: string[];
  featureFlags?: string[];
  riskFlags?: string[];
  metadata?: Record<string, string | number | boolean | null>;
  sourceDatasetId?: string;
  chartType?: string;
  cardType?: string;
}

/** The authority carried by one acquired artifact. */
export type MigrationSourceEvidenceClass =
  | 'authoritative_definition'
  | 'compiled_definition'
  | 'discovery_metadata'
  | 'governance_evidence'
  | 'manual_required';

/**
 * Collection state is independent from whether an inventory happened to
 * contain zero rows. `complete` can therefore represent a verified-empty
 * source while `failed` never can.
 */
export type MigrationPreparedEvidenceStatus =
  | 'complete'
  | 'partial'
  | 'bounded'
  | 'failed'
  | 'manual_required';

export type MigrationSourceDependencyStatus =
  | 'resolved'
  | 'missing'
  | 'review_required'
  | 'manual_required';

export interface MigrationSourceArtifactProvenance {
  /** Stable browser-safe evidence identifier, not a credential-bearing URL. */
  id: string;
  name: string;
  sourceId: string;
  parentSourceId?: string;
  locator?: string;
  mediaType?: string;
  evidenceClass: MigrationSourceEvidenceClass;
  sha256: string;
  sizeBytes: number;
  documentationIds: string[];
  /** Raw vendor definitions are normalized server-side before this DTO. */
  rawContentIncluded: false;
}

export interface MigrationSourceDependencyEvidence {
  sourceId: string;
  dependencySourceId?: string;
  category:
    | 'semantic_model'
    | 'data_source'
    | 'field'
    | 'calculation'
    | 'relationship'
    | 'filter'
    | 'security'
    | 'schedule'
    | 'content'
    | 'unknown';
  required: boolean;
  status: MigrationSourceDependencyStatus;
  reason: string;
}

export interface MigrationPreparedEvidenceDiagnostics {
  complete: boolean;
  verifiedEmpty: boolean;
  truncated: boolean;
  requestsMade: number;
  pagesFetched: number;
  itemsObserved: number;
  bytesRead: number;
  limits: {
    maxRequests?: number;
    maxPages?: number;
    maxItems?: number;
    maxBytes?: number;
  };
  permissionGaps: string[];
  manualRequirements: string[];
  errors: string[];
  warnings: string[];
}

export interface MigrationPrepareEvidenceRequest {
  /** Exact root identifiers selected from the revision-bound inventory. */
  selectedRootIds: string[];
  /** Optimistic concurrency token for the saved source connection. */
  connectionUpdatedAt: string;
}

export interface MigrationSourceEvidenceContract {
  schemaVersion: 'omnikit.source-evidence.v2';
  sourceTool: MigrationSourceTool;
  parser: {
    name: string;
    version: string;
    rulebookVersion?: string;
    rulebookSha256?: string;
  };
  acquisition: {
    mode: 'manual' | 'api' | 'hybrid' | 'unknown';
    runId?: string;
    selectedScopeIds: string[];
  };
  collection: {
    expectedArtifactCount?: number;
    observedArtifactCount: number;
    complete: boolean;
    truncated: boolean;
    permissionGaps: string[];
  };
  dependencyClosure: {
    status: 'not_evaluated' | 'not_applicable' | 'complete' | 'partial' | 'blocked';
    resolvedCount: number;
    missingCount: number;
    reviewCount: number;
  };
  artifactFingerprints: Array<{
    name: string;
    sha256?: string;
    sizeBytes: number;
  }>;
  documentationIds: string[];
  diagnostics: string[];
}

export interface MigrationInventory {
  sourceTool: MigrationSourceTool;
  artifactCount: number;
  artifacts: MigrationArtifact[];
  views: MigrationView[];
  explores: MigrationExplore[];
  relationships: MigrationRelationship[];
  dashboards: MigrationDashboardEvidence[];
  metrics: MigrationMeasure[];
  warnings: string[];
  summary: string;
  sourceEvidence?: MigrationSourceEvidenceContract;
}

/**
 * Browser-safe result of preparing one exact source scope. Credentials,
 * access tokens, session cookies, and unredacted vendor payloads are excluded
 * by contract.
 */
export interface MigrationPreparedEvidenceResult {
  schemaVersion: 'omnikit.prepared-source-evidence.v1';
  platform: MigrationBiSourceTool;
  connectionId: string;
  connectionUpdatedAt: string;
  selectedRootIds: string[];
  scopeFingerprint: string;
  preparedAt: string;
  status: MigrationPreparedEvidenceStatus;
  evidenceContract: MigrationSourceEvidenceContract;
  inventory: MigrationInventory;
  artifacts: MigrationSourceArtifactProvenance[];
  dependencies: MigrationSourceDependencyEvidence[];
  diagnostics: MigrationPreparedEvidenceDiagnostics;
}

export interface MigrationPreparedEvidenceResponse {
  result: MigrationPreparedEvidenceResult;
}

export type DomoManualSourceKind =
  | 'dataset_schema'
  | 'beast_mode'
  | 'variable'
  | 'dataflow_sql'
  | 'relationship'
  | 'page'
  | 'page_card_link'
  | 'card'
  | 'drill_path'
  | 'filter_view'
  | 'card_interaction'
  | 'pdp_policy'
  | 'dataset_access'
  | 'schedule_alert'
  | 'usage_ownership'
  | 'magic_etl'
  | 'dataflow'
  | 'workflow'
  | 'form'
  | 'code_engine'
  | 'custom_app'
  | 'workbench'
  | 'connector'
  | 'embed';

export type DomoManualTargetKind =
  | 'shared_model_view'
  | 'shared_model_dimension'
  | 'shared_model_measure'
  | 'query_view'
  | 'relationships_file'
  | 'topic_dashboard'
  | 'dashboard_tile'
  | 'dashboard_control'
  | 'governance_review'
  | 'operational_review'
  | 'data_engineering_handoff'
  | 'redesign_handoff';

export interface DomoManualMapping {
  id: string;
  sourceKind: DomoManualSourceKind;
  sourceId?: string;
  sourceLocator?: string;
  sourceName: string;
  sourceArtifact: string;
  targetKind: DomoManualTargetKind;
  targetName: string;
  confidence: 'high' | 'medium' | 'low';
  dependencies: string[];
  notes: string[];
}

export interface DomoManualTraversalIssue {
  artifactName: string;
  limit: 'depth' | 'records';
  path: string;
  maximum: number;
}

export interface DomoManualParseDiagnostics {
  schemaVersion: 'omnikit.domo.manual.v2';
  parsedArtifactCount: number;
  unsupportedArtifactCount: number;
  mappingCount: number;
  deduplicatedMeasureCount: number;
  conflictCount: number;
  pageCount: number;
  governanceItemCount: number;
  operationalItemCount: number;
  handoffCount: number;
  traversalLimitHit: boolean;
  traversalIssues: DomoManualTraversalIssue[];
  missingStableIdCount: number;
  unresolvedDependencyCount: number;
  ambiguousRelationshipCount: number;
  warnings: string[];
}

export interface DomoManualConflictVariant {
  sourceId?: string;
  sourceArtifact: string;
  formula: string;
  proposedName: string;
}

export interface DomoManualConflict {
  id: string;
  kind: 'beast_mode_formula_collision' | 'beast_mode_field_collision';
  datasetView: string;
  sourceName: string;
  resolution: 'preserve_all';
  variants: DomoManualConflictVariant[];
}

export interface DomoManualParseResult {
  inventory: MigrationInventory;
  mappings: DomoManualMapping[];
  conflicts: DomoManualConflict[];
  diagnostics: DomoManualParseDiagnostics;
}

export type DomoApiMissingDependencyKind =
  | 'page_detail'
  | 'card_search'
  | 'card_metadata'
  | 'card_chart'
  | 'card_drill'
  | 'dataset_metadata'
  | 'dataset_schema'
  | 'dataset_access'
  | 'dataset_pdp'
  | 'dataset_card_bindings'
  | 'beast_mode_search'
  | 'beast_mode_identity'
  | 'beast_mode_detail'
  | 'dataflow_search'
  | 'connector_search'
  | 'app_search'
  | 'data_app_search'
  | 'alert_search';

export interface DomoApiMissingDependency {
  kind: DomoApiMissingDependencyKind;
  sourceId?: string;
  sourceName?: string;
  reason: string;
}

export type DomoApiEvidenceLimitationCode =
  | 'domo_product_card_analyzer_definition_manual_validation_required'
  | 'domo_product_card_drill_manual_validation_required'
  | 'domo_product_dataset_pdp_manual_validation_required'
  | 'domo_platform_dataset_definition_manual_validation_required'
  | 'domo_platform_beast_mode_manual_validation_required';

export interface DomoApiEvidenceLimitation {
  code: DomoApiEvidenceLimitationCode;
  message: string;
}

export interface DomoApiEvidenceDiagnostics {
  schemaVersion: 'omnikit.domo.api.v1';
  status: 'ready' | 'ready_with_gaps' | 'blocked';
  access: 'deep';
  limitationDispositionRequired: boolean;
  limitations: DomoApiEvidenceLimitation[];
  selectedDashboardCount: number;
  resolvedPageCount: number;
  resolvedCardCount: number;
  resolvedDatasetCount: number;
  resolvedBeastModeCount: number;
  requestCount: number;
  truncated: boolean;
  missingDependencies: DomoApiMissingDependency[];
  blockers: string[];
  warnings: string[];
}

/**
 * Server-prepared Domo evidence. Raw Product API responses and credentials are never included;
 * only the parser's normalized migration contract crosses the browser boundary.
 */
export interface DomoApiEvidenceResult {
  parseResult: DomoManualParseResult;
  selectedDashboardIds: string[];
  resolvedDashboardIds: string[];
  connectionUpdatedAt: string;
  scopeFingerprint: string;
  preparedAt: string;
  diagnostics: DomoApiEvidenceDiagnostics;
}

export type LookerManualSourceKind = 'model' | 'view' | 'explore' | 'measure' | 'relationship' | 'dashboard';

export interface LookerManualMapping {
  id: string;
  sourceKind: LookerManualSourceKind;
  sourceName: string;
  sourceArtifact: string;
  targetKind: 'model_context' | 'shared_model_view' | 'shared_model_measure' | 'relationships_file' | 'topic' | 'dashboard_tile';
  targetName: string;
  confidence: 'high' | 'medium' | 'low';
  notes: string[];
}

export interface LookerManualParseDiagnostics {
  schemaVersion: 'omnikit.looker.manual.v1';
  parsedArtifactCount: number;
  unsupportedArtifactCount: number;
  modelFileCount: number;
  viewFileCount: number;
  dashboardFileCount: number;
  mappingCount: number;
  warnings: string[];
}

export interface LookerManualParseResult {
  inventory: MigrationInventory;
  mappings: LookerManualMapping[];
  diagnostics: LookerManualParseDiagnostics;
}

export type MicroStrategyManualSourceKind = 'project' | 'cube' | 'report' | 'attribute' | 'metric' | 'relationship' | 'dashboard' | 'visualization' | 'filter' | 'prompt';

export interface MicroStrategyManualMapping {
  id: string;
  sourceKind: MicroStrategyManualSourceKind;
  sourceId?: string;
  sourceName: string;
  sourceArtifact: string;
  targetKind: 'model_context' | 'shared_model_view' | 'dimension' | 'shared_model_measure' | 'relationships_file' | 'topic' | 'dashboard_tile' | 'filter';
  targetName: string;
  confidence: 'high' | 'medium' | 'low';
  notes: string[];
}

export interface MicroStrategyManualParseDiagnostics {
  schemaVersion: 'omnikit.microstrategy.manual.v1';
  parsedArtifactCount: number;
  unsupportedArtifactCount: number;
  projectCount: number;
  cubeCount: number;
  reportCount: number;
  attributeCount: number;
  metricCount: number;
  relationshipCount: number;
  dashboardCount: number;
  visualizationCount: number;
  mappingCount: number;
  warnings: string[];
}

export interface MicroStrategyManualParseResult {
  inventory: MigrationInventory;
  mappings: MicroStrategyManualMapping[];
  diagnostics: MicroStrategyManualParseDiagnostics;
}

export type PowerBiManualSchemaVersion = 'omnikit.powerbi.manual.v1' | 'omnikit.powerbi.manual.v2';

export type PowerBiManualSourceKind =
  | 'workspace'
  | 'semantic_model'
  | 'data_source'
  | 'partition'
  | 'table'
  | 'column'
  | 'calculated_column'
  | 'measure'
  | 'hierarchy'
  | 'calculation_group'
  | 'relationship'
  | 'perspective'
  | 'culture'
  | 'role'
  | 'sensitivity_label'
  | 'report'
  | 'page'
  | 'visual'
  | 'filter'
  | 'slicer'
  | 'bookmark'
  | 'interaction'
  | 'drillthrough'
  | 'theme';

export interface PowerBiVisualPosition {
  x: number;
  y: number;
  width: number;
  height: number;
  z?: number;
  tabOrder?: number;
}

export interface PowerBiManualVisualEvidence {
  id: string;
  name: string;
  title?: string;
  visualType: string;
  pageId: string;
  sourceArtifact: string;
  fields: string[];
  fieldBindings?: Array<{ role: string; field: string }>;
  filters: string[];
  position?: PowerBiVisualPosition;
  query?: string;
  formatting?: string;
  customVisual?: boolean;
  unsupportedReasons: string[];
}

export interface PowerBiManualPageEvidence {
  id: string;
  name: string;
  displayName: string;
  order: number;
  sourceArtifact: string;
  width?: number;
  height?: number;
  filters: string[];
  drillthroughFields: string[];
  visuals: PowerBiManualVisualEvidence[];
}

export interface PowerBiManualReportEvidence {
  id: string;
  name: string;
  datasetId?: string;
  sourceArtifact: string;
  filters: string[];
  pages: PowerBiManualPageEvidence[];
  bookmarks: string[];
  themeFiles: string[];
  warnings: string[];
}

export interface PowerBiManualProjectEvidence {
  id: string;
  name: string;
  sourceFiles: string[];
  semanticModelIds: string[];
  reports: PowerBiManualReportEvidence[];
  warnings: string[];
}

export interface PowerBiManualModelEvidence {
  id: string;
  name: string;
  sourceArtifact: string;
  culture?: string;
  annotations?: Record<string, string>;
  warnings: string[];
}

export interface PowerBiManualMapping {
  id: string;
  sourceKind: PowerBiManualSourceKind;
  sourceId?: string;
  sourceName: string;
  sourceArtifact: string;
  targetKind:
    | 'model_context'
    | 'shared_model_view'
    | 'query_view'
    | 'dimension'
    | 'shared_model_measure'
    | 'relationships_file'
    | 'governance_review'
    | 'access_policy'
    | 'topic'
    | 'dashboard_section'
    | 'dashboard_tile'
    | 'dashboard_filter'
    | 'dashboard_bookmark'
    | 'dashboard_interaction'
    | 'dashboard_theme'
    | 'filter';
  targetName: string;
  confidence: 'high' | 'medium' | 'low';
  notes: string[];
}

export interface PowerBiManualParseDiagnostics {
  schemaVersion: PowerBiManualSchemaVersion;
  parsedArtifactCount: number;
  unsupportedArtifactCount: number;
  workspaceCount: number;
  semanticModelCount: number;
  tableCount: number;
  columnCount: number;
  measureCount: number;
  relationshipCount: number;
  roleCount: number;
  reportCount: number;
  pageCount: number;
  visualCount: number;
  projectCount?: number;
  dataSourceCount?: number;
  partitionCount?: number;
  calculatedColumnCount?: number;
  hierarchyCount?: number;
  calculationGroupCount?: number;
  perspectiveCount?: number;
  cultureCount?: number;
  bookmarkCount?: number;
  interactionCount?: number;
  unsupportedVisualCount?: number;
  mappingCount: number;
  warnings: string[];
}

export interface PowerBiManualParseResult {
  inventory: MigrationInventory;
  mappings: PowerBiManualMapping[];
  diagnostics: PowerBiManualParseDiagnostics;
  projects?: PowerBiManualProjectEvidence[];
  models?: PowerBiManualModelEvidence[];
}

export type SemanticYamlFileName = 'model' | 'relationships' | `${string}.topic` | `${string}.view`;

export interface SemanticMigrationFile {
  id: string;
  fileName: SemanticYamlFileName;
  yaml: string;
  source: 'semantic-migration';
  decisionIds?: string[];
  placementIds?: string[];
  evidenceIds?: string[];
  definitions?: Array<{
    path: string;
    decisionIds: string[];
    placementIds: string[];
    evidenceIds: string[];
  }>;
  baseDigest?: string | null;
}

export type OmniMigrationDeliverableKind = 'model' | 'view' | 'topic' | 'permission' | 'dashboard' | 'schedule';

export interface OmniMigrationDeliverable {
  id: string;
  kind: OmniMigrationDeliverableKind;
  sourceAssetIds: string[];
  targetId?: string;
  targetName: string;
  operation: 'create' | 'update' | 'map' | 'skip';
  dependsOn: string[];
  payload: Record<string, unknown>;
  decisionIds: string[];
}

export interface MigrationDashboardFilterPlan {
  id: string;
  label: string;
  sourceField?: string;
  targetField?: string;
  operator?: string;
  values?: string[];
  isNegative?: boolean;
  sourceEvidenceIds?: string[];
  required: boolean;
  sourceFilterType?: string;
}

export interface MigrationDashboardTilePlan {
  id: string;
  title: string;
  description?: string;
  sourceEvidenceIds: string[];
  sourceKind?: 'query' | 'text' | 'markdown' | 'image';
  migrationOutcome?: 'generated' | 'mapped' | 'redesign' | 'manual' | 'waived' | 'blocked';
  fields: string[];
  filters: string[];
  queryTopic?: string;
  queryFilters?: Array<{
    id: string;
    field: string;
    operator: string;
    values: string[];
    isNegative: boolean;
  }>;
  sorts?: Array<Record<string, unknown>>;
  limit?: number;
  pivots?: string[];
  pivotStrategy?: 'none' | 'table_query' | 'chart_series' | 'decision_required';
  filterExpression?: string;
  hiddenFields?: string[];
  calculationDependencies?: string[];
  queryOrigin?: 'inline' | 'result_maker' | 'saved_look' | 'query_id' | 'unknown';
  sourceLookId?: string;
  sourceQueryId?: string;
  sourceModel?: string;
  sourceExplore?: string;
  dynamicFields?: Array<{
    id: string;
    name: string;
    label?: string;
    category: 'group_by' | 'filtered_measure' | 'table_calculation' | 'expression' | 'unknown';
    expression?: string;
    basedOn?: string;
    filters: Record<string, string>;
    dependencies: string[];
    supportOutcome: 'automatic' | 'decision_required' | 'manual' | 'unsupported';
    config: Record<string, unknown>;
  }>;
  visualizationConfig?: Record<string, unknown>;
  layout?: { x: number; y: number; w: number; h: number };
  visualType: string;
  buildInstructions: string;
  validationAssertions: string[];
}

export interface MigrationDashboardBuildPlan {
  id: string;
  sourceDashboardId: string;
  sourceDashboardName: string;
  sourcePath?: string;
  sourceEvidenceIds: string[];
  dependencyIds: string[];
  targetName: string;
  targetFolderPath?: string;
  description?: string;
  filters: MigrationDashboardFilterPlan[];
  filterBindings?: Array<{
    id: string;
    dashboardFilterId: string;
    dashboardFilterLabel: string;
    tileId: string;
    targetField?: string;
    excluded: boolean;
  }>;
  filterOrder?: string[];
  tileOrder?: string[];
  sourceFolderPath?: string;
  sourceOwner?: string;
  sourceUpdatedAt?: string;
  sourceUsageCount?: number;
  tiles: MigrationDashboardTilePlan[];
  unsupportedFeatures: string[];
  validationAssertions: string[];
}

export interface MigrationBundle {
  schemaVersion: '1.0';
  bundleId: string;
  generatedAt: string;
  source: {
    platform: MigrationPlatformKind;
    connectionId?: string;
    selectedDashboardIds: string[];
    dependencyAssetIds: string[];
    coverageNotes: string[];
    engine?: {
      name: string;
      version: string;
      revision?: string;
      rulebookVersion: string;
      rulebookSha256?: string;
      requestId: string;
      sourceArtifactFingerprints: Array<{ name: string; sha256: string; sizeBytes: number }>;
      capabilityCoverage: Record<string, unknown>;
      untranslatableCount: number;
    };
  };
  target: {
    platform: 'omni';
    instanceId?: string;
    modelId?: string;
    modelName?: string;
    branchName: string;
    connectionMappings?: Array<{
      sourceKey: string;
      sourceName?: string;
      sourceDialect?: string;
      targetConnectionId: string;
      targetConnectionName?: string;
      targetDialect?: string;
      confidence: 'exact' | 'dialect' | 'ambiguous' | 'none';
      confirmed: boolean;
    }>;
    connectionRoutes?: Array<{
      id: string;
      targetConnectionId: string;
      targetConnectionName?: string;
      sourceKeys: string[];
      compatibleModels: Array<{ id: string; name: string }>;
      selectedModelId?: string;
      selectedModelName?: string;
      writeStatus: 'ready' | 'model_required' | 'separate_package_required';
    }>;
  };
  placement?: {
    graphSchemaVersion: CanonicalMigrationGraph['schemaVersion'];
    nodeIds: string[];
    edgeCount: number;
    decisions: ArtifactPlacementDecision[];
    transformationPackage?: TransformationPackage;
    validation?: TransformationValidationReport;
  };
  decisions: MigrationDecision[];
  semanticFiles: Array<{ fileName: SemanticYamlFileName; yaml: string }>;
  dashboardPlans: MigrationDashboardBuildPlan[];
  validationRequirements: string[];
}

export type MigrationDashboardBuildStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled';

export interface MigrationDashboardBuildItem {
  id: string;
  planId: string;
  sourceDashboardId: string;
  sourceDashboardName: string;
  status: MigrationDashboardBuildStatus;
  attempt: number;
  startedAt?: string;
  completedAt?: string;
  resultSummary?: string;
  jobId?: string;
  semanticBaselineSha256?: string;
  conversationId?: string;
  chatUrl?: string;
  dashboardUrl?: string;
  provisionalDashboardUrl?: string;
  provisionalDocumentId?: string;
  reconciliationRequired?: boolean;
  verification?: {
    documentId: string;
    modelId: string;
    documentStateVerified: true;
    semanticBranchUnchanged: true;
    verifiedAt: string;
  };
  error?: string;
}

export type MigrationRunStage =
  | 'idle'
  | 'parsing'
  | 'planning'
  | 'package'
  | 'preparing'
  | 'creating-branch'
  | 'saving'
  | 'validating'
  | 'ready'
  | 'failed';

export interface MigrationDiffLine {
  type: 'added' | 'removed' | 'unchanged';
  text: string;
}

export interface MigrationFileDiff {
  fileName: string;
  lines: MigrationDiffLine[];
}

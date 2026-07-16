export type MigrationBiSourceTool = 'looker' | 'metabase' | 'power_bi' | 'tableau' | 'domo' | 'sigma' | 'webfocus' | 'microstrategy';

export type MigrationSourceTool = MigrationBiSourceTool | 'dbt';

export type PlannedMigrationSourceTool = never;

export type MigrationPlatformKind = MigrationSourceTool | 'omni';

export type MigrationProviderKind =
  | 'omni_ai'
  | 'openai'
  | 'anthropic'
  | 'snowflake_cortex'
  | 'databricks_genie';

export type LegacyMigrationProviderKind =
  | 'databricks_model_serving'
  | 'custom_openai_compatible';

export type MigrationProjectStage =
  | 'connect'
  | 'scope'
  | 'analyze'
  | 'resolve'
  | 'review'
  | 'run'
  | 'reconcile';

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
  accountIdentifier?: string;
  warehouse?: string;
  database?: string;
  schema?: string;
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
  enabled: boolean;
  credentialMasked?: string;
  lastValidatedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MigrationProject {
  id: string;
  name: string;
  description?: string;
  sourcePlatform: MigrationPlatformKind;
  sourceConnectionId?: string;
  providerId: string;
  targetPlatform: 'omni';
  targetInstanceId: string;
  targetModelId?: string;
  stage: MigrationProjectStage;
  promptSchemaVersion: string;
  canonicalSchemaVersion: string;
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

export interface CanonicalSemanticNode {
  id: string;
  kind: 'workspace' | 'project' | 'model' | 'view' | 'field' | 'measure' | 'relationship' | 'topic' | 'data_source' | 'dataset' | 'report' | 'dashboard' | 'workbook' | 'page' | 'tile' | 'visual' | 'card' | 'cube' | 'metric' | 'attribute' | 'calculation' | 'filter' | 'permission' | 'schedule';
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

export type MigrationDecisionAction = 'map_existing' | 'create_new' | 'rewrite' | 'exclude' | 'defer';

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
  sourceArtifact?: string;
  sourceId?: string;
  sourceLocator?: string;
  sourceEvidence?: SemanticEvidenceReference[];
  sourceDatasetId?: string;
  chartType?: string;
  cardType?: string;
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
}

export type DomoManualSourceKind = 'dataset_schema' | 'beast_mode' | 'dataflow_sql' | 'relationship' | 'card';

export type DomoManualTargetKind = 'shared_model_view' | 'shared_model_measure' | 'query_view' | 'relationships_file' | 'dashboard_tile';

export interface DomoManualMapping {
  id: string;
  sourceKind: DomoManualSourceKind;
  sourceId?: string;
  sourceName: string;
  sourceArtifact: string;
  targetKind: DomoManualTargetKind;
  targetName: string;
  confidence: 'high' | 'medium' | 'low';
  dependencies: string[];
  notes: string[];
}

export interface DomoManualParseDiagnostics {
  schemaVersion: 'omnikit.domo.manual.v1';
  parsedArtifactCount: number;
  unsupportedArtifactCount: number;
  mappingCount: number;
  deduplicatedMeasureCount: number;
  conflictCount: number;
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
  kind: 'beast_mode_formula_collision';
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
}

export interface SemanticMigrationPackage {
  files: SemanticMigrationFile[];
  rawMessage: string;
  warnings: string[];
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
}

export interface MigrationDashboardTilePlan {
  id: string;
  title: string;
  description?: string;
  sourceEvidenceIds: string[];
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
      confidence: 'exact' | 'dialect';
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
  conversationId?: string;
  chatUrl?: string;
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

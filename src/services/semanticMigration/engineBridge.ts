import { buildCanonicalBiModel } from './canonical';
import type {
  CanonicalSemanticModel,
  MigrationArtifact,
  MigrationDashboardBuildPlan,
  MigrationDecision,
  MigrationField,
  MigrationInventory,
  MigrationMeasure,
  MigrationSourceTool,
  SemanticEvidenceReference,
  SemanticYamlFileName,
} from './types';
import type { SourceDashboardCatalogItem } from './studioApi';

export const MIGRATION_ENGINE_BRIDGE_SCHEMA_VERSION = 'omnikit.migration.bridge.v1' as const;
export const MIGRATION_ENGINE_RESULT_SCHEMA_VERSION = 'omnikit.migration.bundle.v1' as const;
export const MIGRATION_ENGINE_CONFORMANCE_SCHEMA_VERSION = 'omnikit.migration.conformance-run.v1' as const;

export type MigrationEngineSource = 'looker' | 'powerbi' | 'tableau' | 'metabase' | 'sigma';
export type MigrationEngineRolloutMode = 'off' | 'shadow' | 'primary';

export interface MigrationEngineConformanceResult {
  schema_version: typeof MIGRATION_ENGINE_CONFORMANCE_SCHEMA_VERSION;
  engine: { name: 'omni-migrator'; version: string };
  passed: boolean;
  sources: Record<MigrationEngineSource, {
    passed: boolean;
    manifest_sha256: string;
    expected_sha256: string;
    errors: string[];
    coverage: {
      artifacts: Record<string, 'full' | 'partial' | 'unsupported'>;
      fidelity_classes: Record<'full' | 'partial' | 'unsupported', string[]>;
    };
  }>;
}

export interface MigrationEngineControlPlaneCapabilities {
  defaultMode: MigrationEngineRolloutMode;
  sourceModes: Record<MigrationEngineSource, MigrationEngineRolloutMode>;
  requestedSourceModes: Record<MigrationEngineSource, MigrationEngineRolloutMode>;
  promotionGates: Record<MigrationEngineSource, { approved: boolean; reason: string; observationCount: number }>;
  fallback: 'native_when_available';
  observationRequired: boolean;
}

export interface MigrationEngineNote {
  object: string;
  reason: string;
  severity: 'info' | 'warning' | 'blocker';
  hint?: string | null;
}

export interface MigrationEngineEvidence {
  artifact_name?: string | null;
  artifact_sha256?: string | null;
  locator: string;
  content_sha256: string;
  role: 'direct' | 'bundle_input' | 'derived';
}

interface MigrationEngineIdentity {
  source_id: string;
  native_source_id?: string | null;
  source_locator: string;
  evidence: MigrationEngineEvidence[];
}

export interface MigrationEngineField extends MigrationEngineIdentity {
  name: string;
  source_name?: string | null;
  kind: 'dimension' | 'measure' | 'calculation' | 'parameter';
  data_type: string;
  sql?: string | null;
  aggregate?: string | null;
  value_format?: string | null;
  label?: string | null;
  description?: string | null;
  group_label?: string | null;
  hidden?: boolean;
  primary_key?: boolean;
  timeframes?: string[] | null;
  filters?: Record<string, unknown> | null;
  suggestion_list?: Array<{ value: string; label?: string }> | null;
  filter_single_select_only?: boolean;
  untranslatable: MigrationEngineNote[];
}

export interface MigrationEngineView extends MigrationEngineIdentity {
  name: string;
  source_table?: string | null;
  schema_name?: string | null;
  sql?: string | null;
  label?: string | null;
  description?: string | null;
  connection: {
    source_connection_name?: string | null;
    dialect: string;
    omni_connection_id?: string | null;
    database?: string | null;
  };
  fields: MigrationEngineField[];
  untranslatable: MigrationEngineNote[];
}

export interface MigrationEngineJoin extends MigrationEngineIdentity {
  join_from_view: string;
  join_to_view: string;
  join_type: string;
  relationship_type: string;
  on_sql: string;
  reversible: boolean;
}

export interface MigrationEngineTopic extends MigrationEngineIdentity {
  name: string;
  base_view: string;
  label?: string | null;
  description?: string | null;
  joins: MigrationEngineJoin[];
  always_where_filters?: Record<string, unknown>;
  access_filters?: Array<Record<string, unknown>>;
}

export interface MigrationEngineSemanticRequirement extends MigrationEngineIdentity {
  object_type: 'parameter' | 'filtered_measure' | 'derived_table' | 'always_filter' | 'access_filter' | 'extension' | 'refinement' | 'liquid' | 'user_attribute' | 'dynamic_field';
  name: string;
  support_outcome: 'automatic' | 'decision_required' | 'manual' | 'unsupported';
  reason: string;
  target_file_hint?: string | null;
  dependencies: string[];
  config: Record<string, unknown>;
}

export interface MigrationEngineFilter extends MigrationEngineIdentity {
  field: string;
  operator: string;
  values: string[];
  is_negative: boolean;
  label?: string | null;
  filter_type?: string | null;
  required?: boolean;
}

export interface MigrationEngineDynamicField extends MigrationEngineIdentity {
  name: string;
  label?: string | null;
  category: 'group_by' | 'filtered_measure' | 'table_calculation' | 'expression' | 'unknown';
  expression?: string | null;
  based_on?: string | null;
  filters: Record<string, string>;
  dependencies: string[];
  support_outcome: 'automatic' | 'decision_required' | 'manual' | 'unsupported';
  config: Record<string, unknown>;
}

export interface MigrationEngineFilterBinding extends MigrationEngineIdentity {
  dashboard_filter_id: string;
  dashboard_filter_label: string;
  tile_id: string;
  target_field?: string | null;
  excluded: boolean;
}

export interface MigrationEngineQuery extends MigrationEngineIdentity {
  topic: string;
  fields: string[];
  filters: MigrationEngineFilter[];
  sorts: Array<Record<string, unknown>>;
  limit?: number | null;
  pivots?: string[] | null;
  source_model?: string | null;
  source_explore?: string | null;
  filter_expression?: string | null;
  hidden_fields?: string[];
  dynamic_fields?: MigrationEngineDynamicField[];
  calculation_dependencies?: string[];
  query_origin?: 'inline' | 'result_maker' | 'saved_look' | 'query_id' | 'unknown';
  source_look_id?: string | null;
}

export interface MigrationEngineTile extends MigrationEngineIdentity {
  kind: 'query' | 'text' | 'markdown' | 'image';
  title?: string | null;
  query?: MigrationEngineQuery | null;
  chart_type?: string | null;
  vis_config: Record<string, unknown>;
  layout: { x: number; y: number; w: number; h: number };
  untranslatable: MigrationEngineNote[];
}

export interface MigrationEngineDashboard extends MigrationEngineIdentity {
  selection_aliases?: string[];
  name: string;
  tiles: MigrationEngineTile[];
  filters: MigrationEngineFilter[];
  filter_bindings?: MigrationEngineFilterBinding[];
  filter_order?: string[];
  tile_order?: string[];
  folder_path?: string | null;
  owner?: string | null;
  updated_at?: string | null;
  usage_count?: number | null;
  source_url?: string | null;
  untranslatable: MigrationEngineNote[];
}

export interface MigrationEngineConnectionMapping {
  source_key: string;
  source_name?: string | null;
  source_dialect: string;
  source_schema?: string | null;
  target_connection_id?: string | null;
  target_connection_name?: string | null;
  target_dialect?: string | null;
  target_database?: string | null;
  target_default_schema?: string | null;
  confidence: 'exact' | 'dialect' | 'ambiguous' | 'none';
  reason: string;
  candidate_ids: string[];
  candidates?: Array<{
    id: string;
    name: string;
    dialect: string;
    database?: string | null;
    default_schema?: string | null;
  }>;
  confirmed: boolean;
}

export interface MigrationConnectionRoutePlan {
  id: string;
  targetConnectionId: string;
  targetConnectionName?: string;
  sourceKeys: string[];
  compatibleModels: Array<{ id: string; name: string }>;
}

export interface MigrationEngineBundle {
  ir_version: '1' | '2';
  source: MigrationEngineSource;
  provenance: {
    run_id?: string | null;
    extracted_at?: string | null;
    source_artifact?: string | null;
    tool_version: string;
  };
  acquisition?: {
    contract_version: string;
    mode: 'manual' | 'api' | 'unknown';
    project_ids: string[];
    dashboard_ids: string[];
    look_ids: string[];
    query_ids: string[];
    source_files: string[];
    required_files: string[];
    unrelated_files: string[];
    dependencies: Array<{
      kind: 'model' | 'include' | 'explore' | 'view' | 'extension' | 'refinement' | 'manifest_dependency' | 'constant';
      reference: string;
      source_file?: string | null;
      status: 'resolved' | 'missing' | 'review';
      required: boolean;
      matched_files: string[];
      affected_dashboard_ids: string[];
      message: string;
    }>;
    saved_look_coverage: 'not_evaluated' | 'not_applicable' | 'complete' | 'partial' | 'blocked';
    dependency_closure_status: 'not_evaluated' | 'not_applicable' | 'complete' | 'partial' | 'blocked';
    source_query_validation_status: 'not_evaluated' | 'not_applicable' | 'complete' | 'partial' | 'blocked';
    diagnostics: string[];
  } | null;
  model: {
    views: MigrationEngineView[];
    topics: MigrationEngineTopic[];
    requirements?: MigrationEngineSemanticRequirement[];
    untranslatable: MigrationEngineNote[];
  };
  dashboards: MigrationEngineDashboard[];
}

export interface MigrationEngineBridgeResult {
  schema_version: typeof MIGRATION_ENGINE_RESULT_SCHEMA_VERSION;
  request_id: string;
  engine: { name: string; version: string; revision?: string };
  source: MigrationEngineSource;
  mode: 'manual' | 'api';
  provenance: {
    source_artifacts: string[];
    source_artifact_fingerprints?: Array<{ name: string; sha256: string; size_bytes: number }>;
    source_artifact_count: number;
    ir_version: string;
  };
  capability_coverage: Record<string, unknown>;
  bundle: MigrationEngineBundle;
  connection_mappings?: MigrationEngineConnectionMapping[];
  model_suggestions: Array<{
    path: string;
    content: string;
    sha256: string;
    parser_version: string;
    rulebook_version: string;
    rulebook_sha256: string;
    confidence: number;
    severity: 'info' | 'warning' | 'blocker';
    source_ids: string[];
    evidence: MigrationEngineEvidence[];
  }>;
  diagnostics: {
    view_count: number;
    topic_count: number;
    dashboard_count: number;
    field_count: number;
    untranslatable_count: number;
    source_artifact_count: number;
    limitations: string[];
    rulebook_version: string;
    rulebook_sha256: string;
    acquisition_contract_version?: string | null;
    saved_look_coverage?: string | null;
    dependency_closure_status?: string | null;
    source_query_validation_status?: string | null;
  };
  control_plane?: {
    rollout_mode: MigrationEngineRolloutMode;
    queue_wait_ms: number;
    duration_ms: number;
    fallback: 'native_when_available';
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringHasUnsafeControlText(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x1b
      || code <= 0x08
      || code >= 0x0b && code <= 0x0c
      || code >= 0x0e && code <= 0x1f
      || code === 0x7f) return true;
  }
  return false;
}

function hasUnsafeControlText(value: unknown): boolean {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === 'string' && stringHasUnsafeControlText(current)) return true;
    if (Array.isArray(current)) pending.push(...current);
    else if (isRecord(current)) pending.push(...Object.values(current));
  }
  return false;
}

function validSuggestionPath(value: unknown): value is string {
  if (value === 'model' || value === 'relationships') return true;
  if (typeof value !== 'string' || !value.endsWith('.view') && !value.endsWith('.topic')) return false;
  if (value.startsWith('/') || value.includes('\\') || value.includes('\0')) return false;
  return value.split('/').every((segment) => segment !== '.'
    && segment !== '..'
    && /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(segment));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function parseMigrationEngineConformanceResult(
  value: unknown,
  expectedSources: MigrationEngineSource[] = ['looker', 'powerbi', 'tableau', 'metabase', 'sigma'],
): MigrationEngineConformanceResult {
  if (hasUnsafeControlText(value)) {
    throw new Error('Migration engine conformance output contains unsafe control characters.');
  }
  if (!isRecord(value)
    || value.schema_version !== MIGRATION_ENGINE_CONFORMANCE_SCHEMA_VERSION
    || typeof value.passed !== 'boolean'
    || !isRecord(value.engine)
    || value.engine.name !== 'omni-migrator'
    || typeof value.engine.version !== 'string'
    || !isRecord(value.sources)) {
    throw new Error('Migration engine conformance result is missing its trusted schema or engine identity.');
  }
  const sources = value.sources;
  if (Object.keys(sources).some((source) => !['looker', 'powerbi', 'tableau', 'metabase', 'sigma'].includes(source))
    || expectedSources.some((source) => !isRecord(sources[source]))) {
    throw new Error('Migration engine conformance result does not cover the expected sources.');
  }
  for (const source of expectedSources) {
    const evidence = sources[source] as Record<string, unknown>;
    if (typeof evidence.passed !== 'boolean'
      || !/^[a-f0-9]{64}$/i.test(String(evidence.manifest_sha256))
      || !/^[a-f0-9]{64}$/i.test(String(evidence.expected_sha256))
      || !Array.isArray(evidence.errors)
      || evidence.errors.some((item) => typeof item !== 'string')
      || !isRecord(evidence.coverage)) {
      throw new Error(`Migration engine conformance evidence for ${source} is invalid.`);
    }
    const artifacts = isRecord(evidence.coverage.artifacts) ? evidence.coverage.artifacts : null;
    const classes = isRecord(evidence.coverage.fidelity_classes) ? evidence.coverage.fidelity_classes : null;
    if (!artifacts
      || Object.values(artifacts).some((item) => !['full', 'partial', 'unsupported'].includes(String(item)))
      || !classes
      || ['full', 'partial', 'unsupported'].some((level) => !Array.isArray(classes[level]) || (classes[level] as unknown[]).some((item) => typeof item !== 'string'))) {
      throw new Error(`Migration engine fidelity classification for ${source} is invalid.`);
    }
    if (evidence.passed && (evidence.manifest_sha256 !== evidence.expected_sha256 || evidence.errors.length > 0)) {
      throw new Error(`Migration engine conformance evidence for ${source} claims success with mismatched contracts.`);
    }
  }
  const selectedPassed = expectedSources.every((source) => (sources[source] as Record<string, unknown>).passed === true);
  if (value.passed !== selectedPassed) {
    throw new Error('Migration engine conformance rollup does not match its source results.');
  }
  return value as unknown as MigrationEngineConformanceResult;
}

function validEvidence(value: unknown): value is MigrationEngineEvidence {
  return isRecord(value)
    && typeof value.locator === 'string'
    && Boolean(value.locator.trim())
    && /^[a-f0-9]{64}$/i.test(String(value.content_sha256))
    && ['direct', 'bundle_input', 'derived'].includes(String(value.role))
    && (value.artifact_name === undefined || value.artifact_name === null || typeof value.artifact_name === 'string')
    && (value.artifact_sha256 === undefined || value.artifact_sha256 === null || /^[a-f0-9]{64}$/i.test(String(value.artifact_sha256)));
}

function validIdentity(value: unknown): value is Record<string, unknown> & MigrationEngineIdentity {
  return isRecord(value)
    && typeof value.source_id === 'string'
    && Boolean(value.source_id.trim())
    && (value.native_source_id === undefined || value.native_source_id === null || (typeof value.native_source_id === 'string' && Boolean(value.native_source_id.trim())))
    && typeof value.source_locator === 'string'
    && Boolean(value.source_locator.trim())
    && Array.isArray(value.evidence)
    && value.evidence.length > 0
    && value.evidence.every(validEvidence);
}

function validNote(value: unknown): value is MigrationEngineNote {
  return isRecord(value)
    && typeof value.object === 'string'
    && typeof value.reason === 'string'
    && ['info', 'warning', 'blocker'].includes(String(value.severity));
}

function validNotes(value: unknown): value is MigrationEngineNote[] {
  return Array.isArray(value) && value.every(validNote);
}

function validFilter(value: unknown): value is MigrationEngineFilter {
  return validIdentity(value)
    && typeof value.field === 'string'
    && typeof value.operator === 'string'
    && Array.isArray(value.values)
    && value.values.every((item) => typeof item === 'string')
    && typeof value.is_negative === 'boolean'
    && (value.required === undefined || typeof value.required === 'boolean');
}

function validDynamicField(value: unknown): value is MigrationEngineDynamicField {
  return validIdentity(value)
    && typeof value.name === 'string'
    && ['group_by', 'filtered_measure', 'table_calculation', 'expression', 'unknown'].includes(String(value.category))
    && ['automatic', 'decision_required', 'manual', 'unsupported'].includes(String(value.support_outcome))
    && isRecord(value.filters)
    && Object.values(value.filters).every((item) => typeof item === 'string')
    && Array.isArray(value.dependencies)
    && value.dependencies.every((item) => typeof item === 'string')
    && isRecord(value.config);
}

function validFilterBinding(value: unknown): value is MigrationEngineFilterBinding {
  return validIdentity(value)
    && typeof value.dashboard_filter_id === 'string'
    && typeof value.dashboard_filter_label === 'string'
    && typeof value.tile_id === 'string'
    && (value.target_field === undefined || value.target_field === null || typeof value.target_field === 'string')
    && typeof value.excluded === 'boolean';
}

function validQuery(value: unknown): value is MigrationEngineQuery {
  return validIdentity(value)
    && typeof value.topic === 'string'
    && Array.isArray(value.fields)
    && value.fields.every((item) => typeof item === 'string')
    && Array.isArray(value.filters)
    && value.filters.every(validFilter)
    && Array.isArray(value.sorts)
    && value.sorts.every(isRecord)
    && (value.limit === undefined || value.limit === null || (typeof value.limit === 'number' && Number.isFinite(value.limit)))
    && (value.pivots === undefined || value.pivots === null || (Array.isArray(value.pivots) && value.pivots.every((item) => typeof item === 'string')))
    && (value.hidden_fields === undefined || (Array.isArray(value.hidden_fields) && value.hidden_fields.every((item) => typeof item === 'string')))
    && (value.dynamic_fields === undefined || (Array.isArray(value.dynamic_fields) && value.dynamic_fields.every(validDynamicField)))
    && (value.calculation_dependencies === undefined || (Array.isArray(value.calculation_dependencies) && value.calculation_dependencies.every((item) => typeof item === 'string')))
    && (value.query_origin === undefined || ['inline', 'result_maker', 'saved_look', 'query_id', 'unknown'].includes(String(value.query_origin)))
    && (value.source_look_id === undefined || value.source_look_id === null || typeof value.source_look_id === 'string');
}

function validField(value: unknown): value is MigrationEngineField {
  return validIdentity(value)
    && typeof value.name === 'string'
    && ['dimension', 'measure', 'calculation', 'parameter'].includes(String(value.kind))
    && typeof value.data_type === 'string'
    && (value.timeframes === undefined || value.timeframes === null || (Array.isArray(value.timeframes) && value.timeframes.every((item) => typeof item === 'string')))
    && (value.filters === undefined || value.filters === null || isRecord(value.filters))
    && (value.suggestion_list === undefined || value.suggestion_list === null || (Array.isArray(value.suggestion_list) && value.suggestion_list.every((item) => isRecord(item) && typeof item.value === 'string' && (item.label === undefined || typeof item.label === 'string'))))
    && (value.filter_single_select_only === undefined || typeof value.filter_single_select_only === 'boolean')
    && validNotes(value.untranslatable);
}

function validView(value: unknown): value is MigrationEngineView {
  return validIdentity(value)
    && typeof value.name === 'string'
    && isRecord(value.connection)
    && typeof value.connection.dialect === 'string'
    && Array.isArray(value.fields)
    && value.fields.every(validField)
    && validNotes(value.untranslatable);
}

function validJoin(value: unknown): value is MigrationEngineJoin {
  return validIdentity(value)
    && typeof value.join_from_view === 'string'
    && typeof value.join_to_view === 'string'
    && typeof value.join_type === 'string'
    && typeof value.relationship_type === 'string'
    && typeof value.on_sql === 'string'
    && typeof value.reversible === 'boolean';
}

function validTopic(value: unknown): value is MigrationEngineTopic {
  return validIdentity(value)
    && typeof value.name === 'string'
    && typeof value.base_view === 'string'
    && Array.isArray(value.joins)
    && value.joins.every(validJoin)
    && (value.always_where_filters === undefined || isRecord(value.always_where_filters))
    && (value.access_filters === undefined || (Array.isArray(value.access_filters) && value.access_filters.every(isRecord)));
}

function validSemanticRequirement(value: unknown): value is MigrationEngineSemanticRequirement {
  return validIdentity(value)
    && ['parameter', 'filtered_measure', 'derived_table', 'always_filter', 'access_filter', 'extension', 'refinement', 'liquid', 'user_attribute', 'dynamic_field'].includes(String(value.object_type))
    && typeof value.name === 'string'
    && ['automatic', 'decision_required', 'manual', 'unsupported'].includes(String(value.support_outcome))
    && typeof value.reason === 'string'
    && (value.target_file_hint === undefined || value.target_file_hint === null || typeof value.target_file_hint === 'string')
    && Array.isArray(value.dependencies)
    && value.dependencies.every((item) => typeof item === 'string')
    && isRecord(value.config);
}

function validTile(value: unknown): value is MigrationEngineTile {
  if (!validIdentity(value) || !isRecord(value.layout)) return false;
  const layout = value.layout;
  return validIdentity(value)
    && ['query', 'text', 'markdown', 'image'].includes(String(value.kind))
    && (value.query === undefined || value.query === null || validQuery(value.query))
    && isRecord(value.vis_config)
    && ['x', 'y', 'w', 'h'].every((key) => typeof layout[key] === 'number')
    && validNotes(value.untranslatable);
}

function validDashboard(value: unknown): value is MigrationEngineDashboard {
  return validIdentity(value)
    && (value.selection_aliases === undefined || (Array.isArray(value.selection_aliases) && value.selection_aliases.every((item) => typeof item === 'string' && Boolean(item.trim()))))
    && typeof value.name === 'string'
    && Array.isArray(value.tiles)
    && value.tiles.every(validTile)
    && Array.isArray(value.filters)
    && value.filters.every(validFilter)
    && (value.filter_bindings === undefined || (Array.isArray(value.filter_bindings) && value.filter_bindings.every(validFilterBinding)))
    && (value.filter_order === undefined || (Array.isArray(value.filter_order) && value.filter_order.every((item) => typeof item === 'string')))
    && (value.tile_order === undefined || (Array.isArray(value.tile_order) && value.tile_order.every((item) => typeof item === 'string')))
    && validNotes(value.untranslatable);
}

function validConnectionMapping(value: unknown): value is MigrationEngineConnectionMapping {
  return isRecord(value)
    && typeof value.source_key === 'string'
    && Boolean(value.source_key.trim())
    && typeof value.source_dialect === 'string'
    && ['exact', 'dialect', 'ambiguous', 'none'].includes(String(value.confidence))
    && typeof value.reason === 'string'
    && Array.isArray(value.candidate_ids)
    && value.candidate_ids.every((item) => typeof item === 'string' && Boolean(item.trim()))
    && (value.candidates === undefined || (Array.isArray(value.candidates) && value.candidates.every((candidate) => isRecord(candidate)
      && typeof candidate.id === 'string' && Boolean(candidate.id.trim())
      && typeof candidate.name === 'string' && Boolean(candidate.name.trim())
      && typeof candidate.dialect === 'string')))
    && typeof value.confirmed === 'boolean'
    && (value.target_connection_id === undefined || value.target_connection_id === null || typeof value.target_connection_id === 'string')
    && (value.target_connection_name === undefined || value.target_connection_name === null || typeof value.target_connection_name === 'string')
    && (value.target_dialect === undefined || value.target_dialect === null || typeof value.target_dialect === 'string');
}

function validAcquisitionEvidence(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  const coverage = ['not_evaluated', 'not_applicable', 'complete', 'partial', 'blocked'];
  return isRecord(value)
    && typeof value.contract_version === 'string'
    && Boolean(value.contract_version.trim())
    && ['manual', 'api', 'unknown'].includes(String(value.mode))
    && ['project_ids', 'dashboard_ids', 'look_ids', 'query_ids', 'source_files', 'required_files', 'unrelated_files', 'diagnostics']
      .every((key) => Array.isArray(value[key]) && (value[key] as unknown[]).every((item) => typeof item === 'string'))
    && Array.isArray(value.dependencies)
    && value.dependencies.every((item) => isRecord(item)
      && ['model', 'include', 'explore', 'view', 'extension', 'refinement', 'manifest_dependency', 'constant'].includes(String(item.kind))
      && typeof item.reference === 'string'
      && ['resolved', 'missing', 'review'].includes(String(item.status))
      && typeof item.required === 'boolean'
      && Array.isArray(item.matched_files) && item.matched_files.every((entry) => typeof entry === 'string')
      && Array.isArray(item.affected_dashboard_ids) && item.affected_dashboard_ids.every((entry) => typeof entry === 'string')
      && typeof item.message === 'string')
    && coverage.includes(String(value.saved_look_coverage))
    && coverage.includes(String(value.dependency_closure_status))
    && coverage.includes(String(value.source_query_validation_status));
}

export function buildMigrationConnectionRoutes(
  mappings: MigrationEngineConnectionMapping[],
  models: Array<{ id: string; name: string; connectionId?: string }>,
): MigrationConnectionRoutePlan[] {
  const grouped = new Map<string, MigrationConnectionRoutePlan>();
  mappings.forEach((mapping) => {
    const targetConnectionId = mapping.target_connection_id?.trim();
    if (!targetConnectionId) return;
    const current = grouped.get(targetConnectionId);
    const targetConnectionName = mapping.target_connection_name
      || mapping.candidates?.find((candidate) => candidate.id === targetConnectionId)?.name;
    grouped.set(targetConnectionId, {
      id: `connection-route:${targetConnectionId}`,
      targetConnectionId,
      targetConnectionName,
      sourceKeys: Array.from(new Set([...(current?.sourceKeys || []), mapping.source_key])).sort(),
      compatibleModels: models.filter((model) => model.connectionId === targetConnectionId).map((model) => ({ id: model.id, name: model.name })),
    });
  });
  return Array.from(grouped.values()).sort((left, right) => (left.targetConnectionName || left.targetConnectionId).localeCompare(right.targetConnectionName || right.targetConnectionId));
}

export function parseMigrationEngineBridgeResult(value: unknown): MigrationEngineBridgeResult {
  if (hasUnsafeControlText(value)) {
    throw new Error('Migration engine output contains unsafe control characters.');
  }
  if (!isRecord(value) || value.schema_version !== MIGRATION_ENGINE_RESULT_SCHEMA_VERSION) {
    throw new Error(`Unsupported migration engine result. Expected ${MIGRATION_ENGINE_RESULT_SCHEMA_VERSION}.`);
  }
  if (!isRecord(value.engine) || value.engine.name !== 'omni-migrator' || typeof value.engine.version !== 'string') {
    throw new Error('Migration engine identity is missing or invalid.');
  }
  if (typeof value.request_id !== 'string' || !value.request_id.trim() || !['looker', 'powerbi', 'tableau', 'metabase', 'sigma'].includes(String(value.source)) || !['manual', 'api'].includes(String(value.mode))) {
    throw new Error('Migration engine request identity, source, or mode is invalid.');
  }
  if (!isRecord(value.bundle) || !['1', '2'].includes(String(value.bundle.ir_version)) || value.bundle.source !== value.source || !isRecord(value.bundle.provenance) || typeof value.bundle.provenance.tool_version !== 'string' || !validAcquisitionEvidence(value.bundle.acquisition) || !isRecord(value.bundle.model) || !Array.isArray(value.bundle.model.views) || !value.bundle.model.views.every(validView) || !Array.isArray(value.bundle.model.topics) || !value.bundle.model.topics.every(validTopic) || (value.bundle.model.requirements !== undefined && (!Array.isArray(value.bundle.model.requirements) || !value.bundle.model.requirements.every(validSemanticRequirement))) || !validNotes(value.bundle.model.untranslatable) || !Array.isArray(value.bundle.dashboards) || !value.bundle.dashboards.every(validDashboard)) {
    throw new Error('Migration engine result does not contain a complete canonical bundle.');
  }
  if (!Array.isArray(value.model_suggestions) || !isRecord(value.diagnostics) || !isRecord(value.capability_coverage)) {
    throw new Error('Migration engine result is missing suggestions or diagnostics.');
  }
  if (value.connection_mappings !== undefined && (!Array.isArray(value.connection_mappings) || !value.connection_mappings.every(validConnectionMapping))) {
    throw new Error('Migration engine connection mappings are invalid.');
  }
  if (!isRecord(value.provenance) || !Array.isArray(value.provenance.source_artifacts) || typeof value.provenance.source_artifact_count !== 'number' || typeof value.provenance.ir_version !== 'string') {
    throw new Error('Migration engine provenance is missing or invalid.');
  }
  if (value.provenance.source_artifact_fingerprints !== undefined && (!Array.isArray(value.provenance.source_artifact_fingerprints) || value.provenance.source_artifact_fingerprints.some((item) => !isRecord(item) || typeof item.name !== 'string' || !/^[a-f0-9]{64}$/i.test(String(item.sha256)) || typeof item.size_bytes !== 'number'))) {
    throw new Error('Migration engine artifact fingerprints are invalid.');
  }
  if (value.model_suggestions.some((item) => !isRecord(item)
    || !validSuggestionPath(item.path)
    || typeof item.content !== 'string'
    || !/^[a-f0-9]{64}$/i.test(String(item.sha256))
    || typeof item.parser_version !== 'string'
    || typeof item.rulebook_version !== 'string'
    || !/^[a-f0-9]{64}$/i.test(String(item.rulebook_sha256))
    || typeof item.confidence !== 'number'
    || item.confidence < 0
    || item.confidence > 1
    || !['info', 'warning', 'blocker'].includes(String(item.severity))
    || !Array.isArray(item.source_ids)
    || item.source_ids.some((sourceId) => typeof sourceId !== 'string' || !sourceId.trim())
    || !Array.isArray(item.evidence)
    || item.evidence.some((evidence) => !validEvidence(evidence)))) {
    throw new Error('Migration engine suggestions are invalid.');
  }
  if (typeof value.diagnostics.rulebook_version !== 'string' || !value.diagnostics.rulebook_version.trim() || !/^[a-f0-9]{64}$/i.test(String(value.diagnostics.rulebook_sha256)) || typeof value.diagnostics.untranslatable_count !== 'number') {
    throw new Error('Migration engine diagnostics are missing rulebook or review counts.');
  }
  if (value.control_plane !== undefined && (!isRecord(value.control_plane)
    || !['off', 'shadow', 'primary'].includes(String(value.control_plane.rollout_mode))
    || typeof value.control_plane.queue_wait_ms !== 'number'
    || value.control_plane.queue_wait_ms < 0
    || typeof value.control_plane.duration_ms !== 'number'
    || value.control_plane.duration_ms < 0
    || value.control_plane.fallback !== 'native_when_available')) {
    throw new Error('Migration engine control-plane telemetry is invalid.');
  }
  return value as unknown as MigrationEngineBridgeResult;
}

export function migrationEngineControlPlaneFromCapabilities(value: unknown): MigrationEngineControlPlaneCapabilities | null {
  if (!isRecord(value) || !isRecord(value.control_plane)) return null;
  const controlPlane = value.control_plane;
  if (!['off', 'shadow', 'primary'].includes(String(controlPlane.defaultMode))
    || !isRecord(controlPlane.sourceModes)
    || controlPlane.fallback !== 'native_when_available'
    || typeof controlPlane.observationRequired !== 'boolean') return null;
  const sourceModes = controlPlane.sourceModes;
  const requestedSourceModes = controlPlane.requestedSourceModes;
  const promotionGates = controlPlane.promotionGates;
  if (!isRecord(requestedSourceModes) || !isRecord(promotionGates) || ['looker', 'powerbi', 'tableau', 'metabase', 'sigma'].some((source) => {
    const gate = promotionGates[source];
    return !['off', 'shadow', 'primary'].includes(String(sourceModes[source]))
      || !['off', 'shadow', 'primary'].includes(String(requestedSourceModes[source]))
      || !isRecord(gate)
      || typeof gate.approved !== 'boolean'
      || typeof gate.reason !== 'string'
      || typeof gate.observationCount !== 'number';
  })) return null;
  return controlPlane as unknown as MigrationEngineControlPlaneCapabilities;
}

export function migrationEngineResultForRollout(
  mode: MigrationEngineRolloutMode,
  result: MigrationEngineBridgeResult | null,
): MigrationEngineBridgeResult | null {
  return mode === 'primary' ? result : null;
}

function evidenceFromEngine(identity: MigrationEngineIdentity): SemanticEvidenceReference[] {
  return identity.evidence.map((item) => ({
    sourceId: identity.source_id,
    artifactId: item.artifact_name || undefined,
    locator: item.locator,
    artifactSha256: item.artifact_sha256 || undefined,
    contentSha256: item.content_sha256,
    role: item.role,
  }));
}

function omniKitSource(source: MigrationEngineSource): MigrationSourceTool {
  return source === 'powerbi' ? 'power_bi' : source;
}

function sourceArtifact(result: MigrationEngineBridgeResult): string | undefined {
  return result.provenance.source_artifacts.join(', ') || result.bundle.provenance.source_artifact || undefined;
}

function fieldFromEngine(field: MigrationEngineField, artifact?: string): MigrationField {
  const filters = field.filters && Object.values(field.filters).every(isRecord)
    ? field.filters as Record<string, Record<string, unknown>>
    : undefined;
  return {
    sourceId: field.source_id,
    sourceLocator: field.source_locator,
    sourceEvidence: evidenceFromEngine(field),
    name: field.name,
    type: field.data_type,
    sql: field.sql || undefined,
    sourceColumn: field.source_name || undefined,
    description: field.description || undefined,
    label: field.label || undefined,
    groupLabel: field.group_label || undefined,
    formatString: field.value_format || undefined,
    hidden: field.hidden,
    primaryKey: field.primary_key,
    timeframes: field.timeframes || undefined,
    filters,
    untranslatable: noteText(field.untranslatable),
    sourceArtifact: artifact,
  };
}

function measureFromEngine(field: MigrationEngineField, artifact?: string): MigrationMeasure {
  return {
    ...fieldFromEngine(field, artifact),
    aggregateType: field.aggregate || undefined,
    originalName: field.source_name || undefined,
  };
}

function noteText(notes: MigrationEngineNote[]): string[] {
  return notes.map((note) => `${note.severity.toUpperCase()}: ${note.object} - ${note.reason}${note.hint ? ` (${note.hint})` : ''}`);
}

function fieldIdentityLookup(result: MigrationEngineBridgeResult): Map<string, string> {
  const candidates = new Map<string, Set<string>>();
  const add = (key: string, sourceId: string) => {
    const normalized = key.trim().toLowerCase();
    if (!normalized) return;
    const values = candidates.get(normalized) || new Set<string>();
    values.add(sourceId);
    candidates.set(normalized, values);
  };
  result.bundle.model.views.forEach((view) => view.fields.forEach((field) => {
    add(field.name, field.source_id);
    add(field.source_name || '', field.source_id);
    add(`${view.name}.${field.name}`, field.source_id);
    add(`${view.name}.${field.source_name || field.name}`, field.source_id);
  }));
  return new Map(Array.from(candidates.entries()).flatMap(([key, values]) => values.size === 1 ? [[key, Array.from(values)[0]!]] : []));
}

function unresolvedFieldIdentity(source: MigrationEngineSource, field: string): string {
  return `engine-field-ref:${source}:${field.trim().toLowerCase().replace(/[^a-z0-9_.:-]+/g, '_')}`;
}

function fieldIdentity(result: MigrationEngineBridgeResult, lookup: Map<string, string>, field: string): string {
  return lookup.get(field.trim().toLowerCase()) || unresolvedFieldIdentity(result.source, field);
}

function engineIdentity(result: MigrationEngineBridgeResult): string {
  const revision = result.engine.revision ? ` @ ${result.engine.revision.slice(0, 12)}` : '';
  return `${result.engine.name} ${result.engine.version}${revision} · rulebook ${result.diagnostics.rulebook_version}`;
}

export function migrationInventoryFromEngine(
  result: MigrationEngineBridgeResult,
  artifacts: MigrationArtifact[] = [],
): MigrationInventory {
  const artifact = sourceArtifact(result);
  const relationships = result.bundle.model.topics.flatMap((topic) => topic.joins.map((join) => ({
    sourceId: join.source_id,
    sourceLocator: join.source_locator,
    sourceEvidence: evidenceFromEngine(join),
    from: join.join_from_view,
    to: join.join_to_view,
    joinType: join.join_type,
    relationshipType: join.relationship_type,
    sql: join.on_sql,
    sourceArtifact: artifact,
  })));
  const views = result.bundle.model.views.map((view) => {
    const measures = view.fields.filter((field) => field.kind === 'measure').map((field) => measureFromEngine(field, artifact));
    return {
      sourceId: view.source_id,
      sourceLocator: view.source_locator,
      sourceEvidence: evidenceFromEngine(view),
      name: view.name,
      label: view.label || undefined,
      description: view.description || undefined,
      sourceArtifact: artifact,
      sql: view.sql || undefined,
      fields: view.fields.filter((field) => field.kind !== 'measure').map((field) => fieldFromEngine(field, artifact)),
      measures,
      warnings: [
        ...noteText(view.untranslatable),
        ...view.fields.flatMap((field) => noteText(field.untranslatable)),
      ],
    };
  });
  const dashboards = result.bundle.dashboards.map((dashboard) => ({
    name: dashboard.name,
    sourceArtifact: artifact,
    sourceId: dashboard.source_id,
    sourceLocator: dashboard.source_locator,
    sourceEvidence: evidenceFromEngine(dashboard),
    fields: Array.from(new Set(dashboard.tiles.flatMap((tile) => queryDependencyFields(tile.query)))),
    filters: Array.from(new Set([
      ...dashboard.filters.map((filter) => filter.field),
      ...dashboard.tiles.flatMap((tile) => tile.query?.filters.map((filter) => filter.field) || []),
    ])),
    chartType: Array.from(new Set(dashboard.tiles.map((tile) => tile.chart_type).filter(Boolean))).join(', ') || undefined,
  }));
  const warnings = Array.from(new Set([
    ...result.diagnostics.limitations,
    ...noteText(result.bundle.model.untranslatable),
    ...result.bundle.model.views.flatMap((view) => view.fields.flatMap((field) => noteText(field.untranslatable))),
    ...result.bundle.dashboards.flatMap((dashboard) => noteText(dashboard.untranslatable)),
    ...result.bundle.dashboards.flatMap((dashboard) => dashboard.tiles.flatMap((tile) => noteText(tile.untranslatable))),
  ]));
  return {
    sourceTool: omniKitSource(result.source),
    artifactCount: artifacts.length || result.provenance.source_artifact_count,
    artifacts,
    views,
    explores: result.bundle.model.topics.map((topic) => ({
      sourceId: topic.source_id,
      sourceLocator: topic.source_locator,
      sourceEvidence: evidenceFromEngine(topic),
      name: topic.name,
      baseView: topic.base_view,
      joins: topic.joins.map((join) => ({
        sourceId: join.source_id,
        sourceLocator: join.source_locator,
        sourceEvidence: evidenceFromEngine(join),
        from: join.join_from_view,
        to: join.join_to_view,
        joinType: join.join_type,
        relationshipType: join.relationship_type,
        sql: join.on_sql,
        sourceArtifact: artifact,
      })),
      fields: [],
      filters: [],
      sourceArtifact: artifact,
    })),
    relationships,
    dashboards,
    metrics: views.flatMap((view) => view.measures),
    warnings,
    summary: `${engineIdentity(result)} · ${views.length} views · ${result.bundle.model.topics.length} topics · ${dashboards.length} dashboards · ${result.diagnostics.untranslatable_count} review items`,
  };
}

function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const values = new Map<string, T>();
  items.forEach((item) => values.set(key(item), item));
  return Array.from(values.values());
}

function queryDependencyFields(query?: MigrationEngineQuery | null): string[] {
  if (!query) return [];
  return Array.from(new Set([
    ...query.fields,
    ...(query.hidden_fields || []),
    ...(query.calculation_dependencies || []),
    ...(query.dynamic_fields || []).flatMap((field) => field.dependencies),
  ].filter(Boolean)));
}

export function mergeMigrationEngineInventory(
  result: MigrationEngineBridgeResult,
  fallback: MigrationInventory,
): MigrationInventory {
  const engine = migrationInventoryFromEngine(result, fallback.artifacts);
  return {
    ...fallback,
    sourceTool: engine.sourceTool,
    artifactCount: Math.max(fallback.artifactCount, engine.artifactCount),
    views: dedupeBy([...fallback.views, ...engine.views], (view) => view.name.toLowerCase()),
    explores: dedupeBy([...fallback.explores, ...engine.explores], (explore) => explore.name.toLowerCase()),
    relationships: dedupeBy([...fallback.relationships, ...engine.relationships], (relationship) => `${relationship.from}:${relationship.to}:${relationship.sql || ''}`),
    dashboards: dedupeBy([...fallback.dashboards, ...engine.dashboards], (dashboard) => `${dashboard.sourceId || ''}:${dashboard.name.toLowerCase()}`),
    metrics: dedupeBy([...fallback.metrics, ...engine.metrics], (metric) => `${metric.sourceId || ''}:${metric.name.toLowerCase()}`),
    warnings: Array.from(new Set([...fallback.warnings, ...engine.warnings])),
    summary: engine.summary,
  };
}

export function sourceDashboardCatalogFromEngine(result: MigrationEngineBridgeResult): SourceDashboardCatalogItem[] {
  const lookup = fieldIdentityLookup(result);
  const nativeIdCounts = new Map<string, number>();
  result.bundle.dashboards.forEach((dashboard) => {
    if (dashboard.native_source_id) nativeIdCounts.set(dashboard.native_source_id, (nativeIdCounts.get(dashboard.native_source_id) || 0) + 1);
  });
  return result.bundle.dashboards.map((dashboard) => {
    const notes = [
      ...noteText(dashboard.untranslatable),
      ...dashboard.tiles.flatMap((tile) => noteText(tile.untranslatable)),
    ];
    const dependencyFields = Array.from(new Set(dashboard.tiles.flatMap((tile) => queryDependencyFields(tile.query)))).sort();
    const dependencyIds = dependencyFields.map((field) => fieldIdentity(result, lookup, field));
    const sourceId = dashboard.native_source_id && nativeIdCounts.get(dashboard.native_source_id) === 1
      ? dashboard.native_source_id
      : dashboard.source_id;
    const selectionAliases = Array.from(new Set([
      dashboard.source_id,
      dashboard.native_source_id,
      ...(dashboard.selection_aliases || []),
    ].filter((item): item is string => Boolean(item))));
    return {
      id: sourceId,
      canonicalSourceId: dashboard.source_id,
      selectionAliases,
      name: dashboard.name,
      kind: 'dashboard',
      path: dashboard.source_url || undefined,
      dependencyIds,
      dependencies: dependencyFields.map((field, index) => ({
        assetId: dependencyIds[index]!,
        name: field,
        kind: 'calculation',
        category: 'field',
        required: true,
        reason: 'Referenced by the deterministic dashboard query evidence.',
      })),
      dependencyCounts: { field: dependencyIds.length },
      complexity: dashboard.tiles.length > 12 ? 'high' : dashboard.tiles.length > 5 ? 'medium' : 'low',
      coverage: notes.length > 0 ? 'partial' : 'complete',
      coverageNotes: notes.length > 0 ? notes : ['The deterministic engine resolved every emitted tile and filter in this dashboard.'],
      riskFlags: notes,
    };
  });
}

export function reconcileEngineDashboardSelection(
  selectedIds: string[],
  previousCatalog: SourceDashboardCatalogItem[],
  nextCatalog: SourceDashboardCatalogItem[],
): string[] {
  if (selectedIds.length === 0 || nextCatalog.length === 0) return [];
  const selected = new Set(selectedIds);
  const previousIdentities = new Set<string>();
  previousCatalog.forEach((dashboard) => {
    if (!selected.has(dashboard.id)) return;
    [dashboard.id, dashboard.canonicalSourceId, ...(dashboard.selectionAliases || [])]
      .filter((item): item is string => Boolean(item))
      .forEach((item) => previousIdentities.add(item));
  });
  selectedIds.forEach((id) => previousIdentities.add(id));
  return nextCatalog.filter((dashboard) => [
    dashboard.id,
    dashboard.canonicalSourceId,
    ...(dashboard.selectionAliases || []),
  ].some((identity) => identity && previousIdentities.has(identity))).map((dashboard) => dashboard.id);
}

function semanticFileName(path: string): SemanticYamlFileName | null {
  if (validSuggestionPath(path)) return path as SemanticYamlFileName;
  return null;
}

function semanticRequirementDecisionType(
  objectType: MigrationEngineSemanticRequirement['object_type'],
): Pick<MigrationDecision, 'domain' | 'semanticKind'> {
  if (objectType === 'parameter' || objectType === 'always_filter') return { domain: 'filter', semanticKind: 'filter' };
  if (objectType === 'filtered_measure') return { domain: 'measure', semanticKind: 'measure' };
  if (objectType === 'access_filter' || objectType === 'user_attribute') return { domain: 'permission', semanticKind: 'permission' };
  if (objectType === 'derived_table' || objectType === 'extension' || objectType === 'refinement' || objectType === 'liquid') return { domain: 'model', semanticKind: 'view' };
  return { domain: 'field', semanticKind: 'field' };
}

export function migrationDecisionsFromEngine(result: MigrationEngineBridgeResult): MigrationDecision[] {
  const suggestionDecisions = result.model_suggestions.flatMap((suggestion, index) => {
    const targetFileName = semanticFileName(suggestion.path);
    if (!targetFileName) return [];
    return [{
      id: `engine:${result.request_id}:${index + 1}`,
      nodeId: `engine-suggestion:${suggestion.path}`,
      domain: suggestion.path === 'relationships' ? 'relationship' : 'model',
      sourceLabel: suggestion.path,
      targetLabel: suggestion.path,
      action: 'create_new',
      targetFileName,
      proposedCode: suggestion.content,
      rationale: `Deterministic ${result.source} suggestion from ${engineIdentity(result)}. Review and edit before approval.`,
      confidence: suggestion.confidence,
      evidence: suggestion.evidence.map((item) => ({
        sourceId: suggestion.source_ids[0] || suggestion.path,
        artifactId: item.artifact_name || undefined,
        locator: item.locator,
        artifactSha256: item.artifact_sha256 || undefined,
        contentSha256: item.content_sha256,
        role: item.role,
      })),
      blocking: true,
      impactAssetIds: suggestion.source_ids,
      validationRequired: true,
      compatibilityKey: `engine:${result.source}:${suggestion.rulebook_version}:${suggestion.sha256}`,
      approvedByUser: false,
      translationProvenance: {
        engineName: result.engine.name,
        engineVersion: result.engine.version,
        parserVersion: suggestion.parser_version,
        rulebookVersion: suggestion.rulebook_version,
        rulebookSha256: suggestion.rulebook_sha256,
        suggestionSha256: suggestion.sha256,
        severity: suggestion.severity,
      },
    } satisfies MigrationDecision];
  });
  const requirementDecisions = (result.bundle.model.requirements || [])
    .filter((requirement) => requirement.support_outcome !== 'automatic')
    .map((requirement, index) => {
      const matchingSuggestion = result.model_suggestions.find((suggestion) => suggestion.source_ids.includes(requirement.source_id));
      const hintedFile = requirement.target_file_hint ? semanticFileName(requirement.target_file_hint) : null;
      const targetFileName = matchingSuggestion ? semanticFileName(matchingSuggestion.path) : hintedFile;
      const proposedCode = typeof requirement.config.proposed_yaml === 'string'
        ? requirement.config.proposed_yaml
        : undefined;
      const semantic = semanticRequirementDecisionType(requirement.object_type);
      const confidence = requirement.support_outcome === 'decision_required' ? 0.72 : requirement.support_outcome === 'manual' ? 0.35 : 0.1;
      const proposalOptions: NonNullable<MigrationDecision['proposalOptions']> = [];
      if (targetFileName && proposedCode?.trim()) {
        proposalOptions.push({
          id: `${requirement.source_id}:rewrite`,
          action: 'rewrite',
          targetFileName,
          proposedCode,
          rationale: 'Apply the deterministic Omni fragment after explicit human review.',
          confidence,
        });
      }
      proposalOptions.push({
        id: `${requirement.source_id}:map`,
        action: 'map_existing',
        rationale: 'Map this source behavior to an existing governed Omni object.',
        confidence: Math.min(confidence, 0.6),
      }, {
        id: `${requirement.source_id}:exclude`,
        action: 'exclude',
        rationale: 'Exclude this behavior with an accountable waiver and accept the documented fidelity gap.',
        confidence: 0,
      }, {
        id: `${requirement.source_id}:defer`,
        action: 'defer',
        rationale: 'Defer this behavior to an accountable follow-up owner before migration completion.',
        confidence: 0,
      });
      return {
        id: `engine:${result.request_id}:requirement:${index + 1}`,
        nodeId: requirement.source_id,
        semanticKind: semantic.semanticKind,
        semanticKey: `${requirement.object_type}:${requirement.name}`,
        domain: semantic.domain,
        sourceLabel: requirement.name,
        targetLabel: targetFileName || undefined,
        action: 'defer' as const,
        targetFileName: targetFileName || undefined,
        proposedCode,
        rationale: requirement.reason,
        confidence,
        evidence: requirement.evidence.map((item) => ({
          sourceId: requirement.source_id,
          artifactId: item.artifact_name || undefined,
          locator: item.locator,
          artifactSha256: item.artifact_sha256 || undefined,
          contentSha256: item.content_sha256,
          role: item.role,
        })),
        blocking: true,
        impactAssetIds: [requirement.source_id, ...requirement.dependencies],
        validationRequired: true,
        compatibilityKey: `engine:${result.source}:requirement:${requirement.object_type}:${requirement.name}`,
        approvedByUser: false,
        proposalOptions,
        identityDiagnostics: [`Looker ${requirement.object_type} · ${requirement.support_outcome}`],
        translationProvenance: matchingSuggestion ? {
          engineName: result.engine.name,
          engineVersion: result.engine.version,
          parserVersion: matchingSuggestion.parser_version,
          rulebookVersion: matchingSuggestion.rulebook_version,
          rulebookSha256: matchingSuggestion.rulebook_sha256,
          suggestionSha256: matchingSuggestion.sha256,
          severity: matchingSuggestion.severity,
        } : undefined,
      } satisfies MigrationDecision;
    });
  return [...suggestionDecisions, ...requirementDecisions];
}

export function dashboardPlansFromEngine(result: MigrationEngineBridgeResult): MigrationDashboardBuildPlan[] {
  const lookup = fieldIdentityLookup(result);
  const artifactCoverage = isRecord(result.capability_coverage.artifact_coverage)
    ? result.capability_coverage.artifact_coverage
    : {};
  const layoutAvailable = artifactCoverage.layout !== 'unsupported';
  return result.bundle.dashboards.map((dashboard) => {
    const sourceDashboardId = dashboard.native_source_id || dashboard.source_id;
    const dependencyFields = Array.from(new Set(dashboard.tiles.flatMap((tile) => queryDependencyFields(tile.query))));
    const filterPlans = dashboard.filters.map((filter) => ({
      id: filter.source_id,
      label: filter.label || filter.field,
      sourceField: filter.field,
      operator: filter.operator,
      values: [...filter.values],
      isNegative: filter.is_negative,
      sourceEvidenceIds: [filter.source_id],
      required: filter.required === true,
      sourceFilterType: filter.filter_type || undefined,
    }));
    const dashboardFilterIdBySourceIdentity = new Map<string, string>();
    dashboard.filters.forEach((filter) => {
      [filter.native_source_id, filter.label, filter.field].filter((item): item is string => Boolean(item)).forEach((item) => dashboardFilterIdBySourceIdentity.set(item, filter.source_id));
    });
    const tileIdBySourceIdentity = new Map<string, string>();
    dashboard.tiles.forEach((tile) => {
      [tile.native_source_id, tile.title].filter((item): item is string => Boolean(item)).forEach((item) => tileIdBySourceIdentity.set(item, tile.source_id));
    });
    return {
      id: `engine-plan:${result.request_id}:${sourceDashboardId}`,
      sourceDashboardId,
      sourceDashboardName: dashboard.name,
      sourcePath: dashboard.source_url || undefined,
      sourceEvidenceIds: [sourceDashboardId, ...result.provenance.source_artifacts],
      dependencyIds: dependencyFields.map((field) => fieldIdentity(result, lookup, field)),
      targetName: dashboard.name,
      sourceFolderPath: dashboard.folder_path || undefined,
      sourceOwner: dashboard.owner || undefined,
      sourceUpdatedAt: dashboard.updated_at || undefined,
      sourceUsageCount: dashboard.usage_count ?? undefined,
      filters: filterPlans,
      filterBindings: (dashboard.filter_bindings || []).map((binding) => ({
        id: binding.source_id,
        dashboardFilterId: dashboardFilterIdBySourceIdentity.get(binding.dashboard_filter_id) || binding.dashboard_filter_id,
        dashboardFilterLabel: binding.dashboard_filter_label,
        tileId: tileIdBySourceIdentity.get(binding.tile_id) || binding.tile_id,
        targetField: binding.target_field || undefined,
        excluded: binding.excluded,
      })),
      filterOrder: (dashboard.filter_order || []).map((id) => dashboardFilterIdBySourceIdentity.get(id) || id),
      tileOrder: (dashboard.tile_order || []).map((id) => tileIdBySourceIdentity.get(id) || id),
      tiles: dashboard.tiles.map((tile, tileIndex) => ({
        id: tile.source_id,
        title: tile.title || `Tile ${tileIndex + 1}`,
        sourceEvidenceIds: [tile.source_id, ...result.provenance.source_artifacts],
        sourceKind: tile.kind,
        migrationOutcome: tile.query
          ? 'generated'
          : tile.untranslatable.some((note) => /merged[- ]results/i.test(note.reason))
            ? 'manual'
            : tile.kind === 'text' || tile.kind === 'markdown'
              ? 'manual'
              : tile.untranslatable.some((note) => note.severity === 'blocker')
                ? 'blocked'
                : 'redesign',
        fields: (tile.query?.fields || []).filter((field) => !(tile.query?.hidden_fields || []).includes(field)),
        filters: tile.query?.filters.map((filter) => filter.source_id) || [],
        queryTopic: tile.query?.topic || undefined,
        queryFilters: tile.query?.filters.map((filter) => ({
          id: filter.source_id,
          field: filter.field,
          operator: filter.operator,
          values: [...filter.values],
          isNegative: filter.is_negative,
        })) || [],
        sorts: tile.query?.sorts.map((sort) => ({ ...sort })) || [],
        limit: tile.query?.limit ?? undefined,
        pivots: tile.query?.pivots || undefined,
        pivotStrategy: !tile.query?.pivots?.length
          ? 'none'
          : ['table', 'looker_grid'].includes(tile.chart_type || '')
            ? 'table_query'
            : 'chart_series',
        filterExpression: tile.query?.filter_expression || undefined,
        hiddenFields: [...(tile.query?.hidden_fields || [])],
        calculationDependencies: [...(tile.query?.calculation_dependencies || [])],
        queryOrigin: tile.query?.query_origin || undefined,
        sourceLookId: tile.query?.source_look_id || undefined,
        sourceQueryId: tile.query?.native_source_id || undefined,
        sourceModel: tile.query?.source_model || undefined,
        sourceExplore: tile.query?.source_explore || undefined,
        dynamicFields: (tile.query?.dynamic_fields || []).map((field) => ({
          id: field.source_id,
          name: field.name,
          label: field.label || undefined,
          category: field.category,
          expression: field.expression || undefined,
          basedOn: field.based_on || undefined,
          filters: { ...field.filters },
          dependencies: [...field.dependencies],
          supportOutcome: field.support_outcome,
          config: { ...field.config },
        })),
        visualizationConfig: { ...tile.vis_config },
        layout: layoutAvailable ? { ...tile.layout } : undefined,
        visualType: tile.chart_type || tile.kind,
        buildInstructions: [
          layoutAvailable
            ? `Recreate the ${tile.chart_type || tile.kind} visual at source grid x=${tile.layout.x}, y=${tile.layout.y}, w=${tile.layout.w}, h=${tile.layout.h}.`
            : `Recreate the ${tile.chart_type || tile.kind} visual using an Omni-native layout selected during dashboard review.`,
          ...(tile.query?.pivots?.length && ['table', 'looker_grid'].includes(tile.chart_type || '')
            ? ['Preserve source pivots as Omni query pivots in the destination table.']
            : tile.query?.pivots?.length
              ? ['Translate source pivots into stacked chart series rather than exposing pivot columns.']
              : []),
          ...(!tile.query && tile.untranslatable.some((note) => /merged[- ]results/i.test(note.reason))
            ? ['Rebuild this merged-results tile manually from its reviewed component queries before completion.']
            : []),
          ...(tile.query?.query_origin === 'saved_look' || tile.query?.query_origin === 'query_id'
            ? [`Preserve the resolved saved-Look query intent${tile.query.source_look_id ? ` from Look ${tile.query.source_look_id}` : ''}.`]
            : []),
        ].join(' '),
        validationAssertions: [
          'The generated tile uses the reviewed target fields and returns a valid query.',
          ...(tile.query?.filter_expression ? ['The translated compound filter produces the reviewed source behavior.'] : []),
          ...((tile.query?.hidden_fields || []).length ? ['Computation-only source fields are not exposed as visible destination fields.'] : []),
          ...(tile.query?.pivots?.length ? ['Pivot dimensions preserve the reviewed table or chart-series intent.'] : []),
        ],
      })),
      unsupportedFeatures: [
        ...noteText(dashboard.untranslatable),
        ...dashboard.tiles.flatMap((tile) => noteText(tile.untranslatable)),
        ...dashboard.tiles.flatMap((tile) => (tile.query?.dynamic_fields || [])
          .filter((field) => ['decision_required', 'manual', 'unsupported'].includes(field.support_outcome))
          .map((field) => `${field.label || field.name} requires a ${field.support_outcome} dynamic-field outcome.`)),
        ...(layoutAvailable ? [] : ['Source layout is unavailable from this API and requires Omni-native redesign review.']),
      ],
      validationAssertions: [
        'Every source tile has a generated or explicitly waived destination outcome.',
        'Every source dashboard filter has an explicit include or exclude decision for every tile.',
      ],
    };
  });
}

export function canonicalModelFromEngine(result: MigrationEngineBridgeResult, artifacts: MigrationArtifact[] = []): CanonicalSemanticModel {
  return buildCanonicalBiModel(migrationInventoryFromEngine(result, artifacts));
}

export function migrationEngineSourceFromOmniKit(source: MigrationSourceTool): MigrationEngineSource | null {
  if (source === 'power_bi') return 'powerbi';
  if (source === 'looker' || source === 'tableau' || source === 'sigma' || source === 'metabase') return source;
  return null;
}

export function migrationEngineArtifactNames(value: unknown): string[] {
  if (!isRecord(value) || !isRecord(value.provenance)) return [];
  return stringArray(value.provenance.source_artifacts);
}

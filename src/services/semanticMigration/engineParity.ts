import type { MigrationInventory, MigrationSourceTool } from './types';
import type { MigrationEngineBridgeResult, MigrationEngineRolloutMode, MigrationEngineSource } from './engineBridge';

export type MigrationParityCategory = 'views' | 'fields' | 'topics' | 'relationships' | 'dashboards';

export interface MigrationParityCategoryResult {
  baselineCount: number;
  candidateCount: number;
  baselineStableIdentityCount: number;
  candidateStableIdentityCount: number;
  matchedStableIdentityCount: number;
  equivalentCount: number;
  missingFromCandidateCount: number;
  additionalInCandidateCount: number;
  score: number;
}

export interface MigrationEngineParityReport {
  schemaVersion: 'omnikit.migration.engine-parity.v1';
  generatedAt: string;
  source: MigrationEngineSource;
  mode: MigrationEngineRolloutMode;
  engine: { name: string; version: string; parserVersion: string; rulebookVersion: string };
  categories: Record<MigrationParityCategory, MigrationParityCategoryResult>;
  scores: {
    semantic: number;
    dashboards: number;
    stableIdentity: number;
    warningsAndLimitations: number;
    overall: number;
  };
  promotion: {
    promotable: boolean;
    observationCount: number;
    requiredObservationCount: number;
    thresholds: { semantic: number; dashboards: number; stableIdentity: number; overall: number };
    blockers: string[];
  };
  operational: { durationMs?: number; queueWaitMs?: number; fallback: 'native_when_available' };
}

export interface MigrationEngineSourcePolicy {
  source: MigrationSourceTool;
  nativeAuthority: string;
  engineAuthority: string;
  engineFormats: string[];
  nativeFormats: string[];
  rollback: string;
  owner: 'OmniKit';
}

export const MIGRATION_ENGINE_SOURCE_POLICIES: Record<MigrationSourceTool, MigrationEngineSourcePolicy> = {
  dbt: { source: 'dbt', nativeAuthority: 'OmniKit package parser', engineAuthority: 'none', engineFormats: [], nativeFormats: ['manifest.json', 'catalog.json', 'semantic YAML'], rollback: 'Keep OmniKit native parsing active.', owner: 'OmniKit' },
  domo: { source: 'domo', nativeAuthority: 'OmniKit guided manual parser', engineAuthority: 'none', engineFormats: [], nativeFormats: ['dataset schema JSON', 'Beast Mode JSON', 'DataFlow SQL', 'card JSON'], rollback: 'Keep the guided OmniKit parser authoritative.', owner: 'OmniKit' },
  looker: { source: 'looker', nativeAuthority: 'OmniKit manual/API connector fallback', engineAuthority: 'OmniKit first-party LookML and scoped Looker API acquisition', engineFormats: ['.model.lkml', '.view.lkml', '.dashboard.lookml'], nativeFormats: ['same formats through guided upload'], rollback: 'Set the Looker engine mode to off or shadow.', owner: 'OmniKit' },
  metabase: { source: 'metabase', nativeAuthority: 'OmniKit API inventory fallback', engineAuthority: 'OmniKit first-party Metabase API and MBQL normalization', engineFormats: ['REST API snapshot JSON'], nativeFormats: ['API inventory JSON'], rollback: 'Set the Metabase engine mode to off or shadow.', owner: 'OmniKit' },
  microstrategy: { source: 'microstrategy', nativeAuthority: 'OmniKit guided export parser', engineAuthority: 'none', engineFormats: [], nativeFormats: ['project', 'cube', 'report', 'dossier exports'], rollback: 'Keep the guided OmniKit parser authoritative.', owner: 'OmniKit' },
  power_bi: { source: 'power_bi', nativeAuthority: 'OmniKit PBIP/PBIR/TMDL/scanner parser', engineAuthority: 'OmniKit first-party direct PBIX extraction', engineFormats: ['.pbix'], nativeFormats: ['.pbip', '.pbir', '.tmdl', 'model.bim', 'scanner JSON'], rollback: 'Disable Power BI engine mode; direct PBIX then requires conversion to PBIP or supported exports.', owner: 'OmniKit' },
  sigma: { source: 'sigma', nativeAuthority: 'OmniKit API inventory fallback', engineAuthority: 'OmniKit first-party Sigma API/formula normalization', engineFormats: ['REST API snapshot'], nativeFormats: ['API inventory JSON'], rollback: 'Set the Sigma engine mode to off or shadow.', owner: 'OmniKit' },
  tableau: { source: 'tableau', nativeAuthority: 'OmniKit artifact inventory fallback', engineAuthority: 'OmniKit first-party structured workbook/data-source parsing', engineFormats: ['.twb', '.twbx', '.tds', '.tdsx'], nativeFormats: ['uploaded source artifacts'], rollback: 'Set the Tableau engine mode to off or shadow.', owner: 'OmniKit' },
  webfocus: { source: 'webfocus', nativeAuthority: 'OmniKit guided file parser', engineAuthority: 'none', engineFormats: [], nativeFormats: ['.fex', '.mas', '.acx'], rollback: 'Keep the OmniKit parser authoritative.', owner: 'OmniKit' },
};

export interface MigrationParityComparableItem {
  id?: string;
  matchKey: string;
  signature: string;
}

export type MigrationParityManifest = Record<MigrationParityCategory, MigrationParityComparableItem[]>;

function rounded(value: number): number {
  return Math.round(Math.max(0, Math.min(100, value)) * 10) / 10;
}

function categoryResult(baseline: MigrationParityComparableItem[], candidate: MigrationParityComparableItem[]): MigrationParityCategoryResult {
  const baselineComparable = new Map(baseline.map((item) => [item.matchKey, item.signature] as const));
  const candidateComparable = new Map(candidate.map((item) => [item.matchKey, item.signature] as const));
  const matchedIds = Array.from(baselineComparable.keys()).filter((id) => candidateComparable.has(id));
  const equivalentCount = matchedIds.filter((id) => baselineComparable.get(id) === candidateComparable.get(id)).length;
  const denominator = Math.max(baseline.length, candidate.length, 1);
  const score = baseline.length === 0 && candidate.length === 0 ? 100 : rounded((equivalentCount / denominator) * 100);
  return {
    baselineCount: baseline.length,
    candidateCount: candidate.length,
    baselineStableIdentityCount: baseline.filter((item) => Boolean(item.id)).length,
    candidateStableIdentityCount: candidate.filter((item) => Boolean(item.id)).length,
    matchedStableIdentityCount: matchedIds.length,
    equivalentCount,
    missingFromCandidateCount: Math.max(0, baselineComparable.size - matchedIds.length),
    additionalInCandidateCount: Math.max(0, candidateComparable.size - matchedIds.length),
    score,
  };
}

function normalizedName(value: string | undefined | null): string {
  return String(value || '').trim().replace(/^['"]|['"]$/g, '').replace(/\s+/g, ' ').toLowerCase();
}

function normalizedType(value: string | undefined | null): string {
  const normalized = normalizedName(value).replace(/\s+sql\s*:.+$/i, '');
  if (['int', 'integer', 'float', 'double', 'decimal', 'numeric'].includes(normalized)) return 'number';
  if (['yesno', 'bool'].includes(normalized)) return 'boolean';
  if (['date_time', 'datetime'].includes(normalized)) return 'timestamp';
  return normalized;
}

function normalizedAggregate(value: string | undefined | null): string {
  const normalized = normalizedName(value).replace(/\s+sql\s*:.+$/i, '').replace(/[^a-z0-9]+/g, '_');
  if (normalized === 'avg') return 'average';
  if (normalized === 'countdistinct' || normalized === 'distinct_count') return 'count_distinct';
  return normalized;
}

function normalizedExpression(value: string | undefined | null): string {
  return String(value || '').trim().replace(/;;\s*$/, '').replace(/\s+/g, ' ').toLowerCase();
}

function sortedNormalized(values: Array<string | undefined | null>): string[] {
  return Array.from(new Set(values.map(normalizedName).filter(Boolean))).sort();
}

function fieldMatchName(field: { name: string; sourceColumn?: string; originalName?: string }): string {
  return normalizedName(field.sourceColumn || field.originalName || field.name);
}

/**
 * Canonical parity projection shared by browser diagnostics, server attestation, and
 * source conformance tests. It intentionally removes formatting-only differences.
 */
export function buildMigrationParityManifest(inventory: MigrationInventory): MigrationParityManifest {
  return {
    views: inventory.views.map((view) => ({
      id: view.sourceId,
      matchKey: `view:${normalizedName(view.name)}`,
      signature: JSON.stringify({
        fields: sortedNormalized(view.fields.map((field) => fieldMatchName(field))),
        measures: sortedNormalized(view.measures.map((field) => fieldMatchName(field))),
        kind: normalizedName(view.kind || 'dataset'),
        sql: normalizedExpression(view.sql),
      }),
    })),
    fields: inventory.views.flatMap((view) => [...view.fields, ...view.measures].map((field) => ({
      id: field.sourceId,
      matchKey: `view:${normalizedName(view.name)}/field:${fieldMatchName(field)}`,
      signature: JSON.stringify({
        type: normalizedType(field.type),
        aggregate: 'aggregateType' in field && typeof field.aggregateType === 'string' ? normalizedAggregate(field.aggregateType) : '',
        sql: normalizedExpression(field.sql),
      }),
    }))),
    topics: inventory.explores.map((topic) => ({
      id: topic.sourceId,
      matchKey: `topic:${normalizedName(topic.name)}`,
      signature: JSON.stringify({
        baseView: normalizedName(topic.baseView),
        joins: sortedNormalized(topic.joins.map((join) => `${join.from}->${join.to}`)),
        fields: sortedNormalized(topic.fields),
        filters: sortedNormalized(topic.filters),
      }),
    })),
    relationships: inventory.explores.length > 0
      ? inventory.explores.flatMap((topic) => topic.joins.map((relationship) => ({
        id: relationship.sourceId,
        matchKey: `topic:${normalizedName(topic.name)}/join:${normalizedName(relationship.from)}->${normalizedName(relationship.to)}`,
        signature: JSON.stringify({
          joinType: normalizedName(relationship.joinType),
          relationshipType: normalizedName(relationship.relationshipType),
          sql: normalizedExpression(relationship.sql),
        }),
      })))
      : inventory.relationships.map((relationship) => ({
        id: relationship.sourceId,
        matchKey: `join:${normalizedName(relationship.from)}->${normalizedName(relationship.to)}`,
        signature: JSON.stringify({
          joinType: normalizedName(relationship.joinType),
          relationshipType: normalizedName(relationship.relationshipType),
          sql: normalizedExpression(relationship.sql),
        }),
      })),
    dashboards: inventory.dashboards.map((dashboard) => ({
      id: dashboard.sourceId,
      matchKey: `dashboard:${normalizedName(dashboard.name)}`,
      signature: JSON.stringify({
        fields: sortedNormalized(dashboard.fields),
        filters: sortedNormalized(dashboard.filters),
        chartType: normalizedName(dashboard.chartType || dashboard.cardType),
      }),
    })),
  };
}

function average(values: number[]): number {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 100;
}

function countSimilarity(baseline: number, candidate: number): number {
  if (baseline === 0 && candidate === 0) return 100;
  return rounded((Math.min(baseline, candidate) / Math.max(baseline, candidate, 1)) * 100);
}

const PROMOTION_THRESHOLDS: Record<MigrationEngineSource, { semantic: number; dashboards: number; stableIdentity: number; overall: number; observations: number }> = {
  looker: { semantic: 95, dashboards: 90, stableIdentity: 95, overall: 93, observations: 20 },
  powerbi: { semantic: 95, dashboards: 85, stableIdentity: 95, overall: 92, observations: 20 },
  tableau: { semantic: 92, dashboards: 85, stableIdentity: 95, overall: 90, observations: 25 },
  metabase: { semantic: 95, dashboards: 95, stableIdentity: 95, overall: 95, observations: 20 },
  sigma: { semantic: 90, dashboards: 80, stableIdentity: 95, overall: 88, observations: 25 },
};

export function migrationEnginePromotionRequirements(source: MigrationEngineSource): { semantic: number; dashboards: number; stableIdentity: number; overall: number; observations: number } {
  return { ...PROMOTION_THRESHOLDS[source] };
}

export function buildMigrationEngineParityReport(input: {
  baseline: MigrationInventory;
  candidate: MigrationInventory;
  engineResult: MigrationEngineBridgeResult;
  mode: MigrationEngineRolloutMode;
  observationCount?: number;
}): MigrationEngineParityReport {
  const baseline = buildMigrationParityManifest(input.baseline);
  const candidate = buildMigrationParityManifest(input.candidate);
  const categories = Object.fromEntries((Object.keys(baseline) as MigrationParityCategory[]).map((category) => [category, categoryResult(baseline[category], candidate[category])])) as Record<MigrationParityCategory, MigrationParityCategoryResult>;
  const semantic = rounded(average(['views', 'fields', 'topics', 'relationships'].map((category) => categories[category as MigrationParityCategory].score)));
  const dashboards = categories.dashboards.score;
  const totalCandidate = Object.values(categories).reduce((total, item) => total + item.candidateCount, 0);
  const stableCandidate = Object.values(categories).reduce((total, item) => total + item.candidateStableIdentityCount, 0);
  const totalComparable = Object.values(categories).reduce((total, item) => total + Math.max(item.baselineCount, item.candidateCount), 0);
  const matchedComparable = Object.values(categories).reduce((total, item) => total + item.matchedStableIdentityCount, 0);
  const stableIdentity = rounded(average([
    totalComparable ? (matchedComparable / totalComparable) * 100 : 100,
    totalCandidate ? (stableCandidate / totalCandidate) * 100 : 100,
  ]));
  const warningsAndLimitations = countSimilarity(input.baseline.warnings.length, input.candidate.warnings.length);
  const overall = rounded((semantic * 0.6) + (dashboards * 0.25) + (stableIdentity * 0.1) + (warningsAndLimitations * 0.05));
  const thresholds = PROMOTION_THRESHOLDS[input.engineResult.source];
  const observationCount = Math.max(0, Math.floor(input.observationCount || 0));
  const blockers = [
    semantic < thresholds.semantic ? `Semantic parity ${semantic}% is below ${thresholds.semantic}%.` : '',
    dashboards < thresholds.dashboards ? `Dashboard parity ${dashboards}% is below ${thresholds.dashboards}%.` : '',
    stableIdentity < thresholds.stableIdentity ? `Stable identity coverage ${stableIdentity}% is below ${thresholds.stableIdentity}%.` : '',
    overall < thresholds.overall ? `Overall parity ${overall}% is below ${thresholds.overall}%.` : '',
    observationCount < thresholds.observations ? `${thresholds.observations - observationCount} additional shadow observations are required.` : '',
  ].filter(Boolean);
  return {
    schemaVersion: 'omnikit.migration.engine-parity.v1',
    generatedAt: new Date().toISOString(),
    source: input.engineResult.source,
    mode: input.mode,
    engine: {
      name: input.engineResult.engine.name,
      version: input.engineResult.engine.version,
      parserVersion: input.engineResult.model_suggestions[0]?.parser_version || input.engineResult.engine.version,
      rulebookVersion: input.engineResult.diagnostics.rulebook_version,
    },
    categories,
    scores: { semantic, dashboards, stableIdentity, warningsAndLimitations, overall },
    promotion: {
      promotable: blockers.length === 0,
      observationCount,
      requiredObservationCount: thresholds.observations,
      thresholds: { semantic: thresholds.semantic, dashboards: thresholds.dashboards, stableIdentity: thresholds.stableIdentity, overall: thresholds.overall },
      blockers,
    },
    operational: {
      durationMs: input.engineResult.control_plane?.duration_ms,
      queueWaitMs: input.engineResult.control_plane?.queue_wait_ms,
      fallback: 'native_when_available',
    },
  };
}

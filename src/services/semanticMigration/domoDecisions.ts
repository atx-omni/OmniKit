import type {
  DomoManualMapping,
  DomoManualParseResult,
  MigrationDecision,
  MigrationDecisionAction,
  MigrationMappingDomain,
  SemanticYamlFileName,
} from './types';
import { domoSourceItemsForSelection } from './manualUpload';
import { mergeMigrationDecisionProposalChunks, withMigrationDecisionIdentity } from './decisionIdentity';

function normalized(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function semanticFileName(mapping: DomoManualMapping): SemanticYamlFileName | undefined {
  if (mapping.targetKind === 'relationships_file') return 'relationships';
  if (mapping.targetName.endsWith('.view') || mapping.targetName.endsWith('.topic')) return mapping.targetName as SemanticYamlFileName;
  return undefined;
}

function decisionShape(mapping: DomoManualMapping): {
  domain: MigrationMappingDomain;
  action: MigrationDecisionAction;
  rationale: string;
} | null {
  if (mapping.sourceKind === 'dataset_schema') {
    return { domain: 'model', action: 'create_new', rationale: 'The selected Domo DataSet schema requires a reviewed Omni shared-model view or an explicit mapping to an equivalent target view.' };
  }
  if (mapping.sourceKind === 'beast_mode') {
    return mapping.targetKind === 'shared_model_dimension'
      ? { domain: 'field', action: 'create_new', rationale: 'The row-level or FIXED Domo Beast Mode must be mapped to an equivalent field or translated into a reviewed additive Omni dimension.' }
      : { domain: 'measure', action: 'create_new', rationale: 'The aggregate or analytic Domo Beast Mode must be mapped to an equivalent measure or translated into a reviewed additive Omni measure.' };
  }
  if (mapping.sourceKind === 'variable') {
    return { domain: 'filter', action: 'rewrite', rationale: 'The Domo Variable requires a reviewed Omni dashboard-control decision and a compatible translated expression; one current value must not be inlined.' };
  }
  if (mapping.sourceKind === 'dataflow_sql') {
    return { domain: 'data_source', action: 'rewrite', rationale: 'Domo DataFlow SQL must be translated for the target warehouse dialect and reviewed as an Omni query view.' };
  }
  if (mapping.sourceKind === 'relationship') {
    return { domain: 'relationship', action: 'create_new', rationale: 'The recovered join keys and relationship behavior require an explicit Omni relationship decision.' };
  }
  return null;
}

function targetObjectLabel(result: DomoManualParseResult, mapping: DomoManualMapping): string {
  if (mapping.sourceKind !== 'beast_mode') return mapping.targetName;
  if (mapping.targetKind === 'shared_model_dimension') {
    const field = result.inventory.views
      .flatMap((view) => view.fields)
      .find((candidate) => (
        Boolean(mapping.sourceId && candidate.sourceId === mapping.sourceId)
        || (candidate.sourceArtifact === mapping.sourceArtifact && candidate.name === mapping.sourceName)
      ));
    return field?.name || mapping.sourceName;
  }
  const measure = result.inventory.views
    .flatMap((view) => view.measures)
    .find((candidate) => (
      Boolean(mapping.sourceId && candidate.sourceId === mapping.sourceId)
      || (candidate.sourceArtifact === mapping.sourceArtifact && (candidate.originalName || candidate.name) === mapping.sourceName)
    ));
  return measure?.name || mapping.sourceName;
}

export function requiredDomoMigrationDecisions(
  result: DomoManualParseResult | null,
  selectedDashboardIds: string[],
): MigrationDecision[] {
  if (!result) return [];
  const selectedMappingIds = new Set(domoSourceItemsForSelection(result, selectedDashboardIds).map((item) => item.id));
  const impactAssetIds = Array.from(new Set(selectedDashboardIds)).sort();
  return result.mappings.flatMap((mapping) => {
    if (!selectedMappingIds.has(mapping.id)) return [];
    const shape = decisionShape(mapping);
    if (!shape) return [];
    const targetFileName = semanticFileName(mapping);
    const identity = `${normalized(mapping.sourceKind)}:${normalized(mapping.sourceId || mapping.sourceName)}:${normalized(mapping.sourceArtifact)}`;
    const targetLabel = targetObjectLabel(result, mapping);
    return [withMigrationDecisionIdentity({
      id: `decision:domo:${shape.domain}:${identity}`,
      nodeId: `domo:${identity}`,
      domain: shape.domain,
      sourceLabel: mapping.sourceName,
      targetLabel,
      action: shape.action,
      targetFileName,
      rationale: `${shape.rationale} ${mapping.notes.join(' ')}`.trim(),
      confidence: mapping.confidence === 'high' ? 0.9 : mapping.confidence === 'medium' ? 0.7 : 0.4,
      evidence: [{ sourceId: mapping.sourceId || mapping.sourceArtifact, artifactId: mapping.sourceArtifact, locator: mapping.sourceName }],
      blocking: true,
      impactAssetIds,
      validationRequired: true,
      compatibilityKey: `domo:${shape.domain}:${normalized(mapping.sourceKind)}:${normalized(mapping.sourceName)}:${normalized(mapping.targetName)}`,
      approvedByUser: false,
    })];
  }).sort((left, right) => left.domain.localeCompare(right.domain) || left.sourceLabel.localeCompare(right.sourceLabel) || left.id.localeCompare(right.id));
}

function mergeKey(decision: MigrationDecision): string {
  const artifacts = decision.evidence.map((item) => item.artifactId || item.sourceId).filter(Boolean).map(normalized).sort().join(':');
  return `${decision.domain}:${normalized(decision.sourceLabel)}:${artifacts}`;
}

export function mergeRequiredDomoDecisions(
  aiDecisions: MigrationDecision[],
  requiredDecisions: MigrationDecision[],
): MigrationDecision[] {
  const remaining = new Map(requiredDecisions.map((decision) => [decision.id, decision]));
  const byNodeId = new Map<string, MigrationDecision[]>();
  const byScopedKey = new Map<string, MigrationDecision[]>();
  requiredDecisions.forEach((decision) => {
    byNodeId.set(decision.nodeId, [...(byNodeId.get(decision.nodeId) || []), decision]);
    byScopedKey.set(mergeKey(decision), [...(byScopedKey.get(mergeKey(decision)) || []), decision]);
  });
  const firstAvailable = (candidates: MigrationDecision[]) => candidates.find((candidate) => remaining.has(candidate.id));
  const merged = aiDecisions.map((decision) => {
    const required = remaining.get(decision.id)
      || firstAvailable(byNodeId.get(decision.nodeId) || [])
      || firstAvailable(byScopedKey.get(mergeKey(decision)) || []);
    if (!required) return decision;
    remaining.delete(required.id);
    return withMigrationDecisionIdentity({
      ...required,
      ...decision,
      id: required.id,
      nodeId: required.nodeId,
      semanticKey: undefined,
      evidence: Array.from(new Map([...required.evidence, ...decision.evidence].map((item) => [`${item.sourceId}:${item.locator || ''}`, item])).values()),
      impactAssetIds: Array.from(new Set([...required.impactAssetIds, ...decision.impactAssetIds])).sort(),
      blocking: true,
      validationRequired: true,
      compatibilityKey: required.compatibilityKey,
      approvedByUser: false,
    });
  });
  return mergeMigrationDecisionProposalChunks([[
    ...merged,
    ...Array.from(remaining.values()).map(withMigrationDecisionIdentity),
  ]]);
}

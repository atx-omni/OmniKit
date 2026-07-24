import type {
  DomoManualParseResult,
  DomoManualSourceKind,
  MigrationArtifact,
  MigrationInventory,
} from './types';
import type { SourceInventoryItem } from './studioApi';

export type DomoManualUploadStep = 'add' | 'review' | 'ready';

export interface DomoManualArtifactReview {
  artifactId: string;
  name: string;
  roles: DomoManualSourceKind[];
  mappingCount: number;
  status: 'parsed' | 'unsupported';
}

export interface DomoManualUploadGate {
  ready: boolean;
  missingRequiredEvidence: Array<'dataset_schema' | 'content'>;
  reasons: string[];
}

export interface ReleasedRawSourceSummary {
  artifactCount: number;
  byteCount: number;
  fileNames: string[];
  nativeArtifactCount: number;
  engineTextArtifactCount: number;
  engineBinaryArtifactCount: number;
  engineInputKey: string;
  releasedAt: string;
}

export function migrationInventoryWithoutRawArtifactContent(inventory: MigrationInventory): MigrationInventory {
  return {
    ...inventory,
    artifacts: inventory.artifacts.map((artifact) => ({
      ...artifact,
      content: '',
    })),
  };
}

export const DOMO_MANUAL_ROLE_LABELS: Record<DomoManualSourceKind, string> = {
  dataset_schema: 'Dataset schema',
  beast_mode: 'Beast Mode',
  variable: 'Variable and control',
  dataflow_sql: 'DataFlow SQL',
  relationship: 'Relationship',
  page: 'Page',
  page_card_link: 'Page/Card link',
  card: 'Card',
  drill_path: 'Card drill path',
  filter_view: 'Filter view',
  card_interaction: 'Card interaction',
  pdp_policy: 'PDP policy',
  dataset_access: 'DataSet access',
  schedule_alert: 'Schedule or alert',
  usage_ownership: 'Usage and ownership',
  magic_etl: 'Magic ETL handoff',
  dataflow: 'DataFlow handoff',
  workflow: 'Workflow handoff',
  form: 'Form handoff',
  code_engine: 'Code Engine handoff',
  custom_app: 'Custom app handoff',
  workbench: 'Workbench handoff',
  connector: 'Connector handoff',
  embed: 'Embed handoff',
};

export interface DomoMigrationWaveRecommendation {
  wave: 'Wave 1' | 'Wave 2';
  reason: string;
}

export function domoMigrationWaveRecommendation(item: SourceInventoryItem): DomoMigrationWaveRecommendation {
  const sourceKind = typeof item.metadata?.sourceKind === 'string' ? item.metadata.sourceKind : '';
  const targetKind = typeof item.metadata?.targetKind === 'string' ? item.metadata.targetKind : '';
  if (targetKind === 'governance_review' || targetKind === 'operational_review' || targetKind.endsWith('_handoff')) {
    return { wave: 'Wave 2', reason: 'Review governance, operations, or an accountable handoff after the core semantic dependency is prepared.' };
  }
  if (item.riskFlags.length > 0 || ['dataflow_sql', 'relationship'].includes(sourceKind)) {
    return { wave: 'Wave 2', reason: 'Validate translation or dependency risk after the directly reusable model objects are prepared.' };
  }
  if ((item.usageCount || 0) > 0) {
    return { wave: 'Wave 1', reason: 'Prioritize actively used content and its direct semantic dependencies.' };
  }
  return { wave: 'Wave 1', reason: 'Prepare the direct dataset, calculation, and dashboard dependency first.' };
}

function domoSourceItemKind(kind: DomoManualSourceKind): SourceInventoryItem['kind'] {
  if (kind === 'dataset_schema') return 'dataset';
  if (kind === 'beast_mode' || kind === 'variable') return 'calculation';
  if (kind === 'dataflow_sql' || kind === 'relationship') return 'view';
  if (kind === 'page') return 'page';
  if (kind === 'card' || kind === 'page_card_link' || kind === 'drill_path' || kind === 'filter_view' || kind === 'card_interaction') return 'card';
  if (kind === 'pdp_policy' || kind === 'dataset_access') return 'permission';
  if (kind === 'schedule_alert') return 'schedule';
  return 'repository_item';
}

export function domoManualSourceItems(result: DomoManualParseResult | null): SourceInventoryItem[] {
  if (!result) return [];
  const dashboardById = new Map(result.inventory.dashboards.flatMap((dashboard) => dashboard.sourceId ? [[dashboard.sourceId, dashboard] as const] : []));
  return result.mappings.map((mapping) => {
    const dashboard = mapping.sourceId ? dashboardById.get(mapping.sourceId) : undefined;
    const handoff = mapping.targetKind === 'data_engineering_handoff' || mapping.targetKind === 'redesign_handoff';
    const item: SourceInventoryItem = {
      id: mapping.id,
      name: mapping.sourceName,
      kind: domoSourceItemKind(mapping.sourceKind),
      parentId: dashboard?.parentId,
      path: dashboard?.path || `${mapping.sourceArtifact}#${mapping.sourceKind}`,
      owner: dashboard?.owner,
      updatedAt: dashboard?.updatedAt,
      usageCount: dashboard?.usageCount,
      dependencyIds: [...mapping.dependencies],
      featureFlags: [...(dashboard?.featureFlags || []), mapping.targetKind],
      riskFlags: [...(dashboard?.riskFlags || []), ...(handoff ? ['Requires an accountable migration handoff.'] : [])],
      metadata: {
        sourceKind: mapping.sourceKind,
        targetKind: mapping.targetKind,
        confidence: mapping.confidence,
        ...(handoff ? { handoffType: mapping.sourceKind } : {}),
        notes: mapping.notes.join(' ').slice(0, 500),
      },
    };
    const recommendation = domoMigrationWaveRecommendation(item);
    return {
      ...item,
      metadata: {
        ...item.metadata,
        recommendedWave: recommendation.wave,
        waveRecommendation: recommendation.reason,
      },
    };
  });
}

export function domoSourceItemsForSelection(
  result: DomoManualParseResult | null,
  selectedDashboardIds: string[],
): SourceInventoryItem[] {
  if (!result) return [];
  const allItems = domoManualSourceItems(result);
  if (selectedDashboardIds.length === 0) return allItems;

  const closure = new Set(selectedDashboardIds);
  const includedMappingIds = new Set<string>();
  const dashboardsById = new Map(result.inventory.dashboards.flatMap((dashboard) => dashboard.sourceId ? [[dashboard.sourceId, dashboard] as const] : []));
  let changed = true;
  while (changed) {
    changed = false;
    Array.from(closure).forEach((id) => {
      const dashboard = dashboardsById.get(id);
      if (!dashboard) return;
      [
        ...(dashboard.childIds || []),
        ...(dashboard.sourceDatasetId ? [dashboard.sourceDatasetId] : []),
        ...(dashboard.dependencyIds || []),
        ...dashboard.fields,
        ...dashboard.filters,
      ].forEach((dependency) => {
        if (!closure.has(dependency)) {
          closure.add(dependency);
          changed = true;
        }
      });
    });
    result.mappings.forEach((mapping) => {
      const related = Boolean(mapping.sourceId && closure.has(mapping.sourceId))
        || closure.has(mapping.sourceName)
        || mapping.dependencies.some((dependency) => closure.has(dependency));
      if (!related) return;
      if (!includedMappingIds.has(mapping.id)) {
        includedMappingIds.add(mapping.id);
        changed = true;
      }
      [mapping.sourceId || '', mapping.sourceName, ...mapping.dependencies].filter(Boolean).forEach((dependency) => {
        if (!closure.has(dependency)) {
          closure.add(dependency);
          changed = true;
        }
      });
    });
  }
  return allItems.filter((item) => includedMappingIds.has(item.id));
}

function nonQueryDomoCard(card: DomoManualParseResult['inventory']['dashboards'][number]): boolean {
  return /(?:text|image|html|document|iframe|app)/i.test(`${card.cardType || ''} ${card.chartType || ''}`);
}

export function domoSelectionClosureIssues(
  result: DomoManualParseResult | null,
  selectedDashboardIds: string[],
): string[] {
  if (!result || selectedDashboardIds.length === 0) return [];
  const dashboardsById = new Map(result.inventory.dashboards.flatMap((dashboard) => dashboard.sourceId ? [[dashboard.sourceId, dashboard] as const] : []));
  const viewsByDatasetId = new Map(result.inventory.views.flatMap((view) => view.sourceId ? [[view.sourceId, view] as const] : []));
  const issues: string[] = [];

  selectedDashboardIds.forEach((selectedId) => {
    const selected = dashboardsById.get(selectedId);
    if (!selected) {
      issues.push(`Selected Domo content ${selectedId} is missing from the normalized evidence.`);
      return;
    }
    const cardIds = selected.assetKind === 'page' ? selected.childIds || [] : [selectedId];
    if (selected.assetKind === 'page' && cardIds.length === 0) {
      issues.push(`Page ${selected.name} has no recovered Card membership. Add the Page detail or Card exports before planning.`);
    }
    cardIds.forEach((cardId) => {
      const card = dashboardsById.get(cardId);
      if (!card) {
        issues.push(`Page ${selected.name} references Card ${cardId}, but its Card definition is missing.`);
        return;
      }
      if (nonQueryDomoCard(card)) return;
      if (!card.sourceDatasetId) {
        issues.push(`Card ${card.name} has no recovered DataSet binding.`);
        return;
      }
      const dataset = viewsByDatasetId.get(card.sourceDatasetId);
      if (!dataset || dataset.fields.length === 0) {
        issues.push(`Card ${card.name} uses DataSet ${card.sourceDatasetId}, but its schema is missing or empty.`);
      }
      if (card.fields.length === 0) {
        issues.push(`Card ${card.name} has no recovered field bindings. Add Card Analyzer JSON or API evidence before planning.`);
      }
    });
  });

  return Array.from(new Set(issues)).sort();
}

export function buildDomoManualArtifactReview(
  artifacts: MigrationArtifact[],
  result: DomoManualParseResult | null,
): DomoManualArtifactReview[] {
  return artifacts.map((artifact) => {
    const mappings = result?.mappings.filter((mapping) => mapping.sourceArtifact === artifact.name) || [];
    const roles = Array.from(new Set(mappings.map((mapping) => mapping.sourceKind)));
    return {
      artifactId: artifact.id,
      name: artifact.name,
      roles,
      mappingCount: mappings.length,
      status: mappings.length > 0 ? 'parsed' : 'unsupported',
    };
  });
}

export function domoManualUploadGate(input: {
  result: DomoManualParseResult | null;
  conflictsAcknowledged: boolean;
  unsupportedAcknowledged: boolean;
  handoffsAcknowledged?: boolean;
}): DomoManualUploadGate {
  const { result, conflictsAcknowledged, unsupportedAcknowledged, handoffsAcknowledged = false } = input;
  if (!result) return { ready: false, missingRequiredEvidence: ['dataset_schema', 'content'], reasons: ['Wait for Domo parsing to finish.'] };

  const sourceKinds = new Set(result.mappings.map((mapping) => mapping.sourceKind));
  const missingRequiredEvidence: Array<'dataset_schema' | 'content'> = [];
  if (!sourceKinds.has('dataset_schema')) missingRequiredEvidence.push('dataset_schema');
  if (!sourceKinds.has('page') && !sourceKinds.has('card')) missingRequiredEvidence.push('content');
  const reasons: string[] = [];
  if (missingRequiredEvidence.includes('dataset_schema')) reasons.push('Add at least one Domo dataset schema so target dimensions and types can be validated.');
  if (missingRequiredEvidence.includes('content')) reasons.push('Add at least one Domo Page or Card definition so dashboard membership, fields, filters, and visual intent can be reviewed.');
  if (result.conflicts.length > 0 && !conflictsAcknowledged) reasons.push('Acknowledge the additive names OmniKit proposed for different same-named Beast Mode formulas.');
  if (result.diagnostics.handoffCount > 0 && !handoffsAcknowledged) reasons.push('Acknowledge the Domo platform features that require a data-engineering or redesign handoff.');
  if (result.diagnostics.unsupportedArtifactCount > 0 && !unsupportedAcknowledged) reasons.push('Remove unsupported files or acknowledge that they will not contribute migration evidence.');
  return { ready: reasons.length === 0, missingRequiredEvidence, reasons };
}

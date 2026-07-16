import { buildMigrationInventory } from '../../../src/services/semanticMigration/adapters';
import type {
  LookerManualMapping,
  LookerManualParseResult,
  MigrationArtifact,
} from '../../../src/services/semanticMigration/types';

export const LOOKER_MANUAL_SCHEMA_VERSION = 'omnikit.looker.manual.v1' as const;

function stableId(mapping: Omit<LookerManualMapping, 'id'>): string {
  return ['looker', mapping.sourceKind, mapping.sourceArtifact, mapping.sourceName, mapping.targetKind, mapping.targetName]
    .join(':')
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, '_');
}

function mapping(input: Omit<LookerManualMapping, 'id'>): LookerManualMapping {
  return { ...input, id: stableId(input) };
}

function targetName(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
}

export function parseLookerManualArtifacts(artifacts: MigrationArtifact[]): LookerManualParseResult {
  const inventory = buildMigrationInventory('looker', artifacts);
  const mappings: LookerManualMapping[] = [];

  artifacts.filter((artifact) => /\.model\.lkml$/i.test(artifact.name)).forEach((artifact) => {
    mappings.push(mapping({
      sourceKind: 'model',
      sourceName: artifact.name.replace(/\.model\.lkml$/i, ''),
      sourceArtifact: artifact.name,
      targetKind: 'model_context',
      targetName: 'selected_omni_model',
      confidence: 'high',
      notes: ['Connection, includes, and model-level access behavior remain review context rather than generated Omni YAML.'],
    }));
  });
  inventory.views.forEach((view) => {
    mappings.push(mapping({
      sourceKind: 'view', sourceName: view.name, sourceArtifact: view.sourceArtifact || 'LookML project',
      targetKind: 'shared_model_view', targetName: `${targetName(view.name)}.view`, confidence: 'high', notes: [],
    }));
    view.measures.forEach((measure) => mappings.push(mapping({
      sourceKind: 'measure', sourceName: `${view.name}.${measure.name}`, sourceArtifact: measure.sourceArtifact || view.sourceArtifact || 'LookML project',
      targetKind: 'shared_model_measure', targetName: `${targetName(view.name)}.${targetName(measure.name)}`, confidence: measure.sql ? 'high' : 'medium', notes: [],
    })));
  });
  inventory.explores.forEach((explore) => mappings.push(mapping({
    sourceKind: 'explore', sourceName: explore.name, sourceArtifact: explore.sourceArtifact || 'LookML project',
    targetKind: 'topic', targetName: `${targetName(explore.name)}.topic`, confidence: 'high', notes: ['Explore field scope and filters require operator review.'],
  })));
  inventory.relationships.forEach((relationship) => mappings.push(mapping({
    sourceKind: 'relationship', sourceName: `${relationship.from} -> ${relationship.to}`, sourceArtifact: relationship.sourceArtifact || 'LookML project',
    targetKind: 'relationships_file', targetName: 'relationships', confidence: relationship.sql ? 'high' : 'medium', notes: [],
  })));
  inventory.dashboards.forEach((dashboard) => mappings.push(mapping({
    sourceKind: 'dashboard', sourceName: dashboard.name, sourceArtifact: dashboard.sourceArtifact || 'LookML project',
    targetKind: 'dashboard_tile', targetName: dashboard.name, confidence: dashboard.fields.length ? 'high' : 'medium',
    notes: ['Looker visualization settings are preserved as source evidence and rebuilt through a reviewed Omni dashboard plan.'],
  })));

  const supportedArtifacts = new Set(mappings.map((item) => item.sourceArtifact));
  const unsupportedArtifacts = artifacts.filter((artifact) => !supportedArtifacts.has(artifact.name));
  const warnings = Array.from(new Set([
    ...inventory.warnings,
    ...unsupportedArtifacts.map((artifact) => `${artifact.name} did not expose a LookML model, view, Explore, measure, relationship, or dashboard.`),
  ])).slice(0, 80);
  inventory.warnings = warnings;
  inventory.summary = [
    `${artifacts.length} LookML project file${artifacts.length === 1 ? '' : 's'}`,
    `${inventory.views.length} view${inventory.views.length === 1 ? '' : 's'}`,
    `${inventory.metrics.length} measure${inventory.metrics.length === 1 ? '' : 's'}`,
    `${inventory.explores.length} Explore${inventory.explores.length === 1 ? '' : 's'}`,
    `${inventory.relationships.length} join${inventory.relationships.length === 1 ? '' : 's'}`,
    `${inventory.dashboards.length} dashboard${inventory.dashboards.length === 1 ? '' : 's'}`,
  ].join(' · ');

  return {
    inventory,
    mappings,
    diagnostics: {
      schemaVersion: LOOKER_MANUAL_SCHEMA_VERSION,
      parsedArtifactCount: artifacts.length - unsupportedArtifacts.length,
      unsupportedArtifactCount: unsupportedArtifacts.length,
      modelFileCount: artifacts.filter((artifact) => /\.model\.lkml$/i.test(artifact.name)).length,
      viewFileCount: artifacts.filter((artifact) => /\.view\.lkml$/i.test(artifact.name)).length,
      dashboardFileCount: artifacts.filter((artifact) => /\.dashboard\.lookml$/i.test(artifact.name)).length,
      mappingCount: mappings.length,
      warnings,
    },
  };
}

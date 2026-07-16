import type {
  CanonicalSemanticModel,
  CanonicalSemanticNode,
  MigrationInventory,
  MigrationAssetScopeDecision,
  SemanticEvidenceReference,
} from './types';
import type { SourceInventoryItem } from './studioApi';

export function scopedSourceInventoryItems(items: SourceInventoryItem[], scope: Record<string, MigrationAssetScopeDecision>): SourceInventoryItem[] {
  return items.filter((item) => !['defer', 'retire'].includes(scope[item.id]?.disposition || 'migrate'));
}

function stableId(kind: CanonicalSemanticNode['kind'], name: string, parent?: string): string {
  return `${kind}:${parent ? `${parent}:` : ''}${name}`.toLowerCase().replace(/[^a-z0-9:_-]+/g, '_');
}

function evidence(sourceArtifact?: string, locator?: string, exact: SemanticEvidenceReference[] = []): SemanticEvidenceReference[] {
  return exact.length > 0 ? exact : sourceArtifact ? [{ sourceId: sourceArtifact, artifactId: sourceArtifact, locator }] : [];
}

export function buildCanonicalSemanticModel(inventory: MigrationInventory): CanonicalSemanticModel {
  const nodes: CanonicalSemanticNode[] = [];
  const nodeIds = new Set<string>();
  const viewIds = new Map(inventory.views.map((view) => [view.name.toLowerCase(), view.sourceId || stableId('view', view.name)]));
  const fieldCandidates = new Map<string, Set<string>>();
  inventory.views.forEach((view) => {
    const viewId = view.sourceId || stableId('view', view.name);
    [...view.fields, ...view.measures].forEach((field) => {
      const fieldId = field.sourceId || stableId('aggregateType' in field ? 'measure' : 'field', field.name, viewId);
      [field.name, `${view.name}.${field.name}`].forEach((key) => {
        const normalized = key.toLowerCase();
        const values = fieldCandidates.get(normalized) || new Set<string>();
        values.add(fieldId);
        fieldCandidates.set(normalized, values);
      });
    });
  });
  const fieldIds = new Map(Array.from(fieldCandidates.entries()).flatMap(([key, values]) => values.size === 1 ? [[key, Array.from(values)[0]!]] : []));
  const viewIdFor = (name: string) => viewIds.get(name.toLowerCase()) || stableId('view', name);
  const fieldIdFor = (name: string, parentId?: string) => fieldIds.get(name.toLowerCase()) || stableId('field', name, parentId);
  const add = (node: CanonicalSemanticNode) => {
    if (nodeIds.has(node.id)) return;
    nodeIds.add(node.id);
    nodes.push(node);
  };

  inventory.views.forEach((view) => {
    const viewId = view.sourceId || stableId('view', view.name);
    add({
      id: viewId,
      kind: 'view',
      name: view.name,
      description: view.description,
      expression: view.sql,
      dependencies: [],
      evidence: evidence(view.sourceArtifact, view.sourceLocator || view.name, view.sourceEvidence),
      metadata: { warningCount: view.warnings.length, sourceId: view.sourceId || null, sourceKind: view.kind || null, label: view.label || null },
    });
    view.fields.forEach((field) => add({
      id: field.sourceId || stableId('field', field.name, viewId),
      kind: 'field',
      name: field.name,
      description: field.description,
      dataType: field.type,
      expression: field.sql,
      parentId: viewId,
      dependencies: [],
      evidence: evidence(field.sourceArtifact || view.sourceArtifact, field.sourceLocator || `${view.name}.${field.name}`, field.sourceEvidence),
      metadata: {
        label: field.label || null,
        groupLabel: field.groupLabel || null,
        sourceColumn: field.sourceColumn || null,
        formatString: field.formatString || null,
        hidden: field.hidden || false,
        primaryKey: field.primaryKey || false,
        timeframes: field.timeframes ? JSON.stringify(field.timeframes) : null,
        filters: field.filters ? JSON.stringify(field.filters) : null,
        untranslatable: field.untranslatable?.length ? JSON.stringify(field.untranslatable) : null,
      },
    }));
    view.measures.forEach((measure) => add({
      id: measure.sourceId || stableId('measure', measure.name, viewId),
      kind: 'measure',
      name: measure.name,
      description: measure.description,
      dataType: measure.type,
      expression: measure.sql,
      parentId: viewId,
      dependencies: (measure.dependencies || []).map((dependency) => fieldIdFor(dependency, viewId)),
      evidence: evidence(measure.sourceArtifact || view.sourceArtifact, measure.sourceLocator || `${view.name}.${measure.name}`, measure.sourceEvidence),
      metadata: {
        aggregateType: measure.aggregateType || null,
        sourceId: measure.sourceId || null,
        originalName: measure.originalName || null,
        label: measure.label || null,
        groupLabel: measure.groupLabel || null,
        formatString: measure.formatString || null,
        filters: measure.filters ? JSON.stringify(measure.filters) : null,
        untranslatable: measure.untranslatable?.length ? JSON.stringify(measure.untranslatable) : null,
      },
    }));
  });

  inventory.relationships.forEach((relationship) => add({
    id: relationship.sourceId || stableId('relationship', `${relationship.from}->${relationship.to}`),
    kind: 'relationship',
    name: `${relationship.from} → ${relationship.to}`,
    expression: relationship.sql,
    dependencies: [viewIdFor(relationship.from), viewIdFor(relationship.to)],
    evidence: evidence(relationship.sourceArtifact, relationship.sourceLocator || `${relationship.from}->${relationship.to}`, relationship.sourceEvidence),
    metadata: { joinType: relationship.joinType || null, relationshipType: relationship.relationshipType || null },
  }));

  inventory.explores.forEach((explore) => add({
    id: explore.sourceId || stableId('topic', explore.name),
    kind: 'topic',
    name: explore.name,
    dependencies: [explore.baseView ? viewIdFor(explore.baseView) : '', ...explore.joins.flatMap((join) => [viewIdFor(join.from), viewIdFor(join.to)])].filter(Boolean),
    evidence: evidence(explore.sourceArtifact, explore.sourceLocator || explore.name, explore.sourceEvidence),
    metadata: { baseView: explore.baseView || null, fieldCount: explore.fields.length, filterCount: explore.filters.length },
  }));

  inventory.dashboards.forEach((dashboard) => add({
    id: dashboard.sourceId || stableId('dashboard', dashboard.name),
    kind: 'dashboard',
    name: dashboard.name,
    dependencies: dashboard.fields.map((field) => fieldIdFor(field)),
    evidence: evidence(dashboard.sourceArtifact, dashboard.sourceLocator || dashboard.name, dashboard.sourceEvidence),
    metadata: {
      fieldCount: dashboard.fields.length,
      filterCount: dashboard.filters.length,
      sourceId: dashboard.sourceId || null,
      sourceDatasetId: dashboard.sourceDatasetId || null,
      chartType: dashboard.chartType || null,
      cardType: dashboard.cardType || null,
    },
  }));

  return {
    schemaVersion: '1.0',
    sourcePlatform: inventory.sourceTool,
    generatedAt: new Date().toISOString(),
    nodes: nodes.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)),
    warnings: [...inventory.warnings],
  };
}

const SOURCE_KIND_MAP: Record<SourceInventoryItem['kind'], CanonicalSemanticNode['kind']> = {
  workspace: 'workspace',
  project: 'project',
  semantic_model: 'model',
  data_source: 'data_source',
  dataset: 'dataset',
  report: 'report',
  dashboard: 'dashboard',
  workbook: 'workbook',
  page: 'page',
  view: 'view',
  tile: 'tile',
  visual: 'visual',
  card: 'card',
  cube: 'cube',
  metric: 'metric',
  attribute: 'attribute',
  calculation: 'calculation',
  filter: 'filter',
  permission: 'permission',
  schedule: 'schedule',
  repository_item: 'report',
};

export function buildCanonicalBiModel(inventory: MigrationInventory, sourceItems: SourceInventoryItem[] = []): CanonicalSemanticModel {
  const semantic = buildCanonicalSemanticModel(inventory);
  const semanticIds = new Set(semantic.nodes.map((node) => node.id));
  const sourceNodes: CanonicalSemanticNode[] = sourceItems.flatMap((item) => {
    const kind = SOURCE_KIND_MAP[item.kind];
    const id = stableId(kind, item.id, item.parentId);
    if (semanticIds.has(id)) return [];
    return [{
      id,
      kind,
      name: item.name,
      parentId: item.parentId,
      dependencies: item.dependencyIds,
      evidence: [{ sourceId: item.id, locator: item.path, excerpt: item.name }],
      metadata: {
        owner: item.owner || null,
        updatedAt: item.updatedAt || null,
        usageCount: item.usageCount ?? null,
        sourceKind: item.kind,
        featureFlags: item.featureFlags.join(','),
        riskFlags: item.riskFlags.join(','),
      },
    }];
  });
  return { ...semantic, nodes: [...semantic.nodes, ...sourceNodes].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)) };
}

export function canonicalDependencyOrder(model: CanonicalSemanticModel): string[] {
  const byId = new Map(model.nodes.map((node) => [node.id, node]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const ordered: string[] = [];
  const visit = (id: string) => {
    if (visited.has(id) || visiting.has(id)) return;
    visiting.add(id);
    byId.get(id)?.dependencies.forEach((dependency) => visit(dependency));
    visiting.delete(id);
    visited.add(id);
    ordered.push(id);
  };
  model.nodes.forEach((node) => visit(node.id));
  return ordered;
}

export function canonicalModelSummary(model: CanonicalSemanticModel): string {
  const counts = new Map<string, number>();
  model.nodes.forEach((node) => counts.set(node.kind, (counts.get(node.kind) || 0) + 1));
  return Array.from(counts.entries()).map(([kind, count]) => `${count} ${kind}${count === 1 ? '' : 's'}`).join(' · ');
}

const CANONICAL_FIELD_KINDS = new Set<CanonicalSemanticNode['kind']>(['field', 'measure', 'metric', 'attribute', 'calculation']);

export function canonicalFieldEvidenceReferences(model: CanonicalSemanticModel): string[] {
  return Array.from(new Set(model.nodes
    .filter((node) => CANONICAL_FIELD_KINDS.has(node.kind))
    .flatMap((node) => [
      node.id,
      node.name,
      ...node.evidence.flatMap((item) => [item.locator || '', item.sourceId, item.artifactId || '']),
    ])
    .map((value) => value.trim())
    .filter(Boolean))).sort();
}

function normalizedReference(value: string): string {
  return value.trim().toLowerCase().replace(/\[/g, '').replace(/\]/g, '').replace(/['"`]/g, '').replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '');
}

export interface CanonicalPromptScope {
  model: CanonicalSemanticModel;
  coverage: {
    totalNodes: number;
    includedNodes: number;
    omittedUnrelatedNodes: number;
    completeForSelectedScope: true;
  };
}

export function canonicalPromptScope(model: CanonicalSemanticModel, input: { fieldNames: string[]; dependencyIds: string[] }): CanonicalPromptScope {
  const fields = new Set(input.fieldNames.flatMap((field) => {
    const normalized = normalizedReference(field);
    const leaf = normalized.split('.').pop() || normalized;
    return [normalized, leaf].filter(Boolean);
  }));
  const dependencies = new Set(input.dependencyIds.map(normalizedReference));
  if (fields.size === 0 && dependencies.size === 0) {
    return { model, coverage: { totalNodes: model.nodes.length, includedNodes: model.nodes.length, omittedUnrelatedNodes: 0, completeForSelectedScope: true } };
  }

  const byId = new Map(model.nodes.map((node) => [node.id, node]));
  const included = new Set<string>();
  model.nodes.forEach((node) => {
    const nodeRefs = [
      node.id,
      node.name,
      ...node.evidence.flatMap((item) => [item.sourceId, item.artifactId || '', item.locator || '']),
    ].map(normalizedReference).filter(Boolean);
    if (nodeRefs.some((reference) => dependencies.has(reference) || fields.has(reference) || fields.has(reference.split('.').pop() || reference))) included.add(node.id);
  });

  const includeDependencies = (id: string) => {
    const node = byId.get(id);
    if (!node) return;
    if (node.parentId && !included.has(node.parentId)) {
      included.add(node.parentId);
      includeDependencies(node.parentId);
    }
    node.dependencies.forEach((dependency) => {
      if (included.has(dependency)) return;
      included.add(dependency);
      includeDependencies(dependency);
    });
  };
  Array.from(included).forEach(includeDependencies);
  if (included.size === 0) model.nodes.forEach((node) => included.add(node.id));
  const nodes = model.nodes.filter((node) => included.has(node.id));
  return {
    model: { ...model, nodes },
    coverage: {
      totalNodes: model.nodes.length,
      includedNodes: nodes.length,
      omittedUnrelatedNodes: model.nodes.length - nodes.length,
      completeForSelectedScope: true,
    },
  };
}

import type {
  CanonicalSemanticModel,
  MigrationDecision,
  OmniMigrationDeliverable,
  OmniMigrationDeliverableKind,
} from './types';

function deliverableKind(kind: CanonicalSemanticModel['nodes'][number]['kind']): OmniMigrationDeliverableKind | null {
  if (kind === 'model' || kind === 'data_source' || kind === 'dataset' || kind === 'cube') return 'model';
  if (kind === 'view' || kind === 'field' || kind === 'measure' || kind === 'metric' || kind === 'attribute' || kind === 'calculation' || kind === 'relationship') return 'view';
  if (kind === 'topic' || kind === 'filter') return 'topic';
  if (kind === 'permission') return 'permission';
  if (kind === 'schedule') return 'schedule';
  if (['report', 'dashboard', 'workbook', 'page', 'tile', 'visual', 'card'].includes(kind)) return 'dashboard';
  return null;
}

export function compileOmniMigrationDeliverables(model: CanonicalSemanticModel, decisions: MigrationDecision[]): OmniMigrationDeliverable[] {
  const decisionsByNode = new Map(decisions.map((decision) => [decision.nodeId, decision]));
  return model.nodes.flatMap((node) => {
    const kind = deliverableKind(node.kind);
    if (!kind) return [];
    const decision = decisionsByNode.get(node.id);
    const operation: OmniMigrationDeliverable['operation'] = !decision?.approvedByUser
      ? 'skip'
      : decision.action === 'map_existing'
        ? 'map'
        : decision.action === 'create_new'
          ? 'create'
          : decision.action === 'rewrite'
            ? 'update'
            : 'skip';
    return [{
      id: `deliverable:${node.id}`,
      kind,
      sourceAssetIds: node.evidence.map((item) => item.sourceId),
      targetId: decision?.targetId,
      targetName: decision?.targetLabel || node.name,
      operation,
      dependsOn: [...node.dependencies].sort(),
      payload: {
        sourceNodeId: node.id,
        sourceKind: node.kind,
        name: node.name,
        description: node.description || null,
        dataType: node.dataType || null,
        expression: node.expression || null,
        metadata: node.metadata,
        reviewRequired: operation === 'skip',
      },
      decisionIds: decision ? [decision.id] : [],
    }];
  }).sort((a, b) => a.kind.localeCompare(b.kind) || a.targetName.localeCompare(b.targetName) || a.id.localeCompare(b.id));
}

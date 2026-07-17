import type {
  CanonicalSemanticModel,
  MigrationDecision,
  OmniMigrationDeliverable,
  OmniMigrationDeliverableKind,
} from './types';
import {
  migrationDecisionSemanticKey,
  migrationDecisionSemanticKind,
} from './decisionIdentity';

function deliverableKind(kind: CanonicalSemanticModel['nodes'][number]['kind']): OmniMigrationDeliverableKind | null {
  if (kind === 'model' || kind === 'data_source' || kind === 'dataset' || kind === 'cube') return 'model';
  if (kind === 'view' || kind === 'field' || kind === 'measure' || kind === 'metric' || kind === 'attribute' || kind === 'calculation' || kind === 'relationship') return 'view';
  if (kind === 'topic' || kind === 'filter') return 'topic';
  if (kind === 'permission') return 'permission';
  if (kind === 'schedule') return 'schedule';
  if (['report', 'dashboard', 'workbook', 'page', 'tile', 'visual', 'card'].includes(kind)) return 'dashboard';
  return null;
}

function decisionDeliverableKind(decision: MigrationDecision): OmniMigrationDeliverableKind {
  const kind = migrationDecisionSemanticKind(decision);
  if (kind === 'data_source' || kind === 'model') return 'model';
  if (kind === 'view' || kind === 'field' || kind === 'measure' || kind === 'relationship') return 'view';
  if (kind === 'topic' || kind === 'filter') return 'topic';
  if (kind === 'permission' || kind === 'user' || kind === 'group') return 'permission';
  if (kind === 'schedule') return 'schedule';
  return 'dashboard';
}

function decisionOperation(decision: MigrationDecision | undefined): OmniMigrationDeliverable['operation'] {
  if (!decision?.approvedByUser) return 'skip';
  if (decision.action === 'map_existing') return 'map';
  if (decision.action === 'create_new') return 'create';
  if (decision.action === 'rewrite') return 'update';
  return 'skip';
}

export function compileOmniMigrationDeliverables(model: CanonicalSemanticModel, decisions: MigrationDecision[]): OmniMigrationDeliverable[] {
  const decisionsByNode = new Map<string, MigrationDecision[]>();
  decisions.forEach((decision) => decisionsByNode.set(
    decision.nodeId,
    [...(decisionsByNode.get(decision.nodeId) || []), decision],
  ));
  const boundDecisionIds = new Set<string>();
  const canonicalDeliverables = model.nodes.flatMap<OmniMigrationDeliverable>((node) => {
    const kind = deliverableKind(node.kind);
    if (!kind) return [];
    const related = decisionsByNode.get(node.id) || [];
    if (related.length === 0) {
      return [{
        id: `deliverable:${node.id}`,
        kind,
        sourceAssetIds: node.evidence.map((item) => item.sourceId),
        targetId: undefined,
        targetName: node.name,
        operation: 'skip' as const,
        dependsOn: [...node.dependencies].sort(),
        payload: {
          sourceNodeId: node.id,
          sourceKind: node.kind,
          name: node.name,
          description: node.description || null,
          dataType: node.dataType || null,
          expression: node.expression || null,
          metadata: node.metadata,
          reviewRequired: true,
        },
        decisionIds: [],
      }];
    }
    return related.map((decision) => {
      boundDecisionIds.add(decision.id);
      const operation = decisionOperation(decision);
      return {
        id: `deliverable:${migrationDecisionSemanticKey(decision)}`,
        kind: decisionDeliverableKind(decision),
        sourceAssetIds: Array.from(new Set([
          ...node.evidence.map((item) => item.sourceId),
          ...decision.evidence.map((item) => item.sourceId),
        ])),
        targetId: decision.targetId,
        targetName: decision.targetLabel || node.name,
        operation,
        dependsOn: [...node.dependencies].sort(),
        payload: {
          sourceNodeId: node.id,
          sourceKind: node.kind,
          semanticKind: migrationDecisionSemanticKind(decision),
          semanticKey: migrationDecisionSemanticKey(decision),
          name: node.name,
          description: node.description || null,
          dataType: node.dataType || null,
          expression: node.expression || null,
          metadata: node.metadata,
          reviewRequired: operation === 'skip',
        },
        decisionIds: [decision.id],
      };
    });
  });
  const unboundDeliverables = decisions
    .filter((decision) => !boundDecisionIds.has(decision.id))
    .map((decision) => {
      const operation = decisionOperation(decision);
      return {
        id: `deliverable:${migrationDecisionSemanticKey(decision)}`,
        kind: decisionDeliverableKind(decision),
        sourceAssetIds: Array.from(new Set([
          decision.nodeId,
          ...decision.evidence.map((item) => item.sourceId),
          ...decision.impactAssetIds,
        ].filter(Boolean))),
        targetId: decision.targetId,
        targetName: decision.targetLabel || decision.sourceLabel,
        operation,
        dependsOn: [],
        payload: {
          sourceNodeId: decision.nodeId,
          sourceKind: migrationDecisionSemanticKind(decision),
          semanticKind: migrationDecisionSemanticKind(decision),
          semanticKey: migrationDecisionSemanticKey(decision),
          name: decision.sourceLabel,
          reviewRequired: operation === 'skip',
        },
        decisionIds: [decision.id],
      } satisfies OmniMigrationDeliverable;
    });
  return [...canonicalDeliverables, ...unboundDeliverables]
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.targetName.localeCompare(b.targetName) || a.id.localeCompare(b.id));
}

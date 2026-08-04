import type {
  ArtifactPlacementDecision,
  AutomationHandoff,
  CanonicalMigrationGraph,
  TransformationOperation,
  TransformationPackage,
  TransformationTargetKind,
} from './types';
import { placementReadinessIssues } from './placement';

const SECRET_ASSIGNMENT = /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|private[_-]?key)\b\s*[:=]\s*['"]?[^\s,'";]+/i;
const UNSAFE_OBJECT_NAME = /[^a-zA-Z0-9_]/g;

function safeObjectName(value: string): string {
  const normalized = value.trim().replace(UNSAFE_OBJECT_NAME, '_').replace(/^_+|_+$/g, '').toLowerCase();
  return normalized || 'migrated_artifact';
}

function stableOrder(graph: CanonicalMigrationGraph, selectedNodeIds: Set<string>): string[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const ordered: string[] = [];
  const visit = (nodeId: string) => {
    if (visited.has(nodeId)) return;
    if (visiting.has(nodeId)) throw new Error(`Transformation dependency cycle detected at ${nodeId}.`);
    visiting.add(nodeId);
    byId.get(nodeId)?.dependencies.filter((dependency) => selectedNodeIds.has(dependency)).forEach(visit);
    visiting.delete(nodeId);
    visited.add(nodeId);
    ordered.push(nodeId);
  };
  Array.from(selectedNodeIds).sort().forEach(visit);
  return ordered;
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash)).map((part) => part.toString(16).padStart(2, '0')).join('');
}

function assertSecretSafe(value: string, label: string): void {
  if (SECRET_ASSIGNMENT.test(value)) {
    throw new Error(`${label} contains secret-shaped content and cannot be added to a migration package.`);
  }
}

function handoffForPlacement(decision: ArtifactPlacementDecision): AutomationHandoff {
  const target = decision.approvedTarget || decision.recommendedTarget;
  const category = target === 'governance_handoff'
    ? 'governance'
    : decision.reasonCodes.includes('side_effects')
      ? 'writeback'
      : decision.sourceKind === 'schedule'
        ? 'notification'
        : 'workflow';
  return {
    id: `handoff:${decision.nodeId}`,
    nodeId: decision.nodeId,
    sourceName: decision.sourceName,
    sourcePlatform: decision.sourcePlatform,
    category,
    rationale: decision.rationale,
    dependencies: [...decision.dependencies],
    recommendedOwner: target === 'governance_handoff' ? 'Security and analytics governance' : 'Data platform operations',
    acceptanceCriteria: [
      'An accountable owner accepts the handoff.',
      'Source behavior, schedule, inputs, and outputs are documented.',
      'A target implementation and rollback procedure are approved before dashboard cutover.',
    ],
  };
}

export async function buildTransformationPackage(input: {
  graph: CanonicalMigrationGraph;
  placements: ArtifactPlacementDecision[];
  target: TransformationTargetKind;
}): Promise<TransformationPackage> {
  const readinessIssues = placementReadinessIssues(input.placements, input.graph);
  if (readinessIssues.length > 0) {
    throw new Error(`Artifact placement is not ready: ${readinessIssues.slice(0, 5).join(' ')}`);
  }
  const byNodeId = new Map(input.graph.nodes.map((node) => [node.id, node]));
  const upstreamPlacements = input.placements.filter((decision) => (
    decision.approvedTarget || decision.recommendedTarget
  ) === 'upstream_transformation');
  const handoffPlacements = input.placements.filter((decision) => ['automation_handoff', 'governance_handoff'].includes(
    decision.approvedTarget || decision.recommendedTarget,
  ));
  const selectedNodeIds = new Set(upstreamPlacements.map((decision) => decision.nodeId));
  const dependencyOrder = stableOrder(input.graph, selectedNodeIds);
  const placementByNodeId = new Map(upstreamPlacements.map((decision) => [decision.nodeId, decision]));
  const operations: TransformationOperation[] = [];
  const warnings: string[] = [];

  for (const nodeId of dependencyOrder) {
    const node = byNodeId.get(nodeId)!;
    const placement = placementByNodeId.get(nodeId)!;
    const execution = input.graph.executionByNodeId[nodeId]!;
    const sql = node.expression?.trim();
    if (!sql) {
      warnings.push(`${node.name} has no executable expression and was omitted from the transformation package.`);
      continue;
    }
    assertSecretSafe(sql, node.name);
    const materialization = execution.incremental
      ? 'incremental'
      : execution.materialized
        ? 'table'
        : 'view';
    const kind = materialization === 'incremental'
      ? 'create_incremental_model'
      : materialization === 'table'
        ? 'create_table'
        : 'create_view';
    const name = safeObjectName(placement.targetObjectName || node.name);
    const operationSeed = JSON.stringify({ nodeId, name, kind, sql, dependencies: node.dependencies });
    operations.push({
      id: `operation:${nodeId}`,
      nodeId,
      name,
      kind,
      sql,
      dependencies: node.dependencies.filter((dependency) => selectedNodeIds.has(dependency)),
      sourceEvidenceIds: node.evidence.map((reference) => reference.sourceId),
      reasonCodes: [...placement.reasonCodes],
      materialization,
      idempotencyKey: await sha256(operationSeed),
    });
  }

  const packageSeed = JSON.stringify({
    sourcePlatform: input.graph.sourcePlatform,
    target: input.target,
    operations: operations.map((operation) => operation.idempotencyKey),
    handoffs: handoffPlacements.map((decision) => decision.nodeId).sort(),
  });
  const packageHash = await sha256(packageSeed);
  return {
    schemaVersion: '1.0',
    packageId: `transformation-${packageHash.slice(0, 16)}`,
    generatedAt: input.graph.generatedAt,
    sourcePlatform: input.graph.sourcePlatform,
    target: input.target,
    placements: input.placements.map((decision) => ({ ...decision, dependencies: [...decision.dependencies], missingEvidence: [...decision.missingEvidence], reasonCodes: [...decision.reasonCodes] })),
    operations,
    handoffs: handoffPlacements.map(handoffForPlacement),
    files: [],
    dependencyOrder: operations.map((operation) => operation.id),
    validationQueries: operations.map((operation) => `SELECT * FROM ${operation.name} LIMIT 1;`),
    rollbackInstructions: operations.map((operation) => `Remove ${operation.name} only after confirming no downstream dependency uses it.`),
    warnings,
  };
}

export async function transformationPackageFileChecksum(content: string): Promise<string> {
  assertSecretSafe(content, 'Generated transformation file');
  return sha256(content);
}

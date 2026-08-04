import type {
  ArtifactPlacementDecision,
  CanonicalMigrationGraph,
  CanonicalSemanticNode,
  MigrationBiSourceTool,
  MigrationDecision,
  MigrationExecutionCharacteristics,
  MigrationPlacementTarget,
  TransformationTargetKind,
} from './types';

const OMNI_SEMANTIC_TARGETS = new Set<MigrationPlacementTarget>([
  'omni_view',
  'omni_topic',
  'omni_query_view',
]);

const PLACEMENT_NODE_KINDS = new Set<CanonicalSemanticNode['kind']>([
  'view',
  'field',
  'measure',
  'relationship',
  'topic',
  'data_source',
  'dataset',
  'cube',
  'metric',
  'attribute',
  'calculation',
  'permission',
  'schedule',
  'transformation',
  'materialization',
  'automation',
  'policy',
  'output',
]);

type SourcePolicy = {
  upstream: RegExp;
  automation: RegExp;
  governance: RegExp;
  queryView: RegExp;
};

export const SOURCE_PLACEMENT_POLICIES: Record<MigrationBiSourceTool, SourcePolicy> = {
  domo: {
    upstream: /\b(magic etl|dataflow|dataset view|workbench|connector|sql dataflow)\b/i,
    automation: /\b(workflow|form|code engine|alert|buzz|writeback)\b/i,
    governance: /\b(pdp|personalized data permission|dataset access|role)\b/i,
    queryView: /\b(dataset view|sql view)\b/i,
  },
  looker: {
    upstream: /\b(persistent derived table|pdt|derived table|datagroup|persist_for|sql_trigger_value)\b/i,
    automation: /\b(schedule|scheduled plan|action hub|webhook)\b/i,
    governance: /\b(access grant|access filter|user attribute)\b/i,
    queryView: /\b(derived table|native derived table|sql_table_name)\b/i,
  },
  metabase: {
    upstream: /\b(model persistence|persisted model|transform|materialized)\b/i,
    automation: /\b(pulse|subscription|alert|action|writeback)\b/i,
    governance: /\b(sandbox|row level|permission|group)\b/i,
    queryView: /\b(native query|sql question|model)\b/i,
  },
  microstrategy: {
    upstream: /\b(cube|intelligent cube|freeform sql|data mart|warehouse catalog)\b/i,
    automation: /\b(subscription|schedule|distribution service|transaction service)\b/i,
    governance: /\b(security filter|acl|permission|role)\b/i,
    queryView: /\b(freeform sql|report sql)\b/i,
  },
  power_bi: {
    upstream: /\b(power query|m expression|partition|dataflow|incremental refresh|calculated table)\b/i,
    automation: /\b(subscription|alert|power automate|writeback)\b/i,
    governance: /\b(rls|ols|role|object level security|row level security)\b/i,
    queryView: /\b(native query|directquery|power query)\b/i,
  },
  sigma: {
    upstream: /\b(materialization|dataset|warehouse view|writeback table|input table)\b/i,
    automation: /\b(schedule|alert|notification|action|writeback)\b/i,
    governance: /\b(row level security|team|permission)\b/i,
    queryView: /\b(custom sql|dataset sql)\b/i,
  },
  tableau: {
    upstream: /\b(extract|hyper|custom sql|prep flow|materialized)\b/i,
    automation: /\b(subscription|alert|extension|writeback)\b/i,
    governance: /\b(entitlement|user filter|row level security|permission)\b/i,
    queryView: /\b(custom sql|logical table)\b/i,
  },
  webfocus: {
    upstream: /\b(focexec|procedure|hold file|modify|maintain|data flow|synonym)\b/i,
    automation: /\b(reportcaster|schedule|alert|maintain|writeback)\b/i,
    governance: /\b(metadata security|access file|permission|role)\b/i,
    queryView: /\b(report procedure|table file|sql)\b/i,
  },
};

function nodeSignals(node: CanonicalSemanticNode): string {
  return [
    node.kind,
    node.name,
    node.description || '',
    node.expression || '',
    ...Object.entries(node.metadata).flatMap(([key, value]) => [key, String(value ?? '')]),
  ].join(' ');
}

function hardQueryViewBlocker(execution: MigrationExecutionCharacteristics): string | null {
  if (execution.scheduled) return 'scheduled';
  if (execution.incremental) return 'incremental';
  if (execution.stateful) return 'stateful';
  if (execution.sideEffects) return 'side_effecting';
  if (execution.scripting) return 'scripted';
  if (execution.materialized) return 'materialized';
  if (execution.estimatedComplexity === 'heavy') return 'heavy';
  return null;
}

function recommendTarget(
  node: CanonicalSemanticNode,
  execution: MigrationExecutionCharacteristics,
  sourcePlatform: MigrationBiSourceTool,
): { target: MigrationPlacementTarget; reasons: string[]; rationale: string; confidence: ArtifactPlacementDecision['confidence'] } {
  const signal = nodeSignals(node);
  const policy = SOURCE_PLACEMENT_POLICIES[sourcePlatform];
  const queryViewBlocker = hardQueryViewBlocker(execution);

  if (node.kind === 'permission' || node.kind === 'policy' || policy.governance.test(signal)) {
    return {
      target: 'governance_handoff',
      reasons: ['governance_boundary', 'human_review_required'],
      rationale: 'Access and governance behavior must be reviewed against Omni roles, groups, and model permissions.',
      confidence: 'high',
    };
  }
  if (node.kind === 'schedule' || node.kind === 'automation' || execution.sideEffects || policy.automation.test(signal)) {
    return {
      target: 'automation_handoff',
      reasons: ['operational_behavior', execution.sideEffects ? 'side_effects' : 'scheduled_or_triggered'],
      rationale: 'Operational workflows, notifications, writebacks, and schedules need an accountable platform handoff.',
      confidence: 'high',
    };
  }
  if (
    node.kind === 'dataset'
    || node.kind === 'data_source'
    || node.kind === 'cube'
    || node.kind === 'transformation'
    || node.kind === 'materialization'
    || Boolean(queryViewBlocker)
    || policy.upstream.test(signal)
  ) {
    return {
      target: 'upstream_transformation',
      reasons: Array.from(new Set(['warehouse_owned', ...(queryViewBlocker ? [`query_view_blocked_${queryViewBlocker}`] : [])])),
      rationale: queryViewBlocker
        ? `This artifact is ${queryViewBlocker.replace('_', ' ')} and should run upstream instead of at dashboard query time.`
        : 'This artifact defines reusable or materialized data preparation that belongs in the governed data platform.',
      confidence: queryViewBlocker || policy.upstream.test(signal) ? 'high' : 'medium',
    };
  }
  if (node.kind === 'topic') {
    return {
      target: 'omni_topic',
      reasons: ['curated_exploration'],
      rationale: 'This artifact curates a governed exploration surface and belongs in an Omni topic.',
      confidence: 'high',
    };
  }
  if (node.kind === 'view' && execution.queryTimeSafe && policy.queryView.test(signal)) {
    return {
      target: 'omni_query_view',
      reasons: ['read_only', 'query_time_safe', 'bounded_transformation'],
      rationale: 'This is a bounded read-only transformation that can safely compile at Omni query time.',
      confidence: 'medium',
    };
  }
  if (['view', 'field', 'measure', 'metric', 'attribute', 'calculation', 'relationship'].includes(node.kind)) {
    return {
      target: 'omni_view',
      reasons: ['semantic_modeling'],
      rationale: 'This artifact describes reusable semantic meaning and belongs in the Omni model layer.',
      confidence: 'high',
    };
  }
  return {
    target: 'exclude',
    reasons: ['downstream_or_context_only'],
    rationale: 'This source object is context for migration but does not require its own deployed artifact.',
    confidence: 'medium',
  };
}

export function recommendArtifactPlacements(
  graph: CanonicalMigrationGraph,
  targetAdapter: TransformationTargetKind = 'generic_sql',
): ArtifactPlacementDecision[] {
  const sourcePlatform = graph.sourcePlatform === 'dbt' || graph.sourcePlatform === 'omni'
    ? null
    : graph.sourcePlatform;
  if (!sourcePlatform) return [];
  return graph.nodes
    .filter((node) => PLACEMENT_NODE_KINDS.has(node.kind))
    .map((node) => {
      const execution = graph.executionByNodeId[node.id]!;
      const recommendation = recommendTarget(node, execution, sourcePlatform);
      const missingEvidence = recommendation.target === 'upstream_transformation' && !node.expression?.trim()
        ? ['Executable source expression or transformation definition is missing.']
        : [];
      return {
        id: `placement:${node.id}`,
        nodeId: node.id,
        sourcePlatform,
        sourceKind: node.kind,
        sourceName: node.name,
        recommendedTarget: recommendation.target,
        targetAdapter: recommendation.target === 'upstream_transformation' ? targetAdapter : undefined,
        deploymentMode: 'export',
        targetObjectName: node.name,
        reasonCodes: recommendation.reasons,
        rationale: recommendation.rationale,
        confidence: missingEvidence.length > 0 ? 'low' : recommendation.confidence,
        blocking: recommendation.target !== 'exclude',
        missingEvidence,
        dependencies: [...node.dependencies],
        approvedByUser: false,
      } satisfies ArtifactPlacementDecision;
    })
    .sort((left, right) => left.recommendedTarget.localeCompare(right.recommendedTarget) || left.sourceName.localeCompare(right.sourceName));
}

export function artifactPlacementResolutionIssue(
  decision: ArtifactPlacementDecision,
  graph?: CanonicalMigrationGraph,
): string | null {
  const target = decision.approvedTarget || decision.recommendedTarget;
  if (decision.missingEvidence.length > 0 && target === 'upstream_transformation') return decision.missingEvidence[0]!;
  if (target === 'upstream_transformation' && !decision.targetAdapter) return `Choose an upstream package target for ${decision.sourceName}.`;
  if (target === 'omni_query_view' && graph) {
    const blocker = hardQueryViewBlocker(graph.executionByNodeId[decision.nodeId]!);
    if (blocker) return `${decision.sourceName} cannot be placed in an Omni query view because it is ${blocker.replace('_', ' ')}.`;
  }
  if (decision.blocking && !decision.approvedByUser) return `Approve the placement for ${decision.sourceName}.`;
  if (decision.deploymentMode === 'deploy' && target !== 'upstream_transformation') {
    return 'Direct deployment is only available for approved upstream transformation packages.';
  }
  return null;
}

export function placementReadinessIssues(
  decisions: ArtifactPlacementDecision[],
  graph?: CanonicalMigrationGraph,
): string[] {
  return decisions.flatMap((decision) => {
    const issue = artifactPlacementResolutionIssue(decision, graph);
    return issue ? [issue] : [];
  });
}

export function acceptRecommendedPlacements(
  decisions: ArtifactPlacementDecision[],
): ArtifactPlacementDecision[] {
  return decisions.map((decision) => ({
    ...decision,
    approvedTarget: decision.recommendedTarget,
    approvedByUser: decision.missingEvidence.length === 0,
  }));
}

export function updateArtifactPlacement(
  decisions: ArtifactPlacementDecision[],
  nodeId: string,
  patch: Partial<Pick<ArtifactPlacementDecision, 'approvedTarget' | 'targetAdapter' | 'deploymentMode' | 'targetObjectName' | 'approvedByUser'>>,
  graph?: CanonicalMigrationGraph,
): ArtifactPlacementDecision[] {
  return decisions.map((decision) => {
    if (decision.nodeId !== nodeId) return decision;
    const updated = { ...decision, ...patch };
    if (updated.approvedTarget !== 'upstream_transformation') {
      updated.deploymentMode = 'export';
      updated.targetAdapter = undefined;
    }
    if (updated.approvedTarget === 'omni_query_view' && graph) {
      const blocker = hardQueryViewBlocker(graph.executionByNodeId[nodeId]!);
      if (blocker) updated.approvedByUser = false;
    }
    return updated;
  });
}

export function migrationDecisionsForApprovedPlacements(
  decisions: MigrationDecision[],
  placements: ArtifactPlacementDecision[],
): MigrationDecision[] {
  if (placements.length === 0) return decisions;
  const placementByNodeId = new Map(placements.map((placement) => [placement.nodeId, placement]));
  return decisions.filter((decision) => {
    const placement = placementByNodeId.get(decision.nodeId);
    if (!placement) return true;
    const target = placement.approvedTarget || placement.recommendedTarget;
    return placement.approvedByUser && OMNI_SEMANTIC_TARGETS.has(target);
  });
}

import type {
  MigrationDecision,
  MigrationMappingDomain,
  MicroStrategyManualParseResult,
  SemanticEvidenceReference,
} from './types';
import type {
  MicroStrategyArtifactClass,
  MicroStrategyDependencyEdge,
  MicroStrategyEvidenceBundle,
  MicroStrategyEvidenceNode,
} from './microStrategyEvidence';
import {
  mergeMigrationDecisionProposalChunks,
  withMigrationDecisionIdentity,
} from './decisionIdentity';

type EvidenceAwareMicroStrategyResult = MicroStrategyManualParseResult & {
  evidence?: MicroStrategyEvidenceBundle;
};

const MISSING_EVIDENCE_REASON_CODES = new Set([
  'metric_dimensionality_missing',
  'freeform_sql_evidence_missing',
  'dataset_dependency_missing',
]);

function normalized(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort();
}

function kindLabel(kind: MicroStrategyArtifactClass): string {
  return kind.replace(/_/g, ' ');
}

function domainForKind(kind: MicroStrategyArtifactClass): MigrationMappingDomain {
  if (kind === 'metric') return 'measure';
  if (kind === 'attribute' || kind === 'attribute_form' || kind === 'derived_element') return 'field';
  if (kind === 'filter' || kind === 'prompt' || kind === 'report_limit' || kind === 'metric_limit') return 'filter';
  if (kind === 'dossier' || kind === 'document') return 'content';
  if (kind === 'sql') return 'data_source';
  return 'model';
}

function nodeEvidence(nodes: MicroStrategyEvidenceNode[]): SemanticEvidenceReference[] {
  return Array.from(new Map(nodes.map((node) => [
    `${node.evidenceId}:${node.sourceArtifact}:${node.sourcePath}`,
    {
      sourceId: node.evidenceId,
      artifactId: node.sourceArtifact,
      locator: node.sourcePath,
    },
  ])).values()).sort((left, right) => (
    left.sourceId.localeCompare(right.sourceId)
    || (left.artifactId || '').localeCompare(right.artifactId || '')
    || (left.locator || '').localeCompare(right.locator || '')
  ));
}

function groupedNodes(
  nodes: MicroStrategyEvidenceNode[],
  key: (node: MicroStrategyEvidenceNode) => string,
): MicroStrategyEvidenceNode[][] {
  const groups = new Map<string, MicroStrategyEvidenceNode[]>();
  nodes.forEach((node) => groups.set(key(node), [...(groups.get(key(node)) || []), node]));
  return Array.from(groups.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, values]) => values.sort((left, right) => left.evidenceId.localeCompare(right.evidenceId)));
}

function sourceIdentity(node: MicroStrategyEvidenceNode): string {
  return node.sourceId || node.evidenceId;
}

function requiredDecision(input: {
  category: string;
  identity: string;
  domain: MigrationMappingDomain;
  sourceLabel: string;
  rationale: string;
  evidence: SemanticEvidenceReference[];
  impactAssetIds: string[];
}): MigrationDecision {
  const stableIdentity = normalized(input.identity);
  return withMigrationDecisionIdentity({
    id: `decision:microstrategy:${input.domain}:${normalized(input.category)}:${stableIdentity}`,
    nodeId: `microstrategy:${normalized(input.category)}:${stableIdentity}`,
    domain: input.domain,
    sourceLabel: input.sourceLabel,
    action: 'defer',
    rationale: input.rationale,
    confidence: 1,
    evidence: input.evidence,
    blocking: true,
    impactAssetIds: input.impactAssetIds,
    validationRequired: true,
    compatibilityKey: `microstrategy:${input.domain}:${normalized(input.category)}`,
    approvedByUser: false,
  });
}

function missingEvidenceRationale(node: MicroStrategyEvidenceNode, reasonCode: string): string {
  const identity = node.sourceId || node.name;
  if (reasonCode === 'metric_dimensionality_missing') {
    return `Metric ${identity} has no explicit dimty evidence. Its dimensionality remains unresolved and must not be inferred from the metric expression.`;
  }
  if (reasonCode === 'freeform_sql_evidence_missing') {
    return `Freeform SQL report ${identity} has no execution SQL evidence in the typed parser bundle. Recover the missing source evidence before deciding its target architecture.`;
  }
  if (reasonCode === 'dataset_dependency_missing') {
    return `${kindLabel(node.kind)} ${identity} does not identify a dataset dependency in the typed parser bundle. Recover or explicitly hand off that dependency before approval.`;
  }
  return `${kindLabel(node.kind)} ${identity} is referenced without a full typed definition. Recover the definition or record an accountable handoff before approval.`;
}

function missingEvidenceDecisions(
  bundle: MicroStrategyEvidenceBundle,
  impactAssetIds: string[],
): MigrationDecision[] {
  const rows = bundle.nodes.flatMap((node) => node.classification.reasonCodes.flatMap((reasonCode) => (
    reasonCode.endsWith('_definition_missing') || MISSING_EVIDENCE_REASON_CODES.has(reasonCode)
      ? [{ node, reasonCode }]
      : []
  )));
  const groups = new Map<string, typeof rows>();
  rows.forEach((row) => {
    const key = `${row.node.kind}:${sourceIdentity(row.node)}:${row.reasonCode}`;
    groups.set(key, [...(groups.get(key) || []), row]);
  });
  return Array.from(groups.entries()).sort(([left], [right]) => left.localeCompare(right)).map(([identity, group]) => {
    const representative = group[0]!;
    const category = representative.reasonCode === 'metric_dimensionality_missing'
      ? 'metric_dimensionality'
      : 'missing_evidence';
    return requiredDecision({
      category,
      identity: `${identity}:${representative.reasonCode}`,
      domain: domainForKind(representative.node.kind),
      sourceLabel: `${representative.node.name} (${representative.reasonCode.replace(/_/g, ' ')})`,
      rationale: missingEvidenceRationale(representative.node, representative.reasonCode),
      evidence: nodeEvidence(group.map((row) => row.node)),
      impactAssetIds,
    });
  });
}

function dependencyGapDecisions(
  bundle: MicroStrategyEvidenceBundle,
  impactAssetIds: string[],
): MigrationDecision[] {
  const nodeByEvidenceId = new Map(bundle.nodes.map((node) => [node.evidenceId, node]));
  const groups = new Map<string, MicroStrategyDependencyEdge[]>();
  bundle.dependencies.filter((edge) => edge.status !== 'resolved').forEach((edge) => {
    const owner = nodeByEvidenceId.get(edge.sourceEvidenceId);
    if (!owner) return;
    const key = [
      owner.kind,
      sourceIdentity(owner),
      edge.dependencySourceId,
      edge.requirement,
      edge.expectedKinds.slice().sort().join(','),
    ].join(':');
    groups.set(key, [...(groups.get(key) || []), edge]);
  });
  return Array.from(groups.entries()).sort(([left], [right]) => left.localeCompare(right)).map(([identity, edges]) => {
    const edge = edges[0]!;
    const owner = nodeByEvidenceId.get(edge.sourceEvidenceId)!;
    const evidenceNodes = edges.flatMap((item) => [
      nodeByEvidenceId.get(item.sourceEvidenceId),
      item.resolvedEvidenceId ? nodeByEvidenceId.get(item.resolvedEvidenceId) : undefined,
    ]).filter((node): node is MicroStrategyEvidenceNode => Boolean(node));
    return requiredDecision({
      category: `dependency_${edge.status}`,
      identity,
      domain: domainForKind(owner.kind),
      sourceLabel: `${owner.name} dependency: ${edge.dependencyName || edge.dependencySourceId}`,
      rationale: `${kindLabel(owner.kind)} ${owner.sourceId || owner.name} requires ${edge.dependencySourceId}, but the typed ${edge.requirement} evidence is ${edge.status}. Recover the dependency or assign an explicit handoff before approval.`,
      evidence: nodeEvidence(evidenceNodes),
      impactAssetIds,
    });
  });
}

function behaviorDecisions(
  bundle: MicroStrategyEvidenceBundle,
  impactAssetIds: string[],
): MigrationDecision[] {
  const nodesByEvidenceId = new Map(bundle.nodes.map((node) => [node.evidenceId, node]));
  const decisions: MigrationDecision[] = [];

  groupedNodes(bundle.nodes.filter((node) => node.kind === 'prompt'), (node) => `${sourceIdentity(node)}:${node.occurrenceKey || ''}`)
    .forEach((nodes) => decisions.push(requiredDecision({
      category: 'prompt_behavior',
      identity: `${sourceIdentity(nodes[0]!)}:${nodes[0]!.occurrenceKey || ''}`,
      domain: 'filter',
      sourceLabel: `Prompt: ${nodes[0]!.name}`,
      rationale: 'Typed parser evidence identifies this prompt and its captured occurrence state, but its target control, answer, default, and required behavior remain an explicit operator decision.',
      evidence: nodeEvidence(nodes),
      impactAssetIds,
    })));

  bundle.nodes.filter((node) => node.kind === 'filter' && node.details.filterRole === 'selector')
    .sort((left, right) => left.evidenceId.localeCompare(right.evidenceId))
    .forEach((node) => decisions.push(requiredDecision({
      category: 'selector_behavior',
      identity: node.evidenceId,
      domain: 'filter',
      sourceLabel: `Selector: ${node.name}`,
      rationale: 'Typed parser evidence identifies this dossier selector. Its target control, scope, and interaction behavior remain unresolved pending operator review.',
      evidence: nodeEvidence([node]),
      impactAssetIds,
    })));

  groupedNodes(bundle.nodes.filter((node) => node.kind === 'report' && node.details.freeformSql), sourceIdentity)
    .forEach((nodes) => {
      const sqlNodes = nodes.flatMap((node) => node.kind === 'report'
        ? node.details.sqlEvidenceIds.map((evidenceId) => nodesByEvidenceId.get(evidenceId)).filter((item): item is MicroStrategyEvidenceNode => Boolean(item))
        : []);
      decisions.push(requiredDecision({
        category: 'freeform_sql_architecture',
        identity: sourceIdentity(nodes[0]!),
        domain: 'data_source',
        sourceLabel: `Freeform SQL report: ${nodes[0]!.name}`,
        rationale: 'The report is classified as Freeform SQL. Captured SQL is execution-scoped evidence, not a semantic definition; target ownership and validation remain unresolved.',
        evidence: nodeEvidence([...nodes, ...sqlNodes]),
        impactAssetIds,
      }));
    });

  groupedNodes(bundle.nodes.filter((node) => node.kind === 'dataset' || node.kind === 'intelligent_cube'), sourceIdentity)
    .forEach((nodes) => decisions.push(requiredDecision({
      category: 'cube_or_dataset_architecture',
      identity: sourceIdentity(nodes[0]!),
      domain: 'model',
      sourceLabel: `Cube or dataset: ${nodes[0]!.name}`,
      rationale: 'Typed cube or dataset evidence identifies source objects and dependencies, but does not decide target ownership, materialization, or refresh behavior.',
      evidence: nodeEvidence(nodes),
      impactAssetIds,
    })));

  bundle.nodes.filter((node) => node.kind === 'report_limit' || node.kind === 'metric_limit')
    .sort((left, right) => left.evidenceId.localeCompare(right.evidenceId))
    .forEach((node) => decisions.push(requiredDecision({
      category: 'limit_behavior',
      identity: node.evidenceId,
      domain: 'filter',
      sourceLabel: `${kindLabel(node.kind)}: ${node.name}`,
      rationale: 'The typed parser classifies this limit as unsupported migration behavior and did not coerce it into a target filter. Rebuild, hand off, or explicitly exclude it through operator review.',
      evidence: nodeEvidence([node]),
      impactAssetIds,
    })));

  groupedNodes(bundle.nodes.filter((node) => node.kind === 'derived_element'), sourceIdentity)
    .forEach((nodes) => decisions.push(requiredDecision({
      category: 'derived_element_behavior',
      identity: sourceIdentity(nodes[0]!),
      domain: 'field',
      sourceLabel: `Derived element: ${nodes[0]!.name}`,
      rationale: 'The typed parser classifies this derived element as unsupported translation behavior. No target field or expression was inferred.',
      evidence: nodeEvidence(nodes),
      impactAssetIds,
    })));

  return decisions;
}

function governanceHandoffDecisions(
  bundle: MicroStrategyEvidenceBundle,
  impactAssetIds: string[],
): MigrationDecision[] {
  const sortedNodes = bundle.nodes.slice().sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
  const projectAnchors = sortedNodes.filter((node) => node.kind === 'project');
  const anchors = projectAnchors.length > 0 ? projectAnchors : sortedNodes.slice(0, 1);
  return anchors.flatMap((anchor) => ([
    requiredDecision({
      category: 'permissions_handoff',
      identity: sourceIdentity(anchor),
      domain: 'permission',
      sourceLabel: `Permissions handoff: ${anchor.name}`,
      rationale: 'The typed parser bundle contains no permission or ACL objects. Assign an accountable source inventory and target authorization validation handoff before approval.',
      evidence: nodeEvidence([anchor]),
      impactAssetIds,
    }),
    requiredDecision({
      category: 'schedules_handoff',
      identity: sourceIdentity(anchor),
      domain: 'schedule',
      sourceLabel: `Schedules handoff: ${anchor.name}`,
      rationale: 'The typed parser bundle contains no schedule or subscription objects. Assign an accountable source inventory and target operational validation handoff before approval.',
      evidence: nodeEvidence([anchor]),
      impactAssetIds,
    }),
  ]));
}

export function requiredMicroStrategyMigrationDecisions(
  result: EvidenceAwareMicroStrategyResult | null,
  selectedAssetIds: string[] = [],
): MigrationDecision[] {
  const bundle = result?.evidence;
  if (!bundle?.nodes.length) return [];
  const impactAssetIds = uniqueSorted(selectedAssetIds);
  return mergeMigrationDecisionProposalChunks([[
    ...missingEvidenceDecisions(bundle, impactAssetIds),
    ...dependencyGapDecisions(bundle, impactAssetIds),
    ...behaviorDecisions(bundle, impactAssetIds),
    ...governanceHandoffDecisions(bundle, impactAssetIds),
  ]]);
}

function evidenceMergeKey(reference: SemanticEvidenceReference): string {
  return `${reference.sourceId}:${reference.artifactId || ''}:${reference.locator || ''}`;
}

function mergeKey(decision: MigrationDecision): string {
  return `${decision.domain}:${normalized(decision.sourceLabel)}`;
}

export function mergeRequiredMicroStrategyDecisions(
  providerDecisions: MigrationDecision[],
  requiredDecisions: MigrationDecision[],
): MigrationDecision[] {
  const remaining = new Map(requiredDecisions.map((decision) => [decision.id, decision]));
  const byNodeId = new Map(requiredDecisions.map((decision) => [decision.nodeId, decision]));
  const byMergeKey = new Map<string, MigrationDecision[]>();
  const byEvidenceId = new Map<string, MigrationDecision[]>();
  requiredDecisions.forEach((decision) => {
    const key = mergeKey(decision);
    byMergeKey.set(key, [...(byMergeKey.get(key) || []), decision]);
    decision.evidence.forEach((reference) => {
      byEvidenceId.set(reference.sourceId, [...(byEvidenceId.get(reference.sourceId) || []), decision]);
    });
  });
  const firstAvailable = (candidates: MigrationDecision[]) => candidates.find((candidate) => remaining.has(candidate.id));
  const mergedProviderDecisions = providerDecisions.map((providerDecision) => {
    const evidenceMatches = providerDecision.evidence.flatMap((reference) => byEvidenceId.get(reference.sourceId) || []);
    const required = remaining.get(providerDecision.id)
      || (byNodeId.get(providerDecision.nodeId) && remaining.has(byNodeId.get(providerDecision.nodeId)!.id)
        ? byNodeId.get(providerDecision.nodeId)
        : undefined)
      || firstAvailable(evidenceMatches)
      || firstAvailable(byMergeKey.get(mergeKey(providerDecision)) || []);
    if (!required) return providerDecision;
    remaining.delete(required.id);
    return withMigrationDecisionIdentity({
      ...required,
      ...providerDecision,
      id: required.id,
      nodeId: required.nodeId,
      semanticKind: required.semanticKind,
      semanticKey: undefined,
      domain: required.domain,
      sourceLabel: required.sourceLabel,
      rationale: providerDecision.rationale === required.rationale
        ? required.rationale
        : `${required.rationale} Provider proposal: ${providerDecision.rationale}`,
      evidence: Array.from(new Map([...required.evidence, ...providerDecision.evidence].map((reference) => [
        evidenceMergeKey(reference),
        reference,
      ])).values()),
      impactAssetIds: uniqueSorted([...required.impactAssetIds, ...providerDecision.impactAssetIds]),
      blocking: true,
      validationRequired: true,
      compatibilityKey: required.compatibilityKey,
      approvedByUser: false,
    });
  });

  return mergeMigrationDecisionProposalChunks([[
    ...mergedProviderDecisions,
    ...Array.from(remaining.values()).map(withMigrationDecisionIdentity),
  ]]);
}

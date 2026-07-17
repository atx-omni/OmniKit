import type {
  MigrationDecision,
  MigrationDecisionAction,
  MigrationMappingDomain,
  PowerBiManualMapping,
  PowerBiManualParseResult,
  SemanticYamlFileName,
} from './types';
import {
  mergeMigrationDecisionProposalChunks,
  withMigrationDecisionIdentity,
} from './decisionIdentity';

function normalized(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function normalizedPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/').toLowerCase();
}

interface SelectedProjectScope {
  projectId: string;
  projectName: string;
  reportIds: string[];
  sourceFiles: Set<string>;
}

function selectedProjectScopes(result: PowerBiManualParseResult, selectedDashboardIds: string[]): SelectedProjectScope[] {
  const selected = new Set(selectedDashboardIds);
  return (result.projects || []).flatMap((project) => {
    const reportIds = project.reports.filter((report) => selected.has(report.id)).map((report) => report.id).sort();
    return reportIds.length ? [{
      projectId: project.id,
      projectName: project.name,
      reportIds,
      sourceFiles: new Set([...project.sourceFiles, ...project.reports.map((report) => report.sourceArtifact)].map(normalizedPath)),
    }] : [];
  });
}

function allProjectFiles(result: PowerBiManualParseResult): Set<string> {
  return new Set((result.projects || []).flatMap((project) => [...project.sourceFiles, ...project.reports.map((report) => report.sourceArtifact)]).map(normalizedPath));
}

export function unassignedPowerBiDecisionArtifacts(result: PowerBiManualParseResult | null, selectedDashboardIds: string[]): string[] {
  if (!result) return [];
  const scopes = selectedProjectScopes(result, selectedDashboardIds);
  if (scopes.length === 0) return [];
  const ownedFiles = allProjectFiles(result);
  return Array.from(new Set(result.mappings.flatMap((mapping) => decisionShape(mapping) && !ownedFiles.has(normalizedPath(mapping.sourceArtifact)) ? [mapping.sourceArtifact] : []))).sort();
}

function semanticFileName(mapping: PowerBiManualMapping): SemanticYamlFileName | undefined {
  if (mapping.targetName === 'relationships') return 'relationships';
  if (mapping.targetName.endsWith('.view') || mapping.targetName.endsWith('.topic')) return mapping.targetName as SemanticYamlFileName;
  if (['measure', 'calculated_column', 'calculation_group'].includes(mapping.sourceKind)) {
    const table = mapping.sourceName.split('.')[0] || 'power_bi';
    return `${normalized(table)}.view`;
  }
  return undefined;
}

function decisionShape(mapping: PowerBiManualMapping): { domain: MigrationMappingDomain; action: MigrationDecisionAction; rationale: string } | null {
  if (mapping.sourceKind === 'measure' || mapping.sourceKind === 'calculated_column' || mapping.sourceKind === 'calculation_group') {
    return { domain: mapping.sourceKind === 'calculated_column' ? 'field' : 'measure', action: mapping.sourceKind === 'calculation_group' ? 'rewrite' : 'create_new', rationale: `${mapping.sourceKind.split('_').join(' ')} semantics require an explicit target mapping or reviewed Omni definition.` };
  }
  if ((mapping.sourceKind === 'partition' || mapping.sourceKind === 'data_source') && mapping.targetKind === 'query_view') {
    return { domain: 'data_source', action: 'rewrite', rationale: 'Power Query/M cannot be executed as-is; choose a reviewed Omni query view or map it to an existing warehouse-backed view.' };
  }
  if (mapping.sourceKind === 'relationship') {
    return { domain: 'relationship', action: 'create_new', rationale: 'Relationship keys, cardinality, direction, and active state require an explicit Omni relationship decision.' };
  }
  if (mapping.sourceKind === 'role' || mapping.sourceKind === 'sensitivity_label' || mapping.sourceKind === 'culture') {
    return { domain: 'permission', action: 'defer', rationale: 'Security and governance evidence must be mapped, redesigned, or explicitly excluded by an owner.' };
  }
  return null;
}

export function requiredPowerBiMigrationDecisions(
  result: PowerBiManualParseResult | null,
  selectedDashboardIds: string[],
  artifactReportAssociations: Record<string, string[]> = {},
): MigrationDecision[] {
  if (!result) return [];
  const impactAssetIds = Array.from(new Set(selectedDashboardIds)).sort();
  const impactSet = new Set(impactAssetIds);
  const scopes = selectedProjectScopes(result, impactAssetIds);
  const ownedFiles = allProjectFiles(result);
  const mappingDecisions = result.mappings.flatMap((mapping) => {
    const shape = decisionShape(mapping);
    if (!shape) return [];
    const artifactPath = normalizedPath(mapping.sourceArtifact);
    const owningScopes = scopes.filter((scope) => scope.sourceFiles.has(artifactPath));
    const associatedReportIds = (artifactReportAssociations[mapping.sourceArtifact] || artifactReportAssociations[artifactPath] || []).filter((reportId) => impactSet.has(reportId));
    const mappingImpactIds = Array.from(new Set([
      ...owningScopes.flatMap((scope) => scope.reportIds),
      ...associatedReportIds,
    ])).sort();
    if (scopes.length > 0 && mappingImpactIds.length === 0) {
      if (ownedFiles.has(artifactPath)) return [];
      return [];
    }
    const effectiveImpactIds = scopes.length > 0 ? mappingImpactIds : impactAssetIds;
    if (effectiveImpactIds.length === 0) return [];
    const scopeIdentity = normalized(mapping.sourceArtifact);
    const compatibilityKey = `power_bi:${shape.domain}:${normalized(mapping.sourceKind)}:${normalized(mapping.sourceName)}:${scopeIdentity}`;
    return [{
      id: `decision:${compatibilityKey}`,
      nodeId: `powerbi:${normalized(mapping.sourceKind)}:${normalized(mapping.sourceName)}:${scopeIdentity}`,
      domain: shape.domain,
      sourceLabel: mapping.sourceName,
      targetLabel: mapping.targetName,
      action: shape.action,
      targetFileName: semanticFileName(mapping),
      rationale: `${shape.rationale} ${mapping.notes.join(' ')}`.trim(),
      confidence: mapping.confidence === 'high' ? 0.9 : mapping.confidence === 'medium' ? 0.7 : 0.4,
      evidence: owningScopes.length > 0
        ? owningScopes.map((scope) => ({ sourceId: scope.projectId, artifactId: mapping.sourceArtifact, locator: `${scope.projectName} / ${mapping.sourceName}` }))
        : [{ sourceId: mapping.sourceArtifact, artifactId: mapping.sourceArtifact, locator: mapping.sourceName }],
      blocking: true,
      impactAssetIds: effectiveImpactIds,
      validationRequired: true,
      compatibilityKey,
      approvedByUser: false,
    } satisfies MigrationDecision];
  });
  const unresolvedAssociations = scopes.length > 0 ? unassignedPowerBiDecisionArtifacts(result, impactAssetIds).filter((artifact) => {
    const associated = artifactReportAssociations[artifact] || artifactReportAssociations[normalizedPath(artifact)] || [];
    return !associated.some((reportId) => impactSet.has(reportId));
  }) : [];
  const associationDecisions = unresolvedAssociations.map((artifact) => ({
    id: `decision:power_bi:model_association:${normalized(artifact)}`,
    nodeId: `powerbi:model_association:${normalized(artifact)}`,
    domain: 'model' as const,
    sourceLabel: `Associate ${artifact} with a selected report`,
    action: 'defer' as const,
    rationale: 'This semantic artifact is not linked by the uploaded PBIP/PBIR project metadata. Choose its selected report association before semantic dependencies are generated.',
    confidence: 1,
    evidence: [{ sourceId: artifact, artifactId: artifact, locator: 'Unassigned semantic artifact' }],
    blocking: true,
    impactAssetIds,
    validationRequired: true,
    compatibilityKey: `power_bi:model_association:${normalized(artifact)}`,
    approvedByUser: false,
  } satisfies MigrationDecision));
  const selectedReports = result.projects?.flatMap((project) => project.reports).filter((report) => impactAssetIds.includes(report.id)) || [];
  const visualDecisions = selectedReports.flatMap((report) => report.pages.flatMap((page) => page.visuals.filter((visual) => visual.unsupportedReasons.length > 0).map((visual) => ({
    id: `decision:power_bi:visual:${normalized(`${report.id}:${page.id}:${visual.id}`)}`,
    nodeId: `powerbi:visual:${normalized(`${report.id}:${page.id}:${visual.id}`)}`,
    domain: 'visual' as const,
    sourceLabel: `${report.name} / ${page.displayName} / ${visual.title || visual.name}`,
    action: 'defer' as const,
    rationale: visual.unsupportedReasons.join(' '),
    confidence: 1,
    evidence: [{ sourceId: visual.sourceArtifact, artifactId: visual.sourceArtifact, locator: visual.id }],
    blocking: true,
    impactAssetIds: [report.id],
    validationRequired: true,
    compatibilityKey: `power_bi:visual:${normalized(visual.visualType)}`,
    approvedByUser: false,
  }))));
  return Array.from(new Map([...mappingDecisions, ...associationDecisions, ...visualDecisions].map((decision) => [decision.id, decision])).values())
    .sort((a, b) => a.domain.localeCompare(b.domain) || a.sourceLabel.localeCompare(b.sourceLabel));
}

function mergeKey(decision: MigrationDecision): string {
  const artifacts = decision.evidence.map((item) => item.artifactId || item.sourceId).filter(Boolean).map(normalized).sort().join(':');
  return `${decision.domain}:${normalized(decision.sourceLabel)}:${artifacts}`;
}

export function mergeRequiredPowerBiDecisions(aiDecisions: MigrationDecision[], requiredDecisions: MigrationDecision[]): MigrationDecision[] {
  const remaining = new Map(requiredDecisions.map((decision) => [decision.id, decision]));
  const byNodeId = new Map<string, MigrationDecision[]>();
  requiredDecisions.forEach((decision) => byNodeId.set(decision.nodeId, [...(byNodeId.get(decision.nodeId) || []), decision]));
  const byScopedKey = new Map<string, MigrationDecision[]>();
  requiredDecisions.forEach((decision) => byScopedKey.set(mergeKey(decision), [...(byScopedKey.get(mergeKey(decision)) || []), decision]));
  const byLabelKey = new Map<string, MigrationDecision[]>();
  requiredDecisions.forEach((decision) => {
    const key = `${decision.domain}:${normalized(decision.sourceLabel)}`;
    byLabelKey.set(key, [...(byLabelKey.get(key) || []), decision]);
  });
  const firstAvailable = (candidates: MigrationDecision[]) => candidates.find((candidate) => remaining.has(candidate.id));
  const merged = aiDecisions.map((decision) => {
    const scopedMatches = byScopedKey.get(mergeKey(decision)) || [];
    const labelMatches = byLabelKey.get(`${decision.domain}:${normalized(decision.sourceLabel)}`) || [];
    const required = remaining.get(decision.id)
      || firstAvailable(byNodeId.get(decision.nodeId) || [])
      || firstAvailable(scopedMatches)
      || firstAvailable(labelMatches);
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

export const mergePowerBiDecisionProposalChunks = mergeMigrationDecisionProposalChunks;

export function selectMigrationDecisionProposal(
  decisions: MigrationDecision[],
  decisionId: string,
  proposalOptionId: string,
): MigrationDecision[] {
  return decisions.map((decision) => {
    if (decision.id !== decisionId) return decision;
    const option = decision.proposalOptions?.find((item) => item.id === proposalOptionId);
    if (!option) return decision;
    return {
      ...decision,
      action: option.action,
      targetLabel: option.targetLabel,
      targetId: option.targetId,
      targetFileName: option.targetFileName,
      proposedCode: option.proposedCode,
      rationale: option.rationale,
      confidence: option.confidence,
      selectedProposalOptionId: option.id,
      approvedByUser: false,
    };
  });
}

import type {
  MigrationDecision,
  MigrationDecisionAction,
  MigrationMappingDomain,
  SemanticPatch,
  SemanticYamlFileName,
} from './types';
import { mergeGeneratedSemanticFiles } from './package';
import {
  isMigrationSemanticDecisionKind,
  withMigrationDecisionIdentity,
} from './decisionIdentity';

const DECISION_ACTIONS = new Set<MigrationDecisionAction>(['map_existing', 'create_new', 'rewrite', 'exclude', 'defer']);
const MAPPING_DOMAINS = new Set<MigrationMappingDomain>(['data_source', 'model', 'field', 'measure', 'relationship', 'filter', 'folder', 'user', 'group', 'permission', 'schedule', 'content', 'visual']);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function cleanFileName(value: unknown): SemanticYamlFileName | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === 'model' || trimmed === 'relationships' || trimmed.endsWith('.view') || trimmed.endsWith('.topic')) return trimmed as SemanticYamlFileName;
  return undefined;
}

export function normalizeMigrationDecisions(value: unknown): MigrationDecision[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    const row = asRecord(item);
    const action = typeof row.action === 'string' && DECISION_ACTIONS.has(row.action as MigrationDecisionAction)
      ? row.action as MigrationDecisionAction
      : 'defer';
    const nodeId = typeof row.nodeId === 'string' ? row.nodeId.trim() : '';
    if (!nodeId) return [];
    const confidenceValue = typeof row.confidence === 'number' ? row.confidence : Number(row.confidence);
    return [withMigrationDecisionIdentity({
      id: typeof row.id === 'string' && row.id.trim() ? row.id.trim() : `decision-${index + 1}`,
      nodeId,
      providerDecisionId: typeof row.id === 'string' && row.id.trim() ? row.id.trim() : undefined,
      semanticKind: isMigrationSemanticDecisionKind(row.semanticKind) ? row.semanticKind : undefined,
      domain: typeof row.domain === 'string' && MAPPING_DOMAINS.has(row.domain as MigrationMappingDomain) ? row.domain as MigrationMappingDomain : 'field',
      sourceLabel: typeof row.sourceLabel === 'string' && row.sourceLabel.trim() ? row.sourceLabel.trim() : nodeId,
      targetLabel: typeof row.targetLabel === 'string' && row.targetLabel.trim() ? row.targetLabel.trim() : undefined,
      action,
      targetId: typeof row.targetId === 'string' && row.targetId.trim() ? row.targetId.trim() : undefined,
      targetFileName: cleanFileName(row.targetFileName),
      proposedCode: typeof row.proposedCode === 'string' ? row.proposedCode : undefined,
      rationale: typeof row.rationale === 'string' ? row.rationale : 'Review this proposed migration decision.',
      confidence: Number.isFinite(confidenceValue) ? Math.min(1, Math.max(0, confidenceValue)) : 0,
      evidence: Array.isArray(row.evidence) ? row.evidence.flatMap((evidenceValue) => {
        const evidence = asRecord(evidenceValue);
        return typeof evidence.sourceId === 'string' ? [{
          sourceId: evidence.sourceId,
          artifactId: typeof evidence.artifactId === 'string' ? evidence.artifactId : undefined,
          locator: typeof evidence.locator === 'string' ? evidence.locator : undefined,
          excerpt: typeof evidence.excerpt === 'string' ? evidence.excerpt : undefined,
        }] : [];
      }) : [],
      blocking: row.blocking !== false,
      impactAssetIds: Array.isArray(row.impactAssetIds) ? row.impactAssetIds.filter((item): item is string => typeof item === 'string') : [],
      validationRequired: row.validationRequired !== false,
      compatibilityKey: typeof row.compatibilityKey === 'string' && row.compatibilityKey.trim() ? row.compatibilityKey.trim() : undefined,
      approvedByUser: false,
      proposalOptions: Array.isArray(row.proposalOptions) ? row.proposalOptions.flatMap((optionValue, optionIndex) => {
        const option = asRecord(optionValue);
        const optionAction = typeof option.action === 'string' && DECISION_ACTIONS.has(option.action as MigrationDecisionAction)
          ? option.action as MigrationDecisionAction
          : undefined;
        if (!optionAction) return [];
        const optionConfidence = typeof option.confidence === 'number' ? option.confidence : Number(option.confidence);
        return [{
          id: typeof option.id === 'string' && option.id.trim() ? option.id.trim() : `${nodeId}:proposal:${optionIndex + 1}`,
          action: optionAction,
          targetLabel: typeof option.targetLabel === 'string' && option.targetLabel.trim() ? option.targetLabel.trim() : undefined,
          targetId: typeof option.targetId === 'string' && option.targetId.trim() ? option.targetId.trim() : undefined,
          targetFileName: cleanFileName(option.targetFileName),
          proposedCode: typeof option.proposedCode === 'string' ? option.proposedCode : undefined,
          rationale: typeof option.rationale === 'string' ? option.rationale : 'AI-proposed migration option.',
          confidence: Number.isFinite(optionConfidence) ? Math.min(1, Math.max(0, optionConfidence)) : 0,
        }];
      }) : undefined,
      selectedProposalOptionId: typeof row.selectedProposalOptionId === 'string' && row.selectedProposalOptionId.trim() ? row.selectedProposalOptionId.trim() : undefined,
    })];
  });
}

export function migrationDecisionResolutionIssue(decision: MigrationDecision): string | null {
  if ((decision.proposalOptions?.length || 0) > 1 && !decision.selectedProposalOptionId) return 'Choose one AI proposal or make a custom operator decision before approval.';
  if (['exclude', 'defer'].includes(decision.action)) return null;
  if (decision.action === 'map_existing' && !decision.targetId?.trim() && !decision.targetLabel?.trim()) return 'Choose the existing target object before approving this mapping.';
  if (['create_new', 'rewrite'].includes(decision.action) && !decision.targetFileName) return 'Choose the target Omni semantic file before approving this change.';
  return null;
}

export function migrationDecisionCanBeApproved(decision: MigrationDecision): boolean {
  return migrationDecisionResolutionIssue(decision) === null;
}

export function compileApprovedDecisions(decisions: MigrationDecision[], checksums: Record<string, string> = {}): SemanticPatch[] {
  return decisions.flatMap((decision) => {
    if (!decision.approvedByUser || migrationDecisionResolutionIssue(decision) || ['exclude', 'defer', 'map_existing'].includes(decision.action)) return [];
    if (!decision.targetFileName || !decision.proposedCode?.trim()) return [];
    return [{
      id: `patch:${decision.id}`,
      operation: checksums[decision.targetFileName] ? 'update_file' : 'create_file',
      fileName: decision.targetFileName,
      baseChecksum: checksums[decision.targetFileName],
      content: decision.proposedCode,
      decisionIds: [decision.id],
      destructive: false,
    } satisfies SemanticPatch];
  });
}

export function compileApprovedDecisionPackage(
  decisions: MigrationDecision[],
  currentFiles: Record<string, string>,
  checksums: Record<string, string> = {},
): { files: ReturnType<typeof mergeGeneratedSemanticFiles>; patches: SemanticPatch[] } {
  const patches = compileApprovedDecisions(decisions, checksums);
  const approvedRewrites = decisions.filter((decision) => decision.approvedByUser && decision.action === 'rewrite' && decision.targetFileName);
  const files = mergeGeneratedSemanticFiles(patches.flatMap((patch) => patch.content ? [{
    id: patch.id,
    fileName: patch.fileName,
    yaml: patch.content,
    source: 'semantic-migration' as const,
  }] : []), currentFiles, {
    allowDefinitionOverwrite: (fileName, _section, definitionName) => approvedRewrites.some((decision) => {
      if (decision.targetFileName !== fileName) return false;
      const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
      const candidates = [decision.sourceLabel, decision.sourceLabel.split('.').pop() || '', decision.targetLabel || '', decision.targetId || ''].map(normalize);
      return candidates.includes(normalize(definitionName));
    }),
  });
  return { files, patches };
}

export function unresolvedDecisionCount(decisions: MigrationDecision[]): number {
  return decisions.filter((decision) => decision.blocking && (!decision.approvedByUser || Boolean(migrationDecisionResolutionIssue(decision)))).length;
}

export function applyDecisionToCompatibleTargets(decisions: MigrationDecision[], sourceDecisionId: string): MigrationDecision[] {
  const source = decisions.find((decision) => decision.id === sourceDecisionId);
  if (!source?.compatibilityKey || !source.approvedByUser) return decisions;
  return decisions.map((decision) => decision.id !== source.id
    && decision.domain === source.domain
    && decision.compatibilityKey === source.compatibilityKey
    ? {
        ...decision,
        action: source.action,
        targetId: source.targetId,
        targetLabel: source.targetLabel,
        targetFileName: source.targetFileName,
        proposedCode: source.proposedCode,
        approvedByUser: true,
      }
    : decision);
}

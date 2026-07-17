import type {
  MigrationDecision,
  MigrationDecisionProposalOption,
  MigrationSemanticDecisionKind,
  SemanticYamlFileName,
} from './types';

export const MIGRATION_SEMANTIC_DECISION_KINDS: readonly MigrationSemanticDecisionKind[] = [
  'data_source',
  'model',
  'view',
  'field',
  'measure',
  'relationship',
  'topic',
  'filter',
  'folder',
  'user',
  'group',
  'permission',
  'schedule',
  'dashboard',
  'visual',
];

const SEMANTIC_KIND_SET = new Set<MigrationSemanticDecisionKind>(MIGRATION_SEMANTIC_DECISION_KINDS);

function normalized(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function semanticKindFromTargetFile(
  targetFileName: SemanticYamlFileName | undefined,
): MigrationSemanticDecisionKind | undefined {
  if (targetFileName === 'model') return 'model';
  if (targetFileName === 'relationships') return 'relationship';
  if (targetFileName?.endsWith('.topic')) return 'topic';
  if (targetFileName?.endsWith('.view')) return 'view';
  return undefined;
}

export function isMigrationSemanticDecisionKind(value: unknown): value is MigrationSemanticDecisionKind {
  return typeof value === 'string' && SEMANTIC_KIND_SET.has(value as MigrationSemanticDecisionKind);
}

export function migrationDecisionSemanticKind(
  decision: Pick<MigrationDecision, 'domain' | 'nodeId' | 'sourceLabel' | 'targetFileName' | 'semanticKind'>,
): MigrationSemanticDecisionKind {
  if (decision.semanticKind && SEMANTIC_KIND_SET.has(decision.semanticKind)) return decision.semanticKind;
  if (decision.domain === 'model') {
    const targetKind = semanticKindFromTargetFile(decision.targetFileName);
    if (targetKind === 'topic' || targetKind === 'view') return targetKind;
    const lineage = `${decision.nodeId} ${decision.sourceLabel}`.toLowerCase();
    if (/\b(topic|explore)\b/.test(lineage)) return 'topic';
    if (/\bview\b/.test(lineage)) return 'view';
    return 'model';
  }
  if (decision.domain === 'content') return 'dashboard';
  if (decision.domain === 'field' && decision.targetFileName?.endsWith('.topic')) return 'filter';
  return decision.domain;
}

function evidenceScope(decision: Pick<MigrationDecision, 'evidence'>): string {
  return Array.from(new Set(decision.evidence.flatMap((item) => {
    const artifact = normalized(item.artifactId || '');
    const source = normalized(item.sourceId || '');
    return artifact || source || [];
  }))).sort().join(':');
}

export function migrationDecisionSemanticKey(
  decision: Pick<MigrationDecision, 'domain' | 'nodeId' | 'sourceLabel' | 'targetFileName' | 'semanticKind' | 'semanticKey' | 'evidence'>,
): string {
  if (decision.semanticKey?.trim()) return decision.semanticKey.trim();
  const kind = migrationDecisionSemanticKind(decision);
  const node = normalized(decision.nodeId);
  const label = normalized(decision.sourceLabel);
  const scope = evidenceScope(decision);
  return [kind, node || 'unscoped', label || 'unlabeled', scope].filter(Boolean).join(':');
}

export function withMigrationDecisionIdentity(decision: MigrationDecision): MigrationDecision {
  const semanticKind = migrationDecisionSemanticKind(decision);
  return {
    ...decision,
    providerDecisionId: decision.providerDecisionId || decision.id,
    semanticKind,
    semanticKey: migrationDecisionSemanticKey({ ...decision, semanticKind, semanticKey: undefined }),
    identityDiagnostics: Array.from(new Set(decision.identityDiagnostics || [])),
  };
}

function mergeEvidence(left: MigrationDecision['evidence'], right: MigrationDecision['evidence']) {
  return Array.from(new Map([...left, ...right].map((item) => [
    `${item.sourceId}:${item.artifactId || ''}:${item.locator || ''}`,
    item,
  ])).values());
}

function proposalSignature(option: MigrationDecisionProposalOption): string {
  return JSON.stringify([
    option.action,
    option.targetLabel || '',
    option.targetId || '',
    option.targetFileName || '',
    option.proposedCode || '',
  ]);
}

function toProposalOption(item: MigrationDecision, index: number): MigrationDecisionProposalOption {
  return {
    id: `${item.id}:proposal:${index + 1}`,
    action: item.action,
    targetLabel: item.targetLabel,
    targetId: item.targetId,
    targetFileName: item.targetFileName,
    proposedCode: item.proposedCode,
    rationale: item.rationale,
    confidence: item.confidence,
  };
}

function addDiagnostic(decision: MigrationDecision, diagnostic: string): MigrationDecision {
  return {
    ...decision,
    identityDiagnostics: Array.from(new Set([...(decision.identityDiagnostics || []), diagnostic])),
  };
}

function diagnoseProviderIdentityReuse(decisions: MigrationDecision[]): MigrationDecision[] {
  const semanticKeysByProviderId = new Map<string, Set<string>>();
  const semanticKeysByNodeId = new Map<string, Set<string>>();
  decisions.forEach((decision) => {
    const semanticKey = migrationDecisionSemanticKey(decision);
    const providerId = decision.providerDecisionId || decision.id;
    semanticKeysByProviderId.set(providerId, new Set([...(semanticKeysByProviderId.get(providerId) || []), semanticKey]));
    semanticKeysByNodeId.set(decision.nodeId, new Set([...(semanticKeysByNodeId.get(decision.nodeId) || []), semanticKey]));
  });
  return decisions.map((decision) => {
    const providerId = decision.providerDecisionId || decision.id;
    const providerReuse = (semanticKeysByProviderId.get(providerId)?.size || 0) > 1;
    const nodeReuse = (semanticKeysByNodeId.get(decision.nodeId)?.size || 0) > 1;
    let next = decision;
    if (providerReuse) {
      next = addDiagnostic(next, `The AI provider reused decision ID "${providerId}" for independent semantic work. OmniKit assigned separate internal decisions.`);
    }
    if (nodeReuse) {
      next = addDiagnostic(next, `The AI provider reused source lineage "${decision.nodeId}" across related semantic work. OmniKit kept each deliverable separate.`);
    }
    return next;
  });
}

function ensureUniqueDecisionIds(decisions: MigrationDecision[]): MigrationDecision[] {
  const used = new Map<string, number>();
  return decisions.map((decision) => {
    const count = (used.get(decision.id) || 0) + 1;
    used.set(decision.id, count);
    if (count === 1) return decision;
    return addDiagnostic({
      ...decision,
      providerDecisionId: decision.providerDecisionId || decision.id,
      id: `${decision.id}:decision:${count}`,
    }, `The AI provider reused decision ID "${decision.id}". OmniKit assigned a unique internal ID.`);
  });
}

export function mergeMigrationDecisionProposalChunks(chunks: MigrationDecision[][]): MigrationDecision[] {
  const prepared = diagnoseProviderIdentityReuse(chunks.flat().map(withMigrationDecisionIdentity));
  const merged = new Map<string, MigrationDecision>();
  prepared.forEach((decision) => {
    const key = migrationDecisionSemanticKey(decision);
    const current = merged.get(key);
    if (!current) {
      merged.set(key, decision);
      return;
    }
    const currentOptions = current.proposalOptions?.length ? current.proposalOptions : [toProposalOption(current, 0)];
    const nextOption = toProposalOption(decision, currentOptions.length);
    const uniqueOptions = Array.from(new Map([...currentOptions, nextOption].map((option) => [proposalSignature(option), option])).values());
    const shared = {
      evidence: mergeEvidence(current.evidence, decision.evidence),
      impactAssetIds: Array.from(new Set([...current.impactAssetIds, ...decision.impactAssetIds])).sort(),
      confidence: Math.max(current.confidence, decision.confidence),
      identityDiagnostics: Array.from(new Set([...(current.identityDiagnostics || []), ...(decision.identityDiagnostics || [])])),
    };
    if (uniqueOptions.length === 1) {
      merged.set(key, { ...current, ...shared });
      return;
    }
    merged.set(key, {
      ...current,
      ...shared,
      rationale: `AI planning returned ${uniqueOptions.length} different recommendations for the same semantic object. Choose the supported outcome below, or make a custom operator decision.`,
      blocking: true,
      approvedByUser: false,
      proposalOptions: uniqueOptions,
      selectedProposalOptionId: undefined,
    });
  });
  return ensureUniqueDecisionIds(Array.from(merged.values()))
    .sort((left, right) => (
      migrationDecisionSemanticKind(left).localeCompare(migrationDecisionSemanticKind(right))
      || left.sourceLabel.localeCompare(right.sourceLabel)
      || left.id.localeCompare(right.id)
    ));
}

export function migrationDecisionIdentityDiagnostics(decisions: MigrationDecision[]): string[] {
  return Array.from(new Set(decisions.flatMap((decision) => decision.identityDiagnostics || [])));
}

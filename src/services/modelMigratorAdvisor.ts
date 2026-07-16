import type { InstanceModel, ModelMigratorConnection, ModelMigratorReadinessPair } from './opsConsole';

export type ModelMigrationStrategyId = 'copy_auto' | 'review_adapt' | 'pr_review' | 'impact_report';

export interface TargetModelMatchScore {
  score: number;
  confidence: 'strong' | 'likely' | 'manual';
  reasons: string[];
}

export interface ModelMigrationStrategy {
  id: ModelMigrationStrategyId;
  label: string;
  description: string;
  modelPath: 'fast' | 'translate' | 'impact_report';
  releaseMode: 'direct' | 'pr' | 'validate_only';
  reasons: string[];
}

function normalize(value?: string) {
  return (value || '').trim().toLowerCase();
}

function tokenize(value?: string) {
  return new Set(normalize(value).split(/[^a-z0-9]+/).filter(Boolean));
}

function tokenOverlap(a?: string, b?: string) {
  const left = tokenize(a);
  const right = tokenize(b);
  if (left.size === 0 || right.size === 0) return 0;
  let overlap = 0;
  for (const token of left) if (right.has(token)) overlap += 1;
  return overlap / Math.max(left.size, right.size);
}

export function scoreTargetModelMatch(
  source: InstanceModel,
  target: InstanceModel,
  sourceConnection?: ModelMigratorConnection,
  targetConnection?: ModelMigratorConnection,
  schemaOverlap?: { sourceSchemas: string[]; targetSchemas: string[]; overlappingSchemas: string[] },
): TargetModelMatchScore {
  let score = 0;
  const reasons: string[] = [];
  if (normalize(source.id) && normalize(source.id) === normalize(target.id)) {
    score += 10;
    reasons.push('same model id');
  }
  if (normalize(source.name) && normalize(source.name) === normalize(target.name)) {
    score += 55;
    reasons.push('same model name');
  } else {
    const overlap = tokenOverlap(source.name, target.name);
    if (overlap >= 0.6) {
      score += Math.round(25 * overlap);
      reasons.push('similar model name');
    }
  }
  if (source.identifier && target.identifier && normalize(source.identifier) === normalize(target.identifier)) {
    score += 30;
    reasons.push('same identifier');
  }
  if (source.connectionId && target.connectionId && source.connectionId === target.connectionId) {
    score += 10;
    reasons.push('same connection id');
  }
  if (sourceConnection?.dialect && targetConnection?.dialect && normalize(sourceConnection.dialect) === normalize(targetConnection.dialect)) {
    score += 8;
    reasons.push('same warehouse dialect');
  }
  if (sourceConnection?.database && targetConnection?.database && normalize(sourceConnection.database) === normalize(targetConnection.database)) {
    score += 4;
    reasons.push('same database name');
  }
  if (schemaOverlap?.overlappingSchemas.length) {
    score += Math.min(18, schemaOverlap.overlappingSchemas.length * 6);
    reasons.push(`${schemaOverlap.overlappingSchemas.length} overlapping schema${schemaOverlap.overlappingSchemas.length === 1 ? '' : 's'}`);
  } else if ((schemaOverlap?.sourceSchemas.length || 0) > 0 && (schemaOverlap?.targetSchemas.length || 0) > 0) {
    score -= 8;
    reasons.push('no schema overlap');
  }
  if (!target.deletedAt) {
    score += 3;
    reasons.push('active target model');
  }
  const bounded = Math.max(0, Math.min(100, score));
  return {
    score: bounded,
    confidence: bounded >= 60 ? 'strong' : bounded >= 35 ? 'likely' : 'manual',
    reasons,
  };
}

export function recommendModelMigrationStrategy(input: {
  sourceModel: InstanceModel;
  targetModel?: InstanceModel;
  sourceConnection?: ModelMigratorConnection;
  targetConnection?: ModelMigratorConnection;
  readinessPair?: ModelMigratorReadinessPair;
  contentSelected?: boolean;
}): ModelMigrationStrategy {
  const reasons: string[] = [];
  const target = input.targetModel;
  if (!target) {
    return {
      id: 'impact_report',
      label: 'Impact report only',
      description: 'Choose a target model before OmniKit can recommend a publishing path.',
      modelPath: 'impact_report',
      releaseMode: 'validate_only',
      reasons: ['target model not selected'],
    };
  }
  if (target.pullRequestRequired || target.gitProtected || input.readinessPair?.releaseMode === 'pr') {
    reasons.push('target model requires pull request review');
    return {
      id: 'pr_review',
      label: 'Create PR for review',
      description: 'OmniKit will stage model changes on a safe working copy and prepare the release for review instead of forcing a direct publish.',
      modelPath: 'translate',
      releaseMode: 'pr',
      reasons,
    };
  }
  const sameDialect = input.sourceConnection?.dialect
    && input.targetConnection?.dialect
    && normalize(input.sourceConnection.dialect) === normalize(input.targetConnection.dialect);
  if (input.sourceModel.gitConfigured && sameDialect) {
    reasons.push('source model is git-backed');
    reasons.push('source and target use the same dialect');
    return {
      id: 'copy_auto',
      label: 'Copy model automatically',
      description: 'OmniKit can try Omni’s native model migration path, then validate the target before publishing.',
      modelPath: 'fast',
      releaseMode: 'direct',
      reasons,
    };
  }
  if (!sameDialect) reasons.push('source and target dialects may differ');
  if (!input.sourceModel.gitConfigured) reasons.push('source model is not confirmed as git-backed');
  return {
    id: 'review_adapt',
    label: 'Review and adapt model changes',
    description: 'OmniKit will prepare YAML changes on a safe working copy so you can review data-location and semantic differences before publishing.',
    modelPath: 'translate',
    releaseMode: 'direct',
    reasons,
  };
}

export interface SchemaMappingRow {
  id: string;
  source: string;
  target: string;
}

export function parseSchemaMappingRows(value: string): SchemaMappingRow[] {
  return value
    .split('\n')
    .map((line, index) => {
      const trimmed = line.trim();
      if (!trimmed) return null;
      const parts = trimmed.includes('->') ? trimmed.split('->') : trimmed.split(',');
      const source = parts[0]?.trim() || '';
      const target = parts.slice(1).join('->').trim();
      if (!source && !target) return null;
      return { id: `schema-map-${index}`, source, target };
    })
    .filter((row): row is SchemaMappingRow => Boolean(row));
}

export function serializeSchemaMappingRows(rows: SchemaMappingRow[]) {
  return rows
    .map((row) => row.source.trim() || row.target.trim() ? `${row.source.trim()} -> ${row.target.trim()}` : '')
    .filter(Boolean)
    .join('\n');
}

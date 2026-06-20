const SEMANTIC_MODEL_KINDS = new Set(['SHARED', 'SHARED_EXTENSION']);

function stringFrom(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function hasDeletionMarker(record: Record<string, unknown>): boolean {
  const deletedAt = record.deletedAt ?? record.deleted_at;
  if (typeof deletedAt === 'string') return deletedAt.trim().length > 0;
  if (deletedAt !== null && deletedAt !== undefined) return true;
  return record.deleted === true;
}

export function isActiveSemanticModel(
  model: unknown,
  options: { treatMissingKindAsSemantic?: boolean } = {},
): boolean {
  if (!model || typeof model !== 'object' || Array.isArray(model)) return false;
  const record = model as Record<string, unknown>;
  if (hasDeletionMarker(record)) return false;

  const kind = stringFrom(record, 'kind', 'modelKind', 'model_kind', 'type').toUpperCase();
  if (!kind) return options.treatMissingKindAsSemantic === true;
  return SEMANTIC_MODEL_KINDS.has(kind);
}

export function countWorkspaceSnapshotSemanticModels(models: unknown): number | null {
  if (!Array.isArray(models)) return null;
  return models.filter((model) => (
    isActiveSemanticModel(model, { treatMissingKindAsSemantic: true })
  )).length;
}

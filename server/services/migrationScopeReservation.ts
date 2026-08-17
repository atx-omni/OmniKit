import type { MigrationJob, MigrationJobItem } from './migrationJobs';

export interface MigrationDestinationModelScope {
  destinationInstanceId: string;
  targetModelId: string;
}

export type MigrationDestinationModelMutationState =
  | 'claimed'
  | 'dispatched'
  | 'remote_pending'
  | 'uncertain'
  | 'resolved'
  | 'failed_prewrite';

export interface MigrationDestinationModelMutationLease {
  jobId: string;
  itemId: string;
  destinationInstanceId: string;
  targetModelId: string;
  state: MigrationDestinationModelMutationState;
  operation: string;
  updatedAt: number;
  revision?: number;
  externalJobId?: string;
  dispatchItemId?: string;
  dispatchItemKind?: string;
  dispatchedAt?: number;
  dispatchFingerprint?: string;
}

export interface MigrationDestinationModelMutationScanOptions {
  excludeItemIds?: ReadonlySet<string>;
}

const MIGRATION_MUTATION_OPERATIONS = new Set([
  'model_job',
  'model_merge',
  'legacy_dashboard_job',
  'schema_refresh',
  'scratch_validation',
]);

function detailString(item: MigrationJobItem, key: string): string | undefined {
  const value = item.details?.[key];
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 1_024) return undefined;
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  }) ? undefined : value;
}

function detailNumber(item: MigrationJobItem, key: string): number | undefined {
  const value = item.details?.[key];
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function migrationDestinationModelMutationLease(
  item: MigrationJobItem,
): MigrationDestinationModelMutationLease | undefined {
  if (item.details?.migrationDestinationModelMutation !== true) return undefined;
  const state = detailString(item, 'migrationMutationState');
  const operation = detailString(item, 'migrationMutationOperation');
  const updatedAt = detailNumber(item, 'migrationMutationUpdatedAt');
  if (
    !item.jobId.trim()
    || !item.id.trim()
    || !item.destinationId.trim()
    || !item.targetModelId?.trim()
    || !operation
    || !MIGRATION_MUTATION_OPERATIONS.has(operation)
    || !updatedAt
    || !['claimed', 'dispatched', 'remote_pending', 'uncertain', 'resolved', 'failed_prewrite'].includes(state || '')
  ) return undefined;
  return {
    jobId: item.jobId,
    itemId: item.id,
    destinationInstanceId: item.destinationId,
    targetModelId: item.targetModelId,
    state: state as MigrationDestinationModelMutationState,
    operation,
    updatedAt,
    revision: detailNumber(item, 'migrationMutationRevision'),
    externalJobId: detailString(item, 'migrationMutationExternalJobId'),
    dispatchItemId: detailString(item, 'migrationMutationDispatchItemId'),
    dispatchItemKind: detailString(item, 'migrationMutationDispatchItemKind'),
    dispatchedAt: detailNumber(item, 'migrationMutationDispatchedAt'),
    dispatchFingerprint: detailString(item, 'migrationMutationDispatchFingerprint'),
  };
}

function unresolvedSafeCopyScope(item: MigrationJobItem): MigrationDestinationModelScope | undefined {
  if (item.details?.safeCopyAttempt !== true) return undefined;
  const state = detailString(item, 'safeCopyAttemptState');
  if (state !== 'dispatched' && state !== 'uncertain') return undefined;
  const destinationInstanceId = detailString(item, 'safeCopyDestinationInstanceId') || item.destinationId.trim();
  const targetModelId = detailString(item, 'safeCopyModelId') || item.targetModelId?.trim();
  return destinationInstanceId && targetModelId ? { destinationInstanceId, targetModelId } : undefined;
}

export function migrationJobHasUnresolvedDestinationModelMutation(job: MigrationJob): boolean {
  return job.items.some((item) => {
    const lease = migrationDestinationModelMutationLease(item);
    if (lease?.state === 'dispatched' || lease?.state === 'remote_pending' || lease?.state === 'uncertain') return true;
    if (item.details?.migrationDestinationModelMutation === true && !lease) return true;
    return Boolean(unresolvedSafeCopyScope(item));
  });
}

export function hasUnresolvedMigrationDestinationModelMutation(
  jobs: readonly MigrationJob[],
  scopes: readonly MigrationDestinationModelScope[],
  options: MigrationDestinationModelMutationScanOptions = {},
): boolean {
  const keys = new Set(scopes.map(scopeKey).filter((key) => key !== '\u0000'));
  if (keys.size === 0) return false;
  return jobs.some((job) => job.items.some((item) => {
    if (options.excludeItemIds?.has(item.id)) return false;
    const lease = migrationDestinationModelMutationLease(item);
    if (item.details?.migrationDestinationModelMutation === true && !lease) {
      const destinationInstanceId = item.destinationId.trim();
      const targetModelId = item.targetModelId?.trim();
      return !destinationInstanceId || !targetModelId
        ? true
        : keys.has(scopeKey({ destinationInstanceId, targetModelId }));
    }
    if (
      lease?.operation !== 'scratch_validation'
      && (lease?.state === 'dispatched' || lease?.state === 'remote_pending' || lease?.state === 'uncertain')
    ) {
      return keys.has(scopeKey(lease));
    }
    const safeCopyScope = unresolvedSafeCopyScope(item);
    return Boolean(safeCopyScope && keys.has(scopeKey(safeCopyScope)));
  }));
}

export class MigrationScopeReservationError extends Error {
  readonly code = 'MIGRATION_DESTINATION_MODEL_BUSY';
  readonly statusCode = 409;

  constructor() {
    super('Another migration workflow currently owns this destination model. Wait for it to finish or reconcile it before retrying.');
    this.name = 'MigrationScopeReservationError';
  }
}

const scopeOwners = new Map<string, string>();

function scopeKey(scope: MigrationDestinationModelScope): string {
  return `${scope.destinationInstanceId.trim()}\u0000${scope.targetModelId.trim()}`;
}

export function reserveMigrationDestinationModels(
  owner: string,
  scopes: readonly MigrationDestinationModelScope[],
): () => void {
  const ownerId = owner.trim();
  const keys = [...new Set(scopes.map(scopeKey).filter((key) => key !== '\u0000'))].sort();
  if (!ownerId || keys.length === 0) throw new MigrationScopeReservationError();
  if (keys.some((key) => {
    const current = scopeOwners.get(key);
    return current && current !== ownerId;
  })) throw new MigrationScopeReservationError();
  for (const key of keys) scopeOwners.set(key, ownerId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const key of keys) {
      if (scopeOwners.get(key) === ownerId) scopeOwners.delete(key);
    }
  };
}

export function releaseMigrationDestinationModels(owner: string): void {
  const ownerId = owner.trim();
  for (const [key, current] of scopeOwners.entries()) {
    if (current === ownerId) scopeOwners.delete(key);
  }
}

export function releaseMigrationDestinationModel(
  owner: string,
  scope: MigrationDestinationModelScope,
): void {
  const ownerId = owner.trim();
  const key = scopeKey(scope);
  if (ownerId && scopeOwners.get(key) === ownerId) scopeOwners.delete(key);
}

export function releaseMigrationDestinationModelsByPrefix(ownerPrefix: string): void {
  for (const [key, current] of scopeOwners.entries()) {
    if (current.startsWith(ownerPrefix)) scopeOwners.delete(key);
  }
}

export function clearMigrationDestinationModelReservations(): void {
  scopeOwners.clear();
}

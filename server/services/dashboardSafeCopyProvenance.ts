import { listJobs } from './jobStore';
import type { MigrationJob, MigrationJobItem, MigrationTarget } from './migrationJobs';

const SAFE_COPY_PROFILE = 'safe_copy_v1';
const SAFE_COPY_OPERATION_MODE = 'safe_copy';
const MAX_COPY_NAME_LENGTH = 256;
const MAX_COPY_NAME_ATTEMPTS = 10_000;
const MIN_VERIFIED_AT = Date.UTC(2000, 0, 1);
const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const MAX_EVIDENCE_STRING_LENGTH = 1_024;
const DOCUMENT_PROVENANCE_DETAIL_KEY = 'safeCopyDocumentProvenance';
const DOCUMENT_PROVENANCE_KEYS = new Set([
  'profile',
  'resolverVersion',
  'verifierVersion',
  'jobId',
  'attemptId',
  'targetId',
  'sourceInstanceId',
  'sourceConnectionId',
  'sourceDocumentId',
  'sourceExportHash',
  'destinationInstanceId',
  'connectionId',
  'modelId',
  'folderId',
  'folderPath',
  'importedDocumentId',
  'importedIdentifier',
  'chosenName',
  'expectedPayloadHash',
  'publishedFingerprint',
  'finalVerification',
  'documentWriteMode',
  'verifiedAt',
]);

export interface DashboardSafeCopyProvenanceScope {
  sourceInstanceId: string;
  sourceConnectionId: string;
  sourceDocumentId: string;
  destinationInstanceId: string;
  targetConnectionId: string;
  targetModelId: string;
  targetFolderId?: string;
  targetFolderPath?: string;
}

export interface DashboardSafeCopyProvenanceMatch {
  jobId: string;
  itemId: string;
  targetId: string;
  sourceInstanceId: string;
  sourceConnectionId: string;
  sourceDocumentId: string;
  sourceExportHash: string;
  destinationInstanceId: string;
  targetConnectionId: string;
  targetModelId: string;
  targetFolderId?: string;
  targetFolderPath?: string;
  importedDocumentId: string;
  importedIdentifier: string;
  chosenName: string;
  expectedPayloadHash: string;
  publishedFingerprint: string;
  resolverVersion: number;
  verifierVersion: number;
  verifiedAt: number;
  usage: 'audit_only';
  updateInPlaceAuthorized: false;
}

export interface DashboardSafeCopyDocumentVerificationProvenance {
  profile: typeof SAFE_COPY_PROFILE;
  resolverVersion: number;
  verifierVersion: number;
  jobId: string;
  attemptId: string;
  targetId: string;
  sourceInstanceId: string;
  sourceConnectionId: string;
  sourceDocumentId: string;
  sourceExportHash: string;
  destinationInstanceId: string;
  connectionId: string;
  modelId: string;
  folderId?: string;
  folderPath?: string;
  importedDocumentId: string;
  importedIdentifier: string;
  chosenName: string;
  expectedPayloadHash: string;
  publishedFingerprint: string;
  finalVerification: 'passed';
  documentWriteMode: 'created';
  verifiedAt: number;
}

export interface DashboardSafeCopyProvenanceLookupOptions {
  now?: number;
}

export class DashboardSafeCopyNameAllocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DashboardSafeCopyNameAllocationError';
  }
}

function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function exactBoundedString(value: unknown): string | undefined {
  if (
    typeof value !== 'string'
    || !value
    || value !== value.trim()
    || value.length > MAX_EVIDENCE_STRING_LENGTH
  ) return undefined;
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  }) ? undefined : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalName(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('en-US');
}

function detailString(job: MigrationJob, key: string): string | undefined {
  return cleanString(job.details?.[key]);
}

function isPersistedSafeCopyJob(job: MigrationJob): boolean {
  return job.workflow === 'dashboard'
    && detailString(job, 'safeCopyProfile') === SAFE_COPY_PROFILE
    && detailString(job, 'operationMode') === SAFE_COPY_OPERATION_MODE
    && (job.status === 'succeeded' || job.status === 'partial')
    && Array.isArray(job.documentIds)
    && Array.isArray(job.destinationIds)
    && Array.isArray(job.targets)
    && Array.isArray(job.items)
    && Array.isArray(job.postMigrationActions)
    && job.emptyFirst === false
    && job.replaceSameNamed === false
    && job.deleteSourceOnSuccess === false
    && job.postMigrationActions.length === 0;
}

function targetForItem(job: MigrationJob, item: MigrationJobItem): MigrationTarget | undefined {
  const targetId = exactBoundedString(item.targetId);
  if (!targetId) return undefined;
  const matches = Array.isArray(job.targets)
    ? job.targets.filter((target) => target.id === targetId)
    : [];
  return matches.length === 1 ? matches[0] : undefined;
}

function folderScopeMatches(
  candidate: { folderId?: string; folderPath?: string },
  scope: DashboardSafeCopyProvenanceScope,
): boolean {
  return candidate.folderId === scope.targetFolderId
    && candidate.folderPath === scope.targetFolderPath;
}

function positiveVersion(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : undefined;
}

function boundedVerifiedAt(value: unknown, item: MigrationJobItem, now: number): number | undefined {
  if (
    !Number.isSafeInteger(value)
    || (value as number) < MIN_VERIFIED_AT
    || (value as number) > now + MAX_FUTURE_CLOCK_SKEW_MS
    || item.endedAt !== value
  ) return undefined;
  return value as number;
}

function documentProvenance(
  item: MigrationJobItem,
  now: number,
): DashboardSafeCopyDocumentVerificationProvenance | undefined {
  if (!isRecord(item.details)) return undefined;
  const raw = item.details[DOCUMENT_PROVENANCE_DETAIL_KEY];
  if (!isRecord(raw)) return undefined;
  if (Object.keys(raw).some((key) => !DOCUMENT_PROVENANCE_KEYS.has(key))) return undefined;

  const resolverVersion = positiveVersion(raw.resolverVersion);
  const verifierVersion = positiveVersion(raw.verifierVersion);
  const verifiedAt = boundedVerifiedAt(raw.verifiedAt, item, now);
  const provenance = {
    profile: raw.profile,
    resolverVersion,
    verifierVersion,
    jobId: exactBoundedString(raw.jobId),
    attemptId: exactBoundedString(raw.attemptId),
    targetId: exactBoundedString(raw.targetId),
    sourceInstanceId: exactBoundedString(raw.sourceInstanceId),
    sourceConnectionId: exactBoundedString(raw.sourceConnectionId),
    sourceDocumentId: exactBoundedString(raw.sourceDocumentId),
    sourceExportHash: exactBoundedString(raw.sourceExportHash),
    destinationInstanceId: exactBoundedString(raw.destinationInstanceId),
    connectionId: exactBoundedString(raw.connectionId),
    modelId: exactBoundedString(raw.modelId),
    folderId: raw.folderId === undefined ? undefined : exactBoundedString(raw.folderId),
    folderPath: raw.folderPath === undefined ? undefined : exactBoundedString(raw.folderPath),
    importedDocumentId: exactBoundedString(raw.importedDocumentId),
    importedIdentifier: exactBoundedString(raw.importedIdentifier),
    chosenName: exactBoundedString(raw.chosenName),
    expectedPayloadHash: exactBoundedString(raw.expectedPayloadHash),
    publishedFingerprint: exactBoundedString(raw.publishedFingerprint),
    finalVerification: raw.finalVerification,
    documentWriteMode: raw.documentWriteMode,
    verifiedAt,
  };
  if (
    provenance.profile !== SAFE_COPY_PROFILE
    || provenance.finalVerification !== 'passed'
    || provenance.documentWriteMode !== 'created'
    || !provenance.resolverVersion
    || !provenance.verifierVersion
    || !provenance.verifiedAt
    || !provenance.jobId
    || !provenance.attemptId
    || !provenance.targetId
    || !provenance.sourceInstanceId
    || !provenance.sourceConnectionId
    || !provenance.sourceDocumentId
    || !provenance.sourceExportHash
    || !provenance.destinationInstanceId
    || !provenance.connectionId
    || !provenance.modelId
    || !provenance.importedDocumentId
    || !provenance.importedIdentifier
    || !provenance.chosenName
    || !provenance.expectedPayloadHash
    || provenance.publishedFingerprint !== provenance.expectedPayloadHash
  ) return undefined;
  return provenance as DashboardSafeCopyDocumentVerificationProvenance;
}

function candidateForItem(
  job: MigrationJob,
  item: MigrationJobItem,
  scope: DashboardSafeCopyProvenanceScope,
  now: number,
): DashboardSafeCopyProvenanceMatch | undefined {
  if (item.kind !== 'document_verify' || item.status !== 'succeeded') return undefined;
  if (
    item.replacement === true
    || item.details?.updateInPlace === true
    || cleanString(item.error)
    || (item.warnings?.length || 0) > 0
  ) return undefined;
  const provenance = documentProvenance(item, now);
  if (!provenance) return undefined;
  if (job.sourceId !== scope.sourceInstanceId) return undefined;
  if (job.sourceConnectionId !== scope.sourceConnectionId) return undefined;
  if (!job.documentIds.includes(scope.sourceDocumentId)) return undefined;
  if (!job.destinationIds.includes(scope.destinationInstanceId)) return undefined;
  if (item.documentId !== scope.sourceDocumentId) return undefined;
  if (item.destinationId !== scope.destinationInstanceId) return undefined;

  const target = targetForItem(job, item);
  if (!target || target.destinationInstanceId !== scope.destinationInstanceId) return undefined;
  if (target.targetConnectionId !== scope.targetConnectionId) return undefined;
  if (target.targetModelId !== scope.targetModelId) return undefined;
  if (item.targetModelId !== scope.targetModelId) return undefined;

  if (
    !folderScopeMatches({
      folderId: target.targetFolderId,
      folderPath: target.targetFolderPath,
    }, scope)
    || !folderScopeMatches({
      folderId: item.targetFolderId,
      folderPath: item.targetFolderPath,
    }, scope)
  ) return undefined;
  if (
    provenance.jobId !== job.id
    || provenance.targetId !== target.id
    || provenance.sourceInstanceId !== scope.sourceInstanceId
    || provenance.sourceConnectionId !== scope.sourceConnectionId
    || provenance.sourceDocumentId !== scope.sourceDocumentId
    || provenance.destinationInstanceId !== scope.destinationInstanceId
    || provenance.connectionId !== scope.targetConnectionId
    || provenance.modelId !== scope.targetModelId
    || !folderScopeMatches(provenance, scope)
    || item.importedDocumentId !== provenance.importedDocumentId
    || item.importedIdentifier !== provenance.importedIdentifier
    || item.documentName !== provenance.chosenName
  ) return undefined;

  return {
    jobId: job.id,
    itemId: item.id,
    targetId: target.id,
    sourceInstanceId: job.sourceId,
    sourceConnectionId: job.sourceConnectionId,
    sourceDocumentId: item.documentId,
    sourceExportHash: provenance.sourceExportHash,
    destinationInstanceId: item.destinationId,
    targetConnectionId: provenance.connectionId,
    targetModelId: scope.targetModelId,
    ...(provenance.folderId ? { targetFolderId: provenance.folderId } : {}),
    ...(provenance.folderPath ? { targetFolderPath: provenance.folderPath } : {}),
    importedDocumentId: provenance.importedDocumentId,
    importedIdentifier: provenance.importedIdentifier,
    chosenName: provenance.chosenName,
    expectedPayloadHash: provenance.expectedPayloadHash,
    publishedFingerprint: provenance.publishedFingerprint,
    resolverVersion: provenance.resolverVersion,
    verifierVersion: provenance.verifierVersion,
    verifiedAt: provenance.verifiedAt,
    usage: 'audit_only',
    updateInPlaceAuthorized: false,
  };
}

function compareLatest(
  left: DashboardSafeCopyProvenanceMatch,
  right: DashboardSafeCopyProvenanceMatch,
): number {
  if (left.verifiedAt !== right.verifiedAt) return right.verifiedAt - left.verifiedAt;
  if (left.jobId !== right.jobId) return left.jobId < right.jobId ? 1 : -1;
  if (left.itemId === right.itemId) return 0;
  return left.itemId < right.itemId ? 1 : -1;
}

export function findLatestVerifiedDashboardSafeCopyProvenance(
  jobs: readonly MigrationJob[],
  scope: DashboardSafeCopyProvenanceScope,
  options: DashboardSafeCopyProvenanceLookupOptions = {},
): DashboardSafeCopyProvenanceMatch | undefined {
  const now = Number.isSafeInteger(options.now) ? options.now as number : Date.now();
  const candidates: DashboardSafeCopyProvenanceMatch[] = [];
  for (const job of jobs) {
    if (!isPersistedSafeCopyJob(job)) continue;
    for (const item of job.items) {
      const candidate = candidateForItem(job, item, scope, now);
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates.sort(compareLatest)[0];
}

export function findLatestVerifiedDashboardSafeCopyProvenanceInStore(
  scope: DashboardSafeCopyProvenanceScope,
  options: DashboardSafeCopyProvenanceLookupOptions = {},
): DashboardSafeCopyProvenanceMatch | undefined {
  return findLatestVerifiedDashboardSafeCopyProvenance(
    listJobs(Number.MAX_SAFE_INTEGER),
    scope,
    options,
  );
}

export function allocateDashboardSafeCopyName(
  originalName: string,
  existingNames: Iterable<string>,
): string {
  const normalizedOriginal = cleanString(originalName);
  if (!normalizedOriginal) {
    throw new DashboardSafeCopyNameAllocationError('A dashboard name is required before allocating a copy name.');
  }
  const occupied = new Set<string>();
  for (const name of existingNames) {
    const normalized = cleanString(name);
    if (normalized) occupied.add(canonicalName(normalized));
  }

  for (let attempt = 1; attempt <= MAX_COPY_NAME_ATTEMPTS; attempt += 1) {
    const suffix = attempt === 1 ? ' (Copy)' : ` (Copy ${attempt})`;
    const availableBaseLength = MAX_COPY_NAME_LENGTH - suffix.length;
    const base = normalizedOriginal.slice(0, availableBaseLength).trimEnd();
    if (!base) {
      throw new DashboardSafeCopyNameAllocationError('The dashboard name cannot be represented within the copy-name limit.');
    }
    const candidate = `${base}${suffix}`;
    if (!occupied.has(canonicalName(candidate))) return candidate;
  }
  throw new DashboardSafeCopyNameAllocationError(
    `No non-conflicting dashboard copy name was available within ${MAX_COPY_NAME_ATTEMPTS} attempts.`,
  );
}

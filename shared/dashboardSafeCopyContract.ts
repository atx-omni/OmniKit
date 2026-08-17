export const DASHBOARD_SAFE_COPY_PROFILE = 'safe_copy_v1' as const;
export const DASHBOARD_SAFE_COPY_RESOLVER_VERSION = 'safe-copy-resolver-v1' as const;

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_DOCUMENTS = 500;
const MAX_DESTINATIONS = 100;
export const DASHBOARD_SAFE_COPY_MAX_MATRIX_CELLS = 1_000;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_FOLDER_PATH_LENGTH = 1_024;

export interface DashboardSafeCopySource {
  instanceId: string;
  connectionId: string;
  documentIds: string[];
}

export interface DashboardSafeCopyDestination {
  targetId: string;
  instanceId: string;
  connectionId: string;
  modelId: string;
  folderId?: string;
  folderPath?: string;
}

export interface DashboardSafeCopyIntent {
  profile: typeof DASHBOARD_SAFE_COPY_PROFILE;
  requestId: string;
  source: DashboardSafeCopySource;
  destinations: DashboardSafeCopyDestination[];
}

export type DashboardSafeCopyErrorCode =
  | 'SAFE_COPY_INVALID_BODY'
  | 'SAFE_COPY_UNKNOWN_FIELD'
  | 'SAFE_COPY_INVALID_PROFILE'
  | 'SAFE_COPY_INVALID_REQUEST_ID'
  | 'SAFE_COPY_INVALID_SOURCE'
  | 'SAFE_COPY_INVALID_DESTINATION'
  | 'SAFE_COPY_DUPLICATE_TARGET'
  | 'SAFE_COPY_LIMIT_EXCEEDED'
  | 'SAFE_COPY_IDEMPOTENCY_CONFLICT'
  | 'SAFE_COPY_SCOPE_CONFLICT'
  | 'SAFE_COPY_INSTANCE_NOT_FOUND';

export class DashboardSafeCopyError extends Error {
  readonly code: DashboardSafeCopyErrorCode;
  readonly statusCode: number;

  constructor(code: DashboardSafeCopyErrorCode, message: string, statusCode = 400) {
    super(message);
    this.name = 'DashboardSafeCopyError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function compareCanonicalStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function hasAsciiControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  location: string,
): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) {
    throw new DashboardSafeCopyError(
      'SAFE_COPY_UNKNOWN_FIELD',
      `${location} contains ${unknown.length} unsupported field${unknown.length === 1 ? '' : 's'}.`,
    );
  }
}

function requiredIdentifier(
  value: unknown,
  label: string,
  code: DashboardSafeCopyErrorCode,
): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new DashboardSafeCopyError(code, `${label} is required.`);
  }
  const normalized = value.trim();
  if (hasAsciiControl(normalized)) {
    throw new DashboardSafeCopyError(code, `${label} contains unsupported control characters.`);
  }
  if (normalized.length > MAX_IDENTIFIER_LENGTH) {
    throw new DashboardSafeCopyError('SAFE_COPY_LIMIT_EXCEEDED', `${label} exceeds the bounded identifier length.`);
  }
  return normalized;
}

function optionalIdentifier(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredIdentifier(value, label, 'SAFE_COPY_INVALID_DESTINATION');
}

function optionalFolderPath(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    throw new DashboardSafeCopyError('SAFE_COPY_INVALID_DESTINATION', 'Destination folderPath must be a non-empty string when provided.');
  }
  const normalized = value.trim();
  if (hasAsciiControl(normalized)) {
    throw new DashboardSafeCopyError('SAFE_COPY_INVALID_DESTINATION', 'Destination folderPath contains unsupported control characters.');
  }
  if (normalized.length > MAX_FOLDER_PATH_LENGTH) {
    throw new DashboardSafeCopyError('SAFE_COPY_LIMIT_EXCEEDED', 'Destination folderPath exceeds the bounded length.');
  }
  return normalized;
}

function parseSource(value: unknown): DashboardSafeCopySource {
  if (!isRecord(value)) {
    throw new DashboardSafeCopyError('SAFE_COPY_INVALID_SOURCE', 'source must be an object.');
  }
  assertOnlyKeys(value, ['instanceId', 'connectionId', 'documentIds'], 'source');
  if (!Array.isArray(value.documentIds) || value.documentIds.length === 0) {
    throw new DashboardSafeCopyError('SAFE_COPY_INVALID_SOURCE', 'Select at least one source dashboard.');
  }
  if (value.documentIds.length > MAX_DOCUMENTS) {
    throw new DashboardSafeCopyError('SAFE_COPY_LIMIT_EXCEEDED', `A safe-copy request supports at most ${MAX_DOCUMENTS} dashboards.`);
  }
  const documentIds = [...new Set(value.documentIds.map((item, index) => (
    requiredIdentifier(item, `source.documentIds[${index}]`, 'SAFE_COPY_INVALID_SOURCE')
  )))].sort(compareCanonicalStrings);
  return {
    instanceId: requiredIdentifier(value.instanceId, 'source.instanceId', 'SAFE_COPY_INVALID_SOURCE'),
    connectionId: requiredIdentifier(value.connectionId, 'source.connectionId', 'SAFE_COPY_INVALID_SOURCE'),
    documentIds,
  };
}

function parseDestination(value: unknown, index: number): DashboardSafeCopyDestination {
  if (!isRecord(value)) {
    throw new DashboardSafeCopyError('SAFE_COPY_INVALID_DESTINATION', `destinations[${index}] must be an object.`);
  }
  assertOnlyKeys(
    value,
    ['targetId', 'instanceId', 'connectionId', 'modelId', 'folderId', 'folderPath'],
    `destinations[${index}]`,
  );
  const destination: DashboardSafeCopyDestination = {
    targetId: requiredIdentifier(value.targetId, `destinations[${index}].targetId`, 'SAFE_COPY_INVALID_DESTINATION'),
    instanceId: requiredIdentifier(value.instanceId, `destinations[${index}].instanceId`, 'SAFE_COPY_INVALID_DESTINATION'),
    connectionId: requiredIdentifier(value.connectionId, `destinations[${index}].connectionId`, 'SAFE_COPY_INVALID_DESTINATION'),
    modelId: requiredIdentifier(value.modelId, `destinations[${index}].modelId`, 'SAFE_COPY_INVALID_DESTINATION'),
  };
  const folderId = optionalIdentifier(value.folderId, `destinations[${index}].folderId`);
  const folderPath = optionalFolderPath(value.folderPath);
  if (folderId) destination.folderId = folderId;
  if (folderPath) destination.folderPath = folderPath;
  return destination;
}

function destinationCanonicalKey(destination: DashboardSafeCopyDestination): string {
  return JSON.stringify({
    targetId: destination.targetId,
    instanceId: destination.instanceId,
    connectionId: destination.connectionId,
    modelId: destination.modelId,
    folderId: destination.folderId || '',
    folderPath: destination.folderPath || '',
  });
}

function parseDestinations(value: unknown): DashboardSafeCopyDestination[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new DashboardSafeCopyError('SAFE_COPY_INVALID_DESTINATION', 'Select at least one destination.');
  }
  if (value.length > MAX_DESTINATIONS) {
    throw new DashboardSafeCopyError('SAFE_COPY_LIMIT_EXCEEDED', `A safe-copy request supports at most ${MAX_DESTINATIONS} destinations.`);
  }
  const byTargetId = new Map<string, DashboardSafeCopyDestination>();
  for (const [index, item] of value.entries()) {
    const destination = parseDestination(item, index);
    const existing = byTargetId.get(destination.targetId);
    if (!existing) {
      byTargetId.set(destination.targetId, destination);
      continue;
    }
    if (destinationCanonicalKey(existing) !== destinationCanonicalKey(destination)) {
      throw new DashboardSafeCopyError(
        'SAFE_COPY_DUPLICATE_TARGET',
        'A destination targetId was supplied with conflicting values.',
      );
    }
  }
  const destinations = [...byTargetId.values()];
  const destinationModelScopes = new Set<string>();
  for (const destination of destinations) {
    const scope = JSON.stringify({ instanceId: destination.instanceId, modelId: destination.modelId });
    if (destinationModelScopes.has(scope)) {
      throw new DashboardSafeCopyError(
        'SAFE_COPY_DUPLICATE_TARGET',
        'A safe-copy request supports only one destination target per destination model.',
      );
    }
    destinationModelScopes.add(scope);
  }
  return destinations.sort((left, right) => (
    compareCanonicalStrings(left.targetId, right.targetId)
      || compareCanonicalStrings(left.instanceId, right.instanceId)
      || compareCanonicalStrings(left.connectionId, right.connectionId)
      || compareCanonicalStrings(left.modelId, right.modelId)
  ));
}

export function parseDashboardSafeCopyIntent(value: unknown): DashboardSafeCopyIntent {
  if (!isRecord(value)) {
    throw new DashboardSafeCopyError('SAFE_COPY_INVALID_BODY', 'Safe-copy request body must be a JSON object.');
  }
  assertOnlyKeys(value, ['profile', 'requestId', 'source', 'destinations'], 'request');
  if (value.profile !== DASHBOARD_SAFE_COPY_PROFILE) {
    throw new DashboardSafeCopyError('SAFE_COPY_INVALID_PROFILE', `profile must be ${DASHBOARD_SAFE_COPY_PROFILE}.`);
  }
  const requestId = requiredIdentifier(value.requestId, 'requestId', 'SAFE_COPY_INVALID_REQUEST_ID').toLowerCase();
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw new DashboardSafeCopyError('SAFE_COPY_INVALID_REQUEST_ID', 'requestId must be a canonical UUID.');
  }
  const source = parseSource(value.source);
  const destinations = parseDestinations(value.destinations);
  if (source.documentIds.length * destinations.length > DASHBOARD_SAFE_COPY_MAX_MATRIX_CELLS) {
    throw new DashboardSafeCopyError(
      'SAFE_COPY_LIMIT_EXCEEDED',
      `A safe-copy request supports at most ${DASHBOARD_SAFE_COPY_MAX_MATRIX_CELLS} dashboard-destination copies.`,
    );
  }
  return {
    profile: DASHBOARD_SAFE_COPY_PROFILE,
    requestId,
    source,
    destinations,
  };
}

export function canonicalDashboardSafeCopyIntent(intent: DashboardSafeCopyIntent): DashboardSafeCopyIntent {
  return parseDashboardSafeCopyIntent(intent);
}

export function dashboardSafeCopyCanonicalJson(intent: DashboardSafeCopyIntent): string {
  const canonical = canonicalDashboardSafeCopyIntent(intent);
  return JSON.stringify({
    profile: canonical.profile,
    requestId: canonical.requestId,
    source: canonical.source,
    destinations: canonical.destinations,
  });
}

export function isDashboardSafeCopyError(error: unknown): error is DashboardSafeCopyError {
  return error instanceof DashboardSafeCopyError;
}

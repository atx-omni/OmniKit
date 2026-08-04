import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

export const BI_MIGRATION_RUN_SCHEMA_VERSION = '1.0' as const;

const DEFAULT_RUN_STORE_PATH = './data/bi-migration-runs.jsonl';
const GENESIS_HASH = `sha256:${'0'.repeat(64)}` as HashDigest;
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const SECRET_KEY_PATTERN = /(?:password|passphrase|secret|token|api[_-]?key|private[_-]?key|authorization|cookie|credential|raw[_-]?(?:request[_-]?)?body|request[_-]?body)/i;
const SECRET_VALUE_PATTERN = /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/-]+=*|\b(?:password|passphrase|secret|token|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+)/i;

export type HashDigest = `sha256:${string}`;

export type BiMigrationBootstrapPhase =
  | 'PLANNED'
  | 'PREFLIGHTED'
  | 'CONNECTION_READY'
  | 'SCHEMA_READY'
  | 'REFRESH_DISPATCHED'
  | 'REFRESHING'
  | 'REFRESHED'
  | 'SHARED_READY'
  | 'BRANCH_CREATING'
  | 'READY_FOR_YAML'
  | 'RECONCILE_REQUIRED'
  | 'FAILED'
  | 'ROLLED_BACK'
  | 'ROLLBACK_INCOMPLETE';

export type BiMigrationOperationStatus =
  | 'PLANNED'
  | 'DISPATCHED'
  | 'SUCCEEDED'
  | 'TERMINAL_FAILURE'
  | 'UNKNOWN'
  | 'RECONCILED';

export type BiMigrationResourceOwnership =
  | 'external'
  | 'created_by_run'
  | 'platform_generated'
  | 'adopted';

export type BiMigrationRunCommand = 'start' | 'reconcile' | 'rollback';

export interface BiMigrationResourceRef {
  id: string;
  ownership: BiMigrationResourceOwnership;
  logicalKey?: string;
  name?: string;
  kind?: string;
  connectionId?: string;
  baseModelId?: string;
  checksum?: HashDigest;
}

export interface BiMigrationRunResources {
  connection?: BiMigrationResourceRef;
  schemaModel?: BiMigrationResourceRef;
  sharedModel?: BiMigrationResourceRef;
  branch?: BiMigrationResourceRef;
}

export interface BiMigrationRefreshState {
  jobId?: string;
  status: 'NOT_STARTED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'UNKNOWN';
  nextPollAt?: string;
  deadlineAt?: string;
}

export interface BiMigrationRollbackEvidence {
  operationKey: string;
  resourceId?: string;
  ownership: BiMigrationResourceOwnership;
  beforeHash?: HashDigest;
  afterHash?: HashDigest;
  compensator: string;
  attempts: number;
  observedAt: string;
  completedAt?: string;
  errorCode?: string;
  errorMessage?: string;
  absenceVerified: boolean;
}

export interface BiMigrationRollbackState {
  status: 'NOT_STARTED' | 'RUNNING' | 'COMPLETED' | 'INCOMPLETE';
  evidence: BiMigrationRollbackEvidence[];
}

export interface BiMigrationOperationRecord {
  operationKey: string;
  kind: string;
  logicalResourceKey: string;
  inputHash: HashDigest;
  status: BiMigrationOperationStatus;
  attempt: number;
  ownership?: BiMigrationResourceOwnership;
  resource?: BiMigrationResourceRef;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  dispatchedAt?: string;
  completedAt?: string;
  unknownAt?: string;
}

export interface BiMigrationBootstrapRun {
  schemaVersion: typeof BI_MIGRATION_RUN_SCHEMA_VERSION;
  id: string;
  idempotencyKey: string;
  version: number;
  planHash: HashDigest;
  inputHash: HashDigest;
  phase: BiMigrationBootstrapPhase;
  operations: BiMigrationOperationRecord[];
  resources: BiMigrationRunResources;
  refresh: BiMigrationRefreshState;
  rollback: BiMigrationRollbackState;
  allowedCommands: BiMigrationRunCommand[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateBiMigrationRunInput {
  id?: string;
  idempotencyKey: string;
  planHash: HashDigest;
  inputHash: HashDigest;
  phase?: 'PLANNED';
  resources?: BiMigrationRunResources;
  refresh?: BiMigrationRefreshState;
  rollback?: BiMigrationRollbackState;
  allowedCommands?: BiMigrationRunCommand[];
}

export interface UpdateBiMigrationRunPatch {
  phase?: BiMigrationBootstrapPhase;
  resources?: BiMigrationRunResources;
  refresh?: BiMigrationRefreshState;
  rollback?: BiMigrationRollbackState;
  allowedCommands?: BiMigrationRunCommand[];
}

export interface AppendBiMigrationRunTransitionInput extends UpdateBiMigrationRunPatch {
  runId: string;
  expectedVersion: number;
}

export interface AppendBiMigrationOperationTransitionInput {
  runId: string;
  expectedVersion: number;
  operationKey: string;
  status: BiMigrationOperationStatus;
  kind?: string;
  logicalResourceKey?: string;
  inputHash?: HashDigest;
  ownership?: BiMigrationResourceOwnership;
  resource?: BiMigrationResourceRef;
  errorCode?: string;
  errorMessage?: string;
}

type JournalEventType = 'RUN_CREATED' | 'RUN_UPDATED' | 'RUN_RECOVERED';

interface BiMigrationJournalEventBody {
  schemaVersion: typeof BI_MIGRATION_RUN_SCHEMA_VERSION;
  sequence: number;
  eventId: string;
  occurredAt: string;
  previousHash: HashDigest;
  type: JournalEventType;
  runId: string;
  run: BiMigrationBootstrapRun;
}

interface BiMigrationJournalEvent extends BiMigrationJournalEventBody {
  hash: HashDigest;
}

interface BiMigrationRunSnapshot {
  schemaVersion: typeof BI_MIGRATION_RUN_SCHEMA_VERSION;
  eventCount: number;
  journalHeadHash: HashDigest;
  stateHash: HashDigest;
  runs: BiMigrationBootstrapRun[];
  writtenAt: string;
}

const BOOTSTRAP_PHASES = new Set<BiMigrationBootstrapPhase>([
  'PLANNED',
  'PREFLIGHTED',
  'CONNECTION_READY',
  'SCHEMA_READY',
  'REFRESH_DISPATCHED',
  'REFRESHING',
  'REFRESHED',
  'SHARED_READY',
  'BRANCH_CREATING',
  'READY_FOR_YAML',
  'RECONCILE_REQUIRED',
  'FAILED',
  'ROLLED_BACK',
  'ROLLBACK_INCOMPLETE',
]);

const OPERATION_STATUSES = new Set<BiMigrationOperationStatus>([
  'PLANNED',
  'DISPATCHED',
  'SUCCEEDED',
  'TERMINAL_FAILURE',
  'UNKNOWN',
  'RECONCILED',
]);

const RESOURCE_OWNERSHIP = new Set<BiMigrationResourceOwnership>([
  'external',
  'created_by_run',
  'platform_generated',
  'adopted',
]);

const RUN_COMMANDS = new Set<BiMigrationRunCommand>(['start', 'reconcile', 'rollback']);

const ALLOWED_OPERATION_TRANSITIONS: Record<BiMigrationOperationStatus, ReadonlySet<BiMigrationOperationStatus>> = {
  PLANNED: new Set(['DISPATCHED', 'TERMINAL_FAILURE']),
  DISPATCHED: new Set(['SUCCEEDED', 'TERMINAL_FAILURE', 'UNKNOWN']),
  SUCCEEDED: new Set(),
  TERMINAL_FAILURE: new Set(),
  UNKNOWN: new Set(['RECONCILED', 'TERMINAL_FAILURE']),
  RECONCILED: new Set(),
};

export class BiMigrationRunStoreError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = 'BiMigrationRunStoreError';
  }
}

export class BiMigrationRunValidationError extends BiMigrationRunStoreError {
  constructor(message: string) {
    super(message, 400);
    this.name = 'BiMigrationRunValidationError';
  }
}

export class BiMigrationRunNotFoundError extends BiMigrationRunStoreError {
  constructor(readonly runId: string) {
    super(`BI migration bootstrap run ${runId} was not found.`, 404);
    this.name = 'BiMigrationRunNotFoundError';
  }
}

export class BiMigrationRunVersionError extends BiMigrationRunStoreError {
  constructor(
    readonly runId: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(`BI migration bootstrap run ${runId} is at version ${actualVersion}, not ${expectedVersion}.`, 412);
    this.name = 'BiMigrationRunVersionError';
  }
}

export class BiMigrationRunIdempotencyConflictError extends BiMigrationRunStoreError {
  constructor(readonly idempotencyKey: string) {
    super('The BI migration idempotency key is already bound to different plan input.', 409);
    this.name = 'BiMigrationRunIdempotencyConflictError';
  }
}

export class BiMigrationRunTamperError extends BiMigrationRunStoreError {
  constructor(message = 'The BI migration run journal failed its integrity check.') {
    super(message, 500);
    this.name = 'BiMigrationRunTamperError';
  }
}

let cachedPath = '';
let cachedRuns: Map<string, BiMigrationBootstrapRun> | null = null;
let cachedHeadHash: HashDigest = GENESIS_HASH;
let cachedEventCount = 0;
let mutationTail: Promise<void> = Promise.resolve();

export function getBiMigrationRunStorePath(): string {
  return process.env.OMNIKIT_BI_MIGRATION_RUN_STORE_PATH || DEFAULT_RUN_STORE_PATH;
}

export function getBiMigrationRunSnapshotPath(): string {
  return `${getBiMigrationRunStorePath()}.snapshot.json`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableValue(nested)]),
  );
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function sha256(value: string): HashDigest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function cloneRun(run: BiMigrationBootstrapRun): BiMigrationBootstrapRun {
  return structuredClone(run);
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknown) throw new BiMigrationRunValidationError(`${label} contains unsupported field ${unknown}.`);
}

function assertNoSecretMaterial(value: unknown, path = 'input'): void {
  if (Array.isArray(value)) {
    value.forEach((nested, index) => assertNoSecretMaterial(nested, `${path}[${index}]`));
    return;
  }
  if (isRecord(value)) {
    for (const [key, nested] of Object.entries(value)) {
      if (SECRET_KEY_PATTERN.test(key)) {
        throw new BiMigrationRunValidationError(`Secret-shaped field ${path}.${key} cannot be persisted in the BI migration run journal.`);
      }
      assertNoSecretMaterial(nested, `${path}.${key}`);
    }
    return;
  }
  if (typeof value === 'string' && SECRET_VALUE_PATTERN.test(value)) {
    throw new BiMigrationRunValidationError(`Secret-shaped content cannot be persisted at ${path}.`);
  }
}

function assertSafeIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !SAFE_IDENTIFIER_PATTERN.test(value)) {
    throw new BiMigrationRunValidationError(`${label} is invalid.`);
  }
}

function assertHash(value: unknown, label: string): asserts value is HashDigest {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    throw new BiMigrationRunValidationError(`${label} must be a sha256 digest.`);
  }
}

function assertIsoTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new BiMigrationRunValidationError(`${label} must be an ISO timestamp.`);
  }
}

function normalizeCommands(value: unknown): BiMigrationRunCommand[] {
  if (!Array.isArray(value)) throw new BiMigrationRunValidationError('allowedCommands must be an array.');
  const commands = value.map((command) => {
    if (typeof command !== 'string' || !RUN_COMMANDS.has(command as BiMigrationRunCommand)) {
      throw new BiMigrationRunValidationError('allowedCommands contains an invalid command.');
    }
    return command as BiMigrationRunCommand;
  });
  return [...new Set(commands)];
}

function normalizeResource(value: unknown, label: string): BiMigrationResourceRef {
  if (!isRecord(value)) throw new BiMigrationRunValidationError(`${label} is invalid.`);
  assertExactKeys(value, [
    'id', 'ownership', 'logicalKey', 'name', 'kind', 'connectionId', 'baseModelId', 'checksum',
  ], label);
  assertSafeIdentifier(value.id, `${label}.id`);
  if (typeof value.ownership !== 'string' || !RESOURCE_OWNERSHIP.has(value.ownership as BiMigrationResourceOwnership)) {
    throw new BiMigrationRunValidationError(`${label}.ownership is invalid.`);
  }
  const optionalIdentifiers = ['logicalKey', 'connectionId', 'baseModelId'] as const;
  for (const key of optionalIdentifiers) {
    if (value[key] !== undefined) assertSafeIdentifier(value[key], `${label}.${key}`);
  }
  for (const key of ['name', 'kind'] as const) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key].length > 256)) {
      throw new BiMigrationRunValidationError(`${label}.${key} is invalid.`);
    }
  }
  if (value.checksum !== undefined) assertHash(value.checksum, `${label}.checksum`);
  return {
    id: value.id,
    ownership: value.ownership as BiMigrationResourceOwnership,
    ...(value.logicalKey === undefined ? {} : { logicalKey: value.logicalKey as string }),
    ...(value.name === undefined ? {} : { name: value.name as string }),
    ...(value.kind === undefined ? {} : { kind: value.kind as string }),
    ...(value.connectionId === undefined ? {} : { connectionId: value.connectionId as string }),
    ...(value.baseModelId === undefined ? {} : { baseModelId: value.baseModelId as string }),
    ...(value.checksum === undefined ? {} : { checksum: value.checksum as HashDigest }),
  };
}

function normalizeResources(value: unknown): BiMigrationRunResources {
  if (!isRecord(value)) throw new BiMigrationRunValidationError('resources must be an object.');
  assertExactKeys(value, ['connection', 'schemaModel', 'sharedModel', 'branch'], 'resources');
  const normalized: BiMigrationRunResources = {};
  for (const key of ['connection', 'schemaModel', 'sharedModel', 'branch'] as const) {
    if (value[key] !== undefined) normalized[key] = normalizeResource(value[key], `resources.${key}`);
  }
  return normalized;
}

function normalizeRefresh(value: unknown): BiMigrationRefreshState {
  if (!isRecord(value)) throw new BiMigrationRunValidationError('refresh must be an object.');
  assertExactKeys(value, ['jobId', 'status', 'nextPollAt', 'deadlineAt'], 'refresh');
  const statuses = new Set(['NOT_STARTED', 'RUNNING', 'COMPLETED', 'FAILED', 'UNKNOWN']);
  if (typeof value.status !== 'string' || !statuses.has(value.status)) {
    throw new BiMigrationRunValidationError('refresh.status is invalid.');
  }
  if (value.jobId !== undefined) assertSafeIdentifier(value.jobId, 'refresh.jobId');
  if (value.nextPollAt !== undefined) assertIsoTimestamp(value.nextPollAt, 'refresh.nextPollAt');
  if (value.deadlineAt !== undefined) assertIsoTimestamp(value.deadlineAt, 'refresh.deadlineAt');
  return {
    status: value.status as BiMigrationRefreshState['status'],
    ...(value.jobId === undefined ? {} : { jobId: value.jobId }),
    ...(value.nextPollAt === undefined ? {} : { nextPollAt: value.nextPollAt }),
    ...(value.deadlineAt === undefined ? {} : { deadlineAt: value.deadlineAt }),
  };
}

function normalizeRollbackEvidence(value: unknown, index: number): BiMigrationRollbackEvidence {
  if (!isRecord(value)) throw new BiMigrationRunValidationError(`rollback.evidence[${index}] is invalid.`);
  assertExactKeys(value, [
    'operationKey', 'resourceId', 'ownership', 'beforeHash', 'afterHash', 'compensator', 'attempts',
    'observedAt', 'completedAt', 'errorCode', 'errorMessage', 'absenceVerified',
  ], `rollback.evidence[${index}]`);
  assertSafeIdentifier(value.operationKey, `rollback.evidence[${index}].operationKey`);
  if (value.resourceId !== undefined) assertSafeIdentifier(value.resourceId, `rollback.evidence[${index}].resourceId`);
  if (typeof value.ownership !== 'string' || !RESOURCE_OWNERSHIP.has(value.ownership as BiMigrationResourceOwnership)) {
    throw new BiMigrationRunValidationError(`rollback.evidence[${index}].ownership is invalid.`);
  }
  if (value.beforeHash !== undefined) assertHash(value.beforeHash, `rollback.evidence[${index}].beforeHash`);
  if (value.afterHash !== undefined) assertHash(value.afterHash, `rollback.evidence[${index}].afterHash`);
  assertSafeIdentifier(value.compensator, `rollback.evidence[${index}].compensator`);
  if (!Number.isInteger(value.attempts) || Number(value.attempts) < 0) {
    throw new BiMigrationRunValidationError(`rollback.evidence[${index}].attempts is invalid.`);
  }
  assertIsoTimestamp(value.observedAt, `rollback.evidence[${index}].observedAt`);
  if (value.completedAt !== undefined) assertIsoTimestamp(value.completedAt, `rollback.evidence[${index}].completedAt`);
  for (const key of ['errorCode', 'errorMessage'] as const) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key].length > 1_000)) {
      throw new BiMigrationRunValidationError(`rollback.evidence[${index}].${key} is invalid.`);
    }
  }
  if (typeof value.absenceVerified !== 'boolean') {
    throw new BiMigrationRunValidationError(`rollback.evidence[${index}].absenceVerified is invalid.`);
  }
  return value as unknown as BiMigrationRollbackEvidence;
}

function normalizeRollback(value: unknown): BiMigrationRollbackState {
  if (!isRecord(value)) throw new BiMigrationRunValidationError('rollback must be an object.');
  assertExactKeys(value, ['status', 'evidence'], 'rollback');
  const statuses = new Set(['NOT_STARTED', 'RUNNING', 'COMPLETED', 'INCOMPLETE']);
  if (typeof value.status !== 'string' || !statuses.has(value.status)) {
    throw new BiMigrationRunValidationError('rollback.status is invalid.');
  }
  if (!Array.isArray(value.evidence)) throw new BiMigrationRunValidationError('rollback.evidence must be an array.');
  return {
    status: value.status as BiMigrationRollbackState['status'],
    evidence: value.evidence.map(normalizeRollbackEvidence),
  };
}

function normalizeOperation(value: unknown, index: number): BiMigrationOperationRecord {
  if (!isRecord(value)) throw new BiMigrationRunValidationError(`operations[${index}] is invalid.`);
  assertExactKeys(value, [
    'operationKey', 'kind', 'logicalResourceKey', 'inputHash', 'status', 'attempt', 'ownership', 'resource',
    'errorCode', 'errorMessage', 'createdAt', 'updatedAt', 'dispatchedAt', 'completedAt', 'unknownAt',
  ], `operations[${index}]`);
  assertSafeIdentifier(value.operationKey, `operations[${index}].operationKey`);
  assertSafeIdentifier(value.kind, `operations[${index}].kind`);
  assertSafeIdentifier(value.logicalResourceKey, `operations[${index}].logicalResourceKey`);
  assertHash(value.inputHash, `operations[${index}].inputHash`);
  if (typeof value.status !== 'string' || !OPERATION_STATUSES.has(value.status as BiMigrationOperationStatus)) {
    throw new BiMigrationRunValidationError(`operations[${index}].status is invalid.`);
  }
  if (!Number.isInteger(value.attempt) || Number(value.attempt) < 0) {
    throw new BiMigrationRunValidationError(`operations[${index}].attempt is invalid.`);
  }
  if (value.ownership !== undefined && (
    typeof value.ownership !== 'string'
    || !RESOURCE_OWNERSHIP.has(value.ownership as BiMigrationResourceOwnership)
  )) {
    throw new BiMigrationRunValidationError(`operations[${index}].ownership is invalid.`);
  }
  const resource = value.resource === undefined ? undefined : normalizeResource(value.resource, `operations[${index}].resource`);
  for (const key of ['errorCode', 'errorMessage'] as const) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key].length > 1_000)) {
      throw new BiMigrationRunValidationError(`operations[${index}].${key} is invalid.`);
    }
  }
  for (const key of ['createdAt', 'updatedAt'] as const) assertIsoTimestamp(value[key], `operations[${index}].${key}`);
  for (const key of ['dispatchedAt', 'completedAt', 'unknownAt'] as const) {
    if (value[key] !== undefined) assertIsoTimestamp(value[key], `operations[${index}].${key}`);
  }
  return {
    ...value,
    resource,
  } as unknown as BiMigrationOperationRecord;
}

function normalizeRun(value: unknown): BiMigrationBootstrapRun {
  if (!isRecord(value)) throw new BiMigrationRunValidationError('run is invalid.');
  assertNoSecretMaterial(value, 'run');
  assertExactKeys(value, [
    'schemaVersion', 'id', 'idempotencyKey', 'version', 'planHash', 'inputHash', 'phase', 'operations',
    'resources', 'refresh', 'rollback', 'allowedCommands', 'createdAt', 'updatedAt',
  ], 'run');
  if (value.schemaVersion !== BI_MIGRATION_RUN_SCHEMA_VERSION) {
    throw new BiMigrationRunValidationError('run.schemaVersion is unsupported.');
  }
  assertSafeIdentifier(value.id, 'run.id');
  assertSafeIdentifier(value.idempotencyKey, 'run.idempotencyKey');
  if (!Number.isInteger(value.version) || Number(value.version) < 1) {
    throw new BiMigrationRunValidationError('run.version is invalid.');
  }
  assertHash(value.planHash, 'run.planHash');
  assertHash(value.inputHash, 'run.inputHash');
  if (typeof value.phase !== 'string' || !BOOTSTRAP_PHASES.has(value.phase as BiMigrationBootstrapPhase)) {
    throw new BiMigrationRunValidationError('run.phase is invalid.');
  }
  if (!Array.isArray(value.operations)) throw new BiMigrationRunValidationError('run.operations must be an array.');
  assertIsoTimestamp(value.createdAt, 'run.createdAt');
  assertIsoTimestamp(value.updatedAt, 'run.updatedAt');
  return {
    schemaVersion: BI_MIGRATION_RUN_SCHEMA_VERSION,
    id: value.id,
    idempotencyKey: value.idempotencyKey,
    version: value.version as number,
    planHash: value.planHash,
    inputHash: value.inputHash,
    phase: value.phase as BiMigrationBootstrapPhase,
    operations: value.operations.map(normalizeOperation),
    resources: normalizeResources(value.resources),
    refresh: normalizeRefresh(value.refresh),
    rollback: normalizeRollback(value.rollback),
    allowedCommands: normalizeCommands(value.allowedCommands),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function secureDirectory(pathname: string): void {
  mkdirSync(dirname(pathname), { recursive: true, mode: 0o700 });
}

function secureExistingFile(pathname: string): void {
  if (existsSync(pathname)) chmodSync(pathname, 0o600);
}

function fsyncDirectory(pathname: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dirname(pathname), 'r');
    fsyncSync(fd);
  } catch {
    // Some platforms do not permit directory fsync. File fsync remains authoritative.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function writeAtomic(pathname: string, content: string): void {
  secureDirectory(pathname);
  const temporaryPath = `${pathname}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporaryPath, 'w', 0o600);
    writeFileSync(fd, content, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, pathname);
    chmodSync(pathname, 0o600);
    fsyncDirectory(pathname);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    throw error;
  }
}

function currentRuns(): Map<string, BiMigrationBootstrapRun> {
  if (!cachedRuns) throw new Error('BI migration run store was not loaded.');
  return cachedRuns;
}

function runsForSnapshot(): BiMigrationBootstrapRun[] {
  return [...currentRuns().values()]
    .map(cloneRun)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function writeSnapshot(): void {
  const runs = runsForSnapshot();
  const snapshot: BiMigrationRunSnapshot = {
    schemaVersion: BI_MIGRATION_RUN_SCHEMA_VERSION,
    eventCount: cachedEventCount,
    journalHeadHash: cachedHeadHash,
    stateHash: sha256(stableStringify(runs)),
    runs,
    writtenAt: new Date().toISOString(),
  };
  assertNoSecretMaterial(snapshot, 'snapshot');
  writeAtomic(getBiMigrationRunSnapshotPath(), `${JSON.stringify(snapshot, null, 2)}\n`);
}

function eventHash(body: BiMigrationJournalEventBody): HashDigest {
  return sha256(stableStringify(body));
}

function appendEvent(type: JournalEventType, run: BiMigrationBootstrapRun): void {
  const pathname = getBiMigrationRunStorePath();
  secureDirectory(pathname);
  const body: BiMigrationJournalEventBody = {
    schemaVersion: BI_MIGRATION_RUN_SCHEMA_VERSION,
    sequence: cachedEventCount + 1,
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    previousHash: cachedHeadHash,
    type,
    runId: run.id,
    run: normalizeRun(run),
  };
  assertNoSecretMaterial(body, 'journalEvent');
  const event: BiMigrationJournalEvent = { ...body, hash: eventHash(body) };
  let fd: number | undefined;
  try {
    fd = openSync(pathname, 'a', 0o600);
    writeSync(fd, `${JSON.stringify(event)}\n`, undefined, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    chmodSync(pathname, 0o600);
    fsyncDirectory(pathname);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    throw error;
  }
  currentRuns().set(run.id, cloneRun(run));
  cachedEventCount = event.sequence;
  cachedHeadHash = event.hash;
  writeSnapshot();
}

function parseJournalEvent(line: string, expectedSequence: number, expectedPreviousHash: HashDigest): BiMigrationJournalEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    throw new BiMigrationRunTamperError('The BI migration run journal contains invalid JSON.');
  }
  if (!isRecord(parsed)) throw new BiMigrationRunTamperError();
  const { hash, ...body } = parsed;
  if (typeof hash !== 'string' || !HASH_PATTERN.test(hash)) throw new BiMigrationRunTamperError();
  if (body.schemaVersion !== BI_MIGRATION_RUN_SCHEMA_VERSION) throw new BiMigrationRunTamperError();
  if (body.sequence !== expectedSequence || body.previousHash !== expectedPreviousHash) {
    throw new BiMigrationRunTamperError('The BI migration run journal hash chain is discontinuous.');
  }
  if (body.type !== 'RUN_CREATED' && body.type !== 'RUN_UPDATED' && body.type !== 'RUN_RECOVERED') {
    throw new BiMigrationRunTamperError('The BI migration run journal contains an unsupported event.');
  }
  if (eventHash(body as unknown as BiMigrationJournalEventBody) !== hash) {
    throw new BiMigrationRunTamperError();
  }
  let run: BiMigrationBootstrapRun;
  try {
    run = normalizeRun(body.run);
  } catch {
    throw new BiMigrationRunTamperError('The BI migration run journal contains an invalid run snapshot.');
  }
  if (body.runId !== run.id) throw new BiMigrationRunTamperError();
  return { ...(body as unknown as BiMigrationJournalEventBody), run, hash: hash as HashDigest };
}

function validateSnapshotIfCurrent(): void {
  const pathname = getBiMigrationRunSnapshotPath();
  if (!existsSync(pathname)) return;
  secureExistingFile(pathname);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(pathname, 'utf8')) as unknown;
  } catch {
    throw new BiMigrationRunTamperError('The BI migration run snapshot contains invalid JSON.');
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== BI_MIGRATION_RUN_SCHEMA_VERSION) {
    throw new BiMigrationRunTamperError('The BI migration run snapshot is invalid.');
  }
  if (!Array.isArray(parsed.runs)) {
    throw new BiMigrationRunTamperError('The BI migration run snapshot does not contain valid run state.');
  }
  let snapshotRuns: BiMigrationBootstrapRun[];
  try {
    snapshotRuns = parsed.runs.map(normalizeRun).sort((left, right) => left.id.localeCompare(right.id));
  } catch {
    throw new BiMigrationRunTamperError('The BI migration run snapshot contains invalid run state.');
  }
  if (parsed.stateHash !== sha256(stableStringify(snapshotRuns))) {
    throw new BiMigrationRunTamperError('The BI migration run snapshot failed its state integrity check.');
  }
  const eventCount = Number(parsed.eventCount);
  if (!Number.isInteger(eventCount) || eventCount < 0 || eventCount > cachedEventCount) {
    throw new BiMigrationRunTamperError('The BI migration run snapshot is ahead of its journal.');
  }
  if (eventCount !== cachedEventCount) return;
  const runs = runsForSnapshot();
  if (parsed.journalHeadHash !== cachedHeadHash || parsed.stateHash !== sha256(stableStringify(runs))) {
    throw new BiMigrationRunTamperError('The BI migration run snapshot does not match its journal.');
  }
}

function recoverInterruptedRuns(): void {
  for (const run of [...currentRuns().values()]) {
    const interrupted = run.operations.filter((operation) => operation.status === 'DISPATCHED');
    if (interrupted.length === 0) continue;
    const now = new Date().toISOString();
    const recovered = cloneRun(run);
    recovered.operations = recovered.operations.map((operation) => (
      operation.status === 'DISPATCHED'
        ? { ...operation, status: 'UNKNOWN', unknownAt: now, updatedAt: now }
        : operation
    ));
    recovered.phase = 'RECONCILE_REQUIRED';
    recovered.allowedCommands = ['reconcile', 'rollback'];
    recovered.version += 1;
    recovered.updatedAt = now;
    appendEvent('RUN_RECOVERED', recovered);
  }
}

function ensureLoaded(): void {
  const pathname = getBiMigrationRunStorePath();
  if (cachedRuns && cachedPath === pathname) return;
  cachedPath = pathname;
  cachedRuns = new Map();
  cachedHeadHash = GENESIS_HASH;
  cachedEventCount = 0;
  if (!existsSync(pathname)) return;
  secureExistingFile(pathname);
  const lines = readFileSync(pathname, 'utf8').split(/\r?\n/).filter((line) => line.trim());
  for (const line of lines) {
    const event = parseJournalEvent(line, cachedEventCount + 1, cachedHeadHash);
    const prior = currentRuns().get(event.runId);
    if (event.type === 'RUN_CREATED') {
      if (prior || event.run.version !== 1) throw new BiMigrationRunTamperError();
    } else if (!prior || event.run.version !== prior.version + 1) {
      throw new BiMigrationRunTamperError('The BI migration run journal contains an invalid version transition.');
    }
    currentRuns().set(event.runId, cloneRun(event.run));
    cachedEventCount = event.sequence;
    cachedHeadHash = event.hash;
  }
  validateSnapshotIfCurrent();
  recoverInterruptedRuns();
}

async function withMutationLock<T>(operation: () => T): Promise<T> {
  const previous = mutationTail;
  let release: (() => void) | undefined;
  mutationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return operation();
  } finally {
    release?.();
  }
}

function requireRun(runId: string): BiMigrationBootstrapRun {
  assertSafeIdentifier(runId, 'runId');
  const run = currentRuns().get(runId);
  if (!run) throw new BiMigrationRunNotFoundError(runId);
  return run;
}

function assertExpectedVersion(run: BiMigrationBootstrapRun, expectedVersion: number): void {
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new BiMigrationRunValidationError('expectedVersion is invalid.');
  }
  if (run.version !== expectedVersion) {
    throw new BiMigrationRunVersionError(run.id, expectedVersion, run.version);
  }
}

function normalizeCreateInput(input: CreateBiMigrationRunInput): CreateBiMigrationRunInput {
  if (!isRecord(input)) throw new BiMigrationRunValidationError('BI migration run input is invalid.');
  assertNoSecretMaterial(input);
  assertExactKeys(input, [
    'id', 'idempotencyKey', 'planHash', 'inputHash', 'phase', 'resources', 'refresh', 'rollback', 'allowedCommands',
  ], 'input');
  if (input.id !== undefined) assertSafeIdentifier(input.id, 'input.id');
  assertSafeIdentifier(input.idempotencyKey, 'input.idempotencyKey');
  assertHash(input.planHash, 'input.planHash');
  assertHash(input.inputHash, 'input.inputHash');
  if (input.phase !== undefined && input.phase !== 'PLANNED') {
    throw new BiMigrationRunValidationError('A new BI migration bootstrap run must start in PLANNED.');
  }
  return {
    ...input,
    ...(input.resources === undefined ? {} : { resources: normalizeResources(input.resources) }),
    ...(input.refresh === undefined ? {} : { refresh: normalizeRefresh(input.refresh) }),
    ...(input.rollback === undefined ? {} : { rollback: normalizeRollback(input.rollback) }),
    ...(input.allowedCommands === undefined ? {} : { allowedCommands: normalizeCommands(input.allowedCommands) }),
  };
}

function normalizeUpdatePatch(patch: UpdateBiMigrationRunPatch): UpdateBiMigrationRunPatch {
  if (!isRecord(patch)) throw new BiMigrationRunValidationError('BI migration run update is invalid.');
  assertNoSecretMaterial(patch, 'patch');
  assertExactKeys(patch, ['phase', 'resources', 'refresh', 'rollback', 'allowedCommands'], 'patch');
  if (
    patch.phase !== undefined
    && (typeof patch.phase !== 'string' || !BOOTSTRAP_PHASES.has(patch.phase as BiMigrationBootstrapPhase))
  ) {
    throw new BiMigrationRunValidationError('patch.phase is invalid.');
  }
  return {
    ...patch,
    ...(patch.resources === undefined ? {} : { resources: normalizeResources(patch.resources) }),
    ...(patch.refresh === undefined ? {} : { refresh: normalizeRefresh(patch.refresh) }),
    ...(patch.rollback === undefined ? {} : { rollback: normalizeRollback(patch.rollback) }),
    ...(patch.allowedCommands === undefined ? {} : { allowedCommands: normalizeCommands(patch.allowedCommands) }),
  };
}

function applyPatch(run: BiMigrationBootstrapRun, patch: UpdateBiMigrationRunPatch): BiMigrationBootstrapRun {
  const normalized = normalizeUpdatePatch(patch);
  const now = new Date().toISOString();
  return normalizeRun({
    ...cloneRun(run),
    ...normalized,
    resources: normalized.resources === undefined
      ? run.resources
      : { ...run.resources, ...normalized.resources },
    version: run.version + 1,
    updatedAt: now,
  });
}

export async function createBiMigrationRun(input: CreateBiMigrationRunInput): Promise<BiMigrationBootstrapRun> {
  return withMutationLock(() => {
    ensureLoaded();
    const normalized = normalizeCreateInput(input);
    const existing = [...currentRuns().values()].find((run) => run.idempotencyKey === normalized.idempotencyKey);
    if (existing) {
      if (existing.planHash === normalized.planHash && existing.inputHash === normalized.inputHash) return cloneRun(existing);
      throw new BiMigrationRunIdempotencyConflictError(normalized.idempotencyKey);
    }
    const now = new Date().toISOString();
    const run = normalizeRun({
      schemaVersion: BI_MIGRATION_RUN_SCHEMA_VERSION,
      id: normalized.id || randomUUID(),
      idempotencyKey: normalized.idempotencyKey,
      version: 1,
      planHash: normalized.planHash,
      inputHash: normalized.inputHash,
      phase: 'PLANNED',
      operations: [],
      resources: normalized.resources || {},
      refresh: normalized.refresh || { status: 'NOT_STARTED' },
      rollback: normalized.rollback || { status: 'NOT_STARTED', evidence: [] },
      allowedCommands: normalized.allowedCommands || ['start'],
      createdAt: now,
      updatedAt: now,
    });
    appendEvent('RUN_CREATED', run);
    return cloneRun(run);
  });
}

export async function getBiMigrationRun(runId: string): Promise<BiMigrationBootstrapRun | undefined> {
  ensureLoaded();
  assertSafeIdentifier(runId, 'runId');
  const run = currentRuns().get(runId);
  return run ? cloneRun(run) : undefined;
}

export async function listBiMigrationRuns(): Promise<BiMigrationBootstrapRun[]> {
  ensureLoaded();
  return [...currentRuns().values()]
    .map(cloneRun)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function updateBiMigrationRun(
  runId: string,
  expectedVersion: number,
  patch: UpdateBiMigrationRunPatch,
): Promise<BiMigrationBootstrapRun> {
  return withMutationLock(() => {
    ensureLoaded();
    const run = requireRun(runId);
    assertExpectedVersion(run, expectedVersion);
    const updated = applyPatch(run, patch);
    appendEvent('RUN_UPDATED', updated);
    return cloneRun(updated);
  });
}

export async function appendBiMigrationRunTransition(
  input: AppendBiMigrationRunTransitionInput,
): Promise<BiMigrationBootstrapRun> {
  if (!isRecord(input)) throw new BiMigrationRunValidationError('BI migration run transition is invalid.');
  assertNoSecretMaterial(input);
  assertExactKeys(input, [
    'runId', 'expectedVersion', 'phase', 'resources', 'refresh', 'rollback', 'allowedCommands',
  ], 'transition');
  const { runId, expectedVersion, ...patch } = input;
  return updateBiMigrationRun(runId, expectedVersion, patch);
}

export async function appendBiMigrationOperationTransition(
  input: AppendBiMigrationOperationTransitionInput,
): Promise<BiMigrationBootstrapRun> {
  return withMutationLock(() => {
    ensureLoaded();
    if (!isRecord(input)) throw new BiMigrationRunValidationError('BI migration operation transition is invalid.');
    assertNoSecretMaterial(input);
    assertExactKeys(input, [
      'runId', 'expectedVersion', 'operationKey', 'status', 'kind', 'logicalResourceKey', 'inputHash',
      'ownership', 'resource', 'errorCode', 'errorMessage',
    ], 'operationTransition');
    const run = requireRun(input.runId);
    assertExpectedVersion(run, input.expectedVersion);
    assertSafeIdentifier(input.operationKey, 'operationTransition.operationKey');
    if (!OPERATION_STATUSES.has(input.status)) throw new BiMigrationRunValidationError('operationTransition.status is invalid.');
    const now = new Date().toISOString();
    const operations = run.operations.map((operation) => ({ ...operation }));
    const index = operations.findIndex((operation) => operation.operationKey === input.operationKey);
    if (index === -1) {
      if (input.status !== 'PLANNED') {
        throw new BiMigrationRunValidationError('A new BI migration operation must start in PLANNED.');
      }
      assertSafeIdentifier(input.kind, 'operationTransition.kind');
      assertSafeIdentifier(input.logicalResourceKey, 'operationTransition.logicalResourceKey');
      assertHash(input.inputHash, 'operationTransition.inputHash');
      operations.push(normalizeOperation({
        operationKey: input.operationKey,
        kind: input.kind,
        logicalResourceKey: input.logicalResourceKey,
        inputHash: input.inputHash,
        status: 'PLANNED',
        attempt: 0,
        ...(input.ownership === undefined ? {} : { ownership: input.ownership }),
        createdAt: now,
        updatedAt: now,
      }, operations.length));
    } else {
      const existing = operations[index];
      if (!ALLOWED_OPERATION_TRANSITIONS[existing.status].has(input.status)) {
        throw new BiMigrationRunValidationError(`Operation ${input.operationKey} cannot transition from ${existing.status} to ${input.status}.`);
      }
      if (input.kind !== undefined && input.kind !== existing.kind) {
        throw new BiMigrationRunValidationError('operationTransition.kind cannot change.');
      }
      if (input.logicalResourceKey !== undefined && input.logicalResourceKey !== existing.logicalResourceKey) {
        throw new BiMigrationRunValidationError('operationTransition.logicalResourceKey cannot change.');
      }
      if (input.inputHash !== undefined && input.inputHash !== existing.inputHash) {
        throw new BiMigrationRunValidationError('operationTransition.inputHash cannot change.');
      }
      if (input.ownership !== undefined && !RESOURCE_OWNERSHIP.has(input.ownership)) {
        throw new BiMigrationRunValidationError('operationTransition.ownership is invalid.');
      }
      const resource = input.resource === undefined
        ? existing.resource
        : normalizeResource(input.resource, 'operationTransition.resource');
      for (const key of ['errorCode', 'errorMessage'] as const) {
        if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key]!.length > 1_000)) {
          throw new BiMigrationRunValidationError(`operationTransition.${key} is invalid.`);
        }
      }
      operations[index] = normalizeOperation({
        ...existing,
        status: input.status,
        attempt: input.status === 'DISPATCHED' ? existing.attempt + 1 : existing.attempt,
        ...(input.ownership === undefined ? {} : { ownership: input.ownership }),
        ...(resource === undefined ? {} : { resource }),
        ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
        ...(input.errorMessage === undefined ? {} : { errorMessage: input.errorMessage }),
        updatedAt: now,
        ...(input.status === 'DISPATCHED' ? { dispatchedAt: now } : {}),
        ...(['SUCCEEDED', 'TERMINAL_FAILURE', 'RECONCILED'].includes(input.status) ? { completedAt: now } : {}),
        ...(input.status === 'UNKNOWN' ? { unknownAt: now } : {}),
      }, index);
    }
    const updated = normalizeRun({
      ...cloneRun(run),
      operations,
      version: run.version + 1,
      updatedAt: now,
    });
    appendEvent('RUN_UPDATED', updated);
    return cloneRun(updated);
  });
}

/**
 * Callers must await this durable transition before issuing the remote mutation.
 * A process crash after this function returns is recovered as UNKNOWN.
 */
export async function markBiMigrationOperationDispatched(input: {
  runId: string;
  expectedVersion: number;
  operationKey: string;
}): Promise<BiMigrationBootstrapRun> {
  return appendBiMigrationOperationTransition({ ...input, status: 'DISPATCHED' });
}

export function resetBiMigrationRunStoreForTests(): void {
  cachedPath = '';
  cachedRuns = null;
  cachedHeadHash = GENESIS_HASH;
  cachedEventCount = 0;
  mutationTail = Promise.resolve();
}

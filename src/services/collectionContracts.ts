import type {
  OmniConnection,
  OmniDocument,
  OmniModel,
  OmniSchedule,
  OmniUpload,
  PageInfo,
} from '@/types';

type JsonRecord = Record<string, unknown>;

export interface ConnectionRefreshSchedule {
  scheduleId: string;
  connectionId: string;
  schedule: string;
  timezone: string;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
  disabledAt?: string | null;
}

export interface ConnectionDbtConfiguration {
  state: 'configured';
  supportsDbt: true;
  autogenRelationships: boolean;
  branch: string;
  dbtVersion: string;
  enableSemanticLayer: boolean;
  enableVirtualSchemas: boolean;
  projectRootPath: string | null;
  sshUrl: string;
}

export interface ConnectionDbtNotConfigured {
  state: 'not_configured';
  supportsDbt?: true;
}

export interface ConnectionDbtNotSupported {
  state: 'not_supported';
  supportsDbt: false;
}

export type ConnectionDbtEvidence = ConnectionDbtConfiguration | ConnectionDbtNotConfigured | ConnectionDbtNotSupported;

export interface VerifiedPage<T> {
  records: T[];
  pageInfo: PageInfo;
}

export interface UploadPaginationContext {
  pageNumber: number;
  previouslyLoaded: number;
  previousRecordIds: readonly string[];
  previousCursors: readonly string[];
  expectedTotalRecords?: number;
  currentCursor?: string;
}

export interface VerifiedUploadPage extends VerifiedPage<OmniUpload> {
  cumulativeLoaded: number;
  cumulativeRecordIds: string[];
  cursorHistory: string[];
}

export interface SchedulePaginationContext {
  pageNumber: number;
  expectedPageSize: number;
  expectedTotalRecords?: number;
}

export interface ScheduleMutationRefreshPlan {
  pageNumber: 1;
  clearPaginationEvidence: true;
}

export function planScheduleMutationRefresh(currentPage: number): ScheduleMutationRefreshPlan {
  if (!Number.isSafeInteger(currentPage) || currentPage < 1) {
    throw new CollectionContractError('Schedule evidence');
  }
  return { pageNumber: 1, clearPaginationEvidence: true };
}

export interface VerifiedScheduleDocuments {
  documents: OmniDocument[];
  pageInfo: PageInfo;
  pagesFetched: number;
  loadedResults: number;
  totalResults: number;
}

/**
 * A deliberately generic error for successful HTTP responses whose evidence
 * cannot be reconciled to the documented collection contract. Upstream body
 * text is never copied into the browser-visible message.
 */
export class CollectionContractError extends Error {
  readonly code = 'invalid_collection_response';

  constructor(collectionLabel: string) {
    super(`${collectionLabel} is unavailable because the response could not be verified.`);
    this.name = 'CollectionContractError';
  }
}

export type CollectionReadFailureState = 'unauthorized' | 'unsupported' | 'unavailable' | 'failed';

export interface CollectionReadFailure {
  state: CollectionReadFailureState;
  message: string;
}

function fail(collectionLabel: string): never {
  throw new CollectionContractError(collectionLabel);
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function classifyCollectionReadFailure(error: unknown, collectionLabel: string): CollectionReadFailure {
  const status = isRecord(error) && typeof error.status === 'number' ? error.status : null;
  if (status === 401 || status === 403) {
    return {
      state: 'unauthorized',
      message: `${collectionLabel} is unavailable: the saved credential is unauthorized for this read.`,
    };
  }
  if (status === 404 || status === 405 || status === 501) {
    return {
      state: 'unsupported',
      message: `${collectionLabel} is unavailable: this read is unsupported by the connected instance.`,
    };
  }
  if (status === 0 || status === 408 || status === 429 || (status !== null && status >= 500)) {
    return {
      state: 'unavailable',
      message: `${collectionLabel} is temporarily unavailable.`,
    };
  }
  return {
    state: 'failed',
    message: `${collectionLabel} is unavailable because the response could not be verified.`,
  };
}

function hasTruthyErrorEnvelope(value: JsonRecord): boolean {
  return Object.prototype.hasOwnProperty.call(value, 'error')
    || Object.prototype.hasOwnProperty.call(value, 'errors')
    || value.ok === false
    || value.success === false;
}

function requireEnvelope(value: unknown, collectionLabel: string): JsonRecord {
  if (!isRecord(value) || hasTruthyErrorEnvelope(value)) fail(collectionLabel);
  return value;
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isOptionalString(value: unknown, options: { nullable?: boolean; nonBlank?: boolean } = {}): boolean {
  if (value === undefined || (options.nullable && value === null)) return true;
  return typeof value === 'string' && (!options.nonBlank || value.trim().length > 0);
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

function isOptionalTimestamp(value: unknown, nullable = true): boolean {
  if (value === undefined || (nullable && value === null)) return true;
  return isNonBlankString(value) && Number.isFinite(Date.parse(value));
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function parseArray<T>(
  envelope: JsonRecord,
  key: string,
  collectionLabel: string,
  validate: (record: JsonRecord) => record is JsonRecord & T,
  identity: (record: T) => string,
): T[] {
  const raw = envelope[key];
  if (!Array.isArray(raw)) fail(collectionLabel);

  const records: T[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!isRecord(item) || !validate(item)) fail(collectionLabel);
    const record = item as JsonRecord & T;
    const id = identity(record).trim();
    if (!id || seen.has(id)) fail(collectionLabel);
    seen.add(id);
    records.push(record);
  }
  return records;
}

function parsePageInfoShape(
  value: unknown,
  recordCount: number,
  collectionLabel: string,
): PageInfo {
  if (!isRecord(value)) fail(collectionLabel);
  const hasNextPage = value.hasNextPage;
  const pageSize = value.pageSize;
  const totalRecords = value.totalRecords;
  if (
    typeof hasNextPage !== 'boolean'
    || !Number.isSafeInteger(pageSize)
    || Number(pageSize) < 1
    || Number(pageSize) > 100
    || !isNonNegativeInteger(totalRecords)
    || recordCount > Number(pageSize)
    || recordCount > totalRecords
  ) fail(collectionLabel);

  const nextCursor = value.nextCursor;
  if (hasNextPage) {
    if (!isNonBlankString(nextCursor) || nextCursor !== nextCursor.trim()) fail(collectionLabel);
  } else if (nextCursor !== undefined && nextCursor !== null) {
    fail(collectionLabel);
  }

  return {
    hasNextPage,
    nextCursor: typeof nextCursor === 'string' ? nextCursor : null,
    pageSize: Number(pageSize),
    totalRecords,
  };
}

function parseSchedulePageInfo(
  value: unknown,
  recordCount: number,
  context: SchedulePaginationContext,
  collectionLabel: string,
): PageInfo {
  if (
    !Number.isSafeInteger(context.pageNumber)
    || context.pageNumber < 1
    || !Number.isSafeInteger(context.expectedPageSize)
    || context.expectedPageSize < 1
    || context.expectedPageSize > 100
    || (context.expectedTotalRecords !== undefined && !isNonNegativeInteger(context.expectedTotalRecords))
  ) fail(collectionLabel);
  const pageInfo = parsePageInfoShape(value, recordCount, collectionLabel);
  if (
    pageInfo.pageSize !== context.expectedPageSize
    || (context.expectedTotalRecords !== undefined && pageInfo.totalRecords !== context.expectedTotalRecords)
  ) fail(collectionLabel);
  const offset = (context.pageNumber - 1) * context.expectedPageSize;
  if (offset > pageInfo.totalRecords) fail(collectionLabel);
  const expectedRecords = Math.min(pageInfo.pageSize, pageInfo.totalRecords - offset);
  const expectedHasNextPage = offset + expectedRecords < pageInfo.totalRecords;
  if (pageInfo.totalRecords > 0 && expectedRecords === 0) fail(collectionLabel);
  if (recordCount !== expectedRecords || pageInfo.hasNextPage !== expectedHasNextPage) fail(collectionLabel);
  const rawPageInfo = value as JsonRecord;
  if (expectedHasNextPage) {
    if (rawPageInfo.nextCursor !== String(context.pageNumber + 1)) fail(collectionLabel);
  } else if (rawPageInfo.nextCursor !== null) {
    fail(collectionLabel);
  }
  return pageInfo;
}

function parseUploadPageInfo(
  value: unknown,
  records: OmniUpload[],
  context: UploadPaginationContext,
  collectionLabel: string,
): VerifiedUploadPage {
  if (
    !Number.isSafeInteger(context.pageNumber)
    || context.pageNumber < 1
    || !isNonNegativeInteger(context.previouslyLoaded)
    || !Array.isArray(context.previousRecordIds)
    || context.previousRecordIds.length !== context.previouslyLoaded
    || context.previousRecordIds.some((id) => !isNonBlankString(id) || id !== id.trim())
    || new Set(context.previousRecordIds).size !== context.previousRecordIds.length
    || !Array.isArray(context.previousCursors)
    || context.previousCursors.length !== Math.max(0, context.pageNumber - 2)
    || context.previousCursors.some((cursor) => !isNonBlankString(cursor) || cursor !== cursor.trim())
    || new Set(context.previousCursors).size !== context.previousCursors.length
    || (context.pageNumber === 1 && context.previouslyLoaded !== 0)
    || (context.pageNumber === 1 && context.previousCursors.length !== 0)
    || (context.pageNumber > 1 && context.previouslyLoaded === 0)
    || (context.pageNumber === 1 && context.currentCursor !== undefined)
    || (context.pageNumber > 1 && (!isNonBlankString(context.currentCursor) || context.currentCursor !== context.currentCursor.trim()))
    || (context.currentCursor !== undefined && context.previousCursors.includes(context.currentCursor))
  ) fail(collectionLabel);

  const pageInfo = parsePageInfoShape(value, records.length, collectionLabel);
  if (
    context.expectedTotalRecords !== undefined
    && (!isNonNegativeInteger(context.expectedTotalRecords) || pageInfo.totalRecords !== context.expectedTotalRecords)
  ) fail(collectionLabel);
  if (pageInfo.totalRecords > 0 && records.length === 0) fail(collectionLabel);

  const previousIds = new Set(context.previousRecordIds);
  const recordIds = records.map((record) => record.id.trim());
  if (recordIds.some((recordId) => previousIds.has(recordId))) fail(collectionLabel);
  const cumulativeLoaded = context.previouslyLoaded + records.length;
  if (cumulativeLoaded > pageInfo.totalRecords) fail(collectionLabel);
  if (pageInfo.hasNextPage) {
    if (
      cumulativeLoaded >= pageInfo.totalRecords
      || (pageInfo.nextCursor !== null && (
        pageInfo.nextCursor === context.currentCursor
        || context.previousCursors.includes(pageInfo.nextCursor)
      ))
    ) fail(collectionLabel);
  } else if (cumulativeLoaded !== pageInfo.totalRecords) {
    fail(collectionLabel);
  }

  return {
    records,
    pageInfo,
    cumulativeLoaded,
    cumulativeRecordIds: [...context.previousRecordIds, ...recordIds],
    cursorHistory: [
      ...context.previousCursors,
      ...(context.currentCursor ? [context.currentCursor] : []),
    ],
  };
}

function validConnection(record: JsonRecord): record is JsonRecord & OmniConnection {
  return isNonBlankString(record.id)
    && isNonBlankString(record.name)
    && isNonBlankString(record.dialect)
    && isOptionalString(record.database)
    && isOptionalString(record.defaultSchema)
    && isOptionalString(record.baseRole)
    && isOptionalTimestamp(record.createdAt)
    && isOptionalTimestamp(record.updatedAt)
    && isOptionalTimestamp(record.deletedAt);
}

function validModel(record: JsonRecord): record is JsonRecord & OmniModel {
  return isNonBlankString(record.id)
    && isNonBlankString(record.name)
    && isOptionalString(record.identifier)
    && isOptionalString(record.connectionId, { nonBlank: true })
    && isOptionalString(record.connectionName)
    && isOptionalString(record.baseModelId, { nonBlank: true })
    && isOptionalString(record.kind)
    && isOptionalBoolean(record.gitConfigured)
    && isOptionalBoolean(record.pullRequestRequired)
    && isOptionalBoolean(record.gitProtected)
    && isOptionalBoolean(record.gitFollower)
    && isOptionalTimestamp(record.createdAt)
    && isOptionalTimestamp(record.updatedAt)
    && isOptionalTimestamp(record.deletedAt);
}

function validRefreshSchedule(record: JsonRecord): record is JsonRecord & ConnectionRefreshSchedule {
  return isNonBlankString(record.scheduleId)
    && isNonBlankString(record.connectionId)
    && isNonBlankString(record.schedule)
    && isNonBlankString(record.timezone)
    && isOptionalString(record.description)
    && isOptionalTimestamp(record.createdAt)
    && isOptionalTimestamp(record.updatedAt)
    && isOptionalTimestamp(record.disabledAt);
}

function validSchedule(record: JsonRecord): record is JsonRecord & OmniSchedule {
  return isNonBlankString(record.id)
    && isNonBlankString(record.name)
    && isNonBlankString(record.schedule)
    && isNonBlankString(record.timezone)
    && isNonBlankString(record.identifier)
    && isNonBlankString(record.dashboardName)
    && isNonBlankString(record.ownerId)
    && isNonBlankString(record.ownerName)
    && isOptionalTimestamp(record.lastCompletedAt)
    && isOptionalString(record.lastStatus, { nullable: true })
    && isNonBlankString(record.destinationType)
    && isNonBlankString(record.format)
    && isNonNegativeInteger(record.recipientCount)
    && typeof record.content === 'string'
    && isOptionalTimestamp(record.disabledAt)
    && isOptionalTimestamp(record.systemDisabledAt)
    && isOptionalString(record.systemDisabledReason, { nullable: true })
    && isOptionalString(record.alert, { nullable: true });
}

function validUpload(record: JsonRecord): record is JsonRecord & OmniUpload {
  const uploadedBy = record.uploaded_by_user;
  const validUploader = uploadedBy === undefined
    || uploadedBy === null
    || (isRecord(uploadedBy) && isNonBlankString(uploadedBy.id) && isNonBlankString(uploadedBy.name));
  return isNonBlankString(record.id)
    && isNonBlankString(record.file_name)
    && typeof record.view_name === 'string'
    && typeof record.connection_id === 'string'
    && isOptionalString(record.in_db_as_table_name, { nullable: true })
    && isOptionalString(record.model_id, { nullable: true, nonBlank: true })
    && (record.size_bytes === undefined || record.size_bytes === null || isNonNegativeInteger(record.size_bytes))
    && isNonBlankString(record.created_at)
    && Number.isFinite(Date.parse(record.created_at))
    && isNonBlankString(record.updated_at)
    && Number.isFinite(Date.parse(record.updated_at))
    && validUploader;
}

function validDocument(record: JsonRecord): record is JsonRecord & OmniDocument {
  return isNonBlankString(record.id)
    && isNonBlankString(record.name)
    && isOptionalString(record.identifier, { nonBlank: true })
    && isOptionalString(record.baseModelId, { nonBlank: true })
    && isOptionalString(record.baseModelName)
    && isOptionalString(record.folderPath)
    && isOptionalString(record.folderId, { nonBlank: true })
    && isOptionalString(record.type);
}

export function parseConnectionsCollection(value: unknown): OmniConnection[] {
  const envelope = requireEnvelope(value, 'Connection inventory');
  return parseArray(envelope, 'connections', 'Connection inventory', validConnection, (record) => record.id);
}

export function parseSchemaModelsCollection(value: unknown): OmniModel[] {
  const collectionLabel = 'Schema model evidence';
  const envelope = requireEnvelope(value, collectionLabel);
  const models = parseArray(envelope, 'models', collectionLabel, validModel, (record) => record.id);
  if (models.some((model) => model.kind !== 'SCHEMA' || !isNonBlankString(model.connectionId))) {
    fail(collectionLabel);
  }
  const pagesFetched = envelope.pagesFetched;
  const loadedResults = envelope.loadedResults;
  const totalResults = envelope.totalResults;
  if (
    envelope.complete !== true
    || !Number.isSafeInteger(pagesFetched)
    || Number(pagesFetched) < 1
    || !isNonNegativeInteger(loadedResults)
    || !isNonNegativeInteger(totalResults)
    || loadedResults !== totalResults
    || models.length !== loadedResults
    || !isRecord(envelope.pageInfo)
  ) fail(collectionLabel);

  const pageInfo = envelope.pageInfo;
  if (
    pageInfo.hasNextPage !== false
    || !Number.isSafeInteger(pageInfo.pageSize)
    || Number(pageInfo.pageSize) < 1
    || Number(pageInfo.pageSize) > 100
    || pageInfo.totalRecords !== totalResults
    || (pageInfo.nextCursor !== undefined && pageInfo.nextCursor !== null)
  ) fail(collectionLabel);

  const minimumPages = Math.max(1, Math.ceil(totalResults / Number(pageInfo.pageSize)));
  const maximumPages = Math.max(1, totalResults);
  if (Number(pagesFetched) < minimumPages || Number(pagesFetched) > maximumPages) fail(collectionLabel);
  return models;
}

export function parseConnectionDbtConfig(value: unknown): ConnectionDbtEvidence {
  const collectionLabel = 'dbt configuration evidence';
  const envelope = requireEnvelope(value, collectionLabel);
  const configurationFields = [
    'autogenRelationships',
    'branch',
    'dbtVersion',
    'enableSemanticLayer',
    'enableVirtualSchemas',
    'projectRootPath',
    'sshUrl',
  ];

  if (Object.prototype.hasOwnProperty.call(envelope, 'message')) {
    if (
      envelope.message !== 'dbt not configured for this connection'
      || (envelope.supportsDbt !== undefined && typeof envelope.supportsDbt !== 'boolean')
      || configurationFields.some((field) => Object.prototype.hasOwnProperty.call(envelope, field))
    ) fail(collectionLabel);
    return envelope.supportsDbt === false
      ? { state: 'not_supported', supportsDbt: false }
      : {
          state: 'not_configured',
          ...(envelope.supportsDbt === true ? { supportsDbt: true as const } : {}),
        };
  }

  if (
    typeof envelope.supportsDbt !== 'boolean'
    || typeof envelope.autogenRelationships !== 'boolean'
    || !isNonBlankString(envelope.branch)
    || !isNonBlankString(envelope.dbtVersion)
    || typeof envelope.enableSemanticLayer !== 'boolean'
    || typeof envelope.enableVirtualSchemas !== 'boolean'
    || !(envelope.projectRootPath === null || typeof envelope.projectRootPath === 'string')
    || !isNonBlankString(envelope.sshUrl)
  ) fail(collectionLabel);

  if (envelope.supportsDbt === false) {
    return { state: 'not_supported', supportsDbt: false };
  }

  return {
    state: 'configured',
    supportsDbt: true,
    autogenRelationships: envelope.autogenRelationships,
    branch: envelope.branch.trim(),
    dbtVersion: envelope.dbtVersion.trim(),
    enableSemanticLayer: envelope.enableSemanticLayer,
    enableVirtualSchemas: envelope.enableVirtualSchemas,
    projectRootPath: envelope.projectRootPath,
    sshUrl: envelope.sshUrl.trim(),
  };
}

export function parseConnectionRefreshSchedules(
  value: unknown,
  expectedConnectionId: string,
): ConnectionRefreshSchedule[] {
  const envelope = requireEnvelope(value, 'Refresh schedule evidence');
  const schedules = parseArray(
    envelope,
    'schedules',
    'Refresh schedule evidence',
    validRefreshSchedule,
    (record) => record.scheduleId,
  );
  if (schedules.some((schedule) => schedule.connectionId !== expectedConnectionId)) {
    fail('Refresh schedule evidence');
  }
  return schedules;
}

export function parseSchedulesCollection(value: unknown, context: SchedulePaginationContext): VerifiedPage<OmniSchedule> {
  const collectionLabel = 'Schedule evidence';
  const envelope = requireEnvelope(value, collectionLabel);
  const records = parseArray(envelope, 'records', collectionLabel, validSchedule, (record) => record.id);
  const pageInfo = parseSchedulePageInfo(envelope.pageInfo, records.length, context, collectionLabel);
  return { records, pageInfo };
}

export function parseUploadsCollection(value: unknown, context: UploadPaginationContext): VerifiedUploadPage {
  const collectionLabel = 'Upload inventory';
  const envelope = requireEnvelope(value, collectionLabel);
  const records = parseArray(envelope, 'records', collectionLabel, validUpload, (record) => record.id);
  return parseUploadPageInfo(envelope.pageInfo, records, context, collectionLabel);
}

export function parseScheduleDocumentsCollection(value: unknown): VerifiedScheduleDocuments {
  const collectionLabel = 'Dashboard inventory';
  const envelope = requireEnvelope(value, collectionLabel);
  const documents = parseArray(envelope, 'documents', collectionLabel, validDocument, (record) => record.id);
  const pagesFetched = envelope.pagesFetched;
  const loadedResults = envelope.loadedResults;
  const totalResults = envelope.totalResults;
  if (
    envelope.complete !== true
    || !Number.isSafeInteger(pagesFetched)
    || Number(pagesFetched) < 1
    || !isNonNegativeInteger(loadedResults)
    || !isNonNegativeInteger(totalResults)
    || loadedResults !== totalResults
    || documents.length > loadedResults
    || !isRecord(envelope.pageInfo)
  ) fail(collectionLabel);

  const pageInfo = envelope.pageInfo;
  if (
    pageInfo.hasNextPage !== false
    || !Number.isSafeInteger(pageInfo.pageSize)
    || Number(pageInfo.pageSize) < 1
    || Number(pageInfo.pageSize) > 100
    || pageInfo.totalRecords !== totalResults
    || (pageInfo.nextCursor !== undefined && pageInfo.nextCursor !== null)
  ) fail(collectionLabel);

  const minimumPages = Math.max(1, Math.ceil(totalResults / Number(pageInfo.pageSize)));
  const maximumPages = Math.max(1, loadedResults);
  if (Number(pagesFetched) < minimumPages || Number(pagesFetched) > maximumPages) fail(collectionLabel);

  return {
    documents,
    pageInfo: {
      hasNextPage: false,
      nextCursor: null,
      pageSize: Number(pageInfo.pageSize),
      totalRecords: totalResults,
    },
    pagesFetched: Number(pagesFetched),
    loadedResults,
    totalResults,
  };
}

const MAX_CONTENT_DEPTH = 24;
const MAX_CONTENT_NODES = 50_000;
const MAX_CONTENT_STRING_CHARACTERS = 2_000_000;
const MAX_SINGLE_STRING_CHARACTERS = 64_000;
const MAX_OBJECT_KEYS = 5_000;
const MAX_ARRAY_LENGTH = 5_000;
const MAX_QUERY_PRESENTATIONS = 1_000;
const MAX_LAYOUT_CONTAINERS = 1_000;
const MAX_DOCUMENT_NAME_CHARACTERS = 254;
const MAX_DOCUMENT_DESCRIPTION_CHARACTERS = 64_000;
const MAX_KEY_CHARACTERS = 256;
const MAX_PRESENTATION_NAME_CHARACTERS = 144;
const MAX_PRESENTATION_SUBTITLE_CHARACTERS = 250;
const MAX_PRESENTATION_DESCRIPTION_CHARACTERS = 500;
const MAX_PRESENTATION_MODEL_OBJECT_CHARACTERS = 500;
const MAX_PRESENTATION_TOPIC_NAME_CHARACTERS = 500;
const MAX_PRESENTATION_FILTER_NAME_CHARACTERS = 1_000;

const QUERY_PRESENTATION_KEY = /^[1-9][0-9]*$/;
const TOP_LEVEL_KEYS = new Set([
  'name',
  'description',
  'queryPresentations',
  'controls',
  'settings',
  'containers',
]);
const QUERY_PRESENTATION_ENVELOPE_KEYS = new Set(['data', 'order']);
const QUERY_PRESENTATION_KEYS = new Set([
  'type',
  'name',
  'subTitle',
  'description',
  'topicName',
  'isSql',
  'prefersChart',
  'automaticVis',
  'filterOrder',
  'editingModelObjectName',
  'editingModelObjectNameChange',
  'query',
  'visConfig',
  'resultConfig',
  'aiConfig',
  'sourceQueryPresentationKey',
  'model_extension_id',
]);
const QUERY_PRESENTATION_TYPES = new Set([
  'blank',
  'csv',
  'query',
  'dataset',
  'spreadsheet',
  'sql',
  'dbt',
  'query-view',
  'linked',
  'app',
]);
const FORBIDDEN_METADATA_TOKENS = new Set([
  'access',
  'acl',
  'grant',
  'grants',
  'permission',
  'permissions',
  'ability',
  'abilities',
  'security',
  'secure',
  'share',
  'shared',
  'sharing',
  'owner',
  'owners',
  'ownership',
  'creator',
  'principal',
  'principals',
  'schedule',
  'schedules',
  'scheduled',
  'subscription',
  'subscriptions',
  'subscriber',
  'subscribers',
  'alert',
  'alerts',
  'action',
  'actions',
  'webhook',
  'webhooks',
  'cron',
]);
const FORBIDDEN_COMPACT_FRAGMENTS = [
  'access',
  'permission',
  'security',
  'sharing',
  'owner',
  'schedule',
  'subscription',
  'subscriber',
  'alert',
  'createdby',
  'updatedby',
  'publiclink',
  'collaborator',
  'webhook',
] as const;
const PROTOTYPE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export type DashboardSafeCopyJsonScalar = string | number | boolean | null;
export type DashboardSafeCopyJsonValue =
  | DashboardSafeCopyJsonScalar
  | DashboardSafeCopyJsonValue[]
  | { [key: string]: DashboardSafeCopyJsonValue };
export type DashboardSafeCopyJsonRecord = { [key: string]: DashboardSafeCopyJsonValue };
export type DashboardSafeCopyJsonContainer = DashboardSafeCopyJsonRecord | DashboardSafeCopyJsonValue[];

export interface DashboardSafeCopyQueryPresentation {
  type?: string;
  name?: string;
  subTitle?: string | null;
  description?: string | null;
  topicName?: string | null;
  isSql?: boolean | null;
  prefersChart?: boolean;
  automaticVis?: boolean | null;
  filterOrder?: string[];
  editingModelObjectName?: string | null;
  editingModelObjectNameChange?: string | null;
  query?: DashboardSafeCopyJsonRecord | null;
  visConfig?: DashboardSafeCopyJsonRecord | null;
  resultConfig?: DashboardSafeCopyJsonRecord;
  aiConfig?: DashboardSafeCopyJsonRecord | null;
  sourceQueryPresentationKey?: string | null;
}

export interface DashboardSafeCopyQueryPresentations {
  data: Record<string, DashboardSafeCopyQueryPresentation>;
  order: string[];
}

export interface DashboardSafeCopyDocumentContent {
  name: string;
  description?: string | null;
  queryPresentations: DashboardSafeCopyQueryPresentations;
  controls?: DashboardSafeCopyJsonContainer;
  settings?: DashboardSafeCopyJsonRecord;
  containers: DashboardSafeCopyJsonRecord[];
}

export type DashboardSafeCopyContentErrorCode =
  | 'SAFE_COPY_CONTENT_INVALID_ROOT'
  | 'SAFE_COPY_CONTENT_UNKNOWN_FIELD'
  | 'SAFE_COPY_CONTENT_INVALID_DOCUMENT'
  | 'SAFE_COPY_CONTENT_INVALID_PRESENTATIONS'
  | 'SAFE_COPY_CONTENT_FORBIDDEN_METADATA'
  | 'SAFE_COPY_CONTENT_LIMIT_EXCEEDED'
  | 'SAFE_COPY_CONTENT_UNSUPPORTED_VALUE';

const ERROR_MESSAGES: Record<DashboardSafeCopyContentErrorCode, string> = {
  SAFE_COPY_CONTENT_INVALID_ROOT: 'Safe-copy document content must be a plain JSON object.',
  SAFE_COPY_CONTENT_UNKNOWN_FIELD: 'Safe-copy document content contains a field outside the supported content schema.',
  SAFE_COPY_CONTENT_INVALID_DOCUMENT: 'Safe-copy document content is missing a required bounded document field.',
  SAFE_COPY_CONTENT_INVALID_PRESENTATIONS: 'Safe-copy query presentation content does not match the supported Documents V2 shape.',
  SAFE_COPY_CONTENT_FORBIDDEN_METADATA: 'Safe-copy document content contains access, security, ownership, sharing, or automation metadata.',
  SAFE_COPY_CONTENT_LIMIT_EXCEEDED: 'Safe-copy document content exceeds a bounded size or complexity limit.',
  SAFE_COPY_CONTENT_UNSUPPORTED_VALUE: 'Safe-copy document content contains a value that is not supported JSON.',
};

/**
 * Fixed, non-reflective error surface. It deliberately omits the rejected key,
 * value, path, payload, and parser cause so callers can persist the code/message
 * without leaking source document content.
 */
export class DashboardSafeCopyContentError extends Error {
  readonly code: DashboardSafeCopyContentErrorCode;
  readonly statusCode = 422;

  constructor(code: DashboardSafeCopyContentErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'DashboardSafeCopyContentError';
    this.code = code;
  }
}

interface CloneState {
  nodes: number;
  stringCharacters: number;
  ancestors: WeakSet<object>;
}

function fail(code: DashboardSafeCopyContentErrorCode): never {
  throw new DashboardSafeCopyContentError(code);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function recordEntries(value: Record<string, unknown>): Array<[string, unknown]> {
  if (Object.getOwnPropertySymbols(value).length > 0) fail('SAFE_COPY_CONTENT_UNSUPPORTED_VALUE');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(value);
  if (keys.length > MAX_OBJECT_KEYS) fail('SAFE_COPY_CONTENT_LIMIT_EXCEEDED');
  return keys.map((key) => {
    const descriptor = descriptors[key];
    if (!descriptor || !('value' in descriptor)) fail('SAFE_COPY_CONTENT_UNSUPPORTED_VALUE');
    return [key, descriptor.value];
  });
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  if (recordEntries(value).some(([key]) => !allowed.has(key))) {
    fail('SAFE_COPY_CONTENT_UNKNOWN_FIELD');
  }
}

function keyTokens(key: string): string[] {
  const segmented = key
    .normalize('NFKC')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return segmented;
}

function assertSafeNestedKey(key: string): void {
  if (!key || key.length > MAX_KEY_CHARACTERS) fail('SAFE_COPY_CONTENT_LIMIT_EXCEEDED');
  if (PROTOTYPE_KEYS.has(key)) fail('SAFE_COPY_CONTENT_FORBIDDEN_METADATA');
  const tokens = keyTokens(key);
  const compact = tokens.join('');
  if (
    tokens.some((token) => FORBIDDEN_METADATA_TOKENS.has(token))
    || FORBIDDEN_COMPACT_FRAGMENTS.some((fragment) => (
      compact.includes(fragment)
      && !(fragment === 'access' && compact.includes('accessibility'))
    ))
    || (
      compact.includes('action')
      && !compact.includes('transaction')
      && !compact.includes('interaction')
    )
    || tokens.some((token, index) => token === 'created' && tokens[index + 1] === 'by')
    || tokens.some((token, index) => token === 'updated' && tokens[index + 1] === 'by')
  ) {
    fail('SAFE_COPY_CONTENT_FORBIDDEN_METADATA');
  }
}

function addNode(state: CloneState, depth: number): void {
  state.nodes += 1;
  if (depth > MAX_CONTENT_DEPTH || state.nodes > MAX_CONTENT_NODES) {
    fail('SAFE_COPY_CONTENT_LIMIT_EXCEEDED');
  }
}

function boundedString(
  value: unknown,
  state: CloneState,
  maximum = MAX_SINGLE_STRING_CHARACTERS,
  allowEmpty = true,
): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) {
    fail('SAFE_COPY_CONTENT_INVALID_DOCUMENT');
  }
  if (value.length > maximum) fail('SAFE_COPY_CONTENT_LIMIT_EXCEEDED');
  state.stringCharacters += value.length;
  if (state.stringCharacters > MAX_CONTENT_STRING_CHARACTERS) {
    fail('SAFE_COPY_CONTENT_LIMIT_EXCEEDED');
  }
  return value;
}

function cloneSafeJson(
  value: unknown,
  state: CloneState,
  depth = 0,
): DashboardSafeCopyJsonValue {
  addNode(state, depth);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return boundedString(value, state);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('SAFE_COPY_CONTENT_UNSUPPORTED_VALUE');
    return value;
  }
  if (!value || typeof value !== 'object') fail('SAFE_COPY_CONTENT_UNSUPPORTED_VALUE');
  if (state.ancestors.has(value)) fail('SAFE_COPY_CONTENT_UNSUPPORTED_VALUE');
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_ARRAY_LENGTH) fail('SAFE_COPY_CONTENT_LIMIT_EXCEEDED');
      const cloned: DashboardSafeCopyJsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          fail('SAFE_COPY_CONTENT_UNSUPPORTED_VALUE');
        }
        cloned.push(cloneSafeJson(value[index], state, depth + 1));
      }
      return cloned;
    }
    if (!isPlainRecord(value)) fail('SAFE_COPY_CONTENT_UNSUPPORTED_VALUE');
    const entries = recordEntries(value);
    const cloned: Record<string, DashboardSafeCopyJsonValue> = {};
    for (const [key, child] of entries) {
      assertSafeNestedKey(key);
      cloned[key] = cloneSafeJson(child, state, depth + 1);
    }
    return cloned;
  } finally {
    state.ancestors.delete(value);
  }
}

function optionalText(
  value: unknown,
  state: CloneState,
  maximum: number,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return boundedString(value, state, maximum);
}

function presentationString(
  value: unknown,
  state: CloneState,
  maximum = MAX_SINGLE_STRING_CHARACTERS,
  allowEmpty = true,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') fail('SAFE_COPY_CONTENT_INVALID_PRESENTATIONS');
  if (!allowEmpty && !value.trim()) fail('SAFE_COPY_CONTENT_INVALID_PRESENTATIONS');
  return boundedString(value, state, maximum);
}

function optionalPresentationText(
  value: unknown,
  state: CloneState,
  maximum: number,
): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string') fail('SAFE_COPY_CONTENT_INVALID_PRESENTATIONS');
  return boundedString(value, state, maximum);
}

function optionalPresentationBoolean(value: unknown, allowNull: true): boolean | null | undefined;
function optionalPresentationBoolean(value: unknown, allowNull: false): boolean | undefined;
function optionalPresentationBoolean(
  value: unknown,
  allowNull: boolean,
): boolean | null | undefined {
  if (value === undefined) return undefined;
  if (value === null && allowNull) return null;
  if (typeof value !== 'boolean') fail('SAFE_COPY_CONTENT_INVALID_PRESENTATIONS');
  return value;
}

function optionalPresentationRecord(
  value: unknown,
  state: CloneState,
  allowNull: true,
): DashboardSafeCopyJsonRecord | null | undefined;
function optionalPresentationRecord(
  value: unknown,
  state: CloneState,
  allowNull: false,
): DashboardSafeCopyJsonRecord | undefined;
function optionalPresentationRecord(
  value: unknown,
  state: CloneState,
  allowNull: boolean,
): DashboardSafeCopyJsonRecord | null | undefined {
  if (value === undefined) return undefined;
  if (value === null && allowNull) return null;
  if (!isPlainRecord(value)) fail('SAFE_COPY_CONTENT_INVALID_PRESENTATIONS');
  return cloneSafeJson(value, state, 3) as DashboardSafeCopyJsonRecord;
}

function optionalPresentationStringList(
  value: unknown,
  state: CloneState,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) fail('SAFE_COPY_CONTENT_INVALID_PRESENTATIONS');
  if (value.length > MAX_ARRAY_LENGTH) fail('SAFE_COPY_CONTENT_LIMIT_EXCEEDED');
  addNode(state, 3);
  return value.map((item) => {
    addNode(state, 4);
    if (typeof item !== 'string' || !item.trim()) fail('SAFE_COPY_CONTENT_INVALID_PRESENTATIONS');
    return boundedString(item, state, MAX_PRESENTATION_FILTER_NAME_CHARACTERS);
  });
}

function materializePresentation(
  value: unknown,
  state: CloneState,
): DashboardSafeCopyQueryPresentation {
  addNode(state, 2);
  if (!isPlainRecord(value)) fail('SAFE_COPY_CONTENT_INVALID_PRESENTATIONS');
  assertOnlyKeys(value, QUERY_PRESENTATION_KEYS);
  const type = presentationString(value.type, state, 32);
  if (type && !QUERY_PRESENTATION_TYPES.has(type)) {
    fail('SAFE_COPY_CONTENT_INVALID_PRESENTATIONS');
  }
  const name = presentationString(value.name, state, MAX_PRESENTATION_NAME_CHARACTERS, false);
  const subTitle = optionalPresentationText(value.subTitle, state, MAX_PRESENTATION_SUBTITLE_CHARACTERS);
  const description = optionalPresentationText(value.description, state, MAX_PRESENTATION_DESCRIPTION_CHARACTERS);
  const topicName = optionalPresentationText(value.topicName, state, MAX_PRESENTATION_TOPIC_NAME_CHARACTERS);
  const isSql = optionalPresentationBoolean(value.isSql, true);
  const prefersChart = optionalPresentationBoolean(value.prefersChart, false);
  const automaticVis = optionalPresentationBoolean(value.automaticVis, true);
  const filterOrder = optionalPresentationStringList(value.filterOrder, state);
  const editingModelObjectName = optionalPresentationText(
    value.editingModelObjectName,
    state,
    MAX_PRESENTATION_MODEL_OBJECT_CHARACTERS,
  );
  const editingModelObjectNameChange = optionalPresentationText(
    value.editingModelObjectNameChange,
    state,
    MAX_PRESENTATION_MODEL_OBJECT_CHARACTERS,
  );
  const sourceQueryPresentationKey = optionalPresentationText(value.sourceQueryPresentationKey, state, 128);
  if (type === 'linked') {
    if (
      typeof sourceQueryPresentationKey !== 'string'
      || !QUERY_PRESENTATION_KEY.test(sourceQueryPresentationKey)
    ) {
      fail('SAFE_COPY_CONTENT_INVALID_PRESENTATIONS');
    }
  } else if (sourceQueryPresentationKey !== undefined && sourceQueryPresentationKey !== null) {
    fail('SAFE_COPY_CONTENT_INVALID_PRESENTATIONS');
  }
  const query = optionalPresentationRecord(value.query, state, true);
  const visConfig = optionalPresentationRecord(value.visConfig, state, true);
  const resultConfig = optionalPresentationRecord(value.resultConfig, state, false);
  const aiConfig = optionalPresentationRecord(value.aiConfig, state, true);
  // Documents V2 can return this server-managed identifier. Validate the
  // source value so malformed state fails closed, but never propagate it to a
  // new destination document where Omni must assign the authoritative value.
  optionalPresentationText(value.model_extension_id, state, MAX_SINGLE_STRING_CHARACTERS);
  return {
    ...(type ? { type } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(subTitle !== undefined ? { subTitle } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(topicName !== undefined ? { topicName } : {}),
    ...(isSql !== undefined ? { isSql } : {}),
    ...(prefersChart !== undefined ? { prefersChart } : {}),
    ...(automaticVis !== undefined ? { automaticVis } : {}),
    ...(filterOrder !== undefined ? { filterOrder } : {}),
    ...(editingModelObjectName !== undefined ? { editingModelObjectName } : {}),
    ...(editingModelObjectNameChange !== undefined ? { editingModelObjectNameChange } : {}),
    ...(query !== undefined ? { query } : {}),
    ...(visConfig !== undefined ? { visConfig } : {}),
    ...(resultConfig !== undefined ? { resultConfig } : {}),
    ...(aiConfig !== undefined ? { aiConfig } : {}),
    ...(sourceQueryPresentationKey !== undefined ? { sourceQueryPresentationKey } : {}),
  };
}

function materializePresentations(
  value: unknown,
  state: CloneState,
): DashboardSafeCopyQueryPresentations {
  addNode(state, 1);
  if (!isPlainRecord(value)) fail('SAFE_COPY_CONTENT_INVALID_PRESENTATIONS');
  assertOnlyKeys(value, QUERY_PRESENTATION_ENVELOPE_KEYS);
  if (!isPlainRecord(value.data) || !Array.isArray(value.order)) {
    fail('SAFE_COPY_CONTENT_INVALID_PRESENTATIONS');
  }
  const dataEntries = recordEntries(value.data);
  if (dataEntries.length > MAX_QUERY_PRESENTATIONS || value.order.length > MAX_QUERY_PRESENTATIONS) {
    fail('SAFE_COPY_CONTENT_LIMIT_EXCEEDED');
  }
  const data: Record<string, DashboardSafeCopyQueryPresentation> = {};
  for (const [key, presentation] of dataEntries) {
    if (!QUERY_PRESENTATION_KEY.test(key)) fail('SAFE_COPY_CONTENT_INVALID_PRESENTATIONS');
    data[key] = materializePresentation(presentation, state);
  }
  const order = value.order.map((key) => {
    if (typeof key !== 'string' || !QUERY_PRESENTATION_KEY.test(key)) {
      fail('SAFE_COPY_CONTENT_INVALID_PRESENTATIONS');
    }
    return boundedString(key, state, 128);
  });
  if (
    new Set(order).size !== order.length
    || order.length !== dataEntries.length
    || Object.keys(data).some((key) => !order.includes(key))
  ) {
    fail('SAFE_COPY_CONTENT_INVALID_PRESENTATIONS');
  }
  for (const presentation of Object.values(data)) {
    if (
      presentation.type === 'linked'
      && presentation.sourceQueryPresentationKey
      && !data[presentation.sourceQueryPresentationKey]
    ) {
      fail('SAFE_COPY_CONTENT_INVALID_PRESENTATIONS');
    }
  }
  return { data, order };
}

function cloneOptionalContentSlot(
  value: unknown,
  state: CloneState,
  recordOnly = false,
): DashboardSafeCopyJsonContainer | undefined {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value) && (recordOnly || !Array.isArray(value))) {
    fail('SAFE_COPY_CONTENT_INVALID_DOCUMENT');
  }
  return cloneSafeJson(value, state, 1) as DashboardSafeCopyJsonContainer;
}

/**
 * Materializes only the Documents V2 fields needed to create dashboard content.
 * Model, folder, identifier, branch, owner, access, sharing, scheduling, and
 * other governance inputs must be supplied or governed separately by the
 * destination adapter; they are not accepted or returned here.
 */
function materializeDocumentContent(
  value: unknown,
): DashboardSafeCopyDocumentContent {
  if (!isPlainRecord(value)) fail('SAFE_COPY_CONTENT_INVALID_ROOT');
  assertOnlyKeys(value, TOP_LEVEL_KEYS);
  const state: CloneState = {
    nodes: 0,
    stringCharacters: 0,
    ancestors: new WeakSet(),
  };
  addNode(state, 0);
  const name = boundedString(value.name, state, MAX_DOCUMENT_NAME_CHARACTERS, false).trim();
  const description = optionalText(value.description, state, MAX_DOCUMENT_DESCRIPTION_CHARACTERS);
  const queryPresentations = materializePresentations(value.queryPresentations, state);
  const controls = cloneOptionalContentSlot(value.controls, state);
  const settings = cloneOptionalContentSlot(value.settings, state, true) as DashboardSafeCopyJsonRecord | undefined;
  if (!Array.isArray(value.containers)) fail('SAFE_COPY_CONTENT_INVALID_DOCUMENT');
  if (value.containers.length > MAX_LAYOUT_CONTAINERS) fail('SAFE_COPY_CONTENT_LIMIT_EXCEEDED');
  if (value.containers.some((container) => !isPlainRecord(container))) {
    fail('SAFE_COPY_CONTENT_INVALID_DOCUMENT');
  }
  const containers = cloneSafeJson(value.containers, state, 1) as DashboardSafeCopyJsonRecord[];
  return {
    name,
    ...(description !== undefined ? { description } : {}),
    queryPresentations,
    ...(controls !== undefined ? { controls } : {}),
    ...(settings !== undefined ? { settings } : {}),
    containers,
  };
}

export function materializeDashboardSafeCopyDocumentContent(
  value: unknown,
): DashboardSafeCopyDocumentContent {
  try {
    return materializeDocumentContent(value);
  } catch (error) {
    if (error instanceof DashboardSafeCopyContentError) throw error;
    throw new DashboardSafeCopyContentError('SAFE_COPY_CONTENT_UNSUPPORTED_VALUE');
  }
}

export function isDashboardSafeCopyContentError(
  error: unknown,
): error is DashboardSafeCopyContentError {
  return error instanceof DashboardSafeCopyContentError;
}

/** Boolean validation seam for dependency-injected writers. */
export function isDashboardSafeCopyDocumentContent(
  value: unknown,
): value is DashboardSafeCopyDocumentContent {
  try {
    materializeDashboardSafeCopyDocumentContent(value);
    return true;
  } catch {
    return false;
  }
}

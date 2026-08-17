import { createHash } from 'node:crypto';

import {
  materializeDashboardSafeCopyDocumentContent,
  type DashboardSafeCopyDocumentContent,
  type DashboardSafeCopyJsonRecord,
  type DashboardSafeCopyJsonValue,
} from './dashboardSafeCopyContent';

const MAX_QUERY_COUNT = 1_000;
const MAX_QUERY_DEPTH = 24;
const MAX_QUERY_NODES = 50_000;
const MAX_QUERY_ID_CHARACTERS = 128;
const MAX_EXECUTION_JOB_ID_CHARACTERS = 1_024;
const QUERY_PRESENTATION_KEY = /^[1-9][0-9]*$/;
const SHA_256 = /^[a-f0-9]{64}$/;
const QUERY_REQUIRED_PRESENTATION_TYPES = new Set([
  'query',
  'dataset',
  'sql',
  'dbt',
  'query-view',
]);
const NON_EXECUTABLE_PRESENTATION_TYPES = new Set(['blank', 'linked', 'app']);
const QUERY_REFERENCE_KEYS = new Set([
  'querypresentationkey',
  'querypresentationkeys',
  'querypresentationid',
  'querypresentationids',
  'sourcequerypresentationkey',
  'sourcequerypresentationid',
  'targetquerypresentationkey',
  'targetquerypresentationid',
]);
const SUCCESS_STATUSES = new Set(['COMPLETE', 'COMPLETED', 'SUCCESS', 'SUCCEEDED', 'DONE']);
const EXECUTION_EVIDENCE_KEYS = new Set(['queryId', 'queryHash', 'summary']);
const EXECUTION_SUMMARY_KEYS = new Set(['jobId', 'status', 'rowCount']);

export type DashboardSafeCopyQueryProofErrorCode =
  | 'SAFE_COPY_QUERY_CONTENT_INVALID'
  | 'SAFE_COPY_QUERY_STRUCTURE_MISSING'
  | 'SAFE_COPY_QUERY_STRUCTURE_INVALID'
  | 'SAFE_COPY_QUERY_STRUCTURE_DUPLICATE'
  | 'SAFE_COPY_QUERY_BEARING_SHAPE_UNKNOWN'
  | 'SAFE_COPY_QUERY_SET_INVALID'
  | 'SAFE_COPY_QUERY_SET_MISMATCH'
  | 'SAFE_COPY_QUERY_EXECUTION_EVIDENCE_INVALID'
  | 'SAFE_COPY_QUERY_EXECUTION_FAILED';

const ERROR_MESSAGES: Record<DashboardSafeCopyQueryProofErrorCode, string> = {
  SAFE_COPY_QUERY_CONTENT_INVALID: 'Safe-copy query proof requires valid detached Documents V2 content.',
  SAFE_COPY_QUERY_STRUCTURE_MISSING: 'Safe-copy content is missing a required executable query structure.',
  SAFE_COPY_QUERY_STRUCTURE_INVALID: 'Safe-copy content contains a malformed executable query structure.',
  SAFE_COPY_QUERY_STRUCTURE_DUPLICATE: 'Safe-copy query proof contains a duplicate stable query identifier.',
  SAFE_COPY_QUERY_BEARING_SHAPE_UNKNOWN: 'Safe-copy content contains an unsupported query-bearing shape outside the canonical presentation query.',
  SAFE_COPY_QUERY_SET_INVALID: 'Safe-copy executable query-set evidence is invalid.',
  SAFE_COPY_QUERY_SET_MISMATCH: 'The live safe-copy executable query set does not exactly match the prepared query set.',
  SAFE_COPY_QUERY_EXECUTION_EVIDENCE_INVALID: 'Safe-copy query execution evidence is missing, malformed, duplicated, or outside the expected query set.',
  SAFE_COPY_QUERY_EXECUTION_FAILED: 'A safe-copy query did not return an explicit successful terminal status.',
};

/** Fixed error surface: rejected document/query values and raw execution data are never reflected. */
export class DashboardSafeCopyQueryProofError extends Error {
  readonly code: DashboardSafeCopyQueryProofErrorCode;
  readonly statusCode: 409 | 422;

  constructor(code: DashboardSafeCopyQueryProofErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'DashboardSafeCopyQueryProofError';
    this.code = code;
    this.statusCode = code === 'SAFE_COPY_QUERY_SET_MISMATCH' ? 409 : 422;
  }
}

export interface DashboardSafeCopyExecutableQuery {
  /** Stable Documents V2 query-presentation key. */
  id: string;
  /** SHA-256 over the canonical JSON query body. */
  hash: string;
  /** Detached, bounded query body. It is for transient execution, not persistence. */
  query: DashboardSafeCopyJsonRecord;
}

export interface DashboardSafeCopyExecutableQuerySet {
  version: 1;
  queries: DashboardSafeCopyExecutableQuery[];
  /** SHA-256 over the sorted stable ID/query-hash pairs. */
  setHash: string;
}

export interface DashboardSafeCopyQueryExecutionEvidenceInput {
  queryId: string;
  queryHash: string;
  summary: unknown;
}

export type DashboardSafeCopySuccessfulQueryStatus =
  | 'COMPLETE'
  | 'COMPLETED'
  | 'SUCCESS'
  | 'SUCCEEDED'
  | 'DONE';

export interface DashboardSafeCopySuccessfulQueryExecution {
  queryId: string;
  queryHash: string;
  status: DashboardSafeCopySuccessfulQueryStatus;
  jobId?: string;
  rowCount?: number;
}

export interface DashboardSafeCopyQueryExecutionProof {
  version: 1;
  querySetHash: string;
  queryCount: number;
  executions: DashboardSafeCopySuccessfulQueryExecution[];
}

interface CanonicalState {
  ancestors: WeakSet<object>;
  nodes: number;
}

function fail(code: DashboardSafeCopyQueryProofErrorCode): never {
  throw new DashboardSafeCopyQueryProofError(code);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownDataEntries(value: Record<string, unknown>): Array<[string, unknown]> {
  if (Object.getOwnPropertySymbols(value).length > 0) fail('SAFE_COPY_QUERY_STRUCTURE_INVALID');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Object.keys(value).map((key) => {
    const descriptor = descriptors[key];
    if (!descriptor || !('value' in descriptor)) fail('SAFE_COPY_QUERY_STRUCTURE_INVALID');
    return [key, descriptor.value];
  });
}

function stableCompare(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function canonicalJson(value: unknown, state: CanonicalState, depth = 0): string {
  state.nodes += 1;
  if (depth > MAX_QUERY_DEPTH || state.nodes > MAX_QUERY_NODES) {
    fail('SAFE_COPY_QUERY_STRUCTURE_INVALID');
  }
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('SAFE_COPY_QUERY_STRUCTURE_INVALID');
    return JSON.stringify(value);
  }
  if (!value || typeof value !== 'object') fail('SAFE_COPY_QUERY_STRUCTURE_INVALID');
  if (state.ancestors.has(value)) fail('SAFE_COPY_QUERY_STRUCTURE_INVALID');
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const serialized: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !('value' in descriptor)) fail('SAFE_COPY_QUERY_STRUCTURE_INVALID');
        serialized.push(canonicalJson(descriptor.value, state, depth + 1));
      }
      if (Object.keys(value).some((key) => (
        !/^(?:0|[1-9][0-9]*)$/.test(key)
        || Number(key) >= value.length
      ))) {
        fail('SAFE_COPY_QUERY_STRUCTURE_INVALID');
      }
      if (Object.getOwnPropertySymbols(value).length > 0) fail('SAFE_COPY_QUERY_STRUCTURE_INVALID');
      return `[${serialized.join(',')}]`;
    }
    if (!isPlainRecord(value)) fail('SAFE_COPY_QUERY_STRUCTURE_INVALID');
    const entries = ownDataEntries(value).sort(([left], [right]) => stableCompare(left, right));
    return `{${entries.map(([key, child]) => (
      `${JSON.stringify(key)}:${canonicalJson(child, state, depth + 1)}`
    )).join(',')}}`;
  } finally {
    state.ancestors.delete(value);
  }
}

function canonical(value: unknown): string {
  return canonicalJson(value, { ancestors: new WeakSet(), nodes: 0 });
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hashQuery(query: DashboardSafeCopyJsonRecord): string {
  return sha256(canonical(query));
}

function hashQuerySet(queries: readonly Pick<DashboardSafeCopyExecutableQuery, 'id' | 'hash'>[]): string {
  return sha256(canonical(queries.map(({ id, hash }) => ({ id, hash }))));
}

function compactKey(key: string): string {
  return key
    .normalize('NFKC')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join('');
}

function isUnknownQueryBearingKey(key: string): boolean {
  const compact = compactKey(key);
  if (QUERY_REFERENCE_KEYS.has(compact)) return false;
  return compact === 'query'
    || compact === 'queries'
    || compact.includes('query')
    || compact.includes('queries')
    || compact.includes('sql');
}

function assertNoUnknownQueryBearingShape(value: DashboardSafeCopyJsonValue | undefined): void {
  if (value === undefined || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((child) => assertNoUnknownQueryBearingShape(child));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (isUnknownQueryBearingKey(key)) fail('SAFE_COPY_QUERY_BEARING_SHAPE_UNKNOWN');
    assertNoUnknownQueryBearingShape(child);
  }
}

function materializeProofContent(value: unknown): DashboardSafeCopyDocumentContent {
  try {
    return materializeDashboardSafeCopyDocumentContent(value);
  } catch {
    return fail('SAFE_COPY_QUERY_CONTENT_INVALID');
  }
}

function assertCanonicalQueryLocations(content: DashboardSafeCopyDocumentContent): void {
  assertNoUnknownQueryBearingShape(content.controls);
  assertNoUnknownQueryBearingShape(content.settings);
  assertNoUnknownQueryBearingShape(content.containers);
  for (const presentation of Object.values(content.queryPresentations.data)) {
    assertNoUnknownQueryBearingShape(presentation.visConfig);
  }
}

function validatedQuerySet(
  value: DashboardSafeCopyExecutableQuerySet,
): DashboardSafeCopyExecutableQuery[] {
  if (
    !isPlainRecord(value)
    || value.version !== 1
    || !Array.isArray(value.queries)
    || value.queries.length > MAX_QUERY_COUNT
    || typeof value.setHash !== 'string'
    || !SHA_256.test(value.setHash)
  ) {
    fail('SAFE_COPY_QUERY_SET_INVALID');
  }
  const queries: DashboardSafeCopyExecutableQuery[] = [];
  const ids = new Set<string>();
  for (const row of value.queries) {
    if (!isPlainRecord(row)) fail('SAFE_COPY_QUERY_SET_INVALID');
    const entries = ownDataEntries(row);
    if (
      entries.some(([key]) => !new Set(['id', 'hash', 'query']).has(key))
      || typeof row.id !== 'string'
      || row.id.length > MAX_QUERY_ID_CHARACTERS
      || !QUERY_PRESENTATION_KEY.test(row.id)
      || typeof row.hash !== 'string'
      || !SHA_256.test(row.hash)
      || !isPlainRecord(row.query)
      || Object.keys(row.query).length === 0
    ) {
      fail('SAFE_COPY_QUERY_SET_INVALID');
    }
    if (ids.has(row.id)) fail('SAFE_COPY_QUERY_STRUCTURE_DUPLICATE');
    ids.add(row.id);
    const query = row.query as DashboardSafeCopyJsonRecord;
    if (hashQuery(query) !== row.hash) fail('SAFE_COPY_QUERY_SET_INVALID');
    queries.push({ id: row.id, hash: row.hash, query });
  }
  queries.sort((left, right) => stableCompare(left.id, right.id));
  if (hashQuerySet(queries) !== value.setHash) fail('SAFE_COPY_QUERY_SET_INVALID');
  return queries;
}

/**
 * Derives the only executable query set accepted by safe-copy: non-empty query
 * objects at queryPresentations.data[stableId].query. Other query-bearing paths
 * are ambiguous and fail closed.
 */
export function deriveDashboardSafeCopyExecutableQuerySet(
  value: unknown,
): DashboardSafeCopyExecutableQuerySet {
  const content = materializeProofContent(value);
  assertCanonicalQueryLocations(content);
  const queries: DashboardSafeCopyExecutableQuery[] = [];
  for (const id of content.queryPresentations.order) {
    const presentation = content.queryPresentations.data[id];
    if (!presentation) fail('SAFE_COPY_QUERY_STRUCTURE_MISSING');
    const { query, type } = presentation;
    if (query === undefined || query === null) {
      if (type && QUERY_REQUIRED_PRESENTATION_TYPES.has(type)) {
        fail('SAFE_COPY_QUERY_STRUCTURE_MISSING');
      }
      continue;
    }
    if (
      Object.keys(query).length === 0
      || (type !== undefined && NON_EXECUTABLE_PRESENTATION_TYPES.has(type))
    ) {
      fail('SAFE_COPY_QUERY_STRUCTURE_INVALID');
    }
    queries.push({ id, hash: hashQuery(query), query });
  }
  queries.sort((left, right) => stableCompare(left.id, right.id));
  return { version: 1, queries, setHash: hashQuerySet(queries) };
}

/** Re-derives live content and requires the same stable IDs and canonical query bodies. */
export function assertDashboardSafeCopyLiveQuerySet(
  expected: DashboardSafeCopyExecutableQuerySet,
  liveContent: unknown,
): DashboardSafeCopyExecutableQuerySet {
  const expectedQueries = validatedQuerySet(expected);
  const live = deriveDashboardSafeCopyExecutableQuerySet(liveContent);
  if (expected.setHash !== live.setHash || expectedQueries.length !== live.queries.length) {
    fail('SAFE_COPY_QUERY_SET_MISMATCH');
  }
  for (let index = 0; index < expectedQueries.length; index += 1) {
    const expectedQuery = expectedQueries[index];
    const liveQuery = live.queries[index];
    if (
      expectedQuery.id !== liveQuery.id
      || expectedQuery.hash !== liveQuery.hash
      || canonical(expectedQuery.query) !== canonical(liveQuery.query)
    ) {
      fail('SAFE_COPY_QUERY_SET_MISMATCH');
    }
  }
  return live;
}

function ownArrayValues(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > MAX_QUERY_COUNT) {
    fail('SAFE_COPY_QUERY_EXECUTION_EVIDENCE_INVALID');
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    fail('SAFE_COPY_QUERY_EXECUTION_EVIDENCE_INVALID');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const rows: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !('value' in descriptor)) {
      fail('SAFE_COPY_QUERY_EXECUTION_EVIDENCE_INVALID');
    }
    rows.push(descriptor.value);
  }
  if (Object.keys(value).some((key) => !/^\d+$/.test(key))) {
    fail('SAFE_COPY_QUERY_EXECUTION_EVIDENCE_INVALID');
  }
  return rows;
}

function strictExecutionRecord(
  value: unknown,
  allowed: ReadonlySet<string>,
): Record<string, unknown> {
  if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length > 0) {
    fail('SAFE_COPY_QUERY_EXECUTION_EVIDENCE_INVALID');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.has(key))) {
    fail('SAFE_COPY_QUERY_EXECUTION_EVIDENCE_INVALID');
  }
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !('value' in descriptor)) {
      fail('SAFE_COPY_QUERY_EXECUTION_EVIDENCE_INVALID');
    }
    result[key] = descriptor.value;
  }
  return result;
}

function successfulExecution(
  query: DashboardSafeCopyExecutableQuery,
  evidence: unknown,
): DashboardSafeCopySuccessfulQueryExecution {
  const row = strictExecutionRecord(evidence, EXECUTION_EVIDENCE_KEYS);
  if (row.queryId !== query.id || row.queryHash !== query.hash) {
    fail('SAFE_COPY_QUERY_EXECUTION_EVIDENCE_INVALID');
  }
  const summary = strictExecutionRecord(row.summary, EXECUTION_SUMMARY_KEYS);
  if (typeof summary.status !== 'string' || !summary.status.trim() || summary.status.length > 32) {
    fail('SAFE_COPY_QUERY_EXECUTION_EVIDENCE_INVALID');
  }
  const status = summary.status.trim().toUpperCase();
  if (!SUCCESS_STATUSES.has(status)) fail('SAFE_COPY_QUERY_EXECUTION_FAILED');
  if (
    summary.jobId !== undefined
    && (
      typeof summary.jobId !== 'string'
      || !summary.jobId.trim()
      || summary.jobId.length > MAX_EXECUTION_JOB_ID_CHARACTERS
    )
  ) {
    fail('SAFE_COPY_QUERY_EXECUTION_EVIDENCE_INVALID');
  }
  if (
    summary.rowCount !== undefined
    && (
      typeof summary.rowCount !== 'number'
      || !Number.isSafeInteger(summary.rowCount)
      || summary.rowCount < 0
    )
  ) {
    fail('SAFE_COPY_QUERY_EXECUTION_EVIDENCE_INVALID');
  }
  return {
    queryId: query.id,
    queryHash: query.hash,
    status: status as DashboardSafeCopySuccessfulQueryStatus,
    ...(summary.jobId !== undefined ? { jobId: summary.jobId.trim() } : {}),
    ...(summary.rowCount !== undefined ? { rowCount: summary.rowCount } : {}),
  };
}

/**
 * Converts exactly one explicit terminal-success summary per expected query
 * into bounded proof. Empty objects, inferred defaults, and non-terminal status
 * values never count as execution success.
 */
export function proveDashboardSafeCopyQueryExecutions(
  expected: DashboardSafeCopyExecutableQuerySet,
  evidence: readonly DashboardSafeCopyQueryExecutionEvidenceInput[],
): DashboardSafeCopyQueryExecutionProof {
  const queries = validatedQuerySet(expected);
  const rows = ownArrayValues(evidence);
  if (rows.length !== queries.length) fail('SAFE_COPY_QUERY_EXECUTION_EVIDENCE_INVALID');
  const byId = new Map<string, unknown>();
  for (const row of rows) {
    const record = strictExecutionRecord(row, EXECUTION_EVIDENCE_KEYS);
    if (typeof record.queryId !== 'string' || byId.has(record.queryId)) {
      fail('SAFE_COPY_QUERY_EXECUTION_EVIDENCE_INVALID');
    }
    byId.set(record.queryId, row);
  }
  const executions = queries.map((query) => {
    const row = byId.get(query.id);
    if (row === undefined) fail('SAFE_COPY_QUERY_EXECUTION_EVIDENCE_INVALID');
    return successfulExecution(query, row);
  });
  return {
    version: 1,
    querySetHash: expected.setHash,
    queryCount: queries.length,
    executions,
  };
}

export function isDashboardSafeCopyQueryProofError(
  error: unknown,
): error is DashboardSafeCopyQueryProofError {
  return error instanceof DashboardSafeCopyQueryProofError;
}

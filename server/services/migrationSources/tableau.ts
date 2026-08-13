import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { buildMigrationInventory } from '../../../src/services/semanticMigration/adapters';
import type {
  MigrationArtifact,
  MigrationInventory,
  MigrationPreparedEvidenceResult,
  MigrationPreparedEvidenceStatus,
  MigrationSourceArtifactProvenance,
  MigrationSourceDependencyEvidence,
} from '../../../src/services/semanticMigration/types';
import type {
  MigrationSourceCollectorContext,
  MigrationSourceConnectionSnapshot,
  MigrationSourceEvidenceCollector,
  MigrationSourceTransport,
  MigrationSourceTransportResponse,
} from './contracts';

const TABLEAU_DEFAULT_REST_VERSION = '3.29';
const MAX_SELECTED_ROOTS = 50;
const MAX_DEFINITION_BYTES = 25 * 1024 * 1024;
const MAX_DECOMPRESSED_XML_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_DEFINITION_BYTES = 180 * 1024 * 1024;
const MAX_PACKAGE_ENTRIES = 250;
const MAX_GOVERNANCE_BYTES = 5 * 1024 * 1024;
const MAX_METADATA_BYTES = 8 * 1024 * 1024;
const TABLEAU_SUBSCRIPTION_PAGE_SIZE = 1_000;
const TABLEAU_MAX_SUBSCRIPTION_ITEMS = 10_000;
const TABLEAU_MAX_SUBSCRIPTION_DATA_PAGES = Math.ceil(TABLEAU_MAX_SUBSCRIPTION_ITEMS / TABLEAU_SUBSCRIPTION_PAGE_SIZE);
// One terminal probe is allowed when pagination metadata is absent and the
// tenth data page is full.
const TABLEAU_MAX_SUBSCRIPTION_REQUEST_PAGES = TABLEAU_MAX_SUBSCRIPTION_DATA_PAGES + 1;
const TABLEAU_DOCUMENTATION = [
  'https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api_concepts_auth.htm',
  'https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api_ref_workbooks_and_views.htm',
  'https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api_ref_data_sources.htm',
  'https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api_concepts_permissions.htm',
  'https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api_ref_extract_and_encryption.htm',
  'https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api_ref_subscriptions.htm',
  'https://help.tableau.com/current/api/metadata_api/en-us/docs/meta_api_start.html',
] as const;

type TableauRootKind = 'workbook' | 'datasource';

interface TableauSelectedRoot {
  kind: TableauRootKind;
  id: string;
  sourceId: string;
}

interface TableauSession {
  token: string;
  siteId: string;
  siteContentUrl: string;
  userId?: string;
  apiBase: string;
}

interface TableauDefinitionArtifact {
  artifact: MigrationArtifact;
  provenance: MigrationSourceArtifactProvenance;
  root: TableauSelectedRoot;
}

interface TableauCollectionTotals {
  requestsMade: number;
  bytesRead: number;
  itemsObserved: number;
}

interface TableauOptionalEvidence {
  name: string;
  sourceId: string;
  parentSourceId?: string;
  payload: unknown;
  mediaType: string;
  evidenceClass: 'governance_evidence' | 'discovery_metadata';
  documentationIds: string[];
}

export type TableauDiscoveryItemKind = 'project' | 'workbook' | 'view' | 'data_source';

export interface TableauDiscoveryItem {
  id: string;
  name: string;
  kind: TableauDiscoveryItemKind;
  parentId?: string;
  contentUrl?: string;
  ownerId?: string;
  createdAt?: string;
  updatedAt?: string;
  tags: string[];
}

export interface TableauDiscoveryResult {
  platform: 'tableau';
  connectionId: string;
  connectionUpdatedAt: string;
  siteId: string;
  siteContentUrl: string;
  items: TableauDiscoveryItem[];
  complete: boolean;
  truncated: boolean;
  requestsMade: number;
  pagesFetched: number;
  bytesRead: number;
  warnings: string[];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function header(response: MigrationSourceTransportResponse, name: string): string | undefined {
  const target = name.toLowerCase();
  return Object.entries(response.headers).find(([key]) => key.toLowerCase() === target)?.[1];
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeJson(value: unknown): string {
  return JSON.stringify(value, (_key, child) => child === undefined ? null : child);
}

function tableauError(message: string, statusCode = 502): Error {
  return Object.assign(new Error(message), { statusCode });
}

function rethrowTableauCancellation(error: unknown): void {
  const statusCode = (error as { statusCode?: number })?.statusCode;
  if (statusCode === 499 || statusCode === 504 || (error as { name?: string })?.name === 'AbortError') throw error;
}

function isUnsafeTableauIdentifierCharacter(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return code <= 0x1f || code === 0x7f || '\\/?#'.includes(character);
}

function stripControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f ? '' : character;
  }).join('');
}

function assertTableauIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 240 || Array.from(normalized).some(isUnsafeTableauIdentifierCharacter) || normalized === '.' || normalized === '..') {
    throw tableauError(`${label} is invalid.`, 400);
  }
  return normalized;
}

function parseTableauRoot(value: string): TableauSelectedRoot {
  const trimmed = value.trim();
  const matched = trimmed.match(/^(workbook|datasource):(.+)$/i);
  const kind = matched?.[1]?.toLowerCase() === 'datasource' ? 'datasource' : 'workbook';
  const id = assertTableauIdentifier(matched?.[2] || trimmed, `Tableau ${kind} ID`);
  return { kind, id, sourceId: `tableau:${kind}:${id}` };
}

function tableauApiCoordinates(baseUrl: string): { origin: string; apiBase: string; version: string } {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw tableauError('Tableau server URL is invalid.', 400);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw tableauError('Tableau server URL must be a credential-free HTTPS URL.', 400);
  }
  const match = parsed.pathname.replace(/\/+$/, '').match(/^(.*)\/api\/(\d+\.\d+)$/i);
  const version = match?.[2] || TABLEAU_DEFAULT_REST_VERSION;
  // Preserve the valid empty prefix for an origin-root REST base. Falling back
  // on an empty capture would otherwise duplicate `/api/{version}` when this
  // helper receives an already-normalized session API base.
  const prefix = match ? match[1]! : parsed.pathname.replace(/\/+$/, '');
  const origin = `${parsed.origin}${prefix}`.replace(/\/+$/, '');
  return { origin, version, apiBase: `${origin}/api/${version}` };
}

function assertTableauConnection(connection: MigrationSourceConnectionSnapshot): void {
  if (connection.platform !== 'tableau') throw tableauError('The Tableau collector requires a Tableau connection.', 400);
  if (connection.authMode !== 'personal_access_token') {
    throw tableauError('Tableau Saved API requires personal access token authentication.', 409);
  }
  if (!connection.username || !connection.credential) {
    throw tableauError('Tableau personal access token name and secret are required.', 409);
  }
  if (connection.username.length > 500 || connection.credential.length > 16_384 || /[\r\n]/.test(connection.credential)) {
    throw tableauError('The saved Tableau personal access token is invalid and must be replaced.', 409);
  }
  tableauApiCoordinates(connection.baseUrl);
}

function observe(totals: TableauCollectionTotals, response: MigrationSourceTransportResponse): void {
  totals.requestsMade += Math.max(1, response.requestCount || 1);
  totals.bytesRead += response.bytesRead;
}

async function tableauSignIn(
  connection: MigrationSourceConnectionSnapshot,
  transport: MigrationSourceTransport,
  totals: TableauCollectionTotals,
  signal?: AbortSignal,
): Promise<TableauSession> {
  assertTableauConnection(connection);
  const coordinates = tableauApiCoordinates(connection.baseUrl);
  const response = await transport.request<Record<string, unknown>>({
    url: `${coordinates.apiBase}/auth/signin`,
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      credentials: {
        personalAccessTokenName: connection.username,
        personalAccessTokenSecret: connection.credential,
        site: { contentUrl: connection.siteId || '' },
      },
    }),
    responseType: 'json',
    label: 'Tableau personal access token sign-in',
    allowStatuses: [200, 401, 403],
    maxResponseBytes: 512 * 1024,
    signal,
  });
  observe(totals, response);
  if (response.status !== 200) {
    throw tableauError(response.status === 401 || response.status === 403
      ? 'Tableau rejected the saved personal access token or site. Replace the credential or correct the site content URL.'
      : 'Tableau sign-in failed.');
  }
  const credentials = record(record(response.body).credentials);
  const site = record(credentials.site);
  const user = record(credentials.user);
  const token = nonEmptyString(credentials.token);
  const siteId = nonEmptyString(site.id);
  if (!token || !siteId) throw tableauError('Tableau sign-in returned an incomplete credentials contract.');
  return {
    token,
    siteId: assertTableauIdentifier(siteId, 'Tableau signed-in site ID'),
    siteContentUrl: nonEmptyString(site.contentUrl) || connection.siteId || '',
    userId: nonEmptyString(user.id),
    apiBase: coordinates.apiBase,
  };
}

async function tableauSignOut(
  session: TableauSession,
  transport: MigrationSourceTransport,
  totals: TableauCollectionTotals,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const response = await transport.request({
      url: `${session.apiBase}/auth/signout`,
      method: 'POST',
      headers: { 'X-Tableau-Auth': session.token },
      responseType: 'text',
      label: 'Tableau session sign-out',
      allowStatuses: [204, 400, 401, 403],
      maxResponseBytes: 64 * 1024,
      signal,
    });
    observe(totals, response);
  } catch {
    // The short-lived token is never persisted. Sign-out failure must not replace
    // the acquisition result or expose the session credential in diagnostics.
  }
}

function tableauHeaders(session: TableauSession, accept = 'application/json'): Record<string, string> {
  return { Accept: accept, 'X-Tableau-Auth': session.token };
}

function tableauEnvelopeRows(payload: unknown, container: string, singular: string, label: string): unknown[] {
  if (!isRecord(payload) || !hasOwn(payload, container)) {
    throw tableauError(`Tableau ${label} returned an unrecognized HTTP-200 envelope.`, 502);
  }
  const nested = payload[container];
  if (!isRecord(nested)) {
    throw tableauError(`Tableau ${label} returned a malformed ${container} container.`, 502);
  }
  if (!hasOwn(nested, singular)) return [];
  const rows = nested[singular];
  if (Array.isArray(rows)) return rows;
  if (isRecord(rows)) return [rows];
  throw tableauError(`Tableau ${label} returned a malformed ${singular} collection.`, 502);
}

function tableauPaginationInteger(value: unknown, label: string, allowZero = false): number {
  const normalized = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value.trim())
      ? Number(value.trim())
      : Number.NaN;
  if (!Number.isSafeInteger(normalized) || normalized < (allowZero ? 0 : 1)) {
    throw tableauError(`Tableau pagination ${label} must be ${allowZero ? 'a non-negative' : 'a positive'} integer.`, 502);
  }
  return normalized;
}

function tableauPagination(payload: unknown): { pageNumber: number; pageSize: number; totalAvailable: number } | undefined {
  const root = record(payload);
  if (!Object.prototype.hasOwnProperty.call(root, 'pagination')) return undefined;
  if (!root.pagination || typeof root.pagination !== 'object' || Array.isArray(root.pagination)) {
    throw tableauError('Tableau pagination metadata was present but malformed.', 502);
  }
  const value = root.pagination as Record<string, unknown>;
  return {
    pageNumber: tableauPaginationInteger(value.pageNumber, 'pageNumber'),
    pageSize: tableauPaginationInteger(value.pageSize, 'pageSize'),
    // Empty catalogs are valid, so totalAvailable may be zero even though the
    // page coordinates themselves must always be positive.
    totalAvailable: tableauPaginationInteger(value.totalAvailable, 'totalAvailable', true),
  };
}

function tableauTagNames(value: unknown): string[] {
  const tags = record(record(value).tags).tag;
  const rows = Array.isArray(tags) ? tags : tags && typeof tags === 'object' ? [tags] : [];
  return Array.from(new Set(rows.map((tag) => nonEmptyString(record(tag).label)).filter((tag): tag is string => Boolean(tag)))).slice(0, 100);
}

function normalizeTableauDiscoveryItem(value: unknown, kind: TableauDiscoveryItemKind, index: number): TableauDiscoveryItem {
  if (!isRecord(value)) {
    throw tableauError(`Tableau ${kind.replace('_', ' ')} inventory returned an invalid item record at index ${index}.`, 502);
  }
  const item = value;
  const id = nonEmptyString(item.id);
  const name = nonEmptyString(item.name);
  if (!id || !name) {
    throw tableauError(`Tableau ${kind.replace('_', ' ')} inventory returned an invalid item record at index ${index}.`, 502);
  }
  const project = record(item.project);
  const workbook = record(item.workbook);
  const owner = record(item.owner);
  return {
    id,
    name,
    kind,
    parentId: nonEmptyString(project.id) || nonEmptyString(workbook.id),
    contentUrl: nonEmptyString(item.contentUrl),
    ownerId: nonEmptyString(owner.id),
    createdAt: nonEmptyString(item.createdAt),
    updatedAt: nonEmptyString(item.updatedAt),
    tags: tableauTagNames(item),
  };
}

async function discoverTableauKind(input: {
  session: TableauSession;
  transport: MigrationSourceTransport;
  totals: TableauCollectionTotals;
  endpoint: string;
  container: string;
  singular: string;
  kind: TableauDiscoveryItemKind;
  signal?: AbortSignal;
}): Promise<{ items: TableauDiscoveryItem[]; truncated: boolean }> {
  const pageSize = 1000;
  const maxPages = 10;
  const maxItems = 2_000;
  const items: TableauDiscoveryItem[] = [];
  const seen = new Set<string>();
  let truncated = false;
  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    const response = await input.transport.request<Record<string, unknown>>({
      url: `${input.session.apiBase}/sites/${encodeURIComponent(input.session.siteId)}/${input.endpoint}?pageSize=${pageSize}&pageNumber=${pageNumber}`,
      headers: tableauHeaders(input.session),
      responseType: 'json',
      label: `Tableau ${input.kind.replace('_', ' ')} discovery`,
      allowStatuses: [200, 401, 403, 404],
      maxResponseBytes: MAX_GOVERNANCE_BYTES,
      signal: input.signal,
    });
    observe(input.totals, response);
    if (response.status !== 200) {
      throw tableauError(response.status === 401 || response.status === 403
        ? `Tableau ${input.kind.replace('_', ' ')} inventory is not accessible to the saved PAT.`
        : `Tableau ${input.kind.replace('_', ' ')} inventory could not be read.`);
    }
    input.totals.itemsObserved += 1;
    const rows = tableauEnvelopeRows(
      response.body,
      input.container,
      input.singular,
      `${input.kind.replace('_', ' ')} inventory`,
    );
    if (rows.length > pageSize) {
      throw tableauError(`Tableau ${input.kind.replace('_', ' ')} inventory exceeded the requested page size.`, 502);
    }
    for (const [index, row] of rows.entries()) {
      const item = normalizeTableauDiscoveryItem(row, input.kind, index);
      const key = `${item.kind}:${item.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
      if (items.length >= maxItems) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
    const pagination = tableauPagination(response.body);
    const hasMore = pagination
      ? pagination.pageNumber * pagination.pageSize < pagination.totalAvailable
      : rows.length >= pageSize;
    if (!hasMore) break;
    if (pageNumber === maxPages) truncated = true;
  }
  return { items, truncated };
}

/**
 * Authenticated Tableau catalog discovery. This endpoint intentionally emits
 * only selectable catalog metadata; callers must run prepareTableauEvidence
 * before treating any root as migration evidence.
 */
export async function discoverTableauSource(
  connection: MigrationSourceConnectionSnapshot,
  transport: MigrationSourceTransport,
  signal?: AbortSignal,
): Promise<TableauDiscoveryResult> {
  assertTableauConnection(connection);
  const totals: TableauCollectionTotals = { requestsMade: 0, bytesRead: 0, itemsObserved: 0 };
  let pagesFetched = 0;
  const warnings: string[] = [];
  const session = await tableauSignIn(connection, transport, totals, signal);
  try {
    const definitions = [
      { endpoint: 'projects', container: 'projects', singular: 'project', kind: 'project' as const },
      { endpoint: 'workbooks', container: 'workbooks', singular: 'workbook', kind: 'workbook' as const },
      { endpoint: 'views', container: 'views', singular: 'view', kind: 'view' as const },
      { endpoint: 'datasources', container: 'datasources', singular: 'datasource', kind: 'data_source' as const },
    ];
    const results: Array<{ items: TableauDiscoveryItem[]; truncated: boolean }> = [];
    for (const definition of definitions) {
      try {
        const result = await discoverTableauKind({ session, transport, totals, signal, ...definition });
        results.push(result);
        pagesFetched += Math.max(1, Math.ceil(result.items.length / 1000));
      } catch (error) {
        rethrowTableauCancellation(error);
        warnings.push(error instanceof Error ? error.message : `Tableau ${definition.kind} inventory could not be verified.`);
      }
    }
    const items = results.flatMap((result) => result.items);
    const truncated = results.some((result) => result.truncated);
    return {
      platform: 'tableau',
      connectionId: connection.id,
      connectionUpdatedAt: connection.updatedAt,
      siteId: session.siteId,
      siteContentUrl: session.siteContentUrl,
      items,
      complete: warnings.length === 0 && !truncated,
      truncated,
      requestsMade: totals.requestsMade,
      pagesFetched,
      bytesRead: totals.bytesRead,
      warnings,
    };
  } finally {
    await tableauSignOut(session, transport, totals, signal);
  }
}

function contentDispositionFilename(response: MigrationSourceTransportResponse, fallback: string): string {
  const disposition = header(response, 'content-disposition') || '';
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const basic = disposition.match(/filename\s*=\s*"?([^";]+)"?/i)?.[1];
  let name = fallback;
  try {
    name = encoded ? decodeURIComponent(encoded) : basic || fallback;
  } catch {
    name = basic || fallback;
  }
  const basename = name.replaceAll('\\', '/').split('/').pop()?.trim() || fallback;
  return stripControlCharacters(basename).slice(0, 240) || fallback;
}

function looksLikeXml(bytes: Uint8Array): boolean {
  const prefix = new TextDecoder().decode(bytes.slice(0, 512)).replace(/^\uFEFF/, '').trimStart();
  return prefix.startsWith('<?xml') || prefix.startsWith('<workbook') || prefix.startsWith('<datasource');
}

async function extractTableauXml(bytes: Uint8Array, kind: TableauRootKind, filename: string): Promise<{ name: string; content: string; warnings: string[] }> {
  const expectedExtension = kind === 'workbook' ? '.twb' : '.tds';
  if (looksLikeXml(bytes)) {
    if (bytes.byteLength > MAX_DECOMPRESSED_XML_BYTES) throw tableauError('Tableau XML definition exceeded the 16 MB safety limit.', 413);
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { name: filename.toLowerCase().endsWith(expectedExtension) ? filename : `${filename}${expectedExtension}`, content, warnings: [] };
  }

  let archive: JSZip;
  try {
    // JSZip's eager CRC verification inflates every member during load, before
    // OmniKit can enforce the selected XML member's decompressed byte ceiling.
    // Parse directory metadata only, then stream the single definition below.
    archive = await JSZip.loadAsync(bytes, { checkCRC32: false, createFolders: false });
  } catch {
    throw tableauError(`Tableau returned ${filename}, but it was neither readable XML nor a valid packaged definition. Supply the corresponding Manual File.`, 422);
  }
  const entries = Object.values(archive.files);
  if (entries.length > MAX_PACKAGE_ENTRIES) throw tableauError('Tableau packaged definition exceeded the 250-entry safety limit.', 413);
  const duplicateNames = new Set<string>();
  for (const entry of entries) {
    const original = entry.unsafeOriginalName || entry.name;
    const normalized = original.replaceAll('\\', '/');
    if (normalized.startsWith('/') || normalized.split('/').some((segment) => segment === '..')) {
      throw tableauError('Tableau packaged definition contained an unsafe member path.', 422);
    }
    const key = normalized.toLowerCase();
    if (duplicateNames.has(key)) throw tableauError('Tableau packaged definition contained duplicate member names.', 422);
    duplicateNames.add(key);
  }
  const candidates = entries.filter((entry) => !entry.dir && entry.name.toLowerCase().endsWith(expectedExtension));
  if (candidates.length !== 1) {
    throw tableauError(`Tableau packaged definition must contain exactly one ${expectedExtension} definition. Supply a focused Manual File instead.`, 422);
  }
  const candidate = candidates[0]!;
  const xmlBytes = await new Promise<Uint8Array>((resolve, reject) => {
    const stream = candidate.nodeStream('nodebuffer');
    const chunks: Buffer[] = [];
    let sizeBytes = 0;
    let settled = false;
    stream.on('data', (chunk: Buffer) => {
      if (settled) return;
      sizeBytes += chunk.byteLength;
      if (sizeBytes > MAX_DECOMPRESSED_XML_BYTES) {
        settled = true;
        chunks.length = 0;
        (stream as NodeJS.ReadableStream & { destroy(): void }).destroy();
        reject(tableauError('Tableau packaged XML definition exceeded the 16 MB decompressed safety limit.', 413));
        return;
      }
      chunks.push(chunk);
    });
    stream.once('error', (error) => {
      if (settled) return;
      settled = true;
      reject(Object.assign(new Error('Tableau packaged XML could not be decompressed safely.'), { statusCode: 422, cause: error }));
    });
    stream.once('end', () => {
      if (settled) return;
      settled = true;
      resolve(new Uint8Array(Buffer.concat(chunks, sizeBytes)));
    });
  });
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(xmlBytes);
  } catch {
    throw tableauError('Tableau packaged definition contained non-UTF-8 XML.', 422);
  }
  if (!looksLikeXml(xmlBytes)) throw tableauError('Tableau packaged definition did not contain a recognized workbook or data-source XML root.', 422);
  return {
    name: candidates[0].name.replaceAll('\\', '/').split('/').pop() || `${filename}${expectedExtension}`,
    content,
    warnings: [`${filename} was unpacked server-side without extracts; non-definition package resources were not retained.`],
  };
}

async function downloadTableauDefinition(
  root: TableauSelectedRoot,
  session: TableauSession,
  transport: MigrationSourceTransport,
  totals: TableauCollectionTotals,
  signal?: AbortSignal,
): Promise<TableauDefinitionArtifact> {
  const plural = root.kind === 'workbook' ? 'workbooks' : 'datasources';
  const response = await transport.request<Uint8Array>({
    url: `${session.apiBase}/sites/${encodeURIComponent(session.siteId)}/${plural}/${encodeURIComponent(root.id)}/content?includeExtract=False`,
    headers: tableauHeaders(session, 'application/xml, application/octet-stream'),
    responseType: 'bytes',
    label: `Tableau ${root.kind} definition download`,
    allowStatuses: [200, 401, 403, 404],
    maxResponseBytes: MAX_DEFINITION_BYTES,
    signal,
  });
  observe(totals, response);
  if (response.status === 401 || response.status === 403) {
    throw tableauError(`Tableau ${root.kind} ${root.id} could not be downloaded because ExportXml permission is unavailable. Supply its TWB/TWBX or TDS/TDSX through Manual Files.`, 403);
  }
  if (response.status !== 200) {
    throw tableauError(`Tableau ${root.kind} ${root.id} was not found in the signed-in site.`, response.status === 404 ? 404 : 502);
  }
  const bytes = response.body;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) throw tableauError(`Tableau ${root.kind} ${root.id} returned an empty definition.`, 502);
  const fallback = `${root.kind}-${root.id}${root.kind === 'workbook' ? '.twbx' : '.tdsx'}`;
  const filename = contentDispositionFilename(response, fallback);
  const extracted = await extractTableauXml(bytes, root.kind, filename);
  const contentBytes = Buffer.byteLength(extracted.content, 'utf8');
  const artifact: MigrationArtifact = {
    id: `tableau-api-${root.kind}-${sha256(root.id).slice(0, 16)}`,
    sourceTool: 'tableau',
    name: extracted.name,
    kind: 'xml',
    content: extracted.content,
    sizeBytes: contentBytes,
    parseWarnings: extracted.warnings,
  };
  totals.itemsObserved += 1;
  return {
    artifact,
    root,
    provenance: {
      id: `tableau:${root.kind}:definition:${root.id}`,
      name: artifact.name,
      sourceId: root.sourceId,
      locator: `${root.kind}:${root.id}:content`,
      mediaType: 'application/xml',
      evidenceClass: 'authoritative_definition',
      sha256: sha256(extracted.content),
      sizeBytes: contentBytes,
      documentationIds: [
        root.kind === 'workbook' ? TABLEAU_DOCUMENTATION[1] : TABLEAU_DOCUMENTATION[2],
      ],
      rawContentIncluded: false,
    },
  };
}

async function requestOptionalJson(
  input: {
    url: string;
    label: string;
    session: TableauSession;
    transport: MigrationSourceTransport;
    totals: TableauCollectionTotals;
    signal?: AbortSignal;
    method?: 'GET' | 'POST';
    body?: string;
    maxResponseBytes?: number;
  },
): Promise<{ status: number; body?: unknown }> {
  try {
    const response = await input.transport.request({
      url: input.url,
      method: input.method,
      headers: { ...tableauHeaders(input.session), ...(input.body ? { 'Content-Type': 'application/json' } : {}) },
      body: input.body,
      responseType: 'json',
      label: input.label,
      allowStatuses: [200, 400, 401, 403, 404, 405],
      maxResponseBytes: input.maxResponseBytes || MAX_GOVERNANCE_BYTES,
      signal: input.signal,
    });
    observe(input.totals, response);
    return { status: response.status, body: response.status === 200 ? response.body : undefined };
  } catch (error) {
    rethrowTableauCancellation(error);
    return { status: (error as { statusCode?: number })?.statusCode === 413 ? 413 : 502 };
  }
}

function validateTableauObjectRows(
  payload: unknown,
  container: string,
  singular: string,
  label: string,
  recognizable: (row: Record<string, unknown>) => boolean = () => true,
): Record<string, unknown>[] {
  const rows = tableauEnvelopeRows(payload, container, singular, label);
  return rows.map((row, index) => {
    if (!isRecord(row) || !recognizable(row)) {
      throw tableauError(`Tableau ${label} returned an invalid item record at index ${index}.`, 502);
    }
    return row;
  });
}

function validateTableauMetadataEnvelope(payload: unknown): {
  data?: Record<string, unknown>;
  errors: Record<string, unknown>[];
} {
  if (!isRecord(payload)) {
    throw tableauError('Tableau Metadata API returned an unrecognized HTTP-200 envelope.', 502);
  }
  let errors: Record<string, unknown>[] = [];
  if (hasOwn(payload, 'errors')) {
    if (!Array.isArray(payload.errors) || payload.errors.some((error) => !isRecord(error))) {
      throw tableauError('Tableau Metadata API returned a malformed GraphQL errors collection.', 502);
    }
    errors = payload.errors as Record<string, unknown>[];
  }
  if (!hasOwn(payload, 'data') || payload.data === null) {
    if (errors.length > 0) return { errors };
    throw tableauError('Tableau Metadata API returned an unrecognized HTTP-200 envelope.', 502);
  }
  if (!isRecord(payload.data)) {
    throw tableauError('Tableau Metadata API returned a malformed GraphQL data object.', 502);
  }
  const data = payload.data;
  const selectedCollections = ['workbooks', 'publishedDatasources'].filter((key) => hasOwn(data, key));
  if (selectedCollections.length === 0) {
    if (errors.length > 0) return { errors };
    throw tableauError('Tableau Metadata API response did not contain a selected-scope collection.', 502);
  }
  for (const collection of selectedCollections) {
    const rows = data[collection];
    if (!Array.isArray(rows) || rows.some((row) => (
      !isRecord(row)
      || (!nonEmptyString(row.id) && !nonEmptyString(row.luid))
      || !nonEmptyString(row.name)
    ))) {
      throw tableauError(`Tableau Metadata API returned a malformed ${collection} collection.`, 502);
    }
  }
  return { data, errors };
}

function tableauValidationMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

async function collectTableauSubscriptions(
  session: TableauSession,
  transport: MigrationSourceTransport,
  totals: TableauCollectionTotals,
  signal?: AbortSignal,
): Promise<{
  status: number;
  payload?: unknown;
  complete: boolean;
  truncated: boolean;
  pagesFetched: number;
  integrityIssue?: string;
}> {
  const rows: unknown[] = [];
  let pagesFetched = 0;
  let reportedTotal: number | undefined;
  let previousPageSignature = '';
  let terminalObserved = false;
  let truncated = false;
  let integrityIssue: string | undefined;

  for (let pageNumber = 1; pageNumber <= TABLEAU_MAX_SUBSCRIPTION_REQUEST_PAGES; pageNumber += 1) {
    const response = await requestOptionalJson({
      url: `${session.apiBase}/sites/${encodeURIComponent(session.siteId)}/subscriptions?pageSize=${TABLEAU_SUBSCRIPTION_PAGE_SIZE}&pageNumber=${pageNumber}`,
      label: `Tableau site subscriptions page ${pageNumber}`,
      session,
      transport,
      totals,
      signal,
    });
    pagesFetched += 1;
    if (response.status !== 200) {
      return { status: response.status, complete: false, truncated: truncated || response.status === 413, pagesFetched };
    }

    let pageRows: Record<string, unknown>[];
    let pagination: ReturnType<typeof tableauPagination>;
    try {
      pageRows = validateTableauObjectRows(
        response.body,
        'subscriptions',
        'subscription',
        'subscriptions',
        (row) => Boolean(nonEmptyString(row.id)),
      );
      pagination = tableauPagination(response.body);
    } catch (error) {
      return {
        status: 422,
        complete: false,
        truncated: true,
        pagesFetched,
        integrityIssue: tableauValidationMessage(error, 'Tableau subscriptions returned malformed HTTP-200 evidence.'),
      };
    }
    if (pageRows.length > TABLEAU_SUBSCRIPTION_PAGE_SIZE) {
      truncated = true;
      integrityIssue = `Tableau subscriptions page ${pageNumber} exceeded the requested page size.`;
      break;
    }
    if (pagination) {
      if (pagination.pageNumber !== pageNumber || pagination.pageSize !== TABLEAU_SUBSCRIPTION_PAGE_SIZE) {
        truncated = true;
        integrityIssue = `Tableau subscriptions page ${pageNumber} returned incoherent page coordinates.`;
        break;
      }
      if (reportedTotal !== undefined && pagination.totalAvailable !== reportedTotal) {
        truncated = true;
        integrityIssue = 'Tableau subscriptions changed totalAvailable between pages.';
        break;
      }
      reportedTotal = pagination.totalAvailable;
      const projectedCount = rows.length + pageRows.length;
      if (projectedCount > pagination.totalAvailable) {
        truncated = true;
        integrityIssue = `Tableau subscriptions page ${pageNumber} would exceed totalAvailable.`;
        break;
      }
      if (pageRows.length === 0 && rows.length < pagination.totalAvailable) {
        truncated = true;
        integrityIssue = `Tableau subscriptions page ${pageNumber} was empty before totalAvailable was reached.`;
        break;
      }
    }

    if (pageNumber > TABLEAU_MAX_SUBSCRIPTION_DATA_PAGES) {
      terminalObserved = pageRows.length === 0;
      truncated = pageRows.length > 0;
      break;
    }

    const pageSignature = sha256(safeJson(pageRows));
    if (pageRows.length > 0 && pageSignature === previousPageSignature) {
      truncated = true;
      break;
    }
    previousPageSignature = pageSignature;
    rows.push(...pageRows);
    totals.itemsObserved += pageRows.length;

    if (rows.length > TABLEAU_MAX_SUBSCRIPTION_ITEMS) {
      rows.length = TABLEAU_MAX_SUBSCRIPTION_ITEMS;
      truncated = true;
      break;
    }
    if (pagination) {
      if (rows.length === pagination.totalAvailable) {
        terminalObserved = true;
        break;
      }
      if (pageRows.length < TABLEAU_SUBSCRIPTION_PAGE_SIZE) {
        truncated = true;
        integrityIssue = `Tableau subscriptions page ${pageNumber} was short before totalAvailable was reached.`;
        break;
      }
      if (pageNumber === TABLEAU_MAX_SUBSCRIPTION_DATA_PAGES) {
        truncated = true;
        break;
      }
    } else if (pageRows.length < TABLEAU_SUBSCRIPTION_PAGE_SIZE) {
      terminalObserved = true;
      break;
    }
  }

  if (!terminalObserved && !truncated) truncated = true;
  return {
    status: 200,
    payload: {
      subscriptions: { subscription: rows },
      collection: {
        pagesFetched,
        observed: rows.length,
        reportedTotal: reportedTotal ?? null,
        complete: terminalObserved && !truncated,
        truncated,
      },
    },
    complete: terminalObserved && !truncated,
    truncated,
    pagesFetched,
    integrityIssue,
  };
}

const TABLEAU_METADATA_QUERY = `
  query OmniKitTableauEvidence($workbookLuids: [String!], $datasourceLuids: [String!]) {
    workbooks(filter: { luidWithin: $workbookLuids }) {
      id luid name containsUnsupportedCustomSql projectLuid projectName
      owner { id name }
      parameters { id name }
      sheets { id name }
      embeddedDatasources {
        id name hasUserReference hasExtracts containsUnsupportedCustomSql
        fields {
          __typename id name fullyQualifiedName description isHidden
          ... on CalculatedField { formula aggregation hasUserReference fields { id name } }
        }
      }
    }
    publishedDatasources(filter: { luidWithin: $datasourceLuids }) {
      id luid name hasUserReference hasExtracts containsUnsupportedCustomSql
      fields {
        __typename id name fullyQualifiedName description isHidden
        ... on CalculatedField { formula aggregation hasUserReference fields { id name } }
      }
    }
  }
`;

async function collectTableauOptionalEvidence(
  roots: TableauSelectedRoot[],
  session: TableauSession,
  transport: MigrationSourceTransport,
  totals: TableauCollectionTotals,
  signal?: AbortSignal,
): Promise<{
  evidence: TableauOptionalEvidence[];
  permissionGaps: string[];
  governanceGaps: string[];
  warnings: string[];
  truncated: boolean;
  pagesFetched: number;
}> {
  const evidence: TableauOptionalEvidence[] = [];
  const permissionGaps: string[] = [];
  const governanceGaps: string[] = [];
  const warnings: string[] = [];
  const workbookIds = roots.filter((root) => root.kind === 'workbook').map((root) => root.id);
  const datasourceIds = roots.filter((root) => root.kind === 'datasource').map((root) => root.id);

  const metadata = await requestOptionalJson({
    url: `${tableauApiCoordinates(session.apiBase).origin}/api/metadata/graphql`,
    method: 'POST',
    body: JSON.stringify({ query: TABLEAU_METADATA_QUERY, variables: { workbookLuids: workbookIds, datasourceLuids: datasourceIds } }),
    label: 'Tableau Metadata API selected-scope query',
    session,
    transport,
    totals,
    signal,
    maxResponseBytes: MAX_METADATA_BYTES,
  });
  if (metadata.status === 200) {
    try {
      const validated = validateTableauMetadataEnvelope(metadata.body);
      if (validated.errors.length > 0) {
        const gap = 'Tableau Metadata API returned selected-scope errors; downloaded XML remains authoritative, but lineage and calculated-field cross-checks require review.';
        governanceGaps.push(gap);
        warnings.push(gap);
      }
      if (validated.data) {
        evidence.push({
          name: 'Tableau selected-scope Metadata API evidence',
          sourceId: `tableau:site:${session.siteId}`,
          payload: validated.data,
          mediaType: 'application/json',
          evidenceClass: 'governance_evidence',
          documentationIds: [TABLEAU_DOCUMENTATION[6]],
        });
      }
    } catch (error) {
      const detail = tableauValidationMessage(error, 'Tableau Metadata API returned malformed HTTP-200 evidence.');
      const gap = `${detail} Metadata lineage and calculated-field cross-checks were not trusted.`;
      governanceGaps.push(gap);
      warnings.push(gap);
    }
  } else {
    permissionGaps.push('Tableau Metadata API lineage and calculated-field cross-check could not be verified for the selected scope.');
  }

  for (const root of roots) {
    const plural = root.kind === 'workbook' ? 'workbooks' : 'datasources';
    const base = `${session.apiBase}/sites/${encodeURIComponent(session.siteId)}/${plural}/${encodeURIComponent(root.id)}`;
    const [permissions, connections] = await Promise.all([
      requestOptionalJson({ url: `${base}/permissions`, label: `Tableau ${root.kind} permissions`, session, transport, totals, signal }),
      requestOptionalJson({ url: `${base}/connections`, label: `Tableau ${root.kind} connections`, session, transport, totals, signal }),
    ]);
    if (permissions.status === 200) {
      try {
        validateTableauObjectRows(
          permissions.body,
          'permissions',
          'granteeCapabilities',
          `${root.kind} ${root.id} permissions`,
          (row) => {
            const grantee = isRecord(row.user) ? row.user : isRecord(row.group) ? row.group : undefined;
            return Boolean(grantee && nonEmptyString(grantee.id) && isRecord(row.capabilities));
          },
        );
        evidence.push({
          name: `${root.kind} ${root.id} permissions`, sourceId: `${root.sourceId}:permissions`, parentSourceId: root.sourceId,
          payload: permissions.body, mediaType: 'application/json', evidenceClass: 'governance_evidence', documentationIds: [TABLEAU_DOCUMENTATION[3]],
        });
      } catch (error) {
        permissionGaps.push(`${tableauValidationMessage(error, `Tableau ${root.kind} ${root.id} permissions returned malformed HTTP-200 evidence.`)} Permissions were not trusted.`);
      }
    } else {
      permissionGaps.push(`Tableau ${root.kind} ${root.id} permissions could not be verified.`);
    }
    if (connections.status === 200) {
      try {
        validateTableauObjectRows(
          connections.body,
          'connections',
          'connection',
          `${root.kind} ${root.id} connections`,
          (row) => Boolean(nonEmptyString(row.id)),
        );
        evidence.push({
          name: `${root.kind} ${root.id} connections`, sourceId: `${root.sourceId}:connections`, parentSourceId: root.sourceId,
          payload: connections.body, mediaType: 'application/json', evidenceClass: 'discovery_metadata', documentationIds: [root.kind === 'workbook' ? TABLEAU_DOCUMENTATION[1] : TABLEAU_DOCUMENTATION[2]],
        });
      } catch (error) {
        const gap = `${tableauValidationMessage(error, `Tableau ${root.kind} ${root.id} connections returned malformed HTTP-200 evidence.`)} Connection lineage was not trusted.`;
        governanceGaps.push(gap);
        warnings.push(gap);
      }
    } else {
      const gap = `Tableau ${root.kind} ${root.id} connection lineage could not be cross-checked through REST.`;
      governanceGaps.push(gap);
      warnings.push(gap);
    }
  }

  const [refreshTasks, subscriptions] = await Promise.all([
    requestOptionalJson({
      url: `${session.apiBase}/sites/${encodeURIComponent(session.siteId)}/tasks/extractRefreshes`,
      label: 'Tableau site extract refresh tasks', session, transport, totals, signal,
    }),
    collectTableauSubscriptions(session, transport, totals, signal),
  ]);
  if (refreshTasks.status === 200) {
    try {
      validateTableauObjectRows(
        refreshTasks.body,
        'tasks',
        'task',
        'site extract refresh tasks',
        (row) => isRecord(row.extractRefresh) && Boolean(nonEmptyString(row.extractRefresh.id)),
      );
      tableauPagination(refreshTasks.body);
      evidence.push({
        name: 'Tableau site extract refresh tasks', sourceId: `tableau:site:${session.siteId}:extract-refreshes`,
        payload: refreshTasks.body, mediaType: 'application/json', evidenceClass: 'governance_evidence', documentationIds: [TABLEAU_DOCUMENTATION[4]],
      });
    } catch (error) {
      const gap = `${tableauValidationMessage(error, 'Tableau extract refresh tasks returned malformed HTTP-200 evidence.')} Extract refresh governance was not trusted.`;
      governanceGaps.push(gap);
      warnings.push(gap);
    }
  } else {
    permissionGaps.push('Tableau extract refresh schedules could not be verified for the signed-in principal.');
  }
  if (subscriptions.status === 200) {
    evidence.push({
      name: 'Tableau site subscriptions', sourceId: `tableau:site:${session.siteId}:subscriptions`,
      payload: subscriptions.payload, mediaType: 'application/json', evidenceClass: 'governance_evidence', documentationIds: [TABLEAU_DOCUMENTATION[5]],
    });
    if (!subscriptions.complete) {
      const gap = subscriptions.integrityIssue
        ? `${subscriptions.integrityIssue} Subscription governance is incomplete.`
        : `Tableau subscriptions exceeded the ${TABLEAU_MAX_SUBSCRIPTION_ITEMS}-item safety bound or did not return terminal pagination evidence; subscription governance is incomplete.`;
      governanceGaps.push(gap);
      warnings.push(gap);
    }
  } else if (subscriptions.integrityIssue) {
    const gap = `${subscriptions.integrityIssue} Subscription governance was not trusted.`;
    governanceGaps.push(gap);
    warnings.push(gap);
  } else {
    permissionGaps.push('Tableau subscriptions could not be verified for the signed-in principal.');
  }
  return {
    evidence,
    permissionGaps,
    governanceGaps,
    warnings,
    truncated: subscriptions.truncated,
    pagesFetched: subscriptions.pagesFetched,
  };
}

function optionalProvenance(item: TableauOptionalEvidence): MigrationSourceArtifactProvenance {
  const payload = safeJson(item.payload);
  return {
    id: item.sourceId,
    name: item.name,
    sourceId: item.sourceId,
    parentSourceId: item.parentSourceId,
    locator: item.sourceId,
    mediaType: item.mediaType,
    evidenceClass: item.evidenceClass,
    sha256: sha256(payload),
    sizeBytes: Buffer.byteLength(payload, 'utf8'),
    documentationIds: item.documentationIds,
    rawContentIncluded: false,
  };
}

function browserSafeInventory(inventory: MigrationInventory, evidenceContract: MigrationPreparedEvidenceResult['evidenceContract']): MigrationInventory {
  return {
    ...inventory,
    artifacts: [],
    sourceEvidence: evidenceContract,
    warnings: Array.from(new Set(inventory.warnings)),
  };
}

function dependencyEvidence(
  roots: TableauSelectedRoot[],
  definitions: TableauDefinitionArtifact[],
  permissionGaps: string[],
  governanceGaps: string[],
): MigrationSourceDependencyEvidence[] {
  const resolved = new Set(definitions.map((definition) => definition.root.sourceId));
  const dependencies: MigrationSourceDependencyEvidence[] = roots.map((root) => ({
    sourceId: root.sourceId,
    category: root.kind === 'workbook' ? 'content' : 'data_source',
    required: true,
    status: resolved.has(root.sourceId) ? 'resolved' : 'manual_required',
    reason: resolved.has(root.sourceId)
      ? `The selected Tableau ${root.kind} definition was downloaded without extracts and normalized server-side.`
      : `The selected Tableau ${root.kind} requires a TWB/TWBX or TDS/TDSX Manual File.`,
  }));
  if (permissionGaps.length > 0 || governanceGaps.length > 0) {
    dependencies.push({
      sourceId: 'tableau:governance:selected-scope',
      category: 'security',
      required: true,
      status: 'review_required',
      reason: [...permissionGaps, ...governanceGaps].join(' '),
    });
  }
  return dependencies;
}

export async function prepareTableauEvidence(context: MigrationSourceCollectorContext): Promise<MigrationPreparedEvidenceResult> {
  const roots = Array.from(new Set(context.selectedRootIds.map((value) => value.trim()).filter(Boolean))).map(parseTableauRoot);
  if (roots.length === 0) throw tableauError('Select at least one Tableau workbook or data source before preparing evidence.', 400);
  if (roots.length > MAX_SELECTED_ROOTS) throw tableauError(`Tableau evidence preparation accepts at most ${MAX_SELECTED_ROOTS} selected roots.`, 400);
  assertTableauConnection(context.connection);

  const totals: TableauCollectionTotals = { requestsMade: 0, bytesRead: 0, itemsObserved: 0 };
  const definitions: TableauDefinitionArtifact[] = [];
  const errors: string[] = [];
  const manualRequirements: string[] = [];
  const warnings: string[] = [];
  let permissionGaps: string[] = [];
  let governanceGaps: string[] = [];
  let optionalEvidence: TableauOptionalEvidence[] = [];
  let optionalEvidenceTruncated = false;
  let optionalPagesFetched = 0;
  const session = await tableauSignIn(context.connection, context.transport, totals, context.signal);
  try {
    context.registerSensitiveValue?.(session.token, 'Tableau sign-in');
    for (const root of roots) {
      try {
        const definition = await downloadTableauDefinition(root, session, context.transport, totals, context.signal);
        const nextTotal = definitions.reduce((sum, item) => sum + item.artifact.sizeBytes, 0) + definition.artifact.sizeBytes;
        if (nextTotal > MAX_TOTAL_DEFINITION_BYTES) {
          manualRequirements.push('The selected Tableau definitions exceeded the 180 MB aggregate safety limit. Narrow the saved scope or supply focused Manual Files.');
          break;
        }
        definitions.push(definition);
      } catch (error) {
        rethrowTableauCancellation(error);
        const message = error instanceof Error ? error.message : `Tableau ${root.kind} ${root.id} could not be collected.`;
        if ((error as { statusCode?: number })?.statusCode === 403 || (error as { statusCode?: number })?.statusCode === 422) {
          manualRequirements.push(message);
        } else {
          errors.push(message);
        }
      }
    }
    const optional = await collectTableauOptionalEvidence(roots, session, context.transport, totals, context.signal);
    optionalEvidence = optional.evidence;
    permissionGaps = optional.permissionGaps;
    governanceGaps = optional.governanceGaps;
    optionalEvidenceTruncated = optional.truncated;
    optionalPagesFetched = optional.pagesFetched;
    warnings.push(...optional.warnings);
  } finally {
    await tableauSignOut(session, context.transport, totals, context.signal);
  }

  const rawInventory = buildMigrationInventory('tableau', definitions.map((definition) => definition.artifact));
  const provenance = [...definitions.map((definition) => definition.provenance), ...optionalEvidence.map(optionalProvenance)];
  const dependencies = dependencyEvidence(roots, definitions, permissionGaps, governanceGaps);
  const missingDefinitionCount = roots.length - definitions.length;
  const manualRequired = missingDefinitionCount > 0 || manualRequirements.length > 0;
  const collectionTruncated = optionalEvidenceTruncated || manualRequirements.some((message) => message.includes('safety limit'));
  const acquisitionComplete = definitions.length === roots.length
    && !collectionTruncated
    && errors.length === 0
    && manualRequirements.length === 0;
  const partial = permissionGaps.length > 0 || governanceGaps.length > 0;
  const reportedManualRequirements = Array.from(new Set([
    ...manualRequirements,
    ...permissionGaps,
    ...governanceGaps,
  ]));
  const status: MigrationPreparedEvidenceStatus = manualRequired
    ? 'manual_required'
    : errors.length > 0
      ? 'failed'
      : collectionTruncated
        ? 'bounded'
        : partial
          ? 'partial'
          : 'complete';
  const evidenceContract: MigrationPreparedEvidenceResult['evidenceContract'] = {
    schemaVersion: 'omnikit.source-evidence.v2',
    sourceTool: 'tableau',
    parser: { name: 'Tableau REST XML and Metadata API collector', version: '1.0.0' },
    acquisition: { mode: 'api', runId: context.scopeFingerprint, selectedScopeIds: roots.map((root) => root.sourceId) },
    collection: {
      expectedArtifactCount: roots.length,
      observedArtifactCount: definitions.length,
      complete: acquisitionComplete,
      truncated: collectionTruncated,
      permissionGaps,
    },
    dependencyClosure: {
      status: manualRequired ? 'blocked' : permissionGaps.length > 0 || governanceGaps.length > 0 ? 'partial' : 'complete',
      resolvedCount: dependencies.filter((dependency) => dependency.status === 'resolved').length,
      missingCount: dependencies.filter((dependency) => dependency.status === 'missing' || dependency.status === 'manual_required').length,
      reviewCount: dependencies.filter((dependency) => dependency.status === 'review_required').length,
    },
    artifactFingerprints: provenance.map((artifact) => ({ name: artifact.name, sha256: artifact.sha256, sizeBytes: artifact.sizeBytes })),
    documentationIds: [...TABLEAU_DOCUMENTATION],
    diagnostics: [...warnings, ...reportedManualRequirements, ...errors],
  };
  const inventory = browserSafeInventory({
    ...rawInventory,
    warnings: [...rawInventory.warnings, ...warnings, ...reportedManualRequirements, ...errors],
  }, evidenceContract);
  return {
    schemaVersion: 'omnikit.prepared-source-evidence.v1',
    platform: 'tableau',
    connectionId: context.connection.id,
    connectionUpdatedAt: context.connection.updatedAt,
    selectedRootIds: roots.map((root) => root.sourceId),
    scopeFingerprint: context.scopeFingerprint,
    preparedAt: new Date().toISOString(),
    status,
    evidenceContract,
    inventory,
    artifacts: provenance,
    dependencies,
    diagnostics: {
      complete: acquisitionComplete,
      verifiedEmpty: false,
      truncated: evidenceContract.collection.truncated,
      requestsMade: totals.requestsMade,
      pagesFetched: optionalPagesFetched,
      itemsObserved: totals.itemsObserved,
      bytesRead: totals.bytesRead,
      limits: {
        maxRequests: 4 + roots.length * 3 + TABLEAU_MAX_SUBSCRIPTION_REQUEST_PAGES,
        maxPages: TABLEAU_MAX_SUBSCRIPTION_REQUEST_PAGES,
        maxItems: MAX_SELECTED_ROOTS + TABLEAU_MAX_SUBSCRIPTION_ITEMS,
        maxBytes: MAX_TOTAL_DEFINITION_BYTES,
      },
      permissionGaps,
      manualRequirements: reportedManualRequirements,
      errors,
      warnings,
    },
  };
}

export const tableauEvidenceCollector: MigrationSourceEvidenceCollector = {
  platform: 'tableau',
  prepareEvidence: prepareTableauEvidence,
};

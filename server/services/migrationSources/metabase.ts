import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { parseDocument } from 'yaml';
import type {
  MigrationDashboardEvidence,
  MigrationField,
  MigrationInventory,
  MigrationRelationship,
  MigrationSourceArtifactProvenance,
  MigrationSourceDependencyEvidence,
  MigrationView,
} from '../../../src/services/semanticMigration/types';
import type {
  MigrationPreparedEvidenceResult,
  MigrationSourceCollectorContext,
  MigrationSourceEvidenceCollector,
} from './contracts';

const METABASE_API_DOCUMENTATION = 'https://www.metabase.com/docs/latest/api-documentation';
const METABASE_API_KEY_DOCUMENTATION = 'https://www.metabase.com/docs/latest/people-and-groups/api-keys';
const METABASE_SERIALIZATION_DOCUMENTATION = 'https://www.metabase.com/docs/latest/installation-and-operation/serialization';
const METABASE_SERIALIZATION_PATH = '/api/ee/serialization/export';
const MAX_SELECTED_ROOTS = 200;
const MAX_DEPENDENCY_CARDS = 500;
const MAX_DEPENDENCY_DEPTH = 32;
const MAX_REQUESTS = 1_200;
const MAX_JSON_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_JSON_BYTES = 75 * 1024 * 1024;
const MAX_DISCOVERY_ITEMS = 2_000;
const MAX_SERIALIZATION_BYTES = 50 * 1024 * 1024;
const MAX_SERIALIZATION_EXPANDED_BYTES = 100 * 1024 * 1024;
const MAX_SERIALIZATION_FILE_BYTES = 10 * 1024 * 1024;
const MAX_SERIALIZATION_FILES = 5_000;
const MAX_SERIALIZATION_DIAGNOSTICS = 100;
const REQUEST_DEADLINE_MS = 30_000;

type JsonRecord = Record<string, unknown>;
type RootKind = 'dashboard' | 'card' | 'table' | 'collection';

interface RootScope {
  dashboards: string[];
  cards: string[];
  tables: string[];
  collections: string[];
}

interface CollectionStats {
  requestsMade: number;
  bytesRead: number;
  permissionGaps: string[];
  warnings: string[];
  errors: string[];
}

type MetabaseSerializationModel = 'Collection' | 'Card' | 'Dashboard';

interface MetabaseSerializationEntity {
  path: string;
  model: MetabaseSerializationModel;
  id: string;
  value: JsonRecord;
  sha256: string;
  sizeBytes: number;
}

interface MetabaseSerializationParseResult {
  entities: MetabaseSerializationEntity[];
  unsupported: string[];
}

export interface MetabaseDiscoveryItem {
  id: string;
  name: string;
  kind: 'data_source' | 'dataset' | 'report' | 'dashboard' | 'project';
  parentId?: string;
  updatedAt?: string;
  dependencyIds: string[];
  metadata: Record<string, string | number | boolean | null>;
}

export interface MetabaseDiscoveryResult {
  platform: 'metabase';
  connectionId: string;
  connectionUpdatedAt: string;
  items: MetabaseDiscoveryItem[];
  complete: boolean;
  truncated: boolean;
  requestsMade: number;
  pagesFetched: number;
  bytesRead: number;
  warnings: string[];
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value)
    ? value.filter((item): item is JsonRecord => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];
}

function stringValue(...values: unknown[]): string {
  const value = values.find((item) => typeof item === 'string' && item.trim());
  return typeof value === 'string' ? value.trim() : '';
}

function identifier(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return stringValue(value);
}

function contentIdentifier(value: JsonRecord): string {
  return identifier(value.id || value.entity_id || value.entityId);
}

function portableEntityId(value: JsonRecord): string {
  return identifier(value.entity_id || value.entityId);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort();
}

function canonicalize(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(Object.entries(item as JsonRecord)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, normalize(child)]));
  };
  return JSON.stringify(normalize(value));
}

function jsonFingerprint(value: unknown): { sha256: string; sizeBytes: number } {
  const normalized = canonicalize(value);
  const sizeBytes = Buffer.byteLength(normalized, 'utf8');
  if (sizeBytes > MAX_JSON_BYTES) {
    throw Object.assign(new Error('A selected Metabase definition exceeded the 10 MB normalized evidence limit.'), { statusCode: 413 });
  }
  return { sha256: createHash('sha256').update(normalized).digest('hex'), sizeBytes };
}

function byteFingerprint(value: Uint8Array): { sha256: string; sizeBytes: number } {
  return { sha256: createHash('sha256').update(value).digest('hex'), sizeBytes: value.byteLength };
}

function serializationFormatError(message: string): Error & { serializationUnsupported: true } {
  return Object.assign(new Error(message), { serializationUnsupported: true as const });
}

function decodeUtf8(value: Uint8Array, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    throw serializationFormatError(`${label} was not valid UTF-8.`);
  }
}

function tarText(header: Uint8Array, start: number, length: number): string {
  const field = header.subarray(start, start + length);
  const terminator = field.indexOf(0);
  return decodeUtf8(terminator >= 0 ? field.subarray(0, terminator) : field, 'A Metabase serialization TAR header');
}

function tarOctal(header: Uint8Array, start: number, length: number, label: string): number {
  const raw = tarText(header, start, length).trim();
  if (!raw) return 0;
  if (!/^[0-7]+$/.test(raw)) throw serializationFormatError(`The Metabase serialization TAR used an unsupported ${label} encoding.`);
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw serializationFormatError(`The Metabase serialization TAR contained an invalid ${label}.`);
  return value;
}

function validateTarChecksum(header: Uint8Array): void {
  const expected = tarOctal(header, 148, 8, 'checksum');
  let actual = 0;
  for (let index = 0; index < header.byteLength; index += 1) {
    actual += index >= 148 && index < 156 ? 32 : header[index]!;
  }
  if (actual !== expected) throw serializationFormatError('The Metabase serialization TAR failed its header checksum.');
}

function safeArchivePath(raw: string): string {
  const hasControlCharacter = Array.from(raw).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (!raw || raw.length > 1_024 || raw.startsWith('/') || raw.includes('\\') || hasControlCharacter) {
    throw serializationFormatError('The Metabase serialization TAR contained an unsafe entry path.');
  }
  const parts = raw.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw serializationFormatError('The Metabase serialization TAR contained an unsafe entry path.');
  }
  return parts.join('/');
}

function parsePaxPath(value: Uint8Array): string | undefined {
  let offset = 0;
  let path: string | undefined;
  while (offset < value.byteLength) {
    let separator = offset;
    while (separator < value.byteLength && value[separator] !== 0x20) separator += 1;
    if (separator >= value.byteLength) throw serializationFormatError('The Metabase serialization TAR contained malformed PAX metadata.');
    const lengthText = decodeUtf8(value.subarray(offset, separator), 'Metabase serialization PAX record length');
    if (!/^[0-9]+$/.test(lengthText)) throw serializationFormatError('The Metabase serialization TAR contained malformed PAX metadata.');
    const recordLength = Number.parseInt(lengthText, 10);
    const recordEnd = offset + recordLength;
    if (!Number.isSafeInteger(recordLength) || recordLength <= separator - offset + 1 || recordEnd > value.byteLength || value[recordEnd - 1] !== 0x0a) {
      throw serializationFormatError('The Metabase serialization TAR contained malformed PAX metadata.');
    }
    const record = decodeUtf8(value.subarray(separator + 1, recordEnd - 1), 'Metabase serialization PAX record');
    const equals = record.indexOf('=');
    if (equals > 0 && record.slice(0, equals) === 'path') path = record.slice(equals + 1);
    offset = recordEnd;
  }
  return path;
}

function serializationYamlEntries(compressed: Uint8Array): Array<{ path: string; body: Uint8Array }> {
  if (compressed.byteLength < 2 || compressed[0] !== 0x1f || compressed[1] !== 0x8b) {
    throw serializationFormatError('The Metabase serialization endpoint returned a response that was not a GZIP-compressed TAR archive.');
  }
  let expanded: Buffer;
  try {
    expanded = gunzipSync(Buffer.from(compressed), { maxOutputLength: MAX_SERIALIZATION_EXPANDED_BYTES });
  } catch (error) {
    if (asRecord(error).code === 'ERR_BUFFER_TOO_LARGE') {
      throw Object.assign(new Error('The Metabase serialization archive exceeded the 100 MB expanded-content safety bound.'), { statusCode: 413 });
    }
    throw serializationFormatError('The Metabase serialization endpoint returned an invalid or unsupported GZIP archive.');
  }
  if (expanded.byteLength > MAX_SERIALIZATION_EXPANDED_BYTES) {
    throw Object.assign(new Error('The Metabase serialization archive exceeded the 100 MB expanded-content safety bound.'), { statusCode: 413 });
  }
  const entries: Array<{ path: string; body: Uint8Array }> = [];
  const entryPaths = new Set<string>();
  let offset = 0;
  let pendingPath: string | undefined;
  let headersSeen = 0;
  let terminated = false;
  while (offset + 512 <= expanded.byteLength) {
    const header = expanded.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      terminated = true;
      break;
    }
    headersSeen += 1;
    if (headersSeen > MAX_SERIALIZATION_FILES * 2) {
      throw Object.assign(new Error('The Metabase serialization archive exceeded the TAR-entry safety bound.'), { statusCode: 413 });
    }
    validateTarChecksum(header);
    const name = tarText(header, 0, 100);
    const prefix = tarText(header, 345, 155);
    const headerPath = prefix ? `${prefix}/${name}` : name;
    const size = tarOctal(header, 124, 12, 'entry size');
    if (size > MAX_SERIALIZATION_FILE_BYTES) {
      throw Object.assign(new Error('A Metabase serialization file exceeded the 10 MB per-file safety bound.'), { statusCode: 413 });
    }
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > expanded.byteLength) throw serializationFormatError('The Metabase serialization TAR ended inside an entry.');
    const type = String.fromCharCode(header[156] || 0);
    const body = expanded.subarray(dataStart, dataEnd);
    if (type === 'x') {
      pendingPath = parsePaxPath(body) || pendingPath;
    } else if (type === 'g') {
      parsePaxPath(body);
    } else if (type === 'L') {
      pendingPath = decodeUtf8(body, 'A Metabase serialization TAR long path').replace(/\0+$/, '');
    } else if (type === '5') {
      safeArchivePath(pendingPath || headerPath);
      pendingPath = undefined;
    } else if (type === '\0' || type === '0') {
      const path = safeArchivePath(pendingPath || headerPath);
      pendingPath = undefined;
      if (entryPaths.has(path)) throw serializationFormatError(`The Metabase serialization TAR contained duplicate entry path ${path}.`);
      entryPaths.add(path);
      entries.push({ path, body });
      if (entries.length > MAX_SERIALIZATION_FILES) {
        throw Object.assign(new Error(`The Metabase serialization archive exceeded the ${MAX_SERIALIZATION_FILES}-file safety bound.`), { statusCode: 413 });
      }
    } else {
      throw serializationFormatError(`The Metabase serialization TAR contained unsupported entry type ${JSON.stringify(type)}.`);
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  if (!terminated || pendingPath || !expanded.subarray(offset).every((byte) => byte === 0)) {
    throw serializationFormatError('The Metabase serialization TAR did not terminate cleanly.');
  }
  return entries;
}

function serializationModel(value: JsonRecord): { model: string; metaId: string; valid: boolean } {
  const rawMetadata = value['serdes/meta'];
  const metadata = records(rawMetadata);
  const terminal = metadata[metadata.length - 1] || {};
  const valid = Array.isArray(rawMetadata)
    && metadata.length === rawMetadata.length
    && metadata.length > 0
    && metadata.every((entry) => stringValue(entry.model) && identifier(entry.id));
  return { model: stringValue(terminal.model), metaId: identifier(terminal.id), valid };
}

function parseMetabaseSerialization(compressed: Uint8Array): MetabaseSerializationParseResult {
  const entities: MetabaseSerializationEntity[] = [];
  const unsupported: string[] = [];
  const entityKeys = new Set<string>();
  const noteUnsupported = (message: string): void => {
    if (unsupported.length < MAX_SERIALIZATION_DIAGNOSTICS) unsupported.push(message);
  };
  const archiveEntries = serializationYamlEntries(compressed);
  const yamlEntries = archiveEntries.filter((entry) => /\.ya?ml$/i.test(entry.path));
  archiveEntries
    .filter((entry) => !/\.ya?ml$/i.test(entry.path))
    .forEach((entry) => noteUnsupported(`Serialization archive entry ${entry.path} was not YAML and was not trusted as migration evidence.`));
  for (const entry of yamlEntries) {
    const parts = entry.path.split('/');
    const collectionsIndex = parts.indexOf('collections');
    if (collectionsIndex < 0 || collectionsIndex > 1 || parts.length <= collectionsIndex + 2) {
      noteUnsupported(`Serialization file ${entry.path} was outside a recognized collections namespace and was not trusted as migration evidence.`);
      continue;
    }
    let value: JsonRecord;
    try {
      const document = parseDocument(decodeUtf8(entry.body, `Serialization file ${entry.path}`), {
        prettyErrors: false,
        strict: true,
        uniqueKeys: true,
      });
      if (document.errors.length > 0) {
        noteUnsupported(`Serialization file ${entry.path} was not valid unique-key YAML.`);
        continue;
      }
      value = asRecord(document.toJS({ maxAliasCount: 50 }));
    } catch {
      noteUnsupported(`Serialization file ${entry.path} could not be parsed safely as YAML.`);
      continue;
    }
    const id = identifier(value.entity_id);
    const { model, metaId, valid: validMetadata } = serializationModel(value);
    if (!id || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || metaId !== id || !validMetadata) {
      noteUnsupported(`Serialization file ${entry.path} did not contain matching, valid entity_id and serdes/meta IDs.`);
      continue;
    }
    if (model !== 'Collection' && model !== 'Card' && model !== 'Dashboard') {
      noteUnsupported(`Serialization entity ${id} uses unsupported model ${model || 'unknown'} and requires Manual Files review.`);
      continue;
    }
    if (!stringValue(value.name)) {
      noteUnsupported(`Serialization ${model} ${id} did not contain its required name.`);
      continue;
    }
    if ((model === 'Card' || model === 'Dashboard') && !stringValue(value.creator_id)) {
      noteUnsupported(`Serialization ${model} ${id} did not contain its required creator reference.`);
      continue;
    }
    if (model === 'Card' && (
      !stringValue(value.display)
      || Object.keys(asRecord(value.dataset_query)).length === 0
      || !Object.prototype.hasOwnProperty.call(value, 'visualization_settings')
      || !value.visualization_settings
      || typeof value.visualization_settings !== 'object'
      || Array.isArray(value.visualization_settings)
    )) {
      noteUnsupported(`Serialization Card ${id} did not match the documented Card query shape.`);
      continue;
    }
    if (model === 'Card' && Object.prototype.hasOwnProperty.call(value, 'parameters') && !Array.isArray(value.parameters)) {
      noteUnsupported(`Serialization Card ${id} did not contain the documented parameters array shape.`);
      continue;
    }
    if (model === 'Dashboard' && ['parameters', 'tabs', 'dashcards'].some((key) => (
      Object.prototype.hasOwnProperty.call(value, key) && !Array.isArray(value[key])
    ))) {
      noteUnsupported(`Serialization Dashboard ${id} did not contain documented dashboard array shapes.`);
      continue;
    }
    const entityKey = `${model}:${id}`;
    if (entityKeys.has(entityKey)) {
      const existing = entities.findIndex((entity) => `${entity.model}:${entity.id}` === entityKey);
      if (existing >= 0) entities.splice(existing, 1);
      noteUnsupported(`Serialization entity ${entityKey} appeared more than once and was not trusted as unambiguous migration evidence.`);
      continue;
    }
    entityKeys.add(entityKey);
    const digest = byteFingerprint(entry.body);
    entities.push({ path: entry.path, model, id, value, ...digest });
  }
  if (yamlEntries.length === 0) noteUnsupported('The serialization archive did not contain YAML files.');
  if (entities.length === 0) noteUnsupported('The serialization archive did not contain any supported Collection, Card, or Dashboard entities.');
  return { entities, unsupported: unique(unsupported) };
}

function metabaseBase(raw: string): string {
  const url = new URL(raw);
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/api$/i, '');
  return url.toString().replace(/\/+$/, '');
}

function parseScope(selectedRootIds: readonly string[]): RootScope {
  if (selectedRootIds.length === 0) throw Object.assign(new Error('Select at least one Metabase dashboard, question, table, or collection.'), { statusCode: 400 });
  if (selectedRootIds.length > MAX_SELECTED_ROOTS) throw Object.assign(new Error(`Select ${MAX_SELECTED_ROOTS} or fewer Metabase roots.`), { statusCode: 400 });
  const scope: RootScope = { dashboards: [], cards: [], tables: [], collections: [] };
  selectedRootIds.forEach((raw) => {
    const value = raw.trim();
    if (!value) return;
    const separator = value.indexOf(':');
    const kind = separator > 0 ? value.slice(0, separator).toLowerCase() : 'dashboard';
    const id = separator > 0 ? value.slice(separator + 1).trim() : value;
    if (!id || id.length > 300) throw Object.assign(new Error('A Metabase source identifier is invalid.'), { statusCode: 400 });
    if (kind === 'dashboard') scope.dashboards.push(id);
    else if (kind === 'card' || kind === 'question' || kind === 'model') scope.cards.push(id);
    else if (kind === 'table') scope.tables.push(id);
    else if (kind === 'collection') scope.collections.push(id);
    else throw Object.assign(new Error(`Unsupported Metabase source kind: ${kind}.`), { statusCode: 400 });
  });
  scope.dashboards = unique(scope.dashboards);
  scope.cards = unique(scope.cards);
  scope.tables = unique(scope.tables);
  scope.collections = unique(scope.collections);
  return scope;
}

async function requestJson(
  context: MigrationSourceCollectorContext,
  stats: CollectionStats,
  url: string,
  label: string,
  allowStatuses: readonly number[] = [200],
): Promise<{ status: number; body: unknown }> {
  if (stats.requestsMade >= MAX_REQUESTS) {
    throw Object.assign(new Error(`Metabase evidence collection reached the ${MAX_REQUESTS}-request safety bound.`), { statusCode: 413 });
  }
  const response = await context.transport.request<string>({
    url,
    method: 'GET',
    headers: { Accept: 'application/json', 'X-API-KEY': context.connection.credential || '' },
    responseType: 'text',
    label,
    allowStatuses,
    maxResponseBytes: MAX_JSON_BYTES,
    deadlineMs: REQUEST_DEADLINE_MS,
    signal: context.signal,
  });
  stats.requestsMade += response.requestCount;
  stats.bytesRead += response.bytesRead;
  if (stats.bytesRead > MAX_TOTAL_JSON_BYTES) {
    throw Object.assign(new Error('Metabase API evidence exceeded the 75 MB aggregate JSON response limit.'), { statusCode: 413 });
  }
  if (response.status !== 200) return { status: response.status, body: {} };
  try {
    return { status: response.status, body: response.body.trim() ? JSON.parse(response.body) as unknown : {} };
  } catch {
    throw Object.assign(new Error(`${label} returned an unrecognized non-JSON success response.`), { statusCode: 502 });
  }
}

function discoveryRows(value: unknown, ...keys: string[]): JsonRecord[] {
  if (Array.isArray(value)) return records(value);
  const root = asRecord(value);
  const containers = [root, asRecord(root.data), asRecord(root.result)];
  for (const container of containers) {
    for (const key of keys) if (Array.isArray(container[key])) return records(container[key]);
  }
  return [];
}

/**
 * Bounded Metabase catalog discovery. Results carry stable selection IDs and
 * dependency hints only; selected API definitions are reacquired by the
 * prepared-evidence path before Analyze.
 */
export async function discoverMetabaseSource(context: MigrationSourceCollectorContext): Promise<MetabaseDiscoveryResult> {
  const { connection } = context;
  if (connection.platform !== 'metabase' || connection.authMode !== 'api_key' || !connection.credential) {
    throw Object.assign(new Error('The Metabase discovery helper requires a saved API-key connection.'), { statusCode: 409 });
  }
  const base = metabaseBase(connection.baseUrl);
  const stats: CollectionStats = { requestsMade: 0, bytesRead: 0, permissionGaps: [], warnings: [], errors: [] };
  const catalogs: Array<{
    path: string;
    label: string;
    keys: string[];
    kind: MetabaseDiscoveryItem['kind'];
    prefix: string;
  }> = [
    { path: '/api/database', label: 'Metabase database catalog', keys: ['data', 'databases'], kind: 'data_source', prefix: 'database' },
    { path: '/api/table', label: 'Metabase table catalog', keys: ['data', 'tables'], kind: 'dataset', prefix: 'table' },
    { path: '/api/card', label: 'Metabase question catalog', keys: ['data', 'cards'], kind: 'report', prefix: 'card' },
    { path: '/api/dashboard', label: 'Metabase dashboard catalog', keys: ['data', 'dashboards'], kind: 'dashboard', prefix: 'dashboard' },
    { path: '/api/collection', label: 'Metabase collection catalog', keys: ['data', 'collections'], kind: 'project', prefix: 'collection' },
  ];
  const items: MetabaseDiscoveryItem[] = [];
  let truncated = false;
  for (const catalog of catalogs) {
    const response = await requestJson(context, stats, `${base}${catalog.path}`, catalog.label, [200, 400, 401, 403, 404]);
    if (response.status !== 200) {
      const message = `${catalog.label} was unavailable with status ${response.status}.`;
      if (response.status === 401 || response.status === 403) stats.permissionGaps.push(message);
      else stats.errors.push(message);
      continue;
    }
    const rows = discoveryRows(response.body, ...catalog.keys);
    for (const row of rows) {
      const id = identifier(row.id);
      if (!id) {
        stats.warnings.push(`${catalog.label} returned an item without a stable ID; it was excluded from selection.`);
        continue;
      }
      const sourceId = `${catalog.prefix}:${id}`;
      const parentId = catalog.kind === 'dataset'
        ? identifier(row.db_id || row.database_id || row.databaseId)
        : catalog.kind === 'report' || catalog.kind === 'dashboard'
          ? identifier(row.collection_id || row.collectionId)
          : catalog.kind === 'project'
            ? identifier(row.parent_id || row.parentId)
            : '';
      const dependencies = catalog.kind === 'report'
        ? [...cardDependencyIds(row).map((cardId) => `card:${cardId}`), ...cardTableIds(row).map((tableId) => `table:${tableId}`)]
        : catalog.kind === 'dashboard'
          ? dashboardCardIds(row).map((cardId) => `card:${cardId}`)
          : [];
      items.push({
        id: sourceId,
        name: stringValue(row.name, row.display_name, row.title) || `${catalog.kind.replace('_', ' ')} ${id}`,
        kind: catalog.kind,
        parentId: parentId ? `${catalog.kind === 'dataset' ? 'database' : 'collection'}:${parentId}` : undefined,
        updatedAt: stringValue(row.updated_at, row.updatedAt, row.last_modified) || undefined,
        dependencyIds: unique(dependencies),
        metadata: Object.fromEntries([
          ['description', row.description],
          ['archived', row.archived],
          ['display', row.display],
          ['entityType', row.entity_type || row.entityType],
        ].flatMap(([key, value]) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null ? [[key, value] as const] : [])),
      });
      if (items.length >= MAX_DISCOVERY_ITEMS) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
  }
  if (truncated) stats.warnings.push(`Metabase catalog discovery reached the ${MAX_DISCOVERY_ITEMS}-item safety bound. Narrow the source scope before planning.`);
  const deduped = Array.from(new Map(items.map((item) => [item.id, item])).values()).sort((left, right) => left.id.localeCompare(right.id));
  return {
    platform: 'metabase',
    connectionId: connection.id,
    connectionUpdatedAt: connection.updatedAt,
    items: deduped,
    complete: !truncated && stats.permissionGaps.length === 0 && stats.errors.length === 0,
    truncated,
    requestsMade: stats.requestsMade,
    pagesFetched: stats.requestsMade,
    bytesRead: stats.bytesRead,
    warnings: unique([...stats.warnings, ...stats.permissionGaps, ...stats.errors]),
  };
}

function artifact(
  kind: RootKind,
  id: string,
  name: string,
  value: unknown,
  evidenceClass: MigrationSourceArtifactProvenance['evidenceClass'] = 'authoritative_definition',
): MigrationSourceArtifactProvenance {
  return {
    id: `metabase:${kind}:${id}`,
    name,
    sourceId: `metabase:${kind}:${id}`,
    locator: `${kind}:${id}`,
    mediaType: 'application/json',
    evidenceClass,
    ...jsonFingerprint(value),
    documentationIds: [METABASE_API_DOCUMENTATION],
    rawContentIncluded: false,
  };
}

function serializationArtifact(entity: MetabaseSerializationEntity): MigrationSourceArtifactProvenance {
  const kind = entity.model.toLowerCase();
  const sourceId = entity.model === 'Collection'
    ? `metabase:collection-entity:${entity.id}`
    : `metabase:${kind}:${entity.id}`;
  return {
    id: `metabase:serialization:${kind}:${entity.id}`,
    name: stringValue(entity.value.name) || `${entity.model} ${entity.id}`,
    sourceId,
    locator: `serialization:${entity.path}`,
    mediaType: 'application/yaml',
    evidenceClass: 'authoritative_definition',
    sha256: entity.sha256,
    sizeBytes: entity.sizeBytes,
    documentationIds: [METABASE_SERIALIZATION_DOCUMENTATION],
    rawContentIncluded: false,
  };
}

function normalizedArtifactBinding(provenance: MigrationSourceArtifactProvenance | undefined): {
  sourceArtifact?: string;
  sourceEvidence?: Array<{
    sourceId: string;
    artifactId: string;
    locator?: string;
    artifactSha256: string;
    role: 'direct';
  }>;
} {
  if (!provenance) return {};
  return {
    sourceArtifact: provenance.locator || provenance.id,
    sourceEvidence: [{
      sourceId: provenance.sourceId,
      artifactId: provenance.id,
      locator: provenance.locator,
      artifactSha256: provenance.sha256,
      role: 'direct',
    }],
  };
}

function dashcards(dashboard: JsonRecord): JsonRecord[] {
  return [...records(dashboard.dashcards), ...records(dashboard.ordered_cards), ...records(dashboard.cards)];
}

function dashboardCardIds(dashboard: JsonRecord): string[] {
  return unique(dashcards(dashboard).flatMap((item) => {
    const direct = asRecord(item.card);
    return [
      identifier(item.card_id || item.cardId || direct.id),
      ...records(item.series).map((series) => identifier(series.id || series.card_id || series.cardId)),
    ];
  }));
}

function cardTableIds(card: JsonRecord): string[] {
  const datasetQuery = asRecord(card.dataset_query || card.datasetQuery);
  const tableIdentifier = (value: unknown): string => Array.isArray(value)
    ? canonicalize(value)
    : identifier(value);
  const ids = new Set<string>();
  let scanned = 0;
  const add = (value: unknown): void => {
    const tableId = tableIdentifier(value);
    if (tableId && !tableId.startsWith('card__')) ids.add(tableId);
  };
  const visit = (value: unknown, depth: number): void => {
    if (depth > MAX_DEPENDENCY_DEPTH) throw Object.assign(new Error(`Metabase question ${contentIdentifier(card) || 'unknown'} table scanning exceeded the ${MAX_DEPENDENCY_DEPTH}-level safety bound.`), { statusCode: 413 });
    if (Array.isArray(value)) {
      value.forEach((child) => visit(child, depth + 1));
      return;
    }
    if (!value || typeof value !== 'object') return;
    scanned += 1;
    if (scanned > 10_000) throw Object.assign(new Error(`Metabase question ${contentIdentifier(card) || 'unknown'} table scanning exceeded the 10,000-record safety bound.`), { statusCode: 413 });
    Object.entries(value as JsonRecord).forEach(([key, child]) => {
      if (/^source[-_]table$/i.test(key)) add(child);
      visit(child, depth + 1);
    });
  };
  add(card.table_id);
  add(card.tableId);
  visit(datasetQuery, 0);
  return Array.from(ids).sort();
}

function cardDependencyIds(card: JsonRecord): string[] {
  const datasetQuery = asRecord(card.dataset_query || card.datasetQuery);
  const references = new Set<string>();
  let scanned = 0;
  const add = (value: unknown): void => {
    const text = identifier(value);
    const match = text.match(/^card__([A-Za-z0-9-]+)$/i);
    if (match?.[1]) references.add(match[1]);
  };
  const visit = (value: unknown, depth: number): void => {
    if (depth > MAX_DEPENDENCY_DEPTH) throw Object.assign(new Error(`Metabase question ${contentIdentifier(card) || 'unknown'} dependency scanning exceeded the ${MAX_DEPENDENCY_DEPTH}-level safety bound.`), { statusCode: 413 });
    if (Array.isArray(value)) {
      value.forEach((child) => visit(child, depth + 1));
      return;
    }
    if (typeof value === 'string') {
      add(value);
      for (const match of value.matchAll(/\bcard__([A-Za-z0-9-]+)\b/gi)) if (match[1]) references.add(match[1]);
      return;
    }
    if (!value || typeof value !== 'object') return;
    scanned += 1;
    if (scanned > 10_000) throw Object.assign(new Error(`Metabase question ${contentIdentifier(card) || 'unknown'} dependency scanning exceeded the 10,000-record safety bound.`), { statusCode: 413 });
    Object.entries(value as JsonRecord).forEach(([key, child]) => {
      if (/^(?:source-card|source_card|card_id|cardId)$/i.test(key)) {
        const id = identifier(child).replace(/^card__/i, '');
        if (id) references.add(id);
      }
      visit(child, depth + 1);
    });
  };
  visit(datasetQuery, 0);
  visit(card.parameters, 0);
  references.delete(contentIdentifier(card));
  return Array.from(references).sort();
}

function normalizedCardQuery(card: JsonRecord): { language: 'native_sql' | 'mbql'; expression: string } | undefined {
  const datasetQuery = asRecord(card.dataset_query || card.datasetQuery);
  const native = asRecord(datasetQuery.native);
  const nativeSql = stringValue(native.query, native.sql);
  if (nativeSql) return { language: 'native_sql', expression: nativeSql.replace(/\r\n?/g, '\n').trim() };
  const query = asRecord(datasetQuery.query);
  if (Object.keys(query).length > 0) return { language: 'mbql', expression: canonicalize(query) };
  const stages = records(datasetQuery.stages);
  for (const stage of stages) {
    const stageNative = typeof stage.native === 'string'
      ? stage.native
      : stringValue(asRecord(stage.native).query, asRecord(stage.native).sql);
    if (stageNative.trim()) return { language: 'native_sql', expression: stageNative.replace(/\r\n?/g, '\n').trim() };
  }
  if (stages.length > 0 && stringValue(datasetQuery['lib/type']).toLowerCase() === 'mbql/query') {
    return { language: 'mbql', expression: canonicalize(datasetQuery) };
  }
  return undefined;
}

function cardQueryView(card: JsonRecord, provenance?: MigrationSourceArtifactProvenance): MigrationView | undefined {
  const id = contentIdentifier(card);
  const query = normalizedCardQuery(card);
  if (!id || !query) return undefined;
  const datasetQuery = asRecord(card.dataset_query || card.datasetQuery);
  const mbql = asRecord(datasetQuery.query);
  const expressions = Object.entries(asRecord(mbql.expressions)).sort(([left], [right]) => left.localeCompare(right));
  const binding = normalizedArtifactBinding(provenance);
  return {
    sourceId: `metabase:card:${id}:query`,
    sourceLocator: `card:${id}/query`,
    name: stringValue(card.name, card.title) || `Question ${id}`,
    kind: 'query_view',
    sql: query.expression,
    annotations: { queryLanguage: query.language, cardId: id, queryDefinition: canonicalize(datasetQuery) },
    fields: expressions.map(([name, expression]): MigrationField => ({
      sourceId: `metabase:card:${id}:expression:${name}`,
      sourceLocator: `card:${id}/expression:${name}`,
      name,
      sql: canonicalize(expression),
      annotations: { queryLanguage: 'mbql_expression' },
      ...binding,
    })),
    measures: [],
    warnings: [],
    ...binding,
  };
}

function cardParameterNames(card: JsonRecord): string[] {
  const datasetQuery = asRecord(card.dataset_query || card.datasetQuery);
  const names: string[] = records(card.parameters)
    .map((parameter) => stringValue(parameter.name, parameter.slug, parameter.id))
    .filter(Boolean);
  const visit = (value: unknown, depth: number): void => {
    if (depth > MAX_DEPENDENCY_DEPTH) return;
    if (Array.isArray(value)) {
      value.forEach((child) => visit(child, depth + 1));
      return;
    }
    if (!value || typeof value !== 'object') return;
    Object.entries(value as JsonRecord).forEach(([key, child]) => {
      if (/^template[-_]tags$/i.test(key)) {
        names.push(...records(child).map((tag) => stringValue(tag.name, tag['display-name'], tag.display_name, tag.id)).filter(Boolean));
        if (child && typeof child === 'object' && !Array.isArray(child)) names.push(...Object.keys(child as JsonRecord));
      } else {
        visit(child, depth + 1);
      }
    });
  };
  visit(datasetQuery, 0);
  return unique(names);
}

function cardFields(card: JsonRecord): string[] {
  const datasetQuery = asRecord(card.dataset_query || card.datasetQuery);
  const query = asRecord(datasetQuery.query);
  const stages = records(datasetQuery.stages);
  const resultMetadata = records(card.result_metadata || card.resultMetadata);
  const namedMetadata = resultMetadata.map((field) => stringValue(field.display_name, field.name)).filter(Boolean);
  const fields = [query, ...stages].flatMap((stage) => Array.isArray(stage.fields) ? stage.fields : []);
  const breakouts = [query, ...stages].flatMap((stage) => Array.isArray(stage.breakout) ? stage.breakout : []);
  const aggregations = [query, ...stages].flatMap((stage) => Array.isArray(stage.aggregation) ? stage.aggregation : []);
  const expressionNames = [query, ...stages].flatMap((stage) => {
    const expressions = stage.expressions;
    if (Array.isArray(expressions)) return expressions.map((expression) => canonicalize(expression));
    return Object.keys(asRecord(expressions));
  });
  return unique([
    ...namedMetadata,
    ...fields.map((field) => typeof field === 'string' ? field : canonicalize(field)),
    ...breakouts.map((field) => typeof field === 'string' ? field : canonicalize(field)),
    ...aggregations.map((field) => typeof field === 'string' ? field : canonicalize(field)),
    ...expressionNames,
  ]).slice(0, 500);
}

function dashboardEvidence(
  dashboard: JsonRecord,
  cardMap: ReadonlyMap<string, JsonRecord>,
  provenance?: MigrationSourceArtifactProvenance,
): MigrationDashboardEvidence {
  const id = contentIdentifier(dashboard);
  const cards = dashcards(dashboard).flatMap((dashcard) => {
    const embedded = asRecord(dashcard.card);
    const cardId = identifier(dashcard.card_id || dashcard.cardId || embedded.id);
    return cardId && cardMap.has(cardId) ? [cardMap.get(cardId)!] : Object.keys(embedded).length > 0 ? [embedded] : [];
  });
  const parameters = [...records(dashboard.parameters), ...records(dashboard.filters)];
  const binding = normalizedArtifactBinding(provenance);
  return {
    sourceId: `metabase:dashboard:${id}`,
    sourceLocator: `dashboard:${id}`,
    name: stringValue(dashboard.name, dashboard.title) || `Dashboard ${id}`,
    fields: unique(cards.flatMap(cardFields)).slice(0, 500),
    filters: unique(parameters.map((parameter) => stringValue(parameter.name, parameter.slug, parameter.id)).filter(Boolean)),
    assetKind: 'dashboard',
    path: identifier(dashboard.collection_id || dashboard.collectionId) || undefined,
    updatedAt: stringValue(dashboard.updated_at, dashboard.updatedAt) || undefined,
    dependencyIds: dashboardCardIds(dashboard).map((cardId) => `metabase:card:${cardId}`),
    childIds: dashcards(dashboard).map((dashcard) => identifier(dashcard.entity_id || dashcard.entityId)).filter(Boolean),
    metadata: {
      metabaseDefinition: canonicalize({
        parameters: dashboard.parameters || [],
        tabs: dashboard.tabs || [],
        dashcards: dashboard.dashcards || dashboard.ordered_cards || dashboard.cards || [],
      }),
    },
    ...binding,
  };
}

function cardEvidence(card: JsonRecord, provenance?: MigrationSourceArtifactProvenance): MigrationDashboardEvidence {
  const id = contentIdentifier(card);
  const datasetQuery = asRecord(card.dataset_query || card.datasetQuery);
  const binding = normalizedArtifactBinding(provenance);
  return {
    sourceId: `metabase:card:${id}`,
    sourceLocator: `card:${id}`,
    name: stringValue(card.name, card.title) || `Question ${id}`,
    fields: cardFields(card),
    filters: cardParameterNames(card),
    assetKind: 'card',
    chartType: stringValue(card.display, card.visualization_type) || undefined,
    sourceDatasetId: cardTableIds(card)[0],
    path: identifier(card.collection_id || card.collectionId) || undefined,
    dependencyIds: [
      ...cardTableIds(card).map((tableId) => `metabase:table:${tableId}`),
      ...cardDependencyIds(card).map((cardId) => `metabase:card:${cardId}`),
    ],
    metadata: {
      metabaseCardType: stringValue(card.type) || null,
      metabaseQueryDefinition: canonicalize(datasetQuery),
      metabaseVisualizationSettings: canonicalize(asRecord(card.visualization_settings || card.visualizationSettings)),
    },
    ...binding,
  };
}

function tableView(table: JsonRecord, provenance?: MigrationSourceArtifactProvenance): MigrationView {
  const id = identifier(table.id);
  const binding = normalizedArtifactBinding(provenance);
  const fields = records(table.fields || table.columns).map((field): MigrationField => {
    const fieldId = identifier(field.id);
    return {
      sourceId: fieldId ? `metabase:field:${fieldId}` : undefined,
      sourceLocator: fieldId ? `field:${fieldId}` : undefined,
      name: stringValue(field.name, field.display_name) || `field_${fieldId || 'unknown'}`,
      label: stringValue(field.display_name) || undefined,
      type: stringValue(field.effective_type, field.base_type, field.type) || undefined,
      description: stringValue(field.description) || undefined,
      hidden: typeof field.visibility_type === 'string' ? field.visibility_type !== 'normal' : undefined,
      primaryKey: field.semantic_type === 'type/PK',
      ...binding,
    };
  });
  return {
    sourceId: `metabase:table:${id}`,
    sourceLocator: `table:${id}`,
    name: stringValue(table.name, table.display_name) || `Table ${id}`,
    label: stringValue(table.display_name) || undefined,
    description: stringValue(table.description) || undefined,
    kind: 'dataset',
    fields,
    measures: [],
    warnings: [],
    ...binding,
  };
}

function tableRelationships(
  tables: readonly JsonRecord[],
  artifactsBySourceId: ReadonlyMap<string, MigrationSourceArtifactProvenance>,
): MigrationRelationship[] {
  const fields = new Map<string, { tableId: string; name: string }>();
  tables.forEach((table) => records(table.fields || table.columns).forEach((field) => {
    const fieldId = identifier(field.id);
    if (fieldId) fields.set(fieldId, { tableId: identifier(table.id), name: stringValue(field.name, field.display_name) });
  }));
  return tables.flatMap((table) => records(table.fields || table.columns).flatMap((field): MigrationRelationship[] => {
    const target = fields.get(identifier(field.fk_target_field_id || field.fkTargetFieldId));
    if (!target) return [];
    const fromId = identifier(table.id);
    const fieldName = stringValue(field.name, field.display_name);
    const binding = normalizedArtifactBinding(artifactsBySourceId.get(`metabase:table:${fromId}`));
    return [{
      sourceId: `metabase:relationship:${fromId}:${identifier(field.id)}:${target.tableId}`,
      sourceLocator: `table:${fromId}/field:${identifier(field.id)}`,
      from: stringValue(table.name, table.display_name) || fromId,
      to: target.tableId,
      joinType: 'many_to_one',
      relationshipType: 'foreign_key',
      sql: fieldName && target.name ? `${fieldName} = ${target.name}` : undefined,
      ...binding,
    }];
  }));
}

export async function prepareMetabaseEvidence(context: MigrationSourceCollectorContext): Promise<MigrationPreparedEvidenceResult> {
  const { connection } = context;
  if (connection.platform !== 'metabase') throw Object.assign(new Error('The Metabase collector requires a Metabase connection.'), { statusCode: 400 });
  if (connection.authMode !== 'api_key' || !connection.credential) {
    throw Object.assign(new Error('Metabase Saved API requires an API key.'), { statusCode: 409 });
  }
  const scope = parseScope(context.selectedRootIds);
  const base = metabaseBase(connection.baseUrl);
  const stats: CollectionStats = { requestsMade: 0, bytesRead: 0, permissionGaps: [], warnings: [], errors: [] };
  const artifacts: MigrationSourceArtifactProvenance[] = [];
  const dependencies: MigrationSourceDependencyEvidence[] = [];
  const dashboards = new Map<string, JsonRecord>();
  const cards = new Map<string, JsonRecord>();
  const tables = new Map<string, JsonRecord>();
  const pendingCards: Array<{ id: string; depth: number }> = [];
  const queuedCardDepth = new Map<string, number>();
  const enqueueCard = (id: string, depth: number): void => {
    if (!id) return;
    if (depth > MAX_DEPENDENCY_DEPTH) throw Object.assign(new Error(`Metabase nested-question closure exceeded the ${MAX_DEPENDENCY_DEPTH}-level safety bound.`), { statusCode: 413 });
    const previous = queuedCardDepth.get(id);
    if (previous !== undefined && previous <= depth) return;
    queuedCardDepth.set(id, depth);
    pendingCards.push({ id, depth });
    if (queuedCardDepth.size > MAX_DEPENDENCY_CARDS) throw Object.assign(new Error(`Metabase nested-question closure exceeded the ${MAX_DEPENDENCY_CARDS}-question safety bound.`), { statusCode: 413 });
  };
  scope.cards.forEach((id) => enqueueCard(id, 0));

  for (const dashboardId of scope.dashboards) {
    const response = await requestJson(context, stats, `${base}/api/dashboard/${encodeURIComponent(dashboardId)}`, 'Metabase dashboard definition', [200, 403, 404]);
    if (response.status !== 200) {
      stats.permissionGaps.push(`Dashboard ${dashboardId} was not accessible through the configured API key.`);
      dependencies.push({ sourceId: `metabase:dashboard:${dashboardId}`, category: 'content', required: true, status: 'missing', reason: 'The selected dashboard definition was unavailable.' });
      continue;
    }
    const dashboard = asRecord(response.body);
    dashboards.set(dashboardId, dashboard);
    artifacts.push(artifact('dashboard', dashboardId, stringValue(dashboard.name) || `Dashboard ${dashboardId}`, dashboard));
    dependencies.push({ sourceId: `metabase:dashboard:${dashboardId}`, category: 'content', required: true, status: 'resolved', reason: 'The selected dashboard definition was acquired from the documented API.' });
    dashboardCardIds(dashboard).forEach((cardId) => enqueueCard(cardId, 1));
  }

  const attemptedCardIds = new Set<string>();
  while (pendingCards.length > 0) {
    const { id: cardId, depth } = pendingCards.shift()!;
    if (attemptedCardIds.has(cardId)) continue;
    attemptedCardIds.add(cardId);
    const response = await requestJson(context, stats, `${base}/api/card/${encodeURIComponent(cardId)}`, 'Metabase question definition', [200, 403, 404]);
    if (response.status !== 200) {
      stats.permissionGaps.push(`Question ${cardId} was not accessible through the configured API key.`);
      dependencies.push({ sourceId: `metabase:card:${cardId}`, category: 'content', required: true, status: 'missing', reason: 'The selected, dashboard-linked, or nested question definition was unavailable.' });
      continue;
    }
    const card = asRecord(response.body);
    cards.set(cardId, card);
    cardDependencyIds(card).forEach((dependencyId) => enqueueCard(dependencyId, depth + 1));
  }
  dashboards.forEach((dashboard, dashboardId) => dashboardCardIds(dashboard).forEach((cardId) => dependencies.push({
    sourceId: `metabase:dashboard:${dashboardId}`,
    dependencySourceId: `metabase:card:${cardId}`,
    category: 'content',
    required: true,
    status: cards.has(cardId) ? 'resolved' : 'missing',
    reason: cards.has(cardId) ? 'The dashboard-linked question definition was acquired.' : 'The dashboard-linked question definition was not acquired.',
  })));
  cards.forEach((card, cardId) => {
    artifacts.push(artifact('card', cardId, stringValue(card.name) || `Question ${cardId}`, card));
    dependencies.push({ sourceId: `metabase:card:${cardId}`, category: 'content', required: true, status: 'resolved', reason: 'The question and its MBQL or native-query definition were acquired from the documented API.' });
    cardDependencyIds(card).forEach((dependencyId) => dependencies.push({ sourceId: `metabase:card:${cardId}`, dependencySourceId: `metabase:card:${dependencyId}`, category: 'content', required: true, status: cards.has(dependencyId) ? 'resolved' : 'missing', reason: cards.has(dependencyId) ? 'The nested question definition was acquired.' : 'The nested question definition was not acquired.' }));
    scope.tables.push(...cardTableIds(card));
  });

  for (const tableId of unique(scope.tables)) {
    const response = await requestJson(context, stats, `${base}/api/table/${encodeURIComponent(tableId)}/query_metadata`, 'Metabase table query metadata', [200, 403, 404]);
    if (response.status !== 200) {
      stats.permissionGaps.push(`Table ${tableId} query metadata was not accessible through the configured API key.`);
      dependencies.push({ sourceId: `metabase:table:${tableId}`, category: 'data_source', required: true, status: 'missing', reason: 'The selected or question-linked table metadata was unavailable.' });
      continue;
    }
    const table = asRecord(response.body);
    tables.set(tableId, table);
    artifacts.push(artifact('table', tableId, stringValue(table.name, table.display_name) || `Table ${tableId}`, table));
    dependencies.push({ sourceId: `metabase:table:${tableId}`, category: 'data_source', required: true, status: 'resolved', reason: 'Table and field metadata were acquired from the documented API.' });
  }
  cards.forEach((card, cardId) => cardTableIds(card).forEach((tableId) => dependencies.push({
    sourceId: `metabase:card:${cardId}`,
    dependencySourceId: `metabase:table:${tableId}`,
    category: 'data_source',
    required: true,
    status: tables.has(tableId) ? 'resolved' : 'missing',
    reason: tables.has(tableId) ? 'The question-linked table and field metadata were acquired.' : 'The question-linked table and field metadata were not acquired.',
  })));

  let serializationCaptured = false;
  let serializationParsed = false;
  let serializationUnsupported: string[] = [];
  let serializedCollectionCount = 0;
  if (scope.collections.length > 0) {
    if (stats.requestsMade >= MAX_REQUESTS) throw Object.assign(new Error(`Metabase evidence collection reached the ${MAX_REQUESTS}-request safety bound.`), { statusCode: 413 });
    const url = new URL(`${base}${METABASE_SERIALIZATION_PATH}`);
    scope.collections.forEach((collectionId) => url.searchParams.append('collection', collectionId));
    url.searchParams.set('settings', 'false');
    url.searchParams.set('data_model', 'false');
    const response = await context.transport.request<Uint8Array>({
      url: url.toString(),
      method: 'POST',
      headers: { Accept: 'application/gzip', 'X-API-KEY': connection.credential },
      responseType: 'bytes',
      label: 'Metabase selected-collection serialization export',
      allowStatuses: [200, 400, 403, 404, 405, 422, 501],
      maxResponseBytes: MAX_SERIALIZATION_BYTES,
      deadlineMs: REQUEST_DEADLINE_MS,
      signal: context.signal,
    });
    stats.requestsMade += response.requestCount;
    stats.bytesRead += response.bytesRead;
    if (response.status === 200 && response.body instanceof Uint8Array && response.body.byteLength > 0) {
      const digest = byteFingerprint(response.body);
      artifacts.push({
        id: `metabase:serialization:${context.scopeFingerprint}`,
        name: 'Selected Metabase collection serialization',
        sourceId: `metabase:serialization:${context.scopeFingerprint}`,
        locator: `serialization:${scope.collections.join(',')}`,
        mediaType: 'application/gzip',
        evidenceClass: 'authoritative_definition',
        ...digest,
        documentationIds: [METABASE_SERIALIZATION_DOCUMENTATION],
        rawContentIncluded: false,
      });
      serializationCaptured = true;
      try {
        const parsed = parseMetabaseSerialization(response.body);
        serializationUnsupported = parsed.unsupported;
        const serializedCollectionIds = new Set(parsed.entities
          .filter((entity) => entity.model === 'Collection')
          .map((entity) => entity.id));
        serializedCollectionCount = serializedCollectionIds.size;
        if (serializedCollectionIds.size < scope.collections.length) {
          serializationUnsupported.push('The serialization archive returned fewer Collection definitions than the number of selected collection roots.');
        }
        const replacePortableEntity = (target: Map<string, JsonRecord>, entity: MetabaseSerializationEntity): void => {
          target.forEach((value, key) => {
            if (portableEntityId(value) === entity.id) target.delete(key);
          });
          target.set(entity.id, entity.value);
        };
        parsed.entities.forEach((entity) => {
          artifacts.push(serializationArtifact(entity));
          if (entity.model === 'Card') replacePortableEntity(cards, entity);
          else if (entity.model === 'Dashboard') replacePortableEntity(dashboards, entity);
        });
        parsed.entities.forEach((entity) => {
          if (entity.model === 'Collection') {
            dependencies.push({
              sourceId: `metabase:collection-entity:${entity.id}`,
              category: 'content',
              required: true,
              status: 'resolved',
              reason: 'The collection definition was parsed from its exact documented serialization YAML artifact.',
            });
          } else if (entity.model === 'Card') {
            const querySupported = Boolean(normalizedCardQuery(entity.value));
            if (!querySupported) serializationUnsupported.push(`Serialization Card ${entity.id} used a query shape that requires Manual Files review.`);
            dependencies.push({
              sourceId: `metabase:card:${entity.id}`,
              category: 'content',
              required: true,
              status: querySupported ? 'resolved' : 'manual_required',
              reason: querySupported
                ? 'The Card, stable Entity ID, and complete normalized MBQL or native query were parsed from the exact documented serialization YAML artifact.'
                : 'The Card artifact was preserved, but its query shape was not translated heuristically.',
            });
            cardDependencyIds(entity.value).forEach((dependencyId) => dependencies.push({
              sourceId: `metabase:card:${entity.id}`,
              dependencySourceId: `metabase:card:${dependencyId}`,
              category: 'content',
              required: true,
              status: cards.has(dependencyId) ? 'resolved' : 'missing',
              reason: cards.has(dependencyId)
                ? 'The serialized nested Card dependency was acquired with the selected collection.'
                : 'The serialized Card references another Card that was not present in the selected API or serialization evidence.',
            }));
            cardTableIds(entity.value).forEach((tableId) => dependencies.push({
              sourceId: `metabase:card:${entity.id}`,
              dependencySourceId: `metabase:table:${tableId}`,
              category: 'data_source',
              required: true,
              status: tables.has(tableId) ? 'resolved' : 'manual_required',
              reason: tables.has(tableId)
                ? 'The serialized Card data-source reference matched acquired table metadata.'
                : 'The serialized Card preserved a database/table natural key, but this content-only export excluded data-model metadata. Reconcile the source through Saved API or Manual Files.',
            }));
          } else {
            dependencies.push({
              sourceId: `metabase:dashboard:${entity.id}`,
              category: 'content',
              required: true,
              status: 'resolved',
              reason: 'The Dashboard layout, parameters, tabs, stable Entity ID, and dashcards were parsed from the exact documented serialization YAML artifact.',
            });
            dashboardCardIds(entity.value).forEach((cardId) => dependencies.push({
              sourceId: `metabase:dashboard:${entity.id}`,
              dependencySourceId: `metabase:card:${cardId}`,
              category: 'content',
              required: true,
              status: cards.has(cardId) ? 'resolved' : 'missing',
              reason: cards.has(cardId)
                ? 'The serialized Dashboard Card dependency was acquired with the selected collection.'
                : 'The serialized Dashboard references a Card that was not present in the selected API or serialization evidence.',
            }));
          }
          const collectionId = identifier(entity.model === 'Collection' ? entity.value.parent_id : entity.value.collection_id);
          if (collectionId) {
            dependencies.push({
              sourceId: entity.model === 'Collection'
                ? `metabase:collection-entity:${entity.id}`
                : `metabase:${entity.model.toLowerCase()}:${entity.id}`,
              dependencySourceId: `metabase:collection-entity:${collectionId}`,
              category: 'content',
              required: true,
              status: serializedCollectionIds.has(collectionId) ? 'resolved' : 'missing',
              reason: serializedCollectionIds.has(collectionId)
                ? 'The serialized collection membership resolved by stable Collection Entity ID.'
                : 'The serialized content references a Collection Entity ID that was absent from the selected export.',
            });
          }
          if (entity.model === 'Card') {
            const dashboardId = identifier(entity.value.dashboard_id);
            if (dashboardId) dependencies.push({
              sourceId: `metabase:card:${entity.id}`,
              dependencySourceId: `metabase:dashboard:${dashboardId}`,
              category: 'content',
              required: true,
              status: dashboards.has(dashboardId) ? 'resolved' : 'missing',
              reason: dashboards.has(dashboardId)
                ? 'The serialized Card container resolved by stable Dashboard Entity ID.'
                : 'The serialized Card references a Dashboard Entity ID that was absent from the selected export.',
            });
          }
        });
        serializationUnsupported = unique(serializationUnsupported);
        serializationParsed = parsed.entities.length > 0 && serializationUnsupported.length === 0;
        if (!serializationParsed) stats.errors.push('The selected Metabase serialization archive contained unsupported or incomplete collection content.');
      } catch (error) {
        if (asRecord(error).statusCode === 413) throw error;
        const message = error instanceof Error ? error.message : 'The selected Metabase serialization archive used an unsupported format.';
        stats.errors.push(message);
        serializationUnsupported = [message];
      }
      scope.collections.forEach((collectionId) => dependencies.push({
        sourceId: `metabase:collection:${collectionId}`,
        category: 'content',
        required: true,
        status: serializationParsed ? 'resolved' : 'manual_required',
        reason: serializationParsed
          ? 'The endpoint-scoped collection export was securely unpacked and every collection YAML entity matched a supported documented representation.'
          : 'The endpoint-scoped collection export was acquired, but one or more archive or YAML shapes were not safely normalized. Provide those artifacts through Manual Files review.',
      }));
    } else {
      stats.permissionGaps.push('The configured Metabase edition or API key did not permit selected-collection serialization export.');
      scope.collections.forEach((collectionId) => dependencies.push({
        sourceId: `metabase:collection:${collectionId}`,
        category: 'content',
        required: true,
        status: 'manual_required',
        reason: 'The selected collection could not be serialized. Provide a version-matched Pro/Enterprise export or its complete contents through Manual Files.',
      }));
    }
  }

  const manualRequirements = unique([
    ...(!serializationParsed ? ['Use a version-matched, fully supported Pro/Enterprise serialization export or Manual Files when portable YAML definitions are required.'] : []),
    ...serializationUnsupported,
    'Review unknown or version-specific MBQL shapes instead of translating them heuristically.',
    ...(serializationParsed ? ['Reconcile serialized database, table, and field natural keys separately because the selected content export intentionally excludes data-model metadata.'] : []),
    'Supply alerts, subscriptions, users, groups, and permissions separately; Metabase serialization does not export those user-bound entities.',
  ]);
  dependencies.push({
    sourceId: `metabase:scope:${context.scopeFingerprint}`,
    category: 'security',
    required: true,
    status: 'manual_required',
    reason: 'Alerts, subscriptions, users, groups, and permissions are outside the portable serialization contract and require explicit review.',
  });
  const artifactsBySourceId = new Map<string, MigrationSourceArtifactProvenance>();
  artifacts.forEach((item) => artifactsBySourceId.set(item.sourceId, item));
  const tableValues = Array.from(tables.values());
  const dashboardValues = Array.from(dashboards.values());
  const cardValues = Array.from(cards.values());
  const relationships = tableRelationships(tableValues, artifactsBySourceId);
  const queryViews: MigrationView[] = cardValues
    .map((card) => cardQueryView(card, artifactsBySourceId.get(`metabase:card:${contentIdentifier(card)}`)))
    .filter((view): view is MigrationView => Boolean(view));
  const views = [
    ...tableValues.map((table) => tableView(table, artifactsBySourceId.get(`metabase:table:${identifier(table.id)}`))),
    ...queryViews,
  ];
  const normalizedDashboards = [
    ...dashboardValues.map((dashboard) => dashboardEvidence(
      dashboard,
      cards,
      artifactsBySourceId.get(`metabase:dashboard:${contentIdentifier(dashboard)}`),
    )),
    ...cardValues.map((card) => cardEvidence(card, artifactsBySourceId.get(`metabase:card:${contentIdentifier(card)}`))),
  ];
  const collectionSelectionIncomplete = scope.collections.length > 0 && !serializationParsed;
  const collectionComplete = stats.permissionGaps.length === 0 && stats.errors.length === 0 && !collectionSelectionIncomplete;
  const missingCount = dependencies.filter((dependency) => dependency.status === 'missing').length
    + dependencies.filter((dependency) => dependency.sourceId.startsWith('metabase:collection:') && dependency.status === 'manual_required').length;
  const resolvedCount = dependencies.filter((dependency) => dependency.status === 'resolved').length;
  const reviewCount = dependencies.filter((dependency) => dependency.status === 'review_required' || dependency.status === 'manual_required').length;
  const warnings = unique([...stats.warnings, ...manualRequirements]);
  const inventory: MigrationInventory = {
    sourceTool: 'metabase',
    artifactCount: artifacts.length,
    artifacts: [],
    views,
    explores: [],
    relationships,
    dashboards: normalizedDashboards,
    metrics: views.flatMap((view) => view.measures),
    warnings,
    summary: `${dashboardValues.length} dashboard${dashboardValues.length === 1 ? '' : 's'} · ${cardValues.length} question${cardValues.length === 1 ? '' : 's'} · ${tableValues.length} table definition${tableValues.length === 1 ? '' : 's'}${serializationCaptured ? ` · ${serializedCollectionCount} serialized collection${serializedCollectionCount === 1 ? '' : 's'}` : ''}${serializationParsed ? ' · selected serialization parsed' : serializationCaptured ? ' · selected serialization requires review' : ''}`,
  };
  const evidenceContract: MigrationPreparedEvidenceResult['evidenceContract'] = {
    schemaVersion: 'omnikit.source-evidence.v2',
    sourceTool: 'metabase',
    parser: { name: 'OmniKit Metabase API and serialization normalizer', version: '2' },
    acquisition: { mode: serializationCaptured ? 'hybrid' : 'api', runId: context.scopeFingerprint, selectedScopeIds: [...context.selectedRootIds].sort() },
    collection: { observedArtifactCount: artifacts.length, complete: collectionComplete, truncated: false, permissionGaps: unique(stats.permissionGaps) },
    dependencyClosure: { status: missingCount > 0 ? 'blocked' : 'partial', resolvedCount, missingCount, reviewCount },
    artifactFingerprints: artifacts.map((item) => ({ name: item.name, sha256: item.sha256, sizeBytes: item.sizeBytes })),
    documentationIds: [METABASE_API_DOCUMENTATION, METABASE_API_KEY_DOCUMENTATION, METABASE_SERIALIZATION_DOCUMENTATION],
    diagnostics: unique([...stats.errors, ...stats.permissionGaps, ...warnings]),
  };
  inventory.sourceEvidence = evidenceContract;
  return {
    schemaVersion: 'omnikit.prepared-source-evidence.v1',
    platform: 'metabase',
    connectionId: connection.id,
    connectionUpdatedAt: connection.updatedAt,
    selectedRootIds: [...context.selectedRootIds].sort(),
    scopeFingerprint: context.scopeFingerprint,
    preparedAt: new Date().toISOString(),
    status: collectionSelectionIncomplete ? 'manual_required' : 'partial',
    evidenceContract,
    inventory,
    artifacts,
    dependencies,
    diagnostics: {
      complete: collectionComplete,
      verifiedEmpty: false,
      truncated: false,
      requestsMade: stats.requestsMade,
      pagesFetched: stats.requestsMade,
      itemsObserved: artifacts.length,
      bytesRead: stats.bytesRead,
      limits: { maxRequests: MAX_REQUESTS, maxPages: MAX_REQUESTS, maxItems: MAX_DEPENDENCY_CARDS + MAX_SELECTED_ROOTS, maxBytes: MAX_TOTAL_JSON_BYTES + MAX_SERIALIZATION_BYTES },
      permissionGaps: unique(stats.permissionGaps),
      manualRequirements,
      errors: unique(stats.errors),
      warnings: unique(stats.warnings),
    },
  };
}

export const metabaseEvidenceCollector: MigrationSourceEvidenceCollector = {
  platform: 'metabase',
  prepareEvidence: prepareMetabaseEvidence,
};

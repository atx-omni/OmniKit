import { isDeepStrictEqual } from 'node:util';
import { isAlias, isMap, isNode, isScalar, parseDocument, visit, type Scalar } from 'yaml';

export type TopicTableNameInventory = {
  namespace: string;
  status: 'available' | 'unavailable';
  tableNames: string[];
  /** Opt-in schema column evidence. Omitted for historical spelling-only approvals. */
  columnsByTable?: Array<{ tableName: string; columns: string[] }>;
};

const MAX_FILES = 5_000;
const MAX_YAML_BYTES = 2_000_000;
const MAX_INVENTORY_BYTES = 20_000_000;
const MAX_NODES = 25_000;
const MAX_DEPTH = 64;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]{0,254}$/;
const NAMESPACE_PART = /^[A-Za-z_][A-Za-z0-9_$-]{0,254}$/;
const isIdentifier = (value: unknown): value is string => typeof value === 'string' && IDENTIFIER.test(value);
const isNamespace = (value: unknown): value is string => typeof value === 'string'
  && value.split('.').length <= 2 && value.split('.').every(part => NAMESPACE_PART.test(part));

type PhysicalView = {
  kind: 'physical';
  namespace: string;
  tableName: string;
  tableNode: Scalar<string>;
  value: Record<string, unknown>;
};

/** Parse only bounded authored mappings; aliases/tags cannot supply hidden physical identities. */
function readView(yaml: string): PhysicalView | { kind: 'query' } | undefined {
  if (typeof yaml !== 'string' || Buffer.byteLength(yaml, 'utf8') > MAX_YAML_BYTES) return;
  try {
    const document = parseDocument(yaml, { uniqueKeys: true, strict: true, prettyErrors: false });
    if (document.errors.length || document.warnings.length || !isMap(document.contents)) return;
    let nodes = 0;
    visit(document, (_key, node, path) => {
      if (++nodes > MAX_NODES || path.length > MAX_DEPTH) throw new Error('Bounded YAML required.');
      if (isAlias(node) || (isNode(node) && (node.tag || ('anchor' in node && node.anchor)))) {
        throw new Error('Aliases, anchors, and explicit tags are unsupported.');
      }
      if (isMap(node)) for (const pair of node.items) {
        if (!isScalar(pair.key) || typeof pair.key.value !== 'string'
          || ['__proto__', 'prototype', 'constructor', '<<'].includes(pair.key.value)) throw new Error('Safe mapping keys required.');
      }
    });
    const mapping = document.contents;
    if (['sql', 'sql_table_name', 'query', 'query_view'].some(key => mapping.has(key))) return { kind: 'query' };
    const literal = (key: string, pattern = IDENTIFIER): string | undefined => {
      const node = mapping.get(key, true);
      return isScalar(node) && ['PLAIN', 'QUOTE_SINGLE', 'QUOTE_DOUBLE'].includes(node.type || '')
        && typeof node.value === 'string' && pattern.test(node.value)
        ? node.value : undefined;
    };
    // Catalog/project metadata can contain hyphens; physical table matching remains conservative.
    const schema = literal('schema', NAMESPACE_PART), catalog = literal('catalog', NAMESPACE_PART),
      database = literal('database', NAMESPACE_PART), tableName = literal('table_name');
    if (!schema || !tableName || (mapping.has('catalog') && !catalog) || (mapping.has('database') && !database)
      || (catalog && database && catalog !== database)) return;
    const namespace = catalog || database ? `${catalog || database}.${schema}` : schema;
    const tableNode: unknown = mapping.get('table_name', true);
    if (!isScalar<string>(tableNode) || typeof tableNode.value !== 'string' || !tableNode.range) return;
    const value = document.toJS({ maxAliasCount: 0 }) as Record<string, unknown>;
    return { kind: 'physical', namespace, tableName, tableNode, value };
  } catch { return; }
}

/** No namespace inference from file paths and no interpretation of SQL-backed tables. */
export function topicMigrationPhysicalTable(yaml: string): { namespace: string; tableName: string } | undefined {
  const view = readView(yaml);
  return view?.kind === 'physical' ? { namespace: view.namespace, tableName: view.tableName } : undefined;
}

/** Consume a complete includeSchemas YAML file map; malformed ordinary views invalidate the evidence. */
export function readTopicTableNameInventory(namespace: string, files: Record<string, string>, includeColumns = false): TopicTableNameInventory {
  const unavailable = (): TopicTableNameInventory => ({ namespace, status: 'unavailable', tableNames: [] });
  if (!isNamespace(namespace) || !files || typeof files !== 'object' || Array.isArray(files)) return unavailable();
  try {
    const descriptors = Object.getOwnPropertyDescriptors(files);
    const names = Object.keys(descriptors);
    if (names.length > MAX_FILES || ![Object.prototype, null].includes(Object.getPrototypeOf(files))) return unavailable();
    let bytes = 0;
    const tableNames: string[] = [];
    const columnsByTable: NonNullable<TopicTableNameInventory['columnsByTable']> = [];
    for (const name of names) {
      const descriptor = descriptors[name];
      if (!('value' in descriptor) || typeof descriptor.value !== 'string') return unavailable();
      bytes += Buffer.byteLength(descriptor.value, 'utf8');
      if (bytes > MAX_INVENTORY_BYTES) return unavailable();
      if (!name.endsWith('.view')) continue;
      if (name.length > 1024 || name.startsWith('/') || name.includes('\\')
        || name.split('/').some(segment => !segment || segment === '.' || segment === '..')
        || [...name].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return unavailable();
      if (name.endsWith('.query.view')) continue;
      const view = readView(descriptor.value);
      if (!view) return unavailable();
      if (view.kind === 'physical' && view.namespace === namespace) {
        tableNames.push(view.tableName);
        // Only canonical schema-view files can supply column evidence, not authored aliases.
        if (includeColumns && name === `${namespace}/${view.tableName}.view`) {
          const dimensions = view.value.dimensions;
          const columns = dimensions && typeof dimensions === 'object' && !Array.isArray(dimensions)
            ? Object.values(dimensions).flatMap(field => {
              if (!field || typeof field !== 'object' || typeof field.sql !== 'string') return [];
              // Destination backtick or unquoted single-column references only; no expression inference.
              const match = /^(?:\$\{TABLE\}\.)?(?:`([A-Za-z_][A-Za-z0-9_$]{0,254})`|([A-Za-z_][A-Za-z0-9_$]{0,254}))$/.exec(field.sql.trim());
              return match ? [match[1] || match[2]] : [];
            }) : [];
          columnsByTable.push({ tableName: view.tableName, columns: [...new Set(columns)].sort() });
        }
      }
    }
    // Multiple semantic views may share one exact physical identity; case variants remain distinct.
    return { namespace, status: 'available', tableNames: [...new Set(tableNames)].sort(),
      ...(includeColumns ? { columnsByTable: columnsByTable.sort((a, b) => a.tableName.localeCompare(b.tableName)) } : {}) };
  } catch { return unavailable(); }
}

export function reconcileTopicTableName(yaml: string, inventory: TopicTableNameInventory | undefined): {
  yaml: string;
  status: 'corrected' | 'exact' | 'ambiguous' | 'missing' | 'unsupported' | 'unavailable';
  namespace?: string;
  sourceTableName?: string;
  targetTableName?: string;
} {
  const view = readView(yaml);
  if (!view || view.kind !== 'physical') return { yaml, status: 'unsupported' };
  const context = { yaml, namespace: view.namespace, sourceTableName: view.tableName };
  if (!inventory || inventory.status !== 'available' || inventory.namespace !== view.namespace
    || !Array.isArray(inventory.tableNames) || inventory.tableNames.length > MAX_FILES
    || !inventory.tableNames.every(isIdentifier)) return { ...context, status: 'unavailable' };
  const matches = [...new Set(inventory.tableNames)].filter(name => name.toLowerCase() === view.tableName.toLowerCase());
  if (matches.length > 1) return { ...context, status: 'ambiguous' };
  if (!matches.length) return { ...context, status: 'missing' };
  const targetTableName = matches[0];
  if (targetTableName === view.tableName) return { ...context, status: 'exact', targetTableName };
  const [start, end] = view.tableNode.range!;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > yaml.length) {
    return { ...context, status: 'unsupported' };
  }
  const quoted = view.tableNode.type === 'QUOTE_SINGLE' ? `'${targetTableName}'` : JSON.stringify(targetTableName);
  const tokens = view.tableNode.type === 'PLAIN' ? [targetTableName, quoted] : [quoted];
  for (const token of tokens) {
    const corrected = yaml.slice(0, start) + token + yaml.slice(end);
    const reparsed = readView(corrected);
    if (reparsed?.kind === 'physical' && reparsed.namespace === view.namespace && reparsed.tableName === targetTableName
      && isDeepStrictEqual(reparsed.value, { ...view.value, table_name: targetTableName })) {
      return { ...context, yaml: corrected, status: 'corrected', targetTableName };
    }
  }
  return { ...context, status: 'unsupported' };
}

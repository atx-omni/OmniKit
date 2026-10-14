import { isDeepStrictEqual } from 'node:util';
import { isAlias, isMap, isNode, isScalar, isSeq, parseDocument, visit, type Scalar, type YAMLMap } from 'yaml';

type Dialect = 'snowflake' | 'databricks' | 'bigquery' | 'unknown';
type Finding = { path: string; reason: string };
type Correction = { path: string; from: string; to: string };
type Review = { yaml: string; corrections: Correction[]; findings: Finding[] };
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]{0,254}$/;
const MAX_FINDINGS = 100;
const SQL_KEYS = new Set(['sql', 'on_sql', 'where_sql', 'always_where_sql', 'having_sql', 'custom_sql', 'sql_table_name', 'sql_filter', 'sql_distinct_key']);

function sqlPaths(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => sqlPaths(item, `${path}[${index}]`));
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, item]) => {
    const next = /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? `${path ? path + '.' : ''}${key}` : `${path}[${JSON.stringify(key)}]`;
    return [...(SQL_KEYS.has(key) ? [next] : []), ...sqlPaths(item, next)];
  });
}

/** Normalize known metadata aliases only; an unfamiliar label is never guessed from a substring. */
export function normalizeMigrationDialect(raw: unknown): Dialect {
  if (typeof raw !== 'string' || raw.length > 128) return 'unknown';
  const value = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (['snowflake', 'snowflake_sql'].includes(value)) return 'snowflake';
  if (['databricks', 'databricks_sql', 'databricks_spark', 'spark', 'spark_sql', 'apache_spark', 'apache_spark_sql'].includes(value)) return 'databricks';
  if (['bigquery', 'big_query', 'google_bigquery', 'google_big_query', 'google_bigquery_sql'].includes(value)) return 'bigquery';
  return 'unknown';
}

function readYaml(yaml: string) {
  if (typeof yaml !== 'string' || Buffer.byteLength(yaml, 'utf8') > 2_000_000) return;
  try {
    const document = parseDocument(yaml, { uniqueKeys: true, strict: true, prettyErrors: false });
    if (document.errors.length || document.warnings.length || (!isMap(document.contents) && !isSeq(document.contents))) return;
    let nodes = 0, hasSql = false;
    visit(document, (_key, node, path) => {
      if (++nodes > 25_000 || path.length > 64) throw new Error('Bounded YAML required.');
      if (isAlias(node) || (isNode(node) && (node.tag || ('anchor' in node && node.anchor)))) throw new Error('Explicit YAML required.');
      if (isMap(node)) for (const pair of node.items) {
        if (!isScalar(pair.key) || typeof pair.key.value !== 'string'
          || ['__proto__', 'prototype', 'constructor', '<<'].includes(pair.key.value)) throw new Error('Safe unique keys required.');
        if (SQL_KEYS.has(pair.key.value)) hasSql = true;
      }
    });
    const value = document.toJS({ maxAliasCount: 0 }) as Record<string, unknown>;
    return { document, hasSql, value, sqlPaths: hasSql ? sqlPaths(value) : [] };
  } catch { return; }
}

/** Whole-expression grammar: optional whitespace, optional exact Omni TABLE prefix, one quoted simple identifier. */
function directSnowflakeColumn(sql: string): { before: string; prefix: string; column: string; after: string } | undefined {
  if (sql.length > 8192) return;
  const match = /^([ \t\r\n]*)(\$\{TABLE\}\.)?"([A-Za-z_][A-Za-z0-9_$]{0,254})"([ \t\r\n]*)$/.exec(sql);
  return match ? { before: match[1], prefix: match[2] || '', column: match[3], after: match[4] } : undefined;
}

function fieldPath(section: string, name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? `${section}.${name}.sql` : `${section}[${JSON.stringify(name)}].sql`;
}

function physicalView(mapping: YAMLMap): boolean {
  if (['sql', 'sql_table_name', 'query', 'query_view'].some(key => mapping.has(key))) return false;
  const literal = (key: string, pattern: RegExp): string | undefined => {
    const node = mapping.get(key, true);
    return isScalar(node) && typeof node.value === 'string' && ['PLAIN', 'QUOTE_SINGLE', 'QUOTE_DOUBLE'].includes(node.type || '')
      && pattern.test(node.value) ? node.value : undefined;
  };
  // A BigQuery project/catalog can contain hyphens; these metadata values are never rewritten here.
  const namespaceSegment = /^[A-Za-z_][A-Za-z0-9_$-]{0,254}$/;
  const schema = literal('schema', namespaceSegment), catalog = literal('catalog', namespaceSegment), database = literal('database', namespaceSegment);
  return Boolean(schema && literal('table_name', IDENTIFIER) && (!mapping.has('catalog') || catalog)
    && (!mapping.has('database') || database) && !(catalog && database && catalog !== database));
}

/** No SQL compiler or semantic rewrite: only proven single-column quoting on ordinary physical view fields. */
export function reviewTopicMigrationSqlDialect(input: {
  yaml: string;
  kind: 'topic' | 'view' | 'relationships' | 'model';
  sourceDialect: string;
  targetDialect: string;
  columns?: string[];
}): Review {
  const { yaml } = input;
  const result: Review = { yaml, corrections: [], findings: [] };
  const finding = (path: string, reason: string) => {
    if (result.findings.length < MAX_FINDINGS) result.findings.push({ path, reason });
    else if (result.findings.length === MAX_FINDINGS) result.findings.push({ path: '$', reason: 'FINDINGS_TRUNCATED: Additional SQL expressions require manual review.' });
  };
  const parsed = readYaml(yaml);
  if (!parsed) { finding('$', 'UNSUPPORTED_YAML: Use bounded, explicit YAML without duplicate keys, aliases, anchors, or tags.'); return result; }
  if (!parsed.hasSql) return result;
  const source = normalizeMigrationDialect(input.sourceDialect), target = normalizeMigrationDialect(input.targetDialect);
  if (source === 'unknown' || target === 'unknown') {
    finding('$', 'UNKNOWN_DIALECT: Source and destination dialect metadata must identify supported dialects.'); return result;
  }
  if (source === target) return result;
  if (source !== 'snowflake' || !['databricks', 'bigquery'].includes(target)) {
    finding('$', 'UNSUPPORTED_DIALECT_PAIR: Automatic quoting supports only Snowflake to Databricks or BigQuery.'); return result;
  }
  if (input.kind !== 'view') {
    finding('$', 'UNSUPPORTED_SCOPE: SQL outside ordinary physical view dimensions and measures remains for native review.'); return result;
  }
  if (!isMap(parsed.document.contents) || !physicalView(parsed.document.contents)) {
    finding('$', 'UNSUPPORTED_VIEW: Query-backed views or views without explicit literal physical metadata remain unchanged.'); return result;
  }

  const metadataAvailable = Array.isArray(input.columns) && input.columns.length <= 5_000 && input.columns.every(column =>
    typeof column === 'string' && column.length > 0 && column.length <= 255 && column === column.trim()
    && ![...column].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127));
  const columns = metadataAvailable ? [...new Set(input.columns)] : [];
  const columnsByCase = new Map<string, string[]>();
  for (const column of columns) {
    const folded = column.toLowerCase(); columnsByCase.set(folded, [...(columnsByCase.get(folded) || []), column]);
  }
  const expected = structuredClone(parsed.value);
  const edits: Array<{ start: number; end: number; token: string }> = [];
  const reviewedPaths = new Set<string>();
  let expressions = 0;
  for (const section of ['dimensions', 'measures']) {
    const fields = parsed.document.contents.get(section, true);
    if (fields === undefined || fields === null || (isScalar(fields) && fields.value === null)) continue;
    if (!isMap(fields)) { finding(section, 'UNSUPPORTED_FIELD_STRUCTURE: Field definitions must be explicit mappings.'); continue; }
    for (const pair of fields.items) {
      const name = String((pair.key as Scalar<string>).value), field = pair.value;
      if (field === null || (isScalar(field) && field.value === null)) continue;
      if (!isMap(field)) { finding(fieldPath(section, name), 'UNSUPPORTED_FIELD_STRUCTURE: The field definition is not an explicit mapping.'); continue; }
      if (!field.has('sql')) continue;
      if (++expressions > 2_000) return { yaml, corrections: [], findings: [{ path: '$', reason: 'EXPRESSION_LIMIT: Split this file for bounded native SQL review.' }] };
      const path = fieldPath(section, name), node = field.get('sql', true);
      reviewedPaths.add(path);
      if (!isScalar<string>(node) || typeof node.value !== 'string' || !node.range
        || !['PLAIN', 'QUOTE_SINGLE', 'QUOTE_DOUBLE'].includes(node.type || '')) {
        finding(path, 'UNSUPPORTED_EXPRESSION: SQL must be a plain or quoted scalar containing one direct column.'); continue;
      }
      const expression = directSnowflakeColumn(node.value);
      if (!expression) {
        finding(path, 'UNSUPPORTED_EXPRESSION: Functions, strings, comments, arithmetic, and other Omni references are preserved for native review.'); continue;
      }
      if (!metadataAvailable) { finding(path, 'COLUMN_METADATA_UNAVAILABLE: Complete destination column-name metadata is required.'); continue; }
      const matches = columnsByCase.get(expression.column.toLowerCase()) || [];
      if (matches.length > 1) { finding(path, 'AMBIGUOUS_COLUMN: Multiple destination column spellings match without a unique identity.'); continue; }
      if (!matches.length) { finding(path, 'NO_MATCHING_COLUMN: The direct source column has no case-insensitive destination match.'); continue; }
      if (!IDENTIFIER.test(matches[0])) { finding(path, 'UNSUPPORTED_DESTINATION_IDENTIFIER: The matched destination name is outside the simple-identifier grammar.'); continue; }
      const to = expression.before + expression.prefix + '`' + matches[0] + '`' + expression.after;
      const [start, end] = node.range;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > yaml.length) {
        return { yaml, corrections: [], findings: [{ path: '$', reason: 'UNSUPPORTED_YAML: Scalar edit boundaries could not be verified.' }] };
      }
      const token = node.type === 'QUOTE_SINGLE' ? "'" + to.replace(/'/g, "''") + "'"
        : node.type === 'PLAIN' && to.startsWith('${TABLE}.') ? to : JSON.stringify(to);
      edits.push({ start, end, token });
      result.corrections.push({ path, from: node.value, to });
      ((expected[section] as Record<string, Record<string, unknown>>)[name]).sql = to;
    }
  }
  for (const path of parsed.sqlPaths) if (!reviewedPaths.has(path)) {
    finding(path, 'UNSUPPORTED_SCOPE: Filters, policies, joins, and SQL outside direct physical view field expressions remain unchanged.');
  }
  if (!edits.length) return result;
  const pieces: string[] = [];
  let cursor = 0;
  for (const edit of edits.sort((a, b) => a.start - b.start)) {
    if (edit.start < cursor) return { yaml, corrections: [], findings: [{ path: '$', reason: 'UNSUPPORTED_YAML: SQL scalar edit boundaries overlap.' }] };
    pieces.push(yaml.slice(cursor, edit.start), edit.token); cursor = edit.end;
  }
  pieces.push(yaml.slice(cursor));
  const corrected = pieces.join(''), verified = readYaml(corrected);
  if (!verified || !isDeepStrictEqual(verified.value, expected)) {
    return { yaml, corrections: [], findings: [{ path: '$', reason: 'UNSUPPORTED_YAML: The proposed edits could not be proven to preserve all unrelated values.' }] };
  }
  return { ...result, yaml: corrected };
}

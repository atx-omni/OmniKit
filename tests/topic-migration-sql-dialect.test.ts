import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeMigrationDialect, reviewTopicMigrationSqlDialect } from '../server/services/topicMigrationSqlDialect';

const physical = 'catalog: warehouse\nschema: analytics\ntable_name: records\n';
const sqlView = (sql: string) => physical + 'dimensions:\n  id:\n    sql: ' + JSON.stringify(sql) + '\n';
const review = (yaml: string, overrides: Partial<Parameters<typeof reviewTopicMigrationSqlDialect>[0]> = {}) =>
  reviewTopicMigrationSqlDialect({ yaml, kind: 'view', sourceDialect: 'snowflake', targetDialect: 'databricks', columns: ['id'], ...overrides });

test('SQL dialect metadata normalizes exact common aliases without substring guesses', () => {
  for (const value of ['SNOWFLAKE', ' Snowflake SQL ']) assert.equal(normalizeMigrationDialect(value), 'snowflake');
  for (const value of ['Databricks', 'Spark', 'spark-sql', 'Apache Spark', 'databricks_sql']) assert.equal(normalizeMigrationDialect(value), 'databricks');
  for (const value of ['BigQuery', 'big_query', 'Google BigQuery', 'google-big-query']) assert.equal(normalizeMigrationDialect(value), 'bigquery');
  for (const value of ['', null, undefined, {}, 'snowflake-compatible', 'not_databricks', 'postgres']) assert.equal(normalizeMigrationDialect(value), 'unknown');
});

test('SQL dialect converts only complete Snowflake direct columns using exact destination spelling', () => {
  for (const targetDialect of ['databricks', 'bigquery']) for (const [from, to] of [
    ['"ID"', '`id`'], ['${TABLE}."ID"', '${TABLE}.`id`'], [' \t"ID"\n', ' \t`id`\n'],
  ]) {
    const result = review(sqlView(from), { targetDialect });
    assert.deepEqual(result.corrections, [{ path: 'dimensions.id.sql', from, to }]);
    assert.deepEqual(result.findings, []);
    assert.equal(result.yaml, sqlView(to));
  }
  const measure = physical + 'measures:\n  total:\n    sql: \'"VALUE"\'\n';
  assert.equal(review(measure, { columns: ['VaLuE'] }).yaml, measure.replace('"VALUE"', '`VaLuE`'));
  const project = sqlView('"ID"').replace('catalog: warehouse', 'catalog: example-project').replace('schema: analytics', 'schema: analytics-test');
  assert.equal(review(project, { targetDialect: 'bigquery' }).corrections.length, 1);
});

test('SQL dialect leaves same dialect, unknown labels, and unsupported pairs unchanged', () => {
  const yaml = sqlView('"ID"');
  const same = review(yaml, { sourceDialect: 'Spark', targetDialect: 'databricks' });
  assert.equal(same.yaml, yaml); assert.deepEqual(same.corrections, []); assert.deepEqual(same.findings, []);
  for (const patch of [{ sourceDialect: 'unknown' }, { targetDialect: '' }]) {
    const result = review(yaml, patch); assert.equal(result.yaml, yaml); assert.match(result.findings[0].reason, /^UNKNOWN_DIALECT:/);
  }
  for (const patch of [{ sourceDialect: 'databricks', targetDialect: 'bigquery' }, { sourceDialect: 'bigquery', targetDialect: 'snowflake' }]) {
    const result = review(yaml, patch); assert.equal(result.yaml, yaml); assert.match(result.findings[0].reason, /^UNSUPPORTED_DIALECT_PAIR:/);
  }
});

test('SQL dialect requires complete unambiguous destination columns and never guesses a missing match', () => {
  const yaml = sqlView('"ID"');
  for (const columns of [undefined, [' id'], [''], [null] as unknown as string[]]) {
    const result = review(yaml, { columns }); assert.equal(result.yaml, yaml); assert.match(result.findings[0].reason, /^COLUMN_METADATA_UNAVAILABLE:/);
  }
  for (const columns of [[], ['identifier'], ['other id']]) assert.match(review(yaml, { columns }).findings[0].reason, /^NO_MATCHING_COLUMN:/);
  const ambiguous = review(yaml, { columns: ['ID', 'id', 'id'] });
  assert.equal(ambiguous.yaml, yaml); assert.match(ambiguous.findings[0].reason, /^AMBIGUOUS_COLUMN:/);
  assert.equal(review(yaml, { columns: ['id', 'id', 'other column'] }).corrections.length, 1);
});

test('SQL dialect preserves functions, strings, arithmetic, comments and Omni references for explicit review', () => {
  const expressions = ['${records.id}', '${TABLE}.id', "'ID'", 'UPPER("ID")', '"ID" + 1', '"ID" -- comment', '/* comment */ "ID"', '"ID";SELECT 1', '"schema"."ID"', '"I""D"'];
  for (const sql of expressions) {
    const yaml = sqlView(sql), result = review(yaml);
    assert.equal(result.yaml, yaml); assert.deepEqual(result.corrections, []);
    assert.match(result.findings[0].reason, /^UNSUPPORTED_EXPRESSION:/); assert.equal(result.findings[0].path, 'dimensions.id.sql');
  }
});

test('SQL dialect never rewrites query-backed views, model policies, topics, or relationship expressions', () => {
  for (const extra of ['sql: SELECT * FROM records\n', 'sql_table_name: warehouse.analytics.records\n', 'query: {fields: [records.id]}\n']) {
    const yaml = sqlView('"ID"') + extra, result = review(yaml);
    assert.equal(result.yaml, yaml); assert.deepEqual(result.corrections, []); assert.match(result.findings[0].reason, /^UNSUPPORTED_VIEW:/);
  }
  const missingPhysical = 'dimensions: {id: {sql: \'"ID"\'}}\n';
  assert.match(review(missingPhysical).findings[0].reason, /^UNSUPPORTED_VIEW:/);
  for (const kind of ['model', 'topic', 'relationships'] as const) {
    const yaml = kind === 'relationships' ? '- on_sql: \'"ID"\'\n' : 'access_filters: {policy: {sql: \'"ID"\'}}\n';
    const result = review(yaml, { kind }); assert.equal(result.yaml, yaml); assert.deepEqual(result.corrections, []); assert.match(result.findings[0].reason, /^UNSUPPORTED_SCOPE:/);
  }
});

test('SQL dialect scalar edits preserve comments, CRLF, YAML quote styles, filters and security byte-for-byte', () => {
  const yaml = '# keep heading\r\ncatalog: warehouse\r\nschema: analytics\r\ntable_name: records\r\nrequired_access_grants: [restricted]\r\nalways_where_sql: \'"ID" = 1\' # keep policy\r\ndimensions:\r\n  id:\r\n    sql: \'"ID"\' # keep SQL comment\r\n    sql_filter: \'"ID" > 0\'\r\n    filters: {id: "1"}\r\n    required_access_grants: [restricted]\r\n  other:\r\n    sql: ${TABLE}."ID" # keep plain\r\n';
  const result = review(yaml);
  assert.equal(result.yaml, yaml.replace('sql: \'"ID"\'', "sql: '`id`'").replace('sql: ${TABLE}."ID"', 'sql: ${TABLE}.`id`'));
  assert.equal(result.corrections.length, 2);
  assert.ok(result.findings.some(finding => finding.path === 'always_where_sql'));
  assert.ok(result.findings.some(finding => finding.path === 'dimensions.id.sql_filter'));
  const block = physical + 'dimensions:\n  id:\n    sql: | # authored block\n      "ID"\n';
  assert.equal(review(block).yaml, block); assert.match(review(block).findings[0].reason, /^UNSUPPORTED_EXPRESSION:/);
});

test('SQL dialect fails closed on malformed, aliased, tagged, duplicate and unsafe YAML', () => {
  for (const yaml of ['dimensions: [', sqlView('"ID"') + 'schema: other\n', sqlView('"ID"') + 'label: &label records\n',
    sqlView('"ID"') + 'label: *missing\n', sqlView('"ID"') + 'label: !custom records\n', sqlView('"ID"') + 'metadata: {"__proto__": unsafe}\n',
    sqlView('"ID"') + '---\nmodel: {}\n', sqlView('"ID"') + '#'.repeat(2_000_001), sqlView('"ID"') + `metadata: ${'['.repeat(70)}value${']'.repeat(70)}\n`]) {
    const result = review(yaml); assert.equal(result.yaml, yaml); assert.deepEqual(result.corrections, []); assert.match(result.findings[0].reason, /^UNSUPPORTED_YAML:/);
  }
});

test('SQL dialect findings stay bounded and never fabricate corrections for large unsupported expression sets', () => {
  const yaml = physical + 'dimensions:\n' + Array.from({ length: 110 }, (_, index) => `  field_${index}:\n    sql: 'UPPER("ID")'\n`).join('');
  const result = review(yaml);
  assert.equal(result.yaml, yaml); assert.deepEqual(result.corrections, []); assert.equal(result.findings.length, 101);
  assert.match(result.findings[100].reason, /^FINDINGS_TRUNCATED:/);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse } from 'yaml';
import { applySchemaMapToYaml, buildTranslatedYamlFiles } from '../server/services/modelMigration/helpers';

const rules = [{ source: 'SOURCE_CATALOG.SHARED_SCHEMA', target: 'target_catalog.target_schema' }];

test('maps an explicit catalog/schema pair and SQL references while preserving comments, security, identifiers, and SQL logic', () => {
  const original = [
    '# SOURCE_CATALOG.SHARED_SCHEMA is a source note',
    'catalog: SOURCE_CATALOG # retain catalog comment',
    'schema: SHARED_SCHEMA # retain schema comment',
    'table_name: example_records',
    'label: SOURCE_CATALOG.SHARED_SCHEMA',
    'base_view: SOURCE_CATALOG.SHARED_SCHEMA',
    'access_filters:',
    '  - field: SOURCE_CATALOG.SHARED_SCHEMA',
    '    sql: SOURCE_CATALOG.SHARED_SCHEMA',
    'required_access_grants: [SOURCE_CATALOG.SHARED_SCHEMA]',
    'dimensions:',
    '  SOURCE_CATALOG.SHARED_SCHEMA:',
    '    sql: ${SOURCE_CATALOG.SHARED_SCHEMA} + 1',
    'sql: | # SOURCE_CATALOG.SHARED_SCHEMA header note',
    '  SELECT amount::NUMBER FROM SOURCE_CATALOG.SHARED_SCHEMA.example_records',
    "  WHERE label = 'SOURCE_CATALOG.SHARED_SCHEMA'",
    '  -- SOURCE_CATALOG.SHARED_SCHEMA SQL note',
    '  /* SOURCE_CATALOG.SHARED_SCHEMA block note */',
    '',
  ].join('\n');
  const result = applySchemaMapToYaml(original, rules);
  assert.equal(result.yaml, original
    .replace('catalog: SOURCE_CATALOG #', 'catalog: target_catalog #')
    .replace('schema: SHARED_SCHEMA #', 'schema: target_schema #')
    .replace('FROM SOURCE_CATALOG.SHARED_SCHEMA.example_records', 'FROM target_catalog.target_schema.example_records'));
  assert.equal(result.replacements, 3);
  assert.equal(parse(result.yaml).table_name, 'example_records');
});

test('does not infer standalone schema mappings, affect another catalog, or rewrite nested location fields', () => {
  for (const original of [
    'catalog: OTHER_CATALOG\nschema: SHARED_SCHEMA\n',
    'schema: SHARED_SCHEMA\n',
    'metadata:\n  catalog: SOURCE_CATALOG\n  schema: SHARED_SCHEMA\n',
    'catalog: SOURCE_CATALOG\nschema: OTHER_SCHEMA\n',
  ]) {
    assert.deepEqual(applySchemaMapToYaml(original, rules), { yaml: original, replacements: 0 });
  }
  const standalone = 'catalog: SOURCE_CATALOG\nschema: SHARED_SCHEMA\nsql: SELECT * FROM SHARED_SCHEMA.example_records\n';
  assert.equal(applySchemaMapToYaml(standalone, [{ source: 'SHARED_SCHEMA', target: 'explicit_schema' }]).yaml,
    standalone.replace('FROM SHARED_SCHEMA.', 'FROM explicit_schema.'));
});

test('preserves quoted scalar style, inline comments, flow mappings, and line endings', () => {
  const original = "catalog: 'SOURCE_CATALOG' # catalog\r\nschema: \"SHARED_SCHEMA\" # schema\r\ntable_name: example_records\r\n";
  assert.equal(applySchemaMapToYaml(original, rules).yaml,
    "catalog: 'target_catalog' # catalog\r\nschema: \"target_schema\" # schema\r\ntable_name: example_records\r\n");
  const flow = '{ catalog: SOURCE_CATALOG, schema: SHARED_SCHEMA, table_name: example_records }\n';
  assert.equal(applySchemaMapToYaml(flow, rules).yaml,
    '{ catalog: target_catalog, schema: target_schema, table_name: example_records }\n');
});

test('combined mapping takes precedence over a shared-schema rule and mapped output never cascades', () => {
  const original = 'catalog: SOURCE_CATALOG\nschema: SHARED_SCHEMA\nsql: SELECT * FROM SOURCE_CATALOG.SHARED_SCHEMA.example_records JOIN SHARED_SCHEMA.other_records\n';
  const result = applySchemaMapToYaml(original, [
    { source: 'SHARED_SCHEMA', target: 'generic_schema' },
    ...rules,
    { source: 'target_catalog.target_schema', target: 'unexpected_catalog.unexpected_schema' },
    { source: 'target_catalog', target: 'unexpected_catalog' },
  ]);
  assert.equal(result.yaml,
    'catalog: target_catalog\nschema: target_schema\nsql: SELECT * FROM target_catalog.target_schema.example_records JOIN generic_schema.other_records\n');
  assert.equal(result.replacements, 4);
});

test('retains dotted SQL mappings including quoted references and on_sql without renaming semantic references', () => {
  const original = [
    'sql_table_name: SOURCE_CATALOG.SHARED_SCHEMA.example_records',
    'on_sql: ${SOURCE_CATALOG.SHARED_SCHEMA} = SOURCE_CATALOG.SHARED_SCHEMA.example_records.id',
    'where_sql: SOURCE_CATALOG.SHARED_SCHEMA.example_records.id > 0',
    'dimensions:',
    '  example_id:',
    '    sql: SELECT id FROM "SOURCE_CATALOG"."SHARED_SCHEMA"."example_records"',
    '',
  ].join('\n');
  const result = applySchemaMapToYaml(original, rules);
  assert.equal(result.yaml, [
    'sql_table_name: target_catalog.target_schema.example_records',
    'on_sql: ${SOURCE_CATALOG.SHARED_SCHEMA} = target_catalog.target_schema.example_records.id',
    'where_sql: target_catalog.target_schema.example_records.id > 0',
    'dimensions:',
    '  example_id:',
    '    sql: SELECT id FROM target_catalog.target_schema."example_records"',
    '',
  ].join('\n'));
  assert.equal(result.replacements, 4);
});

test('malformed, duplicated, multi-document, or conflicting YAML mapping requires review', () => {
  for (const yaml of [
    'catalog: [unterminated',
    'catalog: SOURCE_CATALOG\ncatalog: OTHER_CATALOG\nschema: SHARED_SCHEMA\n',
    'catalog: SOURCE_CATALOG\nschema: SHARED_SCHEMA\n---\ncatalog: SOURCE_CATALOG\nschema: SHARED_SCHEMA\n',
  ]) assert.throws(() => applySchemaMapToYaml(yaml, rules), /unambiguous YAML/);
  assert.throws(() => applySchemaMapToYaml('catalog: SOURCE_CATALOG\nschema: SHARED_SCHEMA\n', [
    ...rules, { source: 'SOURCE_CATALOG.SHARED_SCHEMA', target: 'another_catalog.another_schema' },
  ]), /Conflicting catalog\/schema mappings/);
  assert.deepEqual(applySchemaMapToYaml('catalog: [unterminated', []),
    { yaml: 'catalog: [unterminated', replacements: 0 });
});

test('anchors, aliases, and escaped SQL require review instead of risking shared values or literals', () => {
  for (const yaml of [
    'catalog: &catalog SOURCE_CATALOG\nschema: SHARED_SCHEMA\nsecurity_value: *catalog\n',
    'catalog: SOURCE_CATALOG\nsource_schema: &schema SHARED_SCHEMA\nschema: *schema\n',
    'sql: &query SELECT * FROM SOURCE_CATALOG.SHARED_SCHEMA.example_records\nsecurity_value: *query\n',
    'source_query: &query SELECT * FROM SOURCE_CATALOG.SHARED_SCHEMA.example_records\nsql: *query\n',
    "sql: 'SELECT * FROM SOURCE_CATALOG.SHARED_SCHEMA.example_records WHERE label = ''SOURCE_CATALOG.SHARED_SCHEMA'''\n",
    'sql: "SELECT * FROM \\"SOURCE_CATALOG\\".\\"SHARED_SCHEMA\\".example_records"\n',
  ]) assert.throws(() => applySchemaMapToYaml(yaml, rules), /manual review/);
});

test('unrelated escaped single- and double-quoted SQL stays verbatim during a catalog/schema mapping', () => {
  const original = [
    'catalog: SOURCE_CATALOG',
    'schema: SHARED_SCHEMA',
    'dimensions:',
    '  single_quote:',
    "    sql: &unchanged_expression 'CASE WHEN x = ''ok'' THEN 1 END'",
    '  double_quote:',
    '    sql: "CASE WHEN x = \\"ok\\" THEN 1 END"',
    'security_value: *unchanged_expression',
    '',
  ].join('\n');
  const result = applySchemaMapToYaml(original, rules);
  assert.equal(result.yaml, original
    .replace('catalog: SOURCE_CATALOG', 'catalog: target_catalog')
    .replace('schema: SHARED_SCHEMA', 'schema: target_schema'));
  assert.equal(result.replacements, 2);
});


test('structured-only mapping reaches translation review with a changed draft and no invented table or dialect edits', () => {
  const original = 'catalog: SOURCE_CATALOG\nschema: SHARED_SCHEMA\ntable_name: example_records\ndimensions:\n  example_id:\n    sql: ${TABLE}.id::NUMBER\n';
  const [result] = buildTranslatedYamlFiles({
    files: { 'example_records.view': original }, schemaMap: rules,
    sourceDialect: 'snowflake', targetDialect: 'databricks',
  });
  assert.equal(result.original, original);
  assert.equal(result.deterministic, original.replace('catalog: SOURCE_CATALOG', 'catalog: target_catalog').replace('schema: SHARED_SCHEMA', 'schema: target_schema'));
  assert.equal(result.translated, result.deterministic);
  assert.equal(result.changed, true);
  assert.equal(result.reviewRequired, true);
  assert.ok(result.warnings.includes('2 schema/catalog reference rewrites applied.'));
  assert.match(result.warnings.join('\n'), /SQL requires human review/);
});

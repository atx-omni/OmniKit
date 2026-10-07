import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readTopicTableNameInventory, reconcileTopicTableName, topicMigrationPhysicalTable } from '../server/services/topicMigrationTableNames';

const view = (tableName: string, namespace = 'warehouse.analytics') => {
  const parts = namespace.split('.');
  return `${parts.length === 2 ? `catalog: ${parts[0]}\n` : ''}schema: ${parts[parts.length - 1]}\ntable_name: ${tableName}\ndimensions:\n  id:\n    sql: '\${TABLE}.ID'\n`;
};
const inventory = (tableNames: string[], namespace = 'warehouse.analytics') => ({ namespace, status: 'available' as const, tableNames });

test('table names reconcile upper and lower case only from unique exact-namespace inventory evidence', () => {
  for (const [source, target] of [['RECORDS', 'records'], ['records', 'RECORDS']]) {
    const yaml = view(source);
    const evidence = readTopicTableNameInventory('warehouse.analytics', { 'warehouse.analytics/records.view': view(target) });
    assert.equal(evidence.status, 'available');
    const result = reconcileTopicTableName(yaml, evidence);
    assert.equal(result.status, 'corrected'); assert.equal(result.targetTableName, target);
    assert.equal(result.yaml, yaml.replace(`table_name: ${source}`, `table_name: ${target}`));
    assert.equal(result.sourceTableName, source); assert.equal(result.namespace, 'warehouse.analytics');
  }
  const exact = view('records');
  assert.deepEqual(reconcileTopicTableName(exact, inventory(['records'])), { yaml: exact, status: 'exact', namespace: 'warehouse.analytics', sourceTableName: 'records', targetTableName: 'records' });
});

test('table names isolate namespaces and support schema-only or consistent catalog/database literals', () => {
  const files = { 'a.view': view('records'), 'b.view': view('RECORDS', 'other.analytics'), 'c.view': view('records', 'analytics') };
  assert.deepEqual(readTopicTableNameInventory('warehouse.analytics', files), inventory(['records']));
  assert.equal(reconcileTopicTableName(view('RECORDS'), inventory(['records'], 'other.analytics')).status, 'unavailable');
  assert.equal(reconcileTopicTableName(view('RECORDS'), inventory(['records'], 'Warehouse.analytics')).status, 'unavailable');
  assert.deepEqual(topicMigrationPhysicalTable(view('records', 'analytics')), { namespace: 'analytics', tableName: 'records' });
  assert.deepEqual(topicMigrationPhysicalTable(view('records').replace('catalog:', 'database:')), { namespace: 'warehouse.analytics', tableName: 'records' });
  assert.ok(topicMigrationPhysicalTable(view('records') + 'database: warehouse\n'));
  assert.equal(topicMigrationPhysicalTable(view('records') + 'database: other\n'), undefined);
  assert.equal(topicMigrationPhysicalTable('catalog: warehouse\nschema: analytics\n'), undefined);
});

test('table names deduplicate exact physical identities but keep ambiguity, missing, and unavailable evidence unchanged', () => {
  const yaml = view('RECORDS');
  for (const evidence of [inventory(['records', 'RECORDS']), inventory(['records', 'records', 'RECORDS'])]) {
    assert.equal(reconcileTopicTableName(yaml, evidence).status, 'ambiguous'); assert.equal(reconcileTopicTableName(yaml, evidence).yaml, yaml);
  }
  assert.equal(reconcileTopicTableName(yaml, inventory(['records', 'records'])).status, 'corrected');
  assert.equal(reconcileTopicTableName(yaml, inventory(['RECORDS', 'RECORDS'])).status, 'exact');
  assert.equal(reconcileTopicTableName(yaml, inventory(['record'])).status, 'missing');
  assert.equal(reconcileTopicTableName(yaml, inventory([])).status, 'missing');
  for (const evidence of [undefined, { ...inventory(['records']), status: 'unavailable' as const }, inventory(['records;drop'])]) {
    assert.equal(reconcileTopicTableName(yaml, evidence).status, 'unavailable'); assert.equal(reconcileTopicTableName(yaml, evidence).yaml, yaml);
  }
  assert.deepEqual(readTopicTableNameInventory('warehouse.analytics', { 'a.view': view('records'), 'b.view': view('records') }), inventory(['records']));
  assert.deepEqual(readTopicTableNameInventory('warehouse.analytics', { 'a.view': view('records'), 'b.view': view('RECORDS') }), inventory(['RECORDS', 'records']));
  assert.deepEqual(readTopicTableNameInventory('warehouse.analytics', {}), inventory([]));
});

test('table names preserve every non-scalar byte including quote style, comments, CRLF, SQL, and security', () => {
  for (const quote of ['"', "'"]) {
    const yaml = `# keep heading\r\ncatalog: "warehouse"\r\nschema: 'analytics'\r\ntable_name: ${quote}RECORDS${quote} # keep table comment\r\nrequired_access_grants: [existing_grant]\r\ndimensions: {id: {sql: '\${TABLE}."ID"'}} # keep formula\r\n`;
    const result = reconcileTopicTableName(yaml, inventory(['records']));
    assert.equal(result.status, 'corrected');
    assert.equal(result.yaml, yaml.replace(`${quote}RECORDS${quote}`, `${quote}records${quote}`));
  }
  const escaped = 'catalog: warehouse\nschema: analytics\ntable_name: "REC\\u004fRDS" # keep\n';
  assert.equal(reconcileTopicTableName(escaped, inventory(['records'])).yaml, escaped.replace('"REC\\u004fRDS"', '"records"'));
  const plainReserved = view('tRUe');
  assert.equal(reconcileTopicTableName(plainReserved, inventory(['true'])).yaml, plainReserved.replace('table_name: tRUe', 'table_name: "true"'));
});

test('table names skip SQL and query-backed views without interpreting expressions or non-view files', () => {
  for (const extra of ['sql: SELECT * FROM records\n', 'sql_table_name: warehouse.analytics.records\n', 'query: {fields: [records.id]}\n']) {
    const yaml = view('RECORDS') + extra;
    assert.equal(topicMigrationPhysicalTable(yaml), undefined);
    assert.equal(reconcileTopicTableName(yaml, inventory(['records'])).status, 'unsupported');
    assert.equal(reconcileTopicTableName(yaml, inventory(['records'])).yaml, yaml);
    assert.deepEqual(readTopicTableNameInventory('warehouse.analytics', { 'query.view': yaml }), inventory([]));
  }
  assert.deepEqual(readTopicTableNameInventory('warehouse.analytics', {
    model: 'unparsed: [', relationships: 'unparsed: [', 'records.topic': 'unparsed: [', 'records.query.view': 'unparsed: [', 'records.view': view('records'),
  }), inventory(['records']));
});

test('table names fail closed on malformed, aliased, tagged, duplicate, and unsafe view inventories', () => {
  const invalid = ['schema: [', view('records') + 'table_name: other\n', view('records') + 'label: &label records\n',
    view('records') + 'label: *missing\n', view('records').replace('table_name: records', 'table_name: !custom records'),
    view('records') + 'metadata: {"__proto__": unsafe}\n', view('records').replace('table_name: records', 'table_name: schema.records'),
    view('records').replace('table_name: records', 'table_name: |\n  records'), view('records') + 'database: other\n',
    view('records') + '---\nschema: analytics\ntable_name: extra\n'];
  for (const yaml of invalid) {
    assert.equal(topicMigrationPhysicalTable(yaml), undefined);
    assert.equal(reconcileTopicTableName(yaml, inventory(['RECORDS'])).status, 'unsupported');
    assert.deepEqual(readTopicTableNameInventory('warehouse.analytics', { 'safe.view': view('records'), 'other.view': yaml }), { namespace: 'warehouse.analytics', status: 'unavailable', tableNames: [] });
  }
  assert.equal(readTopicTableNameInventory('warehouse.analytics', { '../unsafe.view': view('records') }).status, 'unavailable');
  assert.equal(readTopicTableNameInventory('warehouse..analytics', { 'safe.view': view('records') }).status, 'unavailable');
  assert.equal(readTopicTableNameInventory('warehouse.analytics', { 'other.view': view('records', 'other.analytics') + 'label: &x unsafe\n' }).status, 'unavailable');
});

test('table names enforce file, byte, node, and depth bounds and reject malformed supplied maps', () => {
  const tooLarge = view('records') + '#'.repeat(2_000_001);
  assert.equal(topicMigrationPhysicalTable(tooLarge), undefined);
  assert.equal(readTopicTableNameInventory('warehouse.analytics', { 'records.view': tooLarge }).status, 'unavailable');
  assert.equal(readTopicTableNameInventory('warehouse.analytics', Object.fromEntries(Array.from({ length: 5_001 }, (_, index) => [`${index}.view`, view('records')]))).status, 'unavailable');
  assert.equal(topicMigrationPhysicalTable(view('records') + `metadata: ${'['.repeat(70)}value${']'.repeat(70)}\n`), undefined);
  assert.equal(topicMigrationPhysicalTable(view('records') + `metadata: [${Array.from({ length: 25_001 }, () => 'value').join(',')}]\n`), undefined);
  const getter = Object.defineProperty({}, 'records.view', { enumerable: true, get: () => { throw new Error('Must not evaluate inventory getters.'); } });
  assert.equal(readTopicTableNameInventory('warehouse.analytics', getter).status, 'unavailable');
  assert.equal(readTopicTableNameInventory('warehouse.analytics', { 'records.view': 1 } as unknown as Record<string, string>).status, 'unavailable');
});

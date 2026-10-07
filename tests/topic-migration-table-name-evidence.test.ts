import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { readTopicMigrationTableNameEvidence } from '../server/services/topicMigrationTableNameEvidence';
import { readTopicTableNameInventory } from '../server/services/topicMigrationTableNames';

const view = (schema: string, table = 'RECORDS') => ({ kind: 'view' as const, fileName: schema + '/records.view',
  proposed: `catalog: example\nschema: ${schema}\ntable_name: ${table}\ndimensions: {}\n` });

test('sql dialect column evidence is explicit, canonical, bounded, and opt-in', async () => {
  const yaml = 'catalog: example\nschema: data\ntable_name: records\ndimensions:\n  alias: {sql: "`ID`"}\n  ambiguous: {sql: "`id`"}\n  derived: {sql: "SUM(amount)"}\n  not_a_column: {sql: \'"literal"\'}\n';
  const files = { 'example.data/records.view': yaml, 'authored_alias.view': yaml.replace('`ID`', '`NOT_SCHEMA_EVIDENCE`') };
  assert.equal(readTopicTableNameInventory('example.data', files).columnsByTable, undefined);
  const metadata = await readTopicMigrationTableNameEvidence([view('data')], async () => ({ files }), undefined, { includeColumns: true });
  assert.deepEqual(metadata[0].columnsByTable, [{ tableName: 'records', columns: ['ID', 'id'] }]);
  assert.deepEqual(readTopicTableNameInventory('example.data', { 'authored_alias.view': yaml }, true).columnsByTable, []);
});

test('table-name evidence reads once per selected namespace and ignores query views', async () => {
  const calls: string[] = [];
  const files = [view('data'), { ...view('data', 'DETAILS'), fileName: 'data/details.view' },
    { ...view('other'), fileName: 'other/records.query.view' }];
  const result = await readTopicMigrationTableNameEvidence(files, async namespace => {
    calls.push(namespace);
    return { files: { 'example.data/records.view': view('data', 'records').proposed, 'example.data/details.view': view('data', 'details').proposed } };
  });
  assert.deepEqual(calls, ['example.data']);
  assert.deepEqual(result, [{ namespace: 'example.data', status: 'available', tableNames: ['details', 'records'] }]);
});

test('sql dialect evidence supports hyphenated project namespaces without inferring column names', async () => {
  const yaml = 'catalog: example-project\nschema: analytics\ntable_name: records\ndimensions:\n  field_alias: {sql: "`RECORD_ID`"}\n';
  const metadata = await readTopicMigrationTableNameEvidence([
    { kind: 'view', fileName: 'records.view', proposed: yaml },
  ], async namespace => {
    assert.equal(namespace, 'example-project.analytics');
    return { files: { 'example-project.analytics/records.view': yaml } };
  }, undefined, { includeColumns: true });
  assert.deepEqual(metadata, [{ namespace: 'example-project.analytics', status: 'available', tableNames: ['records'],
    columnsByTable: [{ tableName: 'records', columns: ['RECORD_ID'] }] }]);
  assert.equal(readTopicTableNameInventory('example-project.analytics/other', {}, true).status, 'unavailable');
});

test('table-name evidence bounds namespace fanout and simultaneous reads', async () => {
  let active = 0, peak = 0, reads = 0;
  const result = await readTopicMigrationTableNameEvidence(Array.from({ length: 24 }, (_, index) => view('schema_' + index)), async namespace => {
    reads++; active++; peak = Math.max(peak, active);
    await setImmediate(); active--;
    return { files: { 'records.view': view(namespace.split('.')[1], 'records').proposed } };
  });
  assert.equal(reads, 20); assert.equal(peak, 4);
  assert.equal(result.filter(item => item.status === 'available').length, 20);
  assert.equal(result.filter(item => item.status === 'unavailable').length, 4);
});

test('table-name evidence preserves unavailable metadata and aborts canceled reviews', async () => {
  const result = await readTopicMigrationTableNameEvidence([view('data')], async () => { throw new Error('Fictional read failure'); });
  assert.deepEqual(result, [{ namespace: 'example.data', status: 'unavailable', tableNames: [] }]);
  const controller = new AbortController(); controller.abort(new Error('Canceled review'));
  let reads = 0;
  await assert.rejects(readTopicMigrationTableNameEvidence([view('data')], async () => { reads++; return { files: {} }; }, controller.signal), /Canceled review/);
  assert.equal(reads, 0);
});

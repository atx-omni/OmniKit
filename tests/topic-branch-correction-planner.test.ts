import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TopicMigrationFile } from '../shared/topicMigration';
import { buildTopicBranchCorrections, type DestinationTableNameInventory } from '../server/services/topicBranchCorrectionPlanner';

const sourcePath = 'SOURCE.PUBLIC/records.view', targetPath = 'warehouse.analytics/records.view';
const originalYaml = 'catalog: warehouse\nschema: analytics\ntable_name: RECORDS\ndimensions:\n  id:\n    sql: \'"ID"\'\n';
const original = (proposed = originalYaml): TopicMigrationFile => ({ sourceFileName: sourcePath, fileName: targetPath, destinationFileName: targetPath,
  kind: 'view', topicIds: ['records.topic'], before: null, proposed, status: 'create' });
const inventory = (namespace = 'warehouse.analytics', tableName = 'records', columns = ['id']): DestinationTableNameInventory => ({
  namespace, status: 'available', tableNames: [tableName], columnsByTable: [{ tableName, columns }],
});
const plan = (overrides: Partial<Parameters<typeof buildTopicBranchCorrections>[0]> = {}) => buildTopicBranchCorrections({
  originalFiles: [original()], schemaMapText: 'SOURCE.PUBLIC -> warehouse.analytics',
  branchFiles: { [targetPath]: originalYaml }, branchChecksums: { [targetPath]: 'current-checksum' },
  sourceDialect: 'Snowflake', targetDialect: 'Databricks', tableNames: [inventory()], ...overrides,
});

test('branch corrections derive exact mapped paths and propose only checksummed existing-file scalar changes', () => {
  // Old approvals may retain the submitted source path; only the proven destination is used.
  const result = plan({ originalFiles: [{ ...original(), fileName: sourcePath, destinationFileName: undefined }] });
  assert.equal(result.issues.filter(issue => issue.severity === 'blocker').length, 0);
  assert.equal(result.files.length, 1); assert.equal(result.noops, 0);
  const file = result.files[0];
  assert.equal(file.fileName, targetPath); assert.equal(file.sourceFileName, sourcePath);
  assert.equal(file.before, originalYaml); assert.equal(file.previousChecksum, 'current-checksum'); assert.equal(file.status, 'add');
  assert.equal(file.proposed, originalYaml.replace('table_name: RECORDS', 'table_name: records').replace('"ID"', '`id`'));
  assert.deepEqual(file.tableNameCorrection, { namespace: 'warehouse.analytics', from: 'RECORDS', to: 'records' });
  assert.deepEqual(file.sqlDialectReview?.corrections, [{ path: 'dimensions.id.sql', from: '"ID"', to: '`id`' }]);
});

test('branch corrections preserve unrelated native fields, formulas, filters, comments and security byte-for-byte', () => {
  const approved = originalYaml + '  calculated:\n    sql: ${records.id} + 1\nrequired_access_grants: [original_grant]\n';
  const current = ('# native heading\n' + approved.replace('[original_grant]', '[native_reviewed_grant]')
    + 'label: Native label\nfilters: {id: "1"}\nmeasures:\n  native_measure:\n    sql: \'"NEW_COLUMN"\' # keep native\n').replace(/\n/g, '\r\n');
  const result = plan({ originalFiles: [original(approved)], branchFiles: { [targetPath]: current, 'native_extra.view': 'native: unchanged\n' },
    tableNames: [inventory('warehouse.analytics', 'records', ['id', 'new_column'])] });
  assert.equal(result.files.length, 1); assert.equal(result.files[0].status, 'add');
  assert.equal(result.files[0].proposed, current.replace('table_name: RECORDS', 'table_name: records').replace('sql: \'"ID"\'', "sql: '`id`'"));
  assert.deepEqual(result.files[0].sqlDialectReview?.corrections.map(correction => correction.path), ['dimensions.id.sql']);
  assert.ok(result.files[0].sqlDialectReview?.findings.some(finding => finding.path === 'dimensions.calculated.sql'));
  assert.ok(result.files[0].sqlDialectReview?.findings.some(finding => finding.reason.startsWith('NATIVE_SQL_PRESERVED:')));
});

test('branch corrections block overlapping native SQL edits or missing fields without applying a partial table fix', () => {
  for (const current of [originalYaml.replace('"ID"', 'UPPER("ID")'), originalYaml.replace('"ID"', ' "ID" '),
    originalYaml.replace('  id:', '  moved_id:'), originalYaml.replace('    sql: \'"ID"\'\n', '')]) {
    const result = plan({ branchFiles: { [targetPath]: current } });
    assert.ok(result.issues.some(issue => issue.title === 'NATIVE_SQL_EDIT_CONFLICT' && issue.severity === 'blocker'));
    assert.equal(result.files[0].status, 'blocked'); assert.equal(result.files[0].proposed, current); assert.equal(result.noops, 0);
  }
});

test('branch corrections preserve manual physical bindings and use only their exact current column evidence', () => {
  const current = originalYaml.replace('catalog: warehouse', 'catalog: native_catalog').replace('schema: analytics', 'schema: manual_schema').replace('table_name: RECORDS', 'table_name: manual_records');
  const result = plan({ branchFiles: { [targetPath]: current }, tableNames: [inventory(), inventory('native_catalog.manual_schema', 'manual_records', ['Id'])] });
  assert.equal(result.files[0].proposed, current.replace('"ID"', '`Id`'));
  assert.equal(result.files[0].tableNameCorrection, undefined);
  assert.ok(result.issues.some(issue => issue.title === 'NATIVE_PHYSICAL_MAPPING_PRESERVED'));
  const noCurrentEvidence = plan({ branchFiles: { [targetPath]: current }, tableNames: [inventory()] });
  assert.equal(noCurrentEvidence.files[0].status, 'reuse'); assert.equal(noCurrentEvidence.files[0].proposed, current);
  assert.ok(noCurrentEvidence.issues.some(issue => issue.title === 'TABLE_METADATA_UNAVAILABLE'));
});

test('branch corrections rerun as a no-op when the approved SQL and table fixes are already present', () => {
  const first = plan(), corrected = first.files[0].proposed;
  const second = plan({ branchFiles: { [targetPath]: corrected }, branchChecksums: { [targetPath]: 'new-checksum' } });
  assert.equal(second.noops, 1); assert.equal(second.files[0].status, 'reuse'); assert.equal(second.files[0].proposed, corrected);
  assert.equal(second.files[0].previousChecksum, 'new-checksum'); assert.deepEqual(second.files[0].sqlDialectReview?.corrections, []);
  assert.deepEqual(second.files[0].sqlDialectReview?.findings, []); assert.equal(second.issues.some(issue => issue.severity === 'blocker'), false);
});

test('branch corrections refuse missing, moved, colliding paths and missing checksums instead of creating or relocating files', () => {
  const variants: Array<Partial<Parameters<typeof buildTopicBranchCorrections>[0]>> = [
    { branchFiles: {} }, { branchFiles: { 'elsewhere/records.view': originalYaml } },
    { branchFiles: { [targetPath]: originalYaml, 'warehouse.analytics/RECORDS.view': originalYaml } },
    { originalFiles: [original(), original()] }, { branchChecksums: {} },
    { originalFiles: [{ ...original(), destinationFileName: 'different/records.view' }] },
  ];
  for (const variant of variants) {
    const result = plan(variant);
    assert.ok(result.issues.some(issue => issue.severity === 'blocker'));
    assert.equal(result.files.some(file => file.status === 'create' || file.status === 'add'), false);
  }
});

test('branch corrections leave unavailable or ambiguous metadata unresolved without guessing columns or tables', () => {
  const correctedTable = originalYaml.replace('table_name: RECORDS', 'table_name: records');
  const variants: DestinationTableNameInventory[][] = [[], [{ ...inventory(), status: 'unavailable' }],
    [{ ...inventory(), tableNames: ['records', 'RECORDS'] }], [inventory(), inventory()],
    [{ ...inventory(), columnsByTable: [{ tableName: 'records', columns: ['id'] }, { tableName: 'records', columns: ['ID'] }] }],
    [{ ...inventory(), columnsByTable: [{ tableName: 'records', columns: ['id', 'ID'] }] }],
  ];
  for (const tableNames of variants) {
    const result = plan({ originalFiles: [original(correctedTable)], branchFiles: { [targetPath]: correctedTable }, tableNames });
    assert.equal(result.files[0].status, 'reuse'); assert.equal(result.files[0].proposed, correctedTable);
    assert.ok(result.issues.some(issue => issue.severity === 'review'));
  }
});

test('branch corrections are restricted to copied physical views, not topics, relationships, query views, or reused originals', () => {
  const originals: TopicMigrationFile[] = [original(), { ...original(), status: 'reuse' },
    { ...original(), sourceFileName: 'records.topic', fileName: 'records.topic', destinationFileName: undefined, kind: 'topic', proposed: 'base_view: records\n' },
    { ...original(), sourceFileName: 'relationships', fileName: 'relationships', destinationFileName: undefined, kind: 'relationships', proposed: '[]\n' },
    { ...original(), sourceFileName: 'records.query.view', fileName: 'records.query.view', destinationFileName: undefined, proposed: 'sql: SELECT 1\n' },
    { ...original(), sourceFileName: 'query.view', fileName: 'query.view', destinationFileName: undefined, proposed: 'sql: SELECT 1\n' }];
  const result = plan({ originalFiles: originals });
  assert.equal(result.files.length, 1); assert.equal(result.files[0].fileName, targetPath);
  assert.ok(result.issues.some(issue => issue.title === 'NON_PHYSICAL_VIEW_PRESERVED'));
});

test('branch corrections fail closed on unsafe current or approved YAML and retain the original branch bytes', () => {
  const invalid = [originalYaml + 'schema: duplicate\n', originalYaml + 'label: &x native\n', originalYaml + 'label: *missing\n',
    originalYaml + 'label: !custom value\n', originalYaml + 'metadata: {"__proto__": bad}\n', originalYaml + '#'.repeat(2_000_001)];
  for (const current of invalid) {
    const result = plan({ branchFiles: { [targetPath]: current } });
    assert.equal(result.files[0].status, 'blocked'); assert.equal(result.files[0].proposed, current);
    assert.ok(result.issues.some(issue => issue.title === 'CURRENT_YAML_UNSUPPORTED'));
  }
  const approved = plan({ originalFiles: [original(originalYaml + 'label: &x native\n')] });
  assert.equal(approved.files.length, 0); assert.ok(approved.issues.some(issue => issue.severity === 'blocker'));
});

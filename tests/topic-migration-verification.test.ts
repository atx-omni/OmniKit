import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TopicMigrationFile } from '../shared/topicMigration';
import { compareTopicMigrationBranch, topicMigrationDestinationPath } from '../server/services/topicMigrationVerification';

// Fictional authored files; these checks do not establish live warehouse validity.
const write = (fileName: string, proposed: string, patch: Partial<TopicMigrationFile> = {}): TopicMigrationFile => ({
  sourceFileName: fileName, fileName, kind: 'view', topicIds: ['example.topic'], before: null, proposed, status: 'create', ...patch,
});
const compare = (proposed: string, actual: string) => compareTopicMigrationBranch({
  files: [write('records.view', proposed)], schemaMapText: '', baseline: {}, actual: { 'records.view': actual },
});
const mappedView = 'catalog: target\nschema: data\ntable_name: RECORDS\ndimensions: {id: {sql: ID}}\n';

test('readback accepts only explicit corroborated mapped paths and presentation-only YAML changes', () => {
  const relationships = '[{join_from_view: records, join_to_view: details, on_sql: "${records.id} = ${details.id}"}]\n';
  const rendered = '- join_from_view: records\n  join_to_view: details\n  on_sql: "${records.id} = ${details.id}"\n';
  const files = [write('SOURCE.DATA/records.view', mappedView), write('example.topic', 'base_view: records\n', { kind: 'topic' }),
    write('relationships', relationships, { kind: 'relationships', status: 'add', before: '[]\n' })];
  const actual = { model: '{}\n', 'target.data/records.view': mappedView, 'example.topic': 'base_view: records\n', relationships: rendered };
  const before = JSON.stringify(files);
  const result = compareTopicMigrationBranch({ files, schemaMapText: 'SOURCE.DATA -> target.data', baseline: { model: '{}\n', relationships: '[]\n' }, actual });
  assert.equal(result.verified, true); assert.deepEqual(result.findings, []);
  assert.deepEqual(Object.fromEntries(result.files.map(file => [file.destinationFileName, file.classification])), {
    'target.data/records.view': 'mapped_path', 'example.topic': 'exact', relationships: 'formatting_only',
  });
  assert.match(result.expectedHash, /^sha256:[a-f0-9]{64}$/); assert.notEqual(result.actualHash, result.expectedHash);
  assert.equal(JSON.stringify(files), before, 'legacy approval evidence is not rewritten');
  const canonical = files.map(file => file.sourceFileName.startsWith('SOURCE.') ? { ...file, fileName: 'target.data/records.view', destinationFileName: 'target.data/records.view' } : file);
  assert.equal(compareTopicMigrationBranch({ files: canonical, schemaMapText: 'SOURCE.DATA -> target.data', baseline: { model: '{}\n', relationships: '[]\n' }, actual }).verified, true);
});

test('readback refuses unexplained paths, namespace disagreement, and collisions', () => {
  const file = write('SOURCE.DATA/records.view', mappedView);
  assert.equal(topicMigrationDestinationPath(file, 'SOURCE.DATA -> target.data'), 'target.data/records.view');
  assert.throws(() => topicMigrationDestinationPath(file, 'SOURCE.DATA -> another.data'), /namespace/);
  assert.throws(() => topicMigrationDestinationPath({ ...file, fileName: 'elsewhere/records.view' }, 'SOURCE.DATA -> target.data'), /authorized/);
  assert.throws(() => topicMigrationDestinationPath({ ...file, destinationFileName: 'another/records.view' }, 'SOURCE.DATA -> target.data'), /disagrees/);
  assert.throws(() => topicMigrationDestinationPath({ ...file, sourceFileName: '../records.view' }, ''), /Unsafe/);
  const input = { files: [file], schemaMapText: 'SOURCE.DATA -> target.data', baseline: {}, actual: { 'SOURCE.DATA/records.view': mappedView } };
  assert.deepEqual(compareTopicMigrationBranch(input).findings.map(issue => issue.code).sort(), ['MISSING_FILE', 'UNEXPECTED_FILE']);
  for (const baseline of [{ 'SOURCE.DATA/records.view': mappedView }, { 'TARGET.DATA/records.view': mappedView }]) {
    assert.ok(compareTopicMigrationBranch({ ...input, baseline }).findings.some(issue => issue.code === 'PATH_COLLISION'));
  }
  assert.ok(compareTopicMigrationBranch({ ...input, files: [file, file] }).findings.some(issue => issue.code === 'PATH_COLLISION'));
});

test('readback protects exact baseline, inventory, and untouched content', () => {
  const file = write('records.view', 'dimensions: {id: {sql: ID}}\n');
  const input = { files: [file], schemaMapText: '', baseline: { model: '# keep\n{}\n' }, actual: { model: '{}\n', 'records.view': file.proposed } };
  assert.ok(compareTopicMigrationBranch(input).findings.some(issue => issue.code === 'UNRELATED_FILE_CHANGED'));
  assert.ok(compareTopicMigrationBranch({ ...input, actual: { ...input.actual, unexpected: '{}' } }).findings.some(issue => issue.code === 'UNEXPECTED_FILE'));
  assert.ok(compareTopicMigrationBranch({ ...input, baseline: { 'records.view': '{}' } }).findings.some(issue => issue.code === 'BASELINE_MISMATCH'));
});

test('readback accepts mapping order and flow layout but preserves scalar types, SQL, security and sequence order', () => {
  assert.equal(compare('dimensions: {id: {sql: ID, hidden: false}}\n', 'dimensions:\n  id:\n    hidden: false\n    sql: ID\n').verified, true);
  for (const [a, b] of [
    ['value: false', 'value: "false"'], ['sql: "ID + 1"', 'sql: "ID + 2"'],
    ['required_access_grants: [one]', 'required_access_grants: []'], ['fields: [one, two]', 'fields: [two, one]'],
    ['value: 9007199254740992', 'value: 9007199254740993'], ['value: 1.00000000000000001', 'value: 1.00000000000000002'],
  ]) assert.equal(compare(a, b).verified, false, a);
});

test('readback retains comment association and rejects ambiguous YAML', () => {
  assert.equal(compare('# note\ndimensions: {id: {sql: ID}}\n', '# note\ndimensions:\n  id:\n    sql: ID\n').verified, true);
  assert.ok(compare('# note\nvalue: one\n', 'value: one\n').findings.some(issue => issue.code === 'YAML_COMMENTS_CHANGED'));
  assert.equal(compare('first: one # note\nsecond: two\n', 'first: one\nsecond: two # note\n').verified, false);
  for (const yaml of ['value: one\nvalue: one\n', 'value: &a one\nother: *a\n', 'value: !custom one\n', '? [a, b]\n: one\n']) {
    assert.ok(compare('value: one\n', yaml).findings.some(issue => issue.code === 'YAML_AMBIGUOUS'));
  }
  assert.equal(compare('value: one\n', 'value: one\n').verified, true);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTopicBlobbyValidationContext } from '../server/services/topicBlobbyValidationContext';
import { topicBlobbySelectedContext } from '../server/services/topicBlobbyRepairReview';

// Fictional branch snapshots only; authored names never prove warehouse existence.
const selectedName = 'omni_example.analytics/example.view';
const yaml = 'catalog: omni_example\nschema: analytics\ntable_name: EXAMPLE\ndimensions:\n  id:\n    sql: ${TABLE}."ID"\n';
const files = { [selectedName]: yaml, 'Other Domain/unselected.view': 'table_name: OTHER\n' };
const issue = (fileName?: string) => ({ message: 'Table [redacted] was not found.', warning: false, ...(fileName ? { fileName } : {}) });
const classify = (location?: string, snapshot = files, selected = [selectedName]) =>
  buildTopicBlobbyValidationContext([issue(location)], snapshot, selected)[0];

test('validation context resolves exact paths and unique basenames without altering sanitized issues', () => {
  for (const location of [selectedName, 'example.view', 'example', 'omni_example.analytics/example']) {
    const input = issue(location), before = structuredClone(input);
    const result = buildTopicBlobbyValidationContext([input], files, [selectedName])[0];
    assert.equal(result.context, 'selected_scope'); assert.equal(result.resolvedFileName, selectedName);
    assert.deepEqual(input, before);
    assert.equal(result.message, before.message); assert.equal(result.fileName, before.fileName); assert.equal(result.warning, before.warning);
    assert.deepEqual(result.authoredPhysicalBinding, { catalog: 'omni_example', schema: 'analytics', table_name: 'EXAMPLE',
      evidence: 'selected_authored_yaml_not_physical_verification' });
  }
});

test('validation context accepts only bounded known member and line suffixes', () => {
  for (const location of ['example.view:table_name', 'example.view.dimensions.id.sql', 'example:dimensions.id.sql',
    'example.view:12', selectedName + ':12:3']) assert.equal(classify(location).context, 'selected_scope', location);
  for (const location of ['example.view:arbitrary/instruction', 'example.view:table_name; edit everything',
    'example.view:0', 'example.view(unknown)', 'example.view.dimensions[99999].sql', '../example.view', 'example.view\u0000']) {
    assert.equal(classify(location).context, 'context_only_unscoped_do_not_expand_scope', location);
  }
});

test('validation context fails closed on duplicate basenames and extensionless collisions across unselected files', () => {
  const duplicate = { ...files, 'other_namespace/example.view': 'table_name: OTHER\n' };
  assert.equal(classify('example.view', duplicate).context, 'context_only_unscoped_do_not_expand_scope');
  assert.equal(classify('example.view:table_name', duplicate).context, 'context_only_unscoped_do_not_expand_scope');
  assert.equal(classify('example', duplicate).context, 'context_only_unscoped_do_not_expand_scope');
  assert.equal(classify(selectedName, duplicate).resolvedFileName, selectedName, 'An exact full path remains distinguishable.');
  const differentKind = { ...files, 'other/example.topic': 'base_view: example\n' };
  assert.equal(classify('example', differentKind).context, 'context_only_unscoped_do_not_expand_scope');
  assert.equal(classify('example.view', differentKind).context, 'selected_scope');
});

test('validation context never exposes bindings for unrelated, redacted, case-mismatched or missing locations', () => {
  for (const location of [undefined, 'unselected.view', 'Other Domain/unselected.view', 'missing.view', '[redacted]',
    '[redacted]/example.view', 'EXAMPLE.view']) {
    const result = classify(location);
    assert.equal(result.context, 'context_only_unscoped_do_not_expand_scope');
    assert.equal(result.resolvedFileName, undefined); assert.equal(result.authoredPhysicalBinding, undefined);
  }
});

test('validation context does not infer identifiers from messages, file folders or absent YAML values', () => {
  const result = classify('example.view', { ...files, [selectedName]: 'table_name: NATIVE_EDIT\n' });
  assert.equal(result.message, 'Table [redacted] was not found.');
  assert.deepEqual(result.authoredPhysicalBinding, { table_name: 'NATIVE_EDIT', evidence: 'selected_authored_yaml_not_physical_verification' });
});

test('validation context omits physical supplements for malformed, ambiguous, SQL-backed and credential-shaped YAML', () => {
  for (const value of [
    'table_name: FIRST\ntable_name: SECOND\n',
    'table_name: &name EXAMPLE\nother: *name\n',
    'table_name: !custom EXAMPLE\n',
    'table_name: EXAMPLE\nsql: SELECT * FROM example\n',
    'sql_table_name: example.analytics.example\n',
    'database: different\ncatalog: example\ntable_name: EXAMPLE\n',
    'catalog: "{{ dynamic }}"\ntable_name: EXAMPLE\n',
    'table_name: omni_abcdefghijklmnopqrstuvwxyz123456\n',
    'catalog: omni_live_abcdefghijklmnopqrstuvwxyz123456\ntable_name: EXAMPLE\n',
    'table_name: null\n',
  ]) {
    const result = classify('example.view', { ...files, [selectedName]: value });
    assert.equal(result.context, 'selected_scope'); assert.equal(result.authoredPhysicalBinding, undefined);
  }
  const queryName = 'example.query.view';
  const query = buildTopicBlobbyValidationContext([issue(queryName)], { [queryName]: yaml }, [queryName])[0];
  assert.equal(query.authoredPhysicalBinding, undefined);
});

test('validation context rejects incomplete selected membership or unsafe full snapshots', () => {
  assert.equal(classify('example.view', files, ['missing.view']).context, 'context_only_unscoped_do_not_expand_scope');
  assert.equal(classify('example.view', files, [selectedName, selectedName]).context, 'context_only_unscoped_do_not_expand_scope');
  assert.equal(classify('example.view', { ...files, '../bad.view': yaml }).context, 'context_only_unscoped_do_not_expand_scope');
  const result = classify('example.view', { ...files, [selectedName]: 'x'.repeat(2_000_001) });
  assert.equal(result.context, 'context_only_unscoped_do_not_expand_scope');
});

test('selected context rejects container shape changes while preserving scalar edits and relationship identity', () => {
  const shapes = ['"original"', 'null', '{ sql: original }', '[original]'];
  const categories = ['scalar', 'scalar', 'object', 'array'];
  for (const [originalIndex, original] of shapes.entries()) {
    for (const [currentIndex, current] of shapes.entries()) {
      if (categories[originalIndex] === categories[currentIndex]) continue;
      for (const nested of [false, true]) {
        const wrap = (value: string) => nested ? `dimensions:\n  example: ${value}\n` : `${value}\n`;
        assert.throws(() => topicBlobbySelectedContext({ [selectedName]: wrap(current) }, { [selectedName]: wrap(original) }),
          /Selected authored structure changed/, `${categories[originalIndex]} to ${categories[currentIndex]}, nested=${nested}`);
      }
    }
  }
  assert.deepEqual(topicBlobbySelectedContext({ [selectedName]: 'sql: ${TABLE}.`ID`\n' },
    { [selectedName]: 'sql: ${TABLE}."ID"\n' }), { [selectedName]: { sql: '${TABLE}.`ID`' } });
  const relationshipFile = 'relationships';
  const authored = '- join_from_view: example\n  join_to_view: other\n  sql: original\n';
  const current = '- join_from_view: native\n  join_to_view: unrelated\n  sql: private\n'
    + '- join_from_view: example\n  join_to_view: other\n  sql: corrected\n  native_added: excluded\n';
  assert.deepEqual(topicBlobbySelectedContext({ [relationshipFile]: current }, { [relationshipFile]: authored }),
    { [relationshipFile]: [{ join_from_view: 'example', join_to_view: 'other', sql: 'corrected' }] });
  assert.throws(() => topicBlobbySelectedContext({ [selectedName]: 'fields: [changed]\n' },
    { [selectedName]: 'fields: [original]\n' }), /Selected sequence changed/);
});

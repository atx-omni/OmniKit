import assert from 'node:assert/strict';
import test from 'node:test';

import { findAuthoredTopicYamlFile, preserveExistingTopicYaml } from '../src/services/topicYamlGovernance';

test('topic file discovery preserves an exact nested authored path', () => {
  const result = findAuthoredTopicYamlFile({
    files: {
      'topics/orders.topic': 'base_view: orders\n',
      'views/orders.view': 'dimensions: {}\n',
    },
  }, 'Orders');

  assert.deepEqual(result, {
    fileName: 'topics/orders.topic',
    yaml: 'base_view: orders\n',
  });
});

test('topic file discovery fails closed on duplicate normalized paths', () => {
  const result = findAuthoredTopicYamlFile({
    files: {
      'orders.topic': 'base_view: orders\n',
      'topics/orders.topic': 'base_view: orders_v2\n',
    },
  }, 'orders');

  assert.equal(result, null);
});

test('topic preservation restores omitted authored sections before ai_context', () => {
  const source = `# authored topic
base_view: orders
label: Orders
default_filters:
  orders.created_at:
    time_for_duration: [30 complete days ago, 30 days]
required_access_grants: [finance]
ai_context: >-
  Existing guidance.
`;
  const candidate = `base_view: orders
label: Executive Orders
ai_fields: [orders.revenue]
ai_context: >-
  Updated guidance.
`;

  const result = preserveExistingTopicYaml(source, candidate);

  assert.deepEqual(result.restoredTopLevelKeys, ['default_filters', 'required_access_grants']);
  assert.deepEqual(result.restoredPaths, ['default_filters', 'required_access_grants']);
  assert.match(result.yaml, /label: Executive Orders/);
  assert.match(result.yaml, /default_filters:\n {2}orders\.created_at:/);
  assert.match(result.yaml, /required_access_grants: \[\s*finance\s*\]/);
  assert.ok(result.yaml.indexOf('required_access_grants:') < result.yaml.indexOf('ai_context:'));
  assert.match(result.yaml, /Updated guidance\./);
});

test('topic preservation leaves explicit candidate sections unchanged', () => {
  const source = `base_view: orders
label: Orders
description: Original description
`;
  const candidate = `base_view: orders
label: New Orders
description: Approved replacement
`;

  const result = preserveExistingTopicYaml(source, candidate);

  assert.deepEqual(result.restoredTopLevelKeys, []);
  assert.deepEqual(result.restoredPaths, []);
  assert.equal(result.yaml, candidate.trimEnd());
});

test('topic preservation restores omitted nested authored keys and comments', () => {
  const source = `# governed source topic
base_view: orders
joins:
  customers:
    relationship_type: many_to_one
    on: orders.customer_id = customers.id
  regions:
    relationship_type: many_to_one
    on: customers.region_id = regions.id
fields:
  orders:
    revenue:
      label: Revenue
    margin:
      label: Margin
`;
  const candidate = `base_view: orders
joins:
  customers:
    relationship_type: one_to_one
    on: orders.customer_id = customers.id
fields:
  orders:
    revenue:
      label: Net revenue
`;

  const result = preserveExistingTopicYaml(source, candidate);

  assert.deepEqual(result.restoredTopLevelKeys, []);
  assert.deepEqual(result.restoredPaths, ['joins.regions', 'fields.orders.margin']);
  assert.match(result.yaml, /^# governed source topic/m);
  assert.match(result.yaml, /relationship_type: one_to_one/);
  assert.match(result.yaml, /regions:\n {4}relationship_type: many_to_one/);
  assert.match(result.yaml, /margin:\n {6}label: Margin/);
  assert.match(result.yaml, /label: Net revenue/);
});

test('topic preservation rejects invalid replacement YAML before a branch write', () => {
  assert.throws(
    () => preserveExistingTopicYaml('base_view: orders\n', 'label: [broken\n'),
    /Candidate topic YAML is invalid/,
  );
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { semanticRelationshipYamlIssues } from '../src/services/semanticRelationshipYaml';

test('accepts a complete reviewed Settings/relationships file', () => {
  const issues = semanticRelationshipYamlIssues([
    '- join_from_view: orders',
    '  join_to_view: customers',
    '  join_type: always_left',
    '  on_sql: ${orders.customer_id} = ${customers.id}',
    '  relationship_type: many_to_one',
    '  reversible: false',
  ].join('\n'));

  assert.deepEqual(issues, []);
  assert.equal(Object.isFrozen(issues), true);
});

test('rejects wrapped, empty, and scalar relationship file bodies', () => {
  assert.match(
    semanticRelationshipYamlIssues('relationships:\n  - join_from_view: orders\n').join('\n'),
    /top-level YAML list/i,
  );
  assert.match(
    semanticRelationshipYamlIssues('[]\n').join('\n'),
    /at least one reviewed relationship object/i,
  );
  assert.match(
    semanticRelationshipYamlIssues('- orders_to_customers\n').join('\n'),
    /item 1 must be a YAML mapping/i,
  );
});

test('rejects incomplete relationship objects and invalid cardinality controls', () => {
  const issues = semanticRelationshipYamlIssues([
    '- join_from_view: orders',
    '  join_to_view: customers',
    '  on_sql: ${orders.customer_id} = ${customers.id}',
    '  relationship_type: one_to_some',
    '  reversible: "true"',
  ].join('\n'));
  const message = issues.join('\n');

  assert.match(message, /must include a non-empty join_type/i);
  assert.match(message, /unsupported relationship_type "one_to_some"/i);
  assert.match(message, /reversible must be true or false/i);
});

test('reports YAML syntax failures without throwing', () => {
  assert.match(
    semanticRelationshipYamlIssues('- join_from_view: orders\n  join_to_view customers\n').join('\n'),
    /invalid YAML syntax/i,
  );
});

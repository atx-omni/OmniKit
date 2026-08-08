import assert from 'node:assert/strict';
import test from 'node:test';
import {
  semanticApprovedTopicViewScopeIssues,
  semanticModelReferenceIssues,
  semanticModelViewNames,
  semanticTopicReferencedTopicNames,
  semanticTopicReferencedViewNames,
  semanticTopicReachableViewNames,
  semanticViewIdentityContract,
  type SemanticRelationshipContract,
} from '../src/services/semanticModelReferences';

const modelYaml = {
  files: {
    model: 'default_row_limit: 500\n',
    'food_service/fact_order_items.view': 'dimensions:\n  order_id:\n    sql: order_id\n',
    'views/customers.view': 'dimensions:\n  customer_id:\n    sql: customer_id\n',
  },
  viewNames: {
    'food_service/fact_order_items.view': 'food_service__fact_order_items',
    'views/customers.view': 'customers',
  },
};

test('model inventory exposes internal view names instead of view file paths', () => {
  assert.deepEqual(
    semanticModelViewNames(modelYaml),
    ['customers', 'food_service__fact_order_items'],
  );
});

test('topic base_view must resolve to an existing or staged internal view', () => {
  assert.match(
    semanticModelReferenceIssues([{
      fileName: 'subway_store_analytics.topic',
      yaml: 'base_view: fact_order_lines\n',
    }], modelYaml).join('\n'),
    /no existing or staged view has that internal name/i,
  );

  assert.deepEqual(semanticModelReferenceIssues([{
    fileName: 'subway_store_analytics.topic',
    yaml: 'base_view: food_service__fact_order_items\n',
  }], modelYaml), []);

  assert.deepEqual(semanticModelReferenceIssues([{
    fileName: 'food_service/subway_orders.view',
    yaml: 'schema: analytics\ntable_name: subway_orders\n',
  }, {
    fileName: 'subway_store_analytics.topic',
    yaml: 'base_view: food_service__subway_orders\n',
  }], modelYaml), []);
});

test('reusable relationship endpoints must resolve before branch creation', () => {
  const issues = semanticModelReferenceIssues([{
    fileName: 'relationships',
    yaml: [
      '- join_from_view: food_service__fact_order_items',
      '  join_to_view: missing_store',
      '  join_type: always_left',
      '  on_sql: ${food_service__fact_order_items.store_id} = ${missing_store.store_id}',
      '  relationship_type: many_to_one',
    ].join('\n'),
  }], modelYaml);

  assert.equal(issues.length, 1);
  assert.match(issues[0] || '', /join_to_view "missing_store"/);
  assert.match(issues[0] || '', /Map the relationship endpoint or add its \.view artifact first/);
});

test('topic access filters must reference a view reachable from that topic', () => {
  const inaccessible = semanticModelReferenceIssues([{
    fileName: 'subway_stats.topic',
    yaml: [
      'base_view: food_service__fact_order_items',
      'access_filters:',
      '  - field: customers.customer_id',
      '    user_attribute: customer_id',
    ].join('\n'),
  }], modelYaml);

  assert.equal(inaccessible.length, 1);
  assert.match(inaccessible[0] || '', /view "customers" is not reachable from this topic/i);
  assert.match(inaccessible[0] || '', /Choose a field from the base view or an explicitly joined\/included view/i);

  assert.deepEqual(semanticModelReferenceIssues([{
    fileName: 'subway_stats.topic',
    yaml: [
      'base_view: food_service__fact_order_items',
      'joins:',
      '  customers: {}',
      'access_filters:',
      '  - field: customers.customer_id',
      '    user_attribute: customer_id',
    ].join('\n'),
  }], modelYaml), []);
});

test('topic reachable-view inventory includes nested joins and explicit views', () => {
  assert.deepEqual(semanticTopicReachableViewNames([
    'base_view: orders',
    'joins:',
    '  customers:',
    '    regions: {}',
    'views:',
    '  products: {}',
  ].join('\n')), ['customers', 'orders', 'products', 'regions']);
});

test('topic referenced-view inventory expands semantic selectors without changing reachability', () => {
  const yaml = [
    'base_view: orders',
    'joins:',
    '  customers: {}',
    'views:',
    '  products: {}',
    'ai_fields:',
    '  - ai_metrics.revenue',
    'fields:',
    '  field_scope.metric: {}',
    'default_filters:',
    '  default_scope.created_at:',
    '    time_for_duration: [30 complete days ago, 30 days]',
    'always_where_filters:',
    '  always_scope.active: true',
    'access_filters:',
    '  - field: access_scope.region',
    '    user_attribute: region',
    'field_overrides:',
    '  override_scope.metric:',
    '    label: Reviewed metric',
    'sample_queries:',
    '  Monthly performance:',
    '    query:',
    '      topic: sample_topic',
    '      base_view: sample_base',
    '      fields: ["sample_fields.revenue", "sample_time.created_at[month]"]',
    '      pivots: [sample_pivots.region]',
    '      sorts:',
    '        - field: sample_sorts.created_at',
    '          desc: true',
    '      filters:',
    '        sample_filters.status: complete',
    'ai_context: >-',
    '  Compare ${nested_scope.id} with ${orders.id}.',
  ].join('\n');

  assert.deepEqual(semanticTopicReachableViewNames(yaml), ['customers', 'orders', 'products']);
  assert.deepEqual(semanticTopicReferencedViewNames(yaml), [
    'access_scope',
    'ai_metrics',
    'always_scope',
    'customers',
    'default_scope',
    'field_scope',
    'nested_scope',
    'orders',
    'override_scope',
    'products',
    'sample_base',
    'sample_fields',
    'sample_filters',
    'sample_pivots',
    'sample_sorts',
    'sample_time',
  ]);
  assert.deepEqual(semanticTopicReferencedTopicNames(yaml), ['sample_topic']);

  const issues = semanticApprovedTopicViewScopeIssues({
    files: [{ fileName: 'analytics.topic', yaml }],
    approvedExistingViewNames: ['orders', 'customers', 'products'],
    primaryExistingViewName: 'orders',
  }).join('\n');
  assert.match(issues, /references view "ai_metrics" outside the reviewed topic data scope/i);
  assert.match(issues, /references view "sample_filters" outside the reviewed topic data scope/i);
  assert.match(issues, /references view "sample_pivots" outside the reviewed topic data scope/i);
  assert.match(issues, /references view "nested_scope" outside the reviewed topic data scope/i);
});

test('sample-query topics are validated against the approved topic instead of treated as views', () => {
  const yaml = [
    'base_view: orders',
    'sample_queries:',
    '  Monthly performance:',
    '    query:',
    '      topic: sales_performance',
    '      fields: [orders.revenue]',
  ].join('\n');

  assert.deepEqual(semanticApprovedTopicViewScopeIssues({
    files: [{ fileName: 'sales_performance.topic', yaml }],
    approvedExistingViewNames: ['orders'],
    primaryExistingViewName: 'orders',
    approvedTargetTopicFileName: 'sales_performance.topic',
  }), []);
  assert.match(semanticApprovedTopicViewScopeIssues({
    files: [{ fileName: 'sales_performance.topic', yaml: yaml.replace('topic: sales_performance', 'topic: other_topic') }],
    approvedExistingViewNames: ['orders'],
    primaryExistingViewName: 'orders',
    approvedTargetTopicFileName: 'sales_performance.topic',
  }).join('\n'), /sample query references topic "other_topic" instead of the approved target topic/i);
});

test('relationship reference parsing fails closed on malformed roots and rows', () => {
  const cases = [
    ['- join_from_view: [orders\n', /invalid YAML syntax/i],
    ['join_from_view: food_service__fact_order_items\njoin_to_view: customers\n', /top-level YAML list/i],
    ['- food_service__fact_order_items\n', /row 1 must be a relationship object/i],
    ['- join_from_view: food_service__fact_order_items\n', /row 1 must include non-empty join_from_view and join_to_view endpoints/i],
  ] as const;

  cases.forEach(([yaml, expected]) => {
    assert.match(semanticModelReferenceIssues([{ fileName: 'relationships', yaml }], modelYaml).join('\n'), expected);
  });

  assert.match(semanticApprovedTopicViewScopeIssues({
    files: [{ fileName: 'sales.topic', yaml: 'base_view: food_service__fact_order_items\n' }],
    approvedExistingViewNames: ['food_service__fact_order_items'],
    primaryExistingViewName: 'food_service__fact_order_items',
    baselineRelationshipsYaml: 'relationships: []\n',
  }).join('\n'), /Baseline relationships YAML must be a top-level YAML list/i);
});

test('new topic scope blocks an unrelated existing view and preserves the reviewed primary view', () => {
  const scopeModel = {
    files: {
      ...modelYaml.files,
      'restaurant/whataburger_locations.view': 'dimensions:\n  location_id:\n    sql: location_id\n',
    },
    viewNames: {
      ...modelYaml.viewNames,
      'restaurant/whataburger_locations.view': 'whataburger__locations',
    },
  };

  assert.deepEqual(semanticApprovedTopicViewScopeIssues({
    files: [{
      fileName: 'subway_stats.topic',
      yaml: 'base_view: food_service__fact_order_items\njoins:\n  customers: {}\n',
    }],
    approvedExistingViewNames: ['food_service__fact_order_items', 'customers'],
    primaryExistingViewName: 'food_service__fact_order_items',
  }), []);

  const unrelated = semanticApprovedTopicViewScopeIssues({
    files: [{
      fileName: 'subway_stats.topic',
      yaml: 'base_view: whataburger__locations\n',
    }],
    approvedExistingViewNames: ['food_service__fact_order_items'],
    primaryExistingViewName: 'food_service__fact_order_items',
  });
  assert.match(unrelated.join('\n'), /reviewed primary data view is "food_service__fact_order_items"/i);
  assert.match(unrelated.join('\n'), /outside the reviewed topic data scope/i);

  assert.deepEqual(semanticModelReferenceIssues([{
    fileName: 'subway_stats.topic',
    yaml: 'base_view: whataburger__locations\n',
  }], scopeModel), []);
  assert.ok(unrelated.length > 0, 'existence validation alone must not approve a semantically unrelated view');
});

test('only explicitly approved staged views join the scope and relationship decisions constrain changes', () => {
  const baselineRelationship = [
    '- join_from_view: whataburger__orders',
    '  join_to_view: whataburger__locations',
    '  relationship_type: many_to_one',
  ].join('\n');
  const stagedFiles = [{
    fileName: 'food_service/subway_locations.view',
    yaml: 'schema: analytics\ntable_name: subway_locations\n',
  }, {
    fileName: 'relationships',
    yaml: [
      baselineRelationship,
      '- join_from_view: food_service__fact_order_items',
      '  join_to_view: food_service__subway_locations',
      '  relationship_type: many_to_one',
    ].join('\n'),
  }, {
    fileName: 'subway_stats.topic',
    yaml: 'base_view: food_service__fact_order_items\njoins:\n  food_service__subway_locations: {}\n',
  }];
  const approvedStagedIdentity = semanticViewIdentityContract(stagedFiles[0]);
  assert.ok(approvedStagedIdentity);

  assert.deepEqual(semanticApprovedTopicViewScopeIssues({
    files: stagedFiles,
    approvedExistingViewNames: ['food_service__fact_order_items'],
    approvedStagedViewFileNames: ['food_service/subway_locations.view'],
    approvedStagedViewIdentities: [approvedStagedIdentity],
    primaryExistingViewName: 'food_service__fact_order_items',
    baselineRelationshipsYaml: baselineRelationship,
    relationshipDecisions: {
      food_service__subway_locations: 'create_reusable',
    },
  }), []);

  assert.match(semanticApprovedTopicViewScopeIssues({
    files: stagedFiles,
    approvedExistingViewNames: ['food_service__fact_order_items'],
    approvedStagedViewFileNames: ['food_service/subway_locations.view'],
    primaryExistingViewName: 'food_service__fact_order_items',
    baselineRelationshipsYaml: baselineRelationship,
  }).join('\n'), /missing immutable view identity contracts/i);

  const selfAuthorized = semanticApprovedTopicViewScopeIssues({
    files: stagedFiles,
    approvedExistingViewNames: ['food_service__fact_order_items'],
    primaryExistingViewName: 'food_service__fact_order_items',
    baselineRelationshipsYaml: baselineRelationship,
    relationshipDecisions: {
      food_service__subway_locations: 'create_reusable',
    },
  });
  assert.match(selfAuthorized.join('\n'), /staged view outside the reviewed semantic blueprint/i);

  const widenedRelationship = semanticApprovedTopicViewScopeIssues({
    files: [{
      fileName: 'relationships',
      yaml: [
        baselineRelationship,
        '- join_from_view: food_service__fact_order_items',
        '  join_to_view: whataburger__locations',
        '  relationship_type: many_to_one',
      ].join('\n'),
    }],
    approvedExistingViewNames: ['food_service__fact_order_items'],
    primaryExistingViewName: 'food_service__fact_order_items',
    baselineRelationshipsYaml: baselineRelationship,
  });
  assert.match(widenedRelationship.join('\n'), /relationships adds or changes/i);
  assert.match(widenedRelationship.join('\n'), /whataburger__locations/i);
});

test('identity-bound staged views cannot change internal names, table sources, or query sources', () => {
  const tableFile = {
    fileName: 'food_service/subway_locations.view',
    yaml: 'schema: analytics\ntable_name: subway_locations\ndimensions:\n  location_id: {}\n',
  };
  const tableIdentity = semanticViewIdentityContract(tableFile);
  assert.ok(tableIdentity);
  const validateTable = (yaml: string) => semanticApprovedTopicViewScopeIssues({
    files: [{ ...tableFile, yaml }, {
      fileName: 'subway_stats.topic',
      yaml: 'base_view: food_service__fact_order_items\njoins:\n  food_service__subway_locations: {}\n',
    }],
    approvedExistingViewNames: ['food_service__fact_order_items'],
    approvedStagedViewFileNames: [tableFile.fileName],
    approvedStagedViewIdentities: [tableIdentity],
    primaryExistingViewName: 'food_service__fact_order_items',
  }).join('\n');

  assert.equal(validateTable(tableFile.yaml), '');
  assert.match(validateTable(`name: other_locations\n${tableFile.yaml}`), /changes the approved internal view name/i);
  assert.match(
    validateTable(tableFile.yaml.replace('table_name: subway_locations', 'table_name: other_locations')),
    /changes the approved table source contract/i,
  );

  const queryFile = {
    fileName: 'food_service/recent_orders.query.view',
    yaml: 'sql: |\n  SELECT * FROM analytics.orders\ndimensions:\n  order_id: {}\n',
  };
  const queryIdentity = semanticViewIdentityContract(queryFile);
  assert.ok(queryIdentity);
  const queryIssues = semanticApprovedTopicViewScopeIssues({
    files: [{
      ...queryFile,
      yaml: queryFile.yaml.replace('analytics.orders', 'other.orders'),
    }],
    approvedExistingViewNames: [],
    approvedStagedViewFileNames: [queryFile.fileName],
    approvedStagedViewIdentities: [queryIdentity],
  });
  assert.match(queryIssues.join('\n'), /changes the approved query source digest/i);
});

test('relationship decisions reject contract drift and missing authored relationships', () => {
  const baselineRelationship = [
    '- join_from_view: orders',
    '  join_to_view: locations',
    '  join_type: always_left',
    '  on_sql: ${orders.location_id} = ${locations.id}',
    '  relationship_type: many_to_one',
  ].join('\n');

  const changedCardinality = semanticApprovedTopicViewScopeIssues({
    files: [{
      fileName: 'relationships',
      yaml: baselineRelationship.replace('many_to_one', 'many_to_many'),
    }],
    approvedExistingViewNames: ['orders', 'locations'],
    primaryExistingViewName: 'orders',
    baselineRelationshipsYaml: baselineRelationship,
    relationshipDecisions: { locations: 'use_existing' },
  });
  assert.match(changedCardinality.join('\n'), /does not approve a reusable relationship change/i);

  const missingExisting = semanticApprovedTopicViewScopeIssues({
    files: [{ fileName: 'sales.topic', yaml: 'base_view: orders\n' }],
    approvedExistingViewNames: ['orders', 'customers'],
    primaryExistingViewName: 'orders',
    baselineRelationshipsYaml: baselineRelationship,
    relationshipDecisions: { customers: 'use_existing' },
  });
  assert.match(missingExisting.join('\n'), /no exact use_existing relationship contract was approved/i);

  const missingCreated = semanticApprovedTopicViewScopeIssues({
    files: [{ fileName: 'sales.topic', yaml: 'base_view: orders\n' }],
    approvedExistingViewNames: ['orders', 'customers'],
    primaryExistingViewName: 'orders',
    baselineRelationshipsYaml: baselineRelationship,
    relationshipDecisions: { customers: 'create_reusable' },
  });
  assert.match(missingCreated.join('\n'), /staged package does not contain that reviewed relationship change/i);

  assert.deepEqual(semanticApprovedTopicViewScopeIssues({
    files: [{
      fileName: 'relationships',
      yaml: [
        baselineRelationship,
        '- join_from_view: orders',
        '  join_to_view: customers',
        '  join_type: always_left',
        '  on_sql: ${orders.customer_id} = ${customers.id}',
        '  relationship_type: many_to_one',
      ].join('\n'),
    }, { fileName: 'sales.topic', yaml: 'base_view: orders\n' }],
    approvedExistingViewNames: ['orders', 'customers'],
    primaryExistingViewName: 'orders',
    baselineRelationshipsYaml: baselineRelationship,
    relationshipDecisions: { customers: 'create_reusable' },
  }), []);
});

test('AI-proposed relationships are complete, unique, and stay on approved endpoints', () => {
  const proposed = [
    '- join_from_view: orders',
    '  join_to_view: customers',
    '  join_type: always_left',
    '  on_sql: ${orders.customer_id} = ${customers.id}',
    '  relationship_type: many_to_one',
    '  reversible: false',
  ].join('\n');
  const validate = (yaml: string) => semanticApprovedTopicViewScopeIssues({
    files: [{ fileName: 'relationships', yaml }, { fileName: 'sales.topic', yaml: 'base_view: orders\n' }],
    approvedExistingViewNames: ['orders', 'customers'],
    primaryExistingViewName: 'orders',
    baselineRelationshipsYaml: '',
    relationshipDecisions: { customers: 'propose_reusable' },
    relationshipContracts: [],
  });

  assert.deepEqual(validate(proposed), []);
  assert.match(validate(proposed.replace('always_left', 'inner')).join('\n'), /join_type must be exactly always_left/i);
  assert.match(validate(proposed.replace('${customers.id}', '${orders.other_id}')).join('\n'), /must reference a field from "customers"/i);
  assert.match(validate(`${proposed}\n${proposed}`).join('\n'), /same proposed relationship row 2 times/i);
});

test('AI-proposed relationships may use an evidence-backed multi-hop graph', () => {
  const proposed = [
    '- join_from_view: orders',
    '  join_to_view: order_lines',
    '  join_type: always_left',
    '  on_sql: ${orders.id} = ${order_lines.order_id}',
    '  relationship_type: one_to_many',
    '  reversible: false',
    '- join_from_view: order_lines',
    '  join_to_view: products',
    '  join_type: always_left',
    '  on_sql: ${order_lines.product_id} = ${products.id}',
    '  relationship_type: many_to_one',
    '  reversible: false',
  ].join('\n');
  const validate = (yaml: string) => semanticApprovedTopicViewScopeIssues({
    files: [{ fileName: 'relationships', yaml }, { fileName: 'sales.topic', yaml: 'base_view: orders\n' }],
    approvedExistingViewNames: ['orders', 'order_lines', 'products'],
    primaryExistingViewName: 'orders',
    baselineRelationshipsYaml: '',
    relationshipDecisions: {
      order_lines: 'propose_reusable',
      products: 'propose_reusable',
    },
    relationshipContracts: [],
  });

  assert.deepEqual(validate(proposed), []);
  assert.match(
    validate(proposed.replace('join_from_view: orders\n  join_to_view: order_lines', 'join_from_view: order_lines\n  join_to_view: orders')).join('\n'),
    /does not make "order_lines" reachable from "orders"/i,
  );
});

test('a focused relationship replacement cannot delete unrelated authored rows', () => {
  const reviewedRelationship = [
    '- join_from_view: orders',
    '  join_to_view: locations',
    '  relationship_type: many_to_one',
  ].join('\n');
  const unrelatedRelationship = [
    '- join_from_view: payments',
    '  join_to_view: customers',
    '  relationship_type: many_to_one',
  ].join('\n');
  const issues = semanticApprovedTopicViewScopeIssues({
    files: [{ fileName: 'relationships', yaml: reviewedRelationship }],
    approvedExistingViewNames: ['orders', 'locations'],
    primaryExistingViewName: 'orders',
    baselineRelationshipsYaml: [reviewedRelationship, unrelatedRelationship].join('\n'),
    relationshipDecisions: { locations: 'use_existing' },
  });
  assert.match(issues.join('\n'), /removes or rewrites the authored payments -> customers relationship/i);
});

test('relationship preservation uses multiset counts for duplicate authored rows', () => {
  const duplicateRelationship = [
    '- join_from_view: orders',
    '  join_to_view: locations',
    '  join_type: always_left',
    '  on_sql: ${orders.location_id} = ${locations.id}',
    '  relationship_type: many_to_one',
    '  reversible: false',
  ].join('\n');
  const issues = semanticApprovedTopicViewScopeIssues({
    files: [{ fileName: 'relationships', yaml: duplicateRelationship }],
    approvedExistingViewNames: ['orders', 'locations'],
    primaryExistingViewName: 'orders',
    baselineRelationshipsYaml: [duplicateRelationship, duplicateRelationship].join('\n'),
    relationshipDecisions: { locations: 'use_existing' },
  });

  assert.match(issues.join('\n'), /missing 1 of 2 identical authored rows/i);
});

test('use_existing requires exact canonical equality with the authored baseline row', () => {
  const contract: SemanticRelationshipContract = {
    join_from_view: 'orders',
    join_to_view: 'locations',
    join_type: 'always_left',
    on_sql: '${orders.location_id} = ${locations.id}',
    relationship_type: 'many_to_one',
    reversible: false,
  };
  const exactYaml = [
    '- join_from_view: orders',
    '  join_to_view: locations',
    '  join_type: always_left',
    '  on_sql: ${orders.location_id} = ${locations.id}',
    '  relationship_type: many_to_one',
    '  reversible: false',
  ].join('\n');
  const validate = (baselineRelationshipsYaml: string, relationshipContracts = [contract]) => (
    semanticApprovedTopicViewScopeIssues({
      files: [{ fileName: 'sales.topic', yaml: 'base_view: orders\njoins:\n  locations: {}\n' }],
      approvedExistingViewNames: ['orders', 'locations'],
      primaryExistingViewName: 'orders',
      baselineRelationshipsYaml,
      relationshipDecisions: { locations: 'use_existing' },
      relationshipContracts,
    })
  );

  assert.deepEqual(validate(exactYaml), []);
  assert.deepEqual(
    validate(exactYaml.replace('\n  reversible: false', '')),
    [],
    'an omitted reversible flag is canonically equivalent to false',
  );
  assert.match(semanticApprovedTopicViewScopeIssues({
    files: [{ fileName: 'sales.topic', yaml: 'base_view: orders\njoins:\n  locations: {}\n' }],
    approvedExistingViewNames: ['orders', 'locations'],
    primaryExistingViewName: 'orders',
    baselineRelationshipsYaml: exactYaml,
    relationshipDecisions: { locations: 'use_existing' },
  }).join('\n'), /no exact use_existing relationship contract was approved/i);
  assert.match(validate(exactYaml, []).join('\n'), /no exact use_existing relationship contract was approved/i);

  const driftCases = [
    exactYaml.replace('${orders.location_id} = ${locations.id}', '${orders.location_key} = ${locations.id}'),
    exactYaml
      .replace('join_from_view: orders', 'join_from_view: locations')
      .replace('join_to_view: locations', 'join_to_view: orders'),
    exactYaml.replace('join_type: always_left', 'join_type: inner'),
    exactYaml.replace('relationship_type: many_to_one', 'relationship_type: many_to_many'),
    exactYaml.replace('reversible: false', 'reversible: true'),
  ];
  driftCases.forEach((yaml) => {
    assert.match(validate(yaml).join('\n'), /missing 1 of 1 exact approved use_existing rows/i);
  });
});

test('create_reusable relationship contracts require exact complete row equality', () => {
  const contract: SemanticRelationshipContract = {
    join_from_view: 'orders',
    join_to_view: 'locations',
    join_type: 'always_left',
    on_sql: '${orders.location_id} = ${locations.id}',
    relationship_type: 'many_to_one',
    reversible: false,
  };
  const exactYaml = [
    '- join_from_view: orders',
    '  join_to_view: locations',
    '  join_type: always_left',
    '  on_sql: ${orders.location_id} = ${locations.id}',
    '  relationship_type: many_to_one',
    '  reversible: false',
  ].join('\n');
  const validate = (yaml: string) => semanticApprovedTopicViewScopeIssues({
    files: [
      { fileName: 'relationships', yaml },
      { fileName: 'sales.topic', yaml: 'base_view: orders\njoins:\n  locations: {}\n' },
    ],
    approvedExistingViewNames: ['orders', 'locations'],
    primaryExistingViewName: 'orders',
    baselineRelationshipsYaml: '[]\n',
    relationshipDecisions: { locations: 'create_reusable' },
    relationshipContracts: [contract],
  });

  assert.deepEqual(validate(exactYaml), []);

  const driftCases = [
    ['SQL', exactYaml.replace('${orders.location_id} = ${locations.id}', '${orders.location_key} = ${locations.id}')],
    ['direction', exactYaml
      .replace('join_from_view: orders', 'join_from_view: locations')
      .replace('join_to_view: locations', 'join_to_view: orders')],
    ['join type', exactYaml.replace('join_type: always_left', 'join_type: inner')],
    ['cardinality', exactYaml.replace('relationship_type: many_to_one', 'relationship_type: many_to_many')],
    ['reversible', exactYaml.replace('reversible: false', 'reversible: true')],
  ] as const;
  driftCases.forEach(([label, yaml]) => {
    const issues = validate(yaml).join('\n');
    assert.match(issues, /missing 1 of 1 exact approved create_reusable rows/i, `${label} drift must make the approved row missing`);
    assert.match(issues, /does not exactly match an approved create_reusable relationship contract/i, `${label} drift must reject the staged row`);
  });
});

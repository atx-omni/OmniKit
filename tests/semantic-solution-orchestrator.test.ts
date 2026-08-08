import assert from 'node:assert/strict';
import test from 'node:test';

import {
  approvedSemanticSolutionWriteTargets,
  authoredSemanticYamlCommentIssues,
  buildSemanticSolutionGenerationSteps,
  buildSemanticSolutionOrchestration,
  mergeAuthoredRelationshipsBaseline,
  scopedRelationshipsForPrompt,
  orderSemanticSolutionDeployDrafts,
  resumableAcceptedSemanticSolutionFiles,
  semanticSolutionGeneratedFileFingerprint,
} from '../src/services/semanticSolutionOrchestrator';
import {
  buildSemanticSolutionPlan,
  type SemanticSolutionDependencyItem,
  type SemanticSolutionPlan,
} from '../src/services/semanticSolutionPlanner';

function orderedPlan(permissionIntent: 'required' | 'not_required' = 'not_required') {
  return buildSemanticSolutionPlan({
    goal: 'build_new_topic',
    modelYamlFiles: {
      model: 'default_row_limit: 500\n',
      relationships: '[]\n',
      'views/players.view': 'schema: sports\ntable_name: players\n',
    },
    plannedTopicFileName: 'topics/fantasy_rankings.topic',
    requestedArtifactFileNames: [
      'relationships',
      'views/weekly_rankings.query.view',
      'views/players.view',
      'model',
    ],
    permissionIntent,
  });
}

test('returns approved generation steps in deterministic dependency order', () => {
  const plan = orderedPlan();
  const orchestration = buildSemanticSolutionOrchestration(plan);

  assert.deepEqual(
    orchestration.generationSteps.map((step) => [step.action, step.fileName]),
    [
      ['edit', 'model'],
      ['edit', 'views/players.view'],
      ['create', 'views/weekly_rankings.query.view'],
      ['edit', 'relationships'],
      ['create', 'topics/fantasy_rankings.topic'],
    ],
  );
  assert.equal(orchestration.generationSteps.some((step) => step.fileName === 'permissions'), false);
  assert.equal(Object.isFrozen(orchestration.generationSteps), true);
  assert.equal(Object.isFrozen(orchestration.generationSteps[0]?.dependencies), true);
});

test('guided relationship intent stages reusable relationships before the topic without an advanced file request', () => {
  const plan = buildSemanticSolutionPlan({
    goal: 'build_new_topic',
    modelYamlFiles: {
      model: 'default_row_limit: 500\n',
      'views/orders.view': 'schema: analytics\ntable_name: orders\n',
      'views/customers.view': 'schema: analytics\ntable_name: customers\n',
    },
    plannedTopicFileName: 'topics/customer_orders.topic',
    requestedArtifactFileNames: ['views/orders.view', 'views/customers.view'],
    relationshipIntent: 'required',
    permissionIntent: 'not_required',
  });
  const orchestration = buildSemanticSolutionOrchestration(plan);

  assert.deepEqual(
    orchestration.generationSteps.map((step) => [step.action, step.fileName]),
    [
      ['edit', 'views/customers.view'],
      ['edit', 'views/orders.view'],
      ['create', 'relationships'],
      ['create', 'topics/customer_orders.topic'],
    ],
  );
});

test('rejects a blocked plan before orchestration', () => {
  const blockedPlan = buildSemanticSolutionPlan({
    goal: 'build_new_topic',
    modelYamlFiles: {
      model: 'default_row_limit: 500\n',
      'views/players.view': 'schema: sports\ntable_name: players\n',
    },
    plannedTopicFileName: 'fantasy_players.topic',
    requestedArtifactFileNames: ['views/players.view'],
    excludedArtifactFileNames: ['views/players.view'],
  });

  assert.equal(blockedPlan.blocked, true);
  assert.throws(
    () => buildSemanticSolutionGenerationSteps(blockedPlan),
    /semantic solution plan is blocked/i,
  );
});

test('returns a frozen approved target scope and adds Settings/model for permission intent', () => {
  const plan = buildSemanticSolutionPlan({
    goal: 'build_new_topic',
    modelYamlFiles: { model: 'default_row_limit: 500\n' },
    plannedTopicFileName: 'topics/revenue.topic',
    permissionIntent: 'required',
  });

  const targets = approvedSemanticSolutionWriteTargets(plan, { permissionIntent: 'required' });
  assert.deepEqual(targets, ['model', 'topics/revenue.topic']);
  assert.equal(Object.isFrozen(targets), true);
  assert.throws(() => (targets as string[]).push('unapproved.view'), TypeError);

  assert.throws(
    () => orderSemanticSolutionDeployDrafts(plan, [
      { fileName: 'topics/revenue.topic', yaml: 'base_view: revenue\n' },
      { fileName: 'views/unapproved.view', yaml: 'schema: public\n' },
    ], { permissionIntent: 'required' }),
    /outside the approved semantic solution write scope/i,
  );
});

test('orders deploy drafts with non-topic dependencies first and exactly one topic last', () => {
  const plan = orderedPlan();
  const drafts = orderSemanticSolutionDeployDrafts(plan, [
    { fileName: 'topics/fantasy_rankings.topic', yaml: 'base_view: players\n' },
    { fileName: 'relationships', yaml: '- join_from_view: players\n' },
    { fileName: 'views/weekly_rankings.query.view', yaml: 'sql: select 1\n' },
    { fileName: 'model', yaml: 'default_row_limit: 1000\n' },
    { fileName: 'views/players.view', yaml: 'schema: sports\ntable_name: players\n' },
  ]);

  assert.deepEqual(drafts.map((draft) => draft.fileName), [
    'model',
    'views/players.view',
    'views/weekly_rankings.query.view',
    'relationships',
    'topics/fantasy_rankings.topic',
  ]);
  assert.equal(Object.isFrozen(drafts), true);
});

test('rejects duplicate filenames and multiple topics', () => {
  const plan = orderedPlan();
  const view = plan.items.find((item) => item.fileName === 'views/players.view');
  assert.ok(view);

  const duplicatePlan: SemanticSolutionPlan = {
    ...plan,
    items: [...plan.items, { ...view, id: 'view:duplicate-players' }],
  };
  assert.throws(
    () => buildSemanticSolutionGenerationSteps(duplicatePlan),
    /duplicate filename/i,
  );

  const extraTopic: SemanticSolutionDependencyItem = {
    id: 'topic:topics/second.topic',
    kind: 'topic',
    fileName: 'topics/second.topic',
    readiness: 'missing',
    action: 'create',
    reason: 'Test-only malformed second topic.',
    dependencies: ['model:model'],
    required: true,
    requested: true,
    exists: false,
  };
  const multiTopicPlan: SemanticSolutionPlan = {
    ...plan,
    items: [...plan.items, extraTopic],
  };
  assert.throws(
    () => buildSemanticSolutionGenerationSteps(multiTopicPlan),
    /only one \.topic artifact/i,
  );

  assert.throws(
    () => orderSemanticSolutionDeployDrafts(plan, [
      { fileName: 'topics/fantasy_rankings.topic', yaml: 'base_view: players\n' },
      { fileName: 'topics/fantasy_rankings.topic', yaml: 'base_view: players\n' },
    ]),
    /duplicate filename/i,
  );
});

test('resumes only accepted nonempty generated files whose local fingerprint has not drifted', () => {
  const plan = orderedPlan();
  const acceptedView = {
    fileName: 'views/players.view',
    yaml: 'schema: sports\ntable_name: players\n',
  };
  const acceptedTopic = {
    fileName: 'topics/fantasy_rankings.topic',
    yaml: 'base_view: players\n',
  };
  const acceptedRelationships = {
    fileName: 'relationships',
    yaml: '   \n',
  };

  const resumable = resumableAcceptedSemanticSolutionFiles(plan, [
    {
      ...acceptedTopic,
      yaml: 'base_view: changed_after_acceptance\n',
      acceptedFingerprint: semanticSolutionGeneratedFileFingerprint(acceptedTopic),
    },
    {
      ...acceptedRelationships,
      acceptedFingerprint: semanticSolutionGeneratedFileFingerprint(acceptedRelationships),
    },
    {
      ...acceptedView,
      acceptedFingerprint: semanticSolutionGeneratedFileFingerprint(acceptedView),
    },
  ]);

  assert.deepEqual(resumable.map((file) => file.fileName), ['views/players.view']);
  assert.equal(Object.isFrozen(resumable), true);
  assert.match(resumable[0]?.acceptedFingerprint || '', /^fnv1a64:[a-f0-9]{16}$/);
});

test('blocks complete replacement YAML that omits source-authored model or relationship comments', () => {
  assert.deepEqual(
    authoredSemanticYamlCommentIssues(
      'model',
      '# Preserve this governance note\nai_context: |-\n  # This is block-scalar content, not a YAML comment.\n  Keep it.\n',
      '# Preserve this governance note\nai_context: |-\n  Revised guidance.\n',
    ),
    [],
  );

  const modelIssues = authoredSemanticYamlCommentIssues(
    'model',
    '# Preserve this governance note\ndefault_row_limit: 500\n',
    'default_row_limit: 500\n',
  );
  assert.equal(modelIssues.length, 1);
  assert.match(modelIssues[0], /model omits 1 source-authored YAML comment/i);
  assert.match(modelIssues[0], /Preserve this governance note/);

  const relationshipIssues = authoredSemanticYamlCommentIssues(
    'relationships',
    '# Store-day fanout warning\n- join_from_view: orders\n  join_to_view: store_day\n',
    '- join_from_view: orders\n  join_to_view: store_day\n',
  );
  assert.equal(relationshipIssues.length, 1);
  assert.match(relationshipIssues[0], /relationships omits 1 source-authored YAML comment/i);
});

test('relationship generation preserves excluded authored rows and comments while appending proposals', () => {
  const source = [
    '# Existing domain relationship',
    '- join_from_view: legacy_orders',
    '  join_to_view: legacy_locations',
    '  join_type: always_left',
    '  on_sql: ${legacy_orders.location_id} = ${legacy_locations.id}',
    '  relationship_type: many_to_one',
  ].join('\n');
  const candidate = [
    '- join_from_view: legacy_orders',
    '  join_to_view: legacy_locations',
    '  join_type: always_left',
    '  on_sql: ${legacy_orders.location_id} = ${legacy_locations.id}',
    '  relationship_type: many_to_one',
    '- join_from_view: orders',
    '  join_to_view: customers',
    '  join_type: always_left',
    '  on_sql: ${orders.customer_id} = ${customers.id}',
    '  relationship_type: many_to_one',
  ].join('\n');

  const merged = mergeAuthoredRelationshipsBaseline(source, candidate);
  assert.match(merged, /^# Existing domain relationship/m);
  assert.equal((merged.match(/join_from_view: legacy_orders/g) || []).length, 1);
  assert.equal((merged.match(/join_from_view: orders/g) || []).length, 1);
  assert.deepEqual(authoredSemanticYamlCommentIssues('relationships', source, merged), []);
});

test('topic prompt relationship evidence includes only approved endpoints', () => {
  const relationships = [
    '- join_from_view: unrelated_orders',
    '  join_to_view: unrelated_locations',
    '- join_from_view: orders',
    '  join_to_view: order_lines',
    '  join_type: always_left',
    '  on_sql: ${orders.id} = ${order_lines.order_id}',
    '  relationship_type: one_to_many',
  ].join('\n');
  const scoped = scopedRelationshipsForPrompt(relationships, ['orders', 'order_lines']);
  assert.match(scoped, /join_from_view: orders/);
  assert.match(scoped, /join_to_view: order_lines/);
  assert.doesNotMatch(scoped, /unrelated_/);
});

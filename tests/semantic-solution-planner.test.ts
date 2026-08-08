import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSemanticSolutionPlan,
  type SemanticArtifactKind,
  type SemanticSolutionDependencyItem,
  type SemanticSolutionDependencyPlan,
} from '../src/services/semanticSolutionPlanner';

function itemByKind(
  plan: SemanticSolutionDependencyPlan,
  kind: SemanticArtifactKind,
): SemanticSolutionDependencyItem {
  const matches = plan.items.filter((item) => item.kind === kind);
  assert.equal(matches.length, 1, `Expected one ${kind} item.`);
  return matches[0];
}

function itemByFileName(
  plan: SemanticSolutionDependencyPlan,
  fileName: string,
): SemanticSolutionDependencyItem {
  const item = plan.items.find((candidate) => candidate.fileName === fileName);
  assert.ok(item, `Expected a dependency item for ${fileName}.`);
  return item;
}

test('plans a new fantasy-football topic with existing sports dependencies', () => {
  const plan = buildSemanticSolutionPlan({
    goal: 'build_new_topic',
    modelYamlFiles: {
      model: 'default_row_limit: 500\n',
      relationships: '- join_from_view: players\n  join_to_view: teams\n',
      'sports/players.view': 'schema: sports\ntable_name: players\n',
      'sports/teams.view': 'schema: sports\ntable_name: teams\n',
      'sports/player_week_projection.query.view': 'sql: select * from projections\n',
    },
    plannedTopicFileName: 'topics/fantasy_football_high_performers.topic',
    requestedArtifactFileNames: [
      'sports/player_week_projection.query.view',
      'relationships',
      'sports/teams.view',
      'sports/players.view',
    ],
    permissionIntent: 'required',
  });

  assert.equal(plan.blocked, false);
  assert.deepEqual(plan.items.map((item) => [item.kind, item.fileName]), [
    ['model', 'model'],
    ['view', 'sports/players.view'],
    ['view', 'sports/teams.view'],
    ['query_view', 'sports/player_week_projection.query.view'],
    ['relationships', 'relationships'],
    ['topic', 'topics/fantasy_football_high_performers.topic'],
    ['permissions', 'permissions'],
  ]);

  assert.deepEqual(
    plan.items.slice(1, 5).map((item) => [item.readiness, item.action]),
    [
      ['needs_work', 'edit'],
      ['needs_work', 'edit'],
      ['needs_work', 'edit'],
      ['needs_work', 'edit'],
    ],
  );
  const topic = itemByKind(plan, 'topic');
  assert.equal(topic.readiness, 'missing');
  assert.equal(topic.action, 'create');
  assert.deepEqual(topic.dependencies, [
    'model:model',
    'view:sports/players.view',
    'view:sports/teams.view',
    'query_view:sports/player_week_projection.query.view',
    'relationships:relationships',
  ]);
  assert.deepEqual(itemByKind(plan, 'permissions').dependencies, [
    'model:model',
    'topic:topics/fantasy_football_high_performers.topic',
  ]);
  assert.deepEqual(plan.summary, {
    total: 7,
    byReadiness: {
      ready: 1,
      needs_work: 5,
      missing: 1,
      not_required: 0,
      blocked: 0,
    },
    byAction: {
      reuse: 1,
      edit: 5,
      create: 1,
      exclude: 0,
    },
  });
});

test('plans an existing-topic update as an edit without inventing dependencies', () => {
  const plan = buildSemanticSolutionPlan({
    goal: 'improve_existing_topic',
    modelYamlFiles: {
      model: 'default_row_limit: 500\n',
      relationships: '[]\n',
      'views/weather.view': 'schema: public\ntable_name: weather\n',
      'topics/weather_coffee.topic': 'base_view: weather\n',
    },
    selectedTopicName: 'Weather Coffee',
    permissionIntent: 'not_required',
  });

  const topic = itemByKind(plan, 'topic');
  assert.equal(plan.blocked, false);
  assert.equal(plan.topicFileName, 'topics/weather_coffee.topic');
  assert.equal(topic.readiness, 'needs_work');
  assert.equal(topic.action, 'edit');
  assert.equal(topic.exists, true);
  assert.deepEqual(topic.dependencies, ['model:model']);
  assert.deepEqual(
    [itemByKind(plan, 'model').action, itemByKind(plan, 'relationships').action],
    ['reuse', 'reuse'],
  );
  assert.match(itemByKind(plan, 'relationships').reason, /will be reused.*No relationship YAML will be generated/i);
});

test('creates missing requested views and classifies query views before generic views', () => {
  const plan = buildSemanticSolutionPlan({
    goal: 'build_new_topic',
    modelYamlFiles: { model: 'default_row_limit: 500\n' },
    plannedTopicFileName: 'fantasy_rankings.topic',
    requestedArtifactFileNames: [
      'views/week_rankings.query.view',
      'views/player_rankings.view',
    ],
  });

  const view = itemByFileName(plan, 'views/player_rankings.view');
  const queryView = itemByFileName(plan, 'views/week_rankings.query.view');
  assert.deepEqual([view.kind, view.readiness, view.action], ['view', 'missing', 'create']);
  assert.deepEqual(
    [queryView.kind, queryView.readiness, queryView.action],
    ['query_view', 'missing', 'create'],
  );
  assert.ok(plan.items.indexOf(view) < plan.items.indexOf(queryView));
  assert.deepEqual(itemByKind(plan, 'topic').dependencies, [
    'model:model',
    'view:views/player_rankings.view',
    'query_view:views/week_rankings.query.view',
  ]);
  assert.equal(plan.blocked, false);
});

test('blocks a topic when a required dependency is excluded', () => {
  const plan = buildSemanticSolutionPlan({
    goal: 'build_new_topic',
    modelYamlFiles: {
      model: 'default_row_limit: 500\n',
      'sports/players.view': 'schema: sports\ntable_name: players\n',
    },
    plannedTopicFileName: 'fantasy_players.topic',
    requestedArtifactFileNames: ['players.view'],
    excludedArtifactFileNames: ['sports/players.view'],
  });

  const view = itemByFileName(plan, 'sports/players.view');
  const topic = itemByKind(plan, 'topic');
  assert.deepEqual([view.readiness, view.action], ['blocked', 'exclude']);
  assert.deepEqual([topic.readiness, topic.action], ['blocked', 'exclude']);
  assert.match(topic.reason, /required view .* is excluded or blocked/i);
  assert.equal(plan.blocked, true);
  assert.ok(plan.summary.byReadiness.blocked >= 2);
});

test('blocks unsafe requested paths and an unsafe planned topic filename', () => {
  const plan = buildSemanticSolutionPlan({
    goal: 'build_new_topic',
    modelYamlFiles: { model: 'default_row_limit: 500\n' },
    plannedTopicFileName: '../fantasy.topic',
    requestedArtifactFileNames: [
      '../../private/projections.query.view',
      '/tmp/players.view',
      'notes.yaml',
    ],
  });

  const unsafeItems = plan.items.filter((item) => (
    item.kind === 'view' || item.kind === 'query_view' || item.kind === 'topic'
  ));
  assert.equal(unsafeItems.length, 3);
  unsafeItems.forEach((item) => {
    assert.equal(item.readiness, 'blocked');
    assert.equal(item.action, 'exclude');
    assert.match(item.reason, /unsafe|blocked/i);
  });
  assert.equal(plan.blocked, true);
  assert.match(plan.blockers.join('\n'), /notes\.yaml.*not a supported semantic filename/i);
  assert.equal(plan.summary.byAction.create, 0);
});

test('marks absent optional relationships and permissions as not required', () => {
  const plan = buildSemanticSolutionPlan({
    goal: 'build_new_topic',
    modelYamlFiles: { model: 'default_row_limit: 500\n' },
    plannedTopicFileName: 'fantasy_football.topic',
    permissionIntent: 'not_required',
  });

  const relationships = itemByKind(plan, 'relationships');
  const permissions = itemByKind(plan, 'permissions');
  const topic = itemByKind(plan, 'topic');
  assert.deepEqual(
    [relationships.readiness, relationships.action, relationships.required],
    ['not_required', 'exclude', false],
  );
  assert.match(relationships.reason, /No global relationship change is planned.*exact join contract is confirmed/i);
  assert.deepEqual(
    [permissions.readiness, permissions.action, permissions.required],
    ['not_required', 'exclude', false],
  );
  assert.deepEqual(topic.dependencies, ['model:model']);
  assert.equal(topic.readiness, 'missing');
  assert.equal(plan.blocked, false);
});

test('guided topic planning creates a missing reusable relationships file before the topic', () => {
  const plan = buildSemanticSolutionPlan({
    goal: 'build_new_topic',
    modelYamlFiles: {
      model: 'default_row_limit: 500\n',
      'sports/players.view': 'schema: sports\ntable_name: players\n',
      'sports/teams.view': 'schema: sports\ntable_name: teams\n',
    },
    plannedTopicFileName: 'topics/player_performance.topic',
    requestedArtifactFileNames: ['sports/players.view', 'sports/teams.view'],
    relationshipIntent: 'required',
    permissionIntent: 'not_required',
  });

  const relationships = itemByKind(plan, 'relationships');
  const topic = itemByKind(plan, 'topic');
  assert.deepEqual(
    [relationships.readiness, relationships.action, relationships.required, relationships.exists],
    ['missing', 'create', true, false],
  );
  assert.match(relationships.reason, /requires reusable relationship YAML/i);
  assert.ok(topic.dependencies.includes('relationships:relationships'));
  assert.ok(plan.items.indexOf(relationships) < plan.items.indexOf(topic));
  assert.equal(plan.blocked, false);
});

test('guided topic planning reviews an existing relationship file without replacing it silently', () => {
  const plan = buildSemanticSolutionPlan({
    goal: 'improve_existing_topic',
    modelYamlFiles: {
      model: 'default_row_limit: 500\n',
      relationships: [
        '- join_from_view: players',
        '  join_to_view: teams',
        '  join_type: always_left',
        '  on_sql: ${players.team_id} = ${teams.id}',
        '  relationship_type: many_to_one',
      ].join('\n'),
      'topics/player_performance.topic': 'base_view: players\n',
    },
    selectedTopicName: 'Player Performance',
    relationshipIntent: 'required',
    permissionIntent: 'not_required',
  });

  const relationships = itemByKind(plan, 'relationships');
  assert.deepEqual(
    [relationships.readiness, relationships.action, relationships.required, relationships.exists],
    ['needs_work', 'edit', true, true],
  );
  assert.match(relationships.reason, /Preserve existing joins/i);
  assert.ok(itemByKind(plan, 'topic').dependencies.includes('relationships:relationships'));
});

test('guided topic planning permits an explicit single-view relationship opt-out', () => {
  const plan = buildSemanticSolutionPlan({
    goal: 'build_new_topic',
    modelYamlFiles: { model: 'default_row_limit: 500\n' },
    plannedTopicFileName: 'topics/single_view.topic',
    relationshipIntent: 'not_required',
    permissionIntent: 'not_required',
  });

  const relationships = itemByKind(plan, 'relationships');
  assert.deepEqual(
    [relationships.readiness, relationships.action, relationships.required],
    ['not_required', 'exclude', false],
  );
  assert.deepEqual(itemByKind(plan, 'topic').dependencies, ['model:model']);
});

test('returns stable IDs, ordering, dependencies, and summaries for reordered inputs', () => {
  const first = buildSemanticSolutionPlan({
    goal: 'build_new_topic',
    modelYamlFiles: {
      'views/zebra.view': 'schema: sports\n',
      model: 'default_row_limit: 500\n',
      'views/alpha.query.view': 'sql: select 1\n',
      relationships: '[]\n',
    },
    plannedTopicFileName: 'stable.topic',
    requestedArtifactFileNames: ['relationships', 'views/zebra.view', 'views/alpha.query.view'],
    permissionIntent: 'required',
  });
  const second = buildSemanticSolutionPlan({
    goal: 'build_new_topic',
    modelYamlFiles: {
      relationships: '[]\n',
      'views/alpha.query.view': 'sql: select 1\n',
      model: 'default_row_limit: 500\n',
      'views/zebra.view': 'schema: sports\n',
    },
    plannedTopicFileName: 'stable.topic',
    requestedArtifactFileNames: ['views/alpha.query.view', 'views/zebra.view', 'relationships'],
    permissionIntent: 'required',
  });

  assert.deepEqual(second, first);
  assert.deepEqual(first.items.map((item) => item.id), [
    'model:model',
    'view:views/zebra.view',
    'query_view:views/alpha.query.view',
    'relationships:relationships',
    'topic:stable.topic',
    'permissions:permissions',
  ]);
});

test('applies a valid edit override to an existing ready dependency', () => {
  const plan = buildSemanticSolutionPlan({
    goal: 'build_new_topic',
    modelYamlFiles: {
      model: 'default_row_limit: 500\n',
      relationships: '[]\n',
    },
    plannedTopicFileName: 'edited_relationships.topic',
    actionOverrides: {
      'relationships:relationships': 'edit',
    },
  });

  const relationships = itemByKind(plan, 'relationships');
  assert.deepEqual(
    [relationships.readiness, relationships.action, relationships.required, relationships.requested],
    ['needs_work', 'edit', true, true],
  );
  assert.match(relationships.reason, /user explicitly chose to edit/i);
  assert.deepEqual(itemByKind(plan, 'topic').dependencies, [
    'model:model',
    'relationships:relationships',
  ]);
  assert.equal(plan.blocked, false);
});

test('applies a valid create override to an absent optional dependency', () => {
  const plan = buildSemanticSolutionPlan({
    goal: 'build_new_topic',
    modelYamlFiles: { model: 'default_row_limit: 500\n' },
    plannedTopicFileName: 'created_relationships.topic',
    actionOverrides: {
      'relationships:relationships': 'create',
    },
  });

  const relationships = itemByKind(plan, 'relationships');
  assert.deepEqual(
    [relationships.readiness, relationships.action, relationships.required, relationships.requested],
    ['missing', 'create', true, true],
  );
  assert.match(relationships.reason, /explicitly requested creation/i);
  assert.deepEqual(itemByKind(plan, 'topic').dependencies, [
    'model:model',
    'relationships:relationships',
  ]);
  assert.equal(plan.blocked, false);
});

test('applies a valid reuse override to a requested existing dependency', () => {
  const plan = buildSemanticSolutionPlan({
    goal: 'build_new_topic',
    modelYamlFiles: {
      model: 'default_row_limit: 500\n',
      'sports/players.view': 'schema: sports\ntable_name: players\n',
    },
    plannedTopicFileName: 'reused_players.topic',
    requestedArtifactFileNames: ['players.view'],
    actionOverrides: {
      'view:sports/players.view': 'reuse',
    },
  });

  const view = itemByFileName(plan, 'sports/players.view');
  assert.deepEqual([view.readiness, view.action], ['ready', 'reuse']);
  assert.match(view.reason, /explicitly chose to reuse/i);
  assert.deepEqual(itemByKind(plan, 'topic').dependencies, [
    'model:model',
    'view:sports/players.view',
  ]);
  assert.equal(plan.blocked, false);
});

test('blocks the plan and topic when an override excludes a required dependency', () => {
  const plan = buildSemanticSolutionPlan({
    goal: 'build_new_topic',
    modelYamlFiles: {
      model: 'default_row_limit: 500\n',
      'sports/players.view': 'schema: sports\ntable_name: players\n',
    },
    plannedTopicFileName: 'excluded_players.topic',
    requestedArtifactFileNames: ['players.view'],
    actionOverrides: {
      'view:sports/players.view': 'exclude',
    },
  });

  const view = itemByFileName(plan, 'sports/players.view');
  const topic = itemByKind(plan, 'topic');
  assert.deepEqual([view.readiness, view.action], ['blocked', 'exclude']);
  assert.match(view.reason, /user excluded required view/i);
  assert.deepEqual([topic.readiness, topic.action], ['blocked', 'exclude']);
  assert.match(topic.reason, /required view .* is excluded or blocked/i);
  assert.equal(plan.blocked, true);
});

test('turns invalid, unknown, and force-through overrides into explicit blockers', () => {
  const plan = buildSemanticSolutionPlan({
    goal: 'build_new_topic',
    modelYamlFiles: {
      model: 'default_row_limit: 500\n',
      'sports/players.view': 'schema: sports\ntable_name: players\n',
    },
    plannedTopicFileName: 'invalid_overrides.topic',
    requestedArtifactFileNames: ['players.view', '../unsafe.query.view'],
    actionOverrides: {
      'view:sports/players.view': 'create',
      'query_view:../unsafe.query.view': 'create',
      'view:not-in-plan.view': 'reuse',
    },
  });

  const existingView = itemByFileName(plan, 'sports/players.view');
  const unsafeQueryView = itemByFileName(plan, '../unsafe.query.view');
  assert.deepEqual([existingView.readiness, existingView.action], ['blocked', 'create']);
  assert.match(existingView.reason, /invalid.*existing artifact cannot be created again/i);
  assert.deepEqual([unsafeQueryView.readiness, unsafeQueryView.action], ['blocked', 'create']);
  assert.match(unsafeQueryView.reason, /invalid.*already blocked/i);
  assert.match(plan.blockers.join('\n'), /unknown dependency item ID "view:not-in-plan\.view"/i);
  assert.equal(itemByKind(plan, 'topic').readiness, 'blocked');
  assert.equal(plan.blocked, true);
});

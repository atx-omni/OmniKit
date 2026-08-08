import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import {
  compileSemanticPermissionYaml,
  EMPTY_SEMANTIC_PERMISSION_CONTRACT_DRAFT,
  formatSemanticPermissionContract,
  normalizeSemanticPermissionUserAttributes,
  planSemanticPermissionMerge,
  renderSemanticPermissionAccessGrantEntries,
  renderSemanticPermissionRequiredAccessGrants,
  renderSemanticPermissionTopicAccessFilters,
  semanticPermissionContractFromDraft,
  semanticPermissionContractIssues,
  semanticPermissionFieldOptions,
  semanticPermissionFilterableViewOptions,
  semanticPermissionListValues,
  semanticPermissionMetadataIssues,
  semanticPermissionPackageIssues,
  semanticPermissionReviewedBaseViewNames,
  type SemanticPermissionContractDraft,
} from '../src/services/semanticPermissionContract';

const COMPLETE_DRAFT: SemanticPermissionContractDraft = {
  mode: 'grant_and_row_filter',
  grants: [{
    id: 'grant-regional',
    name: 'regional_access',
    userAttribute: 'region',
    allowedValues: ['Central', 'West', 'Admin'],
    accessBoostable: false,
  }],
  grantLogic: 'all',
  filters: [{
    id: 'filter-region',
    field: 'orders.region',
    userAttribute: 'region',
    allowUnfilteredValues: true,
    valuesForUnfiltered: ['Admin', 'all_regions'],
  }],
  reviewedAndConfirmed: true,
};

test('permission contract fails closed until every enforceable input is confirmed', () => {
  const issues = semanticPermissionContractIssues(EMPTY_SEMANTIC_PERMISSION_CONTRACT_DRAFT);

  assert.equal(issues.length, 6);
  assert.equal(semanticPermissionContractFromDraft(EMPTY_SEMANTIC_PERMISSION_CONTRACT_DRAFT), null);
  assert.match(issues.join(' '), /user attribute/i);
  assert.match(issues.join(' '), /fail closed/i);
});

test('grant-only and row-filter-only policies require only their selected controls', () => {
  const grantOnly = semanticPermissionContractFromDraft({
    ...COMPLETE_DRAFT,
    mode: 'grant_only',
    filters: [],
  });
  assert.ok(grantOnly);
  assert.equal(grantOnly.topicAccessFilters.length, 0);

  const filterOnly = semanticPermissionContractFromDraft({
    ...COMPLETE_DRAFT,
    mode: 'row_filter_only',
    grants: [],
    filters: [{ ...COMPLETE_DRAFT.filters[0], allowUnfilteredValues: false, valuesForUnfiltered: [] }],
  });
  assert.ok(filterOnly);
  assert.equal(filterOnly.accessGrants.length, 0);
  assert.equal(filterOnly.topicRequiredAccessGrants.length, 0);
  assert.equal(filterOnly.topicAccessFilters[0].valuesForUnfiltered.length, 0);
});

test('permission contract produces one exact model grant and topic policy', () => {
  const contract = semanticPermissionContractFromDraft(COMPLETE_DRAFT);

  assert.deepEqual(contract, {
    accessGrants: [{
      name: 'regional_access',
      userAttribute: 'region',
      allowedValues: ['Central', 'West', 'Admin'],
      accessBoostable: false,
    }],
    topicRequiredAccessGrants: ['regional_access'],
    topicAccessFilters: [{
      field: 'orders.region',
      userAttribute: 'region',
      valuesForUnfiltered: ['Admin', 'all_regions'],
    }],
  });
});

test('permission contract preserves explicit AccessBoost intent', () => {
  const contract = semanticPermissionContractFromDraft({
    ...COMPLETE_DRAFT,
    grants: [{ ...COMPLETE_DRAFT.grants[0], accessBoostable: true }],
  });
  assert.equal(contract?.accessGrants[0].accessBoostable, true);
});

test('permission contract supports multiple grants with explicit all or any logic and multiple filters', () => {
  const multiDraft: SemanticPermissionContractDraft = {
    ...COMPLETE_DRAFT,
    grants: [
      COMPLETE_DRAFT.grants[0],
      { id: 'grant-finance', name: 'finance_access', userAttribute: 'department', allowedValues: ['Finance'], accessBoostable: true },
    ],
    filters: [
      COMPLETE_DRAFT.filters[0],
      { id: 'filter-department', field: 'orders.department', userAttribute: 'department', allowUnfilteredValues: false, valuesForUnfiltered: [] },
    ],
  };

  const allContract = semanticPermissionContractFromDraft(multiDraft);
  assert.equal(allContract?.accessGrants.length, 2);
  assert.deepEqual(allContract?.topicRequiredAccessGrants, ['regional_access&finance_access']);
  assert.equal(allContract?.topicAccessFilters.length, 2);

  const anyContract = semanticPermissionContractFromDraft({ ...multiDraft, grantLogic: 'any' });
  assert.deepEqual(anyContract?.topicRequiredAccessGrants, ['regional_access|finance_access']);
});

test('permission contract renders documented Omni model and topic YAML shapes', () => {
  const contract = semanticPermissionContractFromDraft({
    ...COMPLETE_DRAFT,
    grants: [{ ...COMPLETE_DRAFT.grants[0], accessBoostable: true }],
  });
  assert.ok(contract);

  assert.equal(renderSemanticPermissionAccessGrantEntries(contract.accessGrants).join('\n'), [
    '  regional_access:',
    '    user_attribute: region',
    '    allowed_values:',
    '      - "Central"',
    '      - "West"',
    '      - "Admin"',
    '    access_boostable: true',
  ].join('\n'));
  assert.equal(renderSemanticPermissionRequiredAccessGrants(contract.topicRequiredAccessGrants), [
    'required_access_grants:',
    '  - regional_access',
  ].join('\n'));
  assert.equal(renderSemanticPermissionTopicAccessFilters(contract.topicAccessFilters), [
    'access_filters:',
    '  - field: orders.region',
    '    user_attribute: region',
    '    values_for_unfiltered:',
    '      - "Admin"',
    '      - "all_regions"',
  ].join('\n'));
});

test('permission list parsing removes duplicates, quotes, and unsafe line breaks', () => {
  assert.deepEqual(
    semanticPermissionListValues('"Central", central, West, bad\nvalue, `Admin`'),
    ['Central', 'West', 'Admin'],
  );
});

test('permission metadata normalizes Omni attributes and topic fields for selectors', () => {
  const attributes = normalizeSemanticPermissionUserAttributes({
    records: [
      { name: 'omni_user_groups', label: 'Omni User Groups', type: 'String', multiple_values: true, system: true },
      { name: 'region', label: 'Region', type: 'String', multiple_values: false, system: false, default_value: 'Central' },
      { name: 'region', label: 'Duplicate Region', type: 'String' },
    ],
  });
  assert.deepEqual(attributes.map((attribute) => attribute.reference), ['region', 'omni_user_groups']);
  assert.equal(attributes[0].defaultValue, 'Central');
  assert.equal(attributes[1].multipleValues, true);

  const fields = semanticPermissionFieldOptions({
    topicDetail: {
      views: [
        {
          name: 'orders',
          dimensions: [
            { field_name: 'region', label: 'Sales Region', fully_qualified_name: 'orders.region' },
            { name: 'department' },
          ],
          filter_only_fields: [{ field_name: 'tenant_scope', label: 'Tenant Scope' }],
          measures: [{ name: 'revenue' }],
        },
        { view_name: 'customers', fields: ['customer_tier'] },
      ],
    },
    modelFiles: {
      'views/fallback.view': 'dimensions:\n  fallback_region: {}\n',
    },
  });
  assert.deepEqual(fields.map((field) => field.reference), ['customers.customer_tier', 'orders.department', 'orders.region', 'orders.tenant_scope']);
  assert.equal(fields.find((field) => field.reference === 'orders.region')?.label, 'Sales Region');
  assert.equal(fields.some((field) => field.reference === 'orders.revenue'), false);
});

test('net-new topic permission fields stay inside the reviewed topic view scope', () => {
  const modelFiles = {
    'views/subway_orders.view': 'dimensions:\n  store_region: {}\n  order_id: {}\n',
    'views/dim_whataburger_crew.view': 'dimensions:\n  role: {}\n',
  };
  const modelViewNames = {
    'views/subway_orders.view': 'food_service__subway_orders',
    'views/dim_whataburger_crew.view': 'dim_whataburger_crew',
  };

  assert.deepEqual(semanticPermissionFieldOptions({
    modelFiles,
    modelViewNames,
  }), []);

  assert.deepEqual(semanticPermissionFieldOptions({
    modelFiles,
    modelViewNames,
    allowedViewNames: ['food_service__subway_orders'],
  }).map((field) => field.reference), [
    'food_service__subway_orders.order_id',
    'food_service__subway_orders.store_region',
  ]);
});

test('net-new topic permissions recover the reviewed base view before topic YAML exists', () => {
  const reviewedBaseViews = semanticPermissionReviewedBaseViewNames([
    {
      decision: 'create_new',
      baseView: 'food_service__subway_orders',
    },
    'base_view: food_service__subway_orders',
    'Unrelated prose may mention dim_whataburger_crew, but it is not reviewed base-view evidence.',
  ]);
  const fields = semanticPermissionFieldOptions({
    modelFiles: {
      'views/subway_orders.view': 'dimensions:\n  store_region: {}\n  order_id: {}\n',
      'views/dim_whataburger_crew.view': 'dimensions:\n  role: {}\n',
    },
    modelViewNames: {
      'views/subway_orders.view': 'food_service__subway_orders',
      'views/dim_whataburger_crew.view': 'dim_whataburger_crew',
    },
    allowedViewNames: reviewedBaseViews.slice(0, 1),
  });

  assert.deepEqual(reviewedBaseViews, ['food_service__subway_orders']);
  assert.deepEqual(fields.map((field) => field.reference), [
    'food_service__subway_orders.order_id',
    'food_service__subway_orders.store_region',
  ]);
});

test('net-new topic permissions expose only exact model views that own filterable dimensions', () => {
  const options = semanticPermissionFilterableViewOptions({
    modelFiles: {
      'views/orders.view': 'dimensions:\n  region: {}\n  order_id: {}\n',
      'views/crew.view': 'dimensions:\n  role: {}\n',
      'views/measure_only.view': 'measures:\n  revenue: {}\n',
    },
    modelViewNames: {
      'views/orders.view': 'food_service__orders',
      'views/crew.view': 'dim_crew',
      'views/measure_only.view': 'measure_only',
    },
  });

  assert.deepEqual(options, [
    { name: 'dim_crew', fieldCount: 1 },
    { name: 'food_service__orders', fieldCount: 2 },
  ]);
});

test('permission metadata validation fails closed on attributes or fields outside the loaded inventories', () => {
  const issues = semanticPermissionMetadataIssues(COMPLETE_DRAFT, {
    userAttributes: [{ reference: 'department', label: 'Department', type: 'String', multipleValues: false, system: false, defaultValue: '' }],
    fieldOptions: [{ reference: 'orders.department', label: 'department', viewName: 'orders', fieldName: 'department', kind: 'dimension' }],
    userAttributesLoaded: true,
  });

  assert.match(issues.join(' '), /region is not present/i);
  assert.match(issues.join(' '), /orders\.region is not reachable/i);
});

test('permission metadata blocks an attribute default from becoming an unfiltered bypass', () => {
  const issues = semanticPermissionMetadataIssues(COMPLETE_DRAFT, {
    userAttributes: [{ reference: 'region', label: 'Region', type: 'String', multipleValues: false, system: false, defaultValue: 'Admin' }],
    fieldOptions: [{ reference: 'orders.region', label: 'Region', viewName: 'orders', fieldName: 'region', kind: 'dimension' }],
    userAttributesLoaded: true,
  });

  assert.match(issues.join(' '), /cannot be used as an unfiltered bypass value/i);
});

test('multi-rule permission compilation writes every grant, expression, and row filter', () => {
  const contract = semanticPermissionContractFromDraft({
    ...COMPLETE_DRAFT,
    grants: [
      COMPLETE_DRAFT.grants[0],
      { id: 'grant-finance', name: 'finance_access', userAttribute: 'department', allowedValues: ['Finance'], accessBoostable: false },
    ],
    filters: [
      COMPLETE_DRAFT.filters[0],
      { id: 'filter-department', field: 'orders.department', userAttribute: 'department', allowUnfilteredValues: false, valuesForUnfiltered: [] },
    ],
  });
  assert.ok(contract);

  const compiled = compileSemanticPermissionYaml({
    sourceModelYaml: 'label: Sales\n',
    baselineModelYaml: 'label: Sales\n',
    sourceTopicYaml: 'base_view: orders\n',
    baselineTopicYaml: 'base_view: orders\n',
    contract,
  });

  assert.deepEqual(compiled.plan.blockers, []);
  assert.match(compiled.modelYaml, /regional_access:/);
  assert.match(compiled.modelYaml, /finance_access:/);
  assert.match(compiled.topicYaml, /regional_access&finance_access/);
  assert.match(compiled.topicYaml, /field: orders\.region/);
  assert.match(compiled.topicYaml, /field: orders\.department/);
});

test('staged permission YAML must structurally match every approved security decision', () => {
  const contract = semanticPermissionContractFromDraft(COMPLETE_DRAFT);
  assert.ok(contract);
  const baselineModelYaml = 'label: Sales\n';
  const baselineTopicYaml = 'base_view: orders\n';
  const compiled = compileSemanticPermissionYaml({
    sourceModelYaml: baselineModelYaml,
    sourceTopicYaml: baselineTopicYaml,
    baselineModelYaml,
    baselineTopicYaml,
    contract,
  });
  assert.deepEqual(compiled.plan.blockers, []);
  assert.deepEqual(semanticPermissionPackageIssues({
    modelYaml: compiled.modelYaml,
    topicYaml: compiled.topicYaml,
    baselineModelYaml,
    baselineTopicYaml,
    contract,
  }), []);

  const cases = [
    {
      label: 'grant attribute drift',
      modelYaml: compiled.modelYaml.replace('user_attribute: region', 'user_attribute: department'),
      topicYaml: compiled.topicYaml,
      expected: /access_grants do not exactly match/i,
    },
    {
      label: 'grant value drift',
      modelYaml: compiled.modelYaml.replace('"Central"', '"East"'),
      topicYaml: compiled.topicYaml,
      expected: /access_grants do not exactly match/i,
    },
    {
      label: 'grant boost drift',
      modelYaml: compiled.modelYaml.replace('    allowed_values:', '    access_boostable: true\n    allowed_values:'),
      topicYaml: compiled.topicYaml,
      expected: /access_grants do not exactly match/i,
    },
    {
      label: 'extra grant',
      modelYaml: compiled.modelYaml.replace(
        'access_grants:',
        'access_grants:\n  unexpected_access:\n    user_attribute: region\n    allowed_values: ["Central"]',
      ),
      topicYaml: compiled.topicYaml,
      expected: /access_grants do not exactly match/i,
    },
    {
      label: 'required grant drift',
      modelYaml: compiled.modelYaml,
      topicYaml: compiled.topicYaml.replace('- regional_access', '- other_access'),
      expected: /required_access_grants do not exactly match/i,
    },
    {
      label: 'row-filter field drift',
      modelYaml: compiled.modelYaml,
      topicYaml: compiled.topicYaml.replace('field: orders.region', 'field: orders.department'),
      expected: /access_filters do not exactly match/i,
    },
    {
      label: 'row-filter attribute drift',
      modelYaml: compiled.modelYaml,
      topicYaml: compiled.topicYaml.replace('user_attribute: region', 'user_attribute: department'),
      expected: /access_filters do not exactly match/i,
    },
    {
      label: 'row-filter bypass drift',
      modelYaml: compiled.modelYaml,
      topicYaml: compiled.topicYaml.replace('"Admin"', '"Executive"'),
      expected: /access_filters do not exactly match/i,
    },
    {
      label: 'extra row filter',
      modelYaml: compiled.modelYaml,
      topicYaml: compiled.topicYaml.replace(
        'access_filters:',
        'access_filters:\n  - field: orders.department\n    user_attribute: department',
      ),
      expected: /access_filters do not exactly match/i,
    },
  ] as const;

  cases.forEach((entry) => {
    assert.match(semanticPermissionPackageIssues({
      modelYaml: entry.modelYaml,
      topicYaml: entry.topicYaml,
      baselineModelYaml,
      baselineTopicYaml,
      contract,
    }).join('\n'), entry.expected, entry.label);
  });
});

test('permission compilation expands an empty flow-style Omni model before adding access grants', () => {
  const contract = semanticPermissionContractFromDraft({
    ...COMPLETE_DRAFT,
    grants: [{
      id: 'grant-scout-report',
      name: 'scout_report_access',
      userAttribute: 'omni_user_groups',
      allowedValues: ['Scout Team'],
      accessBoostable: false,
    }],
    filters: [{
      id: 'filter-scout-team',
      field: 'players.team',
      userAttribute: 'omni_user_groups',
      allowUnfilteredValues: false,
      valuesForUnfiltered: [],
    }],
  });
  assert.ok(contract);

  const compiled = compileSemanticPermissionYaml({
    sourceModelYaml: '{}\n',
    baselineModelYaml: '{}\n',
    sourceTopicYaml: 'base_view: players\nai_context: |\n  Keep authored scouting guidance.\n',
    baselineTopicYaml: 'base_view: players\nai_context: |\n  Keep authored scouting guidance.\n',
    contract,
  });

  assert.deepEqual(compiled.plan.blockers, []);
  assert.deepEqual(parse(compiled.modelYaml), {
    access_grants: {
      scout_report_access: {
        user_attribute: 'omni_user_groups',
        allowed_values: ['Scout Team'],
      },
    },
  });
  assert.match(compiled.topicYaml, /required_access_grants:\n {2}- scout_report_access/);
  assert.match(compiled.topicYaml, /field: players\.team/);
  assert.match(compiled.topicYaml, /ai_context: \|\n {2}Keep authored scouting guidance\./);
});

test('permission merge preserves scalar grants and adds only missing policy nodes', () => {
  const contract = semanticPermissionContractFromDraft(COMPLETE_DRAFT);
  assert.ok(contract);
  const plan = planSemanticPermissionMerge({
    modelYaml: 'access_grants: {}\n',
    topicYaml: 'required_access_grants: legacy_access\naccess_filters: []\n',
    contract,
  });

  assert.deepEqual(plan.blockers, []);
  assert.deepEqual(plan.accessGrantsToAdd.map((grant) => grant.name), ['regional_access']);
  assert.deepEqual(plan.topicRequiredAccessGrants, ['legacy_access', 'regional_access']);
  assert.deepEqual(plan.topicRequiredAccessGrantsToAdd, ['regional_access']);
  assert.deepEqual(plan.topicAccessFiltersToAdd, contract.topicAccessFilters);
});

test('equivalent existing access nodes are no-ops and conflicting nodes fail closed', () => {
  const contract = semanticPermissionContractFromDraft(COMPLETE_DRAFT);
  assert.ok(contract);
  const equivalent = planSemanticPermissionMerge({
    modelYaml: [
      'access_grants:',
      '  regional_access:',
      '    user_attribute: region',
      '    allowed_values: [Admin, West, Central]',
    ].join('\n'),
    topicYaml: [
      'required_access_grants: regional_access',
      'access_filters:',
      '  - field: orders.region',
      '    user_attribute: region',
      '    values_for_unfiltered: [all_regions, Admin]',
    ].join('\n'),
    contract,
  });
  assert.deepEqual(equivalent.blockers, []);
  assert.deepEqual(equivalent.accessGrantsToAdd, []);
  assert.deepEqual(equivalent.topicRequiredAccessGrantsToAdd, []);
  assert.deepEqual(equivalent.topicAccessFiltersToAdd, []);

  const conflict = planSemanticPermissionMerge({
    modelYaml: [
      'access_grants:',
      '  regional_access:',
      '    user_attribute: department',
      '    allowed_values: [Finance]',
    ].join('\n'),
    topicYaml: [
      'access_filters:',
      '  - field: orders.region',
      '    user_attribute: department',
    ].join('\n'),
    contract,
  });
  assert.equal(conflict.blockers.length, 2);
  assert.match(conflict.blockers.join(' '), /instead of overwriting/i);
});

test('permission compilation is additive and preserves unrelated YAML and AI context', () => {
  const contract = semanticPermissionContractFromDraft(COMPLETE_DRAFT);
  assert.ok(contract);
  const compiled = compileSemanticPermissionYaml({
    sourceModelYaml: [
      '# model comment',
      'label: Updated model label',
      'access_grants:',
      '  invented_grant:',
      '    user_attribute: unsafe',
      '    allowed_values: [all]',
    ].join('\n'),
    baselineModelYaml: [
      '# model comment',
      'label: Original model label',
      'access_grants:',
      '  legacy_access:',
      '    user_attribute: department',
      '    allowed_values: [Finance]',
    ].join('\n'),
    sourceTopicYaml: [
      'base_view: orders',
      'required_access_grants: invented_grant',
      'access_filters:',
      '  - field: orders.unsafe',
      '    user_attribute: unsafe',
      'ai_context: Keep this authored guidance.',
    ].join('\n'),
    baselineTopicYaml: [
      'base_view: orders',
      'required_access_grants: legacy_access # preserve grant',
      'access_filters:',
      '  - field: orders.department',
      '    user_attribute: department',
      'ai_context: Keep this authored guidance.',
    ].join('\n'),
    contract,
  });

  assert.deepEqual(compiled.plan.blockers, []);
  assert.match(compiled.modelYaml, /label: Updated model label/);
  assert.match(compiled.modelYaml, /legacy_access:/);
  assert.match(compiled.modelYaml, /regional_access:/);
  assert.doesNotMatch(compiled.modelYaml, /invented_grant:/);
  assert.match(compiled.topicYaml, /legacy_access/);
  assert.match(compiled.topicYaml, /regional_access/);
  assert.match(compiled.topicYaml, /orders\.department/);
  assert.match(compiled.topicYaml, /orders\.region/);
  assert.doesNotMatch(compiled.topicYaml, /orders\.unsafe/);
  assert.match(compiled.topicYaml, /ai_context: Keep this authored guidance\./);
});

test('formatted access contract is explicit enough for review evidence without authorizing inference', () => {
  const summary = formatSemanticPermissionContract(COMPLETE_DRAFT);

  assert.match(summary, /Define regional_access grant/);
  assert.match(summary, /required_access_grants: \[regional_access\]/);
  assert.match(summary, /access_filter on field: orders\.region/);
  assert.match(summary, /must fail closed/i);
});

test('TopicsPage uses structured permission inputs and blocks generation when they are incomplete', () => {
  const source = readFileSync(path.join(process.cwd(), 'src/pages/TopicsPage.tsx'), 'utf8');
  const form = readFileSync(path.join(process.cwd(), 'src/components/semanticStudio/SemanticPermissionContractForm.tsx'), 'utf8');

  assert.match(source, /semanticPermissionContractFromDraft\(permissionContractDraft\)/);
  assert.match(source, /confirmedContract: confirmedPermissionContract/);
  assert.match(source, /permissionConfirmIssues\.length > 0/);
  assert.match(source, /if \(deterministicPermissionPackage && !deterministicPermissionPackage\.message\)/);
  assert.match(source, /targetBaseViewName !== fileName/);
  assert.match(source, /modelViewNames: fieldInventory\?\.viewNames/);
  assert.match(source, /topicPlanChunk\?\.parsed/);
  assert.match(source, /topicDetailBaseView/);
  assert.match(source, /fullyResolved: true/);
  assert.match(source, /permissionFieldScopeViewName/);
  assert.match(source, /reviewedPermissionFieldReachabilityIssues/);
  assert.match(source, /Guided Permission Builder currently deploys reviewed topic visibility and row-filter contracts only/);
  assert.match(form, /Blobby cannot invent access rules/);
  assert.match(form, /Visibility \+ rows/);
  assert.match(form, /Add grant/);
  assert.match(form, /Add row filter/);
  assert.match(form, /Choose an Omni attribute/);
  assert.match(form, /Choose a topic field/);
  assert.match(form, /Topic field scope/);
  assert.match(form, /require the generated topic to reach that view/);
  assert.match(form, /Settings &gt; Attributes/);
});

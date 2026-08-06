import assert from 'node:assert/strict';
import test from 'node:test';
import { artifactFromText } from '../src/services/semanticMigration/adapters';
import {
  MICROSTRATEGY_EVIDENCE_SCHEMA_VERSION,
  MICROSTRATEGY_SUPPORTED_EVIDENCE_CLASSES,
} from '../src/services/semanticMigration/microStrategyEvidence';
import { requiredMicroStrategyMigrationDecisions } from '../src/services/semanticMigration/microStrategyDecisions';
import { evaluateMicroStrategyRoundTrip, type MicroStrategyRoundTripManifest } from '../src/services/semanticMigration/microStrategyRoundTrip';
import { parseMicroStrategyManualArtifacts } from '../server/services/semanticMigration/microStrategyManualParser';

function artifact(name: string, value: unknown) {
  const parsed = artifactFromText('microstrategy', JSON.stringify(value), name);
  assert.ok(parsed);
  return parsed;
}

function evidenceBundle() {
  return [
    artifact('projects.json', [{ id: 'PROJECT-EXAMPLE', name: 'Example project', alias: 'EXAMPLE', status: 0 }]),
    artifact('schema-objects.json', {
      attributes: [
        {
          information: { objectId: 'ATTRIBUTE-REGION', subType: 'attribute', name: 'Region' },
          keyForm: { name: 'ID' },
          forms: [
            {
              id: 'FORM-REGION-ID',
              name: 'ID',
              category: 'ID',
              dataType: { type: 'integer' },
              expressions: [{ expression: { text: 'REGION_ID', tree: { type: 'column_reference', columnName: 'REGION_ID' } } }],
            },
          ],
        },
      ],
      metrics: [
        {
          information: { objectId: 'METRIC-REVENUE', subType: 'metric', name: 'Revenue' },
          expression: { text: 'Sum(Revenue)', tree: { type: 'operator', function: 'sum' } },
          dimty: {
            dimtyUnits: [
              {
                dimtyUnitType: 'attribute',
                target: { objectId: 'ATTRIBUTE-REGION', subType: 'attribute', name: 'Region' },
                aggregation: 'normal',
                filtering: 'apply',
                groupBy: true,
              },
            ],
          },
          conditionality: { filter: { objectId: 'FILTER-ACTIVE', subType: 'filter', name: 'Active rows' } },
        },
        {
          information: { objectId: 'METRIC-MARGIN', subType: 'metric', name: 'Margin' },
          expression: { text: 'Sum(Revenue) - Sum(Cost)', tree: { type: 'operator', function: 'minus' } },
        },
      ],
      filters: [
        {
          information: { objectId: 'FILTER-ACTIVE', subType: 'filter', name: 'Active rows' },
          qualification: {
            text: 'Region (ID) > 0',
            tree: {
              type: 'predicate_form_qualification',
              predicateTree: {
                attribute: { objectId: 'ATTRIBUTE-REGION', subType: 'attribute', name: 'Region' },
                form: { objectId: 'FORM-REGION-ID', subType: 'attribute_form_system', name: 'ID' },
              },
            },
          },
        },
      ],
      prompts: [
        {
          id: 'PROMPT-REGION',
          key: 'PROMPT-REGION@0@10',
          name: 'Choose region',
          type: 'ELEMENTS',
          required: true,
          closed: false,
          source: { id: 'ATTRIBUTE-REGION', type: 12, name: 'Region' },
          defaultAnswer: [],
        },
      ],
      derivedElements: [
        {
          information: { objectId: 'DERIVED-REGION', subType: 'consolidation_element', name: 'Grouped region' },
          attribute: { objectId: 'ATTRIBUTE-REGION', subType: 'attribute', name: 'Region' },
          elements: [{ id: 'DERIVED-ELEMENT-1', name: 'Selected regions', type: 'list' }],
        },
      ],
    }),
    artifact('cube.json', {
      cubes: [
        {
          information: { objectId: 'CUBE-EXAMPLE', subType: 'report_cube', name: 'Example cube' },
          attributes: [{ id: 'ATTRIBUTE-REGION', name: 'Region', type: 'attribute' }],
          metrics: [
            { id: 'METRIC-REVENUE', name: 'Revenue', type: 'metric' },
            { id: 'METRIC-MARGIN', name: 'Margin', type: 'metric' },
          ],
        },
      ],
    }),
    artifact('report-definition.json', {
      information: { objectId: 'REPORT-EXAMPLE', subType: 'report_grid', name: 'Example report' },
      sourceType: 'freeform_sql',
      dataSource: {
        cube: { objectId: 'CUBE-EXAMPLE', subType: 'report_cube', name: 'Example cube' },
        dataTemplate: {
          units: [
            { type: 'attributes', elements: [{ id: 'ATTRIBUTE-REGION', name: 'Region', subType: 'attribute' }] },
            {
              type: 'metrics',
              elements: [
                { id: 'METRIC-REVENUE', name: 'Revenue', subType: 'metric' },
                { id: 'METRIC-MISSING', name: 'Missing metric', subType: 'metric' },
              ],
            },
          ],
          limit: { text: 'Top 100 by Revenue', expression: { text: 'Rank(Revenue) <= 100' } },
        },
        filter: {
          text: 'Active rows',
          tree: { filter: { objectId: 'FILTER-ACTIVE', subType: 'filter', name: 'Active rows' } },
        },
      },
      metricLimits: [{ id: 'METRIC-LIMIT-1', name: 'Positive revenue', expression: { text: 'Revenue > 0' } }],
      prompts: [{ id: 'PROMPT-REGION', key: 'PROMPT-REGION@0@10', name: 'Choose region', type: 'ELEMENTS', required: true }],
      derivedElements: [{ information: { objectId: 'DERIVED-REGION', subType: 'consolidation_element', name: 'Grouped region' } }],
      sqlStatement: 'select region_id, sum(revenue) from example_fact group by region_id',
    }),
    artifact('dossier-definition.json', {
      id: 'DOSSIER-EXAMPLE',
      name: 'Example dossier',
      hasPrompt: true,
      chapters: [
        {
          key: 'CHAPTER-1',
          name: 'Overview',
          filters: [
            {
              key: 'FILTER-1',
              name: 'Region selector',
              selectorType: 'attribute_element_list',
              source: { id: 'ATTRIBUTE-REGION', type: 12, name: 'Region' },
              summary: 'Region in selected values',
            },
          ],
          pages: [{ key: 'PAGE-1', name: 'Page 1', visualizations: [{ key: 'VISUAL-1', name: 'Revenue by region' }] }],
        },
      ],
      prompts: [{ id: 'PROMPT-REGION', key: 'PROMPT-REGION@0@10', name: 'Choose region', type: 'ELEMENTS', required: true }],
      datasets: [
        {
          id: 'CUBE-EXAMPLE',
          name: 'Example cube',
          availableObjects: [
            {
              id: 'ATTRIBUTE-REGION',
              name: 'Region',
              type: 'attribute',
              forms: [{ id: 'FORM-REGION-ID', name: 'ID', dataType: 'integer', baseFormCategory: 'ID' }],
            },
            { id: 'METRIC-REVENUE', name: 'Revenue', type: 'metric' },
          ],
        },
      ],
    }),
    artifact('document-definition.json', {
      documents: [
        {
          information: { objectId: 'DOCUMENT-EXAMPLE', subType: 'document_definition', name: 'Example document' },
          datasets: [
            {
              id: 'CUBE-EXAMPLE',
              name: 'Example cube',
              availableObjects: [{ id: 'ATTRIBUTE-REGION', name: 'Region', type: 'attribute' }],
            },
          ],
        },
      ],
    }),
  ];
}

test('MicroStrategy typed evidence preserves official object identities, definitions, and dependency edges', () => {
  const result = parseMicroStrategyManualArtifacts(evidenceBundle());
  const { evidence } = result;

  assert.equal(evidence.schemaVersion, MICROSTRATEGY_EVIDENCE_SCHEMA_VERSION);
  [
    'report', 'dossier', 'document', 'dataset', 'intelligent_cube', 'attribute', 'attribute_form', 'metric',
    'filter', 'prompt', 'report_limit', 'metric_limit', 'derived_element', 'sql',
  ].forEach((kind) => assert.ok(evidence.diagnostics.counts[kind as keyof typeof evidence.diagnostics.counts] > 0, `${kind} evidence should be captured`));

  const report = evidence.nodes.find((node) => node.kind === 'report' && node.sourceId === 'REPORT-EXAMPLE');
  assert.ok(report && report.kind === 'report');
  assert.equal(report.details.freeformSql, true);
  assert.ok(report.details.datasetSourceIds.includes('CUBE-EXAMPLE'));
  assert.ok(report.details.metricSourceIds.includes('METRIC-MISSING'));
  assert.equal(report.details.sqlEvidenceIds.length, 1);

  const sql = evidence.nodes.find((node) => node.kind === 'sql' && node.details.ownerSourceId === 'REPORT-EXAMPLE');
  assert.ok(sql && sql.kind === 'sql');
  assert.match(sql.details.statement, /^select region_id/i);
  assert.equal(sql.details.executionScoped, true);

  const form = evidence.nodes.find((node) => node.kind === 'attribute_form' && node.sourceId === 'FORM-REGION-ID' && node.sourceArtifact === 'schema-objects.json');
  assert.ok(form && form.kind === 'attribute_form');
  assert.equal(form.details.parentAttributeSourceId, 'ATTRIBUTE-REGION');
  assert.equal(form.details.expression.hasTree, true);

  const metric = evidence.nodes.find((node) => node.kind === 'metric' && node.sourceId === 'METRIC-REVENUE' && node.evidenceLevel === 'definition');
  assert.ok(metric && metric.kind === 'metric');
  assert.equal(metric.details.dimensionalityStatus, 'explicit');
  assert.equal(metric.details.dimensionalityUnits[0]?.targetSourceId, 'ATTRIBUTE-REGION');

  assert.ok(evidence.dependencies.some((edge) => edge.dependencySourceId === 'CUBE-EXAMPLE' && edge.status === 'resolved'));
  assert.ok(evidence.dependencies.some((edge) => edge.dependencySourceId === 'METRIC-MISSING' && edge.status === 'partial'));
  assert.ok(evidence.diagnostics.blockers.some((item) => item.code === 'metric_dimensionality_missing' && /METRIC-MARGIN/.test(item.message)));
  assert.ok(evidence.diagnostics.blockers.some((item) => item.code === 'partial_dependency' && item.dependencySourceId === 'METRIC-MISSING'));
  assert.ok(evidence.diagnostics.blockers.some((item) => item.code === 'limit_behavior_requires_explicit_target_decision'));
  assert.ok(evidence.diagnostics.blockers.some((item) => item.code === 'derived_element_translation_unsupported'));
  assert.equal(result.inventory.views.flatMap((view) => view.fields).some((field) => field.sourceId === 'ATTRIBUTE-REGION'), true);
  const revenueMappings = result.mappings.filter((mapping) => mapping.sourceKind === 'metric' && mapping.sourceId === 'METRIC-REVENUE');
  const marginMapping = result.mappings.find((mapping) => mapping.sourceKind === 'metric' && mapping.sourceId === 'METRIC-MARGIN');
  assert.ok(revenueMappings.length > 0);
  assert.doesNotMatch(revenueMappings.flatMap((mapping) => mapping.notes).join(' '), /dimty is missing/i);
  assert.equal(marginMapping?.confidence, 'medium');
  assert.match(marginMapping?.notes.join(' ') || '', /dimty is missing.*must not be inferred/i);
});

test('MicroStrategy required decisions are deterministic, evidence-backed, and unresolved by default', () => {
  const first = requiredMicroStrategyMigrationDecisions(
    parseMicroStrategyManualArtifacts(evidenceBundle()),
    ['DOSSIER-EXAMPLE'],
  );
  const second = requiredMicroStrategyMigrationDecisions(
    parseMicroStrategyManualArtifacts(evidenceBundle()),
    ['DOSSIER-EXAMPLE'],
  );

  assert.deepEqual(first.map((decision) => decision.id), second.map((decision) => decision.id));
  assert.equal(new Set(first.map((decision) => decision.id)).size, first.length);
  assert.ok(first.some((decision) => decision.id.includes(':metric_dimensionality:')));
  assert.ok(first.some((decision) => decision.id.includes(':prompt_behavior:')));
  assert.ok(first.some((decision) => decision.id.includes(':selector_behavior:')));
  assert.ok(first.some((decision) => decision.id.includes(':freeform_sql_architecture:')));
  assert.ok(first.some((decision) => decision.id.includes(':cube_or_dataset_architecture:')));
  assert.ok(first.some((decision) => decision.id.includes(':limit_behavior:')));
  assert.ok(first.some((decision) => decision.id.includes(':derived_element_behavior:')));
  assert.ok(first.some((decision) => decision.domain === 'permission'));
  assert.ok(first.some((decision) => decision.domain === 'schedule'));
  assert.ok(first.some((decision) => /full typed definition|typed definition evidence is partial/i.test(decision.rationale)));
  assert.equal(first.every((decision) => decision.action === 'defer'), true);
  assert.equal(first.every((decision) => decision.blocking && decision.validationRequired && !decision.approvedByUser), true);
  assert.equal(first.every((decision) => !decision.targetId && !decision.targetFileName && !decision.proposedCode), true);
  assert.equal(first.every((decision) => decision.evidence.length > 0), true);
  assert.equal(first.every((decision) => decision.evidence.every((reference) => reference.sourceId.startsWith('microstrategy:'))), true);
  assert.equal(first.every((decision) => decision.impactAssetIds.join(',') === 'DOSSIER-EXAMPLE'), true);
});

test('MicroStrategy cubes never inherit unrelated project objects when local dependencies are absent', () => {
  const result = parseMicroStrategyManualArtifacts([
    artifact('incomplete-cube.json', {
      attributes: [{ id: 'ATTRIBUTE-UNSCOPED', name: 'Unscoped attribute', forms: [{ id: 'FORM-UNSCOPED', name: 'ID', dataType: 'integer' }] }],
      metrics: [{ id: 'METRIC-UNSCOPED', name: 'Unscoped metric', formula: 'Sum(Value)' }],
      cubes: [{ id: 'CUBE-INCOMPLETE', name: 'Incomplete cube' }],
    }),
  ]);
  const cube = result.inventory.views.find((view) => view.sourceId === 'CUBE-INCOMPLETE');

  assert.ok(cube);
  assert.deepEqual(cube.fields, []);
  assert.deepEqual(cube.measures, []);
  assert.match(cube.warnings.join(' '), /project-level objects were not attached automatically/i);
  assert.ok(result.evidence.diagnostics.blockers.some((item) => item.code === 'intelligent_cube_definition_missing'));
});

test('MicroStrategy malformed JSON is an explicit typed evidence blocker', () => {
  const malformed = artifactFromText('microstrategy', '{"reports":[', 'malformed-report.json');
  assert.ok(malformed);
  const result = parseMicroStrategyManualArtifacts([malformed]);

  const blocker = result.evidence.diagnostics.blockers.find((item) => item.code === 'invalid_json');
  assert.equal(blocker?.sourceArtifact, 'malformed-report.json');
  assert.equal(blocker?.sourcePath, '$');
  assert.match(blocker?.message || '', /not valid JSON.*not inventoried/i);
  assert.equal(result.evidenceIntegrity.eligibleForControlledLiveAcceptance, false);
});

test('MicroStrategy Evidence Integrity reaches merge-only with fixture verification and remains blocked from live acceptance', () => {
  const result = parseMicroStrategyManualArtifacts(evidenceBundle());
  const categories = ['projects', 'cubes', 'reports', 'attributes', 'metrics', 'relationships', 'dashboards', 'visualizations', 'fieldReferences'] as const;
  const manifest: MicroStrategyRoundTripManifest = {
    schemaVersion: 'omnikit.microstrategy.roundtrip.v1',
    synthetic: true,
    name: 'MicroStrategy typed evidence fixture',
    description: 'Synthetic parser evidence only.',
    targetScore: 100,
    artifacts: [],
    expectedOmniFiles: [],
    weights: Object.fromEntries(categories.map((category) => [category, 1])) as MicroStrategyRoundTripManifest['weights'],
    expected: Object.fromEntries(categories.map((category) => [category, []])) as MicroStrategyRoundTripManifest['expected'],
  };
  const report = evaluateMicroStrategyRoundTrip(result, manifest);
  const documentedClasses = new Set(result.evidence.documentation.flatMap((document) => document.artifactClasses));

  assert.equal(result.evidenceIntegrity.score, 75);
  assert.equal(report.evidenceIntegrity.score, 90);
  assert.equal(report.evidenceIntegrity.band, 'merge_only');
  assert.equal(report.evidenceIntegrity.eligibleForControlledLiveAcceptance, false);
  assert.deepEqual(report.evidenceIntegrity.components, {
    documentationTraceability: 30,
    deterministicParserCoverage: 25,
    explicitUnsupportedBehavior: 20,
    sourceToTargetVerification: 15,
    independentReview: 0,
  });
  assert.ok(report.blockers.some((blocker) => /dimensionality was not inferred/i.test(blocker)));
  assert.ok(report.blockers.some((blocker) => /METRIC-MISSING/.test(blocker)));
  MICROSTRATEGY_SUPPORTED_EVIDENCE_CLASSES.forEach((kind) => assert.equal(documentedClasses.has(kind), true, `${kind} should have official documentation traceability`));
  result.evidence.documentation.forEach((document) => assert.equal(new URL(document.url).hostname, 'microstrategy.github.io'));
});

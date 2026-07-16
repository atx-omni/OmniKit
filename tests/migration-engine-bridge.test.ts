import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  buildMigrationConnectionRoutes,
  canonicalModelFromEngine,
  dashboardPlansFromEngine,
  migrationDecisionsFromEngine,
  migrationEngineControlPlaneFromCapabilities,
  migrationInventoryFromEngine,
  migrationEngineResultForRollout,
  parseMigrationEngineConformanceResult,
  parseMigrationEngineBridgeResult,
  reconcileEngineDashboardSelection,
  sourceDashboardCatalogFromEngine,
  type MigrationEngineBridgeResult,
} from '../src/services/semanticMigration/engineBridge';
import { buildMigrationEngineParityReport, MIGRATION_ENGINE_SOURCE_POLICIES } from '../src/services/semanticMigration/engineParity';
import { createMigrationBundle, mergeDeterministicDashboardPlanEvidence } from '../src/services/semanticMigration/bundle';
import {
  assertMigrationEngineOutputContainsNoSecrets,
  attestCompletedMigrationEngineExtraction,
  cleanupAbandonedMigrationEngineTempDirectories,
  migrationEngineChildEnvironment,
  migrationEngineControlPlane,
  migrationEngineQueueLimits,
  migrationEngineRolloutMode,
  redactMigrationEngineErrorText,
  recordMigrationEngineParityObservation,
  resetMigrationEngineRuntimeForTests,
  withMigrationEngineTemporaryDirectory,
} from '../server/services/migrationEngineBridge';

const SHARED_FIXTURE_SHA256 = '650db951d5304c11cae92f10a2da1deccc2359905de4c27c5eb676c0b6ee829e';
const SHARED_SCHEMA_SHA256 = '64dc590f50a50c4407d07b238df0f9d34950a0e4c261a8ebedf2dad6dd63c02f';

function identity(id: string, locator: string) {
  return {
    source_id: id,
    source_locator: locator,
    evidence: [{
      artifact_name: 'orders.view.lkml',
      artifact_sha256: 'a'.repeat(64),
      locator,
      content_sha256: 'c'.repeat(64),
      role: 'bundle_input' as const,
    }],
  };
}

function result(): MigrationEngineBridgeResult {
  return {
    schema_version: 'omnikit.migration.bundle.v1',
    request_id: 'test-request',
    engine: { name: 'omni-migrator', version: '0.0.1' },
    source: 'looker',
    mode: 'manual',
    provenance: {
      source_artifacts: ['orders.view.lkml'],
      source_artifact_fingerprints: [{ name: 'orders.view.lkml', sha256: 'a'.repeat(64), size_bytes: 512 }],
      source_artifact_count: 1,
      ir_version: '1',
    },
    capability_coverage: { manual: true, semantic: 'full' },
    connection_mappings: [{
      source_key: 'analytics', source_name: 'Analytics', source_dialect: 'snowflake',
      target_connection_id: 'connection-1', target_connection_name: 'Production', target_dialect: 'snowflake',
      confidence: 'exact', reason: 'Matched by name.', candidate_ids: ['connection-1'], confirmed: false,
    }],
    bundle: {
      ir_version: '1',
      source: 'looker',
      provenance: { tool_version: '0.0.1', source_artifact: 'orders.view.lkml' },
      model: {
        views: [{
          ...identity('looker:view:orders', 'view:orders'),
          name: 'orders', connection: { dialect: 'snowflake' }, untranslatable: [],
          fields: [
            { ...identity('looker:field:orders.id', 'view:orders/field:id'), name: 'id', kind: 'dimension', data_type: 'number', primary_key: true, untranslatable: [] },
            {
              ...identity('looker:field:orders.revenue', 'view:orders/field:revenue'),
              name: 'revenue', source_name: 'Revenue', label: 'Net revenue', group_label: 'Financials',
              kind: 'measure', data_type: 'number', aggregate: 'sum', sql: '${TABLE}.revenue',
              value_format: '$#,##0', timeframes: ['date', 'month'], filters: { status: { is: 'complete' } },
              untranslatable: [{ object: 'measure revenue', reason: 'Source color metadata requires review.', severity: 'info' }],
            },
          ],
        }],
        topics: [{ ...identity('looker:topic:orders', 'topic:orders'), name: 'orders', base_view: 'orders', joins: [] }],
        untranslatable: [],
      },
      dashboards: [{
        ...identity('looker:dashboard:1', 'dashboard:1'),
        name: 'Order summary', filters: [], source_url: 'https://looker.example/dashboards/1', untranslatable: [],
        tiles: [{
          ...identity('looker:tile:1', 'dashboard:1/tile:1'),
          kind: 'query', title: 'Revenue', chart_type: 'bar', vis_config: { stacking: 'normal', show_values: true }, layout: { x: 0, y: 0, w: 6, h: 4 }, untranslatable: [],
          query: {
            ...identity('looker:query:1', 'dashboard:1/tile:1/query'), topic: 'orders', fields: ['orders.revenue'],
            filters: [{ ...identity('looker:filter:status', 'dashboard:1/tile:1/query/filter:status'), field: 'orders.status', operator: 'equals', values: ['complete'], is_negative: false }],
            sorts: [{ field: 'orders.revenue', direction: 'desc' }], limit: 500, pivots: ['orders.region'],
          },
        }],
      }],
    },
    model_suggestions: [{
      path: 'analytics/orders.view', content: 'schema: analytics', sha256: 'b'.repeat(64),
      parser_version: '0.0.1', rulebook_version: 'v2', rulebook_sha256: 'e'.repeat(64), confidence: 0.95, severity: 'info',
      source_ids: ['looker:view:orders', 'looker:field:orders.id', 'looker:field:orders.revenue'],
      evidence: identity('looker:view:orders', 'view:orders').evidence,
    }],
    diagnostics: { view_count: 1, topic_count: 1, dashboard_count: 1, field_count: 2, untranslatable_count: 1, source_artifact_count: 1, limitations: [], rulebook_version: 'v2', rulebook_sha256: 'e'.repeat(64) },
  };
}

test('both repositories consume the same content-addressed contract fixture', () => {
  const fixture = readFileSync(resolve(process.cwd(), 'tests/fixtures/migration-engine/omnikit.migration.bundle.v1.valid.json'), 'utf8');
  assert.equal(createHash('sha256').update(fixture).digest('hex'), SHARED_FIXTURE_SHA256);
  const parsed = parseMigrationEngineBridgeResult(JSON.parse(fixture));
  assert.equal(parsed.bundle.model.views[0]?.source_id, 'looker:view:111111111111111111111111');
  assert.equal(parsed.bundle.model.views[0]?.fields[0]?.evidence[0]?.artifact_sha256, 'a'.repeat(64));
});

test('the committed JSON Schema accepts the shared fixture and rejects contract drift', () => {
  const schemaText = readFileSync(resolve(process.cwd(), 'tests/fixtures/migration-engine/omnikit.migration.bundle.v1.schema.json'), 'utf8');
  const fixture = JSON.parse(readFileSync(resolve(process.cwd(), 'tests/fixtures/migration-engine/omnikit.migration.bundle.v1.valid.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(createHash('sha256').update(schemaText).digest('hex'), SHARED_SCHEMA_SHA256);
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(JSON.parse(schemaText));
  assert.equal(validate(fixture), true, JSON.stringify(validate.errors));

  const malformed = structuredClone(fixture) as { bundle: { model: { views: Array<Record<string, unknown>> } } };
  delete malformed.bundle.model.views[0]!.source_id;
  assert.equal(validate(malformed), false);
  assert.throws(() => parseMigrationEngineBridgeResult(malformed), /complete canonical bundle/);
});

test('engine result adapts into OmniKit inventory and canonical evidence', () => {
  const parsed = parseMigrationEngineBridgeResult(result());
  const inventory = migrationInventoryFromEngine(parsed);
  const canonical = canonicalModelFromEngine(parsed);

  assert.equal(inventory.views[0].measures[0].name, 'revenue');
  assert.equal(inventory.views[0].measures[0].sourceId, 'looker:field:orders.revenue');
  assert.equal(inventory.views[0].measures[0].groupLabel, 'Financials');
  assert.deepEqual(inventory.views[0].measures[0].filters, { status: { is: 'complete' } });
  assert.deepEqual(inventory.views[0].measures[0].timeframes, ['date', 'month']);
  assert.equal(inventory.dashboards[0].fields[0], 'orders.revenue');
  assert.ok(canonical.nodes.some((node) => node.id === 'looker:field:orders.revenue' && node.kind === 'measure' && node.metadata.groupLabel === 'Financials'));
});

test('shadow rollout measures the engine without making it authoritative', () => {
  const engine = result();
  const nativeInventory = migrationInventoryFromEngine(engine);
  const engineInventory = migrationInventoryFromEngine(engine);
  const report = buildMigrationEngineParityReport({
    baseline: nativeInventory,
    candidate: engineInventory,
    engineResult: engine,
    mode: 'shadow',
    observationCount: 20,
  });

  assert.equal(migrationEngineResultForRollout('shadow', engine), null);
  assert.equal(migrationEngineResultForRollout('off', engine), null);
  assert.equal(migrationEngineResultForRollout('primary', engine), engine);
  assert.equal(report.scores.overall, 100);
  assert.equal(report.promotion.promotable, true);
  assert.equal(report.categories.fields.matchedStableIdentityCount, 2);
});

test('parity gates detect semantic drift and source policy preserves split Power BI ownership', () => {
  const engine = result();
  const baseline = migrationInventoryFromEngine(engine);
  const candidate = migrationInventoryFromEngine(engine);
  candidate.views[0]!.fields = [];
  candidate.views[0]!.measures = [];
  const report = buildMigrationEngineParityReport({ baseline, candidate, engineResult: engine, mode: 'shadow', observationCount: 100 });

  assert.equal(report.promotion.promotable, false);
  assert.ok(report.promotion.blockers.some((blocker) => blocker.includes('Semantic parity')));
  assert.deepEqual(MIGRATION_ENGINE_SOURCE_POLICIES.power_bi.engineFormats, ['.pbix']);
  assert.ok(MIGRATION_ENGINE_SOURCE_POLICIES.power_bi.nativeFormats.includes('.tmdl'));
  assert.equal(MIGRATION_ENGINE_SOURCE_POLICIES.domo.owner, 'OmniKit');
});

test('shadow parity observations are deduplicated and persist only sanitized operational evidence', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'omnikit-engine-parity-test-'));
  const observationPath = resolve(root, 'parity-observations.json');
  const originalPath = process.env.OMNIKIT_MIGRATION_ENGINE_PARITY_PATH;
  process.env.OMNIKIT_MIGRATION_ENGINE_PARITY_PATH = observationPath;
  try {
    const engine = result();
    const inventory = migrationInventoryFromEngine(engine);
    const attest = (requestId: string) => {
      const attestedResult = { ...engine, request_id: requestId, control_plane: { rollout_mode: 'shadow' as const, fallback: 'native_when_available' as const } };
      attestCompletedMigrationEngineExtraction({
        requestId,
        source: 'looker',
        mode: 'manual',
        artifacts: [{ name: 'orders.view.lkml', content: 'view: orders {}' }],
        parityBaseline: inventory,
        parityBaselineSource: 'server_native',
      }, attestedResult);
    };
    attest('same-request');
    assert.equal((await recordMigrationEngineParityObservation('same-request')).comparisonType, 'native_differential');
    assert.equal((await recordMigrationEngineParityObservation('same-request')).observationCount, 1);
    attest('second-request');
    assert.equal((await recordMigrationEngineParityObservation('second-request')).observationCount, 2);
    const stored = JSON.parse(readFileSync(observationPath, 'utf8')) as { sources: { looker: Array<Record<string, unknown>> } };
    assert.equal(stored.sources.looker.length, 2);
    assert.equal('categories' in stored.sources.looker[0], false);
    assert.equal('bundle' in stored.sources.looker[0], false);
    assert.deepEqual(Object.keys(stored.sources.looker[0]).sort(), [
      'attestationVersion', 'baselineFingerprint', 'baselineSource', 'comparisonType', 'engineName', 'engineVersion', 'generatedAt', 'mode', 'observationType', 'parserVersion', 'requestFingerprint', 'requestId', 'resultFingerprint', 'rulebookVersion', 'scores', 'source',
    ].sort());
  } finally {
    if (originalPath === undefined) delete process.env.OMNIKIT_MIGRATION_ENGINE_PARITY_PATH;
    else process.env.OMNIKIT_MIGRATION_ENGINE_PARITY_PATH = originalPath;
    resetMigrationEngineRuntimeForTests();
    rmSync(root, { recursive: true, force: true });
  }
});

test('parity evidence rejects unknown requests and extractions without a server baseline', async () => {
  resetMigrationEngineRuntimeForTests();
  await assert.rejects(recordMigrationEngineParityObservation('client-invented-request'), /No recent completed engine extraction/);

  const engine = { ...result(), request_id: 'missing-baseline', control_plane: { rollout_mode: 'shadow' as const, fallback: 'native_when_available' as const } };
  attestCompletedMigrationEngineExtraction({
    requestId: 'missing-baseline',
    source: 'looker',
    mode: 'manual',
    artifacts: [{ name: 'orders.view.lkml', content: 'view: orders {}' }],
  }, engine);
  await assert.rejects(recordMigrationEngineParityObservation('missing-baseline'), /no server-generated parity baseline/i);
  resetMigrationEngineRuntimeForTests();
});

test('canonical conformance produces explicit server-attested promotion evidence for every engine source without a native baseline', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'omnikit-engine-canonical-parity-test-'));
  const observationPath = resolve(root, 'parity-observations.json');
  const originalPath = process.env.OMNIKIT_MIGRATION_ENGINE_PARITY_PATH;
  process.env.OMNIKIT_MIGRATION_ENGINE_PARITY_PATH = observationPath;
  try {
    const sources = ['looker', 'powerbi', 'tableau', 'metabase', 'sigma'] as const;
    for (const source of sources) {
      const requestId = `canonical-${source}`;
      const mode = source === 'sigma' ? 'api' as const : 'manual' as const;
      const base = result();
      const engine = {
        ...base, request_id: requestId, source, mode,
        bundle: { ...base.bundle, source },
        control_plane: { rollout_mode: 'shadow' as const, fallback: 'native_when_available' as const },
      } as MigrationEngineBridgeResult;
      attestCompletedMigrationEngineExtraction({
        requestId, source, mode,
        artifacts: source === 'sigma' ? [] : [{ name: `${source}.source`, content: 'fixture' }],
      }, engine, undefined, {
        source, engineVersion: engine.engine.version,
        manifestSha256: 'd'.repeat(64), expectedSha256: 'd'.repeat(64),
      });
      const summary = await recordMigrationEngineParityObservation(requestId);
      assert.equal(summary.latestOverall, 100);
      assert.equal(summary.comparisonType, 'canonical_conformance');
    }
    const storedSources = JSON.parse(readFileSync(observationPath, 'utf8')).sources as Record<string, Array<Record<string, unknown>>>;
    sources.forEach((source) => {
      const sourceObservations = storedSources[source]!;
      assert.equal(sourceObservations.length, 2);
      const canonical = sourceObservations.find((item) => item.observationType === 'canonical_conformance')!;
      const operational = sourceObservations.find((item) => item.observationType === 'operational')!;
      assert.equal(canonical.baselineSource, 'canonical_fixture');
      assert.equal(canonical.comparisonType, 'canonical_conformance');
      assert.equal(canonical.resultFingerprint, 'd'.repeat(64));
      assert.equal(canonical.baselineFingerprint, 'd'.repeat(64));
      assert.equal(canonical.canonicalFixtureSha256, 'd'.repeat(64));
      assert.equal(operational.canonicalFixtureSha256, 'd'.repeat(64));
      assert.equal((canonical.scores as Record<string, number>).semantic, 100);
    });
  } finally {
    if (originalPath === undefined) delete process.env.OMNIKIT_MIGRATION_ENGINE_PARITY_PATH;
    else process.env.OMNIKIT_MIGRATION_ENGINE_PARITY_PATH = originalPath;
    resetMigrationEngineRuntimeForTests();
    rmSync(root, { recursive: true, force: true });
  }
});

test('engine suggestions remain unapproved decisions', () => {
  const decisions = migrationDecisionsFromEngine(result());

  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].approvedByUser, false);
  assert.equal(decisions[0].blocking, true);
  assert.equal(decisions[0].proposedCode, 'schema: analytics');
  assert.equal(decisions[0].translationProvenance?.rulebookSha256, 'e'.repeat(64));
  assert.deepEqual(decisions[0].impactAssetIds, ['looker:view:orders', 'looker:field:orders.id', 'looker:field:orders.revenue']);
});

test('engine dashboards become reviewed build plans with layout evidence', () => {
  const plans = dashboardPlansFromEngine(result());

  assert.equal(plans[0].tiles[0].visualType, 'bar');
  assert.equal(plans[0].sourceDashboardId, 'looker:dashboard:1');
  assert.equal(plans[0].tiles[0].id, 'looker:tile:1');
  assert.deepEqual(plans[0].dependencyIds, ['looker:field:orders.revenue']);
  assert.equal(plans[0].tiles[0].queryTopic, 'orders');
  assert.equal(plans[0].tiles[0].queryFilters?.[0]?.operator, 'equals');
  assert.deepEqual(plans[0].tiles[0].sorts, [{ field: 'orders.revenue', direction: 'desc' }]);
  assert.deepEqual(plans[0].tiles[0].pivots, ['orders.region']);
  assert.deepEqual(plans[0].tiles[0].visualizationConfig, { stacking: 'normal', show_values: true });
  assert.deepEqual(plans[0].tiles[0].layout, { x: 0, y: 0, w: 6, h: 4 });
  assert.match(plans[0].tiles[0].buildInstructions, /x=0, y=0, w=6, h=4/);
});

test('unsupported source layout is excluded from generated dashboard plans', () => {
  const engine = result();
  engine.source = 'sigma';
  engine.bundle.source = 'sigma';
  engine.capability_coverage = { artifact_coverage: { layout: 'unsupported' } };
  const plans = dashboardPlansFromEngine(engine);
  assert.equal(plans[0]?.tiles[0]?.layout, undefined);
  assert.match(plans[0]?.tiles[0]?.buildInstructions || '', /Omni-native layout/);
  assert.ok(plans[0]?.unsupportedFeatures.some((warning) => /layout is unavailable/i.test(warning)));
});

test('AI dashboard edits cannot discard deterministic query or visualization evidence', () => {
  const deterministic = dashboardPlansFromEngine(result());
  const aiPlan = {
    ...deterministic[0]!,
    tiles: deterministic[0]!.tiles.map((tile) => ({
      ...tile, fields: ['invented.field'], filters: [], visualType: 'pie', queryTopic: undefined,
      queryFilters: [], sorts: [], pivots: [], limit: undefined, visualizationConfig: undefined, layout: undefined,
    })),
  };
  const [merged] = mergeDeterministicDashboardPlanEvidence([aiPlan], deterministic);
  assert.deepEqual(merged!.tiles[0]!.fields, ['orders.revenue']);
  assert.equal(merged!.tiles[0]!.visualType, 'bar');
  assert.equal(merged!.tiles[0]!.queryTopic, 'orders');
  assert.deepEqual(merged!.tiles[0]!.layout, { x: 0, y: 0, w: 6, h: 4 });
});

test('native dashboard selections survive engine catalog activation and Sigma workbook expansion', () => {
  const base = result();
  const first = base.bundle.dashboards[0]!;
  const sigma = {
    ...base,
    source: 'sigma',
    bundle: {
      ...base.bundle,
      source: 'sigma',
      dashboards: [
        { ...first, source_id: 'sigma:dashboard:page-1', native_source_id: 'page-1', selection_aliases: ['workbook-1', 'page-1'], name: 'Overview' },
        { ...first, source_id: 'sigma:dashboard:page-2', native_source_id: 'page-2', selection_aliases: ['workbook-1', 'page-2'], name: 'Details' },
      ],
    },
  } as MigrationEngineBridgeResult;
  const nativeCatalog = [{
    id: 'workbook-1', name: 'Workbook', kind: 'workbook' as const, dependencyIds: [], dependencies: [], dependencyCounts: {},
    complexity: 'low' as const, coverage: 'partial' as const, coverageNotes: [], riskFlags: [],
  }];
  const engineCatalog = sourceDashboardCatalogFromEngine(sigma);
  assert.deepEqual(reconcileEngineDashboardSelection(['workbook-1'], nativeCatalog, engineCatalog), ['page-1', 'page-2']);
  assert.deepEqual(dashboardPlansFromEngine(sigma).map((plan) => plan.sourceDashboardId), ['page-1', 'page-2']);
  assert.deepEqual(engineCatalog.map((item) => item.canonicalSourceId), ['sigma:dashboard:page-1', 'sigma:dashboard:page-2']);
});

test('unknown engine result schemas fail closed', () => {
  assert.throws(() => parseMigrationEngineBridgeResult({ ...result(), schema_version: 'future' }), /Unsupported migration engine result/);
});

test('malformed engine fingerprints and suggestion hashes fail closed', () => {
  const malformedFingerprint = result();
  malformedFingerprint.provenance.source_artifact_fingerprints![0]!.sha256 = 'not-a-hash';
  assert.throws(() => parseMigrationEngineBridgeResult(malformedFingerprint), /fingerprints are invalid/);

  const malformedSuggestion = result();
  malformedSuggestion.model_suggestions[0]!.sha256 = 'short';
  assert.throws(() => parseMigrationEngineBridgeResult(malformedSuggestion), /suggestions are invalid/);
});

test('unsafe suggestion paths and child-output control characters fail closed', () => {
  const unsafePath = result();
  unsafePath.model_suggestions[0]!.path = '../outside.view';
  assert.throws(() => parseMigrationEngineBridgeResult(unsafePath), /suggestions are invalid/);

  const unsafeControl = result();
  unsafeControl.diagnostics.limitations = ['normal text\u001b[31mspoofed terminal text'];
  assert.throws(() => parseMigrationEngineBridgeResult(unsafeControl), /unsafe control characters/);
});

test('engine errors redact exact source credentials and successful output cannot echo them', () => {
  const secret = 'source-token-browser-test';
  const redacted = redactMigrationEngineErrorText(
    `authorization: ${secret} https://operator:${secret}@source.example/api`,
    [secret],
  );
  assert.equal(redacted.includes(secret), false);
  assert.match(redacted, /\[redacted\]/);
  assert.throws(
    () => assertMigrationEngineOutputContainsNoSecrets({ diagnostics: { limitations: [secret] } }, [secret]),
    /contained source credentials/,
  );
  assert.doesNotThrow(() => assertMigrationEngineOutputContainsNoSecrets({ ok: true }, [secret]));
});

test('malformed nested engine identity and evidence fail closed', () => {
  const malformedIdentity = result();
  malformedIdentity.bundle.model.views[0]!.source_id = '';
  assert.throws(() => parseMigrationEngineBridgeResult(malformedIdentity), /complete canonical bundle/);

  const malformedEvidence = result();
  malformedEvidence.bundle.dashboards[0]!.evidence[0]!.content_sha256 = 'short';
  assert.throws(() => parseMigrationEngineBridgeResult(malformedEvidence), /complete canonical bundle/);
});

test('malformed connection mapping evidence fails closed', () => {
  const malformed = result() as MigrationEngineBridgeResult & { connection_mappings: Array<Record<string, unknown>> };
  malformed.connection_mappings[0]!.confidence = 'wishful';
  assert.throws(() => parseMigrationEngineBridgeResult(malformed), /connection mappings are invalid/);
});

test('connection routes preserve distinct destinations and compatible model choices', () => {
  const first = result().connection_mappings![0]!;
  const routes = buildMigrationConnectionRoutes([
    first,
    {
      ...first,
      source_key: 'finance',
      source_name: 'Finance',
      target_connection_id: 'connection-2',
      target_connection_name: 'Finance Warehouse',
      candidate_ids: ['connection-2'],
    },
  ], [
    { id: 'model-1', name: 'Orders', connectionId: 'connection-1' },
    { id: 'model-2', name: 'Finance', connectionId: 'connection-2' },
    { id: 'model-3', name: 'Finance Sandbox', connectionId: 'connection-2' },
  ]);

  assert.equal(routes.length, 2);
  assert.deepEqual(routes[0]?.sourceKeys, ['finance']);
  assert.deepEqual(routes[0]?.compatibleModels.map((model) => model.id), ['model-2', 'model-3']);
  assert.deepEqual(routes[1]?.sourceKeys, ['analytics']);
  assert.deepEqual(routes[1]?.compatibleModels.map((model) => model.id), ['model-1']);
});

test('conformance evidence is source-complete and rejects false passing checksums', () => {
  const sourceEvidence = {
    passed: true,
    manifest_sha256: 'a'.repeat(64),
    expected_sha256: 'a'.repeat(64),
    errors: [],
    coverage: {
      artifacts: { views: 'full', permissions: 'unsupported' },
      fidelity_classes: { full: ['views'], partial: [], unsupported: ['permissions'] },
    },
  };
  const parsed = parseMigrationEngineConformanceResult({
    schema_version: 'omnikit.migration.conformance-run.v1',
    engine: { name: 'omni-migrator', version: '0.0.1' },
    passed: true,
    sources: { looker: sourceEvidence },
  }, ['looker']);
  assert.equal(parsed.sources.looker?.passed, true);

  assert.throws(() => parseMigrationEngineConformanceResult({
    ...parsed,
    sources: { looker: { ...sourceEvidence, expected_sha256: 'b'.repeat(64) } },
  }, ['looker']), /claims success with mismatched contracts/);
});

test('migration bundles preserve non-secret engine provenance for audit', () => {
  const engine = result();
  const catalog = sourceDashboardCatalogFromEngine(engine);
  const plans = dashboardPlansFromEngine(engine);
  const bundle = createMigrationBundle({
    sourceInventory: null,
    sourcePlatform: 'looker',
    sourceDashboardCatalog: catalog,
    selectedDashboardIds: [catalog[0].id],
    dashboardPlans: plans,
    branchName: 'migration/orders',
    decisions: [],
    semanticFiles: [],
    connectionMappings: [{
      sourceKey: 'analytics', sourceName: 'Analytics', sourceDialect: 'snowflake',
      targetConnectionId: 'connection-1', targetConnectionName: 'Production', targetDialect: 'snowflake',
      confidence: 'exact', confirmed: true,
    }],
    connectionRoutes: [{
      id: 'connection-route:connection-1',
      targetConnectionId: 'connection-1',
      targetConnectionName: 'Production',
      sourceKeys: ['analytics'],
      compatibleModels: [{ id: 'model-1', name: 'Orders' }],
      selectedModelId: 'model-1',
      selectedModelName: 'Orders',
      writeStatus: 'ready',
    }],
    engineEvidence: {
      name: engine.engine.name,
      version: engine.engine.version,
      rulebookVersion: engine.diagnostics.rulebook_version,
      requestId: engine.request_id,
      sourceArtifactFingerprints: engine.provenance.source_artifact_fingerprints!.map((artifact) => ({ name: artifact.name, sha256: artifact.sha256, sizeBytes: artifact.size_bytes })),
      capabilityCoverage: engine.capability_coverage,
      untranslatableCount: engine.diagnostics.untranslatable_count,
    },
  });

  assert.equal(bundle.source.engine?.rulebookVersion, 'v2');
  assert.equal(bundle.source.engine?.sourceArtifactFingerprints[0].sha256, 'a'.repeat(64));
  assert.equal(bundle.source.engine?.untranslatableCount, 1);
  assert.equal(bundle.target.connectionMappings?.[0]?.targetConnectionId, 'connection-1');
  assert.equal(bundle.target.connectionMappings?.[0]?.confirmed, true);
  assert.equal(bundle.target.connectionRoutes?.[0]?.writeStatus, 'ready');
  assert.deepEqual(bundle.target.connectionRoutes?.[0]?.sourceKeys, ['analytics']);
});

test('connection mapping changes alter server attestation fingerprints', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'omnikit-engine-connection-attestation-'));
  const observationPath = resolve(root, 'parity-observations.json');
  const originalPath = process.env.OMNIKIT_MIGRATION_ENGINE_PARITY_PATH;
  process.env.OMNIKIT_MIGRATION_ENGINE_PARITY_PATH = observationPath;
  try {
    const engine = result();
    const inventory = migrationInventoryFromEngine(engine);
    const attest = (targetConnectionId: string) => {
      const attestedResult = {
        ...engine,
        request_id: 'mapping-request',
        connection_mappings: engine.connection_mappings!.map((mapping) => ({ ...mapping, target_connection_id: targetConnectionId })),
        control_plane: { rollout_mode: 'shadow' as const, fallback: 'native_when_available' as const },
      };
      attestCompletedMigrationEngineExtraction({
        requestId: 'mapping-request', source: 'looker', mode: 'manual',
        artifacts: [{ name: 'orders.view.lkml', content: 'view: orders {}' }],
        targetConnections: [{ id: targetConnectionId, name: targetConnectionId, dialect: 'snowflake' }],
        connectionOverrides: { analytics: targetConnectionId },
        parityBaseline: inventory, parityBaselineSource: 'server_native',
      }, attestedResult);
    };
    attest('connection-a');
    await recordMigrationEngineParityObservation('mapping-request');
    const first = JSON.parse(readFileSync(observationPath, 'utf8')).sources.looker[0] as Record<string, string>;
    attest('connection-b');
    await recordMigrationEngineParityObservation('mapping-request');
    const second = JSON.parse(readFileSync(observationPath, 'utf8')).sources.looker[0] as Record<string, string>;
    assert.notEqual(first.requestFingerprint, second.requestFingerprint);
    assert.notEqual(first.resultFingerprint, second.resultFingerprint);
  } finally {
    if (originalPath === undefined) delete process.env.OMNIKIT_MIGRATION_ENGINE_PARITY_PATH;
    else process.env.OMNIKIT_MIGRATION_ENGINE_PARITY_PATH = originalPath;
    resetMigrationEngineRuntimeForTests();
    rmSync(root, { recursive: true, force: true });
  }
});

test('engine child environment is allowlisted and process capacity is bounded', () => {
  const originalSecret = process.env.OMNIKIT_UNRELATED_TEST_SECRET;
  const originalConcurrency = process.env.OMNIKIT_MIGRATION_ENGINE_MAX_CONCURRENCY;
  process.env.OMNIKIT_UNRELATED_TEST_SECRET = 'must-not-cross-boundary';
  process.env.OMNIKIT_MIGRATION_ENGINE_MAX_CONCURRENCY = '999';
  try {
    const environment = migrationEngineChildEnvironment('/tmp/engine-root');
    assert.equal(environment.OMNIKIT_UNRELATED_TEST_SECRET, undefined);
    assert.equal(environment.PYTHONPATH, '/tmp/engine-root/src');
    assert.equal(environment.PYTHONUNBUFFERED, '1');
    assert.equal(migrationEngineQueueLimits().maxConcurrency, 16);
  } finally {
    if (originalSecret === undefined) delete process.env.OMNIKIT_UNRELATED_TEST_SECRET;
    else process.env.OMNIKIT_UNRELATED_TEST_SECRET = originalSecret;
    if (originalConcurrency === undefined) delete process.env.OMNIKIT_MIGRATION_ENGINE_MAX_CONCURRENCY;
    else process.env.OMNIKIT_MIGRATION_ENGINE_MAX_CONCURRENCY = originalConcurrency;
    resetMigrationEngineRuntimeForTests();
  }
});

test('engine rollout modes support source overrides and fail-closed capability parsing', () => {
  const promotionRoot = mkdtempSync(resolve(tmpdir(), 'omnikit-engine-promotion-test-'));
  const promotionPath = resolve(promotionRoot, 'promotions.json');
  const manifestPath = resolve(promotionRoot, 'manifest.json');
  const originalDefault = process.env.OMNIKIT_MIGRATION_ENGINE_MODE;
  const originalLooker = process.env.OMNIKIT_MIGRATION_ENGINE_MODE_LOOKER;
  const originalSources = process.env.OMNIKIT_MIGRATION_ENGINE_SOURCES;
  const originalPromotionPath = process.env.OMNIKIT_MIGRATION_ENGINE_PROMOTION_PATH;
  const originalManifestPath = process.env.OMNIKIT_MIGRATION_ENGINE_MANIFEST_PATH;
  process.env.OMNIKIT_MIGRATION_ENGINE_MODE = 'shadow';
  process.env.OMNIKIT_MIGRATION_ENGINE_MODE_LOOKER = 'primary';
  process.env.OMNIKIT_MIGRATION_ENGINE_SOURCES = 'looker,powerbi';
  process.env.OMNIKIT_MIGRATION_ENGINE_PROMOTION_PATH = promotionPath;
  process.env.OMNIKIT_MIGRATION_ENGINE_MANIFEST_PATH = manifestPath;
  try {
    assert.equal(migrationEngineRolloutMode('looker'), 'shadow');
    writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: 2,
      engine: 'omni-migrator',
      version: '0.0.1',
      sourceRevision: 'a'.repeat(40),
      sourceContentSha256: 'b'.repeat(64),
      conformanceSchemaVersion: 'omnikit.migration.conformance-run.v1',
      conformance: {
        passed: true,
        sources: {
          looker: {
            passed: true, manifest_sha256: 'c'.repeat(64), expected_sha256: 'c'.repeat(64),
          },
        },
      },
    }));
    writeFileSync(promotionPath, JSON.stringify({
      schemaVersion: 'omnikit.migration.engine-promotions.v1',
      sources: {
        looker: {
          approvedBy: 'release-owner',
          approvedAt: new Date().toISOString(),
          observationCount: 20,
          scores: { semantic: 100, dashboards: 100, stableIdentity: 100, overall: 100 },
          rollbackDrill: { id: 'rollback-test', completedAt: new Date().toISOString() },
          engine: {
            name: 'omni-migrator', version: '0.0.1', sourceRevision: 'a'.repeat(40), sourceContentSha256: 'b'.repeat(64),
          },
          conformance: {
            schemaVersion: 'omnikit.migration.conformance-run.v1', manifestSha256: 'c'.repeat(64), expectedSha256: 'c'.repeat(64),
          },
        },
      },
    }));
    assert.equal(migrationEngineRolloutMode('looker'), 'primary');
    assert.equal(migrationEngineRolloutMode('powerbi'), 'shadow');
    assert.equal(migrationEngineRolloutMode('sigma'), 'off');
    const controlPlane = migrationEngineControlPlane();
    assert.equal(controlPlane.sourceModes.sigma, 'off');
    assert.deepEqual(migrationEngineControlPlaneFromCapabilities({ control_plane: controlPlane }), controlPlane);
    assert.equal(migrationEngineControlPlaneFromCapabilities({ control_plane: { ...controlPlane, defaultMode: 'unsafe' } }), null);
  } finally {
    if (originalDefault === undefined) delete process.env.OMNIKIT_MIGRATION_ENGINE_MODE;
    else process.env.OMNIKIT_MIGRATION_ENGINE_MODE = originalDefault;
    if (originalLooker === undefined) delete process.env.OMNIKIT_MIGRATION_ENGINE_MODE_LOOKER;
    else process.env.OMNIKIT_MIGRATION_ENGINE_MODE_LOOKER = originalLooker;
    if (originalSources === undefined) delete process.env.OMNIKIT_MIGRATION_ENGINE_SOURCES;
    else process.env.OMNIKIT_MIGRATION_ENGINE_SOURCES = originalSources;
    if (originalPromotionPath === undefined) delete process.env.OMNIKIT_MIGRATION_ENGINE_PROMOTION_PATH;
    else process.env.OMNIKIT_MIGRATION_ENGINE_PROMOTION_PATH = originalPromotionPath;
    if (originalManifestPath === undefined) delete process.env.OMNIKIT_MIGRATION_ENGINE_MANIFEST_PATH;
    else process.env.OMNIKIT_MIGRATION_ENGINE_MANIFEST_PATH = originalManifestPath;
    resetMigrationEngineRuntimeForTests();
    rmSync(promotionRoot, { recursive: true, force: true });
  }
});

test('promotion command requires passing same-runtime observations and records rollback evidence', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'omnikit-engine-promote-command-'));
  const observationPath = resolve(root, 'observations.json');
  const promotionPath = resolve(root, 'promotions.json');
  const manifestPath = resolve(root, 'manifest.json');
  const canonicalObservation = {
    attestationVersion: 'server.v1', observationType: 'canonical_conformance',
    requestId: 'canonical:looker', requestFingerprint: 'd'.repeat(64),
    resultFingerprint: 'c'.repeat(64), baselineFingerprint: 'c'.repeat(64),
    baselineSource: 'canonical_fixture', comparisonType: 'canonical_conformance', canonicalFixtureSha256: 'c'.repeat(64),
    generatedAt: new Date(Date.UTC(2026, 6, 1)).toISOString(), source: 'looker', mode: 'shadow',
    engineName: 'omni-migrator', engineVersion: '0.0.1', parserVersion: '0.0.1', rulebookVersion: 'v2',
    scores: { semantic: 100, dashboards: 100, stableIdentity: 100, warningsAndLimitations: 100, overall: 100 },
  };
  const observations = [canonicalObservation, ...Array.from({ length: 20 }, (_, index) => ({
    attestationVersion: 'server.v1',
    observationType: 'operational',
    requestId: `request-${index}`,
    requestFingerprint: createHash('sha256').update(`request-${index}`).digest('hex'),
    resultFingerprint: createHash('sha256').update(`result-${index}`).digest('hex'),
    baselineFingerprint: 'c'.repeat(64),
    baselineSource: 'canonical_fixture',
    comparisonType: 'canonical_conformance',
    canonicalFixtureSha256: 'c'.repeat(64),
    generatedAt: new Date(Date.UTC(2026, 6, 1, 0, index)).toISOString(),
    source: 'looker',
    mode: 'shadow',
    engineName: 'omni-migrator',
    engineVersion: '0.0.1',
    parserVersion: '0.0.1',
    rulebookVersion: 'v2',
    scores: { semantic: 100, dashboards: 100, stableIdentity: 100, warningsAndLimitations: 100, overall: 100 },
  }))];
  writeFileSync(observationPath, JSON.stringify({
    schemaVersion: 'omnikit.migration.engine-parity-observations.v1',
    sources: { looker: observations },
  }));
  writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 2,
    engine: 'omni-migrator',
    version: '0.0.1',
    sourceRevision: 'a'.repeat(40),
    sourceContentSha256: 'b'.repeat(64),
    bridgeSchemaVersion: 'omnikit.migration.bridge.v1',
    resultSchemaVersion: 'omnikit.migration.bundle.v1',
    conformanceSchemaVersion: 'omnikit.migration.conformance-run.v1',
    conformance: {
      passed: true,
      sources: {
        looker: {
          passed: true,
          manifest_sha256: 'c'.repeat(64),
          expected_sha256: 'c'.repeat(64),
          errors: [],
          coverage: { artifacts: { permissions: 'unsupported', schedules: 'unsupported' } },
        },
      },
    },
  }));
  try {
    execFileSync(process.execPath, [resolve(process.cwd(), 'scripts/promote-migration-engine.mjs'), '--source', 'looker', '--approved-by', 'Release Owner', '--rollback-drill', 'rollback-smoke-1'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OMNIKIT_MIGRATION_ENGINE_PARITY_PATH: observationPath,
        OMNIKIT_MIGRATION_ENGINE_PROMOTION_PATH: promotionPath,
        OMNIKIT_MIGRATION_ENGINE_MANIFEST_PATH: manifestPath,
      },
      stdio: 'pipe',
    });
    const promotion = JSON.parse(readFileSync(promotionPath, 'utf8')) as { sources: { looker: Record<string, unknown> } };
    assert.equal(promotion.sources.looker.approvedBy, 'Release Owner');
    assert.equal(promotion.sources.looker.observationCount, 20);
    assert.equal((promotion.sources.looker.conformance as { manifestSha256: string }).manifestSha256, 'c'.repeat(64));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('release verifier proves managed source, contracts, dependencies, and live conformance', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'omnikit-engine-release-verifier-'));
  const sourceRoot = resolve(root, 'source');
  const manifestPath = resolve(root, 'manifest.json');
  const python = resolve(root, 'fake-python');
  const sourceFiles: Record<string, string> = {
    'src/omni_migrator/bridge.py': '# read-only bridge\n',
    'requirements.lock': 'pydantic==2.0.0\n',
    'contracts/omnikit.migration.bundle.v1.schema.json': '{}\n',
    'contracts/fixtures/omnikit.migration.bundle.v1.valid.json': '{}\n',
    ...Object.fromEntries(['looker', 'powerbi', 'tableau', 'metabase', 'sigma'].map((source) => [`contracts/conformance/${source}.json`, '{}\n'])),
  };
  for (const [relative, content] of Object.entries(sourceFiles)) {
    const path = resolve(sourceRoot, relative);
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
  const sha = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');
  const treeSha = () => {
    const digest = createHash('sha256');
    const visit = (directory: string, prefix = '') => {
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        const absolute = join(directory, entry.name);
        if (entry.isDirectory()) visit(absolute, relative);
        else if (entry.isFile()) digest.update(relative).update('\0').update(sha(readFileSync(absolute))).update('\n');
      }
    };
    visit(sourceRoot);
    return digest.digest('hex');
  };
  const sourceEvidence = Object.fromEntries(['looker', 'powerbi', 'tableau', 'metabase', 'sigma'].map((source) => [source, {
    passed: true,
    manifest_sha256: sha(source),
    expected_sha256: sha(source),
    errors: [],
    coverage: {
      artifacts: { permissions: 'unsupported', schedules: 'unsupported', ...(source === 'sigma' ? { layout: 'unsupported' } : {}) },
      fidelity_classes: { full: [], partial: [], unsupported: ['permissions', 'schedules'] },
    },
  }]));
  const manifest = {
    schemaVersion: 2,
    engine: 'omni-migrator',
    version: '0.0.1',
    sourceRoot,
    sourceRevision: 'a'.repeat(40),
    sourceContentSha256: treeSha(),
    dependencyLockSha256: sha(sourceFiles['requirements.lock']),
    contractsSha256: Object.fromEntries(Object.keys(sourceFiles).filter((path) => path.startsWith('contracts/')).map((path) => [path, sha(sourceFiles[path]!)])),
    bridgeSchemaVersion: 'omnikit.migration.bridge.v1',
    resultSchemaVersion: 'omnikit.migration.bundle.v1',
    conformanceSchemaVersion: 'omnikit.migration.conformance-run.v1',
    conformance: {
      schema_version: 'omnikit.migration.conformance-run.v1',
      engine: { name: 'omni-migrator', version: '0.0.1' },
      passed: true,
      sources: sourceEvidence,
    },
  };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(python, `#!/usr/bin/env node
const manifest = JSON.parse(require('node:fs').readFileSync(process.env.FAKE_ENGINE_MANIFEST, 'utf8'));
const args = process.argv.slice(2);
if (args.includes('capabilities')) console.log(JSON.stringify({write_authority:false,engine:{name:'omni-migrator',version:'0.0.1'},schema_version:'omnikit.migration.bridge.v1',result_schema_version:'omnikit.migration.bundle.v1',operations:['extract','capabilities','conformance']}));
else if (args.includes('conformance')) console.log(JSON.stringify(manifest.conformance));
else console.log(JSON.stringify({pydantic:'2.0.0'}));
`);
  chmodSync(python, 0o755);
  try {
    const output = execFileSync(process.execPath, [resolve(process.cwd(), 'scripts/verify-migration-engine-release.mjs'), '--json'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        FAKE_ENGINE_MANIFEST: manifestPath,
        OMNIKIT_MIGRATION_ENGINE_MANIFEST_PATH: manifestPath,
        OMNIKIT_MIGRATION_ENGINE_ROOT: sourceRoot,
        OMNIKIT_MIGRATION_ENGINE_PYTHON: python,
      },
    });
    assert.equal(JSON.parse(output).verified, true);

    writeFileSync(resolve(sourceRoot, 'contracts/conformance/sigma.json'), '{"drift":true}\n');
    assert.throws(() => execFileSync(process.execPath, [resolve(process.cwd(), 'scripts/verify-migration-engine-release.mjs')], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        FAKE_ENGINE_MANIFEST: manifestPath,
        OMNIKIT_MIGRATION_ENGINE_MANIFEST_PATH: manifestPath,
        OMNIKIT_MIGRATION_ENGINE_ROOT: sourceRoot,
        OMNIKIT_MIGRATION_ENGINE_PYTHON: python,
      },
      stdio: 'pipe',
    }), /checksum drifted/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('engine startup cleanup removes abandoned temp roots and preserves live ownership', async () => {
  const base = mkdtempSync(resolve(tmpdir(), 'omnikit-engine-cleanup-test-'));
  const stale = resolve(base, 'omnikit-migration-engine-99999999-stale');
  const live = resolve(base, `omnikit-migration-engine-${process.pid}-live`);
  mkdirSync(stale);
  mkdirSync(live);
  const old = new Date(Date.now() - 2 * 60 * 60_000);
  utimesSync(stale, old, old);
  utimesSync(live, old, old);
  try {
    const removed = await cleanupAbandonedMigrationEngineTempDirectories(base);
    assert.equal(removed, 1);
    assert.equal(existsSync(stale), false);
    assert.equal(existsSync(live), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('engine temporary artifacts are removed after success, failure, and cancellation', async () => {
  const base = mkdtempSync(resolve(tmpdir(), 'omnikit-engine-lifecycle-test-'));
  const observedRoots: string[] = [];
  try {
    const success = await withMigrationEngineTemporaryDirectory(async (temporaryRoot) => {
      observedRoots.push(temporaryRoot);
      writeFileSync(join(temporaryRoot, 'source.json'), '{"source":"temporary"}');
      return 'complete';
    }, base);
    assert.equal(success, 'complete');

    await assert.rejects(withMigrationEngineTemporaryDirectory(async (temporaryRoot) => {
      observedRoots.push(temporaryRoot);
      writeFileSync(join(temporaryRoot, 'source.json'), '{"source":"temporary"}');
      throw new Error('parser failed');
    }, base), /parser failed/);

    await assert.rejects(withMigrationEngineTemporaryDirectory(async (temporaryRoot) => {
      observedRoots.push(temporaryRoot);
      writeFileSync(join(temporaryRoot, 'source.json'), '{"source":"temporary"}');
      const error = new Error('request cancelled');
      error.name = 'AbortError';
      throw error;
    }, base), (error: Error) => error.name === 'AbortError');

    assert.equal(observedRoots.length, 3);
    assert.equal(observedRoots.every((temporaryRoot) => !existsSync(temporaryRoot)), true);
    assert.deepEqual(readdirSync(base), []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

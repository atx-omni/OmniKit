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
import { evaluateLookerProfessionalReadiness } from '../src/services/semanticMigration/lookerProfessional';
import { createMigrationBundle, mergeDeterministicDashboardPlanEvidence } from '../src/services/semanticMigration/bundle';
import {
  applyMigrationEngineConnectionOverrides,
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
const SHARED_SCHEMA_SHA256 = '428d3a0154419a70a8eb06c3a93951bc1eaa79a9e91992da13e493d9710da8a2';

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
      ir_version: '2',
    },
    capability_coverage: { manual: true, semantic: 'full' },
    connection_mappings: [{
      source_key: 'analytics', source_name: 'Analytics', source_dialect: 'snowflake',
      target_connection_id: 'connection-1', target_connection_name: 'Production', target_dialect: 'snowflake',
      confidence: 'exact', reason: 'Matched by name.', candidate_ids: ['connection-1'], confirmed: false,
    }],
    bundle: {
      ir_version: '2',
      source: 'looker',
      provenance: { tool_version: '0.0.1', source_artifact: 'orders.view.lkml' },
      acquisition: {
        contract_version: 'looker.evidence.v1',
        mode: 'manual',
        project_ids: [],
        dashboard_ids: ['1'],
        look_ids: [],
        query_ids: [],
        source_files: ['orders.view.lkml'],
        required_files: ['orders.view.lkml'],
        unrelated_files: [],
        dependencies: [{
          kind: 'view',
          reference: 'orders',
          source_file: 'orders.view.lkml',
          status: 'resolved',
          required: true,
          matched_files: ['orders.view.lkml'],
          affected_dashboard_ids: ['1'],
          message: 'Resolved selected query view orders.',
        }],
        saved_look_coverage: 'not_applicable',
        dependency_closure_status: 'complete',
        source_query_validation_status: 'not_evaluated',
        diagnostics: [],
      },
      model: {
        views: [{
          ...identity('looker:view:orders', 'view:orders'),
          name: 'orders', connection: { dialect: 'snowflake' }, untranslatable: [],
          fields: [
            { ...identity('looker:field:orders.id', 'view:orders/field:id'), name: 'id', kind: 'dimension', data_type: 'number', primary_key: true, untranslatable: [] },
            { ...identity('looker:field:orders.margin', 'view:orders/field:margin'), name: 'margin', kind: 'dimension', data_type: 'number', untranslatable: [] },
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
        name: 'Order summary', source_url: 'https://looker.example/dashboards/1', untranslatable: [],
        folder_path: 'Shared analytics', owner: 'Analytics team', updated_at: '2026-07-20T12:00:00Z', usage_count: 42,
        filters: [{
          ...identity('looker:dashboard-filter:date', 'dashboard:1/filter:date'),
          native_source_id: 'date',
          field: 'orders.created_date', label: 'Date', filter_type: 'date_filter', required: false,
          operator: 'default', values: ['30 days'], is_negative: false,
        }],
        filter_order: ['date'], tile_order: ['tile-1'],
        filter_bindings: [{
          ...identity('looker:binding:date:tile-1', 'dashboard:1/binding:date:tile-1'),
          dashboard_filter_id: 'date', dashboard_filter_label: 'Date', tile_id: 'tile-1',
          target_field: 'orders.created_date', excluded: false,
        }],
        tiles: [{
          ...identity('looker:tile:1', 'dashboard:1/tile:1'),
          native_source_id: 'tile-1',
          kind: 'query', title: 'Revenue', chart_type: 'bar', vis_config: { stacking: 'normal', show_values: true }, layout: { x: 0, y: 0, w: 6, h: 4 }, untranslatable: [],
          query: {
            ...identity('looker:query:1', 'dashboard:1/tile:1/query'), topic: 'orders', fields: ['orders.revenue'],
            filters: [{ ...identity('looker:filter:status', 'dashboard:1/tile:1/query/filter:status'), field: 'orders.status', operator: 'equals', values: ['complete'], is_negative: false }],
            sorts: [{ field: 'orders.revenue', direction: 'desc' }], limit: 500, pivots: ['orders.region'],
            filter_expression: '${orders.revenue} > 0', hidden_fields: ['orders.margin'],
            calculation_dependencies: ['orders.margin'],
            dynamic_fields: [{
              ...identity('looker:dynamic:margin-band', 'dashboard:1/tile:1/query/dynamic:margin-band'),
              name: 'margin_band', label: 'Margin band', category: 'group_by',
              expression: 'case(when(${orders.margin}>0.5,"High"),"Standard")', based_on: null,
              filters: {}, dependencies: ['orders.margin'], support_outcome: 'automatic', config: { category: 'dimension' },
            }],
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
    diagnostics: { view_count: 1, topic_count: 1, dashboard_count: 1, field_count: 3, untranslatable_count: 1, source_artifact_count: 1, limitations: [], rulebook_version: 'v2', rulebook_sha256: 'e'.repeat(64) },
  };
}

function controlPlane(lookerMode: 'off' | 'shadow' | 'primary', approved = false) {
  const sources = ['looker', 'powerbi', 'tableau', 'metabase', 'sigma'] as const;
  return {
    defaultMode: 'off' as const,
    sourceModes: Object.fromEntries(sources.map((source) => [source, source === 'looker' ? lookerMode : 'off'])) as Record<(typeof sources)[number], 'off' | 'shadow' | 'primary'>,
    requestedSourceModes: Object.fromEntries(sources.map((source) => [source, source === 'looker' ? lookerMode : 'off'])) as Record<(typeof sources)[number], 'off' | 'shadow' | 'primary'>,
    promotionGates: Object.fromEntries(sources.map((source) => [source, {
      approved: source === 'looker' ? approved : false,
      reason: source === 'looker' && approved ? 'Measured promotion thresholds passed.' : 'Promotion evidence is incomplete.',
      observationCount: source === 'looker' ? 20 : 0,
    }])) as Record<(typeof sources)[number], { approved: boolean; reason: string; observationCount: number }>,
    fallback: 'native_when_available' as const,
    observationRequired: true,
  };
}

test('Looker Professional V2 keeps native fallback and partial capability truth when the candidate is unavailable', () => {
  const readiness = evaluateLookerProfessionalReadiness({
    sourcePlatform: 'looker',
    sourceMode: 'manual',
    controlPlane: controlPlane('off'),
  });

  assert.equal(readiness.state, 'native_fallback');
  assert.equal(readiness.canProceed, true);
  assert.equal(readiness.authoritative, false);
  assert.equal(readiness.releaseStage, 'preview');
  assert.equal(readiness.capabilityClaims.semanticObjects, 'partial');
  assert.equal(readiness.capabilityClaims.permissions, 'unsupported');
  assert.match(readiness.rollback, /shadow or off/i);
});

test('Looker Professional V2 treats shadow output as comparison evidence and rejects unapproved primary output', () => {
  const shadowResult = result();
  shadowResult.control_plane = { rollout_mode: 'shadow', queue_wait_ms: 2, duration_ms: 18, fallback: 'native_when_available' };
  const shadow = evaluateLookerProfessionalReadiness({
    sourcePlatform: 'looker',
    sourceMode: 'manual',
    engineResult: shadowResult,
    controlPlane: controlPlane('shadow'),
  });
  assert.equal(shadow.state, 'shadow_preview');
  assert.equal(shadow.authoritative, false);
  assert.match(shadow.summary, /comparison evidence/i);

  const primaryResult = result();
  primaryResult.control_plane = { rollout_mode: 'primary', queue_wait_ms: 1, duration_ms: 12, fallback: 'native_when_available' };
  const blocked = evaluateLookerProfessionalReadiness({
    sourcePlatform: 'looker',
    sourceMode: 'manual',
    engineResult: primaryResult,
    controlPlane: controlPlane('primary', false),
  });
  assert.equal(blocked.state, 'blocked');
  assert.equal(blocked.canProceed, false);
  assert.match(blocked.blockers.join(' '), /Measured rollout gate/i);
});

test('Looker Professional V2 blocks unresolved selected-scope acquisition dependencies', () => {
  const primaryResult = result();
  primaryResult.control_plane = { rollout_mode: 'primary', queue_wait_ms: 1, duration_ms: 12, fallback: 'native_when_available' };
  primaryResult.bundle.acquisition!.dependency_closure_status = 'blocked';
  primaryResult.bundle.acquisition!.dependencies = [{
    kind: 'include',
    reference: '/views/*.view.lkml',
    source_file: 'commerce.model.lkml',
    status: 'missing',
    required: true,
    matched_files: [],
    affected_dashboard_ids: ['1'],
    message: 'Required include did not match selected evidence.',
  }];
  primaryResult.bundle.acquisition!.diagnostics = ['Required include did not match selected evidence.'];

  const readiness = evaluateLookerProfessionalReadiness({
    sourcePlatform: 'looker',
    sourceMode: 'manual',
    engineResult: primaryResult,
    controlPlane: controlPlane('primary', true),
  });

  assert.equal(readiness.state, 'blocked');
  assert.equal(readiness.canProceed, false);
  assert.match(readiness.blockers.join(' '), /Required include did not match selected evidence/);
});

test('Looker Professional V2 becomes review-ready only after approved primary evidence and target proof', () => {
  const primaryResult = result();
  primaryResult.control_plane = { rollout_mode: 'primary', queue_wait_ms: 1, duration_ms: 12, fallback: 'native_when_available' };
  const readiness = evaluateLookerProfessionalReadiness({
    sourcePlatform: 'looker',
    sourceMode: 'manual',
    engineResult: primaryResult,
    controlPlane: controlPlane('primary', true),
    dashboardPlans: dashboardPlansFromEngine(primaryResult),
    preparationReady: true,
    validationReady: true,
  });

  assert.equal(readiness.state, 'review_ready');
  assert.equal(readiness.authoritative, true);
  assert.equal(readiness.canProceed, true);
  assert.equal(readiness.checks.every((item) => item.status === 'passed'), true);
});

test('operator connection overrides become confirmed mappings without inventing automatic confidence', () => {
  const engine = result();
  engine.connection_mappings = [{
    ...engine.connection_mappings![0]!,
    target_connection_id: null,
    target_connection_name: null,
    target_dialect: null,
    confidence: 'none',
    reason: 'No automatic connection match.',
    candidate_ids: [],
    candidates: [],
    confirmed: false,
  }];
  const applied = applyMigrationEngineConnectionOverrides({
    requestId: 'test-request',
    source: 'looker',
    mode: 'manual',
    targetConnections: [{
      id: 'connection-food-service',
      name: 'SE Demo - Food Service',
      dialect: 'snowflake',
      database: 'PROD_FOOD_SERVICE',
      defaultSchema: 'PUBLIC',
    }],
    connectionOverrides: { analytics: 'connection-food-service' },
  }, engine);

  const mapping = applied.connection_mappings![0]!;
  assert.equal(mapping.target_connection_id, 'connection-food-service');
  assert.equal(mapping.target_connection_name, 'SE Demo - Food Service');
  assert.equal(mapping.target_dialect, 'snowflake');
  assert.equal(mapping.confidence, 'none');
  assert.equal(mapping.confirmed, true);
  assert.equal(mapping.reason, 'Confirmed by operator mapping override.');
  assert.deepEqual(mapping.candidate_ids, ['connection-food-service']);
  assert.equal(engine.connection_mappings![0]!.confirmed, false);
});

test('operator connection overrides reject destinations outside the trusted target list', () => {
  assert.throws(() => applyMigrationEngineConnectionOverrides({
    requestId: 'test-request',
    source: 'looker',
    mode: 'manual',
    targetConnections: [{ id: 'connection-1', name: 'Production', dialect: 'snowflake' }],
    connectionOverrides: { analytics: 'connection-untrusted' },
  }, result()), /not available to this request/);
});

test('OmniKit and its first-party engine consume the same content-addressed contract fixture', () => {
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
  assert.equal(report.categories.fields.matchedStableIdentityCount, 3);
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

test('Looker semantic requirements become typed blocking decisions with deterministic fragments only when safe', () => {
  const engine = result();
  const parameterIdentity = identity('looker:requirement:parameter', 'semantic-requirement:parameter:orders.segment_mode');
  const pdtIdentity = identity('looker:requirement:pdt', 'semantic-requirement:derived_table:orders_rollup');
  engine.bundle.model.requirements = [{
    ...parameterIdentity,
    object_type: 'parameter',
    name: 'orders.segment_mode',
    support_outcome: 'decision_required',
    reason: 'Confirm the filter-only field.',
    target_file_hint: 'orders.view',
    dependencies: ['segment_mode'],
    config: { proposed_yaml: 'filters:\n  segment_mode:\n    type: string\n' },
  }, {
    ...pdtIdentity,
    object_type: 'derived_table',
    name: 'orders_rollup',
    support_outcome: 'manual',
    reason: 'Rewrite the native derived table.',
    target_file_hint: 'orders_rollup.view',
    dependencies: ['orders'],
    config: { explore_source: 'orders' },
  }];
  engine.model_suggestions[0]!.source_ids.push(parameterIdentity.source_id);

  const decisions = migrationDecisionsFromEngine(engine);
  const parameter = decisions.find((decision) => decision.nodeId === parameterIdentity.source_id)!;
  const pdt = decisions.find((decision) => decision.nodeId === pdtIdentity.source_id)!;
  assert.equal(parameter.semanticKind, 'filter');
  assert.equal(parameter.targetFileName, 'analytics/orders.view');
  assert.equal(parameter.approvedByUser, false);
  assert.equal(parameter.proposalOptions?.some((option) => option.action === 'rewrite' && option.proposedCode?.includes('segment_mode')), true);
  assert.equal(pdt.semanticKind, 'view');
  assert.equal(pdt.proposalOptions?.some((option) => option.action === 'rewrite'), false);
  assert.equal(pdt.blocking, true);
});

test('engine dashboards become reviewed build plans with layout evidence', () => {
  const plans = dashboardPlansFromEngine(result());

  assert.equal(plans[0].tiles[0].visualType, 'bar');
  assert.equal(plans[0].sourceDashboardId, 'looker:dashboard:1');
  assert.equal(plans[0].tiles[0].id, 'looker:tile:1');
  assert.equal(plans[0].tiles[0].queryTopic, 'orders');
  assert.equal(plans[0].tiles[0].queryFilters?.[0]?.operator, 'equals');
  assert.deepEqual(plans[0].tiles[0].sorts, [{ field: 'orders.revenue', direction: 'desc' }]);
  assert.deepEqual(plans[0].tiles[0].pivots, ['orders.region']);
  assert.equal(plans[0].tiles[0].filterExpression, '${orders.revenue} > 0');
  assert.deepEqual(plans[0].tiles[0].hiddenFields, ['orders.margin']);
  assert.equal(plans[0].tiles[0].dynamicFields?.[0]?.category, 'group_by');
  assert.equal(plans[0].tiles[0].pivotStrategy, 'chart_series');
  assert.equal(plans[0].tiles[0].migrationOutcome, 'generated');
  assert.equal(plans[0].filterBindings?.[0]?.targetField, 'orders.created_date');
  assert.equal(plans[0].filterBindings?.[0]?.dashboardFilterId, 'looker:dashboard-filter:date');
  assert.equal(plans[0].filterBindings?.[0]?.tileId, 'looker:tile:1');
  assert.deepEqual(plans[0].filterOrder, ['looker:dashboard-filter:date']);
  assert.deepEqual(plans[0].tileOrder, ['looker:tile:1']);
  assert.equal(plans[0].sourceFolderPath, 'Shared analytics');
  assert.deepEqual(plans[0].dependencyIds, ['looker:field:orders.revenue', 'looker:field:orders.margin']);
  assert.deepEqual(plans[0].tiles[0].visualizationConfig, { stacking: 'normal', show_values: true });
  assert.deepEqual(plans[0].tiles[0].layout, { x: 0, y: 0, w: 6, h: 4 });
  assert.match(plans[0].tiles[0].buildInstructions, /x=0, y=0, w=6, h=4/);
});

test('engine dashboard plans preserve explicit pivot, narrative, and merged-results outcomes', () => {
  const engine = result();
  const dashboard = engine.bundle.dashboards[0]!;
  const sourceTile = dashboard.tiles[0]!;
  dashboard.filters = [];
  dashboard.filter_bindings = [];
  dashboard.tiles = [
    sourceTile,
    {
      ...identity('looker:tile:merged', 'dashboard:1/tile:merged'),
      native_source_id: 'merged', kind: 'query', title: 'Merged comparison', query: null,
      chart_type: 'line', vis_config: {}, layout: { x: 0, y: 4, w: 6, h: 4 },
      untranslatable: [{ object: 'tile Merged comparison', severity: 'warning', reason: 'Merged-results tile has no Omni equivalent; rebuild manually.' }],
    },
    {
      ...identity('looker:tile:notes', 'dashboard:1/tile:notes'),
      native_source_id: 'notes', kind: 'markdown', title: 'Methodology', query: null,
      chart_type: 'markdown', vis_config: { body: 'Reviewed assumptions.' }, layout: { x: 6, y: 4, w: 6, h: 4 },
      untranslatable: [],
    },
  ];
  dashboard.tile_order = ['tile-1', 'merged', 'notes'];

  const plan = dashboardPlansFromEngine(engine)[0]!;
  assert.equal(plan.tiles[0]?.pivotStrategy, 'chart_series');
  assert.match(plan.tiles[0]?.buildInstructions || '', /stacked chart series/i);
  assert.equal(plan.tiles[1]?.migrationOutcome, 'manual');
  assert.match(plan.tiles[1]?.buildInstructions || '', /merged-results tile manually/i);
  assert.equal(plan.tiles[2]?.sourceKind, 'markdown');
  assert.equal(plan.tiles[2]?.migrationOutcome, 'manual');
  assert.deepEqual(plan.tileOrder, ['looker:tile:1', 'looker:tile:merged', 'looker:tile:notes']);
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
          omnikitCommitSha: 'e'.repeat(40),
          observationCount: 20,
          scores: { semantic: 100, dashboards: 100, stableIdentity: 100, overall: 100 },
          rollbackDrill: {
            id: 'rollback-test',
            completedAt: new Date().toISOString(),
            completedBy: 'release-owner',
            ledgerSha256: 'f'.repeat(64),
          },
          liveAcceptance: {
            schemaVersion: 'omnikit.migration-engine-live-acceptance.v3',
            source: 'looker',
            recordedAt: new Date().toISOString(),
            finalizedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000).toISOString(),
            owner: 'migration-owner',
            omnikitCommitSha: 'e'.repeat(40),
            viewCount: 2,
            dashboardCount: 1,
            connectionMappingCount: 1,
            stageCount: 8,
            acceptedGapCount: 0,
            deferredGapCount: 0,
            evidenceSha256: 'd'.repeat(64),
          },
          liveAcceptances: ['manual', 'api'].map((mode, index) => ({
            schemaVersion: 'omnikit.migration-engine-live-acceptance.v3',
            source: 'looker',
            mode,
            recordedAt: new Date().toISOString(),
            finalizedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000).toISOString(),
            owner: 'migration-owner',
            omnikitCommitSha: 'e'.repeat(40),
            viewCount: 2,
            dashboardCount: 1,
            connectionMappingCount: 1,
            stageCount: 8,
            acceptedGapCount: 0,
            deferredGapCount: 0,
            evidenceSha256: String(index + 1).repeat(64),
          })),
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
  const apiAcceptancePath = resolve(root, 'acceptance-api.json');
  const manualAcceptancePath = resolve(root, 'acceptance-manual.json');
  const rollbackDrillPath = resolve(root, 'rollback-drills.json');
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
  const promotionManifest = {
    schemaVersion: 2,
    engine: 'omni-migrator',
    version: '0.0.1',
    sourceRevision: 'a'.repeat(40),
    sourceContentSha256: 'b'.repeat(64),
    bridgeSchemaVersion: 'omnikit.migration.bridge.v1',
    resultSchemaVersion: 'omnikit.migration.bundle.v1',
    installedAt: new Date(Date.UTC(2026, 5, 30)).toISOString(),
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
  };
  writeFileSync(manifestPath, JSON.stringify(promotionManifest));
  const promotionManifestSha256 = createHash('sha256').update(readFileSync(manifestPath)).digest('hex');
  const acceptance = {
    schema_version: 'omnikit.migration-engine-live-acceptance.v3',
    evidence_status: 'final',
    recorded_at: new Date(Date.UTC(2026, 6, 2)).toISOString(),
    finalized_at: new Date(Date.UTC(2026, 6, 3)).toISOString(),
    expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000).toISOString(),
    outcome: 'passed',
    source: 'looker',
    mode: 'api',
    owner: 'Migration Owner',
    omnikit: { commit_sha: 'f'.repeat(40), worktree_dirty: false },
    review: {
      evidence_sha256: '1'.repeat(64),
      provisional_evidence_sha256: '2'.repeat(64),
    },
    engine: {
      name: 'omni-migrator', version: '0.0.1', revision: 'a'.repeat(40),
      result_schema_version: 'omnikit.migration.bundle.v1', rulebook_version: 'v2', rulebook_sha256: 'e'.repeat(64),
    },
    input: { evidence_origin: 'live_source', target_instance_ref_sha256: 'target-ref', selected_dashboard_count: 1, artifact_count: 0, connection_override_count: 0 },
    result: { view_count: 2, dashboard_count: 1, connection_mapping_count: 1, mapped_connection_count: 1 },
    stages: Object.fromEntries([
      'source_extraction',
      'semantic_translation',
      'branch_deployment',
      'omni_validation',
      'dashboard_reconstruction',
      'query_result_reconciliation',
      'permission_schedule_gap_reporting',
      'visual_structural_reconciliation',
    ].map((stage) => [stage, {
      status: 'passed',
      evidence_sha256: createHash('sha256').update(stage).digest('hex'),
      checked_count: 1,
      failed_count: 0,
    }])),
    gaps: [],
  };
  writeFileSync(apiAcceptancePath, JSON.stringify(acceptance));
  writeFileSync(manualAcceptancePath, JSON.stringify({
    ...acceptance,
    mode: 'manual',
    input: {
      ...acceptance.input,
      selected_dashboard_count: 0,
      artifact_count: 2,
    },
  }));
  writeFileSync(rollbackDrillPath, JSON.stringify({
    schemaVersion: 'omnikit.migration-engine-rollback-drills.v1',
    drills: [{
      id: 'rollback-smoke-1',
      source: 'looker',
      completedAt: new Date().toISOString(),
      completedBy: 'Release Owner',
      passed: true,
      engine: {
        name: 'omni-migrator',
        version: '0.0.1',
        sourceRevision: 'a'.repeat(40),
        sourceContentSha256: 'b'.repeat(64),
        manifestSha256: promotionManifestSha256,
      },
    }],
  }));
  try {
    execFileSync(process.execPath, [
      resolve(process.cwd(), 'scripts/promote-migration-engine.mjs'),
      '--source', 'looker',
      '--acceptance', manualAcceptancePath,
      '--acceptance', apiAcceptancePath,
      '--approved-by', 'Release Owner',
      '--rollback-drill', 'rollback-smoke-1',
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OMNIKIT_MIGRATION_ENGINE_PARITY_PATH: observationPath,
        OMNIKIT_MIGRATION_ENGINE_PROMOTION_PATH: promotionPath,
        OMNIKIT_MIGRATION_ENGINE_MANIFEST_PATH: manifestPath,
        OMNIKIT_MIGRATION_ENGINE_ROLLBACK_DRILL_PATH: rollbackDrillPath,
      },
      stdio: 'pipe',
    });
    const promotion = JSON.parse(readFileSync(promotionPath, 'utf8')) as { sources: { looker: Record<string, unknown> } };
    assert.equal(promotion.sources.looker.approvedBy, 'Release Owner');
    assert.equal(promotion.sources.looker.observationCount, 20);
    assert.equal((promotion.sources.looker.conformance as { manifestSha256: string }).manifestSha256, 'c'.repeat(64));
    assert.equal((promotion.sources.looker.liveAcceptance as { dashboardCount: number }).dashboardCount, 1);
    assert.deepEqual((promotion.sources.looker.liveAcceptances as Array<{ mode: string }>).map((item) => item.mode), ['manual', 'api']);
    assert.equal((promotion.sources.looker.rollbackDrill as { id: string }).id, 'rollback-smoke-1');
    assert.equal((promotion.sources.looker.history as Array<{ event: string }>)[0].event, 'promoted');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('release verifier proves managed source, contracts, dependencies, and live conformance', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'omnikit-engine-release-verifier-'));
  const sourceRoot = resolve(root, 'source');
  const manifestPath = resolve(root, 'manifest.json');
  const python = resolve(root, 'fake-python');
  const distributionHash = '9'.repeat(64);
  const uvLock = `[[package]]
name = "pydantic"
version = "2.0.0"

[[package.wheels]]
url = "https://example.invalid/pydantic-2.0.0-py3-none-any.whl"
hash = "sha256:${distributionHash}"
`;
  const hashLock = `# Generated from requirements.lock and uv.lock. Do not edit by hand.
# Regenerate with: npm run generate:migration-engine:hash-lock
pydantic==2.0.0 \\
    --hash=sha256:${distributionHash}
`;
  const sourceFiles: Record<string, string> = {
    'src/omni_migrator/bridge.py': '# read-only bridge\n',
    'requirements.lock': 'pydantic==2.0.0\n',
    'requirements-hashed.lock': hashLock,
    'uv.lock': uvLock,
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
    packageName: 'omnikit-migration-engine',
    ownership: 'first-party',
    version: '0.0.1',
    sourceRoot,
    sourceRevision: 'a'.repeat(40),
    sourceContentSha256: treeSha(),
    dependencyLockSha256: sha(sourceFiles['requirements.lock']),
    dependencyHashLockSha256: sha(sourceFiles['requirements-hashed.lock']),
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
        NODE_ENV: 'test',
        FAKE_ENGINE_MANIFEST: manifestPath,
        OMNIKIT_MIGRATION_ENGINE_MANIFEST_PATH: manifestPath,
        OMNIKIT_TEST_MIGRATION_ENGINE_ROOT: sourceRoot,
        OMNIKIT_MIGRATION_ENGINE_PYTHON: python,
      },
    });
    assert.equal(JSON.parse(output).verified, true);

    writeFileSync(resolve(sourceRoot, 'contracts/conformance/sigma.json'), '{"drift":true}\n');
    assert.throws(() => execFileSync(process.execPath, [resolve(process.cwd(), 'scripts/verify-migration-engine-release.mjs')], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        FAKE_ENGINE_MANIFEST: manifestPath,
        OMNIKIT_MIGRATION_ENGINE_MANIFEST_PATH: manifestPath,
        OMNIKIT_TEST_MIGRATION_ENGINE_ROOT: sourceRoot,
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

import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import { artifactFromText } from '../src/services/semanticMigration/adapters';
import { buildMigrationEngineParityReport } from '../src/services/semanticMigration/engineParity';
import { migrationInventoryFromEngine } from '../src/services/semanticMigration/engineBridge';
import { parseLookerManualArtifacts } from '../server/services/semanticMigration/lookerManualParser';
import { getMigrationEngineCapabilities, resetMigrationEngineRuntimeForTests, runMigrationEngineExtract } from '../server/services/migrationEngineBridge';

const EXAMPLE_ROOT = resolve(process.cwd(), 'tests/fixtures/semantic-migrations/looker-northstar');
const EXAMPLE_FILES = ['northstar.model.lkml', 'northstar.view.lkml', 'northstar_dashboard.dashboard.lookml'];

test('Northstar Looker dry run preserves deterministic semantic and dashboard evidence without Omni writes', async () => {
  const originalMode = process.env.OMNIKIT_MIGRATION_ENGINE_MODE_LOOKER;
  process.env.OMNIKIT_MIGRATION_ENGINE_MODE_LOOKER = 'shadow';
  resetMigrationEngineRuntimeForTests();
  try {
    const artifacts = EXAMPLE_FILES.map((name) => ({ name, content: readFileSync(resolve(EXAMPLE_ROOT, name), 'utf8') }));
    const result = await runMigrationEngineExtract({
      requestId: 'northstar-looker-smoke-1',
      source: 'looker',
      mode: 'manual',
      artifacts,
      includeModelSuggestions: true,
      rulebookVersion: 'v2',
    });
    const reordered = await runMigrationEngineExtract({
      requestId: 'northstar-looker-smoke-2',
      source: 'looker',
      mode: 'manual',
      artifacts: [...artifacts].reverse(),
      includeModelSuggestions: true,
      rulebookVersion: 'v2',
    });

    assert.equal(result.control_plane?.rollout_mode, 'shadow');
    assert.equal(result.diagnostics.dashboard_count, 1);
    assert.ok(result.diagnostics.view_count >= 1);
    assert.ok(result.model_suggestions.length >= 2);
    const engineFields = new Set(result.bundle.model.views.flatMap((view) => view.fields.map((field) => field.name)));
    ['average_bag_size', 'attach_rate', 'discount_rate', 'items_per_bag', 'margin_pct'].forEach((name) => {
      assert.ok(engineFields.has(name), `Expected compound measure ${name} to survive extraction.`);
    });
    assert.equal(new Set(result.bundle.model.views.map((view) => view.source_id)).size, result.bundle.model.views.length);
    assert.deepEqual(
      result.bundle.model.views.map((view) => view.source_id).sort(),
      reordered.bundle.model.views.map((view) => view.source_id).sort(),
    );
    assert.ok(result.bundle.dashboards.every((dashboard) => dashboard.evidence.length > 0 && dashboard.tiles.every((tile) => tile.evidence.length > 0)));

    const nativeArtifacts = artifacts.map((item, index) => artifactFromText('looker', item.content, item.name, `northstar-native-${index + 1}`)!).filter(Boolean);
    const native = parseLookerManualArtifacts(nativeArtifacts).inventory;
    const parity = buildMigrationEngineParityReport({
      baseline: native,
      candidate: migrationInventoryFromEngine(result, nativeArtifacts),
      engineResult: result,
      mode: 'shadow',
    });
    assert.equal(parity.mode, 'shadow');
    assert.equal(parity.source, 'looker');
    assert.ok(parity.categories.views.candidateCount > 0);
    assert.ok(parity.scores.stableIdentity >= 90, JSON.stringify(parity.scores));
    assert.equal(parity.promotion.promotable, false);
    assert.ok(parity.promotion.blockers.some((blocker) => blocker.includes('Semantic parity')));
    assert.ok(parity.promotion.blockers.some((blocker) => blocker.includes('Dashboard parity')));
    assert.ok(parity.promotion.blockers.some((blocker) => blocker.includes('shadow observations')));
  } finally {
    if (originalMode === undefined) delete process.env.OMNIKIT_MIGRATION_ENGINE_MODE_LOOKER;
    else process.env.OMNIKIT_MIGRATION_ENGINE_MODE_LOOKER = originalMode;
    resetMigrationEngineRuntimeForTests();
  }
});

test('engine queue applies backpressure and supports queued and active cancellation', async () => {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), 'omnikit-engine-cancel-e2e-'));
  const fakePython = resolve(temporaryRoot, 'fake-python.mjs');
  const managedManifest = JSON.parse(readFileSync(resolve(process.cwd(), 'data/migration-engine/manifest.json'), 'utf8')) as {
    engine: string;
    version: string;
  };
  const originalPython = process.env.OMNIKIT_MIGRATION_ENGINE_PYTHON;
  const originalConcurrency = process.env.OMNIKIT_MIGRATION_ENGINE_MAX_CONCURRENCY;
  const originalQueue = process.env.OMNIKIT_MIGRATION_ENGINE_MAX_QUEUE;
  const originalMode = process.env.OMNIKIT_MIGRATION_ENGINE_MODE_LOOKER;
  const capabilities = {
    schema_version: 'omnikit.migration.bridge.v1',
    result_schema_version: 'omnikit.migration.bundle.v1',
    supported_result_schema_versions: ['omnikit.migration.bundle.v1'],
    engine: { name: managedManifest.engine, version: managedManifest.version },
    runtime: { python_version: '3.12.0' },
    operations: ['extract', 'capabilities'],
    write_authority: false,
    sources: {},
  };
  writeFileSync(fakePython, `#!/usr/bin/env node\nconst args = process.argv.slice(2);\nif (args.includes('capabilities')) { console.log(${JSON.stringify(JSON.stringify(capabilities))}); process.exit(0); }\nsetTimeout(() => console.log('{}'), 10000);\n`);
  chmodSync(fakePython, 0o700);
  process.env.OMNIKIT_MIGRATION_ENGINE_PYTHON = fakePython;
  process.env.OMNIKIT_MIGRATION_ENGINE_MAX_CONCURRENCY = '1';
  process.env.OMNIKIT_MIGRATION_ENGINE_MAX_QUEUE = '1';
  process.env.OMNIKIT_MIGRATION_ENGINE_MODE_LOOKER = 'shadow';
  resetMigrationEngineRuntimeForTests();
  try {
    await getMigrationEngineCapabilities();
    const firstController = new AbortController();
    const queuedController = new AbortController();
    const first = runMigrationEngineExtract({ requestId: 'active-cancel', source: 'looker', mode: 'manual', artifacts: [{ name: 'one.lkml', content: 'view: one {}' }], signal: firstController.signal });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    const queued = runMigrationEngineExtract({ requestId: 'queued-cancel', source: 'looker', mode: 'manual', artifacts: [{ name: 'two.lkml', content: 'view: two {}' }], signal: queuedController.signal });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    await assert.rejects(
      runMigrationEngineExtract({ requestId: 'backpressure', source: 'looker', mode: 'manual', artifacts: [{ name: 'three.lkml', content: 'view: three {}' }] }),
      (error: unknown) => Boolean(error && typeof error === 'object' && 'statusCode' in error && (error as { statusCode: number }).statusCode === 429),
    );
    queuedController.abort();
    await assert.rejects(queued, /cancelled while queued/);
    firstController.abort();
    await assert.rejects(first, /cancelled/);
  } finally {
    if (originalPython === undefined) delete process.env.OMNIKIT_MIGRATION_ENGINE_PYTHON;
    else process.env.OMNIKIT_MIGRATION_ENGINE_PYTHON = originalPython;
    if (originalConcurrency === undefined) delete process.env.OMNIKIT_MIGRATION_ENGINE_MAX_CONCURRENCY;
    else process.env.OMNIKIT_MIGRATION_ENGINE_MAX_CONCURRENCY = originalConcurrency;
    if (originalQueue === undefined) delete process.env.OMNIKIT_MIGRATION_ENGINE_MAX_QUEUE;
    else process.env.OMNIKIT_MIGRATION_ENGINE_MAX_QUEUE = originalQueue;
    if (originalMode === undefined) delete process.env.OMNIKIT_MIGRATION_ENGINE_MODE_LOOKER;
    else process.env.OMNIKIT_MIGRATION_ENGINE_MODE_LOOKER = originalMode;
    resetMigrationEngineRuntimeForTests();
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

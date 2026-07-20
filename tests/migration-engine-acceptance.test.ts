import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  buildLiveAcceptanceConfig,
  buildLiveAcceptanceRequest,
  buildSanitizedAcceptanceEvidence,
  loadLiveAcceptanceArtifacts,
  localControlPlaneOrigin,
  localReleaseProvenance,
  parseLiveAcceptanceArgs,
} from '../scripts/accept-migration-engine-live.mjs';
import {
  ACCEPTANCE_REVIEW_SCHEMA_VERSION,
  finalizeMigrationEngineLiveAcceptance,
  LIVE_ACCEPTANCE_SCHEMA_VERSION,
  REVIEWED_ACCEPTANCE_STAGES,
  sha256Json,
  validateMigrationEngineLiveAcceptance,
} from '../scripts/migration-engine-certification.mjs';
import { buildMigrationEngineReadiness } from '../scripts/report-migration-engine-readiness.mjs';

test('live acceptance only targets the local OmniKit control plane', () => {
  assert.equal(localControlPlaneOrigin('http://127.0.0.1:5176/path'), 'http://127.0.0.1:5176');
  assert.equal(localControlPlaneOrigin('http://localhost:5173'), 'http://localhost:5173');
  assert.throws(() => localControlPlaneOrigin('https://example.com'), /only send source evidence to a local OmniKit origin/);
  assert.throws(() => localControlPlaneOrigin('http://user:pass@localhost:5173'), /must not contain credentials/);
});

test('live acceptance rejects plaintext credential flags', () => {
  assert.throws(
    () => parseLiveAcceptanceArgs(['--source', 'looker', '--client-secret', 'never-store-this']),
    /Plaintext credential flags are not accepted/,
  );
});

test('release provenance fails closed when a release commit is invalid', () => {
  assert.deepEqual(localReleaseProvenance({ commitSha: 'not-a-commit', worktreeDirty: 'false' }), {
    commit_sha: 'unknown',
    worktree_dirty: false,
  });
});

test('API acceptance uses a vault reference and selected dashboard scope', () => {
  const config = buildLiveAcceptanceConfig(parseLiveAcceptanceArgs([
    '--source', 'looker',
    '--url', 'http://127.0.0.1:5176',
    '--connection-id', 'saved-looker-profile',
    '--target-instance-id', 'target-omni-profile',
    '--dashboard-id', '42',
    '--project-id', 'commerce',
  ]));
  const request = buildLiveAcceptanceRequest(config);
  assert.equal(request.connectionId, 'saved-looker-profile');
  assert.equal(request.targetInstanceId, 'target-omni-profile');
  assert.deepEqual(request.scope, { selected_dashboard_ids: ['42'], project_ids: ['commerce'] });
  assert.equal(JSON.stringify(request).includes('credential'), false);
  assert.equal(JSON.stringify(request).includes('secret'), false);
});

test('manual acceptance preserves binary bytes but evidence stores only hashes and counts', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'omnikit-live-acceptance-'));
  try {
    const artifactPath = resolve(root, 'customer-report.pbix');
    writeFileSync(artifactPath, Buffer.from([0, 1, 2, 3, 254, 255]));
    const config = buildLiveAcceptanceConfig(parseLiveAcceptanceArgs([
      '--source', 'powerbi',
      '--url', 'http://127.0.0.1:5176',
      '--target-instance-id', 'target-omni-profile',
      '--artifact', artifactPath,
    ]));
    const artifacts = loadLiveAcceptanceArtifacts(config.artifactPaths);
    const request = buildLiveAcceptanceRequest(config, artifacts);
    assert.equal(request.artifacts?.[0].contentBase64, 'AAECA/7/');

    const evidence = buildSanitizedAcceptanceEvidence({
      config,
      request,
      artifactEvidence: artifacts.map((item) => item.evidence),
      recordedAt: '2026-07-15T12:00:00.000Z',
      omnikit: { commit_sha: 'f'.repeat(40), worktree_dirty: false },
      result: {
        schema_version: 'omnikit.migration.bundle.v1',
        source: 'powerbi',
        mode: 'manual',
        engine: { name: 'omni-migrator', version: '0.0.1', revision: 'abc123' },
        diagnostics: {
          view_count: 2, field_count: 8, topic_count: 1, dashboard_count: 1,
          untranslatable_count: 2, rulebook_version: 'v2', rulebook_sha256: 'a'.repeat(64),
          limitations: ['Complex DAX requires review.'],
        },
        control_plane: { rollout_mode: 'shadow', duration_ms: 25, queue_wait_ms: 1 },
        bundle: { dashboards: [{ source_id: 'customer-dashboard-id' }] },
        connection_mappings: [{ confidence: 'exact', target_connection_id: 'customer-connection-id', confirmed: true }],
        model_suggestions: [{ content: 'secret customer model YAML' }],
        capability_coverage: { semantic: 'full', dashboards: 'partial' },
      },
    });
    const serialized = JSON.stringify(evidence);
    assert.equal(serialized.includes('customer-report.pbix'), false);
    assert.equal(serialized.includes('customer-dashboard-id'), false);
    assert.equal(serialized.includes('customer-connection-id'), false);
    assert.equal(serialized.includes('secret customer model YAML'), false);
    assert.equal(serialized.includes('AAECA/7/'), false);
    assert.equal(evidence.result.dashboard_count, 1);
    assert.equal(evidence.result.mapping_confidence.exact, 1);
    assert.equal(evidence.input.artifact_fingerprints[0].size_bytes, 6);
    assert.equal(evidence.schema_version, LIVE_ACCEPTANCE_SCHEMA_VERSION);
    assert.equal(evidence.evidence_status, 'provisional');
    assert.equal(evidence.outcome, 'incomplete');
    assert.equal(evidence.stages.source_extraction.status, 'passed');
    assert.equal(evidence.stages.semantic_translation.status, 'not_run');
    assert.equal(evidence.gaps.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function completedReview(provisional: Record<string, unknown>, provisionalSha256: string) {
  return {
    schema_version: ACCEPTANCE_REVIEW_SCHEMA_VERSION,
    source: provisional.source,
    provisional_evidence_sha256: provisionalSha256,
    owner: 'Migration Owner',
    reviewed_at: '2026-07-16T00:00:00.000Z',
    expires_at: '2026-08-15T00:00:00.000Z',
    stages: Object.fromEntries(REVIEWED_ACCEPTANCE_STAGES.map((stage) => [stage, {
      status: 'passed',
      evidence_sha256: sha256Json({ stage }),
      checked_count: 1,
      failed_count: 0,
    }])),
    gaps: [],
  };
}

function passingFinalEvidence() {
  const provisional = {
    schema_version: LIVE_ACCEPTANCE_SCHEMA_VERSION,
    evidence_status: 'provisional',
    recorded_at: '2026-07-15T00:00:00.000Z',
    outcome: 'incomplete',
    source: 'sigma',
    mode: 'api',
    omnikit: { commit_sha: 'c'.repeat(40), worktree_dirty: false },
    engine: { name: 'omni-migrator', version: '0.1.0', revision: 'a'.repeat(40), result_schema_version: 'omnikit.migration.bundle.v1', rulebook_sha256: 'b'.repeat(64) },
    input: { evidence_origin: 'live_source', target_instance_ref_sha256: 'target-ref', selected_dashboard_count: 1, connection_override_count: 0 },
    result: { view_count: 2, dashboard_count: 1, connection_mapping_count: 1, mapped_connection_count: 1 },
    stages: {
      source_extraction: { status: 'passed', live: true, evidence_sha256: 'd'.repeat(64), checked_count: 1, failed_count: 0 },
    },
    gaps: [],
  };
  const provisionalSha256 = sha256Json(provisional);
  const review = completedReview(provisional, provisionalSha256);
  return finalizeMigrationEngineLiveAcceptance({
    provisionalEvidence: provisional,
    review,
    provisionalSha256,
    reviewSha256: sha256Json(review),
    finalizedAt: '2026-07-16T00:01:00.000Z',
    now: new Date('2026-07-16T00:00:30.000Z'),
  });
}

test('promotion acceptance requires finalized, current, scoped evidence with all downstream stages', () => {
  const manifest = {
    engine: 'omni-migrator', version: '0.1.0', sourceRevision: 'a'.repeat(40),
    resultSchemaVersion: 'omnikit.migration.bundle.v1', installedAt: '2026-07-01T00:00:00.000Z',
  };
  const evidence = passingFinalEvidence();
  assert.equal(validateMigrationEngineLiveAcceptance({ evidence, source: 'sigma', manifest, now: new Date('2026-07-20T00:00:00.000Z') }).dashboardCount, 1);
  assert.throws(() => validateMigrationEngineLiveAcceptance({ evidence: { ...evidence, input: { ...evidence.input, selected_dashboard_count: 0 } }, source: 'sigma', manifest }), /scoped source evidence/);
  assert.throws(() => validateMigrationEngineLiveAcceptance({ evidence: { ...evidence, result: { ...evidence.result, mapped_connection_count: 0 } }, source: 'sigma', manifest }), /map every discovered source connection/);
  assert.throws(() => validateMigrationEngineLiveAcceptance({ evidence: { ...evidence, input: { ...evidence.input, evidence_origin: 'canonical_fixture' } }, source: 'sigma', manifest }), /origin/);
  assert.throws(() => validateMigrationEngineLiveAcceptance({ evidence: { ...evidence, stages: { ...evidence.stages, omni_validation: { ...evidence.stages.omni_validation, status: 'not_run' } } }, source: 'sigma', manifest }), /omni_validation/);
  assert.throws(() => validateMigrationEngineLiveAcceptance({ evidence, source: 'sigma', manifest, now: new Date('2026-09-01T00:00:00.000Z') }), /expired/);
});

test('finalization blocks dirty provenance and requires every extracted capability gap to be dispositioned', () => {
  const base = passingFinalEvidence();
  const provisional = {
    ...base,
    evidence_status: 'provisional',
    outcome: 'incomplete',
    finalized_at: undefined,
    expires_at: undefined,
    owner: undefined,
    review: undefined,
    stages: { source_extraction: base.stages.source_extraction },
    gaps: [{
      id: 'capability:artifacts.permissions',
      category: 'artifacts.permissions',
      coverage: 'unsupported',
      disposition: 'unreviewed',
      count: 1,
    }],
  };
  const provisionalSha256 = sha256Json(provisional);
  const review = completedReview(provisional, provisionalSha256);
  assert.throws(() => finalizeMigrationEngineLiveAcceptance({
    provisionalEvidence: provisional,
    review,
    provisionalSha256,
    reviewSha256: sha256Json(review),
    now: new Date('2026-07-16T00:00:30.000Z'),
  }), /remains unreviewed/);

  const reviewedGap = {
    ...review,
    gaps: [{
      id: 'capability:artifacts.permissions',
      category: 'artifacts.permissions',
      coverage: 'unsupported',
      disposition: 'deferred',
      evidence_sha256: '9'.repeat(64),
      count: 1,
    }],
  };
  assert.equal(finalizeMigrationEngineLiveAcceptance({
    provisionalEvidence: provisional,
    review: reviewedGap,
    provisionalSha256,
    reviewSha256: sha256Json(reviewedGap),
    now: new Date('2026-07-16T00:00:30.000Z'),
  }).gaps[0].disposition, 'deferred');

  assert.throws(() => finalizeMigrationEngineLiveAcceptance({
    provisionalEvidence: { ...provisional, omnikit: { ...provisional.omnikit, worktree_dirty: true } },
    review: reviewedGap,
    provisionalSha256,
    reviewSha256: sha256Json(reviewedGap),
    now: new Date('2026-07-16T00:00:30.000Z'),
  }), /clean OmniKit commit/);
});

test('readiness distinguishes shadow, eligible, primary, and rolled-back sources', () => {
  const manifest = {
    engine: 'omni-migrator', version: '0.1.0', sourceRevision: 'a'.repeat(40),
    conformance: { sources: Object.fromEntries(['looker', 'powerbi', 'tableau', 'metabase', 'sigma'].map((source) => [source, { passed: true }])) },
  };
  const runtimeObservation = { mode: 'shadow', observationType: 'native_parity', engineName: 'omni-migrator', engineVersion: '0.1.0' };
  const observations = { sources: {
    looker: Array.from({ length: 20 }, () => runtimeObservation),
    powerbi: [], tableau: [], metabase: [], sigma: [],
  } };
  const acceptanceEntries = [{ source: 'looker', summary: { recordedAt: '2026-07-15T00:00:00.000Z' }, sha256: 'c'.repeat(64), file: 'looker.json' }];
  const sourceRegistry = [{ id: 'looker', releaseStage: 'preview' }];
  const eligible = buildMigrationEngineReadiness({ manifest, observations, promotions: { sources: {} }, acceptanceEntries, sourceRegistry });
  assert.equal(eligible.find((item) => item.source === 'looker')?.state, 'eligible');
  assert.equal(eligible.find((item) => item.source === 'looker')?.releaseStage, 'preview');
  assert.match(eligible.find((item) => item.source === 'looker')?.releaseBlockers[0] || '', /not approved for general availability/i);
  assert.equal(eligible.find((item) => item.source === 'sigma')?.state, 'shadow');

  const primaryRecord = {
    engine: { sourceRevision: manifest.sourceRevision },
    liveAcceptance: {
      schemaVersion: LIVE_ACCEPTANCE_SCHEMA_VERSION,
      evidenceSha256: 'c'.repeat(64),
      stageCount: 8,
      expiresAt: '2026-08-15T00:00:00.000Z',
    },
  };
  const primary = buildMigrationEngineReadiness({ manifest, observations, promotions: { sources: { looker: primaryRecord } }, acceptanceEntries, sourceRegistry });
  assert.equal(primary.find((item) => item.source === 'looker')?.state, 'primary');
  const rolledBack = buildMigrationEngineReadiness({ manifest, observations, promotions: { sources: { looker: { ...primaryRecord, rolledBackAt: '2026-07-16T00:00:00.000Z', rollbackReason: 'Observed regression' } } }, acceptanceEntries, sourceRegistry });
  assert.equal(rolledBack.find((item) => item.source === 'looker')?.state, 'rolled_back');
});

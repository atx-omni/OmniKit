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
import {
  loadMigrationEnginePromotionPolicy,
  validateMigrationEnginePromotionPolicy,
} from '../scripts/migration-engine-promotion-policy.mjs';
import {
  LOOKER_DUAL_PATH_CAMPAIGN_SCHEMA_VERSION,
  validateLookerDualPathAcceptanceCampaign,
} from '../scripts/verify-looker-live-acceptance-campaign.mjs';

test('one versioned promotion policy defines thresholds and required source modes', () => {
  const policy = loadMigrationEnginePromotionPolicy();
  assert.deepEqual(policy.sources.looker.requiredAcceptanceModes, ['manual', 'api']);
  assert.deepEqual(policy.sources.powerbi.requiredAcceptanceModes, ['manual']);
  assert.throws(() => validateMigrationEnginePromotionPolicy({
    ...policy,
    sources: { ...policy.sources, looker: { ...policy.sources.looker, requiredAcceptanceModes: ['manual', 'manual'] } },
  }), /unique manual or api modes/);
});

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

function passingLookerCampaignFixture() {
  const releaseCommitSha = 'e'.repeat(40);
  const projectRef = '8'.repeat(64);
  const manifest = {
    schemaVersion: 2,
    engine: 'omni-migrator',
    version: '0.1.0',
    sourceRevision: 'a'.repeat(40),
    sourceContentSha256: '2'.repeat(64),
    resultSchemaVersion: 'omnikit.migration.bundle.v1',
    installedAt: '2026-07-20T00:00:00.000Z',
  };
  const buildEvidence = (mode: 'manual' | 'api') => {
    const provisional = {
      schema_version: LIVE_ACCEPTANCE_SCHEMA_VERSION,
      evidence_status: 'provisional',
      recorded_at: '2026-07-21T00:00:00.000Z',
      outcome: 'incomplete',
      source: 'looker',
      mode,
      omnikit: { commit_sha: releaseCommitSha, worktree_dirty: false },
      engine: {
        name: manifest.engine,
        version: manifest.version,
        revision: manifest.sourceRevision,
        result_schema_version: manifest.resultSchemaVersion,
        rulebook_sha256: '3'.repeat(64),
      },
      input: {
        evidence_origin: 'live_source',
        target_instance_ref_sha256: '4'.repeat(64),
        artifact_count: mode === 'manual' ? 1 : 0,
        selected_dashboard_count: mode === 'api' ? 1 : 0,
        selected_project_count: 1,
        selected_project_scope_sha256: projectRef,
        connection_override_count: 0,
      },
      result: {
        view_count: 8,
        dashboard_count: 1,
        connection_mapping_count: 1,
        mapped_connection_count: 1,
      },
      stages: {
        source_extraction: {
          status: 'passed',
          live: true,
          evidence_sha256: mode === 'manual' ? '5'.repeat(64) : '6'.repeat(64),
          checked_count: 1,
          failed_count: 0,
        },
      },
      gaps: [],
    };
    const provisionalSha256 = sha256Json(provisional);
    const review = {
      ...completedReview(provisional, provisionalSha256),
      reviewed_at: '2026-07-21T11:00:00.000Z',
      expires_at: '2026-08-20T11:00:00.000Z',
    };
    return finalizeMigrationEngineLiveAcceptance({
      provisionalEvidence: provisional,
      review,
      provisionalSha256,
      reviewSha256: sha256Json(review),
      finalizedAt: '2026-07-21T12:00:00.000Z',
      now: new Date('2026-07-21T11:59:00.000Z'),
    });
  };
  const manualEvidence = buildEvidence('manual');
  const apiEvidence = buildEvidence('api');
  const manualEvidenceSha256 = sha256Json(manualEvidence);
  const apiEvidenceSha256 = sha256Json(apiEvidence);
  const manifestSha256 = '7'.repeat(64);
  const rollbackDrill = {
    id: 'looker-rollback-2026-07',
    source: 'looker',
    passed: true,
    completedAt: '2026-07-20T12:00:00.000Z',
    completedBy: 'Release Owner',
    engine: {
      name: manifest.engine,
      version: manifest.version,
      sourceRevision: manifest.sourceRevision,
      sourceContentSha256: manifest.sourceContentSha256,
      manifestSha256,
    },
  };
  const evidence = (seed: string) => ({
    manualSha256: seed.repeat(64),
    apiSha256: String(Number(seed) + 1).repeat(64),
    comparisonSha256: String(Number(seed) + 2).repeat(64),
    checkedCount: 1,
    failedCount: 0,
  });
  const campaign = {
    schemaVersion: LOOKER_DUAL_PATH_CAMPAIGN_SCHEMA_VERSION,
    releaseCommitSha,
    releaseStage: 'preview',
    representativeProjectRefSha256: projectRef,
    owner: 'Migration Owner',
    approvedAt: '2026-07-22T10:00:00.000Z',
    expiresAt: '2026-08-20T10:00:00.000Z',
    acceptance: {
      manual: {
        finalAcceptanceSha256: manualEvidenceSha256,
        sourceProjectRefSha256: projectRef,
        branchRefSha256: '9'.repeat(64),
      },
      api: {
        finalAcceptanceSha256: apiEvidenceSha256,
        sourceProjectRefSha256: projectRef,
        branchRefSha256: 'a'.repeat(64),
      },
    },
    requiredConstructs: {
      standardViews: true,
      measures: true,
      joins: true,
      inlineTile: true,
      savedLookTile: true,
      filtersAndListeners: true,
      layout: true,
      reviewRequiredConstruct: true,
    },
    accounting: {
      manual: {
        selectedDashboardCount: 1,
        accountedDashboardCount: 1,
        selectedTileCount: 8,
        accountedTileCount: 8,
        silentOmissionCount: 0,
      },
      api: {
        selectedDashboardCount: 1,
        accountedDashboardCount: 1,
        selectedTileCount: 8,
        accountedTileCount: 8,
        silentOmissionCount: 0,
      },
    },
    parity: { semantic: 96, dashboards: 92, stableIdentity: 97, overall: 94 },
    comparisonEvidence: {
      canonicalInventory: evidence('1'),
      generatedYaml: evidence('2'),
      dashboardPlans: evidence('3'),
      validation: evidence('4'),
      reconciliation: evidence('5'),
    },
    rollback: {
      id: rollbackDrill.id,
      completedAt: rollbackDrill.completedAt,
      drillSha256: sha256Json(rollbackDrill),
    },
  };
  return {
    campaign,
    manualEvidence,
    apiEvidence,
    manualEvidenceSha256,
    apiEvidenceSha256,
    manifest,
    manifestSha256,
    rollbackLedger: {
      schemaVersion: 'omnikit.migration-engine-rollback-drills.v1',
      drills: [rollbackDrill],
    },
    now: new Date('2026-07-22T12:00:00.000Z'),
  };
}

test('Looker dual-path campaign binds both acquisition modes and passes every threshold', () => {
  const fixture = passingLookerCampaignFixture();
  const summary = validateLookerDualPathAcceptanceCampaign(fixture);
  assert.equal(summary.ready, true);
  assert.equal(summary.releaseStage, 'preview');
  assert.deepEqual(summary.modes, ['manual', 'api']);
  assert.equal(summary.comparisonCount, 5);
  assert.equal(summary.accounting.manual.silentOmissionCount, 0);
});

test('Looker dual-path campaign fails closed on omissions, weak parity, and reused branches', () => {
  const fixture = passingLookerCampaignFixture();
  assert.throws(() => validateLookerDualPathAcceptanceCampaign({
    ...fixture,
    campaign: {
      ...fixture.campaign,
      accounting: {
        ...fixture.campaign.accounting,
        manual: { ...fixture.campaign.accounting.manual, accountedTileCount: 7, silentOmissionCount: 1 },
      },
    },
  }), /100% of selected dashboards and tiles/);
  assert.throws(() => validateLookerDualPathAcceptanceCampaign({
    ...fixture,
    campaign: { ...fixture.campaign, parity: { ...fixture.campaign.parity, semantic: 94 } },
  }), /semantic 94 < 95/);
  assert.throws(() => validateLookerDualPathAcceptanceCampaign({
    ...fixture,
    campaign: {
      ...fixture.campaign,
      acceptance: {
        ...fixture.campaign.acceptance,
        api: {
          ...fixture.campaign.acceptance.api,
          branchRefSha256: fixture.campaign.acceptance.manual.branchRefSha256,
        },
      },
    },
  }), /distinct isolated Omni development branches/);
  assert.throws(() => validateLookerDualPathAcceptanceCampaign({
    ...fixture,
    campaign: {
      ...fixture.campaign,
      acceptance: {
        ...fixture.campaign.acceptance,
        api: { ...fixture.campaign.acceptance.api, sourceProjectRefSha256: 'b'.repeat(64) },
      },
    },
  }), /same representative Looker project fingerprint/);
});

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
      owner: 'Governance Owner',
      rationale: 'The permission mapping will be reconciled manually before release.',
      due_at: '2026-08-01T00:00:00.000Z',
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
    provisionalEvidence: provisional,
    review: {
      ...reviewedGap,
      gaps: reviewedGap.gaps.map((gap) => Object.fromEntries(Object.entries(gap).filter(([key]) => key !== 'owner'))),
    },
    provisionalSha256,
    reviewSha256: sha256Json(reviewedGap),
    now: new Date('2026-07-16T00:00:30.000Z'),
  }), /accountable owner/);

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
  const acceptanceEntries = ['manual', 'api'].map((mode) => ({
    source: 'looker',
    summary: {
      mode,
      recordedAt: '2026-07-15T00:00:00.000Z',
      finalizedAt: '2026-07-15T01:00:00.000Z',
      expiresAt: '2099-08-15T00:00:00.000Z',
      owner: 'Migration Owner',
      omnikitCommitSha: 'f'.repeat(40),
      stageCount: 8,
      acceptedGapCount: 0,
      deferredGapCount: 0,
    },
    sha256: mode === 'manual' ? 'c'.repeat(64) : 'd'.repeat(64),
    file: `looker-${mode}.json`,
  }));
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
      expiresAt: '2099-08-15T00:00:00.000Z',
    },
    liveAcceptances: acceptanceEntries.map((entry) => ({
      ...entry.summary,
      schemaVersion: LIVE_ACCEPTANCE_SCHEMA_VERSION,
      source: 'looker',
      evidenceSha256: entry.sha256,
    })),
    omnikitCommitSha: 'f'.repeat(40),
  };
  const primary = buildMigrationEngineReadiness({ manifest, observations, promotions: { sources: { looker: primaryRecord } }, acceptanceEntries, sourceRegistry });
  assert.equal(primary.find((item) => item.source === 'looker')?.state, 'primary');
  const rolledBack = buildMigrationEngineReadiness({ manifest, observations, promotions: { sources: { looker: { ...primaryRecord, rolledBackAt: '2026-07-16T00:00:00.000Z', rollbackReason: 'Observed regression' } } }, acceptanceEntries, sourceRegistry });
  assert.equal(rolledBack.find((item) => item.source === 'looker')?.state, 'rolled_back');
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyReleaseFiles,
  validateReleaseScope,
} from '../scripts/migration-studio-release-scope.mjs';
import { evaluateMigrationStudioReleaseReadiness } from '../scripts/migration-studio-release-readiness.mjs';
import { validateDomoDualPathAcceptanceCampaign } from '../scripts/verify-domo-live-acceptance-campaign.mjs';

const DOMO_STAGES = [
  'sourceAcquisition',
  'dependencyClosure',
  'semanticCompilation',
  'branchDeployment',
  'omniValidation',
  'dashboardReconstruction',
  'queryResultReconciliation',
  'governanceOperationalReconciliation',
];

function domoAccounting(overrides = {}) {
  return {
    selectedPageCount: 1,
    accountedPageCount: 1,
    selectedCardCount: 2,
    accountedCardCount: 2,
    selectedDependencyCount: 5,
    accountedDependencyCount: 5,
    silentOmissionCount: 0,
    ...overrides,
  };
}

function domoAcceptance(mode, branchRefSha256) {
  return {
    schemaVersion: 'omnikit.domo-live-acceptance.v1',
    status: 'final',
    mode,
    recordedAt: '2026-07-21T12:00:00.000Z',
    expiresAt: '2026-08-21T12:00:00.000Z',
    owner: `${mode} migration owner`,
    releaseCommitSha: 'a'.repeat(40),
    sourceScopeRefSha256: 'b'.repeat(64),
    targetEnvironmentRefSha256: 'c'.repeat(64),
    branchRefSha256,
    parserContract: { id: 'domo-native-v2', sha256: 'd'.repeat(64) },
    accounting: domoAccounting(),
    stages: Object.fromEntries(DOMO_STAGES.map((name, index) => [name, {
      status: 'passed',
      evidenceSha256: String((index % 8) + 1).repeat(64),
      checkedCount: 1,
      failedCount: 0,
    }])),
  };
}

function domoCampaign() {
  const constructs = [
    'pages', 'sharedCards', 'sharedDatasets', 'datasetSchemas', 'beastModes', 'sqlDataflows',
    'relationships', 'pdpPolicies', 'ownershipAndUsage', 'schedulesAndAlerts', 'governedHandoffs', 'formulaCollision',
  ];
  const comparisons = ['canonicalInventory', 'dependencyClosure', 'generatedYaml', 'dashboardPlans', 'validation', 'reconciliation'];
  return {
    schemaVersion: 'omnikit.domo-dual-path-acceptance-campaign.v1',
    releaseCommitSha: 'a'.repeat(40),
    releaseStage: 'preview',
    sourceScopeRefSha256: 'b'.repeat(64),
    targetEnvironmentRefSha256: 'c'.repeat(64),
    parserContract: { id: 'domo-native-v2', sha256: 'd'.repeat(64) },
    owner: 'Domo campaign owner',
    approvedAt: '2026-07-22T10:00:00.000Z',
    expiresAt: '2026-08-22T10:00:00.000Z',
    acceptance: {
      manual: { finalEvidenceSha256: 'e'.repeat(64), branchRefSha256: 'f'.repeat(64) },
      api: { finalEvidenceSha256: '1'.repeat(64), branchRefSha256: '2'.repeat(64) },
    },
    requiredConstructs: Object.fromEntries(constructs.map((name) => [name, true])),
    accounting: { manual: domoAccounting(), api: domoAccounting() },
    parity: { semantic: 95, dashboards: 90, stableIdentity: 95, governance: 100, overall: 93 },
    comparisonEvidence: Object.fromEntries(comparisons.map((name, index) => [name, {
      manualSha256: String((index % 6) + 3).repeat(64),
      apiSha256: String((index % 4) + 6).repeat(64),
      comparisonSha256: 'a'.repeat(64),
      checkedCount: 1,
      failedCount: 0,
    }])),
    rollback: { owner: 'Release owner', completedAt: '2026-07-20T10:00:00.000Z', evidenceSha256: '9'.repeat(64) },
  };
}

function validScope(overrides = {}) {
  return {
    schemaVersion: 'omnikit.migration-studio-release-scope.v1',
    generatedAt: '2026-07-22T00:00:00.000Z',
    commitSha: 'a'.repeat(40),
    worktreeDirty: false,
    fileCount: 1,
    contentSha256: 'b'.repeat(64),
    prohibited: {
      planningDocuments: [],
      sensitiveFiles: [],
      durableOperatorEvidence: [],
      generatedReleaseArtifacts: [],
    },
    files: [{ path: 'README.md', sizeBytes: 100, sha256: 'c'.repeat(64) }],
    ...overrides,
  };
}

test('release scope classification rejects plans, secrets, evidence, and generated release output', () => {
  const classified = classifyReleaseFiles([
    'docs/plan-migration.md',
    '.env.production',
    'data/migration-engine/live-acceptance/looker.json',
    'artifacts/release/certificate.json',
    'src/main.tsx',
  ]);
  assert.deepEqual(classified.planningDocuments, ['docs/plan-migration.md']);
  assert.deepEqual(classified.sensitiveFiles, ['.env.production']);
  assert.deepEqual(classified.durableOperatorEvidence, ['data/migration-engine/live-acceptance/looker.json']);
  assert.deepEqual(classified.generatedReleaseArtifacts, ['artifacts/release/certificate.json']);
});

test('release scope validation binds a clean exact commit', () => {
  const scope = validScope();
  assert.deepEqual(validateReleaseScope(scope, { requireClean: true, expectedCommitSha: scope.commitSha }), []);
  assert.match(validateReleaseScope({ ...scope, worktreeDirty: true }, { requireClean: true })[0], /dirty worktree/);
  assert.match(validateReleaseScope(scope, { expectedCommitSha: 'd'.repeat(40) })[0], /does not match/);
});

test('release scope validation fails closed on prohibited content and malformed checksums', () => {
  const errors = validateReleaseScope(validScope({
    contentSha256: 'invalid',
    prohibited: {
      planningDocuments: ['PLAN.md'],
      sensitiveFiles: [],
      durableOperatorEvidence: [],
      generatedReleaseArtifacts: [],
    },
  }));
  assert.ok(errors.some((error) => /checksum/.test(error)));
  assert.ok(errors.some((error) => /planningDocuments/.test(error)));
});

test('Preview and GA readiness remain separate fail-closed decisions', () => {
  const input = {
    fullRepositoryGate: 'passed',
    releaseScope: { attested: true, exactSha: true },
    sourceConformance: { verified: true },
    hygiene: { planningDocs: 0, sensitiveFiles: 0, durableEvidence: 0 },
    governance: { configurationValid: true, requiredFilesPresent: true, externalBlockers: ['Named release owner'] },
    operations: {
      diagnostics: { available: true, passed: true },
      benchmark: { available: true, passed: true },
      cleanRoom: { available: true, passed: true },
      sbom: { available: true, passed: true },
      backupVerification: { available: true, passed: true },
      operationalQualification: { available: true, passed: true },
    },
    sourceContractsReleaseReady: true,
    engineSourcesReleaseReady: true,
    nativeSourcesReleaseReady: true,
  };
  assert.deepEqual(evaluateMigrationStudioReleaseReadiness(input), {
    previewReady: true,
    releaseReady: false,
  });
  assert.deepEqual(evaluateMigrationStudioReleaseReadiness({
    ...input,
    governance: { ...input.governance, externalBlockers: [] },
  }), {
    previewReady: true,
    releaseReady: true,
  });
  assert.deepEqual(evaluateMigrationStudioReleaseReadiness({
    ...input,
    releaseScope: { attested: false, exactSha: false },
  }), {
    previewReady: false,
    releaseReady: false,
  });
});

test('Domo paired acceptance requires complete Manual and API evidence for the same source scope', () => {
  const summary = validateDomoDualPathAcceptanceCampaign({
    campaign: domoCampaign(),
    manualEvidence: domoAcceptance('manual', 'f'.repeat(64)),
    apiEvidence: domoAcceptance('api', '2'.repeat(64)),
    manualEvidenceSha256: 'e'.repeat(64),
    apiEvidenceSha256: '1'.repeat(64),
    now: new Date('2026-07-22T12:00:00.000Z'),
  });
  assert.equal(summary.ready, true);
  assert.deepEqual(summary.modes, ['manual', 'api']);
  assert.equal(summary.accounting.manual.silentOmissionCount, 0);
  assert.equal(summary.releaseStage, 'preview');
});

test('Domo paired acceptance fails closed on omissions, weak parity, and sensitive fields', () => {
  const input = {
    campaign: domoCampaign(),
    manualEvidence: domoAcceptance('manual', 'f'.repeat(64)),
    apiEvidence: domoAcceptance('api', '2'.repeat(64)),
    manualEvidenceSha256: 'e'.repeat(64),
    apiEvidenceSha256: '1'.repeat(64),
    now: new Date('2026-07-22T12:00:00.000Z'),
  };
  assert.throws(() => validateDomoDualPathAcceptanceCampaign({
    ...input,
    campaign: { ...input.campaign, accounting: { ...input.campaign.accounting, api: domoAccounting({ silentOmissionCount: 1 }) } },
  }), /zero silent omissions/);
  assert.throws(() => validateDomoDualPathAcceptanceCampaign({
    ...input,
    campaign: { ...input.campaign, parity: { ...input.campaign.parity, governance: 99 } },
  }), /below the Preview threshold/);
  assert.throws(() => validateDomoDualPathAcceptanceCampaign({
    ...input,
    apiEvidence: { ...input.apiEvidence, accessToken: 'must-never-appear' },
  }), /prohibited sensitive field/);
});

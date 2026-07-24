import assert from 'node:assert/strict';
import test from 'node:test';

import {
  validateGovernanceConfiguration,
  validateRepositoryEvidence,
} from '../scripts/verify-release-governance.mjs';

function governance(overrides = {}) {
  return {
    schemaVersion: 'omnikit.release-governance.v1',
    releaseOwner: null,
    supportOwner: null,
    securityOwner: null,
    supportResponseTarget: null,
    rootLicense: {
      status: 'pending_legal_approval',
      spdx: null,
      decisionRecord: 'docs/governance/root-license-decision.md',
    },
    repositoryPolicy: {
      requiredReviews: 1,
      requiredStatusChecks: true,
      requireConversationResolution: true,
      secretPushProtection: true,
    },
    ...overrides,
  };
}

test('pending human governance decisions are valid configuration without being approved', () => {
  assert.deepEqual(validateGovernanceConfiguration(governance()), []);
});

test('governance configuration rejects weak repository policy and fabricated license state', () => {
  const errors = validateGovernanceConfiguration(governance({
    rootLicense: {
      status: 'approved',
      spdx: null,
      decisionRecord: 'docs/governance/root-license-decision.md',
    },
    repositoryPolicy: {
      requiredReviews: 0,
      requiredStatusChecks: false,
      requireConversationResolution: false,
      secretPushProtection: false,
    },
  }));
  assert.ok(errors.some((error) => /SPDX/.test(error)));
  assert.ok(errors.some((error) => /at least 1/.test(error)));
  assert.ok(errors.some((error) => /secretPushProtection/.test(error)));
});

test('repository evidence must match the exact commit and declared protection floor', () => {
  const commitSha = 'a'.repeat(40);
  const valid = {
    schemaVersion: 'omnikit.repository-governance-evidence.v1',
    generatedAt: '2026-07-22T00:00:00.000Z',
    commitSha,
    provider: 'github',
    repository: 'exploreomni/omnikit',
    branch: 'main',
    actualPolicy: {
      requiredReviews: 1,
      requiredStatusChecks: true,
      requireConversationResolution: true,
      secretPushProtection: true,
    },
    verifiedBy: 'repository-admin@example.test',
  };
  assert.deepEqual(validateRepositoryEvidence(valid, governance(), commitSha), []);
  const errors = validateRepositoryEvidence({
    ...valid,
    commitSha: 'b'.repeat(40),
    actualPolicy: { ...valid.actualPolicy, requiredStatusChecks: false },
  }, governance(), commitSha);
  assert.ok(errors.some((error) => /release commit/.test(error)));
  assert.ok(errors.some((error) => /status checks/.test(error)));
});

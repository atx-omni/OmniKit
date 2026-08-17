import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';

import {
  allocateDashboardSafeCopyName,
  findLatestVerifiedDashboardSafeCopyProvenance,
  findLatestVerifiedDashboardSafeCopyProvenanceInStore,
  type DashboardSafeCopyDocumentVerificationProvenance,
  type DashboardSafeCopyProvenanceScope,
} from '../server/services/dashboardSafeCopyProvenance';
import {
  clearJobs,
  closeJobStoreForTests,
  insertJob,
} from '../server/services/jobStore';
import type {
  MigrationJob,
  MigrationJobItem,
} from '../server/services/migrationJobs';

const testRoot = mkdtempSync(join(tmpdir(), 'omnikit-safe-copy-provenance-'));
process.env.OMNIKIT_JOB_HISTORY_PATH = join(testRoot, 'jobs.json');
process.env.OMNIKIT_JOBS_PATH = join(testRoot, 'legacy-jobs.json');

const NOW = Date.UTC(2026, 7, 16, 12, 0, 0);
const VERIFIED_AT = NOW - 1_000;
const scope: DashboardSafeCopyProvenanceScope = {
  sourceInstanceId: 'source-a',
  sourceConnectionId: 'source-connection',
  sourceDocumentId: 'source-dashboard',
  destinationInstanceId: 'destination-b',
  targetConnectionId: 'destination-connection',
  targetModelId: 'target-model',
  targetFolderId: 'target-folder',
  targetFolderPath: 'Shared/Safe copies',
};

function provenance(
  jobId: string,
  patch: Partial<DashboardSafeCopyDocumentVerificationProvenance> = {},
): DashboardSafeCopyDocumentVerificationProvenance {
  return {
    profile: 'safe_copy_v1',
    resolverVersion: 2,
    verifierVersion: 3,
    jobId,
    attemptId: `${jobId}-attempt`,
    targetId: 'target-b',
    sourceInstanceId: 'source-a',
    sourceConnectionId: 'source-connection',
    sourceDocumentId: 'source-dashboard',
    sourceExportHash: 'source-export-fingerprint',
    destinationInstanceId: 'destination-b',
    connectionId: 'destination-connection',
    modelId: 'target-model',
    folderId: 'target-folder',
    folderPath: 'Shared/Safe copies',
    importedDocumentId: 'imported-document',
    importedIdentifier: 'imported-identifier',
    chosenName: 'Example dashboard (Copy)',
    expectedPayloadHash: 'published-content-fingerprint',
    publishedFingerprint: 'published-content-fingerprint',
    finalVerification: 'passed',
    documentWriteMode: 'created',
    verifiedAt: VERIFIED_AT,
    ...patch,
  };
}

function item(
  jobId: string,
  patch: Partial<MigrationJobItem> = {},
  provenancePatch: Partial<DashboardSafeCopyDocumentVerificationProvenance> = {},
): MigrationJobItem {
  return {
    id: `${jobId}-verification`,
    jobId,
    targetId: 'target-b',
    destinationId: 'destination-b',
    destinationLabel: 'Destination B',
    targetModelId: 'target-model',
    targetFolderId: 'target-folder',
    targetFolderPath: 'Shared/Safe copies',
    kind: 'document_verify',
    documentId: 'source-dashboard',
    documentName: 'Example dashboard (Copy)',
    status: 'succeeded',
    endedAt: VERIFIED_AT,
    importedDocumentId: 'imported-document',
    importedIdentifier: 'imported-identifier',
    details: {
      safeCopyDocumentProvenance: provenance(jobId, provenancePatch),
    },
    ...patch,
  };
}

function safeCopyJob(
  id: string,
  patch: Partial<MigrationJob> = {},
): MigrationJob {
  return {
    id,
    workflow: 'dashboard',
    sourceId: 'source-a',
    sourceLabel: 'Source A',
    sourceConnectionId: 'source-connection',
    destinationIds: ['destination-b'],
    targets: [{
      id: 'target-b',
      destinationInstanceId: 'destination-b',
      targetConnectionId: 'destination-connection',
      targetModelId: 'target-model',
      targetFolderId: 'target-folder',
      targetFolderPath: 'Shared/Safe copies',
    }],
    documentIds: ['source-dashboard'],
    emptyFirst: false,
    replaceSameNamed: false,
    deleteSourceOnSuccess: false,
    postMigrationActions: [],
    status: 'succeeded',
    createdAt: NOW - 10_000,
    endedAt: NOW,
    details: {
      operationMode: 'safe_copy',
      safeCopyProfile: 'safe_copy_v1',
      safeCopyRequestId: '11111111-1111-4111-8111-111111111111',
      safeCopyIntentHash: 'a'.repeat(64),
    },
    items: [item(id)],
    ...patch,
  };
}

beforeEach(() => {
  closeJobStoreForTests();
  clearJobs();
});

after(() => {
  closeJobStoreForTests();
  rmSync(testRoot, { recursive: true, force: true });
  delete process.env.OMNIKIT_JOB_HISTORY_PATH;
  delete process.env.OMNIKIT_JOBS_PATH;
});

test('only exact successful document verification provenance is returned for audit', () => {
  const job = safeCopyJob('safe-copy-job');
  const pure = findLatestVerifiedDashboardSafeCopyProvenance([job], scope, { now: NOW });
  assert.deepEqual(pure, {
    jobId: 'safe-copy-job',
    itemId: 'safe-copy-job-verification',
    targetId: 'target-b',
    sourceInstanceId: 'source-a',
    sourceConnectionId: 'source-connection',
    sourceDocumentId: 'source-dashboard',
    sourceExportHash: 'source-export-fingerprint',
    destinationInstanceId: 'destination-b',
    targetConnectionId: 'destination-connection',
    targetModelId: 'target-model',
    targetFolderId: 'target-folder',
    targetFolderPath: 'Shared/Safe copies',
    importedDocumentId: 'imported-document',
    importedIdentifier: 'imported-identifier',
    chosenName: 'Example dashboard (Copy)',
    expectedPayloadHash: 'published-content-fingerprint',
    publishedFingerprint: 'published-content-fingerprint',
    resolverVersion: 2,
    verifierVersion: 3,
    verifiedAt: VERIFIED_AT,
    usage: 'audit_only',
    updateInPlaceAuthorized: false,
  });

  insertJob(job);
  closeJobStoreForTests();
  assert.deepEqual(
    findLatestVerifiedDashboardSafeCopyProvenanceInStore(scope, { now: NOW }),
    pure,
  );
});

test('wrong source, destination, connection, model, folder, or imported identity is ignored', () => {
  const job = safeCopyJob('safe-copy-job');
  const mismatches: DashboardSafeCopyProvenanceScope[] = [
    { ...scope, sourceInstanceId: 'source-other' },
    { ...scope, sourceConnectionId: 'connection-other' },
    { ...scope, sourceDocumentId: 'dashboard-other' },
    { ...scope, destinationInstanceId: 'destination-other' },
    { ...scope, targetConnectionId: 'destination-connection-other' },
    { ...scope, targetModelId: 'model-other' },
    { ...scope, targetFolderId: 'folder-other' },
    { ...scope, targetFolderPath: 'Shared/Other' },
  ];
  for (const mismatch of mismatches) {
    assert.equal(
      findLatestVerifiedDashboardSafeCopyProvenance([job], mismatch, { now: NOW }),
      undefined,
    );
  }

  const inconsistentTarget = safeCopyJob('inconsistent-target', {
    targets: [{
      ...job.targets![0],
      targetConnectionId: 'different-target-connection',
    }],
  });
  const inconsistentItem = safeCopyJob('inconsistent-item', {
    items: [item('inconsistent-item', { importedDocumentId: 'different-document' })],
  });
  const inconsistentEvidence = safeCopyJob('inconsistent-evidence', {
    items: [item('inconsistent-evidence', {}, { importedIdentifier: 'different-identifier' })],
  });
  const paddedFolder = safeCopyJob('padded-folder', {
    targets: [{
      ...job.targets![0],
      targetFolderPath: ' Shared/Safe copies',
    }],
    items: [item('padded-folder', {
      targetFolderPath: ' Shared/Safe copies',
    }, {
      folderPath: ' Shared/Safe copies',
    })],
  });
  const inconsistentJobScope = safeCopyJob('inconsistent-job-scope', {
    documentIds: ['different-dashboard'],
  });
  for (const candidate of [
    inconsistentTarget,
    inconsistentItem,
    inconsistentEvidence,
    paddedFolder,
    inconsistentJobScope,
  ]) {
    assert.equal(
      findLatestVerifiedDashboardSafeCopyProvenance([candidate], scope, { now: NOW }),
      undefined,
    );
  }
});

test('import/update items, warnings, failures, legacy jobs, and destructive job flags never qualify', () => {
  const rejected = [
    safeCopyJob('import-succeeded', {
      items: [item('import-succeeded', { kind: 'import' })],
    }),
    safeCopyJob('import-warning', {
      items: [item('import-warning', { kind: 'import', status: 'warning' })],
    }),
    safeCopyJob('update-warning', {
      items: [item('update-warning', { kind: 'update', status: 'warning' })],
    }),
    safeCopyJob('verify-warning', {
      items: [item('verify-warning', { status: 'warning' })],
    }),
    safeCopyJob('verify-failed', {
      items: [item('verify-failed', { status: 'failed' })],
    }),
    safeCopyJob('verify-succeeded-with-warning', {
      items: [item('verify-succeeded-with-warning', { warnings: ['Not authoritative.'] })],
    }),
    safeCopyJob('verify-succeeded-with-error', {
      items: [item('verify-succeeded-with-error', { error: 'Verification was inconsistent.' })],
    }),
    safeCopyJob('missing-provenance', {
      items: [item('missing-provenance', { details: {} })],
    }),
    safeCopyJob('legacy', { details: undefined }),
    safeCopyJob('replace-enabled', { replaceSameNamed: true }),
    safeCopyJob('cleanup-enabled', { deleteSourceOnSuccess: true }),
    safeCopyJob('post-action-enabled', {
      postMigrationActions: [{
        kind: 'refresh-schema',
        name: 'Refresh destination schema',
        method: 'POST',
        url: 'https://destination.example.test/api/refresh',
        headers: {},
        body: '',
      }],
    }),
  ];

  assert.equal(
    findLatestVerifiedDashboardSafeCopyProvenance(rejected, scope, { now: NOW }),
    undefined,
  );
});

test('fingerprint, final-verification, create-only, version, and exact-schema evidence is fail closed', () => {
  const extraKeyEvidence = provenance('extra-key') as DashboardSafeCopyDocumentVerificationProvenance & {
    rawPayload?: string;
  };
  extraKeyEvidence.rawPayload = 'must-not-be-accepted';
  const rejected = [
    safeCopyJob('fingerprint-mismatch', {
      items: [item('fingerprint-mismatch', {}, { publishedFingerprint: 'different' })],
    }),
    safeCopyJob('fingerprint-padding', {
      items: [item('fingerprint-padding', {}, {
        expectedPayloadHash: 'published-content-fingerprint ',
      })],
    }),
    safeCopyJob('verification-not-passed', {
      items: [item('verification-not-passed', {}, {
        finalVerification: 'failed' as 'passed',
      })],
    }),
    safeCopyJob('update-mode', {
      items: [item('update-mode', {}, {
        documentWriteMode: 'updated' as 'created',
      })],
    }),
    safeCopyJob('update-flag', {
      items: [item('update-flag', {
        details: {
          safeCopyDocumentProvenance: provenance('update-flag'),
          updateInPlace: true,
        },
      })],
    }),
    safeCopyJob('invalid-version', {
      items: [item('invalid-version', {}, { verifierVersion: 0 })],
    }),
    safeCopyJob('missing-imported-id', {
      items: [item('missing-imported-id', {
        importedDocumentId: undefined,
      }, {
        importedDocumentId: '' as string,
      })],
    }),
    safeCopyJob('extra-key', {
      items: [item('extra-key', {
        details: { safeCopyDocumentProvenance: extraKeyEvidence },
      })],
    }),
  ];

  assert.equal(
    findLatestVerifiedDashboardSafeCopyProvenance(rejected, scope, { now: NOW }),
    undefined,
  );
});

test('verification timestamps must be exact, finite, bounded, and equal to item completion', () => {
  const beforeBound = Date.UTC(1999, 11, 31, 23, 59, 59);
  const future = NOW + (6 * 60 * 1_000);
  const rejected = [
    safeCopyJob('too-old', {
      items: [item('too-old', { endedAt: beforeBound }, { verifiedAt: beforeBound })],
    }),
    safeCopyJob('future', {
      items: [item('future', { endedAt: future }, { verifiedAt: future })],
    }),
    safeCopyJob('timestamp-mismatch', {
      items: [item('timestamp-mismatch', { endedAt: VERIFIED_AT + 1 })],
    }),
    safeCopyJob('non-finite', {
      items: [item('non-finite', { endedAt: Number.NaN }, { verifiedAt: Number.NaN })],
    }),
  ];

  assert.equal(
    findLatestVerifiedDashboardSafeCopyProvenance(rejected, scope, { now: NOW }),
    undefined,
  );
});

test('latest exact succeeded document verification wins deterministically', () => {
  const olderAt = VERIFIED_AT - 1_000;
  const older = safeCopyJob('older-job', {
    items: [item('older-job', {
      endedAt: olderAt,
      importedDocumentId: 'older-document',
      importedIdentifier: 'older-identifier',
    }, {
      importedDocumentId: 'older-document',
      importedIdentifier: 'older-identifier',
      verifiedAt: olderAt,
    })],
  });
  const latest = safeCopyJob('latest-job');
  const ignoredWarning = safeCopyJob('warning-job', {
    items: [item('warning-job', { status: 'warning', endedAt: VERIFIED_AT + 500 }, {
      verifiedAt: VERIFIED_AT + 500,
    })],
  });

  const match = findLatestVerifiedDashboardSafeCopyProvenance(
    [latest, ignoredWarning, older],
    scope,
    { now: NOW },
  );
  assert.equal(match?.jobId, 'latest-job');
  assert.equal(match?.importedDocumentId, 'imported-document');
  assert.equal(match?.verifiedAt, VERIFIED_AT);
  assert.equal(match?.updateInPlaceAuthorized, false);
});

test('copy-name allocation remains bounded, deterministic, and case-insensitive', () => {
  assert.equal(allocateDashboardSafeCopyName('Example', []), 'Example (Copy)');
  assert.equal(
    allocateDashboardSafeCopyName('Example', ['example (copy)', 'EXAMPLE (COPY 2)']),
    'Example (Copy 3)',
  );
  assert.equal(
    allocateDashboardSafeCopyName('Example', ['Example (Copy)', 'Example (Copy 3)']),
    'Example (Copy 2)',
  );
  const bounded = allocateDashboardSafeCopyName('X'.repeat(400), []);
  assert.equal(bounded.length, 256);
  assert.match(bounded, / \(Copy\)$/);
});

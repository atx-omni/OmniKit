import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { DashboardSafeCopyAttemptEvidence } from '../server/services/dashboardSafeCopyExecutor';
import { dashboardSafeCopyIntentHash } from '../server/services/dashboardSafeCopyJobs';
import {
  createDashboardSafeCopyRuntimeAdapterForTests,
  type DashboardSafeCopyRuntimeServices,
} from '../server/services/dashboardSafeCopyRuntime';
import {
  clearJobs,
  closeJobStoreForTests,
  getJob,
  insertJob,
} from '../server/services/jobStore';
import { sanitizeJobHistory } from '../server/services/jobSanitizer';
import type { MigrationJob } from '../server/services/migrationJobs';
import type { SavedInstance } from '../server/services/nativeVault';
import {
  DASHBOARD_SAFE_COPY_PROFILE,
  type DashboardSafeCopyIntent,
} from '../shared/dashboardSafeCopyContract';

const PHONE_LIKE_SOURCE_HASH = 'aaaaaaaaaa2125550199bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const PHONE_LIKE_PAYLOAD_HASH = 'cccccccccc3125550123dddddddddddddddddddddddddddddddddddddddddddd';
const PHONE_LIKE_INTENT_HASH = 'eeeeeeeeee4155550134ffffffffffffffffffffffffffffffffffffffffffff';
const PHONE_LIKE_DECISION_FINGERPRINT = '1111111111512555014522222222222222222222222222222222222222222222';
const PHONE_LIKE_PLAN_FINGERPRINT = '3333333333612555015644444444444444444444444444444444444444444444';
const PHONE_LIKE_PREVIOUS_CHECKSUM = '5555555555712555016766666666666666666666666666666666666666666666';
const PHONE_LIKE_YAML_HASH = '7777777771812555018988888888888888888888888888888888888888888888';
const PHONE_LIKE_PUBLISHED_FINGERPRINT = PHONE_LIKE_PAYLOAD_HASH;
const PHONE_LIKE_ATTEMPT_FINGERPRINT = '766279ac7285b97dd9783236001b6c9077f1b85ae33888fa747b1b921887f65e';
const FIXED_NOW = 1_750_000_000_000;

for (const value of [
  PHONE_LIKE_SOURCE_HASH,
  PHONE_LIKE_PAYLOAD_HASH,
  PHONE_LIKE_INTENT_HASH,
  PHONE_LIKE_DECISION_FINGERPRINT,
  PHONE_LIKE_PLAN_FINGERPRINT,
  PHONE_LIKE_PREVIOUS_CHECKSUM,
  PHONE_LIKE_YAML_HASH,
  PHONE_LIKE_ATTEMPT_FINGERPRINT,
]) {
  assert.match(value, /^[a-f0-9]{64}$/);
}

function sanitizerFixture(): MigrationJob {
  return {
    id: 'safe-copy-sanitizer-job',
    workflow: 'dashboard',
    sourceId: 'source-instance',
    sourceLabel: 'Source owner owner@example.test',
    sourceConnectionId: 'source-connection',
    destinationIds: ['destination-instance'],
    targets: [{
      id: 'target-b',
      destinationInstanceId: 'destination-instance',
      destinationLabel: 'Destination owner destination@example.test',
      targetConnectionId: 'destination-connection',
      targetModelId: 'destination-model',
      targetFolderId: 'folder-b',
      targetFolderPath: 'Customers/646-555-0101',
    }],
    documentIds: ['source-document'],
    emptyFirst: false,
    replaceSameNamed: false,
    deleteSourceOnSuccess: false,
    postMigrationActions: [],
    status: 'pending',
    createdAt: FIXED_NOW,
    details: {
      safeCopyProfile: DASHBOARD_SAFE_COPY_PROFILE,
      operationMode: 'safe_copy',
      safeCopyIntentHash: PHONE_LIKE_INTENT_HASH,
      safeCopyPreparationError: 'Bearer omni_historysecret for owner@example.test at 646-555-0101',
    },
    items: [{
      id: 'safe-copy-attempt:attempt-b',
      jobId: 'safe-copy-sanitizer-job',
      targetId: 'target-b',
      destinationId: 'destination-instance',
      destinationLabel: 'Destination owner destination@example.test',
      targetModelId: 'destination-model',
      targetFolderId: 'folder-b',
      targetFolderPath: 'Customers/646-555-0101',
      kind: 'import',
      documentId: 'source-document',
      documentName: 'Revenue 646-555-0101 owner@example.test',
      status: 'warning',
      error: 'token omni_attemptsecret belongs to owner@example.test',
      details: {
        safeCopyAttempt: true,
        safeCopyAttemptFingerprint: PHONE_LIKE_ATTEMPT_FINGERPRINT,
        safeCopyDecisionFingerprint: PHONE_LIKE_DECISION_FINGERPRINT,
        safeCopyPlanFingerprint: PHONE_LIKE_PLAN_FINGERPRINT,
        safeCopySourceExportHash: PHONE_LIKE_SOURCE_HASH,
        safeCopyExpectedPayloadHash: PHONE_LIKE_PAYLOAD_HASH,
        safeCopyPreviousChecksum: PHONE_LIKE_PREVIOUS_CHECKSUM,
        safeCopyExpectedYamlHash: PHONE_LIKE_YAML_HASH,
        safeCopyPublishedFingerprint: PHONE_LIKE_PUBLISHED_FINGERPRINT,
        safeCopyChosenName: 'Revenue 646-555-0101 owner@example.test',
        safeCopyFolderPath: 'Customers/646-555-0101',
        apiKey: 'omni_nestedsecret',
        safeCopyDocumentProvenance: {
          sourceExportHash: PHONE_LIKE_SOURCE_HASH,
          expectedPayloadHash: PHONE_LIKE_PAYLOAD_HASH,
          publishedFingerprint: PHONE_LIKE_PUBLISHED_FINGERPRINT,
          chosenName: 'Revenue 646-555-0101 owner@example.test',
          folderPath: 'Customers/646-555-0101',
          authorization: 'Bearer omni_provenancesecret',
        },
      },
    }],
  };
}

test('safe-copy sanitizer preserves exact integrity evidence while redacting names, labels, prose, and secrets', () => {
  const sanitized = sanitizeJobHistory([sanitizerFixture()])[0];
  const details = sanitized.details!;
  const item = sanitized.items[0];
  const itemDetails = item.details!;
  const provenance = itemDetails.safeCopyDocumentProvenance as Record<string, unknown>;

  assert.equal(details.safeCopyIntentHash, PHONE_LIKE_INTENT_HASH);
  assert.equal(itemDetails.safeCopyAttemptFingerprint, PHONE_LIKE_ATTEMPT_FINGERPRINT);
  assert.equal(itemDetails.safeCopyDecisionFingerprint, PHONE_LIKE_DECISION_FINGERPRINT);
  assert.equal(itemDetails.safeCopyPlanFingerprint, PHONE_LIKE_PLAN_FINGERPRINT);
  assert.equal(itemDetails.safeCopySourceExportHash, PHONE_LIKE_SOURCE_HASH);
  assert.equal(itemDetails.safeCopyExpectedPayloadHash, PHONE_LIKE_PAYLOAD_HASH);
  assert.equal(itemDetails.safeCopyPreviousChecksum, PHONE_LIKE_PREVIOUS_CHECKSUM);
  assert.equal(itemDetails.safeCopyExpectedYamlHash, PHONE_LIKE_YAML_HASH);
  assert.equal(itemDetails.safeCopyPublishedFingerprint, PHONE_LIKE_PUBLISHED_FINGERPRINT);
  assert.equal(provenance.sourceExportHash, PHONE_LIKE_SOURCE_HASH);
  assert.equal(provenance.expectedPayloadHash, PHONE_LIKE_PAYLOAD_HASH);
  assert.equal(provenance.publishedFingerprint, PHONE_LIKE_PUBLISHED_FINGERPRINT);

  assert.equal(sanitized.sourceLabel, 'Source owner [redacted-email]');
  assert.equal(sanitized.targets?.[0].destinationLabel, 'Destination owner [redacted-email]');
  assert.equal(sanitized.targets?.[0].targetFolderPath, 'Customers/[redacted-phone]');
  assert.equal(item.documentName, 'Revenue [redacted-phone] [redacted-email]');
  assert.equal(item.targetFolderPath, 'Customers/[redacted-phone]');
  assert.equal(itemDetails.safeCopyChosenName, 'Revenue [redacted-phone] [redacted-email]');
  assert.equal(itemDetails.safeCopyFolderPath, 'Customers/[redacted-phone]');
  assert.equal(provenance.chosenName, 'Revenue [redacted-phone] [redacted-email]');
  assert.equal(provenance.folderPath, 'Customers/[redacted-phone]');

  const serialized = JSON.stringify(sanitized);
  assert.doesNotMatch(serialized, /owner@example\.test|destination@example\.test|646-555-0101/);
  assert.doesNotMatch(serialized, /omni_(?:history|attempt|nested|provenance)secret/);
  assert.match(serialized, /\[redacted(?:-email|-phone)?\]/);
});

test('safe-copy integrity key names do not bypass redaction for non-cryptographic secret values', () => {
  const fixture = sanitizerFixture();
  fixture.details!.safeCopyIntentHash = 'omni_live_intentsecret_123456';
  const details = fixture.items[0].details!;
  details.safeCopyAttemptFingerprint = 'Bearer attempt-secret-value';
  details.safeCopyExpectedPayloadHash = 'owner@example.test';
  details.safeCopyPreviousChecksum = 'api_key=checksum-secret-value';
  const provenance = details.safeCopyDocumentProvenance as Record<string, unknown>;
  provenance.sourceExportHash = '646-555-0101';
  provenance.publishedFingerprint = 'omni_live_provenancesecret_123456';

  const serialized = JSON.stringify(sanitizeJobHistory([fixture]));
  assert.doesNotMatch(serialized, /omni_live_(?:intent|provenance)secret/);
  assert.doesNotMatch(serialized, /attempt-secret-value|checksum-secret-value/);
  assert.doesNotMatch(serialized, /owner@example\.test|646-555-0101/);
  assert.match(serialized, /\[redacted(?:-email|-phone)?\]/);
});

function restartIntent(): DashboardSafeCopyIntent {
  return {
    profile: DASHBOARD_SAFE_COPY_PROFILE,
    requestId: '11111111-1111-4111-8111-111111111111',
    source: {
      instanceId: 'source-instance',
      connectionId: 'source-connection',
      documentIds: ['dashboard-a'],
    },
    destinations: [{
      targetId: 'target-b',
      instanceId: 'destination-b',
      connectionId: 'connection-b',
      modelId: 'model-b',
    }],
  };
}

function restartJob(intent: DashboardSafeCopyIntent): MigrationJob {
  return {
    id: 'safe-copy-phone-hash-job',
    workflow: 'dashboard',
    sourceId: intent.source.instanceId,
    sourceLabel: 'Source',
    sourceConnectionId: intent.source.connectionId,
    destinationIds: ['destination-b'],
    targets: [{
      id: 'target-b',
      destinationInstanceId: 'destination-b',
      destinationLabel: 'Destination B',
      targetConnectionId: 'connection-b',
      targetModelId: 'model-b',
    }],
    documentIds: [...intent.source.documentIds],
    emptyFirst: false,
    replaceSameNamed: false,
    deleteSourceOnSuccess: false,
    postMigrationActions: [],
    status: 'pending',
    createdAt: FIXED_NOW,
    details: {
      operationMode: 'safe_copy',
      safeCopyProfile: DASHBOARD_SAFE_COPY_PROFILE,
      safeCopyRequestId: intent.requestId,
      safeCopyIntentHash: dashboardSafeCopyIntentHash(intent),
      safeCopyPreparationState: 'prepared',
    },
    items: [{
      id: 'safe-copy-preparation:target-b',
      jobId: 'safe-copy-phone-hash-job',
      targetId: 'target-b',
      destinationId: 'destination-b',
      destinationLabel: 'Destination B',
      targetModelId: 'model-b',
      kind: 'semantic_validate',
      status: 'succeeded',
      startedAt: FIXED_NOW,
      endedAt: FIXED_NOW,
      details: {
        safeCopyPreparationSummary: true,
        safeCopyTargetStatus: 'ready',
        safeCopyDecisionFingerprint: PHONE_LIKE_DECISION_FINGERPRINT,
        safeCopyPlanFingerprint: PHONE_LIKE_PLAN_FINGERPRINT,
        safeCopyPatchCount: 0,
      },
    }],
  };
}

function savedInstance(id: string): SavedInstance {
  return {
    id,
    label: id,
    role: 'both',
    baseUrl: `https://${id}.example.omniapp.co`,
    apiKey: `${id}-fictional-key`,
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z',
  };
}

function runtimeServices(): DashboardSafeCopyRuntimeServices {
  return {
    getInstance: (id) => savedInstance(id),
    createClient: () => ({
      async listFolderInventory() {
        return {
          folders: [],
          pagination: { complete: true, pages: 1, pageSize: 100, returnedRecords: 0 },
        };
      },
      async listDocumentInventory() {
        return {
          documents: [],
          pagination: { complete: true, pages: 1, pageSize: 100, returnedRecords: 0 },
        };
      },
      async getDocumentStateV2() { return {}; },
      async getDocumentQueries() { return []; },
      async runQuery() { return { status: 'COMPLETE' }; },
      async getModelYaml() { return { files: {}, checksums: {}, raw: {} }; },
      async updateModelYamlFile() { return {}; },
      async listDocumentAccessInventory() {
        return {
          principals: [],
          pagination: { complete: true, pages: 1, pageSize: 100, returnedRecords: 0 },
        };
      },
      async createDashboardSafeCopyDocument() {
        return { id: 'unused', identifier: 'unused', raw: {} };
      },
    }),
    now: () => FIXED_NOW + 10,
  };
}

test('restart parsing accepts an exact attempt SHA-256 that contains phone-like digits', async () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'omnikit-safe-copy-sanitizer-'));
  const previousHistoryPath = process.env.OMNIKIT_JOB_HISTORY_PATH;
  const previousLegacyPath = process.env.OMNIKIT_JOBS_PATH;
  process.env.OMNIKIT_JOB_HISTORY_PATH = join(temporaryRoot, 'jobs.json');
  process.env.OMNIKIT_JOBS_PATH = join(temporaryRoot, 'legacy-jobs.json');
  closeJobStoreForTests();
  clearJobs();
  try {
    const intent = restartIntent();
    const job = restartJob(intent);
    insertJob(job);
    const services = runtimeServices();
    const adapter = await createDashboardSafeCopyRuntimeAdapterForTests(job.id, services);
    const attempt: DashboardSafeCopyAttemptEvidence = {
      attemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      jobId: job.id,
      targetId: 'target-b',
      operation: 'document_create',
      state: 'dispatched',
      destinationInstanceId: 'destination-b',
      connectionId: 'connection-b',
      modelId: 'model-b',
      sourceDocumentId: 'dashboard-a',
      chosenName: 'Safe copy 28',
      sourceExportHash: PHONE_LIKE_SOURCE_HASH,
      expectedPayloadHash: PHONE_LIKE_PAYLOAD_HASH,
      preexistingDocumentIds: [],
      createdAt: FIXED_NOW + 1,
      updatedAt: FIXED_NOW + 1,
    };

    await adapter.dependencies.persistAttempt(attempt);
    const storedFingerprint = getJob(job.id)?.items
      .find((item) => item.details?.safeCopyAttempt === true)
      ?.details?.safeCopyAttemptFingerprint;
    assert.equal(storedFingerprint, PHONE_LIKE_ATTEMPT_FINGERPRINT);
    assert.match(PHONE_LIKE_ATTEMPT_FINGERPRINT, /(?<!\d)\d{10}(?!\d)/);

    closeJobStoreForTests();
    const recoveredAdapter = await createDashboardSafeCopyRuntimeAdapterForTests(job.id, services);
    const state = await recoveredAdapter.dependencies.loadTargetState(job.id, 'target-b');
    assert.equal(state.attempts.length, 1);
    assert.equal(state.attempts[0].state, 'uncertain');
    assert.equal(state.attempts[0].sourceExportHash, PHONE_LIKE_SOURCE_HASH);
    assert.equal(state.attempts[0].expectedPayloadHash, PHONE_LIKE_PAYLOAD_HASH);
  } finally {
    closeJobStoreForTests();
    rmSync(temporaryRoot, { recursive: true, force: true });
    if (previousHistoryPath === undefined) delete process.env.OMNIKIT_JOB_HISTORY_PATH;
    else process.env.OMNIKIT_JOB_HISTORY_PATH = previousHistoryPath;
    if (previousLegacyPath === undefined) delete process.env.OMNIKIT_JOBS_PATH;
    else process.env.OMNIKIT_JOBS_PATH = previousLegacyPath;
  }
});

import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import {
  listSemanticMigrationAuditEvents,
  recordSemanticMigrationAuditEvent,
  recordSemanticMigrationLifecycleEvent,
  type SemanticMigrationLifecycleMetadata,
  type SemanticMigrationLifecycleState,
} from '../server/services/semanticMigrationAudit';
import {
  getLlmProvider,
  markLlmProviderValidated,
  normalizeVaultPayload,
  resetVault,
  unlockVault,
  upsertLlmProvider,
} from '../server/services/nativeVault';

let temporaryRoot = '';
let auditPath = '';

beforeEach(() => {
  temporaryRoot = mkdtempSync(join(tmpdir(), 'omnikit-semantic-audit-'));
  auditPath = join(temporaryRoot, 'semantic-migration-audit.json');
  process.env.OMNIKIT_SEMANTIC_MIGRATION_AUDIT_PATH = auditPath;
  process.env.OMNIKIT_VAULT_PATH = join(temporaryRoot, 'vault.enc');
  resetVault();
});

afterEach(() => {
  resetVault();
  delete process.env.OMNIKIT_SEMANTIC_MIGRATION_AUDIT_PATH;
  delete process.env.OMNIKIT_VAULT_PATH;
  rmSync(temporaryRoot, { recursive: true, force: true });
});

test('audit replacement is atomic, private, and preserves known legacy event fields', () => {
  writeFileSync(auditPath, JSON.stringify([{
    id: 'semantic_audit_legacy',
    type: 'provider_saved',
    timestamp: '2026-08-06T12:00:00.000Z',
    resourceId: 'provider-legacy',
    providerKind: 'openai',
    projectId: 'project-legacy',
    outcome: 'completed',
    telemetry: { durationMs: 12, engineVersion: 'legacy-v1' },
    prompt: 'forbidden-prompt-marker',
    rawError: 'forbidden-raw-error-marker',
    credential: 'forbidden-credential-marker',
  }]), { mode: 0o644 });

  recordSemanticMigrationAuditEvent({
    type: 'source_tested',
    resourceId: 'source-1',
    sourcePlatform: 'looker',
    outcome: 'completed',
  });

  const durable = readFileSync(auditPath, 'utf8');
  const parsed = JSON.parse(durable) as Array<Record<string, unknown>>;
  assert.equal(parsed.length, 2);
  assert.equal(parsed[1].type, 'provider_saved');
  assert.equal(parsed[1].resourceId, 'provider-legacy');
  assert.equal(parsed[1].projectId, 'project-legacy');
  assert.deepEqual(parsed[1].telemetry, { engineVersion: 'legacy-v1', durationMs: 12 });
  assert.doesNotMatch(durable, /forbidden-(?:prompt|raw-error|credential)-marker/);
  assert.equal(statSync(auditPath).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(temporaryRoot), ['semantic-migration-audit.json']);
});

test('lifecycle events support the complete state allowlist and retain only approved metadata', () => {
  const states: SemanticMigrationLifecycleState[] = ['started', 'completed', 'failed', 'cancelled', 'retried', 'circuit'];
  const expectedTypes = new Set([
    'ai_job_started',
    'ai_job_completed',
    'ai_job_failed',
    'ai_job_cancelled',
    'ai_job_retried',
    'ai_provider_circuit',
  ]);
  const unsafeMetadata: SemanticMigrationLifecycleMetadata & Record<string, unknown> = {
    providerKind: 'openai',
    providerId: 'provider-1',
    projectId: 'project-1',
    stage: 'compile',
    jobId: 'semantic_job_1',
    requestId: 'request-1',
    modelVersion: 'model-v1.2.3',
    attemptCount: 2,
    durationMs: 345,
    statusCode: 502,
    errorCode: 'PROVIDER_TIMEOUT',
    prompt: 'forbidden-prompt-marker',
    output: 'forbidden-output-marker',
    rawError: 'forbidden-raw-error-marker',
    credential: 'forbidden-credential-marker',
  };

  for (const state of states) recordSemanticMigrationLifecycleEvent(state, unsafeMetadata);

  const events = listSemanticMigrationAuditEvents();
  assert.equal(events.length, states.length);
  assert.deepEqual(new Set(events.map((event) => event.type)), expectedTypes);
  for (const event of events) {
    assert.equal(event.projectId, 'project-1');
    assert.deepEqual(Object.keys(event.lifecycle || {}).sort(), [
      'attemptCount',
      'durationMs',
      'errorCode',
      'jobId',
      'modelVersion',
      'providerId',
      'providerKind',
      'requestId',
      'stage',
      'statusCode',
    ]);
  }
  assert.doesNotMatch(readFileSync(auditPath, 'utf8'), /forbidden-(?:prompt|output|raw-error|credential)-marker/);
});

test('canonical lifecycle job IDs survive phone-shaped UUID digit runs', () => {
  const jobId = 'semantic_job_c916ad4b-85b0-464e-b612-8b1029582012';
  recordSemanticMigrationLifecycleEvent('started', {
    providerKind: 'openai',
    providerId: 'provider-1',
    stage: 'analyze',
    jobId,
  });
  recordSemanticMigrationLifecycleEvent('completed', {
    providerKind: 'openai',
    providerId: 'provider-1',
    stage: 'analyze',
    jobId,
    attemptCount: 1,
  });

  const events = listSemanticMigrationAuditEvents();
  assert.equal(events.filter((event) => event.resourceId === jobId).length, 2);
  assert.ok(events.every((event) => event.lifecycle?.jobId === jobId));
  assert.match(readFileSync(auditPath, 'utf8'), new RegExp(jobId));
});

test('canonical audit and vault UUID identifiers survive phone-shaped UUID digit runs', () => {
  const auditId = 'semantic_audit_c916ad4b-85b0-464e-b612-8b1029582012';
  const providerId = 'c916ad4b-85b0-464e-b612-8b1029582012';
  writeFileSync(auditPath, JSON.stringify([{
    id: auditId,
    type: 'provider_tested',
    timestamp: '2026-08-06T12:00:00.000Z',
    resourceId: providerId,
    providerKind: 'openai',
    outcome: 'completed',
  }]), { mode: 0o600 });

  const [event] = listSemanticMigrationAuditEvents();
  assert.equal(event?.id, auditId);
  assert.equal(event?.resourceId, providerId);

  const unsafe = recordSemanticMigrationAuditEvent({
    type: 'provider_tested',
    resourceId: '555-123-4567',
    providerKind: 'openai',
    outcome: 'rejected',
  });
  assert.equal(unsafe.resourceId, undefined);
});

test('provider-controlled lifecycle metadata cannot persist secret-shaped or oversized values', () => {
  const secretRequestId = 'sk-provider-controlled-secret-value';
  const oversizedModelVersion = `model-${'x'.repeat(400)}`;
  const oversizedErrorCode = `SK_${'X'.repeat(100)}`;
  recordSemanticMigrationLifecycleEvent('failed', {
    providerKind: 'custom_openai_compatible',
    providerId: 'provider-1',
    projectId: 'project-1',
    stage: 'repair',
    jobId: 'semantic_job_1',
    requestId: secretRequestId,
    modelVersion: oversizedModelVersion,
    errorCode: oversizedErrorCode,
    statusCode: 502,
    attemptCount: 3,
  });

  const [event] = listSemanticMigrationAuditEvents();
  assert.equal(event?.projectId, 'project-1');
  assert.equal(event?.lifecycle?.requestId, undefined);
  assert.equal(event?.lifecycle?.modelVersion, undefined);
  assert.equal(event?.lifecycle?.errorCode, undefined);
  assert.equal('projectId' in (event?.lifecycle || {}), false);
  const durable = readFileSync(auditPath, 'utf8');
  assert.doesNotMatch(durable, new RegExp(secretRequestId));
  assert.doesNotMatch(durable, new RegExp(oversizedModelVersion));
  assert.doesNotMatch(durable, new RegExp(oversizedErrorCode));
});

test('new lifecycle writes fail closed without a valid correlatable job identifier', () => {
  assert.throws(() => recordSemanticMigrationLifecycleEvent('started', {
    providerKind: 'openai',
    providerId: 'provider-1',
    stage: 'analyze',
    jobId: 'sk-secret-shaped-job-identifier',
  }), /require a valid job identifier/i);
  assert.equal(listSemanticMigrationAuditEvents().length, 0);
});

test('legacy lifecycle calls gain allowlisted metadata without losing legacy fields', () => {
  const event = recordSemanticMigrationAuditEvent({
    type: 'ai_job_started',
    resourceId: 'semantic_job_legacy',
    providerKind: 'openai',
    projectId: 'project-legacy',
    outcome: 'accepted',
  });

  assert.equal(event.resourceId, 'semantic_job_legacy');
  assert.equal(event.providerKind, 'openai');
  assert.equal(event.projectId, 'project-legacy');
  assert.deepEqual(event.lifecycle, {
    providerKind: 'openai',
    jobId: 'semantic_job_legacy',
  });
});

test('public provider endpoints stay bound to their documented API origins', () => {
  unlockVault('provider transition passphrase');
  const saved = upsertLlmProvider({
    name: 'OpenAI migration provider',
    kind: 'openai',
    model: 'gpt-5.1',
    baseUrl: 'https://API.OPENAI.COM.:443/v1/',
    credential: 'initial-provider-credential',
  });
  markLlmProviderValidated(saved.id, saved.updatedAt);

  const equivalentPatch = upsertLlmProvider({
    id: saved.id,
    baseUrl: 'https://api.openai.com/v1///',
  });
  assert.equal(equivalentPatch.baseUrl, 'https://api.openai.com/v1');
  assert.equal(equivalentPatch.lastValidationStatus, 'valid');
  assert.equal(getLlmProvider(saved.id)?.credential, 'initial-provider-credential');

  const implicitDefault = upsertLlmProvider({
    name: 'Implicit OpenAI provider',
    kind: 'openai',
    model: 'gpt-5.1',
    credential: 'implicit-provider-credential',
  });
  markLlmProviderValidated(implicitDefault.id, implicitDefault.updatedAt);
  const explicitDefault = upsertLlmProvider({
    id: implicitDefault.id,
    baseUrl: 'https://api.openai.com/v1/',
  });
  assert.equal(explicitDefault.lastValidationStatus, 'valid');
  assert.equal(getLlmProvider(implicitDefault.id)?.credential, 'implicit-provider-credential');

  const unsupportedEndpoints = [
    'https://api.openai.com/v1?routing=proxy',
    'https://api.openai.com/v1#fragment',
    'https://api.openai.com/v2',
    'http://api.openai.com/v1',
    'https://proxy.example/v1',
    'https://api.openai.com:8443/v1',
  ];
  for (const baseUrl of unsupportedEndpoints) {
    assert.throws(() => upsertLlmProvider({
      id: saved.id,
      baseUrl,
      credential: 'replacement-provider-credential',
    }), (error: unknown) => (
      error instanceof Error
      && (error as Error & { code?: string }).code === 'AI_PROVIDER_ENDPOINT_UNSUPPORTED'
    ));
  }
  assert.equal(getLlmProvider(saved.id)?.baseUrl, 'https://api.openai.com/v1');
  assert.equal(getLlmProvider(saved.id)?.credential, 'initial-provider-credential');
  assert.equal(getLlmProvider(saved.id)?.lastValidationStatus, 'valid');

  assert.throws(() => upsertLlmProvider({
    id: saved.id,
    kind: 'anthropic',
    model: 'claude-example',
    baseUrl: 'https://api.anthropic.com/v1',
  }), /requires a replacement credential/i);
  const changedKind = upsertLlmProvider({
    id: saved.id,
    kind: 'anthropic',
    model: 'claude-example',
    baseUrl: 'https://api.anthropic.com/v1',
    credential: 'anthropic-replacement-credential',
  });
  assert.equal(changedKind.kind, 'anthropic');
  assert.equal(changedKind.lastValidationStatus, undefined);
  assert.equal(getLlmProvider(saved.id)?.credential, 'anthropic-replacement-credential');
});

test('Databricks Genie requires expiring OAuth and Foundation Model profiles are retired', () => {
  unlockVault('provider expiry passphrase');
  assert.throws(() => upsertLlmProvider({
    name: 'Databricks OAuth provider',
    kind: 'databricks_genie',
    authMode: 'oauth_access_token',
    model: 'example-space',
    baseUrl: 'https://example.cloud.databricks.com',
    credential: 'oauth-access-token-value',
  }), /credential expiration is required/i);

  const oauth = upsertLlmProvider({
    name: 'Databricks OAuth provider',
    kind: 'databricks_genie',
    authMode: 'oauth_access_token',
    model: 'example-space',
    baseUrl: 'https://example.cloud.databricks.com',
    credential: 'oauth-access-token-value',
    credentialExpiresAt: '2099-12-31T00:00:00.000Z',
  });
  assert.equal(markLlmProviderValidated(oauth.id, oauth.updatedAt).lastValidationStatus, 'valid');

  assert.throws(() => upsertLlmProvider({
    name: 'Databricks PAT provider',
    kind: 'databricks_model_serving',
    authMode: 'personal_access_token',
    model: 'example-static-endpoint',
    baseUrl: 'https://example.cloud.databricks.com',
    credential: 'static-personal-access-token-value',
  }), (error: unknown) => (
    error instanceof Error
    && (error as Error & { code?: string }).code === 'AI_PROVIDER_RETIRED'
  ));

  const normalizedLegacy = normalizeVaultPayload({
    version: 1,
    instances: [],
    deckRecipes: [],
    llmProviders: [{
      id: 'legacy-oauth',
      name: 'Legacy OAuth provider',
      kind: 'databricks_genie',
      authMode: 'oauth_access_token',
      model: 'legacy-space',
      baseUrl: 'https://example.cloud.databricks.com',
      credential: 'legacy-oauth-token',
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      lastValidatedAt: '2026-01-02T00:00:00.000Z',
      lastValidationAttemptAt: '2026-01-02T00:00:00.000Z',
      lastValidationStatus: 'valid',
    }],
  });
  assert.equal(normalizedLegacy.llmProviders[0]?.lastValidatedAt, undefined);
  assert.equal(normalizedLegacy.llmProviders[0]?.lastValidationAttemptAt, undefined);
  assert.equal(normalizedLegacy.llmProviders[0]?.lastValidationStatus, undefined);
  assert.equal(normalizedLegacy.llmProviders[0]?.enabled, false);
});

test('legacy noncanonical public-provider endpoints hydrate as disabled unvalidated records', () => {
  const normalized = normalizeVaultPayload({
    version: 1,
    instances: [],
    deckRecipes: [],
    llmProviders: [
      {
        id: 'legacy-openai-proxy',
        name: 'Legacy OpenAI proxy',
        kind: 'openai',
        authMode: 'api_key',
        model: 'gpt-legacy',
        baseUrl: 'https://proxy.example/v1',
        credential: 'legacy-openai-key',
        enabled: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        lastValidatedAt: '2026-01-02T00:00:00.000Z',
        lastValidatedRevision: '2026-01-01T00:00:00.000Z',
        lastValidationStatus: 'valid',
      },
      {
        id: 'legacy-anthropic-path',
        name: 'Legacy Anthropic path',
        kind: 'anthropic',
        authMode: 'api_key',
        model: 'claude-legacy',
        baseUrl: 'https://api.anthropic.com/messages',
        credential: 'legacy-anthropic-key',
        enabled: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        lastValidatedAt: '2026-01-02T00:00:00.000Z',
        lastValidatedRevision: '2026-01-01T00:00:00.000Z',
        lastValidationStatus: 'valid',
      },
    ],
  });

  for (const provider of normalized.llmProviders) {
    assert.equal(provider.enabled, false);
    assert.equal(provider.lastValidatedAt, undefined);
    assert.equal(provider.lastValidatedRevision, undefined);
    assert.equal(provider.lastValidationStatus, undefined);
  }
});

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import JSZip from 'jszip';
import { parse } from 'yaml';

import migrationStudioHandler, { buildEngineManualParityBaseline, strictPromptFields } from '../server/handlers/migration-studio';
import {
  deleteLlmProvider,
  getLlmProvider,
  listLlmProviders,
  listMigrationProjects,
  listPlatformConnections,
  lockVault,
  markLlmProviderValidated,
  markLlmProviderValidationFailed,
  normalizeVaultPayload,
  resetVault,
  unlockVault,
  upsertInstance,
  upsertLlmProvider,
  upsertMigrationProject,
  upsertPlatformConnection,
} from '../server/services/nativeVault';
import {
  getSemanticMigrationJob,
  getSemanticMigrationJobResult,
  resetSemanticMigrationJobsForTests,
  startSemanticMigrationJob,
} from '../server/services/semanticMigrationJobs';
import { recordSemanticMigrationAuditEvent } from '../server/services/semanticMigrationAudit';
import { DOMO_MANUAL_SCHEMA_VERSION, parseDomoManualArtifacts } from '../server/services/semanticMigration/domoManualParser';
import { LOOKER_MANUAL_SCHEMA_VERSION, parseLookerManualArtifacts } from '../server/services/semanticMigration/lookerManualParser';
import { MICROSTRATEGY_MANUAL_SCHEMA_VERSION, parseMicroStrategyManualArtifacts } from '../server/services/semanticMigration/microStrategyManualParser';
import { POWER_BI_MANUAL_SCHEMA_VERSION, parsePowerBiManualArtifacts } from '../server/services/semanticMigration/powerBiManualParser';
import { buildSourceDashboardCatalog, migrationInventoryNextPageUrl, sourceConnectorDefinitions, sourceDashboardDependencyClosure, sourceInventoryToMigrationInventory, type SourceInventoryItem, type SourceInventoryResult } from '../server/services/migrationConnectors';
import { migrationCapabilityAcknowledgementRequired, migrationCapabilityCoverageRows } from '../src/services/semanticMigration/capabilityCoverage';
import { generateStructuredProposal, migrationProviderEndpoint, providerCapabilities, snowflakeAuthorizationTokenType } from '../server/services/migrationProviders';
import { MIGRATION_PROVIDER_GUIDANCE, PUBLIC_MIGRATION_PROVIDER_OPTIONS, migrationProviderAuthSetup, migrationProviderCredentialState } from '../src/services/semanticMigration/providerGuidance';
import { buildOmniMigrationCapabilityReport, omniMigrationCapabilityBlockers } from '../src/services/semanticMigration/targetCapabilities';
import { buildMigrationGovernanceChecklist, buildMigrationGovernanceValidationChecks, reconcileMigrationGovernanceResolutions } from '../src/services/semanticMigration/governance';
import { buildMigrationVisualValidationCheck, compareMigrationVisualEvidence, migrationVisualReviewDisclosure, normalizeMigrationVisualEvidenceDescriptor } from '../src/services/semanticMigration/visualEvidence';
import {
  artifactFromText,
  buildMigrationInventory,
  MAX_ENGINE_BINARY_ARTIFACT_BYTES,
  MAX_ENGINE_MANUAL_TOTAL_BYTES,
  MAX_ENGINE_TEXT_ARTIFACT_BYTES,
  migrationEngineArtifactTransport,
  validateMigrationEngineUploadFiles,
  webFocusManualEvidenceReview,
} from '../src/services/semanticMigration/adapters';
import { buildCanonicalBiModel, buildCanonicalSemanticModel, canonicalDependencyOrder, canonicalFieldEvidenceReferences, canonicalPromptScope, scopedSourceInventoryItems } from '../src/services/semanticMigration/canonical';
import { applyDecisionToCompatibleTargets, compileApprovedDecisionPackage, compileApprovedDecisions, migrationDecisionCanBeApproved, migrationDecisionResolutionIssue, normalizeMigrationDecisions, unresolvedDecisionCount } from '../src/services/semanticMigration/compiler';
import { mergeGeneratedSemanticFiles } from '../src/services/semanticMigration/package';
import { buildSemanticMigrationPackagePrompt, buildSemanticMigrationPlanPrompt, sanitizeSemanticMigrationProviderText, semanticMigrationAiEvidenceSummary, semanticMigrationPromptEnvelope, stringifySemanticMigrationPromptPayload } from '../src/services/semanticMigration/prompts';
import { SEMANTIC_MIGRATION_EVALUATION_FIXTURES, SEMANTIC_MIGRATION_PROMPT_VERSION } from '../src/services/semanticMigration/protocol';
import { buildMigrationReconciliationReport, migrationReconciliationReportToMarkdown } from '../src/services/semanticMigration/reconciliation';
import { buildDomoManualArtifactReview, domoManualUploadGate, migrationInventoryWithoutRawArtifactContent } from '../src/services/semanticMigration/manualUpload';
import { evaluateDomoGeneratedOutput, evaluateDomoRoundTrip, type DomoRoundTripManifest } from '../src/services/semanticMigration/domoRoundTrip';
import { evaluateLookerRoundTrip, type LookerRoundTripManifest } from '../src/services/semanticMigration/lookerRoundTrip';
import { evaluateMicroStrategyRoundTrip, type MicroStrategyRoundTripManifest } from '../src/services/semanticMigration/microStrategyRoundTrip';
import { evaluatePowerBiRoundTrip, type PowerBiRoundTripManifest } from '../src/services/semanticMigration/powerBiRoundTrip';
import { artifactsFromPowerBiProjectFiles, artifactsFromPowerBiZip, normalizePowerBiProjectPath, POWER_BI_PROJECT_LIMITS } from '../src/services/semanticMigration/powerBiProjectUpload';
import { mergePowerBiDecisionProposalChunks, mergeRequiredPowerBiDecisions, requiredPowerBiMigrationDecisions, selectMigrationDecisionProposal, unassignedPowerBiDecisionArtifacts } from '../src/services/semanticMigration/powerBiDecisions';
import {
  mergeMigrationDecisionProposalChunks,
  migrationDecisionIdentityDiagnostics,
  migrationDecisionSemanticKey,
  migrationDecisionSemanticKind,
} from '../src/services/semanticMigration/decisionIdentity';
import {
  createDashboardBuildQueue,
  dashboardBuildGate,
  dashboardBuildSummary,
  retryableDashboardBuildPlanIds,
  updateDashboardBuildItem,
} from '../src/services/semanticMigration/dashboardBuildQueue';
import { compileOmniMigrationDeliverables } from '../src/services/semanticMigration/deliverables';
import { bundleHasSensitiveKeys, createMigrationBundle, dashboardPlanScopeIssues, mergeDashboardBuildPlanChunks, migrationBundleFingerprint, normalizeDashboardBuildPlans, powerBiManualDashboardCatalog, powerBiSelectedReportEvidence, powerBiSelectedReportEvidenceChunks, rawDashboardBuildPlanContractIssues } from '../src/services/semanticMigration/bundle';
import { buildDashboardBuildValidationCheck, buildMigrationPreparationValidationChecks, buildMigrationValidationChecks, migrationValidationReady, semanticMigrationPreparationFingerprint, semanticMigrationWriteReadinessIssues } from '../src/services/semanticMigration/validation';
import { generateMigrationProposal, MigrationProposalPendingError, type SourceInventory as ClientSourceInventory } from '../src/services/semanticMigration/studioApi';
import { migrationSourceSessionKey } from '../src/services/semanticMigration/workflowState';
import {
  MigrationPlanContractError,
  migrationPlanRepairInstruction,
  migrationPlanningStatusFromJob,
} from '../src/services/semanticMigration/planningOutcome';
import { migrationExtractionStatus } from '../src/services/semanticMigration/extractionStatus';
import {
  migrationPlanningContextLabel,
  migrationPlanningDurationGuidance,
  migrationPlanningPhaseLabel,
} from '../src/services/semanticMigration/planningProgress';
import { deriveBiMigrationWorkflowProgress } from '../src/components/semanticStudio/biMigrationWorkflowModel';
import type { CanonicalSemanticModel, MigrationDashboardBuildPlan, MigrationInventory, MigrationSourceTool, PowerBiManualParseResult, SemanticMigrationFile } from '../src/services/semanticMigration/types';

let tempDir = '';

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'omnikit-semantic-studio-'));
  process.env.OMNIKIT_VAULT_PATH = path.join(tempDir, 'vault.enc');
  process.env.OMNIKIT_SEMANTIC_MIGRATION_JOB_PATH = path.join(tempDir, 'semantic-jobs.json');
  process.env.OMNIKIT_SEMANTIC_MIGRATION_AUDIT_PATH = path.join(tempDir, 'semantic-audit.json');
  resetSemanticMigrationJobsForTests();
  resetVault();
});

afterEach(() => {
  resetVault();
  resetSemanticMigrationJobsForTests();
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.OMNIKIT_VAULT_PATH;
  delete process.env.OMNIKIT_SEMANTIC_MIGRATION_JOB_PATH;
  delete process.env.OMNIKIT_SEMANTIC_MIGRATION_AUDIT_PATH;
  delete process.env.OMNIKIT_MIGRATION_MAX_PROMPT_CHARS;
});

function targetInstance() {
  return upsertInstance({
    label: 'Target Omni',
    role: 'destination',
    baseUrl: 'https://example.omniapp.co',
    apiKey: 'omni_test_secret_123456',
    metricFilter: { connectionDatabaseContains: [], connectionDatabaseExact: [], embedExternalIdContains: [], embedExternalIdExact: [] },
    postMigrationActions: [],
  });
}

function minimalPowerBiResult(input: {
  mappings: PowerBiManualParseResult['mappings'];
  projects: NonNullable<PowerBiManualParseResult['projects']>;
}): PowerBiManualParseResult {
  return {
    inventory: {
      sourceTool: 'power_bi', artifactCount: 0, artifacts: [], views: [], explores: [], relationships: [], dashboards: [], metrics: [], warnings: [], summary: '',
    },
    mappings: input.mappings,
    projects: input.projects,
    diagnostics: {
      schemaVersion: POWER_BI_MANUAL_SCHEMA_VERSION,
      parsedArtifactCount: 0,
      unsupportedArtifactCount: 0,
      workspaceCount: 0,
      semanticModelCount: 2,
      tableCount: 0,
      columnCount: 0,
      measureCount: input.mappings.filter((mapping) => mapping.sourceKind === 'measure').length,
      relationshipCount: 0,
      roleCount: 0,
      reportCount: input.projects.reduce((total, project) => total + project.reports.length, 0),
      pageCount: 0,
      visualCount: 0,
      mappingCount: input.mappings.length,
      warnings: [],
    },
  };
}

function corruptFirstZipCentralCrc(bytes: Uint8Array): Uint8Array {
  const copy = bytes.slice();
  const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
  for (let offset = 0; offset <= copy.byteLength - 20; offset += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) continue;
    const fileNameLength = view.getUint16(offset + 28, true);
    const name = new TextDecoder().decode(copy.subarray(offset + 46, offset + 46 + fileNameLength));
    if (name.endsWith('/')) continue;
    view.setUint32(offset + 16, (view.getUint32(offset + 16, true) + 1) >>> 0, true);
    return copy;
  }
  throw new Error('Test ZIP did not contain a central directory entry.');
}

test('legacy vault payloads normalize new migration collections without losing old data', () => {
  const normalized = normalizeVaultPayload({ version: 1, instances: [], deckRecipes: [] });
  assert.deepEqual(normalized.llmProviders, []);
  assert.deepEqual(normalized.platformConnections, []);
  assert.deepEqual(normalized.migrationProjects, []);
});

test('vault provider, platform, and project records persist without exposing credentials', () => {
  unlockVault('migration studio passphrase');
  const target = targetInstance();
  const provider = upsertLlmProvider({
    name: 'Approved OpenAI',
    kind: 'openai',
    model: 'gpt-5.1',
    baseUrl: 'https://api.openai.com/v1',
    credential: 'fixture-provider-secret-value',
  });
  const source = upsertPlatformConnection({
    name: 'Sigma production',
    platform: 'sigma',
    baseUrl: 'https://api.sigmacomputing.com',
    credential: 'sigma-secret-token',
  });
  upsertMigrationProject({
    name: 'Finance migration',
    sourcePlatform: 'sigma',
    sourceConnectionId: source.id,
    providerId: provider.id,
    targetPlatform: 'omni',
    targetInstanceId: target.id,
    stage: 'connect',
    promptSchemaVersion: SEMANTIC_MIGRATION_PROMPT_VERSION,
    canonicalSchemaVersion: '1.0',
  });

  assert.equal(JSON.stringify(listLlmProviders()).includes('fixture-provider-secret-value'), false);
  assert.equal(JSON.stringify(listPlatformConnections()).includes('sigma-secret-token'), false);
  assert.equal(listMigrationProjects().length, 1);
  assert.equal(readFileSync(process.env.OMNIKIT_VAULT_PATH!, 'utf8').includes('fixture-provider-secret-value'), false);

  lockVault();
  unlockVault('migration studio passphrase');
  assert.equal(listLlmProviders()[0]?.name, 'Approved OpenAI');
  assert.equal(listPlatformConnections()[0]?.name, 'Sigma production');
  assert.throws(() => deleteLlmProvider(provider.id), /referenced by a saved migration project/i);
});

test('every public AI authentication option saves the intended vault reference or bearer value', () => {
  unlockVault('provider authentication passphrase');
  const target = targetInstance();
  const cases = [
    { kind: 'openai', authMode: 'api_key' },
    { kind: 'anthropic', authMode: 'api_key' },
    { kind: 'snowflake_cortex', authMode: 'programmatic_access_token' },
    { kind: 'snowflake_cortex', authMode: 'oauth_access_token' },
    { kind: 'snowflake_cortex', authMode: 'key_pair_jwt' },
    { kind: 'databricks_genie', authMode: 'oauth_access_token' },
    { kind: 'databricks_genie', authMode: 'personal_access_token' },
  ] as const;

  for (const [index, item] of cases.entries()) {
    const secret = `fixture-provider-value-${index}`;
    const saved = upsertLlmProvider({
      name: `${item.kind} ${item.authMode}`,
      kind: item.kind,
      authMode: item.authMode,
      model: item.kind === 'databricks_genie' ? 'fixture-agent-id' : 'fixture-model',
      baseUrl: item.kind === 'snowflake_cortex'
        ? 'https://example.snowflakecomputing.com'
        : item.kind === 'databricks_genie'
          ? 'https://example.cloud.databricks.com'
          : undefined,
      credential: secret,
    });
    assert.equal(saved.authMode, item.authMode);
    assert.equal(saved.hasCredential, true);
    assert.equal(JSON.stringify(saved).includes(secret), false);
    assert.equal(getLlmProvider(saved.id)?.credential, secret);
    assert.equal(readFileSync(process.env.OMNIKIT_VAULT_PATH!, 'utf8').includes(secret), false);
  }

  const omni = upsertLlmProvider({
    name: 'Linked Omni AI',
    kind: 'omni_ai',
    authMode: 'linked_omni_instance',
    model: 'fixture-target-model',
    linkedInstanceId: target.id,
  });
  assert.equal(omni.authMode, 'linked_omni_instance');
  assert.equal(omni.hasCredential, false);
  assert.equal(omni.linkedInstanceId, target.id);
  assert.equal(getLlmProvider(omni.id)?.credential, '');
});

test('provider lifecycle metadata is backward compatible, sanitized, and records validation state', () => {
  const legacy = normalizeVaultPayload({
    version: 1,
    instances: [],
    deckRecipes: [],
    llmProviders: [{ id: 'legacy-openai', name: 'Legacy OpenAI', kind: 'openai', model: 'configured-model', credential: 'legacy-secret', enabled: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
  });
  assert.equal(legacy.llmProviders[0]?.authMode, 'api_key');

  unlockVault('provider lifecycle passphrase');
  const saved = upsertLlmProvider({
    name: 'Cortex validation',
    kind: 'snowflake_cortex',
    model: 'configured-cortex-model',
    baseUrl: 'https://example.snowflakecomputing.com',
    authMode: 'programmatic_access_token',
    credentialOwner: 'Data platform operations',
    credentialExpiresAt: '2026-12-31',
    rotationDueAt: '2026-11-30',
    credential: 'fixture-cortex-token-value',
  });
  assert.equal(saved.authMode, 'programmatic_access_token');
  assert.equal(saved.credentialOwner, 'Data platform operations');
  assert.equal(JSON.stringify(saved).includes('fixture-cortex-token-value'), false);

  const failed = markLlmProviderValidationFailed(saved.id);
  assert.equal(failed.lastValidationStatus, 'failed');
  assert.equal(migrationProviderCredentialState(failed).state, 'attention');
  const valid = markLlmProviderValidated(saved.id);
  assert.equal(valid.lastValidationStatus, 'valid');
  assert.ok(valid.lastValidatedAt);
  const changed = upsertLlmProvider({
    id: saved.id,
    name: saved.name,
    kind: saved.kind,
    model: 'new-cortex-model',
    baseUrl: saved.baseUrl,
    authMode: saved.authMode,
    credentialOwner: saved.credentialOwner,
  });
  assert.equal(changed.lastValidationStatus, undefined);
  assert.equal(changed.lastValidatedAt, undefined);
  assert.equal(JSON.stringify(listLlmProviders()).includes('fixture-cortex-token-value'), false);
});

test('migration studio APIs require the unlocked vault and reject unsafe base URLs', async () => {
  const locked = await migrationStudioHandler(new Request('http://localhost/api/migration-studio/providers'));
  assert.equal(locked.status, 423);

  unlockVault('migration studio passphrase');
  const unsafe = await migrationStudioHandler(new Request('http://localhost/api/migration-studio/providers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Unsafe', kind: 'openai', model: 'test', baseUrl: 'http://127.0.0.1:9999', credential: 'secret' }),
  }));
  assert.equal(unsafe.status, 400);
  assert.match(JSON.stringify(await unsafe.json()), /HTTPS|private|local/i);
});

test('semantic migration prompt envelope and server reject oversized complete requests without truncation', async () => {
  const envelope = semanticMigrationPromptEnvelope('system', 'prompt', 12);
  assert.deepEqual(envelope, { systemCharacters: 6, promptCharacters: 6, totalCharacters: 12, maxCharacters: 12, withinLimit: true });
  assert.equal(semanticMigrationPromptEnvelope('system', 'prompt!', 12).withinLimit, false);

  unlockVault('migration studio passphrase');
  const provider = upsertLlmProvider({ name: 'Strict OpenAI', kind: 'openai', model: 'gpt-5.1', baseUrl: 'https://api.openai.com/v1', credential: 'sk-secret' });
  process.env.OMNIKIT_MIGRATION_MAX_PROMPT_CHARS = '10000';
  const response = await migrationStudioHandler(new Request('http://localhost/api/migration-studio/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      providerId: provider.id,
      task: 'propose_mappings',
      system: 's'.repeat(5_000),
      prompt: 'p'.repeat(5_001),
      schemaName: 'oversized_test',
      schema: { type: 'object' },
    }),
  }));
  assert.equal(response.status, 413);
  const payload = await response.json() as { error?: string };
  assert.match(payload.error || '', /10,001.*10,000.*did not truncate/i);

  const directResponse = await migrationStudioHandler(new Request(`http://localhost/api/migration-studio/providers/${provider.id}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      task: 'propose_mappings', system: 's'.repeat(5_000), prompt: 'p'.repeat(5_001),
      schemaName: 'oversized_direct_test', schema: { type: 'object' },
    }),
  }));
  assert.equal(directResponse.status, 413);
  assert.match(JSON.stringify(await directResponse.json()), /did not truncate/i);
});

test('provider-boundary sanitization preserves contract IDs and strips identities and secrets', () => {
  const dashboardId = '11111111-2222-4333-8444-555555555555';
  const principalId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const sanitized = sanitizeSemanticMigrationProviderText(JSON.stringify({
    sourceDashboardId: dashboardId,
    principalId,
    email: 'analyst@example.com',
    apiKey: 'sk-provider-secret',
  }));

  assert.match(sanitized, new RegExp(dashboardId));
  assert.doesNotMatch(sanitized, new RegExp(principalId));
  assert.doesNotMatch(sanitized, /analyst@example\.com|sk-provider-secret/);
  assert.match(sanitized, /redacted identity|redacted email|redacted/i);

  const structured = sanitizeSemanticMigrationProviderText(JSON.stringify({
    users: [{ displayName: 'Austin Aranda', userId: 12345, objectId: ['principal-a', 'principal-b'] }],
    visual: { displayName: 'Sales by Hour' },
    sourceDashboardId: 'dash-1',
  }));
  assert.doesNotMatch(structured, /Austin Aranda|12345|principal-a|principal-b/);
  assert.match(structured, /Sales by Hour/);
  assert.match(structured, /dash-1/);
});

test('server egress prompt gate sanitizes provider text before size enforcement', () => {
  const sanitized = strictPromptFields({
    system: 'Contact analyst@example.com token=unsafe-token',
    prompt: '{"sourceDashboardId":"11111111-2222-4333-8444-555555555555","principalId":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"}',
  });
  const combined = `${sanitized.system}\n${sanitized.prompt}`;

  assert.match(combined, /11111111-2222-4333-8444-555555555555/);
  assert.doesNotMatch(combined, /analyst@example\.com|unsafe-token|aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/);
});

test('canonical inventory preserves source evidence and dependency order', () => {
  const inventory: MigrationInventory = {
    sourceTool: 'sigma',
    artifactCount: 1,
    artifacts: [],
    views: [{
      name: 'orders',
      sourceArtifact: 'workbook.json',
      fields: [{ name: 'order_id', type: 'number', sourceArtifact: 'workbook.json' }],
      measures: [{ name: 'revenue', sql: 'SUM(amount)', sourceArtifact: 'workbook.json' }],
      warnings: [],
    }],
    explores: [{ name: 'sales', baseView: 'orders', joins: [], fields: [], filters: [], sourceArtifact: 'workbook.json' }],
    relationships: [],
    dashboards: [{ name: 'Executive Sales', fields: ['orders.revenue'], filters: [], sourceArtifact: 'workbook.json' }],
    metrics: [],
    warnings: [],
    summary: 'fixture',
  };
  const canonical = buildCanonicalSemanticModel(inventory);
  assert.equal(canonical.schemaVersion, '1.0');
  assert.ok(canonical.nodes.some((node) => node.kind === 'measure' && node.evidence[0]?.artifactId === 'workbook.json'));
  const order = canonicalDependencyOrder(canonical);
  assert.ok(order.indexOf('view:orders') < order.indexOf('topic:sales'));
});

test('typed decisions require approval and compile only reviewed write intent', () => {
  const decisions = normalizeMigrationDecisions([
    { id: 'map', nodeId: 'field:old', action: 'map_existing', targetId: 'orders.new', rationale: 'renamed', confidence: 0.9 },
    { id: 'create', nodeId: 'measure:margin', action: 'create_new', targetFileName: 'orders.view', proposedCode: 'measures:\n  margin: {}', rationale: 'missing', confidence: 0.8 },
    { id: 'ignore', nodeId: 'field:legacy', action: 'exclude', rationale: 'unused', confidence: 0.7 },
  ]);
  assert.equal(unresolvedDecisionCount(decisions), 3);
  decisions.forEach((decision) => { decision.approvedByUser = true; });
  const patches = compileApprovedDecisions(decisions, { 'orders.view': 'checksum-1' });
  assert.equal(patches.length, 1);
  assert.equal(patches[0]?.operation, 'update_file');
  assert.equal(patches[0]?.baseChecksum, 'checksum-1');
  assert.equal(unresolvedDecisionCount(decisions), 0);
});

test('semantic AI jobs persist sanitized metadata and keep results transient', async () => {
  const promptSecret = 'source-query-super-secret';
  const outputSecret = 'generated-yaml-super-secret';
  const job = startSemanticMigrationJob({
    providerId: 'provider-1',
    stage: 'analyze',
    requestFingerprintSource: promptSecret,
    run: async () => ({ output: outputSecret, usage: { input_tokens: 120, output_tokens: 40 } }),
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(getSemanticMigrationJob(job.id)?.status, 'succeeded');
  assert.deepEqual(getSemanticMigrationJobResult(job.id), { output: outputSecret, usage: { input_tokens: 120, output_tokens: 40 } });
  assert.deepEqual(getSemanticMigrationJob(job.id)?.usage, { input_tokens: 120, output_tokens: 40 });
  const durable = readFileSync(process.env.OMNIKIT_SEMANTIC_MIGRATION_JOB_PATH!, 'utf8');
  assert.equal(durable.includes(promptSecret), false);
  assert.equal(durable.includes(outputSecret), false);
  assert.match(durable, /requestFingerprint/);
});

test('client monitoring resumes the same semantic AI job instead of submitting a duplicate', async () => {
  const originalFetch = globalThis.fetch;
  let postCount = 0;
  const job = { id: 'semantic_job_existing', status: 'running' as const, createdAt: new Date().toISOString() };
  globalThis.fetch = async (_input, init) => {
    if (init?.method === 'POST') {
      postCount += 1;
      return new Response(JSON.stringify({ job }), { status: 202, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ job }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const input = {
    providerId: 'provider-1', task: 'propose_mappings' as const, system: 'System', prompt: 'Prompt', schemaName: 'semantic_migration_plan', schema: { type: 'object' },
  };
  try {
    await assert.rejects(
      generateMigrationProposal(input, { maxPollAttempts: 1, pollIntervalMs: 1 }),
      (error: unknown) => error instanceof MigrationProposalPendingError && error.job.id === job.id,
    );
    await assert.rejects(
      generateMigrationProposal(input, { existingJobId: job.id, maxPollAttempts: 1, pollIntervalMs: 1 }),
      (error: unknown) => error instanceof MigrationProposalPendingError && error.job.id === job.id,
    );
    assert.equal(postCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('semantic migration audit records identifiers and outcomes without payloads or credentials', () => {
  const secret = 'fixture-secret-must-not-be-audit-data';
  recordSemanticMigrationAuditEvent({
    type: 'provider_saved',
    resourceId: 'provider-1',
    providerKind: 'openai',
    outcome: 'completed',
  });
  const durable = readFileSync(process.env.OMNIKIT_SEMANTIC_MIGRATION_AUDIT_PATH!, 'utf8');
  assert.match(durable, /provider_saved/);
  assert.equal(durable.includes(secret), false);
  assert.doesNotMatch(durable, /prompt|generatedYaml|credential/i);
});

function domoManualArtifact() {
  return artifactFromText('domo', JSON.stringify({
    schemaVersion: DOMO_MANUAL_SCHEMA_VERSION,
    datasets: [{
      id: 'dataset-orders',
      name: 'Orders',
      description: 'Order-level sales data',
      schema: { columns: [{ name: 'Region', type: 'STRING' }, { name: 'Revenue', type: 'DECIMAL' }, { name: 'Cost', type: 'DECIMAL' }] },
    }],
    beastModes: [{
      id: 'beast-margin',
      name: 'Gross Margin',
      dataSourceId: 'dataset-orders',
      formula: 'SUM(`Revenue`) - SUM(`Cost`)',
      dataType: 'DECIMAL',
    }],
    dataflows: [{
      id: 'dataflow-orders',
      name: 'Orders Enriched',
      transforms: [{
        id: 'transform-orders',
        name: 'orders_enriched',
        sql: 'CREATE TABLE orders_enriched AS SELECT o.Region, SUM(o.Revenue) AS total_revenue FROM orders o LEFT JOIN targets t ON o.Region = t.Region GROUP BY o.Region',
      }],
    }],
    cards: [{
      id: 42,
      title: 'Revenue by Region',
      type: 'kpi',
      chartType: 'badge_vert_bar',
      datasourceId: 'dataset-orders',
      query: { fields: [{ name: 'Region' }, { name: 'Gross Margin' }], filters: [{ column: 'Region' }] },
    }],
  }), 'domo-manual-bundle.json')!;
}

function domoNorthstarRoundTripFixture() {
  const root = path.resolve('tests/fixtures/semantic-migrations/domo-northstar');
  const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')) as DomoRoundTripManifest;
  const artifacts = manifest.artifacts.map((entry) => artifactFromText(
    'domo',
    readFileSync(path.join(root, entry.path), 'utf8'),
    entry.name,
  )!);
  const expectedOmniFiles = manifest.expectedOmniFiles.map((fileName) => ({ fileName, content: readFileSync(path.join(root, fileName), 'utf8') }));
  return { manifest, artifacts, expectedOmniFiles };
}

test('Domo manual parser normalizes schemas, Beast Modes, DataFlow SQL, relationships, and cards', () => {
  const result = parseDomoManualArtifacts([domoManualArtifact()]);
  assert.equal(result.diagnostics.schemaVersion, DOMO_MANUAL_SCHEMA_VERSION);
  assert.equal(result.diagnostics.unsupportedArtifactCount, 0);

  const dataset = result.inventory.views.find((view) => view.name === 'Orders');
  assert.deepEqual(dataset?.fields.map((field) => field.name), ['Cost', 'Region', 'Revenue']);
  assert.equal(dataset?.measures[0]?.name, 'Gross Margin');
  assert.deepEqual(dataset?.measures[0]?.dependencies, ['Revenue', 'Cost']);

  const queryView = result.inventory.views.find((view) => view.kind === 'query_view');
  assert.equal(queryView?.name, 'orders_enriched');
  assert.match(queryView?.sql || '', /LEFT JOIN targets/i);
  assert.deepEqual(queryView?.fields.map((field) => field.name), ['Region', 'total_revenue']);

  assert.equal(result.inventory.relationships[0]?.from, 'orders');
  assert.equal(result.inventory.relationships[0]?.to, 'targets');
  assert.match(result.inventory.relationships[0]?.sql || '', /Region = t\.Region/);

  assert.equal(result.inventory.dashboards[0]?.name, 'Revenue by Region');
  assert.equal(result.inventory.dashboards[0]?.sourceDatasetId, 'dataset-orders');
  assert.equal(result.inventory.dashboards[0]?.chartType, 'badge_vert_bar');
  assert.ok(result.mappings.some((mapping) => mapping.targetKind === 'shared_model_view'));
  assert.ok(result.mappings.some((mapping) => mapping.targetKind === 'shared_model_measure'));
  assert.ok(result.mappings.some((mapping) => mapping.targetKind === 'query_view'));
  assert.ok(result.mappings.some((mapping) => mapping.targetKind === 'relationships_file'));
  assert.ok(result.mappings.some((mapping) => mapping.targetKind === 'dashboard_tile'));
});

test('Northstar Domo round-trip fixture recovers at least 90 percent of independent Omni expectations', () => {
  const { manifest, artifacts, expectedOmniFiles } = domoNorthstarRoundTripFixture();
  const result = parseDomoManualArtifacts(artifacts);
  const report = evaluateDomoRoundTrip(result, manifest);

  assert.equal(result.diagnostics.unsupportedArtifactCount, 0);
  assert.equal(result.inventory.views.filter((view) => view.kind === 'dataset').length, 6);
  assert.equal(result.inventory.views.filter((view) => view.kind === 'query_view').length, 6);
  assert.equal(result.inventory.dashboards.length, 6);
  assert.equal(report.meetsTarget, true, JSON.stringify(report, null, 2));
  assert.ok(report.score >= 90, JSON.stringify(report, null, 2));
  assert.match(report.caveat, /does not certify generated Omni YAML/i);
  assert.equal(manifest.expectedOmniFiles.length, 9);
  manifest.expectedOmniFiles.forEach((fileName) => {
    const content = readFileSync(path.resolve('tests/fixtures/semantic-migrations/domo-northstar', fileName), 'utf8');
    const parsed = fileName.endsWith('.json') ? JSON.parse(content) : parse(content);
    assert.ok(parsed, `${fileName} should contain a parseable review baseline.`);
  });

  const semanticFiles = expectedOmniFiles.filter((file) => !file.fileName.endsWith('.json')).map((file, index) => ({
    id: `baseline-${index}`,
    fileName: file.fileName.replace(/^expected-omni\//, '') as `${string}.view` | `${string}.topic` | 'relationships',
    yaml: file.content,
    source: 'semantic-migration' as const,
  }));
  const dashboardBaseline = JSON.parse(expectedOmniFiles.find((file) => file.fileName.endsWith('NorthstarDashboard.build.json'))!.content) as { targetName: string; tiles: Array<{ title: string; visualType: string; fields: string[] }>; validationAssertions: string[] };
  const dashboardPlans = [{
    id: 'northstar-dashboard-plan',
    sourceDashboardId: 'domo-page-northstar-dashboard',
    sourceDashboardName: 'NorthstarDashboard',
    sourceEvidenceIds: ['domo-page-northstar-dashboard'],
    dependencyIds: [],
    targetName: dashboardBaseline.targetName,
    filters: [],
    tiles: dashboardBaseline.tiles.map((tile, index) => ({ id: `tile-${index}`, title: tile.title, sourceEvidenceIds: [], fields: tile.fields, filters: [], visualType: tile.visualType, buildInstructions: `Build ${tile.title}`, validationAssertions: [] })),
    unsupportedFeatures: [],
    validationAssertions: dashboardBaseline.validationAssertions,
  }];
  const generatedReport = evaluateDomoGeneratedOutput(semanticFiles, dashboardPlans, expectedOmniFiles, manifest.targetScore);
  assert.equal(generatedReport.score, 100, JSON.stringify(generatedReport, null, 2));
  assert.equal(generatedReport.meetsTarget, true);
  assert.match(generatedReport.caveat, /does not prove SQL equivalence/i);
});

test('Northstar Looker project follows documented file topology and recovers at least 90 percent of expected evidence', () => {
  const root = path.resolve('tests/fixtures/semantic-migrations/looker-northstar');
  const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')) as LookerRoundTripManifest;
  const artifacts = manifest.artifacts.map((entry) => artifactFromText('looker', readFileSync(path.join(root, entry.path), 'utf8'), entry.name)!);
  const result = parseLookerManualArtifacts(artifacts);
  const report = evaluateLookerRoundTrip(result, manifest);

  assert.equal(result.diagnostics.schemaVersion, LOOKER_MANUAL_SCHEMA_VERSION);
  assert.equal(result.diagnostics.modelFileCount, 1);
  assert.equal(result.diagnostics.viewFileCount, 1);
  assert.equal(result.diagnostics.dashboardFileCount, 1);
  assert.equal(result.diagnostics.unsupportedArtifactCount, 0);
  assert.equal(result.inventory.views.length, 6);
  assert.equal(result.inventory.metrics.length, 12);
  assert.equal(result.inventory.explores.length, 1);
  assert.equal(result.inventory.relationships.length, 5);
  assert.equal(result.inventory.dashboards.length, 1);
  assert.equal(result.inventory.dashboards[0].name, 'NorthstarDashboard');
  assert.deepEqual(result.inventory.dashboards[0].filters, ['Business Date']);
  assert.ok(result.inventory.views.flatMap((view) => [...view.fields, ...view.measures]).every((field) => !String(field.type || '').includes('sql:')));
  assert.equal(report.meetsTarget, true, JSON.stringify(report, null, 2));
  assert.ok(report.score >= 90, JSON.stringify(report, null, 2));
  assert.match(report.caveat, /does not certify SQL equivalence/i);

  manifest.expectedOmniFiles.forEach((fileName) => {
    const content = readFileSync(path.join(root, fileName), 'utf8');
    const parsed = fileName.endsWith('.json') ? JSON.parse(content) : parse(content);
    assert.ok(parsed, `${fileName} should contain a parseable review baseline.`);
  });
});

test('Northstar MicroStrategy bundle recovers project, cube, report, metric, and dashboard evidence at 90 percent or better', () => {
  const root = path.resolve('tests/fixtures/semantic-migrations/microstrategy-northstar');
  const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')) as MicroStrategyRoundTripManifest;
  const artifacts = manifest.artifacts.map((entry) => artifactFromText('microstrategy', readFileSync(path.join(root, entry.path), 'utf8'), entry.name)!);
  const result = parseMicroStrategyManualArtifacts(artifacts);
  const report = evaluateMicroStrategyRoundTrip(result, manifest);

  assert.equal(result.diagnostics.schemaVersion, MICROSTRATEGY_MANUAL_SCHEMA_VERSION);
  assert.equal(result.diagnostics.unsupportedArtifactCount, 0);
  assert.equal(result.diagnostics.projectCount, 1);
  assert.equal(result.diagnostics.cubeCount, 6);
  assert.equal(result.diagnostics.reportCount, 6);
  assert.equal(result.diagnostics.attributeCount, 33);
  assert.equal(result.diagnostics.metricCount, 12);
  assert.equal(result.diagnostics.relationshipCount, 5);
  assert.equal(result.diagnostics.dashboardCount, 1);
  assert.equal(result.diagnostics.visualizationCount, 6);
  assert.equal(result.inventory.warnings.length, 0);
  assert.equal(report.meetsTarget, true, JSON.stringify(report, null, 2));
  assert.ok(report.score >= 90, JSON.stringify(report, null, 2));
  assert.match(report.caveat, /does not certify metric-result parity/i);

  manifest.expectedOmniFiles.forEach((fileName) => {
    const content = readFileSync(path.join(root, fileName), 'utf8');
    const parsed = fileName.endsWith('.json') ? JSON.parse(content) : parse(content);
    assert.ok(parsed, `${fileName} should contain a parseable review baseline.`);
  });
});

test('Northstar Power BI bundle recovers model.bim and PBIR-style evidence at 90 percent or better', () => {
  const root = path.resolve('tests/fixtures/semantic-migrations/power-bi-northstar');
  const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')) as PowerBiRoundTripManifest;
  const artifacts = manifest.artifacts.map((entry) => artifactFromText('power_bi', readFileSync(path.join(root, entry.path), 'utf8'), entry.name)!);
  const result = parsePowerBiManualArtifacts(artifacts);
  const report = evaluatePowerBiRoundTrip(result, manifest);

  assert.equal(result.diagnostics.schemaVersion, POWER_BI_MANUAL_SCHEMA_VERSION);
  assert.equal(result.diagnostics.unsupportedArtifactCount, 0);
  assert.equal(result.diagnostics.workspaceCount, 1);
  assert.equal(result.diagnostics.semanticModelCount, 1);
  assert.equal(result.diagnostics.tableCount, 6);
  assert.equal(result.diagnostics.columnCount, 33);
  assert.equal(result.diagnostics.measureCount, 12);
  assert.equal(result.diagnostics.relationshipCount, 5);
  assert.equal(result.diagnostics.roleCount, 0);
  assert.equal(result.diagnostics.reportCount, 1);
  assert.equal(result.diagnostics.pageCount, 6);
  assert.equal(result.diagnostics.visualCount, 6);
  assert.equal(result.inventory.warnings.length, 0);
  assert.equal(report.meetsTarget, true, JSON.stringify(report, null, 2));
  assert.ok(report.score >= 90, JSON.stringify(report, null, 2));
  assert.match(report.caveat, /does not certify DAX result parity/i);

  manifest.expectedOmniFiles.forEach((fileName) => {
    const content = readFileSync(path.join(root, fileName), 'utf8');
    const parsed = fileName.endsWith('.json') ? JSON.parse(content) : parse(content);
    assert.ok(parsed, `${fileName} should contain a parseable review baseline.`);
  });
});

type GoldenExpectedManifest = {
  views: Array<{ name: string; fields: string[]; measures: string[] }>;
  relationships: Array<{ from: string; to: string }>;
  dashboards: Array<{ name: string; fields: string[]; filters: string[] }>;
  caveats: string[];
};

type GoldenSourceManifest = {
  schemaVersion: 'omnikit.migration.golden.v1';
  sourceTool: MigrationSourceTool;
  synthetic: true;
  targetScore: number;
  artifacts: Array<{ name: string; path: string }>;
  expectedOmni: string;
};

function goldenToken(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function evaluateGoldenInventory(inventory: MigrationInventory, expected: GoldenExpectedManifest) {
  const actual = new Set<string>();
  inventory.views.forEach((view) => {
    actual.add(`view:${goldenToken(view.name)}`);
    view.fields.forEach((field) => actual.add(`field:${goldenToken(view.name)}:${goldenToken(field.name)}`));
    view.measures.forEach((measure) => actual.add(`measure:${goldenToken(view.name)}:${goldenToken(measure.name)}`));
  });
  inventory.relationships.forEach((relationship) => actual.add(`relationship:${goldenToken(relationship.from)}:${goldenToken(relationship.to)}`));
  inventory.dashboards.forEach((dashboard) => {
    actual.add(`dashboard:${goldenToken(dashboard.name)}`);
    dashboard.fields.forEach((field) => actual.add(`dashboard-field:${goldenToken(dashboard.name)}:${goldenToken(field)}`));
    dashboard.filters.forEach((filter) => actual.add(`dashboard-filter:${goldenToken(dashboard.name)}:${goldenToken(filter)}`));
  });
  const wanted = [
    ...expected.views.flatMap((view) => [
      `view:${goldenToken(view.name)}`,
      ...view.fields.map((field) => `field:${goldenToken(view.name)}:${goldenToken(field)}`),
      ...view.measures.map((measure) => `measure:${goldenToken(view.name)}:${goldenToken(measure)}`),
    ]),
    ...expected.relationships.map((relationship) => `relationship:${goldenToken(relationship.from)}:${goldenToken(relationship.to)}`),
    ...expected.dashboards.flatMap((dashboard) => [
      `dashboard:${goldenToken(dashboard.name)}`,
      ...dashboard.fields.map((field) => `dashboard-field:${goldenToken(dashboard.name)}:${goldenToken(field)}`),
      ...dashboard.filters.map((filter) => `dashboard-filter:${goldenToken(dashboard.name)}:${goldenToken(filter)}`),
    ]),
  ];
  const missing = wanted.filter((token) => !actual.has(token));
  return { score: wanted.length === 0 ? 100 : Math.round(((wanted.length - missing.length) / wanted.length) * 100), missing };
}

test('Tableau, Metabase, Sigma, and WebFOCUS synthetic golden fixtures recover reviewed Omni evidence', () => {
  for (const fixtureName of ['tableau-northstar', 'metabase-northstar', 'sigma-northstar', 'webfocus-northstar']) {
    const root = path.resolve('tests/fixtures/semantic-migrations', fixtureName);
    const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')) as GoldenSourceManifest;
    const expected = JSON.parse(readFileSync(path.join(root, manifest.expectedOmni), 'utf8')) as GoldenExpectedManifest;
    const artifacts = manifest.artifacts.map((entry) => artifactFromText(
      manifest.sourceTool,
      readFileSync(path.join(root, entry.path), 'utf8'),
      entry.name,
    )!);
    const inventory = buildMigrationInventory(manifest.sourceTool, artifacts);
    const report = evaluateGoldenInventory(inventory, expected);

    assert.equal(manifest.schemaVersion, 'omnikit.migration.golden.v1');
    assert.equal(manifest.synthetic, true);
    assert.ok(expected.caveats.length > 0, `${fixtureName} must state its residual validation caveats.`);
    assert.ok(report.score >= manifest.targetScore, `${fixtureName}: ${JSON.stringify(report, null, 2)}`);
  }
});

test('Power BI PBIP fixture preserves documented split project topology', () => {
  const root = path.resolve('tests/fixtures/semantic-migrations/power-bi-northstar-pbip');
  const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')) as {
    schemaVersion: string;
    artifacts: string[];
  };
  assert.equal(POWER_BI_MANUAL_SCHEMA_VERSION, 'omnikit.powerbi.manual.v2');
  assert.equal(manifest.schemaVersion, 'omnikit.powerbi.pbip.fixture.v1');
  manifest.artifacts.forEach((fileName) => assert.ok(readFileSync(path.join(root, fileName), 'utf8').length > 0, `${fileName} should exist.`));
  assert.ok(manifest.artifacts.some((fileName) => fileName.endsWith('/definition/report.json')));
  assert.ok(manifest.artifacts.some((fileName) => fileName.endsWith('/page.json')));
  assert.ok(manifest.artifacts.filter((fileName) => fileName.endsWith('/visual.json')).length >= 2);
  assert.ok(manifest.artifacts.some((fileName) => fileName.endsWith('/relationships.tmdl')));
  assert.ok(manifest.artifacts.some((fileName) => fileName.includes('/roles/')));
  assert.match(readFileSync(path.join(root, 'workspace-scan.json'), 'utf8'), /"datasets"/);
});

test('Power BI enhanced PBIR project assembles split report, page, visual, layout, and query evidence', () => {
  const root = path.resolve('tests/fixtures/semantic-migrations/power-bi-northstar-pbip');
  const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')) as { artifacts: string[] };
  const artifacts = manifest.artifacts.map((fileName) => artifactFromText('power_bi', readFileSync(path.join(root, fileName), 'utf8'), fileName)!);
  const result = parsePowerBiManualArtifacts(artifacts);
  const project = result.projects?.[0];
  const report = project?.reports[0];
  const page = report?.pages[0];
  const revenue = page?.visuals.find((visual) => visual.id === 'revenue_by_daypart');

  assert.equal(result.diagnostics.projectCount, 1);
  assert.equal(result.diagnostics.reportCount, 1);
  assert.equal(result.diagnostics.pageCount, 1);
  assert.equal(result.diagnostics.visualCount, 2);
  assert.equal(result.diagnostics.unsupportedVisualCount, 0);
  assert.equal(result.diagnostics.unsupportedArtifactCount, 0);
  assert.equal(project?.name, 'NorthstarDashboard');
  assert.ok(project?.sourceFiles.some((fileName) => fileName.endsWith('/definition/report.json')));
  assert.ok(project?.sourceFiles.some((fileName) => fileName.includes('.SemanticModel/definition/tables/Sales.tmdl')));
  assert.equal(report?.datasetId, 'dataset-northstar-simulated');
  assert.equal(page?.displayName, 'Executive Overview');
  assert.deepEqual(page?.filters, ['Region']);
  assert.equal(revenue?.visualType, 'clusteredColumnChart');
  assert.equal(revenue?.title, 'Revenue by Daypart');
  assert.deepEqual(revenue?.fields, ['Sales.Daypart', 'Sales.Total Revenue']);
  assert.deepEqual(revenue?.position, { x: 40, y: 120, width: 760, height: 360, z: 1000, tabOrder: 1 });
  assert.deepEqual(result.inventory.dashboards[0]?.fields.sort(), ['Sales.Daypart', 'Sales.Total Revenue']);
  assert.deepEqual(result.inventory.dashboards[0]?.filters, ['Region']);
});

test('Power BI selected-report evidence is complete, role-aware, and excludes unselected reports', () => {
  const root = path.resolve('tests/fixtures/semantic-migrations/power-bi-northstar-pbip');
  const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')) as { artifacts: string[] };
  const artifacts = manifest.artifacts.map((fileName) => artifactFromText('power_bi', readFileSync(path.join(root, fileName), 'utf8'), fileName)!);
  const parsed = parsePowerBiManualArtifacts(artifacts);
  const reportId = parsed.projects![0]!.reports[0]!.id;
  const evidence = powerBiSelectedReportEvidence(parsed, [reportId]);
  const revenue = evidence.reports[0]?.pages[0]?.visuals.find((visual) => visual.visualId === 'revenue_by_daypart');

  assert.equal(evidence.schemaVersion, 'omnikit.powerbi.selected-report-evidence.v1');
  assert.deepEqual(evidence.selectedDashboardIds, [reportId]);
  assert.equal(evidence.reports.length, 1);
  assert.match(revenue?.evidenceId || '', /^powerbi:visual:/);
  assert.deepEqual(revenue?.fieldBindings, [
    { role: 'Category', field: 'Sales.Daypart' },
    { role: 'Y', field: 'Sales.Total Revenue' },
  ]);
  assert.deepEqual(revenue?.position, { x: 40, y: 120, width: 760, height: 360, z: 1000, tabOrder: 1 });
  assert.match(revenue?.formatting || '', /Revenue by Daypart/);
  assert.equal(powerBiSelectedReportEvidence(parsed, []).reports.length, 0);
});

test('Power BI report evidence remains complete across 499, 500, 501, and 1001 visuals and chunks deterministically', () => {
  const parsedWithVisuals = (count: number): PowerBiManualParseResult => minimalPowerBiResult({
    mappings: [],
    projects: [{
      id: 'project-1', name: 'Enterprise report', sourceFiles: [], semanticModelIds: ['model-1'], warnings: [],
      reports: [{
        id: 'report-1', name: 'Enterprise report', datasetId: 'model-1', sourceArtifact: 'report.json', filters: [], bookmarks: [], themeFiles: [], warnings: [],
        pages: [{
          id: 'page-1', name: 'Page 1', displayName: 'Page 1', order: 1, sourceArtifact: 'page.json', filters: [], drillthroughFields: [],
          visuals: Array.from({ length: count }, (_, index) => ({
            id: `visual-${index + 1}`, name: `Visual ${index + 1}`, title: `Visual ${index + 1}`, visualType: 'barChart', pageId: 'page-1', sourceArtifact: `visual-${index + 1}.json`, fields: ['Sales.Revenue'], filters: [], unsupportedReasons: [],
          })),
        }],
      }],
    }],
  });
  [499, 500, 501, 1001].forEach((count) => {
    const parsed = parsedWithVisuals(count);
    const evidence = powerBiSelectedReportEvidence(parsed, ['report-1']);
    assert.equal(evidence.reports[0]?.pages[0]?.visuals.length, count);
    assert.equal(evidence.truncated, false);
    const chunks = powerBiSelectedReportEvidenceChunks(parsed, ['report-1'], 20_000);
    assert.equal(chunks.flatMap((chunk) => chunk.chunk.expectedVisualIds).length, count);
    assert.equal(new Set(chunks.flatMap((chunk) => chunk.chunk.expectedVisualIds)).size, count);
    assert.ok(chunks.every((chunk, index) => chunk.chunk.index === index + 1 && chunk.chunk.total === chunks.length));
    if (count > 500) assert.ok(chunks.length > 1);
  });
});

test('Power BI visual evidence preserves complete query and formatting payloads or fails as one indivisible unit', () => {
  const query = `SELECT ${'revenue + '.repeat(1_300)}cost`;
  const formatting = JSON.stringify({ title: 'Enterprise visual', theme: 'x'.repeat(8_000) });
  const parsed = minimalPowerBiResult({
    mappings: [],
    projects: [{
      id: 'project-1', name: 'Enterprise report', sourceFiles: [], semanticModelIds: ['model-1'], warnings: [],
      reports: [{
        id: 'report-1', name: 'Enterprise report', datasetId: 'model-1', sourceArtifact: 'report.json', filters: [], bookmarks: [], themeFiles: [], warnings: [],
        pages: [{
          id: 'page-1', name: 'Page 1', displayName: 'Page 1', order: 1, sourceArtifact: 'page.json', filters: [], drillthroughFields: [],
          visuals: [{ id: 'visual-1', name: 'Visual 1', visualType: 'barChart', pageId: 'page-1', sourceArtifact: 'visual.json', fields: ['Sales.Revenue'], filters: [], query, formatting, unsupportedReasons: [] }],
        }],
      }],
    }],
  });

  const evidence = powerBiSelectedReportEvidence(parsed, ['report-1']);
  const visual = evidence.reports[0]?.pages[0]?.visuals[0];
  assert.equal(visual?.query, query);
  assert.equal(visual?.formatting, formatting);
  assert.throws(() => powerBiSelectedReportEvidenceChunks(parsed, ['report-1'], 20_000), /indivisible.*did not shorten/i);
});

test('canonical prompt scope has explicit coverage and no fixed 500-node cutoff', () => {
  const inventory: MigrationInventory = {
    sourceTool: 'power_bi', artifactCount: 0, artifacts: [], explores: [], relationships: [], dashboards: [], metrics: [], warnings: [], summary: 'large semantic model',
    views: [{
      name: 'Sales', warnings: [], measures: [],
      fields: Array.from({ length: 600 }, (_, index) => ({ name: `Field ${index + 1}`, sourceArtifact: 'model.tmdl' })),
    }],
  };
  const canonical = buildCanonicalSemanticModel(inventory);
  const scope = canonicalPromptScope(canonical, { fieldNames: inventory.views[0]!.fields.map((field) => `Sales.${field.name}`), dependencyIds: [] });

  assert.ok(scope.model.nodes.length > 500);
  assert.deepEqual(scope.coverage, {
    totalNodes: canonical.nodes.length,
    includedNodes: canonical.nodes.length,
    omittedUnrelatedNodes: 0,
    completeForSelectedScope: true,
  });
});

test('Power BI planning chunks validate exact visual scope and merge without dropping tiles', () => {
  const selected = [{ id: 'report-1', name: 'Enterprise report', kind: 'report' as const, dependencyIds: [], dependencies: [], dependencyCounts: {}, complexity: 'high' as const, coverage: 'complete' as const, coverageNotes: [], riskFlags: [] }];
  const first = normalizeDashboardBuildPlans([{ sourceDashboardId: 'report-1', targetName: 'Enterprise report', tiles: [{ id: 'tile-one', title: 'One', fields: ['Sales.One'], sourceEvidenceIds: ['powerbi:visual:one'] }] }], selected);
  const second = normalizeDashboardBuildPlans([{ sourceDashboardId: 'report-1', targetName: 'Enterprise report', tiles: [{ id: 'tile-two', title: 'Two', fields: ['Sales.Two'], sourceEvidenceIds: ['powerbi:visual:two'] }] }], selected);
  assert.deepEqual(dashboardPlanScopeIssues(first, selected, ['powerbi:visual:one']), []);
  assert.match(dashboardPlanScopeIssues(first, selected, ['powerbi:visual:two']).join(' '), /Missing visual plan evidence/);
  const merged = mergeDashboardBuildPlanChunks([first, second]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0]?.tiles.map((tile) => tile.title), ['One', 'Two']);
});

test('planning chunks deduplicate equivalent decisions and expose conflicts for operator resolution', () => {
  const first = normalizeMigrationDecisions([{ id: 'generated-1', nodeId: 'measure:sales.revenue', domain: 'measure', sourceLabel: 'Revenue', action: 'create_new', rationale: 'Create it', confidence: 0.9 }]);
  const duplicate = normalizeMigrationDecisions([{ id: 'generated-2', nodeId: 'measure:sales.revenue', domain: 'measure', sourceLabel: 'Revenue', action: 'create_new', rationale: 'Create it', confidence: 0.9 }]);
  const conflict = normalizeMigrationDecisions([{ id: 'generated-3', nodeId: 'measure:sales.revenue', domain: 'measure', sourceLabel: 'Revenue', action: 'defer', rationale: 'Wait', confidence: 0.7 }]);
  assert.equal(mergePowerBiDecisionProposalChunks([first, duplicate]).length, 1);
  const conflicted = normalizeMigrationDecisions(mergePowerBiDecisionProposalChunks([first, conflict]));
  assert.equal(conflicted.length, 1);
  assert.equal(conflicted[0]?.proposalOptions?.length, 2);
  assert.match(migrationDecisionResolutionIssue(conflicted[0]!) || '', /Choose one AI proposal/i);
  const selected = selectMigrationDecisionProposal(conflicted, conflicted[0]!.id, conflicted[0]!.proposalOptions![1]!.id);
  assert.equal(selected[0]?.action, 'defer');
  assert.equal(selected[0]?.selectedProposalOptionId, selected[0]?.proposalOptions?.[1]?.id);
  assert.equal(migrationDecisionResolutionIssue(selected[0]!), null);
});

test('provider identity reuse preserves independent Looker view, relationship, topic, field, and filter decisions', () => {
  const providerDecisions = normalizeMigrationDecisions([
    { id: 'reused-provider-id', nodeId: 'view:daily_grill_report', semanticKind: 'view', domain: 'model', sourceLabel: 'daily_grill_report', targetFileName: 'daily_grill_report.view', action: 'create_new', rationale: 'Create the source view.', confidence: 0.95 },
    { id: 'reused-provider-id', nodeId: 'view:daily_grill_report', semanticKind: 'relationship', domain: 'relationship', sourceLabel: 'daily_grill_report -> northstar_locations', targetFileName: 'relationships', action: 'create_new', rationale: 'Create the location relationship.', confidence: 0.9 },
    { id: 'reused-provider-id', nodeId: 'view:daily_grill_report', semanticKind: 'relationship', domain: 'relationship', sourceLabel: 'daily_grill_report -> bag_tickets', targetFileName: 'relationships', action: 'create_new', rationale: 'Create the ticket relationship.', confidence: 0.9 },
    { id: 'reused-provider-id', nodeId: 'view:daily_grill_report', semanticKind: 'relationship', domain: 'relationship', sourceLabel: 'daily_grill_report -> grill_slips', targetFileName: 'relationships', action: 'defer', rationale: 'Review the grill relationship.', confidence: 0.7 },
    { id: 'reused-provider-id', nodeId: 'view:daily_grill_report', semanticKind: 'topic', domain: 'model', sourceLabel: 'Daily Grill Report', targetFileName: 'daily_grill_report.topic', action: 'create_new', rationale: 'Create the topic.', confidence: 0.9 },
    { id: 'reused-provider-id', nodeId: 'field:daily_grill_report:business_date', semanticKind: 'field', domain: 'field', sourceLabel: 'daily_grill_report.business_date', targetFileName: 'daily_grill_report.view', action: 'create_new', rationale: 'Create the time dimension.', confidence: 0.95 },
    { id: 'reused-provider-id', nodeId: 'field:daily_grill_report:business_date', semanticKind: 'filter', domain: 'filter', sourceLabel: 'daily_grill_report.business_date', targetFileName: 'daily_grill_report.topic', action: 'create_new', rationale: 'Create the topic default filter.', confidence: 0.85 },
  ]);
  const merged = mergeMigrationDecisionProposalChunks([providerDecisions]);

  assert.equal(merged.length, 7);
  assert.equal(new Set(merged.map((decision) => decision.id)).size, 7);
  assert.equal(merged.filter((decision) => (decision.proposalOptions?.length || 0) > 1).length, 0);
  assert.deepEqual(
    new Set(merged.map(migrationDecisionSemanticKind)),
    new Set(['view', 'relationship', 'topic', 'field', 'filter']),
  );
  assert.equal(new Set(merged.map(migrationDecisionSemanticKey)).size, 7);
  assert.match(migrationDecisionIdentityDiagnostics(merged).join(' '), /reused decision ID/i);
  assert.match(migrationDecisionIdentityDiagnostics(merged).join(' '), /reused source lineage/i);

  const canonical: CanonicalSemanticModel = {
    schemaVersion: '1.0',
    sourcePlatform: 'looker',
    generatedAt: '2026-07-16T00:00:00.000Z',
    warnings: [],
    nodes: [{
      id: 'view:daily_grill_report',
      kind: 'view',
      name: 'daily_grill_report',
      dependencies: [],
      evidence: [{ sourceId: 'northstar.view.lkml' }],
      metadata: {},
    }, {
      id: 'field:daily_grill_report:business_date',
      kind: 'field',
      name: 'business_date',
      parentId: 'view:daily_grill_report',
      dependencies: [],
      evidence: [{ sourceId: 'northstar.view.lkml' }],
      metadata: {},
    }],
  };
  const deliverables = compileOmniMigrationDeliverables(canonical, merged);
  assert.equal(deliverables.length, 7);
  assert.equal(new Set(deliverables.flatMap((deliverable) => deliverable.decisionIds)).size, 7);
  assert.equal(deliverables.filter((deliverable) => deliverable.kind === 'topic').length, 2);
  assert.equal(deliverables.filter((deliverable) => deliverable.kind === 'view').length, 5);

  const report = buildMigrationReconciliationReport({
    sourceInventory: null,
    sourcePlatform: 'looker',
    scope: {
      'view:daily_grill_report': {
        assetId: 'view:daily_grill_report',
        disposition: 'migrate',
        wave: 'Wave 1',
        note: '',
      },
    },
    decisions: merged,
    files: [],
    validation: [],
    targetBaseUrl: 'https://example.omniapp.co',
  });
  assert.equal(report.outcomes.length, 8);
  assert.equal(new Set(report.outcomes.filter((outcome) => outcome.decisionKey).map((outcome) => outcome.decisionKey)).size, 7);
});

test('decision merging deduplicates exact outcomes and exposes only true same-object conflicts', () => {
  const exact = normalizeMigrationDecisions([
    { id: 'one', nodeId: 'measure:orders:revenue', semanticKind: 'measure', domain: 'measure', sourceLabel: 'orders.revenue', targetFileName: 'orders.view', action: 'create_new', proposedCode: 'measures:\n  revenue: {}', rationale: 'Create it.', confidence: 0.8 },
  ]);
  const duplicate = normalizeMigrationDecisions([
    { id: 'two', nodeId: 'measure:orders:revenue', semanticKind: 'measure', domain: 'measure', sourceLabel: 'orders.revenue', targetFileName: 'orders.view', action: 'create_new', proposedCode: 'measures:\n  revenue: {}', rationale: 'Same outcome.', confidence: 0.9 },
  ]);
  const conflicting = normalizeMigrationDecisions([
    { id: 'three', nodeId: 'measure:orders:revenue', semanticKind: 'measure', domain: 'measure', sourceLabel: 'orders.revenue', action: 'map_existing', targetId: 'orders.total_revenue', rationale: 'Map instead.', confidence: 0.7 },
  ]);

  const deduplicated = mergeMigrationDecisionProposalChunks([exact, duplicate]);
  assert.equal(deduplicated.length, 1);
  assert.equal(deduplicated[0]?.confidence, 0.9);
  assert.equal(deduplicated[0]?.proposalOptions, undefined);

  const conflict = mergeMigrationDecisionProposalChunks([exact, conflicting]);
  assert.equal(conflict.length, 1);
  assert.equal(conflict[0]?.proposalOptions?.length, 2);
  assert.match(conflict[0]?.rationale || '', /same semantic object/i);
});

test('governance decision identity does not collapse distinct outcomes that share source lineage', () => {
  const decisions = mergeMigrationDecisionProposalChunks([normalizeMigrationDecisions([
    { id: 'permission-one', nodeId: 'role:regional_manager', semanticKind: 'permission', domain: 'permission', sourceLabel: 'Regional Manager row policy', action: 'defer', rationale: 'Map row policy.', confidence: 0.8 },
    { id: 'permission-two', nodeId: 'role:regional_manager', semanticKind: 'permission', domain: 'permission', sourceLabel: 'Regional Manager content access', action: 'defer', rationale: 'Map content access.', confidence: 0.8 },
  ])]);
  const governance = buildMigrationGovernanceChecklist({ decisions });
  assert.equal(governance.length, 2);
  assert.equal(new Set(governance.map((item) => item.id)).size, 2);
  assert.ok(governance.every((item) => item.details.some((detail) => /Source lineage: role:regional_manager/.test(detail))));
});

test('Power BI manual parser supports TMDL tables, DAX measures, relationships, and RLS roles', () => {
  const artifact = artifactFromText('power_bi', `table 'Orders'\n  column 'Order ID'\n  column Revenue\n    formatString: $#,0.00\n  column RevenueBand = IF([Revenue] >= 1000, "High", "Standard")\n  measure 'Total Revenue' = SUM('Orders'[Revenue])\n    formatString: $#,0.00\n  hierarchy Geography\n    level Region\n      column: Region\n  partition Orders = m\n    mode: import\n    source =\n      let\n        Source = Warehouse\n      in\n        Source\n\nrelationship orders_customer\n  fromColumn: Orders.Customer ID\n  toColumn: Customers.Customer ID\n  fromCardinality: many\n  toCardinality: one\n  crossFilteringBehavior: oneDirection\n  isActive: true\n\nrole Regional Manager\n  tablePermission Orders = [Region] = "West"`, 'orders.tmdl')!;
  const result = parsePowerBiManualArtifacts([artifact]);
  assert.equal(result.inventory.views.length, 1);
  assert.equal(result.inventory.views[0].fields.length, 3);
  assert.equal(result.inventory.metrics[0].name, 'Total Revenue');
  assert.equal(result.inventory.relationships.length, 1);
  assert.equal(result.inventory.relationships[0].sql, 'Orders.Customer ID = Customers.Customer ID');
  assert.equal(result.inventory.relationships[0].crossFilteringBehavior, 'oneDirection');
  assert.match(result.inventory.views[0].sql || '', /let[\s\S]*Source = Warehouse/);
  assert.equal(result.inventory.views[0].hierarchies?.[0]?.levels[0]?.column, 'Region');
  assert.equal(result.diagnostics.calculatedColumnCount, 1);
  assert.equal(result.diagnostics.partitionCount, 1);
  assert.equal(result.diagnostics.hierarchyCount, 1);
  assert.equal(result.diagnostics.roleCount, 1);
  assert.match(result.mappings.find((item) => item.sourceKind === 'role')?.notes.join(' ') || '', /\[Region\] = "West"/);
  assert.equal(result.diagnostics.unsupportedArtifactCount, 0);
});

test('Power BI TMDL parser preserves multiline RLS predicates and warns on empty permissions', () => {
  const artifact = artifactFromText('power_bi', `role Regional Manager
  tablePermission Sales = \`\`\`
    [Region] = "West" &&
    [Is Active] = TRUE()
  \`\`\`
  tablePermission Customers = [Customer Type] = "Retail"

role Empty Role
  tablePermission Sales = \`\`\`
  \`\`\``, 'roles.tmdl')!;
  const result = parsePowerBiManualArtifacts([artifact]);
  const regional = result.mappings.find((item) => item.sourceKind === 'role' && item.sourceName === 'Regional Manager');
  assert.match(regional?.notes.join('\n') || '', /Sales: \[Region\] = "West" &&\n\[Is Active\] = TRUE\(\)/);
  assert.match(regional?.notes.join('\n') || '', /Customers: \[Customer Type\] = "Retail"/);
  assert.match(result.inventory.warnings.join(' '), /Empty Role.*could not be recovered/i);
  assert.equal(result.diagnostics.roleCount, 2);
});

test('Power BI model.bim preserves calculated columns, Power Query partitions, hierarchies, and relationship keys', () => {
  const artifact = artifactFromText('power_bi', JSON.stringify({
    model: {
      name: 'Retail Model',
      tables: [{
        name: 'Sales',
        isHidden: false,
        annotations: [{ name: 'lineage', value: 'synthetic-sales' }],
        columns: [
          { name: 'LocationId', dataType: 'string', sourceColumn: 'location_id' },
          { name: 'RevenueBand', dataType: 'string', expression: 'IF([Revenue] >= 1000, "High", "Standard")', formatString: 'General' },
        ],
        measures: [{ name: 'Total Revenue', expression: 'SUM(Sales[Revenue])', formatString: '$#,0.00' }],
        partitions: [{ name: 'Sales', mode: 'import', source: { type: 'm', expression: ['let', '  Source = Warehouse', 'in', '  Source'] } }],
        hierarchies: [{ name: 'Geography', levels: [{ name: 'Location', column: 'LocationId' }] }],
      }],
      relationships: [{ name: 'sales_locations', fromTable: 'Sales', fromColumn: 'LocationId', toTable: 'Locations', toColumn: 'LocationId', fromCardinality: 'many', toCardinality: 'one', crossFilteringBehavior: 'oneDirection', isActive: true }],
      roles: [{ name: 'Regional Viewer', tablePermissions: [{ name: 'Sales', filterExpression: '[Region] = "West"' }] }],
      expressions: [{ name: 'Warehouse', expression: ['let', '  Source = Snowflake.Databases("example.invalid")', 'in', '  Source'] }],
    },
  }), 'retail-model.bim')!;
  const result = parsePowerBiManualArtifacts([artifact]);
  const sales = result.inventory.views.find((view) => view.name === 'Sales');
  assert.equal(sales?.fields.find((field) => field.name === 'RevenueBand')?.sql?.startsWith('IF('), true);
  assert.equal(sales?.fields.find((field) => field.name === 'LocationId')?.sourceColumn, 'location_id');
  assert.equal(sales?.measures[0]?.formatString, '$#,0.00');
  assert.match(sales?.sql || '', /Snowflake|Warehouse/);
  assert.equal(sales?.hierarchies?.[0]?.levels[0]?.column, 'LocationId');
  assert.equal(result.inventory.relationships[0]?.sql, 'Sales.LocationId = Locations.LocationId');
  assert.equal(result.diagnostics.calculatedColumnCount, 1);
  assert.equal(result.diagnostics.partitionCount, 1);
  assert.equal(result.diagnostics.hierarchyCount, 1);
  assert.equal(result.diagnostics.dataSourceCount, 1);
  assert.equal(result.diagnostics.roleCount, 1);
  assert.match(result.mappings.find((item) => item.sourceKind === 'role')?.notes.join(' ') || '', /\[Region\] = "West"/);
});

test('Power BI Workspace Scanner nests datasets and reports under workspaces without exposing principal identities', () => {
  const artifact = artifactFromText('power_bi', JSON.stringify({
    workspaces: [{
      id: 'workspace-1',
      name: 'Retail Analytics',
      users: [{ displayName: 'Private User', principalType: 'User' }],
      datasets: [{ id: 'dataset-1', name: 'Retail Model', sensitivityLabel: { labelId: 'label-1' } }],
      reports: [{ id: 'report-1', name: 'Executive Overview', datasetId: 'dataset-1' }],
    }],
  }), 'workspace-scan.json')!;
  const result = parsePowerBiManualArtifacts([artifact]);
  assert.equal(result.diagnostics.workspaceCount, 1);
  assert.equal(result.diagnostics.semanticModelCount, 1);
  assert.equal(result.diagnostics.reportCount, 1);
  assert.equal(result.inventory.dashboards[0]?.sourceDatasetId, 'dataset-1');
  assert.doesNotMatch(JSON.stringify({ mappings: result.mappings, diagnostics: result.diagnostics }), /Private User/);
  assert.match(result.mappings.find((item) => item.sourceKind === 'workspace')?.notes.join(' ') || '', /identities are not included/);
});

test('Domo manual parser handles official schema-only responses and flags unsupported files', () => {
  const schema = artifactFromText('domo', JSON.stringify({
    name: 'schema',
    dataSourceId: '94a4edfa-5926-4f0c-ad1e-a341f53f6113',
    tables: [{ columns: [{ name: 'Display Name', id: 'Display Name', type: 'STRING', visible: true }] }],
  }), 'dataset-schema.json')!;
  const unknown = artifactFromText('domo', JSON.stringify({ owner: 'Example', updatedAt: '2026-07-10' }), 'metadata-only.json')!;
  const result = parseDomoManualArtifacts([schema, unknown]);
  assert.equal(result.inventory.views[0]?.sourceId, '94a4edfa-5926-4f0c-ad1e-a341f53f6113');
  assert.equal(result.inventory.views[0]?.fields[0]?.name, 'Display Name');
  assert.equal(result.diagnostics.unsupportedArtifactCount, 1);
  assert.match(result.diagnostics.warnings.join(' '), /metadata-only\.json/);
});

test('Domo manual parser resolves Beast Modes against dataset schemas uploaded in separate files', () => {
  const schema = artifactFromText('domo', JSON.stringify({
    id: 'dataset-orders',
    name: 'Orders',
    schema: { columns: [{ name: 'Revenue', type: 'DECIMAL' }] },
  }), 'orders-dataset.json')!;
  const beastMode = artifactFromText('domo', JSON.stringify({
    beastModes: [{ id: 'beast-revenue', name: 'Total Revenue', dataSourceId: 'dataset-orders', formula: 'SUM(`Revenue`)' }],
  }), 'orders-beast-modes.json')!;
  const result = parseDomoManualArtifacts([beastMode, schema]);
  const orders = result.inventory.views.find((view) => view.name === 'Orders');
  assert.equal(orders?.measures[0]?.name, 'Total Revenue');
  assert.equal(result.inventory.views.some((view) => view.name.startsWith('domo_dataset_')), false);
  assert.doesNotMatch(result.inventory.warnings.join(' '), /dataset schema was not uploaded/);
});

test('Domo manual parser deduplicates one shared Beast Mode used by multiple dashboards', () => {
  const schema = artifactFromText('domo', JSON.stringify({ id: 'dataset-orders', name: 'Orders', schema: { columns: [{ name: 'Revenue', type: 'DECIMAL' }] } }), 'orders-schema.json')!;
  const firstDashboard = artifactFromText('domo', JSON.stringify({
    beastModes: [{ id: 'beast-revenue', name: 'Total Revenue', dataSourceId: 'dataset-orders', formula: 'SUM(`Revenue`)' }],
    cards: [{ id: 'card-one', title: 'Executive Revenue', datasourceId: 'dataset-orders', chartType: 'badge_vert_bar' }],
  }), 'executive-dashboard.json')!;
  const secondDashboard = artifactFromText('domo', JSON.stringify({
    beastModes: [{ id: 'beast-revenue', name: 'Total Revenue', dataSourceId: 'dataset-orders', formula: 'SUM(  `Revenue`  )' }],
    cards: [{ id: 'card-two', title: 'Regional Revenue', datasourceId: 'dataset-orders', chartType: 'badge_line' }],
  }), 'regional-dashboard.json')!;
  const result = parseDomoManualArtifacts([schema, firstDashboard, secondDashboard]);
  const orders = result.inventory.views.find((view) => view.name === 'Orders');
  assert.equal(orders?.measures.length, 1);
  assert.equal(orders?.measures[0]?.name, 'Total Revenue');
  assert.equal(result.inventory.dashboards.length, 2);
  assert.equal(result.diagnostics.deduplicatedMeasureCount, 1);
  assert.equal(result.diagnostics.conflictCount, 0);
  assert.equal(result.conflicts.length, 0);
});

test('Domo manual parser preserves different same-named Beast Mode formulas additively', () => {
  const schema = artifactFromText('domo', JSON.stringify({ id: 'dataset-orders', name: 'Orders', schema: { columns: [{ name: 'Revenue', type: 'DECIMAL' }, { name: 'Cost', type: 'DECIMAL' }] } }), 'orders-schema.json')!;
  const firstDashboard = artifactFromText('domo', JSON.stringify({
    beastModes: [{ id: 'beast-margin', name: 'Margin', dataSourceId: 'dataset-orders', formula: 'SUM(`Revenue`) - SUM(`Cost`)' }],
    cards: [{ id: 'card-one', title: 'Executive Margin', datasourceId: 'dataset-orders', chartType: 'badge_vert_bar' }],
  }), 'executive-dashboard.json')!;
  const secondDashboard = artifactFromText('domo', JSON.stringify({
    beastModes: [{ id: 'beast-margin', name: 'Margin', dataSourceId: 'dataset-orders', formula: '(SUM(`Revenue`) - SUM(`Cost`)) / SUM(`Revenue`)' }],
    cards: [{ id: 'card-two', title: 'Margin Rate', datasourceId: 'dataset-orders', chartType: 'badge_line' }],
  }), 'margin-dashboard.json')!;
  const result = parseDomoManualArtifacts([schema, firstDashboard, secondDashboard]);
  const measures = result.inventory.views.find((view) => view.name === 'Orders')?.measures || [];
  assert.equal(measures.length, 2);
  assert.ok(measures.every((measure) => measure.originalName === 'Margin'));
  assert.ok(measures.every((measure) => measure.name.startsWith('Margin__beast_margin_')));
  assert.notEqual(measures[0]?.name, measures[1]?.name);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0]?.resolution, 'preserve_all');
  assert.equal(result.conflicts[0]?.variants.length, 2);
  assert.equal(result.diagnostics.conflictCount, 1);
  assert.match(result.inventory.warnings.join(' '), /preserved every variant/i);
  assert.equal(domoManualUploadGate({ result, conflictsAcknowledged: false, unsupportedAcknowledged: false }).ready, false);
  assert.equal(domoManualUploadGate({ result, conflictsAcknowledged: true, unsupportedAcknowledged: false }).ready, true);
});

test('Domo manual upload gate requires complete evidence and explicit exception acknowledgement', () => {
  const complete = parseDomoManualArtifacts([domoManualArtifact()]);
  assert.equal(domoManualUploadGate({ result: complete, conflictsAcknowledged: false, unsupportedAcknowledged: false }).ready, true);
  const reviews = buildDomoManualArtifactReview(complete.inventory.artifacts, complete);
  assert.equal(reviews[0]?.status, 'parsed');
  assert.ok(reviews[0]?.roles.includes('dataset_schema'));
  assert.ok(reviews[0]?.roles.includes('card'));

  const missingCards = parseDomoManualArtifacts([artifactFromText('domo', JSON.stringify({ id: 'dataset-orders', name: 'Orders', schema: { columns: [{ name: 'Revenue', type: 'DECIMAL' }] } }), 'schema-only.json')!]);
  const missingGate = domoManualUploadGate({ result: missingCards, conflictsAcknowledged: false, unsupportedAcknowledged: false });
  assert.equal(missingGate.ready, false);
  assert.deepEqual(missingGate.missingRequiredEvidence, ['card']);

  const unknown = artifactFromText('domo', JSON.stringify({ owner: 'Example' }), 'unsupported.json')!;
  const withUnsupported = parseDomoManualArtifacts([...complete.inventory.artifacts, unknown]);
  assert.equal(domoManualUploadGate({ result: withUnsupported, conflictsAcknowledged: false, unsupportedAcknowledged: false }).ready, false);
  assert.equal(domoManualUploadGate({ result: withUnsupported, conflictsAcknowledged: false, unsupportedAcknowledged: true }).ready, true);
});

test('released manual evidence keeps normalized metadata but removes every raw artifact body', () => {
  const inventory = buildMigrationInventory('domo', [
    artifactFromText('domo', '{"name":"Sales","formula":"SUM(secret_source_column)"}', 'sales.json')!,
    artifactFromText('domo', 'SELECT * FROM raw_orders', 'orders.sql')!,
  ]);

  const released = migrationInventoryWithoutRawArtifactContent(inventory);

  assert.equal(released.artifactCount, inventory.artifactCount);
  assert.deepEqual(released.artifacts.map((artifact) => artifact.name), inventory.artifacts.map((artifact) => artifact.name));
  assert.deepEqual(released.artifacts.map((artifact) => artifact.sizeBytes), inventory.artifacts.map((artifact) => artifact.sizeBytes));
  assert.equal(released.artifacts.every((artifact) => artifact.content === ''), true);
  assert.equal(JSON.stringify(released).includes('secret_source_column'), false);
  assert.equal(JSON.stringify(released).includes('raw_orders'), false);
});

test('Domo and Power BI manual artifacts preserve larger JSON payloads for backend normalization', () => {
  const content = JSON.stringify({ notes: 'x'.repeat(160_000) });
  const domo = artifactFromText('domo', content, 'large-domo-export.json')!;
  const powerBi = artifactFromText('power_bi', content, 'large-power-bi-export.json')!;
  assert.equal(domo.content.length, content.length);
  assert.equal(domo.parseWarnings.length, 0);
  assert.equal(powerBi.content.length, content.length);
  assert.equal(powerBi.parseWarnings.length, 0);
});

test('Power BI project ZIP ingestion preserves relative paths and blocks traversal', async () => {
  const zip = new JSZip();
  zip.file('Example.Report/definition/report.json', '{"name":"Example"}');
  zip.file('Example.Report/definition/pages/overview/page.json', '{"name":"overview"}');
  zip.file('Example.SemanticModel/definition/tables/Sales.tmdl', 'table Sales\n  column Revenue');
  zip.file('notes.bin', 'ignored');
  const artifacts = await artifactsFromPowerBiZip(await zip.generateAsync({ type: 'uint8array' }), 'example.zip');
  assert.deepEqual(artifacts.map((artifact) => artifact.name).sort(), [
    'Example.Report/definition/pages/overview/page.json',
    'Example.Report/definition/report.json',
    'Example.SemanticModel/definition/tables/Sales.tmdl',
  ]);
  assert.match(artifacts[0].parseWarnings.join(' '), /Skipped unsupported project file notes\.bin/);
  assert.throws(() => normalizePowerBiProjectPath('../outside.json'), /Unsafe Power BI project path/);

  const unsafeZip = new JSZip();
  unsafeZip.file('../outside.json', '{}');
  const unsafeBytes = await unsafeZip.generateAsync({ type: 'uint8array' });
  await assert.rejects(() => artifactsFromPowerBiZip(unsafeBytes), /safe relative paths|Unsafe Power BI project path/);
});

test('Power BI project ZIP ingestion rejects declared expansion before extracting oversized text', async () => {
  const zip = new JSZip();
  zip.file('Example.SemanticModel/definition/model.tmdl', 'x'.repeat(POWER_BI_PROJECT_LIMITS.fileBytes + 1));
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 9 } });
  assert.ok(bytes.byteLength < POWER_BI_PROJECT_LIMITS.archiveBytes);
  await assert.rejects(
    () => artifactsFromPowerBiZip(bytes, 'expanded-project.zip'),
    /declared expanded size exceeds the 5 MB Power BI project file limit/i,
  );
});

test('Power BI project ZIP ingestion rejects duplicate paths, invalid UTF-8, and excessive entry counts', async () => {
  const duplicateZip = new JSZip();
  duplicateZip.file('Example.Report/definition/report.json', '{}');
  duplicateZip.file('example.report/definition/REPORT.json', '{}');
  const duplicateBytes = await duplicateZip.generateAsync({ type: 'uint8array' });
  await assert.rejects(
    () => artifactsFromPowerBiZip(duplicateBytes),
    /Duplicate Power BI project path/i,
  );

  const invalidUtf8Zip = new JSZip();
  invalidUtf8Zip.file('Example.SemanticModel/definition/model.tmdl', new Uint8Array([0xc3, 0x28]));
  const invalidUtf8Bytes = await invalidUtf8Zip.generateAsync({ type: 'uint8array' });
  await assert.rejects(
    () => artifactsFromPowerBiZip(invalidUtf8Bytes),
    /not valid UTF-8/i,
  );

  const crowdedZip = new JSZip();
  for (let index = 0; index <= POWER_BI_PROJECT_LIMITS.files; index += 1) crowdedZip.file(`project/file-${index}.json`, '{}');
  const crowdedBytes = await crowdedZip.generateAsync({ type: 'uint8array' });
  await assert.rejects(
    () => artifactsFromPowerBiZip(crowdedBytes),
    /more than 1,000 files/i,
  );
});

test('Power BI project ZIP ingestion checks CRC without eager unbounded extraction', async () => {
  const zip = new JSZip();
  zip.file('Example.SemanticModel/definition/model.tmdl', 'model Model\n  culture: en-US');
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  await assert.rejects(
    () => artifactsFromPowerBiZip(corruptFirstZipCentralCrc(bytes), 'corrupt-project.zip'),
    /failed its CRC integrity check/i,
  );
});

test('Power BI direct uploads reject oversized files and file counts before reading bytes', async () => {
  let reads = 0;
  const oversized = {
    name: 'oversized.tmdl',
    size: POWER_BI_PROJECT_LIMITS.fileBytes + 1,
    webkitRelativePath: '',
    arrayBuffer: async () => { reads += 1; return new ArrayBuffer(0); },
  } as unknown as File;
  await assert.rejects(() => artifactsFromPowerBiProjectFiles([oversized]), /exceeds.*file limit/i);
  assert.equal(reads, 0);

  const tooMany = Array.from({ length: POWER_BI_PROJECT_LIMITS.files + 1 }, (_, index) => ({
    name: `table-${index}.tmdl`, size: 1, webkitRelativePath: '',
    arrayBuffer: async () => { reads += 1; return new ArrayBuffer(1); },
  } as unknown as File));
  await assert.rejects(() => artifactsFromPowerBiProjectFiles(tooMany), /no more than 1,000/i);
  assert.equal(reads, 0);
});

test('Power BI direct uploads reject cumulative selected size before reading bytes', async () => {
  let reads = 0;
  const files = Array.from({ length: 4 }, (_, index) => ({
    name: `table-${index}.tmdl`, size: POWER_BI_PROJECT_LIMITS.fileBytes,
    webkitRelativePath: '', arrayBuffer: async () => { reads += 1; return new ArrayBuffer(0); },
  } as unknown as File));
  await assert.rejects(() => artifactsFromPowerBiProjectFiles(files), /pre-read limit/i);
  assert.equal(reads, 0);
});

test('Power BI TMDL parsing preserves multiline expressions, culture, and scoped annotations', () => {
  const artifact = artifactFromText('power_bi', [
    'model Model',
    '  culture: en-US',
    '  annotation MigrationOwner = Analytics',
    '',
    'table Sales',
    '  annotation TablePurpose = Revenue',
    '  column Revenue',
    '    dataType: decimal',
    '    sourceColumn: revenue',
    '  column Net Revenue =',
    '    VAR Gross = [Revenue]',
    '    RETURN Gross - 10',
    '  measure Total Revenue =',
    "    VAR Gross = SUM('Sales'[Revenue])",
    '    RETURN Gross',
    '    formatString: $#,0.00',
    '    annotation MetricOwner = Finance',
  ].join('\n'), 'Example.SemanticModel/definition/model.tmdl')!;
  const parsed = parsePowerBiManualArtifacts([artifact]);
  const sales = parsed.inventory.views.find((view) => view.name === 'Sales');
  const measure = sales?.measures.find((item) => item.name === 'Total Revenue');
  const calculatedColumn = sales?.fields.find((item) => item.name === 'Net Revenue');
  const modelEvidence = (parsed as PowerBiManualParseResult & { models?: Array<{ culture?: string; annotations?: Record<string, string> }> }).models?.[0];

  assert.match(measure?.sql || '', /VAR Gross[\s\S]*RETURN Gross/);
  assert.equal(measure?.formatString, '$#,0.00');
  assert.equal(measure?.annotations?.MetricOwner, 'Finance');
  assert.match(calculatedColumn?.sql || '', /VAR Gross[\s\S]*RETURN Gross - 10/);
  assert.equal(sales?.annotations?.TablePurpose, 'Revenue');
  assert.equal(modelEvidence?.culture, 'en-US');
  assert.equal(modelEvidence?.annotations?.MigrationOwner, 'Analytics');
});

test('Power BI TMDL parsing preserves multiline named expressions and warns when assigned expressions are empty', () => {
  const artifact = artifactFromText('power_bi', [
    'expression Warehouse =',
    '  let',
    '    Source = Snowflake.Databases("example.invalid")',
    '  in',
    '    Source',
    '',
    'table Sales',
    '  measure Missing Formula =',
    '    formatString: $#,0.00',
  ].join('\n'), 'Example.SemanticModel/definition/expressions.tmdl')!;
  const parsed = parsePowerBiManualArtifacts([artifact]);
  const expression = parsed.inventory.views.find((view) => view.name === 'Warehouse');

  assert.match(expression?.sql || '', /let[\s\S]*Snowflake\.Databases[\s\S]*Source/);
  assert.match(parsed.diagnostics.warnings.join(' '), /Missing Formula[\s\S]*could not be recovered/i);
});

test('legacy Power BI report containers recover stringified visual queries, type, filters, and layout', () => {
  const config = JSON.stringify({
    name: 'revenue-chart',
    singleVisual: {
      visualType: 'clusteredColumnChart',
      prototypeQuery: { Select: [{ Name: 'Sales.Region' }, { Name: 'Sum(Sales.Total Revenue)' }] },
      vcObjects: { title: [{ properties: { text: { expr: { Literal: { Value: "'Revenue by Region'" } } } } }] },
    },
  });
  const query = JSON.stringify({
    Commands: [{ SemanticQueryDataShapeCommand: { Query: { Select: [
      { Column: { Expression: { SourceRef: { Source: 'Sales' } }, Property: 'Region' }, Name: 'Sales.Region' },
      { Measure: { Expression: { SourceRef: { Source: 'Sales' } }, Property: 'Total Revenue' }, Name: 'Sales.Total Revenue' },
    ] } } }],
  });
  const artifact = artifactFromText('power_bi', JSON.stringify({
    id: 'legacy-report',
    name: 'Legacy Revenue',
    datasetId: 'sales-model',
    sections: [{ id: 'overview', name: 'overview', displayName: 'Overview', visualContainers: [{
      id: 'visual-1', name: 'visual-1', x: 10, y: 20, z: 1, width: 400, height: 240,
      config, query,
      filters: [{ queryRef: 'Sales.Region' }],
    }] }],
  }), 'legacy-report.json')!;
  const parsed = parsePowerBiManualArtifacts([artifact]);
  const report = parsed.projects?.flatMap((project) => project.reports).find((item) => item.id === 'legacy-report');
  const visual = report?.pages[0]?.visuals[0];

  assert.equal(visual?.visualType, 'clusteredColumnChart');
  assert.equal(visual?.title, 'Revenue by Region');
  assert.deepEqual(visual?.fields, ['Sales.Region', 'Sales.Total Revenue']);
  assert.deepEqual(visual?.filters, ['Sales.Region']);
  assert.deepEqual(visual?.position, { x: 10, y: 20, width: 400, height: 240, z: 1 });
});

test('legacy Power BI report reconstruction warns on malformed nested visual JSON without dropping the report', () => {
  const artifact = artifactFromText('power_bi', JSON.stringify({
    id: 'legacy-malformed',
    name: 'Legacy Malformed',
    sections: [{ id: 'overview', displayName: 'Overview', visualContainers: [{
      id: 'broken-visual', x: 0, y: 0, width: 300, height: 200,
      config: '{"singleVisual":',
      query: JSON.stringify({ Select: [{ Name: 'Sales.Revenue' }] }),
    }] }],
  }), 'legacy-malformed.json')!;
  const parsed = parsePowerBiManualArtifacts([artifact]);
  const report = parsed.projects?.flatMap((project) => project.reports).find((item) => item.id === 'legacy-malformed');

  assert.equal(report?.pages[0]?.visuals[0]?.id, 'broken-visual');
  assert.deepEqual(report?.pages[0]?.visuals[0]?.fields, ['Sales.Revenue']);
  assert.match(report?.warnings.join(' ') || '', /malformed nested JSON/i);
});

test('Domo manual parse endpoint is vault-gated, bounded, and audits metadata without source formulas', async () => {
  const locked = await migrationStudioHandler(new Request('http://localhost/api/migration-studio/manual-artifacts/parse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceTool: 'domo', artifacts: [domoManualArtifact()] }),
  }));
  assert.equal(locked.status, 423);

  unlockVault('migration studio passphrase');
  const response = await migrationStudioHandler(new Request('http://localhost/api/migration-studio/manual-artifacts/parse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceTool: 'domo', artifacts: [domoManualArtifact()] }),
  }));
  assert.equal(response.status, 200);
  const payload = await response.json() as { result: { diagnostics: { mappingCount: number } } };
  assert.ok(payload.result.diagnostics.mappingCount >= 5);

  const microStrategyArtifact = artifactFromText('microstrategy', JSON.stringify({
    projects: [{ id: 'project-1', name: 'Private project', status: 0 }],
    cubes: [{ id: 'cube-1', name: 'Private cube', attributes: [{ id: 'a1', name: 'Private attribute', type: 'attribute' }], metrics: [{ id: 'm1', name: 'Private metric', formula: 'Sum(private_value)' }] }],
    dossiers: [{ id: 'd1', name: 'Private dashboard', chapters: [{ pages: [{ visualizations: [{ id: 'v1', name: 'Private visualization', fields: ['Private attribute', 'Private metric'] }] }] }] }],
  }), 'private-microstrategy-export.json')!;
  const microStrategyResponse = await migrationStudioHandler(new Request('http://localhost/api/migration-studio/manual-artifacts/parse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceTool: 'microstrategy', artifacts: [microStrategyArtifact] }),
  }));
  assert.equal(microStrategyResponse.status, 200);
  const microStrategyPayload = await microStrategyResponse.json() as { result: { diagnostics: { mappingCount: number } } };
  assert.ok(microStrategyPayload.result.diagnostics.mappingCount >= 4);

  const powerBiArtifact = artifactFromText('power_bi', JSON.stringify({
    name: 'Private semantic model',
    model: { id: 'private-model', name: 'Private semantic model', tables: [{ name: 'Private orders', columns: [{ name: 'Private revenue', dataType: 'decimal' }], measures: [{ name: 'Private total', expression: 'SUM([Private revenue])' }] }] },
  }), 'private-power-bi-model.bim')!;
  const powerBiResponse = await migrationStudioHandler(new Request('http://localhost/api/migration-studio/manual-artifacts/parse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceTool: 'power_bi', artifacts: [powerBiArtifact] }),
  }));
  assert.equal(powerBiResponse.status, 200);
  const powerBiPayload = await powerBiResponse.json() as { result: { diagnostics: { mappingCount: number } } };
  assert.ok(powerBiPayload.result.diagnostics.mappingCount >= 4);
  const durable = readFileSync(process.env.OMNIKIT_SEMANTIC_MIGRATION_AUDIT_PATH!, 'utf8');
  assert.match(durable, /manual_artifacts_parsed/);
  assert.doesNotMatch(durable, /Gross Margin|SUM\(`Revenue`\)|orders_enriched/);
  assert.doesNotMatch(durable, /Private project|Private cube|Private metric|private_value/);
  assert.doesNotMatch(durable, /Private semantic model|Private orders|Private total|Private revenue/);

  const wrongPlatform = await migrationStudioHandler(new Request('http://localhost/api/migration-studio/manual-artifacts/parse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceTool: 'tableau', artifacts: [domoManualArtifact()] }),
  }));
  assert.equal(wrongPlatform.status, 400);
});

test('prompt and evaluation protocol is versioned with Sigma and WebFOCUS coverage', () => {
  assert.match(SEMANTIC_MIGRATION_PROMPT_VERSION, /^semantic-migration-/);
  assert.ok(SEMANTIC_MIGRATION_EVALUATION_FIXTURES.some((fixture) => fixture.sourcePlatform === 'sigma'));
  assert.ok(SEMANTIC_MIGRATION_EVALUATION_FIXTURES.some((fixture) => fixture.sourcePlatform === 'webfocus'));
});

test('public migration contract covers the supported BI sources and five AI options', () => {
  assert.deepEqual(sourceConnectorDefinitions().map((connector) => connector.platform).sort(), ['domo', 'looker', 'metabase', 'microstrategy', 'power_bi', 'sigma', 'tableau', 'webfocus']);
  const publicProviders = ['openai', 'anthropic', 'snowflake_cortex', 'databricks_genie', 'omni_ai'] as const;
  publicProviders.forEach((kind) => assert.ok(providerCapabilities(kind).supportedTasks.length > 0));
  assert.deepEqual(providerCapabilities('databricks_genie').supportedTasks.sort(), ['evaluate_reconciliation', 'explain_exception', 'generate_validation_sql']);
});

test('public provider guidance is complete, secret-safe, and matches supported authentication modes', () => {
  assert.equal(PUBLIC_MIGRATION_PROVIDER_OPTIONS.length, 5);
  for (const provider of PUBLIC_MIGRATION_PROVIDER_OPTIONS) {
    assert.ok(provider.setupSteps.length >= 4, provider.id);
    assert.ok(provider.prerequisites.length >= 2, provider.id);
    assert.ok(provider.securityNotes.length >= 2, provider.id);
    assert.ok(provider.documentation.every((item) => item.url.startsWith('https://')), provider.id);
    for (const authOption of provider.authOptions) {
      const setup = migrationProviderAuthSetup(provider.id, authOption.id);
      assert.ok(setup.credentialLabel, `${provider.id}/${authOption.id} credential label`);
      assert.ok(setup.storedValueDescription.includes('OmniKit'), `${provider.id}/${authOption.id} storage boundary`);
      assert.ok(setup.setupSteps.length >= 4, `${provider.id}/${authOption.id} setup steps`);
      assert.ok(setup.documentation.length >= 1, `${provider.id}/${authOption.id} documentation`);
      assert.ok(setup.documentation.every((item) => item.url.startsWith('https://')), `${provider.id}/${authOption.id} documentation URLs`);
    }
    assert.doesNotMatch(JSON.stringify(provider), /sk-[a-z0-9]{12,}|bearer\s+[a-z0-9._-]{12,}/i);
  }
  assert.equal(MIGRATION_PROVIDER_GUIDANCE.omni_ai.defaultAuthMode, 'linked_omni_instance');
  assert.equal(MIGRATION_PROVIDER_GUIDANCE.snowflake_cortex.defaultAuthMode, 'programmatic_access_token');
  assert.deepEqual(MIGRATION_PROVIDER_GUIDANCE.databricks_genie.authOptions.map((option) => option.id), ['oauth_access_token', 'personal_access_token']);
  const documentationUrls = PUBLIC_MIGRATION_PROVIDER_OPTIONS.flatMap((provider) => [
    ...provider.documentation.map((item) => item.url),
    ...provider.authOptions.flatMap((option) => migrationProviderAuthSetup(provider.id, option.id).documentation.map((item) => item.url)),
  ]);
  assert.ok(documentationUrls.includes('https://developers.openai.com/api/docs/quickstart'));
  assert.ok(documentationUrls.includes('https://platform.claude.com/docs/en/manage-claude/authentication'));
  assert.ok(documentationUrls.includes('https://docs.snowflake.com/en/user-guide/key-pair-auth'));
  assert.ok(documentationUrls.includes('https://docs.snowflake.com/en/user-guide/oauth-intro'));
  assert.ok(documentationUrls.includes('https://docs.databricks.com/aws/en/genie-agents/conversation-api'));
  assert.doesNotMatch(documentationUrls.join('\n'), /quickstart\/make-your-first-api-request|support\.anthropic\.com|\/gcp\/en\/genie\/conversation-api/);
});

test('Snowflake Cortex uses the documented v2 Chat Completions endpoint', () => {
  unlockVault('snowflake endpoint passphrase');
  const publicProvider = upsertLlmProvider({
    name: 'Snowflake Cortex',
    kind: 'snowflake_cortex',
    model: 'configured-model',
    baseUrl: 'https://account.snowflakecomputing.com',
    credential: 'fixture-pat',
  });
  const provider = getLlmProvider(publicProvider.id)!;
  assert.equal(migrationProviderEndpoint(provider), 'https://account.snowflakecomputing.com/api/v2/cortex/v1/chat/completions');
  assert.equal(snowflakeAuthorizationTokenType('programmatic_access_token'), 'PROGRAMMATIC_ACCESS_TOKEN');
  assert.equal(snowflakeAuthorizationTokenType('oauth_access_token'), 'OAUTH');
  assert.equal(snowflakeAuthorizationTokenType('key_pair_jwt'), 'KEYPAIR_JWT');
});

test('Omni target capability preflight is read-only, blocks unwritable models, and preserves PR handoff', () => {
  const unverified = buildOmniMigrationCapabilityReport({ model: { id: 'model-1', kind: 'SHARED', connectionId: 'connection-1' } });
  assert.equal(unverified.checks.find((check) => check.id === 'branch_write')?.status, 'unverified');
  assert.deepEqual(omniMigrationCapabilityBlockers(unverified, 'semantic_stage'), []);

  const gitFollower = buildOmniMigrationCapabilityReport({ model: { id: 'model-2', kind: 'SHARED', connectionId: 'connection-1', gitFollower: true } });
  assert.equal(gitFollower.checks.find((check) => check.id === 'branch_write')?.status, 'blocked');
  assert.match(omniMigrationCapabilityBlockers(gitFollower, 'semantic_stage').join(' '), /git follower/i);

  const prRequired = buildOmniMigrationCapabilityReport({ model: { id: 'model-3', kind: 'SHARED', connectionId: 'connection-1', pullRequestRequired: true }, yamlLoaded: true });
  assert.equal(prRequired.checks.find((check) => check.id === 'merge')?.status, 'blocked');
  assert.match(omniMigrationCapabilityBlockers(prRequired, 'merge').join(' '), /pull-request workflow/i);

  const verified = buildOmniMigrationCapabilityReport({
    model: { id: 'model-4', kind: 'SHARED', connectionId: 'connection-1' },
    yamlLoaded: true, branchCreated: true, yamlWritten: true, modelValidationRan: true, contentValidationRan: true, aiJobSucceeded: true,
  });
  assert.equal(verified.checks.filter((check) => check.status === 'available').length, 7);
});

test('every source connector produces deterministic dashboard units with dependency coverage', () => {
  const platforms = ['domo', 'power_bi', 'tableau', 'sigma', 'looker', 'metabase', 'webfocus', 'microstrategy'] as const;
  const rootKind = { domo: 'page', power_bi: 'dashboard', tableau: 'workbook', sigma: 'workbook', looker: 'dashboard', metabase: 'dashboard', webfocus: 'repository_item', microstrategy: 'dashboard' } as const;
  platforms.forEach((platform) => {
    const connector = sourceConnectorDefinitions().find((item) => item.platform === platform)!;
    const items: SourceInventoryItem[] = [
      { id: `${platform}-dashboard`, name: `${platform} dashboard`, kind: rootKind[platform], dependencyIds: [`${platform}-model`], featureFlags: [], riskFlags: [], metadata: {} },
      { id: `${platform}-model`, name: `${platform} model`, kind: 'semantic_model', dependencyIds: [], featureFlags: [], riskFlags: [], metadata: {} },
      { id: `${platform}-tile`, name: `${platform} tile`, kind: 'visual', parentId: `${platform}-dashboard`, dependencyIds: [`${platform}-metric`], featureFlags: [], riskFlags: [], metadata: {} },
      { id: `${platform}-metric`, name: `${platform} metric`, kind: 'metric', dependencyIds: [], featureFlags: [], riskFlags: [], metadata: {} },
    ];
    const first = buildSourceDashboardCatalog(platform, items, connector);
    const second = buildSourceDashboardCatalog(platform, items, connector);
    assert.deepEqual(first, second);
    assert.equal(first.length, 1);
    assert.deepEqual(first[0]?.dependencyIds, [`${platform}-metric`, `${platform}-model`, `${platform}-tile`]);
    assert.equal(first[0]?.dependencyCounts.calculation, 1);
  });
});

test('server-fetched API inventory becomes an honest scoped native differential baseline', () => {
  const connector = sourceConnectorDefinitions().find((item) => item.platform === 'metabase')!;
  const items: SourceInventoryItem[] = [
    { id: 'dashboard-1', name: 'NorthstarDashboard', kind: 'dashboard', dependencyIds: ['table-1'], featureFlags: [], riskFlags: [], metadata: {} },
    { id: 'dashboard-2', name: 'Unselected dashboard', kind: 'dashboard', dependencyIds: [], featureFlags: [], riskFlags: [], metadata: {} },
    { id: 'table-1', name: 'northstar_sales', kind: 'dataset', dependencyIds: [], featureFlags: [], riskFlags: [], metadata: {} },
    { id: 'field-1', name: 'business_date', kind: 'attribute', parentId: 'table-1', dependencyIds: [], featureFlags: [], riskFlags: [], metadata: {} },
    { id: 'metric-1', name: 'total_revenue', kind: 'metric', parentId: 'table-1', dependencyIds: [], featureFlags: [], riskFlags: [], metadata: {} },
  ];
  const source: SourceInventoryResult = {
    platform: 'metabase',
    connectionId: 'saved-source',
    connector,
    items,
    dashboardCatalog: buildSourceDashboardCatalog('metabase', items, connector),
    warnings: [],
    truncated: false,
    collection: { scope: 'all_accessible', scopeLabel: 'All accessible content', pagesFetched: 1, parentsExpanded: 0, requestsMade: 1, maxPages: 25, maxItems: 1_000 },
  };
  const baseline = sourceInventoryToMigrationInventory(source, ['dashboard-1']);
  assert.equal(baseline.sourceTool, 'metabase');
  assert.deepEqual(baseline.views.map((view) => view.name), ['northstar_sales']);
  assert.deepEqual(baseline.views[0]?.fields.map((field) => field.name), ['business_date']);
  assert.deepEqual(baseline.views[0]?.measures.map((measure) => measure.name), ['total_revenue']);
  assert.deepEqual(baseline.dashboards.map((dashboard) => dashboard.name), ['NorthstarDashboard']);
  assert.ok(baseline.warnings.some((warning) => /metadata differential baseline/i.test(warning)));
  assert.equal(JSON.stringify(baseline).includes('parityScore'), false);
});

test('direct PBIX comparison uses a separate server-parsed project baseline when supplied', () => {
  assert.equal(buildEngineManualParityBaseline('powerbi', [{ name: 'northstar.pbix', content: new Uint8Array([80, 75, 3, 4]) }]), undefined);
  const modelBim = readFileSync(path.resolve('tests/fixtures/semantic-migrations/power-bi-northstar/northstar-model.bim'), 'utf8');
  const baseline = buildEngineManualParityBaseline('powerbi', [{ name: 'northstar-model.bim', content: modelBim }]);
  assert.ok(baseline);
  assert.ok(baseline.views.length > 0);
  assert.ok(baseline.views.some((view) => view.measures.length > 0));
});

test('inventory continuation preserves provider pagination semantics', () => {
  assert.equal(migrationInventoryNextPageUrl({
    currentUrl: 'https://api.powerbi.com/v1.0/myorg/groups?$top=100&$skip=0',
    payload: { value: [{ id: 'one' }], '@odata.nextLink': 'https://api.powerbi.com/v1.0/myorg/groups?$top=100&$skip=100' },
    style: 'odata', rowsOnPage: 1, pageSize: 100,
  }), 'https://api.powerbi.com/v1.0/myorg/groups?$top=100&$skip=100');
  assert.equal(new URL(migrationInventoryNextPageUrl({
    currentUrl: 'https://api.sigmacomputing.com/v2/workbooks?limit=100',
    payload: { entries: [{ workbookId: 'one' }], nextPage: 'cursor-2' },
    style: 'sigma', rowsOnPage: 1, pageSize: 100,
  })!).searchParams.get('page'), 'cursor-2');
  assert.equal(new URL(migrationInventoryNextPageUrl({
    currentUrl: 'https://tableau.example/api/3.29/sites/site/workbooks?pageSize=100&pageNumber=1',
    payload: { pagination: { pageNumber: 1, pageSize: 100, totalAvailable: 250 }, workbooks: [] },
    style: 'tableau', rowsOnPage: 100, pageSize: 100,
  })!).searchParams.get('pageNumber'), '2');
  assert.equal(new URL(migrationInventoryNextPageUrl({
    currentUrl: 'https://api.domo.com/v1/datasets?limit=100&offset=0',
    payload: Array.from({ length: 100 }, (_, id) => ({ id })),
    style: 'offset', rowsOnPage: 100, pageSize: 100,
  })!).searchParams.get('offset'), '100');
});

test('migration coverage requires an explicit acknowledgement and takes the least complete engine evidence', () => {
  const rows = migrationCapabilityCoverageRows({
    engineCoverage: { artifact_coverage: { models: 'full', views: 'full', fields: 'partial', dashboards: 'full', tiles: 'partial', filters: 'full', layout: 'unsupported', permissions: 'unsupported', schedules: 'unsupported' } },
  });
  assert.equal(rows.find((row) => row.id === 'semantic_objects')?.status, 'partial');
  assert.equal(rows.find((row) => row.id === 'dashboards')?.status, 'partial');
  assert.equal(rows.find((row) => row.id === 'layout')?.status, 'unsupported');
  assert.equal(migrationCapabilityAcknowledgementRequired(rows), true);
});

test('every supported BI source exposes a complete conservative coverage matrix', () => {
  const sources: MigrationSourceTool[] = ['domo', 'looker', 'metabase', 'microstrategy', 'power_bi', 'sigma', 'tableau', 'webfocus'];
  for (const sourcePlatform of sources) {
    const rows = migrationCapabilityCoverageRows({
      sourcePlatform: sourcePlatform as Exclude<MigrationSourceTool, 'dbt'>,
      sourceMode: 'manual',
    });
    assert.equal(rows.length, 6, `${sourcePlatform} should disclose every coverage class`);
    assert.equal(migrationCapabilityAcknowledgementRequired(rows), true);
    assert.ok(rows.every((row) => row.evidenceClasses.includes(`manual ${sourcePlatform} baseline`)));
  }
});

test('coverage uses the least complete source, connector, and engine evidence', () => {
  const rows = migrationCapabilityCoverageRows({
    sourcePlatform: 'looker',
    sourceMode: 'api',
    connectorCoverage: {
      semantic_objects: 'full',
      dashboards: 'full',
      filters: 'full',
      layout: 'full',
      permissions: 'unsupported',
      schedules: 'unsupported',
    },
    engineCoverage: {
      artifact_coverage: {
        models: 'full',
        views: 'partial',
        dashboards: 'full',
        tiles: 'full',
        filters: 'full',
        layout: 'full',
        permissions: 'full',
        schedules: 'full',
      },
    },
  });
  assert.equal(rows.find((row) => row.id === 'semantic_objects')?.status, 'partial');
  assert.equal(rows.find((row) => row.id === 'dashboards')?.status, 'partial');
  assert.equal(rows.find((row) => row.id === 'permissions')?.status, 'unsupported');
});

test('migration source sessions change with acquisition route and inventory revision', () => {
  const manualDomo = migrationSourceSessionKey({
    sourceMode: 'manual',
    manualSourcePlatform: 'domo',
  });
  const manualLooker = migrationSourceSessionKey({
    sourceMode: 'manual',
    manualSourcePlatform: 'looker',
  });
  const unloadedApi = migrationSourceSessionKey({
    sourceMode: 'api',
    manualSourcePlatform: 'domo',
    sourceConnectionId: 'source-1',
  });
  const loadedInventory = {
    platform: 'domo',
    connectionId: 'source-1',
    connector: {},
    items: [{ id: 'dashboard-1', kind: 'dashboard', dependencyIds: [] }],
    dashboardCatalog: [],
    warnings: [],
    truncated: false,
  } as unknown as ClientSourceInventory;
  const loadedApi = migrationSourceSessionKey({
    sourceMode: 'api',
    manualSourcePlatform: 'domo',
    sourceConnectionId: 'source-1',
    sourceInventory: loadedInventory,
  });
  const revisedApi = migrationSourceSessionKey({
    sourceMode: 'api',
    manualSourcePlatform: 'domo',
    sourceConnectionId: 'source-1',
    sourceInventory: {
      ...loadedInventory,
      items: [...loadedInventory.items, { id: 'model-1', kind: 'semantic_model', dependencyIds: [] }],
    },
  });

  assert.notEqual(manualDomo, manualLooker);
  assert.notEqual(manualDomo, unloadedApi);
  assert.notEqual(unloadedApi, loadedApi);
  assert.notEqual(loadedApi, revisedApi);
});

test('workflow readiness is sequential and exposes the active blocker', () => {
  const sourceOnly = deriveBiMigrationWorkflowProgress({
    activeStep: 'evidence',
    ready: {
      source: true,
      evidence: false,
      destination: true,
      analyze: false,
      resolve: false,
      validate: false,
      build: false,
    },
    blockers: {
      evidence: ['Add source evidence.'],
    },
  });
  assert.deepEqual(sourceOnly.completedSteps, ['source']);
  assert.equal(sourceOnly.highestAvailableStep, 'evidence');
  assert.equal(sourceOnly.readinessMessage, 'Add source evidence.');
  assert.deepEqual(sourceOnly.currentStepBlockers, ['Add source evidence.']);

  const throughAnalyze = deriveBiMigrationWorkflowProgress({
    activeStep: 'analyze',
    ready: {
      source: true,
      evidence: true,
      destination: true,
      analyze: true,
      resolve: false,
      validate: false,
      build: false,
    },
    blockers: {},
  });
  assert.deepEqual(throughAnalyze.completedSteps, ['source', 'evidence', 'destination', 'analyze']);
  assert.equal(throughAnalyze.highestAvailableStep, 'resolve');
  assert.equal(throughAnalyze.readinessMessage, 'Analyze ready');
});

test('provider completion enters validation before a migration plan can be accepted', () => {
  assert.equal(migrationPlanningStatusFromJob('queued'), 'queued');
  assert.equal(migrationPlanningStatusFromJob('running'), 'running');
  assert.equal(migrationPlanningStatusFromJob('succeeded'), 'validating');
  assert.equal(migrationPlanningStatusFromJob('failed'), 'failed');
  assert.equal(migrationPlanningStatusFromJob('cancelled'), 'cancelled');
});

test('migration plan repair instructions are bounded and preserve contract issues', () => {
  const issues = Array.from({ length: 25 }, (_, index) => `Missing required dependency ${index + 1}`);
  const instruction = migrationPlanRepairInstruction(issues);
  assert.match(instruction, /one bounded repair attempt/i);
  assert.match(instruction, /Missing required dependency 1/);
  assert.match(instruction, /Missing required dependency 20/);
  assert.doesNotMatch(instruction, /Missing required dependency 21/);

  const error = new MigrationPlanContractError('Power BI planning chunk 1 of 1', issues);
  assert.equal(error.issues.length, 20);
  assert.match(error.message, /did not pass the required contract/i);
});

test('extraction status explains native, managed, fallback, and awaiting-evidence paths', () => {
  const base = {
    sourcePlatform: 'looker' as const,
    sourceLabel: 'Looker',
    sourceMode: 'manual' as const,
    managedMode: 'shadow' as const,
    engineName: 'omni-migrator',
    engineVersion: '1.2.3',
  };
  assert.equal(migrationExtractionStatus({
    ...base,
    hasEvidence: false,
    nativeEvidenceReady: false,
    managedPathEligible: false,
    engineStatus: 'idle',
  }).state, 'awaiting_evidence');
  assert.equal(migrationExtractionStatus({
    ...base,
    hasEvidence: true,
    nativeEvidenceReady: true,
    managedPathEligible: false,
    engineStatus: 'idle',
  }).state, 'native_ready');
  assert.equal(migrationExtractionStatus({
    ...base,
    hasEvidence: true,
    nativeEvidenceReady: true,
    managedPathEligible: true,
    engineStatus: 'ready',
  }).state, 'managed_ready');
  const fallback = migrationExtractionStatus({
    ...base,
    hasEvidence: true,
    nativeEvidenceReady: true,
    managedPathEligible: true,
    engineStatus: 'fallback',
    engineError: 'Managed extraction unavailable.',
  });
  assert.equal(fallback.state, 'fallback');
  assert.equal(fallback.badge, 'Native fallback');
});

test('planning progress names phases, bounded dashboard context, and duplicate-safe monitoring', () => {
  assert.equal(migrationPlanningPhaseLabel('queued', 'analyze'), 'Waiting for the AI provider');
  assert.equal(migrationPlanningPhaseLabel('repairing', 'repair'), 'Repairing the migration plan');
  assert.equal(migrationPlanningPhaseLabel('validating', 'analyze'), 'Validating the provider response');
  assert.equal(migrationPlanningContextLabel({
    chunkIndex: 2,
    chunkTotal: 4,
    dashboardNames: ['Executive Overview', 'Pipeline', 'Retention', 'Operations'],
  }), 'Evidence chunk 2 of 4 · Executive Overview, Pipeline, Retention +1 more');
  assert.match(migrationPlanningDurationGuidance(5), /never submits a duplicate job/i);
  assert.match(migrationPlanningDurationGuidance(45), /resume monitoring the same job/i);
});

test('dashboard dependency closure follows explicit, metadata, and contained-content references', () => {
  const items: SourceInventoryItem[] = [
    { id: 'dashboard', name: 'Dashboard', kind: 'dashboard', dependencyIds: ['model'], featureFlags: [], riskFlags: [], metadata: {} },
    { id: 'model', name: 'Model', kind: 'semantic_model', dependencyIds: [], featureFlags: [], riskFlags: [], metadata: {} },
    { id: 'tile', name: 'Tile', kind: 'visual', parentId: 'dashboard', dependencyIds: [], featureFlags: [], riskFlags: [], metadata: { datasetId: 'dataset' } },
    { id: 'dataset', name: 'Dataset', kind: 'dataset', dependencyIds: [], featureFlags: [], riskFlags: [], metadata: {} },
  ];
  assert.deepEqual(sourceDashboardDependencyClosure('dashboard', items), ['dataset', 'model', 'tile']);
});

test('Databricks Genie is blocked from semantic generation before any outbound request', async () => {
  unlockVault('migration studio passphrase');
  const provider = upsertLlmProvider({
    name: 'Validation Genie',
    kind: 'databricks_genie',
    model: 'space-1',
    baseUrl: 'https://example.cloud.databricks.com',
    credential: 'dapi-secret',
  });
  await assert.rejects(() => generateStructuredProposal(provider, {
    task: 'draft_semantic_patch',
    system: 'system',
    prompt: 'prompt',
    schemaName: 'test',
    schema: { type: 'object' },
  }), /does not support/i);
});

test('WebFOCUS classifies metadata and requires report procedure evidence for readiness', () => {
  const metadata = artifactFromText('webfocus', 'FILENAME=SALES, SUFFIX=FOC\\nFIELDNAME=ORDER_ID, ALIAS=ORDER_ID, USAGE=I11$', 'SALES.mas');
  const procedure = artifactFromText('webfocus', 'TABLE FILE SALES\\nSUM REVENUE\\nBY REGION\\nWHERE STATUS EQ ACTIVE\\nEND', 'SALES_DASHBOARD.fex');
  assert.ok(metadata);
  assert.ok(procedure);
  assert.equal(metadata.kind, 'metadata');
  assert.equal(procedure.kind, 'dashboard');

  const metadataInventory = buildMigrationInventory('webfocus', [metadata]);
  const metadataOnly = webFocusManualEvidenceReview([metadata], metadataInventory);
  assert.equal(metadataOnly.hasMetadataEvidence, true);
  assert.equal(metadataOnly.ready, false);
  assert.match(metadataOnly.blockers[0] || '', /\.fex procedure/i);

  const completeInventory = buildMigrationInventory('webfocus', [metadata, procedure]);
  const complete = webFocusManualEvidenceReview([metadata, procedure], completeInventory);
  assert.equal(complete.ready, true);
  assert.equal(complete.dashboardEvidenceCount, 1);
  assert.equal(complete.blockers.length, 0);
});

test('MicroStrategy exports normalize reports, cubes, attributes, and metrics', () => {
  const artifact = artifactFromText('microstrategy', JSON.stringify({
    reports: [{ id: 'r1', name: 'Executive Revenue', type: 'report', metrics: [{ id: 'm1', name: 'Margin', formula: 'Revenue-Cost' }], attributes: [{ id: 'a1', name: 'Region' }] }],
    cubes: [{ id: 'c1', name: 'Revenue Cube' }],
    dashboards: [{ id: 'd1', name: 'Leadership Dossier' }],
  }), 'microstrategy-export.json');
  assert.ok(artifact);
  const inventory = buildMigrationInventory('microstrategy', [artifact!]);
  assert.ok(inventory.views.some((view) => view.name === 'Revenue Cube'));
  assert.ok(inventory.dashboards.some((dashboard) => dashboard.name === 'Leadership Dossier'));
  assert.ok(inventory.metrics.some((metric) => metric.name === 'Margin'));
});

test('curation excludes deferred and retired source assets from the canonical graph', () => {
  const items = [
    { id: 'keep', name: 'Keep', kind: 'report' as const, dependencyIds: [], featureFlags: [], riskFlags: [], metadata: {} },
    { id: 'later', name: 'Later', kind: 'dashboard' as const, dependencyIds: [], featureFlags: [], riskFlags: [], metadata: {} },
    { id: 'retire', name: 'Retire', kind: 'workbook' as const, dependencyIds: [], featureFlags: [], riskFlags: [], metadata: {} },
  ];
  const scoped = scopedSourceInventoryItems(items, {
    later: { assetId: 'later', disposition: 'defer', wave: 'Wave 2' },
    retire: { assetId: 'retire', disposition: 'retire', wave: '' },
  });
  assert.deepEqual(scoped.map((item) => item.id), ['keep']);
  const canonical = buildCanonicalBiModel({ sourceTool: 'power_bi', artifactCount: 0, artifacts: [], views: [], explores: [], relationships: [], dashboards: [], metrics: [], warnings: [], summary: '' }, scoped);
  assert.deepEqual(canonical.nodes.map((node) => node.name), ['Keep']);
});

test('compatible decisions reuse only an approved exact compatibility key', () => {
  const decisions = normalizeMigrationDecisions([
    { id: 'one', nodeId: 'field:a', domain: 'field', sourceLabel: 'A', action: 'map_existing', targetId: 'orders.a', rationale: 'same field', confidence: 1, compatibilityKey: 'field:a' },
    { id: 'two', nodeId: 'field:a:second', domain: 'field', sourceLabel: 'A', action: 'defer', rationale: 'review', confidence: 0, compatibilityKey: 'field:a' },
    { id: 'three', nodeId: 'measure:a', domain: 'measure', sourceLabel: 'A', action: 'defer', rationale: 'different domain', confidence: 0, compatibilityKey: 'field:a' },
  ]);
  decisions[0]!.approvedByUser = true;
  const reused = applyDecisionToCompatibleTargets(decisions, 'one');
  assert.equal(reused[1]?.action, 'map_existing');
  assert.equal(reused[1]?.approvedByUser, true);
  assert.equal(reused[2]?.action, 'defer');
});

test('semantic compilation preserves untouched YAML and is byte-stable', () => {
  const current = { 'orders.view': 'schema: analytics\ndescription: Existing\ndimensions:\n  id:\n    sql: ${TABLE}.id\n' };
  const generated = [{ id: 'g1', fileName: 'orders.view' as const, yaml: 'measures:\n  revenue:\n    sql: SUM(${TABLE}.revenue)\n', source: 'semantic-migration' as const }];
  const first = mergeGeneratedSemanticFiles(generated, current);
  const second = mergeGeneratedSemanticFiles(generated, current);
  assert.equal(first[0]?.yaml, second[0]?.yaml);
  assert.match(first[0]?.yaml || '', /description: Existing/);
  assert.match(first[0]?.yaml || '', /revenue/);

  const decisions = normalizeMigrationDecisions([{ id: 'create', nodeId: 'measure:revenue', domain: 'measure', sourceLabel: 'Revenue', action: 'create_new', targetFileName: 'orders.view', proposedCode: generated[0]?.yaml, rationale: 'missing', confidence: 0.9 }]);
  decisions[0]!.approvedByUser = true;
  assert.equal(compileApprovedDecisionPackage(decisions, current, { 'orders.view': 'sum' }).patches[0]?.baseChecksum, 'sum');
});

test('semantic package merge is additive unless an existing definition rewrite is approved', () => {
  const current = { 'orders.view': 'schema: analytics\nmeasures:\n  revenue:\n    sql: SUM(${TABLE}.revenue)\n' };
  const changed = [{ id: 'changed', fileName: 'orders.view' as const, yaml: 'measures:\n  revenue:\n    sql: SUM(${TABLE}.net_revenue)\n', source: 'semantic-migration' as const }];
  assert.throws(() => mergeGeneratedSemanticFiles(changed, current), /would change existing measure "revenue"/i);

  const approved = mergeGeneratedSemanticFiles(changed, current, {
    allowDefinitionOverwrite: (fileName, section, definitionName) => fileName === 'orders.view' && section === 'measures' && definitionName === 'revenue',
  });
  assert.match(approved[0]?.yaml || '', /net_revenue/);

  const identical = mergeGeneratedSemanticFiles([{ id: 'same', fileName: 'orders.view' as const, yaml: 'measures:\n  revenue:\n    sql: SUM(${TABLE}.revenue)\n', source: 'semantic-migration' as const }], current);
  assert.match(identical[0]?.yaml || '', /SUM\(\$\{TABLE\}\.revenue\)/);

  const additive = mergeGeneratedSemanticFiles([{ id: 'new', fileName: 'orders.view' as const, yaml: 'measures:\n  margin:\n    sql: SUM(${TABLE}.margin)\n', source: 'semantic-migration' as const }], current);
  assert.match(additive[0]?.yaml || '', /revenue/);
  assert.match(additive[0]?.yaml || '', /margin/);
});

test('canonical assets compile into deterministic reviewed Omni target specs', () => {
  const canonical = buildCanonicalBiModel({ sourceTool: 'power_bi', artifactCount: 0, artifacts: [], views: [], explores: [], relationships: [], dashboards: [], metrics: [], warnings: [], summary: '' }, [
    { id: 'dash-1', name: 'Executive', kind: 'dashboard', dependencyIds: ['model-1'], featureFlags: [], riskFlags: [], metadata: {} },
    { id: 'schedule-1', name: 'Monday delivery', kind: 'schedule', dependencyIds: ['dash-1'], featureFlags: [], riskFlags: [], metadata: {} },
  ]);
  const dashboardNode = canonical.nodes.find((node) => node.kind === 'dashboard')!;
  const decisions = normalizeMigrationDecisions([{ id: 'map-dashboard', nodeId: dashboardNode.id, domain: 'content', sourceLabel: 'Executive', action: 'create_new', rationale: 'migrate', confidence: 1 }]);
  decisions[0]!.approvedByUser = true;
  const first = compileOmniMigrationDeliverables(canonical, decisions);
  const second = compileOmniMigrationDeliverables(canonical, decisions);
  assert.deepEqual(first, second);
  assert.equal(first.find((item) => item.kind === 'dashboard')?.operation, 'create');
  assert.equal(first.find((item) => item.kind === 'schedule')?.operation, 'skip');
});

test('typed dashboard plans preserve out-of-scope rows so validation can reject them', () => {
  const selected = [{ id: 'dash-1', name: 'Executive', kind: 'dashboard' as const, dependencyIds: ['model-1'], dependencies: [], dependencyCounts: {}, complexity: 'low' as const, coverage: 'partial' as const, coverageNotes: ['Export required'], riskFlags: [] }];
  const plans = normalizeDashboardBuildPlans([{ sourceDashboardId: 'dash-1', targetName: 'Executive in Omni', tiles: [{ title: 'Revenue', visualType: 'bar', fields: ['orders.revenue'] }] }, { sourceDashboardId: 'not-selected', targetName: 'Ignore' }], selected);
  assert.equal(plans.length, 2);
  assert.equal(plans[0]?.targetName, 'Executive in Omni');
  assert.equal(plans[0]?.tiles[0]?.visualType, 'bar');
  assert.deepEqual(plans[0]?.dependencyIds, ['model-1']);
  assert.equal(plans[1]?.sourceDashboardId, 'not-selected');
});

test('dashboard plan normalization preserves duplicates and leaves missing plans missing', () => {
  const selected = [{ id: 'dash-1', name: 'Executive', kind: 'dashboard' as const, dependencyIds: [], dependencies: [], dependencyCounts: {}, complexity: 'low' as const, coverage: 'complete' as const, coverageNotes: [], riskFlags: [] }];
  const duplicates = normalizeDashboardBuildPlans([
    { sourceDashboardId: 'dash-1', targetName: 'First', tiles: [{ title: 'Revenue', fields: ['orders.revenue'] }] },
    { sourceDashboardId: 'dash-1', targetName: 'Second', tiles: [{ title: 'Orders', fields: ['orders.count'] }] },
  ], selected);
  const missing = normalizeDashboardBuildPlans([], selected);
  assert.equal(duplicates.length, 2);
  assert.deepEqual(duplicates.map((plan) => plan.targetName), ['First', 'Second']);
  assert.deepEqual(missing, []);
  const duplicateChecks = buildMigrationPreparationValidationChecks({ decisions: [], selectedDashboards: selected, dashboardPlans: duplicates });
  const missingChecks = buildMigrationPreparationValidationChecks({ decisions: [], selectedDashboards: selected, dashboardPlans: missing });
  assert.equal(duplicateChecks.find((check) => check.id === 'dashboard_bindings')?.status, 'failed');
  assert.equal(missingChecks.find((check) => check.id === 'dashboard_bindings')?.status, 'failed');
});

test('raw dashboard-plan contracts fail before normalization can add defaults', () => {
  const selected = [{ id: 'dash-1', name: 'Executive', kind: 'dashboard' as const, dependencyIds: ['model-1'], dependencies: [], dependencyCounts: {}, complexity: 'low' as const, coverage: 'complete' as const, coverageNotes: [], riskFlags: [] }];
  const valid = {
    id: 'plan-1', sourceDashboardId: 'dash-1', sourceEvidenceIds: ['dash-1'], dependencyIds: ['model-1'], targetName: 'Executive', targetFolderPath: null, description: null,
    filters: [], unsupportedFeatures: [], validationAssertions: [],
    tiles: [{ id: 'tile-1', title: 'Revenue', description: null, sourceEvidenceIds: ['powerbi:visual:one'], fields: ['Sales.Revenue'], filters: [], visualType: 'bar', buildInstructions: 'Build revenue.', validationAssertions: [] }],
  };
  assert.deepEqual(rawDashboardBuildPlanContractIssues([valid], selected), []);
  const malformed = { ...valid, id: '', sourceEvidenceIds: [], dependencyIds: [], tiles: [{ ...valid.tiles[0], id: '', fields: [] }] };
  const malformedIssues = rawDashboardBuildPlanContractIssues([malformed], selected).join(' ');
  assert.match(malformedIssues, /missing id/i);
  assert.match(malformedIssues, /does not include dash-1/i);
  assert.match(malformedIssues, /omits required dependencies/i);
  assert.match(malformedIssues, /at least one field/i);
  assert.match(rawDashboardBuildPlanContractIssues([valid, { ...valid, id: 'plan-2' }], selected).join(' '), /Duplicate dashboard plans/i);

  const duplicateIds = {
    ...valid,
    filters: [
      { id: 'region', label: 'Region', sourceField: 'Sales.Region', targetField: null, required: true },
      { id: 'region', label: 'Region duplicate', sourceField: 'Sales.Region', targetField: null, required: true },
    ],
    tiles: [
      { ...valid.tiles[0], id: 'tile-1', filters: ['region'] },
      { ...valid.tiles[0], id: 'tile-1', sourceEvidenceIds: ['powerbi:visual:two'], filters: ['missing-filter'] },
    ],
  };
  const identityIssues = rawDashboardBuildPlanContractIssues([duplicateIds], selected).join(' ');
  assert.match(identityIssues, /repeats filter ids: region/i);
  assert.match(identityIssues, /repeats tile ids: tile-1/i);
  assert.match(identityIssues, /undeclared filters: missing-filter/i);

  const secondDashboard = { ...selected[0]!, id: 'dash-2', name: 'Operations' };
  assert.match(rawDashboardBuildPlanContractIssues([
    valid,
    { ...valid, sourceDashboardId: 'dash-2', sourceEvidenceIds: ['dash-2'] },
  ], [selected[0]!, secondDashboard]).join(' '), /repeats plan id plan-1/i);
});

test('dashboard-plan scope requires each visual once and every field to have provenance', () => {
  const selected = [{ id: 'report-1', name: 'Executive', kind: 'report' as const, dependencyIds: [], dependencies: [], dependencyCounts: {}, complexity: 'low' as const, coverage: 'complete' as const, coverageNotes: [], riskFlags: [] }];
  const catalog = { expectedVisualIds: ['powerbi:visual:one'], fieldsByVisualId: { 'powerbi:visual:one': ['Sales.Revenue'] } };
  const duplicatePlans = normalizeDashboardBuildPlans([{
    sourceDashboardId: 'report-1', targetName: 'Executive', tiles: [
      { title: 'Revenue one', fields: ['Sales.Revenue'], sourceEvidenceIds: ['powerbi:visual:one'] },
      { title: 'Revenue two', fields: ['Sales.Revenue'], sourceEvidenceIds: ['powerbi:visual:one'] },
    ],
  }], selected);
  assert.match(dashboardPlanScopeIssues(duplicatePlans, selected, catalog.expectedVisualIds, catalog).join(' '), /Duplicate visual plan evidence/i);

  const invented = normalizeDashboardBuildPlans([{ sourceDashboardId: 'report-1', targetName: 'Executive', tiles: [{ title: 'Revenue', fields: ['Sales.Not Real'], sourceEvidenceIds: ['powerbi:visual:one'] }] }], selected);
  assert.match(dashboardPlanScopeIssues(invented, selected, catalog.expectedVisualIds, catalog).join(' '), /unproven field Sales\.Not Real/i);
  const approved = [{ id: 'decision-1', nodeId: 'field:sales.revenue', domain: 'field' as const, sourceLabel: 'Sales.Revenue', targetLabel: 'sales.net_revenue', action: 'map_existing' as const, rationale: 'Approved mapping', confidence: 1, evidence: [], blocking: true, impactAssetIds: ['report-1'], validationRequired: true, approvedByUser: true }];
  const mapped = normalizeDashboardBuildPlans([{ sourceDashboardId: 'report-1', targetName: 'Executive', tiles: [{ title: 'Revenue', fields: ['sales.net_revenue'], sourceEvidenceIds: ['powerbi:visual:one'] }] }], selected);
  assert.deepEqual(dashboardPlanScopeIssues(mapped, selected, catalog.expectedVisualIds, catalog, approved), []);

  const canonicalModel = buildCanonicalSemanticModel({
    sourceTool: 'power_bi', artifactCount: 0, artifacts: [], explores: [], relationships: [], dashboards: [], metrics: [], warnings: [], summary: 'canonical field evidence',
    views: [{ name: 'Sales', warnings: [], fields: [{ name: 'Canonical Only', sourceArtifact: 'model.tmdl' }], measures: [] }],
  });
  const canonical = { fieldsByDashboardId: { 'report-1': canonicalFieldEvidenceReferences(canonicalModel) } };
  const canonicalOnly = normalizeDashboardBuildPlans([{ sourceDashboardId: 'report-1', targetName: 'Executive', tiles: [{ title: 'Canonical', fields: ['Sales.Canonical Only'], sourceEvidenceIds: ['powerbi:visual:one'] }] }], selected);
  assert.deepEqual(dashboardPlanScopeIssues(canonicalOnly, selected, catalog.expectedVisualIds, catalog, [], canonical), []);
  assert.match(dashboardPlanScopeIssues(invented, selected, catalog.expectedVisualIds, catalog, [], canonical).join(' '), /unproven field Sales\.Not Real/i);
});

test('dashboard planning chunks deduplicate identical filters and reject conflicting identities', () => {
  const selected = [{ id: 'report-1', name: 'Executive', kind: 'report' as const, dependencyIds: [], dependencies: [], dependencyCounts: {}, complexity: 'low' as const, coverage: 'complete' as const, coverageNotes: [], riskFlags: [] }];
  const first = normalizeDashboardBuildPlans([{
    sourceDashboardId: 'report-1', targetName: 'Executive', filters: [{ id: 'region', label: 'Region', sourceField: 'Sales.Region' }],
    tiles: [{ id: 'tile-1', title: 'Revenue', fields: ['Sales.Revenue'], filters: ['region'], sourceEvidenceIds: ['powerbi:visual:one'] }],
  }], selected);
  const second = normalizeDashboardBuildPlans([{
    sourceDashboardId: 'report-1', targetName: 'Executive', filters: [{ id: 'region', label: 'Region', sourceField: 'Sales.Region' }],
    tiles: [{ id: 'tile-2', title: 'Orders', fields: ['Sales.Orders'], filters: ['region'], sourceEvidenceIds: ['powerbi:visual:two'] }],
  }], selected);
  assert.equal(mergeDashboardBuildPlanChunks([first, second])[0]?.filters.length, 1);

  const conflicting = normalizeDashboardBuildPlans([{
    sourceDashboardId: 'report-1', targetName: 'Executive', filters: [{ id: 'region', label: 'Region', sourceField: 'Sales.Territory' }],
    tiles: [{ id: 'tile-3', title: 'Margin', fields: ['Sales.Margin'], filters: ['region'], sourceEvidenceIds: ['powerbi:visual:three'] }],
  }], selected);
  assert.throws(() => mergeDashboardBuildPlanChunks([first, conflicting]), /conflicting definitions for filter region/i);
});

test('manual Power BI reports become selectable dashboard units and deterministic build queue items', () => {
  const root = path.resolve('tests/fixtures/semantic-migrations/power-bi-northstar-pbip');
  const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')) as { artifacts: string[] };
  const artifacts = manifest.artifacts.map((fileName) => artifactFromText('power_bi', readFileSync(path.join(root, fileName), 'utf8'), fileName)!);
  const parsed = parsePowerBiManualArtifacts(artifacts);
  const catalog = powerBiManualDashboardCatalog(parsed);
  const plans = normalizeDashboardBuildPlans([{
    sourceDashboardId: catalog[0]?.id,
    targetName: 'NorthstarDashboard',
    filters: [{ label: 'Region', sourceField: 'Locations.Region' }],
    tiles: [
      { title: 'Revenue by Daypart', visualType: 'clusteredColumnChart', fields: ['Sales.Daypart', 'Sales.Total Revenue'] },
      { title: 'Total Revenue', visualType: 'card', fields: ['Sales.Total Revenue'] },
    ],
  }], catalog);
  const bundle = createMigrationBundle({ sourceInventory: null, sourcePlatform: 'power_bi', sourceDashboardCatalog: catalog, selectedDashboardIds: [catalog[0]!.id], dashboardPlans: plans, branchName: 'migration/northstardashboard', decisions: [], semanticFiles: [] });
  const queue = createDashboardBuildQueue(bundle.bundleId, plans);

  assert.equal(catalog.length, 1);
  assert.equal(catalog[0]?.name, 'NorthstarDashboard');
  assert.equal(catalog[0]?.coverage, 'complete');
  assert.equal(catalog[0]?.dependencyCounts.content, 2);
  assert.ok(catalog[0]?.dependencyIds.some((id) => id.includes('sales_total_revenue')));
  assert.equal(plans.length, 1);
  assert.equal(plans[0]?.tiles.length, 2);
  assert.deepEqual(bundle.source.selectedDashboardIds, [catalog[0]!.id]);
  assert.equal(bundle.source.platform, 'power_bi');
  assert.equal(queue[0]?.sourceDashboardName, 'NorthstarDashboard');
  assert.equal(queue[0]?.status, 'queued');
});

test('Power BI AI prompts default to normalized evidence and require explicit raw-snippet opt in', () => {
  const inventory = {
    sourceTool: 'power_bi' as const,
    artifactCount: 1,
    artifacts: [artifactFromText('power_bi', 'RAW_PRIVATE_MARKER apiKey=do-not-send', 'private-model.bim')!],
    views: [{ name: 'Sales', fields: [{ name: 'Revenue', type: 'decimal' }], measures: [{ name: 'Total Revenue', sql: 'SUM(Sales[Revenue])', aggregateType: 'DAX' }], warnings: [] }],
    explores: [],
    relationships: [],
    dashboards: [{ name: 'Executive', fields: ['Sales.Total Revenue'], filters: [] }],
    metrics: [{ name: 'Total Revenue', sql: 'SUM(Sales[Revenue])', aggregateType: 'DAX' }],
    warnings: [],
    summary: '1 table · 1 DAX measure · 1 report',
  };
  const defaultPlan = buildSemanticMigrationPlanPrompt({ inventory, modelName: 'Sales', modelId: 'model-1', adminGoal: '' });
  const defaultPackage = buildSemanticMigrationPackagePrompt({ inventory, modelName: 'Sales', modelId: 'model-1', adminGoal: '', confirmedPlan: 'Approved.' });
  const optedIn = buildSemanticMigrationPlanPrompt({ inventory, modelName: 'Sales', modelId: 'model-1', adminGoal: '', includeRawSourceSnippets: true });

  assert.match(defaultPlan, /AI evidence mode: normalized/);
  assert.match(defaultPlan, /SUM\(Sales\[Revenue\]\)/);
  assert.doesNotMatch(defaultPlan, /RAW_PRIVATE_MARKER|do-not-send/);
  assert.doesNotMatch(defaultPackage, /RAW_PRIVATE_MARKER|do-not-send/);
  assert.match(optedIn, /AI evidence mode: normalized_and_raw/);
  assert.match(optedIn, /RAW_PRIVATE_MARKER/);
  assert.doesNotMatch(optedIn, /do-not-send/);
  assert.match(optedIn, /apiKey=\[redacted\]/);
  const disclosure = semanticMigrationAiEvidenceSummary(inventory);
  assert.equal(disclosure.mode, 'normalized');
  assert.deepEqual(disclosure.providerCategories, ['semantic objects', 'expressions', 'relationships', 'report fields', 'filters', 'parser warnings']);
  assert.deepEqual(disclosure.artifactCategories, ['metadata']);
  assert.equal(disclosure.rawArtifactCount, 0);
  assert.ok(disclosure.approximatePayloadCharacters > 0);
  assert.match(disclosure.redaction, /identity|principal|PII/i);
  assert.equal(disclosure.perArtifactCharacterLimit, 0);
  assert.equal(disclosure.totalRawCharacterLimit, 0);
});

test('Power BI raw prompt snippets remove principal identities and disclose identity redaction', () => {
  const inventory: MigrationInventory = {
    sourceTool: 'power_bi',
    artifactCount: 1,
    artifacts: [artifactFromText('power_bi', JSON.stringify({
      workspaces: [{
        name: 'Finance',
        users: [{ displayName: 'Private Person', emailAddress: 'private.person@example.com', principalId: '6f9619ff-8b86-d011-b42d-00cf4fc964ff' }],
      }],
      apiKey: 'do-not-send',
    }), 'workspace-scan.json')!],
    views: [], explores: [], relationships: [], dashboards: [], metrics: [], warnings: [], summary: 'Workspace scanner export',
  };
  const prompt = buildSemanticMigrationPlanPrompt({ inventory, modelName: 'Finance', modelId: 'model-1', adminGoal: '', includeRawSourceSnippets: true });
  const disclosure = semanticMigrationAiEvidenceSummary(inventory, true);

  assert.doesNotMatch(prompt, /Private Person|private\.person@example\.com|6f9619ff-8b86-d011-b42d-00cf4fc964ff|do-not-send/);
  assert.match(prompt, /identity|principal|PII/i);
  assert.match(disclosure.redaction, /identity|principal|PII/i);
});

test('Power BI normalized prompt evidence redacts PII-shaped names, descriptions, and warnings', () => {
  const email = 'private.person@example.com';
  const identityId = '123e4567-e89b-42d3-a456-426614174000';
  const inventory: MigrationInventory = {
    sourceTool: 'power_bi', artifactCount: 0, artifacts: [],
    views: [{ name: email, description: identityId, fields: [{ name: email, type: 'string' }], measures: [], warnings: [] }],
    explores: [], relationships: [], metrics: [],
    dashboards: [{ name: email, fields: [email], filters: [identityId] }],
    warnings: [`Owner ${email} has principal ${identityId}`], summary: `${email} ${identityId}`,
  };
  const prompt = buildSemanticMigrationPlanPrompt({ inventory, modelName: email, modelId: 'model-1', adminGoal: `Ask ${email}` });
  assert.doesNotMatch(prompt, /private\.person@example\.com|123e4567-e89b-42d3-a456-426614174000/);
  assert.match(prompt, /\[redacted email\]|\[redacted id\]/);
});

test('structured prompt payload sanitization preserves contract IDs while redacting descriptive PII', () => {
  const contractId = '123e4567-e89b-42d3-a456-426614174000';
  const serialized = stringifySemanticMigrationPromptPayload({
    sourceDashboardId: contractId,
    sourceEvidenceIds: [contractId],
    sourceDashboardName: 'private.person@example.com',
    description: `Owned by 6f9619ff-8b86-d011-b42d-00cf4fc964ff`,
  });
  assert.match(serialized, new RegExp(contractId));
  assert.doesNotMatch(serialized, /private\.person@example\.com|6f9619ff-8b86-d011-b42d-00cf4fc964ff/);
});

test('Power BI typed decisions are scoped to selected report project dependencies', () => {
  const result = minimalPowerBiResult({
    mappings: [
      { id: 'a', sourceKind: 'measure', sourceName: 'Sales.Total', sourceArtifact: 'ProjectA.SemanticModel/definition/tables/Sales.tmdl', targetKind: 'shared_model_measure', targetName: 'sales.total', confidence: 'high', notes: [] },
      { id: 'b', sourceKind: 'measure', sourceName: 'Finance.Margin', sourceArtifact: 'ProjectB.SemanticModel/definition/tables/Finance.tmdl', targetKind: 'shared_model_measure', targetName: 'finance.margin', confidence: 'high', notes: [] },
    ],
    projects: [
      { id: 'project-a', name: 'Project A', sourceFiles: ['ProjectA.SemanticModel/definition/tables/Sales.tmdl'], semanticModelIds: ['model-a'], reports: [{ id: 'report-a', name: 'Report A', datasetId: 'model-a', sourceArtifact: 'ProjectA.Report/definition/report.json', filters: [], pages: [], bookmarks: [], themeFiles: [], warnings: [] }], warnings: [] },
      { id: 'project-b', name: 'Project B', sourceFiles: ['ProjectB.SemanticModel/definition/tables/Finance.tmdl'], semanticModelIds: ['model-b'], reports: [{ id: 'report-b', name: 'Report B', datasetId: 'model-b', sourceArtifact: 'ProjectB.Report/definition/report.json', filters: [], pages: [], bookmarks: [], themeFiles: [], warnings: [] }], warnings: [] },
    ],
  });
  const decisions = requiredPowerBiMigrationDecisions(result, ['report-a']);

  assert.deepEqual(decisions.map((decision) => decision.sourceLabel), ['Sales.Total']);
  assert.deepEqual(decisions[0]?.impactAssetIds, ['report-a']);
});

test('Power BI typed decisions keep same-named semantic objects distinct across projects', () => {
  const result = minimalPowerBiResult({
    mappings: [
      { id: 'a', sourceKind: 'measure', sourceName: 'Sales.Total', sourceArtifact: 'ProjectA.SemanticModel/definition/tables/Sales.tmdl', targetKind: 'shared_model_measure', targetName: 'sales.total', confidence: 'high', notes: ['Formula A'] },
      { id: 'b', sourceKind: 'measure', sourceName: 'Sales.Total', sourceArtifact: 'ProjectB.SemanticModel/definition/tables/Sales.tmdl', targetKind: 'shared_model_measure', targetName: 'sales.total', confidence: 'high', notes: ['Formula B'] },
    ],
    projects: [
      { id: 'project-a', name: 'Project A', sourceFiles: ['ProjectA.SemanticModel/definition/tables/Sales.tmdl'], semanticModelIds: ['model-a'], reports: [{ id: 'report-a', name: 'Report A', datasetId: 'model-a', sourceArtifact: 'ProjectA.Report/definition/report.json', filters: [], pages: [], bookmarks: [], themeFiles: [], warnings: [] }], warnings: [] },
      { id: 'project-b', name: 'Project B', sourceFiles: ['ProjectB.SemanticModel/definition/tables/Sales.tmdl'], semanticModelIds: ['model-b'], reports: [{ id: 'report-b', name: 'Report B', datasetId: 'model-b', sourceArtifact: 'ProjectB.Report/definition/report.json', filters: [], pages: [], bookmarks: [], themeFiles: [], warnings: [] }], warnings: [] },
    ],
  });
  const decisions = requiredPowerBiMigrationDecisions(result, ['report-a', 'report-b']);

  assert.equal(decisions.length, 2);
  assert.notEqual(decisions[0]?.id, decisions[1]?.id);
  assert.deepEqual(decisions.map((decision) => decision.evidence[0]?.artifactId).sort(), [
    'ProjectA.SemanticModel/definition/tables/Sales.tmdl',
    'ProjectB.SemanticModel/definition/tables/Sales.tmdl',
  ]);
});

test('Power BI planning surfaces unlinked semantic artifacts until the operator assigns selected reports', () => {
  const orphanArtifact = 'Loose.SemanticModel/definition/tables/Loose.tmdl';
  const result = minimalPowerBiResult({
    mappings: [
      { id: 'owned', sourceKind: 'measure', sourceName: 'Sales.Total', sourceArtifact: 'ProjectA.SemanticModel/definition/tables/Sales.tmdl', targetKind: 'shared_model_measure', targetName: 'sales.total', confidence: 'high', notes: [] },
      { id: 'orphan', sourceKind: 'measure', sourceName: 'Loose.Value', sourceArtifact: orphanArtifact, targetKind: 'shared_model_measure', targetName: 'loose.value', confidence: 'high', notes: [] },
    ],
    projects: [{ id: 'project-a', name: 'Project A', sourceFiles: ['ProjectA.SemanticModel/definition/tables/Sales.tmdl'], semanticModelIds: ['model-a'], reports: [{ id: 'report-a', name: 'Report A', datasetId: 'model-a', sourceArtifact: 'ProjectA.Report/definition/report.json', filters: [], pages: [], bookmarks: [], themeFiles: [], warnings: [] }], warnings: [] }],
  });

  assert.deepEqual(unassignedPowerBiDecisionArtifacts(result, ['report-a']), [orphanArtifact]);
  const unresolved = requiredPowerBiMigrationDecisions(result, ['report-a']);
  assert.ok(unresolved.some((decision) => decision.domain === 'model' && decision.sourceLabel.includes(orphanArtifact)));
  assert.equal(unresolved.some((decision) => decision.sourceLabel === 'Loose.Value'), false);

  const assigned = requiredPowerBiMigrationDecisions(result, ['report-a'], { [orphanArtifact]: ['report-a'] });
  assert.equal(assigned.some((decision) => decision.domain === 'model'), false);
  assert.ok(assigned.some((decision) => decision.sourceLabel === 'Loose.Value'));
});

test('Power BI planning cannot omit typed DAX, M, relationship, security, or unsupported-visual decisions', () => {
  const root = path.resolve('tests/fixtures/semantic-migrations/power-bi-northstar-pbip');
  const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')) as { artifacts: string[] };
  const artifacts = manifest.artifacts.map((fileName) => artifactFromText('power_bi', readFileSync(path.join(root, fileName), 'utf8'), fileName)!);
  const parsed = parsePowerBiManualArtifacts(artifacts);
  const reportId = parsed.projects![0]!.reports[0]!.id;
  parsed.projects![0]!.reports[0]!.pages[0]!.visuals.push({
    id: 'custom-visual', name: 'custom-visual', title: 'Custom Visual', visualType: 'demoCustomVisual', pageId: 'overview', sourceArtifact: 'custom-visual.json', fields: ['Sales.Revenue'], filters: [], customVisual: true, unsupportedReasons: ['Custom visual requires redesign.'],
  });
  const required = requiredPowerBiMigrationDecisions(parsed, [reportId]);
  const enriched = normalizeMigrationDecisions([{ nodeId: required.find((decision) => decision.domain === 'relationship')?.nodeId, domain: 'relationship', sourceLabel: required.find((decision) => decision.domain === 'relationship')?.sourceLabel, action: 'map_existing', targetId: 'sales.location', rationale: 'Existing relation is equivalent.', confidence: 0.95 }]);
  const merged = mergeRequiredPowerBiDecisions(enriched, required);

  assert.ok(required.some((decision) => decision.domain === 'measure'));
  assert.ok(required.some((decision) => decision.domain === 'data_source'));
  assert.ok(required.some((decision) => decision.domain === 'relationship'));
  assert.ok(required.some((decision) => decision.domain === 'permission'));
  assert.ok(required.some((decision) => decision.domain === 'visual'));
  assert.equal(merged.length, required.length);
  assert.equal(merged.find((decision) => decision.domain === 'relationship')?.action, 'map_existing');
  assert.equal(merged.every((decision) => decision.blocking && decision.validationRequired), true);
});

test('typed decisions require valid targets and only explicit rewrites can replace existing definitions', () => {
  const missingTarget = normalizeMigrationDecisions([{ nodeId: 'measure:sales:revenue', domain: 'measure', sourceLabel: 'Sales.Revenue', action: 'create_new', rationale: 'Missing', confidence: 0.8 }])[0]!;
  missingTarget.approvedByUser = true;
  assert.match(migrationDecisionResolutionIssue(missingTarget) || '', /target Omni semantic file/);
  assert.equal(migrationDecisionCanBeApproved(missingTarget), false);
  assert.equal(unresolvedDecisionCount([missingTarget]), 1);

  const current = { 'sales.view': 'measures:\n  revenue:\n    sql: SUM(${TABLE}.revenue)\n' };
  const create = normalizeMigrationDecisions([{ nodeId: 'measure:sales:revenue', domain: 'measure', sourceLabel: 'Sales.Revenue', action: 'create_new', targetFileName: 'sales.view', proposedCode: 'measures:\n  revenue:\n    sql: SUM(${TABLE}.net_revenue)\n', rationale: 'Changed source', confidence: 1 }])[0]!;
  create.approvedByUser = true;
  assert.throws(() => compileApprovedDecisionPackage([create], current), /approve an explicit rewrite/i);
  const rewrite = { ...create, action: 'rewrite' as const };
  const compiled = compileApprovedDecisionPackage([rewrite], current);
  assert.match(compiled.files[0]?.yaml || '', /net_revenue/);
});

test('Power BI preparation validation covers typed decisions and one field-bound plan per selected report', () => {
  const root = path.resolve('tests/fixtures/semantic-migrations/power-bi-northstar-pbip');
  const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')) as { artifacts: string[] };
  const artifacts = manifest.artifacts.map((fileName) => artifactFromText('power_bi', readFileSync(path.join(root, fileName), 'utf8'), fileName)!);
  const parsed = parsePowerBiManualArtifacts(artifacts);
  const catalog = powerBiManualDashboardCatalog(parsed);
  const decisions = requiredPowerBiMigrationDecisions(parsed, [catalog[0]!.id]).map((decision) => ({ ...decision, approvedByUser: true }));
  const plans = normalizeDashboardBuildPlans([{ sourceDashboardId: catalog[0]!.id, tiles: [{ title: 'Revenue', fields: ['Sales.Total Revenue'], visualType: 'card' }] }], catalog);
  const passed = buildMigrationPreparationValidationChecks({ decisions, selectedDashboards: catalog, dashboardPlans: plans });
  const failed = buildMigrationPreparationValidationChecks({ decisions, selectedDashboards: catalog, dashboardPlans: [{ ...plans[0]!, tiles: [] }] });
  assert.deepEqual(passed.map((check) => check.status), ['passed', 'passed']);
  assert.equal(failed.find((check) => check.id === 'dashboard_bindings')?.status, 'failed');
});

test('Power BI preparation validation accepts a valid report with no required semantic decisions', () => {
  const dashboard = { id: 'physical-report', name: 'Physical report', kind: 'report' as const, dependencyIds: [], dependencies: [], dependencyCounts: {}, complexity: 'low' as const, coverage: 'complete' as const, coverageNotes: [], riskFlags: [] };
  const plan = normalizeDashboardBuildPlans([{ sourceDashboardId: dashboard.id, tiles: [{ title: 'Rows', visualType: 'table', fields: ['Sales.Region'] }] }], [dashboard]);
  const checks = buildMigrationPreparationValidationChecks({ decisions: [], selectedDashboards: [dashboard], dashboardPlans: plan });

  assert.equal(checks.find((check) => check.id === 'dependency_resolution')?.status, 'passed');
  assert.equal(migrationValidationReady(checks), true);
});

test('Power BI preparation validation rejects duplicate plans for one selected dashboard', () => {
  const dashboard = { id: 'report-1', name: 'Report 1', kind: 'report' as const, dependencyIds: [], dependencies: [], dependencyCounts: {}, complexity: 'low' as const, coverage: 'complete' as const, coverageNotes: [], riskFlags: [] };
  const [plan] = normalizeDashboardBuildPlans([{ sourceDashboardId: dashboard.id, tiles: [{ title: 'Rows', visualType: 'table', fields: ['Sales.Region'] }] }], [dashboard]);
  const duplicate = { ...plan!, id: `${plan!.id}:duplicate` } satisfies MigrationDashboardBuildPlan;
  const checks = buildMigrationPreparationValidationChecks({ decisions: [], selectedDashboards: [dashboard], dashboardPlans: [plan!, duplicate] });
  const dashboardCheck = checks.find((check) => check.id === 'dashboard_bindings');

  assert.equal(dashboardCheck?.status, 'failed');
  assert.match(dashboardCheck?.summary || '', /duplicate|more than one/i);
});

test('Power BI preparation validation blocks plans that omit known visual evidence', () => {
  const root = path.resolve('tests/fixtures/semantic-migrations/power-bi-northstar-pbip');
  const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')) as { artifacts: string[] };
  const artifacts = manifest.artifacts.map((fileName) => artifactFromText('power_bi', readFileSync(path.join(root, fileName), 'utf8'), fileName)!);
  const parsed = parsePowerBiManualArtifacts(artifacts);
  const catalog = powerBiManualDashboardCatalog(parsed);
  const evidence = powerBiSelectedReportEvidence(parsed, [catalog[0]!.id]);
  const visualIds = evidence.reports[0]!.pages.flatMap((page) => page.visuals.map((visual) => visual.evidenceId));
  const incomplete = normalizeDashboardBuildPlans([{
    sourceDashboardId: catalog[0]!.id,
    tiles: [{ title: 'Revenue', fields: ['Sales.Total Revenue'], visualType: 'card', sourceEvidenceIds: [visualIds[0]!] }],
  }], catalog);
  const complete = normalizeDashboardBuildPlans([{
    sourceDashboardId: catalog[0]!.id,
    tiles: visualIds.map((evidenceId, index) => ({ title: `Tile ${index + 1}`, fields: ['Sales.Total Revenue'], visualType: 'card', sourceEvidenceIds: [evidenceId] })),
  }], catalog);

  const failed = buildMigrationPreparationValidationChecks({ decisions: [], selectedDashboards: catalog, dashboardPlans: incomplete, powerBiParseResult: parsed });
  const passed = buildMigrationPreparationValidationChecks({ decisions: [], selectedDashboards: catalog, dashboardPlans: complete, powerBiParseResult: parsed });
  assert.equal(failed.find((check) => check.id === 'dashboard_bindings')?.status, 'failed');
  assert.match(failed.find((check) => check.id === 'dashboard_bindings')?.summary || '', /known visual.*omitted/i);
  assert.equal(passed.find((check) => check.id === 'dashboard_bindings')?.status, 'passed');
});

test('migration bundle version is deterministic and rejects secret-shaped keys', () => {
  const sourceInventory = {
    platform: 'power_bi' as const,
    connectionId: 'source-1',
    connector: sourceConnectorDefinitions().find((item) => item.platform === 'power_bi')!,
    items: [],
    dashboardCatalog: [{ id: 'dash-1', name: 'Executive', kind: 'dashboard' as const, dependencyIds: ['model-1'], dependencies: [], dependencyCounts: {}, complexity: 'low' as const, coverage: 'partial' as const, coverageNotes: ['Scanner export recommended'], riskFlags: [] }],
    warnings: [], truncated: false,
  };
  const plans = normalizeDashboardBuildPlans([], sourceInventory.dashboardCatalog);
  const first = createMigrationBundle({ sourceInventory, selectedDashboardIds: ['dash-1'], dashboardPlans: plans, targetInstanceId: 'target-1', targetModelId: 'model-2', targetModelName: 'Sales', branchName: 'migration/sales', decisions: [], semanticFiles: [] });
  const second = createMigrationBundle({ sourceInventory, selectedDashboardIds: ['dash-1'], dashboardPlans: plans, targetInstanceId: 'target-1', targetModelId: 'model-2', targetModelName: 'Sales', branchName: 'migration/sales', decisions: [], semanticFiles: [] });
  assert.equal(first.bundleId, second.bundleId);
  assert.equal(migrationBundleFingerprint(first), first.bundleId);
  assert.equal(bundleHasSensitiveKeys(first), false);
  assert.equal(bundleHasSensitiveKeys({ apiKey: 'secret' }), true);
  assert.doesNotMatch(JSON.stringify(first), /credential|apiKey|secret/i);
});

test('preparation fingerprints bind source, target, decisions, plans, and semantic package', () => {
  const dashboards = [{ id: 'dash-1', name: 'Executive', kind: 'report' as const, dependencyIds: [], dependencies: [], dependencyCounts: {}, complexity: 'low' as const, coverage: 'complete' as const, coverageNotes: [], riskFlags: [] }];
  const plans = normalizeDashboardBuildPlans([{ sourceDashboardId: 'dash-1', tiles: [{ title: 'Revenue', fields: ['Sales.Revenue'] }] }], dashboards);
  const decisions = normalizeMigrationDecisions([{ id: 'decision-1', nodeId: 'measure:sales.revenue', domain: 'measure', sourceLabel: 'Revenue', action: 'create_new', targetFileName: 'sales.view', proposedCode: 'measures:\n  revenue: {}', rationale: 'Required', confidence: 1 }]);
  decisions[0]!.approvedByUser = true;
  const semanticFiles: SemanticMigrationFile[] = [{ id: 'file-1', fileName: 'sales.view', yaml: 'views:\n  sales: {}', source: 'semantic-migration' }];
  const targetBaseline = { files: { 'sales.view': 'dimensions:\n  revenue:\n    sql: revenue' }, checksums: { 'sales.view': 'checksum-1' } };
  const base = { sourcePlatform: 'power_bi', targetModelId: 'model-1', targetBaseline, selectedDashboardIds: ['dash-1'], dashboardPlans: plans, decisions, semanticFiles, powerBiParseResult: null };
  const fingerprint = semanticMigrationPreparationFingerprint(base);

  assert.equal(semanticMigrationPreparationFingerprint(base), fingerprint);
  assert.notEqual(semanticMigrationPreparationFingerprint({ ...base, targetModelId: 'model-2' }), fingerprint);
  assert.notEqual(semanticMigrationPreparationFingerprint({ ...base, selectedDashboardIds: ['dash-2'] }), fingerprint);
  assert.notEqual(semanticMigrationPreparationFingerprint({ ...base, semanticFiles: [{ ...semanticFiles[0]!, yaml: 'views:\n  sales:\n    label: Changed' }] }), fingerprint);
  assert.notEqual(semanticMigrationPreparationFingerprint({ ...base, decisions: [{ ...decisions[0]!, action: 'exclude' }] }), fingerprint);
  assert.notEqual(semanticMigrationPreparationFingerprint({
    ...base,
    targetBaseline: { files: { 'sales.view': `${targetBaseline.files['sales.view']}\n  concurrent_margin:\n    sql: margin` }, checksums: { 'sales.view': 'checksum-2' } },
  }), fingerprint);
  assert.equal(semanticMigrationPreparationFingerprint({
    ...base,
    targetBaseline: { files: { ...targetBaseline.files }, checksums: { 'sales.view': 'different-branch-checksum' } },
  }), fingerprint);
});

test('branch readiness blocks stale or incomplete preparation before a write can begin', () => {
  const passedChecks = [{ id: 'dependency_resolution' as const, label: 'Dependency decisions', status: 'passed' as const, blocking: true, summary: 'Ready', evidence: [] }];
  const staleIssues = semanticMigrationWriteReadinessIssues({
    preparationChecks: passedChecks,
    packageFileCount: 1,
    packagePreparationFingerprint: 'bundle-old',
    currentPreparationFingerprint: 'bundle-new',
  });
  let branchCalls = 0;
  if (staleIssues.length === 0) branchCalls += 1;

  assert.equal(branchCalls, 0);
  assert.match(staleIssues.join(' '), /stale/i);
  assert.equal(semanticMigrationWriteReadinessIssues({
    preparationChecks: passedChecks,
    packageFileCount: 1,
    packagePreparationFingerprint: 'bundle-current',
    currentPreparationFingerprint: 'bundle-current',
  }).length, 0);
  assert.match(semanticMigrationWriteReadinessIssues({
    preparationChecks: [{ ...passedChecks[0]!, status: 'failed', summary: 'One decision remains.' }],
    packageFileCount: 0,
    packagePreparationFingerprint: '',
    currentPreparationFingerprint: 'bundle-new',
  }).join(' '), /at least one semantic YAML|One decision remains|current reviewed preparation/i);
});

test('dashboard build queue is deterministic, gated, and retries only unfinished plans', () => {
  const plans = normalizeDashboardBuildPlans([
    { sourceDashboardId: 'dash-1', targetName: 'Executive', tiles: [{ title: 'Revenue', fields: ['orders.revenue'], visualType: 'bar' }] },
    { sourceDashboardId: 'dash-2', targetName: 'Operations', tiles: [{ title: 'Orders', fields: ['orders.count'], visualType: 'kpi' }] },
  ], [
    { id: 'dash-1', name: 'Executive', kind: 'dashboard' as const, dependencyIds: [], dependencies: [], dependencyCounts: {}, complexity: 'low' as const, coverage: 'complete' as const, coverageNotes: [], riskFlags: [] },
    { id: 'dash-2', name: 'Operations', kind: 'dashboard' as const, dependencyIds: [], dependencies: [], dependencyCounts: {}, complexity: 'low' as const, coverage: 'complete' as const, coverageNotes: [], riskFlags: [] },
  ]);
  const initial = createDashboardBuildQueue('bundle-1234', plans);
  assert.deepEqual(initial.map((item) => item.status), ['queued', 'queued']);
  assert.equal(dashboardBuildGate({ semanticReady: true, semanticReviewConfirmed: false, plans, items: initial }).ready, false);
  assert.equal(dashboardBuildGate({ semanticReady: true, semanticReviewConfirmed: true, plans, items: initial }).ready, true);

  const completed = updateDashboardBuildItem(initial, plans[0]!.id, { status: 'succeeded', attempt: 1, resultSummary: 'Created dashboard.' });
  assert.deepEqual(retryableDashboardBuildPlanIds(completed), [plans[1]!.id]);
  assert.deepEqual(dashboardBuildSummary(completed), { total: 2, queued: 1, running: 0, succeeded: 1, failed: 0, skipped: 0, cancelled: 0 });
  assert.doesNotMatch(JSON.stringify(completed), /apiKey|credential|secret/i);
});

test('dashboard build validation stays pending or failed until every selected dashboard succeeds', () => {
  const queued = createDashboardBuildQueue('bundle-1234', normalizeDashboardBuildPlans([
    { sourceDashboardId: 'dash-1', tiles: [{ title: 'Revenue', fields: ['orders.revenue'] }] },
  ], [{ id: 'dash-1', name: 'Executive', kind: 'dashboard' as const, dependencyIds: [], dependencies: [], dependencyCounts: {}, complexity: 'low' as const, coverage: 'complete' as const, coverageNotes: [], riskFlags: [] }]));
  assert.equal(buildDashboardBuildValidationCheck({ plannedCount: 1, semanticReviewConfirmed: false, items: queued }).status, 'pending');
  assert.equal(buildDashboardBuildValidationCheck({ plannedCount: 1, semanticReviewConfirmed: true, items: queued }).status, 'pending');
  const failed = updateDashboardBuildItem(queued, queued[0]!.planId, { status: 'failed', attempt: 1 });
  assert.equal(buildDashboardBuildValidationCheck({ plannedCount: 1, semanticReviewConfirmed: true, items: failed }).status, 'failed');
  const succeeded = updateDashboardBuildItem(failed, queued[0]!.planId, { status: 'succeeded', attempt: 2 });
  assert.equal(buildDashboardBuildValidationCheck({ plannedCount: 1, semanticReviewConfirmed: true, items: succeeded }).status, 'passed');
});

test('validation never turns missing evidence into a pass and requires explicit waivers', () => {
  const checks = buildMigrationValidationChecks({ modelValidation: [], contentValidation: {}, changedFileCount: 1, reviewAcknowledged: true });
  assert.equal(checks.find((check) => check.id === 'query')?.status, 'unsupported');
  assert.equal(migrationValidationReady(checks), false);
  const waived = buildMigrationValidationChecks({
    modelValidation: [], contentValidation: {}, changedFileCount: 1, reviewAcknowledged: true,
    waivers: { query: true, visual_intent: true, security: true, operational: true },
  });
  assert.equal(migrationValidationReady(waived), true);
  assert.equal(waived.find((check) => check.id === 'security')?.status, 'waived');
});

test('governance coverage gaps require owner-assigned outcomes before security and operations pass', () => {
  const sourceInventory: ClientSourceInventory = {
    platform: 'power_bi',
    connectionId: 'source-1',
    connector: {
      platform: 'power_bi',
      label: 'Power BI',
      authGuidance: 'Use scoped credentials.',
      capabilities: { apiInventory: true, semanticDefinitions: 'partial', contentDefinitions: 'partial', usage: true, permissions: true, schedules: true, queryValidation: true, visualEvidence: true },
      migrationCoverage: { semantic_objects: 'partial', dashboards: 'partial', filters: 'partial', layout: 'partial', permissions: 'unsupported', schedules: 'unsupported' },
      limitations: [],
    },
    items: [{
      id: 'role:regional', name: 'Regional Viewer', kind: 'permission', owner: 'Analytics Security',
      dependencyIds: [], featureFlags: [], riskFlags: ['row policy'], metadata: { group: 'Regional Viewer' },
    }],
    dashboardCatalog: [], warnings: [], truncated: false,
  };
  const items = buildMigrationGovernanceChecklist({ sourceInventory });
  assert.ok(items.some((item) => item.sourceRef === 'role:regional'));
  assert.ok(items.some((item) => item.sourceRef === 'connector:permissions'));
  assert.ok(items.some((item) => item.sourceRef === 'connector:schedules'));
  let resolutions = reconcileMigrationGovernanceResolutions(items, {});
  assert.equal(buildMigrationGovernanceValidationChecks(items, resolutions).find((check) => check.id === 'security')?.status, 'failed');
  resolutions = Object.fromEntries(items.map((item) => [item.id, {
    itemId: item.id,
    disposition: item.category === 'permission' ? 'map' as const : 'defer' as const,
    owner: item.owner || 'Migration Owner',
    targetRef: item.category === 'permission' ? 'omni-group:regional-viewer' : '',
    reason: item.category === 'schedule' ? 'Recreate after recipient approval.' : '',
    approved: true,
  }]));
  const checks = buildMigrationGovernanceValidationChecks(items, resolutions);
  assert.equal(checks.find((check) => check.id === 'security')?.status, 'passed');
  assert.equal(checks.find((check) => check.id === 'operational')?.status, 'passed');
});

test('visual reconciliation stores safe descriptors and keeps deployment success separate from fidelity', () => {
  const source = normalizeMigrationVisualEvidenceDescriptor({
    id: 'source-1', role: 'source', reference: 'https://source.example/screenshot.png?token=secret', mimeType: 'image/png',
    width: 1600, height: 900, sha256: 'a'.repeat(64), perceptualHash: '0123456789abcdef', redacted: true, capturedAt: '2026-07-16T10:00:00Z',
  });
  const target = normalizeMigrationVisualEvidenceDescriptor({
    id: 'target-1', role: 'target', reference: '/tmp/target.png', mimeType: 'image/png',
    width: 1600, height: 900, sha256: 'b'.repeat(64), perceptualHash: '0123456789abcdef', redacted: true, capturedAt: '2026-07-16T10:05:00Z',
  });
  assert.equal(source.reference, 'https://source.example/screenshot.png');
  assert.equal(target.reference, 'target.png');
  const comparison = compareMigrationVisualEvidence(source, target);
  assert.equal(comparison.status, 'passed');
  assert.equal(comparison.method, 'perceptual_hash');
  assert.equal(buildMigrationVisualValidationCheck([source, target], [comparison]).status, 'passed');
  assert.equal(buildMigrationVisualValidationCheck([], []).status, 'unsupported');
  const disclosure = migrationVisualReviewDisclosure({ llmOptIn: false, redactionConfirmed: true });
  assert.equal(disclosure.llmReviewExecuted, false);
  assert.match(disclosure.statement, /No screenshot bytes were sent/);
  assert.doesNotMatch(JSON.stringify({ source, target, comparison, disclosure }), /token=secret|data:image/i);
});

test('reconciliation report explains scope and exceptions without credentials or source payloads', () => {
  const decisions = normalizeMigrationDecisions([{ id: 'd1', nodeId: 'field:one', domain: 'field', sourceLabel: 'One', action: 'exclude', rationale: 'intentional', confidence: 1 }]);
  decisions[0]!.approvedByUser = true;
  const report = buildMigrationReconciliationReport({
    sourceInventory: null,
    sourcePlatform: 'power_bi',
    sourceDashboardCatalog: [{ id: 'dash-1', name: 'Executive', kind: 'report', dependencyIds: ['model-1'], dependencies: [], dependencyCounts: { semantic_model: 1 }, complexity: 'low', coverage: 'complete', coverageNotes: [], riskFlags: [] }],
    selectedDashboardIds: ['dash-1'],
    scope: { a: { assetId: 'a', disposition: 'migrate', wave: 'Wave 1', note: 'never export sk-secret' } },
    decisions,
    files: [],
    validation: buildMigrationValidationChecks({ modelValidation: [], contentValidation: {}, changedFileCount: 0, reviewAcknowledged: false }),
    targetBaseUrl: 'https://target.omniapp.co/path?token=secret',
    targetModelId: 'model-1',
    connectionMappings: [{
      sourceKey: 'analytics', sourceName: 'Analytics', sourceDialect: 'snowflake',
      targetConnectionId: 'connection-1', targetConnectionName: 'Production', targetDialect: 'snowflake',
      confidence: 'exact', confirmed: true,
    }],
    connectionRoutes: [{
      id: 'connection-route:connection-1', targetConnectionId: 'connection-1', targetConnectionName: 'Production',
      sourceKeys: ['analytics'], compatibleModels: [{ id: 'model-1', name: 'Sales' }],
      selectedModelId: 'model-1', selectedModelName: 'Sales', writeStatus: 'ready',
    }],
    bundleId: 'bundle-abcd',
    engineEvidence: {
      name: 'omni-migrator', version: '0.0.1', rulebookVersion: 'v2', requestId: 'request-1',
      sourceArtifactFingerprints: [{ name: 'source.pbix', sha256: 'a'.repeat(64), sizeBytes: 1024 }],
      capabilityCoverage: { semantic: 'full' }, untranslatableCount: 1,
    },
    dashboardBuildItems: [{ id: 'build-1', planId: 'plan-1', sourceDashboardId: 'dash-1', sourceDashboardName: 'Executive', status: 'failed', attempt: 2, chatUrl: 'https://target.omniapp.co/ai/chat/123?token=secret', error: 'provider returned token=secret' }],
  });
  const serialized = JSON.stringify(report);
  assert.match(serialized, /target\.omniapp\.co/);
  assert.doesNotMatch(serialized, /sk-secret|token=secret/);
  assert.equal(report.bundleId, 'bundle-abcd');
  assert.equal(report.source.platform, 'power_bi');
  assert.equal(report.source.selectedDashboards[0]?.name, 'Executive');
  assert.equal(report.source.engine?.rulebookVersion, 'v2');
  assert.equal(report.source.engine?.sourceArtifactFingerprints[0]?.sha256, 'a'.repeat(64));
  assert.equal(report.target.connectionMappings?.[0]?.confirmed, true);
  assert.equal(report.target.connectionRoutes?.[0]?.writeStatus, 'ready');
  assert.equal(report.dashboardBuilds[0]?.status, 'failed');
  assert.equal(report.deployment.status, 'dashboard_attention');
  assert.equal(report.schemaVersion, '1.3');
  assert.deepEqual(report.governance, []);
  assert.equal(report.visualEvidence.review.llmReviewExecuted, false);
  assert.ok(report.outcomes.some((outcome) => outcome.sourceId === 'field:one' && outcome.outcome === 'excluded'));
  assert.ok(report.outcomes.some((outcome) => outcome.sourceId === 'dash-1' && outcome.outcome === 'unresolved'));
  assert.equal(report.operationalEvidence?.engine?.rulebookVersion, 'v2');
  const markdown = migrationReconciliationReportToMarkdown(report);
  assert.match(markdown, /# OmniKit BI Migration Reconciliation/);
  assert.match(markdown, /\| One \| field \| excluded \|/);
  assert.match(markdown, /## Connection Routes/);
  assert.match(markdown, /\| Production \| analytics \| Sales \| ready \|/);
  assert.doesNotMatch(markdown, /sk-secret|token=secret/);
  assert.ok(report.exceptions.length > 0);
});

test('deterministic migration uploads preserve packaged Tableau sources and full text separately', () => {
  assert.equal(migrationEngineArtifactTransport('tableau', 'sales.twbx'), 'binary');
  assert.equal(migrationEngineArtifactTransport('tableau', 'warehouse.tdsx'), 'binary');
  assert.equal(migrationEngineArtifactTransport('tableau', 'sales.twb'), 'text');
  assert.equal(migrationEngineArtifactTransport('looker', 'orders.view.lkml'), 'text');
  assert.equal(migrationEngineArtifactTransport('metabase', 'snapshot.json'), 'text');
  assert.equal(migrationEngineArtifactTransport('power_bi', 'model.pbix'), 'binary');
  assert.equal(migrationEngineArtifactTransport('power_bi', 'model.tmdl'), null);
});

test('deterministic migration upload limits reject ambiguous or unsafe bundles without truncating', () => {
  assert.throws(() => validateMigrationEngineUploadFiles('tableau', [
    { name: 'sales.twb', size: 100 },
    { name: 'SALES.TWB', size: 100 },
  ]), /must be unique/);
  assert.throws(() => validateMigrationEngineUploadFiles('looker', [
    { name: 'large.model.lkml', size: MAX_ENGINE_TEXT_ARTIFACT_BYTES + 1 },
  ]), /text-artifact limit/);
  assert.throws(() => validateMigrationEngineUploadFiles('tableau', [
    { name: 'large.twbx', size: MAX_ENGINE_BINARY_ARTIFACT_BYTES + 1 },
  ]), /packaged-artifact limit/);
  assert.throws(() => validateMigrationEngineUploadFiles('tableau', [
    { name: 'one.twbx', size: Math.floor(MAX_ENGINE_MANUAL_TOTAL_BYTES / 2) + 1 },
    { name: 'two.twbx', size: Math.floor(MAX_ENGINE_MANUAL_TOTAL_BYTES / 2) + 1 },
  ]), /may total at most/);
});

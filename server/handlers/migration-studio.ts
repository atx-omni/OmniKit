import { assertSafeOutboundUrl, jsonHeaders, validateBaseUrl } from '../security';
import { randomUUID } from 'node:crypto';
import { listSourceInventory, sourceInventoryToMigrationInventory, testPlatformConnection } from '../services/migrationConnectors';
import { generateStructuredProposal, providerCapabilities, testLlmProvider, type MigrationAiTask } from '../services/migrationProviders';
import { redactSensitiveText } from '../services/jobSanitizer';
import { parseDomoManualArtifacts } from '../services/semanticMigration/domoManualParser';
import { parseLookerManualArtifacts } from '../services/semanticMigration/lookerManualParser';
import { parseMicroStrategyManualArtifacts } from '../services/semanticMigration/microStrategyManualParser';
import { parsePowerBiManualArtifacts } from '../services/semanticMigration/powerBiManualParser';
import { getMigrationEngineCapabilities, migrationEngineRolloutMode, recordMigrationEngineParityObservation, runMigrationEngineExtract, type MigrationEngineArtifactInput } from '../services/migrationEngineBridge';
import { OmniClient } from '../services/omniClient';
import {
  cancelSemanticMigrationJob,
  getSemanticMigrationJob,
  getSemanticMigrationJobResult,
  startSemanticMigrationJob,
} from '../services/semanticMigrationJobs';
import {
  assertMigrationProviderAllowed,
  listSemanticMigrationAuditEvents,
  migrationSourceHostAllowlist,
  recordSemanticMigrationAuditEvent,
} from '../services/semanticMigrationAudit';
import {
  deleteLlmProvider,
  deleteMigrationProject,
  deletePlatformConnection,
  getLlmProvider,
  getMigrationProject,
  getPlatformConnection,
  getInstance,
  isVaultUnlocked,
  listLlmProviders,
  listMigrationProjects,
  listPlatformConnections,
  markLlmProviderValidated,
  markPlatformConnectionValidated,
  upsertLlmProvider,
  upsertMigrationProject,
  upsertPlatformConnection,
} from '../services/nativeVault';
import type { MigrationArtifact } from '../../src/services/semanticMigration/types';
import { buildMigrationInventory } from '../../src/services/semanticMigration/adapters';
import { sanitizeSemanticMigrationProviderText } from '../../src/services/semanticMigration/prompts';
import type { MigrationEngineSource } from '../../src/services/semanticMigration/engineBridge';

function maxPromptChars(): number {
  const configured = Number(process.env.OMNIKIT_MIGRATION_MAX_PROMPT_CHARS);
  return Number.isFinite(configured) && configured >= 10_000 ? Math.min(configured, 1_000_000) : 500_000;
}

export function strictPromptFields(body: Record<string, unknown>): { system: string; prompt: string } {
  const system = sanitizeSemanticMigrationProviderText(typeof body.system === 'string' ? body.system : '');
  const prompt = sanitizeSemanticMigrationProviderText(typeof body.prompt === 'string' ? body.prompt : '');
  const maximum = maxPromptChars();
  const total = system.length + prompt.length;
  if (total > maximum) {
    throw Object.assign(new Error(`The semantic migration AI request is ${total.toLocaleString()} characters, above the ${maximum.toLocaleString()} character limit. OmniKit did not truncate it. Reduce the migration scope or split the selected dashboards and retry.`), { statusCode: 413 });
  }
  return { system, prompt };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: jsonHeaders });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sanitizedConnectionOverrides(value: unknown, targetConnectionIds: Set<string>): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([sourceKey, connectionId]) => sourceKey.trim() && sourceKey.length <= 200 && typeof connectionId === 'string' && targetConnectionIds.has(connectionId))
    .slice(0, 100)
    .map(([sourceKey, connectionId]) => [sourceKey.trim(), String(connectionId)]));
}

const MIGRATION_AI_TASKS = new Set<MigrationAiTask>(['classify_inventory', 'propose_mappings', 'translate_expression', 'draft_semantic_patch', 'draft_content_spec', 'explain_exception', 'generate_validation_sql', 'evaluate_reconciliation']);
const MANUAL_ARTIFACT_KINDS = new Set<MigrationArtifact['kind']>(['manifest', 'yaml', 'sql', 'lookml', 'dashboard', 'json', 'xml', 'metadata', 'text', 'unknown']);
const MAX_MANUAL_ARTIFACTS = 100;
const MAX_MANUAL_ARTIFACT_CHARS = 500_000;
const MAX_MANUAL_TOTAL_CHARS = 4_000_000;
const MAX_POWER_BI_MANUAL_ARTIFACTS = 1_000;
const MAX_POWER_BI_MANUAL_ARTIFACT_CHARS = 5 * 1024 * 1024;
const MAX_POWER_BI_MANUAL_TOTAL_CHARS = 18 * 1024 * 1024;

function migrationAiTask(value: unknown): MigrationAiTask | null {
  return typeof value === 'string' && MIGRATION_AI_TASKS.has(value as MigrationAiTask) ? value as MigrationAiTask : null;
}

async function bodyJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = await req.json();
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function requireUnlocked(): Response | null {
  return isVaultUnlocked() ? null : json({ error: 'vault locked' }, 423);
}

function validateSavedBaseUrl(body: Record<string, unknown>): Response | null {
  if (typeof body.baseUrl !== 'string' || !body.baseUrl.trim()) return null;
  const error = validateBaseUrl(body.baseUrl.trim());
  return error ? json({ error }, 400) : null;
}

function manualArtifacts(body: Record<string, unknown>): MigrationArtifact[] {
  if (body.sourceTool !== 'domo' && body.sourceTool !== 'looker' && body.sourceTool !== 'microstrategy' && body.sourceTool !== 'power_bi') {
    throw Object.assign(new Error('The backend manual parser currently supports Domo, Looker, MicroStrategy, and Power BI artifacts only.'), { statusCode: 400 });
  }
  const sourceTool = body.sourceTool;
  const sourceLabel = sourceTool === 'domo' ? 'Domo' : sourceTool === 'looker' ? 'Looker' : sourceTool === 'microstrategy' ? 'MicroStrategy' : 'Power BI';
  const maxArtifacts = sourceTool === 'power_bi' ? MAX_POWER_BI_MANUAL_ARTIFACTS : MAX_MANUAL_ARTIFACTS;
  const maxArtifactChars = sourceTool === 'power_bi' ? MAX_POWER_BI_MANUAL_ARTIFACT_CHARS : MAX_MANUAL_ARTIFACT_CHARS;
  const maxTotalChars = sourceTool === 'power_bi' ? MAX_POWER_BI_MANUAL_TOTAL_CHARS : MAX_MANUAL_TOTAL_CHARS;
  if (!Array.isArray(body.artifacts) || body.artifacts.length === 0) {
    throw Object.assign(new Error(`At least one ${sourceLabel} source artifact is required.`), { statusCode: 400 });
  }
  if (body.artifacts.length > maxArtifacts) {
    throw Object.assign(new Error(`Upload no more than ${maxArtifacts} ${sourceLabel} artifacts at a time.`), { statusCode: 413 });
  }
  let totalChars = 0;
  return body.artifacts.map((value, index) => {
    if (!isRecord(value)) throw Object.assign(new Error(`${sourceLabel} artifact ${index + 1} is invalid.`), { statusCode: 400 });
    const content = typeof value.content === 'string' ? value.content : '';
    totalChars += content.length;
    if (!content.trim()) throw Object.assign(new Error(`${sourceLabel} artifact ${index + 1} has no readable content.`), { statusCode: 400 });
    if (content.length > maxArtifactChars || totalChars > maxTotalChars) {
      throw Object.assign(new Error(`The ${sourceLabel} manual bundle is too large. Split it into smaller, focused exports.`), { statusCode: 413 });
    }
    const kind = typeof value.kind === 'string' && MANUAL_ARTIFACT_KINDS.has(value.kind as MigrationArtifact['kind'])
      ? value.kind as MigrationArtifact['kind']
      : 'unknown';
    return {
      id: typeof value.id === 'string' && value.id.trim() ? value.id.trim().slice(0, 200) : `${sourceTool}-artifact-${index + 1}`,
      sourceTool,
      name: typeof value.name === 'string' && value.name.trim() ? value.name.trim().slice(0, 300) : `${sourceTool}-artifact-${index + 1}.${kind === 'sql' ? 'sql' : sourceTool === 'looker' ? 'lkml' : 'json'}`,
      kind,
      content,
      sizeBytes: typeof value.sizeBytes === 'number' && Number.isFinite(value.sizeBytes) ? Math.max(0, value.sizeBytes) : Buffer.byteLength(content),
      parseWarnings: Array.isArray(value.parseWarnings)
        ? value.parseWarnings.filter((warning): warning is string => typeof warning === 'string').slice(0, 20).map((warning) => warning.slice(0, 500))
        : [],
    } satisfies MigrationArtifact;
  });
}

const ENGINE_SOURCES = new Set<MigrationEngineSource>(['looker', 'metabase', 'powerbi', 'sigma', 'tableau']);

function engineSource(value: unknown): MigrationEngineSource {
  const normalized = value === 'power_bi' ? 'powerbi' : value;
  if (typeof normalized === 'string' && ENGINE_SOURCES.has(normalized as MigrationEngineSource)) return normalized as MigrationEngineSource;
  throw Object.assign(new Error('Select a migration-engine source: Looker, Metabase, Power BI, Sigma, or Tableau.'), { statusCode: 400 });
}

function engineArtifacts(body: Record<string, unknown>, field = 'artifacts'): MigrationEngineArtifactInput[] {
  if (!Array.isArray(body[field])) return [];
  return body[field].map((value, index) => {
    if (!isRecord(value)) throw Object.assign(new Error(`Engine artifact ${index + 1} is invalid.`), { statusCode: 400 });
    const name = typeof value.name === 'string' && value.name.trim() ? value.name.trim().slice(0, 300) : `artifact-${index + 1}`;
    if (typeof value.contentBase64 === 'string') {
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value.contentBase64) || value.contentBase64.length % 4 !== 0) {
        throw Object.assign(new Error(`${name} is not valid base64 artifact content.`), { statusCode: 400 });
      }
      return { name, content: new Uint8Array(Buffer.from(value.contentBase64, 'base64')) };
    }
    if (typeof value.content !== 'string') throw Object.assign(new Error(`${name} has no readable artifact content.`), { statusCode: 400 });
    return { name, content: value.content };
  });
}

function engineApiAuth(connection: NonNullable<ReturnType<typeof getPlatformConnection>>): Record<string, unknown> {
  if (connection.platform === 'sigma') return { client_id: connection.clientId, client_secret: connection.credential };
  if (connection.platform === 'metabase') return { api_key: connection.credential, username: connection.username };
  if (connection.platform === 'looker') return { client_id: connection.clientId, client_secret: connection.credential, project_id: connection.projectId };
  return {};
}

function engineArtifactKind(name: string, source: MigrationEngineSource): MigrationArtifact['kind'] {
  const lower = name.toLowerCase();
  if (lower.endsWith('.lkml') || lower.endsWith('.lookml')) return lower.includes('dashboard') ? 'dashboard' : 'lookml';
  if (lower.endsWith('.twb') || lower.endsWith('.tds') || lower.endsWith('.xml')) return 'xml';
  if (lower.endsWith('.bim') || lower.endsWith('.tmdl') || lower.endsWith('.model')) return 'metadata';
  if (lower.endsWith('.json')) return 'json';
  return source === 'looker' ? 'lookml' : 'unknown';
}

export function buildEngineManualParityBaseline(source: MigrationEngineSource, artifacts: MigrationEngineArtifactInput[]) {
  if (artifacts.length === 0 || artifacts.some((artifact) => typeof artifact.content !== 'string')) return undefined;
  const sourceTool = source === 'powerbi' ? 'power_bi' : source;
  const migrationArtifacts: MigrationArtifact[] = artifacts.map((artifact, index) => ({
    id: `${sourceTool}-engine-baseline-${index + 1}`,
    sourceTool,
    name: artifact.name,
    kind: engineArtifactKind(artifact.name, source),
    content: artifact.content as string,
    sizeBytes: Buffer.byteLength(artifact.content as string),
    parseWarnings: [],
  }));
  if (sourceTool === 'looker') return parseLookerManualArtifacts(migrationArtifacts).inventory;
  if (sourceTool === 'power_bi') return parsePowerBiManualArtifacts(migrationArtifacts).inventory;
  return buildMigrationInventory(sourceTool, migrationArtifacts);
}

export default async function handler(req: Request): Promise<Response> {
  try {
    const locked = requireUnlocked();
    if (locked) return locked;

    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api\/migration-studio\/?/, '');
    const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
    const [resource, id, action] = parts;

    if (resource === 'audit' && req.method === 'GET') {
      return json({ events: listSemanticMigrationAuditEvents() });
    }

    if (resource === 'engine' && id === 'capabilities' && req.method === 'GET') {
      return json({ capabilities: await getMigrationEngineCapabilities() });
    }

    if (resource === 'engine' && id === 'parity' && req.method === 'POST') {
      const body = await bodyJson(req);
      const requestId = typeof body.requestId === 'string' ? body.requestId.trim().slice(0, 200) : '';
      if (!requestId) return json({ error: 'A completed migration-engine request ID is required.' }, 400);
      const summary = await recordMigrationEngineParityObservation(requestId);
      recordSemanticMigrationAuditEvent({
        type: 'engine_parity_recorded',
        resourceId: `${summary.source}:${summary.observationCount}`,
        sourcePlatform: summary.source === 'powerbi' ? 'power_bi' : summary.source,
        outcome: 'completed',
        telemetry: {
          rolloutMode: 'shadow',
          parityScore: summary.latestOverall,
        },
      });
      return json({ summary }, 201);
    }

    if (resource === 'engine' && id === 'extract' && req.method === 'POST') {
      const body = await bodyJson(req);
      const source = engineSource(body.sourceTool);
      const mode = body.mode === 'api' ? 'api' : 'manual';
      const artifacts = mode === 'manual' ? engineArtifacts(body) : [];
      const parityArtifacts = engineArtifacts(body, 'parityArtifacts');
      const targetInstanceId = typeof body.targetInstanceId === 'string' ? body.targetInstanceId.trim().slice(0, 200) : '';
      const targetInstance = targetInstanceId ? getInstance(targetInstanceId) : undefined;
      if (targetInstanceId && !targetInstance) return json({ error: 'Target Omni instance not found in the unlocked vault.' }, 404);
      const targetConnections = targetInstance
        ? (await new OmniClient(targetInstance).listConnections())
          .filter((item) => !item.deletedAt && item.id && item.name)
          .slice(0, 500)
          .map((item) => ({
            id: item.id,
            name: item.name,
            dialect: item.dialect,
            database: item.database || undefined,
            defaultSchema: item.defaultSchema || undefined,
          }))
        : [];
      const connectionOverrides = sanitizedConnectionOverrides(body.connectionOverrides, new Set(targetConnections.map((item) => item.id)));
      const connectionId = typeof body.connectionId === 'string' ? body.connectionId : '';
      const connection = mode === 'api' ? getPlatformConnection(connectionId) : undefined;
      if (mode === 'api' && !connection) return json({ error: 'Saved source connection not found.' }, 404);
      const expectedPlatform = source === 'powerbi' ? 'power_bi' : source;
      if (connection && connection.platform !== expectedPlatform) return json({ error: 'Saved source connection does not match the selected engine source.' }, 409);
      if (connection?.baseUrl) {
        await assertSafeOutboundUrl(connection.baseUrl, {
          label: `${connection.platform} migration-engine source URL`,
          allowlist: migrationSourceHostAllowlist(),
        });
      }
      const requestId = typeof body.requestId === 'string' && body.requestId.trim() ? body.requestId.trim().slice(0, 200) : `engine_${randomUUID()}`;
      const scope = isRecord(body.scope) ? body.scope : {};
      let parityBaseline;
      let parityBaselineWarning = '';
      try {
        if (mode === 'api' && connection) {
          const nativeInventory = await listSourceInventory(connection);
          const selectedDashboardIds = Array.isArray(scope.selected_dashboard_ids)
            ? scope.selected_dashboard_ids.filter((value): value is string => typeof value === 'string').slice(0, 1_000)
            : [];
          parityBaseline = sourceInventoryToMigrationInventory(nativeInventory, selectedDashboardIds);
        } else {
          parityBaseline = buildEngineManualParityBaseline(source, parityArtifacts.length > 0 ? parityArtifacts : artifacts);
        }
      } catch {
        parityBaselineWarning = 'A comparable native baseline could not be generated, so this run is limited to canonical conformance and cannot be described as an old-versus-new differential.';
      }
      const startedAt = Date.now();
      try {
        const result = await runMigrationEngineExtract({
          requestId,
          source,
          mode,
          artifacts,
          connection: connection?.baseUrl ? { baseUrl: connection.baseUrl, auth: engineApiAuth(connection) } : undefined,
          defaultSchema: typeof body.defaultSchema === 'string' ? body.defaultSchema.trim().slice(0, 200) : undefined,
          scope,
          includeModelSuggestions: body.includeModelSuggestions !== false,
          rulebookVersion: typeof body.rulebookVersion === 'string' && body.rulebookVersion.trim() ? body.rulebookVersion.trim().slice(0, 50) : 'v2',
          targetConnections,
          connectionOverrides,
          parityBaseline,
          parityBaselineSource: parityBaseline ? 'server_native' : undefined,
          parityComparisonType: parityBaseline ? 'native_differential' : 'canonical_conformance',
          signal: req.signal,
        });
        recordSemanticMigrationAuditEvent({
          type: 'engine_artifacts_parsed',
          resourceId: `${requestId}:${result.engine.version}:${result.diagnostics.view_count}:${result.diagnostics.dashboard_count}`,
          sourcePlatform: expectedPlatform,
          outcome: 'completed',
          telemetry: {
            engineName: result.engine.name,
            engineVersion: result.engine.version,
            parserVersion: result.model_suggestions[0]?.parser_version || result.engine.version,
            rolloutMode: result.control_plane?.rollout_mode || migrationEngineRolloutMode(source),
            durationMs: result.control_plane?.duration_ms || Date.now() - startedAt,
            queueWaitMs: result.control_plane?.queue_wait_ms,
          },
        });
        return json({
          result,
          parity: {
            comparisonType: parityBaseline ? 'native_differential' : 'canonical_conformance',
            warning: parityBaselineWarning || undefined,
          },
        });
      } catch (caught) {
        const statusCode = caught && typeof caught === 'object' && 'statusCode' in caught ? Number((caught as { statusCode?: unknown }).statusCode) : 500;
        recordSemanticMigrationAuditEvent({
          type: 'engine_artifacts_parsed',
          resourceId: requestId,
          sourcePlatform: expectedPlatform,
          outcome: 'rejected',
          telemetry: {
            rolloutMode: migrationEngineRolloutMode(source),
            durationMs: Date.now() - startedAt,
            fallbackReason: statusCode === 503 && migrationEngineRolloutMode(source) === 'off' ? 'engine_off' : statusCode === 503 ? 'engine_unavailable' : 'engine_failed',
          },
        });
        throw caught;
      }
    }

    if (resource === 'manual-artifacts' && id === 'parse' && req.method === 'POST') {
      const body = await bodyJson(req);
      const artifacts = manualArtifacts(body);
      const sourcePlatform = artifacts[0].sourceTool === 'looker'
        ? 'looker'
        : artifacts[0].sourceTool === 'microstrategy'
          ? 'microstrategy'
          : artifacts[0].sourceTool === 'power_bi'
            ? 'power_bi'
            : 'domo';
      const result = sourcePlatform === 'looker'
        ? parseLookerManualArtifacts(artifacts)
        : sourcePlatform === 'microstrategy'
          ? parseMicroStrategyManualArtifacts(artifacts)
          : sourcePlatform === 'power_bi'
            ? parsePowerBiManualArtifacts(artifacts)
            : parseDomoManualArtifacts(artifacts);
      recordSemanticMigrationAuditEvent({
        type: 'manual_artifacts_parsed',
        resourceId: `${sourcePlatform}-manual:${result.diagnostics.parsedArtifactCount}:${result.diagnostics.mappingCount}`,
        sourcePlatform,
        outcome: 'completed',
      });
      return json({ result });
    }

    if (resource === 'jobs') {
      if (req.method === 'POST' && !id) {
        const body = await bodyJson(req);
        const providerId = typeof body.providerId === 'string' ? body.providerId : '';
        const provider = getLlmProvider(providerId);
        if (!provider) return json({ error: 'AI provider not found.' }, 404);
        assertMigrationProviderAllowed(provider.kind);
        const { system, prompt } = strictPromptFields(body);
        const schemaName = typeof body.schemaName === 'string' && body.schemaName.trim() ? body.schemaName.trim().slice(0, 120) : 'semantic_migration_proposal';
        const schema = isRecord(body.schema) ? body.schema : {};
        const task = migrationAiTask(body.task);
        if (!system || !prompt || !task || Object.keys(schema).length === 0) return json({ error: 'providerId, task, system, prompt, and schema are required.' }, 400);
        const stage = body.stage === 'compile' || body.stage === 'repair' ? body.stage : 'analyze';
        const job = startSemanticMigrationJob({
          providerId,
          projectId: typeof body.projectId === 'string' ? body.projectId : undefined,
          stage,
          requestFingerprintSource: `${providerId}:${task}:${schemaName}:${system}:${prompt}`,
          run: () => generateStructuredProposal(provider, {
            task,
            system,
            prompt,
            schemaName,
            schema,
            targetModelId: typeof body.targetModelId === 'string' ? body.targetModelId : undefined,
          }),
        });
        recordSemanticMigrationAuditEvent({ type: 'ai_job_started', resourceId: job.id, providerKind: provider.kind, projectId: typeof body.projectId === 'string' ? body.projectId : undefined, outcome: 'accepted' });
        return json({ job }, 202);
      }
      if (req.method === 'GET' && id) {
        const job = getSemanticMigrationJob(id);
        if (!job) return json({ error: 'Semantic migration job not found.' }, 404);
        const result = job.status === 'succeeded' ? getSemanticMigrationJobResult(id) : undefined;
        if (job.status === 'succeeded' && result === undefined) {
          return json({ job, resultExpired: true });
        }
        return json({ job, result });
      }
      if (req.method === 'POST' && id && action === 'cancel') {
        const job = cancelSemanticMigrationJob(id);
        if (job) recordSemanticMigrationAuditEvent({ type: 'ai_job_cancelled', resourceId: id, projectId: job.projectId, outcome: 'completed' });
        return job ? json({ job }) : json({ error: 'Semantic migration job not found.' }, 404);
      }
    }

    if (resource === 'providers') {
      if (req.method === 'GET' && !id) {
        return json({ providers: listLlmProviders().map((provider) => ({ ...provider, capabilities: providerCapabilities(provider.kind) })) });
      }
      if ((req.method === 'POST' || req.method === 'PATCH') && (!id || !action)) {
        const body = await bodyJson(req);
        if (id) body.id = id;
        if (typeof body.kind === 'string') assertMigrationProviderAllowed(body.kind);
        const invalidUrl = validateSavedBaseUrl(body);
        if (invalidUrl) return invalidUrl;
        const provider = upsertLlmProvider(body);
        recordSemanticMigrationAuditEvent({ type: 'provider_saved', resourceId: provider.id, providerKind: provider.kind, outcome: 'completed' });
        return json({ provider: { ...provider, capabilities: providerCapabilities(provider.kind) } }, req.method === 'POST' ? 201 : 200);
      }
      if (req.method === 'DELETE' && id && !action) {
        deleteLlmProvider(id);
        recordSemanticMigrationAuditEvent({ type: 'provider_deleted', resourceId: id, outcome: 'completed' });
        return json({ ok: true });
      }
      if (req.method === 'POST' && id && action === 'test') {
        const provider = getLlmProvider(id);
        if (!provider) return json({ error: 'AI provider not found.' }, 404);
        const result = await testLlmProvider(provider);
        recordSemanticMigrationAuditEvent({ type: 'provider_tested', resourceId: id, providerKind: provider.kind, outcome: 'completed' });
        return json({ ...result, provider: markLlmProviderValidated(id) });
      }
      if (req.method === 'POST' && id && action === 'generate') {
        const provider = getLlmProvider(id);
        if (!provider) return json({ error: 'AI provider not found.' }, 404);
        const body = await bodyJson(req);
        const { system, prompt } = strictPromptFields(body);
        const schemaName = typeof body.schemaName === 'string' && body.schemaName.trim() ? body.schemaName.trim().slice(0, 120) : 'semantic_migration_proposal';
        const schema = isRecord(body.schema) ? body.schema : {};
        const task = migrationAiTask(body.task);
        if (!system || !prompt || !task || Object.keys(schema).length === 0) return json({ error: 'task, system, prompt, and schema are required.' }, 400);
        const result = await generateStructuredProposal(provider, {
          task,
          system,
          prompt,
          schemaName,
          schema,
          targetModelId: typeof body.targetModelId === 'string' ? body.targetModelId : undefined,
        });
        return json({ result });
      }
    }

    if (resource === 'platform-connections') {
      if (req.method === 'GET' && !id) return json({ connections: listPlatformConnections() });
      if ((req.method === 'POST' || req.method === 'PATCH') && (!id || !action)) {
        const body = await bodyJson(req);
        if (id) body.id = id;
        const invalidUrl = validateSavedBaseUrl(body);
        if (invalidUrl) return invalidUrl;
        const connection = upsertPlatformConnection(body);
        recordSemanticMigrationAuditEvent({ type: 'source_saved', resourceId: connection.id, sourcePlatform: connection.platform, outcome: 'completed' });
        return json({ connection }, req.method === 'POST' ? 201 : 200);
      }
      if (req.method === 'DELETE' && id && !action) {
        deletePlatformConnection(id);
        recordSemanticMigrationAuditEvent({ type: 'source_deleted', resourceId: id, outcome: 'completed' });
        return json({ ok: true });
      }
      if (req.method === 'POST' && id && action === 'test') {
        const connection = getPlatformConnection(id);
        if (!connection) return json({ error: 'Platform connection not found.' }, 404);
        const result = await testPlatformConnection(connection);
        recordSemanticMigrationAuditEvent({ type: 'source_tested', resourceId: id, sourcePlatform: connection.platform, outcome: 'completed' });
        return json({ ...result, connection: markPlatformConnectionValidated(id) });
      }
      if (req.method === 'GET' && id && action === 'inventory') {
        const connection = getPlatformConnection(id);
        if (!connection) return json({ error: 'Platform connection not found.' }, 404);
        return json({ inventory: await listSourceInventory(connection) });
      }
    }

    if (resource === 'projects') {
      if (req.method === 'GET' && !id) return json({ projects: listMigrationProjects() });
      if (req.method === 'GET' && id && !action) {
        const project = getMigrationProject(id);
        return project ? json({ project }) : json({ error: 'Migration project not found.' }, 404);
      }
      if ((req.method === 'POST' || req.method === 'PATCH') && (!id || !action)) {
        const body = await bodyJson(req);
        if (id) body.id = id;
        const project = upsertMigrationProject(body);
        recordSemanticMigrationAuditEvent({ type: 'project_saved', resourceId: project.id, projectId: project.id, sourcePlatform: project.sourcePlatform, outcome: 'completed' });
        return json({ project }, req.method === 'POST' ? 201 : 200);
      }
      if (req.method === 'DELETE' && id && !action) {
        deleteMigrationProject(id);
        recordSemanticMigrationAuditEvent({ type: 'project_deleted', resourceId: id, projectId: id, outcome: 'completed' });
        return json({ ok: true });
      }
    }

    return json({ error: `Unknown Semantic Migration Studio route: ${path}` }, 404);
  } catch (error) {
    const status = typeof (error as { statusCode?: unknown }).statusCode === 'number'
      ? (error as { statusCode: number }).statusCode
      : 500;
    return json({ error: error instanceof Error ? redactSensitiveText(error.message) : 'Semantic migration operation failed.' }, status);
  }
}

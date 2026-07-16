import { randomUUID } from 'node:crypto';

import { jsonHeaders } from '../security';
import { createModelMigrationJob, mergeModelMigrationJob, type ModelMigrationAcceptedFile, type ModelMigrationContentInput, type ModelMigrationContentRepairAction, type ModelMigrationModelInput, type ModelMigrationSemanticDecision } from '../services/migrationJobs';
import { getInstance, isVaultUnlocked, type PostMigrationAction } from '../services/nativeVault';
import { OmniClient, type OmniDocumentRecord, type OmniModelRecord } from '../services/omniClient';
import {
  buildFieldUniverseFromYaml,
  buildSemanticDifferenceDecisions,
  buildTranslatedYamlFiles,
  parseSchemaMap,
  preflightWorkbookQueryFields,
  promptForYamlFile,
  rewriteQueryModelReferences,
} from '../services/modelMigration/helpers';
import { runAiDialectPass, shouldRunAiDialectPass } from '../services/modelMigration/aiTranslation';
import { redactSensitiveText } from '../services/jobSanitizer';

export type ModelMigratorDocumentKind = 'dashboard' | 'workbook' | 'unknown';

export interface ModelMigratorInventoryDocument {
  id: string;
  identifier: string;
  name: string;
  folderId?: string;
  folderPath?: string;
  baseModelId?: string;
  type?: string;
  kind: ModelMigratorDocumentKind;
  description?: string | null;
  labels?: string[];
  updatedAt?: string;
}

export interface ModelMigratorInventoryRow {
  modelId: string;
  dashboardCount: number;
  workbookCount: number;
  unknownCount: number;
  documents: ModelMigratorInventoryDocument[];
}

interface ModelMigratorReadinessCheck {
  id: string;
  label: string;
  status: 'ready' | 'warning' | 'blocked' | 'unknown';
  message: string;
  detail?: string;
}

interface ModelMigratorReadinessInstance {
  instanceId: string;
  label: string;
  baseUrlHost: string;
  role: string;
  reachable: boolean;
  connections: number;
  sharedModels: number;
  schemaModels: number;
  checks: ModelMigratorReadinessCheck[];
}

interface ModelMigratorReadinessPair {
  sourceModelId: string;
  targetModelId?: string;
  status: 'ready' | 'warning' | 'blocked' | 'unknown';
  recommendedPath: 'fast' | 'translate' | 'impact_report';
  releaseMode: 'direct' | 'pr' | 'validate_only';
  autoMigrationCapability?: 'confirmed' | 'requires_confirmation' | 'blocked' | 'unknown';
  schemaOverlap?: {
    sourceSchemas: string[];
    targetSchemas: string[];
    overlappingSchemas: string[];
  };
  checks: ModelMigratorReadinessCheck[];
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: jsonHeaders });
}

function requireUnlocked(): Response | null {
  return isVaultUnlocked() ? null : json({ error: 'vault locked' }, 423);
}

function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

async function bodyJson(req: Request): Promise<Record<string, unknown>> {
  try {
    return await req.json() as Record<string, unknown>;
  } catch {
    return {};
  }
}

function parseCsv(value: string | null): string[] {
  return (value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function isActiveModel(model: OmniModelRecord): boolean {
  return !model.deletedAt;
}

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim()) : [];
}

function parseStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && Boolean(entry[1].trim()))
      .map(([key, row]) => [key, row.trim()]),
  );
}

function hostLabel(baseUrl: string) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  }
}

function check(
  id: string,
  label: string,
  status: ModelMigratorReadinessCheck['status'],
  message: string,
  detail?: string,
): ModelMigratorReadinessCheck {
  return {
    id,
    label,
    status,
    message,
    ...(detail ? { detail: redactSensitiveText(detail) } : {}),
  };
}

function worstStatus(checks: ModelMigratorReadinessCheck[]): ModelMigratorReadinessCheck['status'] {
  if (checks.some((row) => row.status === 'blocked')) return 'blocked';
  if (checks.some((row) => row.status === 'warning')) return 'warning';
  if (checks.some((row) => row.status === 'unknown')) return 'unknown';
  return 'ready';
}

async function inspectReadinessInstance(instanceId: string): Promise<{
  instance: ModelMigratorReadinessInstance;
  connections: Awaited<ReturnType<OmniClient['listConnections']>>;
  models: OmniModelRecord[];
}> {
  const secret = getInstance(instanceId);
  if (!secret) {
    return {
      instance: {
        instanceId,
        label: 'Unknown instance',
        baseUrlHost: '',
        role: 'unknown',
        reachable: false,
        connections: 0,
        sharedModels: 0,
        schemaModels: 0,
        checks: [check('instance-found', 'Saved instance', 'blocked', 'Saved instance was not found in the unlocked vault.')],
      },
      connections: [],
      models: [],
    };
  }
  const client = new OmniClient(secret);
  const checks: ModelMigratorReadinessCheck[] = [];
  let connections: Awaited<ReturnType<OmniClient['listConnections']>> = [];
  let models: OmniModelRecord[] = [];
  let schemaModels = 0;
  let reachable = false;
  try {
    connections = (await client.listConnections()).filter((connection) => !connection.deletedAt);
    models = (await client.listModels({ modelKind: 'SHARED' })).filter(isActiveModel);
    try {
      schemaModels = (await client.listSchemaModels()).filter((model) => !model.deletedAt).length;
    } catch (error) {
      checks.push(check(
        'schema-models',
        'Schema model inventory',
        'warning',
        'Schema model inventory could not be loaded. Migration can continue, but schema readiness will be less precise.',
        error instanceof Error ? error.message : String(error),
      ));
    }
    reachable = true;
    checks.push(check('connectivity', 'API connectivity', 'ready', 'OmniKit can reach this Omni instance.'));
    checks.push(connections.length > 0
      ? check('connections', 'Connections', 'ready', `${connections.length} active connection${connections.length === 1 ? '' : 's'} available.`)
      : check('connections', 'Connections', 'blocked', 'No active connections were returned for this instance.'));
    checks.push(models.length > 0
      ? check('shared-models', 'Shared models', 'ready', `${models.length} active shared model${models.length === 1 ? '' : 's'} available.`)
      : check('shared-models', 'Shared models', 'warning', 'No active shared models were returned for this instance.'));
  } catch (error) {
    checks.push(check(
      'connectivity',
      'API connectivity',
      'blocked',
      'OmniKit could not complete the non-mutating readiness check for this instance.',
      error instanceof Error ? error.message : String(error),
    ));
  }
  return {
    instance: {
      instanceId: secret.id,
      label: secret.label,
      baseUrlHost: hostLabel(secret.baseUrl),
      role: secret.role,
      reachable,
      connections: connections.length,
      sharedModels: models.length,
      schemaModels,
      checks,
    },
    connections,
    models,
  };
}

function buildReadinessPairs(input: {
  sourceModelIds: string[];
  targetModelBySourceId: Record<string, string>;
  sourceModels: OmniModelRecord[];
  targetModels: OmniModelRecord[];
  sourceSchemasByModel?: Record<string, string[]>;
  targetSchemasByModel?: Record<string, string[]>;
}): ModelMigratorReadinessPair[] {
  const sourceById = new Map(input.sourceModels.map((model) => [model.id, model]));
  const targetById = new Map(input.targetModels.map((model) => [model.id, model]));
  return input.sourceModelIds.map((sourceModelId) => {
    const source = sourceById.get(sourceModelId);
    const targetModelId = input.targetModelBySourceId[sourceModelId];
    const target = targetModelId ? targetById.get(targetModelId) : undefined;
    const sourceSchemas = input.sourceSchemasByModel?.[sourceModelId] || [];
    const targetSchemas = targetModelId ? input.targetSchemasByModel?.[targetModelId] || [] : [];
    const targetSchemaSet = new Set(targetSchemas.map((schema) => schema.toLowerCase()));
    const overlappingSchemas = sourceSchemas.filter((schema) => targetSchemaSet.has(schema.toLowerCase()));
    const checks: ModelMigratorReadinessCheck[] = [];
    if (!source) {
      checks.push(check('source-model', 'Source model', 'blocked', 'The selected source model was not returned by Omni.'));
    } else {
      checks.push(check('source-model', 'Source model', 'ready', `${source.name || source.id} is available for migration planning.`));
    }
    if (!targetModelId) {
      checks.push(check('target-model', 'Target model', 'warning', 'Choose a target model to get a publish recommendation.'));
    } else if (!target) {
      checks.push(check('target-model', 'Target model', 'blocked', 'The selected target model was not returned by Omni.'));
    } else {
      checks.push(check('target-model', 'Target model', 'ready', `${target.name || target.id} is available as the destination.`));
    }
    if (target?.pullRequestRequired || target?.gitProtected) {
      checks.push(check('release-mode', 'Release mode', 'warning', 'Target model appears PR/protected. OmniKit should stage changes and hand off review instead of direct merge.'));
    } else if (target) {
      checks.push(check('release-mode', 'Release mode', 'ready', 'Target model appears eligible for direct publish after validation.'));
    }
    if (source?.gitConfigured) {
      checks.push(check('native-migrate', 'Native model migration', 'warning', 'Automatic copy may be available, but OmniKit needs explicit confirmation that the saved credential is an Organization API key.'));
    } else if (source) {
      checks.push(check('native-migrate', 'Native model migration', 'blocked', 'Source model is not confirmed git-backed; review/adapt YAML is the safer default.'));
    }
    if (sourceSchemas.length || targetSchemas.length) {
      checks.push(overlappingSchemas.length > 0
        ? check('schema-overlap', 'Schema overlap', 'ready', `${overlappingSchemas.length} overlapping schema${overlappingSchemas.length === 1 ? '' : 's'} detected.`)
        : check('schema-overlap', 'Schema overlap', 'warning', 'No overlapping schema names were detected. Review data-location mappings before publishing.'));
    }
    const releaseMode = target?.pullRequestRequired || target?.gitProtected ? 'pr' : target ? 'direct' : 'validate_only';
    const autoMigrationCapability = source?.gitConfigured && target && releaseMode === 'direct' ? 'requires_confirmation' : source ? 'blocked' : 'unknown';
    const recommendedPath = target ? 'translate' : 'impact_report';
    return {
      sourceModelId,
      ...(targetModelId ? { targetModelId } : {}),
      status: worstStatus(checks),
      recommendedPath,
      releaseMode,
      autoMigrationCapability,
      schemaOverlap: {
        sourceSchemas,
        targetSchemas,
        overlappingSchemas,
      },
      checks,
    };
  });
}

function parseAcceptedFiles(value: unknown): ModelMigrationAcceptedFile[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    .map((item) => ({
      fileName: cleanString(item.fileName) || '',
      yaml: typeof item.yaml === 'string' ? item.yaml : '',
      previousChecksum: cleanString(item.previousChecksum),
    }))
    .filter((file) => file.fileName && file.yaml);
}

function parseSemanticDecisions(value: unknown): ModelMigrationSemanticDecision[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    .map((item) => {
      const action = cleanString(item.action);
      const kind = cleanString(item.kind);
      return {
        id: cleanString(item.id) || `${kind || 'semantic'}:${cleanString(item.sourceName) || randomUUID()}`,
        kind: kind === 'field' || kind === 'topic' || kind === 'relationship' || kind === 'file' ? kind : 'view',
        sourceName: cleanString(item.sourceName) || '',
        targetName: cleanString(item.targetName),
        sourceFileName: cleanString(item.sourceFileName),
        targetFileName: cleanString(item.targetFileName),
        action: action === 'map_existing' || action === 'create_from_source' || action === 'keep_target' || action === 'ignore' || action === 'custom_edit'
          ? action
          : 'ignore',
        required: item.required === true,
        acceptedYaml: typeof item.acceptedYaml === 'string' ? item.acceptedYaml : undefined,
      } satisfies ModelMigrationSemanticDecision;
    })
    .filter((item) => item.sourceName);
}

function parseContentRepairActions(value: unknown): ModelMigrationContentRepairAction[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    .map((item) => {
      const kind = cleanString(item.kind);
      return {
        id: cleanString(item.id) || `${kind || 'repair'}:${cleanString(item.find) || ''}`,
        kind: kind === 'view' || kind === 'topic' ? kind : 'field',
        find: cleanString(item.find) || '',
        replacement: cleanString(item.replacement) || '',
        approved: item.approved === true,
        includePersonalFolders: item.includePersonalFolders === true,
      } satisfies ModelMigrationContentRepairAction;
    })
    .filter((item) => item.find && item.replacement);
}

function parseModelInputs(value: unknown): ModelMigrationModelInput[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    .map((item) => ({
      sourceModelId: cleanString(item.sourceModelId) || '',
      sourceModelName: cleanString(item.sourceModelName),
      targetModelId: cleanString(item.targetModelId) || '',
      targetModelName: cleanString(item.targetModelName),
      targetConnectionId: cleanString(item.targetConnectionId) || '',
      mode: item.mode === 'fast' ? 'fast' as const : item.mode === 'impact_report' ? 'impact_report' as const : 'translate' as const,
      branchName: cleanString(item.branchName) || '',
      gitRef: cleanString(item.gitRef),
      fastPathSchemaConfirmed: item.fastPathSchemaConfirmed === true,
      orgApiKeyConfirmed: item.orgApiKeyConfirmed === true,
      mergeHandoffRequired: item.mergeHandoffRequired === true,
      acceptedFiles: parseAcceptedFiles(item.acceptedFiles),
      semanticDecisions: parseSemanticDecisions(item.semanticDecisions),
      contentRepairActions: parseContentRepairActions(item.contentRepairActions),
    }))
    .filter((item) => item.sourceModelId && item.targetModelId && item.targetConnectionId && item.branchName);
}

function parsePostMigrationActions(value: unknown): PostMigrationAction[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    .map((item) => {
      const method = cleanString(item.method);
      return {
        kind: item.kind === 'refresh-schema' ? 'refresh-schema' as const : 'webhook' as const,
        name: cleanString(item.name) || 'Post-migration action',
        method: method && ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? method as PostMigrationAction['method'] : 'POST',
        url: cleanString(item.url) || '',
        headers: item.headers && typeof item.headers === 'object' && !Array.isArray(item.headers)
          ? Object.fromEntries(Object.entries(item.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
          : {},
        body: typeof item.body === 'string' ? item.body : '',
        destinationInstanceId: cleanString(item.destinationInstanceId),
        targetModelId: cleanString(item.targetModelId),
        targetModelName: cleanString(item.targetModelName),
      };
    })
    .filter((action) => action.kind === 'refresh-schema' ? Boolean(action.destinationInstanceId && action.targetModelId) : Boolean(action.url));
}

function parseContentInputs(value: unknown): ModelMigrationContentInput[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    .map((item) => ({
      documentId: cleanString(item.documentId) || '',
      documentName: cleanString(item.documentName) || 'Migrated document',
      kind: item.kind === 'dashboard' ? 'dashboard' as const : 'workbook' as const,
      sourceModelId: cleanString(item.sourceModelId) || '',
      targetModelId: cleanString(item.targetModelId) || '',
      targetModelName: cleanString(item.targetModelName),
      targetFolderId: cleanString(item.targetFolderId),
      targetFolderPath: cleanString(item.targetFolderPath),
    }))
    .filter((item) => item.documentId && item.sourceModelId && item.targetModelId);
}

export function classifyModelMigratorDocument(document: Pick<OmniDocumentRecord, 'hasDashboard' | 'type'>): ModelMigratorDocumentKind {
  const type = (document.type || '').toLowerCase();
  if (document.hasDashboard === true) return 'dashboard';
  if (document.hasDashboard === false) return 'workbook';
  if (type.includes('dashboard')) return 'dashboard';
  if (type.includes('workbook') || type.includes('analysis')) return 'workbook';
  return 'unknown';
}

export function buildModelMigratorInventory(
  documents: OmniDocumentRecord[],
  modelIds: string[],
): ModelMigratorInventoryRow[] {
  const selected = new Set(modelIds);
  const grouped = new Map<string, ModelMigratorInventoryDocument[]>();

  for (const document of documents) {
    if (!document.baseModelId || !selected.has(document.baseModelId)) continue;
    const kind = classifyModelMigratorDocument(document);
    const row: ModelMigratorInventoryDocument = {
      id: document.id,
      identifier: document.identifier,
      name: document.name,
      baseModelId: document.baseModelId,
      kind,
      ...(document.folderId ? { folderId: document.folderId } : {}),
      ...(document.folderPath ? { folderPath: document.folderPath } : {}),
      ...(document.type ? { type: document.type } : {}),
      ...(document.description ? { description: document.description } : {}),
      ...(document.labels?.length ? { labels: document.labels } : {}),
      ...(document.updatedAt ? { updatedAt: document.updatedAt } : {}),
    };
    grouped.set(document.baseModelId, [...(grouped.get(document.baseModelId) || []), row]);
  }

  return modelIds.map((modelId) => {
    const rows = grouped.get(modelId) || [];
    return {
      modelId,
      dashboardCount: rows.filter((row) => row.kind === 'dashboard').length,
      workbookCount: rows.filter((row) => row.kind === 'workbook').length,
      unknownCount: rows.filter((row) => row.kind === 'unknown').length,
      documents: rows.sort((a, b) => a.name.localeCompare(b.name)),
    };
  });
}

export default async function handler(req: Request): Promise<Response> {
  try {
    const locked = requireUnlocked();
    if (locked) return locked;

    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api\/model-migrator\/?/, '');
    const parts = path.split('/').filter(Boolean);

    if (req.method === 'POST' && parts[0] === 'readiness') {
      const body = await bodyJson(req);
      const sourceInstanceId = cleanString(body.sourceInstanceId);
      const targetInstanceId = cleanString(body.targetInstanceId);
      if (!sourceInstanceId) return json({ error: 'sourceInstanceId is required.' }, 400);
      const source = await inspectReadinessInstance(sourceInstanceId);
      const target = targetInstanceId ? await inspectReadinessInstance(targetInstanceId) : undefined;
      const sourceModelIds = parseStringArray(body.sourceModelIds);
      const targetModelBySourceId = parseStringMap(body.targetModelBySourceId);
      const sourceSchemasByModel: Record<string, string[]> = {};
      const targetSchemasByModel: Record<string, string[]> = {};
      const sourceSecret = getInstance(sourceInstanceId);
      const targetSecret = targetInstanceId ? getInstance(targetInstanceId) : undefined;
      if (sourceSecret) {
        const sourceClient = new OmniClient(sourceSecret);
        for (const modelId of sourceModelIds.slice(0, 10)) {
          try {
            sourceSchemasByModel[modelId] = await sourceClient.listModelSchemas(modelId);
          } catch {
            sourceSchemasByModel[modelId] = [];
          }
        }
      }
      if (targetSecret) {
        const targetClient = new OmniClient(targetSecret);
        for (const modelId of [...new Set(Object.values(targetModelBySourceId))].slice(0, 10)) {
          try {
            targetSchemasByModel[modelId] = await targetClient.listModelSchemas(modelId);
          } catch {
            targetSchemasByModel[modelId] = [];
          }
        }
      }
      const pairs = buildReadinessPairs({
        sourceModelIds,
        targetModelBySourceId,
        sourceModels: source.models,
        targetModels: target?.models || [],
        sourceSchemasByModel,
        targetSchemasByModel,
      });
      const allChecks = [
        ...source.instance.checks,
        ...(target?.instance.checks || []),
        ...pairs.flatMap((pair) => pair.checks),
      ];
      const blockers = allChecks.filter((row) => row.status === 'blocked').length;
      const warnings = allChecks.filter((row) => row.status === 'warning').length;
      const status = blockers > 0 ? 'blocked' : warnings > 0 ? 'warning' : 'ready';
      return json({
        readiness: {
          source: source.instance,
          ...(target ? { target: target.instance } : {}),
          pairs,
          summary: {
            status,
            label: status === 'ready'
              ? 'Ready for guided migration planning'
              : status === 'warning'
                ? 'Ready with review items'
                : 'Blocked until readiness issues are fixed',
            blockers,
            warnings,
          },
        },
      });
    }

    if (req.method === 'POST' && parts[0] === 'translate') {
      const body = await bodyJson(req);
      const sourceInstanceId = cleanString(body.sourceInstanceId);
      const targetInstanceId = cleanString(body.targetInstanceId);
      const modelId = cleanString(body.modelId);
      const targetModelId = cleanString(body.targetModelId);
      if (!sourceInstanceId || !modelId) return json({ error: 'sourceInstanceId and modelId are required.' }, 400);
      const secret = getInstance(sourceInstanceId);
      if (!secret) return json({ error: 'Source instance not found.' }, 404);
      const schemaMap = parseSchemaMap(typeof body.schemaMapText === 'string' ? body.schemaMapText : '');
      const sourceDialect = cleanString(body.sourceDialect) || 'source';
      const targetDialect = cleanString(body.targetDialect) || 'target';
      const client = new OmniClient(secret);
      const yaml = await client.getModelYaml(modelId, { includeChecksums: true });
      let targetYamlFiles: Record<string, string> = {};
      if (targetInstanceId && targetModelId) {
        const targetSecret = getInstance(targetInstanceId);
        if (targetSecret) {
          try {
            targetYamlFiles = (await new OmniClient(targetSecret).getModelYaml(targetModelId, { includeChecksums: true })).files;
          } catch {
            targetYamlFiles = {};
          }
        }
      }
      const files = buildTranslatedYamlFiles({
        files: yaml.files,
        schemaMap,
        sourceDialect,
        targetDialect,
      });
      if (body.runAi === true) {
        for (const file of files) {
          if (!shouldRunAiDialectPass(file.fileName, file.translated)) {
            file.warnings.push('No SQL-bearing section detected; AI dialect pass was skipped for this file.');
            continue;
          }
          const prompt = promptForYamlFile({ sourceDialect, targetDialect, fileName: file.fileName, schemaMap, yaml: file.translated });
          try {
            const result = await runAiDialectPass(client, modelId, prompt);
            if (result.yaml) {
              file.aiDraft = result.yaml;
              file.aiJobId = result.jobId;
              file.translated = result.yaml;
              file.changed = file.original !== result.yaml;
              file.reviewRequired = true;
              file.warnings.push(`AI dialect pass applied from Omni AI job ${result.jobId || 'unknown'}. Review before accepting.`);
            }
            if (result.refusal) {
              file.aiJobId = result.jobId;
              file.aiRefusal = redactSensitiveText(result.refusal);
              file.warnings.push(file.aiRefusal);
            }
            if (result.warning) file.warnings.push(redactSensitiveText(result.warning));
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            file.aiRefusal = 'Omni AI dialect pass failed for this file; deterministic translation remains available for review.';
            file.warnings.push(`${file.aiRefusal} ${redactSensitiveText(message)}`);
          }
        }
      }
      return json({
        files,
        checksums: yaml.checksums || {},
        semanticDecisions: buildSemanticDifferenceDecisions({ sourceFiles: yaml.files, targetFiles: targetYamlFiles }),
        prompts: files.map((file) => ({
          fileName: file.fileName,
          prompt: promptForYamlFile({ sourceDialect, targetDialect, fileName: file.fileName, schemaMap, yaml: file.translated }),
        })),
      });
    }

    if (req.method === 'POST' && parts[0] === 'preflight') {
      const body = await bodyJson(req);
      const sourceInstanceId = cleanString(body.sourceInstanceId);
      const targetInstanceId = cleanString(body.targetInstanceId);
      const sourceModelId = cleanString(body.sourceModelId);
      const targetModelId = cleanString(body.targetModelId);
      const documentIds = parseStringArray(body.documentIds);
      if (!sourceInstanceId || !targetInstanceId || !sourceModelId || !targetModelId) {
        return json({ error: 'sourceInstanceId, targetInstanceId, sourceModelId, and targetModelId are required.' }, 400);
      }
      const source = getInstance(sourceInstanceId);
      const target = getInstance(targetInstanceId);
      if (!source || !target) return json({ error: 'Source or target instance not found.' }, 404);
      const sourceClient = new OmniClient(source);
      const targetClient = new OmniClient(target);
      const targetYaml = await targetClient.getModelYaml(targetModelId, { includeChecksums: true });
      const universe = buildFieldUniverseFromYaml(targetYaml.files);
      const workbooks = [];
      for (const documentId of documentIds) {
        const queries = await sourceClient.getDocumentQueries(documentId);
        const tabs = queries.map((query) => {
          const rewritten = rewriteQueryModelReferences(query.query, sourceModelId, targetModelId);
          const preflight = preflightWorkbookQueryFields(rewritten, universe);
          return {
            id: query.id,
            name: query.name,
            fieldReferences: preflight.fieldReferences,
            blockers: preflight.blockers,
            replacementCount: preflight.replacements,
          };
        });
        workbooks.push({
          documentId,
          tabCount: tabs.length,
          blockerCount: tabs.reduce((sum, tab) => sum + tab.blockers.length, 0),
          tabs,
        });
      }
      return json({ workbooks });
    }

    if (req.method === 'POST' && parts[0] === 'jobs') {
      if (parts[2] === 'merge') {
        const body = await bodyJson(req);
        const job = await mergeModelMigrationJob(parts[1], {
          publishDrafts: body.publishDrafts === true,
          deleteBranch: body.deleteBranch !== false,
        });
        return json({ job });
      }

      const body = await bodyJson(req);
      const sourceId = cleanString(body.sourceId);
      const targetId = cleanString(body.targetId);
      if (!sourceId || !targetId) return json({ error: 'sourceId and targetId are required.' }, 400);
      const models = parseModelInputs(body.models);
      if (models.length === 0) return json({ error: 'At least one model migration target is required.' }, 400);
      if (models.some((model) => model.mode === 'fast' && (model.fastPathSchemaConfirmed !== true || model.orgApiKeyConfirmed !== true))) {
        return json({ error: 'Automatic copy requires explicit data-location compatibility and Organization API key confirmation for every selected model.' }, 400);
      }
      if (models.some((model) => model.mode === 'translate' && (model.acceptedFiles?.length || 0) === 0)) {
        return json({ error: 'Review/adapt models require at least one accepted YAML file.' }, 400);
      }
      const job = await createModelMigrationJob({
        sourceId,
        targetId,
        targetLabel: cleanString(body.targetLabel),
        models,
        content: parseContentInputs(body.content),
        replaceSameNamed: body.replaceSameNamed !== false,
        mergeAfterValidation: body.mergeAfterValidation === true,
        publishDrafts: body.publishDrafts === true,
        deleteBranch: body.deleteBranch === true,
        postMigrationActions: parsePostMigrationActions(body.postMigrationActions),
      });
      return json({ job });
    }

    const instanceId = parts[0];
    const action = parts[1];
    if (!instanceId) return json({ error: 'Instance id required.' }, 400);

    const secret = getInstance(instanceId);
    if (!secret) return json({ error: 'Instance not found.' }, 404);
    const client = new OmniClient(secret);

    if (req.method === 'GET' && action === 'connections') {
      const connections = (await client.listConnections()).filter((connection) => !connection.deletedAt);
      return json({ connections });
    }

    if (req.method === 'GET' && action === 'models') {
      const connectionId = cleanString(url.searchParams.get('connectionId'));
      const modelKind = cleanString(url.searchParams.get('modelKind')) || 'SHARED';
      const models = (await client.listModels({ modelKind, connectionId }))
        .filter(isActiveModel)
        .filter((model) => !connectionId || model.connectionId === connectionId);
      return json({ models });
    }

    if (req.method === 'GET' && action === 'inventory') {
      const modelIds = parseCsv(url.searchParams.get('modelIds'));
      if (modelIds.length === 0) return json({ models: [] });
      const documents = await client.listFolderDocuments(undefined, true);
      return json({ models: buildModelMigratorInventory(documents, modelIds) });
    }

    return json({ error: `Unknown model migrator route: ${path}` }, 404);
  } catch (error) {
    const statusCode = typeof (error as { statusCode?: unknown }).statusCode === 'number'
      ? (error as { statusCode: number }).statusCode
      : 500;
    return json({ error: redactSensitiveText(error instanceof Error ? error.message : 'Model migrator request failed.') }, statusCode);
  }
}

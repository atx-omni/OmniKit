import { jsonHeaders } from '../security';
import { createDashboardBranchPreparationPlan, createTopicMigrationPlan, getTopicMigrationPlan, listTopicMigrationTopics, stageTopicMigrationPlan, verifyTopicMigrationBranch } from '../services/topicMigrationPlans';
import { createModelMigrationJob } from '../services/migrationJobs';
import { getInstance, isVaultUnlocked } from '../services/nativeVault';
import type { OmniDocumentRecord } from '../services/omniClient';
import { loadModelMigratorConnections, loadModelMigratorSharedModels, normalizeModelMigratorRequestError, runModelMigratorInteractiveOperation } from '../services/modelMigratorCatalog';
import { redactSensitiveText } from '../services/jobSanitizer';
import { JobHistoryUnavailableError } from '../services/jobStore';

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


function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: jsonHeaders });
}
async function bodyJson(req: Request): Promise<unknown> {
  try { return await req.json(); }
  catch { throw Object.assign(new Error('A valid JSON request is required.'), { statusCode: 400 }); }
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


/** One branch-review workflow; old action URLs remain explicit, fail-closed compatibility boundaries. */
export default async function handler(req: Request, dependencies: { createJob?: typeof createModelMigrationJob } = {}): Promise<Response> {
  try {
    if (!isVaultUnlocked()) return json({ error: 'vault locked' }, 423);
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api\/model-migrator\/?/, '');
    const parts = path.split('/').filter(Boolean);
    if (['jobs', 'translate', 'preflight', 'readiness'].includes(parts[0]) || parts[1] === 'inventory') {
      return json({ error: 'This Model Migrator operation has retired. Prepare an additive review branch, then finalize SQL, table mappings, validation, and deployment manually in Omni.',
        code: 'MODEL_MIGRATOR_BRANCH_REVIEW_ONLY' }, 410);
    }
    if (req.method === 'POST' && path === 'topics') {
      const body = await bodyJson(req);
      return await runModelMigratorInteractiveOperation(async (signal) => json(await listTopicMigrationTopics(body, signal)), { signal: req.signal });
    }
    if (parts[0] === 'topic-plan') {
      if (req.method === 'POST' && parts.length === 2 && parts[1] === 'dashboard') {
        const body = await bodyJson(req);
        return await runModelMigratorInteractiveOperation(async (signal) => json({ plan: await createDashboardBranchPreparationPlan(body, signal) }), { signal: req.signal });
      }
      if (req.method === 'POST' && parts.length === 1) {
        const body = await bodyJson(req);
        return await runModelMigratorInteractiveOperation(async (signal) => json({ plan: await createTopicMigrationPlan(body, signal) }), { signal: req.signal });
      }
      if (req.method === 'GET' && parts.length === 2) return json({ plan: getTopicMigrationPlan(parts[1]) });
      if (req.method === 'POST' && parts.length === 3 && parts[2] === 'stage') {
        const body = await bodyJson(req);
        return await runModelMigratorInteractiveOperation(async (signal) => json(await stageTopicMigrationPlan(parts[1], body, dependencies.createJob || createModelMigrationJob, signal)), { signal: req.signal });
      }
      if (req.method === 'POST' && parts.length === 3 && parts[2] === 'verify') {
        const body = await bodyJson(req);
        return await runModelMigratorInteractiveOperation(async (signal) => json(await verifyTopicMigrationBranch(parts[1], body, signal)), { signal: req.signal });
      }
      return json({ error: 'Unknown topic-plan route.' }, 404);
    }
    if (req.method !== 'GET' || parts.length !== 2 || !['connections', 'models'].includes(parts[1])) return json({ error: 'Unknown model branch-review route.' }, 404);
    const instance = getInstance(parts[0]);
    if (!instance) return json({ error: 'Instance not found.' }, 404);
    const forceRefresh = url.searchParams.get('forceRefresh') === 'true';
    try {
      return await runModelMigratorInteractiveOperation(async (signal) => {
        if (parts[1] === 'connections') return json({ connections: (await loadModelMigratorConnections(instance, { signal, forceRefresh })).filter((row) => !row.deletedAt) });
        const modelKind = url.searchParams.get('modelKind');
        if (modelKind && modelKind !== 'SHARED') return json({ error: 'Branch review selects shared models only.' }, 400);
        const connectionId = url.searchParams.get('connectionId')?.trim();
        return json({ models: (await loadModelMigratorSharedModels(instance, connectionId, { signal, forceRefresh }))
          .filter((row) => !row.deletedAt && (!connectionId || row.connectionId === connectionId)) });
      }, { signal: req.signal });
    } catch (error) {
      const normalized = normalizeModelMigratorRequestError(error, req.signal);
      return json({ error: normalized.message, code: normalized.code, retryable: normalized.retryable }, normalized.statusCode);
    }
  } catch (error) {
    const statusCode = typeof (error as { statusCode?: unknown }).statusCode === 'number' ? (error as { statusCode: number }).statusCode : 500;
    return json({ error: redactSensitiveText(error instanceof Error ? error.message : 'Model branch-review request failed.'),
      ...(error instanceof JobHistoryUnavailableError ? { code: error.code } : {}) }, statusCode);
  }
}

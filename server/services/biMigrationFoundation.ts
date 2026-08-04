import { createHash } from 'node:crypto';
import {
  DESTINATION_FOUNDATION_PLAN_VERSION,
  createDestinationFoundationState,
  transitionDestinationFoundationState,
  type DestinationFoundationInventory,
  type DestinationFoundationPlan,
  type DestinationFoundationProvisionResult,
  type DestinationFoundationSharedModel,
  type DestinationFoundationState,
  type DestinationVaultCredentialReference,
  type ExistingConnectionDestinationFoundationPlan,
} from '../../src/services/semanticMigration/destinationFoundation';
import {
  OmniClientError,
  type OmniConnectionRecord,
  type OmniCreateModelInput,
  type OmniCreateModelResult,
  type OmniJobStatusResult,
  type OmniListModelsOptions,
  type OmniModelRecord,
  type OmniSchemaModelRecord,
} from './omniClient';
import {
  appendBiMigrationOperationTransition,
  appendBiMigrationRunTransition,
  createBiMigrationRun,
  getBiMigrationRun,
  markBiMigrationOperationDispatched,
  type BiMigrationBootstrapRun,
  type BiMigrationRunResources,
  type HashDigest,
} from './biMigrationRunStore';

export interface BiMigrationFoundationClient {
  listConnections(): Promise<OmniConnectionRecord[]>;
  listSchemaModels(): Promise<OmniSchemaModelRecord[]>;
  listModels(options?: string | OmniListModelsOptions): Promise<OmniModelRecord[]>;
  createModel(input: OmniCreateModelInput): Promise<OmniCreateModelResult>;
  refreshModel(modelId: string): Promise<{ jobId?: string; status?: string; raw: unknown }>;
  getJobStatus(jobId: string): Promise<OmniJobStatusResult>;
}

export interface DestinationConnectionCreateInput {
  client: BiMigrationFoundationClient;
  targetInstanceId: string;
  name: string;
  dialect: string;
  credentialReference: DestinationVaultCredentialReference;
}

export type DestinationConnectionCreator = (
  input: DestinationConnectionCreateInput,
) => Promise<OmniConnectionRecord>;

export interface BiMigrationFoundationProvisionOptions {
  maxPollAttempts?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  sleep?: (milliseconds: number) => Promise<void>;
  createConnection?: DestinationConnectionCreator;
}

export interface BiMigrationFoundationRunOptions extends BiMigrationFoundationProvisionOptions {
  idempotencyKey?: string;
}

export type BiMigrationFoundationErrorCode =
  | 'connection_adapter_unsupported'
  | 'destination_connection_not_found'
  | 'destination_inventory_failed'
  | 'destination_model_not_found'
  | 'destination_permission_denied'
  | 'destination_schema_model_ambiguous'
  | 'destination_schema_model_not_found'
  | 'foundation_cancelled'
  | 'foundation_reconcile_required'
  | 'schema_model_create_failed'
  | 'schema_refresh_failed'
  | 'schema_refresh_timeout'
  | 'schema_refresh_untrackable'
  | 'shared_model_create_failed';

export class BiMigrationFoundationError extends Error {
  partialResult?: DestinationFoundationProvisionResult;
  runId?: string;

  constructor(
    readonly code: BiMigrationFoundationErrorCode,
    message: string,
    readonly statusCode: number,
    readonly omni?: {
      status: number;
      httpStatus?: number;
      code?: string;
      message: string;
    },
  ) {
    super(message);
    this.name = 'BiMigrationFoundationError';
  }

  withPartialResult(partialResult: DestinationFoundationProvisionResult): this {
    this.partialResult ||= partialResult;
    return this;
  }

  withRunId(runId: string): this {
    this.runId = runId;
    return this;
  }
}

const SUCCESS_JOB_STATUSES = new Set(['COMPLETE', 'COMPLETED', 'DONE', 'SUCCESS', 'SUCCEEDED']);
const FAILED_JOB_STATUSES = new Set(['CANCELED', 'CANCELLED', 'ERROR', 'FAILED']);

function normalizedName(value: string): string {
  return value.trim().toLowerCase();
}

function normalizedStatus(value?: string): string {
  return (value || 'UNKNOWN').trim().toUpperCase();
}

function isConflict(error: unknown): boolean {
  return error instanceof OmniClientError
    ? error.status === 409
    : Boolean(error && typeof error === 'object' && 'status' in error && (error as { status?: unknown }).status === 409);
}

function safeOperationError(
  error: unknown,
  code: BiMigrationFoundationErrorCode,
  message: string,
): BiMigrationFoundationError {
  if (error instanceof BiMigrationFoundationError) return error;
  const status = error instanceof OmniClientError
    ? error.status
    : error && typeof error === 'object' && 'status' in error && typeof (error as { status?: unknown }).status === 'number'
      ? Number((error as { status: number }).status)
      : 0;
  if (status === 401 || status === 403) {
    return new BiMigrationFoundationError(
      'destination_permission_denied',
      'The saved Omni instance is not authorized to manage destination models.',
      403,
    );
  }
  return new BiMigrationFoundationError(code, message, 502);
}

function modelCreationError(
  error: unknown,
  code: 'schema_model_create_failed' | 'shared_model_create_failed',
  modelLabel: string,
): BiMigrationFoundationError {
  if (!(error instanceof OmniClientError)) {
    return safeOperationError(
      error,
      code,
      `OmniKit could not create the destination ${modelLabel}.`,
    );
  }
  const omni = {
    status: error.status,
    ...(error.httpStatus !== error.status ? { httpStatus: error.httpStatus } : {}),
    ...(error.omniCode ? { code: error.omniCode } : {}),
    message: error.omniMessage,
  };
  const codeLabel = error.omniCode ? ` (${error.omniCode})` : '';
  const statusLabel = error.httpStatus === error.status
    ? `HTTP ${error.status}`
    : `HTTP ${error.httpStatus}, Omni status ${error.status}`;
  return new BiMigrationFoundationError(
    code,
    `Omni returned ${statusLabel}${codeLabel} while creating the destination ${modelLabel}: ${error.omniMessage}`,
    error.status >= 400 && error.status <= 599 ? error.status : 502,
    omni,
  );
}

function connectionById(inventory: DestinationFoundationInventory, connectionId: string) {
  return inventory.connections.find((connection) => connection.id === connectionId);
}

function schemaModelByName(
  inventory: DestinationFoundationInventory,
  connectionId: string,
  modelName: string,
) {
  const name = normalizedName(modelName);
  const matches = inventory.schemaModels.filter((model) => normalizedName(model.name) === name);
  const connected = matches.filter((model) => model.connectionId === connectionId);
  if (connected.length === 1) return connected[0];
  const unscoped = matches.filter((model) => !model.connectionId);
  return connected.length === 0 && matches.length === 1 && unscoped.length === 1
    ? unscoped[0]
    : undefined;
}

function schemaModelForExistingConnection(
  inventory: DestinationFoundationInventory,
  connectionId: string,
  plan: ExistingConnectionDestinationFoundationPlan,
) {
  if ('schemaModelId' in plan) {
    const model = inventory.schemaModels.find((candidate) => candidate.id === plan.schemaModelId);
    return model && (!model.connectionId || model.connectionId === connectionId) ? model : undefined;
  }
  if (!plan.reuseExistingSchemaModel) return schemaModelByName(inventory, connectionId, plan.schemaModelName);

  const byId = inventory.schemaModels.find((candidate) => candidate.id === plan.schemaModelName);
  if (byId) return !byId.connectionId || byId.connectionId === connectionId ? byId : undefined;

  const name = normalizedName(plan.schemaModelName);
  const matches = inventory.schemaModels.filter((model) => (
    normalizedName(model.name) === name
    && (!model.connectionId || model.connectionId === connectionId)
  ));
  if (matches.length > 1) {
    throw new BiMigrationFoundationError(
      'destination_schema_model_ambiguous',
      'More than one schema model matches the explicit reuse reference. Select a detected schema model or enter its exact ID.',
      409,
    );
  }
  return matches[0];
}

function sharedModelByName(
  inventory: DestinationFoundationInventory,
  connectionId: string,
  schemaModelId: string,
  modelName: string,
) {
  const name = normalizedName(modelName);
  const matches = inventory.sharedModels.filter((model) => (
    (!model.connectionId || model.connectionId === connectionId)
    && normalizedName(model.name) === name
  ));
  const exact = matches.find((model) => model.baseModelId === schemaModelId);
  if (exact) return exact;

  // Omni infers a SHARED model's schema foundation from connectionId and may
  // omit baseModelId from list responses. Only adopt an unscoped name match
  // when it is unique on the selected connection.
  const unscoped = matches.filter((model) => !model.baseModelId);
  return matches.length === 1 && unscoped.length === 1 ? unscoped[0] : undefined;
}

function uniqueModels(models: OmniModelRecord[]): OmniModelRecord[] {
  return [...new Map(models.map((model) => [model.id, model])).values()];
}

export async function loadBiMigrationFoundationInventory(
  client: BiMigrationFoundationClient,
  targetInstanceId: string,
): Promise<DestinationFoundationInventory> {
  try {
    const connections = (await client.listConnections())
      .filter((connection) => !connection.deletedAt && connection.id && connection.name)
      .map((connection) => ({
        id: connection.id,
        name: connection.name,
        dialect: connection.dialect,
        database: connection.database || undefined,
        defaultSchema: connection.defaultSchema || undefined,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
    const schemaModels = (await client.listSchemaModels())
      .filter((model) => !model.deletedAt && model.id && model.name)
      .map((model) => ({ id: model.id, name: model.name, connectionId: model.connectionId }))
      .sort((left, right) => left.name.localeCompare(right.name));
    const sharedModels = uniqueModels([
      ...(await client.listModels({ modelKind: 'SHARED' })),
      ...(await client.listModels({ modelKind: 'SHARED_EXTENSION' })),
    ])
      .filter((model) => !model.deletedAt && model.id && model.name)
      .map((model) => ({
        id: model.id,
        name: model.name,
        connectionId: model.connectionId,
        baseModelId: model.baseModelId,
        kind: model.kind === 'SHARED_EXTENSION' ? 'SHARED_EXTENSION' as const : 'SHARED' as const,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
    return {
      version: DESTINATION_FOUNDATION_PLAN_VERSION,
      targetInstanceId,
      connections,
      schemaModels,
      sharedModels,
    };
  } catch (error) {
    throw safeOperationError(
      error,
      'destination_inventory_failed',
      'OmniKit could not load destination connection and model inventory from the saved Omni instance.',
    );
  }
}

export async function createDestinationConnection(
  input: DestinationConnectionCreateInput,
): Promise<OmniConnectionRecord> {
  void input;
  throw new BiMigrationFoundationError(
    'connection_adapter_unsupported',
    'Creating this Omni connection requires a server-side dialect adapter. Create the connection in Omni, then refresh destination inventory.',
    422,
  );
}

async function createSchemaModel(
  client: BiMigrationFoundationClient,
  targetInstanceId: string,
  connectionId: string,
  modelName: string,
): Promise<{ model: { id: string; name: string; connectionId?: string }; reused: boolean }> {
  try {
    const created = await client.createModel({ connectionId, modelName, modelKind: 'SCHEMA' });
    return { model: created, reused: false };
  } catch (error) {
    if (isConflict(error)) {
      const inventory = await loadBiMigrationFoundationInventory(client, targetInstanceId);
      const existing = schemaModelByName(inventory, connectionId, modelName);
      if (existing) return { model: existing, reused: true };
    }
    throw modelCreationError(error, 'schema_model_create_failed', 'schema model');
  }
}

async function createSharedModel(
  client: BiMigrationFoundationClient,
  targetInstanceId: string,
  connectionId: string,
  schemaModelId: string,
  modelName: string,
): Promise<{ model: DestinationFoundationSharedModel; reused: boolean }> {
  try {
    const created = await client.createModel({
      connectionId,
      modelName,
      modelKind: 'SHARED',
    });
    return {
      model: {
        id: created.id,
        name: created.name,
        connectionId: created.connectionId,
        baseModelId: created.baseModelId || schemaModelId,
        kind: 'SHARED',
      },
      reused: false,
    };
  } catch (error) {
    if (isConflict(error)) {
      const inventory = await loadBiMigrationFoundationInventory(client, targetInstanceId);
      const existing = sharedModelByName(inventory, connectionId, schemaModelId, modelName);
      if (existing) return { model: existing, reused: true };
    }
    throw modelCreationError(error, 'shared_model_create_failed', 'shared model');
  }
}

async function refreshSchemaModel(
  client: BiMigrationFoundationClient,
  schemaModelId: string,
): Promise<{ jobId?: string; status?: string }> {
  try {
    return await client.refreshModel(schemaModelId);
  } catch (error) {
    throw safeOperationError(
      error,
      'schema_refresh_failed',
      'Omni could not refresh the destination schema model. Resolve the connection or schema issue in Omni, then retry.',
    );
  }
}

async function waitForSchemaRefresh(
  client: BiMigrationFoundationClient,
  refresh: { jobId?: string; status?: string },
  options: BiMigrationFoundationProvisionOptions,
): Promise<void> {
  const initialStatus = normalizedStatus(refresh.status);
  if (SUCCESS_JOB_STATUSES.has(initialStatus)) return;
  if (FAILED_JOB_STATUSES.has(initialStatus)) {
    throw new BiMigrationFoundationError(
      'schema_refresh_failed',
      'Omni could not refresh the destination schema model. Resolve the connection or schema issue in Omni, then retry.',
      409,
    );
  }
  if (!refresh.jobId) {
    throw new BiMigrationFoundationError(
      'schema_refresh_untrackable',
      'Omni did not return a trackable schema refresh job, so shared model creation was stopped.',
      502,
    );
  }

  const maxPollAttempts = Math.max(1, Math.min(options.maxPollAttempts ?? 120, 600));
  const pollIntervalMs = Math.max(0, Math.min(options.pollIntervalMs ?? 1_000, 30_000));
  const sleep = options.sleep || ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
    if (options.signal?.aborted) {
      throw new BiMigrationFoundationError('foundation_cancelled', 'Destination provisioning was cancelled.', 408);
    }
    let job: OmniJobStatusResult;
    try {
      job = await client.getJobStatus(refresh.jobId);
    } catch (error) {
      throw safeOperationError(
        error,
        'schema_refresh_failed',
        'OmniKit could not monitor the destination schema refresh.',
      );
    }
    const status = normalizedStatus(job.status);
    if (SUCCESS_JOB_STATUSES.has(status)) return;
    if (FAILED_JOB_STATUSES.has(status)) {
      throw new BiMigrationFoundationError(
        'schema_refresh_failed',
        'Omni could not refresh the destination schema model. Resolve the connection or schema issue in Omni, then retry.',
        409,
      );
    }
    if (attempt + 1 < maxPollAttempts && pollIntervalMs > 0) await sleep(pollIntervalMs);
  }
  throw new BiMigrationFoundationError(
    'schema_refresh_timeout',
    'The destination schema refresh did not finish before the provisioning timeout. Shared model creation was stopped.',
    504,
  );
}

function result(
  state: DestinationFoundationState,
  inventory: DestinationFoundationInventory,
  created: DestinationFoundationProvisionResult['created'],
): DestinationFoundationProvisionResult {
  return { version: DESTINATION_FOUNDATION_PLAN_VERSION, state, inventory, created };
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableValue(child)}`)
    .join(',')}}`;
}

function foundationHash(value: unknown): HashDigest {
  return `sha256:${createHash('sha256').update(stableValue(value)).digest('hex')}`;
}

function runSummary(run: BiMigrationBootstrapRun): NonNullable<DestinationFoundationProvisionResult['run']> {
  const phase = run.phase === 'READY_FOR_YAML' || run.phase === 'RECONCILE_REQUIRED'
    ? run.phase
    : 'FAILED';
  return { id: run.id, version: run.version, phase, planHash: run.planHash };
}

function foundationResources(resultValue: DestinationFoundationProvisionResult) {
  const state = resultValue.state;
  return {
    ...(state.connectionId ? {
      connection: {
        id: state.connectionId,
        ownership: resultValue.created.connection ? 'created_by_run' as const : 'external' as const,
        kind: 'connection',
      },
    } : {}),
    ...(state.schemaModelId ? {
      schemaModel: {
        id: state.schemaModelId,
        ownership: resultValue.created.schemaModel ? 'created_by_run' as const : 'external' as const,
        kind: 'schema_model',
        connectionId: state.connectionId,
      },
    } : {}),
    ...(state.sharedModelId ? {
      sharedModel: {
        id: state.sharedModelId,
        ownership: resultValue.created.sharedModel ? 'created_by_run' as const : 'external' as const,
        kind: 'shared_model',
        connectionId: state.connectionId,
        baseModelId: state.schemaModelId,
      },
    } : {}),
  };
}

function mergeFoundationResources(
  existing: BiMigrationRunResources,
  observed: BiMigrationRunResources,
): BiMigrationRunResources {
  const merged: BiMigrationRunResources = { ...existing };
  for (const key of ['connection', 'schemaModel', 'sharedModel', 'branch'] as const) {
    const resource = observed[key];
    if (!resource) continue;
    if (!merged[key] || merged[key]?.id !== resource.id) merged[key] = resource;
  }
  return merged;
}

async function inspectExistingConnectionFoundation(
  client: BiMigrationFoundationClient,
  plan: ExistingConnectionDestinationFoundationPlan,
): Promise<DestinationFoundationProvisionResult> {
  const inventory = await loadBiMigrationFoundationInventory(client, plan.targetInstanceId);
  let state = transitionDestinationFoundationState(
    createDestinationFoundationState(plan),
    { type: 'inventory_loaded' },
  );
  const created = { connection: false, schemaModel: false, sharedModel: false };
  const connection = connectionById(inventory, plan.connectionId);
  if (!connection) return result(state, inventory, created);

  state = transitionDestinationFoundationState(state, {
    type: 'connection_resolved',
    connectionId: connection.id,
    reused: true,
  });
  const schemaModel = schemaModelForExistingConnection(inventory, connection.id, plan);
  if (!schemaModel) return result(state, inventory, created);

  state = transitionDestinationFoundationState(state, {
    type: 'schema_model_resolved',
    schemaModelId: schemaModel.id,
    reused: true,
  });
  const sharedModel = sharedModelByName(
    inventory,
    connection.id,
    schemaModel.id,
    plan.sharedModelName,
  );
  if (!sharedModel) return result(state, inventory, created);

  state = transitionDestinationFoundationState(state, {
    type: 'foundation_resolved',
    connectionId: connection.id,
    schemaModelId: schemaModel.id,
    sharedModelId: sharedModel.id,
  });
  return result(state, inventory, created);
}

function reconciledOperationResource(
  inspected: DestinationFoundationProvisionResult,
) {
  if (inspected.state.sharedModelId) {
    return {
      id: inspected.state.sharedModelId,
      ownership: 'adopted' as const,
      kind: 'shared_model',
      connectionId: inspected.state.connectionId,
      baseModelId: inspected.state.schemaModelId,
    };
  }
  if (inspected.state.schemaModelId) {
    return {
      id: inspected.state.schemaModelId,
      ownership: 'adopted' as const,
      kind: 'schema_model',
      connectionId: inspected.state.connectionId,
    };
  }
  if (inspected.state.connectionId) {
    return {
      id: inspected.state.connectionId,
      ownership: 'external' as const,
      kind: 'connection',
    };
  }
  return undefined;
}

function nextFoundationOperationKey(run: BiMigrationBootstrapRun): string {
  const attempt = run.operations.filter((operation) => (
    operation.kind === 'provision_destination_foundation'
  )).length + 1;
  return attempt === 1 ? 'destination-foundation' : `destination-foundation-${attempt}`;
}

function ambiguousFoundationFailure(error: unknown): boolean {
  if (error instanceof BiMigrationFoundationError) {
    return error.statusCode >= 500 || error.statusCode === 429;
  }
  if (error instanceof OmniClientError) return error.status >= 500 || error.status === 429;
  return true;
}

export async function provisionBiMigrationFoundation(
  client: BiMigrationFoundationClient,
  plan: DestinationFoundationPlan,
  options: BiMigrationFoundationProvisionOptions = {},
): Promise<DestinationFoundationProvisionResult> {
  let state = createDestinationFoundationState(plan);
  let progressInventory: DestinationFoundationInventory | undefined;
  const created = { connection: false, schemaModel: false, sharedModel: false };

  try {
    let inventory = await loadBiMigrationFoundationInventory(client, plan.targetInstanceId);
    progressInventory = inventory;
    state = transitionDestinationFoundationState(state, { type: 'inventory_loaded' });

    if (plan.mode === 'existing_model') {
      const model = inventory.sharedModels.find((candidate) => candidate.id === plan.modelId);
      if (!model) {
        throw new BiMigrationFoundationError(
          'destination_model_not_found',
          'The selected destination model is not available on the saved Omni instance.',
          404,
        );
      }
      state = transitionDestinationFoundationState(state, { type: 'existing_model_resolved', modelId: model.id });
      return result(state, inventory, created);
    }

    let connection: OmniConnectionRecord | DestinationFoundationInventory['connections'][number];
    if (plan.mode === 'new_connection') {
      const connectionCreator = options.createConnection || createDestinationConnection;
      connection = await connectionCreator({
        client,
        targetInstanceId: plan.targetInstanceId,
        name: plan.connectionName,
        dialect: plan.dialect,
        credentialReference: plan.credentialReference,
      });
      created.connection = true;
    } else {
      const existingConnection = connectionById(inventory, plan.connectionId);
      if (!existingConnection) {
        throw new BiMigrationFoundationError(
          'destination_connection_not_found',
          'The selected destination connection is not available on the saved Omni instance.',
          404,
        );
      }
      connection = existingConnection;
    }
    state = transitionDestinationFoundationState(state, {
      type: 'connection_resolved',
      connectionId: connection.id,
      reused: !created.connection,
    });

    const sharedModelName = plan.sharedModelName;
    let schemaModel = plan.mode === 'existing_connection'
      ? schemaModelForExistingConnection(inventory, connection.id, plan)
      : schemaModelByName(inventory, connection.id, plan.schemaModelName);
    if (schemaModel) {
      const existingSharedModel = sharedModelByName(inventory, connection.id, schemaModel.id, sharedModelName);
      if (existingSharedModel) {
        state = transitionDestinationFoundationState(state, {
          type: 'foundation_resolved',
          connectionId: connection.id,
          schemaModelId: schemaModel.id,
          sharedModelId: existingSharedModel.id,
        });
        return result(state, inventory, created);
      }
    } else if (
      plan.mode === 'existing_connection'
      && ('schemaModelId' in plan || plan.reuseExistingSchemaModel)
    ) {
      throw new BiMigrationFoundationError(
        'destination_schema_model_not_found',
        'The selected existing schema model is not available for this Omni connection. Refresh inventory or choose the explicit reuse fallback with its exact model ID.',
        404,
      );
    } else {
      const schemaModelName = plan.schemaModelName;
      const schemaResult = await createSchemaModel(client, plan.targetInstanceId, connection.id, schemaModelName);
      schemaModel = schemaResult.model;
      created.schemaModel = !schemaResult.reused;
    }
    state = transitionDestinationFoundationState(state, {
      type: 'schema_model_resolved',
      schemaModelId: schemaModel.id,
      reused: !created.schemaModel,
    });

    const refresh = await refreshSchemaModel(client, schemaModel.id);
    state = transitionDestinationFoundationState(state, { type: 'schema_refresh_started', jobId: refresh.jobId });
    await waitForSchemaRefresh(client, refresh, options);
    state = transitionDestinationFoundationState(state, { type: 'schema_refresh_succeeded' });

    inventory = await loadBiMigrationFoundationInventory(client, plan.targetInstanceId);
    progressInventory = inventory;
    const existingSharedModel = sharedModelByName(inventory, connection.id, schemaModel.id, sharedModelName);
    let sharedModel: DestinationFoundationSharedModel;
    let reusedSharedModel: boolean;
    if (existingSharedModel) {
      sharedModel = existingSharedModel;
      reusedSharedModel = true;
    } else {
      const sharedResult = await createSharedModel(
        client,
        plan.targetInstanceId,
        connection.id,
        schemaModel.id,
        sharedModelName,
      );
      sharedModel = sharedResult.model;
      reusedSharedModel = sharedResult.reused;
      created.sharedModel = !sharedResult.reused;
    }
    state = transitionDestinationFoundationState(state, {
      type: 'shared_model_resolved',
      sharedModelId: sharedModel.id,
      reused: reusedSharedModel,
    });
    inventory = await loadBiMigrationFoundationInventory(client, plan.targetInstanceId);
    progressInventory = inventory;
    return result(state, inventory, created);
  } catch (error) {
    const foundationError = error instanceof BiMigrationFoundationError
      ? error
      : safeOperationError(
        error,
        'destination_inventory_failed',
        'OmniKit could not complete destination foundation provisioning.',
      );
    if (progressInventory) {
      const failedState = transitionDestinationFoundationState(state, {
        type: 'failed',
        code: foundationError.code,
        message: foundationError.message,
      });
      foundationError.withPartialResult(result(failedState, progressInventory, created));
    }
    throw foundationError;
  }
}

export interface BiMigrationFoundationReconciliationResult {
  status: 'ready' | 'partial' | 'unresolved' | 'not_required';
  run: BiMigrationBootstrapRun;
  observed?: DestinationFoundationProvisionResult;
}

/**
 * Reconciliation reads Omni inventory only. It may update the local run journal,
 * but it never refreshes or creates a remote resource.
 */
export async function reconcileBiMigrationFoundationRun(
  client: BiMigrationFoundationClient,
  plan: DestinationFoundationPlan,
  options: Pick<BiMigrationFoundationRunOptions, 'idempotencyKey'> = {},
): Promise<BiMigrationFoundationReconciliationResult> {
  const planHash = foundationHash(plan);
  const idempotencyKey = options.idempotencyKey?.trim() || `foundation:${plan.targetInstanceId}:${planHash.slice(7)}`;
  let run = await createBiMigrationRun({
    idempotencyKey,
    planHash,
    inputHash: planHash,
  });

  if (run.phase !== 'RECONCILE_REQUIRED') {
    return {
      status: run.phase === 'READY_FOR_YAML' ? 'ready' : 'not_required',
      run,
    };
  }
  if (plan.mode !== 'existing_connection') return { status: 'unresolved', run };

  const observed = await inspectExistingConnectionFoundation(client, plan);
  const resources = mergeFoundationResources(run.resources, foundationResources(observed));
  if (observed.state.phase !== 'ready') {
    run = await appendBiMigrationRunTransition({
      runId: run.id,
      expectedVersion: run.version,
      phase: 'RECONCILE_REQUIRED',
      resources,
      allowedCommands: ['reconcile', 'rollback'],
    });
    return {
      status: observed.state.schemaModelId || observed.state.connectionId ? 'partial' : 'unresolved',
      run,
      observed,
    };
  }

  const unknownOperation = [...run.operations]
    .reverse()
    .find((operation) => operation.status === 'UNKNOWN');
  if (unknownOperation) {
    const resource = reconciledOperationResource(observed);
    run = await appendBiMigrationOperationTransition({
      runId: run.id,
      expectedVersion: run.version,
      operationKey: unknownOperation.operationKey,
      status: 'RECONCILED',
      ownership: 'adopted',
      ...(resource ? { resource } : {}),
    });
  }
  run = await appendBiMigrationRunTransition({
    runId: run.id,
    expectedVersion: run.version,
    phase: 'READY_FOR_YAML',
    resources,
    allowedCommands: [],
  });
  return { status: 'ready', run, observed };
}

/**
 * Persist the approved setup before any remote mutation. An interrupted or
 * ambiguous request is reconciled read-only and is never replayed automatically.
 */
export async function provisionBiMigrationFoundationWithRun(
  client: BiMigrationFoundationClient,
  plan: DestinationFoundationPlan,
  options: BiMigrationFoundationRunOptions = {},
): Promise<DestinationFoundationProvisionResult> {
  const planHash = foundationHash(plan);
  const idempotencyKey = options.idempotencyKey?.trim() || `foundation:${plan.targetInstanceId}:${planHash.slice(7)}`;
  let run = await createBiMigrationRun({
    idempotencyKey,
    planHash,
    inputHash: planHash,
  });

  if (run.phase === 'RECONCILE_REQUIRED') {
    const reconciliation = await reconcileBiMigrationFoundationRun(client, plan, { idempotencyKey });
    if (reconciliation.status === 'ready' && reconciliation.observed) {
      return {
        ...reconciliation.observed,
        run: runSummary(reconciliation.run),
      };
    }
    const observedResource = reconciliation.observed?.state.schemaModelId
      ? ` Reconciliation found schema model ${reconciliation.observed.state.schemaModelId}, but the shared model is not confirmed.`
      : '';
    const reconcileError = new BiMigrationFoundationError(
      'foundation_reconcile_required',
      `Destination setup run ${reconciliation.run.id} still requires reconciliation.${observedResource} No Omni mutation was replayed.`,
      409,
    ).withRunId(reconciliation.run.id);
    if (reconciliation.observed) reconcileError.withPartialResult(reconciliation.observed);
    throw reconcileError;
  }

  if (run.phase === 'FAILED') {
    run = await appendBiMigrationRunTransition({
      runId: run.id,
      expectedVersion: run.version,
      phase: 'PLANNED',
      allowedCommands: ['start', 'rollback'],
    });
  }

  if (run.phase === 'READY_FOR_YAML') {
    const provisioned = await provisionBiMigrationFoundation(client, plan, options);
    return { ...provisioned, run: runSummary((await getBiMigrationRun(run.id)) || run) };
  }

  const operationKey = nextFoundationOperationKey(run);
  run = await appendBiMigrationOperationTransition({
    runId: run.id,
    expectedVersion: run.version,
    operationKey,
    status: 'PLANNED',
    kind: 'provision_destination_foundation',
    logicalResourceKey: `instance:${plan.targetInstanceId}`,
    inputHash: planHash,
  });
  run = await markBiMigrationOperationDispatched({
    runId: run.id,
    expectedVersion: run.version,
    operationKey,
  });

  try {
    const provisioned = await provisionBiMigrationFoundation(client, plan, options);
    run = await appendBiMigrationOperationTransition({
      runId: run.id,
      expectedVersion: run.version,
      operationKey,
      status: 'SUCCEEDED',
      ownership: provisioned.created.sharedModel ? 'created_by_run' : 'external',
      ...(provisioned.state.sharedModelId ? {
        resource: {
          id: provisioned.state.sharedModelId,
          ownership: provisioned.created.sharedModel ? 'created_by_run' : 'external',
          kind: 'shared_model',
          connectionId: provisioned.state.connectionId,
          baseModelId: provisioned.state.schemaModelId,
        },
      } : {}),
    });
    run = await appendBiMigrationRunTransition({
      runId: run.id,
      expectedVersion: run.version,
      phase: 'READY_FOR_YAML',
      resources: mergeFoundationResources(run.resources, foundationResources(provisioned)),
      allowedCommands: [],
    });
    return { ...provisioned, run: runSummary(run) };
  } catch (error) {
    const ambiguous = ambiguousFoundationFailure(error);
    run = await appendBiMigrationOperationTransition({
      runId: run.id,
      expectedVersion: run.version,
      operationKey,
      status: ambiguous ? 'UNKNOWN' : 'TERMINAL_FAILURE',
      errorCode: error instanceof BiMigrationFoundationError ? error.code : 'foundation_failed',
      errorMessage: error instanceof Error ? error.message : 'Destination setup failed.',
    });
    const partialResources = error instanceof BiMigrationFoundationError && error.partialResult
      ? foundationResources(error.partialResult)
      : {};
    run = await appendBiMigrationRunTransition({
      runId: run.id,
      expectedVersion: run.version,
      phase: ambiguous ? 'RECONCILE_REQUIRED' : 'FAILED',
      resources: mergeFoundationResources(run.resources, partialResources),
      allowedCommands: ambiguous ? ['reconcile', 'rollback'] : ['start', 'rollback'],
    });
    if (error instanceof BiMigrationFoundationError) error.withRunId(run.id);
    throw error;
  }
}

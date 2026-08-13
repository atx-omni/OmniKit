import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  BiMigrationFoundationError,
  provisionBiMigrationFoundation,
  provisionBiMigrationFoundationWithRun,
  reconcileBiMigrationFoundationRun,
  type BiMigrationFoundationClient,
} from '../server/services/biMigrationFoundation';
import {
  getBiMigrationRun,
  resetBiMigrationRunStoreForTests,
} from '../server/services/biMigrationRunStore';
import {
  OmniClient,
  OmniClientError,
  type OmniConnectionRecord,
  type OmniCreateModelInput,
  type OmniCreateModelResult,
  type OmniJobStatusResult,
  type OmniListModelsOptions,
  type OmniModelRecord,
  type OmniSchemaModelRecord,
} from '../server/services/omniClient';
import {
  DESTINATION_FOUNDATION_PLAN_VERSION,
  createDestinationFoundationState,
  defaultDestinationFoundationSchemaModelChoice,
  encodeDestinationFoundationSchemaModelChoice,
  parseDestinationFoundationPlan,
  transitionDestinationFoundationState,
  type DestinationFoundationPlan,
} from '../src/services/semanticMigration/destinationFoundation';

class FakeFoundationClient implements BiMigrationFoundationClient {
  readonly connections: OmniConnectionRecord[] = [{
    id: 'connection-a',
    name: 'Analytics',
    dialect: 'snowflake',
    database: 'ANALYTICS',
  }];

  readonly schemaModels: OmniSchemaModelRecord[] = [];
  readonly models: OmniModelRecord[] = [];
  readonly createCalls: OmniCreateModelInput[] = [];
  refreshCalls = 0;
  jobStatus = 'COMPLETED';
  jobRaw: unknown = {};

  async listConnections(): Promise<OmniConnectionRecord[]> {
    return this.connections;
  }

  async listSchemaModels(): Promise<OmniSchemaModelRecord[]> {
    return this.schemaModels;
  }

  async listModels(options: string | OmniListModelsOptions = 'SHARED'): Promise<OmniModelRecord[]> {
    const kind = typeof options === 'string' ? options : options.modelKind;
    return this.models.filter((model) => model.kind === kind);
  }

  async createModel(input: OmniCreateModelInput): Promise<OmniCreateModelResult> {
    this.createCalls.push(input);
    if (input.modelKind === 'SCHEMA') {
      const model: OmniCreateModelResult = {
        id: 'schema-a',
        name: input.modelName,
        connectionId: input.connectionId,
        kind: 'SCHEMA',
        raw: {},
      };
      this.schemaModels.push(model);
      return model;
    }
    const model: OmniCreateModelResult = {
      id: 'shared-a',
      name: input.modelName,
      connectionId: input.connectionId,
      baseModelId: input.baseModelId,
      kind: input.modelKind,
      raw: {},
    };
    this.models.push(model);
    return model;
  }

  async refreshModel(): Promise<{ jobId?: string; status?: string; raw: unknown }> {
    this.refreshCalls += 1;
    return { jobId: 'refresh-a', status: 'RUNNING', raw: {} };
  }

  async getJobStatus(jobId: string): Promise<OmniJobStatusResult> {
    return { jobId, status: this.jobStatus, raw: this.jobRaw };
  }
}

function existingConnectionPlan(): DestinationFoundationPlan {
  return parseDestinationFoundationPlan({
    version: DESTINATION_FOUNDATION_PLAN_VERSION,
    targetInstanceId: 'instance-a',
    mode: 'existing_connection',
    connectionId: 'connection-a',
    schemaModelName: 'Analytics Schema',
    sharedModelName: 'Analytics Shared',
  });
}

async function withTemporaryRunStore<T>(work: () => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'omnikit-foundation-run-'));
  process.env.OMNIKIT_BI_MIGRATION_RUN_STORE_PATH = join(root, 'runs.jsonl');
  resetBiMigrationRunStoreForTests();
  try {
    return await work();
  } finally {
    resetBiMigrationRunStoreForTests();
    delete process.env.OMNIKIT_BI_MIGRATION_RUN_STORE_PATH;
    rmSync(root, { recursive: true, force: true });
  }
}

test('destination foundation state advances through the governed model sequence', () => {
  const plan = existingConnectionPlan();
  let state = createDestinationFoundationState(plan);
  assert.equal(state.phase, 'inventory');

  state = transitionDestinationFoundationState(state, { type: 'inventory_loaded' });
  assert.equal(state.phase, 'connection');
  state = transitionDestinationFoundationState(state, { type: 'connection_resolved', connectionId: 'connection-a', reused: true });
  assert.equal(state.phase, 'schema_model');
  state = transitionDestinationFoundationState(state, { type: 'schema_model_resolved', schemaModelId: 'schema-a', reused: false });
  assert.equal(state.phase, 'schema_refresh');
  state = transitionDestinationFoundationState(state, { type: 'schema_refresh_started', jobId: 'refresh-a' });
  state = transitionDestinationFoundationState(state, { type: 'schema_refresh_succeeded' });
  assert.equal(state.phase, 'shared_model');
  state = transitionDestinationFoundationState(state, { type: 'shared_model_resolved', sharedModelId: 'shared-a', reused: false });

  assert.equal(state.phase, 'ready');
  assert.equal(state.connectionId, 'connection-a');
  assert.equal(state.schemaModelId, 'schema-a');
  assert.equal(state.sharedModelId, 'shared-a');
  assert.equal(state.refreshJobId, 'refresh-a');
});

test('existing connection selection defaults to the first detected schema model or a blank connection choice', () => {
  const inventory = {
    version: DESTINATION_FOUNDATION_PLAN_VERSION,
    targetInstanceId: 'instance-a',
    connections: [],
    schemaModels: [
      { id: 'schema-first', name: 'First', connectionId: 'connection-a' },
      { id: 'schema-second', name: 'Second', connectionId: 'connection-a' },
    ],
    sharedModels: [],
  };

  const selected = defaultDestinationFoundationSchemaModelChoice(inventory, 'connection-a');
  assert.deepEqual(
    parseDestinationFoundationPlan({
      version: DESTINATION_FOUNDATION_PLAN_VERSION,
      targetInstanceId: 'instance-a',
      mode: 'existing_connection',
      connectionId: 'connection-a',
      schemaModelName: selected,
      sharedModelName: 'Analytics Shared',
    }),
    {
      version: DESTINATION_FOUNDATION_PLAN_VERSION,
      targetInstanceId: 'instance-a',
      mode: 'existing_connection',
      connectionId: 'connection-a',
      schemaModelId: 'schema-first',
      sharedModelName: 'Analytics Shared',
    },
  );
  assert.equal(defaultDestinationFoundationSchemaModelChoice(inventory, ''), '');
});

test('detected and explicit-fallback schema model choices reuse inventory without schema creation', async () => {
  const detectedClient = new FakeFoundationClient();
  detectedClient.schemaModels.push({
    id: 'schema-detected',
    name: 'Detected warehouse',
    connectionId: 'connection-a',
  });
  const detectedPlan = parseDestinationFoundationPlan({
    version: DESTINATION_FOUNDATION_PLAN_VERSION,
    targetInstanceId: 'instance-a',
    mode: 'existing_connection',
    connectionId: 'connection-a',
    schemaModelName: encodeDestinationFoundationSchemaModelChoice({
      strategy: 'detected',
      modelId: 'schema-detected',
    }),
    sharedModelName: 'Analytics Shared',
  });

  const detected = await provisionBiMigrationFoundation(detectedClient, detectedPlan, { pollIntervalMs: 0 });
  assert.equal(detected.state.schemaModelId, 'schema-detected');
  assert.equal(detected.state.reusedSchemaModel, true);
  assert.deepEqual(detectedClient.createCalls.map((call) => call.modelKind), ['SHARED']);
  assert.equal(detectedClient.createCalls[0]?.baseModelId, undefined);

  const fallbackClient = new FakeFoundationClient();
  fallbackClient.schemaModels.push({
    id: 'schema-unscoped',
    name: 'Existing warehouse',
  });
  const fallbackPlan = parseDestinationFoundationPlan({
    version: DESTINATION_FOUNDATION_PLAN_VERSION,
    targetInstanceId: 'instance-a',
    mode: 'existing_connection',
    connectionId: 'connection-a',
    schemaModelName: encodeDestinationFoundationSchemaModelChoice({
      strategy: 'reuse_existing',
      modelName: 'schema-unscoped',
    }),
    sharedModelName: 'Fallback Shared',
  });

  const fallback = await provisionBiMigrationFoundation(fallbackClient, fallbackPlan, { pollIntervalMs: 0 });
  assert.equal(fallback.state.schemaModelId, 'schema-unscoped');
  assert.deepEqual(fallbackClient.createCalls.map((call) => call.modelKind), ['SHARED']);
  assert.equal(fallbackClient.createCalls[0]?.baseModelId, undefined);
});

test('existing connection provisioning is idempotent across repeated requests', async () => {
  const client = new FakeFoundationClient();
  const plan = existingConnectionPlan();

  const first = await provisionBiMigrationFoundation(client, plan, { pollIntervalMs: 0 });
  const second = await provisionBiMigrationFoundation(client, plan, { pollIntervalMs: 0 });

  assert.equal(first.state.phase, 'ready');
  assert.deepEqual(first.created, { connection: false, schemaModel: true, sharedModel: true });
  assert.equal(second.state.phase, 'ready');
  assert.deepEqual(second.created, { connection: false, schemaModel: false, sharedModel: false });
  assert.deepEqual(client.createCalls.map((call) => call.modelKind), ['SCHEMA', 'SHARED']);
  assert.equal(client.refreshCalls, 1);
});

test('governed provisioning persists setup intent before writes and reuses a completed run', async () => {
  await withTemporaryRunStore(async () => {
    const client = new FakeFoundationClient();
    const plan = existingConnectionPlan();
    const first = await provisionBiMigrationFoundationWithRun(client, plan, {
      pollIntervalMs: 0,
      idempotencyKey: 'foundation-success-a',
    });
    const repeated = await provisionBiMigrationFoundationWithRun(client, plan, {
      pollIntervalMs: 0,
      idempotencyKey: 'foundation-success-a',
    });

    assert.equal(first.run?.phase, 'READY_FOR_YAML');
    assert.equal(repeated.run?.id, first.run?.id);
    assert.deepEqual(client.createCalls.map((call) => call.modelKind), ['SCHEMA', 'SHARED']);
    const persisted = first.run ? await getBiMigrationRun(first.run.id) : undefined;
    assert.equal(persisted?.operations[0]?.status, 'SUCCEEDED');
    assert.equal(persisted?.phase, 'READY_FOR_YAML');
  });
});

test('ambiguous foundation mutations stop in reconciliation instead of replaying', async () => {
  await withTemporaryRunStore(async () => {
    const client = new FakeFoundationClient();
    let attempts = 0;
    client.createModel = async () => {
      attempts += 1;
      throw new Error('The upstream response ended before a model identifier was returned.');
    };

    await assert.rejects(provisionBiMigrationFoundationWithRun(client, existingConnectionPlan(), {
      pollIntervalMs: 0,
      idempotencyKey: 'foundation-ambiguous-a',
    }));
    await assert.rejects(
      provisionBiMigrationFoundationWithRun(client, existingConnectionPlan(), {
        pollIntervalMs: 0,
        idempotencyKey: 'foundation-ambiguous-a',
      }),
      (error: unknown) => {
        assert.ok(error instanceof BiMigrationFoundationError);
        assert.equal(error.statusCode, 409);
        assert.equal(error.code, 'foundation_reconcile_required');
        assert.match(error.message, /No Omni mutation was replayed/);
        return true;
      },
    );
    const reconciliation = await reconcileBiMigrationFoundationRun(client, existingConnectionPlan(), {
      idempotencyKey: 'foundation-ambiguous-a',
    });
    assert.equal(reconciliation.status, 'partial');
    assert.equal(reconciliation.run.phase, 'RECONCILE_REQUIRED');
    assert.equal(attempts, 1);
  });
});

test('response-loss reconciliation discovers a partial schema model without replaying creation', async () => {
  await withTemporaryRunStore(async () => {
    const client = new FakeFoundationClient();
    const createModel = client.createModel.bind(client);
    let loseSchemaResponse = true;
    client.createModel = async (input) => {
      if (input.modelKind === 'SCHEMA' && loseSchemaResponse) {
        loseSchemaResponse = false;
        await createModel(input);
        throw new Error('The schema model response was lost after dispatch.');
      }
      return createModel(input);
    };

    await assert.rejects(provisionBiMigrationFoundationWithRun(client, existingConnectionPlan(), {
      pollIntervalMs: 0,
      idempotencyKey: 'foundation-response-loss-a',
    }));
    await assert.rejects(
      provisionBiMigrationFoundationWithRun(client, existingConnectionPlan(), {
        pollIntervalMs: 0,
        idempotencyKey: 'foundation-response-loss-a',
      }),
      (error: unknown) => {
        assert.ok(error instanceof BiMigrationFoundationError);
        assert.equal(error.code, 'foundation_reconcile_required');
        assert.equal(error.partialResult?.state.schemaModelId, 'schema-a');
        return true;
      },
    );

    const reconciliation = await reconcileBiMigrationFoundationRun(client, existingConnectionPlan(), {
      idempotencyKey: 'foundation-response-loss-a',
    });
    assert.equal(reconciliation.status, 'partial');
    assert.equal(reconciliation.observed?.state.schemaModelId, 'schema-a');
    assert.equal(reconciliation.run.resources.schemaModel?.id, 'schema-a');
    assert.deepEqual(client.createCalls.map((call) => call.modelKind), ['SCHEMA']);
  });
});

test('deterministic partial provisioning retries from persisted resources without duplicates', async () => {
  await withTemporaryRunStore(async () => {
    const client = new FakeFoundationClient();
    client.jobStatus = 'FAILED';
    let runId = '';

    await assert.rejects(
      provisionBiMigrationFoundationWithRun(client, existingConnectionPlan(), {
        pollIntervalMs: 0,
        idempotencyKey: 'foundation-refresh-retry-a',
      }),
      (error: unknown) => {
        assert.ok(error instanceof BiMigrationFoundationError);
        runId = error.runId || '';
        assert.equal(error.code, 'schema_refresh_failed');
        assert.equal(error.partialResult?.state.schemaModelId, 'schema-a');
        return true;
      },
    );
    const failedRun = await getBiMigrationRun(runId);
    assert.equal(failedRun?.phase, 'FAILED');
    assert.deepEqual(failedRun?.allowedCommands, ['start', 'rollback']);
    assert.equal(failedRun?.resources.schemaModel?.id, 'schema-a');
    assert.equal(failedRun?.resources.schemaModel?.ownership, 'created_by_run');

    client.jobStatus = 'COMPLETED';
    const retried = await provisionBiMigrationFoundationWithRun(client, existingConnectionPlan(), {
      pollIntervalMs: 0,
      idempotencyKey: 'foundation-refresh-retry-a',
    });

    assert.equal(retried.state.phase, 'ready');
    assert.deepEqual(client.createCalls.map((call) => call.modelKind), ['SCHEMA', 'SHARED']);
    const completedRun = await getBiMigrationRun(runId);
    assert.equal(completedRun?.phase, 'READY_FOR_YAML');
    assert.deepEqual(completedRun?.operations.map((operation) => operation.status), [
      'TERMINAL_FAILURE',
      'SUCCEEDED',
    ]);
    assert.equal(completedRun?.resources.schemaModel?.ownership, 'created_by_run');
  });
});

test('known Omni 4xx model failures preserve provider detail and allow an explicit retry', async () => {
  await withTemporaryRunStore(async () => {
    const client = new FakeFoundationClient();
    const createModel = client.createModel.bind(client);
    const attemptedInputs: OmniCreateModelInput[] = [];
    let rejectFirstSchema = true;
    client.createModel = async (input) => {
      attemptedInputs.push(input);
      if (input.modelKind === 'SCHEMA' && rejectFirstSchema) {
        rejectFirstSchema = false;
        throw new OmniClientError(
          422,
          'https://example.omniapp.co/api/v1/models',
          'SCHEMA is not enabled for this connection.',
          'MODEL_KIND_UNSUPPORTED',
        );
      }
      return createModel(input);
    };

    let runId = '';
    await assert.rejects(
      provisionBiMigrationFoundationWithRun(client, existingConnectionPlan(), {
        pollIntervalMs: 0,
        idempotencyKey: 'foundation-known-4xx-a',
      }),
      (error: unknown) => {
        assert.ok(error instanceof BiMigrationFoundationError);
        runId = error.runId || '';
        assert.equal(error.code, 'schema_model_create_failed');
        assert.equal(error.statusCode, 422);
        assert.deepEqual(error.omni, {
          status: 422,
          code: 'MODEL_KIND_UNSUPPORTED',
          message: 'SCHEMA is not enabled for this connection.',
        });
        assert.match(error.message, /MODEL_KIND_UNSUPPORTED/);
        assert.deepEqual(error.partialResult?.state.plan, existingConnectionPlan());
        return true;
      },
    );
    assert.deepEqual((await getBiMigrationRun(runId))?.allowedCommands, ['start', 'rollback']);

    const retried = await provisionBiMigrationFoundationWithRun(client, existingConnectionPlan(), {
      pollIntervalMs: 0,
      idempotencyKey: 'foundation-known-4xx-a',
    });
    assert.equal(retried.state.phase, 'ready');
    assert.deepEqual(attemptedInputs.slice(0, 2), [
      {
        connectionId: 'connection-a',
        modelName: 'Analytics Schema',
        modelKind: 'SCHEMA',
      },
      {
        connectionId: 'connection-a',
        modelName: 'Analytics Schema',
        modelKind: 'SCHEMA',
      },
    ]);
  });
});

test('shared model creation failures preserve Omni status, code, and message', async () => {
  const client = new FakeFoundationClient();
  client.schemaModels.push({
    id: 'schema-existing',
    name: 'Existing schema',
    connectionId: 'connection-a',
  });
  client.createModel = async (input) => {
    assert.equal(input.modelKind, 'SHARED');
    throw new OmniClientError(
      409,
      'https://example.omniapp.co/api/v1/models',
      'A shared model with this base is locked.',
      'MODEL_BASE_LOCKED',
    );
  };
  const plan = parseDestinationFoundationPlan({
    version: DESTINATION_FOUNDATION_PLAN_VERSION,
    targetInstanceId: 'instance-a',
    mode: 'existing_connection',
    connectionId: 'connection-a',
    schemaModelId: 'schema-existing',
    sharedModelName: 'Analytics Shared',
  });

  await assert.rejects(
    provisionBiMigrationFoundation(client, plan, { pollIntervalMs: 0 }),
    (error: unknown) => {
      assert.ok(error instanceof BiMigrationFoundationError);
      assert.equal(error.code, 'shared_model_create_failed');
      assert.equal(error.statusCode, 409);
      assert.deepEqual(error.omni, {
        status: 409,
        code: 'MODEL_BASE_LOCKED',
        message: 'A shared model with this base is locked.',
      });
      assert.match(error.message, /MODEL_BASE_LOCKED/);
      return true;
    },
  );
});

test('a failed schema refresh blocks shared model creation and redacts provider detail', async () => {
  const client = new FakeFoundationClient();
  client.jobStatus = 'FAILED';
  client.jobRaw = { message: 'warehouse password omni_live_secret_123' };

  await assert.rejects(
    provisionBiMigrationFoundation(client, existingConnectionPlan(), { pollIntervalMs: 0 }),
    (error: unknown) => {
      assert.ok(error instanceof BiMigrationFoundationError);
      assert.equal(error.code, 'schema_refresh_failed');
      assert.doesNotMatch(error.message, /omni_live_secret_123/);
      return true;
    },
  );
  assert.deepEqual(client.createCalls.map((call) => call.modelKind), ['SCHEMA']);
});

test('browser plans reject secret material before a request can be sent', () => {
  assert.throws(
    () => parseDestinationFoundationPlan({
      version: DESTINATION_FOUNDATION_PLAN_VERSION,
      targetInstanceId: 'instance-a',
      mode: 'new_connection',
      connectionName: 'Analytics',
      dialect: 'snowflake',
      credentialReference: { kind: 'vault_credential', id: 'vault-ref-a' },
      password: 'warehouse-secret-value',
      schemaModelName: 'Analytics Schema',
      sharedModelName: 'Analytics Shared',
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Browser-supplied connection secrets are not accepted/);
      assert.doesNotMatch(error.message, /warehouse-secret-value/);
      return true;
    },
  );
});

test('new connection mode returns a safe adapter error without exposing its vault reference', async () => {
  const client = new FakeFoundationClient();
  const plan = parseDestinationFoundationPlan({
    version: DESTINATION_FOUNDATION_PLAN_VERSION,
    targetInstanceId: 'instance-a',
    mode: 'new_connection',
    connectionName: 'Analytics',
    dialect: 'snowflake',
    credentialReference: { kind: 'vault_credential', id: 'vault-sensitive-reference-a' },
    schemaModelName: 'Analytics Schema',
    sharedModelName: 'Analytics Shared',
  });

  await assert.rejects(
    provisionBiMigrationFoundation(client, plan),
    (error: unknown) => {
      assert.ok(error instanceof BiMigrationFoundationError);
      assert.equal(error.code, 'connection_adapter_unsupported');
      assert.equal(error.statusCode, 422);
      assert.doesNotMatch(error.message, /vault-sensitive-reference-a/);
      return true;
    },
  );
});

test('OmniClient createModel uses the generic model endpoint and normalizes the result', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(new URL(String(url)).pathname, '/api/v1/models');
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), {
      connectionId: 'connection-a',
      modelName: 'Analytics Shared',
      modelKind: 'SHARED',
    });
    return new Response(JSON.stringify({
      id: 'shared-a',
      name: 'Analytics Shared',
      connectionId: 'connection-a',
      baseModelId: 'schema-a',
      modelKind: 'SHARED',
    }), { status: 201, headers: { 'Content-Type': 'application/json' } });
  });
  const client = new OmniClient({ label: 'Test', baseUrl: 'https://8.8.8.8', apiKey: 'foundation-create-token' });

  const model = await client.createModel({
    connectionId: 'connection-a',
    modelName: 'Analytics Shared',
    modelKind: 'SHARED',
  });

  assert.equal(model.id, 'shared-a');
  assert.equal(model.kind, 'SHARED');
  assert.equal(model.baseModelId, 'schema-a');
});

test('OmniClient createModel rejects HTTP 200 semantic failures with structured Omni detail', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    success: false,
    error: {
      status: 422,
      code: 'MODEL_KIND_UNSUPPORTED',
      message: 'SCHEMA models cannot be created for this connection.',
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const client = new OmniClient({
    label: 'Test',
    baseUrl: 'https://8.8.8.8',
    apiKey: 'foundation-semantic-error-token',
  });

  await assert.rejects(
    client.createModel({
      connectionId: 'connection-a',
      modelName: 'Analytics Schema',
      modelKind: 'SCHEMA',
    }),
    (error: unknown) => {
      assert.ok(error instanceof OmniClientError);
      assert.equal(error.status, 422);
      assert.equal(error.httpStatus, 200);
      assert.equal(error.omniCode, 'MODEL_KIND_UNSUPPORTED');
      assert.equal(error.omniMessage, 'SCHEMA models cannot be created for this connection.');
      return true;
    },
  );
});

test('OmniClient never retries model-creation mutations after an ambiguous server failure', async (t) => {
  let attempts = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    attempts += 1;
    return new Response(JSON.stringify({ error: 'ambiguous upstream failure' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  const client = new OmniClient({ label: 'Test', baseUrl: 'https://8.8.8.8', apiKey: 'foundation-no-retry-token' });

  await assert.rejects(
    client.createModel({
      connectionId: 'connection-a',
      modelName: 'Analytics Shared',
      modelKind: 'SHARED',
      baseModelId: 'schema-a',
    }),
  );

  assert.equal(attempts, 1);
});

test('OmniClient getJobStatus uses the documented status endpoint', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    assert.equal(new URL(String(url)).pathname, '/api/v1/jobs/refresh-a/status');
    return new Response(JSON.stringify({ job: { id: 'refresh-a', status: 'completed' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  const client = new OmniClient({ label: 'Test', baseUrl: 'https://8.8.8.8', apiKey: 'foundation-status-token' });

  const status = await client.getJobStatus('refresh-a');

  assert.equal(status.jobId, 'refresh-a');
  assert.equal(status.status, 'COMPLETED');
});

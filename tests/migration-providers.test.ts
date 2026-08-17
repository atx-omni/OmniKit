import assert from 'node:assert/strict';
import dns from 'node:dns';
import { mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import migrationStudioHandler from '../server/handlers/migration-studio';
import {
  generateStructuredProposal,
  MigrationProviderRequestError,
  providerCapabilities,
  providerGenerationSchema,
  migrationProviderEndpoint,
  providerSchemaName,
  resetMigrationProviderRuntimeForTests,
  testLlmProvider,
  type StructuredGenerationInput,
} from '../server/services/migrationProviders';
import {
  resetVault,
  unlockVault,
  upsertInstance,
  type MigrationProviderKind,
  type SavedLlmProvider,
} from '../server/services/nativeVault';
import {
  cancelSemanticMigrationJob,
  getSemanticMigrationJob,
  getSemanticMigrationJobResult,
  resetSemanticMigrationJobsForTests,
  SemanticMigrationJobIdempotencyConflictError,
  startSemanticMigrationJob,
} from '../server/services/semanticMigrationJobs';

// A globally routable fixture address is required because the production SSRF
// guard intentionally rejects documentation-only TEST-NET ranges before the
// mocked fetch transport is reached.
const TEST_HOST = '93.184.216.34';
const TEST_BASE_URL = `https://${TEST_HOST}`;
const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
const SNOWFLAKE_BASE_URL = 'https://snowflakecomputing.com';
const DATABRICKS_BASE_URL = 'https://databricks.com';
const TEST_CREDENTIAL = 'fixture-provider-credential';
const ENV_KEYS = [
  'OMNIKIT_VAULT_PATH',
  'OMNIKIT_SEMANTIC_MIGRATION_AUDIT_PATH',
  'OMNIKIT_SEMANTIC_MIGRATION_JOB_PATH',
  'OMNIKIT_MIGRATION_PROVIDER_ALLOWLIST',
  'OMNIKIT_MIGRATION_PROVIDER_HOST_ALLOWLIST',
] as const;

let temporaryRoot = '';
let previousEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
const originalDnsLookup = dns.promises.lookup;

beforeEach(() => {
  previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  temporaryRoot = mkdtempSync(path.join(tmpdir(), 'omnikit-provider-tests-'));
  process.env.OMNIKIT_VAULT_PATH = path.join(temporaryRoot, 'vault.enc');
  process.env.OMNIKIT_SEMANTIC_MIGRATION_AUDIT_PATH = path.join(temporaryRoot, 'semantic-audit.json');
  process.env.OMNIKIT_SEMANTIC_MIGRATION_JOB_PATH = path.join(temporaryRoot, 'semantic-jobs.json');
  process.env.OMNIKIT_MIGRATION_PROVIDER_HOST_ALLOWLIST = TEST_HOST;
  delete process.env.OMNIKIT_MIGRATION_PROVIDER_ALLOWLIST;
  Object.defineProperty(dns.promises, 'lookup', {
    configurable: true,
    writable: true,
    value: async () => [{ address: TEST_HOST, family: 4 }],
  });
  syncBuiltinESMExports();
  resetMigrationProviderRuntimeForTests();
  resetSemanticMigrationJobsForTests();
  resetVault();
});

afterEach(() => {
  resetMigrationProviderRuntimeForTests();
  resetSemanticMigrationJobsForTests();
  resetVault();
  Object.defineProperty(dns.promises, 'lookup', {
    configurable: true,
    writable: true,
    value: originalDnsLookup,
  });
  syncBuiltinESMExports();
  rmSync(temporaryRoot, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    const value = previousEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function provider(
  kind: MigrationProviderKind,
  overrides: Partial<SavedLlmProvider> = {},
): SavedLlmProvider {
  const timestamp = '2026-01-01T00:00:00.000Z';
  const baseUrl = kind === 'openai'
    ? OPENAI_BASE_URL
    : kind === 'anthropic'
      ? ANTHROPIC_BASE_URL
      : kind === 'snowflake_cortex'
        ? SNOWFLAKE_BASE_URL
        : kind === 'databricks_genie'
          ? DATABRICKS_BASE_URL
          : kind === 'custom_openai_compatible'
            ? TEST_BASE_URL
            : undefined;
  return {
    id: `provider-${kind}`,
    name: 'Example provider',
    kind,
    model: kind === 'databricks_genie' ? 'example-space-id' : 'example-model',
    baseUrl,
    authMode: kind === 'omni_ai'
      ? 'linked_omni_instance'
      : kind === 'snowflake_cortex' || kind === 'databricks_genie'
        ? 'oauth_access_token'
        : 'api_key',
    credentialExpiresAt: kind === 'snowflake_cortex' || kind === 'databricks_genie'
      ? '2099-12-31T00:00:00.000Z'
      : undefined,
    credential: TEST_CREDENTIAL,
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastValidationStatus: 'valid',
    lastValidatedRevision: timestamp,
    ...overrides,
  };
}

function generationInput(overrides: Partial<StructuredGenerationInput> = {}): StructuredGenerationInput {
  return {
    task: 'classify_inventory',
    system: 'Return a reviewed example result.',
    prompt: 'Classify the selected example artifact.',
    schemaName: 'example_result',
    schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { const: true },
      },
      required: ['ok'],
    },
    ...overrides,
  };
}

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
    ...init,
  });
}

function requestHeader(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

test('provider schema normalization removes schema declarations and recursively replaces const with enum', () => {
  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Internal migration response',
    description: 'Do not send response annotations to providers.',
    type: 'object',
    properties: {
      mode: { const: 'example', default: 'example', examples: ['example'] },
      rows: {
        type: 'array',
        items: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          properties: { enabled: { const: true } },
        },
      },
    },
  };

  const normalized = providerGenerationSchema(schema);

  assert.deepEqual(normalized, {
    type: 'object',
    additionalProperties: false,
    properties: {
      mode: { enum: ['example'] },
      rows: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: { enabled: { enum: [true] } },
          required: ['enabled'],
        },
      },
    },
    required: ['mode', 'rows'],
  });
  assert.equal(schema.properties.mode.const, 'example', 'normalization must not mutate the caller schema');
  assert.equal(schema.properties.rows.items.$schema, 'https://json-schema.org/draft/2020-12/schema');
});

test('provider schema normalization preserves literal property names that match schema annotations', () => {
  const schema = {
    title: 'Internal dashboard planning response',
    description: 'Annotations must not leave the trusted boundary.',
    type: 'object',
    properties: {
      dashboardPlans: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            tiles: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  title: { type: 'string', title: 'Tile title annotation' },
                  description: { type: ['string', 'null'], description: 'Tile description annotation' },
                },
                required: ['id', 'title', 'description'],
              },
            },
          },
          required: ['tiles'],
        },
      },
    },
    required: ['dashboardPlans'],
  };

  const normalized = providerGenerationSchema(schema) as {
    title?: unknown;
    description?: unknown;
    properties: {
      dashboardPlans: {
        items: {
          properties: {
            tiles: {
              items: {
                properties: Record<string, Record<string, unknown>>;
                required: string[];
              };
            };
          };
        };
      };
    };
  };
  const tileSchema = normalized.properties.dashboardPlans.items.properties.tiles.items;

  assert.equal(normalized.title, undefined);
  assert.equal(normalized.description, undefined);
  assert.deepEqual(Object.keys(tileSchema.properties), ['id', 'title', 'description']);
  assert.deepEqual(tileSchema.required, ['id', 'title', 'description']);
  assert.equal(tileSchema.properties.title.title, undefined);
  assert.equal(tileSchema.properties.description.description, undefined);
});

test('provider schema contracts sanitize bounded names and reject non-object or open-ended schemas', () => {
  assert.equal(providerSchemaName(' Reviewed result / v1! '), 'Reviewed_result_v1');
  assert.equal(providerSchemaName('a'.repeat(80)).length, 64);
  assert.throws(
    () => providerSchemaName('!!!'),
    (error: unknown) => error instanceof MigrationProviderRequestError && error.code === 'AI_PROVIDER_SCHEMA_NAME_INVALID',
  );
  assert.throws(
    () => providerGenerationSchema({ type: 'array', items: { type: 'string' } }),
    (error: unknown) => error instanceof MigrationProviderRequestError && error.code === 'AI_PROVIDER_SCHEMA_INVALID',
  );
  assert.throws(
    () => providerGenerationSchema({ type: 'object', additionalProperties: true, properties: {} }),
    (error: unknown) => error instanceof MigrationProviderRequestError && /additionalProperties must be false/.test(error.message),
  );
  let deeplyNested: Record<string, unknown> = { type: 'string' };
  for (let depth = 0; depth < 40; depth += 1) deeplyNested = { type: 'array', items: deeplyNested };
  assert.throws(
    () => providerGenerationSchema({ type: 'object', properties: { value: deeplyNested } }),
    (error: unknown) => error instanceof MigrationProviderRequestError && error.code === 'AI_PROVIDER_SCHEMA_TOO_DEEP',
  );
  assert.throws(
    () => providerGenerationSchema({
      type: 'object',
      properties: { value: { type: 'string', enum: ['x'.repeat(300 * 1024)] } },
    }),
    (error: unknown) => error instanceof MigrationProviderRequestError && error.code === 'AI_PROVIDER_SCHEMA_TOO_LARGE',
  );
});

test('OpenAI sends the saved project API key only as Bearer authorization', async (t) => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    requestUrl = String(input);
    requestInit = init;
    return jsonResponse({
      model: 'gpt-5.1-2025-11-13',
      choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }],
    });
  });

  const result = await generateStructuredProposal(provider('openai'), generationInput());

  assert.equal(requestUrl, `${OPENAI_BASE_URL}/chat/completions`);
  assert.equal(requestHeader(requestInit, 'authorization'), `Bearer ${TEST_CREDENTIAL}`);
  assert.equal(requestHeader(requestInit, 'x-api-key'), null);
  assert.doesNotMatch(String(requestInit?.body), new RegExp(TEST_CREDENTIAL));
  assert.deepEqual(result.output, { ok: true });
});

test('OpenAI requires a valid terminal reason and handles refusal, filtering, and truncation', async (t) => {
  const upstreamMarker = 'upstream-response-body-marker';
  const responses = [
    {
      choices: [{
        finish_reason: 'stop',
        message: { content: '{"ok":true}', refusal: `Declined: ${upstreamMarker}` },
      }],
    },
    {
      choices: [{
        finish_reason: 'length',
        message: { content: `{"ok":true,"detail":"${upstreamMarker}"}` },
      }],
    },
    {
      choices: [{
        finish_reason: 'content_filter',
        message: { content: `{"ok":true,"detail":"${upstreamMarker}"}` },
      }],
    },
    {
      choices: [{ message: { content: '{"ok":true}' } }],
    },
  ];
  let requestCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    const payload = responses[requestCount];
    requestCount += 1;
    return jsonResponse(payload);
  });

  await assert.rejects(
    () => generateStructuredProposal(provider('openai', { id: 'provider-openai-refusal' }), generationInput()),
    (error: unknown) => {
      assert.ok(error instanceof MigrationProviderRequestError);
      assert.equal(error.code, 'AI_PROVIDER_REFUSAL');
      assert.equal(error.statusCode, 422);
      assert.equal(error.retryable, false);
      assert.doesNotMatch(error.message, new RegExp(upstreamMarker));
      return true;
    },
  );
  await assert.rejects(
    () => generateStructuredProposal(provider('openai', { id: 'provider-openai-truncated' }), generationInput()),
    (error: unknown) => {
      assert.ok(error instanceof MigrationProviderRequestError);
      assert.equal(error.code, 'AI_PROVIDER_OUTPUT_TRUNCATED');
      assert.equal(error.statusCode, 502);
      assert.equal(error.retryable, false);
      assert.doesNotMatch(error.message, new RegExp(upstreamMarker));
      return true;
    },
  );
  await assert.rejects(
    () => generateStructuredProposal(provider('openai', { id: 'provider-openai-filtered' }), generationInput()),
    (error: unknown) => {
      assert.ok(error instanceof MigrationProviderRequestError);
      assert.equal(error.code, 'AI_PROVIDER_CONTENT_FILTERED');
      assert.equal(error.statusCode, 422);
      assert.equal(error.retryable, false);
      return true;
    },
  );
  await assert.rejects(
    () => generateStructuredProposal(provider('openai', { id: 'provider-openai-terminal-missing' }), generationInput()),
    (error: unknown) => {
      assert.ok(error instanceof MigrationProviderRequestError);
      assert.equal(error.code, 'AI_PROVIDER_OUTPUT_INCOMPLETE');
      assert.match(error.message, /without a terminal finish reason/i);
      return true;
    },
  );
  assert.equal(requestCount, 4);
});

test('unsupported provider terminal states are not reflected into user-facing errors', async (t) => {
  const upstreamMarker = 'provider-internal-terminal-marker';
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({
    choices: [{ finish_reason: upstreamMarker, message: { content: '{"ok":true}' } }],
  }));

  await assert.rejects(
    () => generateStructuredProposal(provider('openai', { id: 'provider-openai-terminal-unknown' }), generationInput()),
    (error: unknown) => {
      assert.ok(error instanceof MigrationProviderRequestError);
      assert.equal(error.code, 'AI_PROVIDER_OUTPUT_INCOMPLETE');
      assert.doesNotMatch(error.message, new RegExp(upstreamMarker));
      return true;
    },
  );
});

test('Anthropic sends a strict normalized tool schema and accepts the named tool terminal response', async (t) => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    requestUrl = String(input);
    requestInit = init;
    return jsonResponse({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', name: 'example_result', input: { ok: true } }],
      usage: { input_tokens: 12, output_tokens: 4 },
    });
  });

  const result = await generateStructuredProposal(provider('anthropic'), generationInput());
  const body = JSON.parse(String(requestInit?.body)) as Record<string, unknown>;
  const tools = body.tools as Array<Record<string, unknown>>;

  assert.equal(requestUrl, `${ANTHROPIC_BASE_URL}/messages`);
  assert.equal(requestHeader(requestInit, 'x-api-key'), TEST_CREDENTIAL);
  assert.equal(requestHeader(requestInit, 'anthropic-version'), '2023-06-01');
  assert.equal(requestHeader(requestInit, 'authorization'), null);
  assert.doesNotMatch(String(requestInit?.body), new RegExp(TEST_CREDENTIAL));
  assert.equal(tools[0]?.strict, true);
  assert.equal(tools[0]?.name, 'example_result');
  assert.deepEqual(tools[0]?.input_schema, {
    type: 'object',
    additionalProperties: false,
    properties: { ok: { enum: [true] } },
    required: ['ok'],
  });
  assert.deepEqual(body.tool_choice, { type: 'tool', name: 'example_result' });
  assert.deepEqual(result.output, { ok: true });
  assert.deepEqual(result.usage, { input_tokens: 12, output_tokens: 4 });
});

test('Anthropic rejects truncated and mismatched tool terminal responses', async (t) => {
  const responses = [
    { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"ok":true}' }] },
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'different_tool', input: { ok: true } }] },
  ];
  let requestCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    const payload = responses[requestCount];
    requestCount += 1;
    return jsonResponse(payload);
  });

  await assert.rejects(
    () => generateStructuredProposal(provider('anthropic', { id: 'provider-anthropic-truncated' }), generationInput()),
    (error: unknown) => {
      assert.ok(error instanceof MigrationProviderRequestError);
      assert.equal(error.code, 'AI_PROVIDER_OUTPUT_TRUNCATED');
      assert.equal(error.retryable, false);
      return true;
    },
  );
  await assert.rejects(
    () => generateStructuredProposal(provider('anthropic', { id: 'provider-anthropic-wrong-tool' }), generationInput()),
    (error: unknown) => {
      assert.ok(error instanceof MigrationProviderRequestError);
      assert.equal(error.code, 'AI_PROVIDER_OUTPUT_INCOMPLETE');
      assert.match(error.message, /required example_result tool result/i);
      return true;
    },
  );
  assert.equal(requestCount, 2);
});

test('retired Databricks Foundation Model tombstones cannot test, generate, or resolve an endpoint', async (t) => {
  let requestCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requestCount += 1;
    return jsonResponse({});
  });
  const retired = provider('databricks_model_serving', {
    authMode: 'oauth_access_token',
    baseUrl: DATABRICKS_BASE_URL,
    credentialExpiresAt: '2099-12-31T00:00:00.000Z',
    enabled: false,
    lastValidationStatus: undefined,
    lastValidatedRevision: undefined,
  });

  await assert.rejects(() => testLlmProvider(retired), /retired authentication method|supported authentication/i);
  await assert.rejects(
    () => generateStructuredProposal(retired, generationInput()),
    /does not support/i,
  );
  assert.throws(() => migrationProviderEndpoint(retired), (error: unknown) => (
    Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'AI_PROVIDER_RETIRED')
  ));
  assert.equal(providerCapabilities('databricks_model_serving').supportedTasks.length, 0);
  assert.equal(requestCount, 0);
});

test('Snowflake Cortex uses the documented completion-token field for structured output', async (t) => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    requestUrl = String(input);
    requestInit = init;
    return jsonResponse({
      choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }],
    });
  });

  await generateStructuredProposal(provider('snowflake_cortex'), generationInput());
  const body = JSON.parse(String(requestInit?.body)) as Record<string, unknown>;
  assert.equal(requestUrl, `${SNOWFLAKE_BASE_URL}/api/v2/cortex/v1/chat/completions`);
  assert.equal(requestHeader(requestInit, 'authorization'), `Bearer ${TEST_CREDENTIAL}`);
  assert.equal(requestHeader(requestInit, 'x-snowflake-authorization-token-type'), 'OAUTH');
  assert.equal(requestHeader(requestInit, 'x-api-key'), null);
  assert.doesNotMatch(String(requestInit?.body), new RegExp(TEST_CREDENTIAL));
  assert.equal(body.max_completion_tokens, 8192);
  assert.equal('max_tokens' in body, false);
  assert.equal(body.stream, false);
});

test('Snowflake tolerates documented terminal omission but still requires one strict JSON object', async (t) => {
  const responses = [
    { choices: [{ message: { content: '{"ok":true}' } }] },
    { choices: [{ message: { content: '```json\n{"ok":true}\n```' } }] },
  ];
  let requestCount = 0;
  t.mock.method(globalThis, 'fetch', async () => jsonResponse(responses[requestCount++]));

  const accepted = await generateStructuredProposal(
    provider('snowflake_cortex', { id: 'provider-snowflake-terminal-omission' }),
    generationInput(),
  );
  assert.deepEqual(accepted.output, { ok: true });

  await assert.rejects(
    () => generateStructuredProposal(
      provider('snowflake_cortex', { id: 'provider-snowflake-nonstrict-json' }),
      generationInput(),
    ),
    (error: unknown) => error instanceof MigrationProviderRequestError && error.code === 'AI_PROVIDER_STRUCTURED_OUTPUT_INVALID',
  );
  assert.equal(requestCount, 2);
});

test('Databricks Genie accepts nested identifiers and fetches the trusted query-result attachment path', async (t) => {
  const requestUrls: string[] = [];
  const requestMethods: string[] = [];
  const requestAuthorizations: Array<string | null> = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requestUrls.push(url);
    requestMethods.push(init?.method || 'GET');
    requestAuthorizations.push(requestHeader(init, 'authorization'));
    if (url.endsWith('/start-conversation')) {
      return jsonResponse({
        conversation: { id: 'conversation-example' },
        message: {
          id: 'message-example',
          status: 'COMPLETED',
          attachments: [
            { text: { content: 'Validation completed.' } },
            {
              attachment_id: 'attachment-example',
              query: { query: 'SELECT 1 AS example_value', parameters: { source: 'curated-space' } },
            },
          ],
        },
      });
    }
    if (url.endsWith('/attachments/attachment-example/query-result')) {
      return jsonResponse({
        statement_response: {
          statement_id: 'statement-example',
          status: { state: 'SUCCEEDED' },
          manifest: {
            total_row_count: 2,
            truncated: false,
            schema: {
              columns: [
                { name: 'example_value', type_name: 'LONG' },
                { name: 'example_label', type_name: 'STRING' },
              ],
            },
          },
          result: {
            row_count: 2,
            data_array: [[1, 'one'], [2, 'two']],
          },
        },
      });
    }
    return jsonResponse({ error: 'Unexpected mocked path.' }, { status: 500 });
  });

  const result = await generateStructuredProposal(provider('databricks_genie'), generationInput({
    task: 'generate_validation_sql',
  }));
  const output = result.output as Record<string, unknown>;

  assert.deepEqual(requestUrls, [
      `${DATABRICKS_BASE_URL}/api/2.0/genie/spaces/example-space-id/start-conversation`,
      `${DATABRICKS_BASE_URL}/api/2.0/genie/spaces/example-space-id/conversations/conversation-example/messages/message-example/attachments/attachment-example/query-result`,
  ]);
  assert.deepEqual(requestMethods, ['POST', 'GET']);
  assert.deepEqual(requestAuthorizations, [`Bearer ${TEST_CREDENTIAL}`, `Bearer ${TEST_CREDENTIAL}`]);
  assert.equal(output.conversationId, 'conversation-example');
  assert.equal(output.messageId, 'message-example');
  assert.equal(output.sql, 'SELECT 1 AS example_value');
  assert.equal(output.trustedAsset, true);
  assert.equal(output.queryResultAttachmentCount, 1);
  assert.deepEqual(output.queryResults, [{
    attachmentId: 'attachment-example',
    statementId: 'statement-example',
    state: 'SUCCEEDED',
    columns: [
      { name: 'example_value', type: 'LONG' },
      { name: 'example_label', type: 'STRING' },
    ],
    rows: [[1, 'one'], [2, 'two']],
    rowCount: 2,
    returnedRowCount: 2,
    truncated: false,
    providerTruncated: false,
    locallyTruncated: false,
  }]);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(TEST_CREDENTIAL));
});

test('Databricks Genie bounds query-result previews and preserves truncation evidence', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/start-conversation')) {
      return jsonResponse({
        conversation: { id: 'conversation-bounded' },
        message: {
          id: 'message-bounded',
          status: 'COMPLETED',
          attachments: [{
            attachment_id: 'attachment-bounded',
            query: { query: 'SELECT example_value FROM example_table' },
          }],
        },
      });
    }
    return jsonResponse({
      statement_response: {
        status: { state: 'SUCCEEDED' },
        manifest: {
          total_row_count: 101,
          truncated: false,
          schema: { columns: [{ name: 'example_value', type_name: 'LONG' }] },
        },
        result: { data_array: Array.from({ length: 101 }, (_, index) => [index]) },
      },
    });
  });

  const result = await generateStructuredProposal(
    provider('databricks_genie', { id: 'provider-genie-bounded-result' }),
    generationInput({ task: 'evaluate_reconciliation' }),
  );
  const output = result.output as { queryResults: Array<Record<string, unknown>> };
  const queryResult = output.queryResults[0] || {};
  assert.equal((queryResult.rows as unknown[]).length, 100);
  assert.equal(queryResult.rowCount, 101);
  assert.equal(queryResult.returnedRowCount, 100);
  assert.equal(queryResult.providerTruncated, false);
  assert.equal(queryResult.locallyTruncated, true);
  assert.equal(queryResult.truncated, true);
});

test('Databricks Genie treats expired messages and failed query-result statements as terminal', async (t) => {
  let requestCount = 0;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    requestCount += 1;
    const url = String(input);
    if (requestCount === 1) {
      return jsonResponse({
        conversation: { id: 'conversation-expired' },
        message: { id: 'message-expired', status: 'QUERY_RESULT_EXPIRED' },
      });
    }
    if (url.endsWith('/start-conversation')) {
      return jsonResponse({
        conversation: { id: 'conversation-failed-query' },
        message: {
          id: 'message-failed-query',
          status: 'COMPLETED',
          attachments: [{
            attachment_id: 'attachment-failed-query',
            query: { query: 'SELECT 1' },
          }],
        },
      });
    }
    return jsonResponse({
      statement_response: {
        status: { state: 'FAILED' },
      },
    });
  });

  await assert.rejects(
    () => generateStructuredProposal(provider('databricks_genie', { id: 'provider-genie-expired' }), generationInput({ task: 'generate_validation_sql' })),
    (error: unknown) => error instanceof MigrationProviderRequestError && error.code === 'AI_PROVIDER_QUERY_RESULT_EXPIRED',
  );
  assert.equal(requestCount, 1, 'expired results must stop without polling or starting another conversation');

  await assert.rejects(
    () => generateStructuredProposal(provider('databricks_genie', { id: 'provider-genie-failed-query' }), generationInput({ task: 'evaluate_reconciliation' })),
    (error: unknown) => error instanceof MigrationProviderRequestError && error.code === 'AI_PROVIDER_QUERY_FAILED',
  );
  assert.equal(requestCount, 3);
});

test('Omni provider preflight validates the linked instance without posting a placeholder model ID', async (t) => {
  unlockVault('provider contract test passphrase');
  const instance = upsertInstance({
    label: 'Example Omni instance',
    role: 'both',
    baseUrl: 'https://example.omniapp.co',
    apiKey: 'omni_fixture_key',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
  const requestUrls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    requestUrls.push(String(input));
    return jsonResponse({ models: [], pageInfo: { hasNextPage: false } });
  });

  const result = await testLlmProvider(provider('omni_ai', {
    id: 'provider-omni-linked-preflight',
    linkedInstanceId: instance.id,
    model: 'target-model',
    credential: '',
  }));

  assert.equal(result.ok, true);
  assert.equal(result.capabilities.toolUse, false);
  assert.match(result.capabilities.limitations.join(' '), /best-effort prompt-constrained JSON/i);
  assert.equal(requestUrls.length, 1);
  assert.match(requestUrls[0] || '', /\/api\/v1\/models/);
  assert.doesNotMatch(requestUrls[0] || '', /\/api\/v1\/ai\/jobs/);
  assert.equal(providerCapabilities('omni_ai').toolUse, false);
});

test('429 responses retry only to the bounded attempt limit and never expose the upstream body', async (t) => {
  const upstreamMarker = 'upstream-rate-limit-body-marker';
  let requestCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requestCount += 1;
    return jsonResponse({
      error: `${upstreamMarker}; credential=${TEST_CREDENTIAL}`,
    }, {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': '0',
        'x-request-id': 'request-example',
      },
    });
  });

  await assert.rejects(
    () => generateStructuredProposal(provider('openai', { id: 'provider-openai-rate-limit' }), generationInput()),
    (error: unknown) => {
      assert.ok(error instanceof MigrationProviderRequestError);
      assert.equal(error.code, 'AI_PROVIDER_RATE_LIMITED');
      assert.equal(error.statusCode, 429);
      assert.equal(error.upstreamStatus, 429);
      assert.equal(error.retryAfterMs, 0);
      assert.equal(error.requestId, 'request-example');
      assert.equal(error.retryable, true);
      assert.doesNotMatch(error.message, new RegExp(upstreamMarker));
      assert.doesNotMatch(error.message, new RegExp(TEST_CREDENTIAL));
      return true;
    },
  );
  assert.equal(requestCount, 3);
});

test('generation POST leaves explicit upstream 5xx retries to the user', async (t) => {
  let requestCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requestCount += 1;
    return jsonResponse({ error: 'The provider returned an indeterminate server failure.' }, { status: 501 });
  });

  await assert.rejects(
    () => generateStructuredProposal(
      provider('openai', { id: 'provider-openai-explicit-5xx' }),
      generationInput(),
    ),
    (error: unknown) => error instanceof MigrationProviderRequestError
      && error.code === 'AI_PROVIDER_UNAVAILABLE'
      && error.retryable
      && error.attempts === 1,
  );
  assert.equal(requestCount, 1);
});

test('built-in providers never inherit the custom provider host allowlist', async (t) => {
  process.env.OMNIKIT_MIGRATION_PROVIDER_HOST_ALLOWLIST = TEST_HOST;
  let requestCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requestCount += 1;
    return jsonResponse({
      choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }],
    });
  });

  await assert.rejects(
    () => generateStructuredProposal(provider('openai', { baseUrl: TEST_BASE_URL }), generationInput()),
    /host is not allowlisted/i,
  );
  assert.equal(requestCount, 0);
});

test('custom OpenAI-compatible providers fail closed without an explicit host allowlist', async (t) => {
  delete process.env.OMNIKIT_MIGRATION_PROVIDER_HOST_ALLOWLIST;
  let requestCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requestCount += 1;
    return jsonResponse({
      choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }],
    });
  });

  await assert.rejects(
    () => generateStructuredProposal(provider('custom_openai_compatible'), generationInput()),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /require OMNIKIT_MIGRATION_PROVIDER_HOST_ALLOWLIST/i);
      assert.equal((error as Error & { statusCode?: number }).statusCode, 403);
      return true;
    },
  );
  assert.equal(requestCount, 0);
});

test('generation POST network loss is typed and never replayed', async (t) => {
  let requestCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requestCount += 1;
    throw new TypeError('Mocked connection loss after dispatch.');
  });

  await assert.rejects(
    () => generateStructuredProposal(provider('openai', { id: 'provider-openai-network-loss' }), generationInput()),
    (error: unknown) => {
      assert.ok(error instanceof MigrationProviderRequestError);
      assert.equal(error.code, 'AI_PROVIDER_NETWORK_ERROR');
      assert.equal(error.retryable, false);
      assert.equal(error.attempts, 1);
      return true;
    },
  );
  assert.equal(requestCount, 1);
});

test('generation POST body-stream abort is a typed timeout and is never replayed', async (t) => {
  let requestCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requestCount += 1;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new DOMException('Mocked response stream aborted.', 'AbortError'));
      },
    }), { status: 200 });
  });

  await assert.rejects(
    () => generateStructuredProposal(provider('openai', { id: 'provider-openai-body-abort' }), generationInput()),
    (error: unknown) => {
      assert.ok(error instanceof MigrationProviderRequestError);
      assert.equal(error.code, 'AI_PROVIDER_TIMEOUT');
      assert.equal(error.retryable, false);
      assert.equal(error.attempts, 1);
      return true;
    },
  );
  assert.equal(requestCount, 1);
});

test('safe Genie GET preflight retries bounded body-stream aborts', async (t) => {
  let requestCount = 0;
  const requestAuthorizations: Array<string | null> = [];
  t.mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
    requestCount += 1;
    requestAuthorizations.push(requestHeader(init, 'authorization'));
    if (requestCount < 3) {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new DOMException('Mocked GET stream aborted.', 'AbortError'));
        },
      }), { status: 200 });
    }
    return jsonResponse({ space_id: 'example-space-id', title: 'Example space' });
  });

  const result = await testLlmProvider(provider('databricks_genie', { id: 'provider-genie-get-retry' }));
  assert.equal(result.ok, true);
  assert.equal(requestCount, 3);
  assert.deepEqual(requestAuthorizations, Array.from({ length: 3 }, () => `Bearer ${TEST_CREDENTIAL}`));
});

test('provider execution cancellation aborts an active response body without retrying', async (t) => {
  const controller = new AbortController();
  let requestCount = 0;
  let resolveRequestStarted: (() => void) | undefined;
  const requestStarted = new Promise<void>((resolve) => {
    resolveRequestStarted = resolve;
  });
  t.mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
    requestCount += 1;
    resolveRequestStarted?.();
    const signal = init?.signal;
    return new Response(new ReadableStream<Uint8Array>({
      start(streamController) {
        if (signal?.aborted) {
          streamController.error(new DOMException('Mocked response body aborted.', 'AbortError'));
          return;
        }
        signal?.addEventListener('abort', () => {
          streamController.error(new DOMException('Mocked response body aborted.', 'AbortError'));
        }, { once: true });
      },
    }), { status: 200 });
  });

  const pending = generateStructuredProposal(
    provider('openai', { id: 'provider-openai-cancelled' }),
    generationInput(),
    { signal: controller.signal },
  );
  await requestStarted;
  controller.abort();

  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof MigrationProviderRequestError);
    assert.equal(error.code, 'AI_PROVIDER_CANCELLED');
    assert.equal(error.statusCode, 409);
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(requestCount, 1);
});

test('oversized provider responses fail closed without replaying generation', async (t) => {
  let requestCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requestCount += 1;
    return new Response('{}', {
      status: 200,
      headers: { 'Content-Length': String((4 * 1024 * 1024) + 1) },
    });
  });

  await assert.rejects(
    () => generateStructuredProposal(provider('openai', { id: 'provider-openai-oversized' }), generationInput()),
    (error: unknown) => error instanceof MigrationProviderRequestError && error.code === 'AI_PROVIDER_RESPONSE_TOO_LARGE',
  );
  assert.equal(requestCount, 1);
});

test('expired, unvalidated, and stale provider revisions fail before any outbound request', async (t) => {
  let requestCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requestCount += 1;
    return jsonResponse({});
  });

  await assert.rejects(
    () => generateStructuredProposal(provider('snowflake_cortex', {
      id: 'provider-snowflake-expired',
      credentialExpiresAt: '2000-01-01T00:00:00.000Z',
    }), generationInput()),
    (error: unknown) => Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'AI_PROVIDER_CREDENTIAL_EXPIRED'),
  );
  await assert.rejects(
    () => generateStructuredProposal(provider('openai', {
      id: 'provider-openai-unvalidated',
      lastValidationStatus: undefined,
      lastValidatedRevision: undefined,
    }), generationInput()),
    (error: unknown) => Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'AI_PROVIDER_VALIDATION_REQUIRED'),
  );
  await assert.rejects(
    () => generateStructuredProposal(provider('openai', {
      id: 'provider-openai-stale-revision',
      updatedAt: '2026-01-01T00:00:00.001Z',
      lastValidatedRevision: '2026-01-01T00:00:00.000Z',
    }), generationInput()),
    (error: unknown) => Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'AI_PROVIDER_VALIDATION_REQUIRED'),
  );
  assert.equal(requestCount, 0);
});

test('provider routes save masked credentials, validate the exact revision, and run API-key and OAuth jobs', async (t) => {
  unlockVault('provider route workflow passphrase');
  const outbound: Array<{ url: string; authorization: string | null; apiKey: string | null; snowflakeTokenType: string | null }> = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    outbound.push({
      url: String(input),
      authorization: requestHeader(init, 'authorization'),
      apiKey: requestHeader(init, 'x-api-key'),
      snowflakeTokenType: requestHeader(init, 'x-snowflake-authorization-token-type'),
    });
    return jsonResponse({
      model: 'documented-provider-model-version',
      choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }],
    });
  });

  const cases = [
    {
      name: 'Route OpenAI',
      kind: 'openai',
      model: 'gpt-5.1',
      baseUrl: OPENAI_BASE_URL,
      authMode: 'api_key',
      credential: 'route-openai-project-key',
      expectedOrigin: OPENAI_BASE_URL,
      expectedAuthorization: 'Bearer route-openai-project-key',
      expectedSnowflakeTokenType: null,
    },
    {
      name: 'Route Snowflake Cortex',
      kind: 'snowflake_cortex',
      model: 'claude-example',
      baseUrl: SNOWFLAKE_BASE_URL,
      authMode: 'oauth_access_token',
      credential: 'route-snowflake-oauth-token',
      credentialExpiresAt: '2099-12-31T00:00:00.000Z',
      expectedOrigin: SNOWFLAKE_BASE_URL,
      expectedAuthorization: 'Bearer route-snowflake-oauth-token',
      expectedSnowflakeTokenType: 'OAUTH',
    },
  ] as const;

  for (const item of cases) {
    const saveResponse = await migrationStudioHandler(new Request('http://localhost/api/migration-studio/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(item),
    }));
    assert.equal(saveResponse.status, 201);
    const savePayload = await saveResponse.json() as { provider: Record<string, unknown> };
    const saved = savePayload.provider;
    const providerId = String(saved.id);
    assert.equal('credential' in saved, false);
    assert.equal(saved.hasCredential, true);
    assert.doesNotMatch(JSON.stringify(savePayload), new RegExp(item.credential));

    const listResponse = await migrationStudioHandler(new Request('http://localhost/api/migration-studio/providers'));
    assert.equal(listResponse.status, 200);
    const listBody = JSON.stringify(await listResponse.json());
    assert.doesNotMatch(listBody, new RegExp(item.credential));

    const testResponse = await migrationStudioHandler(new Request(`http://localhost/api/migration-studio/providers/${encodeURIComponent(providerId)}/test`, {
      method: 'POST',
    }));
    assert.equal(testResponse.status, 200);
    const testPayload = await testResponse.json() as { provider: Record<string, unknown> };
    assert.equal(testPayload.provider.lastValidationStatus, 'valid');
    assert.equal(testPayload.provider.lastValidatedRevision, testPayload.provider.updatedAt);
    assert.doesNotMatch(JSON.stringify(testPayload), new RegExp(item.credential));

    const jobResponse = await migrationStudioHandler(new Request('http://localhost/api/migration-studio/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `${providerId}:route-proof` },
      body: JSON.stringify({
        providerId,
        task: 'classify_inventory',
        system: 'Return one strict test object.',
        prompt: 'Return {"ok":true}.',
        schemaName: 'route_provider_proof',
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
        },
      }),
    }));
    assert.equal(jobResponse.status, 202);
    const jobPayload = await jobResponse.json() as { job: { id: string } };
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = getSemanticMigrationJob(jobPayload.job.id)?.status;
      if (status === 'succeeded' || status === 'failed' || status === 'cancelled') break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(getSemanticMigrationJob(jobPayload.job.id)?.status, 'succeeded');
    const completedResponse = await migrationStudioHandler(new Request(`http://localhost/api/migration-studio/jobs/${encodeURIComponent(jobPayload.job.id)}`));
    assert.equal(completedResponse.status, 200);
    const completedBody = JSON.stringify(await completedResponse.json());
    assert.match(completedBody, /"ok":true/);
    assert.doesNotMatch(completedBody, new RegExp(item.credential));

    const requests = outbound.filter((request) => request.url.startsWith(item.expectedOrigin));
    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.equal(request.authorization, item.expectedAuthorization);
      assert.equal(request.apiKey, null);
      assert.equal(request.snowflakeTokenType, item.expectedSnowflakeTokenType);
    }
  }
});

test('ambiguous transport failures open the provider circuit without replaying each POST', async (t) => {
  let requestCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requestCount += 1;
    throw new TypeError('Mocked provider outage.');
  });
  const failedProvider = provider('openai', { id: 'provider-openai-circuit' });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(
      () => generateStructuredProposal(failedProvider, generationInput()),
      (error: unknown) => error instanceof MigrationProviderRequestError && error.code === 'AI_PROVIDER_NETWORK_ERROR',
    );
  }
  await assert.rejects(
    () => generateStructuredProposal(failedProvider, generationInput()),
    (error: unknown) => error instanceof MigrationProviderRequestError && error.code === 'AI_PROVIDER_CIRCUIT_OPEN',
  );
  assert.equal(requestCount, 5);
});

test('semantic job cancellation aborts locally and invokes registered upstream cancellation once', async () => {
  let resolveRunStarted: (() => void) | undefined;
  const runStarted = new Promise<void>((resolve) => {
    resolveRunStarted = resolve;
  });
  let runSignal: AbortSignal | undefined;
  let upstreamCancellationCount = 0;
  const job = startSemanticMigrationJob({
    providerId: 'provider-example',
    projectId: 'project-example',
    stage: 'analyze',
    requestFingerprintSource: 'example-request',
    run: async ({ signal, registerUpstreamCancellation }) => {
      runSignal = signal;
      registerUpstreamCancellation(async () => {
        upstreamCancellationCount += 1;
      });
      resolveRunStarted?.();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('Mocked local execution aborted.')), { once: true });
      });
      return { output: { ok: true } };
    },
  });
  await runStarted;

  const cancellation = cancelSemanticMigrationJob(job.id);
  assert.ok(cancellation);
  assert.equal(cancellation.status, 'cancelled');
  const completedCancellation = await cancellation;
  assert.equal(completedCancellation.status, 'cancelled');
  assert.equal(runSignal?.aborted, true);
  assert.equal(upstreamCancellationCount, 1);
  assert.equal(getSemanticMigrationJob(job.id)?.status, 'cancelled');
  assert.equal(getSemanticMigrationJobResult(job.id), undefined);

  const repeatedCancellation = cancelSemanticMigrationJob(job.id);
  assert.ok(repeatedCancellation);
  await repeatedCancellation;
  assert.equal(upstreamCancellationCount, 1, 'repeated cancellation must reuse the first upstream cancellation');
});

test('semantic job idempotency reuses identical work and rejects conflicting input', async () => {
  let runCount = 0;
  const input = {
    providerId: 'provider-example',
    projectId: 'project-example',
    stage: 'compile' as const,
    requestFingerprintSource: 'same-example-request',
    idempotencyKey: 'example:compile:1',
    run: async () => {
      runCount += 1;
      return { output: { ok: true } };
    },
  };

  const first = startSemanticMigrationJob(input);
  const duplicate = startSemanticMigrationJob(input);
  assert.equal(duplicate.id, first.id);
  assert.equal(duplicate.requestFingerprint, first.requestFingerprint);

  assert.throws(
    () => startSemanticMigrationJob({
      ...input,
      requestFingerprintSource: 'different-example-request',
    }),
    (error: unknown) => {
      assert.ok(error instanceof SemanticMigrationJobIdempotencyConflictError);
      assert.equal(error.code, 'SEMANTIC_JOB_IDEMPOTENCY_CONFLICT');
      assert.equal(error.statusCode, 409);
      return true;
    },
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runCount, 1);
  assert.equal(getSemanticMigrationJob(first.id)?.status, 'succeeded');
});

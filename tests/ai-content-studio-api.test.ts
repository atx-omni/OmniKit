import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import {
  createAiPublicOnlyLookup,
  handleManageAi,
  readBoundedJson,
  type ManageAiDependencies,
} from '../server/handlers/manage-ai';
import {
  ApiError,
  createAiJob,
  createAiContentStudioJob,
  getAiJob,
  getAiContentStudioJob,
  getAiContentStudioJobResult,
  getAiJobResult,
  isRetryableAiJobReadError,
  cancelAiJob,
  cancelAiContentStudioJob,
  verifyAiContentDocument,
  trashAiContentDocument,
  listConnections,
  listModels,
  listTopics,
  OMNI_AI_CONTENT_STUDIO_COMPLETE_NO_USABLE_RESULT_CODE,
  type OmniAiContentStudioJobResult,
} from '../src/services/omniApi';
import listModelsHandler from '../server/handlers/list-models';
import manageTopicsHandler from '../server/handlers/manage-topics';
import {
  AI_CONTENT_RESULT_CONTRACT_MISMATCH_CODE,
  AIContentCompletedResultValidationError,
  AIContentResultContractMismatchError,
  recoverCompletedAIContentJob,
  runAIContentJob,
  type AIContentJobTransport,
} from '../src/services/aiContentStudio/jobRunner';
import {
  applyStudioConnectionNames,
  parseStudioConnectionNamesResponse,
} from '../src/services/topicsRequestState';

const API_KEY = 'vault-hydrated-server-side-key';
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const PNG_BASE64 = PNG_BYTES.toString('base64');
const PDF_BASE64 = Buffer.from('%PDF-1.7\n').toString('base64');
const JOB_ID = '550e8400-e29b-41d4-a716-446655440000';
const CONVERSATION_ID = '660e8400-e29b-41d4-a716-446655440001';
const MODEL_ID = '770e8400-e29b-41d4-a716-446655440002';

test('AI result read retry classification is shared across every client runner', () => {
  [0, 404, 408, 409, 425, 429, 500, 502, 503, 504].forEach((status) => {
    assert.equal(
      isRetryableAiJobReadError(new ApiError(status, 'Transient read failure.')),
      true,
      `expected ${status} to be retryable`,
    );
  });
  [400, 401, 403, 405, 422].forEach((status) => {
    assert.equal(
      isRetryableAiJobReadError(new ApiError(status, 'Deterministic read failure.')),
      false,
      `expected ${status} not to be retryable`,
    );
  });
  assert.equal(isRetryableAiJobReadError(new Error('Unknown failure.')), false);
});

function liveReviewNarrative(): string {
  return [
    '## Evidence reviewed',
    '',
    'The captured dashboard render and bounded dashboard structure were reviewed.',
    '',
    '## Supported findings',
    '',
    `The executive hierarchy is clear. ${'A specific visible finding remained evidence grounded. '.repeat(55)}`,
    '',
    '## Unknowns',
    '',
    'Interaction behavior and hidden states were not assessable from the static render.',
    '',
    '## Recommended next steps',
    '',
    'Resolve the empty state first, then tighten formatting and visual density.',
  ].join('\n');
}

function incomingJsonStream(contentType: string, payload: unknown): IncomingMessage {
  const stream = new PassThrough();
  Object.assign(stream, { headers: { 'content-type': contentType } });
  stream.end(JSON.stringify(payload));
  return stream as unknown as IncomingMessage;
}

function validDashboardState() {
  return {
    name: 'Created dashboard',
    modelId: MODEL_ID,
    queryPresentations: {
      data: { '1': { type: 'query', name: 'Governed metric' } },
      order: ['1'],
    },
    containers: [{ type: 'grid' }],
  };
}

function createJobRequest(attachments: unknown, prompt = 'Build content from the attached evidence.'): Request {
  return new Request('http://127.0.0.1/api/manage-ai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base_url: 'https://example.omniapp.co',
      api_key: API_KEY,
      action: 'create-job',
      model_id: 'model-a',
      prompt,
      attachments,
    }),
  });
}

function testDependencies(
  request: NonNullable<ManageAiDependencies['request']>,
): ManageAiDependencies {
  return { validateOutbound: async () => undefined, request };
}

function resultRequest(baseUrl = 'https://example.omniapp.co'): Request {
  return new Request('http://127.0.0.1/api/manage-ai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base_url: baseUrl,
      api_key: API_KEY,
      action: 'get-content-studio-job-result',
      job_id: 'job-a',
    }),
  });
}

function genericResultRequest(baseUrl = 'https://example.omniapp.co'): Request {
  return new Request('http://127.0.0.1/api/manage-ai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base_url: baseUrl,
      api_key: API_KEY,
      action: 'get-job-result',
      job_id: 'job-a',
    }),
  });
}

function contentStudioLifecycleRequest(action: 'create-job' | 'get-job' | 'cancel-job'): Request {
  return new Request('http://127.0.0.1/api/manage-ai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base_url: 'https://example.omniapp.co',
      api_key: API_KEY,
      action,
      response_contract: 'ai-content-studio-v1',
      ...(action === 'create-job' ? {
        model_id: 'model-a',
        prompt: 'Build content from governed evidence.',
      } : { job_id: JOB_ID }),
    }),
  });
}

function contentDocumentRequest(
  action: 'verify-content-document' | 'trash-content-document',
  documentId = 'created-dashboard',
): Request {
  return new Request('http://127.0.0.1/api/manage-ai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base_url: 'https://example.omniapp.co',
      api_key: API_KEY,
      action,
      document_id: documentId,
    }),
  });
}

test('AI proxy forwards the exact Omni attachment schema and never echoes attachment or credential bytes', async () => {
  let upstreamBody: Record<string, unknown> | undefined;
  const largeBinary = Buffer.alloc(1_200, 7).toString('base64');
  const response = await handleManageAi(createJobRequest([{
    data: PNG_BASE64,
    mimeType: 'image/png',
    name: 'reference.png',
  }]), testDependencies(async (request) => {
    upstreamBody = JSON.parse(request.body || '{}') as Record<string, unknown>;
    return {
      status: 200,
      data: {
        jobId: 'job-a',
        message: `created with ${API_KEY}`,
        [API_KEY]: `key=${API_KEY}`,
        attachments: [{ mime_type: 'image/png', data: PNG_BASE64, name: 'reference.png' }],
        nested: { attachment: { contentType: 'image/png', data: PNG_BASE64 } },
        opaque: largeBinary,
      },
    };
  }));

  assert.equal(response.status, 200);
  assert.deepEqual(upstreamBody?.attachments, [{
    data: PNG_BASE64,
    mimeType: 'image/png',
    name: 'reference.png',
  }]);
  const serialized = await response.text();
  assert.doesNotMatch(serialized, new RegExp(API_KEY, 'g'));
  assert.doesNotMatch(serialized, new RegExp(PNG_BASE64.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'));
  assert.doesNotMatch(serialized, new RegExp(largeBinary.slice(0, 100), 'g'));
  assert.match(serialized, /redacted-binary/);
});

test('AI proxy rejects malformed base64 and MIME-signature mismatches without outbound requests', async () => {
  let calls = 0;
  const dependencies = testDependencies(async () => {
    calls += 1;
    return { status: 200, data: { jobId: 'should-not-run' } };
  });

  const malformed = await handleManageAi(createJobRequest([{
    data: 'not-base64%%',
    mimeType: 'image/png',
  }]), dependencies);
  assert.equal(malformed.status, 400);
  assert.match((await malformed.json() as { error: string }).error, /canonical base64/);

  const mismatch = await handleManageAi(createJobRequest([{
    data: PDF_BASE64,
    mimeType: 'image/png',
  }]), dependencies);
  assert.equal(mismatch.status, 400);
  assert.match((await mismatch.json() as { error: string }).error, /does not match/);
  assert.equal(calls, 0);
});

test('AI proxy rejects implausibly short credentials before response redaction', async () => {
  let calls = 0;
  const request = new Request('http://127.0.0.1/api/manage-ai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base_url: 'https://example.omniapp.co',
      api_key: 'a',
      action: 'create-job',
      model_id: 'model-a',
      prompt: 'Build a report.',
    }),
  });
  const response = await handleManageAi(request, testDependencies(async () => {
    calls += 1;
    return { status: 200, data: { jobId: 'should-not-run' } };
  }));
  assert.equal(response.status, 400);
  assert.equal(calls, 0);
});

test('AI Content Studio result projection keeps only bounded display fields and neutral document IDs', async () => {
  const csvResult = 'customer_email,revenue\nprivate@example.com,1200000';
  const query = { fields: ['orders.customer_email', 'orders.revenue'], filters: { secret: API_KEY } };
  let maximumResponseBytes = 0;
  const response = await handleManageAi(resultRequest(), testDependencies(async (request) => {
    maximumResponseBytes = request.maximumResponseBytes || 0;
    return {
      status: 200,
      data: {
        message: `Report complete without exposing ${API_KEY}.`,
        topic: 'orders',
        omniChatUrl: 'https://example.omniapp.co/chat/conversation-a',
        actions: [{
          type: 'generate_query',
          message: 'Queried the requested measures.',
          timestamp: '2026-08-13T12:00:00.000Z',
          result: {
            query,
            csvResult,
            document: { id: 'dashboard-123', title: 'Private dashboard title' },
          },
          internalTrace: { apiKey: API_KEY },
        }, {
          type: 'create_dashboard',
          message: 'Created the requested dashboard.',
          timestamp: '2026-08-13T12:00:01.000Z',
          documentId: 'dashboard-456',
        }],
        internalPrompt: 'server-only',
      },
    };
  }));

  assert.equal(response.status, 200);
  assert.equal(maximumResponseBytes, 16 * 1024 * 1024);
  const projected = await response.json();
  assert.deepEqual(projected, {
    message: 'Report complete without exposing [redacted].',
    actions: [{
      type: 'generate_query',
      message: 'Queried the requested measures.',
      timestamp: '2026-08-13T12:00:00.000Z',
      documentId: 'dashboard-123',
    }, {
      type: 'create_dashboard',
      message: 'Created the requested dashboard.',
      timestamp: '2026-08-13T12:00:01.000Z',
      documentId: 'dashboard-456',
    }],
    topic: 'orders',
    omniChatUrl: 'https://example.omniapp.co/chat/conversation-a',
  });
  const serialized = JSON.stringify(projected);
  assert.doesNotMatch(serialized, /customer_email|private@example\.com|csvResult|internalTrace|internalPrompt|Private dashboard title/);
  assert.doesNotMatch(serialized, new RegExp(API_KEY));
});

test('AI result readers accept bounded JSON from Omni octet streams while non-result readers reject it', async () => {
  const payload = {
    actions: [],
    message: 'A bounded result narrative.',
  };
  assert.deepEqual(
    await readBoundedJson(
      incomingJsonStream('application/octet-stream', payload),
      1024,
      true,
    ),
    payload,
  );
  await assert.rejects(
    readBoundedJson(
      incomingJsonStream('application/octet-stream', payload),
      1024,
      false,
    ),
    /non-json-response/,
  );
  await assert.rejects(
    readBoundedJson(
      incomingJsonStream('text/html', payload),
      1024,
      true,
    ),
    /non-json-response/,
  );
});

test('AI proxy permits octet-stream JSON only for generic and Content Studio result reads', async () => {
  const resultReadOptions: Array<{ action: string; allowsOctetStream: boolean; maximumResponseBytes?: number }> = [];
  const capture = testDependencies(async (request) => {
    const path = new URL(request.url).pathname;
    resultReadOptions.push({
      action: path,
      allowsOctetStream: request.allowOctetStreamJson === true,
      maximumResponseBytes: request.maximumResponseBytes,
    });
    const data = path.endsWith('/result')
      ? { actions: [], message: 'A bounded result narrative.' }
      : path.endsWith('/cancel')
        ? { jobId: JOB_ID, state: 'CANCELLED' }
        : request.method === 'POST'
          ? {
              jobId: JOB_ID,
              conversationId: CONVERSATION_ID,
              omniChatUrl: `https://example.omniapp.co/chat/${CONVERSATION_ID}`,
            }
          : {
              id: JOB_ID,
              state: 'COMPLETE',
              conversationId: CONVERSATION_ID,
              omniChatUrl: `https://example.omniapp.co/chat/${CONVERSATION_ID}`,
            };
    return {
      status: 200,
      data,
    };
  });

  const genericResult = await handleManageAi(genericResultRequest(), capture);
  const contentResult = await handleManageAi(resultRequest(), capture);
  const create = await handleManageAi(contentStudioLifecycleRequest('create-job'), capture);
  const status = await handleManageAi(contentStudioLifecycleRequest('get-job'), capture);
  const cancel = await handleManageAi(contentStudioLifecycleRequest('cancel-job'), capture);

  assert.equal(genericResult.status, 200);
  assert.equal(contentResult.status, 200);
  assert.equal(create.status, 200);
  assert.equal(status.status, 200);
  assert.equal(cancel.status, 200);
  assert.deepEqual(resultReadOptions.map(({ allowsOctetStream, maximumResponseBytes }) => ({
    allowsOctetStream,
    maximumResponseBytes,
  })), [
    { allowsOctetStream: true, maximumResponseBytes: 2 * 1024 * 1024 },
    { allowsOctetStream: true, maximumResponseBytes: 16 * 1024 * 1024 },
    { allowsOctetStream: false, maximumResponseBytes: 2 * 1024 * 1024 },
    { allowsOctetStream: false, maximumResponseBytes: 2 * 1024 * 1024 },
    { allowsOctetStream: false, maximumResponseBytes: 2 * 1024 * 1024 },
  ]);
});

test('AI Content Studio projects the live octet-stream review envelope without duplicating its final narrative action', async () => {
  const narrative = liveReviewNarrative();
  assert.ok(narrative.length > 2_000);
  let resultTransportAllowsOctetStream = false;
  const response = await handleManageAi(resultRequest(), testDependencies(async (request) => {
    resultTransportAllowsOctetStream = request.allowOctetStreamJson === true;
    return {
      status: 200,
      data: {
        actions: [{
          type: 'summarize',
          message: narrative,
          timestamp: '2026-08-14T16:11:00.000Z',
        }],
        message: narrative,
        metrics: { tokens: 7_493, internal: API_KEY },
        omniChatUrl: `https://example.omniapp.co/chat/${CONVERSATION_ID}`,
        resultSummary: narrative,
      },
    };
  }));

  assert.equal(resultTransportAllowsOctetStream, true);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    actions: [],
    message: narrative,
    resultSummary: narrative,
    omniChatUrl: `https://example.omniapp.co/chat/${CONVERSATION_ID}`,
  });
});

test('AI Content Studio result projection accepts documented optional top-level fields without weakening actions', async () => {
  const summaryOnly = await handleManageAi(resultRequest(), testDependencies(async () => ({
    status: 200,
    data: {
      resultSummary: 'The App job completed; continue verification in Omni.',
      omniChatUrl: 'https://example.omni.co/chat/conversation-a?discard=1#fragment',
    },
  })));
  assert.equal(summaryOnly.status, 200);
  assert.deepEqual(await summaryOnly.json(), {
    actions: [],
    resultSummary: 'The App job completed; continue verification in Omni.',
    omniChatUrl: 'https://example.omni.co/chat/conversation-a',
  });

  const messageOnly = await handleManageAi(resultRequest(), testDependencies(async () => ({
    status: 200,
    data: {
      message: 'The requested content flow completed.',
      resultSummary: null,
      actions: null,
      topic: null,
      omniChatUrl: null,
    },
  })));
  assert.equal(messageOnly.status, 200);
  assert.deepEqual(await messageOnly.json(), {
    actions: [],
    message: 'The requested content flow completed.',
  });

  const actionOnly = await handleManageAi(resultRequest(), testDependencies(async () => ({
    status: 200,
    data: {
      actions: [{
        type: 'create_app',
        message: 'Created an App candidate for reconciliation.',
        timestamp: '2026-08-14T01:23:20.000Z',
        result: { document: { id: 'app-candidate' }, html: '<private-app-html />' },
      }],
    },
  })));
  assert.equal(actionOnly.status, 200);
  assert.deepEqual(await actionOnly.json(), {
    actions: [{
      type: 'create_app',
      message: 'Created an App candidate for reconciliation.',
      timestamp: '2026-08-14T01:23:20.000Z',
      documentId: 'app-candidate',
    }],
  });
});

test('AI Content Studio result projection preserves a safe narrative while quarantining malformed optional companions', async () => {
  const response = await handleManageAi(resultRequest(), testDependencies(async () => ({
    status: 200,
    data: {
      message: 'The requested App candidate completed.',
      resultSummary: { unsafe: API_KEY },
      topic: API_KEY.repeat(200),
      omniChatUrl: 'https://attacker.example/chat/conversation-a',
      actions: [
        {
          type: 'future_action_type',
          message: 'A future action remained safe to display.',
          timestamp: '2026-08-14T01:23:20.000Z',
        },
        null,
        { type: 'summarize', message: 'Missing timestamp.' },
        { type: 'summarize', message: 'Invalid timestamp.', timestamp: 'not-a-date' },
      ],
    },
  })));
  assert.equal(response.status, 200);
  const projected = await response.json();
  assert.deepEqual(projected, {
    actions: [{
      type: 'future_action_type',
      message: 'A future action remained safe to display.',
      timestamp: '2026-08-14T01:23:20.000Z',
    }],
    message: 'The requested App candidate completed.',
    projectionIssues: [
      'RESULT_SUMMARY_DROPPED',
      'ACTION_DROPPED',
      'ACTION_DROPPED_NOT_OBJECT',
      'ACTION_DROPPED_INVALID_TIMESTAMP',
      'TOPIC_DROPPED',
      'OMNI_CHAT_URL_DROPPED',
    ],
  });
  assert.doesNotMatch(JSON.stringify(projected), new RegExp(API_KEY));

  const malformedList = await handleManageAi(resultRequest(), testDependencies(async () => ({
    status: 200,
    data: {
      resultSummary: 'The stopped run remains safe to display.',
      actions: { unsafe: API_KEY },
    },
  })));
  assert.equal(malformedList.status, 200);
  assert.deepEqual(await malformedList.json(), {
    actions: [],
    resultSummary: 'The stopped run remains safe to display.',
    projectionIssues: ['ACTIONS_DROPPED'],
  });
});

test('AI Content Studio result projection preserves bounded empty-message actions from the live structural variant', async () => {
  const narrative = `## Verification stopped\n\n${'Evidence remained bounded. '.repeat(110)}`.trim();
  assert.equal(narrative.length > 2_000, true);
  const response = await handleManageAi(resultRequest(), testDependencies(async () => ({
    status: 200,
    data: {
      message: narrative,
      resultSummary: narrative,
      topic: 'example_topic',
      omniChatUrl: 'https://example.omniapp.co/chat/conversation-a',
      actions: [{
        type: 'inspect_model',
        message: 'Inspected the bounded model context.',
        timestamp: '2026-08-14T01:23:19.000Z',
      }, {
        type: 'search_model_files',
        message: '',
        timestamp: '2026-08-14T01:23:20.000Z',
      }, {
        type: 'generate_query',
        message: '',
        timestamp: '2026-08-14T01:23:21.000Z',
      }, {
        type: 'summarize',
        message: narrative,
        timestamp: '2026-08-14T01:23:22.000Z',
      }],
    },
  })));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    actions: [
      {
        type: 'inspect_model',
        message: 'Inspected the bounded model context.',
        timestamp: '2026-08-14T01:23:19.000Z',
      },
      {
        type: 'search_model_files',
        message: '',
        timestamp: '2026-08-14T01:23:20.000Z',
      },
      {
        type: 'generate_query',
        message: '',
        timestamp: '2026-08-14T01:23:21.000Z',
      },
    ],
    message: narrative,
    resultSummary: narrative,
    topic: 'example_topic',
    omniChatUrl: 'https://example.omniapp.co/chat/conversation-a',
  });
});

test('AI Content Studio result projection reports bounded drop reasons without exposing malformed action payloads', async () => {
  const response = await handleManageAi(resultRequest(), testDependencies(async () => ({
    status: 200,
    data: {
      message: 'The bounded report remains available for review.',
      actions: [
        { type: 'missing_message', timestamp: '2026-08-14T01:23:20.000Z' },
        { type: 'invalid_message_type', message: { unsafe: API_KEY }, timestamp: '2026-08-14T01:23:21.000Z' },
        { type: 'oversized_message', message: API_KEY.repeat(300), timestamp: '2026-08-14T01:23:22.000Z' },
        { type: API_KEY.repeat(20), message: 'The invalid type stays private.', timestamp: '2026-08-14T01:23:23.000Z' },
      ],
    },
  })));

  assert.equal(response.status, 200);
  const projected = await response.json();
  assert.deepEqual(projected, {
    actions: [],
    message: 'The bounded report remains available for review.',
    projectionIssues: [
      'ACTION_DROPPED',
      'ACTION_DROPPED_MISSING_MESSAGE',
      'ACTION_DROPPED_INVALID_MESSAGE_TYPE',
      'ACTION_DROPPED_OVERSIZED_MESSAGE',
      'ACTION_DROPPED_INVALID_TYPE',
    ],
  });
  assert.doesNotMatch(JSON.stringify(projected), new RegExp(API_KEY));
});

test('AI Content Studio result projection caps excess actions without discarding valid bounded evidence', async () => {
  const actions = Array.from({ length: 101 }, (_, index) => ({
    type: index === 0 ? 'unknown_but_valid' : 'generate_query',
    message: `Bounded action ${index + 1}.`,
    timestamp: '2026-08-14T01:23:20.000Z',
  }));
  const response = await handleManageAi(resultRequest(), testDependencies(async () => ({
    status: 200,
    data: { actions },
  })));

  assert.equal(response.status, 200);
  const projected = await response.json() as OmniAiContentStudioJobResult;
  assert.equal(projected.actions?.length, 100);
  assert.equal(projected.actions?.[0]?.type, 'unknown_but_valid');
  assert.deepEqual(projected.projectionIssues, ['ACTIONS_TRUNCATED']);
});

test('AI Content Studio result projection fails closed with a distinct code when no usable evidence remains', async () => {
  const unusableResults: unknown[] = [
    {},
    { actions: [] },
    { message: null, resultSummary: null, actions: null, topic: null, omniChatUrl: null },
    { actions: 'not-an-array' },
    { actions: [{ type: 'summarize', timestamp: '2026-08-14T01:23:20.000Z' }] },
  ];

  for (const data of unusableResults) {
    const response = await handleManageAi(resultRequest(), testDependencies(async () => ({ status: 200, data })));
    assert.equal(response.status, 422);
    const body = await response.json() as { error: string; code: string; projectionIssues?: string[] };
    assert.match(body.error, /without a usable narrative or valid action evidence/i);
    assert.equal(body.code, OMNI_AI_CONTENT_STUDIO_COMPLETE_NO_USABLE_RESULT_CODE);
    assert.doesNotMatch(body.error, /documented AI response contract/i);
    if (body.projectionIssues) {
      assert.equal(body.projectionIssues.every((issue) => /^[A-Z_]+$/.test(issue)), true);
    }
  }
});

test('AI Content Studio lifecycle projections expose only documented create, status, and cancel fields', async () => {
  const create = await handleManageAi(contentStudioLifecycleRequest('create-job'), testDependencies(async () => ({
    status: 201,
    data: {
      jobId: JOB_ID,
      conversationId: CONVERSATION_ID,
      omniChatUrl: `https://example.omni.co/chat/${CONVERSATION_ID}?secret=discard#fragment`,
      prompt: 'must remain server-side',
      modelId: 'model-a',
      apiKey: API_KEY,
    },
  })));
  assert.equal(create.status, 201);
  assert.deepEqual(await create.json(), {
    jobId: JOB_ID,
    conversationId: CONVERSATION_ID,
    omniChatUrl: `https://example.omni.co/chat/${CONVERSATION_ID}`,
  });

  const status = await handleManageAi(contentStudioLifecycleRequest('get-job'), testDependencies(async () => ({
    status: 200,
    data: {
      id: JOB_ID,
      state: 'EXECUTING',
      conversationId: CONVERSATION_ID,
      omniChatUrl: `https://example.omniapp.co/chat/${CONVERSATION_ID}?secret=discard`,
      prompt: 'must remain server-side',
      resultSummary: 'may contain governed result values',
      progress: { message: 'internal progress' },
      userId: '770e8400-e29b-41d4-a716-446655440002',
    },
  })));
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), {
    id: JOB_ID,
    state: 'EXECUTING',
    conversationId: CONVERSATION_ID,
    omniChatUrl: `https://example.omniapp.co/chat/${CONVERSATION_ID}`,
  });

  const cancel = await handleManageAi(contentStudioLifecycleRequest('cancel-job'), testDependencies(async () => ({
    status: 200,
    data: {
      jobId: JOB_ID,
      state: 'CANCELLED',
      prompt: 'must remain server-side',
      resultSummary: 'must remain server-side',
    },
  })));
  assert.equal(cancel.status, 200);
  assert.deepEqual(await cancel.json(), { jobId: JOB_ID, state: 'CANCELLED' });
});

test('AI Content Studio lifecycle projections reject malformed successful upstream contracts', async () => {
  const cases: Array<{
    action: 'create-job' | 'get-job' | 'cancel-job';
    data: unknown;
  }> = [
    {
      action: 'create-job',
      data: { jobId: JOB_ID, conversationId: CONVERSATION_ID },
    },
    {
      action: 'create-job',
      data: {
        jobId: 'not-a-uuid',
        conversationId: CONVERSATION_ID,
        omniChatUrl: `https://example.omni.co/chat/${CONVERSATION_ID}`,
      },
    },
    {
      action: 'get-job',
      data: { id: JOB_ID, state: 'UNKNOWN' },
    },
    {
      action: 'get-job',
      data: { id: JOB_ID, state: 'QUEUED', omniChatUrl: 'https://attacker.example/chat/1' },
    },
    {
      action: 'cancel-job',
      data: { jobId: JOB_ID, state: 'UNKNOWN' },
    },
    {
      action: 'cancel-job',
      data: { jobId: JOB_ID, state: 'COMPLETE' },
    },
  ];

  for (const fixture of cases) {
    const response = await handleManageAi(
      contentStudioLifecycleRequest(fixture.action),
      testDependencies(async () => ({ status: fixture.action === 'create-job' ? 201 : 200, data: fixture.data })),
    );
    assert.equal(response.status, 502, `${fixture.action} should fail closed`);
    assert.match((await response.json() as { error: string }).error, /invalid or oversized JSON response/);
  }
});

test('AI Content Studio completes a live-shaped review result without a reconciliation hold', async () => {
  const narrative = liveReviewNarrative();
  let creates = 0;
  let polls = 0;
  let resultReads = 0;
  const outcome = await runAIContentJob({
    baseUrl: 'https://example.omniapp.co',
    apiKey: API_KEY,
    modelId: MODEL_ID,
    prompt: 'Review the selected dashboard without making changes.',
    attachments: [],
    mode: 'review',
    signal: new AbortController().signal,
    pollIntervalMs: 0,
    transport: {
      createJob: async () => {
        creates += 1;
        return {
          jobId: JOB_ID,
          conversationId: CONVERSATION_ID,
          omniChatUrl: `https://example.omniapp.co/chat/${CONVERSATION_ID}`,
        };
      },
      getJob: async () => {
        polls += 1;
        return {
          id: JOB_ID,
          state: 'COMPLETE',
          conversationId: CONVERSATION_ID,
          omniChatUrl: `https://example.omniapp.co/chat/${CONVERSATION_ID}`,
        };
      },
      getResult: async () => {
        resultReads += 1;
        return {
          actions: [],
          message: narrative,
          resultSummary: narrative,
          omniChatUrl: `https://example.omniapp.co/chat/${CONVERSATION_ID}`,
        };
      },
      cancelJob: async () => ({ jobId: JOB_ID, state: 'CANCELLED' }),
    },
  });

  assert.equal(creates, 1);
  assert.equal(polls, 1);
  assert.equal(resultReads, 1);
  assert.equal(outcome.state, 'COMPLETE');
  assert.equal(outcome.message, narrative);
  assert.deepEqual(outcome.actionSummaries, []);
  assert.deepEqual(outcome.actionReviewIssues, []);
  assert.equal(outcome.chatUrl, `https://example.omniapp.co/chat/${CONVERSATION_ID}`);
});

test('AI Content Studio lifecycle maps a deterministic result mismatch without repeated result reads', async () => {
  let resultReads = 0;
  const transport: AIContentJobTransport = {
    createJob: async () => ({
      jobId: JOB_ID,
      state: 'COMPLETE',
      conversationId: CONVERSATION_ID,
      omniChatUrl: `https://example.omniapp.co/chat/${CONVERSATION_ID}`,
    }),
    getJob: async () => ({ id: JOB_ID, state: 'COMPLETE' }),
    getResult: async () => {
      resultReads += 1;
      throw new ApiError(
        422,
        'Omni completed the job, but its result did not match the documented AI response contract.',
        undefined,
        AI_CONTENT_RESULT_CONTRACT_MISMATCH_CODE,
      );
    },
    cancelJob: async () => ({ jobId: JOB_ID, state: 'CANCELLED' }),
  };

  await assert.rejects(() => runAIContentJob({
    baseUrl: 'https://example.omniapp.co',
    apiKey: API_KEY,
    modelId: MODEL_ID,
    prompt: 'Create the approved App candidate.',
    attachments: [],
    mode: 'app',
    signal: new AbortController().signal,
    pollIntervalMs: 0,
    transport,
  }), (error: unknown) => {
    assert.ok(error instanceof AIContentResultContractMismatchError, JSON.stringify({
      constructor: (error as { constructor?: { name?: string } })?.constructor?.name,
      name: (error as { name?: string })?.name,
      status: (error as { status?: number })?.status,
      code: (error as { code?: string })?.code,
      message: (error as { message?: string })?.message,
    }));
    assert.equal(error.jobId, JOB_ID);
    assert.equal(error.chatUrl, `https://example.omniapp.co/chat/${CONVERSATION_ID}`);
    assert.equal(error.code, AI_CONTENT_RESULT_CONTRACT_MISMATCH_CODE);
    return true;
  });
  assert.equal(resultReads, 1);
});

test('completed-job recovery performs one result-only transport operation and never requires lifecycle mutations', async () => {
  let resultReads = 0;
  const outcome = await recoverCompletedAIContentJob({
    baseUrl: 'https://example.omniapp.co',
    apiKey: API_KEY,
    jobId: JOB_ID,
    mode: 'app',
    signal: new AbortController().signal,
    conversationId: CONVERSATION_ID,
    chatUrl: `https://example.omniapp.co/chat/${CONVERSATION_ID}?discard=1`,
    transport: {
      getResult: async () => {
        resultReads += 1;
        return {
          resultSummary: 'The App candidate completed and still requires authoritative reconciliation.',
          actions: [{
            type: 'create_app',
            message: 'Created one App candidate.',
            timestamp: '2026-08-14T01:23:20.000Z',
            documentId: 'app-candidate',
          }],
        };
      },
    },
  });

  assert.equal(resultReads, 1);
  assert.equal(outcome.jobId, JOB_ID);
  assert.equal(outcome.state, 'COMPLETE');
  assert.equal(outcome.message, 'The App candidate completed and still requires authoritative reconciliation.');
  assert.equal(outcome.chatUrl, `https://example.omniapp.co/chat/${CONVERSATION_ID}`);
  assert.deepEqual(outcome.documentReferences, [{
    documentId: 'app-candidate',
    actionType: 'create_app',
    summary: 'Created one App candidate.',
  }]);
  assert.deepEqual(outcome.actionReviewIssues, []);
});

test('completed-job recovery preserves identity when local result validation fails', async () => {
  let resultReads = 0;
  await assert.rejects(() => recoverCompletedAIContentJob({
    baseUrl: 'https://example.omniapp.co',
    apiKey: API_KEY,
    jobId: JOB_ID,
    mode: 'app',
    signal: new AbortController().signal,
    chatUrl: `https://example.omniapp.co/chat/${CONVERSATION_ID}?discard=1`,
    transport: {
      getResult: async () => {
        resultReads += 1;
        return {
          message: 'undefined',
          actions: [{
            type: 'create_app',
            message: 'Created one App candidate.',
            timestamp: '2026-08-14T01:23:20.000Z',
            documentId: 'app-candidate',
          }],
        };
      },
    },
  }), (error: unknown) => {
    assert.ok(error instanceof AIContentCompletedResultValidationError);
    assert.equal(error.jobId, JOB_ID);
    assert.equal(error.chatUrl, `https://example.omniapp.co/chat/${CONVERSATION_ID}`);
    assert.match(error.message, /incomplete final message/i);
    return true;
  });
  assert.equal(resultReads, 1);
});

test('completed-job recovery preserves deterministic contract mismatch identity after one result-only transport operation', async () => {
  let resultReads = 0;
  await assert.rejects(() => recoverCompletedAIContentJob({
    baseUrl: 'https://example.omniapp.co',
    apiKey: API_KEY,
    jobId: JOB_ID,
    mode: 'app',
    signal: new AbortController().signal,
    chatUrl: `https://example.omniapp.co/chat/${CONVERSATION_ID}`,
    transport: {
      getResult: async () => {
        resultReads += 1;
        throw new ApiError(
          422,
          'Result contract mismatch.',
          undefined,
          AI_CONTENT_RESULT_CONTRACT_MISMATCH_CODE,
        );
      },
    },
  }), (error: unknown) => {
    assert.ok(error instanceof AIContentResultContractMismatchError, JSON.stringify({
      constructor: (error as { constructor?: { name?: string } })?.constructor?.name,
      name: (error as { name?: string })?.name,
      status: (error as { status?: number })?.status,
      code: (error as { code?: string })?.code,
      message: (error as { message?: string })?.message,
    }));
    assert.equal(error.jobId, JOB_ID);
    assert.equal(error.chatUrl, `https://example.omniapp.co/chat/${CONVERSATION_ID}`);
    return true;
  });
  assert.equal(resultReads, 1);
});

test('AI Content Studio verifies an exact dashboard through documented authoritative rereads', async () => {
  const calls: Array<{ method: string; url: string; maximumResponseBytes?: number }> = [];
  const response = await handleManageAi(
    contentDocumentRequest('verify-content-document'),
    testDependencies(async (request) => {
      calls.push({
        method: request.method,
        url: request.url,
        maximumResponseBytes: request.maximumResponseBytes,
      });
      const url = new URL(request.url);
      if (url.pathname === '/api/v2/documents/created-dashboard') {
        return {
          status: 200,
          data: {
            name: 'Created dashboard',
            modelId: MODEL_ID,
            queryPresentations: {
              data: {
                '1': {
                  type: 'query',
                  name: 'Private presentation name',
                  query: { fields: ['must-not-reach-browser'] },
                },
              },
              order: ['1'],
            },
            containers: [{ type: 'grid', privateLayout: 'must-not-reach-browser' }],
            description: 'not projected',
          },
        };
      }
      if (url.pathname === '/api/v1/documents/created-dashboard/queries') {
        return {
          status: 200,
          data: {
            queries: [{
              id: '880e8400-e29b-41d4-a716-446655440003',
              name: 'Governed metric',
              url: 'https://example.omniapp.co/w/created-dashboard?key=1',
              query: { modelId: MODEL_ID, fields: ['example.metric'] },
            }],
          },
        };
      }
      if (url.pathname === '/api/v1/dashboards/created-dashboard/filters') {
        return {
          status: 200,
          data: {
            identifier: 'created-dashboard',
            filters: { 'example.date': { type: 'date' } },
            controls: [{ id: 'metric-selector', type: 'FIELD_SELECTION' }],
            filterOrder: ['example.date', 'metric-selector'],
          },
        };
      }
      if (url.pathname === '/api/v1/documents/created-dashboard/access-list') {
        if (!url.searchParams.has('cursor')) {
          return {
            status: 200,
            data: {
              principals: [
                {
                  id: 'user-one',
                  name: 'Private owner name',
                  email: 'owner@example.com',
                  accessSource: 'direct',
                  isOwner: true,
                },
                {
                  id: 'group-one',
                  name: 'Private group name',
                  accessSource: 'folder',
                  isOwner: false,
                },
              ],
              pageInfo: {
                hasNextPage: true,
                nextCursor: 'next-access-page',
                pageSize: 100,
                totalRecords: 3,
              },
            },
          };
        }
        assert.equal(url.searchParams.get('cursor'), 'next-access-page');
        return {
          status: 200,
          data: {
            principals: [{
              id: 'user-two',
              name: 'Private viewer name',
              email: 'viewer@example.com',
              accessSource: 'direct',
              isOwner: false,
            }],
            pageInfo: {
              hasNextPage: false,
              pageSize: 100,
              totalRecords: 3,
            },
          },
        };
      }
      assert.equal(
        url.pathname,
        `/api/v1/models/${MODEL_ID}/content-validator`,
      );
      assert.equal(url.searchParams.get('include_personal_folders'), 'true');
      return {
        status: 200,
        data: {
          model_id: MODEL_ID,
          branch: null,
          content: [{
            document_id: '990e8400-e29b-41d4-a716-446655440004',
            identifier: 'created-dashboard',
            name: 'Created dashboard',
            queries_and_issues: [{
              query_name: 'Governed metric',
              issues: ['Field example.old_metric was not found.'],
            }],
            dashboard_filter_issues: ['Filter example.old_date was not found.'],
            owner: { email: 'must-not-reach-browser@example.com' },
          }],
        },
      };
    }),
  );

  assert.equal(response.status, 200);
  const verified = await response.json() as Record<string, unknown>;
  const verifiedAt = String(verified.verifiedAt || '');
  assert.ok(Number.isFinite(Date.parse(verifiedAt)));
  assert.deepEqual({ ...verified, verifiedAt: '<timestamp>' }, {
    identifier: 'created-dashboard',
    name: 'Created dashboard',
    modelId: MODEL_ID,
    queryCount: 1,
    queries: [{
      id: '880e8400-e29b-41d4-a716-446655440003',
      name: 'Governed metric',
      modelIds: [MODEL_ID],
    }],
    queryPresentationCount: 1,
    queryPresentationTypes: [{ type: 'query', count: 1 }],
    layoutContainerCount: 1,
    filterCount: 1,
    controlCount: 1,
    accessGrantCount: 3,
    directAccessGrantCount: 2,
    inheritedAccessGrantCount: 1,
    ownerGrantCount: 1,
    accessListComplete: true,
    contentValidationIssues: [
      'Field example.old_metric was not found.',
      'Filter example.old_date was not found.',
    ],
    verifiedAt: '<timestamp>',
  });
  assert.deepEqual(calls.map((call) => call.method), ['GET', 'GET', 'GET', 'GET', 'GET', 'GET']);
  assert.equal(calls.at(-1)?.maximumResponseBytes, 16 * 1024 * 1024);
  assert.doesNotMatch(
    JSON.stringify(verified),
    /Private presentation|privateLayout|description|owner@example|viewer@example|Private owner|Private group|Private viewer|must-not-reach-browser/,
  );
});

test('AI Content Studio dashboard verification rejects workbook-only and malformed presentation state', async () => {
  const invalidStates = [
    {
      name: 'Created dashboard',
      modelId: MODEL_ID,
      queryPresentations: { data: { '1': { type: 'query' } }, order: ['1'] },
      // Documents V2 omits containers for workbook-only documents.
    },
    {
      name: 'Created dashboard',
      modelId: MODEL_ID,
      queryPresentations: { data: { '1': { type: 'invented' } }, order: ['1'] },
      containers: [{ type: 'grid' }],
    },
    {
      name: 'Created dashboard',
      modelId: MODEL_ID,
      queryPresentations: { data: { '1': { type: 'query' } }, order: ['2'] },
      containers: [{ type: 'grid' }],
    },
  ];

  for (const state of invalidStates) {
    let calls = 0;
    const response = await handleManageAi(
      contentDocumentRequest('verify-content-document'),
      testDependencies(async () => {
        calls += 1;
        return { status: 200, data: state };
      }),
    );
    assert.equal(response.status, 502);
    assert.equal(calls, 1, 'invalid Documents V2 state must fail before supplemental reads');
  }
});

test('AI Content Studio document verification fails closed without an exact content-validator match', async () => {
  const response = await handleManageAi(
    contentDocumentRequest('verify-content-document'),
    testDependencies(async (request) => {
      const url = new URL(request.url);
      if (url.pathname === '/api/v2/documents/created-dashboard') {
        return { status: 200, data: validDashboardState() };
      }
      if (url.pathname.endsWith('/queries')) return { status: 200, data: { queries: [] } };
      if (url.pathname.endsWith('/filters')) {
        return {
          status: 200,
          data: { identifier: 'created-dashboard', filters: {}, controls: [], filterOrder: [] },
        };
      }
      if (url.pathname.endsWith('/access-list')) {
        return {
          status: 200,
          data: {
            principals: [],
            pageInfo: { hasNextPage: false, pageSize: 100, totalRecords: 0 },
          },
        };
      }
      return {
        status: 200,
        data: {
          model_id: MODEL_ID,
          content: [{
            identifier: 'different-dashboard',
            queries_and_issues: [],
            dashboard_filter_issues: [],
          }],
        },
      };
    }),
  );
  assert.equal(response.status, 502);
  assert.match((await response.json() as { error: string }).error, /invalid or oversized JSON response/);
});

test('AI Content Studio document verification fails closed on incomplete access pagination', async () => {
  let accessCalls = 0;
  const response = await handleManageAi(
    contentDocumentRequest('verify-content-document'),
    testDependencies(async (request) => {
      const url = new URL(request.url);
      if (url.pathname === '/api/v2/documents/created-dashboard') {
        return { status: 200, data: validDashboardState() };
      }
      if (url.pathname.endsWith('/queries')) return { status: 200, data: { queries: [] } };
      if (url.pathname.endsWith('/filters')) {
        return {
          status: 200,
          data: { identifier: 'created-dashboard', filters: {}, controls: [], filterOrder: [] },
        };
      }
      assert.match(url.pathname, /\/access-list$/);
      accessCalls += 1;
      return {
        status: 200,
        data: {
          principals: [{ accessSource: 'direct', isOwner: false }],
          pageInfo: {
            hasNextPage: true,
            nextCursor: 'repeated-cursor',
            pageSize: 100,
            totalRecords: 3,
          },
        },
      };
    }),
  );
  assert.equal(response.status, 502);
  assert.equal(accessCalls, 2);
  assert.match((await response.json() as { error: string }).error, /invalid or oversized JSON response/);
});

test('AI Content Studio trashes only an explicit known identifier and projects the recoverable result', async () => {
  let target: { method?: string; url?: string } = {};
  const response = await handleManageAi(
    contentDocumentRequest('trash-content-document'),
    testDependencies(async (request) => {
      target = request;
      return { status: 200, data: { success: true, internal: 'not projected' } };
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(target.method, 'DELETE');
  assert.equal(target.url, 'https://example.omniapp.co/api/v1/documents/created-dashboard');
  const trashed = await response.json() as Record<string, unknown>;
  assert.ok(Number.isFinite(Date.parse(String(trashed.trashedAt || ''))));
  assert.deepEqual({ ...trashed, trashedAt: '<timestamp>' }, {
    identifier: 'created-dashboard',
    trashed: true,
    trashedAt: '<timestamp>',
  });

  let calls = 0;
  const invalid = await handleManageAi(
    contentDocumentRequest('trash-content-document', '../another-document'),
    testDependencies(async () => {
      calls += 1;
      return { status: 200, data: { success: true } };
    }),
  );
  assert.equal(invalid.status, 400);
  assert.equal(calls, 0);
});

test('generic AI lifecycle consumers retain their existing unprojected response contract', async () => {
  const response = await handleManageAi(new Request('http://127.0.0.1/api/manage-ai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base_url: 'https://example.omniapp.co',
      api_key: API_KEY,
      action: 'cancel-job',
      job_id: JOB_ID,
    }),
  }), testDependencies(async () => ({
    status: 200,
    data: { jobId: JOB_ID, state: 'COMPLETE', retainedForGenericConsumer: true },
  })));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    jobId: JOB_ID,
    state: 'COMPLETE',
    retainedForGenericConsumer: true,
  });
});

test('AI proxy requires an origin-only Omni base URL before any outbound request', async () => {
  let calls = 0;
  const dependencies = testDependencies(async () => {
    calls += 1;
    return { status: 200, data: { state: 'COMPLETE' } };
  });
  const invalidBaseUrls = [
    'https://example.omniapp.co/api',
    'https://example.omniapp.co/api/..',
    'https://example.omniapp.co/tenant/path',
    'https://example.omniapp.co?source=unsafe',
    'https://example.omniapp.co#fragment',
    'https://user:password@example.omniapp.co',
  ];

  for (const baseUrl of invalidBaseUrls) {
    const response = await handleManageAi(resultRequest(baseUrl), dependencies);
    assert.equal(response.status, 400);
    assert.match((await response.json() as { error: string }).error, /base_url|tenant origin|credentials/i);
  }
  assert.equal(calls, 0);

  let targetUrl = '';
  const accepted = await handleManageAi(resultRequest('https://example.omniapp.co/'), testDependencies(async (request) => {
    targetUrl = request.url;
    return {
      status: 200,
      data: {
        message: 'A valid projected result.',
        actions: [],
      },
    };
  }));
  assert.equal(accepted.status, 200);
  assert.equal(targetUrl, 'https://example.omniapp.co/api/v1/ai/jobs/job-a/result');
});

test('AI proxy applies image and attachment-count limits while allowing PDFs to use the combined budget', async () => {
  let calls = 0;
  const dependencies = testDependencies(async () => {
    calls += 1;
    return { status: 200, data: { jobId: 'should-not-run' } };
  });
  const oversizedPng = Buffer.concat([
    PNG_BYTES.subarray(0, 8),
    Buffer.alloc(3 * 1024 * 1024 - 7),
  ]).toString('base64');
  const oversized = await handleManageAi(createJobRequest([{
    data: oversizedPng,
    mimeType: 'image/png',
  }]), dependencies);
  assert.equal(oversized.status, 413);
  assert.match((await oversized.json() as { error: string }).error, /Image attachment.*3 MiB/);

  const tooMany = await handleManageAi(createJobRequest(Array.from({ length: 6 }, (_, index) => ({
    data: PNG_BASE64,
    mimeType: 'image/png',
    name: `${index}.png`,
  }))), dependencies);
  assert.equal(tooMany.status, 413);
  assert.match((await tooMany.json() as { error: string }).error, /maximum of 5/);

  const largerPdf = Buffer.concat([
    Buffer.from('%PDF-1.7\n'),
    Buffer.alloc(3 * 1024 * 1024),
  ]).toString('base64');
  const acceptedPdf = await handleManageAi(createJobRequest([{
    data: largerPdf,
    mimeType: 'application/pdf',
    name: 'requirements.pdf',
  }]), dependencies);
  assert.equal(acceptedPdf.status, 200);
  assert.equal(calls, 1);
});

test('AI client forwards AbortSignal for create, poll, generic result, projected result, and cancel requests', async (t) => {
  const signals: Array<AbortSignal | null | undefined> = [];
  const actions: string[] = [];
  const responseContracts: Array<string | undefined> = [];
  t.mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
    signals.push(init?.signal);
    const parsed = JSON.parse(String(init?.body || '{}')) as { action?: string; response_contract?: string };
    actions.push(parsed.action || '');
    responseContracts.push(parsed.response_contract);
    return new Response(JSON.stringify({ jobId: 'job-a', state: 'COMPLETE' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  const controller = new AbortController();

  await createAiJob('https://example.omniapp.co', API_KEY, {
    modelId: 'model-a',
    prompt: 'Build a report.',
    attachments: [{ data: PNG_BASE64, mimeType: 'image/png', name: 'reference.png' }],
  }, controller.signal);
  await createAiContentStudioJob('https://example.omniapp.co', API_KEY, {
    modelId: 'model-a',
    prompt: 'Build a report.',
  }, controller.signal);
  await getAiJob('https://example.omniapp.co', API_KEY, 'job-a', controller.signal);
  await getAiContentStudioJob('https://example.omniapp.co', API_KEY, 'job-a', controller.signal);
  await getAiJobResult('https://example.omniapp.co', API_KEY, 'job-a', controller.signal);
  await getAiContentStudioJobResult('https://example.omniapp.co', API_KEY, 'job-a', controller.signal);
  await cancelAiJob('https://example.omniapp.co', API_KEY, 'job-a', controller.signal);
  await cancelAiContentStudioJob('https://example.omniapp.co', API_KEY, 'job-a', controller.signal);
  await verifyAiContentDocument('https://example.omniapp.co', API_KEY, 'created-dashboard', controller.signal);
  await trashAiContentDocument('https://example.omniapp.co', API_KEY, 'created-dashboard', controller.signal);

  assert.deepEqual(actions, [
    'create-job',
    'create-job',
    'get-job',
    'get-job',
    'get-job-result',
    'get-content-studio-job-result',
    'cancel-job',
    'cancel-job',
    'verify-content-document',
    'trash-content-document',
  ]);
  assert.deepEqual(responseContracts, [
    undefined,
    'ai-content-studio-v1',
    undefined,
    'ai-content-studio-v1',
    undefined,
    undefined,
    undefined,
    'ai-content-studio-v1',
    undefined,
    undefined,
  ]);
  assert.equal(signals.length, 10);
  signals.forEach((signal) => assert.equal(signal, controller.signal));
});

test('AI client preserves a bounded server error code for deterministic result-contract handling', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return new Response(JSON.stringify({
      error: 'Omni completed the job, but its result did not match the documented AI response contract.',
      code: AI_CONTENT_RESULT_CONTRACT_MISMATCH_CODE,
    }), {
      status: 422,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  await assert.rejects(
    getAiContentStudioJobResult(
      'https://example.omniapp.co',
      API_KEY,
      JOB_ID,
      new AbortController().signal,
    ),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 422);
      assert.equal(error.code, AI_CONTENT_RESULT_CONTRACT_MISMATCH_CODE);
      assert.doesNotMatch(error.detail || '', new RegExp(API_KEY));
      return true;
    },
  );
  assert.equal(calls, 1);
});

test('AI client preserves AbortError cancellation semantics', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new DOMException('cancelled', 'AbortError');
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    createAiJob('https://example.omniapp.co', API_KEY, {
      modelId: 'model-a',
      prompt: 'Build a report.',
    }, controller.signal),
    (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
  );
});

test('AI Content Studio model and topic inventory requests preserve caller cancellation', async (t) => {
  const signals: Array<AbortSignal | null | undefined> = [];
  t.mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
    signals.push(init?.signal);
    return await new Promise<Response>((_resolve, reject) => {
      const onAbort = () => reject(new DOMException('cancelled', 'AbortError'));
      if (init?.signal?.aborted) onAbort();
      else init?.signal?.addEventListener('abort', onAbort, { once: true });
    });
  });
  const controller = new AbortController();
  const modelRequest = listModels('https://inventory-cancel.example.omniapp.co', API_KEY, {
    modelKind: 'SHARED',
    allPages: true,
    pageSize: 100,
    signal: controller.signal,
  });
  const topicRequest = listTopics(
    'https://inventory-cancel.example.omniapp.co',
    API_KEY,
    'model-cancel-test',
    { signal: controller.signal },
  );

  while (signals.length < 2) await new Promise<void>((resolve) => setImmediate(resolve));
  signals.forEach((signal) => assert.equal(signal, controller.signal));
  controller.abort();
  await Promise.all([
    assert.rejects(modelRequest, (error: unknown) => error instanceof DOMException && error.name === 'AbortError'),
    assert.rejects(topicRequest, (error: unknown) => error instanceof DOMException && error.name === 'AbortError'),
  ]);
});

test('AI Content Studio resolves connection labels from the documented connection catalog by immutable ID', async (t) => {
  let requestBody: Record<string, unknown> | undefined;
  t.mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
    return new Response(JSON.stringify({
      connections: [
        { id: 'connection-a', name: 'Primary warehouse' },
        { id: 'connection-b', name: 'Analytics replica' },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  const response = await listConnections(
    'https://connection-labels.example.omniapp.co',
    API_KEY,
    { forceRefresh: true, signal: new AbortController().signal },
  );
  const models = applyStudioConnectionNames(
    [
      { id: 'model-a', kind: 'SHARED', connectionId: 'connection-a' },
      { id: 'model-b', kind: 'SHARED', connectionId: 'connection-b', connectionName: 'Unverified model label' },
      { id: 'model-c', kind: 'SHARED', connectionId: 'connection-c', connectionName: 'Stale model label' },
    ],
    parseStudioConnectionNamesResponse(response),
  );

  assert.equal(requestBody?.method, 'GET');
  assert.equal(requestBody?.endpoint, '/v1/connections');
  assert.equal(requestBody?.api_key, API_KEY);
  assert.deepEqual(models.map((model) => ({
    connectionId: model.connectionId,
    connectionName: model.connectionName,
  })), [
    { connectionId: 'connection-a', connectionName: 'Primary warehouse' },
    { connectionId: 'connection-b', connectionName: 'Analytics replica' },
    { connectionId: 'connection-c', connectionName: undefined },
  ]);
});

test('model and topic handlers forward disconnected callers to bounded upstream requests', async (t) => {
  const upstreamSignals: AbortSignal[] = [];
  t.mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
    assert.ok(init?.signal);
    upstreamSignals.push(init.signal);
    return await new Promise<Response>((_resolve, reject) => {
      const onAbort = () => reject(new DOMException('cancelled', 'AbortError'));
      if (init.signal?.aborted) onAbort();
      else init.signal?.addEventListener('abort', onAbort, { once: true });
    });
  });

  async function exercise(
    handler: (request: Request) => Promise<Response>,
    body: Record<string, unknown>,
  ) {
    const controller = new AbortController();
    const response = handler(new Request('http://127.0.0.1/api/inventory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    }));
    while (upstreamSignals.length === 0 || upstreamSignals.at(-1)?.aborted) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const upstreamSignal = upstreamSignals.at(-1)!;
    controller.abort();
    await response;
    assert.equal(upstreamSignal.aborted, true);
  }

  await exercise(
    (request) => listModelsHandler(request, {
      fetch: globalThis.fetch,
      validateOutbound: async () => undefined,
    }), {
    base_url: 'https://handler-cancel.example.omniapp.co',
    api_key: API_KEY,
    model_kind: 'SHARED',
    all_pages: true,
    page_size: 100,
  });
  const priorCount = upstreamSignals.length;
  await exercise(manageTopicsHandler, {
    base_url: 'https://handler-cancel.example.omniapp.co',
    api_key: API_KEY,
    action: 'list',
    model_id: 'model-cancel-test',
  });
  assert.equal(upstreamSignals.length, priorCount + 1);
});

test('AI client enforces the 15 MiB combined prompt and decoded attachment budget', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return new Response(JSON.stringify({ jobId: 'should-not-run' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
  const exactBudgetPdf = Buffer.concat([
    Buffer.from('%PDF-1.7\n'),
    Buffer.alloc(15 * 1024 * 1024 - Buffer.byteLength('%PDF-1.7\n')),
  ]).toString('base64');
  await assert.rejects(
    createAiJob('https://example.omniapp.co', API_KEY, {
      modelId: 'model-a',
      prompt: 'x',
      attachments: [{ data: exactBudgetPdf, mimeType: 'application/pdf', name: 'requirements.pdf' }],
    }),
    (error: unknown) => (
      error instanceof Error
      && 'status' in error
      && (error as { status: number }).status === 413
      && /combined request limit/.test(error.message)
    ),
  );
  assert.equal(calls, 0);
});

test('AI connection-bound DNS lookup rejects a private address after preflight validation', async () => {
  const resolver = ((_hostname: string, _options: unknown, callback: (error: Error | null, records: unknown[]) => void) => {
    callback(null, [{ address: '10.20.30.40', family: 4 }]);
  }) as unknown as typeof import('node:dns').lookup;
  const lookup = createAiPublicOnlyLookup(resolver);
  const error = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
    (lookup as unknown as (
      hostname: string,
      options: { all: boolean },
      callback: (error: NodeJS.ErrnoException | null) => void,
    ) => void)('example.omniapp.co', { all: false }, (lookupError) => resolve(lookupError));
  });
  assert.equal(error?.code, 'EACCES');
  assert.match(error?.message || '', /local or private network address/);
});

test('AI proxy propagates request cancellation and enforces its upstream deadline', async () => {
  const cancelled = new AbortController();
  const cancelledRequest = new Request('http://127.0.0.1/api/manage-ai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base_url: 'https://example.omniapp.co',
      api_key: API_KEY,
      action: 'get-job',
      job_id: 'job-a',
    }),
    signal: cancelled.signal,
  });
  const waitForAbort: NonNullable<ManageAiDependencies['request']> = async ({ signal }) => (
    new Promise((_resolve, reject) => {
      const onAbort = () => reject(new DOMException('cancelled', 'AbortError'));
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    })
  );
  const cancelledResponsePromise = handleManageAi(cancelledRequest, {
    validateOutbound: async () => undefined,
    request: waitForAbort,
  });
  cancelled.abort();
  const cancelledResponse = await cancelledResponsePromise;
  assert.equal(cancelledResponse.status, 499);

  const timeoutResponse = await handleManageAi(new Request('http://127.0.0.1/api/manage-ai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base_url: 'https://example.omniapp.co',
      api_key: API_KEY,
      action: 'get-job',
      job_id: 'job-a',
    }),
  }), {
    validateOutbound: async () => undefined,
    request: waitForAbort,
    timeoutMs: 5,
  });
  assert.equal(timeoutResponse.status, 504);
  assert.match((await timeoutResponse.json() as { error: string }).error, /timed out/);
});

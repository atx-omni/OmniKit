import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import {
  handleManageAi,
  readBoundedJson,
  type ManageAiDependencies,
} from '../server/handlers/manage-ai';
import {
  AI_CONTENT_RESULT_CONTRACT_MISMATCH_CODE,
  AIContentResultContractMismatchError,
  recoverCompletedAIContentJob,
  runAIContentJob,
  type AIContentJobTransport,
} from '../src/services/aiContentStudio/jobRunner';
import type { AIContentAgentMode } from '../src/services/aiContentStudio/types';
import { ApiError } from '../src/services/omniApi';

const API_KEY = 'matrix-vault-key';
const BASE_URL = 'https://matrix.example.omniapp.co';
const MEBIBYTE = 1024 * 1024;

type AiProxyAction =
  | 'pick-topic'
  | 'create-job'
  | 'get-job'
  | 'get-job-result'
  | 'get-content-studio-job-result'
  | 'cancel-job';

function proxyRequest(action: AiProxyAction): Request {
  const body: Record<string, unknown> = {
    base_url: BASE_URL,
    api_key: API_KEY,
    action,
  };
  if (action === 'pick-topic' || action === 'create-job') {
    body.model_id = 'matrix-model';
    body.prompt = 'Use only the selected governed scope.';
  }
  if (action !== 'pick-topic' && action !== 'create-job') body.job_id = 'matrix-job';
  return new Request('http://127.0.0.1/api/manage-ai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function incomingStream(
  contentType: string,
  body: string,
  declaredLength?: number,
): IncomingMessage {
  const stream = new PassThrough();
  Object.assign(stream, {
    headers: {
      'content-type': contentType,
      ...(declaredLength === undefined ? {} : { 'content-length': String(declaredLength) }),
    },
  });
  stream.end(body);
  return stream as unknown as IncomingMessage;
}

function dependencies(
  request: NonNullable<ManageAiDependencies['request']>,
): ManageAiDependencies {
  return { validateOutbound: async () => undefined, request };
}

test('AI proxy keeps status and result paths distinct while limiting octet-stream JSON to result reads', async () => {
  const observed: Array<{
    action: AiProxyAction;
    method: string;
    path: string;
    maximumResponseBytes: number | undefined;
    allowOctetStreamJson: boolean | undefined;
  }> = [];
  const fixtures: Array<{
    action: AiProxyAction;
    method: 'GET' | 'POST';
    path: string;
    maximumResponseBytes: number;
    allowOctetStreamJson: boolean;
  }> = [
    {
      action: 'pick-topic',
      method: 'POST',
      path: '/api/v1/ai/pick-topic',
      maximumResponseBytes: 2 * MEBIBYTE,
      allowOctetStreamJson: false,
    },
    {
      action: 'create-job',
      method: 'POST',
      path: '/api/v1/ai/jobs',
      maximumResponseBytes: 2 * MEBIBYTE,
      allowOctetStreamJson: false,
    },
    {
      action: 'get-job',
      method: 'GET',
      path: '/api/v1/ai/jobs/matrix-job',
      maximumResponseBytes: 2 * MEBIBYTE,
      allowOctetStreamJson: false,
    },
    {
      action: 'get-job-result',
      method: 'GET',
      path: '/api/v1/ai/jobs/matrix-job/result',
      maximumResponseBytes: 2 * MEBIBYTE,
      allowOctetStreamJson: true,
    },
    {
      action: 'get-content-studio-job-result',
      method: 'GET',
      path: '/api/v1/ai/jobs/matrix-job/result',
      maximumResponseBytes: 16 * MEBIBYTE,
      allowOctetStreamJson: true,
    },
    {
      action: 'cancel-job',
      method: 'POST',
      path: '/api/v1/ai/jobs/matrix-job/cancel',
      maximumResponseBytes: 2 * MEBIBYTE,
      allowOctetStreamJson: false,
    },
  ];

  for (const fixture of fixtures) {
    const response = await handleManageAi(proxyRequest(fixture.action), dependencies(async (request) => {
      observed.push({
        action: fixture.action,
        method: request.method,
        path: new URL(request.url).pathname,
        maximumResponseBytes: request.maximumResponseBytes,
        allowOctetStreamJson: request.allowOctetStreamJson,
      });
      return {
        status: 200,
        data: fixture.action === 'get-content-studio-job-result'
          ? { message: 'The projected content result completed.', actions: [], genericMarker: 'drop-me' }
          : { message: 'The generic AI response completed.', genericMarker: 'preserve-me' },
      };
    }));
    assert.equal(response.status, 200, fixture.action);
    const data = await response.json() as Record<string, unknown>;
    if (fixture.action === 'get-content-studio-job-result') {
      assert.equal(data.genericMarker, undefined, 'the Studio result must use the bounded projection');
    }
    if (fixture.action === 'get-job-result') {
      assert.equal(data.genericMarker, 'preserve-me', 'the generic result must retain its existing response shape');
    }
  }

  assert.deepEqual(observed, fixtures.map((fixture) => ({
    action: fixture.action,
    method: fixture.method,
    path: fixture.path,
    maximumResponseBytes: fixture.maximumResponseBytes,
    allowOctetStreamJson: fixture.allowOctetStreamJson,
  })));

  const payload = JSON.stringify({ message: 'A bounded streamed result.' });
  assert.deepEqual(
    await readBoundedJson(incomingStream('application/octet-stream', payload), 1_024, true),
    { message: 'A bounded streamed result.' },
  );
  await assert.rejects(
    readBoundedJson(incomingStream('application/octet-stream', payload), 1_024, false),
    (error: unknown) => (
      error instanceof Error
      && error.message === 'non-json-response'
      && (error as Error & { statusCode?: number }).statusCode === 502
    ),
  );
});

test('streamed result JSON fails closed at both exact response ceilings and on an over-limit chunk', async () => {
  for (const maximumBytes of [2 * MEBIBYTE, 16 * MEBIBYTE]) {
    await assert.rejects(
      readBoundedJson(
        incomingStream('application/octet-stream', '{}', maximumBytes + 1),
        maximumBytes,
        true,
      ),
      (error: unknown) => (
        error instanceof Error
        && error.message === 'response-too-large'
        && (error as Error & { statusCode?: number }).statusCode === 502
      ),
      `${maximumBytes} byte ceiling should reject a larger declared response`,
    );
  }

  await assert.rejects(
    readBoundedJson(
      incomingStream('application/octet-stream', JSON.stringify({ message: 'x'.repeat(1_024) })),
      128,
      true,
    ),
    (error: unknown) => (
      error instanceof Error
      && error.message === 'response-too-large'
      && (error as Error & { statusCode?: number }).statusCode === 502
    ),
  );
});

test('streamed result parsing rejects invalid JSON and every non-object JSON root', async () => {
  for (const body of ['{', 'null', '[]', '"text"', '1', 'true']) {
    await assert.rejects(
      readBoundedJson(incomingStream('application/octet-stream', body), 1_024, true),
      (error: unknown) => (
        error instanceof Error
        && error.message === 'invalid-json-response'
        && (error as Error & { statusCode?: number }).statusCode === 502
      ),
      `unexpected accepted root: ${body}`,
    );
  }
});

test('dashboard-from-chat result projection preserves bounded action evidence without inventing a document identifier', async () => {
  const buildMessage = 'Building **Coffee Orders** with 13 queries...';
  const finalNarrative = 'Dashboard creation completed in Omni Chat; inspect the exact artifact before relying on it.';
  const response = await handleManageAi(
    proxyRequest('get-content-studio-job-result'),
    dependencies(async () => ({
      status: 200,
      data: {
        message: finalNarrative,
        actions: [{
          type: 'create_dashboard_from_chat',
          message: buildMessage,
          timestamp: '2026-08-14T18:01:00.000Z',
          result: {
            queryCount: 13,
            requestedName: 'Coffee Orders',
            internalDefinition: { fields: ['must-not-reach-browser'] },
          },
        }, {
          type: 'summarize',
          message: finalNarrative,
          timestamp: '2026-08-14T18:01:01.000Z',
        }],
      },
    })),
  );

  assert.equal(response.status, 200);
  const projected = await response.json() as {
    message?: string;
    actions?: Array<Record<string, unknown>>;
  };
  assert.equal(projected.message, finalNarrative);
  assert.deepEqual(projected.actions, [{
    type: 'create_dashboard_from_chat',
    message: buildMessage,
    timestamp: '2026-08-14T18:01:00.000Z',
  }]);
  assert.equal(projected.actions?.some((action) => 'documentId' in action), false);
  assert.doesNotMatch(JSON.stringify(projected), /queryCount|requestedName|internalDefinition|must-not-reach-browser/);
});

test('dashboard mode recognizes dashboard-from-chat creation once while keeping the absent artifact ID unverified', async () => {
  const buildMessage = 'Building **Coffee Orders** with 13 queries...';
  const finalNarrative = 'Dashboard creation completed in Omni Chat; inspect the exact artifact before relying on it.';
  const outcome = await runAIContentJob({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    modelId: 'matrix-model',
    prompt: 'Create the approved bounded dashboard.',
    attachments: [],
    mode: 'dashboard',
    signal: new AbortController().signal,
    pollIntervalMs: 0,
    transport: {
      createJob: async () => ({ jobId: 'dashboard-chat-action-job', state: 'COMPLETE' }),
      getJob: async () => ({ jobId: 'dashboard-chat-action-job', state: 'COMPLETE' }),
      getResult: async () => ({
        message: finalNarrative,
        actions: [{
          type: 'create_dashboard_from_chat',
          message: buildMessage,
          timestamp: '2026-08-14T18:01:00.000Z',
        }],
      }),
      cancelJob: async () => ({ jobId: 'dashboard-chat-action-job', state: 'CANCELLED' }),
    },
  });

  assert.deepEqual(outcome.actionSummaries, [`create_dashboard_from_chat: ${buildMessage}`]);
  assert.deepEqual(outcome.actionReviewIssues, []);
  assert.deepEqual(outcome.documentReferences, []);
  assert.equal(outcome.artifactState, 'reported-created-unverified');
  assert.equal(outcome.actionSummaries.filter((summary) => summary.includes(buildMessage)).length, 1);
});

test('summarize remains narrative-only when its bounded message uses creation language', async () => {
  const summary = 'Built the approved dashboard narrative and described the created result for human verification.';
  const outcome = await runAIContentJob({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    modelId: 'matrix-model',
    prompt: 'Create the approved bounded dashboard.',
    attachments: [],
    mode: 'dashboard',
    signal: new AbortController().signal,
    pollIntervalMs: 0,
    transport: {
      createJob: async () => ({ jobId: 'dashboard-summary-language-job', state: 'COMPLETE' }),
      getJob: async () => ({ jobId: 'dashboard-summary-language-job', state: 'COMPLETE' }),
      getResult: async () => ({
        message: 'The dashboard response completed and remains subject to exact artifact reconciliation.',
        actions: [{
          type: 'summarize',
          message: summary,
          timestamp: '2026-08-14T18:01:01.000Z',
        }],
      }),
      cancelJob: async () => ({ jobId: 'dashboard-summary-language-job', state: 'CANCELLED' }),
    },
  });

  assert.deepEqual(outcome.actionSummaries, [`summarize: ${summary}`]);
  assert.deepEqual(outcome.actionReviewIssues, []);
  assert.deepEqual(outcome.documentReferences, []);
});

test('dashboard-from-chat creation remains a review issue outside the approved dashboard write mode', async () => {
  for (const mode of ['review', 'report'] as const) {
    const buildMessage = 'Building **Coffee Orders** with 13 queries...';
    const outcome = await runAIContentJob({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      modelId: 'matrix-model',
      prompt: `Run the bounded ${mode} request.`,
      attachments: [],
      mode,
      signal: new AbortController().signal,
      pollIntervalMs: 0,
      transport: {
        createJob: async () => ({ jobId: `${mode}-chat-action-job`, state: 'COMPLETE' }),
        getJob: async () => ({ jobId: `${mode}-chat-action-job`, state: 'COMPLETE' }),
        getResult: async () => ({
          message: resultMessage(mode),
          actions: [{
            type: 'create_dashboard_from_chat',
            message: buildMessage,
            timestamp: '2026-08-14T18:01:00.000Z',
          }],
        }),
        cancelJob: async () => ({ jobId: `${mode}-chat-action-job`, state: 'CANCELLED' }),
      },
    });

    assert.equal(outcome.actionReviewIssues.length > 0, true, mode);
    assert.equal(
      outcome.actionReviewIssues.some((issue) => issue.includes('create_dashboard_from_chat')),
      true,
      mode,
    );
    assert.deepEqual(outcome.documentReferences, [], mode);
    assert.equal(outcome.artifactState, 'not-returned', mode);
  }
});

test('dashboard action classification still fails closed for malformed and unknown action evidence', async () => {
  const outcome = await runAIContentJob({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    modelId: 'matrix-model',
    prompt: 'Create the approved bounded dashboard.',
    attachments: [],
    mode: 'dashboard',
    signal: new AbortController().signal,
    pollIntervalMs: 0,
    transport: {
      createJob: async () => ({ jobId: 'dashboard-invalid-actions-job', state: 'COMPLETE' }),
      getJob: async () => ({ jobId: 'dashboard-invalid-actions-job', state: 'COMPLETE' }),
      getResult: async () => ({
        message: 'The dashboard job completed with action evidence requiring manual review.',
        actions: [{
          type: 'create_dashboard_from_chat',
          message: 'Building the bounded dashboard.',
          timestamp: '',
        }, {
          type: 'invented_dashboard_action',
          message: 'An unknown action was returned.',
          timestamp: '2026-08-14T18:01:01.000Z',
        }],
      }),
      cancelJob: async () => ({ jobId: 'dashboard-invalid-actions-job', state: 'CANCELLED' }),
    },
  });

  assert.equal(outcome.actionReviewIssues.some((issue) => issue.startsWith('MALFORMED_ACTION:')), true);
  assert.equal(outcome.actionReviewIssues.some((issue) => issue.includes('invented_dashboard_action')), true);
  assert.deepEqual(outcome.documentReferences, []);
  assert.equal(outcome.artifactState, 'creation-status-unverified');
});

test('creation modes distinguish unsafe COMPLETE action evidence from a clean no-action stop', async () => {
  for (const mode of ['dashboard', 'app'] as const) {
    const expectedAction = mode === 'dashboard' ? 'create_dashboard_from_chat' : 'create_app';
    const unsafeResults = [{
      label: 'malformed expected creation action',
      result: {
        message: `The ${mode} job completed with malformed creation evidence.`,
        actions: [{
          type: expectedAction,
          message: `Building the bounded ${mode}.`,
          timestamp: '',
        }],
      },
      expectedIssues: ['MALFORMED_ACTION'],
    }, {
      label: 'unknown potentially mutating action',
      result: {
        message: `The ${mode} job completed with an unknown mutating action.`,
        actions: [{
          type: 'delete_unknown_content',
          message: 'Deleted and replaced an unknown content artifact.',
          timestamp: '2026-08-14T18:02:00.000Z',
        }],
      },
      expectedIssues: ['UNRECOGNIZED_ACTION_TYPE', 'POTENTIAL_MUTATION'],
    }, {
      label: 'server-dropped action evidence',
      result: {
        message: `The ${mode} job completed after the server dropped unsafe action evidence.`,
        actions: [],
        projectionIssues: ['ACTION_DROPPED'] as const,
      },
      expectedIssues: ['ACTION_DROPPED'],
    }, {
      label: 'server-truncated action evidence',
      result: {
        message: `The ${mode} job completed after the server truncated action evidence.`,
        actions: [],
        projectionIssues: ['ACTIONS_TRUNCATED'] as const,
      },
      expectedIssues: ['ACTIONS_TRUNCATED'],
    }];

    for (const fixture of unsafeResults) {
      const outcome = await runAIContentJob({
        baseUrl: BASE_URL,
        apiKey: API_KEY,
        modelId: 'matrix-model',
        prompt: `Run the bounded ${mode} workflow.`,
        attachments: [],
        mode,
        signal: new AbortController().signal,
        pollIntervalMs: 0,
        transport: {
          createJob: async () => ({ jobId: `${mode}-${fixture.label}`, state: 'COMPLETE' }),
          getJob: async () => ({ jobId: `${mode}-${fixture.label}`, state: 'COMPLETE' }),
          getResult: async () => fixture.result,
          cancelJob: async () => ({ jobId: `${mode}-${fixture.label}`, state: 'CANCELLED' }),
        },
      });

      assert.equal(outcome.artifactState, 'creation-status-unverified', `${mode}: ${fixture.label}`);
      assert.deepEqual(outcome.documentReferences, [], `${mode}: ${fixture.label}`);
      for (const issue of fixture.expectedIssues) {
        assert.equal(
          outcome.actionReviewIssues.some((candidate) => candidate.includes(issue)),
          true,
          `${mode}: ${fixture.label} should retain ${issue}`,
        );
      }
    }

    const cleanStop = await runAIContentJob({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      modelId: 'matrix-model',
      prompt: `Stop the bounded ${mode} workflow when required evidence is missing.`,
      attachments: [],
      mode,
      signal: new AbortController().signal,
      pollIntervalMs: 0,
      transport: {
        createJob: async () => ({ jobId: `${mode}-clean-stop`, state: 'COMPLETE' }),
        getJob: async () => ({ jobId: `${mode}-clean-stop`, state: 'COMPLETE' }),
        getResult: async () => ({
          message: `Required governed evidence was unavailable, so no ${mode} creation action ran.`,
          actions: [],
        }),
        cancelJob: async () => ({ jobId: `${mode}-clean-stop`, state: 'CANCELLED' }),
      },
    });

    assert.equal(cleanStop.artifactState, 'not-returned', `${mode}: clean no-action stop`);
    assert.deepEqual(cleanStop.actionReviewIssues, [], `${mode}: clean no-action stop`);
    assert.deepEqual(cleanStop.documentReferences, [], `${mode}: clean no-action stop`);
  }
});

test('server-projected action loss overrides a valid no-ID creation action while an explicit ID stays highest precedence', async () => {
  for (const mode of ['dashboard', 'app'] as const) {
    const expectedAction = mode === 'dashboard' ? 'create_dashboard_from_chat' : 'create_app';
    for (const documentId of ['', `${mode}-explicit-document-id`]) {
      const outcome = await runAIContentJob({
        baseUrl: BASE_URL,
        apiKey: API_KEY,
        modelId: 'matrix-model',
        prompt: `Run the bounded ${mode} workflow.`,
        attachments: [],
        mode,
        signal: new AbortController().signal,
        pollIntervalMs: 0,
        transport: {
          createJob: async () => ({ jobId: `${mode}-projected-loss-precedence`, state: 'COMPLETE' }),
          getJob: async () => ({ jobId: `${mode}-projected-loss-precedence`, state: 'COMPLETE' }),
          getResult: async () => ({
            message: `The ${mode} job returned a valid creation action plus incomplete server-projected evidence.`,
            actions: [{
              type: expectedAction,
              message: `Built the bounded ${mode}.`,
              timestamp: '2026-08-14T18:04:00.000Z',
              ...(documentId ? { documentId } : {}),
            }],
            projectionIssues: ['ACTION_DROPPED'],
          }),
          cancelJob: async () => ({ jobId: `${mode}-projected-loss-precedence`, state: 'CANCELLED' }),
        },
      });

      assert.equal(
        outcome.artifactState,
        documentId ? 'returned-unverified' : 'creation-status-unverified',
        `${mode}: explicit structured identifiers are the only higher-precedence artifact evidence`,
      );
      assert.deepEqual(
        outcome.documentReferences,
        documentId ? [{ documentId, actionType: expectedAction, summary: `Built the bounded ${mode}.` }] : [],
        mode,
      );
      assert.equal(outcome.actionReviewIssues.includes('ACTION_DROPPED'), true, mode);
    }
  }
});

test('App mode recognizes the observed App-from-chat creation alias with valid empty action messages', async () => {
  const outcome = await runAIContentJob({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    modelId: 'matrix-model',
    prompt: 'Build the bounded App and retain exact action evidence.',
    attachments: [],
    mode: 'app',
    signal: new AbortController().signal,
    pollIntervalMs: 0,
    transport: {
      createJob: async () => ({ jobId: 'app-from-chat-alias-job', state: 'COMPLETE' }),
      getJob: async () => ({ jobId: 'app-from-chat-alias-job', state: 'COMPLETE' }),
      getResult: async () => ({
        message: 'The App job completed and still requires exact functional reconciliation in Omni.',
        actions: [{
          type: 'search_model',
          message: '',
          timestamp: '2026-08-14T18:10:00.000Z',
        }, {
          type: 'manage_task_list',
          message: 'Tracked the bounded App work plan.',
          timestamp: '2026-08-14T18:10:01.000Z',
        }, {
          type: 'create_app_from_chat',
          message: '',
          timestamp: '2026-08-14T18:10:02.000Z',
        }],
      }),
      cancelJob: async () => ({ jobId: 'app-from-chat-alias-job', state: 'CANCELLED' }),
    },
  });

  assert.deepEqual(outcome.actionSummaries, [
    'search_model',
    'manage_task_list: Tracked the bounded App work plan.',
    'create_app_from_chat',
  ]);
  assert.deepEqual(outcome.actionReviewIssues, []);
  assert.deepEqual(outcome.documentReferences, []);
  assert.equal(outcome.artifactState, 'reported-created-unverified');
});

test('empty action messages remain distinct from missing or non-string action evidence', async () => {
  const outcome = await runAIContentJob({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    modelId: 'matrix-model',
    prompt: 'Build the bounded App and fail closed on malformed action evidence.',
    attachments: [],
    mode: 'app',
    signal: new AbortController().signal,
    pollIntervalMs: 0,
    transport: {
      createJob: async () => ({ jobId: 'app-malformed-message-job', state: 'COMPLETE' }),
      getJob: async () => ({ jobId: 'app-malformed-message-job', state: 'COMPLETE' }),
      getResult: async () => ({
        message: 'The App job completed with malformed creation evidence that requires reconciliation.',
        actions: [{
          type: 'create_app_from_chat',
          message: null as unknown as string,
          timestamp: '2026-08-14T18:10:03.000Z',
        }],
      }),
      cancelJob: async () => ({ jobId: 'app-malformed-message-job', state: 'CANCELLED' }),
    },
  });

  assert.equal(
    outcome.actionReviewIssues.some((issue) => issue.startsWith('MALFORMED_ACTION:')),
    true,
  );
  assert.equal(outcome.actionReviewIssues.some((issue) => issue.startsWith('UNRECOGNIZED_ACTION_TYPE:')), false);
  assert.equal(outcome.artifactState, 'creation-status-unverified');
});

test('observed read and orchestration aliases are exact, mode-neutral, and never creation proof', async () => {
  const modes: AIContentAgentMode[] = ['review', 'dashboard', 'app', 'report'];
  for (const mode of modes) {
    const outcome = await runAIContentJob({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      modelId: 'matrix-model',
      prompt: `Run the bounded ${mode} workflow.`,
      attachments: [],
      mode,
      signal: new AbortController().signal,
      pollIntervalMs: 0,
      transport: {
        createJob: async () => ({ jobId: `${mode}-observed-read-aliases`, state: 'COMPLETE' }),
        getJob: async () => ({ jobId: `${mode}-observed-read-aliases`, state: 'COMPLETE' }),
        getResult: async () => ({
          message: resultMessage(mode),
          actions: [{
            type: 'search_model',
            message: '',
            timestamp: '2026-08-14T18:11:00.000Z',
          }, {
            type: 'manage_task_list',
            message: 'Tracked the bounded response plan.',
            timestamp: '2026-08-14T18:11:01.000Z',
          }],
        }),
        cancelJob: async () => ({ jobId: `${mode}-observed-read-aliases`, state: 'CANCELLED' }),
      },
    });

    assert.deepEqual(outcome.actionReviewIssues, [], mode);
    assert.deepEqual(outcome.actionSummaries, [
      'search_model',
      'manage_task_list: Tracked the bounded response plan.',
    ], mode);
    assert.equal(outcome.artifactState, 'not-returned', mode);
  }
});

test('observed aliases retain mutation scanning, exact-mode enforcement, and fail-closed unknowns', async () => {
  const unsafeActions = [{
    type: 'manage_task_list',
    message: 'Updated the selected model and created a dashboard.',
    timestamp: '2026-08-14T18:12:00.000Z',
  }, {
    type: 'search_model_and_update',
    message: 'Updated the selected model.',
    timestamp: '2026-08-14T18:12:01.000Z',
  }, {
    type: 'create_app_from_chat',
    message: 'Built an App outside the approved mode.',
    timestamp: '2026-08-14T18:12:02.000Z',
  }];
  const outcome = await runAIContentJob({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    modelId: 'matrix-model',
    prompt: 'Run one bounded dashboard workflow.',
    attachments: [],
    mode: 'dashboard',
    signal: new AbortController().signal,
    pollIntervalMs: 0,
    transport: {
      createJob: async () => ({ jobId: 'observed-alias-negative-job', state: 'COMPLETE' }),
      getJob: async () => ({ jobId: 'observed-alias-negative-job', state: 'COMPLETE' }),
      getResult: async () => ({
        message: resultMessage('dashboard'),
        actions: unsafeActions,
      }),
      cancelJob: async () => ({ jobId: 'observed-alias-negative-job', state: 'CANCELLED' }),
    },
  });

  assert.equal(
    outcome.actionReviewIssues.some((issue) => issue.startsWith('UNRECOGNIZED_ACTION_TYPE: manage_task_list')),
    false,
  );
  assert.equal(
    outcome.actionReviewIssues.some((issue) => issue.startsWith('POTENTIAL_MUTATION: manage_task_list')),
    true,
  );
  assert.equal(
    outcome.actionReviewIssues.some((issue) => issue.startsWith('UNRECOGNIZED_ACTION_TYPE: search_model_and_update')),
    true,
  );
  assert.equal(
    outcome.actionReviewIssues.some((issue) => issue.startsWith('POTENTIAL_MUTATION: search_model_and_update')),
    true,
  );
  assert.equal(
    outcome.actionReviewIssues.some((issue) => issue.startsWith('UNEXPECTED_ACTION_FOR_MODE: create_app_from_chat')),
    true,
  );
  assert.equal(
    outcome.actionReviewIssues.some((issue) => issue.startsWith('POTENTIAL_MUTATION: create_app_from_chat')),
    true,
  );
  assert.equal(outcome.artifactState, 'creation-status-unverified');
});

function resultMessage(mode: AIContentAgentMode): string {
  if (mode === 'review') {
    return [
      '## Evidence reviewed',
      'The bounded dashboard evidence was reviewed.',
      '## Supported findings',
      'One supported finding was returned.',
      '## Unknowns',
      'Hidden interaction states remain unknown.',
      '## Recommended next steps',
      'Verify the highest-priority visual change in Omni.',
    ].join('\n\n');
  }
  if (mode === 'report') {
    return [
      '## Report',
      'The governed narrative was returned.',
      '## Evidence limits',
      'Unobserved states remain unknown.',
      '## Follow-ups',
      'Continue validation in Omni.',
    ].join('\n\n');
  }
  return `The ${mode} job completed and remains available for reconciliation in Omni.`;
}

test('all four Studio workflows recover a result read without retrying create or invoking cancel', async () => {
  const modes: AIContentAgentMode[] = ['review', 'dashboard', 'app', 'report'];

  for (const mode of modes) {
    let creates = 0;
    let statusReads = 0;
    let resultReads = 0;
    let cancels = 0;
    const jobId = `matrix-${mode}-job`;
    const chatUrl = `${BASE_URL}/chat/matrix-${mode}`;
    const transport: AIContentJobTransport = {
      createJob: async () => {
        creates += 1;
        return { jobId, state: 'COMPLETE', omniChatUrl: `${chatUrl}?discard=1` };
      },
      getJob: async () => {
        statusReads += 1;
        return { jobId, state: 'COMPLETE' };
      },
      getResult: async () => {
        resultReads += 1;
        if (resultReads === 1) {
          throw new ApiError(
            422,
            'The completed response could not be projected.',
            undefined,
            AI_CONTENT_RESULT_CONTRACT_MISMATCH_CODE,
          );
        }
        return { message: resultMessage(mode), actions: [] };
      },
      cancelJob: async () => {
        cancels += 1;
        return { jobId, state: 'CANCELLED' };
      },
    };

    await assert.rejects(() => runAIContentJob({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      modelId: 'matrix-model',
      prompt: `Run the bounded ${mode} workflow.`,
      attachments: [],
      mode,
      signal: new AbortController().signal,
      pollIntervalMs: 0,
      transport,
    }), (error: unknown) => {
      assert.ok(error instanceof AIContentResultContractMismatchError);
      assert.equal(error.jobId, jobId);
      assert.equal(error.chatUrl, chatUrl);
      return true;
    });

    const recovered = await recoverCompletedAIContentJob({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      jobId,
      mode,
      signal: new AbortController().signal,
      chatUrl,
      transport: { getResult: transport.getResult },
    });

    assert.equal(recovered.state, 'COMPLETE', mode);
    assert.equal(recovered.message, resultMessage(mode), mode);
    assert.equal(creates, 1, `${mode}: result recovery must never resubmit create`);
    assert.equal(statusReads, 0, `${mode}: a create response already marked COMPLETE must not be polled`);
    assert.equal(resultReads, 2, `${mode}: initial result read plus one explicit recovery read`);
    assert.equal(cancels, 0, `${mode}: a COMPLETE job must not be cancelled`);
  }
});

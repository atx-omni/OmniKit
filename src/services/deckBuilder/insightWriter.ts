import {
  ApiError,
  cancelAiJob,
  createAiJob,
  getAiJob,
  getAiJobResult,
  isRetryableAiJobReadError,
  type OmniAiJob,
  type OmniAiJobResult,
} from '../omniApi';
import {
  AsyncJobCancelledError,
  AsyncJobCreateAcceptanceUnknownError,
  AsyncJobDeadlineError,
  AsyncJobReadUnavailableError,
  AsyncJobStaleScopeError,
  AsyncJobTerminalStateError,
  runAsyncJobLifecycle,
  type AsyncJobScope,
} from '../asyncJobLifecycle';
import { cleanDeckInsightText, isDeckInsightRefusal } from './prompts';

const TERMINAL_AI_STATES = new Set(['COMPLETE', 'COMPLETED', 'SUCCESS', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'CANCELED']);
const SUCCESSFUL_AI_STATES = new Set(['COMPLETE', 'COMPLETED', 'SUCCESS', 'SUCCEEDED']);

export interface DeckInsightJobTransport {
  createJob: typeof createAiJob;
  getJob: typeof getAiJob;
  getResult: typeof getAiJobResult;
  cancelJob: typeof cancelAiJob;
}

const defaultTransport: DeckInsightJobTransport = {
  createJob: createAiJob,
  getJob: getAiJob,
  getResult: getAiJobResult,
  cancelJob: cancelAiJob,
};

export interface GenerateDeckInsightInput {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  topicName?: string;
  prompt: string;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  maxPolls?: number;
  deadlineMs?: number;
  scope?: AsyncJobScope;
  onStatus?: (message: string) => void;
  onJobId?: (jobId: string) => void;
  transport?: DeckInsightJobTransport;
}

export interface GenerateDeckInsightResult {
  text: string;
  jobId: string;
  conversationId?: string;
  chatUrl?: string;
  truncated: boolean;
}

export class DeckInsightCancelledError extends Error {
  constructor() {
    super('AI insight generation cancelled.');
    this.name = 'DeckInsightCancelledError';
  }
}

function normalizeAiState(value: string | undefined): string {
  return (value || '').trim().toUpperCase().replace(/[-\s]/g, '_');
}

function readFirstString(value: unknown, keys: string[]): string {
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const field = record[key];
    if (typeof field === 'string' && field.trim()) return field.trim();
  }
  return '';
}

function buildOmniChatUrl(baseUrl: string, conversationId: string): string {
  const cleanBase = baseUrl.trim().replace(/\/+$/, '').replace(/\/api$/i, '');
  return cleanBase && conversationId ? `${cleanBase}/chat/${encodeURIComponent(conversationId)}` : '';
}

function jobToResult(job: OmniAiJob | null | undefined): OmniAiJobResult | null {
  if (!job) return null;
  const message = readFirstString(job, ['resultSummary', 'result_summary', 'message']);
  return message ? { message } : null;
}

function extractAiMessage(result: OmniAiJobResult | null | undefined, fallbackJob?: OmniAiJob | null): string {
  const direct =
    readFirstString(result, ['finalMessage', 'final_message', 'message', 'resultSummary', 'result_summary', 'answer']) ||
    readFirstString(fallbackJob, ['resultSummary', 'result_summary', 'message']);
  if (direct) return direct;

  const actions = Array.isArray(result?.actions) ? result?.actions : Array.isArray(fallbackJob?.actions) ? fallbackJob?.actions : [];
  for (const action of actions || []) {
    const value =
      readFirstString(action, ['message', 'result', 'summary', 'text', 'answer']) ||
      readFirstString((action as Record<string, unknown>).payload, ['message', 'result', 'summary', 'text', 'answer']);
    if (value) return value;
  }
  return '';
}

export async function generateDeckInsight(input: GenerateDeckInsightInput): Promise<GenerateDeckInsightResult> {
  if (!input.modelId.trim()) throw new Error('This tile does not expose a model ID for Omni AI.');
  const transport = input.transport || defaultTransport;
  const pollIntervalMs = input.pollIntervalMs ?? 3_000;
  const maxPolls = input.maxPolls ?? 36;
  input.onStatus?.('Creating one Omni AI job...');
  try {
    const outcome = await runAsyncJobLifecycle({
      connection: { baseUrl: input.baseUrl, apiKey: input.apiKey },
      createInput: {
        modelId: input.modelId,
        topicName: input.topicName || undefined,
        prompt: input.prompt,
      },
      transport: {
        create: (connection, createInput, signal) => transport.createJob(
          connection.baseUrl,
          connection.apiKey,
          createInput,
          signal,
        ),
        getJob: (connection, jobId, signal) => transport.getJob(
          connection.baseUrl,
          connection.apiKey,
          jobId,
          signal,
        ),
        getResult: (connection, jobId, signal) => transport.getResult(
          connection.baseUrl,
          connection.apiKey,
          jobId,
          signal,
        ),
        cancel: (connection, jobId, signal) => transport.cancelJob(
          connection.baseUrl,
          connection.apiKey,
          jobId,
          signal,
        ),
      },
      getJobId: (job) => job.jobId || job.id || '',
      getState: (job) => normalizeAiState(job.state || job.status),
      isTerminalState: (state) => TERMINAL_AI_STATES.has(state),
      isSuccessfulState: (state) => SUCCESSFUL_AI_STATES.has(state),
      isResultReady: (result, terminalJob) => Boolean(extractAiMessage(result, terminalJob)),
      fallbackResult: jobToResult,
      isCreateAcceptanceUnknown: (error) => !(error instanceof ApiError)
        || error.status <= 0
        || error.status === 408
        || error.status === 425
        || error.status >= 500,
      shouldRetryRead: isRetryableAiJobReadError,
      signal: input.signal,
      scope: input.scope,
      deadlineMs: input.deadlineMs ?? Math.max(
        30_000,
        (maxPolls * Math.max(0, pollIntervalMs)) + 45_000,
      ),
      pollIntervalMs,
      maxPollAttempts: maxPolls,
      maxConsecutivePollFailures: 5,
      resultRetryIntervalMs: 3_000,
      maxResultAttempts: 8,
      onCreated: (jobId) => input.onJobId?.(jobId),
      onPoll: () => input.onStatus?.('Waiting for Blobby to finish...'),
      onPollRetry: () => input.onStatus?.('Omni job status is temporarily unavailable. Retrying the read...'),
      onResultRetry: () => input.onStatus?.('Omni finished. Waiting for the insight result...'),
    });
    const { created, terminalJob: finalJob, result, jobId } = outcome;
    const createdConversationId = readFirstString(created, ['conversationId', 'conversation_id']);
    const createdChatUrl = readFirstString(created, ['omniChatUrl', 'omni_chat_url']) || buildOmniChatUrl(input.baseUrl, createdConversationId);
    input.onStatus?.('Retrieving AI insight...');
    const rawText = extractAiMessage(result, finalJob);
    if (!rawText) throw new Error('Omni AI did not return an insight.');
    if (isDeckInsightRefusal(rawText)) {
      throw new Error('Omni AI declined to generate an insight for this tile. Try again or write the insight manually.');
    }
    const cleaned = cleanDeckInsightText(rawText);
    if (!cleaned.text) throw new Error('Omni AI returned an empty insight.');
    const conversationId = readFirstString(result, ['conversationId', 'conversation_id']) || readFirstString(finalJob, ['conversationId', 'conversation_id']) || createdConversationId;
    const chatUrl = readFirstString(result, ['omniChatUrl', 'omni_chat_url']) || readFirstString(finalJob, ['omniChatUrl', 'omni_chat_url']) || createdChatUrl || buildOmniChatUrl(input.baseUrl, conversationId);
    return { text: cleaned.text, jobId, conversationId, chatUrl, truncated: cleaned.truncated };
  } catch (error) {
    if (error instanceof AsyncJobCancelledError) throw new DeckInsightCancelledError();
    if (error instanceof AsyncJobStaleScopeError) {
      throw new Error('The AI insight result was discarded because the Omni instance or dashboard changed.');
    }
    if (error instanceof AsyncJobCreateAcceptanceUnknownError) {
      throw new Error('Omni did not confirm whether the AI insight job was created. Check Omni before retrying; the request was not resubmitted.');
    }
    if (error instanceof AsyncJobDeadlineError) {
      throw new Error('The AI insight run reached its overall deadline. OmniKit requested cancellation and did not resubmit the job.');
    }
    if (error instanceof AsyncJobTerminalStateError) {
      throw new Error(`Omni AI job ${error.state.toLowerCase()}.`);
    }
    if (error instanceof AsyncJobReadUnavailableError) {
      throw new Error(error.phase === 'poll'
        ? 'Omni AI job status could not be confirmed. Check Omni before retrying; the job was not resubmitted.'
        : 'Omni AI completed, but the insight result could not be read. Check Omni before retrying.');
    }
    throw error;
  }
}

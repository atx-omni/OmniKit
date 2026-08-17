import {
  ApiError,
  createAiJob,
  createAiContentStudioJob,
  getAiJob,
  getAiContentStudioJob,
  getAiContentStudioJobResult,
  cancelAiContentStudioJob,
  isRetryableAiJobReadError,
  type OmniAiJob,
  type OmniAiContentStudioJobResult,
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
import type {
  AIContentAgentMode,
  AIContentDocumentReference,
  AIContentAttachment,
  AIContentJobOutcome,
  AIContentUnresolvedJobReason,
} from './types';

const TERMINAL_STATES = new Set(['COMPLETE', 'FAILED', 'CANCELLED']);
const POLL_INTERVAL_MS = 2_000;
const MAX_POLLS = 120;
const MAX_CONSECUTIVE_POLL_FAILURES = 5;
const MAX_RESULT_ATTEMPTS = 8;
const OVERALL_DEADLINE_MS = 4 * 60_000;
const MAX_CLASSIFIED_ACTIONS = 100;
export const AI_CONTENT_RESULT_CONTRACT_MISMATCH_CODE = 'AI_RESULT_CONTRACT_MISMATCH';
const NON_MUTATING_AI_ACTION_TYPES = new Set([
  'generate_query',
  'inspect_model',
  // Observed live read aliases. Omni's result API does not publish an action
  // type enum, so keep compatibility exact and fail closed for every other
  // search-like type.
  'search_model',
  'search_model_files',
  'summarize',
]);
const ORCHESTRATION_AI_ACTION_TYPES = new Set([
  // This observed action manages the Agent's internal work plan. It is not
  // creation evidence, and its message is still scanned for mutation language.
  'manage_task_list',
]);
const CREATION_ACTION_MODE = new Map<string, AIContentAgentMode>([
  // These creation types are observed live but are not used as proof that an
  // artifact exists. They are expected only when the submitted mode requested
  // that exact kind of artifact and still require identifier reconciliation.
  ['create_dashboard_from_chat', 'dashboard'],
  ['create_app', 'app'],
  ['create_app_from_chat', 'app'],
]);

export class AIContentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AIContentJobError';
  }
}

export class AIContentCreateAcceptanceUnknownError extends AIContentJobError {
  constructor() {
    super('Omni did not confirm whether the AI job was created. Check Omni before retrying; this request was not resubmitted.');
    this.name = 'AIContentCreateAcceptanceUnknownError';
  }
}

export class AIContentUnresolvedJobError extends AIContentJobError {
  jobId: string;
  chatUrl: string;
  reason: AIContentUnresolvedJobReason;

  constructor(message: string, jobId: string, chatUrl: string, reason: AIContentUnresolvedJobReason) {
    super(message);
    this.name = 'AIContentUnresolvedJobError';
    this.jobId = jobId;
    this.chatUrl = chatUrl;
    this.reason = reason;
  }
}

export class AIContentResultContractMismatchError extends AIContentJobError {
  readonly code = AI_CONTENT_RESULT_CONTRACT_MISMATCH_CODE;
  readonly jobId: string;
  readonly chatUrl: string;

  constructor(jobId: string, chatUrl: string) {
    super('Omni completed the job, but its result did not match the documented AI response contract. Check Omni before retrying; this job was not resubmitted.');
    this.name = 'AIContentResultContractMismatchError';
    this.jobId = jobId;
    this.chatUrl = chatUrl;
  }
}

export class AIContentCompletedResultValidationError extends AIContentJobError {
  readonly jobId: string;
  readonly chatUrl: string;

  constructor(jobId: string, chatUrl: string, validationMessage: string) {
    const detail = validationMessage.trim().slice(0, 1_000)
      || 'The returned result did not pass local validation.';
    super(`Omni completed the job, but its returned result failed OmniKit's local validation: ${detail} Check the existing job in Omni before retrying; this job was not resubmitted.`);
    this.name = 'AIContentCompletedResultValidationError';
    this.jobId = jobId;
    this.chatUrl = chatUrl;
  }
}

export class AIContentTerminalJobError extends AIContentJobError {
  jobId: string;
  chatUrl: string;
  state: 'FAILED' | 'CANCELLED';

  constructor(jobId: string, chatUrl: string, state: 'FAILED' | 'CANCELLED') {
    super(`Omni AI job ended in ${state.toLowerCase()} state.`);
    this.name = 'AIContentTerminalJobError';
    this.jobId = jobId;
    this.chatUrl = chatUrl;
    this.state = state;
  }
}

function strictState(job: OmniAiJob): string {
  return typeof job.state === 'string' ? job.state.trim().toUpperCase() : '';
}

function isAmbiguousCreateFailure(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  return error.status === 408 || error.status === 425 || error.status >= 500 || error.status <= 0;
}

function isResultContractMismatch(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { status?: unknown; code?: unknown };
  return candidate.status === 422
    && candidate.code === AI_CONTENT_RESULT_CONTRACT_MISMATCH_CODE;
}

function boundedString(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

const REQUIRED_STRUCTURED_HEADINGS: Partial<Record<AIContentAgentMode, readonly string[]>> = {
  review: ['Evidence reviewed', 'Supported findings', 'Unknowns', 'Recommended next steps'],
  report: ['Report', 'Evidence limits', 'Follow-ups'],
};

function inspectStructuredMarkdown(
  message: string,
  requiredHeadings: readonly string[],
): { missing: string[]; unexpected: string[] } {
  const requiredByNormalizedHeading = new Map(
    requiredHeadings.map((heading) => [heading.toLowerCase(), heading]),
  );
  const sections = new Map<string, string[]>();
  const displayedHeadings = new Map<string, string>();
  let currentHeading = '';
  message.split(/\r?\n/).forEach((line) => {
    const match = line.match(/^ {0,3}##(?!#)[\t ]+(.+?)(?:[\t ]+#+)?[\t ]*$/);
    if (match) {
      const displayedHeading = match[1].trim();
      currentHeading = displayedHeading.toLowerCase();
      displayedHeadings.set(currentHeading, displayedHeading);
      if (!sections.has(currentHeading)) sections.set(currentHeading, []);
      return;
    }
    if (currentHeading) sections.get(currentHeading)?.push(line);
  });
  return {
    missing: requiredHeadings.filter((heading) => {
      const content = sections.get(heading.toLowerCase())?.join('\n').trim() || '';
      return content.length < 4;
    }),
    unexpected: Array.from(displayedHeadings, ([normalized, displayed]) => (
      requiredByNormalizedHeading.has(normalized) ? '' : displayed
    )).filter(Boolean),
  };
}

function validateFinalMessage(result: OmniAiContentStudioJobResult, mode: AIContentAgentMode): {
  message: string;
  reviewIssues: string[];
} {
  const messageCandidates = [
    boundedString(result.message, 50_000),
    boundedString(result.resultSummary, 50_000),
  ].filter(Boolean);
  const requiredHeadings = REQUIRED_STRUCTURED_HEADINGS[mode] || [];
  const structuredCandidate = requiredHeadings.length > 0
    ? messageCandidates.find((candidate) => {
        const structure = inspectStructuredMarkdown(candidate, requiredHeadings);
        return structure.missing.length === 0 && structure.unexpected.length === 0;
      })
    : '';
  const message = structuredCandidate || messageCandidates.find((candidate) => (
    candidate.length >= 8 && !/^(?:undefined|null|nan)$/i.test(candidate)
  )) || messageCandidates.find((candidate) => !/^(?:undefined|null|nan)$/i.test(candidate))
    || messageCandidates[0]
    || '';
  if (/^(?:undefined|null|nan)$/i.test(message)) {
    throw new AIContentJobError('Omni returned an incomplete final message. Open Omni chat to inspect the run.');
  }
  if (message.length < 8) {
    if ((result.actions?.length || 0) > 0 && (mode === 'dashboard' || mode === 'app')) {
      return {
        message: 'Omni completed the job and returned documented actions, but no usable final narrative. Review the action evidence and continue in Omni Chat.',
        reviewIssues: [],
      };
    }
    throw new AIContentJobError('Omni completed the job without a usable final message. Open Omni chat to inspect the run.');
  }
  const structure = requiredHeadings.length > 0
    ? inspectStructuredMarkdown(message, requiredHeadings)
    : { missing: [], unexpected: [] };
  if (structure.missing.length > 0 || structure.unexpected.length > 0) {
    const issueType = mode === 'review' ? 'REVIEW_STRUCTURE' : 'REPORT_STRUCTURE';
    const reviewIssues: string[] = [];
    if (structure.missing.length > 0) {
      reviewIssues.push(`${issueType}: Missing or empty required Markdown headings: ${structure.missing.join(', ')}.`);
    }
    if (structure.unexpected.length > 0) {
      reviewIssues.push(`${issueType}: Unexpected level-two Markdown headings: ${structure.unexpected.join(', ')}.`);
    }
    return {
      message,
      reviewIssues,
    };
  }
  return { message, reviewIssues: [] };
}

function projectedReviewIssues(result: OmniAiContentStudioJobResult): string[] {
  if (!Array.isArray(result.projectionIssues)) return [];
  return Array.from(new Set(
    result.projectionIssues
      .map((issue) => boundedString(issue, 2_000))
      .filter(Boolean),
  ));
}

function isCreationStatusUnverifiedIssue(issue: string): boolean {
  const normalized = issue.trim().toUpperCase();
  return normalized === 'ACTIONS_DROPPED'
    || normalized === 'ACTION_DROPPED'
    || normalized === 'ACTIONS_TRUNCATED'
    || normalized.startsWith('MALFORMED_ACTION:')
    || normalized.startsWith('UNRECOGNIZED_ACTION_TYPE:')
    || normalized.startsWith('UNEXPECTED_ACTION_FOR_MODE:')
    || normalized.startsWith('POTENTIAL_MUTATION:')
    || normalized.startsWith('TRUNCATED_ACTIONS:');
}

function actionType(action: Record<string, unknown>): string {
  return boundedString(action.type, 100) || 'ACTION';
}

function actionSummary(action: Record<string, unknown>): string {
  return boundedString(action.message, 500);
}

function actionDocumentId(action: Record<string, unknown>): string {
  return boundedString(action.documentId, 200);
}

function validateActions(result: OmniAiContentStudioJobResult, mode: AIContentAgentMode): {
  summaries: string[];
  documentReferences: AIContentDocumentReference[];
  reviewIssues: string[];
  expectedCreationActionObserved: boolean;
} {
  if (result.actions !== undefined && !Array.isArray(result.actions)) {
    throw new AIContentJobError('Omni returned an invalid action list.');
  }
  const rawActions = result.actions || [];
  const summaries: string[] = [];
  const documentReferences: AIContentDocumentReference[] = [];
  const reviewIssues: string[] = [];
  let expectedCreationActionObserved = false;
  rawActions.slice(0, MAX_CLASSIFIED_ACTIONS).forEach((candidate, index) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      reviewIssues.push(`MALFORMED_ACTION: action ${index + 1} was not an object.`);
      return;
    }
    const action = candidate as unknown as Record<string, unknown>;
    const type = actionType(action);
    const summary = actionSummary(action);
    const timestamp = boundedString(action.timestamp, 100);
    const normalizedType = type.toLowerCase();
    const actionContractValid = type !== 'ACTION'
      && typeof action.message === 'string'
      && Boolean(timestamp)
      && !Number.isNaN(Date.parse(timestamp));
    if (!actionContractValid) {
      reviewIssues.push(`MALFORMED_ACTION: action ${index + 1} did not match Omni's documented type, message, and timestamp contract.`);
    }
    const expectedCreationMode = CREATION_ACTION_MODE.get(normalizedType);
    const expectedCreation = expectedCreationMode === mode;
    if (expectedCreation && actionContractValid) expectedCreationActionObserved = true;
    if (expectedCreationMode && !expectedCreation) {
      reviewIssues.push(`UNEXPECTED_ACTION_FOR_MODE: ${type} is not expected for ${mode}.`);
    } else if (
      !expectedCreationMode
      && !NON_MUTATING_AI_ACTION_TYPES.has(normalizedType)
      && !ORCHESTRATION_AI_ACTION_TYPES.has(normalizedType)
    ) {
      reviewIssues.push(`UNRECOGNIZED_ACTION_TYPE: ${type}.`);
    }
    const display = summary ? `${type}: ${summary}` : type;
    summaries.push(display);
    if (!expectedCreation && !NON_MUTATING_AI_ACTION_TYPES.has(normalizedType) && isPotentialMutatingAction(display)) {
      reviewIssues.push(`POTENTIAL_MUTATION: ${display}`);
    }
    const documentId = actionDocumentId(action);
    if (documentId) {
      documentReferences.push({ documentId, actionType: type, summary });
    }
  });
  if (rawActions.length > MAX_CLASSIFIED_ACTIONS) {
    const issue = `TRUNCATED_ACTIONS: ${rawActions.length - MAX_CLASSIFIED_ACTIONS} additional actions were returned and could not be classified.`;
    summaries.push(issue);
    reviewIssues.push(issue);
  }
  return {
    summaries,
    documentReferences,
    reviewIssues: Array.from(new Set(reviewIssues)),
    expectedCreationActionObserved,
  };
}

export function validateOmniChatUrl(baseUrl: string, candidate: string): string {
  if (!candidate) return '';
  try {
    const expected = new URL(baseUrl);
    const parsed = new URL(candidate);
    if (
      parsed.protocol !== 'https:'
      || expected.protocol !== 'https:'
      || expected.username
      || expected.password
      || parsed.username
      || parsed.password
    ) return '';
    const sameOrigin = expected.origin === parsed.origin;
    const expectedTenant = standardOmniTenant(expected.hostname);
    const candidateTenant = standardOmniTenant(parsed.hostname);
    const sameStandardTenant = expected.port === ''
      && parsed.port === ''
      && expectedTenant !== ''
      && expectedTenant === candidateTenant;
    if (!sameOrigin && !sameStandardTenant) return '';
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '';
  }
}

function standardOmniTenant(hostname: string): string {
  const suffix = hostname.endsWith('.omniapp.co')
    ? '.omniapp.co'
    : hostname.endsWith('.omni.co')
      ? '.omni.co'
      : '';
  if (!suffix) return '';
  const tenant = hostname.slice(0, -suffix.length);
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(tenant) ? tenant : '';
}

export function isPotentialMutatingAction(summary: string): boolean {
  const actionType = summary.match(/^\s*([a-z][a-z0-9_]*)\s*:/i)?.[1]?.toLowerCase();
  if (actionType && NON_MUTATING_AI_ACTION_TYPES.has(actionType)) return false;
  if (actionType === 'create_dashboard_from_chat') return true;
  return /(?:^|[^a-z])(?:create|created|creation|build|built|publish|published|update|updated|edit|edited|delete|deleted|write|wrote|share|shared|grant|granted|move|moved|copy|copied|clone|cloned|rename|renamed|archive|archived|save|saved|upload|uploaded|send|sent|schedule|scheduled|deliver|delivered|invite|invited|assign|assigned|permission)(?:[^a-z]|$)/i.test(summary);
}

function conversationFrom(job: OmniAiJob): string {
  return boundedString(job.conversationId, 200);
}

function chatFrom(job: OmniAiJob): string {
  return boundedString(job.omniChatUrl, 2_000);
}

function resultChatFrom(result: OmniAiContentStudioJobResult): string {
  return boundedString(result.omniChatUrl, 2_000);
}

export interface RunAIContentJobInput {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  topicName?: string;
  prompt: string;
  attachments: AIContentAttachment[];
  mode: AIContentAgentMode;
  signal: AbortSignal;
  scope?: AsyncJobScope;
  deadlineMs?: number;
  pollIntervalMs?: number;
  onJobCreated?: (jobId: string, chatUrl?: string) => void;
  onTerminal?: (state: string, jobId: string, chatUrl?: string) => void;
  onProgress?: (message: string) => void;
  transport?: AIContentJobTransport;
}

export interface AIContentJobTransport {
  createJob: typeof createAiJob;
  getJob: typeof getAiJob;
  getResult: typeof getAiContentStudioJobResult;
  cancelJob: typeof cancelAiContentStudioJob;
}

export interface AIContentResultTransport {
  getResult: typeof getAiContentStudioJobResult;
}

export interface RecoverCompletedAIContentJobInput {
  baseUrl: string;
  apiKey: string;
  jobId: string;
  mode: AIContentAgentMode;
  signal: AbortSignal;
  conversationId?: string;
  chatUrl?: string;
  transport?: AIContentResultTransport;
}

const defaultTransport: AIContentJobTransport = {
  createJob: createAiContentStudioJob,
  getJob: getAiContentStudioJob,
  getResult: getAiContentStudioJobResult,
  cancelJob: cancelAiContentStudioJob,
};

function completedOutcomeFromResult(input: {
  baseUrl: string;
  jobId: string;
  mode: AIContentAgentMode;
  result: OmniAiContentStudioJobResult;
  conversationId?: string;
  chatUrl?: string;
}): AIContentJobOutcome {
  const finalMessage = validateFinalMessage(input.result, input.mode);
  const actions = validateActions(input.result, input.mode);
  const documentReferences = actions.documentReferences;
  const modeReviewIssues = documentReferences.length === 0
    ? []
    : input.mode === 'review'
      ? [`REVIEW_UNEXPECTED_DOCUMENT_REFERENCE: ${documentReferences.length} document reference${documentReferences.length === 1 ? '' : 's'} returned for a zero-write review.`]
      : input.mode === 'report'
        ? [`REPORT_UNEXPECTED_DOCUMENT_REFERENCE: ${documentReferences.length} document reference${documentReferences.length === 1 ? '' : 's'} returned for a no-write narrative report.`]
        : [];
  const safeChatUrl = validateOmniChatUrl(input.baseUrl, resultChatFrom(input.result))
    || validateOmniChatUrl(input.baseUrl, input.chatUrl || '');
  const actionReviewIssues = Array.from(new Set([
    ...projectedReviewIssues(input.result),
    ...actions.reviewIssues,
    ...finalMessage.reviewIssues,
    ...modeReviewIssues,
  ]));
  const creationStatusUnverified = (input.mode === 'dashboard' || input.mode === 'app')
    && actionReviewIssues.some(isCreationStatusUnverifiedIssue);
  return {
    jobId: input.jobId,
    state: 'COMPLETE',
    message: finalMessage.message,
    actionSummaries: actions.summaries,
    conversationId: boundedString(input.conversationId, 200),
    chatUrl: safeChatUrl,
    documentReferences,
    artifactState: documentReferences.length > 0
      ? 'returned-unverified'
      : creationStatusUnverified
        ? 'creation-status-unverified'
        : actions.expectedCreationActionObserved
          ? 'reported-created-unverified'
          : 'not-returned',
    actionReviewIssues,
  };
}

function validatedCompletedOutcome(input: {
  baseUrl: string;
  jobId: string;
  mode: AIContentAgentMode;
  result: OmniAiContentStudioJobResult;
  conversationId?: string;
  chatUrl?: string;
}): AIContentJobOutcome {
  const trustedChatUrl = validateOmniChatUrl(input.baseUrl, resultChatFrom(input.result))
    || validateOmniChatUrl(input.baseUrl, input.chatUrl || '');
  try {
    return completedOutcomeFromResult(input);
  } catch (error) {
    if (error instanceof AIContentCompletedResultValidationError) throw error;
    throw new AIContentCompletedResultValidationError(
      input.jobId,
      trustedChatUrl,
      error instanceof Error ? error.message : 'The returned result did not pass local validation.',
    );
  }
}

/**
 * Re-reads and validates the result of one already-COMPLETE AI Content Studio
 * job. This recovery path performs one result-only transport operation and
 * never creates, polls, cancels, or resubmits a job. The HTTP reader may apply
 * bounded idempotent retries for transient read failures.
 */
export async function recoverCompletedAIContentJob(
  input: RecoverCompletedAIContentJobInput,
): Promise<AIContentJobOutcome> {
  const jobId = boundedString(input.jobId, 200);
  if (!jobId) throw new AIContentJobError('A completed Omni AI job ID is required for result recovery.');
  const trustedChatUrl = validateOmniChatUrl(input.baseUrl, input.chatUrl || '');
  let result: OmniAiContentStudioJobResult;
  try {
    result = await (input.transport || defaultTransport).getResult(
      input.baseUrl,
      input.apiKey,
      jobId,
      input.signal,
    );
  } catch (error) {
    if (isResultContractMismatch(error)) {
      throw new AIContentResultContractMismatchError(jobId, trustedChatUrl);
    }
    throw error;
  }
  return validatedCompletedOutcome({
    baseUrl: input.baseUrl,
    jobId,
    mode: input.mode,
    result,
    conversationId: input.conversationId,
    chatUrl: trustedChatUrl,
  });
}

export async function runAIContentJob(input: RunAIContentJobInput): Promise<AIContentJobOutcome> {
  input.onProgress?.('Submitting one AI job to Omni…');
  const transport = input.transport || defaultTransport;
  const pollIntervalMs = input.pollIntervalMs ?? POLL_INTERVAL_MS;
  let lastConversationId = '';
  let lastChatUrl = '';
  let lifecycle;
  try {
    lifecycle = await runAsyncJobLifecycle({
      connection: { baseUrl: input.baseUrl, apiKey: input.apiKey },
      createInput: {
        modelId: input.modelId,
        prompt: input.prompt,
        topicName: input.topicName || undefined,
        attachments: input.attachments.map((attachment) => ({
          data: attachment.data,
          mimeType: attachment.contentType,
          name: attachment.name,
        })),
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
        cancel: async (connection, jobId, signal) => {
          const cancelled = await transport.cancelJob(
            connection.baseUrl,
            connection.apiKey,
            jobId,
            signal,
          );
          if (strictState(cancelled) !== 'CANCELLED') {
            throw new AIContentJobError('Omni did not confirm the AI job cancellation.');
          }
          return cancelled;
        },
      },
      getJobId: (job) => boundedString(job.jobId, 200),
      getState: strictState,
      isTerminalState: (state) => TERMINAL_STATES.has(state),
      isSuccessfulState: (state) => state === 'COMPLETE',
      isResultReady: () => true,
      isCreateAcceptanceUnknown: isAmbiguousCreateFailure,
      shouldRetryRead: isRetryableAiJobReadError,
      signal: input.signal,
      scope: input.scope,
      // The page owns explicit caller cancellation so it can preserve a failed
      // confirmation as a reconciliation hold. Stale scope and deadline stops
      // still cancel here through the original strict tenant transport.
      cancelOnCallerAbort: false,
      deadlineMs: input.deadlineMs ?? OVERALL_DEADLINE_MS,
      pollIntervalMs,
      maxPollAttempts: MAX_POLLS,
      maxConsecutivePollFailures: MAX_CONSECUTIVE_POLL_FAILURES,
      resultRetryIntervalMs: 1_000,
      maxResultAttempts: MAX_RESULT_ATTEMPTS,
      onCreated: (jobId, created) => {
        lastConversationId = conversationFrom(created);
        lastChatUrl = validateOmniChatUrl(input.baseUrl, chatFrom(created));
        input.onJobCreated?.(jobId, lastChatUrl || undefined);
      },
      onPoll: (attempt, latest) => {
        lastConversationId = conversationFrom(latest) || lastConversationId;
        lastChatUrl = validateOmniChatUrl(input.baseUrl, chatFrom(latest)) || lastChatUrl;
        input.onProgress?.(`Omni is working… ${Math.floor((attempt * pollIntervalMs) / 1_000)}s`);
      },
      onTerminal: (terminalJobId, state, latest) => {
        lastConversationId = conversationFrom(latest) || lastConversationId;
        lastChatUrl = validateOmniChatUrl(input.baseUrl, chatFrom(latest)) || lastChatUrl;
        input.onTerminal?.(state, terminalJobId, lastChatUrl || undefined);
      },
      onPollRetry: () => input.onProgress?.('Omni job status is temporarily unavailable. Retrying the read…'),
      onResultRetry: () => input.onProgress?.('The job is complete. Waiting for the structured response…'),
    });
  } catch (error) {
    if (error instanceof AsyncJobCreateAcceptanceUnknownError) {
      const underlying = error.underlyingError;
      if (underlying instanceof ApiError && !isAmbiguousCreateFailure(underlying)) throw underlying;
      throw new AIContentCreateAcceptanceUnknownError();
    }
    if (error instanceof AsyncJobCancelledError || error instanceof AsyncJobStaleScopeError) {
      throw new DOMException(
        error instanceof AsyncJobStaleScopeError
          ? 'The AI content job was cancelled because its scope changed.'
          : 'The AI content job was cancelled.',
        'AbortError',
      );
    }
    if (error instanceof AsyncJobDeadlineError) {
      throw new AIContentUnresolvedJobError(
        'Omni is still working after four minutes. OmniKit requested cancellation and did not resubmit this job.',
        error.jobId,
        lastChatUrl,
        'timeout',
      );
    }
    if (error instanceof AsyncJobTerminalStateError) {
      throw new AIContentTerminalJobError(
        error.jobId,
        lastChatUrl,
        error.state as 'FAILED' | 'CANCELLED',
      );
    }
    if (error instanceof AsyncJobReadUnavailableError) {
      if (error.phase === 'result' && isResultContractMismatch(error.underlyingError)) {
        throw new AIContentResultContractMismatchError(error.jobId, lastChatUrl);
      }
      throw new AIContentUnresolvedJobError(
        error.phase === 'poll'
          ? 'Omni job status could not be confirmed. Check the job in Omni before retrying.'
          : 'Omni completed the job, but its structured result could not be read. Check the job in Omni before retrying.',
        error.jobId,
        lastChatUrl,
        error.phase === 'poll' ? 'poll-unavailable' : 'result-unavailable',
      );
    }
    throw error;
  }
  const { created, terminalJob: latest, result, jobId } = lifecycle;
  const conversationId = conversationFrom(latest) || conversationFrom(created) || lastConversationId;
  const chatUrl = validateOmniChatUrl(input.baseUrl, chatFrom(latest))
    || validateOmniChatUrl(input.baseUrl, chatFrom(created))
    || lastChatUrl;
  input.onProgress?.('Checking Omni’s structured response…');
  return validatedCompletedOutcome({
    baseUrl: input.baseUrl,
    jobId,
    mode: input.mode,
    result,
    conversationId,
    chatUrl,
  });
}

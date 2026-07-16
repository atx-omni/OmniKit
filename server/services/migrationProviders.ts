import { assertSafeOutboundUrl } from '../security';
import { redactSensitiveText } from './jobSanitizer';
import { OmniClient } from './omniClient';
import { assertMigrationProviderAllowed, migrationProviderHostAllowlist } from './semanticMigrationAudit';
import {
  getInstance,
  type MigrationProviderKind,
  type SavedLlmProvider,
} from './nativeVault';

const REQUEST_TIMEOUT_MS = 45_000;
const OMNI_POLL_INTERVAL_MS = 1_000;
const OMNI_POLL_LIMIT = 90;
const MAX_CONCURRENT_PER_PROVIDER = 2;
const CIRCUIT_FAILURE_LIMIT = 5;
const CIRCUIT_OPEN_MS = 60_000;

interface ProviderRuntimeState {
  active: number;
  failures: number;
  openedUntil: number;
}

const providerRuntime = new Map<string, ProviderRuntimeState>();

export interface ProviderCapabilities {
  structuredOutput: boolean;
  toolUse: boolean;
  cancellation: boolean;
  modelDiscovery: boolean;
  usageReporting: boolean;
  supportedTasks: MigrationAiTask[];
  limitations: string[];
}

export type MigrationAiTask = 'classify_inventory' | 'propose_mappings' | 'translate_expression' | 'draft_semantic_patch' | 'draft_content_spec' | 'explain_exception' | 'generate_validation_sql' | 'evaluate_reconciliation';

export interface StructuredGenerationInput {
  task: MigrationAiTask;
  system: string;
  prompt: string;
  schemaName: string;
  schema: Record<string, unknown>;
  targetModelId?: string;
}

export interface StructuredGenerationResult {
  providerKind: MigrationProviderKind;
  model: string;
  output: unknown;
  rawText: string;
  usage?: Record<string, number>;
}

const GENERATION_TASKS: MigrationAiTask[] = ['classify_inventory', 'propose_mappings', 'translate_expression', 'draft_semantic_patch', 'draft_content_spec', 'explain_exception', 'generate_validation_sql', 'evaluate_reconciliation'];
const CAPABILITIES: Record<MigrationProviderKind, ProviderCapabilities> = {
  omni_ai: { structuredOutput: false, toolUse: true, cancellation: true, modelDiscovery: false, usageReporting: false, supportedTasks: GENERATION_TASKS, limitations: ['Structured output is validated after the Omni AI job completes.'] },
  openai: { structuredOutput: true, toolUse: true, cancellation: false, modelDiscovery: true, usageReporting: true, supportedTasks: GENERATION_TASKS, limitations: [] },
  anthropic: { structuredOutput: true, toolUse: true, cancellation: false, modelDiscovery: true, usageReporting: true, supportedTasks: GENERATION_TASKS, limitations: [] },
  snowflake_cortex: { structuredOutput: true, toolUse: false, cancellation: false, modelDiscovery: false, usageReporting: true, supportedTasks: GENERATION_TASKS, limitations: ['Model availability depends on the Snowflake account and region.'] },
  databricks_genie: { structuredOutput: false, toolUse: false, cancellation: false, modelDiscovery: true, usageReporting: false, supportedTasks: ['generate_validation_sql', 'evaluate_reconciliation', 'explain_exception'], limitations: ['Genie does not translate arbitrary BI metadata or generate Omni semantic/content packages.'] },
  databricks_model_serving: { structuredOutput: true, toolUse: true, cancellation: false, modelDiscovery: false, usageReporting: true, supportedTasks: GENERATION_TASKS, limitations: ['Legacy vault profile; create new profiles with a supported public option.'] },
  custom_openai_compatible: { structuredOutput: true, toolUse: true, cancellation: false, modelDiscovery: false, usageReporting: true, supportedTasks: GENERATION_TASKS, limitations: ['Legacy vault profile; create new profiles with a supported public option.'] },
};

export function providerCapabilities(kind: MigrationProviderKind): ProviderCapabilities {
  const capabilities = CAPABILITIES[kind];
  return { ...capabilities, supportedTasks: [...capabilities.supportedTasks], limitations: [...capabilities.limitations] };
}

export function providerSupportsTask(kind: MigrationProviderKind, task: MigrationAiTask): boolean {
  return CAPABILITIES[kind].supportedTasks.includes(task);
}

function cleanBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function providerBaseUrl(provider: SavedLlmProvider): string {
  if (provider.baseUrl) return cleanBaseUrl(provider.baseUrl);
  if (provider.kind === 'openai') return 'https://api.openai.com/v1';
  if (provider.kind === 'anthropic') return 'https://api.anthropic.com/v1';
  throw Object.assign(new Error('Provider base URL is required.'), { statusCode: 400 });
}

function endpointFor(provider: SavedLlmProvider): string {
  const base = providerBaseUrl(provider);
  if (provider.kind === 'anthropic') return `${base}/messages`;
  if (provider.kind === 'snowflake_cortex') return `${base}/api/v2/cortex/inference:complete`;
  if (provider.kind === 'databricks_model_serving') {
    return `${base}/serving-endpoints/${encodeURIComponent(provider.model)}/invocations`;
  }
  return `${base}/chat/completions`;
}

function parseJsonText(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
    if (fenced) {
      try { return JSON.parse(fenced); } catch { /* handled below */ }
    }
  }
  throw Object.assign(new Error('The AI provider did not return valid structured JSON.'), { statusCode: 502 });
}

function numericUsage(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).flatMap(([key, item]) => typeof item === 'number' && Number.isFinite(item) ? [[key, item] as const] : []);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function openAiText(payload: unknown): string {
  const root = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const first = choices[0] && typeof choices[0] === 'object' ? choices[0] as Record<string, unknown> : {};
  const message = first.message && typeof first.message === 'object' ? first.message as Record<string, unknown> : {};
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content.flatMap((item) => item && typeof item === 'object' && typeof (item as Record<string, unknown>).text === 'string'
      ? [(item as Record<string, unknown>).text as string]
      : []).join('\n');
  }
  return '';
}

function anthropicText(payload: unknown): string {
  const root = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  const content = Array.isArray(root.content) ? root.content : [];
  const toolInput = content.find((item) => item && typeof item === 'object' && (item as Record<string, unknown>).type === 'tool_use');
  if (toolInput && typeof toolInput === 'object') return JSON.stringify((toolInput as Record<string, unknown>).input ?? {});
  return content.flatMap((item) => item && typeof item === 'object' && typeof (item as Record<string, unknown>).text === 'string'
    ? [(item as Record<string, unknown>).text as string]
    : []).join('\n');
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function firstString(value: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return '';
}

function genieMessageContent(payload: unknown): { text: string; sql: string } {
  const root = asRecord(payload);
  const attachments = Array.isArray(root.attachments) ? root.attachments : [];
  let text = firstString(root, ['content', 'message', 'answer', 'description']);
  let sql = '';
  for (const attachmentValue of attachments) {
    const attachment = asRecord(attachmentValue);
    const query = asRecord(attachment.query);
    const textAttachment = asRecord(attachment.text);
    sql ||= firstString(query, ['query', 'sql', 'statement']);
    text ||= firstString(textAttachment, ['content', 'text']) || firstString(attachment, ['content', 'text']);
  }
  return { text, sql };
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  await assertSafeOutboundUrl(url, { label: 'AI provider URL', allowlist: migrationProviderHostAllowlist() });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, redirect: 'manual', signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      throw Object.assign(new Error(`AI provider returned ${response.status}: ${redactSensitiveText(text.slice(0, 500) || response.statusText)}`), { statusCode: 502 });
    }
    if (!text) return {};
    try { return JSON.parse(text); } catch { return { content: text }; }
  } finally {
    clearTimeout(timeout);
  }
}

async function generateWithAnthropic(provider: SavedLlmProvider, input: StructuredGenerationInput): Promise<StructuredGenerationResult> {
  const payload = await fetchJson(endpointFor(provider), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': provider.credential,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: provider.model,
      max_tokens: 8192,
      system: input.system,
      messages: [{ role: 'user', content: input.prompt }],
      tools: [{ name: input.schemaName, description: 'Return the reviewed semantic migration proposal.', input_schema: input.schema }],
      tool_choice: { type: 'tool', name: input.schemaName },
    }),
  });
  const rawText = anthropicText(payload);
  const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  return { providerKind: provider.kind, model: provider.model, rawText, output: parseJsonText(rawText), usage: numericUsage(root.usage) };
}

async function generateWithOpenAiCompatible(provider: SavedLlmProvider, input: StructuredGenerationInput): Promise<StructuredGenerationResult> {
  const payload = await fetchJson(endpointFor(provider), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.credential}` },
    body: JSON.stringify({
      model: provider.kind === 'databricks_model_serving' ? undefined : provider.model,
      messages: [
        { role: 'system', content: input.system },
        { role: 'user', content: input.prompt },
      ],
      temperature: 0,
      response_format: {
        type: 'json_schema',
        json_schema: { name: input.schemaName, strict: true, schema: input.schema },
      },
    }),
  });
  const rawText = openAiText(payload);
  const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  return { providerKind: provider.kind, model: provider.model, rawText, output: parseJsonText(rawText), usage: numericUsage(root.usage) };
}

async function generateWithSnowflake(provider: SavedLlmProvider, input: StructuredGenerationInput): Promise<StructuredGenerationResult> {
  const payload = await fetchJson(endpointFor(provider), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.credential}` },
    body: JSON.stringify({
      model: provider.model,
      messages: [
        { role: 'system', content: input.system },
        { role: 'user', content: input.prompt },
      ],
      response_format: { type: 'json', schema: input.schema },
    }),
  });
  const rawText = openAiText(payload) || JSON.stringify(payload);
  const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  return { providerKind: provider.kind, model: provider.model, rawText, output: parseJsonText(rawText), usage: numericUsage(root.usage) };
}

async function generateWithOmni(provider: SavedLlmProvider, input: StructuredGenerationInput): Promise<StructuredGenerationResult> {
  const instance = provider.linkedInstanceId ? getInstance(provider.linkedInstanceId) : undefined;
  if (!instance) throw Object.assign(new Error('The Omni AI provider no longer references a saved instance.'), { statusCode: 400 });
  if (!input.targetModelId) throw Object.assign(new Error('A target Omni model is required for Omni AI.'), { statusCode: 400 });
  const client = new OmniClient(instance);
  const created = await client.createAiJob({
    modelId: input.targetModelId,
    prompt: `${input.system}\n\n${input.prompt}\n\nReturn JSON matching this schema exactly:\n${JSON.stringify(input.schema)}`,
  });
  let state = (created.status || '').toUpperCase();
  for (let attempt = 0; attempt < OMNI_POLL_LIMIT && !['COMPLETE', 'COMPLETED', 'SUCCESS', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'CANCELED'].includes(state); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, OMNI_POLL_INTERVAL_MS));
    state = ((await client.getAiJob(created.id)).status || '').toUpperCase();
  }
  if (!['COMPLETE', 'COMPLETED', 'SUCCESS', 'SUCCEEDED'].includes(state)) {
    throw Object.assign(new Error(`Omni AI job ended in state ${state || 'unknown'}.`), { statusCode: 502 });
  }
  const result = await client.getAiJobResult(created.id);
  const resultRecord = result && typeof result === 'object' ? result as Record<string, unknown> : {};
  const rawText = typeof resultRecord.message === 'string' ? resultRecord.message : '';
  return { providerKind: provider.kind, model: provider.model, rawText, output: parseJsonText(rawText) };
}

async function generateWithGenie(provider: SavedLlmProvider, input: StructuredGenerationInput): Promise<StructuredGenerationResult> {
  const base = providerBaseUrl(provider);
  const spaceId = provider.model.trim();
  if (!spaceId) throw Object.assign(new Error('A Databricks Genie Space ID is required.'), { statusCode: 400 });
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.credential}` };
  const started = asRecord(await fetchJson(`${base}/api/2.0/genie/spaces/${encodeURIComponent(spaceId)}/start-conversation`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ content: `${input.system}\n\n${input.prompt}` }),
  }));
  const conversationId = firstString(started, ['conversation_id', 'conversationId']);
  const messageId = firstString(started, ['message_id', 'messageId']);
  if (!conversationId || !messageId) {
    throw Object.assign(new Error('Databricks Genie did not return conversation and message identifiers.'), { statusCode: 502 });
  }

  let message: Record<string, unknown> = started;
  for (let attempt = 0; attempt < OMNI_POLL_LIMIT; attempt += 1) {
    const status = firstString(message, ['status', 'state']).toUpperCase();
    if (['COMPLETED', 'COMPLETE', 'SUCCEEDED', 'SUCCESS', 'FAILED', 'CANCELLED', 'CANCELED'].includes(status)) break;
    await new Promise((resolve) => setTimeout(resolve, OMNI_POLL_INTERVAL_MS));
    message = asRecord(await fetchJson(`${base}/api/2.0/genie/spaces/${encodeURIComponent(spaceId)}/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`, {
      method: 'GET',
      headers,
    }));
  }
  const status = firstString(message, ['status', 'state']).toUpperCase();
  if (['FAILED', 'CANCELLED', 'CANCELED'].includes(status)) {
    throw Object.assign(new Error(`Databricks Genie validation ended in state ${status.toLowerCase()}.`), { statusCode: 502 });
  }
  const content = genieMessageContent(message);
  if (!content.text && !content.sql) throw Object.assign(new Error('Databricks Genie completed without validation text or SQL.'), { statusCode: 502 });
  const output = {
    message: content.text || 'Databricks Genie generated validation SQL.',
    sql: content.sql || undefined,
    conversationId,
    messageId,
  };
  return { providerKind: provider.kind, model: provider.model, rawText: JSON.stringify(output), output };
}

async function dispatchStructuredProposal(provider: SavedLlmProvider, input: StructuredGenerationInput): Promise<StructuredGenerationResult> {
  assertMigrationProviderAllowed(provider.kind);
  if (!provider.enabled) throw Object.assign(new Error('This AI provider is disabled.'), { statusCode: 409 });
  if (!providerSupportsTask(provider.kind, input.task)) throw Object.assign(new Error(`${provider.kind} does not support the ${input.task} migration task.`), { statusCode: 409 });
  if (provider.kind === 'databricks_genie') return generateWithGenie(provider, input);
  if (provider.kind === 'omni_ai') return generateWithOmni(provider, input);
  if (provider.kind === 'anthropic') return generateWithAnthropic(provider, input);
  if (provider.kind === 'snowflake_cortex') return generateWithSnowflake(provider, input);
  return generateWithOpenAiCompatible(provider, input);
}

export async function generateStructuredProposal(provider: SavedLlmProvider, input: StructuredGenerationInput): Promise<StructuredGenerationResult> {
  const state = providerRuntime.get(provider.id) || { active: 0, failures: 0, openedUntil: 0 };
  if (state.openedUntil > Date.now()) {
    throw Object.assign(new Error('This AI provider circuit is temporarily open after repeated failures. Retry in one minute.'), { statusCode: 503 });
  }
  if (state.active >= MAX_CONCURRENT_PER_PROVIDER) {
    throw Object.assign(new Error('This AI provider already has the maximum number of active migration requests.'), { statusCode: 429 });
  }
  state.active += 1;
  providerRuntime.set(provider.id, state);
  try {
    const result = await dispatchStructuredProposal(provider, input);
    state.failures = 0;
    state.openedUntil = 0;
    return result;
  } catch (error) {
    state.failures += 1;
    if (state.failures >= CIRCUIT_FAILURE_LIMIT) state.openedUntil = Date.now() + CIRCUIT_OPEN_MS;
    throw error;
  } finally {
    state.active = Math.max(0, state.active - 1);
    providerRuntime.set(provider.id, state);
  }
}

export function resetMigrationProviderRuntimeForTests(): void {
  providerRuntime.clear();
}

export async function testLlmProvider(provider: SavedLlmProvider): Promise<{ ok: true; model: string; capabilities: ProviderCapabilities }> {
  if (provider.kind === 'databricks_genie') {
    const base = providerBaseUrl(provider);
    await fetchJson(`${base}/api/2.0/genie/spaces`, { method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${provider.credential}` } });
    return { ok: true, model: provider.model, capabilities: providerCapabilities(provider.kind) };
  }
  await generateStructuredProposal(provider, {
    task: 'classify_inventory',
    system: 'You are testing an enterprise semantic migration provider connection.',
    prompt: 'Return {"ok":true}. Do not include any other content.',
    schemaName: 'connection_test',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
    },
    targetModelId: provider.kind === 'omni_ai' ? provider.model : undefined,
  });
  return { ok: true, model: provider.model, capabilities: providerCapabilities(provider.kind) };
}

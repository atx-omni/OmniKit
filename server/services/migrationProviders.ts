import { assertSafeOutboundUrl } from '../security';
import { redactSensitiveText } from './jobSanitizer';
import { OmniClient } from './omniClient';
import { assertMigrationProviderAllowed, migrationProviderHostAllowlist } from './semanticMigrationAudit';
import {
  SemanticMigrationContractError,
  assertSemanticMigrationStageIsolation,
  assertSemanticMigrationStageOutput,
  semanticMigrationStageContract,
  type SemanticMigrationContractValidationContext,
  type SemanticMigrationStageContractId,
} from '../../src/services/semanticMigration/contracts';
import {
  ProviderStructuredOutputError,
  parseProviderStructuredOutput,
  type ProviderStructuredOutputHandling,
} from '../../src/services/semanticMigration/providerOutput';
import {
  getInstance,
  migrationProviderAuthModeAllowed,
  type MigrationProviderAuthMode,
  type MigrationProviderKind,
  type SavedLlmProvider,
} from './nativeVault';

const REQUEST_TIMEOUT_MS = 45_000;
const MAX_PROVIDER_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_PROVIDER_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 10_000;
const OMNI_POLL_INTERVAL_MS = 1_000;
const OMNI_POLL_LIMIT = 300;
const MAX_CONCURRENT_PER_PROVIDER = 2;
const CIRCUIT_FAILURE_LIMIT = 5;
const CIRCUIT_OPEN_MS = 60_000;
const PROVIDER_SCHEMA_NAME_MAX_LENGTH = 64;
const MAX_PROVIDER_SCHEMA_BYTES = 256 * 1024;
const MAX_PROVIDER_SCHEMA_DEPTH = 32;
const MAX_PROVIDER_SCHEMA_NODES = 10_000;
const MAX_GENIE_RESULT_COLUMNS = 100;
const MAX_GENIE_RESULT_ROWS = 100;
const MAX_GENIE_CELL_CHARACTERS = 4_096;

interface ProviderRuntimeState {
  active: number;
  failures: number;
  openedUntil: number;
  halfOpenProbe: boolean;
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
  branchId?: string;
  semanticMigrationContract?: {
    id: SemanticMigrationStageContractId;
    validationContext: SemanticMigrationContractValidationContext;
  };
}

export interface StructuredGenerationResult {
  providerKind: MigrationProviderKind;
  model: string;
  output: unknown;
  rawText: string;
  usage?: Record<string, number>;
  outputHandling?: ProviderStructuredOutputHandling;
  telemetry?: ProviderExecutionTelemetry;
}

export interface ProviderExecutionTelemetry {
  durationMs: number;
  providerAttempts: number;
  providerRequests: number;
  providerRetries: number;
  requestId?: string;
  modelVersion?: string;
}

export interface ProviderExecutionContext {
  signal?: AbortSignal;
  registerUpstreamCancellation?: (cancel: () => void | Promise<void>) => void;
}

export class MigrationProviderRequestError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly retryable: boolean;
  readonly upstreamStatus?: number;
  readonly requestId?: string;
  readonly retryAfterMs?: number;
  attempts = 1;

  constructor(input: {
    message: string;
    code: string;
    statusCode: number;
    retryable: boolean;
    upstreamStatus?: number;
    requestId?: string;
    retryAfterMs?: number;
  }) {
    super(input.message);
    this.name = 'MigrationProviderRequestError';
    this.code = input.code;
    this.statusCode = input.statusCode;
    this.retryable = input.retryable;
    this.upstreamStatus = input.upstreamStatus;
    this.requestId = input.requestId;
    this.retryAfterMs = input.retryAfterMs;
  }
}

export function normalizeStructuredGenerationInput(input: StructuredGenerationInput): StructuredGenerationInput {
  if (!input.semanticMigrationContract) return input;
  const contract = semanticMigrationStageContract(input.semanticMigrationContract.id);
  if (contract.stage === 'compile' || contract.stage === 'repair') {
    assertSemanticMigrationStageIsolation(contract.stage, { system: input.system, prompt: input.prompt });
  }
  return {
    ...input,
    schemaName: contract.schemaName,
    schema: contract.schema,
  };
}

export function postValidateStructuredGenerationResult(
  input: StructuredGenerationInput,
  result: StructuredGenerationResult,
): StructuredGenerationResult {
  if (!input.semanticMigrationContract) return result;
  return {
    ...result,
    output: assertSemanticMigrationStageOutput(
      input.semanticMigrationContract.id,
      result.output,
      input.semanticMigrationContract.validationContext,
    ),
  };
}

export class SemanticMigrationCompileOutputError extends Error {
  readonly code: 'SEMANTIC_COMPILE_OUTPUT_INVALID' | 'SEMANTIC_REPAIR_OUTPUT_INVALID';
  readonly statusCode = 502;
  readonly retryable = true;
  readonly stage: 'compile' | 'repair';
  readonly attempts: number;

  constructor(stage: 'compile' | 'repair', attempts: number, finalError: unknown) {
    const finalIssue = finalError instanceof SemanticMigrationContractError
      ? `${finalError.issues.length} contract validation issue${finalError.issues.length === 1 ? '' : 's'} remained.`
      : finalError instanceof ProviderStructuredOutputError
        ? finalError.message
        : 'The final provider response was not valid structured output.';
    const label = stage === 'compile' ? 'Semantic compile' : 'Semantic repair';
    super(
      `${label} stopped because the AI provider returned unusable structured output on ${attempts} attempts. `
      + `OmniKit discarded the responses without creating semantic files. Retry this ${stage} step; if it fails again, reduce the selected scope or choose another generation provider. `
      + `Final issue: ${finalIssue}`,
    );
    this.name = 'SemanticMigrationCompileOutputError';
    this.code = stage === 'compile' ? 'SEMANTIC_COMPILE_OUTPUT_INVALID' : 'SEMANTIC_REPAIR_OUTPUT_INVALID';
    this.stage = stage;
    this.attempts = attempts;
  }
}

function retryableSemanticStage(input: StructuredGenerationInput): 'compile' | 'repair' | undefined {
  if (!input.semanticMigrationContract) return undefined;
  const stage = semanticMigrationStageContract(input.semanticMigrationContract.id).stage;
  return stage === 'compile' || stage === 'repair' ? stage : undefined;
}

function structuredOutputFailure(error: unknown): boolean {
  return error instanceof ProviderStructuredOutputError || error instanceof SemanticMigrationContractError;
}

function structuredOutputRetryInput(
  input: StructuredGenerationInput,
  stage: 'compile' | 'repair',
): StructuredGenerationInput {
  const retrySystem = [
    input.system,
    '',
    `The previous ${stage} response failed structured-output parsing or contract validation.`,
    'This is the single bounded provider retry. Return exactly one complete JSON value matching the registered schema.',
    'Do not include markdown fences, prose outside JSON, comments, trailing commas, or literal line breaks inside JSON strings.',
    'Re-read the authoritative request payload. Do not copy or infer from the rejected response.',
  ].join('\n');
  assertSemanticMigrationStageIsolation(stage, { system: retrySystem, prompt: input.prompt });
  return { ...input, system: retrySystem };
}

export async function runStructuredGenerationWithOutputRetry(
  input: StructuredGenerationInput,
  generate: (attemptInput: StructuredGenerationInput, attempt: number) => Promise<StructuredGenerationResult>,
  options: { allowAutomaticRetry?: boolean } = {},
): Promise<StructuredGenerationResult> {
  const stage = retryableSemanticStage(input);
  const maxAttempts = stage && options.allowAutomaticRetry !== false ? 2 : 1;
  let finalError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const attemptInput = attempt === 1 || !stage ? input : structuredOutputRetryInput(input, stage);
    try {
      const validated = postValidateStructuredGenerationResult(attemptInput, await generate(attemptInput, attempt));
      const handling = validated.outputHandling || { parseMode: 'strict' as const, extracted: false, repairs: [] };
      return {
        ...validated,
        outputHandling: {
          ...handling,
          providerAttempts: attempt,
          automaticRetry: attempt > 1,
        },
      };
    } catch (error) {
      finalError = error;
      if (!stage || !structuredOutputFailure(error)) throw error;
      if (attempt === maxAttempts) break;
    }
  }

  throw new SemanticMigrationCompileOutputError(stage!, maxAttempts, finalError);
}

const GENERATION_TASKS: MigrationAiTask[] = ['classify_inventory', 'propose_mappings', 'translate_expression', 'draft_semantic_patch', 'draft_content_spec', 'explain_exception', 'generate_validation_sql', 'evaluate_reconciliation'];
const CAPABILITIES: Record<MigrationProviderKind, ProviderCapabilities> = {
  omni_ai: { structuredOutput: false, toolUse: false, cancellation: true, modelDiscovery: false, usageReporting: false, supportedTasks: GENERATION_TASKS, limitations: ['Omni AI Jobs return best-effort prompt-constrained JSON that OmniKit validates after completion.', 'Omni AI Jobs do not expose caller-defined tools or strict JSON-schema enforcement through this provider contract.'] },
  openai: { structuredOutput: true, toolUse: true, cancellation: false, modelDiscovery: false, usageReporting: true, supportedTasks: GENERATION_TASKS, limitations: ['Enter a model ID available to the saved OpenAI project; OmniKit does not enumerate project models.'] },
  anthropic: { structuredOutput: true, toolUse: true, cancellation: false, modelDiscovery: false, usageReporting: true, supportedTasks: GENERATION_TASKS, limitations: ['Enter a model ID available to the saved Anthropic workspace; OmniKit does not enumerate workspace models.'] },
  snowflake_cortex: { structuredOutput: true, toolUse: false, cancellation: false, modelDiscovery: false, usageReporting: true, supportedTasks: GENERATION_TASKS, limitations: ['Model availability depends on the Snowflake account and region.'] },
  databricks_genie: { structuredOutput: false, toolUse: false, cancellation: false, modelDiscovery: false, usageReporting: false, supportedTasks: ['generate_validation_sql', 'evaluate_reconciliation', 'explain_exception'], limitations: ['Genie does not translate arbitrary BI metadata or generate Omni semantic/content packages.', 'OmniKit permits one saved Genie profile bound to one immutable Agent/Space ID; it validates that exact resource rather than listing all spaces.'] },
  databricks_model_serving: { structuredOutput: false, toolUse: false, cancellation: false, modelDiscovery: false, usageReporting: false, supportedTasks: [], limitations: ['Retired legacy profile. Delete it and choose a supported AI engine.'] },
  custom_openai_compatible: { structuredOutput: true, toolUse: true, cancellation: false, modelDiscovery: false, usageReporting: true, supportedTasks: GENERATION_TASKS, limitations: ['Legacy vault profile; create new profiles with a supported public option.'] },
};

export function providerCapabilities(kind: MigrationProviderKind): ProviderCapabilities {
  const capabilities = CAPABILITIES[kind];
  return { ...capabilities, supportedTasks: [...capabilities.supportedTasks], limitations: [...capabilities.limitations] };
}

export function providerSupportsTask(kind: MigrationProviderKind, task: MigrationAiTask): boolean {
  return CAPABILITIES[kind].supportedTasks.includes(task);
}

function providerSchemaError(message: string, code = 'AI_PROVIDER_SCHEMA_INVALID'): MigrationProviderRequestError {
  return new MigrationProviderRequestError({
    message,
    code,
    statusCode: 400,
    retryable: false,
  });
}

export function providerSchemaName(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, PROVIDER_SCHEMA_NAME_MAX_LENGTH);
  if (!sanitized) {
    throw providerSchemaError(
      'Structured-output schema name must contain at least one letter, number, underscore, or dash.',
      'AI_PROVIDER_SCHEMA_NAME_INVALID',
    );
  }
  return sanitized;
}

export function providerGenerationSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const annotations = new Set(['$comment', 'default', 'description', 'examples', 'readOnly', 'title', 'writeOnly']);
  let nodeCount = 0;
  const normalize = (value: unknown, path: string, depth = 0, propertyMap = false): unknown => {
    nodeCount += 1;
    if (nodeCount > MAX_PROVIDER_SCHEMA_NODES) {
      throw providerSchemaError('Structured-output schema is too complex for bounded provider egress.', 'AI_PROVIDER_SCHEMA_TOO_LARGE');
    }
    if (depth > MAX_PROVIDER_SCHEMA_DEPTH) {
      throw providerSchemaError(`${path} exceeds the maximum structured-output schema depth.`, 'AI_PROVIDER_SCHEMA_TOO_DEEP');
    }
    if (Array.isArray(value)) return value.map((item, index) => normalize(item, `${path}[${index}]`, depth + 1));
    if (!value || typeof value !== 'object') return value;
    const record = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) {
      if (!propertyMap && (key === '$schema' || key === 'const' || annotations.has(key))) continue;
      normalized[key] = normalize(item, `${path}.${key}`, depth + 1, !propertyMap && key === 'properties');
    }
    if (propertyMap) return normalized;
    if (Object.prototype.hasOwnProperty.call(record, 'const')) {
      normalized.enum = [normalize(record.const, `${path}.const`, depth + 1)];
    }

    const type = normalized.type;
    const objectSchema = type === 'object'
      || (Array.isArray(type) && type.includes('object'))
      || Object.prototype.hasOwnProperty.call(normalized, 'properties');
    if (!objectSchema) return normalized;

    if (normalized.properties !== undefined && (
      !normalized.properties
      || typeof normalized.properties !== 'object'
      || Array.isArray(normalized.properties)
    )) {
      throw providerSchemaError(`${path}.properties must be an object for strict structured output.`);
    }
    if (normalized.additionalProperties !== undefined && normalized.additionalProperties !== false) {
      throw providerSchemaError(`${path}.additionalProperties must be false for strict structured output.`);
    }
    const properties = (normalized.properties || {}) as Record<string, unknown>;
    const propertyNames = Object.keys(properties);
    if (normalized.required !== undefined) {
      if (!Array.isArray(normalized.required) || normalized.required.some((item) => typeof item !== 'string')) {
        throw providerSchemaError(`${path}.required must be an array of property names.`);
      }
      const unknownRequired = normalized.required.filter((item) => !propertyNames.includes(String(item)));
      if (unknownRequired.length > 0) {
        throw providerSchemaError(`${path}.required references unknown properties: ${unknownRequired.join(', ')}.`);
      }
    }
    normalized.type ??= 'object';
    normalized.properties = properties;
    normalized.additionalProperties = false;
    normalized.required = propertyNames;
    return normalized;
  };
  const normalized = normalize(schema, 'schema') as Record<string, unknown>;
  const rootType = normalized.type;
  if (rootType !== 'object' && !(Array.isArray(rootType) && rootType.includes('object'))) {
    throw providerSchemaError('Structured-output schema root must be an object.');
  }
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > MAX_PROVIDER_SCHEMA_BYTES) {
    throw providerSchemaError('Structured-output schema exceeds the bounded provider egress limit.', 'AI_PROVIDER_SCHEMA_TOO_LARGE');
  }
  return normalized;
}

export function snowflakeAuthorizationTokenType(authMode?: MigrationProviderAuthMode): 'OAUTH' {
  if (authMode !== 'oauth_access_token') {
    throw Object.assign(new Error('Snowflake Cortex requires an OAuth access token.'), {
      statusCode: 409,
      code: 'AI_PROVIDER_AUTH_MODE_UNSUPPORTED',
    });
  }
  return 'OAUTH';
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

export function migrationProviderEndpoint(provider: SavedLlmProvider): string {
  const base = providerBaseUrl(provider);
  if (provider.kind === 'anthropic') return `${base}/messages`;
  if (provider.kind === 'snowflake_cortex') return `${base}/api/v2/cortex/v1/chat/completions`;
  if (provider.kind === 'openai' || provider.kind === 'custom_openai_compatible') return `${base}/chat/completions`;
  throw Object.assign(new Error('This AI provider does not expose a supported generation endpoint.'), {
    statusCode: 410,
    code: 'AI_PROVIDER_RETIRED',
  });
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

function genieMessageContent(payload: unknown): { text: string; sql: string; queryAttachmentIds: string[]; trustedAsset: boolean } {
  const root = asRecord(payload);
  const attachments = Array.isArray(root.attachments) ? root.attachments : [];
  let text = '';
  let sql = '';
  const queryAttachmentIds: string[] = [];
  let trustedAsset = false;
  for (const attachmentValue of attachments) {
    const attachment = asRecord(attachmentValue);
    const query = asRecord(attachment.query);
    const textAttachment = asRecord(attachment.text);
    const attachmentId = firstString(attachment, ['attachment_id', 'attachmentId']);
    if (attachmentId && Object.keys(query).length > 0) queryAttachmentIds.push(attachmentId);
    if (query.parameters && typeof query.parameters === 'object') trustedAsset = true;
    sql ||= firstString(query, ['query', 'sql', 'statement']);
    text ||= firstString(textAttachment, ['content', 'text']) || firstString(attachment, ['content', 'text']);
  }
  return { text, sql, queryAttachmentIds: [...new Set(queryAttachmentIds)], trustedAsset };
}

interface NormalizedGenieColumn {
  name: string;
  type?: string;
}

interface NormalizedGenieQueryResult {
  attachmentId: string;
  statementId?: string;
  state: 'SUCCEEDED';
  columns: NormalizedGenieColumn[];
  rows: Array<Array<string | number | boolean | null>>;
  rowCount: number;
  returnedRowCount: number;
  truncated: boolean;
  providerTruncated: boolean;
  locallyTruncated: boolean;
}

function firstNonNegativeInteger(...values: unknown[]): number | undefined {
  for (const value of values) {
    const numeric = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
    if (Number.isFinite(numeric) && numeric >= 0) return Math.floor(numeric);
  }
  return undefined;
}

function firstBoolean(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  return undefined;
}

function normalizeGenieQueryResult(payload: unknown, attachmentId: string): NormalizedGenieQueryResult {
  const root = asRecord(payload);
  const statement = Object.keys(asRecord(root.statement_response)).length > 0
    ? asRecord(root.statement_response)
    : Object.keys(asRecord(root.statementResponse)).length > 0
      ? asRecord(root.statementResponse)
      : root;
  const status = asRecord(statement.status);
  const state = (firstString(status, ['state', 'status']) || firstString(statement, ['state'])).toUpperCase();
  if (state !== 'SUCCEEDED') {
    const failed = ['FAILED', 'CANCELED', 'CANCELLED', 'CLOSED'].includes(state);
    throw new MigrationProviderRequestError({
      message: state
        ? `Databricks Genie query result ended in state ${state.toLowerCase()}.`
        : 'Databricks Genie query result did not include a terminal statement state.',
      code: failed ? 'AI_PROVIDER_QUERY_FAILED' : state ? 'AI_PROVIDER_QUERY_RESULT_INCOMPLETE' : 'AI_PROVIDER_QUERY_RESULT_STATE_MISSING',
      statusCode: 502,
      retryable: false,
    });
  }

  const manifest = asRecord(statement.manifest);
  const manifestSchema = asRecord(manifest.schema);
  const result = asRecord(statement.result);
  const rawRowsValue = result.data_array ?? result.dataArray ?? root.data_array ?? root.rows;
  const rawRows = Array.isArray(rawRowsValue) ? rawRowsValue : [];
  const rawColumnsValue = manifestSchema.columns ?? manifest.columns ?? root.columns;
  const rawColumns = Array.isArray(rawColumnsValue) ? rawColumnsValue : [];
  const objectRowKeys = rawRows.find((row) => row && typeof row === 'object' && !Array.isArray(row));
  const firstArrayWidth = rawRows.reduce((width, row) => Array.isArray(row) ? Math.max(width, row.length) : width, 0);
  const objectKeys = objectRowKeys ? Object.keys(asRecord(objectRowKeys)) : [];
  const columnCount = Math.min(MAX_GENIE_RESULT_COLUMNS, Math.max(rawColumns.length, firstArrayWidth, objectKeys.length));
  const columns: NormalizedGenieColumn[] = Array.from({ length: columnCount }, (_, index) => {
    const rawColumn = asRecord(rawColumns[index]);
    const name = (firstString(rawColumn, ['name', 'column_name', 'columnName']) || objectKeys[index] || `column_${index + 1}`).slice(0, 256);
    const type = firstString(rawColumn, ['type_name', 'type_text', 'typeName', 'type']);
    return { name, ...(type ? { type: type.slice(0, 128) } : {}) };
  });

  let cellTruncated = false;
  const normalizeCell = (value: unknown): string | number | boolean | null => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    const normalized = typeof text === 'string' ? text : String(value);
    if (normalized.length > MAX_GENIE_CELL_CHARACTERS) cellTruncated = true;
    return normalized.slice(0, MAX_GENIE_CELL_CHARACTERS);
  };
  const rows = rawRows.slice(0, MAX_GENIE_RESULT_ROWS).map((row) => {
    const values = Array.isArray(row)
      ? row
      : columns.map((column) => asRecord(row)[column.name]);
    if (values.length > MAX_GENIE_RESULT_COLUMNS) cellTruncated = true;
    return values.slice(0, MAX_GENIE_RESULT_COLUMNS).map(normalizeCell);
  });
  const rowCount = firstNonNegativeInteger(
    manifest.total_row_count,
    manifest.totalRowCount,
    result.row_count,
    result.rowCount,
    root.row_count,
    root.rowCount,
  ) ?? rawRows.length;
  const providerTruncated = firstBoolean(manifest.truncated, result.truncated, root.is_truncated, root.truncated) === true;
  const locallyTruncated = rawColumns.length > MAX_GENIE_RESULT_COLUMNS
    || rawRows.length > MAX_GENIE_RESULT_ROWS
    || rowCount > rows.length
    || cellTruncated;
  return {
    attachmentId,
    statementId: firstString(statement, ['statement_id', 'statementId']) || undefined,
    state: 'SUCCEEDED',
    columns,
    rows,
    rowCount,
    returnedRowCount: rows.length,
    truncated: providerTruncated || locallyTruncated,
    providerTruncated,
    locallyTruncated,
  };
}

interface ProviderFetchResult {
  payload: unknown;
  attempts: number;
  durationMs: number;
  requestId?: string;
}

function retryableProviderStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function providerOutboundAllowlist(provider: SavedLlmProvider): string[] {
  if (provider.kind === 'openai') return ['api.openai.com'];
  if (provider.kind === 'anthropic') return ['api.anthropic.com'];
  if (provider.kind === 'snowflake_cortex') return ['snowflakecomputing.com'];
  if (provider.kind === 'databricks_genie') {
    return ['databricks.com', 'azuredatabricks.net'];
  }
  return provider.kind === 'custom_openai_compatible' ? migrationProviderHostAllowlist() : [];
}

function providerRequestId(response: Response): string | undefined {
  for (const header of ['request-id', 'x-request-id', 'x-databricks-request-id', 'x-snowflake-request-id', 'sfqid']) {
    const value = response.headers.get(header)?.trim();
    if (value) return redactSensitiveText(value).slice(0, 160);
  }
  return undefined;
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get('retry-after')?.trim();
  if (!value) return undefined;
  const seconds = Number(value);
  const rawMs = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(value) - Date.now();
  if (!Number.isFinite(rawMs)) return undefined;
  return Math.max(0, Math.min(MAX_RETRY_DELAY_MS, Math.round(rawMs)));
}

function providerCancelledError(): MigrationProviderRequestError {
  return new MigrationProviderRequestError({
    message: 'AI provider request cancelled.',
    code: 'AI_PROVIDER_CANCELLED',
    statusCode: 409,
    retryable: false,
  });
}

async function providerDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw providerCancelledError();
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(providerCancelledError());
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function providerBackoffMs(attempt: number, response: Response): number {
  const requested = retryAfterMs(response);
  if (requested !== undefined) return requested;
  return Math.min(MAX_RETRY_DELAY_MS, 250 * (2 ** Math.max(0, attempt - 1)));
}

function providerAttemptBackoffMs(attempt: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, 250 * (2 ** Math.max(0, attempt - 1)));
}

function providerRequestMethod(init: RequestInit): string {
  return String(init.method || 'GET').trim().toUpperCase();
}

function mayRetryTransportFailure(method: string): boolean {
  return method === 'GET' || method === 'HEAD';
}

function mayRetryRejectedResponse(method: string, status: number): boolean {
  if (!retryableProviderStatus(status)) return false;
  if (method === 'GET' || method === 'HEAD') return true;
  // A rate-limit response is an explicit rejection. Other POST failures may have
  // accepted billable work before returning an error, so replay remains manual.
  return status === 429;
}

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError');
}

function providerTransportError(
  error: unknown,
  method: string,
  contextSignal: AbortSignal | undefined,
  requestSignal: AbortSignal,
): MigrationProviderRequestError {
  if (contextSignal?.aborted) return providerCancelledError();
  const timeout = requestSignal.aborted || isAbortError(error);
  return new MigrationProviderRequestError({
    message: timeout
      ? 'AI provider request timed out or its response stream ended before completion.'
      : 'AI provider request failed before a complete response was received.',
    code: timeout ? 'AI_PROVIDER_TIMEOUT' : 'AI_PROVIDER_NETWORK_ERROR',
    statusCode: timeout ? 504 : 502,
    retryable: mayRetryTransportFailure(method),
  });
}

async function readProviderResponse(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new MigrationProviderRequestError({
      message: 'AI provider response exceeded OmniKit response limits.',
      code: 'AI_PROVIDER_RESPONSE_TOO_LARGE',
      statusCode: 502,
      retryable: false,
    });
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_PROVIDER_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new MigrationProviderRequestError({
        message: 'AI provider response exceeded OmniKit response limits.',
        code: 'AI_PROVIDER_RESPONSE_TOO_LARGE',
        statusCode: 502,
        retryable: false,
      });
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function fetchJson(
  provider: SavedLlmProvider,
  url: string,
  init: RequestInit,
  context: ProviderExecutionContext = {},
): Promise<ProviderFetchResult> {
  const allowlist = providerOutboundAllowlist(provider);
  if (allowlist.length === 0) {
    throw Object.assign(new Error('Custom AI provider hosts require OMNIKIT_MIGRATION_PROVIDER_HOST_ALLOWLIST.'), { statusCode: 403 });
  }
  await assertSafeOutboundUrl(url, { label: 'AI provider URL', allowlist });
  const startedAt = Date.now();
  const method = providerRequestMethod(init);

  for (let attempt = 1; attempt <= MAX_PROVIDER_ATTEMPTS; attempt += 1) {
    if (context.signal?.aborted) throw providerCancelledError();
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    context.signal?.addEventListener('abort', forwardAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, { ...init, redirect: 'manual', signal: controller.signal });
      const requestId = providerRequestId(response);
      if (!response.ok) {
        const retryable = retryableProviderStatus(response.status);
        const automaticRetry = mayRetryRejectedResponse(method, response.status);
        const waitMs = retryAfterMs(response);
        await response.body?.cancel().catch(() => undefined);
        if (automaticRetry && attempt < MAX_PROVIDER_ATTEMPTS) {
          await providerDelay(providerBackoffMs(attempt, response), context.signal);
          continue;
        }
        throw new MigrationProviderRequestError({
          message: `AI provider rejected the request with HTTP ${response.status}${requestId ? ` (request ${requestId})` : ''}.`,
          code: response.status === 401
            ? 'AI_PROVIDER_AUTHENTICATION_FAILED'
            : response.status === 403
              ? 'AI_PROVIDER_ACCESS_DENIED'
              : response.status === 404
                ? 'AI_PROVIDER_RESOURCE_NOT_FOUND'
                : response.status === 429
                  ? 'AI_PROVIDER_RATE_LIMITED'
                  : retryable
                    ? 'AI_PROVIDER_UNAVAILABLE'
                    : 'AI_PROVIDER_REQUEST_REJECTED',
          statusCode: [401, 403, 404].includes(response.status)
            ? response.status
            : response.status === 429
              ? 429
              : retryable
                ? 503
                : 422,
          retryable,
          upstreamStatus: response.status,
          requestId,
          retryAfterMs: waitMs,
        });
      }
      const text = await readProviderResponse(response);
      let payload: unknown = {};
      if (text) {
        try { payload = JSON.parse(text); } catch { payload = { content: text }; }
      }
      return { payload, attempts: attempt, durationMs: Date.now() - startedAt, requestId };
    } catch (error) {
      if (error instanceof MigrationProviderRequestError) {
        error.attempts = attempt;
        throw error;
      }
      const transportError = providerTransportError(error, method, context.signal, controller.signal);
      transportError.attempts = attempt;
      if (transportError.retryable && attempt < MAX_PROVIDER_ATTEMPTS) {
        await providerDelay(providerAttemptBackoffMs(attempt), context.signal);
        continue;
      }
      throw transportError;
    } finally {
      clearTimeout(timeout);
      context.signal?.removeEventListener('abort', forwardAbort);
    }
  }
  throw new MigrationProviderRequestError({
    message: 'AI provider remained unavailable after bounded retries.',
    code: 'AI_PROVIDER_UNAVAILABLE',
    statusCode: 503,
    retryable: true,
  });
}

function providerModelVersion(payload: unknown): string | undefined {
  const root = asRecord(payload);
  return firstString(root, ['model', 'model_version', 'modelVersion']) || undefined;
}

function executionTelemetry(result: ProviderFetchResult): ProviderExecutionTelemetry {
  return {
    durationMs: result.durationMs,
    providerAttempts: result.attempts,
    providerRequests: 1,
    providerRetries: Math.max(0, result.attempts - 1),
    requestId: result.requestId,
    modelVersion: providerModelVersion(result.payload),
  };
}

function chatCompletionsStructuredText(
  payload: unknown,
  options: { providerLabel: string; allowMissingFinishReason?: boolean },
): string {
  const root = asRecord(payload);
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const first = asRecord(choices[0]);
  const message = asRecord(first.message);
  const refusal = firstString(message, ['refusal']);
  if (refusal) {
    throw new MigrationProviderRequestError({
      message: 'The AI provider refused this migration request.',
      code: 'AI_PROVIDER_REFUSAL',
      statusCode: 422,
      retryable: false,
    });
  }
  const finishReason = firstString(first, ['finish_reason', 'finishReason']).toLowerCase();
  if (!finishReason && !options.allowMissingFinishReason) {
    throw new MigrationProviderRequestError({
      message: `${options.providerLabel} returned structured content without a terminal finish reason.`,
      code: 'AI_PROVIDER_OUTPUT_INCOMPLETE',
      statusCode: 502,
      retryable: false,
    });
  }
  if (finishReason === 'content_filter') {
    throw new MigrationProviderRequestError({
      message: `${options.providerLabel} stopped because the response was filtered.`,
      code: 'AI_PROVIDER_CONTENT_FILTERED',
      statusCode: 422,
      retryable: false,
    });
  }
  if (finishReason && finishReason !== 'stop') {
    const truncated = finishReason === 'length' || finishReason === 'max_tokens';
    throw new MigrationProviderRequestError({
      message: truncated
        ? `${options.providerLabel} stopped before completing the structured response.`
        : `${options.providerLabel} ended without a supported terminal completion state.`,
      code: truncated ? 'AI_PROVIDER_OUTPUT_TRUNCATED' : 'AI_PROVIDER_OUTPUT_INCOMPLETE',
      statusCode: 502,
      retryable: false,
    });
  }
  const text = openAiText(payload);
  if (!text) {
    throw new MigrationProviderRequestError({
      message: 'The AI provider returned no structured response content.',
      code: 'AI_PROVIDER_OUTPUT_EMPTY',
      statusCode: 502,
      retryable: false,
    });
  }
  return text;
}

function parseStrictJsonObject(rawText: string, providerLabel: string): {
  value: Record<string, unknown>;
  handling: ProviderStructuredOutputHandling;
} {
  let value: unknown;
  try {
    value = JSON.parse(rawText) as unknown;
  } catch {
    throw new MigrationProviderRequestError({
      message: `${providerLabel} did not return one complete strict JSON object.`,
      code: 'AI_PROVIDER_STRUCTURED_OUTPUT_INVALID',
      statusCode: 502,
      retryable: false,
    });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MigrationProviderRequestError({
      message: `${providerLabel} returned JSON, but the strict structured response root was not an object.`,
      code: 'AI_PROVIDER_STRUCTURED_OUTPUT_INVALID',
      statusCode: 502,
      retryable: false,
    });
  }
  return {
    value: value as Record<string, unknown>,
    handling: { parseMode: 'strict', extracted: false, repairs: [] },
  };
}

function anthropicStructuredText(payload: unknown, schemaName: string): string {
  const root = asRecord(payload);
  const stopReason = firstString(root, ['stop_reason', 'stopReason']).toLowerCase();
  if (stopReason !== 'tool_use') {
    const truncated = stopReason === 'max_tokens' || stopReason === 'model_context_window_exceeded';
    throw new MigrationProviderRequestError({
      message: truncated
        ? 'Anthropic stopped before completing the structured tool response.'
        : stopReason === 'refusal'
          ? 'Anthropic refused this migration request.'
          : `Anthropic ended without the required ${schemaName} tool response.`,
      code: stopReason === 'refusal' ? 'AI_PROVIDER_REFUSAL' : truncated ? 'AI_PROVIDER_OUTPUT_TRUNCATED' : 'AI_PROVIDER_OUTPUT_INCOMPLETE',
      statusCode: stopReason === 'refusal' ? 422 : 502,
        retryable: false,
    });
  }
  const content = Array.isArray(root.content) ? root.content : [];
  const toolUse = content.find((item) => {
    const record = asRecord(item);
    return record.type === 'tool_use' && record.name === schemaName;
  });
  if (!toolUse) {
    throw new MigrationProviderRequestError({
      message: `Anthropic did not return the required ${schemaName} tool result.`,
      code: 'AI_PROVIDER_OUTPUT_INCOMPLETE',
      statusCode: 502,
      retryable: false,
    });
  }
  return JSON.stringify(asRecord(toolUse).input ?? {});
}

async function generateWithAnthropic(
  provider: SavedLlmProvider,
  input: StructuredGenerationInput,
  context: ProviderExecutionContext,
): Promise<StructuredGenerationResult> {
  const schemaName = providerSchemaName(input.schemaName);
  const schema = providerGenerationSchema(input.schema);
  const response = await fetchJson(provider, migrationProviderEndpoint(provider), {
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
      tools: [{ name: schemaName, description: 'Return the reviewed semantic migration proposal.', input_schema: schema, strict: true }],
      tool_choice: { type: 'tool', name: schemaName },
    }),
  }, context);
  const rawText = anthropicStructuredText(response.payload, schemaName);
  const parsed = parseProviderStructuredOutput(rawText);
  const root = asRecord(response.payload);
  return { providerKind: provider.kind, model: provider.model, rawText: JSON.stringify(parsed.value), output: parsed.value, outputHandling: parsed.handling, usage: numericUsage(root.usage), telemetry: executionTelemetry(response) };
}

async function generateWithOpenAiCompatible(
  provider: SavedLlmProvider,
  input: StructuredGenerationInput,
  context: ProviderExecutionContext,
): Promise<StructuredGenerationResult> {
  const schemaName = providerSchemaName(input.schemaName);
  const schema = providerGenerationSchema(input.schema);
  const response = await fetchJson(provider, migrationProviderEndpoint(provider), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.credential}` },
    body: JSON.stringify({
      model: provider.model,
      messages: [
        { role: 'system', content: input.system },
        { role: 'user', content: input.prompt },
      ],
      temperature: 0,
      stream: false,
      ...(provider.kind === 'openai' ? { max_completion_tokens: 8192 } : { max_tokens: 8192 }),
      response_format: {
        type: 'json_schema',
        json_schema: { name: schemaName, strict: true, schema },
      },
    }),
  }, context);
  const providerLabel = provider.kind === 'openai' ? 'OpenAI' : 'Custom OpenAI-compatible provider';
  const rawText = chatCompletionsStructuredText(response.payload, {
    providerLabel,
    allowMissingFinishReason: provider.kind === 'custom_openai_compatible',
  });
  const parsed = provider.kind === 'custom_openai_compatible'
    ? parseProviderStructuredOutput(rawText)
    : parseStrictJsonObject(rawText, providerLabel);
  const root = asRecord(response.payload);
  return { providerKind: provider.kind, model: provider.model, rawText: JSON.stringify(parsed.value), output: parsed.value, outputHandling: parsed.handling, usage: numericUsage(root.usage), telemetry: executionTelemetry(response) };
}

async function generateWithSnowflake(
  provider: SavedLlmProvider,
  input: StructuredGenerationInput,
  context: ProviderExecutionContext,
): Promise<StructuredGenerationResult> {
  const snowflakeTokenType = snowflakeAuthorizationTokenType(provider.authMode);
  const schemaName = providerSchemaName(input.schemaName);
  const schema = providerGenerationSchema(input.schema);
  const response = await fetchJson(provider, migrationProviderEndpoint(provider), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.credential}`,
      'X-Snowflake-Authorization-Token-Type': snowflakeTokenType,
    },
    body: JSON.stringify({
      model: provider.model,
      messages: [
        { role: 'system', content: input.system },
        { role: 'user', content: input.prompt },
      ],
      max_completion_tokens: 8192,
      stream: false,
      response_format: {
        type: 'json_schema',
        json_schema: { name: schemaName, strict: true, schema },
      },
    }),
  }, context);
  const rawText = chatCompletionsStructuredText(response.payload, {
    providerLabel: 'Snowflake Cortex',
    allowMissingFinishReason: true,
  });
  const parsed = parseStrictJsonObject(rawText, 'Snowflake Cortex');
  const root = asRecord(response.payload);
  return { providerKind: provider.kind, model: provider.model, rawText: JSON.stringify(parsed.value), output: parsed.value, outputHandling: parsed.handling, usage: numericUsage(root.usage), telemetry: executionTelemetry(response) };
}

async function generateWithOmni(
  provider: SavedLlmProvider,
  input: StructuredGenerationInput,
  context: ProviderExecutionContext,
): Promise<StructuredGenerationResult> {
  const startedAt = Date.now();
  const instance = provider.linkedInstanceId ? getInstance(provider.linkedInstanceId) : undefined;
  if (!instance) throw Object.assign(new Error('The Omni AI provider no longer references a saved instance.'), { statusCode: 400 });
  if (!input.targetModelId) throw Object.assign(new Error('A target Omni model is required for Omni AI.'), { statusCode: 400 });
  const client = new OmniClient(instance);
  const schema = providerGenerationSchema(input.schema);
  const created = await client.createAiJob({
    modelId: input.targetModelId,
    prompt: `${input.system}\n\n${input.prompt}\n\nReturn one best-effort JSON object matching this schema exactly:\n${JSON.stringify(schema)}`,
    branchId: input.branchId,
  }, context.signal);
  if (!created.id) throw Object.assign(new Error('Omni AI did not return a job identifier.'), { statusCode: 502, code: 'AI_PROVIDER_JOB_ID_MISSING' });
  context.registerUpstreamCancellation?.(() => client.cancelAiJob(created.id).then(() => undefined));
  let state = (created.status || '').toUpperCase();
  for (let attempt = 0; attempt < OMNI_POLL_LIMIT && !['COMPLETE', 'FAILED', 'CANCELLED'].includes(state); attempt += 1) {
    await providerDelay(OMNI_POLL_INTERVAL_MS, context.signal);
    state = ((await client.getAiJob(created.id, context.signal)).status || '').toUpperCase();
  }
  if (state !== 'COMPLETE') {
    const terminal = ['FAILED', 'CANCELLED'].includes(state);
    const message = terminal
      ? `Omni AI job ended in state ${state.toLowerCase()}.`
      : `Omni AI is still ${state ? state.toLowerCase() : 'processing'} after ${Math.round((OMNI_POLL_INTERVAL_MS * OMNI_POLL_LIMIT) / 60_000)} minutes. OmniKit stopped monitoring without submitting a second request.`;
    throw Object.assign(new Error(message), { statusCode: terminal ? 502 : 504 });
  }
  const result = await client.getAiJobResult(created.id, context.signal);
  const resultRecord = result && typeof result === 'object' ? result as Record<string, unknown> : {};
  const rawText = typeof resultRecord.message === 'string' ? resultRecord.message : '';
  const parsed = parseProviderStructuredOutput(rawText);
  return {
    providerKind: provider.kind,
    model: provider.model,
    rawText: JSON.stringify(parsed.value),
    output: parsed.value,
    outputHandling: parsed.handling,
    telemetry: { durationMs: Date.now() - startedAt, providerAttempts: 1, providerRequests: 1, providerRetries: 0, requestId: created.id },
  };
}

async function generateWithGenie(
  provider: SavedLlmProvider,
  input: StructuredGenerationInput,
  context: ProviderExecutionContext,
): Promise<StructuredGenerationResult> {
  const startedAt = Date.now();
  const base = providerBaseUrl(provider);
  const spaceId = provider.model.trim();
  if (!spaceId) throw Object.assign(new Error('A Databricks Genie Space ID is required.'), { statusCode: 400 });
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.credential}` };
  const startedResponse = await fetchJson(provider, `${base}/api/2.0/genie/spaces/${encodeURIComponent(spaceId)}/start-conversation`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ content: `${input.system}\n\n${input.prompt}` }),
  }, context);
  const started = asRecord(startedResponse.payload);
  let providerAttempts = startedResponse.attempts;
  let providerRequests = 1;
  let providerRetries = Math.max(0, startedResponse.attempts - 1);
  let requestId = startedResponse.requestId;
  const conversation = asRecord(started.conversation);
  const initialMessage = asRecord(started.message);
  const conversationId = firstString(conversation, ['id']) || firstString(initialMessage, ['conversation_id', 'conversationId']);
  const messageId = firstString(initialMessage, ['id']) || firstString(started, ['message_id', 'messageId']);
  if (!conversationId || !messageId) {
    throw Object.assign(new Error('Databricks Genie did not return conversation and message identifiers.'), { statusCode: 502 });
  }

  let message: Record<string, unknown> = initialMessage;
  for (let attempt = 0; attempt < OMNI_POLL_LIMIT; attempt += 1) {
    const status = firstString(message, ['status', 'state']).toUpperCase();
    if (['COMPLETED', 'FAILED', 'CANCELLED', 'QUERY_RESULT_EXPIRED'].includes(status)) break;
    await providerDelay(OMNI_POLL_INTERVAL_MS, context.signal);
    const polled = await fetchJson(provider, `${base}/api/2.0/genie/spaces/${encodeURIComponent(spaceId)}/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`, {
      method: 'GET',
      headers,
    }, context);
    providerAttempts += polled.attempts;
    providerRequests += 1;
    providerRetries += Math.max(0, polled.attempts - 1);
    requestId = polled.requestId || requestId;
    message = asRecord(polled.payload);
  }
  const status = firstString(message, ['status', 'state']).toUpperCase();
  if (status === 'QUERY_RESULT_EXPIRED') {
    throw new MigrationProviderRequestError({
      message: 'Databricks Genie completed, but its query result expired and must be rerun.',
      code: 'AI_PROVIDER_QUERY_RESULT_EXPIRED',
      statusCode: 410,
      retryable: false,
    });
  }
  if (['FAILED', 'CANCELLED'].includes(status)) {
    throw new MigrationProviderRequestError({
      message: `Databricks Genie validation ended in state ${status.toLowerCase()}.`,
      code: status === 'CANCELLED' ? 'AI_PROVIDER_UPSTREAM_CANCELLED' : 'AI_PROVIDER_UPSTREAM_FAILED',
      statusCode: 502,
      retryable: false,
    });
  }
  if (status !== 'COMPLETED') {
    throw new MigrationProviderRequestError({
      message: 'Databricks Genie did not reach a completed state before the monitoring deadline.',
      code: 'AI_PROVIDER_TIMEOUT',
      statusCode: 504,
      retryable: true,
    });
  }
  const content = genieMessageContent(message);
  if (!content.text && !content.sql) throw Object.assign(new Error('Databricks Genie completed without validation text or SQL.'), { statusCode: 502 });
  const queryResults: NormalizedGenieQueryResult[] = [];
  for (const attachmentId of content.queryAttachmentIds) {
    const queryResult = await fetchJson(provider, `${base}/api/2.0/genie/spaces/${encodeURIComponent(spaceId)}/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}/query-result`, {
      method: 'GET',
      headers,
    }, context);
    providerAttempts += queryResult.attempts;
    providerRequests += 1;
    providerRetries += Math.max(0, queryResult.attempts - 1);
    requestId = queryResult.requestId || requestId;
    queryResults.push(normalizeGenieQueryResult(queryResult.payload, attachmentId));
  }
  const output = {
    message: content.text || 'Databricks Genie generated validation SQL.',
    sql: content.sql || undefined,
    conversationId,
    messageId,
    trustedAsset: content.trustedAsset,
    queryResultAttachmentCount: content.queryAttachmentIds.length,
    queryResults,
  };
  return {
    providerKind: provider.kind,
    model: provider.model,
    rawText: JSON.stringify(output),
    output,
    telemetry: {
      durationMs: Date.now() - startedAt,
      providerAttempts,
      providerRequests,
      providerRetries,
      requestId: requestId || messageId,
    },
  };
}

const REQUIRED_PROVIDER_AUTH_MODE: Partial<Record<MigrationProviderKind, MigrationProviderAuthMode>> = {
  openai: 'api_key',
  anthropic: 'api_key',
  snowflake_cortex: 'oauth_access_token',
  databricks_genie: 'oauth_access_token',
};

function assertProviderAuthenticationPolicy(provider: SavedLlmProvider): void {
  const requiredAuthMode = REQUIRED_PROVIDER_AUTH_MODE[provider.kind];
  const allowed = migrationProviderAuthModeAllowed(provider.kind, provider.authMode)
    && (!requiredAuthMode || provider.authMode === requiredAuthMode);
  if (allowed) return;
  throw Object.assign(new Error(`${provider.kind} requires ${requiredAuthMode || 'a supported authentication mode'} authentication.`), {
    statusCode: 409,
    code: 'AI_PROVIDER_AUTH_MODE_UNSUPPORTED',
  });
}

function assertProviderReady(provider: SavedLlmProvider, options: { requireValidatedRevision?: boolean } = {}): void {
  assertMigrationProviderAllowed(provider.kind);
  assertProviderAuthenticationPolicy(provider);
  if (!provider.enabled) throw Object.assign(new Error('This AI provider is disabled.'), { statusCode: 409, code: 'AI_PROVIDER_DISABLED' });
  if (provider.kind !== 'omni_ai' && !provider.credential?.trim()) {
    throw Object.assign(new Error('This AI provider does not have a saved credential.'), { statusCode: 409, code: 'AI_PROVIDER_CREDENTIAL_MISSING' });
  }
  if (REQUIRED_PROVIDER_AUTH_MODE[provider.kind] === 'oauth_access_token' && !provider.credentialExpiresAt) {
    throw Object.assign(new Error('This OAuth provider is missing credential expiration. Replace and test it before continuing.'), { statusCode: 409, code: 'AI_PROVIDER_CREDENTIAL_EXPIRATION_MISSING' });
  }
  if (provider.credentialExpiresAt) {
    const expiresAt = Date.parse(provider.credentialExpiresAt);
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
      throw Object.assign(new Error('This AI provider credential has expired. Replace and test it before continuing.'), { statusCode: 409, code: 'AI_PROVIDER_CREDENTIAL_EXPIRED' });
    }
  }
  if (options.requireValidatedRevision && provider.kind !== 'omni_ai' && (
    provider.lastValidationStatus !== 'valid'
    || !provider.lastValidatedRevision
    || provider.lastValidatedRevision !== provider.updatedAt
  )) {
    throw Object.assign(new Error('Test this exact AI provider configuration before using it for a migration job.'), {
      statusCode: 409,
      code: 'AI_PROVIDER_VALIDATION_REQUIRED',
    });
  }
}

async function dispatchStructuredProposal(
  provider: SavedLlmProvider,
  input: StructuredGenerationInput,
  context: ProviderExecutionContext,
  requireValidatedRevision = true,
): Promise<StructuredGenerationResult> {
  assertProviderReady(provider, { requireValidatedRevision });
  if (!providerSupportsTask(provider.kind, input.task)) throw Object.assign(new Error(`${provider.kind} does not support the ${input.task} migration task.`), { statusCode: 409 });
  if (provider.kind === 'databricks_genie') return generateWithGenie(provider, input, context);
  if (provider.kind === 'omni_ai') return generateWithOmni(provider, input, context);
  if (provider.kind === 'anthropic') return generateWithAnthropic(provider, input, context);
  if (provider.kind === 'snowflake_cortex') return generateWithSnowflake(provider, input, context);
  return generateWithOpenAiCompatible(provider, input, context);
}

function countsTowardProviderCircuit(error: unknown): boolean {
  if (error instanceof MigrationProviderRequestError) {
    return error.retryable || ['AI_PROVIDER_NETWORK_ERROR', 'AI_PROVIDER_TIMEOUT'].includes(error.code);
  }
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  return record.retryable === true && Number(record.statusCode || 0) >= 500;
}

export async function generateStructuredProposal(
  provider: SavedLlmProvider,
  input: StructuredGenerationInput,
  context: ProviderExecutionContext = {},
): Promise<StructuredGenerationResult> {
  const normalizedInput = normalizeStructuredGenerationInput(input);
  if (!providerSupportsTask(provider.kind, normalizedInput.task)) {
    throw Object.assign(new Error(`${provider.kind} does not support the ${normalizedInput.task} migration task.`), { statusCode: 409, code: 'AI_PROVIDER_TASK_UNSUPPORTED' });
  }
  assertProviderReady(provider, { requireValidatedRevision: true });
  const state = providerRuntime.get(provider.id) || { active: 0, failures: 0, openedUntil: 0, halfOpenProbe: false };
  if (state.openedUntil > Date.now()) {
    throw new MigrationProviderRequestError({
      message: 'This AI provider circuit is temporarily open after repeated failures. Retry in one minute.',
      code: 'AI_PROVIDER_CIRCUIT_OPEN',
      statusCode: 503,
      retryable: true,
    });
  }
  const isHalfOpen = state.openedUntil > 0;
  if (isHalfOpen && state.halfOpenProbe) {
    throw new MigrationProviderRequestError({
      message: 'This AI provider circuit is checking recovery with another request. Retry shortly.',
      code: 'AI_PROVIDER_CIRCUIT_HALF_OPEN',
      statusCode: 503,
      retryable: true,
    });
  }
  if (!isHalfOpen && state.active >= MAX_CONCURRENT_PER_PROVIDER) {
    throw Object.assign(new Error('This AI provider already has the maximum number of active migration requests.'), { statusCode: 429 });
  }
  if (isHalfOpen) state.halfOpenProbe = true;
  state.active += 1;
  providerRuntime.set(provider.id, state);
  try {
    const result = await runStructuredGenerationWithOutputRetry(
      normalizedInput,
      (attemptInput) => dispatchStructuredProposal(provider, attemptInput, context),
    );
    state.failures = 0;
    state.openedUntil = 0;
    return result;
  } catch (error) {
    if (countsTowardProviderCircuit(error)) {
      state.failures += 1;
      if (isHalfOpen || state.failures >= CIRCUIT_FAILURE_LIMIT) {
        state.openedUntil = Date.now() + CIRCUIT_OPEN_MS;
        if (error && typeof error === 'object') Object.assign(error, { circuitOpened: true });
      }
    }
    throw error;
  } finally {
    state.active = Math.max(0, state.active - 1);
    state.halfOpenProbe = false;
    providerRuntime.set(provider.id, state);
  }
}

async function generateProviderConnectionTest(provider: SavedLlmProvider): Promise<StructuredGenerationResult> {
  const input = normalizeStructuredGenerationInput(connectionTestInput());
  assertProviderReady(provider);
  return runStructuredGenerationWithOutputRetry(
    input,
    (attemptInput) => dispatchStructuredProposal(provider, attemptInput, {}, false),
  );
}

export function resetMigrationProviderRuntimeForTests(): void {
  providerRuntime.clear();
}

function connectionTestInput(): StructuredGenerationInput {
  return {
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
  };
}

export async function testLlmProvider(provider: SavedLlmProvider): Promise<{ ok: true; model: string; capabilities: ProviderCapabilities }> {
  assertProviderReady(provider);
  if (provider.kind === 'omni_ai') {
    const instance = provider.linkedInstanceId ? getInstance(provider.linkedInstanceId) : undefined;
    if (!instance || !instance.apiKey.trim()) {
      throw Object.assign(new Error('The Omni AI provider must reference a saved Omni instance with a credential.'), { statusCode: 409, code: 'AI_PROVIDER_LINKED_INSTANCE_MISSING' });
    }
    await new OmniClient(instance).listModels('SHARED');
    return { ok: true, model: provider.model, capabilities: providerCapabilities(provider.kind) };
  }
  if (provider.kind === 'databricks_genie') {
    const base = providerBaseUrl(provider);
    await fetchJson(provider, `${base}/api/2.0/genie/spaces/${encodeURIComponent(provider.model)}`, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${provider.credential}` },
    });
    return { ok: true, model: provider.model, capabilities: providerCapabilities(provider.kind) };
  }
  await generateProviderConnectionTest(provider);
  return { ok: true, model: provider.model, capabilities: providerCapabilities(provider.kind) };
}

import type {
  DomoManualParseResult,
  DomoApiEvidenceResult,
  LookerManualParseResult,
  MicroStrategyManualParseResult,
  PowerBiManualParseResult,
  MigrationArtifact,
  MigrationPlatformConnection,
  MigrationPlatformAuthMode,
  MigrationPlatformKind,
  MigrationPrepareEvidenceRequest,
  MigrationPreparedEvidenceResult,
  MigrationPreparedEvidenceResponse,
  MigrationProviderCapabilities,
  MigrationProviderAuthMode,
  MigrationProviderKind,
  MigrationProviderProfile,
  MigrationAiTask,
} from './types';
import type { MigrationEngineBridgeResult, MigrationEngineSource } from './engineBridge';
import type { SemanticMigrationProviderContractMetadata } from './compilePipeline';
import type { ProviderStructuredOutputHandling } from './providerOutput';
import { sha256Text } from './sourceEvidence';
import {
  parseDestinationFoundationPlan,
  type DestinationFoundationInventory,
  type DestinationFoundationPlan,
  type DestinationFoundationProvisionResult,
} from './destinationFoundation';

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw Object.assign(
    new Error(typeof payload.error === 'string' ? payload.error : `Request failed (${response.status}).`),
    {
      status: response.status,
      code: typeof payload.code === 'string' ? payload.code : undefined,
    },
  );
  return payload as T;
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(',')}}`;
}

const MAX_PROPOSAL_RETRY_TOKENS = 256;
const proposalRetryTokens = new Map<string, string>();

function proposalRetryToken(normalizedInput: unknown): string {
  const localDigest = sha256Text(stableJson(normalizedInput));
  const existing = proposalRetryTokens.get(localDigest);
  if (existing) return existing;
  const token = globalThis.crypto.randomUUID();
  proposalRetryTokens.set(localDigest, token);
  if (proposalRetryTokens.size > MAX_PROPOSAL_RETRY_TOKENS) {
    const oldest = proposalRetryTokens.keys().next().value;
    if (typeof oldest === 'string') proposalRetryTokens.delete(oldest);
  }
  return token;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Migration proposal monitoring was cancelled.', 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

async function waitForNextProposalPoll(delayMs: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface SaveProviderInput {
  id?: string;
  name: string;
  kind: MigrationProviderKind;
  model: string;
  baseUrl?: string;
  linkedInstanceId?: string;
  accountIdentifier?: string;
  warehouse?: string;
  database?: string;
  schema?: string;
  authMode?: MigrationProviderAuthMode;
  credentialOwner?: string;
  credentialExpiresAt?: string;
  rotationDueAt?: string;
  credential?: string;
  enabled?: boolean;
}

export interface SavePlatformConnectionInput {
  id?: string;
  name: string;
  platform: MigrationPlatformKind;
  baseUrl?: string;
  accountIdentifier?: string;
  workspaceId?: string;
  projectId?: string;
  siteId?: string;
  clientId?: string;
  username?: string;
  repositoryPath?: string;
  authMode?: MigrationPlatformAuthMode;
  credentialExpiresAt?: string;
  credential?: string;
  productApiToken?: string;
  clearCredential?: boolean;
  clearProductApiToken?: boolean;
  clearClientId?: boolean;
  enabled?: boolean;
}

export interface LookerSourceValidationProbeInput {
  dashboardPlanId: string;
  tileId: string;
  queryOrigin?: 'inline' | 'result_maker' | 'saved_look' | 'query_id' | 'unknown';
  lookId?: string;
  queryId?: string;
  model?: string;
  explore?: string;
  fields?: string[];
  filters?: Record<string, string>;
  sorts?: string[];
  pivots?: string[];
  filterExpression?: string;
  limit?: number;
}

export interface LookerSourceValidationProbeResult {
  dashboardPlanId: string;
  tileId: string;
  source: 'saved_look' | 'query_id' | 'inline';
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  returnedRowCount: number;
  fieldNames: string[];
  fingerprint: string;
  truncated: boolean;
}

export interface SourceInventoryItem {
  id: string;
  name: string;
  kind: 'workspace' | 'project' | 'semantic_model' | 'data_source' | 'dataset' | 'report' | 'dashboard' | 'workbook' | 'page' | 'view' | 'tile' | 'visual' | 'card' | 'cube' | 'metric' | 'attribute' | 'calculation' | 'filter' | 'permission' | 'schedule' | 'repository_item';
  parentId?: string;
  path?: string;
  owner?: string;
  updatedAt?: string;
  usageCount?: number;
  dependencyIds: string[];
  featureFlags: string[];
  riskFlags: string[];
  metadata: Record<string, string | number | boolean | null>;
}

export interface SourceConnectorCapabilities {
  apiInventory: boolean;
  semanticDefinitions: 'full' | 'partial' | 'export_required';
  contentDefinitions: 'full' | 'partial' | 'export_required';
  usage: boolean;
  permissions: boolean;
  schedules: boolean;
  queryValidation: boolean;
  queryValidationMode: 'source_and_target' | 'target_only' | 'manual_source_evidence';
  visualEvidence: boolean;
}

export type SourceMigrationCoverageStatus = 'full' | 'partial' | 'export_required' | 'unsupported';
export type SourceMigrationCoverage = Record<'semantic_objects' | 'dashboards' | 'filters' | 'layout' | 'permissions' | 'schedules', SourceMigrationCoverageStatus>;

export interface SourceInventory {
  platform: MigrationPlatformKind;
  connectionId: string;
  connectionUpdatedAt: string;
  connector: {
    platform: MigrationPlatformKind;
    label: string;
    authGuidance: string;
    capabilities: SourceConnectorCapabilities;
    migrationCoverage?: SourceMigrationCoverage;
    limitations: string[];
  };
  items: SourceInventoryItem[];
  dashboardCatalog: SourceDashboardCatalogItem[];
  warnings: string[];
  truncated: boolean;
  collection?: {
    scope: 'all_accessible' | 'saved_parent';
    scopeLabel: string;
    complete: boolean;
    status: 'complete' | 'partial' | 'failed' | 'bounded';
    errors: string[];
    pagesFetched: number;
    parentsExpanded: number;
    requestsMade: number;
    maxPages: number;
    maxItems: number;
  };
}

export type SourceDependencyCategory = 'semantic_model' | 'data_source' | 'field' | 'calculation' | 'relationship' | 'filter' | 'security' | 'schedule' | 'content' | 'unknown';

export interface SourceDependencyReference {
  assetId: string;
  name: string;
  kind: SourceInventoryItem['kind'];
  category: SourceDependencyCategory;
  required: boolean;
  reason: string;
  status?: 'resolved' | 'missing';
}

export interface SourceDashboardCatalogItem {
  id: string;
  canonicalSourceId?: string;
  selectionAliases?: string[];
  name: string;
  kind: SourceInventoryItem['kind'];
  path?: string;
  owner?: string;
  updatedAt?: string;
  usageCount?: number;
  dependencyIds: string[];
  dependencies: SourceDependencyReference[];
  dependencyCounts: Partial<Record<SourceDependencyCategory, number>>;
  complexity: 'low' | 'medium' | 'high';
  coverage: 'complete' | 'partial' | 'export_required';
  coverageNotes: string[];
  riskFlags: string[];
}

export async function listMigrationProviders(): Promise<MigrationProviderProfile[]> {
  const result = await apiFetch<{ providers: MigrationProviderProfile[] }>('/api/migration-studio/providers');
  return result.providers;
}

export async function saveMigrationProvider(input: SaveProviderInput): Promise<MigrationProviderProfile> {
  const result = await apiFetch<{ provider: MigrationProviderProfile }>(input.id ? `/api/migration-studio/providers/${encodeURIComponent(input.id)}` : '/api/migration-studio/providers', {
    method: input.id ? 'PATCH' : 'POST',
    body: JSON.stringify(input),
  });
  return result.provider;
}

export async function deleteMigrationProvider(id: string): Promise<void> {
  await apiFetch(`/api/migration-studio/providers/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function testMigrationProvider(id: string): Promise<{ ok: true; model: string; capabilities: MigrationProviderCapabilities }> {
  return apiFetch(`/api/migration-studio/providers/${encodeURIComponent(id)}/test`, { method: 'POST' });
}

export interface MigrationProposalInput {
  providerId: string;
  projectId?: string;
  task: MigrationAiTask;
  system: string;
  prompt: string;
  schemaName: string;
  schema: Record<string, unknown>;
  targetModelId?: string;
  branchId?: string;
  semanticMigrationContract?: SemanticMigrationProviderContractMetadata;
  stage?: 'analyze' | 'compile' | 'repair';
}

export interface MigrationProposalJob {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  stage?: 'analyze' | 'compile' | 'repair';
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string;
  error?: string;
  errorCode?: string;
  retryable?: boolean;
  failureAttempts?: number;
}

export interface MigrationProposalResult {
  output: unknown;
  rawText: string;
  usage?: Record<string, number>;
  outputHandling?: ProviderStructuredOutputHandling;
  telemetry?: {
    durationMs: number;
    providerAttempts: number;
    providerRequests: number;
    providerRetries: number;
    requestId?: string;
    modelVersion?: string;
  };
}

interface MigrationProposalJobResponse {
  job: MigrationProposalJob;
  result?: MigrationProposalResult;
  resultExpired?: boolean;
  resultRequiresVaultUnlock?: boolean;
}

export class MigrationProposalPendingError extends Error {
  readonly job: MigrationProposalJob;

  constructor(job: MigrationProposalJob) {
    super('The AI provider is still processing. Continue monitoring this job instead of starting another one.');
    this.name = 'MigrationProposalPendingError';
    this.job = job;
  }
}

export class MigrationProposalFailedError extends Error {
  readonly job: MigrationProposalJob;
  readonly code?: string;
  readonly retryable: boolean;
  readonly failureAttempts?: number;

  constructor(job: MigrationProposalJob) {
    super(job.error || 'The AI provider job failed.');
    this.name = 'MigrationProposalFailedError';
    this.job = job;
    this.code = job.errorCode;
    this.retryable = job.retryable === true;
    this.failureAttempts = job.failureAttempts;
  }
}

export async function startMigrationProposal(
  input: MigrationProposalInput,
  options: { signal?: AbortSignal } = {},
): Promise<MigrationProposalJob> {
  const normalizedInput = {
    ...input,
    stage: input.stage || (input.schemaName.includes('package') ? 'compile' : 'analyze'),
  };
  // Keep the input digest in memory and send only an opaque retry token. The
  // server independently binds that token to a keyed request fingerprint.
  const idempotencyKey = `proposal:${proposalRetryToken(normalizedInput)}`;
  const started = await apiFetch<{ job: MigrationProposalJob }>('/api/migration-studio/jobs', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(normalizedInput),
    signal: options.signal,
  });
  return started.job;
}

export async function getMigrationProposalJob(
  id: string,
  options: { signal?: AbortSignal } = {},
): Promise<MigrationProposalJobResponse> {
  return apiFetch<MigrationProposalJobResponse>(`/api/migration-studio/jobs/${encodeURIComponent(id)}`, {
    signal: options.signal,
  });
}

export async function cancelMigrationProposalJob(id: string): Promise<MigrationProposalJob> {
  const response = await apiFetch<{ job: MigrationProposalJob }>(`/api/migration-studio/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
  return response.job;
}

export async function generateMigrationProposal(
  input: MigrationProposalInput,
  options: {
    existingJobId?: string;
    maxPollAttempts?: number;
    pollIntervalMs?: number;
    signal?: AbortSignal;
    onStatus?: (job: MigrationProposalJob) => void;
  } = {},
): Promise<MigrationProposalResult> {
  throwIfAborted(options.signal);
  const started = options.existingJobId
    ? (await getMigrationProposalJob(options.existingJobId, { signal: options.signal })).job
    : await startMigrationProposal(input, { signal: options.signal });
  options.onStatus?.(started);
  const maxPollAttempts = Math.max(1, options.maxPollAttempts ?? 120);
  const pollIntervalMs = Math.max(250, options.pollIntervalMs ?? 1_000);
  let latestJob = started;
  for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
    throwIfAborted(options.signal);
    const result = await getMigrationProposalJob(started.id, { signal: options.signal });
    latestJob = result.job;
    options.onStatus?.(result.job);
    if (result.job.status === 'succeeded') {
      if (result.result) return result.result;
      if (result.resultRequiresVaultUnlock) {
        throw new Error('Unlock the OmniKit vault to retrieve this completed AI result. The result has not been returned to the browser.');
      }
      throw new Error(result.resultExpired ? 'The completed AI result expired from transient memory. Rerun this reviewed step.' : 'The AI job completed without a result.');
    }
    if (result.job.status === 'failed' || result.job.status === 'cancelled') {
      throw new MigrationProposalFailedError({
        ...result.job,
        error: result.job.error || `The AI job was ${result.job.status}.`,
      });
    }
    if (attempt + 1 < maxPollAttempts) await waitForNextProposalPoll(pollIntervalMs, options.signal);
  }
  throw new MigrationProposalPendingError(latestJob);
}

export async function listMigrationPlatformConnections(): Promise<MigrationPlatformConnection[]> {
  const result = await apiFetch<{ connections: MigrationPlatformConnection[] }>('/api/migration-studio/platform-connections');
  return result.connections;
}

export async function saveMigrationPlatformConnection(input: SavePlatformConnectionInput): Promise<MigrationPlatformConnection> {
  const result = await apiFetch<{ connection: MigrationPlatformConnection }>(input.id ? `/api/migration-studio/platform-connections/${encodeURIComponent(input.id)}` : '/api/migration-studio/platform-connections', {
    method: input.id ? 'PATCH' : 'POST',
    body: JSON.stringify(input),
  });
  return result.connection;
}

export async function deleteMigrationPlatformConnection(id: string): Promise<void> {
  await apiFetch(`/api/migration-studio/platform-connections/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function testMigrationPlatformConnection(id: string): Promise<{
  ok: boolean;
  platform: MigrationPlatformKind;
  itemCount: number;
  inventory?: SourceInventory;
  connection?: MigrationPlatformConnection;
}> {
  return apiFetch(`/api/migration-studio/platform-connections/${encodeURIComponent(id)}/test`, { method: 'POST' });
}

export async function loadMigrationSourceInventory(id: string): Promise<SourceInventory> {
  const result = await apiFetch<{ inventory: SourceInventory }>(`/api/migration-studio/platform-connections/${encodeURIComponent(id)}/inventory`);
  return result.inventory;
}

export type PrepareMigrationSourceEvidenceInput = MigrationPrepareEvidenceRequest;

/**
 * Prepare migration-grade evidence for one exact selected source scope.
 * Inventory discovery and evidence preparation intentionally remain separate
 * operations so catalog metadata cannot silently unlock Analyze.
 */
export async function prepareMigrationSourceEvidence(
  id: string,
  input: PrepareMigrationSourceEvidenceInput,
  options: { signal?: AbortSignal } = {},
): Promise<MigrationPreparedEvidenceResult> {
  const result = await apiFetch<MigrationPreparedEvidenceResponse>(
    `/api/migration-studio/platform-connections/${encodeURIComponent(id)}/evidence`,
    {
      method: 'POST',
      body: JSON.stringify(input),
      signal: options.signal,
    },
  );
  return result.result;
}

export async function prepareDomoMigrationEvidence(
  id: string,
  selectedDashboardIds: string[],
  connectionUpdatedAt: string,
  options: { signal?: AbortSignal } = {},
): Promise<DomoApiEvidenceResult> {
  const result = await apiFetch<{ result: DomoApiEvidenceResult }>(`/api/migration-studio/platform-connections/${encodeURIComponent(id)}/domo-evidence`, {
      method: 'POST',
      body: JSON.stringify({ selectedDashboardIds, connectionUpdatedAt }),
      signal: options.signal,
  });
  return result.result;
}

export async function runLookerMigrationSourceProbe(
  id: string,
  input: LookerSourceValidationProbeInput,
): Promise<LookerSourceValidationProbeResult> {
  const result = await apiFetch<{ result: LookerSourceValidationProbeResult }>(`/api/migration-studio/platform-connections/${encodeURIComponent(id)}/validate-query`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return result.result;
}

export async function loadMigrationEngineCapabilities(): Promise<Record<string, unknown>> {
  const result = await apiFetch<{
    available: boolean;
    capabilities: Record<string, unknown> | null;
    reason?: string;
  }>('/api/migration-studio/engine/capabilities');
  if (!result.available || !result.capabilities) {
    throw new Error(result.reason || 'The deterministic migration engine is unavailable.');
  }
  return result.capabilities;
}

export async function extractWithMigrationEngine(input: {
  requestId?: string;
  sourceTool: MigrationEngineSource | 'power_bi';
  mode: 'manual';
  connectionId?: string;
  artifacts?: Array<{ name: string; content?: string; contentBase64?: string }>;
  /** Optional comparable native export used only for server-side differential attestation. */
  parityArtifacts?: Array<{ name: string; content?: string; contentBase64?: string }>;
  defaultSchema?: string;
  scope?: Record<string, unknown>;
  includeModelSuggestions?: boolean;
  rulebookVersion?: string;
  targetInstanceId?: string;
  connectionOverrides?: Record<string, string>;
}, signal?: AbortSignal): Promise<MigrationEngineBridgeResult> {
  const response = await apiFetch<{ result: MigrationEngineBridgeResult }>('/api/migration-studio/engine/extract', {
    method: 'POST',
    body: JSON.stringify(input),
    signal,
  });
  return response.result;
}

export async function confirmMigrationEngineConnections(input: {
  targetInstanceId: string;
  result: MigrationEngineBridgeResult;
  connectionOverrides: Record<string, string>;
}, signal?: AbortSignal): Promise<MigrationEngineBridgeResult> {
  const response = await apiFetch<{ result: MigrationEngineBridgeResult }>('/api/migration-studio/engine/confirm-connections', {
    method: 'POST',
    body: JSON.stringify(input),
    signal,
  });
  return response.result;
}

export async function recordMigrationEngineParityObservation(
  requestId: string,
): Promise<{ source: MigrationEngineSource; observationCount: number; latestOverall: number; comparisonType: 'native_differential' | 'canonical_conformance' }> {
  const response = await apiFetch<{ summary: { source: MigrationEngineSource; observationCount: number; latestOverall: number; comparisonType: 'native_differential' | 'canonical_conformance' } }>('/api/migration-studio/engine/parity', {
    method: 'POST',
    body: JSON.stringify({ requestId }),
  });
  return response.summary;
}

export function parseManualMigrationArtifacts(sourceTool: 'domo', artifacts: MigrationArtifact[]): Promise<DomoManualParseResult>;
export function parseManualMigrationArtifacts(sourceTool: 'looker', artifacts: MigrationArtifact[]): Promise<LookerManualParseResult>;
export function parseManualMigrationArtifacts(sourceTool: 'microstrategy', artifacts: MigrationArtifact[]): Promise<MicroStrategyManualParseResult>;
export function parseManualMigrationArtifacts(sourceTool: 'power_bi', artifacts: MigrationArtifact[]): Promise<PowerBiManualParseResult>;
export async function parseManualMigrationArtifacts(sourceTool: 'domo' | 'looker' | 'microstrategy' | 'power_bi', artifacts: MigrationArtifact[]): Promise<DomoManualParseResult | LookerManualParseResult | MicroStrategyManualParseResult | PowerBiManualParseResult> {
  const response = await apiFetch<{ result: DomoManualParseResult | LookerManualParseResult | MicroStrategyManualParseResult | PowerBiManualParseResult }>('/api/migration-studio/manual-artifacts/parse', {
    method: 'POST',
    body: JSON.stringify({ sourceTool, artifacts }),
  });
  return response.result;
}

export async function loadDestinationFoundationInventory(
  targetInstanceId: string,
): Promise<DestinationFoundationInventory> {
  const result = await apiFetch<{ inventory: DestinationFoundationInventory }>(
    `/api/migration-studio/destination-foundation/${encodeURIComponent(targetInstanceId)}/inventory`,
  );
  return result.inventory;
}

export async function provisionDestinationFoundation(
  input: DestinationFoundationPlan,
): Promise<DestinationFoundationProvisionResult> {
  const plan = parseDestinationFoundationPlan(input);
  const result = await apiFetch<{ result: DestinationFoundationProvisionResult }>(
    `/api/migration-studio/destination-foundation/${encodeURIComponent(plan.targetInstanceId)}/provision`,
    {
      method: 'POST',
      body: JSON.stringify(plan),
    },
  );
  return result.result;
}

import type {
  DomoManualParseResult,
  DomoApiEvidenceResult,
  LookerManualParseResult,
  MicroStrategyManualParseResult,
  PowerBiManualParseResult,
  MigrationArtifact,
  MigrationPlatformConnection,
  MigrationPlatformKind,
  MigrationProject,
  MigrationProviderCapabilities,
  MigrationProviderAuthMode,
  MigrationProviderKind,
  MigrationProviderProfile,
  MigrationAiTask,
} from './types';
import type { MigrationEngineBridgeResult, MigrationEngineSource } from './engineBridge';

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw Object.assign(new Error(typeof payload.error === 'string' ? payload.error : `Request failed (${response.status}).`), { status: response.status });
  return payload as T;
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
  authMode?: 'oauth_client_credentials' | 'oauth_access_token';
  credential?: string;
  productApiToken?: string;
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
  visualEvidence: boolean;
}

export type SourceMigrationCoverageStatus = 'full' | 'partial' | 'export_required' | 'unsupported';
export type SourceMigrationCoverage = Record<'semantic_objects' | 'dashboards' | 'filters' | 'layout' | 'permissions' | 'schedules', SourceMigrationCoverageStatus>;

export interface SourceInventory {
  platform: MigrationPlatformKind;
  connectionId: string;
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
  task: MigrationAiTask;
  system: string;
  prompt: string;
  schemaName: string;
  schema: Record<string, unknown>;
  targetModelId?: string;
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
}

export interface MigrationProposalResult {
  output: unknown;
  rawText: string;
  usage?: Record<string, number>;
}

interface MigrationProposalJobResponse {
  job: MigrationProposalJob;
  result?: MigrationProposalResult;
  resultExpired?: boolean;
}

export class MigrationProposalPendingError extends Error {
  readonly job: MigrationProposalJob;

  constructor(job: MigrationProposalJob) {
    super('The AI provider is still processing. Continue monitoring this job instead of starting another one.');
    this.name = 'MigrationProposalPendingError';
    this.job = job;
  }
}

export async function startMigrationProposal(input: MigrationProposalInput): Promise<MigrationProposalJob> {
  const started = await apiFetch<{ job: MigrationProposalJob }>('/api/migration-studio/jobs', {
    method: 'POST',
    body: JSON.stringify({ ...input, stage: input.stage || (input.schemaName.includes('package') ? 'compile' : 'analyze') }),
  });
  return started.job;
}

export async function getMigrationProposalJob(id: string): Promise<MigrationProposalJobResponse> {
  return apiFetch<MigrationProposalJobResponse>(`/api/migration-studio/jobs/${encodeURIComponent(id)}`);
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
  const started = options.existingJobId
    ? (await getMigrationProposalJob(options.existingJobId)).job
    : await startMigrationProposal(input);
  options.onStatus?.(started);
  const maxPollAttempts = Math.max(1, options.maxPollAttempts ?? 120);
  const pollIntervalMs = Math.max(250, options.pollIntervalMs ?? 1_000);
  let latestJob = started;
  for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
    if (options.signal?.aborted) throw new DOMException('Migration proposal monitoring was cancelled.', 'AbortError');
    const result = await getMigrationProposalJob(started.id);
    latestJob = result.job;
    options.onStatus?.(result.job);
    if (result.job.status === 'succeeded') {
      if (result.result) return result.result;
      throw new Error(result.resultExpired ? 'The completed AI result expired from transient memory. Rerun this reviewed step.' : 'The AI job completed without a result.');
    }
    if (result.job.status === 'failed' || result.job.status === 'cancelled') {
      throw new Error(result.job.error || `The AI job was ${result.job.status}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
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

export async function testMigrationPlatformConnection(id: string): Promise<{ ok: true; platform: MigrationPlatformKind; itemCount: number }> {
  return apiFetch(`/api/migration-studio/platform-connections/${encodeURIComponent(id)}/test`, { method: 'POST' });
}

export async function loadMigrationSourceInventory(id: string): Promise<SourceInventory> {
  const result = await apiFetch<{ inventory: SourceInventory }>(`/api/migration-studio/platform-connections/${encodeURIComponent(id)}/inventory`);
  return result.inventory;
}

export async function prepareDomoMigrationEvidence(
  id: string,
  selectedDashboardIds: string[],
): Promise<DomoApiEvidenceResult> {
  const result = await apiFetch<{ result: DomoApiEvidenceResult }>(`/api/migration-studio/platform-connections/${encodeURIComponent(id)}/domo-evidence`, {
    method: 'POST',
    body: JSON.stringify({ selectedDashboardIds }),
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
  mode: 'manual' | 'api';
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

export async function listMigrationProjects(): Promise<MigrationProject[]> {
  const result = await apiFetch<{ projects: MigrationProject[] }>('/api/migration-studio/projects');
  return result.projects;
}

export async function saveMigrationProject(input: Partial<MigrationProject>): Promise<MigrationProject> {
  const result = await apiFetch<{ project: MigrationProject }>(input.id ? `/api/migration-studio/projects/${encodeURIComponent(input.id)}` : '/api/migration-studio/projects', {
    method: input.id ? 'PATCH' : 'POST',
    body: JSON.stringify(input),
  });
  return result.project;
}

export async function deleteMigrationProject(id: string): Promise<void> {
  await apiFetch(`/api/migration-studio/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

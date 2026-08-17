import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { validateRecipe } from '../../src/services/deckBuilder/deckRecipe';
import type { DeckRecipe } from '../../src/services/deckBuilder/types';
import { clearReadThroughCache } from './readThroughCache';

const VAULT_VERSION = 1;
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

const DEFAULT_VAULT_PATH = './data/vault.enc';
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000;

// Unlock throttling. Key derivation is deliberately expensive, but without a
// backoff an attacker with local API reach can still grind roughly 10-20
// guesses per second against a weak passphrase.
const UNLOCK_FREE_ATTEMPTS = 5;
const UNLOCK_BACKOFF_BASE_MS = 500;
const UNLOCK_BACKOFF_MAX_MS = 30 * 1000;
const UNLOCK_ATTEMPT_RESET_MS = 15 * 60 * 1000;

export type InstanceRole = 'source' | 'destination' | 'both';

export interface InstanceMetricFilter {
  connectionDatabaseContains: string[];
  connectionDatabaseExact: string[];
  embedExternalIdContains: string[];
  embedExternalIdExact: string[];
}

export interface PostMigrationAction {
  kind?: 'webhook' | 'refresh-schema';
  name: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers: Record<string, string>;
  body: string;
  destinationInstanceId?: string;
  targetModelId?: string;
  targetModelName?: string;
}

export const VAULT_SESSION_ABORT_SIGNAL: unique symbol = Symbol('omnikit.vaultSessionAbortSignal');

export interface VaultSessionBoundInstance {
  readonly [VAULT_SESSION_ABORT_SIGNAL]?: AbortSignal;
}

export interface SavedInstance extends VaultSessionBoundInstance {
  id: string;
  label: string;
  role: InstanceRole;
  baseUrl: string;
  apiKey: string;
  defaultModelId?: string;
  defaultFolderId?: string;
  defaultFolderPath?: string;
  entityGroupSeparator?: string;
  organizationApiKeyConfirmed?: boolean;
  portfolioAppLabel?: string;
  metricFilter: InstanceMetricFilter;
  postMigrationActions: PostMigrationAction[];
  createdAt: string;
  updatedAt: string;
  lastValidatedAt?: string;
}

export type SavedInstancePublic = Omit<SavedInstance, 'apiKey'> & {
  apiKeyMasked: string;
};

export interface VaultDeckRecipeRecord {
  id: string;
  name: string;
  description?: string;
  savedForInstanceId?: string;
  savedForInstanceLabel?: string;
  savedForBaseUrlHost?: string;
  createdAt: number;
  updatedAt: number;
  recipe: DeckRecipe;
}

export interface SaveDeckRecipeInput {
  id?: string;
  name: string;
  description?: string;
  savedForInstanceId?: string;
  savedForInstanceLabel?: string;
  savedForBaseUrlHost?: string;
  recipe: DeckRecipe;
}

export type MigrationProviderKind =
  | 'omni_ai'
  | 'openai'
  | 'anthropic'
  | 'snowflake_cortex'
  | 'databricks_genie'
  /** Read-only compatibility tombstone. New and edited profiles are rejected. */
  | 'databricks_model_serving'
  | 'custom_openai_compatible';

export type MigrationProviderAuthMode =
  | 'linked_omni_instance'
  | 'api_key'
  | 'programmatic_access_token'
  | 'oauth_access_token'
  | 'personal_access_token'
  | 'key_pair_jwt';

export type MigrationPlatformKind =
  | 'dbt'
  | 'looker'
  | 'metabase'
  | 'power_bi'
  | 'tableau'
  | 'domo'
  | 'sigma'
  | 'webfocus'
  | 'microstrategy'
  | 'databricks_genie'
  | 'omni';

export type MigrationPlatformAuthMode =
  | 'api_key'
  | 'api_client_credentials'
  | 'oauth_client_credentials'
  | 'oauth_access_token'
  | 'product_api_token'
  | 'personal_access_token'
  | 'username_password_session';

export interface SavedLlmProvider {
  id: string;
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
  credential: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastValidatedAt?: string;
  lastValidatedRevision?: string;
  lastValidationStatus?: 'valid' | 'failed';
  lastValidationAttemptAt?: string;
}

export type SavedLlmProviderPublic = Omit<SavedLlmProvider, 'credential'> & {
  credentialMasked: string;
  hasCredential: boolean;
};

export interface SavedPlatformConnection {
  id: string;
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
  credential: string;
  productApiToken?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastValidatedAt?: string;
  lastValidatedRevision?: string;
  lastValidationStatus?: 'valid' | 'failed';
  lastValidationAttemptAt?: string;
}

type SavedPlatformConnectionWrite = Partial<SavedPlatformConnection> & {
  clearCredential?: boolean;
  clearProductApiToken?: boolean;
  clearClientId?: boolean;
};

export type SavedPlatformConnectionPublic = Omit<SavedPlatformConnection, 'credential' | 'productApiToken'> & {
  credentialMasked: string;
  hasCredential: boolean;
  productApiTokenMasked: string;
  hasProductApiToken: boolean;
  hasPlatformOAuthClient: boolean;
  inventoryAccess: 'basic' | 'deep' | 'hybrid';
};

export interface VaultPortfolioOverviewSnapshot {
  fingerprint: string;
  storedAt: number;
  overview: Record<string, unknown>;
}

export interface VaultPortfolioOverviewHistoryMetric {
  value: number | null;
  status: string;
  source: string;
  asOf: string;
  coverage: {
    included: number;
    total: number;
  };
  exclusions: string[];
  reasonCode: string | null;
  reasonLabel?: string;
}

export interface VaultPortfolioOverviewHistoryEntry {
  day: string;
  storedAt: number;
  generatedAt: string;
  coverage: {
    totalInstances: number;
    reportingInstances: number;
    partialInstances: number;
    staleInstances: number;
    unavailableInstances: number;
    savedInstances: number;
    duplicateSavedOrigins: number;
  };
  metrics: Record<string, VaultPortfolioOverviewHistoryMetric>;
  partial: boolean;
  stale: boolean;
}

interface VaultPayload {
  version: typeof VAULT_VERSION;
  instances: SavedInstance[];
  deckRecipes: VaultDeckRecipeRecord[];
  llmProviders: SavedLlmProvider[];
  platformConnections: SavedPlatformConnection[];
  portfolioOverviewSnapshot?: VaultPortfolioOverviewSnapshot;
  portfolioOverviewHistory: VaultPortfolioOverviewHistoryEntry[];
}

interface UnlockedVault {
  key: Buffer;
  salt: Buffer;
  payload: VaultPayload;
}

let unlockedVault: UnlockedVault | null = null;
let lastVaultActivityAt = 0;
let idleTimer: NodeJS.Timeout | null = null;
let vaultSessionAbortController = new AbortController();

function rotateVaultSessionBoundary(reason: string): void {
  vaultSessionAbortController.abort(new Error(reason));
  vaultSessionAbortController = new AbortController();
}

export function getVaultPath(): string {
  return process.env.OMNIKIT_VAULT_PATH || DEFAULT_VAULT_PATH;
}

/**
 * Resolves the idle auto-lock timeout.
 *
 * Blank and unparseable values fall back to the default rather than disabling
 * the lock. `Number('')` is 0, so a half-filled `.env` or compose file that
 * declares OMNIKIT_VAULT_IDLE_TIMEOUT_MS with no value used to silently turn
 * auto-lock off. Disabling it now requires the explicit string `off`.
 *
 * Small values are honoured as written — "lock sooner" is a legitimate operator
 * choice and the test suite relies on it. Only the upper bound is capped, since
 * an enormous timeout disables the lock without saying so.
 */
export function getVaultIdleTimeoutMs(): number {
  const configured = (process.env.OMNIKIT_VAULT_IDLE_TIMEOUT_MS || '').trim();
  if (!configured) return DEFAULT_IDLE_TIMEOUT_MS;
  if (configured.toLowerCase() === 'off') return 0;
  const raw = Number(configured);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_IDLE_TIMEOUT_MS;
  return Math.min(raw, MAX_IDLE_TIMEOUT_MS);
}

export function vaultExists(): boolean {
  return existsSync(getVaultPath());
}

export function isVaultUnlocked(): boolean {
  enforceIdleTimeout();
  return unlockedVault !== null;
}

function clearIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
}

function scheduleIdleTimer(): void {
  clearIdleTimer();
  const timeout = getVaultIdleTimeoutMs();
  if (!unlockedVault || timeout <= 0) return;
  idleTimer = setTimeout(() => {
    lockVault();
  }, timeout);
  idleTimer.unref?.();
}

function touchVault(): void {
  if (!unlockedVault) return;
  lastVaultActivityAt = Date.now();
  scheduleIdleTimer();
}

export function touchVaultSession() {
  requireUnlocked();
  return vaultStatus();
}

function enforceIdleTimeout(): void {
  if (!unlockedVault) return;
  const timeout = getVaultIdleTimeoutMs();
  if (timeout <= 0) return;
  if (Date.now() - lastVaultActivityAt >= timeout) lockVault();
}

function defaultFilter(): InstanceMetricFilter {
  return {
    connectionDatabaseContains: [],
    connectionDatabaseExact: [],
    embedExternalIdContains: [],
    embedExternalIdExact: [],
  };
}

function normalizeFilter(filter: Partial<InstanceMetricFilter> | undefined): InstanceMetricFilter {
  const clean = (value: unknown) => Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
    : [];
  return {
    connectionDatabaseContains: clean(filter?.connectionDatabaseContains),
    connectionDatabaseExact: clean(filter?.connectionDatabaseExact),
    embedExternalIdContains: clean(filter?.embedExternalIdContains),
    embedExternalIdExact: clean(filter?.embedExternalIdExact),
  };
}

function normalizeActions(actions: unknown): PostMigrationAction[] {
  if (!Array.isArray(actions)) return [];
  return actions
    .filter((action): action is Partial<PostMigrationAction> => Boolean(action) && typeof action === 'object' && !Array.isArray(action))
    .map((action) => ({
      kind: action.kind === 'refresh-schema' ? 'refresh-schema' as const : 'webhook' as const,
      name: typeof action.name === 'string' && action.name.trim() ? action.name.trim() : 'Post-migration action',
      method: normalizeMethod(action.method),
      url: typeof action.url === 'string' ? action.url.trim() : '',
      headers: action.headers && typeof action.headers === 'object' && !Array.isArray(action.headers)
        ? Object.fromEntries(Object.entries(action.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
        : {},
      body: typeof action.body === 'string' ? action.body : '',
      destinationInstanceId: typeof action.destinationInstanceId === 'string' && action.destinationInstanceId.trim() ? action.destinationInstanceId.trim() : undefined,
      targetModelId: typeof action.targetModelId === 'string' && action.targetModelId.trim() ? action.targetModelId.trim() : undefined,
      targetModelName: typeof action.targetModelName === 'string' && action.targetModelName.trim() ? action.targetModelName.trim() : undefined,
    }))
    .filter((action) => action.kind === 'refresh-schema' ? Boolean(action.targetModelId) : Boolean(action.url));
}

function normalizeMethod(value: unknown): PostMigrationAction['method'] {
  const method = typeof value === 'string' ? value.toUpperCase() : 'POST';
  if (method === 'GET' || method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') return method;
  return 'POST';
}

function normalizeRole(value: unknown): InstanceRole {
  return value === 'source' || value === 'destination' || value === 'both' ? value : 'destination';
}

const FORBIDDEN_DECK_RECIPE_KEYS = new Set([
  'apikey',
  'api_key',
  'token',
  'secret',
  'password',
  'passphrase',
]);

function cleanOptionalText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function cleanRequiredText(value: unknown, label: string, maxLength: number, fallback?: string): string {
  const cleaned = cleanOptionalText(value, maxLength) || fallback;
  if (!cleaned) throw Object.assign(new Error(`${label} is required.`), { statusCode: 400 });
  return cleaned;
}

function canonicalCredentialEndpoint(value: unknown): string | undefined {
  const cleaned = cleanOptionalText(value, 500);
  if (!cleaned) return undefined;
  try {
    const parsed = new URL(cleaned);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return undefined;
    parsed.hostname = parsed.hostname.replace(/\.+$/, '').toLowerCase();
    parsed.hash = '';
    parsed.search = '';
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function credentialEndpointChanged(existingBaseUrl: string | undefined, nextBaseUrl: string | undefined): boolean {
  return canonicalCredentialEndpoint(existingBaseUrl) !== canonicalCredentialEndpoint(nextBaseUrl);
}

const PROVIDER_KINDS = new Set<MigrationProviderKind>([
  'omni_ai',
  'openai',
  'anthropic',
  'snowflake_cortex',
  'databricks_genie',
  'databricks_model_serving',
  'custom_openai_compatible',
]);

const PLATFORM_KINDS = new Set<MigrationPlatformKind>([
  'dbt',
  'looker',
  'metabase',
  'power_bi',
  'tableau',
  'domo',
  'sigma',
  'webfocus',
  'microstrategy',
  'databricks_genie',
  'omni',
]);

const PROVIDER_AUTH_MODES = new Set<MigrationProviderAuthMode>([
  'linked_omni_instance',
  'api_key',
  'programmatic_access_token',
  'oauth_access_token',
  'personal_access_token',
  'key_pair_jwt',
]);

const EXPIRING_PROVIDER_AUTH_MODES = new Set<MigrationProviderAuthMode>([
  'oauth_access_token',
  'key_pair_jwt',
]);

const PROVIDER_AUTH_BY_KIND: Record<MigrationProviderKind, MigrationProviderAuthMode[]> = {
  omni_ai: ['linked_omni_instance'],
  openai: ['api_key'],
  anthropic: ['api_key'],
  snowflake_cortex: ['oauth_access_token'],
  databricks_genie: ['oauth_access_token'],
  databricks_model_serving: [],
  custom_openai_compatible: ['api_key', 'oauth_access_token', 'personal_access_token'],
};

export function migrationProviderAuthModeAllowed(
  kind: MigrationProviderKind,
  authMode: MigrationProviderAuthMode | undefined,
): boolean {
  const allowed = PROVIDER_AUTH_BY_KIND[kind];
  return allowed.length > 0 && allowed.includes(authMode || allowed[0]!);
}

function defaultProviderAuthMode(kind: MigrationProviderKind): MigrationProviderAuthMode {
  const authMode = PROVIDER_AUTH_BY_KIND[kind][0];
  if (!authMode) {
    throw Object.assign(new Error('Databricks Foundation Model providers are retired. Delete this legacy profile and choose a supported AI engine.'), {
      statusCode: 410,
      code: 'AI_PROVIDER_RETIRED',
    });
  }
  return authMode;
}

function normalizeProviderAuthMode(
  value: unknown,
  kind: MigrationProviderKind,
  fallback?: MigrationProviderAuthMode,
  allowLegacyAuthentication = false,
): MigrationProviderAuthMode {
  const candidate = typeof value === 'string' && PROVIDER_AUTH_MODES.has(value as MigrationProviderAuthMode)
    ? value as MigrationProviderAuthMode
    : fallback || (allowLegacyAuthentication && kind === 'databricks_model_serving'
      ? 'oauth_access_token'
      : defaultProviderAuthMode(kind));
  if (!allowLegacyAuthentication && !PROVIDER_AUTH_BY_KIND[kind].includes(candidate)) {
    throw Object.assign(new Error(`The selected authentication method is not supported for ${kind}.`), { statusCode: 400 });
  }
  return candidate;
}

function cleanOptionalDate(value: unknown, label: string, fallback?: string): string | undefined {
  const cleaned = cleanOptionalText(value, 80);
  if (!cleaned) return fallback;
  const timestamp = Date.parse(cleaned);
  if (!Number.isFinite(timestamp)) throw Object.assign(new Error(`${label} must be a valid date.`), { statusCode: 400 });
  return new Date(timestamp).toISOString();
}

function normalizeProviderBaseUrl(value: unknown): string | undefined {
  const cleaned = cleanOptionalText(value, 500);
  if (!cleaned) return undefined;
  try {
    const parsed = new URL(cleaned);
    parsed.hostname = parsed.hostname.replace(/\.$/, '');
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    const normalized = parsed.toString();
    return parsed.pathname === '/' && !parsed.search && !parsed.hash
      ? normalized.slice(0, -1)
      : normalized;
  } catch {
    return cleaned.replace(/\/+$/, '');
  }
}

function defaultProviderBaseUrl(kind: MigrationProviderKind): string | undefined {
  if (kind === 'openai') return 'https://api.openai.com/v1';
  if (kind === 'anthropic') return 'https://api.anthropic.com/v1';
  return undefined;
}

function effectiveProviderBaseUrl(kind: MigrationProviderKind, baseUrl: string | undefined): string | undefined {
  return normalizeProviderBaseUrl(baseUrl ?? defaultProviderBaseUrl(kind));
}

function providerUsesCanonicalPublicEndpoint(kind: MigrationProviderKind, baseUrl: string | undefined): boolean {
  if (kind !== 'openai' && kind !== 'anthropic') return true;
  const effectiveBaseUrl = effectiveProviderBaseUrl(kind, baseUrl);
  if (!effectiveBaseUrl) return false;
  try {
    const parsed = new URL(effectiveBaseUrl);
    const expectedHostname = kind === 'openai' ? 'api.openai.com' : 'api.anthropic.com';
    const normalizedPath = parsed.pathname.replace(/\/+$/, '') || '/';
    return parsed.protocol === 'https:'
      && !parsed.username
      && !parsed.password
      && !parsed.search
      && !parsed.hash
      && parsed.hostname === expectedHostname
      && parsed.port === ''
      && normalizedPath === '/v1';
  } catch {
    return false;
  }
}

function normalizeProviderKind(value: unknown): MigrationProviderKind {
  if (typeof value === 'string' && PROVIDER_KINDS.has(value as MigrationProviderKind)) return value as MigrationProviderKind;
  throw Object.assign(new Error('Select a supported AI provider.'), { statusCode: 400 });
}

function normalizePlatformKind(value: unknown): MigrationPlatformKind {
  if (typeof value === 'string' && PLATFORM_KINDS.has(value as MigrationPlatformKind)) return value as MigrationPlatformKind;
  throw Object.assign(new Error('Select a supported migration platform.'), { statusCode: 400 });
}

export function savedSourceAuthenticationIssue(connection: SavedPlatformConnection): string | undefined {
  if (!connection.enabled) return 'This saved source is disabled and must be replaced before it can access an API.';
  if (connection.platform === 'domo') {
    const productReady = Boolean(connection.productApiToken);
    const platformOAuthReady = Boolean(connection.clientId && connection.credential);
    return productReady || platformOAuthReady
      ? undefined
      : 'Domo Saved API requires a tenant-bound Product API developer token, Platform OAuth client credentials, or both. Replace this legacy source or use Manual Files.';
  }
  if (connection.platform === 'looker') {
    return connection.authMode === 'api_client_credentials' && Boolean(connection.clientId) && Boolean(connection.credential)
      ? undefined
      : 'Looker Saved API requires an API client ID and client secret. Replace this legacy source or use Manual Files.';
  }
  if (connection.platform === 'metabase') {
    return connection.authMode === 'api_key' && Boolean(connection.credential) && !connection.clientId
      ? undefined
      : 'Metabase Saved API requires an API key. Replace this legacy source or use Manual Files.';
  }
  if (connection.platform === 'sigma') {
    return connection.authMode === 'oauth_client_credentials' && Boolean(connection.clientId) && Boolean(connection.credential)
      ? undefined
      : 'Sigma Saved API requires an API client ID and client secret. Replace this legacy source or use Manual Files.';
  }
  if (connection.platform === 'tableau') {
    return connection.authMode === 'personal_access_token' && Boolean(connection.username) && Boolean(connection.credential)
      ? undefined
      : 'Tableau Saved API requires a PAT name and PAT secret. Add a site content URL for a non-default site, or use Manual Files.';
  }
  if (connection.platform === 'power_bi') {
    const servicePrincipalReady = connection.authMode === 'oauth_client_credentials'
      && Boolean(connection.accountIdentifier)
      && Boolean(connection.clientId)
      && Boolean(connection.credential)
      && Boolean(connection.workspaceId);
    const accessTokenReady = connection.authMode === 'oauth_access_token'
      && Boolean(connection.credential)
      && Boolean(connection.credentialExpiresAt)
      && Boolean(connection.workspaceId)
      && Date.parse(connection.credentialExpiresAt || '') > Date.now();
    return servicePrincipalReady || accessTokenReady
      ? undefined
      : 'Power BI/Fabric Saved API requires a Microsoft Entra service principal or an unexpired delegated OAuth access token. Use Manual Files when OAuth is unavailable.';
  }
  if (connection.platform === 'microstrategy') {
    return connection.authMode === 'username_password_session'
      && Boolean(connection.username)
      && Boolean(connection.credential)
      && Boolean(connection.projectId)
      ? undefined
      : 'Strategy Saved API requires a supported username/password login and project ID. Unsupported SAML-only connections must use Manual Files.';
  }
  if (connection.platform === 'webfocus') {
    return 'WebFOCUS Saved API remains Manual Files-first until stored IBFS username/password access receives explicit security approval.';
  }
  return 'Saved API is unavailable for this source. Use Manual Files.';
}

function maskedCredential(value: string): string {
  if (!value) return '';
  if (value.length <= 8) return '••••';
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

function toPublicProvider(provider: SavedLlmProvider): SavedLlmProviderPublic {
  const { credential: _credential, ...rest } = provider;
  void _credential;
  return { ...rest, credentialMasked: maskedCredential(provider.credential), hasCredential: Boolean(provider.credential) };
}

function toPublicPlatformConnection(connection: SavedPlatformConnection): SavedPlatformConnectionPublic {
  const { credential: _credential, productApiToken: _productApiToken, ...rest } = connection;
  void _credential;
  void _productApiToken;
  return {
    ...rest,
    credentialMasked: maskedCredential(connection.credential),
    hasCredential: Boolean(connection.credential),
    productApiTokenMasked: maskedCredential(connection.productApiToken || ''),
    hasProductApiToken: Boolean(connection.productApiToken),
    hasPlatformOAuthClient: connection.platform === 'domo' && Boolean(connection.clientId && connection.credential),
    inventoryAccess: connection.platform === 'domo' && connection.productApiToken && connection.clientId && connection.credential
      ? 'hybrid'
      : connection.platform === 'domo' && (connection.productApiToken || (connection.clientId && connection.credential))
        ? 'deep'
        : 'basic',
  };
}

function normalizeLlmProvider(
  raw: Partial<SavedLlmProvider>,
  existing?: SavedLlmProvider,
  preserveStoredValidationState = false,
): SavedLlmProvider {
  const currentTime = Date.now();
  const existingRevisionTime = existing ? Date.parse(existing.updatedAt) : Number.NaN;
  const now = new Date(existing && Number.isFinite(existingRevisionTime)
    ? Math.max(currentTime, existingRevisionTime + 1)
    : currentTime).toISOString();
  const storedCreatedAt = preserveStoredValidationState ? cleanOptionalText(raw.createdAt, 80) : undefined;
  const storedUpdatedAt = preserveStoredValidationState ? cleanOptionalText(raw.updatedAt, 80) : undefined;
  const kind = normalizeProviderKind(raw.kind ?? existing?.kind);
  const retiredProvider = kind === 'databricks_model_serving';
  if ((retiredProvider || existing?.kind === 'databricks_model_serving') && !preserveStoredValidationState) {
    throw Object.assign(new Error('Databricks Foundation Model providers are retired. Delete this legacy profile and choose a supported AI engine.'), {
      statusCode: 410,
      code: 'AI_PROVIDER_RETIRED',
    });
  }
  const replacementCredential = cleanOptionalText(raw.credential, 16_384);
  const linkedInstanceId = cleanOptionalText(raw.linkedInstanceId, 160) ?? existing?.linkedInstanceId;
  const authMode = normalizeProviderAuthMode(
    raw.authMode,
    kind,
    kind === existing?.kind ? existing?.authMode : undefined,
    preserveStoredValidationState,
  );
  const authModeSupported = PROVIDER_AUTH_BY_KIND[kind].includes(authMode);
  const model = cleanRequiredText(raw.model, 'Provider model', 240, existing?.model);
  const existingBaseUrl = normalizeProviderBaseUrl(existing?.baseUrl);
  const baseUrl = raw.baseUrl === undefined ? existingBaseUrl : normalizeProviderBaseUrl(raw.baseUrl);
  const publicEndpointSupported = providerUsesCanonicalPublicEndpoint(kind, baseUrl);
  if (!preserveStoredValidationState && !publicEndpointSupported) {
    throw Object.assign(new Error(`${kind === 'openai' ? 'OpenAI' : 'Anthropic'} providers must use the documented ${defaultProviderBaseUrl(kind)} API endpoint.`), {
      statusCode: 400,
      code: 'AI_PROVIDER_ENDPOINT_UNSUPPORTED',
    });
  }
  const kindChanged = Boolean(existing && kind !== existing.kind);
  const baseUrlChanged = Boolean(existing
    && effectiveProviderBaseUrl(kind, baseUrl) !== effectiveProviderBaseUrl(existing.kind, existingBaseUrl));
  const endpointIdentityChanged = kindChanged || baseUrlChanged;
  let credential = replacementCredential ?? existing?.credential ?? '';
  if (endpointIdentityChanged) {
    if (kind === 'omni_ai') credential = '';
    else if (!replacementCredential) {
      throw Object.assign(new Error('Changing an AI provider kind or base URL requires a replacement credential.'), { statusCode: 400 });
    } else credential = replacementCredential;
  }
  const accountIdentifier = cleanOptionalText(raw.accountIdentifier, 240) ?? existing?.accountIdentifier;
  const warehouse = cleanOptionalText(raw.warehouse, 240) ?? existing?.warehouse;
  const database = cleanOptionalText(raw.database, 240) ?? existing?.database;
  const schema = cleanOptionalText(raw.schema, 240) ?? existing?.schema;
  const credentialBoundaryChanged = Boolean(existing && (
    endpointIdentityChanged
    || authMode !== existing.authMode
    || credential !== existing.credential
  ));
  const credentialExpiresAt = cleanOptionalDate(
    raw.credentialExpiresAt,
    'Credential expiration',
    credentialBoundaryChanged ? undefined : existing?.credentialExpiresAt,
  );
  if (!preserveStoredValidationState && EXPIRING_PROVIDER_AUTH_MODES.has(authMode) && !credentialExpiresAt) {
    throw Object.assign(new Error('Credential expiration is required for OAuth provider access tokens.'), { statusCode: 400 });
  }
  const configurationChanged = Boolean(existing && (
    kindChanged
    || credential !== existing.credential
    || linkedInstanceId !== existing.linkedInstanceId
    || authMode !== existing.authMode
    || model !== existing.model
    || baseUrlChanged
    || accountIdentifier !== existing.accountIdentifier
    || warehouse !== existing.warehouse
    || database !== existing.database
    || schema !== existing.schema
  ));
  if (kind === 'omni_ai' && !linkedInstanceId) {
    throw Object.assign(new Error('Omni AI providers must reference a saved Omni instance.'), { statusCode: 400 });
  }
  if (kind !== 'omni_ai' && !credential) {
    throw Object.assign(new Error('Provider credential is required.'), { statusCode: 400 });
  }
  const validationStateInvalidated = retiredProvider
    || !publicEndpointSupported
    || configurationChanged
    || (EXPIRING_PROVIDER_AUTH_MODES.has(authMode) && !credentialExpiresAt);
  const providerCredentialReady = authModeSupported
    && publicEndpointSupported
    && (!EXPIRING_PROVIDER_AUTH_MODES.has(authMode) || Boolean(credentialExpiresAt));
  const storedLastValidatedAt = existing?.lastValidatedAt
    ?? (preserveStoredValidationState ? cleanOptionalText(raw.lastValidatedAt, 80) : undefined);
  const storedLastValidatedRevision = existing?.lastValidatedRevision
    ?? (preserveStoredValidationState ? cleanOptionalText(raw.lastValidatedRevision, 80) : undefined);
  const storedLastValidationStatus = existing?.lastValidationStatus
    ?? (preserveStoredValidationState && (raw.lastValidationStatus === 'valid' || raw.lastValidationStatus === 'failed')
      ? raw.lastValidationStatus
      : undefined);
  const storedLastValidationAttemptAt = existing?.lastValidationAttemptAt
    ?? (preserveStoredValidationState ? cleanOptionalDate(raw.lastValidationAttemptAt, 'Validation attempt') : undefined);
  return {
    id: existing?.id || cleanOptionalText(raw.id, 160) || randomUUID(),
    name: cleanRequiredText(raw.name, 'Provider name', 120, existing?.name),
    kind,
    model,
    baseUrl,
    linkedInstanceId,
    accountIdentifier,
    warehouse,
    database,
    schema,
    authMode,
    credentialOwner: cleanOptionalText(raw.credentialOwner, 240) ?? existing?.credentialOwner,
    credentialExpiresAt,
    rotationDueAt: cleanOptionalDate(raw.rotationDueAt, 'Rotation due date', existing?.rotationDueAt),
    credential,
    enabled: providerCredentialReady && (typeof raw.enabled === 'boolean' ? raw.enabled : existing?.enabled ?? true),
    createdAt: existing?.createdAt || storedCreatedAt || now,
    updatedAt: storedUpdatedAt || now,
    lastValidatedAt: validationStateInvalidated ? undefined : storedLastValidatedAt,
    lastValidatedRevision: validationStateInvalidated ? undefined : storedLastValidatedRevision,
    lastValidationStatus: validationStateInvalidated ? undefined : storedLastValidationStatus,
    lastValidationAttemptAt: validationStateInvalidated ? undefined : storedLastValidationAttemptAt,
  };
}

function normalizePlatformConnection(
  raw: SavedPlatformConnectionWrite,
  existing?: SavedPlatformConnection,
  allowLegacyAuthentication = false,
): SavedPlatformConnection {
  const now = new Date().toISOString();
  const storedCreatedAt = allowLegacyAuthentication ? cleanOptionalText(raw.createdAt, 80) : undefined;
  const storedUpdatedAt = allowLegacyAuthentication ? cleanOptionalText(raw.updatedAt, 80) : undefined;
  const storedLastValidationStatus = allowLegacyAuthentication && (raw.lastValidationStatus === 'valid' || raw.lastValidationStatus === 'failed')
    ? raw.lastValidationStatus
    : undefined;
  const storedLastValidationAttemptAt = allowLegacyAuthentication ? cleanOptionalText(raw.lastValidationAttemptAt, 80) : undefined;
  const platform = normalizePlatformKind(raw.platform ?? existing?.platform);
  const platformChanged = Boolean(existing && platform !== existing.platform);
  if (!allowLegacyAuthentication && platformChanged) {
    throw Object.assign(new Error('A saved source platform cannot be changed in place. Create a new connection so project references and credential boundaries remain explicit.'), { statusCode: 409 });
  }
  const samePlatformExisting = existing?.platform === platform ? existing : undefined;
  const clearCredential = raw.clearCredential === true;
  const clearProductApiToken = raw.clearProductApiToken === true;
  const clearClientId = raw.clearClientId === true;
  const replacementCredential = cleanOptionalText(raw.credential, 16_384);
  const replacementProductApiToken = cleanOptionalText(raw.productApiToken, 16_384);
  const requestedClientId = cleanOptionalText(raw.clientId, 500) ?? samePlatformExisting?.clientId;
  const rawAuthMode = raw.authMode === 'api_key'
    || raw.authMode === 'api_client_credentials'
    || raw.authMode === 'oauth_client_credentials'
    || raw.authMode === 'oauth_access_token'
    || raw.authMode === 'product_api_token'
    || raw.authMode === 'personal_access_token'
    || raw.authMode === 'username_password_session'
    ? raw.authMode
    : undefined;
  const supportedModes: Partial<Record<MigrationPlatformKind, MigrationPlatformAuthMode[]>> = {
    domo: ['product_api_token', 'oauth_client_credentials'],
    looker: ['api_client_credentials'],
    metabase: ['api_key'],
    sigma: ['oauth_client_credentials'],
    tableau: ['personal_access_token'],
    power_bi: ['oauth_client_credentials', 'oauth_access_token'],
    microstrategy: ['username_password_session'],
    webfocus: ['username_password_session'],
  };
  const platformModes = supportedModes[platform] || [];
  if (platformModes.length === 0 && !allowLegacyAuthentication) {
    throw Object.assign(new Error(`${platform} Saved API connections are unavailable. Use Manual Files instead.`), { statusCode: 400 });
  }
  if (platform === 'webfocus' && !allowLegacyAuthentication) {
    throw Object.assign(new Error('WebFOCUS Saved API remains Manual Files-first until stored IBFS username/password access receives explicit security approval.'), { statusCode: 409 });
  }
  const inferredAuthMode: MigrationPlatformAuthMode = platform === 'domo'
    ? (replacementProductApiToken || samePlatformExisting?.productApiToken ? 'product_api_token' : 'oauth_client_credentials')
    : platformModes[0] || rawAuthMode || samePlatformExisting?.authMode || 'oauth_access_token';
  const authMode = rawAuthMode || samePlatformExisting?.authMode || inferredAuthMode;
  const authModeSupported = platformModes.includes(authMode);
  if (!allowLegacyAuthentication && !authModeSupported) {
    throw Object.assign(new Error(`${platform} Saved API does not support ${authMode.replaceAll('_', ' ')} authentication. Use the documented source credential or Manual Files.`), { statusCode: 400 });
  }
  const explicitBaseUrl = cleanOptionalText(raw.baseUrl, 500);
  const nextBaseUrl = explicitBaseUrl ?? samePlatformExisting?.baseUrl;
  const authModeChanged = Boolean(samePlatformExisting && authMode !== samePlatformExisting.authMode);
  const endpointChanged = Boolean(samePlatformExisting && credentialEndpointChanged(samePlatformExisting.baseUrl, nextBaseUrl));
  // Domo's Product API token and Platform OAuth client are independent,
  // tenant-bound credential families. Switching which family is preferred for
  // acquisition must not silently clear the other saved family; explicit clear
  // and replacement inputs below remain authoritative. Other platforms retain
  // the stricter one-auth-mode boundary.
  const credentialBoundaryChanged = platformChanged || endpointChanged || (authModeChanged && platform !== 'domo');
  const credential = clearCredential
    ? ''
    : credentialBoundaryChanged
    ? replacementCredential || ''
    : replacementCredential ?? samePlatformExisting?.credential ?? '';
  const productApiToken = platform === 'domo'
    ? clearProductApiToken
      ? ''
      : credentialBoundaryChanged
      ? replacementProductApiToken || ''
      : replacementProductApiToken ?? samePlatformExisting?.productApiToken ?? ''
    : '';
  const clientId = clearClientId
    ? undefined
    : credentialBoundaryChanged ? cleanOptionalText(raw.clientId, 500) : requestedClientId;
  const accountIdentifier = credentialBoundaryChanged
    ? cleanOptionalText(raw.accountIdentifier, 240)
    : cleanOptionalText(raw.accountIdentifier, 240) ?? samePlatformExisting?.accountIdentifier;
  const workspaceId = cleanOptionalText(raw.workspaceId, 240) ?? samePlatformExisting?.workspaceId;
  const projectId = cleanOptionalText(raw.projectId, 240) ?? samePlatformExisting?.projectId;
  const siteId = cleanOptionalText(raw.siteId, 240) ?? samePlatformExisting?.siteId;
  const username = credentialBoundaryChanged
    ? cleanOptionalText(raw.username, 500)
    : cleanOptionalText(raw.username, 500) ?? samePlatformExisting?.username;
  const repositoryPath = cleanOptionalText(raw.repositoryPath, 500) ?? samePlatformExisting?.repositoryPath;
  const credentialIdentityChanged = Boolean(samePlatformExisting && (
    (platform !== 'domo' && authMode !== samePlatformExisting.authMode)
    || clientId !== samePlatformExisting.clientId
    || accountIdentifier !== samePlatformExisting.accountIdentifier
    || username !== samePlatformExisting.username
  ));
  const explicitlyRemovingDomoOAuth = platform === 'domo' && clearClientId && clearCredential;
  if (!allowLegacyAuthentication && credentialIdentityChanged && !replacementCredential && !explicitlyRemovingDomoOAuth) {
    throw Object.assign(new Error(`Changing the ${platform} credential identity requires a replacement secret or token.`), { statusCode: 400 });
  }
  if (!allowLegacyAuthentication && endpointChanged) {
    const hasReplacement = platform === 'domo'
      ? Boolean(replacementProductApiToken || replacementCredential)
      : Boolean(replacementCredential);
    if (!hasReplacement) {
      throw Object.assign(new Error(platform === 'domo'
        ? 'Changing the Domo tenant URL requires a replacement Product API token or OAuth client secret. Existing credentials are never rebound to another tenant.'
        : `Changing the ${platform} server URL requires a replacement credential.`), { statusCode: 400 });
    }
  }
  if (!allowLegacyAuthentication && !nextBaseUrl) {
    throw Object.assign(new Error(platform === 'domo' ? 'Domo instance URL is required.' : `${platform} server URL is required.`), { statusCode: 400 });
  }
  if (platform === 'domo' && productApiToken && (productApiToken.length < 4 || /[\r\n]/.test(productApiToken))) {
    throw Object.assign(new Error('Domo Product API developer token is invalid. Replace it with the complete token value.'), { statusCode: 400 });
  }
  if (credential && /[\r\n]/.test(credential)) {
    throw Object.assign(new Error('Saved source credentials cannot contain line breaks.'), { statusCode: 400 });
  }
  const credentialExpiresAt = cleanOptionalDate(
    raw.credentialExpiresAt,
    'Source credential expiration',
    credentialBoundaryChanged || authMode !== samePlatformExisting?.authMode ? undefined : samePlatformExisting?.credentialExpiresAt,
  );
  const domoProductReady = platform === 'domo' && Boolean(productApiToken);
  const domoOAuthReady = platform === 'domo' && Boolean(clientId && credential);
  const directAuthenticationSupported = authModeSupported && (
    (platform === 'domo' && (domoProductReady || domoOAuthReady))
    || (platform === 'looker' && authMode === 'api_client_credentials' && Boolean(clientId && credential))
    || (platform === 'metabase' && authMode === 'api_key' && Boolean(credential) && !clientId)
    || (platform === 'sigma' && authMode === 'oauth_client_credentials' && Boolean(clientId && credential))
    || (platform === 'tableau' && authMode === 'personal_access_token' && Boolean(username && credential))
    || (platform === 'power_bi' && authMode === 'oauth_client_credentials' && Boolean(accountIdentifier && clientId && credential && workspaceId))
    || (platform === 'power_bi' && authMode === 'oauth_access_token' && Boolean(credential && credentialExpiresAt && workspaceId) && Date.parse(credentialExpiresAt || '') > Date.now())
    || (platform === 'microstrategy' && authMode === 'username_password_session' && Boolean(username && credential && projectId))
  );
  if (!allowLegacyAuthentication && platform === 'domo' && !domoProductReady && !domoOAuthReady) {
    throw Object.assign(new Error('Domo requires a Product API developer token, Platform OAuth client credentials, or both.'), { statusCode: 400 });
  }
  if (!allowLegacyAuthentication && platform === 'looker' && (!clientId || !credential)) {
    throw Object.assign(new Error('Looker API client ID and client secret are required.'), { statusCode: 400 });
  }
  if (!allowLegacyAuthentication && platform === 'metabase' && !credential) {
    throw Object.assign(new Error('Metabase API key is required.'), { statusCode: 400 });
  }
  if (!allowLegacyAuthentication && platform === 'sigma' && (!clientId || !credential)) {
    throw Object.assign(new Error('Sigma API client ID and client secret are required.'), { statusCode: 400 });
  }
  if (!allowLegacyAuthentication && platform === 'tableau' && (!username || !credential)) {
    throw Object.assign(new Error('Tableau PAT name and PAT secret are required.'), { statusCode: 400 });
  }
  if (!allowLegacyAuthentication && platform === 'power_bi' && !directAuthenticationSupported) {
    throw Object.assign(new Error('Power BI/Fabric requires Microsoft Entra service-principal credentials or an unexpired delegated OAuth access token.'), { statusCode: 400 });
  }
  if (!allowLegacyAuthentication && platform === 'microstrategy' && !directAuthenticationSupported) {
    throw Object.assign(new Error('Strategy requires a username, password, project ID, and supported session login.'), { statusCode: 400 });
  }
  const configurationChanged = Boolean(existing && (
    platform !== existing.platform
    || credential !== existing.credential
    || productApiToken !== existing.productApiToken
    || authMode !== existing.authMode
    || clientId !== existing.clientId
    || nextBaseUrl !== existing.baseUrl
    || accountIdentifier !== existing.accountIdentifier
    || workspaceId !== existing.workspaceId
    || projectId !== existing.projectId
    || siteId !== existing.siteId
    || username !== existing.username
    || repositoryPath !== existing.repositoryPath
    || credentialExpiresAt !== existing.credentialExpiresAt
  ));
  return {
    id: existing?.id || cleanOptionalText(raw.id, 160) || randomUUID(),
    name: cleanRequiredText(raw.name, 'Connection name', 120, existing?.name),
    platform,
    baseUrl: nextBaseUrl,
    accountIdentifier,
    workspaceId,
    projectId,
    siteId,
    clientId,
    username,
    repositoryPath,
    authMode,
    credentialExpiresAt,
    credential,
    productApiToken,
    enabled: directAuthenticationSupported && (typeof raw.enabled === 'boolean' ? raw.enabled : existing?.enabled ?? true),
    createdAt: existing?.createdAt || storedCreatedAt || now,
    updatedAt: storedUpdatedAt || now,
    lastValidatedAt: !directAuthenticationSupported || configurationChanged
      ? undefined
      : cleanOptionalText(raw.lastValidatedAt, 80) ?? existing?.lastValidatedAt,
    lastValidatedRevision: !directAuthenticationSupported || configurationChanged
      ? undefined
      : cleanOptionalText(raw.lastValidatedRevision, 80) ?? existing?.lastValidatedRevision,
    lastValidationStatus: !directAuthenticationSupported || configurationChanged
      ? undefined
      : storedLastValidationStatus ?? existing?.lastValidationStatus,
    lastValidationAttemptAt: !directAuthenticationSupported || configurationChanged
      ? undefined
      : storedLastValidationAttemptAt ?? existing?.lastValidationAttemptAt,
  };
}

function createDeckRecipeId(): string {
  return `recipe_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

export function deckRecipeRecordContainsForbiddenKeys(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((entry) => deckRecipeRecordContainsForbiddenKeys(entry));
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_DECK_RECIPE_KEYS.has(key.toLowerCase())) return true;
    if (deckRecipeRecordContainsForbiddenKeys(child)) return true;
  }
  return false;
}

const PORTFOLIO_SNAPSHOT_KEYS = new Set([
  'schemaVersion', 'generatedAt', 'servedAt', 'cache', 'refresh', 'coverage', 'metrics',
  'instances', 'connections', 'duplicateSavedOrigins', 'failures', 'warnings', 'partial', 'stale',
  'state', 'cachedAt', 'startedAt', 'completedAt', 'completedInstances', 'totalInstances',
  'reportingInstances', 'partialInstances', 'staleInstances', 'unavailableInstances',
  'savedInstances', 'internalMemberships', 'estimatedUniquePeople', 'embedUsers',
  'embedEntities', 'active7d', 'active30d', 'active90d', 'staleUsers90d',
  'neverLoggedInUsers', 'dashboards', 'models', 'topics',
  'aiChats', 'apps', 'value', 'status', 'source', 'asOf', 'included', 'total', 'unit', 'ratio',
  'coverageLabel', 'exclusions', 'reasonCode', 'reasonLabel', 'id', 'label', 'health',
  'statusLabel', 'freshness', 'duplicateSavedOrigin', 'duplicateSavedOriginCount',
  'duplicateInstanceLabels', 'name', 'instanceId', 'instanceLabel', 'readiness',
  'attribution', 'canonicalInstanceId', 'instanceLabels', 'savedInstanceCount', 'metric', 'message',
]);

const PORTFOLIO_SNAPSHOT_MAX_BYTES = 5 * 1024 * 1024;
const PORTFOLIO_HISTORY_MAX_BYTES = 2 * 1024 * 1024;
const PORTFOLIO_HISTORY_MAX_DAYS = 90;
const EMAIL_LIKE_TEXT = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;

function sanitizePortfolioSnapshotValue(value: unknown, depth = 0): unknown {
  if (depth > 14) throw new Error('Portfolio snapshot is too deeply nested.');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Portfolio snapshot contains a non-finite number.');
    return value;
  }
  if (typeof value === 'string') {
    if (EMAIL_LIKE_TEXT.test(value) || /^https?:\/\//i.test(value.trim())) {
      throw new Error('Portfolio snapshot contains prohibited identity or URL data.');
    }
    return value.slice(0, 1_000);
  }
  if (Array.isArray(value)) {
    if (value.length > 50_000) throw new Error('Portfolio snapshot contains an oversized array.');
    return value.map((entry) => sanitizePortfolioSnapshotValue(entry, depth + 1));
  }
  if (!value || typeof value !== 'object') {
    throw new Error('Portfolio snapshot contains an unsupported value.');
  }
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) continue;
    if (!PORTFOLIO_SNAPSHOT_KEYS.has(key)) {
      throw new Error(`Portfolio snapshot contains a prohibited key: ${key}`);
    }
    output[key] = sanitizePortfolioSnapshotValue(child, depth + 1);
  }
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isPortfolioMetricSnapshot(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.coverage)) return false;
  return (value.value === null || typeof value.value === 'number')
    && typeof value.status === 'string'
    && (value.source === undefined || typeof value.source === 'string')
    && typeof value.asOf === 'string'
    && typeof value.coverage.included === 'number'
    && typeof value.coverage.total === 'number'
    && Array.isArray(value.exclusions)
    && (value.reasonCode === null || typeof value.reasonCode === 'string');
}

function isPortfolioFailureSnapshot(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.coverage)) return false;
  return typeof value.id === 'string'
    && typeof value.message === 'string'
    && typeof value.instanceId === 'string'
    && typeof value.instanceLabel === 'string'
    && typeof value.metric === 'string'
    && typeof value.status === 'string'
    && (value.reasonCode === null || typeof value.reasonCode === 'string')
    && (value.reasonLabel === undefined || typeof value.reasonLabel === 'string')
    && Array.isArray(value.exclusions)
    && value.exclusions.every((exclusion) => typeof exclusion === 'string')
    && typeof value.asOf === 'string'
    && typeof value.source === 'string'
    && typeof value.coverage.included === 'number'
    && typeof value.coverage.total === 'number'
    && typeof value.coverage.unit === 'string'
    && (value.coverage.ratio === null || typeof value.coverage.ratio === 'number');
}

const PORTFOLIO_LEGACY_METRIC_SET_KEYS = [
  'internalMemberships', 'estimatedUniquePeople', 'embedUsers', 'embedEntities',
  'active7d', 'active30d', 'active90d', 'dashboards', 'models', 'topics', 'aiChats', 'apps',
];
const PORTFOLIO_LIFECYCLE_METRIC_KEYS = ['staleUsers90d', 'neverLoggedInUsers'];
const PORTFOLIO_METRIC_SET_KEYS = [
  ...PORTFOLIO_LEGACY_METRIC_SET_KEYS,
  ...PORTFOLIO_LIFECYCLE_METRIC_KEYS,
];
const PORTFOLIO_HISTORY_METRIC_KEYS = ['reportingInstances', ...PORTFOLIO_METRIC_SET_KEYS];
const PORTFOLIO_HISTORY_COVERAGE_KEYS = [
  'totalInstances', 'reportingInstances', 'partialInstances', 'staleInstances',
  'unavailableInstances', 'savedInstances', 'duplicateSavedOrigins',
] as const;

function isPortfolioMetricSetSnapshot(value: unknown, includeReporting = false): boolean {
  if (!isRecord(value)) return false;
  const requiredKeys = [...(includeReporting ? ['reportingInstances'] : []), ...PORTFOLIO_LEGACY_METRIC_SET_KEYS];
  return requiredKeys.every((key) => isPortfolioMetricSnapshot(value[key]))
    && PORTFOLIO_LIFECYCLE_METRIC_KEYS.every((key) => (
      value[key] === undefined || isPortfolioMetricSnapshot(value[key])
    ));
}

function isPortfolioConnectionSnapshot(value: unknown): boolean {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && typeof value.instanceId === 'string'
    && typeof value.instanceLabel === 'string'
    && isPortfolioMetricSnapshot(value.dashboards)
    && isPortfolioMetricSnapshot(value.models)
    && isPortfolioMetricSnapshot(value.topics);
}

function isPortfolioInstanceSnapshot(value: unknown): boolean {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.label === 'string'
    && isPortfolioMetricSetSnapshot(value.metrics)
    && Array.isArray(value.connections)
    && value.connections.every(isPortfolioConnectionSnapshot);
}

function isPortfolioOverviewSnapshotShape(value: unknown): value is Record<string, unknown> {
  return isRecord(value)
    && value.schemaVersion === 1
    && typeof value.generatedAt === 'string'
    && typeof value.servedAt === 'string'
    && isRecord(value.cache)
    && isRecord(value.refresh)
    && isRecord(value.coverage)
    && isPortfolioMetricSetSnapshot(value.metrics, true)
    && Array.isArray(value.instances)
    && value.instances.every(isPortfolioInstanceSnapshot)
    && Array.isArray(value.connections)
    && value.connections.every(isPortfolioConnectionSnapshot)
    && Array.isArray(value.duplicateSavedOrigins)
    && (value.failures === undefined
      || (Array.isArray(value.failures) && value.failures.every(isPortfolioFailureSnapshot)))
    && Array.isArray(value.warnings)
    && value.warnings.every((warning) => typeof warning === 'string')
    && typeof value.partial === 'boolean'
    && typeof value.stale === 'boolean';
}

function normalizePortfolioOverviewSnapshot(raw: unknown): VaultPortfolioOverviewSnapshot | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const candidate = raw as Partial<VaultPortfolioOverviewSnapshot>;
  const fingerprint = cleanOptionalText(candidate.fingerprint, 128);
  if (!fingerprint || !/^[a-f0-9]{64}$/i.test(fingerprint) || !Number.isFinite(candidate.storedAt)) return undefined;
  try {
    const overview = sanitizePortfolioSnapshotValue(candidate.overview);
    if (!isPortfolioOverviewSnapshotShape(overview)) return undefined;
    const normalized: VaultPortfolioOverviewSnapshot = {
      fingerprint: fingerprint.toLowerCase(),
      storedAt: Math.max(0, Math.floor(candidate.storedAt!)),
      overview,
    };
    if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > PORTFOLIO_SNAPSHOT_MAX_BYTES) return undefined;
    return normalized;
  } catch {
    return undefined;
  }
}

function utcDay(storedAt: number): string | null {
  if (!Number.isFinite(storedAt) || storedAt < 0) return null;
  try {
    return new Date(Math.floor(storedAt)).toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

function isPortfolioHistoryTimestamp(value: string): boolean {
  return !EMAIL_LIKE_TEXT.test(value)
    && !/^https?:\/\//i.test(value)
    && Number.isFinite(Date.parse(value));
}

function compactHistoryMetric(raw: unknown): VaultPortfolioOverviewHistoryMetric | null {
  if (!isRecord(raw) || !isRecord(raw.coverage)) return null;
  const metric = raw as Record<string, unknown> & { coverage: Record<string, unknown> };
  const status = cleanOptionalText(metric.status, 80);
  const source = cleanOptionalText(metric.source, 120) || 'legacy_snapshot_unknown';
  const asOf = cleanOptionalText(metric.asOf, 80);
  const included = metric.coverage.included;
  const total = metric.coverage.total;
  const value = metric.value;
  const reasonCode = metric.reasonCode === null ? null : cleanOptionalText(metric.reasonCode, 160);
  const reasonLabel = cleanOptionalText(metric.reasonLabel, 320);
  const rawExclusions = metric.exclusions;
  const exclusions = rawExclusions === undefined
    ? ['LEGACY_HISTORY_PROVENANCE_UNKNOWN']
    : Array.isArray(rawExclusions)
      ? rawExclusions.map((entry) => cleanOptionalText(entry, 160)).filter((entry): entry is string => Boolean(entry))
      : null;
  if (!status
    || !source
    || !asOf
    || EMAIL_LIKE_TEXT.test(status)
    || EMAIL_LIKE_TEXT.test(source)
    || !isPortfolioHistoryTimestamp(asOf)
    || /^https?:\/\//i.test(status)
    || /^https?:\/\//i.test(source)
    || /^https?:\/\//i.test(asOf)
    || (value !== null && (!Number.isFinite(value) || typeof value !== 'number'))
    || !Number.isFinite(included)
    || !Number.isFinite(total)
    || (included as number) < 0
    || (total as number) < 0
    || (metric.reasonCode !== null && (!reasonCode
      || EMAIL_LIKE_TEXT.test(reasonCode)
      || /^https?:\/\//i.test(reasonCode)))
    || exclusions === null
    || (Array.isArray(rawExclusions) && exclusions.length !== rawExclusions.length)
    || exclusions.some((entry) => EMAIL_LIKE_TEXT.test(entry) || /^https?:\/\//i.test(entry))
    || (metric.reasonLabel !== undefined && (!reasonLabel
      || EMAIL_LIKE_TEXT.test(reasonLabel)
      || /^https?:\/\//i.test(reasonLabel)))) return null;
  return {
    value: value as number | null,
    status,
    source,
    asOf,
    coverage: {
      included: Math.max(0, Math.floor(included as number)),
      total: Math.max(0, Math.floor(total as number)),
    },
    exclusions: [...new Set(exclusions)].sort(),
    reasonCode: reasonCode || null,
    ...(reasonLabel ? { reasonLabel } : {}),
  };
}

function compactHistoryCoverage(raw: unknown): VaultPortfolioOverviewHistoryEntry['coverage'] | null {
  if (!isRecord(raw)) return null;
  const result = {} as VaultPortfolioOverviewHistoryEntry['coverage'];
  for (const key of PORTFOLIO_HISTORY_COVERAGE_KEYS) {
    const value = raw[key];
    if (!Number.isFinite(value) || (value as number) < 0) return null;
    result[key] = Math.floor(value as number);
  }
  return result;
}

function buildPortfolioOverviewHistoryEntry(
  snapshot: VaultPortfolioOverviewSnapshot,
): VaultPortfolioOverviewHistoryEntry | null {
  const overview = snapshot.overview;
  if (!isRecord(overview.refresh) || overview.refresh.state !== 'idle') return null;
  const completedInstances = overview.refresh.completedInstances;
  const totalInstances = overview.refresh.totalInstances;
  if (!Number.isInteger(completedInstances)
    || !Number.isInteger(totalInstances)
    || (completedInstances as number) < 0
    || (totalInstances as number) < 0
    || completedInstances !== totalInstances
    || typeof overview.refresh.completedAt !== 'string'
    || !isPortfolioHistoryTimestamp(overview.refresh.completedAt)) return null;
  const day = utcDay(snapshot.storedAt);
  const generatedAt = cleanOptionalText(overview.generatedAt, 80);
  const coverage = compactHistoryCoverage(overview.coverage);
  if (!day
    || !generatedAt
    || !isPortfolioHistoryTimestamp(generatedAt)
    || !coverage
    || coverage.totalInstances !== totalInstances
    || !isRecord(overview.metrics)) return null;
  const metrics: Record<string, VaultPortfolioOverviewHistoryMetric> = {};
  for (const key of PORTFOLIO_HISTORY_METRIC_KEYS) {
    const metric = compactHistoryMetric(overview.metrics[key]);
    if (!metric) return null;
    metrics[key] = metric;
  }
  return {
    day,
    storedAt: snapshot.storedAt,
    generatedAt,
    coverage,
    metrics,
    partial: overview.partial as boolean,
    stale: overview.stale as boolean,
  };
}

function legacyLifecycleHistoryMetric(
  asOf: string,
  totalInstances: number,
): VaultPortfolioOverviewHistoryMetric {
  return {
    value: null,
    status: 'unsupported',
    source: 'legacy_snapshot_unknown',
    asOf,
    coverage: { included: 0, total: totalInstances },
    exclusions: ['ACTIVE_USER_RECORDS_NOT_UNIQUE_PEOPLE', 'LEGACY_HISTORY_METRIC_UNAVAILABLE'],
    reasonCode: 'LEGACY_HISTORY_METRIC_UNAVAILABLE',
    reasonLabel: 'This legacy history entry predates the source-record lifecycle metric',
  };
}

function normalizePortfolioOverviewHistoryEntry(raw: unknown): VaultPortfolioOverviewHistoryEntry | null {
  if (!isRecord(raw)) return null;
  const storedAt = Number.isFinite(raw.storedAt) ? Math.max(0, Math.floor(raw.storedAt as number)) : NaN;
  const day = cleanOptionalText(raw.day, 10);
  const generatedAt = cleanOptionalText(raw.generatedAt, 80);
  const coverage = compactHistoryCoverage(raw.coverage);
  if (!day
    || day !== utcDay(storedAt)
    || !generatedAt
    || !isPortfolioHistoryTimestamp(generatedAt)
    || !coverage
    || !isRecord(raw.metrics)) return null;
  if (typeof raw.partial !== 'boolean' || typeof raw.stale !== 'boolean') return null;
  const metrics: Record<string, VaultPortfolioOverviewHistoryMetric> = {};
  for (const key of PORTFOLIO_HISTORY_METRIC_KEYS) {
    const metric = compactHistoryMetric(raw.metrics[key]);
    if (metric) {
      metrics[key] = metric;
      continue;
    }
    if (PORTFOLIO_LIFECYCLE_METRIC_KEYS.includes(key)) {
      metrics[key] = legacyLifecycleHistoryMetric(generatedAt, coverage.totalInstances);
      continue;
    }
    return null;
  }
  const entry: VaultPortfolioOverviewHistoryEntry = {
    day,
    storedAt,
    generatedAt,
    coverage,
    metrics,
    partial: raw.partial,
    stale: raw.stale,
  };
  return Buffer.byteLength(JSON.stringify(entry), 'utf8') <= PORTFOLIO_HISTORY_MAX_BYTES ? entry : null;
}

function normalizePortfolioOverviewHistory(raw: unknown): VaultPortfolioOverviewHistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const byDay = new Map<string, VaultPortfolioOverviewHistoryEntry>();
  for (const candidate of raw) {
    const entry = normalizePortfolioOverviewHistoryEntry(candidate);
    const existing = entry ? byDay.get(entry.day) : undefined;
    if (entry && (!existing || entry.storedAt >= existing.storedAt)) byDay.set(entry.day, entry);
  }
  const normalized = [...byDay.values()]
    .sort((left, right) => right.day.localeCompare(left.day) || right.storedAt - left.storedAt)
    .slice(0, PORTFOLIO_HISTORY_MAX_DAYS);
  return Buffer.byteLength(JSON.stringify(normalized), 'utf8') <= PORTFOLIO_HISTORY_MAX_BYTES
    ? normalized
    : [];
}

function normalizeDeckRecipeRecord(raw: Partial<VaultDeckRecipeRecord> & { recipe?: unknown }, existing?: VaultDeckRecipeRecord): VaultDeckRecipeRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  try {
    const now = Date.now();
    const record: VaultDeckRecipeRecord = {
      id: cleanOptionalText(raw.id, 120) || existing?.id || createDeckRecipeId(),
      name: cleanOptionalText(raw.name, 100) || existing?.name || 'Untitled recipe',
      description: cleanOptionalText(raw.description, 240),
      savedForInstanceId: cleanOptionalText(raw.savedForInstanceId, 120),
      savedForInstanceLabel: cleanOptionalText(raw.savedForInstanceLabel, 120),
      savedForBaseUrlHost: cleanOptionalText(raw.savedForBaseUrlHost, 160),
      createdAt: Number.isFinite(raw.createdAt) ? Number(raw.createdAt) : existing?.createdAt || now,
      updatedAt: Number.isFinite(raw.updatedAt) ? Number(raw.updatedAt) : now,
      recipe: validateRecipe(raw.recipe),
    };
    if (deckRecipeRecordContainsForbiddenKeys(record)) {
      throw Object.assign(new Error('Deck recipe contains secret-shaped keys and cannot be stored in the vault.'), { statusCode: 400 });
    }
    return record;
  } catch {
    if (existing) throw Object.assign(new Error('Saved recipe could not be updated because the recipe payload is invalid.'), { statusCode: 400 });
    return null;
  }
}

export function normalizeVaultPayload(raw: unknown): VaultPayload {
  const parsed = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Partial<VaultPayload> : {};
  let genieProviderSeen = false;
  const llmProviders = Array.isArray(parsed.llmProviders)
    ? parsed.llmProviders.flatMap((provider) => {
        try { return [normalizeLlmProvider(provider as Partial<SavedLlmProvider>, undefined, true)]; } catch { return []; }
      }).sort((a, b) => a.name.localeCompare(b.name))
        .map((provider) => {
          if (provider.kind !== 'databricks_genie') return provider;
          if (!genieProviderSeen) {
            genieProviderSeen = true;
            return provider;
          }
          return {
            ...provider,
            enabled: false,
            lastValidatedAt: undefined,
            lastValidatedRevision: undefined,
            lastValidationStatus: undefined,
            lastValidationAttemptAt: undefined,
          };
        })
    : [];
  return {
    version: VAULT_VERSION,
    instances: Array.isArray(parsed.instances)
      ? parsed.instances.map((instance) => normalizeInstance(instance as SavedInstance))
      : [],
    deckRecipes: Array.isArray(parsed.deckRecipes)
      ? parsed.deckRecipes
          .map((record) => normalizeDeckRecipeRecord(record as Partial<VaultDeckRecipeRecord> & { recipe?: unknown }))
          .filter((record): record is VaultDeckRecipeRecord => Boolean(record))
          .sort((a, b) => b.updatedAt - a.updatedAt)
      : [],
    llmProviders,
    platformConnections: Array.isArray(parsed.platformConnections)
      ? parsed.platformConnections.flatMap((connection) => {
          try { return [normalizePlatformConnection(connection as Partial<SavedPlatformConnection>, undefined, true)]; } catch { return []; }
        }).sort((a, b) => a.name.localeCompare(b.name))
      : [],
    portfolioOverviewSnapshot: normalizePortfolioOverviewSnapshot(parsed.portfolioOverviewSnapshot),
    portfolioOverviewHistory: normalizePortfolioOverviewHistory(parsed.portfolioOverviewHistory),
  };
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase.normalize('NFKC'), salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 128 * SCRYPT_N * SCRYPT_R * 2,
  });
}

function encrypt(plaintext: string, key: Buffer): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]);
}

function decrypt(blob: Buffer, key: Buffer): string {
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = blob.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export function decryptVaultBlob(passphrase: string, blob: Buffer): string {
  if (blob.length < SALT_LEN + IV_LEN + TAG_LEN + 1) {
    throw new Error('Vault file is too small or malformed.');
  }
  const salt = blob.subarray(0, SALT_LEN);
  const encrypted = blob.subarray(SALT_LEN);
  const key = deriveKey(passphrase, salt);
  try {
    return decrypt(encrypted, key);
  } finally {
    key.fill(0);
  }
}

/**
 * Writes the vault atomically, mirroring writeJobsFile in ./jobStore.ts.
 *
 * The vault is the only copy of every saved API key, so it must never be
 * truncated in place: a crash, a full disk, or power loss part-way through a
 * direct overwrite would leave an unreadable file with no recovery path. The
 * previous ciphertext is also retained as a single `.bak` generation before the
 * rename, which is what makes an interrupted changeVaultPassphrase recoverable
 * — without it, a failed write leaves ciphertext that neither the old nor the
 * new passphrase can open.
 */
function persist(): void {
  if (!unlockedVault) throw new Error('vault locked');
  const vaultPath = getVaultPath();
  mkdirSync(dirname(vaultPath), { recursive: true });
  const encrypted = encrypt(JSON.stringify(unlockedVault.payload), unlockedVault.key);
  const contents = Buffer.concat([unlockedVault.salt, encrypted]);
  const tempPath = `${vaultPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tempPath, contents, { mode: 0o600 });
    chmodSync(tempPath, 0o600);
    if (existsSync(vaultPath)) {
      const backupPath = `${vaultPath}.bak`;
      try {
        copyFileSync(vaultPath, backupPath);
        chmodSync(backupPath, 0o600);
      } catch {
        // A backup is best effort. Never block the primary write on it.
      }
    }
    renameSync(tempPath, vaultPath);
    chmodSync(vaultPath, 0o600);
  } catch (error) {
    if (existsSync(tempPath)) {
      try {
        rmSync(tempPath, { force: true });
      } catch {
        // Best-effort cleanup only; preserve the original write error.
      }
    }
    throw error;
  }
}

function requireUnlocked(): UnlockedVault {
  enforceIdleTimeout();
  if (!unlockedVault) throw Object.assign(new Error('vault locked'), { statusCode: 423 });
  touchVault();
  return unlockedVault;
}

function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 8) return '••••';
  return `${apiKey.slice(0, 4)}••••${apiKey.slice(-4)}`;
}

function labelFromBaseUrl(baseUrl: string): string {
  try {
    const withProtocol = /^https?:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`;
    return new URL(withProtocol).host;
  } catch {
    return baseUrl;
  }
}

function toPublic(instance: SavedInstance): SavedInstancePublic {
  const { apiKey: _apiKey, ...rest } = instance;
  void _apiKey;
  return { ...rest, apiKeyMasked: maskApiKey(instance.apiKey) };
}

function normalizePortfolioAppLabel(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const label = value.trim();
  if (label.length > 160) throw new Error('App inventory label must be 160 characters or fewer.');
  if (label.includes(',') || [...label].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  })) {
    throw new Error('App inventory label cannot contain commas or control characters.');
  }
  return label;
}

function normalizeInstance(raw: Partial<SavedInstance> & { apiKey?: string }, existing?: SavedInstance): SavedInstance {
  const now = new Date().toISOString();
  const baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl.trim().replace(/\/+$/, '') : existing?.baseUrl || '';
  const replacementApiKey = typeof raw.apiKey === 'string' && raw.apiKey.trim() ? raw.apiKey.trim() : undefined;
  const apiKey = replacementApiKey || existing?.apiKey || '';
  if (!baseUrl || !apiKey) throw new Error('Instance Base URL and API key are required.');
  const baseUrlChanged = Boolean(existing && baseUrl !== existing.baseUrl);
  if (baseUrlChanged && !replacementApiKey) {
    throw Object.assign(new Error('Changing an instance Base URL requires a replacement API key.'), { statusCode: 400 });
  }
  const credentialBoundaryChanged = Boolean(existing && (
    baseUrlChanged || apiKey !== existing.apiKey
  ));

  return {
    id: existing?.id || raw.id || randomUUID(),
    label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : existing?.label || labelFromBaseUrl(baseUrl),
    role: normalizeRole(raw.role ?? existing?.role),
    baseUrl,
    apiKey,
    defaultModelId: typeof raw.defaultModelId === 'string' && raw.defaultModelId.trim() ? raw.defaultModelId.trim() : undefined,
    defaultFolderId: typeof raw.defaultFolderId === 'string' && raw.defaultFolderId.trim() ? raw.defaultFolderId.trim() : undefined,
    defaultFolderPath: typeof raw.defaultFolderPath === 'string' && raw.defaultFolderPath.trim() ? raw.defaultFolderPath.trim() : undefined,
    entityGroupSeparator: typeof raw.entityGroupSeparator === 'string' && raw.entityGroupSeparator.trim() ? raw.entityGroupSeparator : undefined,
    organizationApiKeyConfirmed: credentialBoundaryChanged ? false : raw.organizationApiKeyConfirmed === true,
    portfolioAppLabel: normalizePortfolioAppLabel(raw.portfolioAppLabel),
    metricFilter: normalizeFilter(raw.metricFilter ?? existing?.metricFilter ?? defaultFilter()),
    postMigrationActions: normalizeActions(raw.postMigrationActions ?? existing?.postMigrationActions ?? []),
    createdAt: existing?.createdAt || raw.createdAt || now,
    updatedAt: now,
    lastValidatedAt: credentialBoundaryChanged ? undefined : raw.lastValidatedAt || existing?.lastValidatedAt,
  };
}

let unlockFailureCount = 0;
let lastUnlockFailureAt = 0;
let unlockBlockedUntil = 0;

/**
 * Rejects rather than sleeps. unlockVault is synchronous, and a sleep would not
 * help anyway — concurrent requests pipeline straight past it. Refusing the
 * attempt outright bounds the guess rate no matter how many callers try at once.
 */
function assertUnlockAttemptAllowed(): void {
  const now = Date.now();
  if (unlockBlockedUntil > now) {
    const seconds = Math.ceil((unlockBlockedUntil - now) / 1000);
    throw Object.assign(
      new Error(`Too many failed unlock attempts. Wait ${seconds} second${seconds === 1 ? '' : 's'} and try again.`),
      { statusCode: 429, retryAfterSeconds: seconds },
    );
  }
  if (lastUnlockFailureAt && now - lastUnlockFailureAt > UNLOCK_ATTEMPT_RESET_MS) {
    unlockFailureCount = 0;
    lastUnlockFailureAt = 0;
  }
}

function recordUnlockFailure(): void {
  unlockFailureCount += 1;
  lastUnlockFailureAt = Date.now();
  if (unlockFailureCount <= UNLOCK_FREE_ATTEMPTS) return;
  const backoff = Math.min(
    UNLOCK_BACKOFF_MAX_MS,
    UNLOCK_BACKOFF_BASE_MS * 2 ** (unlockFailureCount - UNLOCK_FREE_ATTEMPTS - 1),
  );
  unlockBlockedUntil = Date.now() + backoff;
}

function clearUnlockFailures(): void {
  unlockFailureCount = 0;
  lastUnlockFailureAt = 0;
  unlockBlockedUntil = 0;
}

/** Exposed for tests only. */
export function resetUnlockThrottleForTests(): void {
  clearUnlockFailures();
}

export function unlockVault(passphrase: string): void {
  if (!passphrase.trim()) throw new Error('Enter a vault passphrase.');
  assertUnlockAttemptAllowed();
  const vaultPath = getVaultPath();
  mkdirSync(dirname(vaultPath), { recursive: true });

  if (!existsSync(vaultPath)) {
    const salt = randomBytes(SALT_LEN);
    const key = deriveKey(passphrase, salt);
    unlockedVault = {
      key,
      salt,
      payload: {
        version: VAULT_VERSION,
        instances: [],
        deckRecipes: [],
        llmProviders: [],
        platformConnections: [],
        portfolioOverviewHistory: [],
      },
    };
    rotateVaultSessionBoundary('A new vault session replaced the prior authorization boundary.');
    touchVault();
    persist();
    return;
  }

  const blob = readFileSync(vaultPath);
  const salt = blob.subarray(0, SALT_LEN);
  const encrypted = blob.subarray(SALT_LEN);
  const key = deriveKey(passphrase, salt);
  // Only the decrypt step distinguishes a wrong passphrase: AES-GCM verifies the
  // auth tag here, so anything that fails later is corruption, not a bad guess,
  // and must not count against the throttle.
  let json: string;
  try {
    json = decrypt(encrypted, key);
  } catch (error) {
    key.fill(0);
    recordUnlockFailure();
    throw error;
  }
  clearUnlockFailures();
  const parsed = JSON.parse(json) as Partial<VaultPayload>;
  if (parsed.version !== VAULT_VERSION) throw new Error(`Unsupported vault version: ${String(parsed.version)}`);
  unlockedVault = {
    key,
    salt: Buffer.from(salt),
    payload: normalizeVaultPayload(parsed),
  };
  rotateVaultSessionBoundary('A new vault session replaced the prior authorization boundary.');
  touchVault();
}

export function lockVault(): void {
  clearIdleTimer();
  rotateVaultSessionBoundary('The vault was locked.');
  if (unlockedVault?.key) unlockedVault.key.fill(0);
  unlockedVault = null;
  lastVaultActivityAt = 0;
  // Locking is a memory boundary as well as an authorization boundary. Cache
  // keys are credential-bound so a locked vault already blocks new reads, but
  // decrypted Omni content would otherwise sit in process memory until its TTL.
  clearReadThroughCache();
}

export function resetVault(): void {
  lockVault();
  // A reset must not leave the operator throttled out of the fresh vault.
  clearUnlockFailures();
  const vaultPath = getVaultPath();
  // Reset must leave no recoverable ciphertext behind, including the backup
  // generation persist() keeps and any temp file from an interrupted write.
  for (const path of [vaultPath, `${vaultPath}.bak`]) {
    if (existsSync(path)) rmSync(path, { force: true });
  }
  try {
    const directory = dirname(vaultPath);
    const base = `${basename(vaultPath)}.`;
    for (const entry of readdirSync(directory)) {
      if (entry.startsWith(base) && entry.endsWith('.tmp')) {
        rmSync(join(directory, entry), { force: true });
      }
    }
  } catch {
    // A missing or unreadable vault directory means there is nothing to clear.
  }
}

export function changeVaultPassphrase(currentPassphrase: string, nextPassphrase: string): void {
  if (!nextPassphrase.trim()) throw Object.assign(new Error('Enter a new vault passphrase.'), { statusCode: 400 });
  const current = requireUnlocked();
  const verify = deriveKey(currentPassphrase, current.salt);
  if (!timingSafeEqual(verify, current.key)) {
    verify.fill(0);
    throw Object.assign(new Error('Incorrect current passphrase.'), { statusCode: 400 });
  }
  verify.fill(0);
  const oldKey = current.key;
  const oldSalt = current.salt;
  const nextSalt = randomBytes(SALT_LEN);
  const nextKey = deriveKey(nextPassphrase, nextSalt);
  unlockedVault = { key: nextKey, salt: nextSalt, payload: current.payload };
  try {
    persist();
    oldKey.fill(0);
    rotateVaultSessionBoundary('The vault credential boundary changed.');
  } catch (err) {
    unlockedVault = { key: oldKey, salt: oldSalt, payload: current.payload };
    throw err;
  }
}

export function listInstances(): SavedInstancePublic[] {
  return requireUnlocked().payload.instances.map(toPublic);
}

export function getInstance(id: string): SavedInstance | undefined {
  const instance = requireUnlocked().payload.instances.find((candidate) => candidate.id === id);
  return instance ? {
    ...instance,
    [VAULT_SESSION_ABORT_SIGNAL]: vaultSessionAbortController.signal,
  } : undefined;
}

export function getPortfolioOverviewSnapshot(): VaultPortfolioOverviewSnapshot | undefined {
  const snapshot = requireUnlocked().payload.portfolioOverviewSnapshot;
  return snapshot ? structuredClone(snapshot) : undefined;
}

export function getPortfolioOverviewHistory(): VaultPortfolioOverviewHistoryEntry[] {
  return structuredClone(requireUnlocked().payload.portfolioOverviewHistory);
}

export function setPortfolioOverviewSnapshot(raw: VaultPortfolioOverviewSnapshot): void {
  const vault = requireUnlocked();
  const snapshot = normalizePortfolioOverviewSnapshot(raw);
  if (!snapshot) {
    throw Object.assign(new Error('Portfolio overview snapshot is invalid or contains prohibited data.'), { statusCode: 400 });
  }
  vault.payload.portfolioOverviewSnapshot = snapshot;
  const historyEntry = buildPortfolioOverviewHistoryEntry(snapshot);
  if (historyEntry) {
    vault.payload.portfolioOverviewHistory = normalizePortfolioOverviewHistory([
      historyEntry,
      ...vault.payload.portfolioOverviewHistory.filter((entry) => entry.day !== historyEntry.day),
    ]);
  }
  persist();
}

export function clearPortfolioOverviewSnapshot(): void {
  const vault = requireUnlocked();
  if (!vault.payload.portfolioOverviewSnapshot) return;
  delete vault.payload.portfolioOverviewSnapshot;
  persist();
}

export function upsertInstance(raw: Partial<SavedInstance> & { id?: string; apiKey?: string }): SavedInstancePublic {
  const vault = requireUnlocked();
  const existing = raw.id
    ? vault.payload.instances.find((instance) => instance.id === raw.id)
    : vault.payload.instances.find((instance) => instance.baseUrl.toLowerCase() === raw.baseUrl?.toLowerCase());
  const saved = normalizeInstance(raw, existing);
  vault.payload.instances = [
    ...vault.payload.instances.filter((instance) => instance.id !== saved.id),
    saved,
  ].sort((a, b) => a.label.localeCompare(b.label));
  persist();
  rotateVaultSessionBoundary('A saved instance authorization boundary changed.');
  return toPublic(saved);
}

export function deleteInstance(id: string): void {
  const vault = requireUnlocked();
  vault.payload.instances = vault.payload.instances.filter((instance) => instance.id !== id);
  persist();
  rotateVaultSessionBoundary('A saved instance authorization boundary was removed.');
}

export function markInstanceValidated(id: string): SavedInstancePublic {
  const vault = requireUnlocked();
  const existing = vault.payload.instances.find((instance) => instance.id === id);
  if (!existing) throw new Error('Instance not found.');
  existing.lastValidatedAt = new Date().toISOString();
  existing.updatedAt = existing.lastValidatedAt;
  persist();
  return toPublic(existing);
}

export function listDeckRecipes(): VaultDeckRecipeRecord[] {
  return [...requireUnlocked().payload.deckRecipes].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getDeckRecipe(id: string): VaultDeckRecipeRecord | undefined {
  return requireUnlocked().payload.deckRecipes.find((record) => record.id === id);
}

export function upsertDeckRecipe(raw: SaveDeckRecipeInput): VaultDeckRecipeRecord {
  const vault = requireUnlocked();
  const existing = raw.id ? vault.payload.deckRecipes.find((record) => record.id === raw.id) : undefined;
  const saved = normalizeDeckRecipeRecord(raw, existing);
  if (!saved) throw Object.assign(new Error('Deck recipe payload is invalid.'), { statusCode: 400 });
  vault.payload.deckRecipes = [
    ...vault.payload.deckRecipes.filter((record) => record.id !== saved.id),
    saved,
  ].sort((a, b) => b.updatedAt - a.updatedAt);
  persist();
  return saved;
}

export function renameDeckRecipe(id: string, name: string): VaultDeckRecipeRecord | undefined {
  const vault = requireUnlocked();
  const existing = vault.payload.deckRecipes.find((record) => record.id === id);
  if (!existing) return undefined;
  const saved = normalizeDeckRecipeRecord({ ...existing, name, updatedAt: Date.now() }, existing);
  if (!saved) throw Object.assign(new Error('Deck recipe payload is invalid.'), { statusCode: 400 });
  vault.payload.deckRecipes = vault.payload.deckRecipes.map((record) => record.id === id ? saved : record).sort((a, b) => b.updatedAt - a.updatedAt);
  persist();
  return saved;
}

export function duplicateDeckRecipe(id: string): VaultDeckRecipeRecord | undefined {
  const vault = requireUnlocked();
  const existing = vault.payload.deckRecipes.find((record) => record.id === id);
  if (!existing) return undefined;
  const now = Date.now();
  const copy = normalizeDeckRecipeRecord({
    ...existing,
    id: createDeckRecipeId(),
    name: `Copy of ${existing.name}`.slice(0, 100),
    createdAt: now,
    updatedAt: now,
  });
  if (!copy) throw Object.assign(new Error('Deck recipe payload is invalid.'), { statusCode: 400 });
  vault.payload.deckRecipes = [copy, ...vault.payload.deckRecipes].sort((a, b) => b.updatedAt - a.updatedAt);
  persist();
  return copy;
}

export function deleteDeckRecipe(id: string): void {
  const vault = requireUnlocked();
  vault.payload.deckRecipes = vault.payload.deckRecipes.filter((record) => record.id !== id);
  persist();
}

export function importDeckRecipes(records: unknown[]): VaultDeckRecipeRecord[] {
  const imported: VaultDeckRecipeRecord[] = [];
  for (const record of records) {
    const normalized = normalizeDeckRecipeRecord(record as Partial<VaultDeckRecipeRecord> & { recipe?: unknown });
    if (!normalized) continue;
    imported.push(upsertDeckRecipe(normalized));
  }
  return imported;
}

export function listLlmProviders(): SavedLlmProviderPublic[] {
  return requireUnlocked().payload.llmProviders.map(toPublicProvider);
}

export function getLlmProvider(id: string): SavedLlmProvider | undefined {
  return requireUnlocked().payload.llmProviders.find((provider) => provider.id === id);
}

export function upsertLlmProvider(raw: Partial<SavedLlmProvider>): SavedLlmProviderPublic {
  const vault = requireUnlocked();
  const existing = raw.id ? vault.payload.llmProviders.find((provider) => provider.id === raw.id) : undefined;
  const saved = normalizeLlmProvider(raw, existing);
  if (saved.kind === 'databricks_genie'
    && vault.payload.llmProviders.some((provider) => provider.kind === 'databricks_genie' && provider.id !== saved.id)) {
    throw Object.assign(new Error('Only one Databricks Genie provider can be saved. Edit or delete the existing Genie provider first.'), { statusCode: 409 });
  }
  vault.payload.llmProviders = [...vault.payload.llmProviders.filter((provider) => provider.id !== saved.id), saved]
    .sort((a, b) => a.name.localeCompare(b.name));
  persist();
  return toPublicProvider(saved);
}

export function deleteLlmProvider(id: string): void {
  const vault = requireUnlocked();
  vault.payload.llmProviders = vault.payload.llmProviders.filter((provider) => provider.id !== id);
  persist();
}

export function markLlmProviderValidated(id: string, expectedUpdatedAt: string): SavedLlmProviderPublic {
  const vault = requireUnlocked();
  const provider = vault.payload.llmProviders.find((item) => item.id === id);
  if (!provider) throw Object.assign(new Error('AI provider not found.'), { statusCode: 404 });
  if (!expectedUpdatedAt || provider.updatedAt !== expectedUpdatedAt) {
    throw Object.assign(new Error('The AI provider changed while validation was running. Test the current provider configuration again.'), {
      statusCode: 409,
      code: 'AI_PROVIDER_CONFIGURATION_STALE',
    });
  }
  if (!provider.enabled || !migrationProviderAuthModeAllowed(provider.kind, provider.authMode)) {
    throw Object.assign(new Error('This AI provider uses a retired authentication method. Replace its credential before validation.'), { statusCode: 409 });
  }
  if (EXPIRING_PROVIDER_AUTH_MODES.has(provider.authMode || defaultProviderAuthMode(provider.kind))) {
    if (!provider.credentialExpiresAt) {
      throw Object.assign(new Error('Credential expiration is required before this expiring AI provider credential can be marked validated.'), { statusCode: 409 });
    }
    if (Date.parse(provider.credentialExpiresAt) <= Date.now()) {
      throw Object.assign(new Error('This AI provider credential has expired and cannot be marked validated.'), { statusCode: 409 });
    }
  }
  provider.lastValidatedAt = new Date().toISOString();
  provider.lastValidatedRevision = expectedUpdatedAt;
  provider.lastValidationAttemptAt = provider.lastValidatedAt;
  provider.lastValidationStatus = 'valid';
  persist();
  return toPublicProvider(provider);
}

export function markLlmProviderValidationFailed(id: string, expectedUpdatedAt: string): SavedLlmProviderPublic {
  const vault = requireUnlocked();
  const provider = vault.payload.llmProviders.find((item) => item.id === id);
  if (!provider) throw Object.assign(new Error('AI provider not found.'), { statusCode: 404 });
  if (!expectedUpdatedAt || provider.updatedAt !== expectedUpdatedAt) {
    throw Object.assign(new Error('The AI provider changed while validation was running. The prior result was not applied to the current configuration.'), {
      statusCode: 409,
      code: 'AI_PROVIDER_CONFIGURATION_STALE',
    });
  }
  provider.lastValidationAttemptAt = new Date().toISOString();
  provider.lastValidatedAt = undefined;
  provider.lastValidatedRevision = undefined;
  provider.lastValidationStatus = 'failed';
  persist();
  return toPublicProvider(provider);
}

export function listPlatformConnections(): SavedPlatformConnectionPublic[] {
  return requireUnlocked().payload.platformConnections.map(toPublicPlatformConnection);
}

export function getPlatformConnection(id: string): SavedPlatformConnection | undefined {
  return requireUnlocked().payload.platformConnections.find((connection) => connection.id === id);
}

export function upsertPlatformConnection(raw: SavedPlatformConnectionWrite): SavedPlatformConnectionPublic {
  const vault = requireUnlocked();
  const existing = raw.id ? vault.payload.platformConnections.find((connection) => connection.id === raw.id) : undefined;
  const saved = normalizePlatformConnection(raw, existing);
  vault.payload.platformConnections = [...vault.payload.platformConnections.filter((connection) => connection.id !== saved.id), saved]
    .sort((a, b) => a.name.localeCompare(b.name));
  persist();
  return toPublicPlatformConnection(saved);
}

export function deletePlatformConnection(id: string): void {
  const vault = requireUnlocked();
  vault.payload.platformConnections = vault.payload.platformConnections.filter((connection) => connection.id !== id);
  persist();
}

export function markPlatformConnectionValidated(id: string, expectedUpdatedAt: string): SavedPlatformConnectionPublic {
  const vault = requireUnlocked();
  const connection = vault.payload.platformConnections.find((item) => item.id === id);
  if (!connection) throw Object.assign(new Error('Platform connection not found.'), { statusCode: 404 });
  if (!expectedUpdatedAt || connection.updatedAt !== expectedUpdatedAt) {
    throw Object.assign(new Error('The saved source changed while validation was running. Reload and test the current connection before continuing.'), { statusCode: 409 });
  }
  const authenticationIssue = savedSourceAuthenticationIssue(connection);
  if (authenticationIssue) throw Object.assign(new Error(authenticationIssue), { statusCode: 409 });
  connection.lastValidatedAt = new Date().toISOString();
  connection.lastValidatedRevision = expectedUpdatedAt;
  connection.lastValidationStatus = 'valid';
  connection.lastValidationAttemptAt = connection.lastValidatedAt;
  persist();
  return toPublicPlatformConnection(connection);
}

export function markPlatformConnectionValidationFailed(id: string, expectedUpdatedAt: string): SavedPlatformConnectionPublic {
  const vault = requireUnlocked();
  const connection = vault.payload.platformConnections.find((item) => item.id === id);
  if (!connection) throw Object.assign(new Error('Platform connection not found.'), { statusCode: 404 });
  if (!expectedUpdatedAt || connection.updatedAt !== expectedUpdatedAt) {
    throw Object.assign(new Error('The saved source changed while validation was running. The prior failure was not applied to the current configuration.'), {
      statusCode: 409,
      code: 'SOURCE_CONFIGURATION_STALE',
    });
  }
  connection.lastValidationAttemptAt = new Date().toISOString();
  connection.lastValidatedAt = undefined;
  connection.lastValidatedRevision = undefined;
  connection.lastValidationStatus = 'failed';
  persist();
  return toPublicPlatformConnection(connection);
}

export function vaultStatus() {
  enforceIdleTimeout();
  return {
    unlocked: isVaultUnlocked(),
    exists: vaultExists(),
    path: getVaultPath(),
    idleTimeoutMs: getVaultIdleTimeoutMs(),
    lastActivityAt: lastVaultActivityAt || undefined,
    instanceCount: unlockedVault?.payload.instances.length ?? 0,
    deckRecipeCount: unlockedVault?.payload.deckRecipes.length ?? 0,
    llmProviderCount: unlockedVault?.payload.llmProviders.length ?? 0,
    platformConnectionCount: unlockedVault?.payload.platformConnections.length ?? 0,
  };
}

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { validateRecipe } from '../../src/services/deckBuilder/deckRecipe';
import type { DeckRecipe } from '../../src/services/deckBuilder/types';

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

export interface SavedInstance {
  id: string;
  label: string;
  role: InstanceRole;
  baseUrl: string;
  apiKey: string;
  defaultModelId?: string;
  defaultFolderId?: string;
  defaultFolderPath?: string;
  entityGroupSeparator?: string;
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
  | 'databricks_model_serving'
  | 'custom_openai_compatible';

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
  credential: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastValidatedAt?: string;
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
  credential: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastValidatedAt?: string;
}

export type SavedPlatformConnectionPublic = Omit<SavedPlatformConnection, 'credential'> & {
  credentialMasked: string;
  hasCredential: boolean;
};

export type MigrationProjectStage = 'connect' | 'scope' | 'analyze' | 'resolve' | 'review' | 'run' | 'reconcile';

export interface SavedMigrationProject {
  id: string;
  name: string;
  description?: string;
  sourcePlatform: MigrationPlatformKind;
  sourceConnectionId?: string;
  providerId: string;
  targetPlatform: 'omni';
  targetInstanceId: string;
  targetModelId?: string;
  stage: MigrationProjectStage;
  promptSchemaVersion: string;
  canonicalSchemaVersion: string;
  createdAt: string;
  updatedAt: string;
}

interface VaultPayload {
  version: typeof VAULT_VERSION;
  instances: SavedInstance[];
  deckRecipes: VaultDeckRecipeRecord[];
  llmProviders: SavedLlmProvider[];
  platformConnections: SavedPlatformConnection[];
  migrationProjects: SavedMigrationProject[];
}

interface UnlockedVault {
  key: Buffer;
  salt: Buffer;
  payload: VaultPayload;
}

let unlockedVault: UnlockedVault | null = null;
let lastVaultActivityAt = 0;
let idleTimer: NodeJS.Timeout | null = null;

export function getVaultPath(): string {
  return process.env.OMNIKIT_VAULT_PATH || DEFAULT_VAULT_PATH;
}

export function getVaultIdleTimeoutMs(): number {
  const raw = Number(process.env.OMNIKIT_VAULT_IDLE_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return DEFAULT_IDLE_TIMEOUT_MS;
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

const PROJECT_STAGES = new Set<MigrationProjectStage>(['connect', 'scope', 'analyze', 'resolve', 'review', 'run', 'reconcile']);

function normalizeProviderKind(value: unknown): MigrationProviderKind {
  if (typeof value === 'string' && PROVIDER_KINDS.has(value as MigrationProviderKind)) return value as MigrationProviderKind;
  throw Object.assign(new Error('Select a supported AI provider.'), { statusCode: 400 });
}

function normalizePlatformKind(value: unknown): MigrationPlatformKind {
  if (typeof value === 'string' && PLATFORM_KINDS.has(value as MigrationPlatformKind)) return value as MigrationPlatformKind;
  throw Object.assign(new Error('Select a supported migration platform.'), { statusCode: 400 });
}

function normalizeProjectStage(value: unknown): MigrationProjectStage {
  return typeof value === 'string' && PROJECT_STAGES.has(value as MigrationProjectStage)
    ? value as MigrationProjectStage
    : 'connect';
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
  const { credential: _credential, ...rest } = connection;
  void _credential;
  return { ...rest, credentialMasked: maskedCredential(connection.credential), hasCredential: Boolean(connection.credential) };
}

function normalizeLlmProvider(raw: Partial<SavedLlmProvider>, existing?: SavedLlmProvider): SavedLlmProvider {
  const now = new Date().toISOString();
  const kind = normalizeProviderKind(raw.kind ?? existing?.kind);
  const credential = cleanOptionalText(raw.credential, 16_384) ?? existing?.credential ?? '';
  const linkedInstanceId = cleanOptionalText(raw.linkedInstanceId, 160) ?? existing?.linkedInstanceId;
  if (kind === 'omni_ai' && !linkedInstanceId) {
    throw Object.assign(new Error('Omni AI providers must reference a saved Omni instance.'), { statusCode: 400 });
  }
  if (kind !== 'omni_ai' && !credential) {
    throw Object.assign(new Error('Provider credential is required.'), { statusCode: 400 });
  }
  return {
    id: existing?.id || cleanOptionalText(raw.id, 160) || randomUUID(),
    name: cleanRequiredText(raw.name, 'Provider name', 120, existing?.name),
    kind,
    model: cleanRequiredText(raw.model, 'Provider model', 240, existing?.model),
    baseUrl: cleanOptionalText(raw.baseUrl, 500) ?? existing?.baseUrl,
    linkedInstanceId,
    accountIdentifier: cleanOptionalText(raw.accountIdentifier, 240) ?? existing?.accountIdentifier,
    warehouse: cleanOptionalText(raw.warehouse, 240) ?? existing?.warehouse,
    database: cleanOptionalText(raw.database, 240) ?? existing?.database,
    schema: cleanOptionalText(raw.schema, 240) ?? existing?.schema,
    credential,
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : existing?.enabled ?? true,
    createdAt: existing?.createdAt || cleanOptionalText(raw.createdAt, 80) || now,
    updatedAt: now,
    lastValidatedAt: cleanOptionalText(raw.lastValidatedAt, 80) ?? existing?.lastValidatedAt,
  };
}

function normalizePlatformConnection(raw: Partial<SavedPlatformConnection>, existing?: SavedPlatformConnection): SavedPlatformConnection {
  const now = new Date().toISOString();
  const platform = normalizePlatformKind(raw.platform ?? existing?.platform);
  const credential = cleanOptionalText(raw.credential, 16_384) ?? existing?.credential ?? '';
  if (!credential && !['dbt', 'power_bi', 'tableau', 'domo'].includes(platform)) {
    throw Object.assign(new Error('Platform credential is required for API connections.'), { statusCode: 400 });
  }
  return {
    id: existing?.id || cleanOptionalText(raw.id, 160) || randomUUID(),
    name: cleanRequiredText(raw.name, 'Connection name', 120, existing?.name),
    platform,
    baseUrl: cleanOptionalText(raw.baseUrl, 500) ?? existing?.baseUrl,
    accountIdentifier: cleanOptionalText(raw.accountIdentifier, 240) ?? existing?.accountIdentifier,
    workspaceId: cleanOptionalText(raw.workspaceId, 240) ?? existing?.workspaceId,
    projectId: cleanOptionalText(raw.projectId, 240) ?? existing?.projectId,
    siteId: cleanOptionalText(raw.siteId, 240) ?? existing?.siteId,
    clientId: cleanOptionalText(raw.clientId, 500) ?? existing?.clientId,
    username: cleanOptionalText(raw.username, 500) ?? existing?.username,
    repositoryPath: cleanOptionalText(raw.repositoryPath, 500) ?? existing?.repositoryPath,
    credential,
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : existing?.enabled ?? true,
    createdAt: existing?.createdAt || cleanOptionalText(raw.createdAt, 80) || now,
    updatedAt: now,
    lastValidatedAt: cleanOptionalText(raw.lastValidatedAt, 80) ?? existing?.lastValidatedAt,
  };
}

function normalizeMigrationProject(raw: Partial<SavedMigrationProject>, existing?: SavedMigrationProject): SavedMigrationProject {
  const now = new Date().toISOString();
  return {
    id: existing?.id || cleanOptionalText(raw.id, 160) || randomUUID(),
    name: cleanRequiredText(raw.name, 'Project name', 120, existing?.name),
    description: cleanOptionalText(raw.description, 500) ?? existing?.description,
    sourcePlatform: normalizePlatformKind(raw.sourcePlatform ?? existing?.sourcePlatform),
    sourceConnectionId: cleanOptionalText(raw.sourceConnectionId, 160) ?? existing?.sourceConnectionId,
    providerId: cleanRequiredText(raw.providerId, 'AI provider', 160, existing?.providerId),
    targetPlatform: 'omni',
    targetInstanceId: cleanRequiredText(raw.targetInstanceId, 'Target Omni instance', 160, existing?.targetInstanceId),
    targetModelId: cleanOptionalText(raw.targetModelId, 160) ?? existing?.targetModelId,
    stage: normalizeProjectStage(raw.stage ?? existing?.stage),
    promptSchemaVersion: cleanOptionalText(raw.promptSchemaVersion, 40) ?? existing?.promptSchemaVersion ?? '1.0',
    canonicalSchemaVersion: cleanOptionalText(raw.canonicalSchemaVersion, 40) ?? existing?.canonicalSchemaVersion ?? '1.0',
    createdAt: existing?.createdAt || cleanOptionalText(raw.createdAt, 80) || now,
    updatedAt: now,
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
    llmProviders: Array.isArray(parsed.llmProviders)
      ? parsed.llmProviders.flatMap((provider) => {
          try { return [normalizeLlmProvider(provider as Partial<SavedLlmProvider>)]; } catch { return []; }
        }).sort((a, b) => a.name.localeCompare(b.name))
      : [],
    platformConnections: Array.isArray(parsed.platformConnections)
      ? parsed.platformConnections.flatMap((connection) => {
          try { return [normalizePlatformConnection(connection as Partial<SavedPlatformConnection>)]; } catch { return []; }
        }).sort((a, b) => a.name.localeCompare(b.name))
      : [],
    migrationProjects: Array.isArray(parsed.migrationProjects)
      ? parsed.migrationProjects.flatMap((project) => {
          try { return [normalizeMigrationProject(project as Partial<SavedMigrationProject>)]; } catch { return []; }
        }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      : [],
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

function persist(): void {
  if (!unlockedVault) throw new Error('vault locked');
  const vaultPath = getVaultPath();
  mkdirSync(dirname(vaultPath), { recursive: true });
  const encrypted = encrypt(JSON.stringify(unlockedVault.payload), unlockedVault.key);
  writeFileSync(vaultPath, Buffer.concat([unlockedVault.salt, encrypted]), { mode: 0o600 });
  chmodSync(vaultPath, 0o600);
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

function normalizeInstance(raw: Partial<SavedInstance> & { apiKey?: string }, existing?: SavedInstance): SavedInstance {
  const now = new Date().toISOString();
  const baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl.trim().replace(/\/+$/, '') : existing?.baseUrl || '';
  const apiKey = typeof raw.apiKey === 'string' && raw.apiKey.trim() ? raw.apiKey.trim() : existing?.apiKey || '';
  if (!baseUrl || !apiKey) throw new Error('Instance Base URL and API key are required.');

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
    metricFilter: normalizeFilter(raw.metricFilter ?? existing?.metricFilter ?? defaultFilter()),
    postMigrationActions: normalizeActions(raw.postMigrationActions ?? existing?.postMigrationActions ?? []),
    createdAt: existing?.createdAt || raw.createdAt || now,
    updatedAt: now,
    lastValidatedAt: raw.lastValidatedAt || existing?.lastValidatedAt,
  };
}

export function unlockVault(passphrase: string): void {
  if (!passphrase.trim()) throw new Error('Enter a vault passphrase.');
  const vaultPath = getVaultPath();
  mkdirSync(dirname(vaultPath), { recursive: true });

  if (!existsSync(vaultPath)) {
    const salt = randomBytes(SALT_LEN);
    const key = deriveKey(passphrase, salt);
    unlockedVault = {
      key,
      salt,
      payload: { version: VAULT_VERSION, instances: [], deckRecipes: [], llmProviders: [], platformConnections: [], migrationProjects: [] },
    };
    touchVault();
    persist();
    return;
  }

  const blob = readFileSync(vaultPath);
  const salt = blob.subarray(0, SALT_LEN);
  const encrypted = blob.subarray(SALT_LEN);
  const key = deriveKey(passphrase, salt);
  const json = decrypt(encrypted, key);
  const parsed = JSON.parse(json) as Partial<VaultPayload>;
  if (parsed.version !== VAULT_VERSION) throw new Error(`Unsupported vault version: ${String(parsed.version)}`);
  unlockedVault = {
    key,
    salt: Buffer.from(salt),
    payload: normalizeVaultPayload(parsed),
  };
  touchVault();
}

export function lockVault(): void {
  clearIdleTimer();
  if (unlockedVault?.key) unlockedVault.key.fill(0);
  unlockedVault = null;
  lastVaultActivityAt = 0;
}

export function resetVault(): void {
  lockVault();
  const vaultPath = getVaultPath();
  if (existsSync(vaultPath)) rmSync(vaultPath, { force: true });
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
  } catch (err) {
    unlockedVault = { key: oldKey, salt: oldSalt, payload: current.payload };
    throw err;
  }
}

export function listInstances(): SavedInstancePublic[] {
  return requireUnlocked().payload.instances.map(toPublic);
}

export function getInstance(id: string): SavedInstance | undefined {
  return requireUnlocked().payload.instances.find((instance) => instance.id === id);
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
  return toPublic(saved);
}

export function deleteInstance(id: string): void {
  const vault = requireUnlocked();
  vault.payload.instances = vault.payload.instances.filter((instance) => instance.id !== id);
  persist();
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
  vault.payload.llmProviders = [...vault.payload.llmProviders.filter((provider) => provider.id !== saved.id), saved]
    .sort((a, b) => a.name.localeCompare(b.name));
  persist();
  return toPublicProvider(saved);
}

export function deleteLlmProvider(id: string): void {
  const vault = requireUnlocked();
  if (vault.payload.migrationProjects.some((project) => project.providerId === id)) {
    throw Object.assign(new Error('This provider is referenced by a saved migration project.'), { statusCode: 409 });
  }
  vault.payload.llmProviders = vault.payload.llmProviders.filter((provider) => provider.id !== id);
  persist();
}

export function markLlmProviderValidated(id: string): SavedLlmProviderPublic {
  const vault = requireUnlocked();
  const provider = vault.payload.llmProviders.find((item) => item.id === id);
  if (!provider) throw Object.assign(new Error('AI provider not found.'), { statusCode: 404 });
  provider.lastValidatedAt = new Date().toISOString();
  provider.updatedAt = provider.lastValidatedAt;
  persist();
  return toPublicProvider(provider);
}

export function listPlatformConnections(): SavedPlatformConnectionPublic[] {
  return requireUnlocked().payload.platformConnections.map(toPublicPlatformConnection);
}

export function getPlatformConnection(id: string): SavedPlatformConnection | undefined {
  return requireUnlocked().payload.platformConnections.find((connection) => connection.id === id);
}

export function upsertPlatformConnection(raw: Partial<SavedPlatformConnection>): SavedPlatformConnectionPublic {
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
  if (vault.payload.migrationProjects.some((project) => project.sourceConnectionId === id)) {
    throw Object.assign(new Error('This connection is referenced by a saved migration project.'), { statusCode: 409 });
  }
  vault.payload.platformConnections = vault.payload.platformConnections.filter((connection) => connection.id !== id);
  persist();
}

export function markPlatformConnectionValidated(id: string): SavedPlatformConnectionPublic {
  const vault = requireUnlocked();
  const connection = vault.payload.platformConnections.find((item) => item.id === id);
  if (!connection) throw Object.assign(new Error('Platform connection not found.'), { statusCode: 404 });
  connection.lastValidatedAt = new Date().toISOString();
  connection.updatedAt = connection.lastValidatedAt;
  persist();
  return toPublicPlatformConnection(connection);
}

export function listMigrationProjects(): SavedMigrationProject[] {
  return [...requireUnlocked().payload.migrationProjects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getMigrationProject(id: string): SavedMigrationProject | undefined {
  return requireUnlocked().payload.migrationProjects.find((project) => project.id === id);
}

export function upsertMigrationProject(raw: Partial<SavedMigrationProject>): SavedMigrationProject {
  const vault = requireUnlocked();
  const existing = raw.id ? vault.payload.migrationProjects.find((project) => project.id === raw.id) : undefined;
  const saved = normalizeMigrationProject(raw, existing);
  if (!vault.payload.llmProviders.some((provider) => provider.id === saved.providerId)) {
    throw Object.assign(new Error('Saved AI provider not found.'), { statusCode: 400 });
  }
  if (!vault.payload.instances.some((instance) => instance.id === saved.targetInstanceId)) {
    throw Object.assign(new Error('Saved target Omni instance not found.'), { statusCode: 400 });
  }
  vault.payload.migrationProjects = [...vault.payload.migrationProjects.filter((project) => project.id !== saved.id), saved]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  persist();
  return saved;
}

export function deleteMigrationProject(id: string): void {
  const vault = requireUnlocked();
  vault.payload.migrationProjects = vault.payload.migrationProjects.filter((project) => project.id !== id);
  persist();
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
    migrationProjectCount: unlockedVault?.payload.migrationProjects.length ?? 0,
  };
}

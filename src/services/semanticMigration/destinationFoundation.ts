export const DESTINATION_FOUNDATION_PLAN_VERSION = '1.0' as const;
export const DESTINATION_FOUNDATION_STATE_VERSION = '1.0' as const;

export type DestinationFoundationMode = 'existing_model' | 'existing_connection' | 'new_connection';

const DETECTED_SCHEMA_MODEL_CHOICE_PREFIX = '@omnikit/schema-model/id/';
const REUSE_SCHEMA_MODEL_NAME_CHOICE_PREFIX = '@omnikit/schema-model/name/';

export type DestinationFoundationSchemaModelChoice =
  | { strategy: 'detected'; modelId: string }
  | { strategy: 'reuse_existing'; modelName: string }
  | { strategy: 'create_new'; modelName: string };

export function encodeDestinationFoundationSchemaModelChoice(
  choice: Exclude<DestinationFoundationSchemaModelChoice, { strategy: 'create_new' }>,
): string {
  const value = choice.strategy === 'detected' ? choice.modelId : choice.modelName;
  const prefix = choice.strategy === 'detected'
    ? DETECTED_SCHEMA_MODEL_CHOICE_PREFIX
    : REUSE_SCHEMA_MODEL_NAME_CHOICE_PREFIX;
  return `${prefix}${encodeURIComponent(value)}`;
}

function decodeSchemaModelChoiceValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return '';
  }
}

export function decodeDestinationFoundationSchemaModelChoice(
  value: string,
): DestinationFoundationSchemaModelChoice {
  if (value.startsWith(DETECTED_SCHEMA_MODEL_CHOICE_PREFIX)) {
    return {
      strategy: 'detected',
      modelId: decodeSchemaModelChoiceValue(value.slice(DETECTED_SCHEMA_MODEL_CHOICE_PREFIX.length)),
    };
  }
  if (value.startsWith(REUSE_SCHEMA_MODEL_NAME_CHOICE_PREFIX)) {
    return {
      strategy: 'reuse_existing',
      modelName: decodeSchemaModelChoiceValue(value.slice(REUSE_SCHEMA_MODEL_NAME_CHOICE_PREFIX.length)),
    };
  }
  return { strategy: 'create_new', modelName: value };
}

interface DestinationFoundationPlanBase {
  version: typeof DESTINATION_FOUNDATION_PLAN_VERSION;
  targetInstanceId: string;
  mode: DestinationFoundationMode;
}

export interface ExistingModelDestinationFoundationPlan extends DestinationFoundationPlanBase {
  mode: 'existing_model';
  modelId: string;
}

interface ExistingConnectionDestinationFoundationPlanBase extends DestinationFoundationPlanBase {
  mode: 'existing_connection';
  connectionId: string;
  sharedModelName: string;
}

export interface ExistingConnectionDetectedSchemaModelPlan extends ExistingConnectionDestinationFoundationPlanBase {
  schemaModelId: string;
  schemaModelName?: never;
  reuseExistingSchemaModel?: never;
}

export interface ExistingConnectionNamedSchemaModelPlan extends ExistingConnectionDestinationFoundationPlanBase {
  schemaModelName: string;
  schemaModelId?: never;
  reuseExistingSchemaModel?: boolean;
}

export type ExistingConnectionDestinationFoundationPlan =
  | ExistingConnectionDetectedSchemaModelPlan
  | ExistingConnectionNamedSchemaModelPlan;

export interface DestinationVaultCredentialReference {
  kind: 'vault_credential';
  id: string;
}

export interface NewConnectionDestinationFoundationPlan extends DestinationFoundationPlanBase {
  mode: 'new_connection';
  connectionName: string;
  dialect: string;
  credentialReference: DestinationVaultCredentialReference;
  schemaModelName: string;
  sharedModelName: string;
}

export type DestinationFoundationPlan =
  | ExistingModelDestinationFoundationPlan
  | ExistingConnectionDestinationFoundationPlan
  | NewConnectionDestinationFoundationPlan;

export interface DestinationFoundationConnection {
  id: string;
  name: string;
  dialect: string;
  database?: string;
  defaultSchema?: string;
}

export interface DestinationFoundationSchemaModel {
  id: string;
  name: string;
  connectionId?: string;
}

export interface DestinationFoundationSharedModel {
  id: string;
  name: string;
  connectionId?: string;
  baseModelId?: string;
  kind: 'SHARED' | 'SHARED_EXTENSION';
}

export interface DestinationFoundationInventory {
  version: typeof DESTINATION_FOUNDATION_PLAN_VERSION;
  targetInstanceId: string;
  connections: DestinationFoundationConnection[];
  schemaModels: DestinationFoundationSchemaModel[];
  sharedModels: DestinationFoundationSharedModel[];
}

export function defaultDestinationFoundationSchemaModelChoice(
  inventory: DestinationFoundationInventory | null,
  connectionId: string,
): string {
  if (!connectionId) return '';
  const detected = inventory?.schemaModels.find((model) => model.connectionId === connectionId);
  return detected
    ? encodeDestinationFoundationSchemaModelChoice({ strategy: 'detected', modelId: detected.id })
    : encodeDestinationFoundationSchemaModelChoice({ strategy: 'reuse_existing', modelName: '' });
}

export type DestinationFoundationPhase =
  | 'inventory'
  | 'model'
  | 'connection'
  | 'schema_model'
  | 'schema_refresh'
  | 'shared_model'
  | 'ready'
  | 'failed';

export interface DestinationFoundationState {
  version: typeof DESTINATION_FOUNDATION_STATE_VERSION;
  plan: DestinationFoundationPlan;
  phase: DestinationFoundationPhase;
  connectionId?: string;
  schemaModelId?: string;
  sharedModelId?: string;
  refreshJobId?: string;
  reusedConnection?: boolean;
  reusedSchemaModel?: boolean;
  reusedSharedModel?: boolean;
  error?: {
    code: string;
    message: string;
  };
}

export type DestinationFoundationEvent =
  | { type: 'inventory_loaded' }
  | { type: 'existing_model_resolved'; modelId: string }
  | { type: 'connection_resolved'; connectionId: string; reused: boolean }
  | { type: 'schema_model_resolved'; schemaModelId: string; reused: boolean }
  | { type: 'schema_refresh_started'; jobId?: string }
  | { type: 'schema_refresh_succeeded' }
  | { type: 'shared_model_resolved'; sharedModelId: string; reused: boolean }
  | {
      type: 'foundation_resolved';
      connectionId: string;
      schemaModelId: string;
      sharedModelId: string;
    }
  | { type: 'failed'; code: string; message: string };

export interface DestinationFoundationProvisionResult {
  version: typeof DESTINATION_FOUNDATION_PLAN_VERSION;
  state: DestinationFoundationState;
  inventory: DestinationFoundationInventory;
  created: {
    connection: boolean;
    schemaModel: boolean;
    sharedModel: boolean;
  };
  run?: {
    id: string;
    version: number;
    phase: 'READY_FOR_YAML' | 'RECONCILE_REQUIRED' | 'FAILED';
    planHash: string;
  };
}

export class DestinationFoundationPlanError extends Error {
  readonly code = 'invalid_destination_foundation_plan';
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = 'DestinationFoundationPlanError';
  }
}

const FORBIDDEN_BROWSER_SECRET_KEYS = new Set([
  'apikey',
  'authorization',
  'clientsecret',
  'credential',
  'password',
  'privatekey',
  'refreshtoken',
  'secret',
  'token',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizedKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function destinationFoundationPlanHasBrowserSecrets(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(destinationFoundationPlanHasBrowserSecrets);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, child]) => (
    FORBIDDEN_BROWSER_SECRET_KEYS.has(normalizedKey(key))
    || destinationFoundationPlanHasBrowserSecrets(child)
  ));
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: Set<string>): void {
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected) throw new DestinationFoundationPlanError(`Destination foundation field is not supported: ${unexpected}.`);
}

function requiredString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new DestinationFoundationPlanError(`${label} is required.`);
  }
  const cleaned = value.trim();
  const hasControlCharacter = Array.from(cleaned).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  if (cleaned.length > maxLength || hasControlCharacter) {
    throw new DestinationFoundationPlanError(`${label} is invalid.`);
  }
  return cleaned;
}

export function parseDestinationFoundationPlan(value: unknown): DestinationFoundationPlan {
  if (!isRecord(value)) throw new DestinationFoundationPlanError('Destination foundation plan must be an object.');
  if (destinationFoundationPlanHasBrowserSecrets(value)) {
    throw new DestinationFoundationPlanError('Browser-supplied connection secrets are not accepted. Use a vault-held credential reference.');
  }

  const version = requiredString(value.version, 'Destination foundation plan version', 20);
  if (version !== DESTINATION_FOUNDATION_PLAN_VERSION) {
    throw new DestinationFoundationPlanError('Destination foundation plan version is not supported.');
  }
  const targetInstanceId = requiredString(value.targetInstanceId, 'Target Omni instance', 200);
  const mode = requiredString(value.mode, 'Destination foundation mode', 40);

  if (mode === 'existing_model') {
    assertAllowedKeys(value, new Set(['version', 'targetInstanceId', 'mode', 'modelId']));
    return {
      version: DESTINATION_FOUNDATION_PLAN_VERSION,
      targetInstanceId,
      mode,
      modelId: requiredString(value.modelId, 'Destination model', 200),
    };
  }

  if (mode === 'existing_connection') {
    assertAllowedKeys(value, new Set([
      'version',
      'targetInstanceId',
      'mode',
      'connectionId',
      'schemaModelId',
      'schemaModelName',
      'reuseExistingSchemaModel',
      'sharedModelName',
    ]));
    if (value.schemaModelId !== undefined && value.schemaModelName !== undefined) {
      throw new DestinationFoundationPlanError('Choose either a detected schema model or a schema model name, not both.');
    }
    if (value.reuseExistingSchemaModel !== undefined && typeof value.reuseExistingSchemaModel !== 'boolean') {
      throw new DestinationFoundationPlanError('Schema model reuse selection is invalid.');
    }
    const connectionId = requiredString(value.connectionId, 'Destination connection', 200);
    const sharedModelName = requiredString(value.sharedModelName, 'Shared model name', 120);
    if (value.schemaModelId !== undefined) {
      if (value.reuseExistingSchemaModel !== undefined) {
        throw new DestinationFoundationPlanError('Detected schema models are already explicit reuse selections.');
      }
      return {
        version: DESTINATION_FOUNDATION_PLAN_VERSION,
        targetInstanceId,
        mode,
        connectionId,
        schemaModelId: requiredString(value.schemaModelId, 'Schema model', 200),
        sharedModelName,
      };
    }
    const schemaModelChoice = decodeDestinationFoundationSchemaModelChoice(
      requiredString(value.schemaModelName, 'Schema model name', 300),
    );
    if (schemaModelChoice.strategy === 'detected') {
      return {
        version: DESTINATION_FOUNDATION_PLAN_VERSION,
        targetInstanceId,
        mode,
        connectionId,
        schemaModelId: requiredString(schemaModelChoice.modelId, 'Schema model', 200),
        sharedModelName,
      };
    }
    const schemaModelName = requiredString(
      schemaModelChoice.modelName,
      'Schema model name',
      120,
    );
    const reuseExistingSchemaModel = schemaModelChoice.strategy === 'reuse_existing'
      || value.reuseExistingSchemaModel === true;
    return {
      version: DESTINATION_FOUNDATION_PLAN_VERSION,
      targetInstanceId,
      mode,
      connectionId,
      schemaModelName,
      ...(reuseExistingSchemaModel ? { reuseExistingSchemaModel: true } : {}),
      sharedModelName,
    };
  }

  if (mode === 'new_connection') {
    assertAllowedKeys(value, new Set([
      'version',
      'targetInstanceId',
      'mode',
      'connectionName',
      'dialect',
      'credentialReference',
      'schemaModelName',
      'sharedModelName',
    ]));
    if (!isRecord(value.credentialReference)) {
      throw new DestinationFoundationPlanError('A vault-held credential reference is required.');
    }
    assertAllowedKeys(value.credentialReference, new Set(['kind', 'id']));
    if (value.credentialReference.kind !== 'vault_credential') {
      throw new DestinationFoundationPlanError('Vault credential reference kind is not supported.');
    }
    return {
      version: DESTINATION_FOUNDATION_PLAN_VERSION,
      targetInstanceId,
      mode,
      connectionName: requiredString(value.connectionName, 'Destination connection name', 120),
      dialect: requiredString(value.dialect, 'Destination connection dialect', 80),
      credentialReference: {
        kind: 'vault_credential',
        id: requiredString(value.credentialReference.id, 'Vault credential reference', 200),
      },
      schemaModelName: requiredString(value.schemaModelName, 'Schema model name', 120),
      sharedModelName: requiredString(value.sharedModelName, 'Shared model name', 120),
    };
  }

  throw new DestinationFoundationPlanError('Destination foundation mode is not supported.');
}

export function createDestinationFoundationState(plan: DestinationFoundationPlan): DestinationFoundationState {
  return {
    version: DESTINATION_FOUNDATION_STATE_VERSION,
    plan,
    phase: 'inventory',
  };
}

function requirePhase(state: DestinationFoundationState, event: DestinationFoundationEvent, phases: DestinationFoundationPhase[]): void {
  if (!phases.includes(state.phase)) {
    throw new Error(`Destination foundation event ${event.type} is not valid during ${state.phase}.`);
  }
}

export function transitionDestinationFoundationState(
  state: DestinationFoundationState,
  event: DestinationFoundationEvent,
): DestinationFoundationState {
  if (event.type === 'failed') {
    return { ...state, phase: 'failed', error: { code: event.code, message: event.message } };
  }
  if (event.type === 'inventory_loaded') {
    requirePhase(state, event, ['inventory']);
    return { ...state, phase: state.plan.mode === 'existing_model' ? 'model' : 'connection' };
  }
  if (event.type === 'existing_model_resolved') {
    requirePhase(state, event, ['model']);
    return { ...state, phase: 'ready', sharedModelId: event.modelId, reusedSharedModel: true };
  }
  if (event.type === 'connection_resolved') {
    requirePhase(state, event, ['connection']);
    return { ...state, phase: 'schema_model', connectionId: event.connectionId, reusedConnection: event.reused };
  }
  if (event.type === 'schema_model_resolved') {
    requirePhase(state, event, ['schema_model']);
    return { ...state, phase: 'schema_refresh', schemaModelId: event.schemaModelId, reusedSchemaModel: event.reused };
  }
  if (event.type === 'schema_refresh_started') {
    requirePhase(state, event, ['schema_refresh']);
    return { ...state, refreshJobId: event.jobId };
  }
  if (event.type === 'schema_refresh_succeeded') {
    requirePhase(state, event, ['schema_refresh']);
    return { ...state, phase: 'shared_model' };
  }
  if (event.type === 'shared_model_resolved') {
    requirePhase(state, event, ['shared_model']);
    return { ...state, phase: 'ready', sharedModelId: event.sharedModelId, reusedSharedModel: event.reused };
  }
  if (event.type === 'foundation_resolved') {
    requirePhase(state, event, ['connection', 'schema_model', 'schema_refresh', 'shared_model']);
    return {
      ...state,
      phase: 'ready',
      connectionId: event.connectionId,
      schemaModelId: event.schemaModelId,
      sharedModelId: event.sharedModelId,
      reusedConnection: true,
      reusedSchemaModel: true,
      reusedSharedModel: true,
    };
  }
  return state;
}

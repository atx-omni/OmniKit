import {
  CheckCircle2,
  Database,
  Loader2,
  Plus,
  RefreshCw,
  ServerCog,
  ShieldCheck,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type {
  DestinationFoundationInventory,
  DestinationFoundationMode,
  DestinationFoundationProvisionResult,
} from '@/services/semanticMigration/destinationFoundation';
import {
  decodeDestinationFoundationSchemaModelChoice,
  defaultDestinationFoundationSchemaModelChoice,
  encodeDestinationFoundationSchemaModelChoice,
} from '@/services/semanticMigration/destinationFoundation';

type ApprovalState = {
  existingDestination: boolean;
  createSharedModel: boolean;
  approvedEnvironment: boolean;
  leastPrivilegeCredential: boolean;
  createConnectionAndModel: boolean;
};

export interface MigrationDestinationFoundationPanelProps {
  mode: DestinationFoundationMode;
  onModeChange: (mode: DestinationFoundationMode) => void;
  inventory: DestinationFoundationInventory | null;
  inventoryLoading: boolean;
  inventoryError?: string;
  onRefreshInventory: () => void;
  selectedConnectionId: string;
  onSelectedConnectionIdChange: (connectionId: string) => void;
  schemaModelName: string;
  onSchemaModelNameChange: (name: string) => void;
  sharedModelName: string;
  onSharedModelNameChange: (name: string) => void;
  newConnectionEnabled: boolean;
  connectionName: string;
  onConnectionNameChange: (name: string) => void;
  connectionDialect: string;
  onConnectionDialectChange: (dialect: string) => void;
  credentialReferenceId: string;
  onCredentialReferenceIdChange: (id: string) => void;
  approvals: ApprovalState;
  onApprovalChange: (approval: keyof ApprovalState, checked: boolean) => void;
  provisioning: boolean;
  provisionResult: DestinationFoundationProvisionResult | null;
  provisionError?: string;
  onProvision: () => void;
  existingModelPicker: ReactNode;
  existingModelReady: boolean;
}

const MODES: Array<{
  id: DestinationFoundationMode;
  label: string;
  summary: string;
  icon: typeof Database;
}> = [
  {
    id: 'existing_model',
    label: 'Use what exists',
    summary: 'Use an approved shared model and its current connection.',
    icon: Database,
  },
  {
    id: 'existing_connection',
    label: 'Build from this connection',
    summary: 'Create a shared model from an existing Omni connection and warehouse structure.',
    icon: ServerCog,
  },
  {
    id: 'new_connection',
    label: 'Set up Omni from scratch',
    summary: 'Create a connection, prepare its warehouse structure, and create a shared model.',
    icon: Plus,
  },
];

const DIALECTS = [
  { id: 'snowflake', label: 'Snowflake' },
  { id: 'databricks', label: 'Databricks' },
  { id: 'bigquery', label: 'BigQuery' },
  { id: 'postgres', label: 'PostgreSQL' },
  { id: 'motherduck', label: 'MotherDuck' },
];

const REUSE_EXISTING_SCHEMA_MODEL = 'reuse_existing';
const CREATE_NEW_SCHEMA_MODEL = 'create_new';

function approvalRow(
  checked: boolean,
  onChange: (checked: boolean) => void,
  label: string,
  disabled = false,
) {
  return (
    <label className={`flex items-start gap-2 text-xs leading-relaxed text-content-secondary ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-4 w-4 accent-omni-600 disabled:cursor-not-allowed"
      />
      <span>{label}</span>
    </label>
  );
}

export function MigrationDestinationFoundationPanel({
  mode,
  onModeChange,
  inventory,
  inventoryLoading,
  inventoryError,
  onRefreshInventory,
  selectedConnectionId,
  onSelectedConnectionIdChange,
  schemaModelName,
  onSchemaModelNameChange,
  sharedModelName,
  onSharedModelNameChange,
  newConnectionEnabled,
  connectionName,
  onConnectionNameChange,
  connectionDialect,
  onConnectionDialectChange,
  credentialReferenceId,
  onCredentialReferenceIdChange,
  approvals,
  onApprovalChange,
  provisioning,
  provisionResult,
  provisionError,
  onProvision,
  existingModelPicker,
  existingModelReady,
}: MigrationDestinationFoundationPanelProps) {
  const connection = inventory?.connections.find((candidate) => candidate.id === selectedConnectionId);
  const detectedSchemaModels = (inventory?.schemaModels || [])
    .filter((candidate) => candidate.connectionId === selectedConnectionId);
  const schemaModelChoice = decodeDestinationFoundationSchemaModelChoice(schemaModelName);
  const selectedDetectedSchemaModel = schemaModelChoice.strategy === 'detected'
    ? detectedSchemaModels.find((candidate) => candidate.id === schemaModelChoice.modelId)
    : undefined;
  const schemaModelSelection = schemaModelChoice.strategy === 'reuse_existing'
    ? REUSE_EXISTING_SCHEMA_MODEL
    : schemaModelChoice.strategy === 'create_new'
      ? CREATE_NEW_SCHEMA_MODEL
      : selectedDetectedSchemaModel
        ? encodeDestinationFoundationSchemaModelChoice(schemaModelChoice)
        : '';
  const schemaModelReady = schemaModelChoice.strategy === 'detected'
    ? Boolean(selectedDetectedSchemaModel)
    : Boolean(schemaModelChoice.modelName.trim());
  const creationReady = mode === 'existing_connection'
    ? Boolean(selectedConnectionId && schemaModelReady && sharedModelName.trim() && approvals.createSharedModel)
    : Boolean(
      newConnectionEnabled
      && connectionName.trim()
      && connectionDialect
      && credentialReferenceId.trim()
      && schemaModelName.trim()
      && sharedModelName.trim()
      && approvals.approvedEnvironment
      && approvals.leastPrivilegeCredential
      && approvals.createConnectionAndModel
    );
  const ready = mode === 'existing_model'
    ? existingModelReady && approvals.existingDestination
    : creationReady;
  const reconciliationRequired = Boolean(provisionError?.includes('requires reconciliation'));

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 id="target-omni-model-title" className="text-base font-semibold text-content-primary">What already exists in Omni?</h2>
            <span className="rounded-chip border border-omni-200 bg-omni-50 px-2 py-0.5 text-[10px] font-semibold text-omni-800">Preview</span>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-content-secondary">Choose the closest starting point. OmniKit will verify it and will not create anything until you approve the setup plan.</p>
        </div>
        <button
          type="button"
          className="btn-secondary shrink-0 text-xs"
          onClick={onRefreshInventory}
          disabled={inventoryLoading || provisioning}
          title="Refresh destination inventory"
        >
          {inventoryLoading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          Refresh
        </button>
      </div>

      <div className="grid overflow-hidden rounded-button border border-border md:grid-cols-3" role="radiogroup" aria-label="Destination foundation mode">
        {MODES.map((option) => {
          const Icon = option.icon;
          const selected = option.id === mode;
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={provisioning}
              onClick={() => onModeChange(option.id)}
              className={`min-h-24 border-b border-border px-4 py-3 text-left transition-colors last:border-b-0 disabled:cursor-not-allowed disabled:opacity-60 md:border-b-0 md:border-r md:last:border-r-0 ${selected ? 'bg-omni-50 text-omni-900' : 'bg-white text-content-primary hover:bg-surface-secondary'}`}
            >
              <span className="flex items-center gap-2 text-sm font-semibold"><Icon size={16} /> {option.label}</span>
              <span className="mt-1.5 block text-xs leading-relaxed text-content-secondary">{option.summary}</span>
            </button>
          );
        })}
      </div>

      {inventoryError && <div className="alert-error text-xs">{inventoryError}</div>}

      {mode === 'existing_model' && (
        <div className="space-y-3">
          {existingModelPicker}
          <div className="border-t border-border pt-3">
            {approvalRow(
              approvals.existingDestination,
              (checked) => onApprovalChange('existingDestination', checked),
              'I confirm this shared model and connection are the approved destination.',
              !existingModelReady || provisioning,
            )}
          </div>
        </div>
      )}

      {mode === 'existing_connection' && (
        <div className="space-y-4 border-t border-border pt-4">
          <div className="grid gap-3 md:grid-cols-3">
            <label className="text-xs font-semibold text-content-primary">
              Existing Omni connection
              <select
                value={selectedConnectionId}
                onChange={(event) => {
                  const connectionId = event.target.value;
                  onSelectedConnectionIdChange(connectionId);
                  onSchemaModelNameChange(
                    defaultDestinationFoundationSchemaModelChoice(inventory, connectionId),
                  );
                }}
                className="mt-1 input-field w-full text-sm font-normal"
              >
                <option value="">Choose a connection</option>
                {(inventory?.connections || []).map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>{candidate.name}{candidate.dialect ? ` · ${candidate.dialect}` : ''}</option>
                ))}
              </select>
            </label>
            <label className="text-xs font-semibold text-content-primary">
              Schema model
              <select
                value={schemaModelSelection}
                onChange={(event) => {
                  if (event.target.value === REUSE_EXISTING_SCHEMA_MODEL) {
                    onSchemaModelNameChange(encodeDestinationFoundationSchemaModelChoice({
                      strategy: 'reuse_existing',
                      modelName: '',
                    }));
                    return;
                  }
                  if (event.target.value === CREATE_NEW_SCHEMA_MODEL) {
                    onSchemaModelNameChange('');
                    return;
                  }
                  onSchemaModelNameChange(event.target.value);
                }}
                className="mt-1 input-field w-full text-sm font-normal"
                disabled={!selectedConnectionId}
              >
                {detectedSchemaModels.length > 0 && <option value="">Choose a detected schema model</option>}
                {detectedSchemaModels.map((candidate) => (
                  <option
                    key={candidate.id}
                    value={encodeDestinationFoundationSchemaModelChoice({
                      strategy: 'detected',
                      modelId: candidate.id,
                    })}
                  >
                    {candidate.name}
                  </option>
                ))}
                <option value={REUSE_EXISTING_SCHEMA_MODEL}>Reuse an existing model by name or ID</option>
                <option value={CREATE_NEW_SCHEMA_MODEL}>Create a new schema model</option>
              </select>
              {schemaModelChoice.strategy === 'reuse_existing' && (
                <input
                  value={schemaModelChoice.modelName}
                  onChange={(event) => onSchemaModelNameChange(encodeDestinationFoundationSchemaModelChoice({
                    strategy: 'reuse_existing',
                    modelName: event.target.value,
                  }))}
                  className="mt-2 input-field w-full text-sm font-normal"
                  placeholder="Existing schema model name or ID"
                />
              )}
              {schemaModelChoice.strategy === 'create_new' && (
                <input
                  value={schemaModelChoice.modelName}
                  onChange={(event) => onSchemaModelNameChange(event.target.value)}
                  className="mt-2 input-field w-full text-sm font-normal"
                  placeholder="New schema model name"
                />
              )}
            </label>
            <label className="text-xs font-semibold text-content-primary">
              New shared model name
              <input value={sharedModelName} onChange={(event) => onSharedModelNameChange(event.target.value)} className="mt-1 input-field w-full text-sm font-normal" placeholder="Finance analytics" />
            </label>
          </div>
          {connection && (
            <details className="text-xs text-content-secondary">
              <summary className="cursor-pointer font-semibold text-content-primary">Technical details</summary>
              <div className="mt-2 grid gap-1 font-mono text-[11px]">
                <span>Connection: {connection.id}</span>
                <span>Dialect: {connection.dialect || 'not reported'}</span>
                {connection.database && <span>Database: {connection.database}</span>}
              </div>
            </details>
          )}
          {approvalRow(
            approvals.createSharedModel,
            (checked) => onApprovalChange('createSharedModel', checked),
            schemaModelChoice.strategy === 'create_new'
              ? 'I approve creating this schema model and shared model on the selected connection.'
              : 'I approve creating this shared model from the selected existing schema model.',
          )}
        </div>
      )}

      {mode === 'new_connection' && (
        <div className="space-y-4 border-t border-border pt-4">
          <div className="rounded-button border border-blue-200 bg-blue-50 px-3 py-2 text-xs leading-relaxed text-blue-900">
            Preview: Foundation setup requires human review. Unsupported or unverified operations remain blocked and visible.
          </div>
          {!newConnectionEnabled && (
            <div className="rounded-button border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
              Connection creation is disabled on this OmniKit server. An administrator must enable the governed connection adapter before this plan can run.
            </div>
          )}
          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-xs font-semibold text-content-primary">
              Connection name
              <input disabled={!newConnectionEnabled} value={connectionName} onChange={(event) => onConnectionNameChange(event.target.value)} className="mt-1 input-field w-full text-sm font-normal" placeholder="Production warehouse" />
            </label>
            <label className="text-xs font-semibold text-content-primary">
              Warehouse platform
              <select disabled={!newConnectionEnabled} value={connectionDialect} onChange={(event) => onConnectionDialectChange(event.target.value)} className="mt-1 input-field w-full text-sm font-normal">
                <option value="">Choose a platform</option>
                {DIALECTS.map((dialect) => <option key={dialect.id} value={dialect.id}>{dialect.label}</option>)}
              </select>
            </label>
            <label className="text-xs font-semibold text-content-primary">
              Vault credential profile
              <input disabled={!newConnectionEnabled} value={credentialReferenceId} onChange={(event) => onCredentialReferenceIdChange(event.target.value)} className="mt-1 input-field w-full text-sm font-normal" placeholder="Choose a server-held credential" />
            </label>
            <label className="text-xs font-semibold text-content-primary">
              Warehouse structure name
              <input disabled={!newConnectionEnabled} value={schemaModelName} onChange={(event) => onSchemaModelNameChange(event.target.value)} className="mt-1 input-field w-full text-sm font-normal" placeholder="Production warehouse" />
            </label>
            <label className="text-xs font-semibold text-content-primary md:col-span-2">
              New shared model name
              <input disabled={!newConnectionEnabled} value={sharedModelName} onChange={(event) => onSharedModelNameChange(event.target.value)} className="mt-1 input-field w-full text-sm font-normal" placeholder="Enterprise analytics" />
            </label>
          </div>
          <div className="space-y-2">
            {approvalRow(approvals.approvedEnvironment, (checked) => onApprovalChange('approvedEnvironment', checked), 'I confirm this is the approved target environment.')}
            {approvalRow(approvals.leastPrivilegeCredential, (checked) => onApprovalChange('leastPrivilegeCredential', checked), 'I confirm the credential is least-privilege and this is the approved environment.')}
            {approvalRow(approvals.createConnectionAndModel, (checked) => onApprovalChange('createConnectionAndModel', checked), 'I approve creating the connection and shared model shown in this plan.')}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-2 text-xs leading-relaxed text-content-secondary">
          <ShieldCheck size={15} className="mt-0.5 shrink-0 text-green-700" />
          <span>Semantic changes will be staged on a development branch and require review before dashboard construction.</span>
        </div>
        {mode === 'existing_model' ? (
          <span className={`shrink-0 rounded-chip px-2.5 py-1 text-xs font-semibold ${ready ? 'bg-green-100 text-green-800' : 'bg-surface-tertiary text-content-secondary'}`}>{ready ? 'Destination approved' : 'Approval required'}</span>
        ) : (
          <button type="button" className="btn-primary shrink-0 text-sm" onClick={onProvision} disabled={!ready || provisioning}>
            {provisioning ? <Loader2 size={15} className="animate-spin" /> : <ServerCog size={15} />}
            {provisioning
              ? reconciliationRequired ? 'Checking prior setup' : mode === 'existing_connection' ? 'Preparing shared model' : 'Preparing foundation'
              : reconciliationRequired
                ? 'Check reconciliation status'
                : provisionError
                  ? 'Retry approved setup'
                  : mode === 'existing_connection'
                    ? 'Approve and prepare model'
                    : 'Approve and create foundation'}
          </button>
        )}
      </div>

      {provisioning && <div className="rounded-button border border-blue-200 bg-blue-50 px-3 py-2 text-xs leading-relaxed text-blue-900">
        {mode === 'existing_connection'
          ? 'OmniKit is verifying the connection and schema model, refreshing schema when needed, and preparing the new shared model. Keep this page open until the result appears.'
          : 'OmniKit is verifying each approved foundation resource before it continues. Keep this page open until the result appears.'}
      </div>}
      {provisionError && <div className="alert-error text-xs">{provisionError}</div>}
      {provisionResult?.state.phase === 'ready' && (
        <div className="rounded-button border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-800">
          <div className="flex items-center gap-2 font-semibold"><CheckCircle2 size={14} /> Destination foundation is ready.</div>
          <div className="mt-1">Connection {provisionResult.created.connection ? 'created' : 'reused'} · warehouse structure {provisionResult.created.schemaModel ? 'created and refreshed' : 'reused'} · shared model {provisionResult.created.sharedModel ? 'created' : 'reused'}.</div>
          <details className="mt-2"><summary className="cursor-pointer font-semibold">Technical details</summary><div className="mt-1 space-y-1 break-all font-mono text-[11px]"><div>Connection: {provisionResult.state.connectionId || 'not reported'}</div><div>Schema model: {provisionResult.state.schemaModelId || 'not reported'}</div><div>Shared model: {provisionResult.state.sharedModelId || 'not reported'}</div>{provisionResult.run && <><div>Setup run: {provisionResult.run.id}</div><div>Run phase: {provisionResult.run.phase} · version {provisionResult.run.version}</div></>}</div></details>
        </div>
      )}
    </div>
  );
}

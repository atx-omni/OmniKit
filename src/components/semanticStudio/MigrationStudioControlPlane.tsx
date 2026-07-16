import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bot,
  CheckCircle2,
  Database,
  FileArchive,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  ServerCog,
  Trash2,
} from 'lucide-react';
import type {
  MigrationBiSourceTool,
  MigrationPlatformConnection,
  MigrationPlatformKind,
  MigrationProject,
  MigrationProviderKind,
  MigrationProviderProfile,
} from '@/services/semanticMigration/types';
import {
  deleteMigrationPlatformConnection,
  deleteMigrationProvider,
  listMigrationPlatformConnections,
  listMigrationProjects,
  listMigrationProviders,
  loadMigrationSourceInventory,
  saveMigrationPlatformConnection,
  saveMigrationProject,
  saveMigrationProvider,
  testMigrationPlatformConnection,
  testMigrationProvider,
  type SourceInventory,
} from '@/services/semanticMigration/studioApi';
import {
  SEMANTIC_MIGRATION_CANONICAL_SCHEMA_VERSION,
  SEMANTIC_MIGRATION_PROMPT_VERSION,
} from '@/services/semanticMigration/protocol';

const PROVIDER_OPTIONS: Array<{ id: MigrationProviderKind; label: string; description: string }> = [
  { id: 'omni_ai', label: 'Omni AI', description: 'Use the AI service connected to a saved Omni instance.' },
  { id: 'openai', label: 'OpenAI', description: 'Use an OpenAI model with Structured Outputs.' },
  { id: 'anthropic', label: 'Anthropic', description: 'Use Claude tool output for typed migration decisions.' },
  { id: 'snowflake_cortex', label: 'Snowflake Cortex', description: 'Use Cortex inference and your Snowflake credits.' },
  { id: 'databricks_genie', label: 'Databricks Genie', description: 'Use a curated Genie Space for SQL and result validation. BI artifact generation is not supported.' },
];

const API_SOURCE_OPTIONS: Array<{ id: MigrationBiSourceTool; label: string; description: string }> = [
  { id: 'domo', label: 'Domo', description: 'Inventory datasets, cards, pages, Beast Modes, and pipeline dependencies.' },
  { id: 'looker', label: 'Looker', description: 'Inventory LookML projects, models, Explores, dashboards, Looks, and validation evidence.' },
  { id: 'metabase', label: 'Metabase', description: 'Inventory databases, tables, metrics, segments, cards, dashboards, and collections.' },
  { id: 'microstrategy', label: 'MicroStrategy', description: 'Inventory projects, reports, cubes, dashboards/documents, metrics, and attributes.' },
  { id: 'power_bi', label: 'Power BI', description: 'Inventory workspaces, semantic models, reports, dashboards, and refresh dependencies.' },
  { id: 'sigma', label: 'Sigma', description: 'Inventory workbooks through the Sigma REST API.' },
  { id: 'tableau', label: 'Tableau', description: 'Inventory sites, projects, workbooks, views, data sources, and lineage.' },
  { id: 'webfocus', label: 'WebFOCUS', description: 'Read governed repository exports through Repository REST.' },
];

interface MigrationStudioControlPlaneProps {
  targetInstanceId?: string;
  targetInstanceLabel?: string;
  selectedProviderId: string;
  sourceMode: 'api' | 'manual';
  manualSourcePlatform: MigrationBiSourceTool;
  selectedSourceConnectionId: string;
  onProviderChange: (providerId: string) => void;
  onSourceModeChange: (mode: 'api' | 'manual') => void;
  onSourceConnectionChange: (connectionId: string) => void;
  onInventoryLoaded?: (inventory: SourceInventory | null) => void;
}

function providerDefaultModel(kind: MigrationProviderKind): string {
  if (kind === 'openai') return 'gpt-5.1';
  if (kind === 'anthropic') return 'claude-sonnet-4-5';
  if (kind === 'snowflake_cortex') return 'claude-sonnet-4-5';
  if (kind === 'databricks_genie') return 'genie-space-id';
  if (kind === 'omni_ai') return 'target-model';
  return 'configured-model';
}

function defaultBaseUrl(kind: MigrationProviderKind): string {
  if (kind === 'openai') return 'https://api.openai.com/v1';
  if (kind === 'anthropic') return 'https://api.anthropic.com/v1';
  return '';
}

function platformLabel(kind: MigrationPlatformKind): string {
  return API_SOURCE_OPTIONS.find((option) => option.id === kind)?.label || kind;
}

export function MigrationStudioControlPlane({
  targetInstanceId,
  targetInstanceLabel,
  selectedProviderId,
  sourceMode,
  manualSourcePlatform,
  selectedSourceConnectionId,
  onProviderChange,
  onSourceModeChange,
  onSourceConnectionChange,
  onInventoryLoaded,
}: MigrationStudioControlPlaneProps) {
  const [providers, setProviders] = useState<MigrationProviderProfile[]>([]);
  const [connections, setConnections] = useState<MigrationPlatformConnection[]>([]);
  const [projects, setProjects] = useState<MigrationProject[]>([]);
  const [inventory, setInventory] = useState<SourceInventory | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showProviderForm, setShowProviderForm] = useState(false);
  const [showConnectionForm, setShowConnectionForm] = useState(false);
  const [projectName, setProjectName] = useState('');
  const [providerKind, setProviderKind] = useState<MigrationProviderKind>('openai');
  const [providerName, setProviderName] = useState('');
  const [providerModel, setProviderModel] = useState(providerDefaultModel('openai'));
  const [providerBaseUrl, setProviderBaseUrl] = useState(defaultBaseUrl('openai'));
  const [providerCredential, setProviderCredential] = useState('');
  const [sourcePlatform, setSourcePlatform] = useState<MigrationBiSourceTool>('power_bi');
  const [connectionName, setConnectionName] = useState('');
  const [connectionBaseUrl, setConnectionBaseUrl] = useState('');
  const [connectionCredential, setConnectionCredential] = useState('');
  const [repositoryPath, setRepositoryPath] = useState('/WFC/Repository');
  const [sourceProjectId, setSourceProjectId] = useState('');
  const [sourceSiteId, setSourceSiteId] = useState('');
  const [sourceWorkspaceId, setSourceWorkspaceId] = useState('');

  const loadLibrary = useCallback(async () => {
    setBusy('library');
    setError('');
    try {
      const [nextProviders, nextConnections, nextProjects] = await Promise.all([
        listMigrationProviders(),
        listMigrationPlatformConnections(),
        listMigrationProjects(),
      ]);
      setProviders(nextProviders);
      setConnections(nextConnections);
      setProjects(nextProjects);
      if (!selectedProviderId && nextProviders[0]) onProviderChange(nextProviders[0].id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load the migration library.');
    } finally {
      setBusy('');
    }
  }, [onProviderChange, selectedProviderId]);

  useEffect(() => {
    void loadLibrary();
  }, [loadLibrary]);

  const selectedProvider = useMemo(() => providers.find((provider) => provider.id === selectedProviderId), [providers, selectedProviderId]);
  const selectedConnection = useMemo(() => connections.find((connection) => connection.id === selectedSourceConnectionId), [connections, selectedSourceConnectionId]);

  async function handleSaveProvider() {
    setBusy('save-provider');
    setError('');
    setNotice('');
    try {
      const saved = await saveMigrationProvider({
        name: providerName.trim() || PROVIDER_OPTIONS.find((option) => option.id === providerKind)?.label || 'AI provider',
        kind: providerKind,
        model: providerModel,
        baseUrl: providerBaseUrl || undefined,
        linkedInstanceId: providerKind === 'omni_ai' ? targetInstanceId : undefined,
        credential: providerKind === 'omni_ai' ? undefined : providerCredential,
      });
      setProviders((current) => [...current.filter((provider) => provider.id !== saved.id), saved].sort((a, b) => a.name.localeCompare(b.name)));
      onProviderChange(saved.id);
      setProviderCredential('');
      setShowProviderForm(false);
      setNotice(`${saved.name} is encrypted in the local vault.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save the AI provider.');
    } finally {
      setBusy('');
    }
  }

  async function handleSaveConnection() {
    setBusy('save-connection');
    setError('');
    setNotice('');
    try {
      const saved = await saveMigrationPlatformConnection({
        name: connectionName.trim() || `${platformLabel(sourcePlatform)} source`,
        platform: sourcePlatform,
        baseUrl: connectionBaseUrl,
        credential: connectionCredential,
        repositoryPath: sourcePlatform === 'webfocus' ? repositoryPath : undefined,
        workspaceId: sourcePlatform === 'power_bi' ? sourceWorkspaceId : undefined,
        projectId: sourcePlatform === 'microstrategy' ? sourceProjectId : undefined,
        siteId: sourcePlatform === 'tableau' ? sourceSiteId : undefined,
      });
      setConnections((current) => [...current.filter((connection) => connection.id !== saved.id), saved].sort((a, b) => a.name.localeCompare(b.name)));
      onSourceModeChange('api');
      onSourceConnectionChange(saved.id);
      setConnectionCredential('');
      setShowConnectionForm(false);
      setNotice(`${saved.name} is encrypted in the local vault.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save the source connection.');
    } finally {
      setBusy('');
    }
  }

  async function handleTestProvider(id: string) {
    setBusy(`test-provider-${id}`);
    setError('');
    try {
      const result = await testMigrationProvider(id);
      setNotice(`Provider connected successfully using ${result.model}.`);
      await loadLibrary();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Provider test failed.');
    } finally {
      setBusy('');
    }
  }

  async function handleLoadInventory(id: string) {
    setBusy(`inventory-${id}`);
    setError('');
    setInventory(null);
    try {
      await testMigrationPlatformConnection(id);
      const result = await loadMigrationSourceInventory(id);
      setInventory(result);
      onInventoryLoaded?.(result);
      setNotice(`Loaded ${result.items.length} ${platformLabel(result.platform)} source items from ${result.collection?.scopeLabel || 'the configured scope'}${result.truncated ? '. The safety bound was reached; narrow the saved scope before planning' : ''}.`);
      await loadLibrary();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Source inventory could not be loaded.');
    } finally {
      setBusy('');
    }
  }

  function changeSourceMode(next: 'api' | 'manual') {
    if (next === sourceMode) return;
    setInventory(null);
    setNotice('');
    setError('');
    onInventoryLoaded?.(null);
    onSourceModeChange(next);
    if (next === 'manual') {
      onSourceConnectionChange('');
      setShowConnectionForm(false);
    }
  }

  function changeSourceConnection(id: string) {
    setInventory(null);
    onInventoryLoaded?.(null);
    onSourceConnectionChange(id);
  }

  async function handleSaveProject() {
    if (!selectedProviderId || !targetInstanceId) {
      setError('Choose an AI provider and active target Omni instance before saving the project.');
      return;
    }
    setBusy('save-project');
    setError('');
    try {
      const saved = await saveMigrationProject({
        name: projectName.trim() || `Migration to ${targetInstanceLabel || 'Omni'}`,
        sourcePlatform: sourceMode === 'manual' ? manualSourcePlatform : selectedConnection?.platform || manualSourcePlatform,
        sourceConnectionId: sourceMode === 'api' ? selectedConnection?.id : undefined,
        providerId: selectedProviderId,
        targetPlatform: 'omni',
        targetInstanceId,
        stage: 'connect',
        promptSchemaVersion: SEMANTIC_MIGRATION_PROMPT_VERSION,
        canonicalSchemaVersion: SEMANTIC_MIGRATION_CANONICAL_SCHEMA_VERSION,
      });
      setProjects((current) => [saved, ...current.filter((project) => project.id !== saved.id)]);
      setProjectName(saved.name);
      setNotice(`${saved.name} is saved in the encrypted vault. Source files and AI responses were not stored.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save the migration project.');
    } finally {
      setBusy('');
    }
  }

  return (
    <section className="rounded-card border border-border bg-white p-5 space-y-5" aria-labelledby="migration-control-plane-title">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-omni-700">Migration control plane</div>
          <h2 id="migration-control-plane-title" className="mt-1 text-lg font-bold text-content-primary">Connect the source, AI provider, and Omni target</h2>
          <p className="mt-1 max-w-3xl text-sm text-content-secondary">
            The AI provider proposes typed migration decisions. OmniKit compiles and validates approved changes; it never gives the model direct write access.
          </p>
        </div>
        <button type="button" className="btn-secondary" onClick={() => void loadLibrary()} disabled={Boolean(busy)} title="Refresh saved migration resources">
          <RefreshCw size={15} className={busy === 'library' ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      <div className="grid gap-3 lg:grid-cols-[1fr_auto_1fr_auto_1fr] lg:items-stretch">
        <div className="rounded-card border border-border bg-surface-secondary p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-content-primary"><Database size={16} /> 1. Source</div>
          <p className="mt-1 text-xs text-content-secondary">Choose how OmniKit should receive the source evidence.</p>
          <div className="mt-3 grid grid-cols-2 rounded-button border border-border bg-white p-1" role="group" aria-label="Source acquisition method">
            <button type="button" aria-pressed={sourceMode === 'api'} onClick={() => changeSourceMode('api')} className={`rounded-button px-2 py-2 text-xs font-semibold ${sourceMode === 'api' ? 'bg-omni-600 text-white' : 'text-content-secondary hover:bg-surface-secondary'}`}>Saved API</button>
            <button type="button" aria-pressed={sourceMode === 'manual'} onClick={() => changeSourceMode('manual')} className={`rounded-button px-2 py-2 text-xs font-semibold ${sourceMode === 'manual' ? 'bg-omni-600 text-white' : 'text-content-secondary hover:bg-surface-secondary'}`}>Manual files</button>
          </div>
          {sourceMode === 'api' ? (
            <>
              <select className="input mt-3 w-full" aria-label="Saved source API connection" value={selectedSourceConnectionId} onChange={(event) => changeSourceConnection(event.target.value)}>
                <option value="">Choose a saved API source</option>
                {connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.name} · {platformLabel(connection.platform)}</option>)}
              </select>
              <button type="button" className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-omni-700" onClick={() => setShowConnectionForm((current) => !current)}>
                <Plus size={13} /> Add API source
              </button>
            </>
          ) : (
            <div className="mt-3 rounded-button border border-omni-200 bg-omni-50 px-3 py-2 text-xs text-omni-800">
              Choose the source format below, then upload one or more export files. Saved API access is not required.
            </div>
          )}
        </div>
        <div className="hidden items-center text-content-tertiary lg:flex">→</div>
        <div className="rounded-card border border-omni-200 bg-omni-50 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-content-primary"><Bot size={16} /> 2. AI provider</div>
          <p className="mt-1 text-xs text-content-secondary">Your key stays encrypted in the local vault.</p>
          <select className="input mt-3 w-full" value={selectedProviderId} onChange={(event) => onProviderChange(event.target.value)}>
            <option value="">Choose a provider</option>
            {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} · {provider.model}</option>)}
          </select>
          <button type="button" className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-omni-700" onClick={() => setShowProviderForm((current) => !current)}>
            <Plus size={13} /> Add AI provider
          </button>
        </div>
        <div className="hidden items-center text-content-tertiary lg:flex">→</div>
        <div className="rounded-card border border-border bg-surface-secondary p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-content-primary"><ServerCog size={16} /> 3. Target</div>
          <p className="mt-1 text-xs text-content-secondary">Reviewed changes deploy only to a dev branch.</p>
          <div className="mt-3 rounded-button border border-border bg-white px-3 py-2 text-sm font-semibold text-content-primary">
            {targetInstanceLabel || 'Choose an Omni instance on Home'}
          </div>
          <div className="mt-2 inline-flex items-center gap-1 text-xs text-green-700"><CheckCircle2 size={13} /> Omni compiler and validation</div>
        </div>
      </div>

      {showProviderForm && (
        <div className="border-t border-border pt-4">
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            <label className="text-xs font-semibold text-content-secondary">Provider
              <select className="input mt-1 w-full" value={providerKind} onChange={(event) => {
                const next = event.target.value as MigrationProviderKind;
                setProviderKind(next);
                setProviderModel(providerDefaultModel(next));
                setProviderBaseUrl(defaultBaseUrl(next));
              }}>
                {PROVIDER_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
            </label>
            <label className="text-xs font-semibold text-content-secondary">Profile name
              <input className="input mt-1 w-full" value={providerName} onChange={(event) => setProviderName(event.target.value)} placeholder="Production migration AI" />
            </label>
            <label className="text-xs font-semibold text-content-secondary">Model or endpoint name
              <input className="input mt-1 w-full" value={providerModel} onChange={(event) => setProviderModel(event.target.value)} />
            </label>
            {providerKind !== 'omni_ai' && (
              <>
                <label className="text-xs font-semibold text-content-secondary md:col-span-2">HTTPS base URL
                  <input className="input mt-1 w-full" value={providerBaseUrl} onChange={(event) => setProviderBaseUrl(event.target.value)} placeholder="https://..." />
                </label>
                <label className="text-xs font-semibold text-content-secondary">API key or token
                  <input className="input mt-1 w-full" type="password" autoComplete="new-password" value={providerCredential} onChange={(event) => setProviderCredential(event.target.value)} />
                </label>
              </>
            )}
          </div>
          <div className="mt-3 flex items-center justify-between gap-3">
            <p className="text-xs text-content-secondary">{PROVIDER_OPTIONS.find((option) => option.id === providerKind)?.description}</p>
            <button type="button" className="btn-primary" onClick={() => void handleSaveProvider()} disabled={busy === 'save-provider'}>
              {busy === 'save-provider' ? <Loader2 size={15} className="animate-spin" /> : <KeyRound size={15} />} Save provider
            </button>
          </div>
        </div>
      )}

      {sourceMode === 'api' && showConnectionForm && (
        <div className="border-t border-border pt-4">
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
            <label className="text-xs font-semibold text-content-secondary">Source platform
              <select className="input mt-1 w-full" value={sourcePlatform} onChange={(event) => setSourcePlatform(event.target.value as MigrationBiSourceTool)}>
                {API_SOURCE_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
            </label>
            <label className="text-xs font-semibold text-content-secondary">Connection name
              <input className="input mt-1 w-full" value={connectionName} onChange={(event) => setConnectionName(event.target.value)} />
            </label>
            <label className="text-xs font-semibold text-content-secondary">HTTPS API base URL
              <input className="input mt-1 w-full" value={connectionBaseUrl} onChange={(event) => setConnectionBaseUrl(event.target.value)} placeholder="https://..." />
            </label>
            <label className="text-xs font-semibold text-content-secondary">API key or token
              <input className="input mt-1 w-full" type="password" autoComplete="new-password" value={connectionCredential} onChange={(event) => setConnectionCredential(event.target.value)} />
            </label>
            {sourcePlatform === 'webfocus' && (
              <label className="text-xs font-semibold text-content-secondary md:col-span-2">Repository path
                <input className="input mt-1 w-full" value={repositoryPath} onChange={(event) => setRepositoryPath(event.target.value)} />
              </label>
            )}
            {sourcePlatform === 'tableau' && (
              <label className="text-xs font-semibold text-content-secondary">Tableau site ID
                <input className="input mt-1 w-full" value={sourceSiteId} onChange={(event) => setSourceSiteId(event.target.value)} />
              </label>
            )}
            {sourcePlatform === 'power_bi' && (
              <label className="text-xs font-semibold text-content-secondary">Power BI workspace ID <span className="font-normal text-content-tertiary">(optional)</span>
                <input className="input mt-1 w-full" value={sourceWorkspaceId} onChange={(event) => setSourceWorkspaceId(event.target.value)} placeholder="Leave blank for all accessible workspaces" />
              </label>
            )}
            {sourcePlatform === 'microstrategy' && (
              <label className="text-xs font-semibold text-content-secondary">MicroStrategy project ID
                <input className="input mt-1 w-full" value={sourceProjectId} onChange={(event) => setSourceProjectId(event.target.value)} />
              </label>
            )}
          </div>
          <div className="mt-3 flex items-center justify-between gap-3">
            <p className="text-xs text-content-secondary">{API_SOURCE_OPTIONS.find((option) => option.id === sourcePlatform)?.description}</p>
            <button type="button" className="btn-primary" onClick={() => void handleSaveConnection()} disabled={busy === 'save-connection'}>
              {busy === 'save-connection' ? <Loader2 size={15} className="animate-spin" /> : <Database size={15} />} Save source
            </button>
          </div>
        </div>
      )}

      {(selectedProvider || (sourceMode === 'api' && selectedConnection)) && (
        <div className="grid gap-3 border-t border-border pt-4 lg:grid-cols-2">
          {selectedProvider && (
            <div className="rounded-card border border-border p-3">
              <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-content-primary">{selectedProvider.name}</div>
                <div className="truncate text-xs text-content-secondary">{selectedProvider.kind} · {selectedProvider.model} · {selectedProvider.credentialMasked || 'saved Omni credential'}</div>
              </div>
              <div className="flex shrink-0 gap-2">
                <button type="button" className="btn-secondary" onClick={() => void handleTestProvider(selectedProvider.id)} disabled={busy === `test-provider-${selectedProvider.id}`}>Test</button>
                <button type="button" className="icon-btn" title="Delete provider" onClick={async () => {
                  if (!window.confirm(`Delete ${selectedProvider.name}?`)) return;
                  try { await deleteMigrationProvider(selectedProvider.id); onProviderChange(''); await loadLibrary(); } catch (caught) { setError(caught instanceof Error ? caught.message : 'Delete failed.'); }
                }}><Trash2 size={14} /></button>
              </div>
              </div>
              <div className="mt-2 text-[11px] text-content-secondary">
                Tasks: {selectedProvider.capabilities.supportedTasks.map((task) => task.split('_').join(' ')).join(' · ')}
              </div>
              {selectedProvider.capabilities.limitations.map((limitation) => (
                <div key={limitation} className="mt-2 rounded-button border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] text-amber-900">{limitation}</div>
              ))}
            </div>
          )}
          {sourceMode === 'api' && selectedConnection && (
            <div className="flex items-center justify-between gap-3 rounded-card border border-border p-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-content-primary">{selectedConnection.name}</div>
                <div className="truncate text-xs text-content-secondary">{platformLabel(selectedConnection.platform)} · {selectedConnection.credentialMasked}</div>
              </div>
              <div className="flex shrink-0 gap-2">
                <button type="button" className="btn-secondary" onClick={() => void handleLoadInventory(selectedConnection.id)} disabled={busy === `inventory-${selectedConnection.id}`}>Load inventory</button>
                <button type="button" className="icon-btn" title="Delete source connection" onClick={async () => {
                  if (!window.confirm(`Delete ${selectedConnection.name}?`)) return;
                  try { await deleteMigrationPlatformConnection(selectedConnection.id); changeSourceConnection(''); await loadLibrary(); } catch (caught) { setError(caught instanceof Error ? caught.message : 'Delete failed.'); }
                }}><Trash2 size={14} /></button>
              </div>
            </div>
          )}
        </div>
      )}

      {inventory && (
        <div className="rounded-card border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
          <div className="flex items-center gap-2 font-semibold"><FileArchive size={15} /> {inventory.items.length} source items ready to scope</div>
          <div className="mt-1 text-xs">{inventory.items.slice(0, 5).map((item) => item.name).join(' · ')}{inventory.items.length > 5 ? ` · +${inventory.items.length - 5} more` : ''}</div>
          <div className="mt-2 text-xs">Semantic definitions: {inventory.connector.capabilities.semanticDefinitions.replace('_', ' ')} · Content definitions: {inventory.connector.capabilities.contentDefinitions.replace('_', ' ')} · Query validation: {inventory.connector.capabilities.queryValidation ? 'available' : 'not exposed by this connector'}</div>
        </div>
      )}

      <div className="flex flex-col gap-3 border-t border-border pt-4 md:flex-row md:items-end">
        <label className="flex-1 text-xs font-semibold text-content-secondary">Save this setup as a migration project
          <input className="input mt-1 w-full" value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="Finance semantic migration" />
        </label>
        <button type="button" className="btn-secondary" onClick={() => void handleSaveProject()} disabled={busy === 'save-project' || !selectedProviderId}>
          {busy === 'save-project' ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} Save project
        </button>
        {projects.length > 0 && <div className="pb-2 text-xs text-content-tertiary">{projects.length} saved project{projects.length === 1 ? '' : 's'}</div>}
      </div>

      {error && <div className="rounded-button border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</div>}
      {notice && <div className="rounded-button border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">{notice}</div>}
    </section>
  );
}

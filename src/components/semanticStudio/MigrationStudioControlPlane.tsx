import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  CheckCircle2,
  Database,
  ExternalLink,
  FileArchive,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  ServerCog,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { ComboBox } from '@/components/ui/ComboBox';
import type {
  MigrationBiSourceTool,
  MigrationPlatformConnection,
  MigrationPlatformKind,
  MigrationProject,
  MigrationProviderAuthMode,
  MigrationProviderKind,
  MigrationProviderProfile,
} from '@/services/semanticMigration/types';
import {
  MIGRATION_PROVIDER_GUIDANCE,
  PUBLIC_MIGRATION_PROVIDER_OPTIONS,
  migrationProviderAuthSetup,
  migrationProviderCredentialState,
  migrationProviderGuidance,
} from '@/services/semanticMigration/providerGuidance';
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

const PROVIDER_OPTIONS = PUBLIC_MIGRATION_PROVIDER_OPTIONS;
const OPTIONAL_PROVIDER_OPTIONS = PUBLIC_MIGRATION_PROVIDER_OPTIONS.filter((provider) => provider.id !== 'omni_ai');

function includedOmniProviderId(instanceId: string): string {
  return `omni-ai-default-${instanceId}`;
}

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
  return migrationProviderGuidance(kind).defaultModel;
}

function defaultBaseUrl(kind: MigrationProviderKind): string {
  return migrationProviderGuidance(kind).defaultBaseUrl;
}

function isPublicProviderKind(value: string): value is MigrationProviderKind {
  return Object.prototype.hasOwnProperty.call(MIGRATION_PROVIDER_GUIDANCE, value);
}

function dateInputValue(value?: string): string {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString().slice(0, 10) : '';
}

function providerAuthLabel(provider: MigrationProviderProfile): string {
  const kind = provider.kind;
  if (!isPublicProviderKind(kind)) return provider.authMode || 'legacy';
  const guidance = migrationProviderGuidance(kind);
  return guidance.authOptions.find((option) => option.id === (provider.authMode || guidance.defaultAuthMode))?.label || provider.authMode || 'configured';
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
  const [showProviderChoices, setShowProviderChoices] = useState(false);
  const [showConnectionForm, setShowConnectionForm] = useState(false);
  const [editingProviderId, setEditingProviderId] = useState('');
  const [projectName, setProjectName] = useState('');
  const [providerKind, setProviderKind] = useState<MigrationProviderKind>('openai');
  const [providerName, setProviderName] = useState('');
  const [providerModel, setProviderModel] = useState(providerDefaultModel('openai'));
  const [providerBaseUrl, setProviderBaseUrl] = useState(defaultBaseUrl('openai'));
  const [providerCredential, setProviderCredential] = useState('');
  const [providerAuthMode, setProviderAuthMode] = useState<MigrationProviderAuthMode>(migrationProviderGuidance('openai').defaultAuthMode);
  const [providerCredentialOwner, setProviderCredentialOwner] = useState('');
  const [providerCredentialExpiresAt, setProviderCredentialExpiresAt] = useState('');
  const [providerRotationDueAt, setProviderRotationDueAt] = useState('');
  const [sourcePlatform, setSourcePlatform] = useState<MigrationBiSourceTool>('domo');
  const [connectionName, setConnectionName] = useState('');
  const [connectionBaseUrl, setConnectionBaseUrl] = useState('');
  const [connectionCredential, setConnectionCredential] = useState('');
  const [domoAuthMode, setDomoAuthMode] = useState<'oauth_client_credentials' | 'oauth_access_token'>('oauth_client_credentials');
  const [domoProductApiToken, setDomoProductApiToken] = useState('');
  const [repositoryPath, setRepositoryPath] = useState('/WFC/Repository');
  const [sourceProjectId, setSourceProjectId] = useState('');
  const [sourceClientId, setSourceClientId] = useState('');
  const [sourceSiteId, setSourceSiteId] = useState('');
  const [sourceWorkspaceId, setSourceWorkspaceId] = useState('');
  const selectedProviderIdRef = useRef(selectedProviderId);
  const providerDrawerRef = useRef<HTMLElement>(null);
  const providerDrawerCloseRef = useRef<HTMLButtonElement>(null);
  const providerDrawerReturnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    selectedProviderIdRef.current = selectedProviderId;
  }, [selectedProviderId]);

  const closeProviderForm = useCallback(() => {
    setShowProviderForm(false);
    setEditingProviderId('');
    setProviderCredential('');
    window.setTimeout(() => providerDrawerReturnFocusRef.current?.focus(), 0);
  }, []);

  useEffect(() => {
    if (!showProviderForm) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    providerDrawerCloseRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeProviderForm();
      if (event.key === 'Tab' && providerDrawerRef.current) {
        const focusable = Array.from(providerDrawerRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), summary, textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'));
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!first || !last) return;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [closeProviderForm, showProviderForm]);

  const loadLibrary = useCallback(async () => {
    setBusy('library');
    setError('');
    try {
      const [loadedProviders, nextConnections, nextProjects] = await Promise.all([
        listMigrationProviders(),
        listMigrationPlatformConnections(),
        listMigrationProjects(),
      ]);
      let nextProviders = loadedProviders;
      if (targetInstanceId) {
        const defaultId = includedOmniProviderId(targetInstanceId);
        let includedProvider = nextProviders.find((provider) => provider.id === defaultId);
        if (!includedProvider) {
          const savedIncludedProvider = await saveMigrationProvider({
            id: defaultId,
            name: `Omni AI · ${targetInstanceLabel || 'Active instance'}`,
            kind: 'omni_ai',
            model: 'selected-target-model',
            linkedInstanceId: targetInstanceId,
            authMode: 'linked_omni_instance',
          });
          includedProvider = savedIncludedProvider;
          nextProviders = [...nextProviders.filter((provider) => provider.id !== savedIncludedProvider.id), savedIncludedProvider]
            .sort((a, b) => a.name.localeCompare(b.name));
        }
        const currentProvider = nextProviders.find((provider) => provider.id === selectedProviderIdRef.current);
        if (!currentProvider || currentProvider.kind === 'omni_ai') {
          selectedProviderIdRef.current = includedProvider.id;
          onProviderChange(includedProvider.id);
        }
      }
      setProviders(nextProviders);
      setConnections(nextConnections);
      setProjects(nextProjects);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load the migration library.');
    } finally {
      setBusy('');
    }
  }, [onProviderChange, targetInstanceId, targetInstanceLabel]);

  useEffect(() => {
    void loadLibrary();
  }, [loadLibrary]);

  const selectedProvider = useMemo(() => providers.find((provider) => provider.id === selectedProviderId), [providers, selectedProviderId]);
  const includedOmniProvider = useMemo(
    () => targetInstanceId ? providers.find((provider) => provider.id === includedOmniProviderId(targetInstanceId)) : undefined,
    [providers, targetInstanceId],
  );
  const optionalProviders = useMemo(() => providers.filter((provider) => provider.kind !== 'omni_ai'), [providers]);
  const usingIncludedOmni = !selectedProvider || selectedProvider.kind === 'omni_ai';
  const selectedConnection = useMemo(() => connections.find((connection) => connection.id === selectedSourceConnectionId), [connections, selectedSourceConnectionId]);
  const selectedProviderGuidance = migrationProviderGuidance(providerKind);
  const selectedAuthOption = selectedProviderGuidance.authOptions.find((option) => option.id === providerAuthMode);
  const selectedAuthSetup = migrationProviderAuthSetup(providerKind, providerAuthMode);

  async function handleSaveProvider() {
    setBusy('save-provider');
    setError('');
    setNotice('');
    try {
      const saved = await saveMigrationProvider({
        id: editingProviderId || undefined,
        name: providerName.trim() || PROVIDER_OPTIONS.find((option) => option.id === providerKind)?.label || 'AI provider',
        kind: providerKind,
        model: providerModel,
        baseUrl: providerBaseUrl || undefined,
        linkedInstanceId: providerKind === 'omni_ai' ? targetInstanceId : undefined,
        authMode: providerAuthMode,
        credentialOwner: providerCredentialOwner || undefined,
        credentialExpiresAt: providerCredentialExpiresAt || undefined,
        rotationDueAt: providerRotationDueAt || undefined,
        credential: providerKind === 'omni_ai' ? undefined : providerCredential,
      });
      setProviders((current) => [...current.filter((provider) => provider.id !== saved.id), saved].sort((a, b) => a.name.localeCompare(b.name)));
      onProviderChange(saved.id);
      selectedProviderIdRef.current = saved.id;
      setProviderCredential('');
      setEditingProviderId('');
      setShowProviderForm(false);
      setShowProviderChoices(false);
      window.setTimeout(() => providerDrawerReturnFocusRef.current?.focus(), 0);
      setNotice(`${saved.name} is encrypted in the local vault. Run Test before using it for a migration.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save the AI provider.');
    } finally {
      setBusy('');
    }
  }

  function startAddProvider() {
    providerDrawerReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const nextKind: MigrationProviderKind = 'openai';
    const guidance = migrationProviderGuidance(nextKind);
    setEditingProviderId('');
    setProviderKind(nextKind);
    setProviderName('');
    setProviderModel(guidance.defaultModel);
    setProviderBaseUrl(guidance.defaultBaseUrl);
    setProviderAuthMode(guidance.defaultAuthMode);
    setProviderCredential('');
    setProviderCredentialOwner('');
    setProviderCredentialExpiresAt('');
    setProviderRotationDueAt('');
    setShowProviderChoices(false);
    setShowProviderForm(true);
  }

  function startEditProvider(provider: MigrationProviderProfile) {
    if (!isPublicProviderKind(provider.kind)) {
      setError('Legacy provider profiles can be used or deleted, but cannot be edited into a public provider type. Create a new profile instead.');
      return;
    }
    const guidance = migrationProviderGuidance(provider.kind);
    providerDrawerReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEditingProviderId(provider.id);
    setProviderKind(provider.kind);
    setProviderName(provider.name);
    setProviderModel(provider.model);
    setProviderBaseUrl(provider.baseUrl || guidance.defaultBaseUrl);
    setProviderAuthMode(provider.authMode || guidance.defaultAuthMode);
    setProviderCredential('');
    setProviderCredentialOwner(provider.credentialOwner || '');
    setProviderCredentialExpiresAt(dateInputValue(provider.credentialExpiresAt));
    setProviderRotationDueAt(dateInputValue(provider.rotationDueAt));
    setShowProviderForm(true);
    setError('');
    setNotice('Leave the credential blank to keep the encrypted value already in the vault.');
  }

  async function handleSaveConnection() {
    if (sourcePlatform === 'looker' && !sourceClientId.trim()) {
      setError('Looker Saved API access requires a client ID and client secret. Create an API credential in Looker, then save both values here.');
      return;
    }
    if (sourcePlatform === 'domo' && domoAuthMode === 'oauth_client_credentials' && !sourceClientId.trim()) {
      setError('Domo Basic inventory requires the OAuth client ID created in the Domo Developer Portal.');
      return;
    }
    if (sourcePlatform === 'domo' && !connectionCredential.trim()) {
      setError(domoAuthMode === 'oauth_client_credentials' ? 'Enter the Domo OAuth client secret.' : 'Enter the existing Domo OAuth access token.');
      return;
    }
    if (sourcePlatform === 'domo' && !connectionBaseUrl.trim()) {
      setError('Enter your Domo instance URL so OmniKit can scope optional Product API requests to the correct tenant.');
      return;
    }
    setBusy('save-connection');
    setError('');
    setNotice('');
    try {
      const saved = await saveMigrationPlatformConnection({
        name: connectionName.trim() || `${platformLabel(sourcePlatform)} source`,
        platform: sourcePlatform,
        baseUrl: connectionBaseUrl,
        credential: connectionCredential,
        authMode: sourcePlatform === 'domo' ? domoAuthMode : undefined,
        productApiToken: sourcePlatform === 'domo' ? domoProductApiToken : undefined,
        repositoryPath: sourcePlatform === 'webfocus' ? repositoryPath : undefined,
        workspaceId: sourcePlatform === 'power_bi' ? sourceWorkspaceId : undefined,
        projectId: sourcePlatform === 'microstrategy' || sourcePlatform === 'looker' ? sourceProjectId : undefined,
        clientId: sourcePlatform === 'looker' || sourcePlatform === 'domo' && domoAuthMode === 'oauth_client_credentials' ? sourceClientId : undefined,
        siteId: sourcePlatform === 'tableau' ? sourceSiteId : undefined,
      });
      setConnections((current) => [...current.filter((connection) => connection.id !== saved.id), saved].sort((a, b) => a.name.localeCompare(b.name)));
      onSourceModeChange('api');
      onSourceConnectionChange(saved.id);
      setConnectionCredential('');
      setDomoProductApiToken('');
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
    if (sourceMode === 'api' && !selectedConnection) {
      setError('Choose a saved API source before saving the migration project.');
      return;
    }
    setBusy('save-project');
    setError('');
    try {
      const saved = await saveMigrationProject({
        name: projectName.trim() || `Migration to ${targetInstanceLabel || 'Omni'}`,
        sourcePlatform: sourceMode === 'manual' ? manualSourcePlatform : selectedConnection!.platform,
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
    <section className="space-y-4 border-y border-border bg-white px-5 py-4" aria-labelledby="migration-control-plane-title">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-omni-700">Migration setup</div>
          <h2 id="migration-control-plane-title" className="mt-1 text-lg font-bold text-content-primary">Confirm how this migration will run</h2>
          <p className="mt-1 max-w-3xl text-sm text-content-secondary">
            The AI provider proposes typed migration decisions. OmniKit compiles and validates approved changes; it never gives the model direct write access.
          </p>
        </div>
        <button type="button" className="btn-secondary" onClick={() => void loadLibrary()} disabled={Boolean(busy)} title="Refresh saved migration resources">
          <RefreshCw size={15} className={busy === 'library' ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      <div className="grid overflow-hidden rounded-card border border-border bg-white lg:grid-cols-3 lg:divide-x lg:divide-border">
        <div className="p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-content-primary"><Database size={16} /> Source access</div>
          <p className="mt-1 text-xs text-content-secondary">Choose how OmniKit should receive the source evidence.</p>
          <div className="mt-3 grid grid-cols-2 rounded-button border border-border bg-white p-1" role="group" aria-label="Source acquisition method">
            <button type="button" aria-pressed={sourceMode === 'api'} onClick={() => changeSourceMode('api')} className={`rounded-button px-2 py-2 text-xs font-semibold ${sourceMode === 'api' ? 'bg-omni-700 text-white' : 'text-content-secondary hover:bg-surface-secondary'}`}>Saved API</button>
            <button type="button" aria-pressed={sourceMode === 'manual'} onClick={() => changeSourceMode('manual')} className={`rounded-button px-2 py-2 text-xs font-semibold ${sourceMode === 'manual' ? 'bg-omni-700 text-white' : 'text-content-secondary hover:bg-surface-secondary'}`}>Manual files</button>
          </div>
          {sourceMode === 'api' ? (
            <>
              <div className="mt-3">
                <ComboBox
                  ariaLabel="Saved source API connection"
                  value={selectedSourceConnectionId}
                  onChange={changeSourceConnection}
                  options={connections.map((connection) => ({ value: connection.id, label: connection.name, subtitle: platformLabel(connection.platform) }))}
                  placeholder="Choose a saved API source"
                  emptyLabel="No saved API sources"
                  allowFreeText={false}
                />
              </div>
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
        <div className="border-t border-border bg-omni-50/60 p-4 lg:border-t-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-content-primary"><Bot size={16} /> AI engine</div>
          <p className="mt-1 text-xs text-content-secondary">Omni AI is included through the active instance. Another provider is optional.</p>
          <div className="mt-3 rounded-button border border-omni-200 bg-white px-3 py-2.5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-semibold text-content-primary">{usingIncludedOmni ? 'Omni AI' : selectedProvider?.name}</span>
                  <span className={`shrink-0 rounded-chip px-2 py-0.5 text-[10px] font-semibold ${usingIncludedOmni ? 'bg-green-100 text-green-800' : 'bg-blue-100 text-blue-800'}`}>
                    {usingIncludedOmni ? 'Default' : 'Override'}
                  </span>
                </div>
                <div className="mt-0.5 truncate text-[11px] text-content-secondary">
                  {usingIncludedOmni
                    ? `${targetInstanceLabel || 'Active Omni instance'} · uses the target model selected below`
                    : `${selectedProvider?.kind.split('_').join(' ')} · ${selectedProvider?.model}`}
                </div>
              </div>
              {usingIncludedOmni && <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-green-700" />}
            </div>
          </div>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-2">
            {usingIncludedOmni ? (
              <button type="button" className="inline-flex items-center gap-1 text-xs font-semibold text-omni-700" onClick={() => setShowProviderChoices((current) => !current)}>
                <RefreshCw size={13} /> Use another provider
              </button>
            ) : (
              <>
                <button type="button" className="inline-flex items-center gap-1 text-xs font-semibold text-omni-700" onClick={() => {
                  if (!includedOmniProvider) return;
                  selectedProviderIdRef.current = includedOmniProvider.id;
                  onProviderChange(includedOmniProvider.id);
                  setShowProviderChoices(false);
                }}>
                  <CheckCircle2 size={13} /> Use Omni AI default
                </button>
                <button type="button" className="inline-flex items-center gap-1 text-xs font-semibold text-omni-700" onClick={() => setShowProviderChoices((current) => !current)}>
                  <RefreshCw size={13} /> Change provider
                </button>
              </>
            )}
            <button type="button" className="inline-flex items-center gap-1 text-xs font-semibold text-omni-700" onClick={startAddProvider}>
              <Plus size={13} /> Add external provider
            </button>
          </div>
          {showProviderChoices && (
            <div className="mt-3 border-t border-omni-100 pt-3">
              <ComboBox
                ariaLabel="Optional AI provider"
                value={usingIncludedOmni ? '' : selectedProviderId}
                onChange={(providerId) => {
                  selectedProviderIdRef.current = providerId;
                  onProviderChange(providerId);
                  setShowProviderChoices(false);
                }}
                options={optionalProviders.map((provider) => ({ value: provider.id, label: provider.name, subtitle: provider.model }))}
                placeholder="Choose a saved external provider"
                emptyLabel="No external providers saved yet"
                allowFreeText={false}
              />
            </div>
          )}
        </div>
        <div className="border-t border-border p-4 lg:border-t-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-content-primary"><ServerCog size={16} /> Omni workspace</div>
          <p className="mt-1 text-xs text-content-secondary">Reviewed changes deploy only to a dev branch.</p>
          <div className="mt-3 rounded-button border border-border bg-white px-3 py-2 text-sm font-semibold text-content-primary">
            {targetInstanceLabel || 'Choose an Omni instance on Home'}
          </div>
          <div className="mt-2 inline-flex items-center gap-1 text-xs text-green-700"><CheckCircle2 size={13} /> Omni compiler and validation</div>
        </div>
      </div>

      {showProviderForm && (
        <div
          className="fixed inset-0 z-[80] flex justify-end bg-slate-950/30"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeProviderForm();
          }}
        >
          <section
            ref={providerDrawerRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="provider-drawer-title"
            className="flex h-full w-full max-w-2xl flex-col border-l border-border bg-white shadow-2xl"
          >
            <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-omni-700">Optional AI override</div>
                <h2 id="provider-drawer-title" className="mt-1 text-lg font-bold text-content-primary">{editingProviderId ? 'Edit AI provider' : 'Add AI provider'}</h2>
                <div className="mt-1 text-sm text-content-secondary">Credentials are encrypted in the native vault and used only by the local server.</div>
              </div>
              <button ref={providerDrawerCloseRef} type="button" className="icon-btn" aria-label="Close provider setup" onClick={closeProviderForm}><X size={18} /></button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <fieldset className="sm:col-span-2">
              <legend className="text-xs font-semibold text-content-secondary">Provider</legend>
              <div className="mt-1 grid gap-2 sm:grid-cols-2" data-testid="migration-provider-kind-options">
                {OPTIONAL_PROVIDER_OPTIONS.map((option) => {
                  const selected = providerKind === option.id;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      aria-pressed={selected}
                      disabled={Boolean(editingProviderId)}
                      className={`min-h-16 rounded-button border px-3 py-2 text-left transition-colors ${selected ? 'border-omni-500 bg-omni-50 text-omni-800 ring-1 ring-omni-200' : 'border-border bg-white text-content-primary hover:border-omni-200 hover:bg-surface-secondary'} disabled:cursor-not-allowed disabled:opacity-60`}
                      onClick={() => {
                        const next = option.id;
                        if (next === providerKind) return;
                        const guidance = migrationProviderGuidance(next);
                        setProviderKind(next);
                        setProviderModel(guidance.defaultModel);
                        setProviderBaseUrl(guidance.defaultBaseUrl);
                        setProviderAuthMode(guidance.defaultAuthMode);
                      }}
                    >
                      <span className="flex items-center gap-1.5 text-xs font-semibold">
                        {selected && <CheckCircle2 size={13} className="shrink-0" />}{option.label}
                      </span>
                      <span className="mt-1 block text-[11px] font-normal leading-snug text-content-secondary">{option.authOptions[0]?.label}</span>
                    </button>
                  );
                })}
              </div>
              {editingProviderId && <span className="mt-1 block text-[11px] font-normal text-content-tertiary">Provider type is fixed for saved profiles. Create a new profile to change it.</span>}
            </fieldset>
            <label className="text-xs font-semibold text-content-secondary">Profile name
              <input className="input mt-1 w-full" value={providerName} onChange={(event) => setProviderName(event.target.value)} placeholder="Production migration AI" />
            </label>
            <label className="text-xs font-semibold text-content-secondary">{migrationProviderGuidance(providerKind).modelLabel}
              <input className="input mt-1 w-full" value={providerModel} onChange={(event) => setProviderModel(event.target.value)} />
            </label>
            <label className="text-xs font-semibold text-content-secondary">Credential owner <span className="font-normal text-content-tertiary">(recommended)</span>
              <input className="input mt-1 w-full" value={providerCredentialOwner} onChange={(event) => setProviderCredentialOwner(event.target.value)} placeholder="Team or service owner" />
            </label>
            <fieldset className="sm:col-span-2">
              <legend className="text-xs font-semibold text-content-secondary">Authentication method</legend>
              <div className="mt-1 grid gap-2 sm:grid-cols-2" data-testid="migration-provider-auth-options">
                {selectedProviderGuidance.authOptions.map((option) => {
                  const selected = providerAuthMode === option.id;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      aria-pressed={selected}
                      className={`min-h-16 rounded-button border px-3 py-2 text-left transition-colors ${selected ? 'border-omni-500 bg-omni-50 text-omni-800 ring-1 ring-omni-200' : 'border-border bg-white text-content-primary hover:border-omni-200 hover:bg-surface-secondary'}`}
                      onClick={() => setProviderAuthMode(option.id)}
                    >
                      <span className="flex items-center gap-1.5 text-xs font-semibold">
                        {selected && <CheckCircle2 size={13} className="shrink-0" />}{option.label}
                      </span>
                      <span className="mt-1 block text-[11px] font-normal leading-snug text-content-secondary">{option.description}</span>
                    </button>
                  );
                })}
              </div>
            </fieldset>
            <label className="text-xs font-semibold text-content-secondary">Credential expiration <span className="font-normal text-content-tertiary">(when applicable)</span>
              <input className="input mt-1 w-full" type="date" value={providerCredentialExpiresAt} onChange={(event) => setProviderCredentialExpiresAt(event.target.value)} />
            </label>
            <label className="text-xs font-semibold text-content-secondary">Rotation due <span className="font-normal text-content-tertiary">(recommended)</span>
              <input className="input mt-1 w-full" type="date" value={providerRotationDueAt} onChange={(event) => setProviderRotationDueAt(event.target.value)} />
            </label>
            {providerKind !== 'omni_ai' && (
              <>
                <label className="text-xs font-semibold text-content-secondary sm:col-span-2">{selectedProviderGuidance.baseUrlLabel}
                  <input className="input mt-1 w-full" value={providerBaseUrl} onChange={(event) => setProviderBaseUrl(event.target.value)} placeholder="https://..." />
                </label>
                <label className="text-xs font-semibold text-content-secondary">{selectedAuthSetup.credentialLabel}
                  <input className="input mt-1 w-full" type="password" autoComplete="new-password" value={providerCredential} onChange={(event) => setProviderCredential(event.target.value)} placeholder={editingProviderId ? 'Leave blank to keep saved credential' : selectedAuthSetup.credentialPlaceholder} />
                </label>
              </>
            )}
          </div>
          <div className="mt-5 space-y-3">
            <details className="rounded-card border border-border bg-white" data-testid="provider-credential-help">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-semibold text-content-primary"><KeyRound size={15} className="text-omni-700" /> Set up {selectedAuthOption?.label || 'this credential'}</summary>
              <div className="border-t border-border px-4 py-3">
              <ol className="mt-2 space-y-1.5 text-xs text-blue-950">
                {selectedAuthSetup.setupSteps.map((step, index) => <li key={step}><span className="mr-1 font-bold">{index + 1}.</span>{step}</li>)}
              </ol>
              <div className="mt-3 rounded-button border border-blue-200 bg-white/70 px-3 py-2 text-xs text-blue-950">
                <span className="font-semibold">What OmniKit stores: </span>{selectedAuthSetup.storedValueDescription}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {selectedAuthSetup.documentation.map((document) => (
                  <a key={document.url} className="inline-flex items-center gap-1 text-xs font-semibold text-blue-800 underline" href={document.url} target="_blank" rel="noreferrer">{document.label}<ExternalLink size={11} /></a>
                ))}
              </div>
              </div>
            </details>
            <details className="rounded-card border border-border bg-white" data-testid="provider-security-help">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-semibold text-content-primary"><ShieldCheck size={15} className="text-green-700" /> Security and prerequisites</summary>
              <div className="border-t border-border px-4 py-3">
              <div className="mt-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-green-800">Before you begin</div>
              <ul className="mt-1 space-y-1 text-xs text-green-950">{migrationProviderGuidance(providerKind).prerequisites.map((item) => <li key={item}>• {item}</li>)}</ul>
              <div className="mt-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-green-800">Keep it safe</div>
              <ul className="mt-1 space-y-1 text-xs text-green-950">{migrationProviderGuidance(providerKind).securityNotes.map((item) => <li key={item}>• {item}</li>)}</ul>
              </div>
            </details>
          </div>
            </div>
          <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-4">
            <p className="text-xs text-content-secondary">{PROVIDER_OPTIONS.find((option) => option.id === providerKind)?.description}</p>
            <div className="flex shrink-0 gap-2">
              <button type="button" className="btn-secondary" onClick={closeProviderForm}>Cancel</button>
              <button type="button" className="btn-primary" onClick={() => void handleSaveProvider()} disabled={busy === 'save-provider'}>
                {busy === 'save-provider' ? <Loader2 size={15} className="animate-spin" /> : <KeyRound size={15} />} {editingProviderId ? 'Update and use' : 'Save and use'}
              </button>
            </div>
          </div>
          </section>
        </div>
      )}

      {sourceMode === 'api' && showConnectionForm && (
        <div className="border-t border-border pt-4">
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
            <label className="text-xs font-semibold text-content-secondary">Source platform
              <div className="mt-1">
                <ComboBox
                  ariaLabel="Source platform"
                  value={sourcePlatform}
                  onChange={(value) => {
                    const next = value as MigrationBiSourceTool;
                    setSourcePlatform(next);
                    setConnectionBaseUrl('');
                    setConnectionCredential('');
                    setSourceClientId('');
                    setDomoProductApiToken('');
                    setDomoAuthMode('oauth_client_credentials');
                  }}
                  options={API_SOURCE_OPTIONS.map((option) => ({ value: option.id, label: option.label }))}
                  placeholder="Choose a source platform"
                  allowFreeText={false}
                />
              </div>
            </label>
            <label className="text-xs font-semibold text-content-secondary">Connection name
              <input className="input mt-1 w-full" value={connectionName} onChange={(event) => setConnectionName(event.target.value)} />
            </label>
            <label className="text-xs font-semibold text-content-secondary">{sourcePlatform === 'domo' ? 'Domo instance URL' : 'HTTPS API base URL'}
              <input className="input mt-1 w-full" value={connectionBaseUrl} onChange={(event) => setConnectionBaseUrl(event.target.value)} placeholder={sourcePlatform === 'domo' ? 'https://company.domo.com' : 'https://...'} />
            </label>
            {sourcePlatform === 'domo' && (
              <fieldset className="md:col-span-2 lg:col-span-4">
                <legend className="text-xs font-semibold text-content-secondary">Domo authentication</legend>
                <div className="mt-1 grid gap-2 sm:grid-cols-2">
                  <button type="button" aria-pressed={domoAuthMode === 'oauth_client_credentials'} className={`rounded-button border px-3 py-2 text-left ${domoAuthMode === 'oauth_client_credentials' ? 'border-omni-500 bg-omni-50 ring-1 ring-omni-200' : 'border-border bg-white hover:bg-surface-secondary'}`} onClick={() => setDomoAuthMode('oauth_client_credentials')}>
                    <span className="block text-xs font-semibold text-content-primary">OAuth client credentials <span className="text-green-700">Recommended</span></span>
                    <span className="mt-1 block text-[11px] text-content-secondary">OmniKit requests short-lived, scoped tokens from Domo for each inventory run.</span>
                  </button>
                  <button type="button" aria-pressed={domoAuthMode === 'oauth_access_token'} className={`rounded-button border px-3 py-2 text-left ${domoAuthMode === 'oauth_access_token' ? 'border-omni-500 bg-omni-50 ring-1 ring-omni-200' : 'border-border bg-white hover:bg-surface-secondary'}`} onClick={() => setDomoAuthMode('oauth_access_token')}>
                    <span className="block text-xs font-semibold text-content-primary">Existing OAuth access token</span>
                    <span className="mt-1 block text-[11px] text-content-secondary">Compatibility option for a short-lived bearer token you already generated.</span>
                  </button>
                </div>
              </fieldset>
            )}
            <label className="text-xs font-semibold text-content-secondary">{sourcePlatform === 'looker' ? 'Looker client secret' : sourcePlatform === 'domo' ? domoAuthMode === 'oauth_client_credentials' ? 'Domo client secret' : 'Domo OAuth access token' : 'API key or token'}
              <input className="input mt-1 w-full" type="password" autoComplete="new-password" value={connectionCredential} onChange={(event) => setConnectionCredential(event.target.value)} />
            </label>
            {(sourcePlatform === 'looker' || sourcePlatform === 'domo' && domoAuthMode === 'oauth_client_credentials') && (
              <>
                <label className="text-xs font-semibold text-content-secondary">{sourcePlatform === 'domo' ? 'Domo client ID' : 'Looker client ID'}
                  <input className="input mt-1 w-full" value={sourceClientId} onChange={(event) => setSourceClientId(event.target.value)} autoComplete="off" />
                </label>
                {sourcePlatform === 'looker' && (
                  <label className="text-xs font-semibold text-content-secondary">LookML project ID <span className="font-normal text-content-tertiary">(optional)</span>
                    <input className="input mt-1 w-full" value={sourceProjectId} onChange={(event) => setSourceProjectId(event.target.value)} />
                  </label>
                )}
              </>
            )}
            {sourcePlatform === 'domo' && (
              <label className="text-xs font-semibold text-content-secondary md:col-span-2 lg:col-span-4">Product API developer token <span className="font-normal text-content-tertiary">(optional, enables Deep inventory)</span>
                <input className="input mt-1 w-full" type="password" autoComplete="new-password" value={domoProductApiToken} onChange={(event) => setDomoProductApiToken(event.target.value)} placeholder="Leave blank for least-privilege Basic inventory" />
                <span className="mt-1 block text-[11px] font-normal text-content-tertiary">This broader token inherits its Domo user's permissions. It stays encrypted and is sent only by the local server to this Domo tenant.</span>
              </label>
            )}
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

      {((selectedProvider && selectedProvider.kind !== 'omni_ai') || (sourceMode === 'api' && selectedConnection)) && (
        <div className="grid gap-3 border-t border-border pt-4 lg:grid-cols-2">
          {selectedProvider && selectedProvider.kind !== 'omni_ai' && (
            <div className="rounded-card border border-border p-3">
              <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="truncate text-sm font-semibold text-content-primary">{selectedProvider.name}</div>
                  {(() => {
                    const status = migrationProviderCredentialState(selectedProvider);
                    return <span className={`rounded-chip px-2 py-0.5 text-[10px] font-semibold ${status.state === 'ready' ? 'bg-green-100 text-green-800' : status.state === 'expired' ? 'bg-red-100 text-red-800' : status.state === 'attention' ? 'bg-amber-100 text-amber-900' : 'bg-surface-secondary text-content-secondary'}`}>{status.label}</span>;
                  })()}
                </div>
                <div className="truncate text-xs text-content-secondary">
                  {`${selectedProvider.kind} · ${selectedProvider.model} · ${selectedProvider.credentialMasked}`}
                </div>
              </div>
              <div className="flex shrink-0 gap-2">
                <button type="button" className="btn-secondary" onClick={() => void handleTestProvider(selectedProvider.id)} disabled={busy === `test-provider-${selectedProvider.id}`}>Test</button>
                <button type="button" className="icon-btn" title="Edit provider" onClick={() => startEditProvider(selectedProvider)}><Pencil size={14} /></button>
                <button type="button" className="icon-btn" title="Delete provider" onClick={async () => {
                  if (!window.confirm(`Delete ${selectedProvider.name}?`)) return;
                  try {
                    await deleteMigrationProvider(selectedProvider.id);
                    selectedProviderIdRef.current = includedOmniProvider?.id || '';
                    onProviderChange(includedOmniProvider?.id || '');
                    await loadLibrary();
                  } catch (caught) { setError(caught instanceof Error ? caught.message : 'Delete failed.'); }
                }}><Trash2 size={14} /></button>
              </div>
              </div>
              <div className="mt-1 text-[11px] text-content-secondary">
                Auth: {providerAuthLabel(selectedProvider)}
                {selectedProvider.credentialOwner ? ` · Owner: ${selectedProvider.credentialOwner}` : ''}
                {selectedProvider.rotationDueAt ? ` · Rotate by ${new Date(selectedProvider.rotationDueAt).toLocaleDateString()}` : ''}
              </div>
              <details className="mt-2 text-[11px] text-content-secondary">
                <summary className="cursor-pointer font-semibold text-content-primary">Provider capabilities</summary>
                <div className="mt-1">{selectedProvider.capabilities.supportedTasks.map((task) => task.split('_').join(' ')).join(' · ')}</div>
              </details>
              {selectedProvider.capabilities.limitations.map((limitation) => (
                <div key={limitation} className="mt-2 rounded-button border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] text-amber-900">{limitation}</div>
              ))}
            </div>
          )}
          {sourceMode === 'api' && selectedConnection && (
            <div className="flex items-center justify-between gap-3 rounded-card border border-border p-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-content-primary">{selectedConnection.name}</div>
                <div className="truncate text-xs text-content-secondary">
                  {platformLabel(selectedConnection.platform)}
                  {selectedConnection.platform === 'domo' ? ` · ${selectedConnection.inventoryAccess === 'deep' ? 'Deep inventory' : 'Basic inventory'} · ${selectedConnection.authMode === 'oauth_client_credentials' ? 'OAuth client' : 'OAuth token'}` : ''}
                  {' · Encrypted'}
                </div>
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
        <label className="flex-1 text-xs font-semibold text-content-secondary">Project name
          <input className="input mt-1 w-full" value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="Finance semantic migration" />
        </label>
        <button type="button" className="btn-secondary" onClick={() => void handleSaveProject()} disabled={busy === 'save-project' || !selectedProviderId}>
          {busy === 'save-project' ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} Save draft
        </button>
        {projects.length > 0 && <div className="pb-2 text-xs text-content-tertiary">{projects.length} saved project{projects.length === 1 ? '' : 's'}</div>}
      </div>

      {error && <div className="rounded-button border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</div>}
      {notice && <div className="rounded-button border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">{notice}</div>}
    </section>
  );
}

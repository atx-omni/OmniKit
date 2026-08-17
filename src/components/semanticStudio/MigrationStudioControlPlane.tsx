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
  ServerCog,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { ComboBox } from '@/components/ui/ComboBox';
import { MigrationSourceSetupGuide } from './MigrationSourceSetupGuide';
import type {
  MigrationBiSourceTool,
  MigrationPlatformConnection,
  MigrationPlatformKind,
  MigrationPlatformAuthMode,
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
  loadMigrationSourceInventory,
  listMigrationPlatformConnections,
  listMigrationProviders,
  saveMigrationPlatformConnection,
  saveMigrationProvider,
  testMigrationPlatformConnection,
  testMigrationProvider,
  type SourceInventory,
} from '@/services/semanticMigration/studioApi';
const PROVIDER_OPTIONS = PUBLIC_MIGRATION_PROVIDER_OPTIONS;
type ConfigurableMigrationProviderKind = Exclude<MigrationProviderKind, 'omni_ai'>;
const OPTIONAL_PROVIDER_OPTIONS = PUBLIC_MIGRATION_PROVIDER_OPTIONS.filter(
  (provider): provider is typeof provider & { id: ConfigurableMigrationProviderKind } => provider.id !== 'omni_ai',
);
const FIXED_API_PROVIDER_BASE_URLS: Partial<Record<ConfigurableMigrationProviderKind, string>> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
};

function includedOmniProviderId(instanceId: string): string {
  return `omni-ai-default-${instanceId}`;
}

type SavedApiSourcePlatform = MigrationBiSourceTool;

const PLATFORM_LABELS: Record<MigrationPlatformKind, string> = {
  domo: 'Domo',
  looker: 'Looker',
  metabase: 'Metabase',
  microstrategy: 'Strategy',
  power_bi: 'Power BI',
  sigma: 'Sigma',
  tableau: 'Tableau',
  webfocus: 'WebFOCUS',
  dbt: 'dbt',
  omni: 'Omni',
};

const API_SOURCE_OPTIONS: Array<{ id: SavedApiSourcePlatform; label: string; description: string }> = [
  { id: 'domo', label: 'Domo', description: 'Inventory datasets, cards, pages, Beast Modes, and pipeline dependencies.' },
  { id: 'looker', label: 'Looker', description: 'Inventory LookML projects, models, Explores, dashboards, Looks, and validation evidence.' },
  { id: 'sigma', label: 'Sigma', description: 'Inventory workbooks and retrieve documented Data Model specifications for selected scope.' },
  { id: 'metabase', label: 'Metabase', description: 'Inventory databases, tables, metrics, segments, cards, dashboards, and collections.' },
  { id: 'tableau', label: 'Tableau', description: 'Use a PAT to retrieve selected workbook and data-source definitions without extracts.' },
  { id: 'power_bi', label: 'Power BI / Fabric', description: 'Use Microsoft Entra OAuth to retrieve selected TMDL and PBIR definitions.' },
  { id: 'microstrategy', label: 'Strategy', description: 'Use a project-bound server session to retrieve selected semantic and content definitions.' },
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

function isConfigurableProviderKind(value: string): value is ConfigurableMigrationProviderKind {
  return value !== 'omni_ai' && isPublicProviderKind(value);
}

function dateInputValue(value?: string): string {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString().slice(0, 10) : '';
}

function dateTimeInputValue(value?: string): string {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString().slice(0, 16) : '';
}

function localDateTimeInputValue(value?: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) return '';
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function normalizedProviderBaseUrl(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.hostname = parsed.hostname.replace(/\.$/, '');
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function fixedApiProviderBaseUrlIssue(kind: MigrationProviderKind, baseUrl?: string): string {
  if (kind !== 'openai' && kind !== 'anthropic') return '';
  const expected = FIXED_API_PROVIDER_BASE_URLS[kind]!;
  const actual = normalizedProviderBaseUrl(baseUrl || expected);
  return actual === normalizedProviderBaseUrl(expected)
    ? ''
    : `${kind === 'openai' ? 'OpenAI' : 'Anthropic'} API-key profiles must use the documented ${expected} endpoint.`;
}

function httpsProviderOriginIssue(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || !parsed.hostname) return 'Enter an HTTPS account or workspace URL.';
    if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== '/')) {
      return 'Enter only the HTTPS account or workspace origin, without credentials, paths, query parameters, or fragments.';
    }
    return '';
  } catch {
    return 'Enter a valid HTTPS account or workspace URL.';
  }
}

function providerAuthLabel(provider: MigrationProviderProfile): string {
  const kind = provider.kind;
  if (!isPublicProviderKind(kind)) return provider.authMode || 'legacy';
  const guidance = migrationProviderGuidance(kind);
  return guidance.authOptions.find((option) => option.id === (provider.authMode || guidance.defaultAuthMode))?.label || provider.authMode || 'configured';
}

function providerAuthenticationIssue(provider: MigrationProviderProfile): string {
  if (!provider.enabled) return 'This provider is disabled or uses a retired authentication method.';
  if (provider.kind === 'databricks_model_serving') {
    return 'Databricks Foundation Model profiles are retired. Delete this profile and choose a supported AI option.';
  }
  const endpointIssue = isPublicProviderKind(provider.kind)
    ? fixedApiProviderBaseUrlIssue(provider.kind, provider.baseUrl)
    : '';
  if (endpointIssue) return endpointIssue;
  const required = provider.kind === 'openai' || provider.kind === 'anthropic'
    ? 'api_key'
    : provider.kind === 'snowflake_cortex'
      || provider.kind === 'databricks_genie'
      ? 'oauth_access_token'
      : provider.kind === 'omni_ai'
        ? 'linked_omni_instance'
        : undefined;
  return required && provider.authMode !== required
    ? 'This provider uses a retired authentication method. Replace it before use.'
    : '';
}

function providerReadyForUse(provider: MigrationProviderProfile): boolean {
  const expiresAt = provider.credentialExpiresAt ? Date.parse(provider.credentialExpiresAt) : Number.POSITIVE_INFINITY;
  return !providerAuthenticationIssue(provider)
    && expiresAt > Date.now()
    && provider.lastValidationStatus === 'valid'
    && Boolean(provider.lastValidatedRevision)
    && provider.lastValidatedRevision === provider.updatedAt;
}

function platformLabel(kind: MigrationPlatformKind): string {
  return PLATFORM_LABELS[kind] || kind;
}

function isMigrationBiSourceTool(kind: MigrationPlatformKind): kind is MigrationBiSourceTool {
  return kind === 'domo'
    || kind === 'looker'
    || kind === 'metabase'
    || kind === 'microstrategy'
    || kind === 'power_bi'
    || kind === 'sigma'
    || kind === 'tableau'
    || kind === 'webfocus';
}

function savedApiConnectionIssue(connection: MigrationPlatformConnection): string {
  if (!connection.enabled) return 'This saved API source is disabled.';
  if (connection.platform === 'domo') {
    if (!connection.hasProductApiToken && !connection.hasPlatformOAuthClient) {
      return 'This legacy Domo source has neither a Product API developer token nor Platform OAuth client credentials. Replace it or use Manual Files.';
    }
    return '';
  }
  if (connection.platform === 'looker') {
    if (connection.authMode !== 'api_client_credentials' || !connection.clientId || connection.hasCredential !== true) {
      return 'This is a legacy Looker Saved API connection. Replace it with a Looker API client ID and client secret connection or use Manual Files.';
    }
    return '';
  }
  if (connection.platform === 'metabase') {
    if (connection.authMode !== 'api_key' || connection.hasCredential !== true || Boolean(connection.clientId)) {
      return 'This is a legacy Metabase Saved API connection. Replace it with a Metabase API key connection or use Manual Files.';
    }
    return '';
  }
  if (connection.platform === 'sigma') return connection.authMode === 'oauth_client_credentials' && Boolean(connection.clientId) && connection.hasCredential === true ? '' : 'Replace this Sigma source with documented API client credentials or use Manual Files.';
  if (connection.platform === 'tableau') return connection.authMode === 'personal_access_token' && Boolean(connection.username) && connection.hasCredential === true ? '' : 'Replace this Tableau source with a PAT name and PAT secret, or use Manual Files.';
  if (connection.platform === 'power_bi') {
    const ready = connection.authMode === 'oauth_client_credentials'
      ? Boolean(connection.accountIdentifier && connection.clientId && connection.hasCredential)
      : connection.authMode === 'oauth_access_token' && connection.hasCredential === true && Boolean(connection.credentialExpiresAt);
    return ready ? '' : 'Replace this Power BI/Fabric source with Microsoft Entra OAuth credentials or use Manual Files.';
  }
  if (connection.platform === 'microstrategy') return connection.authMode === 'username_password_session' && Boolean(connection.username && connection.projectId && connection.hasCredential) ? '' : 'Replace this Strategy source with a project-bound supported session credential or use Manual Files.';
  return `Saved API is unavailable for ${platformLabel(connection.platform)}. Use Manual Files.`;
}

function savedApiCredentialLabel(connection: MigrationPlatformConnection): string {
  if (savedApiConnectionIssue(connection)) return 'Legacy Saved API · replacement or Manual Files required';
  if (connection.platform === 'domo') return 'Product API developer token';
  if (connection.platform === 'looker') return 'API client ID + secret';
  if (connection.platform === 'sigma') return 'API client ID + secret';
  if (connection.platform === 'tableau') return 'PAT name + secret';
  if (connection.platform === 'power_bi') return connection.authMode === 'oauth_access_token' ? 'OAuth access token' : 'Entra service principal';
  if (connection.platform === 'microstrategy') return 'Project-bound session login';
  return 'API key';
}

function queryValidationLabel(mode: SourceInventory['connector']['capabilities']['queryValidationMode']): string {
  if (mode === 'source_and_target') return 'automatic source + target comparison';
  if (mode === 'manual_source_evidence') return 'target validation; source results must be supplied';
  return 'target validation only';
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
  const [inventory, setInventory] = useState<SourceInventory | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showProviderForm, setShowProviderForm] = useState(false);
  const [showProviderChoices, setShowProviderChoices] = useState(false);
  const [showConnectionForm, setShowConnectionForm] = useState(false);
  const [editingProviderId, setEditingProviderId] = useState('');
  const [editingConnectionId, setEditingConnectionId] = useState('');
  const [providerKind, setProviderKind] = useState<ConfigurableMigrationProviderKind>('openai');
  const [providerName, setProviderName] = useState('');
  const [providerModel, setProviderModel] = useState(providerDefaultModel('openai'));
  const [providerBaseUrl, setProviderBaseUrl] = useState(defaultBaseUrl('openai'));
  const [providerCredential, setProviderCredential] = useState('');
  const [providerAuthMode, setProviderAuthMode] = useState<MigrationProviderAuthMode>(migrationProviderGuidance('openai').defaultAuthMode);
  const [providerCredentialOwner, setProviderCredentialOwner] = useState('');
  const [providerCredentialExpiresAt, setProviderCredentialExpiresAt] = useState('');
  const [providerRotationDueAt, setProviderRotationDueAt] = useState('');
  const [sourcePlatform, setSourcePlatform] = useState<SavedApiSourcePlatform>('domo');
  const [connectionName, setConnectionName] = useState('');
  const [connectionBaseUrl, setConnectionBaseUrl] = useState('');
  const [connectionCredential, setConnectionCredential] = useState('');
  const [sourceClientId, setSourceClientId] = useState('');
  const [sourceAccountIdentifier, setSourceAccountIdentifier] = useState('');
  const [sourceUsername, setSourceUsername] = useState('');
  const [sourceSiteId, setSourceSiteId] = useState('');
  const [sourceWorkspaceId, setSourceWorkspaceId] = useState('');
  const [sourceCredentialExpiresAt, setSourceCredentialExpiresAt] = useState('');
  const [powerBiAuthMode, setPowerBiAuthMode] = useState<'oauth_client_credentials' | 'oauth_access_token'>('oauth_client_credentials');
  const [domoOAuthEnabled, setDomoOAuthEnabled] = useState(false);
  const [domoProductApiToken, setDomoProductApiToken] = useState('');
  const [removeDomoOAuthClient, setRemoveDomoOAuthClient] = useState(false);
  const [removeDomoProductApiToken, setRemoveDomoProductApiToken] = useState(false);
  const [sourceProjectId, setSourceProjectId] = useState('');
  const selectedProviderIdRef = useRef(selectedProviderId);
  const selectedSourceConnectionIdRef = useRef(selectedSourceConnectionId);
  const libraryRequestSequenceRef = useRef(0);
  const inventoryRequestSequenceRef = useRef(0);
  const providerDrawerRef = useRef<HTMLElement>(null);
  const providerDrawerCloseRef = useRef<HTMLButtonElement>(null);
  const providerDrawerReturnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    selectedProviderIdRef.current = selectedProviderId;
  }, [selectedProviderId]);

  useEffect(() => {
    if (selectedSourceConnectionIdRef.current === selectedSourceConnectionId) return;
    selectedSourceConnectionIdRef.current = selectedSourceConnectionId;
    inventoryRequestSequenceRef.current += 1;
    setBusy((current) => current.startsWith('inventory-') ? '' : current);
    setInventory(null);
    setError('');
    setNotice('');
    onInventoryLoaded?.(null);
  }, [onInventoryLoaded, selectedSourceConnectionId]);

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

  const loadLibrary = useCallback(async (options: { preserveError?: boolean; isCurrent?: () => boolean; manageBusy?: boolean } = {}) => {
    const requestSequence = libraryRequestSequenceRef.current + 1;
    libraryRequestSequenceRef.current = requestSequence;
    const isCurrent = () => (
      libraryRequestSequenceRef.current === requestSequence
      && (options.isCurrent?.() ?? true)
    );
    if (!isCurrent()) return;
    if (options.manageBusy !== false) setBusy('library');
    if (!options.preserveError) setError('');
    try {
      const [loadedProviders, nextConnections] = await Promise.all([
        listMigrationProviders(),
        listMigrationPlatformConnections(),
      ]);
      if (!isCurrent()) return;
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
          if (!isCurrent()) return;
          includedProvider = savedIncludedProvider;
          nextProviders = [...nextProviders.filter((provider) => provider.id !== savedIncludedProvider.id), savedIncludedProvider]
            .sort((a, b) => a.name.localeCompare(b.name));
        }
        const currentProvider = nextProviders.find((provider) => provider.id === selectedProviderIdRef.current);
        if (!currentProvider
          || currentProvider.kind === 'omni_ai'
          || !providerReadyForUse(currentProvider)) {
          selectedProviderIdRef.current = includedProvider.id;
          onProviderChange(includedProvider.id);
        }
      }
      setProviders(nextProviders);
      setConnections(nextConnections);
    } catch (caught) {
      if (isCurrent()) setError(caught instanceof Error ? caught.message : 'Could not load the migration library.');
    } finally {
      if (isCurrent() && options.manageBusy !== false) setBusy('');
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
  const optionalProviders = useMemo(
    () => providers.filter((provider) => provider.kind !== 'omni_ai' && providerReadyForUse(provider)),
    [providers],
  );
  const providersNeedingTest = useMemo(
    () => providers.filter((provider) => provider.kind !== 'omni_ai'
      && !providerAuthenticationIssue(provider)
      && !providerReadyForUse(provider)),
    [providers],
  );
  const retiredProviders = useMemo(
    () => providers.filter((provider) => provider.kind !== 'omni_ai' && Boolean(providerAuthenticationIssue(provider))),
    [providers],
  );
  const usingIncludedOmni = !selectedProvider || selectedProvider.kind === 'omni_ai';
  const selectedConnection = useMemo(() => connections.find((connection) => connection.id === selectedSourceConnectionId), [connections, selectedSourceConnectionId]);
  const editingConnection = useMemo(() => connections.find((connection) => connection.id === editingConnectionId), [connections, editingConnectionId]);
  const setupGuideSource = sourceMode === 'manual'
    ? manualSourcePlatform
    : showConnectionForm
      ? sourcePlatform
      : selectedConnection && isMigrationBiSourceTool(selectedConnection.platform)
        ? selectedConnection.platform
        : sourcePlatform;
  const selectedProviderGuidance = migrationProviderGuidance(providerKind);
  const selectedAuthOption = selectedProviderGuidance.authOptions.find((option) => option.id === providerAuthMode);
  const selectedAuthSetup = migrationProviderAuthSetup(providerKind, providerAuthMode);

  async function handleSaveProvider() {
    const name = providerName.trim();
    const model = providerModel.trim();
    const baseUrl = providerBaseUrl.trim();
    if (!name) {
      setError('Enter a profile name.');
      return;
    }
    if (!model) {
      setError(`Enter the ${selectedProviderGuidance.modelLabel.toLowerCase()}.`);
      return;
    }
    const fixedEndpointIssue = fixedApiProviderBaseUrlIssue(providerKind, baseUrl);
    if (fixedEndpointIssue) {
      setError(fixedEndpointIssue);
      return;
    }
    if (!editingProviderId && !providerCredential.trim()) {
      setError(`Enter the ${selectedAuthSetup.credentialLabel.toLowerCase()}.`);
      return;
    }
    let credentialExpiresAt: string | undefined;
    if (providerCredentialExpiresAt) {
      const expiration = new Date(providerCredentialExpiresAt);
      if (!Number.isFinite(expiration.getTime())) {
        setError('Enter a valid credential expiration date and time.');
        return;
      }
      credentialExpiresAt = expiration.toISOString();
    }
    if (providerAuthMode === 'oauth_access_token') {
      const originIssue = httpsProviderOriginIssue(baseUrl);
      if (originIssue) {
        setError(originIssue);
        return;
      }
      if (!credentialExpiresAt || Date.parse(credentialExpiresAt) <= Date.now()) {
        setError('Enter the OAuth access token\'s exact future expiration date and time.');
        return;
      }
    }
    setBusy('save-provider');
    setError('');
    setNotice('');
    try {
      const saved = await saveMigrationProvider({
        id: editingProviderId || undefined,
        name,
        kind: providerKind,
        model,
        baseUrl: baseUrl || undefined,
        authMode: providerAuthMode,
        credentialOwner: providerCredentialOwner || undefined,
        credentialExpiresAt,
        rotationDueAt: providerRotationDueAt || undefined,
        credential: providerCredential,
      });
      libraryRequestSequenceRef.current += 1;
      setProviders((current) => [...current.filter((provider) => provider.id !== saved.id), saved].sort((a, b) => a.name.localeCompare(b.name)));
      const fallbackProviderId = includedOmniProvider?.id || '';
      selectedProviderIdRef.current = fallbackProviderId;
      onProviderChange(fallbackProviderId);
      setProviderCredential('');
      setEditingProviderId(saved.id);
      try {
        const result = await testMigrationProvider(saved.id);
        await loadLibrary({ preserveError: true, manageBusy: false });
        selectedProviderIdRef.current = saved.id;
        onProviderChange(saved.id);
        setEditingProviderId('');
        setShowProviderForm(false);
        setShowProviderChoices(false);
        window.setTimeout(() => providerDrawerReturnFocusRef.current?.focus(), 0);
        setNotice(`${saved.name} connected successfully using ${result.model} and is now selected.`);
      } catch (caught) {
        await loadLibrary({ preserveError: true, manageBusy: false });
        setError(caught instanceof Error ? caught.message : 'Provider test failed.');
        setNotice(`${saved.name} is encrypted in the local vault but remains unselected. Correct the profile and run Update and test.`);
      }
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
    if (providerAuthenticationIssue(provider)) {
      setError('This provider uses a disabled or retired authentication method. Delete it and create a new compliant profile.');
      return;
    }
    if (!isConfigurableProviderKind(provider.kind)) {
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
    setProviderCredentialExpiresAt(localDateTimeInputValue(provider.credentialExpiresAt));
    setProviderRotationDueAt(dateInputValue(provider.rotationDueAt));
    setShowProviderForm(true);
    setError('');
    setNotice('Leave the credential blank to keep the encrypted value already in the vault.');
  }

  function resetConnectionForm() {
    setEditingConnectionId('');
    setSourcePlatform('domo');
    setConnectionName('');
    setConnectionBaseUrl('');
    setConnectionCredential('');
    setSourceClientId('');
    setSourceAccountIdentifier('');
    setSourceUsername('');
    setSourceSiteId('');
    setSourceWorkspaceId('');
    setSourceCredentialExpiresAt('');
    setPowerBiAuthMode('oauth_client_credentials');
    setDomoOAuthEnabled(false);
    setDomoProductApiToken('');
    setRemoveDomoOAuthClient(false);
    setRemoveDomoProductApiToken(false);
    setSourceProjectId('');
  }

  function startAddConnection() {
    resetConnectionForm();
    setShowConnectionForm(true);
    setError('');
    setNotice('');
  }

  function startEditConnection(connection: MigrationPlatformConnection) {
    if (savedApiConnectionIssue(connection)) {
      setError('This source uses a disabled or retired authentication contract. Create a compliant replacement connection or use Manual Files.');
      return;
    }
    setEditingConnectionId(connection.id);
    setSourcePlatform(connection.platform as SavedApiSourcePlatform);
    setConnectionName(connection.name);
    setConnectionBaseUrl(connection.baseUrl || '');
    setConnectionCredential('');
    setSourceClientId(connection.platform === 'tableau' ? connection.username || '' : connection.clientId || '');
    setSourceAccountIdentifier(connection.accountIdentifier || '');
    setSourceUsername(connection.username || '');
    setSourceSiteId(connection.siteId || '');
    setSourceWorkspaceId(connection.workspaceId || '');
    setSourceCredentialExpiresAt(dateTimeInputValue(connection.credentialExpiresAt));
    setPowerBiAuthMode(connection.platform === 'power_bi' && connection.authMode === 'oauth_access_token' ? 'oauth_access_token' : 'oauth_client_credentials');
    setDomoOAuthEnabled(Boolean(connection.hasPlatformOAuthClient));
    setDomoProductApiToken('');
    setRemoveDomoOAuthClient(false);
    setRemoveDomoProductApiToken(false);
    setSourceProjectId(connection.projectId || '');
    setShowConnectionForm(true);
    setError('');
    setNotice('Leave encrypted secrets blank to retain them. Changing a server, tenant, or credential identity requires a replacement secret.');
  }

  async function handleSaveConnection() {
    const existingConnection = editingConnectionId
      ? connections.find((connection) => connection.id === editingConnectionId && connection.platform === sourcePlatform)
      : undefined;
    const hasExistingSecret = Boolean(existingConnection?.hasCredential);
    const hasExistingProductToken = Boolean(existingConnection?.hasProductApiToken) && !removeDomoProductApiToken;
    const hasExistingOAuthClient = Boolean(existingConnection?.hasPlatformOAuthClient) && !removeDomoOAuthClient;
    if (sourcePlatform === 'domo'
      && !domoProductApiToken.trim()
      && !hasExistingProductToken
      && !(domoOAuthEnabled && sourceClientId.trim() && (connectionCredential.trim() || hasExistingOAuthClient))) {
      setError('Enter a Domo Product API developer token, Platform OAuth client credentials, or both.');
      return;
    }
    if (sourcePlatform === 'domo' && domoOAuthEnabled && (!sourceClientId.trim() || (!connectionCredential.trim() && !hasExistingOAuthClient))) {
      setError('Enter both the Domo Platform OAuth client ID and client secret, or remove that credential family from this source.');
      return;
    }
    if ((sourcePlatform === 'looker' || sourcePlatform === 'sigma') && !sourceClientId.trim()) {
      setError(`Enter the ${platformLabel(sourcePlatform)} API client ID.`);
      return;
    }
    if ((sourcePlatform === 'looker' || sourcePlatform === 'sigma') && !connectionCredential.trim() && !hasExistingSecret) {
      setError(`Enter the ${platformLabel(sourcePlatform)} API client secret.`);
      return;
    }
    if (sourcePlatform === 'metabase' && !connectionCredential.trim() && !hasExistingSecret) {
      setError('Enter the Metabase API key.');
      return;
    }
    if (sourcePlatform === 'tableau' && (!sourceClientId.trim() || (!connectionCredential.trim() && !hasExistingSecret))) {
      setError('Enter the Tableau PAT name and PAT secret.');
      return;
    }
    if (sourcePlatform === 'power_bi') {
      if (!sourceWorkspaceId.trim()) {
        setError('Enter the Fabric workspace ID.');
        return;
      }
      if (powerBiAuthMode === 'oauth_client_credentials'
        && (!sourceAccountIdentifier.trim() || !sourceClientId.trim() || (!connectionCredential.trim() && !hasExistingSecret))) {
        setError('Enter the Microsoft Entra tenant ID, client ID, and client secret.');
        return;
      }
      if (powerBiAuthMode === 'oauth_access_token'
        && ((!connectionCredential.trim() && !hasExistingSecret) || !sourceCredentialExpiresAt)) {
        setError('Enter the delegated OAuth access token and its expiration date.');
        return;
      }
    }
    if (sourcePlatform === 'microstrategy' && (!sourceUsername.trim() || (!connectionCredential.trim() && !hasExistingSecret) || !sourceProjectId.trim())) {
      setError('Enter the Strategy username, password, and project ID.');
      return;
    }
    if (!connectionBaseUrl.trim()) {
      setError(`Enter the ${platformLabel(sourcePlatform)} HTTPS base URL.`);
      return;
    }
    setBusy('save-connection');
    setError('');
    setNotice('');
    try {
      const authMode: MigrationPlatformAuthMode = sourcePlatform === 'domo'
        ? domoProductApiToken.trim() || hasExistingProductToken ? 'product_api_token' : 'oauth_client_credentials'
          : sourcePlatform === 'looker' ? 'api_client_credentials'
          : sourcePlatform === 'power_bi' ? powerBiAuthMode
          : sourcePlatform === 'sigma' ? 'oauth_client_credentials'
            : sourcePlatform === 'tableau' ? 'personal_access_token'
              : sourcePlatform === 'microstrategy' ? 'username_password_session'
                : 'api_key';
      const saved = await saveMigrationPlatformConnection({
        id: editingConnectionId || undefined,
        name: connectionName.trim() || `${platformLabel(sourcePlatform)} source`,
        platform: sourcePlatform,
        baseUrl: connectionBaseUrl,
        credential: sourcePlatform === 'domo' && !domoOAuthEnabled ? '' : connectionCredential,
        authMode,
        productApiToken: sourcePlatform === 'domo' ? domoProductApiToken : undefined,
        clearCredential: sourcePlatform === 'domo' && removeDomoOAuthClient,
        clearClientId: sourcePlatform === 'domo' && removeDomoOAuthClient,
        clearProductApiToken: sourcePlatform === 'domo' && removeDomoProductApiToken,
        clientId: ['domo', 'looker', 'sigma'].includes(sourcePlatform) || (sourcePlatform === 'power_bi' && powerBiAuthMode === 'oauth_client_credentials') ? sourceClientId : undefined,
        accountIdentifier: sourcePlatform === 'power_bi' && powerBiAuthMode === 'oauth_client_credentials' ? sourceAccountIdentifier : undefined,
        siteId: sourcePlatform === 'tableau' ? sourceSiteId : undefined,
        workspaceId: sourcePlatform === 'power_bi' ? sourceWorkspaceId : undefined,
        username: sourcePlatform === 'microstrategy' ? sourceUsername : sourcePlatform === 'tableau' ? sourceClientId : undefined,
        projectId: sourcePlatform === 'looker' || sourcePlatform === 'microstrategy' ? sourceProjectId : undefined,
        credentialExpiresAt: sourcePlatform === 'power_bi' && powerBiAuthMode === 'oauth_access_token' ? sourceCredentialExpiresAt : undefined,
      });
      libraryRequestSequenceRef.current += 1;
      setConnections((current) => [...current.filter((connection) => connection.id !== saved.id), saved].sort((a, b) => a.name.localeCompare(b.name)));
      onSourceModeChange('api');
      changeSourceConnection(saved.id);
      setConnectionCredential('');
      setSourceClientId('');
      setSourceAccountIdentifier('');
      setSourceUsername('');
      setSourceSiteId('');
      setSourceWorkspaceId('');
      setSourceCredentialExpiresAt('');
      setPowerBiAuthMode('oauth_client_credentials');
      setDomoOAuthEnabled(false);
      setDomoProductApiToken('');
      setRemoveDomoOAuthClient(false);
      setRemoveDomoProductApiToken(false);
      setEditingConnectionId('');
      setShowConnectionForm(false);
      setNotice(`${saved.name} is encrypted in the local vault. Run Load inventory to validate this exact revision before planning.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save the source connection.');
    } finally {
      setBusy('');
    }
  }

  async function handleTestProvider(id: string) {
    setBusy(`test-provider-${id}`);
    setError('');
    setNotice('');
    const fallbackProviderId = includedOmniProvider?.id || '';
    selectedProviderIdRef.current = fallbackProviderId;
    onProviderChange(fallbackProviderId);
    try {
      const result = await testMigrationProvider(id);
      await loadLibrary({ preserveError: true, manageBusy: false });
      selectedProviderIdRef.current = id;
      onProviderChange(id);
      setShowProviderChoices(false);
      setNotice(`Provider connected successfully using ${result.model} and is now selected.`);
    } catch (caught) {
      await loadLibrary({ preserveError: true, manageBusy: false });
      setError(caught instanceof Error ? caught.message : 'Provider test failed.');
      setNotice('The provider remains unselected until its exact saved revision passes Test.');
    } finally {
      setBusy('');
    }
  }

  async function handleLoadInventory(id: string) {
    const connection = connections.find((candidate) => candidate.id === id);
    if (!connection) {
      setError('Choose a saved API source before loading inventory.');
      return;
    }
    const policyIssue = savedApiConnectionIssue(connection);
    if (policyIssue) {
      setInventory(null);
      onInventoryLoaded?.(null);
      setNotice('');
      setError(policyIssue);
      return;
    }
    const requestSequence = inventoryRequestSequenceRef.current + 1;
    inventoryRequestSequenceRef.current = requestSequence;
    const isCurrentRequest = () => (
      inventoryRequestSequenceRef.current === requestSequence
      && selectedSourceConnectionIdRef.current === id
    );
    setBusy(`inventory-${id}`);
    setError('');
    setNotice('');
    setInventory(null);
    onInventoryLoaded?.(null);
    try {
      const tested = await testMigrationPlatformConnection(id);
      if (!isCurrentRequest()) return;
      // Current servers return the verified inventory with the connection test so
      // one operator action performs one source scan. Keep the fallback only for
      // older local servers during a rolling upgrade.
      const result = tested.inventory || await loadMigrationSourceInventory(id);
      if (!isCurrentRequest()) return;
      if (result.connectionId !== id) {
        throw new Error('Source inventory response did not match the selected saved API source. Reload the selected source and retry.');
      }
      setInventory(result);
      onInventoryLoaded?.(result);
      const collectionStatus = result.collection?.status || (result.truncated ? 'bounded' : 'complete');
      const scopeLabel = result.collection?.scopeLabel || 'the configured scope';
      if (collectionStatus === 'partial' || collectionStatus === 'failed') {
        const detail = result.collection?.errors[0] || `${platformLabel(result.platform)} inventory could not be verified completely. Check source access and retry.`;
        setError(`Loaded ${result.items.length} visible ${platformLabel(result.platform)} source items from ${scopeLabel}, but the collection is incomplete and planning remains blocked. ${detail}`);
      } else if (collectionStatus === 'bounded') {
        const remediation = result.platform === 'domo'
          ? 'Select a visible Page or Card for exact evidence preparation, or use focused Manual Files when the required item is outside this catalog window.'
          : 'Select a visible source root for exact evidence preparation, or use focused Manual Files when the required item is outside this catalog window.';
        setNotice(`Loaded ${result.items.length} visible ${platformLabel(result.platform)} source items from ${scopeLabel}. The discovery catalog reached its safety bound; it is not migration evidence. ${remediation}`);
      } else {
        setNotice(result.items.length === 0
          ? `The ${platformLabel(result.platform)} inventory is verified empty for ${scopeLabel}.`
          : `Loaded ${result.items.length} ${platformLabel(result.platform)} source items from ${scopeLabel}.`);
      }
      await loadLibrary({ preserveError: true, isCurrent: isCurrentRequest, manageBusy: false });
    } catch (caught) {
      if (isCurrentRequest()) {
        setInventory(null);
        onInventoryLoaded?.(null);
        setNotice('');
        setError(caught instanceof Error ? caught.message : 'Source inventory could not be loaded.');
      }
    } finally {
      if (isCurrentRequest()) setBusy('');
    }
  }

  function changeSourceMode(next: 'api' | 'manual') {
    if (next === sourceMode) return;
    inventoryRequestSequenceRef.current += 1;
    if (next === 'manual') selectedSourceConnectionIdRef.current = '';
    setBusy((current) => current.startsWith('inventory-') ? '' : current);
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
    inventoryRequestSequenceRef.current += 1;
    selectedSourceConnectionIdRef.current = id;
    setBusy((current) => current.startsWith('inventory-') ? '' : current);
    setInventory(null);
    setNotice('');
    setError('');
    onInventoryLoaded?.(null);
    onSourceConnectionChange(id);
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

      <div data-testid="migration-setup-grid" className="grid rounded-card border border-border bg-white lg:grid-cols-3 lg:divide-x lg:divide-border">
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
                  options={connections.map((connection) => ({
                    value: connection.id,
                    label: connection.name,
                    subtitle: `${platformLabel(connection.platform)} · ${savedApiCredentialLabel(connection)}`,
                  }))}
                  placeholder="Choose a saved API source"
                  emptyLabel="No saved API sources"
                  allowFreeText={false}
                />
              </div>
              <button type="button" className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-omni-700" onClick={startAddConnection}>
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
              {providersNeedingTest.length > 0 && (
                <div className="mt-3 rounded-button border border-blue-200 bg-blue-50 p-2.5" data-testid="untested-migration-providers">
                  <div className="text-[11px] font-semibold text-blue-950">Saved profiles that need Test</div>
                  <div className="mt-1 text-[11px] text-blue-900">A profile becomes selectable only after its exact saved revision connects successfully.</div>
                  {providersNeedingTest.map((provider) => {
                    const status = migrationProviderCredentialState(provider);
                    return (
                      <div key={provider.id} className="mt-2 flex items-center justify-between gap-2 text-[11px] text-blue-950">
                        <span className="min-w-0 truncate">{provider.name} · {status.label}</span>
                        <div className="flex shrink-0 items-center gap-1">
                          <button type="button" className="btn-secondary min-h-8 px-2 py-1 text-[11px]" onClick={() => void handleTestProvider(provider.id)} disabled={busy === `test-provider-${provider.id}`}>
                            {busy === `test-provider-${provider.id}` ? <Loader2 size={12} className="animate-spin" /> : <ShieldCheck size={12} />} Test
                          </button>
                          <button type="button" className="icon-btn" title={`Edit ${provider.name}`} onClick={() => startEditProvider(provider)}><Pencil size={13} /></button>
                          <button type="button" className="icon-btn" title={`Delete ${provider.name}`} onClick={async () => {
                            if (!window.confirm(`Delete ${provider.name}?`)) return;
                            try { await deleteMigrationProvider(provider.id); await loadLibrary(); } catch (caught) { setError(caught instanceof Error ? caught.message : 'Delete failed.'); }
                          }}><Trash2 size={13} /></button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {retiredProviders.length > 0 && (
                <div className="mt-3 rounded-button border border-amber-200 bg-amber-50 p-2.5" data-testid="retired-migration-providers">
                  <div className="text-[11px] font-semibold text-amber-950">Retired authentication profiles</div>
                  {retiredProviders.map((provider) => (
                    <div key={provider.id} className="mt-2 flex items-center justify-between gap-2 text-[11px] text-amber-950">
                      <span className="min-w-0 truncate">{provider.name} · replace before use</span>
                      <button type="button" className="icon-btn" title={`Delete ${provider.name}`} onClick={async () => {
                        try { await deleteMigrationProvider(provider.id); await loadLibrary(); } catch (caught) { setError(caught instanceof Error ? caught.message : 'Delete failed.'); }
                      }}><Trash2 size={13} /></button>
                    </div>
                  ))}
                </div>
              )}
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

      <MigrationSourceSetupGuide source={setupGuideSource} mode={sourceMode} />

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
                {OPTIONAL_PROVIDER_OPTIONS
                  .filter((option) => option.id !== 'databricks_genie'
                    || !providers.some((provider) => provider.kind === 'databricks_genie'))
                  .map((option) => {
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
              <input className="input-field mt-1 w-full" value={providerName} onChange={(event) => setProviderName(event.target.value)} placeholder="Production migration AI" />
            </label>
            <label className="text-xs font-semibold text-content-secondary">{migrationProviderGuidance(providerKind).modelLabel}
              <input className="input-field mt-1 w-full" value={providerModel} onChange={(event) => setProviderModel(event.target.value)} />
            </label>
            <label className="text-xs font-semibold text-content-secondary">Credential owner <span className="font-normal text-content-tertiary">(recommended)</span>
              <input className="input-field mt-1 w-full" value={providerCredentialOwner} onChange={(event) => setProviderCredentialOwner(event.target.value)} placeholder="Team or service owner" />
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
            <label className="text-xs font-semibold text-content-secondary">Credential expiration <span className="font-normal text-content-tertiary">{providerAuthMode === 'oauth_access_token' ? '(required, exact)' : '(when applicable)'}</span>
              <input className="input-field mt-1 w-full" type="datetime-local" required={providerAuthMode === 'oauth_access_token'} value={providerCredentialExpiresAt} onChange={(event) => setProviderCredentialExpiresAt(event.target.value)} />
            </label>
            <label className="text-xs font-semibold text-content-secondary">Rotation due <span className="font-normal text-content-tertiary">(recommended)</span>
              <input className="input-field mt-1 w-full" type="date" value={providerRotationDueAt} onChange={(event) => setProviderRotationDueAt(event.target.value)} />
            </label>
            <label className="text-xs font-semibold text-content-secondary sm:col-span-2">{selectedProviderGuidance.baseUrlLabel} {FIXED_API_PROVIDER_BASE_URLS[providerKind] && <span className="font-normal text-content-tertiary">(fixed documented endpoint)</span>}
              <input className="input-field mt-1 w-full" value={providerBaseUrl} onChange={(event) => setProviderBaseUrl(event.target.value)} placeholder="https://..." readOnly={Boolean(FIXED_API_PROVIDER_BASE_URLS[providerKind])} />
            </label>
            <label className="text-xs font-semibold text-content-secondary">{selectedAuthSetup.credentialLabel}
              <input className="input-field mt-1 w-full" type="password" autoComplete="new-password" value={providerCredential} onChange={(event) => setProviderCredential(event.target.value)} placeholder={editingProviderId ? 'Leave blank to keep saved credential' : selectedAuthSetup.credentialPlaceholder} />
            </label>
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
                {busy === 'save-provider' ? <Loader2 size={15} className="animate-spin" /> : <KeyRound size={15} />} {editingProviderId ? 'Update and test' : 'Save and test'}
              </button>
            </div>
          </div>
          </section>
        </div>
      )}

      {sourceMode === 'api' && showConnectionForm && (
        <div className="border-t border-border pt-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-content-primary">{editingConnectionId ? 'Edit saved API source' : 'Add saved API source'}</div>
              <div className="text-xs text-content-secondary">Credentials remain server-side in the encrypted local vault.</div>
            </div>
            <button type="button" className="icon-btn" title="Close source form" onClick={() => { resetConnectionForm(); setShowConnectionForm(false); }}><X size={14} /></button>
          </div>
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
            <label className="text-xs font-semibold text-content-secondary">Source platform
              <div className="mt-1">
                <ComboBox
                  ariaLabel="Source platform"
                  value={sourcePlatform}
                  disabled={Boolean(editingConnectionId)}
                  onChange={(value) => {
                    const next = value as SavedApiSourcePlatform;
                    setSourcePlatform(next);
                    setConnectionBaseUrl('');
                    setConnectionCredential('');
                    setSourceClientId('');
                    setSourceAccountIdentifier('');
                    setSourceUsername('');
                    setSourceSiteId('');
                    setSourceWorkspaceId('');
                    setSourceCredentialExpiresAt('');
                    setPowerBiAuthMode('oauth_client_credentials');
                    setDomoOAuthEnabled(false);
                    setDomoProductApiToken('');
                    setRemoveDomoOAuthClient(false);
                    setRemoveDomoProductApiToken(false);
                    setSourceProjectId('');
                  }}
                  options={API_SOURCE_OPTIONS.map((option) => ({ value: option.id, label: option.label }))}
                  placeholder="Choose a source platform"
                  allowFreeText={false}
                />
                {editingConnectionId && <div className="mt-1 text-[11px] font-normal text-content-tertiary">The platform is immutable. Create a new source to change vendors.</div>}
              </div>
            </label>
            <label className="text-xs font-semibold text-content-secondary">Connection name
              <input className="input-field mt-1 w-full" value={connectionName} onChange={(event) => setConnectionName(event.target.value)} />
            </label>
            <label className="text-xs font-semibold text-content-secondary">{sourcePlatform === 'domo' ? 'Domo instance URL' : `${platformLabel(sourcePlatform)} base URL`}
              <input className="input-field mt-1 w-full" value={connectionBaseUrl} onChange={(event) => setConnectionBaseUrl(event.target.value)} placeholder={sourcePlatform === 'domo' ? 'https://company.domo.com' : sourcePlatform === 'looker' ? 'https://company.looker.com' : sourcePlatform === 'sigma' ? 'https://api.sigmacomputing.com' : sourcePlatform === 'metabase' ? 'https://metabase.company.com' : sourcePlatform === 'tableau' ? 'https://tableau.company.com' : sourcePlatform === 'power_bi' ? 'https://api.fabric.microsoft.com' : 'https://strategy.company.com/MicroStrategyLibrary/api'} />
            </label>
            {(sourcePlatform === 'looker' || sourcePlatform === 'sigma') && (
              <>
                <label className="text-xs font-semibold text-content-secondary">{platformLabel(sourcePlatform)} API client ID
                  <input className="input-field mt-1 w-full" value={sourceClientId} onChange={(event) => setSourceClientId(event.target.value)} autoComplete="off" />
                </label>
                <label className="text-xs font-semibold text-content-secondary">{platformLabel(sourcePlatform)} API client secret
                  <input className="input-field mt-1 w-full" type="password" autoComplete="new-password" value={connectionCredential} onChange={(event) => setConnectionCredential(event.target.value)} />
                  <span className="mt-1 block text-[11px] font-normal text-content-tertiary">OmniKit exchanges this documented client credential server-side for a short-lived API token.</span>
                </label>
              </>
            )}
            {sourcePlatform === 'metabase' && (
              <label className="text-xs font-semibold text-content-secondary">Metabase API key
                <input className="input-field mt-1 w-full" type="password" autoComplete="new-password" value={connectionCredential} onChange={(event) => setConnectionCredential(event.target.value)} />
                <span className="mt-1 block text-[11px] font-normal text-content-tertiary">Use a server-side API key scoped to the content this migration may inventory.</span>
              </label>
            )}
            {sourcePlatform === 'looker' && (
              <label className="text-xs font-semibold text-content-secondary">LookML project ID <span className="font-normal text-content-tertiary">(optional)</span>
                <input className="input-field mt-1 w-full" value={sourceProjectId} onChange={(event) => setSourceProjectId(event.target.value)} />
              </label>
            )}
            {sourcePlatform === 'domo' && (
              <>
                <label className="text-xs font-semibold text-content-secondary md:col-span-2 lg:col-span-4">Product API developer token <span className="font-normal text-content-tertiary">(recommended)</span>
                  <input className="input-field mt-1 w-full" type="password" autoComplete="new-password" value={domoProductApiToken} onChange={(event) => setDomoProductApiToken(event.target.value)} placeholder="Domo developer token" />
                  <span className="mt-1 block text-[11px] font-normal text-content-tertiary">This token inherits its Domo user's permissions. It stays encrypted and is sent only by the local server to this Domo tenant.</span>
                </label>
                <label className="flex items-start gap-2 text-xs font-semibold text-content-secondary md:col-span-2 lg:col-span-4">
                  <input type="checkbox" checked={domoOAuthEnabled} onChange={(event) => setDomoOAuthEnabled(event.target.checked)} />
                  Add Platform OAuth client credentials for documented Chart Card and PDP definitions
                </label>
                {domoOAuthEnabled && <>
                  <label className="text-xs font-semibold text-content-secondary">Domo OAuth client ID<input className="input-field mt-1 w-full" value={sourceClientId} onChange={(event) => setSourceClientId(event.target.value)} /></label>
                  <label className="text-xs font-semibold text-content-secondary">Domo OAuth client secret<input className="input-field mt-1 w-full" type="password" autoComplete="new-password" value={connectionCredential} onChange={(event) => setConnectionCredential(event.target.value)} /></label>
                </>}
                {editingConnection && (editingConnection.hasProductApiToken || editingConnection.hasPlatformOAuthClient) && (
                  <div className="grid gap-2 md:col-span-2 lg:col-span-4">
                    {editingConnection.hasProductApiToken && (
                      <label className="flex items-start gap-2 text-xs font-semibold text-red-800">
                        <input type="checkbox" checked={removeDomoProductApiToken} onChange={(event) => setRemoveDomoProductApiToken(event.target.checked)} />
                        Remove the saved Product API developer token when updating
                      </label>
                    )}
                    {editingConnection.hasPlatformOAuthClient && (
                      <label className="flex items-start gap-2 text-xs font-semibold text-red-800">
                        <input type="checkbox" checked={removeDomoOAuthClient} onChange={(event) => { setRemoveDomoOAuthClient(event.target.checked); if (event.target.checked) setDomoOAuthEnabled(false); }} />
                        Remove the saved Platform OAuth client ID and secret when updating
                      </label>
                    )}
                    <div className="text-[11px] text-content-tertiary">At least one documented Domo credential family must remain. Removing a family invalidates the prior validation revision.</div>
                  </div>
                )}
              </>
            )}
            {sourcePlatform === 'tableau' && <>
              <label className="text-xs font-semibold text-content-secondary">PAT name<input className="input-field mt-1 w-full" value={sourceClientId} onChange={(event) => setSourceClientId(event.target.value)} /></label>
              <label className="text-xs font-semibold text-content-secondary">PAT secret<input className="input-field mt-1 w-full" type="password" autoComplete="new-password" value={connectionCredential} onChange={(event) => setConnectionCredential(event.target.value)} /></label>
              <label className="text-xs font-semibold text-content-secondary">Site content URL<input className="input-field mt-1 w-full" value={sourceSiteId} onChange={(event) => setSourceSiteId(event.target.value)} placeholder="site-content-url" /></label>
            </>}
            {sourcePlatform === 'power_bi' && <>
              <label className="text-xs font-semibold text-content-secondary">Microsoft authentication
                <select className="input-field mt-1 w-full" value={powerBiAuthMode} onChange={(event) => { setPowerBiAuthMode(event.target.value as typeof powerBiAuthMode); setConnectionCredential(''); setSourceCredentialExpiresAt(''); }}>
                  <option value="oauth_client_credentials">Entra service principal</option>
                  <option value="oauth_access_token">Delegated OAuth access token</option>
                </select>
              </label>
              {powerBiAuthMode === 'oauth_client_credentials' ? <>
                <label className="text-xs font-semibold text-content-secondary">Microsoft Entra tenant ID<input className="input-field mt-1 w-full" value={sourceAccountIdentifier} onChange={(event) => setSourceAccountIdentifier(event.target.value)} /></label>
                <label className="text-xs font-semibold text-content-secondary">Client ID<input className="input-field mt-1 w-full" value={sourceClientId} onChange={(event) => setSourceClientId(event.target.value)} /></label>
                <label className="text-xs font-semibold text-content-secondary">Client secret<input className="input-field mt-1 w-full" type="password" autoComplete="new-password" value={connectionCredential} onChange={(event) => setConnectionCredential(event.target.value)} /></label>
              </> : <>
                <label className="text-xs font-semibold text-content-secondary">OAuth access token<input className="input-field mt-1 w-full" type="password" autoComplete="new-password" value={connectionCredential} onChange={(event) => setConnectionCredential(event.target.value)} /></label>
                <label className="text-xs font-semibold text-content-secondary">Token expires<input className="input-field mt-1 w-full" type="datetime-local" value={sourceCredentialExpiresAt} onChange={(event) => setSourceCredentialExpiresAt(event.target.value)} /></label>
                <div className="self-end text-[11px] text-content-tertiary">Delegated tokens are short-lived. Rotate and retest before the saved expiration.</div>
              </>}
              <label className="text-xs font-semibold text-content-secondary">Fabric workspace ID<input className="input-field mt-1 w-full" value={sourceWorkspaceId} onChange={(event) => setSourceWorkspaceId(event.target.value)} /></label>
            </>}
            {sourcePlatform === 'microstrategy' && <>
              <label className="text-xs font-semibold text-content-secondary">Username<input className="input-field mt-1 w-full" value={sourceUsername} onChange={(event) => setSourceUsername(event.target.value)} autoComplete="username" /></label>
              <label className="text-xs font-semibold text-content-secondary">Password<input className="input-field mt-1 w-full" type="password" value={connectionCredential} onChange={(event) => setConnectionCredential(event.target.value)} autoComplete="new-password" /></label>
              <label className="text-xs font-semibold text-content-secondary">Project ID<input className="input-field mt-1 w-full" value={sourceProjectId} onChange={(event) => setSourceProjectId(event.target.value)} /></label>
            </>}
          </div>
          <div className="mt-3 flex items-center justify-between gap-3">
            <p className="text-xs text-content-secondary">{API_SOURCE_OPTIONS.find((option) => option.id === sourcePlatform)?.description}</p>
            <div className="flex shrink-0 gap-2">
              <button type="button" className="btn-secondary" onClick={() => { resetConnectionForm(); setShowConnectionForm(false); }}>Cancel</button>
              <button type="button" className="btn-primary" onClick={() => void handleSaveConnection()} disabled={busy === 'save-connection'}>
                {busy === 'save-connection' ? <Loader2 size={15} className="animate-spin" /> : <Database size={15} />} {editingConnectionId ? 'Update source' : 'Save source'}
              </button>
            </div>
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
                <button type="button" className="btn-secondary" onClick={() => void handleTestProvider(selectedProvider.id)} disabled={Boolean(providerAuthenticationIssue(selectedProvider)) || busy === `test-provider-${selectedProvider.id}`}>Test</button>
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
            <div className={`flex items-center justify-between gap-3 rounded-card border p-3 ${savedApiConnectionIssue(selectedConnection) ? 'border-amber-200 bg-amber-50' : 'border-border'}`}>
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-content-primary">{selectedConnection.name}</div>
                <div className="truncate text-xs text-content-secondary">
                  {platformLabel(selectedConnection.platform)}
                  {` · ${savedApiCredentialLabel(selectedConnection)}`}
                  {' · Encrypted'}
                </div>
                {savedApiConnectionIssue(selectedConnection) && (
                  <div className="mt-1 max-w-xl text-[11px] text-amber-900">{savedApiConnectionIssue(selectedConnection)}</div>
                )}
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => void handleLoadInventory(selectedConnection.id)}
                  disabled={Boolean(savedApiConnectionIssue(selectedConnection)) || busy === `inventory-${selectedConnection.id}`}
                  title={savedApiConnectionIssue(selectedConnection) || 'Load source inventory'}
                >
                  Load inventory
                </button>
                <button type="button" className="icon-btn" title="Edit or rotate source credentials" onClick={() => startEditConnection(selectedConnection)}><Pencil size={14} /></button>
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
        <div className={`rounded-card border p-3 text-sm ${inventory.collection?.complete === false ? 'border-amber-200 bg-amber-50 text-amber-950' : 'border-blue-200 bg-blue-50 text-blue-900'}`}>
          <div className="flex items-center gap-2 font-semibold"><FileArchive size={15} /> {inventory.items.length} source items {inventory.collection?.complete === false ? 'collected; verification incomplete' : inventory.items.length === 0 ? 'in a verified empty scope' : 'ready to scope'}</div>
          <div className="mt-1 text-xs">{inventory.items.slice(0, 5).map((item) => item.name).join(' · ')}{inventory.items.length > 5 ? ` · +${inventory.items.length - 5} more` : ''}</div>
          <div className="mt-2 text-xs">Semantic definitions: {inventory.connector.capabilities.semanticDefinitions.replace('_', ' ')} · Content definitions: {inventory.connector.capabilities.contentDefinitions.replace('_', ' ')} · Query validation: {queryValidationLabel(inventory.connector.capabilities.queryValidationMode)}</div>
        </div>
      )}

      {error && <div className="rounded-button border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</div>}
      {notice && <div className="rounded-button border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">{notice}</div>}
    </section>
  );
}

import type {
  MigrationBiSourceTool,
  MigrationPlatformAuthMode,
  MigrationSourceEvidenceClass,
} from '../../../src/services/semanticMigration/types';

export type MigrationSourceApiAvailability = 'saved_api' | 'saved_api_with_manual_closure' | 'manual_only';

export interface MigrationSourceAuthPolicy {
  platform: MigrationBiSourceTool;
  label: string;
  availability: MigrationSourceApiAvailability;
  primaryAuthMode: MigrationPlatformAuthMode;
  allowedAuthModes: readonly MigrationPlatformAuthMode[];
  optionalCompanionAuthModes: readonly MigrationPlatformAuthMode[];
  /** Saved long-lived modes that must be exchanged for an ephemeral session/token. */
  serverSideExchangeAuthModes: readonly MigrationPlatformAuthMode[];
  /** Direct access-credential modes that require an explicit vault expiry. */
  credentialExpiryRequiredFor: readonly MigrationPlatformAuthMode[];
  storedPasswordApprovalRequired: boolean;
  evidenceClasses: readonly MigrationSourceEvidenceClass[];
  manualBoundary: readonly string[];
  guidance: string;
}

/**
 * Documented source-acquisition policy. Capability claims remain conservative:
 * inventory/discovery access does not imply authoritative migration evidence,
 * and manual closure remains explicit wherever vendor APIs are incomplete.
 */
export const MIGRATION_SOURCE_AUTH_POLICIES: Readonly<Record<MigrationBiSourceTool, MigrationSourceAuthPolicy>> = {
  domo: {
    platform: 'domo',
    label: 'Domo',
    availability: 'saved_api_with_manual_closure',
    primaryAuthMode: 'product_api_token',
    allowedAuthModes: ['product_api_token', 'oauth_client_credentials'],
    optionalCompanionAuthModes: ['oauth_client_credentials'],
    serverSideExchangeAuthModes: ['oauth_client_credentials'],
    credentialExpiryRequiredFor: [],
    storedPasswordApprovalRequired: false,
    evidenceClasses: ['authoritative_definition', 'discovery_metadata', 'governance_evidence', 'manual_required'],
    manualBoundary: [
      'Magic ETL and DataFlow implementation logic without a documented portable definition',
      'App Studio behavior and other undocumented interactive behavior',
      'Card, PDP, DataSet, or Beast Mode evidence unavailable to the configured credential families',
    ],
    guidance: 'Use a Product API developer token for Product evidence and optionally add Platform OAuth client credentials for Card/Page and PDP fidelity.',
  },
  looker: {
    platform: 'looker',
    label: 'Looker',
    availability: 'saved_api_with_manual_closure',
    primaryAuthMode: 'api_client_credentials',
    allowedAuthModes: ['api_client_credentials'],
    optionalCompanionAuthModes: [],
    serverSideExchangeAuthModes: ['api_client_credentials'],
    credentialExpiryRequiredFor: [],
    storedPasswordApprovalRequired: false,
    evidenceClasses: ['compiled_definition', 'discovery_metadata', 'governance_evidence', 'manual_required'],
    manualBoundary: [
      'Raw LookML file contents, includes, refinements, Liquid, manifests, tests, and PDT source SQL',
      'Definitions hidden by source permissions',
    ],
    guidance: 'Use a Looker API client ID and client secret for compiled API evidence; use Git or Manual Files for raw LookML.',
  },
  sigma: {
    platform: 'sigma',
    label: 'Sigma',
    availability: 'saved_api_with_manual_closure',
    primaryAuthMode: 'oauth_client_credentials',
    allowedAuthModes: ['oauth_client_credentials'],
    optionalCompanionAuthModes: [],
    serverSideExchangeAuthModes: ['oauth_client_credentials'],
    credentialExpiryRequiredFor: [],
    storedPasswordApprovalRequired: false,
    evidenceClasses: ['authoritative_definition', 'discovery_metadata', 'governance_evidence', 'manual_required'],
    manualBoundary: [
      'Workbook behavior without a documented portable workbook specification',
      'Unsupported interactions, input tables, writeback, Python elements, and layout fidelity',
    ],
    guidance: 'Exchange a Sigma API client ID and secret server-side, and use the Data Model specification as authoritative model evidence.',
  },
  metabase: {
    platform: 'metabase',
    label: 'Metabase',
    availability: 'saved_api_with_manual_closure',
    primaryAuthMode: 'api_key',
    allowedAuthModes: ['api_key'],
    optionalCompanionAuthModes: [],
    serverSideExchangeAuthModes: [],
    credentialExpiryRequiredFor: [],
    storedPasswordApprovalRequired: false,
    evidenceClasses: ['authoritative_definition', 'discovery_metadata', 'governance_evidence', 'manual_required'],
    manualBoundary: [
      'Serialization unavailable to the installed edition',
      'Unknown or version-unsupported MBQL shapes',
      'Unexposed governance or notification definitions',
    ],
    guidance: 'Use an API key and prefer version-matched serialization export where licensed; preserve unknown MBQL for manual review.',
  },
  tableau: {
    platform: 'tableau',
    label: 'Tableau',
    availability: 'saved_api_with_manual_closure',
    primaryAuthMode: 'personal_access_token',
    allowedAuthModes: ['personal_access_token'],
    optionalCompanionAuthModes: [],
    serverSideExchangeAuthModes: ['personal_access_token'],
    credentialExpiryRequiredFor: [],
    storedPasswordApprovalRequired: false,
    evidenceClasses: ['authoritative_definition', 'discovery_metadata', 'governance_evidence', 'manual_required'],
    manualBoundary: [
      'Workbook or data-source exports denied by site policy or permissions',
      'Virtual-connection policies and unsupported interactive layout behavior',
    ],
    guidance: 'Exchange a PAT name and secret for an ephemeral Tableau session, then retrieve selected definitions without extracts.',
  },
  power_bi: {
    platform: 'power_bi',
    label: 'Power BI / Fabric',
    availability: 'saved_api_with_manual_closure',
    primaryAuthMode: 'oauth_client_credentials',
    allowedAuthModes: ['oauth_client_credentials', 'oauth_access_token'],
    optionalCompanionAuthModes: [],
    serverSideExchangeAuthModes: ['oauth_client_credentials'],
    credentialExpiryRequiredFor: ['oauth_access_token'],
    storedPasswordApprovalRequired: false,
    evidenceClasses: ['authoritative_definition', 'discovery_metadata', 'governance_evidence', 'manual_required'],
    manualBoundary: [
      'Definitions blocked by permissions, sensitivity labels, or unsupported model/report types',
      'Report rendering, interactions, custom visuals, bookmarks, and formatting not proven solely by a retrieved PBIR definition',
      'Power BI governance calls when a separately audience-bound Power BI REST token is unavailable',
    ],
    guidance: 'Use a Fabric API-audience delegated token for Fabric definitions, or service-principal credentials to exchange Fabric and Power BI REST audiences separately. Use PBIP/PBIX Manual Files when retrieval is incomplete.',
  },
  microstrategy: {
    platform: 'microstrategy',
    label: 'Strategy',
    availability: 'saved_api_with_manual_closure',
    primaryAuthMode: 'username_password_session',
    allowedAuthModes: ['username_password_session'],
    optionalCompanionAuthModes: [],
    serverSideExchangeAuthModes: ['username_password_session'],
    credentialExpiryRequiredFor: [],
    storedPasswordApprovalRequired: false,
    evidenceClasses: ['authoritative_definition', 'discovery_metadata', 'governance_evidence', 'manual_required'],
    manualBoundary: [
      'Unsupported authentication modes or server versions',
      'Definitions unavailable through installed Modeling services or assigned privileges',
      'Complete dossier visuals, layout, formatting, interactions, panels, and document behavior beyond the filter, selector, and dataset API projection',
      'Dependencies requiring an official migration package',
    ],
    guidance: 'Create an ephemeral server-side Strategy session and bind every definition request to the selected project; use an official dossier/document package or Manual Files for complete visual and layout fidelity.',
  },
  webfocus: {
    platform: 'webfocus',
    label: 'WebFOCUS',
    availability: 'manual_only',
    primaryAuthMode: 'username_password_session',
    allowedAuthModes: ['username_password_session'],
    optionalCompanionAuthModes: [],
    serverSideExchangeAuthModes: ['username_password_session'],
    credentialExpiryRequiredFor: [],
    storedPasswordApprovalRequired: true,
    evidenceClasses: ['authoritative_definition', 'discovery_metadata', 'governance_evidence', 'manual_required'],
    manualBoundary: [
      'Saved username/password sessions until a separate storage-security approval is recorded',
      'Portal/dashboard behavior without one documented complete definition schema',
      'Repository resources outside the explicitly bounded selected scope',
    ],
    guidance: 'Keep Manual Files or Change Management ZIP as the primary path until stored IBFS session credentials receive explicit security approval.',
  },
};

export function migrationSourceAuthPolicy(platform: MigrationBiSourceTool): MigrationSourceAuthPolicy {
  return MIGRATION_SOURCE_AUTH_POLICIES[platform];
}

export function migrationSourceAuthModeAllowed(
  platform: MigrationBiSourceTool,
  authMode: MigrationPlatformAuthMode,
): boolean {
  return MIGRATION_SOURCE_AUTH_POLICIES[platform].allowedAuthModes.includes(authMode);
}

export function migrationSourceAuthNeedsServerExchange(
  platform: MigrationBiSourceTool,
  authMode: MigrationPlatformAuthMode,
): boolean {
  return MIGRATION_SOURCE_AUTH_POLICIES[platform].serverSideExchangeAuthModes.includes(authMode);
}

export function migrationSourceAuthNeedsExpiry(
  platform: MigrationBiSourceTool,
  authMode: MigrationPlatformAuthMode,
): boolean {
  return MIGRATION_SOURCE_AUTH_POLICIES[platform].credentialExpiryRequiredFor.includes(authMode);
}

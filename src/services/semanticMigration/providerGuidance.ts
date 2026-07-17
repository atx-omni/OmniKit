import type { MigrationProviderKind } from './types';

export type MigrationProviderAuthMode =
  | 'linked_omni_instance'
  | 'api_key'
  | 'programmatic_access_token'
  | 'oauth_access_token'
  | 'personal_access_token'
  | 'key_pair_jwt';

export interface MigrationProviderAuthOption {
  id: MigrationProviderAuthMode;
  label: string;
  description: string;
}

export interface MigrationProviderAuthSetup {
  credentialLabel: string;
  credentialPlaceholder: string;
  storedValueDescription: string;
  setupSteps: string[];
  documentation: Array<{ label: string; url: string }>;
}

export interface MigrationProviderGuidance {
  id: MigrationProviderKind;
  label: string;
  description: string;
  credentialLabel: string;
  modelLabel: string;
  baseUrlLabel: string;
  defaultModel: string;
  defaultBaseUrl: string;
  defaultAuthMode: MigrationProviderAuthMode;
  authOptions: MigrationProviderAuthOption[];
  authSetup: Partial<Record<MigrationProviderAuthMode, MigrationProviderAuthSetup>>;
  prerequisites: string[];
  setupSteps: string[];
  securityNotes: string[];
  documentation: Array<{ label: string; url: string }>;
}

const API_KEY: MigrationProviderAuthOption = {
  id: 'api_key',
  label: 'API key',
  description: 'A provider-issued secret sent only by the local OmniKit server.',
};

const OAUTH_TOKEN: MigrationProviderAuthOption = {
  id: 'oauth_access_token',
  label: 'OAuth access token',
  description: 'A short-lived bearer token. Record its expiration and replace it before it expires.',
};

const PERSONAL_TOKEN: MigrationProviderAuthOption = {
  id: 'personal_access_token',
  label: 'Personal access token',
  description: 'A workspace token suitable for development when OAuth is unavailable.',
};

export const MIGRATION_PROVIDER_GUIDANCE: Record<MigrationProviderKind, MigrationProviderGuidance> = {
  openai: {
    id: 'openai',
    label: 'OpenAI',
    description: 'Generate typed semantic and dashboard migration proposals with Structured Outputs.',
    credentialLabel: 'Project API key',
    modelLabel: 'OpenAI model ID',
    baseUrlLabel: 'OpenAI API base URL',
    defaultModel: 'gpt-5.1',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultAuthMode: 'api_key',
    authOptions: [API_KEY],
    authSetup: {
      api_key: {
        credentialLabel: 'Project API key',
        credentialPlaceholder: 'Paste the project key shown once by OpenAI',
        storedValueDescription: 'OmniKit encrypts the project API key. It does not store your OpenAI password, ChatGPT session, or billing credentials.',
        setupSteps: [
          'Open the OpenAI Platform and select or create the project that will own migration usage.',
          'For shared automation, open Organization settings > Project > Members and create a project service account. For attended use, open the project API Keys page and create a project-scoped secret key.',
          'Review the new key permissions, then copy the secret when it is displayed. OpenAI does not show the complete value again.',
          'Paste only that project API key into OmniKit, choose a model available to the project, and record the credential owner and rotation date.',
          'Save the profile and run Test. Configure project budgets and usage limits in OpenAI before migration work begins.',
        ],
        documentation: [
          { label: 'Open the OpenAI API Keys page', url: 'https://platform.openai.com/api-keys' },
          { label: 'Create and manage project API keys', url: 'https://help.openai.com/en/articles/9186755-managing-projects-in-the-api-platform' },
          { label: 'OpenAI API quickstart', url: 'https://developers.openai.com/api/docs/quickstart' },
        ],
      },
    },
    prerequisites: ['An OpenAI API organization and project', 'Project billing and model access', 'Project owner access to create a key or service account'],
    setupSteps: [
      'Open the OpenAI Platform and select or create the project that will own migration usage.',
      'For shared automation, create a project service account; otherwise create a project-scoped API key.',
      'Copy the key when it is displayed. OpenAI does not show the complete secret again.',
      'Paste the key into OmniKit, choose an allowed model, save the profile, and run Test.',
      'Set project budgets and usage limits in OpenAI, then record an owner and rotation date here.',
    ],
    securityNotes: ['Do not use a personal ChatGPT credential.', 'Keep the key project-scoped and server-side.', 'Revoke and replace the key immediately if it is exposed.'],
    documentation: [
      { label: 'OpenAI API quickstart', url: 'https://developers.openai.com/api/docs/quickstart' },
      { label: 'Projects, API keys, and service accounts', url: 'https://help.openai.com/en/articles/9186755-managing-projects-in-the-api-platform' },
    ],
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    description: 'Generate typed migration proposals with Claude tool output.',
    credentialLabel: 'Anthropic API key',
    modelLabel: 'Claude model ID',
    baseUrlLabel: 'Anthropic API base URL',
    defaultModel: 'claude-sonnet-4-5',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    defaultAuthMode: 'api_key',
    authOptions: [API_KEY],
    authSetup: {
      api_key: {
        credentialLabel: 'Claude workspace API key',
        credentialPlaceholder: 'Paste the workspace API key shown by Claude Console',
        storedValueDescription: 'OmniKit encrypts the workspace API key. Use a standard Claude API key, not an Admin API key or a Claude login/session credential.',
        setupSteps: [
          'Sign in to Claude Console and select the workspace that should own migration usage.',
          'Confirm that you have Workspace Limited Developer, Developer, or Admin access and that API billing is active.',
          'Open Settings > API keys, create a descriptively named workspace key, choose its expiration, and copy the value when it is displayed.',
          'Paste only that Claude API key into OmniKit, select a model available to the workspace, and record the owner and expiration date.',
          'Save the profile and run Test. Review workspace limits and replace the key before it expires.',
        ],
        documentation: [
          { label: 'Open Claude Console API Keys', url: 'https://platform.claude.com/settings/keys' },
          { label: 'Create a Claude API key', url: 'https://platform.claude.com/docs/en/manage-claude/authentication' },
          { label: 'Workspace API-key scope and roles', url: 'https://platform.claude.com/docs/en/manage-claude/workspaces' },
        ],
      },
    },
    prerequisites: ['A Claude Console organization and workspace', 'Limited Developer, Developer, or Admin access to manage workspace API keys', 'API billing or usage credits'],
    setupSteps: [
      'Sign in to the Claude Console and select the workspace that should own migration usage.',
      'Confirm your workspace role can manage API keys and that billing is active.',
      'Open the workspace API Keys tab, create a descriptively named key, choose an expiration, and copy it when it is displayed.',
      'Paste the key into OmniKit, select a Claude model available to the workspace, save, and run Test.',
      'Review usage by workspace and API key, and replace the key on your organization rotation schedule.',
    ],
    securityNotes: ['Use a dedicated workspace/key for migration usage where possible.', 'Do not paste the key into prompts or source files.', 'Disable or delete the key in Claude Console when it is no longer needed.'],
    documentation: [
      { label: 'Claude API authentication', url: 'https://platform.claude.com/docs/en/manage-claude/authentication' },
      { label: 'Claude Console workspaces and API keys', url: 'https://platform.claude.com/docs/en/manage-claude/workspaces' },
      { label: 'Claude Console roles and permissions', url: 'https://support.claude.com/en/articles/10186004-claude-console-roles-and-permissions' },
    ],
  },
  snowflake_cortex: {
    id: 'snowflake_cortex',
    label: 'Snowflake Cortex',
    description: 'Use Cortex REST inference with your Snowflake governance boundary and credits.',
    credentialLabel: 'Snowflake bearer token',
    modelLabel: 'Cortex model name',
    baseUrlLabel: 'Snowflake account URL',
    defaultModel: 'claude-sonnet-4-5',
    defaultBaseUrl: '',
    defaultAuthMode: 'programmatic_access_token',
    authOptions: [
      { id: 'programmatic_access_token', label: 'Programmatic access token (recommended setup)', description: 'A Snowflake PAT restricted to a dedicated user/role and expiration.' },
      OAUTH_TOKEN,
      { id: 'key_pair_jwt', label: 'Key-pair JWT', description: 'A short-lived JWT generated from a protected Snowflake key pair.' },
    ],
    authSetup: {
      programmatic_access_token: {
        credentialLabel: 'Snowflake programmatic access token',
        credentialPlaceholder: 'Paste the PAT secret copied or downloaded from Snowsight',
        storedValueDescription: 'OmniKit encrypts the generated PAT secret. It does not store the Snowflake user password.',
        setupSteps: [
          'Ask a Snowflake administrator to create or select a dedicated service identity and least-privilege role.',
          'Grant the role SNOWFLAKE.CORTEX_REST_API_USER and assign that role to the identity.',
          'In Snowsight, open Admin > Users & Roles, select the identity, then under Programmatic access tokens choose Generate new token.',
          'Name the token, set an expiration, restrict it to the dedicated role, generate it, and copy or download the one-time secret.',
          'Paste that PAT secret into OmniKit, enter the Snowflake account origin and Cortex model, record the expiration, save, and run Test.',
        ],
        documentation: [
          { label: 'Generate a Snowflake PAT', url: 'https://docs.snowflake.com/en/user-guide/programmatic-access-tokens' },
          { label: 'Cortex REST API requirements', url: 'https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-rest-api' },
        ],
      },
      oauth_access_token: {
        credentialLabel: 'Snowflake OAuth access token',
        credentialPlaceholder: 'Paste the generated access_token value',
        storedValueDescription: 'OmniKit encrypts only the short-lived OAuth access token. It does not store an OAuth client secret or refresh token and cannot renew the token.',
        setupSteps: [
          'Have a Snowflake administrator configure an approved Snowflake OAuth or External OAuth security integration and least-privilege role.',
          'Complete your organization-approved OAuth authorization flow outside OmniKit.',
          'Copy only the generated access_token value. Do not paste the OAuth client secret or refresh token into OmniKit.',
          'Enter the Snowflake account origin and Cortex model, paste the access token, and record its exact expiration.',
          'Save and run Test. Generate and save a replacement access token whenever the current token expires.',
        ],
        documentation: [
          { label: 'Set up Snowflake OAuth and obtain a token', url: 'https://docs.snowflake.com/en/user-guide/oauth-intro' },
          { label: 'Use OAuth with Snowflake REST APIs', url: 'https://docs.snowflake.com/en/developer-guide/snowflake-rest-api/authentication' },
          { label: 'Cortex REST API requirements', url: 'https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-rest-api' },
        ],
      },
      key_pair_jwt: {
        credentialLabel: 'Generated Snowflake key-pair JWT',
        credentialPlaceholder: 'Paste a freshly generated JWT, never the private key',
        storedValueDescription: 'OmniKit encrypts only the signed, short-lived JWT. The private key and its passphrase must remain in your approved key-management system.',
        setupSteps: [
          'Create a dedicated Snowflake identity and least-privilege role with SNOWFLAKE.CORTEX_REST_API_USER.',
          'Generate a protected key pair outside OmniKit, retain the private key securely, and assign only the public key to the Snowflake identity.',
          'Generate a short-lived Snowflake JWT with an approved client or the Snowflake CLI. Never paste the private key or passphrase into OmniKit.',
          'Paste only the generated JWT into OmniKit, enter the Snowflake account origin and Cortex model, and record its expiration.',
          'Save and run Test. Generate and save a fresh JWT whenever the current value expires.',
        ],
        documentation: [
          { label: 'Configure Snowflake key-pair authentication', url: 'https://docs.snowflake.com/en/user-guide/key-pair-auth' },
          { label: 'Generate and use a JWT with Snowflake APIs', url: 'https://docs.snowflake.com/en/developer-guide/sql-api/authenticating' },
          { label: 'Cortex REST API requirements', url: 'https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-rest-api' },
        ],
      },
    },
    prerequisites: ['Snowflake account URL', 'Dedicated user or service identity', 'A default role with SNOWFLAKE.CORTEX_REST_API_USER or CORTEX_USER', 'A model available in the account region'],
    setupSteps: [
      'Ask a Snowflake administrator to create or select a dedicated identity and least-privilege default role.',
      'Grant the role access to SNOWFLAKE.CORTEX_REST_API_USER, or document why broader CORTEX_USER is required.',
      'Generate a PAT in Snowsight, or obtain a current OAuth/JWT bearer token through your approved identity flow.',
      'Enter the account origin, for example https://account-identifier.snowflakecomputing.com, and an available Cortex model.',
      'Save the token in OmniKit, record its expiration, and run Test before using it in a migration.',
    ],
    securityNotes: ['Prefer a dedicated service identity and role-restricted PAT.', 'OAuth/JWT values are short lived; OmniKit does not retain refresh credentials.', 'A PAT should have an explicit expiration and network/authentication policy.'],
    documentation: [
      { label: 'Cortex REST API', url: 'https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-rest-api' },
      { label: 'Programmatic access tokens', url: 'https://docs.snowflake.com/en/user-guide/programmatic-access-tokens' },
      { label: 'Snowflake REST API authentication', url: 'https://docs.snowflake.com/en/developer-guide/snowflake-rest-api/authentication' },
    ],
  },
  databricks_genie: {
    id: 'databricks_genie',
    label: 'Databricks Genie',
    description: 'Generate validation SQL, evaluate reconciliation, and explain exceptions through a curated Genie Space.',
    credentialLabel: 'Databricks bearer token',
    modelLabel: 'Genie Agent / Space ID',
    baseUrlLabel: 'Databricks workspace URL',
    defaultModel: 'genie-space-id',
    defaultBaseUrl: '',
    defaultAuthMode: 'oauth_access_token',
    authOptions: [OAUTH_TOKEN, PERSONAL_TOKEN],
    authSetup: {
      oauth_access_token: {
        credentialLabel: 'Databricks OAuth access token',
        credentialPlaceholder: 'Paste the generated access_token value',
        storedValueDescription: 'OmniKit encrypts only the short-lived OAuth access token. It does not store the service-principal client secret and cannot refresh the token.',
        setupSteps: [
          'Select a curated Genie Agent and grant a service principal CAN USE access to the agent and its backing SQL warehouse.',
          'Create an OAuth secret for that service principal and keep the client secret in your approved secret manager, not OmniKit.',
          'Use the documented workspace-level OAuth M2M token endpoint to exchange the client ID and secret for an access token.',
          'Copy only the access_token value, then enter the workspace origin and Genie Agent ID (formerly Space ID) in OmniKit.',
          'Paste the access token, record its expiration, save, and run Test. Obtain a new token after the current one expires.',
        ],
        documentation: [
          { label: 'Generate a Databricks OAuth M2M token', url: 'https://docs.databricks.com/aws/en/dev-tools/auth/oauth-m2m' },
          { label: 'Configure and call Genie Agents', url: 'https://docs.databricks.com/aws/en/genie-agents/conversation-api' },
        ],
      },
      personal_access_token: {
        credentialLabel: 'Databricks personal access token',
        credentialPlaceholder: 'Paste the generated workspace PAT',
        storedValueDescription: 'OmniKit encrypts the generated workspace PAT. PATs are intended for development here; use OAuth for production automation.',
        setupSteps: [
          'Select a curated Genie Agent and confirm your Databricks user can use the agent and its backing SQL warehouse.',
          'In the workspace, open your user menu > Settings > Developer > Access tokens > Manage.',
          'Choose Generate new token, enter a descriptive name, set a short lifetime, and select the API scopes required by the Genie API.',
          'Copy the generated PAT, then enter the workspace origin and Genie Agent ID (formerly Space ID) in OmniKit.',
          'Paste the PAT, record its expiration, save, and run Test. Revoke it when local development is complete.',
        ],
        documentation: [
          { label: 'Create a Databricks personal access token', url: 'https://docs.databricks.com/aws/en/dev-tools/auth/pat' },
          { label: 'Configure and call Genie Agents', url: 'https://docs.databricks.com/aws/en/genie-agents/conversation-api' },
        ],
      },
    },
    prerequisites: ['Databricks workspace URL', 'A curated Genie Agent ID (formerly Space ID)', 'CAN USE access to the Genie Agent and backing SQL warehouse', 'OAuth or PAT permission for the selected identity'],
    setupSteps: [
      'Open the target Databricks workspace and select the curated Genie Agent used for validation.',
      'Copy the Agent ID (the former Space ID) from its URL or API response and confirm the identity can use the backing SQL warehouse.',
      'For production automation, obtain a short-lived OAuth M2M token for a service principal. Use U2M for attended access.',
      'If OAuth cannot be used for local development, create a short-lived workspace PAT and record its expiration.',
      'Enter the workspace origin and Space ID, save the bearer token in OmniKit, and run Test.',
    ],
    securityNotes: ['Genie is validation-only in this workflow; it does not generate Omni migration packages.', 'Databricks recommends OAuth instead of PATs when supported.', 'Use a curated space rather than broad warehouse access.'],
    documentation: [
      { label: 'Genie Agents conversation API', url: 'https://docs.databricks.com/aws/en/genie-agents/conversation-api' },
      { label: 'OAuth for service principals', url: 'https://docs.databricks.com/aws/en/dev-tools/auth/oauth-m2m' },
      { label: 'Personal access tokens (legacy)', url: 'https://docs.databricks.com/aws/en/dev-tools/auth/pat' },
    ],
  },
  omni_ai: {
    id: 'omni_ai',
    label: 'Omni AI',
    description: 'Included default that uses the AI service available to the active saved Omni instance. No separate provider setup or LLM key is required.',
    credentialLabel: 'Linked Omni instance credential',
    modelLabel: 'Default target model ID',
    baseUrlLabel: 'Linked Omni instance',
    defaultModel: 'target-model',
    defaultBaseUrl: '',
    defaultAuthMode: 'linked_omni_instance',
    authOptions: [{ id: 'linked_omni_instance', label: 'Linked Omni instance', description: 'Reuse the encrypted Organization API key or PAT from the active saved Omni instance.' }],
    authSetup: {
      linked_omni_instance: {
        credentialLabel: 'Linked saved Omni instance',
        credentialPlaceholder: '',
        storedValueDescription: 'OmniKit stores only the linked saved-instance ID in this provider profile. The Organization API key or PAT remains encrypted once in the saved Omni instance record.',
        setupSteps: [
          'On OmniKit Home, save and validate the Omni instance URL plus its Organization API key or appropriately scoped PAT in the encrypted vault.',
          'Make that saved instance active, then open BI Migration Studio.',
          'OmniKit automatically selects Omni AI and creates a stable provider reference to the active instance. It does not copy or ask for the credential again.',
          'Choose the target model during migration setup. Omni AI uses that selected model rather than a separately configured provider model.',
          'Use another provider only when you intentionally want the migration to consume external model credits.',
        ],
        documentation: [
          { label: 'Create an Omni Organization key or PAT', url: 'https://docs.omni.co/api/authentication' },
          { label: 'Review Omni REST API coverage', url: 'https://docs.omni.co/api' },
        ],
      },
    },
    prerequisites: ['A saved Omni instance in the unlocked vault', 'An Organization API key for automation or an appropriately scoped PAT', 'Access to the target model and Omni AI APIs'],
    setupSteps: [
      'Create and save the Omni instance connection through OmniKit Home, then validate it and make it active.',
      'Open BI Migration Studio. Omni AI appears automatically as the included default.',
      'Choose the target model in the migration workflow; no separate provider model or provider key is required.',
      'Select Use another provider only when OpenAI, Anthropic, Snowflake Cortex, or Databricks should override the default.',
      'Disable or revoke the Omni token in Omni when the integration is retired or compromised.',
    ],
    securityNotes: ['Organization keys inherit the attributes of their creator.', 'The key is displayed once and should be stored only in the encrypted vault.', 'OmniKit never copies the linked credential into the provider record.'],
    documentation: [
      { label: 'Omni API authentication', url: 'https://docs.omni.co/api/authentication' },
      { label: 'Omni REST APIs', url: 'https://docs.omni.co/api' },
    ],
  },
};

export const PUBLIC_MIGRATION_PROVIDER_OPTIONS = Object.values(MIGRATION_PROVIDER_GUIDANCE);

export function migrationProviderGuidance(kind: MigrationProviderKind): MigrationProviderGuidance {
  return MIGRATION_PROVIDER_GUIDANCE[kind];
}

export function migrationProviderAuthSetup(kind: MigrationProviderKind, authMode: MigrationProviderAuthMode): MigrationProviderAuthSetup {
  const guidance = migrationProviderGuidance(kind);
  const supported = guidance.authOptions.some((option) => option.id === authMode);
  const setup = supported ? guidance.authSetup[authMode] : undefined;
  if (!setup) throw new Error(`Missing credential setup guidance for ${kind}/${authMode}.`);
  return setup;
}

export function migrationProviderCredentialState(input: { credentialExpiresAt?: string; rotationDueAt?: string; lastValidationStatus?: 'valid' | 'failed' }): {
  state: 'ready' | 'attention' | 'expired' | 'untested';
  label: string;
} {
  const now = Date.now();
  const expires = input.credentialExpiresAt ? Date.parse(input.credentialExpiresAt) : Number.NaN;
  const rotation = input.rotationDueAt ? Date.parse(input.rotationDueAt) : Number.NaN;
  if (Number.isFinite(expires) && expires <= now) return { state: 'expired', label: 'Credential expired' };
  if (input.lastValidationStatus === 'failed') return { state: 'attention', label: 'Last test failed' };
  const attentionWindow = now + 30 * 24 * 60 * 60 * 1000;
  if ((Number.isFinite(expires) && expires <= attentionWindow) || (Number.isFinite(rotation) && rotation <= attentionWindow)) {
    return { state: 'attention', label: 'Rotation due soon' };
  }
  if (input.lastValidationStatus === 'valid') return { state: 'ready', label: 'Validated' };
  return { state: 'untested', label: 'Not tested' };
}

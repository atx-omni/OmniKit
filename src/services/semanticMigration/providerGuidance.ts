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
    description: 'Use Cortex REST inference with your Snowflake governance boundary and a model that supports JSON-schema output.',
    credentialLabel: 'Snowflake bearer token',
    modelLabel: 'Cortex model name',
    baseUrlLabel: 'Snowflake account URL',
    defaultModel: 'claude-sonnet-4-5',
    defaultBaseUrl: '',
    defaultAuthMode: 'oauth_access_token',
    authOptions: [OAUTH_TOKEN],
    authSetup: {
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
    },
    prerequisites: ['Snowflake account URL', 'Dedicated user or service identity', 'A default role with SNOWFLAKE.CORTEX_REST_API_USER or CORTEX_USER', 'A Cortex model family that supports response_format with json_schema'],
    setupSteps: [
      'Ask a Snowflake administrator to create or select a dedicated identity and least-privilege default role.',
      'Grant the role access to SNOWFLAKE.CORTEX_REST_API_USER, or document why broader CORTEX_USER is required.',
      'Obtain a current OAuth access token through your organization-approved authorization flow.',
      'Enter the account origin, for example https://account-identifier.snowflakecomputing.com, and an available Cortex model.',
      'Save the token in OmniKit, record its expiration, and run Test. OmniKit sends a minimal JSON-schema request so an incompatible model is rejected before migration work begins.',
    ],
    securityNotes: ['Use a dedicated identity and least-privilege Snowflake role.', 'OAuth access tokens are short lived; OmniKit does not retain client secrets or refresh credentials.', 'Record the exact token expiration and replace the token before it expires.', 'Cortex model families differ: only use a profile after its structured-output Test succeeds.'],
    documentation: [
      { label: 'Cortex REST API', url: 'https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-rest-api' },
      { label: 'Snowflake OAuth for local applications', url: 'https://docs.snowflake.com/en/user-guide/oauth-local-applications' },
      { label: 'Snowflake REST API authentication', url: 'https://docs.snowflake.com/en/developer-guide/snowflake-rest-api/authentication' },
    ],
  },
  databricks_model_serving: {
    id: 'databricks_model_serving',
    label: 'Databricks Foundation Model',
    description: 'Generate typed migration proposals through an existing, chat-compatible Databricks Model Serving endpoint.',
    credentialLabel: 'Databricks bearer token',
    modelLabel: 'Serving endpoint name',
    baseUrlLabel: 'Databricks workspace URL',
    defaultModel: 'migration-foundation-model',
    defaultBaseUrl: '',
    defaultAuthMode: 'oauth_access_token',
    authOptions: [OAUTH_TOKEN],
    authSetup: {
      oauth_access_token: {
        credentialLabel: 'Databricks OAuth access token',
        credentialPlaceholder: 'Paste the generated access_token value',
        storedValueDescription: 'OmniKit encrypts only the short-lived OAuth access token. It does not store or refresh the service-principal client secret.',
        setupSteps: [
          'Create or select a Databricks Model Serving endpoint that exposes a chat-compatible foundation model.',
          'Grant a dedicated service principal CAN QUERY permission on that endpoint.',
          'Use the documented Databricks OAuth M2M flow outside OmniKit to obtain a short-lived workspace access token.',
          'Enter the workspace origin and exact serving endpoint name, then paste only the access_token value and record its expiration.',
          'Save the profile and run Test before migration work. Replace the saved access token when it expires.',
        ],
        documentation: [
          { label: 'Databricks OAuth for service principals', url: 'https://docs.databricks.com/aws/en/dev-tools/auth/oauth-m2m' },
          { label: 'Query a model serving endpoint', url: 'https://docs.databricks.com/aws/en/machine-learning/model-serving/score-foundation-models' },
          { label: 'Foundation Model APIs', url: 'https://docs.databricks.com/aws/en/machine-learning/foundation-model-apis/api-reference' },
        ],
      },
    },
    prerequisites: ['Databricks workspace URL', 'An existing Model Serving endpoint', 'CAN QUERY permission on that endpoint', 'A current OAuth access token'],
    setupSteps: [
      'Create or select a chat-compatible Databricks Model Serving endpoint and copy its exact endpoint name.',
      'Grant the migration identity CAN QUERY access to the endpoint.',
      'Obtain a short-lived OAuth access token for the authorized user or service principal.',
      'Enter the workspace origin, endpoint name, credential owner, and token expiration in OmniKit.',
      'Save and run Test. OmniKit verifies the endpoint is READY and runs a minimal structured-output probe; it does not enumerate all workspace endpoints.',
    ],
    securityNotes: ['Use a dedicated least-privilege identity.', 'Only OAuth access tokens are accepted for Databricks providers.', 'OmniKit never stores the service-principal client secret or refresh token.'],
    documentation: [
      { label: 'Databricks Foundation Model APIs', url: 'https://docs.databricks.com/aws/en/machine-learning/foundation-model-apis/api-reference' },
      { label: 'Model Serving endpoint permissions', url: 'https://docs.databricks.com/aws/en/machine-learning/model-serving/manage-serving-endpoints' },
      { label: 'OAuth for service principals', url: 'https://docs.databricks.com/aws/en/dev-tools/auth/oauth-m2m' },
    ],
  },
  databricks_genie: {
    id: 'databricks_genie',
    label: 'Databricks Genie',
    description: 'Generate validation SQL, evaluate reconciliation results, and explain exceptions through one curated Genie Space.',
    credentialLabel: 'Databricks bearer token',
    modelLabel: 'Genie Agent / Space ID',
    baseUrlLabel: 'Databricks workspace URL',
    defaultModel: 'genie-space-id',
    defaultBaseUrl: '',
    defaultAuthMode: 'oauth_access_token',
    authOptions: [OAUTH_TOKEN],
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
    },
    prerequisites: ['Databricks workspace URL', 'One curated Genie Agent ID (formerly Space ID)', 'CAN USE access to the Genie Agent and backing SQL warehouse', 'OAuth permission for the selected identity'],
    setupSteps: [
      'Open the target Databricks workspace and select the curated Genie Agent used for validation.',
      'Copy the Agent ID (the former Space ID) from its URL or API response and confirm the identity can use the backing SQL warehouse.',
      'Obtain a short-lived OAuth M2M token for a service principal, or use your approved U2M flow for attended access.',
      'Enter the workspace origin and immutable Agent/Space ID, save the OAuth access token in OmniKit, and run Test.',
      'OmniKit allows one saved Genie profile. Delete and intentionally replace that profile to target a different Agent/Space ID.',
    ],
    securityNotes: ['Genie is validation-only in this workflow; it does not generate Omni migration packages.', 'Only OAuth access tokens are accepted.', 'One saved profile is bound to one immutable Agent/Space ID; use a curated space rather than broad warehouse access.'],
    documentation: [
      { label: 'Genie Agents conversation API', url: 'https://docs.databricks.com/aws/en/genie-agents/conversation-api' },
      { label: 'OAuth for service principals', url: 'https://docs.databricks.com/aws/en/dev-tools/auth/oauth-m2m' },
    ],
  },
  omni_ai: {
    id: 'omni_ai',
    label: 'Omni AI',
    description: 'Included default that uses the AI service available to the active saved Omni instance. OmniKit validates every returned proposal before it can affect a migration.',
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
          'The provider Test checks that this saved instance link is available. The first governed migration job is the output-contract check because the Agentic Jobs API does not expose caller-defined strict schemas.',
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
    securityNotes: ['Organization keys inherit the attributes of their creator.', 'The key is displayed once and should be stored only in the encrypted vault.', 'OmniKit never copies the linked credential into the provider record.', 'Omni AI output is treated as untrusted until OmniKit validates it against the registered migration contract.'],
    documentation: [
      { label: 'Omni API authentication', url: 'https://docs.omni.co/api/authentication' },
      { label: 'Create an Omni AI job', url: 'https://docs.omni.co/api/ai/create-ai-job' },
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

export function migrationProviderCredentialState(input: { credentialExpiresAt?: string; rotationDueAt?: string; lastValidationStatus?: 'valid' | 'failed'; lastValidatedRevision?: string; updatedAt?: string }): {
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
  if (input.lastValidationStatus === 'valid' && input.lastValidatedRevision && input.lastValidatedRevision === input.updatedAt) {
    return { state: 'ready', label: 'Validated' };
  }
  return { state: 'untested', label: 'Not tested' };
}

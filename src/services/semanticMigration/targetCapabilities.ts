import type { MigrationProviderProfile } from './types';

export type OmniMigrationCapabilityStatus = 'available' | 'unverified' | 'blocked' | 'unavailable';

export interface OmniMigrationTargetModel {
  id: string;
  kind?: string;
  connectionId?: string;
  gitConfigured?: boolean;
  pullRequestRequired?: boolean;
  gitProtected?: boolean;
  gitFollower?: boolean;
}

export interface OmniMigrationCapabilityCheck {
  id: 'model_read' | 'yaml_read' | 'branch_write' | 'yaml_write' | 'model_validation' | 'content_validation' | 'ai_jobs' | 'merge';
  label: string;
  status: OmniMigrationCapabilityStatus;
  summary: string;
  requiredFor: Array<'semantic_stage' | 'dashboard_build' | 'merge'>;
}

export interface OmniMigrationCapabilityReport {
  schemaVersion: 'omnikit.omni-target-capabilities.v1';
  modelId?: string;
  checks: OmniMigrationCapabilityCheck[];
  blockers: string[];
}

export function buildOmniMigrationCapabilityReport(input: {
  model?: OmniMigrationTargetModel | null;
  yamlLoaded?: boolean;
  branchCreated?: boolean;
  yamlWritten?: boolean;
  modelValidationRan?: boolean;
  contentValidationRan?: boolean;
  aiJobSucceeded?: boolean;
  provider?: MigrationProviderProfile | null;
}): OmniMigrationCapabilityReport {
  const model = input.model;
  const kind = String(model?.kind || 'SHARED').toUpperCase();
  const editableModel = Boolean(model?.id && !['SCHEMA'].includes(kind) && !model.gitFollower);
  const aiProviderVerified = input.provider?.kind === 'omni_ai' && input.provider.lastValidationStatus === 'valid';
  const checks: OmniMigrationCapabilityCheck[] = [
    {
      id: 'model_read', label: 'Target model', status: model?.id ? 'available' : 'unavailable',
      summary: model?.id ? 'The selected shared model was returned by Omni.' : 'Select a shared Omni model.', requiredFor: ['semantic_stage', 'dashboard_build', 'merge'],
    },
    {
      id: 'yaml_read', label: 'Read semantic YAML', status: input.yamlLoaded ? 'available' : model?.id ? 'unverified' : 'unavailable',
      summary: input.yamlLoaded ? 'The target YAML and checksums were loaded.' : 'OmniKit will verify YAML read access before planning or staging.', requiredFor: ['semantic_stage'],
    },
    {
      id: 'branch_write', label: 'Create development branch', status: input.branchCreated ? 'available' : editableModel ? 'unverified' : 'blocked',
      summary: input.branchCreated ? 'A development branch was created.' : model?.gitFollower ? 'Git follower models cannot be edited through the YAML API.' : kind === 'SCHEMA' ? 'Schema models cannot be edited through the YAML API.' : 'Verified only when the operator starts reviewed branch staging.', requiredFor: ['semantic_stage'],
    },
    {
      id: 'yaml_write', label: 'Write reviewed YAML', status: input.yamlWritten ? 'available' : editableModel ? 'unverified' : 'blocked',
      summary: input.yamlWritten ? 'Reviewed files were written with branch and checksum protection.' : editableModel ? 'The write remains unverified until the reviewed package is staged.' : 'This model configuration is not writable through the model YAML API.', requiredFor: ['semantic_stage'],
    },
    {
      id: 'model_validation', label: 'Model validation', status: input.modelValidationRan ? 'available' : model?.id ? 'unverified' : 'unavailable',
      summary: input.modelValidationRan ? 'Omni model validation returned a result.' : 'Validation runs after reviewed YAML is staged.', requiredFor: ['semantic_stage'],
    },
    {
      id: 'content_validation', label: 'Content validator', status: input.contentValidationRan ? 'available' : model?.id ? 'unverified' : 'unavailable',
      summary: input.contentValidationRan ? 'The content validator returned a result.' : 'Content reference validation runs after staging.', requiredFor: ['semantic_stage', 'dashboard_build'],
    },
    {
      id: 'ai_jobs', label: 'Omni AI jobs', status: input.aiJobSucceeded || aiProviderVerified ? 'available' : model?.id ? 'unverified' : 'unavailable',
      summary: input.aiJobSucceeded ? 'A dashboard-build AI job completed for this migration.' : aiProviderVerified ? 'The linked Omni AI provider passed its explicit connection test.' : 'OmniKit does not submit a chargeable AI job during read-only preflight. Test Omni AI explicitly or verify it during the first dashboard build.', requiredFor: ['dashboard_build'],
    },
    {
      id: 'merge', label: model?.pullRequestRequired || model?.gitProtected || model?.gitFollower ? 'Pull-request handoff' : 'Direct branch merge',
      status: model?.pullRequestRequired || model?.gitProtected || model?.gitFollower ? 'blocked' : model?.id ? 'unverified' : 'unavailable',
      summary: model?.pullRequestRequired || model?.gitProtected || model?.gitFollower
        ? 'Direct API merge is not the approved path for this model. Complete review through the configured Git pull-request workflow.'
        : 'Merge authority is verified only after human branch review; preflight never performs a test merge.',
      requiredFor: ['merge'],
    },
  ];
  return {
    schemaVersion: 'omnikit.omni-target-capabilities.v1',
    modelId: model?.id,
    checks,
    blockers: checks.filter((check) => check.status === 'unavailable' || check.status === 'blocked').map((check) => `${check.label}: ${check.summary}`),
  };
}

export function omniMigrationCapabilityBlockers(report: OmniMigrationCapabilityReport, operation: 'semantic_stage' | 'dashboard_build' | 'merge'): string[] {
  return report.checks
    .filter((check) => check.requiredFor.includes(operation) && (check.status === 'unavailable' || check.status === 'blocked'))
    .map((check) => check.summary);
}

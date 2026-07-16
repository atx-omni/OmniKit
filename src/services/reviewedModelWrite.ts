import type { ConnectionConfig, OmniModel } from '../types';
import {
  ApiError,
  createModelBranch,
  createOrUpdateModelBranchPullRequest,
  deleteModelBranch,
  getModelGitConfiguration,
  mergeModelBranch,
  validateModel,
  validateModelContent,
  type OmniModelGitConfiguration,
} from './omniApi';

export interface ModelWriteCapability {
  editable: boolean;
  reason?: string;
  gitConfigured: boolean;
  gitConfigurationKnown: boolean;
  gitFollower: boolean;
  pullRequestRequired: boolean;
  webUrl?: string;
  raw?: OmniModelGitConfiguration;
}

export interface ReviewedModelBranch {
  modelId: string;
  branchId: string;
  branchName: string;
  capability: ModelWriteCapability;
}

export interface ReviewedValidation {
  modelIssues: Array<{ message?: string; is_warning?: boolean; yaml_path?: string }>;
  contentResult: Record<string, unknown> | null;
  contentIssueCount: number;
  contentError?: string;
  blocking: boolean;
}

export interface ReviewedPublishResult {
  mode: 'merged' | 'pull_request';
  message: string;
  url?: string;
  postMergeValidation?: ReviewedValidation;
  raw: Record<string, unknown>;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim();
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function countContentValidationIssues(value: unknown): number {
  const root = record(value);
  const content = Array.isArray(root?.content) ? root.content : [];
  let count = 0;
  for (const item of content) {
    const row = record(item);
    if (!row) continue;
    if (Array.isArray(row.dashboard_filter_issues)) count += row.dashboard_filter_issues.length;
    const queries = Array.isArray(row.queries_and_issues) ? row.queries_and_issues : [];
    for (const query of queries) {
      const queryRow = record(query);
      if (Array.isArray(queryRow?.issues)) count += queryRow.issues.length;
    }
  }
  return count;
}

export function isSchemaModel(model: OmniModel): boolean {
  return model.kind?.toUpperCase() === 'SCHEMA';
}

export function isGovernanceEditableModel(model: OmniModel): boolean {
  const kind = model.kind?.toUpperCase();
  return !model.deletedAt && (kind === 'SHARED' || kind === 'SHARED_EXTENSION');
}

export function normalizeModelGitCapability(
  model: OmniModel,
  raw?: OmniModelGitConfiguration,
  known = true,
): ModelWriteCapability {
  if (!isGovernanceEditableModel(model)) {
    return {
      editable: false,
      reason: model.kind?.toUpperCase() === 'SCHEMA'
        ? 'Schema models cannot be edited or branched through the model YAML API.'
        : `${model.kind || 'Unknown'} models are not supported for reviewed governance writes.`,
      gitConfigured: Boolean(raw),
      gitConfigurationKnown: known,
      gitFollower: false,
      pullRequestRequired: false,
      raw,
    };
  }

  const gitFollower = raw?.gitFollower === true || raw?.git_follower === true;
  const requirePullRequest = firstString(raw?.requirePullRequest, raw?.require_pull_request)?.toLowerCase();
  const pullRequestRequired = requirePullRequest === 'always' || requirePullRequest === 'users-only';
  const gitConfigured = Boolean(raw && Object.keys(raw).length > 0);
  return {
    editable: known && !gitFollower,
    reason: !known
      ? 'OmniKit could not verify this model’s git settings, so writes are blocked.'
      : gitFollower
        ? 'Git follower models are read-only. Apply this change to the leader model instead.'
        : undefined,
    gitConfigured,
    gitConfigurationKnown: known,
    gitFollower,
    pullRequestRequired,
    webUrl: firstString(raw?.webUrl, raw?.web_url),
    raw,
  };
}

export async function inspectModelWriteCapability(
  connection: ConnectionConfig,
  model: OmniModel,
): Promise<ModelWriteCapability> {
  if (!isGovernanceEditableModel(model)) return normalizeModelGitCapability(model);
  try {
    const raw = await getModelGitConfiguration(connection.baseUrl, connection.apiKey, model.id);
    return normalizeModelGitCapability(model, raw, true);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return normalizeModelGitCapability(model, undefined, true);
    }
    return normalizeModelGitCapability(model, undefined, false);
  }
}

export async function startReviewedModelBranch(
  connection: ConnectionConfig,
  model: OmniModel,
  branchPrefix: string,
): Promise<ReviewedModelBranch> {
  const capability = await inspectModelWriteCapability(connection, model);
  if (!capability.editable) throw new Error(capability.reason || 'This model is not editable.');
  if (!model.connectionId) throw new Error('This model is missing a connection ID.');
  const branchName = `${branchPrefix}-${Date.now()}`;
  const branch = await createModelBranch(connection.baseUrl, connection.apiKey, {
    connectionId: model.connectionId,
    baseModelId: model.id,
    branchName,
  });
  const branchId = String(branch.id || '');
  if (!branchId) throw new Error('Omni did not return a branch model ID.');
  return {
    modelId: model.id,
    branchId,
    branchName: String(branch.name || branchName),
    capability,
  };
}

export async function validateReviewedModelBranch(
  connection: ConnectionConfig,
  branch: ReviewedModelBranch,
): Promise<ReviewedValidation> {
  const modelIssues = await validateModel(
    connection.baseUrl,
    connection.apiKey,
    branch.modelId,
    branch.branchId,
  ).catch((error) => [{
    message: error instanceof Error ? error.message : 'Branch validation failed.',
    is_warning: false,
  }]);
  let contentResult: Record<string, unknown> | null = null;
  let contentError: string | undefined;
  try {
    contentResult = await validateModelContent(
      connection.baseUrl,
      connection.apiKey,
      branch.modelId,
      { branchId: branch.branchId, includePersonalFolders: true },
    );
  } catch (error) {
    contentError = error instanceof Error ? error.message : 'Content validation failed.';
  }
  const contentIssueCount = countContentValidationIssues(contentResult);
  return {
    modelIssues: Array.isArray(modelIssues) ? modelIssues : [],
    contentResult,
    contentIssueCount,
    contentError,
    blocking: !Array.isArray(modelIssues)
      || modelIssues.some((issue) => issue.is_warning !== true)
      || contentIssueCount > 0
      || Boolean(contentError),
  };
}

export async function publishReviewedModelBranch(
  connection: ConnectionConfig,
  branch: ReviewedModelBranch,
  commitMessage: string,
): Promise<ReviewedPublishResult> {
  if (branch.capability.pullRequestRequired) {
    const raw = await createOrUpdateModelBranchPullRequest(connection.baseUrl, connection.apiKey, {
      modelId: branch.modelId,
      branchId: branch.branchId,
      commitMessage,
      allowBranchExists: true,
      requireBranchExists: true,
    });
    return {
      mode: 'pull_request',
      message: 'The reviewed branch was committed for pull-request review. The shared model is unchanged until that PR is merged.',
      url: firstString(raw.url, raw.webUrl, raw.web_url, raw.pullRequestUrl, raw.pull_request_url, raw.pr_url),
      raw,
    };
  }

  const raw = await mergeModelBranch(connection.baseUrl, connection.apiKey, {
    modelId: branch.modelId,
    branchName: branch.branchName,
    publishDrafts: true,
    deleteBranch: true,
  });
  const postMergeValidation = await validateReviewedModelBranch(connection, {
    ...branch,
    branchId: '',
  });
  return {
    mode: 'merged',
    message: postMergeValidation.blocking
      ? 'The branch merged, but post-publish validation found blockers that need review.'
      : 'The branch merged and post-publish model/content validation completed.',
    postMergeValidation,
    raw,
  };
}

export async function discardReviewedModelBranch(
  connection: ConnectionConfig,
  branch: Pick<ReviewedModelBranch, 'modelId' | 'branchName'>,
) {
  return deleteModelBranch(connection.baseUrl, connection.apiKey, branch.modelId, branch.branchName);
}

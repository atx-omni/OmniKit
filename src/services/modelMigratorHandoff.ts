import type { MigrationJob, SavedInstancePublic } from './opsConsole';

const MAX_HANDOFF_VALUE_LENGTH = 256;
const CANONICAL_JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HANDOFF_KEYS = new Set([
  'version',
  'source',
  'jobId',
  'targetId',
  'sourceInstanceId',
  'sourceConnectionId',
  'targetInstanceId',
  'targetConnectionId',
  'targetModelId',
]);

export interface DashboardSafeCopyModelMigratorHandoff {
  version: 1;
  source: 'dashboard_safe_copy_v1';
  jobId: string;
  targetId: string;
  sourceInstanceId: string;
  sourceConnectionId: string;
  targetInstanceId: string;
  targetConnectionId: string;
  targetModelId: string;
}

export interface ModelMigratorHandoffResolution {
  status: 'ready' | 'invalid';
  handoff?: DashboardSafeCopyModelMigratorHandoff;
  message?: string;
}

function exactString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_HANDOFF_VALUE_LENGTH) return '';
  if (value !== value.trim() || [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  })) return '';
  return value;
}

export function createDashboardSafeCopyModelMigratorHandoff(
  input: Omit<DashboardSafeCopyModelMigratorHandoff, 'version' | 'source'>,
): DashboardSafeCopyModelMigratorHandoff {
  const parsed = parseDashboardSafeCopyModelMigratorHandoff({
    version: 1,
    source: 'dashboard_safe_copy_v1',
    ...input,
  });
  if (!parsed) throw new Error('The Model Migrator repair scope is incomplete or invalid.');
  return parsed;
}

export function parseDashboardSafeCopyModelMigratorHandoff(
  value: unknown,
): DashboardSafeCopyModelMigratorHandoff | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !HANDOFF_KEYS.has(key))) return null;
  if (record.version !== 1 || record.source !== 'dashboard_safe_copy_v1') return null;
  const jobId = exactString(record.jobId);
  const targetId = exactString(record.targetId);
  const sourceInstanceId = exactString(record.sourceInstanceId);
  const sourceConnectionId = exactString(record.sourceConnectionId);
  const targetInstanceId = exactString(record.targetInstanceId);
  const targetConnectionId = exactString(record.targetConnectionId);
  const targetModelId = exactString(record.targetModelId);
  if (
    !CANONICAL_JOB_ID.test(jobId)
    || !targetId
    || !sourceInstanceId
    || !sourceConnectionId
    || !targetInstanceId
    || !targetConnectionId
    || !targetModelId
  ) return null;
  return {
    version: 1,
    source: 'dashboard_safe_copy_v1',
    jobId,
    targetId,
    sourceInstanceId,
    sourceConnectionId,
    targetInstanceId,
    targetConnectionId,
    targetModelId,
  };
}

export function resolveDashboardSafeCopyModelMigratorHandoff(
  value: unknown,
  instances: Array<Pick<SavedInstancePublic, 'id' | 'role'>>,
): ModelMigratorHandoffResolution {
  const handoff = parseDashboardSafeCopyModelMigratorHandoff(value);
  if (!handoff) {
    return { status: 'invalid', message: 'The dashboard repair handoff was invalid and was not applied.' };
  }
  const source = instances.find((instance) => instance.id === handoff.sourceInstanceId);
  const target = instances.find((instance) => instance.id === handoff.targetInstanceId);
  if (!source || !target) {
    return { status: 'invalid', message: 'The dashboard repair instances are no longer available.' };
  }
  if (source.id === target.id) {
    return { status: 'invalid', message: 'The dashboard repair source and destination must be different saved instances.' };
  }
  if (source.role !== 'source' && source.role !== 'both') {
    return { status: 'invalid', message: 'The dashboard repair source is not authorized for source operations.' };
  }
  if (target.role !== 'destination' && target.role !== 'both') {
    return { status: 'invalid', message: 'The dashboard repair target is not authorized for destination operations.' };
  }
  return { status: 'ready', handoff };
}

export function dashboardSafeCopyModelMigratorHandoffMatchesJob(
  handoff: DashboardSafeCopyModelMigratorHandoff,
  job: MigrationJob,
): boolean {
  if (
    job.id !== handoff.jobId
    || job.workflow !== 'dashboard'
    || job.details?.safeCopyProfile !== 'safe_copy_v1'
    || job.details?.operationMode !== 'safe_copy'
    || job.sourceId !== handoff.sourceInstanceId
    || job.sourceConnectionId !== handoff.sourceConnectionId
    || job.status === 'succeeded'
    || job.status === 'canceled'
  ) return false;
  const target = job.targets?.find((row) => row.id === handoff.targetId);
  if (
    !target
    || target.destinationInstanceId !== handoff.targetInstanceId
    || target.targetConnectionId !== handoff.targetConnectionId
    || target.targetModelId !== handoff.targetModelId
  ) return false;
  const targetItems = job.items.filter((item) => item.targetId === handoff.targetId);
  const hasUnresolvedWrite = targetItems.some((item) => {
    if (item.details?.safeCopyAttempt !== true) return false;
    const state = item.details.safeCopyAttemptState;
    return state === 'dispatched' || state === 'uncertain';
  });
  if (hasUnresolvedWrite) return false;
  const executionSummary = targetItems
    .filter((item) => item.details?.safeCopyTargetExecutionSummary === true)
    .sort((left, right) => Number(right.endedAt || right.startedAt || 0) - Number(left.endedAt || left.startedAt || 0))[0];
  if (executionSummary) {
    return executionSummary.details?.safeCopyTargetStatus === 'needs_attention'
      && Array.isArray(executionSummary.details.safeCopyRecommendedActions)
      && executionSummary.details.safeCopyRecommendedActions.includes('open_model_migrator');
  }
  const preparationSummary = targetItems.find((item) => item.details?.safeCopyPreparationSummary === true);
  return preparationSummary?.details?.safeCopyTargetStatus === 'needs_attention'
    && Array.isArray(preparationSummary.details.safeCopyRecommendedActions)
    && preparationSummary.details.safeCopyRecommendedActions.includes('open_model_migrator');
}

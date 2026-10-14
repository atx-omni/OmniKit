import { apiFetch, type MigrationJob } from './opsConsole';
import type { BranchVerificationRecord, TopicMigrationPlan, TopicMigrationRequest, TopicMigrationTopic } from '../../shared/topicMigration';

export function loadMigrationTopics(input: Pick<TopicMigrationRequest, 'sourceInstanceId' | 'sourceConnectionId' | 'sourceModelId'>, signal?: AbortSignal) {
  const { sourceInstanceId, sourceConnectionId, sourceModelId } = input;
  return apiFetch<{ topics: TopicMigrationTopic[]; sourceHash: string }>('/api/model-migrator/topics', {
    method: 'POST', body: JSON.stringify({ sourceInstanceId, sourceConnectionId, sourceModelId }), signal,
  });
}
export function prepareTopicMigration(input: TopicMigrationRequest, signal?: AbortSignal, comparisonOfPlanId?: string) {
  return apiFetch<{ plan: TopicMigrationPlan }>('/api/model-migrator/topic-plan', {
    method: 'POST', body: JSON.stringify({ ...input, ...(comparisonOfPlanId ? { comparisonOfPlanId } : {}) }), signal,
  });
}
export function getTopicMigrationPlan(id: string, signal?: AbortSignal) {
  return apiFetch<{ plan: TopicMigrationPlan }>(`/api/model-migrator/topic-plan/${encodeURIComponent(id)}`, { signal });
}
export function prepareDashboardTopicMigration(input: { planId: string; targetId: string }, signal?: AbortSignal) {
  return apiFetch<{ plan: TopicMigrationPlan }>('/api/model-migrator/topic-plan/dashboard', {
    method: 'POST', body: JSON.stringify(input), signal,
  });
}
export function stageTopicMigration(plan: Pick<TopicMigrationPlan, 'id' | 'revision'>) {
  return apiFetch<{ plan: TopicMigrationPlan; job: MigrationJob }>(`/api/model-migrator/topic-plan/${encodeURIComponent(plan.id)}/stage`, {
    method: 'POST', body: JSON.stringify({ revision: plan.revision, approve: true }),
  });
}

/** Read back an existing branch only; never creates, rewrites, or publishes it. */
export function verifyTopicMigrationBranch(plan: Pick<TopicMigrationPlan, 'id' | 'revision'>, requestId: string) {
  return apiFetch<{ plan: TopicMigrationPlan; job: MigrationJob; verification: BranchVerificationRecord }>(`/api/model-migrator/topic-plan/${encodeURIComponent(plan.id)}/verify`, {
    method: 'POST', body: JSON.stringify({ revision: plan.revision, requestId }),
  });
}

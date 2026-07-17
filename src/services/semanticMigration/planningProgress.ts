import type { MigrationPlanningOutcomeStatus } from './planningOutcome';

export interface MigrationPlanningProgressContext {
  chunkIndex: number;
  chunkTotal: number;
  dashboardNames: string[];
}

export function migrationPlanningPhaseLabel(
  outcome: MigrationPlanningOutcomeStatus,
  jobStage: 'analyze' | 'compile' | 'repair' | undefined,
) {
  if (outcome === 'repairing' || jobStage === 'repair') return 'Repairing the migration plan';
  if (outcome === 'validating') return 'Validating the provider response';
  if (outcome === 'accepted') return 'Migration plan accepted';
  if (outcome === 'rejected') return 'Migration plan rejected';
  if (outcome === 'failed') return 'Migration planning failed';
  if (outcome === 'cancelled') return 'Planning monitoring stopped';
  if (outcome === 'queued') return 'Waiting for the AI provider';
  if (outcome === 'running') return jobStage === 'compile' ? 'Generating reviewed semantic code' : 'Building the migration plan';
  return 'Migration planning';
}

export function migrationPlanningContextLabel(context: MigrationPlanningProgressContext) {
  const chunk = context.chunkTotal > 1 ? `Evidence chunk ${context.chunkIndex} of ${context.chunkTotal}` : 'Selected migration scope';
  const dashboards = context.dashboardNames.filter(Boolean);
  if (dashboards.length === 0) return chunk;
  const visible = dashboards.slice(0, 3).join(', ');
  const remaining = dashboards.length - Math.min(dashboards.length, 3);
  return `${chunk} · ${visible}${remaining > 0 ? ` +${remaining} more` : ''}`;
}

export function migrationPlanningDurationGuidance(elapsedSeconds: number) {
  return elapsedSeconds >= 30
    ? 'Large dashboard and semantic scopes can take several minutes. You can leave this step and resume monitoring the same job later.'
    : 'Timing depends on the selected dashboards, dependencies, and provider capacity. Continuing monitoring never submits a duplicate job.';
}

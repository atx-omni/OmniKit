export type MigrationPlanningOutcomeStatus =
  | 'idle'
  | 'queued'
  | 'running'
  | 'validating'
  | 'accepted'
  | 'rejected'
  | 'repairing'
  | 'failed'
  | 'cancelled';

export interface MigrationPlanningOutcome {
  status: MigrationPlanningOutcomeStatus;
  issues: string[];
  repairAttempted: boolean;
  updatedAt?: string;
}

export const EMPTY_MIGRATION_PLANNING_OUTCOME: MigrationPlanningOutcome = {
  status: 'idle',
  issues: [],
  repairAttempted: false,
};

export class MigrationPlanContractError extends Error {
  readonly issues: string[];

  constructor(label: string, issues: string[]) {
    const boundedIssues = issues.map((issue) => issue.trim()).filter(Boolean).slice(0, 20);
    super(`${label} returned a migration plan that did not pass the required contract.`);
    this.name = 'MigrationPlanContractError';
    this.issues = boundedIssues;
  }
}

export function migrationPlanningStatusFromJob(
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled',
): MigrationPlanningOutcomeStatus {
  if (status === 'succeeded') return 'validating';
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  return status;
}

export function migrationPlanRepairInstruction(issues: string[]) {
  const bounded = issues.map((issue) => issue.trim()).filter(Boolean).slice(0, 20);
  if (bounded.length === 0) return '';
  return [
    'This is one bounded repair attempt. The previous response was rejected before any migration changes were accepted.',
    'Return a complete replacement response that satisfies the original schema and corrects every issue below.',
    ...bounded.map((issue, index) => `${index + 1}. ${issue}`),
    'Do not omit, weaken, or silently normalize any required dependency, visual, field, filter, or source evidence reference.',
  ].join('\n');
}

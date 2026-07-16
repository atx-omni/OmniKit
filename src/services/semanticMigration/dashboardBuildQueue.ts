import type {
  MigrationDashboardBuildItem,
  MigrationDashboardBuildPlan,
} from './types';

export interface DashboardBuildGateInput {
  semanticReady: boolean;
  semanticReviewConfirmed: boolean;
  plans: MigrationDashboardBuildPlan[];
  items: MigrationDashboardBuildItem[];
}

export interface DashboardBuildGate {
  ready: boolean;
  reasons: string[];
}

export function createDashboardBuildQueue(
  bundleId: string,
  plans: MigrationDashboardBuildPlan[],
): MigrationDashboardBuildItem[] {
  return plans.map((plan) => ({
    id: `dashboard-build:${bundleId}:${plan.id}`,
    planId: plan.id,
    sourceDashboardId: plan.sourceDashboardId,
    sourceDashboardName: plan.sourceDashboardName,
    status: 'queued',
    attempt: 0,
  }));
}

export function updateDashboardBuildItem(
  items: MigrationDashboardBuildItem[],
  planId: string,
  patch: Partial<MigrationDashboardBuildItem>,
): MigrationDashboardBuildItem[] {
  return items.map((item) => item.planId === planId ? { ...item, ...patch } : item);
}

export function retryableDashboardBuildPlanIds(items: MigrationDashboardBuildItem[]): string[] {
  return items
    .filter((item) => !['succeeded', 'skipped'].includes(item.status))
    .map((item) => item.planId);
}

export function dashboardBuildGate(input: DashboardBuildGateInput): DashboardBuildGate {
  const reasons: string[] = [];
  if (!input.semanticReady) reasons.push('The semantic branch must pass validation and diff review first.');
  if (!input.semanticReviewConfirmed) reasons.push('A reviewer must confirm the semantic branch is ready for dashboard construction.');
  if (input.plans.length === 0) reasons.push('At least one selected dashboard needs a build plan.');
  const incompletePlans = input.plans.filter((plan) => plan.tiles.length === 0);
  if (incompletePlans.length > 0) reasons.push(`${incompletePlans.length} dashboard plan${incompletePlans.length === 1 ? '' : 's'} need tile specifications.`);
  if (input.items.some((item) => item.status === 'running')) reasons.push('A dashboard build is already running.');
  return { ready: reasons.length === 0, reasons };
}

export function dashboardBuildSummary(items: MigrationDashboardBuildItem[]) {
  return {
    total: items.length,
    queued: items.filter((item) => item.status === 'queued').length,
    running: items.filter((item) => item.status === 'running').length,
    succeeded: items.filter((item) => item.status === 'succeeded').length,
    failed: items.filter((item) => item.status === 'failed').length,
    skipped: items.filter((item) => item.status === 'skipped').length,
    cancelled: items.filter((item) => item.status === 'cancelled').length,
  };
}

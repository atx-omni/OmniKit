import type {
  MigrationDashboardBuildItem,
  MigrationDashboardBuildPlan,
} from './types';
import type { OmniDocumentV2State } from '../omniApi';
import { dashboardPlanReadiness } from './bundle';
import type { SemanticMigrationBranchSnapshot } from './package';
import { sha256Text } from './sourceEvidence';

export interface DashboardBuildGateInput {
  dashboardStageRequired?: boolean;
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
    .filter((item) => ['queued', 'failed', 'cancelled'].includes(item.status) && !item.reconciliationRequired)
    .map((item) => item.planId);
}

export function dashboardBuildSnapshotFingerprint(snapshot: SemanticMigrationBranchSnapshot): string {
  const files = Object.entries(snapshot.files || {}).sort(([left], [right]) => left.localeCompare(right));
  const checksums = Object.entries(snapshot.checksums || {}).sort(([left], [right]) => left.localeCompare(right));
  return sha256Text(JSON.stringify({ files, checksums }));
}

export function dashboardBuildGate(input: DashboardBuildGateInput): DashboardBuildGate {
  if (input.dashboardStageRequired === false) return { ready: true, reasons: [] };
  const reasons: string[] = [];
  if (!input.semanticReady) reasons.push('The semantic branch must pass validation and diff review first.');
  if (!input.semanticReviewConfirmed) reasons.push('A reviewer must confirm the semantic branch is ready for dashboard construction.');
  if (input.plans.length === 0) reasons.push('At least one selected dashboard needs a build plan.');
  const incompletePlans = input.plans.filter((plan) => plan.tiles.length === 0);
  if (incompletePlans.length > 0) reasons.push(`${incompletePlans.length} dashboard plan${incompletePlans.length === 1 ? '' : 's'} need tile specifications.`);
  const blockedPlans = input.plans.filter((plan) => dashboardPlanReadiness(plan).status === 'blocked');
  if (blockedPlans.length > 0) reasons.push(`${blockedPlans.length} dashboard plan${blockedPlans.length === 1 ? '' : 's'} still contain blocking tile, field, filter, or listener issues.`);
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

export function dashboardBuildTargetUrl(input: {
  targetBaseUrl: string;
  message?: string;
  resultValues?: unknown[];
}): string | undefined {
  let target: URL;
  try {
    target = new URL(input.targetBaseUrl);
  } catch {
    return undefined;
  }
  const candidates: string[] = [];
  (input.resultValues || []).forEach((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    ['dashboardUrl', 'dashboard_url', 'documentUrl', 'document_url', 'targetUrl', 'target_url'].forEach((key) => {
      if (typeof record[key] === 'string') candidates.push(record[key] as string);
    });
  });
  candidates.push(...(input.message?.match(/https?:\/\/[^\s<>"')\]]+/g) || []));
  for (const candidate of candidates) {
    try {
      const parsed = new URL(candidate);
      if (parsed.origin !== target.origin || !/^\/(?:dashboards|documents)\//.test(parsed.pathname)) continue;
      parsed.username = '';
      parsed.password = '';
      parsed.search = '';
      parsed.hash = '';
      return parsed.toString();
    } catch {
      // Ignore malformed provider text and continue looking for a trusted target URL.
    }
  }
  return undefined;
}

export function dashboardBuildTargetDocumentId(targetUrl: string): string | undefined {
  try {
    const parsed = new URL(targetUrl);
    const match = /^\/(?:dashboards|documents)\/([^/]+)\/?$/.exec(parsed.pathname);
    return match?.[1] ? decodeURIComponent(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

export function dashboardBuildDocumentStateIssues(input: {
  documentId: string;
  targetModelId: string;
  state: OmniDocumentV2State;
}): string[] {
  const issues: string[] = [];
  const explicitDocumentId = typeof input.state.documentId === 'string' ? input.state.documentId.trim() : '';
  if (explicitDocumentId && explicitDocumentId !== input.documentId) {
    issues.push(`Omni returned document ${explicitDocumentId}, not the requested document ${input.documentId}.`);
  }
  if (!input.state.modelId) {
    issues.push('The created document did not return a target model ID.');
  } else if (input.state.modelId !== input.targetModelId) {
    issues.push(`The created document is attached to model ${input.state.modelId}, not target model ${input.targetModelId}.`);
  }
  const presentations = input.state.queryPresentations;
  if (!presentations || typeof presentations !== 'object' || Object.keys(presentations).length === 0) {
    issues.push('The created document did not return any query presentations to verify.');
  }
  return issues;
}

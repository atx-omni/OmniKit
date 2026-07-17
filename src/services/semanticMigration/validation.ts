import type { SourceConnectorCapabilities, SourceDashboardCatalogItem } from './studioApi';
import type { MigrationDashboardBuildItem, MigrationDashboardBuildPlan, MigrationDecision, PowerBiManualParseResult, SemanticMigrationFile } from './types';
import { migrationDecisionResolutionIssue } from './compiler';
import { dashboardPlanScopeIssues, dashboardVisualEvidenceCatalog, migrationBundleFingerprint, powerBiSelectedReportEvidence, type DashboardCanonicalFieldEvidenceCatalog } from './bundle';
import {
  migrationDecisionSemanticKey,
  migrationDecisionSemanticKind,
} from './decisionIdentity';

export type MigrationValidationStatus = 'passed' | 'failed' | 'unsupported' | 'skipped' | 'waived' | 'pending';
export type MigrationValidationCategory = 'dependency_resolution' | 'dashboard_bindings' | 'structural' | 'semantic' | 'query' | 'visual_intent' | 'security' | 'operational' | 'human' | 'dashboard_build';

export interface MigrationValidationCheck {
  id: MigrationValidationCategory;
  label: string;
  status: MigrationValidationStatus;
  blocking: boolean;
  summary: string;
  evidence: string[];
}

export interface MigrationValidationInput {
  modelValidation: Array<{ message?: string; is_warning?: boolean; yaml_path?: string }> | null;
  contentValidation: Record<string, unknown> | null;
  sourceCapabilities?: SourceConnectorCapabilities;
  changedFileCount: number;
  reviewAcknowledged: boolean;
  waivers?: Partial<Record<MigrationValidationCategory, boolean>>;
}

function recordHasFailure(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(recordHasFailure);
  return Object.entries(value as Record<string, unknown>).some(([key, item]) => {
    if (/^(error|errors|failed|failure)$/i.test(key)) {
      if (typeof item === 'boolean') return item;
      if (typeof item === 'string') return Boolean(item.trim());
      if (Array.isArray(item)) return item.length > 0;
      if (item && typeof item === 'object') return Object.keys(item as Record<string, unknown>).length > 0;
    }
    return recordHasFailure(item);
  });
}

function unverifiedCheck(
  id: MigrationValidationCategory,
  label: string,
  supportedBySource: boolean | undefined,
  waivers: Partial<Record<MigrationValidationCategory, boolean>>,
  detail: string,
): MigrationValidationCheck {
  if (waivers[id]) return { id, label, status: 'waived', blocking: true, summary: `Explicitly waived. ${detail}`, evidence: ['User waiver recorded in this reviewed session.'] };
  return {
    id,
    label,
    status: 'unsupported',
    blocking: true,
    summary: supportedBySource
      ? `${detail} The source connector exposes supporting APIs, but no comparison evidence has been captured in this run.`
      : `${detail} The selected source connector does not expose enough evidence for this check.`,
    evidence: [],
  };
}

export function buildMigrationValidationChecks(input: MigrationValidationInput): MigrationValidationCheck[] {
  const waivers = input.waivers || {};
  const modelErrors = (input.modelValidation || []).filter((issue) => !issue.is_warning);
  const structural: MigrationValidationCheck = input.modelValidation === null
    ? { id: 'structural', label: 'Structural', status: 'pending', blocking: true, summary: 'Run the reviewed package on a dev branch to validate YAML, references, and checksums.', evidence: [] }
    : modelErrors.length > 0
      ? { id: 'structural', label: 'Structural', status: 'failed', blocking: true, summary: `${modelErrors.length} model validation error${modelErrors.length === 1 ? '' : 's'} remain.`, evidence: modelErrors.slice(0, 8).map((issue) => [issue.yaml_path, issue.message].filter(Boolean).join(': ')) }
      : { id: 'structural', label: 'Structural', status: 'passed', blocking: true, summary: `Omni accepted the dev-branch model structure and ${input.changedFileCount} changed file${input.changedFileCount === 1 ? '' : 's'} were diffed.`, evidence: ['Omni model validation returned no errors.'] };

  const semantic: MigrationValidationCheck = input.contentValidation === null
    ? { id: 'semantic', label: 'Semantic', status: 'pending', blocking: true, summary: 'Model content validation has not run.', evidence: [] }
    : recordHasFailure(input.contentValidation)
      ? { id: 'semantic', label: 'Semantic', status: 'failed', blocking: true, summary: 'Omni content validation reported unresolved semantic references.', evidence: ['Inspect the content validation response and repair the reviewed package.'] }
      : { id: 'semantic', label: 'Semantic', status: 'passed', blocking: true, summary: 'Omni content validation completed without a reported failure.', evidence: ['Content validation response captured in page memory.'] };

  return [
    structural,
    semantic,
    unverifiedCheck('query', 'Query results', input.sourceCapabilities?.queryValidation, waivers, 'Source-versus-target result reconciliation was not executed.'),
    unverifiedCheck('visual_intent', 'Visual intent', input.sourceCapabilities?.visualEvidence, waivers, 'Chart encodings, sort order, limits, filters, and interactions were not compared.'),
    unverifiedCheck('security', 'Security', input.sourceCapabilities?.permissions, waivers, 'User, group, row-policy, and folder-access equivalence was not verified.'),
    unverifiedCheck('operational', 'Operations', input.sourceCapabilities?.schedules, waivers, 'Schedules, subscriptions, refreshes, embeds, and exports were not verified.'),
    input.reviewAcknowledged
      ? { id: 'human', label: 'Owner review', status: 'passed', blocking: true, summary: 'A reviewer acknowledged the generated diff and validation evidence.', evidence: ['Human review checkbox acknowledged.'] }
      : { id: 'human', label: 'Owner review', status: 'pending', blocking: true, summary: 'A reviewer must acknowledge the diff, exceptions, and waivers.', evidence: [] },
  ];
}

export function migrationValidationReady(checks: MigrationValidationCheck[]): boolean {
  return checks.every((check) => !check.blocking || check.status === 'passed' || check.status === 'waived');
}

export function semanticMigrationPreparationFingerprint(input: {
  sourcePlatform: string;
  targetModelId?: string;
  targetBaseline?: {
    version?: number;
    files?: Record<string, string>;
    checksums?: Record<string, string>;
  } | null;
  selectedDashboardIds: string[];
  dashboardPlans: MigrationDashboardBuildPlan[];
  decisions: MigrationDecision[];
  semanticFiles: SemanticMigrationFile[];
  powerBiParseResult?: PowerBiManualParseResult | null;
}): string {
  const dashboardPlans = [...input.dashboardPlans].sort((a, b) => a.sourceDashboardId.localeCompare(b.sourceDashboardId) || a.id.localeCompare(b.id));
  const decisions = [...input.decisions]
    .sort((a, b) => migrationDecisionSemanticKey(a).localeCompare(migrationDecisionSemanticKey(b)) || a.id.localeCompare(b.id))
    .map((decision) => ({
      ...decision,
      semanticKind: migrationDecisionSemanticKind(decision),
      semanticKey: migrationDecisionSemanticKey(decision),
      evidence: [...decision.evidence].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      impactAssetIds: [...decision.impactAssetIds].sort(),
    }));
  const targetFiles = Object.keys(input.targetBaseline?.files || {}).sort().map((fileName) => ({
    fileName,
    digest: migrationBundleFingerprint({ fileName, yaml: input.targetBaseline?.files?.[fileName] || '' }),
  }));
  return migrationBundleFingerprint({
    schemaVersion: 'omnikit.semantic-migration.preparation.v2',
    sourcePlatform: input.sourcePlatform,
    targetModelId: input.targetModelId || '',
    targetBaseline: { files: targetFiles },
    selectedDashboardIds: [...input.selectedDashboardIds].sort(),
    dashboardPlans,
    decisions,
    semanticFiles: [...input.semanticFiles]
      .sort((a, b) => a.fileName.localeCompare(b.fileName) || a.id.localeCompare(b.id))
      .map((file) => ({ fileName: file.fileName, yaml: file.yaml })),
    powerBiEvidence: input.sourcePlatform === 'power_bi'
      ? powerBiSelectedReportEvidence(input.powerBiParseResult || null, input.selectedDashboardIds)
      : undefined,
  });
}

export function semanticMigrationWriteReadinessIssues(input: {
  preparationChecks: MigrationValidationCheck[];
  packageFileCount: number;
  packagePreparationFingerprint: string;
  currentPreparationFingerprint: string;
}): string[] {
  const blockingChecks = input.preparationChecks.filter((check) => check.blocking && !['passed', 'waived'].includes(check.status));
  return [
    ...(input.packageFileCount > 0 ? [] : ['Generate and review at least one semantic YAML file before preparing a dev branch.']),
    ...blockingChecks.map((check) => `${check.label}: ${check.summary}`),
    ...(!input.packagePreparationFingerprint ? ['Generate the semantic YAML package from the current reviewed preparation context.'] : []),
    ...(input.packagePreparationFingerprint && input.packagePreparationFingerprint !== input.currentPreparationFingerprint
      ? ['The semantic YAML package is stale because the selected source, target model baseline, dashboard plans, dependency decisions, or reviewed package changed. Regenerate or repair it against the current target before preparing a dev branch.']
      : []),
  ];
}

export function buildMigrationPreparationValidationChecks(input: {
  decisions: MigrationDecision[];
  selectedDashboards: SourceDashboardCatalogItem[];
  dashboardPlans: MigrationDashboardBuildPlan[];
  powerBiParseResult?: PowerBiManualParseResult | null;
  canonicalFieldCatalog?: DashboardCanonicalFieldEvidenceCatalog;
}): MigrationValidationCheck[] {
  const unresolved = input.decisions.filter((decision) => decision.blocking && (!decision.approvedByUser || migrationDecisionResolutionIssue(decision)));
  const dependencyResolution: MigrationValidationCheck = input.decisions.length === 0
    ? { id: 'dependency_resolution', label: 'Dependency decisions', status: 'passed', blocking: true, summary: 'No typed semantic dependency decisions are required for the selected dashboards.', evidence: ['The selected dependency closure contains no DAX, M, relationship, security, or visual exceptions requiring an operator decision.'] }
    : unresolved.length > 0
      ? { id: 'dependency_resolution', label: 'Dependency decisions', status: 'failed', blocking: true, summary: `${unresolved.length} blocking migration decision${unresolved.length === 1 ? '' : 's'} still need a valid approved action.`, evidence: unresolved.slice(0, 12).map((decision) => `${decision.sourceLabel}: ${migrationDecisionResolutionIssue(decision) || 'approval required'}`) }
      : { id: 'dependency_resolution', label: 'Dependency decisions', status: 'passed', blocking: true, summary: `All ${input.decisions.length} typed migration decisions have valid approved outcomes.`, evidence: input.decisions.map((decision) => `${decision.domain}: ${decision.sourceLabel} → ${decision.action}`).slice(0, 20) };

  const planCounts = input.dashboardPlans.reduce((counts, plan) => counts.set(plan.sourceDashboardId, (counts.get(plan.sourceDashboardId) || 0) + 1), new Map<string, number>());
  const plansByDashboard = new Map(input.dashboardPlans.map((plan) => [plan.sourceDashboardId, plan]));
  const missingPlans = input.selectedDashboards.filter((dashboard) => !plansByDashboard.has(dashboard.id));
  const duplicatePlans = input.selectedDashboards.filter((dashboard) => (planCounts.get(dashboard.id) || 0) > 1);
  const invalidPlans = input.dashboardPlans.filter((plan) => plan.tiles.length === 0 || plan.tiles.some((tile) => tile.fields.length === 0));
  const unknownPlans = input.dashboardPlans.filter((plan) => !input.selectedDashboards.some((dashboard) => dashboard.id === plan.sourceDashboardId));
  const visualEvidence = powerBiSelectedReportEvidence(input.powerBiParseResult || null, input.selectedDashboards.map((dashboard) => dashboard.id));
  const visualCatalog = dashboardVisualEvidenceCatalog(visualEvidence);
  const knownVisualIds = new Set(visualEvidence.reports.flatMap((report) => report.pages.flatMap((page) => page.visuals.map((visual) => visual.evidenceId))));
  const referencedVisualIdList = input.dashboardPlans.flatMap((plan) => plan.tiles.flatMap((tile) => tile.sourceEvidenceIds.filter((id) => id.startsWith('powerbi:visual:'))));
  const referencedVisualIds = new Set(referencedVisualIdList);
  const missingVisualIds = Array.from(knownVisualIds).filter((id) => !referencedVisualIds.has(id));
  const unknownVisualIds = Array.from(referencedVisualIds).filter((id) => !knownVisualIds.has(id));
  const duplicateVisualIds = Array.from(knownVisualIds).filter((id) => referencedVisualIdList.filter((candidate) => candidate === id).length > 1);
  const scopeIssues = dashboardPlanScopeIssues(input.dashboardPlans, input.selectedDashboards, visualCatalog.expectedVisualIds, visualCatalog, input.decisions, input.canonicalFieldCatalog);
  const fieldIssues = scopeIssues.filter((issue) => issue.includes('unproven field'));
  const dashboardBindings: MigrationValidationCheck = input.selectedDashboards.length === 0
    ? { id: 'dashboard_bindings', label: 'Dashboard bindings', status: 'skipped', blocking: false, summary: 'No source dashboards were selected.', evidence: [] }
    : scopeIssues.length > 0
      ? {
          id: 'dashboard_bindings', label: 'Dashboard bindings', status: 'failed', blocking: true,
          summary: `${missingPlans.length} selected dashboard${missingPlans.length === 1 ? '' : 's'} lack plans; ${duplicatePlans.length} dashboard${duplicatePlans.length === 1 ? '' : 's'} have more than one plan; ${invalidPlans.length} plan${invalidPlans.length === 1 ? '' : 's'} lack tile or field bindings; ${unknownPlans.length} plan${unknownPlans.length === 1 ? '' : 's'} reference unselected dashboards; ${missingVisualIds.length} known visual${missingVisualIds.length === 1 ? '' : 's'} are omitted; ${duplicateVisualIds.length} visual${duplicateVisualIds.length === 1 ? '' : 's'} are bound more than once; ${unknownVisualIds.length} visual reference${unknownVisualIds.length === 1 ? '' : 's'} are unknown; ${fieldIssues.length} field binding${fieldIssues.length === 1 ? '' : 's'} lack provenance.`,
          evidence: [
            ...missingPlans.map((dashboard) => `Missing plan: ${dashboard.name}`),
            ...duplicatePlans.map((dashboard) => `Duplicate plans: ${dashboard.name} has ${planCounts.get(dashboard.id)} plans; exactly one is required.`),
            ...invalidPlans.map((plan) => `Incomplete bindings: ${plan.sourceDashboardName}`),
            ...unknownPlans.map((plan) => `Out-of-scope plan: ${plan.sourceDashboardName}`),
            ...missingVisualIds.map((id) => `Missing visual plan evidence: ${id}`),
            ...duplicateVisualIds.map((id) => `Duplicate visual plan evidence: ${id}`),
            ...unknownVisualIds.map((id) => `Unknown visual plan evidence: ${id}`),
            ...fieldIssues,
          ].slice(0, 20),
        }
      : { id: 'dashboard_bindings', label: 'Dashboard bindings', status: 'passed', blocking: true, summary: `Every selected dashboard has one reviewed plan with field-bound tile specifications.`, evidence: input.dashboardPlans.map((plan) => `${plan.sourceDashboardName}: ${plan.tiles.length} tile${plan.tiles.length === 1 ? '' : 's'}`) };
  return [dependencyResolution, dashboardBindings];
}

export function buildDashboardBuildValidationCheck(input: {
  plannedCount: number;
  semanticReviewConfirmed: boolean;
  items: MigrationDashboardBuildItem[];
}): MigrationValidationCheck {
  if (input.plannedCount === 0) {
    return { id: 'dashboard_build', label: 'Dashboard construction', status: 'skipped', blocking: false, summary: 'No source dashboards were selected for construction.', evidence: [] };
  }
  if (!input.semanticReviewConfirmed) {
    return { id: 'dashboard_build', label: 'Dashboard construction', status: 'pending', blocking: true, summary: 'Semantic branch readiness must be confirmed before dashboard construction can begin.', evidence: [] };
  }
  const succeeded = input.items.filter((item) => item.status === 'succeeded');
  const failed = input.items.filter((item) => item.status === 'failed');
  const skipped = input.items.filter((item) => item.status === 'skipped');
  const cancelled = input.items.filter((item) => item.status === 'cancelled');
  const active = input.items.filter((item) => ['queued', 'running'].includes(item.status));
  const evidence = input.items.map((item) => `${item.sourceDashboardName}: ${item.status}${item.attempt ? ` after ${item.attempt} attempt${item.attempt === 1 ? '' : 's'}` : ''}`);
  if (failed.length > 0 || skipped.length > 0) {
    return { id: 'dashboard_build', label: 'Dashboard construction', status: 'failed', blocking: true, summary: `${succeeded.length} of ${input.plannedCount} dashboards succeeded; ${failed.length} failed and ${skipped.length} were skipped.`, evidence };
  }
  if (cancelled.length > 0 || active.length > 0 || input.items.length < input.plannedCount) {
    return { id: 'dashboard_build', label: 'Dashboard construction', status: 'pending', blocking: true, summary: `${succeeded.length} of ${input.plannedCount} dashboards have completed; ${active.length} remain queued or running and ${cancelled.length} were cancelled.`, evidence };
  }
  return { id: 'dashboard_build', label: 'Dashboard construction', status: 'passed', blocking: true, summary: `All ${input.plannedCount} selected dashboards were constructed by Omni AI.`, evidence };
}

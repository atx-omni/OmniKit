import type { SourceDashboardCatalogItem, SourceInventory } from './studioApi';
import type {
  MigrationAssetScopeDecision,
  MigrationDashboardBuildItem,
  MigrationDecision,
  MigrationBundle,
  MigrationPlatformKind,
  OmniMigrationDeliverable,
  SemanticMigrationFile,
} from './types';
import type { MigrationValidationCheck } from './validation';
import type { MigrationEngineParityReport } from './engineParity';

export type MigrationAssetOutcome = 'translated' | 'approximated' | 'redesigned' | 'excluded' | 'deferred' | 'unresolved';

export interface MigrationReconciliationReport {
  schemaVersion: '1.2';
  generatedAt: string;
  bundleId?: string;
  source: {
    platform: string;
    label: string;
    inventoriedAssets: number;
    selectedDashboards: Array<{ id: string; name: string; coverage: string; dependencyCount: number }>;
    engine?: MigrationBundle['source']['engine'];
  };
  target: {
    platform: 'omni';
    instanceHost: string;
    modelId?: string;
    modelName?: string;
    branchId?: string;
    branchName?: string;
    connectionMappings?: MigrationBundle['target']['connectionMappings'];
    connectionRoutes?: MigrationBundle['target']['connectionRoutes'];
  };
  scope: { included: number; consolidated: number; redesigned: number; deferred: number; retired: number; waves: string[] };
  mappings: Array<{ domain: string; source: string; action: string; target?: string; approved: boolean; confidence: number }>;
  deliverables: Array<{ kind: string; name: string; operation: string; executable: boolean }>;
  validation: Array<{ category: string; status: string; summary: string; evidence: string[] }>;
  dashboardBuilds: Array<{ sourceDashboardId: string; name: string; status: string; attempt: number; chatLink?: string }>;
  outcomes: Array<{ sourceId: string; sourceLabel: string; sourceKind: string; outcome: MigrationAssetOutcome; targetRefs: string[]; evidenceRefs: string[]; reason: string }>;
  lineage: Array<{ kind: 'semantic_file' | 'deliverable' | 'dashboard'; sourceIds: string[]; targetRef: string; decisionIds: string[] }>;
  operationalEvidence?: {
    engine?: { name: string; version: string; rulebookVersion: string; untranslatableCount: number };
    parity?: Pick<MigrationEngineParityReport, 'schemaVersion' | 'source' | 'mode' | 'scores' | 'promotion' | 'operational'>;
  };
  exceptions: Array<{ id: string; category: string; summary: string }>;
  deployment: { status: 'not_started' | 'staged_for_review' | 'dashboard_building' | 'ready_for_final_review' | 'dashboard_attention'; targetLinks: string[]; rollback: string };
}

function safeHost(baseUrl: string): string {
  try { return new URL(baseUrl).host; } catch { return ''; }
}

function safeOrigin(baseUrl: string): string {
  try { return new URL(baseUrl).origin; } catch { return ''; }
}

function safeTargetLink(value: string | undefined, expectedHost: string): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.host !== expectedHost) return undefined;
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return undefined;
  }
}

export function buildMigrationReconciliationReport(input: {
  sourceInventory: SourceInventory | null;
  sourcePlatform?: MigrationPlatformKind;
  sourceDashboardCatalog?: SourceDashboardCatalogItem[];
  scope: Record<string, MigrationAssetScopeDecision>;
  decisions: MigrationDecision[];
  files: SemanticMigrationFile[];
  plannedDeliverables?: OmniMigrationDeliverable[];
  validation: MigrationValidationCheck[];
  targetBaseUrl: string;
  targetModelId?: string;
  targetModelName?: string;
  connectionMappings?: MigrationBundle['target']['connectionMappings'];
  connectionRoutes?: MigrationBundle['target']['connectionRoutes'];
  branchId?: string;
  branchName?: string;
  bundleId?: string;
  selectedDashboardIds?: string[];
  dashboardBuildItems?: MigrationDashboardBuildItem[];
  engineEvidence?: MigrationBundle['source']['engine'];
  engineParity?: MigrationEngineParityReport | null;
}): MigrationReconciliationReport {
  const scopeValues = Object.values(input.scope);
  const selectedIds = new Set(input.selectedDashboardIds || []);
  const sourceDashboardCatalog = input.sourceDashboardCatalog || input.sourceInventory?.dashboardCatalog || [];
  const selectedDashboards = sourceDashboardCatalog.filter((dashboard) => selectedIds.has(dashboard.id));
  const dashboardBuildItems = input.dashboardBuildItems || [];
  const failedDashboardBuilds = dashboardBuildItems.filter((item) => ['failed', 'skipped', 'cancelled'].includes(item.status));
  const exceptions = [
    ...input.decisions.filter((decision) => !decision.approvedByUser || ['exclude', 'defer'].includes(decision.action)).map((decision) => ({
      id: decision.id,
      category: decision.domain,
      summary: `${decision.sourceLabel}: ${decision.approvedByUser ? decision.action : 'unresolved'}`,
    })),
    ...input.validation.filter((check) => check.status !== 'passed').map((check) => ({
      id: `validation:${check.id}`,
      category: 'validation',
      summary: `${check.label}: ${check.status} - ${check.summary}`,
    })),
    ...failedDashboardBuilds.map((item) => ({
      id: `dashboard:${item.sourceDashboardId}`,
      category: 'dashboard_build',
      summary: `${item.sourceDashboardName}: ${item.status} after ${item.attempt} attempt${item.attempt === 1 ? '' : 's'}`,
    })),
  ];
  const dashboardSucceeded = dashboardBuildItems.filter((item) => item.status === 'succeeded').length;
  const dashboardActive = dashboardBuildItems.some((item) => ['queued', 'running'].includes(item.status));
  const deploymentStatus: MigrationReconciliationReport['deployment']['status'] = failedDashboardBuilds.length > 0
    ? 'dashboard_attention'
    : selectedDashboards.length > 0 && dashboardSucceeded === selectedDashboards.length
      ? 'ready_for_final_review'
      : dashboardActive
        ? 'dashboard_building'
        : input.branchId
          ? 'staged_for_review'
          : 'not_started';
  const targetHost = safeHost(input.targetBaseUrl);
  const targetLinks = Array.from(new Set([
    safeOrigin(input.targetBaseUrl),
    ...dashboardBuildItems.flatMap((item) => safeTargetLink(item.chatUrl, targetHost) || []),
  ].filter(Boolean)));
  const decisionsBySourceId = new Map<string, MigrationDecision[]>();
  input.decisions.forEach((decision) => {
    const sourceIds = new Set([decision.nodeId, ...decision.impactAssetIds, ...decision.evidence.map((item) => item.sourceId)].filter(Boolean));
    sourceIds.forEach((sourceId) => decisionsBySourceId.set(sourceId, [...(decisionsBySourceId.get(sourceId) || []), decision]));
  });
  const dashboardBuildBySourceId = new Map(dashboardBuildItems.map((item) => [item.sourceDashboardId, item]));
  const sourceAssets = new Map<string, { name: string; kind: string }>();
  input.sourceInventory?.items.forEach((item) => sourceAssets.set(item.id, { name: item.name, kind: item.kind }));
  selectedDashboards.forEach((dashboard) => sourceAssets.set(dashboard.id, { name: dashboard.name, kind: dashboard.kind }));

  const scopedOutcomes = Object.entries(input.scope).map(([sourceId, scopeDecision]) => {
    const asset = sourceAssets.get(sourceId) || { name: sourceId, kind: 'source_asset' };
    const relatedDecisions = decisionsBySourceId.get(sourceId) || [];
    const unresolved = relatedDecisions.some((decision) => !decision.approvedByUser);
    const excluded = relatedDecisions.some((decision) => decision.action === 'exclude');
    const deferred = relatedDecisions.some((decision) => decision.action === 'defer');
    const redesigned = scopeDecision.disposition === 'redesign' || relatedDecisions.some((decision) => decision.action === 'rewrite');
    const approximated = relatedDecisions.some((decision) => decision.approvedByUser && decision.confidence < 0.8);
    const outcome: MigrationAssetOutcome = scopeDecision.disposition === 'retire' || excluded
      ? 'excluded'
      : scopeDecision.disposition === 'defer' || deferred
        ? 'deferred'
        : unresolved
          ? 'unresolved'
          : redesigned
            ? 'redesigned'
            : approximated
              ? 'approximated'
              : 'translated';
    return {
      sourceId,
      sourceLabel: asset.name,
      sourceKind: asset.kind,
      outcome,
      targetRefs: Array.from(new Set(relatedDecisions.flatMap((decision) => [decision.targetId, decision.targetLabel, decision.targetFileName].filter((value): value is string => Boolean(value))))),
      evidenceRefs: Array.from(new Set(relatedDecisions.flatMap((decision) => decision.evidence.map((evidence) => evidence.locator).filter((value): value is string => Boolean(value))))),
      reason: relatedDecisions.length > 0 ? `${relatedDecisions.length} reviewed migration decision${relatedDecisions.length === 1 ? '' : 's'}.` : `Scope disposition: ${scopeDecision.disposition}.`,
    };
  });
  const outcomeSourceIds = new Set(scopedOutcomes.map((item) => item.sourceId));
  const unscopedDecisionGroups = new Map<string, MigrationDecision[]>();
  input.decisions.filter((decision) => !outcomeSourceIds.has(decision.nodeId)).forEach((decision) => {
    unscopedDecisionGroups.set(decision.nodeId, [...(unscopedDecisionGroups.get(decision.nodeId) || []), decision]);
  });
  const decisionOutcomes = Array.from(unscopedDecisionGroups.entries()).map(([sourceId, relatedDecisions]) => {
    const first = relatedDecisions[0]!;
    const outcome: MigrationAssetOutcome = relatedDecisions.some((decision) => !decision.approvedByUser)
      ? 'unresolved'
      : relatedDecisions.some((decision) => decision.action === 'exclude')
        ? 'excluded'
        : relatedDecisions.some((decision) => decision.action === 'defer')
          ? 'deferred'
          : relatedDecisions.some((decision) => decision.action === 'rewrite')
            ? 'redesigned'
            : relatedDecisions.some((decision) => decision.confidence < 0.8)
              ? 'approximated'
              : 'translated';
    return {
      sourceId,
      sourceLabel: first.sourceLabel,
      sourceKind: first.domain,
      outcome,
      targetRefs: Array.from(new Set(relatedDecisions.flatMap((decision) => [decision.targetId, decision.targetLabel, decision.targetFileName].filter((value): value is string => Boolean(value))))),
      evidenceRefs: Array.from(new Set(relatedDecisions.flatMap((decision) => decision.evidence.map((evidence) => evidence.locator).filter((value): value is string => Boolean(value))))),
      reason: outcome === 'unresolved' ? 'One or more migration decisions are unresolved.' : `${relatedDecisions.length} approved migration decision${relatedDecisions.length === 1 ? '' : 's'}.`,
    };
  });
  const recordedOutcomeIds = new Set([...outcomeSourceIds, ...decisionOutcomes.map((item) => item.sourceId)]);
  const dashboardOutcomes = selectedDashboards.filter((dashboard) => !recordedOutcomeIds.has(dashboard.id)).map((dashboard) => {
    const build = dashboardBuildBySourceId.get(dashboard.id);
    const outcome: MigrationAssetOutcome = build?.status === 'succeeded' ? 'translated' : build?.status === 'skipped' || build?.status === 'cancelled' ? 'deferred' : 'unresolved';
    return {
      sourceId: dashboard.id,
      sourceLabel: dashboard.name,
      sourceKind: dashboard.kind,
      outcome,
      targetRefs: [safeTargetLink(build?.chatUrl, targetHost)].filter((value): value is string => Boolean(value)),
      evidenceRefs: [dashboard.path].filter((value): value is string => Boolean(value)),
      reason: build ? `Dashboard build status: ${build.status}.` : 'Dashboard build has not started.',
    };
  });
  const outcomes = [...scopedOutcomes, ...decisionOutcomes, ...dashboardOutcomes];
  const lineage: MigrationReconciliationReport['lineage'] = [
    ...input.files.map((file) => {
      const related = input.decisions.filter((decision) => decision.targetFileName === file.fileName);
      return {
        kind: 'semantic_file' as const,
        sourceIds: Array.from(new Set(related.flatMap((decision) => [decision.nodeId, ...decision.impactAssetIds]))),
        targetRef: file.fileName,
        decisionIds: related.map((decision) => decision.id),
      };
    }),
    ...(input.plannedDeliverables || []).map((deliverable) => ({
      kind: 'deliverable' as const,
      sourceIds: deliverable.sourceAssetIds,
      targetRef: deliverable.targetId || deliverable.targetName,
      decisionIds: deliverable.decisionIds,
    })),
    ...dashboardBuildItems.map((item) => ({
      kind: 'dashboard' as const,
      sourceIds: [item.sourceDashboardId],
      targetRef: safeTargetLink(item.chatUrl, targetHost) || item.sourceDashboardName,
      decisionIds: [],
    })),
  ];
  return {
    schemaVersion: '1.2',
    generatedAt: new Date().toISOString(),
    bundleId: input.bundleId,
    source: {
      platform: input.sourceInventory?.platform || input.sourcePlatform || 'manual_artifacts',
      label: input.sourceInventory?.connector.label || (input.sourcePlatform ? `${input.sourcePlatform.split('_').join(' ')} manual project` : 'Manual source artifacts'),
      inventoriedAssets: input.sourceInventory?.items.length || sourceDashboardCatalog.reduce((count, dashboard) => count + 1 + dashboard.dependencyIds.length, 0),
      selectedDashboards: selectedDashboards.map((dashboard) => ({ id: dashboard.id, name: dashboard.name, coverage: dashboard.coverage, dependencyCount: dashboard.dependencyIds.length })),
      engine: input.engineEvidence,
    },
    target: {
      platform: 'omni',
      instanceHost: safeHost(input.targetBaseUrl),
      modelId: input.targetModelId,
      modelName: input.targetModelName,
      branchId: input.branchId,
      branchName: input.branchName,
      connectionMappings: input.connectionMappings?.map((mapping) => ({ ...mapping })),
      connectionRoutes: input.connectionRoutes?.map((route) => ({
        ...route,
        sourceKeys: [...route.sourceKeys],
        compatibleModels: route.compatibleModels.map((model) => ({ ...model })),
      })),
    },
    scope: {
      included: scopeValues.filter((item) => item.disposition === 'migrate').length,
      consolidated: scopeValues.filter((item) => item.disposition === 'consolidate').length,
      redesigned: scopeValues.filter((item) => item.disposition === 'redesign').length,
      deferred: scopeValues.filter((item) => item.disposition === 'defer').length,
      retired: scopeValues.filter((item) => item.disposition === 'retire').length,
      waves: Array.from(new Set(scopeValues.filter((item) => item.disposition !== 'retire').map((item) => item.wave).filter(Boolean))).sort(),
    },
    mappings: input.decisions.map((decision) => ({
      domain: decision.domain,
      source: decision.sourceLabel,
      action: decision.action,
      target: decision.targetLabel || decision.targetId || decision.targetFileName,
      approved: decision.approvedByUser,
      confidence: decision.confidence,
    })),
    deliverables: [
      ...input.files.map((file) => ({ kind: 'semantic_yaml', name: file.fileName, operation: 'create_or_update', executable: true })),
      ...(input.plannedDeliverables || []).map((deliverable) => ({ kind: deliverable.kind, name: deliverable.targetName, operation: deliverable.operation, executable: false })),
    ],
    validation: input.validation.map((check) => ({ category: check.id, status: check.status, summary: check.summary, evidence: check.evidence })),
    dashboardBuilds: dashboardBuildItems.map((item) => ({
      sourceDashboardId: item.sourceDashboardId,
      name: item.sourceDashboardName,
      status: item.status,
      attempt: item.attempt,
      chatLink: safeTargetLink(item.chatUrl, targetHost),
    })),
    outcomes,
    lineage,
    operationalEvidence: input.engineEvidence || input.engineParity ? {
      engine: input.engineEvidence ? {
        name: input.engineEvidence.name,
        version: input.engineEvidence.version,
        rulebookVersion: input.engineEvidence.rulebookVersion,
        untranslatableCount: input.engineEvidence.untranslatableCount,
      } : undefined,
      parity: input.engineParity ? {
        schemaVersion: input.engineParity.schemaVersion,
        source: input.engineParity.source,
        mode: input.engineParity.mode,
        scores: input.engineParity.scores,
        promotion: input.engineParity.promotion,
        operational: input.engineParity.operational,
      } : undefined,
    } : undefined,
    exceptions,
    deployment: {
      status: deploymentStatus,
      targetLinks,
      rollback: input.branchId
        ? 'Discard the unmerged Omni dev branch and archive any generated dashboard drafts from this bundle before retrying.'
        : 'No target mutation has been performed.',
    },
  };
}

function markdownCell(value: unknown): string {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').trim();
}

export function migrationReconciliationReportToMarkdown(report: MigrationReconciliationReport): string {
  const outcomeCounts = report.outcomes.reduce<Record<MigrationAssetOutcome, number>>((counts, item) => ({ ...counts, [item.outcome]: counts[item.outcome] + 1 }), {
    translated: 0,
    approximated: 0,
    redesigned: 0,
    excluded: 0,
    deferred: 0,
    unresolved: 0,
  });
  const lines = [
    '# OmniKit BI Migration Reconciliation',
    '',
    `Generated: ${report.generatedAt}`,
    `Bundle: ${report.bundleId || 'not assigned'}`,
    `Source: ${report.source.label} (${report.source.platform})`,
    `Target: ${report.target.instanceHost}${report.target.modelName ? ` / ${report.target.modelName}` : ''}`,
    `Deployment: ${report.deployment.status}`,
    '',
    '## Outcome Summary',
    '',
    `- Translated: ${outcomeCounts.translated}`,
    `- Approximated: ${outcomeCounts.approximated}`,
    `- Redesigned: ${outcomeCounts.redesigned}`,
    `- Excluded: ${outcomeCounts.excluded}`,
    `- Deferred: ${outcomeCounts.deferred}`,
    `- Unresolved: ${outcomeCounts.unresolved}`,
    '',
    '## Asset Outcomes',
    '',
    '| Source asset | Kind | Outcome | Target | Reason |',
    '| --- | --- | --- | --- | --- |',
    ...report.outcomes.map((item) => `| ${markdownCell(item.sourceLabel)} | ${markdownCell(item.sourceKind)} | ${item.outcome} | ${markdownCell(item.targetRefs.join(', ') || 'none')} | ${markdownCell(item.reason)} |`),
    '',
    '## Target Lineage',
    '',
    '| Kind | Source IDs | Target | Decisions |',
    '| --- | --- | --- | --- |',
    ...report.lineage.map((item) => `| ${item.kind} | ${markdownCell(item.sourceIds.join(', ') || 'none')} | ${markdownCell(item.targetRef)} | ${markdownCell(item.decisionIds.join(', ') || 'none')} |`),
  ];
  if (report.target.connectionRoutes?.length) {
    lines.push(
      '',
      '## Connection Routes',
      '',
      '| Destination connection | Source connections | Compatible models | Write status |',
      '| --- | --- | --- | --- |',
      ...report.target.connectionRoutes.map((route) => `| ${markdownCell(route.targetConnectionName || route.targetConnectionId)} | ${markdownCell(route.sourceKeys.join(', '))} | ${markdownCell(route.compatibleModels.map((model) => model.name).join(', ') || 'none')} | ${markdownCell(route.writeStatus)} |`),
    );
  }
  lines.push(
    '',
    '## Validation',
    '',
    '| Check | Status | Summary |',
    '| --- | --- | --- |',
    ...report.validation.map((item) => `| ${markdownCell(item.category)} | ${markdownCell(item.status)} | ${markdownCell(item.summary)} |`),
  );
  if (report.operationalEvidence?.parity) {
    lines.push(
      '',
      '## Engine Parity',
      '',
      `- Mode: ${report.operationalEvidence.parity.mode}`,
      `- Overall: ${report.operationalEvidence.parity.scores.overall}%`,
      `- Semantic: ${report.operationalEvidence.parity.scores.semantic}%`,
      `- Dashboards: ${report.operationalEvidence.parity.scores.dashboards}%`,
      `- Promotion gate: ${report.operationalEvidence.parity.promotion.promotable ? 'passed' : 'not passed'}`,
    );
  }
  lines.push('', '## Rollback', '', report.deployment.rollback, '');
  return lines.join('\n');
}

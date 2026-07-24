import type { SourceDashboardCatalogItem, SourceDependencyReference, SourceInventory } from './studioApi';
import type {
  DomoManualParseResult,
  MigrationBundle,
  MigrationDashboardBuildPlan,
  MigrationDashboardFilterPlan,
  MigrationDashboardTilePlan,
  MigrationDecision,
  MigrationPlatformKind,
  PowerBiManualParseResult,
  SemanticMigrationFile,
} from './types';

const SENSITIVE_KEY = /(api[_-]?key|authorization|credential|password|secret|token|private[_-]?key)/i;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function cleanString(value: unknown, limit = 2_000): string {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function stringArray(value: unknown, limit = 500): string[] {
  return Array.isArray(value) ? Array.from(new Set(value.flatMap((item) => typeof item === 'string' && item.trim() ? [item.trim().slice(0, 500)] : []))).slice(0, limit) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function contractString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function contractStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(contractString);
}

function nullableContractString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

function contractLayout(value: unknown): value is Record<'x' | 'y' | 'w' | 'h', number> {
  return isRecord(value) && ['x', 'y', 'w', 'h'].every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]));
}

function boundedJsonValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return undefined;
  if (typeof value === 'string') return value.slice(0, 4_000);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => boundedJsonValue(item, depth + 1)).filter((item) => item !== undefined);
  if (!isRecord(value)) return undefined;
  return Object.fromEntries(Object.entries(value).slice(0, 200).flatMap(([key, item]) => {
    if (SENSITIVE_KEY.test(key)) return [];
    const bounded = boundedJsonValue(item, depth + 1);
    return bounded === undefined ? [] : [[key.slice(0, 200), bounded]];
  }));
}

function boundedRecord(value: unknown): Record<string, unknown> | undefined {
  const bounded = boundedJsonValue(value);
  return isRecord(bounded) ? bounded : undefined;
}

export function rawDashboardBuildPlanContractIssues(value: unknown, selectedDashboards: SourceDashboardCatalogItem[]): string[] {
  if (!Array.isArray(value)) return ['Dashboard planning output must contain a dashboardPlans array.'];
  const issues: string[] = [];
  const selectedById = new Map(selectedDashboards.map((dashboard) => [dashboard.id, dashboard]));
  const counts = new Map<string, number>();
  const planIdCounts = new Map<string, number>();

  value.forEach((item, planIndex) => {
    const label = `Dashboard plan ${planIndex + 1}`;
    if (!isRecord(item)) {
      issues.push(`${label} must be an object.`);
      return;
    }
    const sourceDashboardId = contractString(item.sourceDashboardId) ? item.sourceDashboardId.trim() : '';
    const dependencyIds = contractStringArray(item.dependencyIds) ? item.dependencyIds : null;
    if (!contractString(item.id)) issues.push(`${label} is missing id.`);
    else planIdCounts.set(item.id.trim(), (planIdCounts.get(item.id.trim()) || 0) + 1);
    if (!sourceDashboardId) issues.push(`${label} is missing sourceDashboardId.`);
    if (!contractString(item.targetName)) issues.push(`${label} is missing targetName.`);
    if (!nullableContractString(item.targetFolderPath)) issues.push(`${label} targetFolderPath must be a string or null.`);
    if (!nullableContractString(item.description)) issues.push(`${label} description must be a string or null.`);
    if (!contractStringArray(item.sourceEvidenceIds)) issues.push(`${label} sourceEvidenceIds must be a string array.`);
    if (!dependencyIds) issues.push(`${label} dependencyIds must be a string array.`);
    if (!contractStringArray(item.unsupportedFeatures)) issues.push(`${label} unsupportedFeatures must be a string array.`);
    if (!contractStringArray(item.validationAssertions)) issues.push(`${label} validationAssertions must be a string array.`);

    if (sourceDashboardId) {
      counts.set(sourceDashboardId, (counts.get(sourceDashboardId) || 0) + 1);
      const dashboard = selectedById.get(sourceDashboardId);
      if (!dashboard) issues.push(`${label} references unselected dashboard ${sourceDashboardId}.`);
      if (contractStringArray(item.sourceEvidenceIds) && !item.sourceEvidenceIds.includes(sourceDashboardId)) {
        issues.push(`${label} does not include ${sourceDashboardId} in sourceEvidenceIds.`);
      }
      if (dashboard && dependencyIds) {
        const missingDependencies = dashboard.dependencyIds.filter((id) => !dependencyIds.includes(id));
        if (missingDependencies.length > 0) issues.push(`${label} omits required dependencies: ${missingDependencies.join(', ')}.`);
      }
    }

    const declaredFilterIds: string[] = [];
    if (!Array.isArray(item.filters)) {
      issues.push(`${label} filters must be an array.`);
    } else {
      item.filters.forEach((filter, filterIndex) => {
        const filterLabel = `${label} filter ${filterIndex + 1}`;
        if (!isRecord(filter)) {
          issues.push(`${filterLabel} must be an object.`);
          return;
        }
        if (!contractString(filter.id)) issues.push(`${filterLabel} is missing id.`);
        else declaredFilterIds.push(filter.id.trim());
        if (!contractString(filter.label)) issues.push(`${filterLabel} is missing label.`);
        if (!nullableContractString(filter.sourceField)) issues.push(`${filterLabel} sourceField must be a string or null.`);
        if (!nullableContractString(filter.targetField)) issues.push(`${filterLabel} targetField must be a string or null.`);
        if (filter.operator !== undefined && !contractString(filter.operator)) issues.push(`${filterLabel} operator must be a non-empty string.`);
        if (filter.values !== undefined && !contractStringArray(filter.values)) issues.push(`${filterLabel} values must be a string array.`);
        if (filter.isNegative !== undefined && typeof filter.isNegative !== 'boolean') issues.push(`${filterLabel} isNegative must be boolean.`);
        if (filter.sourceEvidenceIds !== undefined && !contractStringArray(filter.sourceEvidenceIds)) issues.push(`${filterLabel} sourceEvidenceIds must be a string array.`);
        if (typeof filter.required !== 'boolean') issues.push(`${filterLabel} required must be boolean.`);
        if (filter.sourceFilterType !== undefined && !contractString(filter.sourceFilterType)) issues.push(`${filterLabel} sourceFilterType must be a non-empty string.`);
      });
      const duplicateFilterIds = declaredFilterIds.filter((id, index, values) => values.indexOf(id) !== index);
      if (duplicateFilterIds.length > 0) issues.push(`${label} repeats filter ids: ${Array.from(new Set(duplicateFilterIds)).join(', ')}.`);
    }

    if (!Array.isArray(item.tiles) || item.tiles.length === 0) {
      issues.push(`${label} must contain at least one tile.`);
    } else {
      const tileIds: string[] = [];
      item.tiles.forEach((tile, tileIndex) => {
        const tileLabel = `${label} tile ${tileIndex + 1}`;
        if (!isRecord(tile)) {
          issues.push(`${tileLabel} must be an object.`);
          return;
        }
        if (!contractString(tile.id)) issues.push(`${tileLabel} is missing id.`);
        else tileIds.push(tile.id.trim());
        if (!contractString(tile.title)) issues.push(`${tileLabel} is missing title.`);
        if (!nullableContractString(tile.description)) issues.push(`${tileLabel} description must be a string or null.`);
        if (!contractStringArray(tile.sourceEvidenceIds)) issues.push(`${tileLabel} sourceEvidenceIds must be a string array.`);
        if (!contractStringArray(tile.fields)) issues.push(`${tileLabel} fields must be a string array.`);
        const sourceKind = contractString(tile.sourceKind) ? tile.sourceKind : 'query';
        const migrationOutcome = contractString(tile.migrationOutcome) ? tile.migrationOutcome : 'generated';
        if (tile.sourceKind !== undefined && !['query', 'text', 'markdown', 'image'].includes(String(tile.sourceKind))) issues.push(`${tileLabel} sourceKind is invalid.`);
        if (tile.migrationOutcome !== undefined && !['generated', 'mapped', 'redesign', 'manual', 'waived', 'blocked'].includes(String(tile.migrationOutcome))) issues.push(`${tileLabel} migrationOutcome is invalid.`);
        if (sourceKind === 'query' && migrationOutcome === 'generated' && contractStringArray(tile.fields) && tile.fields.length === 0) issues.push(`${tileLabel} generated query must contain at least one field that is visible in the destination.`);
        if (!contractStringArray(tile.filters)) issues.push(`${tileLabel} filters must be a string array.`);
        else {
          const unknownFilters = tile.filters.filter((id) => !declaredFilterIds.includes(id));
          if (unknownFilters.length > 0) issues.push(`${tileLabel} references undeclared filters: ${Array.from(new Set(unknownFilters)).join(', ')}.`);
        }
        if (tile.queryTopic !== undefined && !contractString(tile.queryTopic)) issues.push(`${tileLabel} queryTopic must be a non-empty string.`);
        if (tile.queryFilters !== undefined && (!Array.isArray(tile.queryFilters) || !tile.queryFilters.every((filter) => isRecord(filter) && contractString(filter.id) && contractString(filter.field) && contractString(filter.operator) && contractStringArray(filter.values) && typeof filter.isNegative === 'boolean'))) issues.push(`${tileLabel} queryFilters must contain complete structured filters.`);
        if (tile.sorts !== undefined && (!Array.isArray(tile.sorts) || !tile.sorts.every(isRecord))) issues.push(`${tileLabel} sorts must be an object array.`);
        if (tile.limit !== undefined && (!Number.isFinite(tile.limit) || Number(tile.limit) < 0)) issues.push(`${tileLabel} limit must be a non-negative number.`);
        if (tile.pivots !== undefined && !contractStringArray(tile.pivots)) issues.push(`${tileLabel} pivots must be a string array.`);
        if (tile.pivotStrategy !== undefined && !['none', 'table_query', 'chart_series', 'decision_required'].includes(String(tile.pivotStrategy))) issues.push(`${tileLabel} pivotStrategy is invalid.`);
        if (tile.filterExpression !== undefined && !nullableContractString(tile.filterExpression)) issues.push(`${tileLabel} filterExpression must be a string or null.`);
        if (tile.hiddenFields !== undefined && !contractStringArray(tile.hiddenFields)) issues.push(`${tileLabel} hiddenFields must be a string array.`);
        if (tile.calculationDependencies !== undefined && !contractStringArray(tile.calculationDependencies)) issues.push(`${tileLabel} calculationDependencies must be a string array.`);
        if (tile.dynamicFields !== undefined && (!Array.isArray(tile.dynamicFields) || !tile.dynamicFields.every((field) => isRecord(field)
          && contractString(field.id)
          && contractString(field.name)
          && ['group_by', 'filtered_measure', 'table_calculation', 'expression', 'unknown'].includes(String(field.category))
          && ['automatic', 'decision_required', 'manual', 'unsupported'].includes(String(field.supportOutcome))
          && isRecord(field.filters)
          && contractStringArray(field.dependencies)
          && isRecord(field.config)))) issues.push(`${tileLabel} dynamicFields must contain complete typed migration outcomes.`);
        if (tile.visualizationConfig !== undefined && !isRecord(tile.visualizationConfig)) issues.push(`${tileLabel} visualizationConfig must be an object.`);
        if (tile.layout !== undefined && !contractLayout(tile.layout)) issues.push(`${tileLabel} layout must contain numeric x, y, w, and h.`);
        if (!contractString(tile.visualType)) issues.push(`${tileLabel} is missing visualType.`);
        if (!contractString(tile.buildInstructions)) issues.push(`${tileLabel} is missing buildInstructions.`);
        if (!contractStringArray(tile.validationAssertions)) issues.push(`${tileLabel} validationAssertions must be a string array.`);
        if (contractStringArray(tile.sourceEvidenceIds)) {
          const duplicateEvidenceIds = tile.sourceEvidenceIds.filter((id, index, values) => values.indexOf(id) !== index);
          if (duplicateEvidenceIds.length > 0) issues.push(`${tileLabel} repeats visual evidence: ${Array.from(new Set(duplicateEvidenceIds)).join(', ')}.`);
        }
      });
      const duplicateTileIds = tileIds.filter((id, index, values) => values.indexOf(id) !== index);
      if (duplicateTileIds.length > 0) issues.push(`${label} repeats tile ids: ${Array.from(new Set(duplicateTileIds)).join(', ')}.`);
      if (item.filterBindings !== undefined) {
        if (!Array.isArray(item.filterBindings)) {
          issues.push(`${label} filterBindings must be an array.`);
        } else {
          const pairs = new Map<string, number>();
          item.filterBindings.forEach((binding, bindingIndex) => {
            const bindingLabel = `${label} filter binding ${bindingIndex + 1}`;
            if (!isRecord(binding)) {
              issues.push(`${bindingLabel} must be an object.`);
              return;
            }
            const filterId = contractString(binding.dashboardFilterId) ? binding.dashboardFilterId.trim() : '';
            const tileId = contractString(binding.tileId) ? binding.tileId.trim() : '';
            if (!contractString(binding.id)) issues.push(`${bindingLabel} is missing id.`);
            if (!filterId || !declaredFilterIds.includes(filterId)) issues.push(`${bindingLabel} references an unknown dashboard filter.`);
            if (!tileId || !tileIds.includes(tileId)) issues.push(`${bindingLabel} references an unknown tile.`);
            if (!contractString(binding.dashboardFilterLabel)) issues.push(`${bindingLabel} is missing dashboardFilterLabel.`);
            if (typeof binding.excluded !== 'boolean') issues.push(`${bindingLabel} excluded must be boolean.`);
            if (binding.excluded === true && contractString(binding.targetField)) issues.push(`${bindingLabel} cannot assign targetField when excluded.`);
            if (binding.excluded === false && !contractString(binding.targetField)) issues.push(`${bindingLabel} must assign targetField when included.`);
            if (filterId && tileId) {
              const pair = `${filterId}\u0000${tileId}`;
              pairs.set(pair, (pairs.get(pair) || 0) + 1);
            }
          });
          declaredFilterIds.forEach((filterId) => tileIds.forEach((tileId) => {
            const count = pairs.get(`${filterId}\u0000${tileId}`) || 0;
            if (count === 0) issues.push(`${label} is missing a filter listener outcome for ${filterId} and ${tileId}.`);
            if (count > 1) issues.push(`${label} repeats the filter listener outcome for ${filterId} and ${tileId}.`);
          }));
        }
      }
    }
  });

  planIdCounts.forEach((count, id) => {
    if (count > 1) issues.push(`Dashboard planning output repeats plan id ${id} ${count} times.`);
  });

  selectedDashboards.forEach((dashboard) => {
    const count = counts.get(dashboard.id) || 0;
    if (count === 0) issues.push(`Missing dashboard plan for ${dashboard.name}.`);
    if (count > 1) issues.push(`Duplicate dashboard plans returned for ${dashboard.name}.`);
  });
  return Array.from(new Set(issues));
}

function normalizeFilters(value: unknown, planId: string): MigrationDashboardFilterPlan[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).flatMap((item, index) => {
    const row = asRecord(item);
    const label = cleanString(row.label || row.name, 200);
    if (!label) return [];
    return [{
      id: cleanString(row.id, 200) || `${planId}:filter:${index + 1}`,
      label,
      sourceField: cleanString(row.sourceField, 500) || undefined,
      targetField: cleanString(row.targetField, 500) || undefined,
      operator: cleanString(row.operator, 100) || undefined,
      values: stringArray(row.values),
      isNegative: typeof row.isNegative === 'boolean' ? row.isNegative : undefined,
      sourceEvidenceIds: stringArray(row.sourceEvidenceIds),
      required: row.required !== false,
      sourceFilterType: cleanString(row.sourceFilterType, 100) || undefined,
    }];
  });
}

function normalizeTiles(value: unknown, planId: string): MigrationDashboardTilePlan[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 200).flatMap((item, index) => {
    const row = asRecord(item);
    const title = cleanString(row.title || row.name, 300);
    if (!title) return [];
    return [{
      id: cleanString(row.id, 200) || `${planId}:tile:${index + 1}`,
      title,
      description: cleanString(row.description, 2_000) || undefined,
      sourceEvidenceIds: stringArray(row.sourceEvidenceIds),
      sourceKind: ['query', 'text', 'markdown', 'image'].includes(cleanString(row.sourceKind, 50))
        ? cleanString(row.sourceKind, 50) as MigrationDashboardTilePlan['sourceKind']
        : undefined,
      migrationOutcome: ['generated', 'mapped', 'redesign', 'manual', 'waived', 'blocked'].includes(cleanString(row.migrationOutcome, 50))
        ? cleanString(row.migrationOutcome, 50) as MigrationDashboardTilePlan['migrationOutcome']
        : undefined,
      fields: stringArray(row.fields),
      filters: stringArray(row.filters),
      queryTopic: cleanString(row.queryTopic, 500) || undefined,
      queryFilters: Array.isArray(row.queryFilters) ? row.queryFilters.slice(0, 100).flatMap((item, filterIndex) => {
        const filter = asRecord(item);
        const field = cleanString(filter.field, 500);
        if (!field) return [];
        return [{
          id: cleanString(filter.id, 200) || `${planId}:tile:${index + 1}:filter:${filterIndex + 1}`,
          field,
          operator: cleanString(filter.operator, 100) || 'default',
          values: stringArray(filter.values),
          isNegative: filter.isNegative === true,
        }];
      }) : [],
      sorts: Array.isArray(row.sorts) ? row.sorts.slice(0, 100).flatMap((sort) => {
        const bounded = boundedRecord(sort);
        return bounded ? [bounded] : [];
      }) : [],
      limit: Number.isFinite(row.limit) && Number(row.limit) >= 0 ? Number(row.limit) : undefined,
      pivots: stringArray(row.pivots),
      pivotStrategy: ['none', 'table_query', 'chart_series', 'decision_required'].includes(cleanString(row.pivotStrategy, 50))
        ? cleanString(row.pivotStrategy, 50) as MigrationDashboardTilePlan['pivotStrategy']
        : undefined,
      filterExpression: cleanString(row.filterExpression, 4_000) || undefined,
      hiddenFields: stringArray(row.hiddenFields),
      calculationDependencies: stringArray(row.calculationDependencies),
      queryOrigin: ['inline', 'result_maker', 'saved_look', 'query_id', 'unknown'].includes(cleanString(row.queryOrigin, 50))
        ? cleanString(row.queryOrigin, 50) as MigrationDashboardTilePlan['queryOrigin']
        : undefined,
      sourceLookId: cleanString(row.sourceLookId, 300) || undefined,
      sourceQueryId: cleanString(row.sourceQueryId, 300) || undefined,
      sourceModel: cleanString(row.sourceModel, 500) || undefined,
      sourceExplore: cleanString(row.sourceExplore, 500) || undefined,
      dynamicFields: Array.isArray(row.dynamicFields) ? row.dynamicFields.slice(0, 200).flatMap((item, dynamicIndex) => {
        const field = asRecord(item);
        const name = cleanString(field.name, 300);
        const category = cleanString(field.category, 50);
        const supportOutcome = cleanString(field.supportOutcome, 50);
        if (!name || !['group_by', 'filtered_measure', 'table_calculation', 'expression', 'unknown'].includes(category)
          || !['automatic', 'decision_required', 'manual', 'unsupported'].includes(supportOutcome)) return [];
        const filters = asRecord(field.filters);
        return [{
          id: cleanString(field.id, 300) || `${planId}:tile:${index + 1}:dynamic:${dynamicIndex + 1}`,
          name,
          label: cleanString(field.label, 300) || undefined,
          category: category as NonNullable<MigrationDashboardTilePlan['dynamicFields']>[number]['category'],
          expression: cleanString(field.expression, 4_000) || undefined,
          basedOn: cleanString(field.basedOn, 500) || undefined,
          filters: Object.fromEntries(Object.entries(filters).flatMap(([key, filterValue]) => typeof filterValue === 'string' ? [[key.slice(0, 300), filterValue.slice(0, 1_000)]] : [])),
          dependencies: stringArray(field.dependencies),
          supportOutcome: supportOutcome as NonNullable<MigrationDashboardTilePlan['dynamicFields']>[number]['supportOutcome'],
          config: boundedRecord(field.config) || {},
        }];
      }) : [],
      visualizationConfig: boundedRecord(row.visualizationConfig),
      layout: contractLayout(row.layout) ? {
        x: Number(row.layout.x), y: Number(row.layout.y), w: Number(row.layout.w), h: Number(row.layout.h),
      } : undefined,
      visualType: cleanString(row.visualType, 100) || 'table',
      buildInstructions: cleanString(row.buildInstructions, 4_000) || `Build ${title} from the reviewed target model fields.`,
      validationAssertions: stringArray(row.validationAssertions, 100),
    }];
  });
}

export function normalizeDashboardBuildPlans(value: unknown, selectedDashboards: SourceDashboardCatalogItem[]): MigrationDashboardBuildPlan[] {
  const selectedById = new Map(selectedDashboards.map((dashboard) => [dashboard.id, dashboard]));
  return (Array.isArray(value) ? value : []).map((item, index) => {
    const row = asRecord(item);
    const sourceDashboardId = cleanString(row.sourceDashboardId, 500) || `invalid-dashboard-plan:${index + 1}`;
    const dashboard = selectedById.get(sourceDashboardId);
    const sourceDashboardName = dashboard?.name || cleanString(row.sourceDashboardName, 300) || sourceDashboardId;
    const id = cleanString(row.id, 500) || `dashboard-plan:${sourceDashboardId}:${index + 1}`;
    return {
      id,
      sourceDashboardId,
      sourceDashboardName,
      sourcePath: dashboard?.path || cleanString(row.sourcePath, 1_000) || undefined,
      sourceEvidenceIds: Array.from(new Set([sourceDashboardId, ...stringArray(row.sourceEvidenceIds)])),
      dependencyIds: Array.from(new Set([...(dashboard?.dependencyIds || []), ...stringArray(row.dependencyIds)])).sort(),
      targetName: cleanString(row.targetName, 300) || sourceDashboardName,
      targetFolderPath: cleanString(row.targetFolderPath, 1_000) || undefined,
      description: cleanString(row.description, 2_000) || undefined,
      filters: normalizeFilters(row.filters, id),
      filterBindings: Array.isArray(row.filterBindings) ? row.filterBindings.slice(0, 500).flatMap((item, bindingIndex) => {
        const binding = asRecord(item);
        const dashboardFilterId = cleanString(binding.dashboardFilterId, 300);
        const tileId = cleanString(binding.tileId, 300);
        if (!dashboardFilterId || !tileId) return [];
        return [{
          id: cleanString(binding.id, 300) || `${id}:binding:${bindingIndex + 1}`,
          dashboardFilterId,
          dashboardFilterLabel: cleanString(binding.dashboardFilterLabel, 300) || dashboardFilterId,
          tileId,
          targetField: cleanString(binding.targetField, 500) || undefined,
          excluded: binding.excluded === true,
        }];
      }) : undefined,
      filterOrder: stringArray(row.filterOrder),
      tileOrder: stringArray(row.tileOrder),
      sourceFolderPath: cleanString(row.sourceFolderPath, 1_000) || undefined,
      sourceOwner: cleanString(row.sourceOwner, 500) || undefined,
      sourceUpdatedAt: cleanString(row.sourceUpdatedAt, 100) || undefined,
      sourceUsageCount: Number.isFinite(row.sourceUsageCount) && Number(row.sourceUsageCount) >= 0 ? Number(row.sourceUsageCount) : undefined,
      tiles: normalizeTiles(row.tiles, id),
      unsupportedFeatures: stringArray(row.unsupportedFeatures, 200),
      validationAssertions: stringArray(row.validationAssertions, 200),
    };
  }).sort((a, b) => a.sourceDashboardName.localeCompare(b.sourceDashboardName) || a.sourceDashboardId.localeCompare(b.sourceDashboardId));
}

export function mergeDeterministicDashboardPlanEvidence(
  plans: MigrationDashboardBuildPlan[],
  deterministicPlans: MigrationDashboardBuildPlan[],
): MigrationDashboardBuildPlan[] {
  const deterministicByDashboard = new Map(deterministicPlans.map((plan) => [plan.sourceDashboardId, plan]));
  return plans.map((plan) => {
    const deterministic = deterministicByDashboard.get(plan.sourceDashboardId);
    if (!deterministic) return plan;
    const deterministicFilters = new Map(deterministic.filters.map((filter) => [filter.id, filter]));
    const mergedFilters = Array.from(new Map([
      ...deterministic.filters,
      ...plan.filters.map((filter) => {
        const source = deterministicFilters.get(filter.id);
        return source ? {
          ...filter,
          operator: source.operator,
          values: source.values,
          isNegative: source.isNegative,
          sourceEvidenceIds: source.sourceEvidenceIds,
        } : filter;
      }),
    ].map((filter) => [filter.id, filter])).values());
    const deterministicTiles = new Map(deterministic.tiles.map((tile) => [tile.id, tile]));
    const mergedTiles = plan.tiles.map((tile) => {
      const source = deterministicTiles.get(tile.id)
        || deterministic.tiles.find((candidate) => candidate.sourceEvidenceIds.some((id) => tile.sourceEvidenceIds.includes(id)));
      if (!source) return tile;
      return {
        ...tile,
        sourceEvidenceIds: Array.from(new Set([...source.sourceEvidenceIds, ...tile.sourceEvidenceIds])),
        fields: [...source.fields],
        filters: [...source.filters],
        queryTopic: source.queryTopic,
        queryFilters: source.queryFilters?.map((filter) => ({ ...filter, values: [...filter.values] })),
        sorts: source.sorts?.map((sort) => ({ ...sort })),
        limit: source.limit,
        pivots: source.pivots ? [...source.pivots] : undefined,
        sourceKind: source.sourceKind,
        migrationOutcome: source.migrationOutcome,
        pivotStrategy: source.pivotStrategy,
        filterExpression: source.filterExpression,
        hiddenFields: source.hiddenFields ? [...source.hiddenFields] : undefined,
        calculationDependencies: source.calculationDependencies ? [...source.calculationDependencies] : undefined,
        queryOrigin: source.queryOrigin,
        sourceLookId: source.sourceLookId,
        sourceQueryId: source.sourceQueryId,
        sourceModel: source.sourceModel,
        sourceExplore: source.sourceExplore,
        dynamicFields: source.dynamicFields?.map((field) => ({
          ...field,
          filters: { ...field.filters },
          dependencies: [...field.dependencies],
          config: { ...field.config },
        })),
        visualizationConfig: source.visualizationConfig ? { ...source.visualizationConfig } : undefined,
        layout: source.layout ? { ...source.layout } : undefined,
        visualType: source.visualType,
      };
    });
    return {
      ...plan,
      sourceEvidenceIds: Array.from(new Set([...deterministic.sourceEvidenceIds, ...plan.sourceEvidenceIds])),
      dependencyIds: Array.from(new Set([...deterministic.dependencyIds, ...plan.dependencyIds])).sort(),
      filters: mergedFilters,
      filterBindings: deterministic.filterBindings?.map((binding) => ({ ...binding })),
      filterOrder: deterministic.filterOrder ? [...deterministic.filterOrder] : undefined,
      tileOrder: deterministic.tileOrder ? [...deterministic.tileOrder] : undefined,
      sourceFolderPath: deterministic.sourceFolderPath,
      sourceOwner: deterministic.sourceOwner,
      sourceUpdatedAt: deterministic.sourceUpdatedAt,
      sourceUsageCount: deterministic.sourceUsageCount,
      tiles: mergedTiles,
      unsupportedFeatures: Array.from(new Set([...deterministic.unsupportedFeatures, ...plan.unsupportedFeatures])),
    };
  });
}

function catalogDependency(input: {
  id: string;
  name: string;
  kind: SourceDependencyReference['kind'];
  category: SourceDependencyReference['category'];
  reason: string;
}): SourceDependencyReference {
  return { assetId: input.id, name: input.name, kind: input.kind, category: input.category, required: true, reason: input.reason };
}

function catalogKey(prefix: string, value: string): string {
  return `powerbi:${prefix}:${value}`.toLowerCase().replace(/[^a-z0-9:_-]+/g, '_');
}

export function powerBiVisualEvidenceId(reportId: string, pageId: string, visualId: string): string {
  return catalogKey('visual', `${reportId}:${pageId}:${visualId}`);
}

export function powerBiSelectedReportEvidence(result: PowerBiManualParseResult | null, selectedDashboardIds: string[]) {
  const selected = new Set(selectedDashboardIds);
  const matched = (result?.projects || []).flatMap((project) => project.reports
    .filter((report) => selected.has(report.id))
    .map((report) => ({ project, report })))
    .sort((a, b) => a.report.id.localeCompare(b.report.id));
  const reports = matched.map(({ project, report }) => ({
    projectId: project.id,
    projectName: project.name,
    semanticModelIds: [...project.semanticModelIds].sort(),
    reportId: report.id,
    reportName: report.name,
    datasetId: report.datasetId,
    sourceArtifact: report.sourceArtifact,
    filters: [...report.filters].sort(),
    pages: [...report.pages].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)).map((page) => ({
      pageId: page.id,
      pageName: page.displayName,
      order: page.order,
      sourceArtifact: page.sourceArtifact,
      canvas: page.width != null && page.height != null ? { width: page.width, height: page.height } : undefined,
      filters: [...page.filters].sort(),
      drillthroughFields: [...page.drillthroughFields].sort(),
      visuals: [...page.visuals].sort((a, b) => a.id.localeCompare(b.id)).map((visual) => ({
        evidenceId: powerBiVisualEvidenceId(report.id, page.id, visual.id),
        visualId: visual.id,
        title: visual.title || visual.name,
        visualType: visual.visualType,
        sourceArtifact: visual.sourceArtifact,
        fields: [...visual.fields],
        fieldBindings: [...(visual.fieldBindings || [])].sort((a, b) => a.role.localeCompare(b.role) || a.field.localeCompare(b.field)),
        filters: [...visual.filters].sort(),
        position: visual.position,
        query: visual.query,
        formatting: visual.formatting,
        unsupportedReasons: [...visual.unsupportedReasons],
      })),
    })),
  }));
  return {
    schemaVersion: 'omnikit.powerbi.selected-report-evidence.v1' as const,
    selectedDashboardIds: [...selected].sort(),
    reports,
    truncated: false,
  };
}

export type PowerBiSelectedReportEvidence = ReturnType<typeof powerBiSelectedReportEvidence>;
export type PowerBiSelectedReportEvidenceChunk = PowerBiSelectedReportEvidence & {
  chunk: { index: number; total: number; reportId: string; expectedVisualIds: string[] };
};

export interface DashboardVisualEvidenceCatalog {
  expectedVisualIds: string[];
  fieldsByVisualId: Record<string, string[]>;
}

export interface DashboardCanonicalFieldEvidenceCatalog {
  fieldsByDashboardId: Record<string, string[]>;
}

function normalizedFieldReference(value: string): string {
  return value.trim().toLowerCase().replace(/\[/g, '').replace(/\]/g, '').replace(/['"`]/g, '').replace(/\s+/g, ' ');
}

export function dashboardVisualEvidenceCatalog(evidence: PowerBiSelectedReportEvidence): DashboardVisualEvidenceCatalog {
  const rows = evidence.reports.flatMap((report) => report.pages.flatMap((page) => page.visuals.map((visual) => ({
    id: visual.evidenceId,
    fields: Array.from(new Set([...visual.fields, ...visual.fieldBindings.map((binding) => binding.field)])).sort(),
  }))));
  return {
    expectedVisualIds: rows.map((row) => row.id).sort(),
    fieldsByVisualId: Object.fromEntries(rows.map((row) => [row.id, row.fields])),
  };
}

export function powerBiSelectedReportEvidenceChunks(
  result: PowerBiManualParseResult | null,
  selectedDashboardIds: string[],
  maxEvidenceCharacters = 180_000,
): PowerBiSelectedReportEvidenceChunk[] {
  const complete = powerBiSelectedReportEvidence(result, selectedDashboardIds);
  const pending: Array<Omit<PowerBiSelectedReportEvidenceChunk, 'chunk'> & { reportId: string; expectedVisualIds: string[] }> = [];
  const characterLimit = Math.max(20_000, maxEvidenceCharacters);

  complete.reports.forEach((report) => {
    const emptyPages = report.pages.filter((page) => page.visuals.length === 0).map((page) => ({ ...page, visuals: [] }));
    let pages: typeof report.pages = [];
    let expectedVisualIds: string[] = [];
    let characters = 0;
    const flush = () => {
      if (pages.length === 0 && expectedVisualIds.length === 0) return;
      pending.push({
        schemaVersion: complete.schemaVersion,
        selectedDashboardIds: [report.reportId],
        reports: [{ ...report, pages }],
        truncated: false,
        reportId: report.reportId,
        expectedVisualIds,
      });
      pages = [];
      expectedVisualIds = [];
      characters = 0;
    };

    report.pages.forEach((page) => {
      page.visuals.forEach((visual) => {
        const visualCharacters = JSON.stringify(visual).length;
        if (visualCharacters > characterLimit) {
          throw new Error(`Power BI visual ${visual.title || visual.visualId} contains ${visualCharacters.toLocaleString()} characters of indivisible query or formatting evidence, above the ${characterLimit.toLocaleString()} character evidence-unit limit. Reduce the visual definition or migrate this report separately; OmniKit did not shorten it.`);
        }
        if (expectedVisualIds.length > 0 && characters + visualCharacters > characterLimit) flush();
        let chunkPage = pages.find((candidate) => candidate.pageId === page.pageId);
        if (!chunkPage) {
          chunkPage = { ...page, visuals: [] };
          pages.push(chunkPage);
        }
        chunkPage.visuals.push(visual);
        expectedVisualIds.push(visual.evidenceId);
        characters += visualCharacters;
      });
    });
    if (expectedVisualIds.length > 0) {
      if (emptyPages.length > 0) pages.push(...emptyPages);
      flush();
    } else {
      pages = emptyPages;
      flush();
    }
  });

  return pending.map(({ reportId, expectedVisualIds, ...evidence }, index) => ({
    ...evidence,
    chunk: { index: index + 1, total: pending.length, reportId, expectedVisualIds },
  }));
}

export function dashboardPlanScopeIssues(
  plans: MigrationDashboardBuildPlan[],
  selectedDashboards: SourceDashboardCatalogItem[],
  expectedVisualIds: string[] = [],
  evidenceCatalog?: DashboardVisualEvidenceCatalog,
  approvedDecisions: MigrationDecision[] = [],
  canonicalFieldCatalog?: DashboardCanonicalFieldEvidenceCatalog,
): string[] {
  const selectedIds = new Set(selectedDashboards.map((dashboard) => dashboard.id));
  const counts = plans.reduce((result, plan) => result.set(plan.sourceDashboardId, (result.get(plan.sourceDashboardId) || 0) + 1), new Map<string, number>());
  const visualReferences = plans.flatMap((plan) => plan.tiles.flatMap((tile) => tile.sourceEvidenceIds
    .filter((id) => id.startsWith('powerbi:visual:') || id.startsWith('domo:card:'))
    .map((id) => ({ id, plan, tile }))));
  const visualCounts = visualReferences.reduce((result, reference) => result.set(reference.id, (result.get(reference.id) || 0) + 1), new Map<string, number>());
  const referencedVisualIds = new Set(visualReferences.map((reference) => reference.id));
  const expectedSet = new Set(expectedVisualIds);
  const approvedAliases = approvedDecisions.filter((decision) => decision.approvedByUser && ['map_existing', 'create_new', 'rewrite'].includes(decision.action)).flatMap((decision) => {
    const source = normalizedFieldReference(decision.sourceLabel);
    return [decision.targetLabel, decision.targetId].filter((value): value is string => Boolean(value?.trim())).map((target) => ({ source, target: normalizedFieldReference(target) }));
  });
  const fieldIssues = evidenceCatalog ? plans.flatMap((plan) => plan.tiles.flatMap((tile) => {
    const visualIds = tile.sourceEvidenceIds.filter((id) => expectedSet.has(id));
    if (visualIds.length === 0) return [];
    const sourceFields = Array.from(new Set(visualIds.flatMap((id) => evidenceCatalog.fieldsByVisualId[id] || [])));
    const canonicalFields = canonicalFieldCatalog?.fieldsByDashboardId[plan.sourceDashboardId] || [];
    const allowed = new Set([...sourceFields, ...canonicalFields].map(normalizedFieldReference));
    approvedAliases.forEach((alias) => {
      if (allowed.has(alias.source)) allowed.add(alias.target);
    });
    return tile.fields.filter((field) => !allowed.has(normalizedFieldReference(field))).map((field) => `Dashboard ${plan.sourceDashboardName}, tile ${tile.title}, references unproven field ${field}; expected evidence from its visual, selected canonical dependency scope, or an approved field decision.`);
  })) : [];
  return [
    ...selectedDashboards.filter((dashboard) => !counts.has(dashboard.id)).map((dashboard) => `Missing dashboard plan for ${dashboard.name}.`),
    ...selectedDashboards.filter((dashboard) => (counts.get(dashboard.id) || 0) > 1).map((dashboard) => `Duplicate dashboard plans returned for ${dashboard.name}.`),
    ...plans.filter((plan) => !selectedIds.has(plan.sourceDashboardId)).map((plan) => `Out-of-scope dashboard plan returned for ${plan.sourceDashboardId}.`),
    ...plans.filter((plan) => plan.tiles.length === 0 || plan.tiles.some((tile) => dashboardTileRequiresFields(tile) && tile.fields.length === 0)).map((plan) => `Dashboard plan ${plan.sourceDashboardName} has a generated query tile without visible field bindings.`),
    ...plans.flatMap((plan) => plan.tiles.filter((tile) => tile.migrationOutcome === 'blocked').map((tile) => `Dashboard ${plan.sourceDashboardName}, tile ${tile.title}, remains blocked and must be redesigned, waived, or excluded before construction.`)),
    ...plans.flatMap(dashboardFilterBindingIssues),
    ...expectedVisualIds.filter((id) => !referencedVisualIds.has(id)).map((id) => `Missing visual plan evidence ${id}.`),
    ...expectedVisualIds.filter((id) => (visualCounts.get(id) || 0) > 1).map((id) => `Duplicate visual plan evidence ${id} is referenced ${(visualCounts.get(id) || 0)} times; exactly one tile binding is required.`),
    ...Array.from(referencedVisualIds).filter((id) => !expectedSet.has(id)).map((id) => `Unknown visual plan evidence ${id}.`),
    ...fieldIssues,
  ];
}

export function dashboardTileRequiresFields(tile: MigrationDashboardTilePlan): boolean {
  return (tile.sourceKind || 'query') === 'query' && (tile.migrationOutcome || 'generated') === 'generated';
}

export function dashboardFilterBindingIssues(plan: MigrationDashboardBuildPlan): string[] {
  if (plan.filterBindings === undefined) return [];
  const filterIds = new Set(plan.filters.map((filter) => filter.id));
  const tileIds = new Set(plan.tiles.map((tile) => tile.id));
  const pairCounts = new Map<string, number>();
  const issues: string[] = [];
  plan.filterBindings.forEach((binding) => {
    const pair = `${binding.dashboardFilterId}\u0000${binding.tileId}`;
    pairCounts.set(pair, (pairCounts.get(pair) || 0) + 1);
    if (!filterIds.has(binding.dashboardFilterId)) issues.push(`Dashboard ${plan.sourceDashboardName} has a filter listener for unknown filter ${binding.dashboardFilterId}.`);
    if (!tileIds.has(binding.tileId)) issues.push(`Dashboard ${plan.sourceDashboardName} has a filter listener for unknown tile ${binding.tileId}.`);
    if (binding.excluded && binding.targetField) issues.push(`Dashboard ${plan.sourceDashboardName} marks ${binding.dashboardFilterLabel} excluded from a tile but also assigns target field ${binding.targetField}.`);
    if (!binding.excluded && !binding.targetField?.trim()) issues.push(`Dashboard ${plan.sourceDashboardName} includes ${binding.dashboardFilterLabel} on a tile without a target field.`);
  });
  plan.filters.forEach((filter) => {
    plan.tiles.forEach((tile) => {
      const count = pairCounts.get(`${filter.id}\u0000${tile.id}`) || 0;
      if (count === 0) issues.push(`Dashboard ${plan.sourceDashboardName} is missing the ${filter.label} listener outcome for tile ${tile.title}.`);
      if (count > 1) issues.push(`Dashboard ${plan.sourceDashboardName} repeats the ${filter.label} listener outcome for tile ${tile.title}.`);
    });
  });
  return Array.from(new Set(issues));
}

export interface DashboardPlanReadiness {
  status: 'ready' | 'ready_with_manual_work' | 'blocked';
  label: 'Ready' | 'Ready with manual work' | 'Blocked';
  blockers: string[];
  manualWork: string[];
  generatedTileCount: number;
  manualTileCount: number;
  listenerOutcomeCount: number;
  expectedListenerOutcomeCount: number;
}

export function dashboardPlanReadiness(plan: MigrationDashboardBuildPlan): DashboardPlanReadiness {
  const listenerIssues = dashboardFilterBindingIssues(plan);
  const blockers = [
    ...(plan.tiles.length === 0 ? [`${plan.sourceDashboardName} has no tile outcomes.`] : []),
    ...plan.tiles.filter((tile) => dashboardTileRequiresFields(tile) && tile.fields.length === 0)
      .map((tile) => `${tile.title} is a generated query without visible target fields.`),
    ...plan.tiles.filter((tile) => tile.migrationOutcome === 'blocked')
      .map((tile) => `${tile.title} is blocked.`),
    ...listenerIssues,
  ];
  const manualWork = Array.from(new Set([
    ...plan.unsupportedFeatures,
    ...plan.tiles.filter((tile) => ['manual', 'redesign', 'waived'].includes(tile.migrationOutcome || ''))
      .map((tile) => `${tile.title}: ${(tile.migrationOutcome || 'manual').split('_').join(' ')}`),
    ...plan.tiles.flatMap((tile) => (tile.dynamicFields || [])
      .filter((field) => field.supportOutcome !== 'automatic')
      .map((field) => `${tile.title}: ${field.label || field.name} requires ${field.supportOutcome.split('_').join(' ')}.`)),
    ...plan.tiles.filter((tile) => tile.pivotStrategy === 'decision_required')
      .map((tile) => `${tile.title}: pivot behavior requires a decision.`),
  ]));
  const status = blockers.length > 0 ? 'blocked' : manualWork.length > 0 ? 'ready_with_manual_work' : 'ready';
  return {
    status,
    label: status === 'blocked' ? 'Blocked' : status === 'ready_with_manual_work' ? 'Ready with manual work' : 'Ready',
    blockers: Array.from(new Set(blockers)),
    manualWork,
    generatedTileCount: plan.tiles.filter((tile) => tile.migrationOutcome === 'generated' || tile.migrationOutcome === 'mapped').length,
    manualTileCount: plan.tiles.filter((tile) => ['manual', 'redesign', 'waived'].includes(tile.migrationOutcome || '')).length,
    listenerOutcomeCount: plan.filterBindings?.length || 0,
    expectedListenerOutcomeCount: plan.filters.length * plan.tiles.length,
  };
}

export function mergeDashboardBuildPlanChunks(chunks: MigrationDashboardBuildPlan[][]): MigrationDashboardBuildPlan[] {
  const merged = new Map<string, MigrationDashboardBuildPlan>();
  chunks.flat().forEach((plan) => {
    const current = merged.get(plan.sourceDashboardId);
    if (!current) {
      merged.set(plan.sourceDashboardId, plan);
      return;
    }
    if (current.targetName !== plan.targetName || current.targetFolderPath !== plan.targetFolderPath) {
      throw new Error(`AI planning chunks disagreed on the destination for ${plan.sourceDashboardName}. Rerun planning before continuing.`);
    }
    const filters = new Map(current.filters.map((filter) => [filter.id, filter]));
    plan.filters.forEach((filter) => {
      const existing = filters.get(filter.id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(filter)) {
        throw new Error(`AI planning chunks returned conflicting definitions for filter ${filter.id} in ${plan.sourceDashboardName}. Rerun planning before continuing.`);
      }
      filters.set(filter.id, filter);
    });
    const tiles = new Map(current.tiles.map((tile) => [tile.sourceEvidenceIds.slice().sort().join('|') || `${tile.title}:${tile.fields.join('|')}`, tile]));
    const tilesById = new Map(current.tiles.map((tile) => [tile.id, tile]));
    plan.tiles.forEach((tile) => {
      const existing = tilesById.get(tile.id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(tile)) {
        throw new Error(`AI planning chunks returned conflicting definitions for tile id ${tile.id} in ${plan.sourceDashboardName}. Rerun planning before continuing.`);
      }
      tilesById.set(tile.id, tile);
      tiles.set(tile.sourceEvidenceIds.slice().sort().join('|') || `${tile.title}:${tile.fields.join('|')}`, tile);
    });
    merged.set(plan.sourceDashboardId, {
      ...current,
      sourceEvidenceIds: Array.from(new Set([...current.sourceEvidenceIds, ...plan.sourceEvidenceIds])).sort(),
      dependencyIds: Array.from(new Set([...current.dependencyIds, ...plan.dependencyIds])).sort(),
      filters: Array.from(filters.values()),
      tiles: Array.from(tiles.values()),
      unsupportedFeatures: Array.from(new Set([...current.unsupportedFeatures, ...plan.unsupportedFeatures])).sort(),
      validationAssertions: Array.from(new Set([...current.validationAssertions, ...plan.validationAssertions])).sort(),
    });
  });
  return Array.from(merged.values()).sort((a, b) => a.sourceDashboardName.localeCompare(b.sourceDashboardName) || a.sourceDashboardId.localeCompare(b.sourceDashboardId));
}

export function domoManualDashboardCatalog(result: DomoManualParseResult | null): SourceDashboardCatalogItem[] {
  if (!result) return [];
  const pages = result.inventory.dashboards.filter((dashboard) => dashboard.assetKind === 'page');
  const cards = result.inventory.dashboards.filter((dashboard) => dashboard.assetKind !== 'page');
  const cardsById = new Map(cards.flatMap((card) => card.sourceId ? [[card.sourceId, card] as const] : []));
  const units = pages.length > 0 ? pages : cards;

  return units.map((unit): SourceDashboardCatalogItem => {
    const childCards = unit.assetKind === 'page'
      ? (unit.childIds || []).flatMap((id) => cardsById.get(id) ? [cardsById.get(id)!] : [])
      : [unit];
    const dependencies: SourceDependencyReference[] = [];
    childCards.forEach((card) => {
      if (unit.assetKind === 'page' && card.sourceId) dependencies.push(catalogDependency({
        id: card.sourceId,
        name: card.name,
        kind: 'card',
        category: 'content',
        reason: 'This Card is contained by the selected Domo Page.',
      }));
      if (card.sourceDatasetId) dependencies.push(catalogDependency({
        id: card.sourceDatasetId,
        name: card.sourceDatasetId,
        kind: 'dataset',
        category: 'data_source',
        reason: `Dataset bound to ${card.name}.`,
      }));
      card.fields.forEach((field) => dependencies.push(catalogDependency({
        id: catalogKey('field', `${card.sourceId || card.name}:${field}`),
        name: field,
        kind: 'attribute',
        category: 'field',
        reason: `Field referenced by ${card.name}.`,
      })));
      card.filters.forEach((filter) => dependencies.push(catalogDependency({
        id: catalogKey('filter', `${card.sourceId || card.name}:${filter}`),
        name: filter,
        kind: 'filter',
        category: 'filter',
        reason: `Filter referenced by ${card.name}.`,
      })));
    });

    const datasetIds = new Set(childCards.flatMap((card) => card.sourceDatasetId ? [card.sourceDatasetId] : []));
    result.mappings.filter((mapping) => mapping.sourceKind === 'pdp_policy' && mapping.dependencies.some((dependency) => datasetIds.has(dependency))).forEach((mapping) => dependencies.push(catalogDependency({
      id: mapping.id,
      name: mapping.sourceName,
      kind: 'permission',
      category: 'security',
      reason: 'PDP policy applies to a dataset used by the selected Domo content.',
    })));
    result.mappings.filter((mapping) => mapping.sourceKind === 'schedule_alert' && mapping.dependencies.some((dependency) => dependency === unit.sourceId || childCards.some((card) => card.sourceId === dependency))).forEach((mapping) => dependencies.push(catalogDependency({
      id: mapping.id,
      name: mapping.sourceName,
      kind: 'schedule',
      category: 'schedule',
      reason: 'Schedule or alert references the selected Domo Page or Card.',
    })));

    const deduplicated = Array.from(new Map(dependencies.map((dependency) => [dependency.assetId, dependency])).values());
    const riskFlags = uniqueStrings([
      ...(unit.riskFlags || []),
      ...childCards.flatMap((card) => card.riskFlags || []),
      ...(unit.assetKind === 'page' && childCards.length !== (unit.childIds || []).length ? ['One or more Page Card references were not included in the upload bundle.'] : []),
    ]);
    const counts = deduplicated.reduce<SourceDashboardCatalogItem['dependencyCounts']>((current, dependency) => ({
      ...current,
      [dependency.category]: (current[dependency.category] || 0) + 1,
    }), {});
    const contentLabel = unit.assetKind === 'page' ? `${childCards.length} Card${childCards.length === 1 ? '' : 's'}` : 'Individual Card';
    return {
      id: unit.sourceId || catalogKey(unit.assetKind || 'dashboard', unit.name),
      name: unit.name,
      kind: unit.assetKind === 'page' ? 'page' : 'card',
      path: unit.path || unit.sourceArtifact,
      owner: unit.owner,
      updatedAt: unit.updatedAt,
      usageCount: unit.usageCount,
      dependencyIds: deduplicated.map((dependency) => dependency.assetId),
      dependencies: deduplicated,
      dependencyCounts: counts,
      complexity: riskFlags.length > 0 || childCards.length > 20 ? 'high' : childCards.length > 8 ? 'medium' : 'low',
      coverage: riskFlags.length === 0 && childCards.length > 0 && childCards.every((card) => card.sourceDatasetId && (card.fields.length > 0 || card.chartType)) ? 'complete' : 'partial',
      coverageNotes: [`${contentLabel} recovered from the Domo manual evidence bundle.`, 'Visual layout and interactions remain subject to target reconciliation.'],
      riskFlags,
    };
  }).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export interface DomoSelectedDashboardEvidence {
  schemaVersion: 'omnikit.domo.dashboard-evidence.v1';
  selectedDashboardIds: string[];
  dashboards: Array<{
    sourceDashboardId: string;
    name: string;
    kind: 'page' | 'card';
    sourceArtifact?: string;
    cards: Array<{
      evidenceId: string;
      cardId: string;
      name: string;
      sourceArtifact?: string;
      datasetId?: string;
      fields: string[];
      filters: string[];
      chartType?: string;
      cardType?: string;
      riskFlags: string[];
    }>;
  }>;
}

export function domoSelectedDashboardEvidence(
  result: DomoManualParseResult | null,
  selectedDashboardIds: string[],
): DomoSelectedDashboardEvidence {
  const selected = new Set(selectedDashboardIds);
  const dashboards = result?.inventory.dashboards || [];
  const byId = new Map(dashboards.flatMap((dashboard) => dashboard.sourceId ? [[dashboard.sourceId, dashboard] as const] : []));
  return {
    schemaVersion: 'omnikit.domo.dashboard-evidence.v1',
    selectedDashboardIds: [...selectedDashboardIds].sort(),
    dashboards: dashboards.flatMap((dashboard) => {
      const sourceDashboardId = dashboard.sourceId || '';
      if (!sourceDashboardId || !selected.has(sourceDashboardId)) return [];
      const cards = dashboard.assetKind === 'page'
        ? (dashboard.childIds || []).flatMap((cardId) => byId.get(cardId) ? [byId.get(cardId)!] : [])
        : [dashboard];
      return [{
        sourceDashboardId,
        name: dashboard.name,
        kind: dashboard.assetKind === 'page' ? 'page' as const : 'card' as const,
        sourceArtifact: dashboard.sourceArtifact,
        cards: cards.flatMap((card) => card.sourceId ? [{
          evidenceId: `domo:card:${card.sourceId}`,
          cardId: card.sourceId,
          name: card.name,
          sourceArtifact: card.sourceArtifact,
          datasetId: card.sourceDatasetId,
          fields: [...card.fields],
          filters: [...card.filters],
          chartType: card.chartType,
          cardType: card.cardType,
          riskFlags: [...(card.riskFlags || [])],
        }] : []),
      }];
    }).sort((left, right) => left.name.localeCompare(right.name) || left.sourceDashboardId.localeCompare(right.sourceDashboardId)),
  };
}

export function domoDashboardVisualEvidenceCatalog(evidence: DomoSelectedDashboardEvidence): DashboardVisualEvidenceCatalog {
  const cards = evidence.dashboards.flatMap((dashboard) => dashboard.cards);
  return {
    expectedVisualIds: cards.map((card) => card.evidenceId).sort(),
    fieldsByVisualId: Object.fromEntries(cards.map((card) => [card.evidenceId, Array.from(new Set(card.fields)).sort()])),
  };
}

export function powerBiManualDashboardCatalog(result: PowerBiManualParseResult | null): SourceDashboardCatalogItem[] {
  if (!result) return [];
  const reports = result.projects?.flatMap((project) => project.reports.map((report) => ({ project, report }))) || [];
  if (reports.length === 0) {
    return result.inventory.dashboards.map((dashboard) => ({
      id: dashboard.sourceId || catalogKey('report', dashboard.name),
      name: dashboard.name,
      kind: 'report',
      path: dashboard.sourceArtifact,
      dependencyIds: uniqueStrings([
        dashboard.sourceDatasetId ? catalogKey('model', dashboard.sourceDatasetId) : '',
        ...dashboard.fields.map((field) => catalogKey('field', field)),
        ...dashboard.filters.map((filter) => catalogKey('filter', filter)),
      ]),
      dependencies: [],
      dependencyCounts: { field: dashboard.fields.length, filter: dashboard.filters.length },
      complexity: dashboard.fields.length > 20 ? 'high' : dashboard.fields.length > 8 ? 'medium' : 'low',
      coverage: dashboard.fields.length ? 'partial' : 'export_required',
      coverageNotes: ['Legacy report evidence was detected without a complete enhanced PBIR project; visual layout review is required.'],
      riskFlags: dashboard.fields.length ? [] : ['No visual field references were detected.'],
    }));
  }
  return reports.map(({ project, report }): SourceDashboardCatalogItem => {
    const fieldNames = uniqueStrings(report.pages.flatMap((page) => page.visuals.flatMap((visual) => visual.fields)));
    const filterNames = uniqueStrings([...report.filters, ...report.pages.flatMap((page) => [...page.filters, ...page.visuals.flatMap((visual) => visual.filters)])]);
    const visualDependencies = report.pages.flatMap((page) => page.visuals.map((visual) => catalogDependency({
      id: powerBiVisualEvidenceId(report.id, page.id, visual.id),
      name: visual.title || visual.name,
      kind: 'visual',
      category: 'content',
      reason: `Required to reproduce ${visual.visualType} intent and layout on ${page.displayName}.`,
    })));
    const dependencies: SourceDependencyReference[] = [
      ...(report.datasetId ? [catalogDependency({ id: catalogKey('model', report.datasetId), name: report.datasetId, kind: 'semantic_model', category: 'semantic_model', reason: 'The report is bound to this Power BI semantic model.' })] : []),
      ...fieldNames.map((field) => catalogDependency({ id: catalogKey('field', field), name: field, kind: 'attribute', category: 'field', reason: 'Referenced by a selected report visual.' })),
      ...filterNames.map((filter) => catalogDependency({ id: catalogKey('filter', `${report.id}:${filter}`), name: filter, kind: 'filter', category: 'filter', reason: 'Required to preserve report, page, or visual filter intent.' })),
      ...visualDependencies,
    ];
    const unsupported = uniqueStrings(report.pages.flatMap((page) => page.visuals.flatMap((visual) => visual.unsupportedReasons)));
    const visualCount = visualDependencies.length;
    return {
      id: report.id,
      name: report.name,
      kind: 'report',
      path: `${project.name} / ${report.name}`,
      dependencyIds: dependencies.map((dependency) => dependency.assetId),
      dependencies,
      dependencyCounts: {
        semantic_model: report.datasetId ? 1 : 0,
        field: fieldNames.length,
        filter: filterNames.length,
        content: visualCount,
      },
      complexity: unsupported.length || visualCount > 20 ? 'high' : visualCount > 8 ? 'medium' : 'low',
      coverage: unsupported.length ? 'partial' : visualCount > 0 && fieldNames.length > 0 ? 'complete' : 'partial',
      coverageNotes: [
        `${report.pages.length} page${report.pages.length === 1 ? '' : 's'} and ${visualCount} visual${visualCount === 1 ? '' : 's'} were assembled from enhanced PBIR files.`,
        ...report.warnings,
      ],
      riskFlags: unsupported,
    };
  }).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort();
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !['bundleId', 'generatedAt'].includes(key) && !SENSITIVE_KEY.test(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => [key, stableValue(item)]));
}

export function migrationBundleFingerprint(value: unknown): string {
  const serialized = JSON.stringify(stableValue(value));
  let hash = 0x811c9dc5;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `bundle-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function bundleHasSensitiveKeys(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(bundleHasSensitiveKeys);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value as Record<string, unknown>).some(([key, item]) => SENSITIVE_KEY.test(key) || bundleHasSensitiveKeys(item));
}

export function createMigrationBundle(input: {
  sourceInventory: SourceInventory | null;
  sourcePlatform?: MigrationPlatformKind;
  sourceDashboardCatalog?: SourceDashboardCatalogItem[];
  selectedDashboardIds: string[];
  dashboardPlans: MigrationDashboardBuildPlan[];
  targetInstanceId?: string;
  targetModelId?: string;
  targetModelName?: string;
  connectionMappings?: MigrationBundle['target']['connectionMappings'];
  connectionRoutes?: MigrationBundle['target']['connectionRoutes'];
  branchName: string;
  decisions: MigrationDecision[];
  semanticFiles: SemanticMigrationFile[];
  engineEvidence?: MigrationBundle['source']['engine'];
}): MigrationBundle {
  const selected = (input.sourceDashboardCatalog || input.sourceInventory?.dashboardCatalog || []).filter((dashboard) => input.selectedDashboardIds.includes(dashboard.id));
  const draft: Omit<MigrationBundle, 'bundleId' | 'generatedAt'> = {
    schemaVersion: '1.0',
    source: {
      platform: input.sourceInventory?.platform || input.sourcePlatform || 'dbt',
      connectionId: input.sourceInventory?.connectionId,
      selectedDashboardIds: selected.map((dashboard) => dashboard.id).sort(),
      dependencyAssetIds: Array.from(new Set(selected.flatMap((dashboard) => dashboard.dependencyIds))).sort(),
      coverageNotes: Array.from(new Set(selected.flatMap((dashboard) => dashboard.coverageNotes))).sort(),
      engine: input.engineEvidence,
    },
    target: {
      platform: 'omni',
      instanceId: input.targetInstanceId,
      modelId: input.targetModelId,
      modelName: input.targetModelName,
      branchName: input.branchName,
      connectionMappings: input.connectionMappings?.map((mapping) => ({ ...mapping })),
      connectionRoutes: input.connectionRoutes?.map((route) => ({
        ...route,
        sourceKeys: [...route.sourceKeys],
        compatibleModels: route.compatibleModels.map((model) => ({ ...model })),
      })),
    },
    decisions: input.decisions.map((decision) => ({ ...decision, evidence: [...decision.evidence], impactAssetIds: [...decision.impactAssetIds] })),
    semanticFiles: input.semanticFiles.map((file) => ({ fileName: file.fileName, yaml: file.yaml })),
    dashboardPlans: input.dashboardPlans.map((plan) => ({ ...plan, sourceEvidenceIds: [...plan.sourceEvidenceIds], dependencyIds: [...plan.dependencyIds], filters: plan.filters.map((filter) => ({ ...filter })), tiles: plan.tiles.map((tile) => ({ ...tile, sourceEvidenceIds: [...tile.sourceEvidenceIds], fields: [...tile.fields], filters: [...tile.filters], validationAssertions: [...tile.validationAssertions] })), unsupportedFeatures: [...plan.unsupportedFeatures], validationAssertions: [...plan.validationAssertions] })),
    validationRequirements: ['structural', 'semantic', 'query', 'data', 'visual_intent', 'security', 'operational', 'human'],
  };
  if (bundleHasSensitiveKeys(draft)) throw new Error('Migration bundle contains a secret-shaped key and cannot be compiled.');
  return { ...draft, bundleId: migrationBundleFingerprint(draft), generatedAt: new Date().toISOString() };
}

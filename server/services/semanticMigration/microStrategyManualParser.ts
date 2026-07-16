import type {
  MicroStrategyManualMapping,
  MicroStrategyManualParseResult,
  MigrationArtifact,
  MigrationDashboardEvidence,
  MigrationField,
  MigrationMeasure,
  MigrationRelationship,
  MigrationView,
} from '../../../src/services/semanticMigration/types';

export const MICROSTRATEGY_MANUAL_SCHEMA_VERSION = 'omnikit.microstrategy.manual.v1' as const;

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(...values: unknown[]): string {
  const value = values.find((item) => (typeof item === 'string' || typeof item === 'number') && String(item).trim());
  return value == null ? '' : String(value).trim();
}

function slug(value: string, fallback: string): string {
  return (value || fallback).replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase() || fallback;
}

function unique(values: string[], limit = 160): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).slice(0, limit);
}

function collectRecords(value: unknown, depth = 0, output: RecordValue[] = []): RecordValue[] {
  if (depth > 14 || output.length >= 8_000) return output;
  if (Array.isArray(value)) {
    value.forEach((item) => collectRecords(item, depth + 1, output));
    return output;
  }
  if (!isRecord(value)) return output;
  output.push(value);
  Object.values(value).forEach((item) => {
    if (item && typeof item === 'object') collectRecords(item, depth + 1, output);
  });
  return output;
}

function arraysFor(records: RecordValue[], keys: string[]): unknown[] {
  return records.flatMap((record) => keys.flatMap((key) => Array.isArray(record[key]) ? record[key] as unknown[] : []));
}

function information(record: RecordValue): RecordValue {
  return isRecord(record.information) ? record.information : {};
}

function objectIdentity(record: RecordValue, fallback: string) {
  const info = information(record);
  return {
    id: text(record.id, record.objectId, info.objectId, info.id),
    name: text(record.name, record.title, info.name, fallback),
    description: text(record.description, info.description),
  };
}

function fieldFromObject(value: unknown, artifactName: string): MigrationField | null {
  const record = isRecord(value) ? value : {};
  const identity = objectIdentity(record, '');
  if (!identity.name) return null;
  return {
    name: identity.name,
    type: text(record.dataType, record.type, record.subType, 'attribute'),
    description: identity.description,
    sourceArtifact: artifactName,
  };
}

function metricFromObject(value: unknown, artifactName: string): MigrationMeasure | null {
  const record = isRecord(value) ? value : {};
  const identity = objectIdentity(record, '');
  if (!identity.name) return null;
  const expression = isRecord(record.expression) ? record.expression : {};
  return {
    name: identity.name,
    sourceId: identity.id || undefined,
    sql: text(record.formula, record.definition, record.expressionText, expression.text, expression.tree),
    aggregateType: text(record.aggregateType, record.function, record.subType, 'MicroStrategy metric'),
    description: identity.description,
    sourceArtifact: artifactName,
  };
}

function objectLists(record: RecordValue) {
  const available = Array.isArray(record.availableObjects) ? record.availableObjects : [];
  const attributes = [
    ...(Array.isArray(record.attributes) ? record.attributes : []),
    ...available.filter((item) => isRecord(item) && text(item.type, item.subType).toLowerCase().includes('attribute')),
  ];
  const metrics = [
    ...(Array.isArray(record.metrics) ? record.metrics : []),
    ...(Array.isArray(record.measures) ? record.measures : []),
    ...available.filter((item) => isRecord(item) && text(item.type, item.subType).toLowerCase().includes('metric')),
  ];
  return { attributes, metrics };
}

function stableMappingId(mapping: Omit<MicroStrategyManualMapping, 'id'>): string {
  return ['microstrategy', mapping.sourceKind, mapping.sourceId || mapping.sourceName, mapping.sourceArtifact, mapping.targetKind, mapping.targetName]
    .join(':').toLowerCase().replace(/[^a-z0-9:_-]+/g, '_');
}

function mapping(input: Omit<MicroStrategyManualMapping, 'id'>): MicroStrategyManualMapping {
  return { ...input, id: stableMappingId(input) };
}

function mergeFields(fields: MigrationField[]): MigrationField[] {
  const map = new Map<string, MigrationField>();
  fields.forEach((field) => { if (!map.has(field.name.toLowerCase())) map.set(field.name.toLowerCase(), field); });
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function mergeMetrics(metrics: MigrationMeasure[]): MigrationMeasure[] {
  const map = new Map<string, MigrationMeasure>();
  metrics.forEach((metric) => {
    const key = metric.sourceId || metric.name.toLowerCase();
    const existing = map.get(key);
    if (!existing || (!existing.sql && metric.sql)) map.set(key, metric);
  });
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function parseMicroStrategyManualArtifacts(artifacts: MigrationArtifact[]): MicroStrategyManualParseResult {
  const parsed = artifacts.map((artifact) => {
    try { return { artifact, value: JSON.parse(artifact.content) as unknown }; } catch { return { artifact, value: null }; }
  });
  const mappings: MicroStrategyManualMapping[] = [];
  const views: MigrationView[] = [];
  const relationships: MigrationRelationship[] = [];
  const dashboards: MigrationDashboardEvidence[] = [];
  const warnings: string[] = [];
  let projectCount = 0;
  let reportCount = 0;
  let visualizationCount = 0;

  parsed.forEach(({ artifact, value }) => {
    if (!value) {
      warnings.push(`${artifact.name} is not valid MicroStrategy JSON metadata.`);
      return;
    }
    const records = collectRecords(value);
    const roots = isRecord(value) ? value : {};
    const projects = [...(Array.isArray(value) ? value : []), ...arraysFor(records, ['projects'])]
      .filter((item) => isRecord(item) && (item.status !== undefined || text(item.alias) || /project/i.test(text(item.type, item.kind))));
    projects.forEach((item) => {
      const identity = objectIdentity(item as RecordValue, `Project ${projectCount + 1}`);
      projectCount += 1;
      mappings.push(mapping({ sourceKind: 'project', sourceId: identity.id, sourceName: identity.name, sourceArtifact: artifact.name, targetKind: 'model_context', targetName: 'selected_omni_model', confidence: 'high', notes: ['Project membership and security remain target-model review context.'] }));
    });

    const globalAttributeValues = arraysFor(records, ['attributes']).filter((item) => isRecord(item));
    const globalMetricValues = arraysFor(records, ['metrics', 'measures']).filter((item) => isRecord(item));
    const globalAttributes = mergeFields(globalAttributeValues.map((item) => fieldFromObject(item, artifact.name)).filter((item): item is MigrationField => Boolean(item)));
    const globalMetrics = mergeMetrics(globalMetricValues.map((item) => metricFromObject(item, artifact.name)).filter((item): item is MigrationMeasure => Boolean(item)));
    const metricById = new Map(globalMetrics.flatMap((metric) => metric.sourceId ? [[metric.sourceId, metric] as const] : []));
    const metricByName = new Map(globalMetrics.map((metric) => [metric.name.toLowerCase(), metric]));

    const cubeValues = uniqueRecords(arraysFor(records, ['cubes', 'datasets']), 'cube');
    cubeValues.forEach((cube, index) => {
      const identity = objectIdentity(cube, `MicroStrategy cube ${index + 1}`);
      const lists = objectLists(cube);
      const localFields = mergeFields(lists.attributes.map((item) => fieldFromObject(item, artifact.name)).filter((item): item is MigrationField => Boolean(item)));
      const fields = localFields.length ? localFields : globalAttributes;
      const localMetrics = mergeMetrics(lists.metrics.map((item) => {
        const record = isRecord(item) ? item : {};
        const id = text(record.id, record.objectId);
        const name = text(record.name, record.title).toLowerCase();
        return metricById.get(id) || metricByName.get(name) || metricFromObject(item, artifact.name);
      }).filter((item): item is MigrationMeasure => Boolean(item)));
      const metrics = localMetrics.length ? localMetrics : globalMetrics;
      views.push({ name: identity.name, sourceId: identity.id, description: identity.description, sourceArtifact: artifact.name, fields, measures: metrics, warnings: [] });
      mappings.push(mapping({ sourceKind: 'cube', sourceId: identity.id, sourceName: identity.name, sourceArtifact: artifact.name, targetKind: 'shared_model_view', targetName: `${slug(identity.name, 'cube')}.view`, confidence: 'high', notes: [] }));
      fields.forEach((field) => mappings.push(mapping({ sourceKind: 'attribute', sourceName: `${identity.name}.${field.name}`, sourceArtifact: field.sourceArtifact || artifact.name, targetKind: 'dimension', targetName: `${slug(identity.name, 'cube')}.${slug(field.name, 'attribute')}`, confidence: 'high', notes: [] })));
      metrics.forEach((metric) => mappings.push(mapping({ sourceKind: 'metric', sourceId: metric.sourceId, sourceName: `${identity.name}.${metric.name}`, sourceArtifact: metric.sourceArtifact || artifact.name, targetKind: 'shared_model_measure', targetName: `${slug(identity.name, 'cube')}.${slug(metric.name, 'metric')}`, confidence: metric.sql ? 'high' : 'medium', notes: metric.sql ? [] : ['Metric definition is missing; retrieve it through the Modeling metric API before generation.'] })));
    });

    const reportValues = uniqueRecords(arraysFor(records, ['reports']), 'report');
    reportValues.forEach((report, index) => {
      const identity = objectIdentity(report, `MicroStrategy report ${index + 1}`);
      reportCount += 1;
      mappings.push(mapping({ sourceKind: 'report', sourceId: identity.id, sourceName: identity.name, sourceArtifact: artifact.name, targetKind: 'topic', targetName: `${slug(identity.name, 'report')}.topic`, confidence: 'medium', notes: ['Report templates, prompts, and limits require result-level validation.'] }));
    });

    const relationshipValues = uniqueRecords(arraysFor(records, ['relationships']), 'relationship');
    relationshipValues.forEach((relationship) => {
      const from = text(relationship.from, relationship.left, relationship.source, isRecord(relationship.parent) ? relationship.parent.name : '');
      const to = text(relationship.to, relationship.right, relationship.target, isRecord(relationship.child) ? relationship.child.name : '');
      if (!from || !to) return;
      relationships.push({ from, to, joinType: text(relationship.joinType, relationship.type), relationshipType: text(relationship.cardinality, relationship.relationshipType), sql: text(relationship.expression, relationship.sql), sourceArtifact: artifact.name });
      mappings.push(mapping({ sourceKind: 'relationship', sourceName: `${from} -> ${to}`, sourceArtifact: artifact.name, targetKind: 'relationships_file', targetName: 'relationships', confidence: text(relationship.expression, relationship.sql) ? 'high' : 'medium', notes: [] }));
    });

    const dashboardValues = uniqueRecords([
      ...arraysFor(records, ['dossiers', 'dashboards', 'documents']),
      ...(Array.isArray(roots.chapters) ? [roots] : []),
    ], 'dashboard');
    dashboardValues.forEach((dashboard, index) => {
      const identity = objectIdentity(dashboard, `MicroStrategy dashboard ${index + 1}`);
      const dashboardRecords = collectRecords(dashboard);
      const visualizations = uniqueRecords(arraysFor(dashboardRecords, ['visualizations']), 'visualization');
      const filters = unique(arraysFor(dashboardRecords, ['filters', 'prompts']).flatMap((item) => {
        const record = isRecord(item) ? item : {};
        return [text(record.name, record.title, record.summary, record.viewFilterSummary, record.metricLimitSummary)];
      }));
      const fields = unique(visualizations.flatMap((visualization) => {
        const lists = objectLists(visualization);
        const direct = [
          ...(Array.isArray(visualization.fields) ? visualization.fields : []),
          ...(Array.isArray(visualization.objects) ? visualization.objects : []),
          ...lists.attributes,
          ...lists.metrics,
        ];
        return direct.map((item) => isRecord(item) ? text(item.name, item.title, item.id) : text(item));
      }));
      dashboards.push({ name: identity.name, sourceId: identity.id, sourceArtifact: artifact.name, fields, filters });
      mappings.push(mapping({ sourceKind: 'dashboard', sourceId: identity.id, sourceName: identity.name, sourceArtifact: artifact.name, targetKind: 'topic', targetName: `${slug(identity.name, 'dashboard')}.topic`, confidence: 'high', notes: [] }));
      visualizations.forEach((visualization, visualIndex) => {
        const visualIdentity = objectIdentity(visualization, `Visualization ${visualIndex + 1}`);
        visualizationCount += 1;
        mappings.push(mapping({ sourceKind: 'visualization', sourceId: visualIdentity.id, sourceName: visualIdentity.name, sourceArtifact: artifact.name, targetKind: 'dashboard_tile', targetName: visualIdentity.name, confidence: fields.length ? 'high' : 'medium', notes: ['Visualization formatting and interactions require Omni visual review.'] }));
      });
      filters.forEach((filter) => mappings.push(mapping({ sourceKind: /prompt/i.test(filter) ? 'prompt' : 'filter', sourceName: filter, sourceArtifact: artifact.name, targetKind: 'filter', targetName: slug(filter, 'filter'), confidence: 'medium', notes: ['Prompt answers, selectors, and filter timing require explicit target decisions.'] })));
    });

    if (/securityFilter|security_filter|derivedElement|"selectors?"\s*:|"prompts"\s*:|"hasPrompt"\s*:\s*true/i.test(JSON.stringify(value))) {
      warnings.push(`${artifact.name} contains prompts, selectors, derived elements, or security-filter evidence that requires explicit migration decisions.`);
    }
  });

  const mergedViews = mergeViews(views);
  const mergedRelationships = mergeRelationships(relationships);
  const mergedDashboards = mergeDashboards(dashboards);
  const supportedArtifacts = new Set(mappings.map((item) => item.sourceArtifact));
  const unsupportedArtifacts = artifacts.filter((artifact) => !supportedArtifacts.has(artifact.name));
  unsupportedArtifacts.forEach((artifact) => warnings.push(`${artifact.name} did not expose a MicroStrategy project, cube, report, metric, attribute, relationship, dashboard, or visualization.`));
  const metrics = mergeMetrics(mergedViews.flatMap((view) => view.measures));
  const cleanWarnings = unique([...warnings, ...artifacts.flatMap((artifact) => artifact.parseWarnings)], 80);

  return {
    inventory: {
      sourceTool: 'microstrategy', artifactCount: artifacts.length, artifacts, views: mergedViews, explores: [], relationships: mergedRelationships,
      dashboards: mergedDashboards, metrics, warnings: cleanWarnings,
      summary: `${artifacts.length} MicroStrategy artifact${artifacts.length === 1 ? '' : 's'} · ${mergedViews.length} cube/dataset view${mergedViews.length === 1 ? '' : 's'} · ${metrics.length} metric${metrics.length === 1 ? '' : 's'} · ${mergedRelationships.length} relationship${mergedRelationships.length === 1 ? '' : 's'} · ${mergedDashboards.length} dashboard/document${mergedDashboards.length === 1 ? '' : 's'}`,
    },
    mappings: dedupeMappings(mappings),
    diagnostics: {
      schemaVersion: MICROSTRATEGY_MANUAL_SCHEMA_VERSION,
      parsedArtifactCount: artifacts.length - unsupportedArtifacts.length,
      unsupportedArtifactCount: unsupportedArtifacts.length,
      projectCount,
      cubeCount: mergedViews.length,
      reportCount,
      attributeCount: mergeFields(mergedViews.flatMap((view) => view.fields)).length,
      metricCount: metrics.length,
      relationshipCount: mergedRelationships.length,
      dashboardCount: mergedDashboards.length,
      visualizationCount,
      mappingCount: dedupeMappings(mappings).length,
      warnings: cleanWarnings,
    },
  };
}

function uniqueRecords(values: unknown[], fallback: string): RecordValue[] {
  const map = new Map<string, RecordValue>();
  values.filter(isRecord).forEach((record, index) => {
    const identity = objectIdentity(record, `${fallback}_${index + 1}`);
    const key = identity.id || `${identity.name}:${index}`;
    if (!map.has(key)) map.set(key, record);
  });
  return Array.from(map.values());
}

function mergeViews(views: MigrationView[]): MigrationView[] {
  const map = new Map<string, MigrationView>();
  views.forEach((view) => {
    const key = view.sourceId || view.name.toLowerCase();
    const existing = map.get(key);
    if (!existing) map.set(key, { ...view, fields: mergeFields(view.fields), measures: mergeMetrics(view.measures), warnings: unique(view.warnings) });
    else { existing.fields = mergeFields([...existing.fields, ...view.fields]); existing.measures = mergeMetrics([...existing.measures, ...view.measures]); }
  });
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function mergeRelationships(relationships: MigrationRelationship[]): MigrationRelationship[] {
  const map = new Map<string, MigrationRelationship>();
  relationships.forEach((relationship) => map.set(`${relationship.from.toLowerCase()}:${relationship.to.toLowerCase()}`, relationship));
  return Array.from(map.values()).sort((a, b) => `${a.from}:${a.to}`.localeCompare(`${b.from}:${b.to}`));
}

function mergeDashboards(dashboards: MigrationDashboardEvidence[]): MigrationDashboardEvidence[] {
  const map = new Map<string, MigrationDashboardEvidence>();
  dashboards.forEach((dashboard) => {
    const key = dashboard.sourceId || dashboard.name.toLowerCase();
    const existing = map.get(key);
    if (!existing) map.set(key, { ...dashboard, fields: unique(dashboard.fields), filters: unique(dashboard.filters) });
    else { existing.fields = unique([...existing.fields, ...dashboard.fields]); existing.filters = unique([...existing.filters, ...dashboard.filters]); }
  });
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function dedupeMappings(mappings: MicroStrategyManualMapping[]): MicroStrategyManualMapping[] {
  return Array.from(new Map(mappings.map((item) => [item.id, item])).values()).sort((a, b) => a.sourceKind.localeCompare(b.sourceKind) || a.sourceName.localeCompare(b.sourceName));
}

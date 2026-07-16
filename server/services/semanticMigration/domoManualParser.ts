import type {
  DomoManualConflict,
  DomoManualMapping,
  DomoManualParseResult,
  MigrationArtifact,
  MigrationDashboardEvidence,
  MigrationField,
  MigrationMeasure,
  MigrationRelationship,
  MigrationView,
} from '../../../src/services/semanticMigration/types';

export const DOMO_MANUAL_SCHEMA_VERSION = 'omnikit.domo.manual.v1' as const;

interface RecordNode {
  record: Record<string, unknown>;
  path: string;
}

interface ParseAccumulator {
  views: MigrationView[];
  relationships: MigrationRelationship[];
  dashboards: MigrationDashboardEvidence[];
  mappings: DomoManualMapping[];
  warnings: string[];
}

const MAX_RECORDS = 5_000;
const MAX_DEPTH = 12;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function textValue(...values: unknown[]): string {
  const value = values.find((item) => typeof item === 'string' && item.trim());
  return typeof value === 'string' ? value.trim() : '';
}

function identifier(...values: unknown[]): string {
  const value = values.find((item) => (typeof item === 'string' || typeof item === 'number') && String(item).trim());
  return value == null ? '' : String(value).trim();
}

function normalizedName(value: string, fallback: string): string {
  return (value || fallback)
    .trim()
    .replace(/\.[^.]+$/, '')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '') || fallback;
}

function unique(values: string[], limit = 120): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).slice(0, limit);
}

function stableMappingId(mapping: Pick<DomoManualMapping, 'sourceKind' | 'sourceId' | 'sourceName' | 'sourceArtifact' | 'targetKind' | 'targetName'>): string {
  return ['domo', mapping.sourceKind, mapping.sourceId || mapping.sourceName, mapping.sourceArtifact, mapping.targetKind, mapping.targetName]
    .join(':')
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, '_');
}

function addMapping(accumulator: ParseAccumulator, input: Omit<DomoManualMapping, 'id'>): void {
  const mapping = { ...input, id: stableMappingId(input) };
  if (!accumulator.mappings.some((item) => item.id === mapping.id)) accumulator.mappings.push(mapping);
}

function collectRecords(value: unknown): RecordNode[] {
  const nodes: RecordNode[] = [];
  const walk = (current: unknown, path: string, depth: number) => {
    if (depth > MAX_DEPTH || nodes.length >= MAX_RECORDS) return;
    if (Array.isArray(current)) {
      current.forEach((item, index) => walk(item, `${path}[${index}]`, depth + 1));
      return;
    }
    if (!isRecord(current)) return;
    nodes.push({ record: current, path });
    Object.entries(current).forEach(([key, item]) => {
      if (item && typeof item === 'object') walk(item, path ? `${path}.${key}` : key, depth + 1);
    });
  };
  walk(value, '$', 0);
  return nodes;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function columnArrays(record: Record<string, unknown>): unknown[][] {
  const schema = isRecord(record.schema) ? record.schema : {};
  const arrays = [arrayValue(record.columns), arrayValue(schema.columns)];
  for (const table of arrayValue(record.tables)) {
    if (isRecord(table)) arrays.push(arrayValue(table.columns));
  }
  for (const table of arrayValue(schema.tables)) {
    if (isRecord(table)) arrays.push(arrayValue(table.columns));
  }
  return arrays.filter((items) => items.length > 0);
}

function fieldsFromColumns(record: Record<string, unknown>, artifactName: string): MigrationField[] {
  const fields = columnArrays(record).flatMap((columns) => columns.map((columnValue): MigrationField | null => {
    const column = isRecord(columnValue) ? columnValue : {};
    const metadata = isRecord(column.metadata) ? column.metadata : {};
    const name = textValue(column.name, column.displayName, metadata.colLabel, column.id);
    if (!name) return null;
    return {
      name,
      type: textValue(column.type, column.dataType, column.data_type),
      description: textValue(column.description, metadata.description, metadata.colLabel),
      sourceArtifact: artifactName,
    } satisfies MigrationField;
  }).filter((field): field is MigrationField => Boolean(field)));
  return mergeFields(fields);
}

function datasetIdentity(record: Record<string, unknown>, artifactName: string): { id: string; name: string } {
  const schema = isRecord(record.schema) ? record.schema : {};
  const id = identifier(record.dataSourceId, record.datasourceId, record.datasetId, record.dataSetId, record.id, schema.dataSourceId);
  const candidate = textValue(record.dataSourceName, record.displayName, record.title, record.name);
  const name = candidate && candidate.toLowerCase() !== 'schema'
    ? candidate
    : id ? `domo_dataset_${id.slice(0, 12)}` : normalizedName(artifactName, 'domo_dataset');
  return { id, name };
}

function parseDatasetSchemas(nodes: RecordNode[], artifact: MigrationArtifact, accumulator: ParseAccumulator): Map<string, string> {
  const datasetNames = new Map<string, string>();
  const seen = new Set<string>();
  nodes.forEach(({ record, path }) => {
    const fields = fieldsFromColumns(record, artifact.name);
    if (fields.length === 0) return;
    const lowerPath = path.toLowerCase();
    if (/\.schema$/.test(lowerPath)) return;
    const hasExplicitSchema = isRecord(record.schema) || arrayValue(record.tables).length > 0;
    const datasetContext = /dataset|data_?source|schema/.test(lowerPath);
    if (!hasExplicitSchema && !datasetContext) return;
    const { id, name } = datasetIdentity(record, artifact.name);
    const key = id || name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    if (id) datasetNames.set(id, name);
    accumulator.views.push({
      name,
      description: textValue(record.description, `Domo dataset schema${id ? ` (${id})` : ''}`),
      sourceArtifact: artifact.name,
      sourceId: id || undefined,
      kind: 'dataset',
      fields,
      measures: [],
      warnings: [],
    });
    addMapping(accumulator, {
      sourceKind: 'dataset_schema',
      sourceId: id || undefined,
      sourceName: name,
      sourceArtifact: artifact.name,
      targetKind: 'shared_model_view',
      targetName: `${normalizedName(name, 'domo_dataset')}.view`,
      confidence: 'high',
      dependencies: [],
      notes: [`${fields.length} typed Domo column${fields.length === 1 ? '' : 's'} preserved for Omni dimensions.`],
    });
  });
  return datasetNames;
}

function formulaDependencies(formula: string): string[] {
  return unique(Array.from(formula.matchAll(/`([^`]+)`/g)).map((match) => match[1]), 80);
}

function normalizedFormula(formula: string): string {
  let normalized = '';
  let quote = '';
  let escaped = false;
  for (const char of formula.trim()) {
    if (quote) {
      normalized += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      normalized += char;
    } else if (!/\s/.test(char)) {
      normalized += char;
    }
  }
  return normalized;
}

function isBeastModeNode(path: string, record: Record<string, unknown>): boolean {
  const lowerPath = path.toLowerCase();
  if (/dataflow|transform/.test(lowerPath)) return false;
  const type = textValue(record.type, record.calculationType, record.objectType).toLowerCase();
  return /beast.?mode|calculated.?field|calculation/.test(lowerPath) || /beast.?mode/.test(type);
}

function ensureDatasetView(accumulator: ParseAccumulator, datasetNames: Map<string, string>, datasetId: string, artifactName: string): MigrationView {
  const knownName = datasetId ? datasetNames.get(datasetId) : '';
  const name = knownName || (datasetId ? `domo_dataset_${datasetId.slice(0, 12)}` : 'domo_shared_calculations');
  let view = accumulator.views.find((item) => item.name === name);
  if (!view) {
    view = {
      name,
      description: datasetId ? `Placeholder for Domo dataset ${datasetId}; add its schema export for complete field typing.` : 'Domo calculations whose dataset was not present in the uploaded files.',
      sourceArtifact: artifactName,
      sourceId: datasetId || undefined,
      kind: 'dataset',
      fields: [],
      measures: [],
      warnings: ['The referenced Domo dataset schema was not included, so its dimensions cannot be validated yet.'],
    };
    accumulator.views.push(view);
    accumulator.warnings.push(`${artifactName} includes a Beast Mode for ${datasetId || 'an unknown dataset'}, but that dataset schema was not uploaded.`);
  }
  return view;
}

function parseBeastModes(nodes: RecordNode[], artifact: MigrationArtifact, accumulator: ParseAccumulator, datasetNames: Map<string, string>): void {
  const seen = new Set<string>();
  nodes.forEach(({ record, path }) => {
    if (!isBeastModeNode(path, record)) return;
    const formula = textValue(record.formula, record.calculation, record.expression, record.sql);
    const name = textValue(record.name, record.title, record.displayName, record.columnName);
    if (!formula || !name) return;
    const sourceId = identifier(record.id, record.beastModeId, record.calculationId);
    const datasetId = identifier(record.dataSourceId, record.datasourceId, record.datasetId, record.dataSetId);
    const key = `${sourceId || datasetId}:${name}:${normalizedFormula(formula)}`;
    if (seen.has(key)) return;
    seen.add(key);
    const dependencies = formulaDependencies(formula);
    const measure: MigrationMeasure = {
      name,
      type: textValue(record.dataType, record.type),
      sql: formula,
      description: textValue(record.description),
      aggregateType: 'Domo Beast Mode',
      dependencies,
      sourceArtifact: artifact.name,
      sourceId: sourceId || undefined,
    };
    ensureDatasetView(accumulator, datasetNames, datasetId, artifact.name).measures.push(measure);
    addMapping(accumulator, {
      sourceKind: 'beast_mode',
      sourceId: sourceId || undefined,
      sourceName: name,
      sourceArtifact: artifact.name,
      targetKind: 'shared_model_measure',
      targetName: `${normalizedName(datasetNames.get(datasetId) || (datasetId ? `domo_dataset_${datasetId.slice(0, 12)}` : 'domo_shared_calculations'), 'domo_dataset')}.view`,
      confidence: datasetId && datasetNames.has(datasetId) ? 'high' : 'medium',
      dependencies,
      notes: ['The Beast Mode formula is preserved verbatim for reviewed AI translation into Omni measure YAML.'],
    });
  });
}

function stripSqlIdentifier(value: string): string {
  return value.trim().replace(/^[`"[]|[`"\]]$/g, '').split('.').pop() || value.trim();
}

function splitSqlSelectList(value: string): string[] {
  const items: string[] = [];
  let current = '';
  let depth = 0;
  let quote = '';
  for (const char of value) {
    if (quote) {
      current += char;
      if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      current += char;
    } else if (char === '(') {
      depth += 1;
      current += char;
    } else if (char === ')') {
      depth = Math.max(0, depth - 1);
      current += char;
    } else if (char === ',' && depth === 0) {
      items.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

function fieldsFromSql(sql: string, artifactName: string): MigrationField[] {
  const select = sql.replace(/--[^\n]*/g, '').match(/\bselect\s+([\s\S]+?)\s+from\s+/i)?.[1] || '';
  if (!select) return [];
  return mergeFields(splitSqlSelectList(select).flatMap((expression) => {
    if (expression === '*') return [];
    const alias = expression.match(/\s+as\s+([`"[\]A-Za-z0-9_]+)\s*$/i)?.[1]
      || expression.match(/\s+([`"[\]A-Za-z_][`"[\]A-Za-z0-9_]*)\s*$/)?.[1]
      || expression.split('.').pop();
    const name = alias ? stripSqlIdentifier(alias) : '';
    return name ? [{ name, sql: expression, sourceArtifact: artifactName }] : [];
  }));
}

function relationshipsFromSql(sql: string, artifactName: string): MigrationRelationship[] {
  const baseMatch = sql.match(/\bfrom\s+([`"[\]A-Za-z0-9_.-]+)/i);
  if (!baseMatch) return [];
  const base = stripSqlIdentifier(baseMatch[1]);
  const relationships: MigrationRelationship[] = [];
  const joinRegex = /\b(?:(left|right|full|inner|cross)\s+)?join\s+([`"[\]A-Za-z0-9_.-]+)(?:\s+(?:as\s+)?[A-Za-z_][A-Za-z0-9_]*)?\s+on\s+([\s\S]*?)(?=\b(?:left|right|full|inner|cross)?\s*join\b|\bwhere\b|\bgroup\s+by\b|\border\s+by\b|\bhaving\b|;|$)/gi;
  let match: RegExpExecArray | null;
  while ((match = joinRegex.exec(sql))) {
    relationships.push({
      from: base,
      to: stripSqlIdentifier(match[2]),
      joinType: (match[1] || 'inner').toLowerCase(),
      sql: match[3].trim(),
      sourceArtifact: artifactName,
    });
  }
  return relationships;
}

function sqlStrings(record: Record<string, unknown>): Array<{ name: string; sql: string; sourceId: string }> {
  const results: Array<{ name: string; sql: string; sourceId: string }> = [];
  const walk = (value: unknown, fallbackName: string, depth: number) => {
    if (depth > 8) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${fallbackName}_${index + 1}`, depth + 1));
      return;
    }
    if (!isRecord(value)) return;
    const name = textValue(value.name, value.title, value.transformName, value.outputName, fallbackName);
    const sourceId = identifier(value.id, value.transformId, value.dataFlowId, value.dataflowId);
    const sql = textValue(value.sql, value.query, value.statement, value.script);
    if (sql && /\b(select|create|insert|update|delete|with)\b/i.test(sql)) results.push({ name, sql, sourceId });
    Object.entries(value).forEach(([key, item]) => {
      if (item && typeof item === 'object') walk(item, name || key, depth + 1);
    });
  };
  walk(record, 'domo_dataflow', 0);
  return results;
}

function dataflowNameFromSql(sql: string, fallback: string): string {
  const output = sql.match(/\bcreate\s+(?:temporary\s+)?table\s+([`"[\]A-Za-z0-9_.-]+)/i)?.[1];
  return output ? stripSqlIdentifier(output) : normalizedName(fallback, 'domo_dataflow');
}

function addDataflowSql(input: { name: string; sql: string; sourceId?: string }, artifact: MigrationArtifact, accumulator: ParseAccumulator): void {
  const name = dataflowNameFromSql(input.sql, input.name);
  const key = `${name}:${input.sql}`;
  if (accumulator.views.some((view) => view.kind === 'query_view' && `${view.name}:${view.sql}` === key)) return;
  const relationships = relationshipsFromSql(input.sql, artifact.name);
  accumulator.views.push({
    name,
    description: `Domo SQL DataFlow transform${input.sourceId ? ` (${input.sourceId})` : ''}`,
    sourceArtifact: artifact.name,
    sourceId: input.sourceId,
    kind: 'query_view',
    sql: input.sql,
    fields: fieldsFromSql(input.sql, artifact.name),
    measures: [],
    warnings: [],
  });
  accumulator.relationships.push(...relationships);
  addMapping(accumulator, {
    sourceKind: 'dataflow_sql',
    sourceId: input.sourceId,
    sourceName: input.name || name,
    sourceArtifact: artifact.name,
    targetKind: 'query_view',
    targetName: `${normalizedName(name, 'domo_dataflow')}.view`,
    confidence: /\bselect\b/i.test(input.sql) ? 'high' : 'medium',
    dependencies: unique(relationships.flatMap((relationship) => [relationship.from, relationship.to])),
    notes: ['DataFlow SQL is preserved as source evidence for reviewed AI conversion into an Omni query view.'],
  });
  relationships.forEach((relationship) => addMapping(accumulator, {
    sourceKind: 'relationship',
    sourceName: `${relationship.from} to ${relationship.to}`,
    sourceArtifact: artifact.name,
    targetKind: 'relationships_file',
    targetName: 'relationships',
    confidence: relationship.sql ? 'high' : 'medium',
    dependencies: [relationship.from, relationship.to],
    notes: [relationship.sql ? 'The SQL JOIN predicate was preserved.' : 'The join requires review because no predicate was found.'],
  }));
}

function parseDataflows(nodes: RecordNode[], artifact: MigrationArtifact, accumulator: ParseAccumulator): void {
  const seen = new Set<string>();
  nodes.forEach(({ record, path }) => {
    const lowerPath = path.toLowerCase();
    const type = textValue(record.type, record.objectType).toLowerCase();
    if (!/dataflow|transform|sql/.test(lowerPath) && !/dataflow|transform/.test(type)) return;
    sqlStrings(record).forEach((item) => {
      const key = `${item.sourceId}:${item.name}:${item.sql}`;
      if (seen.has(key)) return;
      seen.add(key);
      addDataflowSql(item, artifact, accumulator);
    });
  });
}

function collectNamedValues(value: unknown, keys: Set<string>, limit = 100): string[] {
  const values: string[] = [];
  const walk = (current: unknown, parentKey: string, depth: number) => {
    if (depth > 10 || values.length >= limit) return;
    if (typeof current === 'string') {
      if (keys.has(parentKey.toLowerCase())) values.push(current);
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((item) => walk(item, parentKey, depth + 1));
      return;
    }
    if (!isRecord(current)) return;
    if (keys.has(parentKey.toLowerCase())) {
      const label = textValue(current.name, current.column, current.field, current.columnName, current.displayName, current.id);
      if (label) values.push(label);
    }
    Object.entries(current).forEach(([key, item]) => walk(item, key, depth + 1));
  };
  walk(value, '', 0);
  return unique(values, limit);
}

function isCardNode(path: string, record: Record<string, unknown>): boolean {
  const lowerPath = path.toLowerCase();
  const type = textValue(record.type, record.objectType).toLowerCase();
  return /(?:^|\.)cards?\[\d+\]$/.test(lowerPath)
    || Boolean(record.chartType && (record.datasourceId || record.dataSourceId || record.datasetId))
    || type === 'card';
}

function parseCards(nodes: RecordNode[], artifact: MigrationArtifact, accumulator: ParseAccumulator): void {
  const seen = new Set<string>();
  const fieldKeys = new Set(['field', 'fields', 'column', 'columns', 'dimension', 'dimensions', 'measure', 'measures', 'groupby', 'orderby']);
  const filterKeys = new Set(['filter', 'filters', 'filtercolumn', 'filtercolumns']);
  nodes.forEach(({ record, path }) => {
    if (!isCardNode(path, record)) return;
    const sourceId = identifier(record.id, record.cardId, record.urn);
    const name = textValue(record.title, record.name, record.displayName) || (sourceId ? `Domo card ${sourceId}` : 'Domo card');
    const datasetId = identifier(record.datasourceId, record.dataSourceId, record.datasetId, record.dataSetId);
    const key = sourceId || `${name}:${datasetId}`;
    if (seen.has(key)) return;
    seen.add(key);
    const fields = collectNamedValues(record, fieldKeys);
    const filters = collectNamedValues(record, filterKeys, 60);
    const chartType = textValue(record.chartType, record.chart_type, record.visualizationType);
    const cardType = textValue(record.type, record.cardType);
    accumulator.dashboards.push({
      name,
      fields,
      filters,
      sourceArtifact: artifact.name,
      sourceId: sourceId || undefined,
      sourceDatasetId: datasetId || undefined,
      chartType: chartType || undefined,
      cardType: cardType || undefined,
    });
    addMapping(accumulator, {
      sourceKind: 'card',
      sourceId: sourceId || undefined,
      sourceName: name,
      sourceArtifact: artifact.name,
      targetKind: 'dashboard_tile',
      targetName: name,
      confidence: datasetId && chartType ? 'high' : datasetId || fields.length > 0 ? 'medium' : 'low',
      dependencies: unique([datasetId, ...fields]),
      notes: [
        chartType ? `Domo chart type ${chartType} is preserved as visual intent.` : 'No Domo chart type was present; visual intent requires review.',
        'Card query evidence is routed to Omni dashboard generation, not emitted as a semantic view.',
      ],
    });
  });
}

function jsonRecordNodes(artifact: MigrationArtifact): RecordNode[] | null {
  try {
    return collectRecords(JSON.parse(artifact.content) as unknown);
  } catch {
    return null;
  }
}

function parseTextArtifact(artifact: MigrationArtifact, accumulator: ParseAccumulator): boolean {
  const content = artifact.content.trim();
  if (/\b(select|create\s+table|with)\b/i.test(content)) {
    addDataflowSql({ name: artifact.name, sql: content }, artifact, accumulator);
    return true;
  }
  if (/`[^`]+`/.test(content) && /\b(case|sum|avg|count|min|max|concat|date|ifnull)\b/i.test(content)) {
    const name = normalizedName(artifact.name, 'domo_beast_mode');
    const view = ensureDatasetView(accumulator, new Map(), '', artifact.name);
    view.measures.push({
      name,
      sql: content,
      aggregateType: 'Domo Beast Mode',
      dependencies: formulaDependencies(content),
      sourceArtifact: artifact.name,
    });
    addMapping(accumulator, {
      sourceKind: 'beast_mode',
      sourceName: name,
      sourceArtifact: artifact.name,
      targetKind: 'shared_model_measure',
      targetName: 'domo_shared_calculations.view',
      confidence: 'medium',
      dependencies: formulaDependencies(content),
      notes: ['The formula was recognized from text, but a structured Beast Mode export is recommended to preserve its Domo ID and dataset scope.'],
    });
    return true;
  }
  return false;
}

function mergeFields(fields: MigrationField[]): MigrationField[] {
  const map = new Map<string, MigrationField>();
  fields.forEach((field) => {
    const key = field.name.toLowerCase();
    const existing = map.get(key);
    if (!existing) map.set(key, { ...field });
    else {
      existing.type ||= field.type;
      existing.sql ||= field.sql;
      existing.description ||= field.description;
    }
  });
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function mergeMeasureEvidence(measures: MigrationMeasure[]): MigrationMeasure {
  const [first, ...rest] = measures;
  if (!first) throw new Error('Cannot merge an empty Domo measure group.');
  const merged: MigrationMeasure = { ...first, dependencies: unique(first.dependencies || []) };
  rest.forEach((measure) => {
    merged.type ||= measure.type;
    merged.sql ||= measure.sql;
    merged.description ||= measure.description;
    merged.aggregateType ||= measure.aggregateType;
    merged.sourceId ||= measure.sourceId;
    merged.dependencies = unique([...(merged.dependencies || []), ...(measure.dependencies || [])]);
  });
  return merged;
}

function shortHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).slice(0, 6);
}

function mergeMeasuresAdditively(datasetView: string, measures: MigrationMeasure[]) {
  const byName = new Map<string, MigrationMeasure[]>();
  measures.forEach((measure) => {
    const key = measure.name.toLowerCase();
    byName.set(key, [...(byName.get(key) || []), measure]);
  });

  const merged: MigrationMeasure[] = [];
  const conflicts: DomoManualConflict[] = [];
  let deduplicatedMeasureCount = 0;

  byName.forEach((namedMeasures) => {
    const byFormula = new Map<string, MigrationMeasure[]>();
    namedMeasures.forEach((measure) => {
      const formulaKey = measure.sql ? normalizedFormula(measure.sql) : `source:${measure.sourceId || measure.sourceArtifact || measure.name}`;
      byFormula.set(formulaKey, [...(byFormula.get(formulaKey) || []), measure]);
    });
    const variants = Array.from(byFormula.entries()).map(([formula, matchingMeasures]) => ({
      formula,
      measure: mergeMeasureEvidence(matchingMeasures),
      duplicateCount: Math.max(0, matchingMeasures.length - 1),
    }));
    deduplicatedMeasureCount += variants.reduce((sum, variant) => sum + variant.duplicateCount, 0);
    if (variants.length === 1) {
      merged.push(variants[0].measure);
      return;
    }

    const sourceName = namedMeasures[0].name;
    const conflictVariants = variants.map(({ formula, measure }) => {
      const sourceSlug = normalizedName(measure.sourceId || measure.sourceArtifact || 'variant', 'variant').slice(0, 28);
      const proposedName = `${sourceName}__${sourceSlug}_${shortHash(formula)}`;
      merged.push({ ...measure, name: proposedName, originalName: sourceName });
      return {
        sourceId: measure.sourceId,
        sourceArtifact: measure.sourceArtifact || 'unknown Domo artifact',
        formula: measure.sql || formula,
        proposedName,
      };
    });
    conflicts.push({
      id: `domo:beast_mode_collision:${normalizedName(datasetView, 'dataset')}:${normalizedName(sourceName, 'measure')}`.toLowerCase(),
      kind: 'beast_mode_formula_collision',
      datasetView,
      sourceName,
      resolution: 'preserve_all',
      variants: conflictVariants,
    });
  });

  return {
    measures: merged.sort((a, b) => a.name.localeCompare(b.name)),
    conflicts,
    deduplicatedMeasureCount,
  };
}

function mergeViews(views: MigrationView[]) {
  const map = new Map<string, MigrationView>();
  views.forEach((view) => {
    const key = `${view.kind || 'dataset'}:${view.name.toLowerCase()}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { ...view, fields: mergeFields(view.fields), measures: [...view.measures], warnings: unique(view.warnings) });
      return;
    }
    existing.description ||= view.description;
    existing.sql ||= view.sql;
    existing.sourceId ||= view.sourceId;
    existing.fields = mergeFields([...existing.fields, ...view.fields]);
    existing.measures = [...existing.measures, ...view.measures];
    existing.warnings = unique([...existing.warnings, ...view.warnings]);
  });
  const conflicts: DomoManualConflict[] = [];
  let deduplicatedMeasureCount = 0;
  const mergedViews = Array.from(map.values()).map((view) => {
    const additive = mergeMeasuresAdditively(view.name, view.measures);
    conflicts.push(...additive.conflicts);
    deduplicatedMeasureCount += additive.deduplicatedMeasureCount;
    return { ...view, measures: additive.measures };
  }).sort((a, b) => a.name.localeCompare(b.name));
  return { views: mergedViews, conflicts, deduplicatedMeasureCount };
}

function mergeRelationships(relationships: MigrationRelationship[]): MigrationRelationship[] {
  const seen = new Set<string>();
  return relationships.filter((relationship) => {
    const key = `${relationship.from}|${relationship.to}|${relationship.sql || ''}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => `${a.from}:${a.to}`.localeCompare(`${b.from}:${b.to}`));
}

function mergeDashboards(dashboards: MigrationDashboardEvidence[]): MigrationDashboardEvidence[] {
  const map = new Map<string, MigrationDashboardEvidence>();
  dashboards.forEach((dashboard) => {
    const key = dashboard.sourceId || dashboard.name.toLowerCase();
    const existing = map.get(key);
    if (!existing) map.set(key, { ...dashboard, fields: unique(dashboard.fields), filters: unique(dashboard.filters) });
    else {
      existing.fields = unique([...existing.fields, ...dashboard.fields]);
      existing.filters = unique([...existing.filters, ...dashboard.filters]);
      existing.chartType ||= dashboard.chartType;
      existing.sourceDatasetId ||= dashboard.sourceDatasetId;
    }
  });
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function parseDomoManualArtifacts(artifacts: MigrationArtifact[]): DomoManualParseResult {
  const accumulator: ParseAccumulator = { views: [], relationships: [], dashboards: [], mappings: [], warnings: [] };
  const jsonNodes = new Map<string, RecordNode[] | null>();
  const datasetNames = new Map<string, string>();

  artifacts.forEach((artifact) => {
    const nodes = jsonRecordNodes(artifact);
    jsonNodes.set(artifact.id, nodes);
    if (nodes) {
      parseDatasetSchemas(nodes, artifact, accumulator).forEach((name, id) => datasetNames.set(id, name));
    }
  });

  artifacts.forEach((artifact) => {
    const nodes = jsonNodes.get(artifact.id);
    if (nodes) {
      parseBeastModes(nodes, artifact, accumulator, datasetNames);
      parseDataflows(nodes, artifact, accumulator);
      parseCards(nodes, artifact, accumulator);
    } else {
      parseTextArtifact(artifact, accumulator);
    }
    accumulator.warnings.push(...artifact.parseWarnings);
  });

  const unsupportedArtifacts = artifacts.filter((artifact) => !accumulator.mappings.some((mapping) => mapping.sourceArtifact === artifact.name));
  unsupportedArtifacts.forEach((artifact) => {
    accumulator.warnings.push(`${artifact.name} did not expose a Domo dataset schema, Beast Mode, SQL DataFlow, or Card definition.`);
  });
  const unsupportedArtifactCount = unsupportedArtifacts.length;

  const additiveViews = mergeViews(accumulator.views);
  const views = additiveViews.views;
  const conflicts = additiveViews.conflicts;
  conflicts.forEach((conflict) => {
    accumulator.warnings.push(`${conflict.datasetView}.${conflict.sourceName} has ${conflict.variants.length} different Beast Mode formulas. OmniKit preserved every variant with a distinct proposed name instead of overwriting one.`);
  });
  const relationships = mergeRelationships(accumulator.relationships);
  const dashboards = mergeDashboards(accumulator.dashboards);
  const mappings = accumulator.mappings.sort((a, b) => a.sourceKind.localeCompare(b.sourceKind) || a.sourceName.localeCompare(b.sourceName));
  const metrics = views.flatMap((view) => view.measures).sort((a, b) => a.name.localeCompare(b.name));
  const warnings = unique([...accumulator.warnings, ...views.flatMap((view) => view.warnings)], 80);
  const summary = [
    `${artifacts.length} Domo artifact${artifacts.length === 1 ? '' : 's'}`,
    `${views.filter((view) => view.kind === 'dataset').length} dataset view${views.filter((view) => view.kind === 'dataset').length === 1 ? '' : 's'}`,
    `${metrics.length} Beast Mode${metrics.length === 1 ? '' : 's'}`,
    `${views.filter((view) => view.kind === 'query_view').length} query view${views.filter((view) => view.kind === 'query_view').length === 1 ? '' : 's'}`,
    `${relationships.length} relationship${relationships.length === 1 ? '' : 's'}`,
    `${dashboards.length} card${dashboards.length === 1 ? '' : 's'}`,
  ].join(' · ');

  return {
    inventory: {
      sourceTool: 'domo',
      artifactCount: artifacts.length,
      artifacts,
      views,
      explores: [],
      relationships,
      dashboards,
      metrics,
      warnings,
      summary,
    },
    mappings,
    conflicts,
    diagnostics: {
      schemaVersion: DOMO_MANUAL_SCHEMA_VERSION,
      parsedArtifactCount: artifacts.length - unsupportedArtifactCount,
      unsupportedArtifactCount,
      mappingCount: mappings.length,
      deduplicatedMeasureCount: additiveViews.deduplicatedMeasureCount,
      conflictCount: conflicts.length,
      warnings,
    },
  };
}

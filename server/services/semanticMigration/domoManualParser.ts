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

export const DOMO_MANUAL_SCHEMA_VERSION = 'omnikit.domo.manual.v2' as const;

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

function scalarText(...values: unknown[]): string {
  const value = values.find((item) => (
    (typeof item === 'string' && item.trim() !== '')
    || (typeof item === 'number' && Number.isFinite(item))
    || typeof item === 'boolean'
  ));
  return value == null ? '' : String(value).trim();
}

function identifier(...values: unknown[]): string {
  const value = values.find((item) => (typeof item === 'string' || typeof item === 'number') && String(item).trim());
  return value == null ? '' : String(value).trim();
}

function numberValue(...values: unknown[]): number | undefined {
  const value = values.find((item) => typeof item === 'number' && Number.isFinite(item));
  return typeof value === 'number' ? value : undefined;
}

function booleanValue(...values: unknown[]): boolean | undefined {
  const value = values.find((item) => typeof item === 'boolean');
  return typeof value === 'boolean' ? value : undefined;
}

function nestedText(value: unknown, ...keys: string[]): string {
  if (typeof value === 'string') return value.trim();
  if (!isRecord(value)) return '';
  return textValue(...keys.map((key) => value[key]));
}

function safeMetadata(record: Record<string, unknown>, keys: string[]): Record<string, string | number | boolean | null> {
  return Object.fromEntries(keys.flatMap((key) => {
    const value = record[key];
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null
      ? [[key, typeof value === 'string' ? value.slice(0, 500) : value] as const]
      : [];
  }));
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

type BeastModeKind = 'dimension' | 'measure' | 'level_of_detail';

function beastModeKind(record: Record<string, unknown>, formula: string): BeastModeKind {
  if (/\bfixed(?:\s+(?:by|add|remove))?\b/i.test(formula)) return 'level_of_detail';
  const aggregated = booleanValue(record.aggregated, record.isAggregated);
  const analytic = booleanValue(record.analytic, record.isAnalytic);
  if (aggregated === true || analytic === true) return 'measure';
  if (aggregated === false) return 'dimension';
  return /\b(sum|avg|average|count|min|max|median|stddev|variance|rank|row_number|lag|lead)\s*\(/i.test(formula)
    ? 'measure'
    : 'dimension';
}

function beastModeScope(record: Record<string, unknown>): string {
  const global = booleanValue(record.global, record.savedToDataset, record.dataSetScoped);
  if (global === true) return 'dataset_scoped';
  if (global === false) return 'card_scoped_or_linked';
  return 'scope_unknown';
}

function beastModeAnnotations(record: Record<string, unknown>, kind: BeastModeKind): Record<string, string> {
  const functions = Array.isArray(record.functions) ? unique(record.functions.map(String), 80) : [];
  const templateDependencies = Array.isArray(record.functionTemplateDependencies)
    ? unique(record.functionTemplateDependencies.map((item) => identifier(isRecord(item) ? item.id : item, isRecord(item) ? item.name : '')), 80)
    : [];
  return Object.fromEntries([
    ['domo.beastModeKind', kind],
    ['domo.scope', beastModeScope(record)],
    ['domo.status', textValue(record.status) || 'unknown'],
    ['domo.aggregated', String(booleanValue(record.aggregated, record.isAggregated) ?? 'unknown')],
    ['domo.analytic', String(booleanValue(record.analytic, record.isAnalytic) ?? 'unknown')],
    ['domo.variable', String(booleanValue(record.variable) ?? false)],
    ['domo.locked', String(booleanValue(record.locked) ?? false)],
    ['domo.archived', String(booleanValue(record.archived) ?? false)],
    ['domo.functions', functions.join(', ')],
    ['domo.functionTemplateDependencies', templateDependencies.join(', ')],
  ].filter(([, value]) => value !== ''));
}

function parseVariables(nodes: RecordNode[], artifact: MigrationArtifact, accumulator: ParseAccumulator): void {
  const seen = new Set<string>();
  nodes.forEach(({ record, path }) => {
    const type = textValue(record.type, record.objectType, record.calculationType).toLowerCase();
    const variable = record.variable === true || /(?:^|\.)variables?\[\d+\]$/i.test(path) || type === 'variable';
    if (!variable) return;
    const sourceId = identifier(record.id, record.variableId, record.calculationId);
    const name = textValue(record.name, record.title, record.displayName);
    if (!name) return;
    const key = sourceId || name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const dataType = textValue(record.dataType, record.valueType, record.type);
    const controlType = textValue(record.controlType, record.control, nestedText(record.defaultControl, 'type', 'controlType'));
    const defaultValue = scalarText(record.defaultValue, record.value, isRecord(record.default) ? record.default.value : undefined);
    addMapping(accumulator, {
      sourceKind: 'variable',
      sourceId: sourceId || undefined,
      sourceName: name,
      sourceArtifact: artifact.name,
      targetKind: 'dashboard_control',
      targetName: normalizedName(name, 'domo_variable'),
      confidence: dataType && defaultValue ? 'high' : 'medium',
      dependencies: unique(collectNamedValues(record, new Set(['beastmode', 'beastmodes', 'calculation', 'calculations', 'functiontemplatedependencies']), 80)),
      notes: [
        `Domo Variable type ${dataType || 'unknown'} and default ${defaultValue ? 'were preserved' : 'were not fully available'}.`,
        controlType ? `Control type ${controlType} was detected.` : 'Control type and allowed values require review.',
        'Translate the Variable with its dependent Beast Mode as an Omni dashboard control plus reviewed model expression; do not inline the current value.',
      ],
    });
  });
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
    if (record.variable === true) return;
    const formula = textValue(record.formula, record.calculation, record.expression, record.sql);
    const name = textValue(record.name, record.title, record.displayName, record.columnName);
    if (!formula || !name) return;
    const sourceId = identifier(record.id, record.beastModeId, record.calculationId);
    const datasetId = identifier(record.dataSourceId, record.datasourceId, record.datasetId, record.dataSetId);
    const key = `${sourceId || datasetId}:${name}:${normalizedFormula(formula)}`;
    if (seen.has(key)) return;
    seen.add(key);
    const dependencies = formulaDependencies(formula);
    const kind = beastModeKind(record, formula);
    const annotations = beastModeAnnotations(record, kind);
    const field: MigrationField = {
      name,
      type: textValue(record.dataType, record.type),
      sql: formula,
      description: textValue(record.description),
      sourceArtifact: artifact.name,
      sourceId: sourceId || undefined,
      annotations,
    };
    const view = ensureDatasetView(accumulator, datasetNames, datasetId, artifact.name);
    if (kind === 'measure') {
      const measure: MigrationMeasure = { ...field, aggregateType: 'Domo Beast Mode', dependencies };
      view.measures.push(measure);
    } else {
      field.untranslatable = kind === 'level_of_detail'
        ? ['Domo FIXED grouping and filter behavior require reviewed Omni level_of_detail translation.']
        : undefined;
      view.fields.push(field);
    }
    const scope = beastModeScope(record);
    const status = textValue(record.status);
    const variableDependencies = Array.isArray(record.functionTemplateDependencies) ? record.functionTemplateDependencies.length : 0;
    addMapping(accumulator, {
      sourceKind: 'beast_mode',
      sourceId: sourceId || undefined,
      sourceName: name,
      sourceArtifact: artifact.name,
      targetKind: kind === 'measure' ? 'shared_model_measure' : 'shared_model_dimension',
      targetName: `${normalizedName(datasetNames.get(datasetId) || (datasetId ? `domo_dataset_${datasetId.slice(0, 12)}` : 'domo_shared_calculations'), 'domo_dataset')}.view`,
      confidence: datasetId && datasetNames.has(datasetId) && booleanValue(record.aggregated, record.analytic) != null ? 'high' : 'medium',
      dependencies: unique([datasetId, ...dependencies]),
      notes: [
        `The Beast Mode was classified as ${kind === 'level_of_detail' ? 'FIXED level-of-detail logic' : kind} and its formula was preserved verbatim.`,
        `Source scope: ${scope.replaceAll('_', ' ')}${status ? `; status: ${status}` : ''}.`,
        variableDependencies > 0 ? `${variableDependencies} Variable or template dependency reference${variableDependencies === 1 ? '' : 's'} require matching dashboard-control decisions.` : '',
        kind === 'level_of_detail' ? 'Grouping plus ALLOW/DENY/NONE filter behavior must be validated before generating Omni level_of_detail YAML.' : 'Translate the Domo dialect and validate result parity before approval.',
      ].filter(Boolean),
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

interface DomoSqlTransform {
  name: string;
  sql: string;
  sourceId?: string;
  engine?: string;
  updateMode?: string;
  recursive?: boolean;
  append?: boolean;
  outputName?: string;
}

function sqlStrings(record: Record<string, unknown>): DomoSqlTransform[] {
  const results: DomoSqlTransform[] = [];
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
    if (sql && /\b(select|create|insert|update|delete|with)\b/i.test(sql)) results.push({
      name,
      sql,
      sourceId,
      engine: textValue(value.engine, value.engineType, value.sqlEngine, value.databaseType) || undefined,
      updateMode: textValue(value.updateMode, value.updateMethod, value.writeMode, value.outputMode) || undefined,
      recursive: booleanValue(value.recursive, value.isRecursive, value.snapshot),
      append: booleanValue(value.append, value.autoAppend, value.isAppend),
      outputName: textValue(value.outputName, value.outputDatasetName, value.outputDataSetName) || undefined,
    });
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

function addDataflowSql(input: DomoSqlTransform, artifact: MigrationArtifact, accumulator: ParseAccumulator): void {
  const name = dataflowNameFromSql(input.sql, input.name);
  const key = `${name}:${input.sql}`;
  if (accumulator.views.some((view) => view.kind === 'query_view' && `${view.name}:${view.sql}` === key)) return;
  const relationships = relationshipsFromSql(input.sql, artifact.name);
  accumulator.views.push({
    name,
    description: `Domo SQL DataFlow transform${input.sourceId ? ` (${input.sourceId})` : ''}${input.engine ? ` using ${input.engine}` : ''}`,
    sourceArtifact: artifact.name,
    sourceId: input.sourceId,
    kind: 'query_view',
    sql: input.sql,
    fields: fieldsFromSql(input.sql, artifact.name),
    measures: [],
    warnings: unique([
      !input.engine ? 'The Domo SQL engine was not present; validate the target warehouse dialect.' : '',
      input.recursive ? 'Recursive or snapshot execution behavior requires a data-engineering handoff.' : '',
      input.append ? 'Append/update semantics require a data-engineering handoff.' : '',
    ]),
  });
  accumulator.relationships.push(...relationships);
  addMapping(accumulator, {
    sourceKind: 'dataflow_sql',
    sourceId: input.sourceId,
    sourceName: input.name || name,
    sourceArtifact: artifact.name,
    targetKind: 'query_view',
    targetName: `${normalizedName(name, 'domo_dataflow')}.view`,
    confidence: /\bselect\b/i.test(input.sql) && Boolean(input.engine) ? 'high' : 'medium',
    dependencies: unique(relationships.flatMap((relationship) => [relationship.from, relationship.to])),
    notes: [
      'DataFlow SQL is preserved as source evidence for reviewed AI conversion into an Omni query view.',
      `Engine/dialect: ${input.engine || 'unknown'}; output: ${input.outputName || name}; update mode: ${input.updateMode || 'unknown'}.`,
      input.recursive || input.append ? 'Recursive, snapshot, or append execution behavior is not represented by a query view and requires a data-engineering decision.' : 'Validate output grain and scheduling outside the semantic file.',
    ],
  });
  relationships.forEach((relationship) => addMapping(accumulator, {
    sourceKind: 'relationship',
    sourceName: `${relationship.from} to ${relationship.to}`,
    sourceArtifact: artifact.name,
    targetKind: 'relationships_file',
    targetName: 'relationships',
    confidence: 'medium',
    dependencies: [relationship.from, relationship.to],
    notes: [relationship.sql ? 'The SQL JOIN predicate was preserved, but it does not prove cardinality or fanout behavior.' : 'The join requires review because no predicate was found.'],
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

function hasNestedKey(value: unknown, pattern: RegExp, depth = 0): boolean {
  if (depth > 8 || value == null) return false;
  if (Array.isArray(value)) return value.some((item) => hasNestedKey(item, pattern, depth + 1));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, item]) => pattern.test(key) || hasNestedKey(item, pattern, depth + 1));
}

function isCardNode(path: string, record: Record<string, unknown>): boolean {
  const lowerPath = path.toLowerCase();
  const type = textValue(record.type, record.objectType).toLowerCase();
  return /(?:^|\.)cards?\[\d+\]$/.test(lowerPath)
    || Boolean(record.chartType && (record.datasourceId || record.dataSourceId || record.datasetId))
    || type === 'card';
}

function parseCards(nodes: RecordNode[], artifact: MigrationArtifact, accumulator: ParseAccumulator): void {
  const fieldKeys = new Set(['field', 'fields', 'column', 'columns', 'dimension', 'dimensions', 'measure', 'measures', 'groupby', 'orderby']);
  const filterKeys = new Set(['filter', 'filters', 'filtercolumn', 'filtercolumns']);
  nodes.forEach(({ record, path }) => {
    if (!isCardNode(path, record)) return;
    const sourceId = identifier(record.id, record.cardId, record.urn);
    const name = textValue(record.title, record.name, record.displayName) || (sourceId ? `Domo card ${sourceId}` : 'Domo card');
    const datasetId = identifier(record.datasourceId, record.dataSourceId, record.datasetId, record.dataSetId);
    const fields = collectNamedValues(record, fieldKeys);
    const filters = collectNamedValues(record, filterKeys, 60);
    const sorts = collectNamedValues(record, new Set(['sort', 'sorts', 'orderby', 'orderBy']), 40);
    const summaryFields = collectNamedValues(record, new Set(['summarynumber', 'summarynumbercolumn', 'summaryfield', 'summaryNumber']), 20);
    const variableNames = collectNamedValues(record, new Set(['variable', 'variables', 'variablecontrol', 'variablecontrols']), 40);
    const quickFilters = collectNamedValues(record, new Set(['quickfilter', 'quickfilters', 'quickFilter', 'quickFilters']), 40);
    const drillIds = unique([
      ...recordIds(record.drillPath, ['id', 'cardId', 'urn', 'dataSourceId', 'datasetId']),
      ...recordIds(record.drillPaths, ['id', 'cardId', 'urn', 'dataSourceId', 'datasetId']),
      ...recordIds(record.drill, ['id', 'cardId', 'urn', 'dataSourceId', 'datasetId']),
    ]);
    const hasDrill = drillIds.length > 0 || hasNestedKey(record, /drill/i);
    const hasInteractions = hasNestedKey(record, /interaction|crossfilter|cross_filter|action/i);
    const hasChartProperties = hasNestedKey(record, /chartpropert|formatting|colorrule|color_rule/i);
    const query = isRecord(record.query) ? record.query : {};
    const limit = numberValue(record.limit, record.rowLimit, query.limit, query.rowLimit);
    const dateGrain = textValue(record.dateGrain, record.granularity, query.dateGrain, query.granularity);
    const chartType = textValue(record.chartType, record.chart_type, record.visualizationType);
    const cardType = textValue(record.type, record.cardType);
    const parentId = identifier(record.pageId, record.page_id, record.parentId, record.parent_id);
    const owner = textValue(record.ownerName, record.owner_name, nestedText(record.owner, 'displayName', 'name', 'email'));
    const usageCount = numberValue(record.usageCount, record.viewCount, record.view_count, record.views, record.cardLoads);
    const dependencyIds = unique([datasetId, ...fields, ...filters, ...sorts, ...summaryFields, ...variableNames, ...drillIds]);
    const riskFlags = unique([
      !datasetId ? 'Dataset binding was not present in the Card evidence.' : '',
      !chartType ? 'Chart type was not present in the Card evidence.' : '',
      hasDrill && drillIds.length === 0 ? 'Drill behavior was detected without complete ordered drill-layer identifiers.' : '',
      variableNames.length > 0 ? 'Variable controls require matching model-expression and dashboard-control decisions.' : '',
    ]);
    accumulator.dashboards.push({
      name,
      fields,
      filters,
      assetKind: 'card',
      sourceArtifact: artifact.name,
      sourceId: sourceId || undefined,
      sourceLocator: path,
      parentId: parentId || undefined,
      path: textValue(record.path, record.url, record.webUrl),
      owner: owner || undefined,
      updatedAt: textValue(record.updatedAt, record.updated_at, record.lastModified, record.lastUpdatedDate) || undefined,
      usageCount,
      dependencyIds,
      featureFlags: unique([
        record.certified === true ? 'certified' : '',
        record.locked === true ? 'locked' : '',
        record.archived === true ? 'archived' : '',
        sorts.length > 0 ? 'sorts' : '',
        limit != null ? 'row_limit' : '',
        dateGrain ? 'date_grain' : '',
        summaryFields.length > 0 ? 'summary_number' : '',
        quickFilters.length > 0 ? 'quick_filters' : '',
        variableNames.length > 0 ? 'variable_controls' : '',
        hasDrill ? 'drill_path' : '',
        hasInteractions ? 'card_interactions' : '',
        hasChartProperties ? 'chart_properties' : '',
      ]),
      riskFlags,
      metadata: {
        ...safeMetadata(record, ['description', 'type', 'chartType', 'cardType', 'pageId', 'page_id', 'datasourceId', 'dataSourceId', 'datasetId']),
        ...(sorts.length > 0 ? { sorts: sorts.join(', ') } : {}),
        ...(limit != null ? { limit } : {}),
        ...(dateGrain ? { dateGrain } : {}),
        ...(summaryFields.length > 0 ? { summaryFields: summaryFields.join(', ') } : {}),
        ...(quickFilters.length > 0 ? { quickFilters: quickFilters.join(', ') } : {}),
        ...(variableNames.length > 0 ? { variables: variableNames.join(', ') } : {}),
        ...(drillIds.length > 0 ? { drillIds: drillIds.join(', ') } : {}),
      },
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
      dependencies: dependencyIds,
      notes: [
        chartType ? `Domo chart type ${chartType} is preserved as visual intent.` : 'No Domo chart type was present; visual intent requires review.',
        `Analyzer evidence: ${fields.length} field(s), ${filters.length} filter(s), ${sorts.length} sort(s), limit ${limit ?? 'unknown'}, date grain ${dateGrain || 'unknown'}, ${summaryFields.length} summary-number field(s).`,
        `${drillIds.length} drill reference(s), ${quickFilters.length} quick-filter field(s), and ${variableNames.length} Variable reference(s) were detected.`,
        'Card query evidence is routed to Omni dashboard generation, not emitted as a semantic view.',
      ],
    });
    if (hasDrill) addMapping(accumulator, {
      sourceKind: 'drill_path',
      sourceId: sourceId ? `${sourceId}:drill` : undefined,
      sourceName: `${name} drill path`,
      sourceArtifact: artifact.name,
      targetKind: 'dashboard_tile',
      targetName: name,
      confidence: drillIds.length > 0 ? 'medium' : 'low',
      dependencies: unique([sourceId, datasetId, ...drillIds, ...fields]),
      notes: ['Translate to Omni drill_fields or drill_queries only when ordered layers, fields, filters, sorts, limits, and any DataSet changes are complete.'],
    });
    if (quickFilters.length > 0) addMapping(accumulator, {
      sourceKind: 'filter_view',
      sourceId: sourceId ? `${sourceId}:quick_filters` : undefined,
      sourceName: `${name} quick filters`,
      sourceArtifact: artifact.name,
      targetKind: 'dashboard_control',
      targetName: name,
      confidence: 'medium',
      dependencies: unique([sourceId, datasetId, ...quickFilters]),
      notes: ['Map each quick filter to a type-compatible Omni dashboard filter and preserve default values and tile applicability.'],
    });
    if (hasInteractions) addMapping(accumulator, {
      sourceKind: 'card_interaction',
      sourceId: sourceId ? `${sourceId}:interaction` : undefined,
      sourceName: `${name} interactions`,
      sourceArtifact: artifact.name,
      targetKind: 'dashboard_control',
      targetName: name,
      confidence: 'low',
      dependencies: unique([sourceId, datasetId]),
      notes: ['Review whether Domo actions can become Omni cross-filtering, dashboard links, or an explicit redesign.'],
    });
  });
}

function recordIds(value: unknown, keys: string[], typeHint?: RegExp): string[] {
  const results: string[] = [];
  const add = (item: unknown) => {
    if (typeof item === 'string' || typeof item === 'number') {
      if (String(item).trim()) results.push(String(item).trim());
      return;
    }
    if (!isRecord(item)) return;
    const type = textValue(item.type, item.objectType, item.contentType).toLowerCase();
    if (typeHint && type && !typeHint.test(type)) return;
    const id = identifier(...keys.map((key) => item[key]));
    if (id) results.push(id);
  };
  if (Array.isArray(value)) value.forEach(add);
  else add(value);
  return unique(results);
}

function isPageNode(path: string, record: Record<string, unknown>): boolean {
  const lowerPath = path.toLowerCase();
  const type = textValue(record.type, record.objectType, record.contentType).toLowerCase();
  return /(?:^|\.)pages?\[\d+\]$/.test(lowerPath) || type === 'page';
}

function pageCardIds(record: Record<string, unknown>): string[] {
  return unique([
    ...recordIds(record.cardIds, ['id', 'cardId', 'urn']),
    ...recordIds(record.card_ids, ['id', 'cardId', 'urn']),
    ...recordIds(record.cards, ['id', 'cardId', 'urn'], /card/),
    ...recordIds(record.children, ['id', 'cardId', 'urn'], /card/),
  ]);
}

function parsePages(nodes: RecordNode[], artifact: MigrationArtifact, accumulator: ParseAccumulator): void {
  const seen = new Set<string>();
  const filterKeys = new Set(['filter', 'filters', 'filtercolumn', 'filtercolumns', 'pagefilters']);
  nodes.forEach(({ record, path }) => {
    if (!isPageNode(path, record)) return;
    const sourceId = identifier(record.id, record.pageId, record.page_id);
    const name = textValue(record.title, record.name, record.displayName) || (sourceId ? `Domo page ${sourceId}` : 'Domo page');
    const key = sourceId || name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const childIds = pageCardIds(record);
    const filters = collectNamedValues(record, filterKeys, 60);
    const filterViewNames = collectNamedValues(record, new Set(['filterview', 'filterviews', 'savedfilter', 'savedfilters']), 40);
    const variableNames = collectNamedValues(record, new Set(['variable', 'variables', 'variablecontrol', 'variablecontrols']), 40);
    const hasInteractions = hasNestedKey(record, /interaction|crossfilter|cross_filter|action|pageDrill/i);
    const type = textValue(record.type, record.objectType, record.contentType, record.pageType, record.layoutType).toLowerCase();
    const appLike = /app.?studio|story|app_page|app page/.test(`${type} ${path.toLowerCase()}`);
    const owner = textValue(record.ownerName, record.owner_name, nestedText(record.owner, 'displayName', 'name', 'email'));
    const parentId = identifier(record.parentId, record.parent_id);
    const riskFlags = unique([
      childIds.length === 0 ? 'No Card membership was present in the Page evidence.' : '',
      record.layout == null && record.columnLayout == null ? 'Page layout was not present and requires visual review.' : '',
      appLike ? 'Story or App Studio behavior requires explicit application redesign review.' : '',
    ]);
    accumulator.dashboards.push({
      name,
      fields: [],
      filters,
      assetKind: 'page',
      sourceArtifact: artifact.name,
      sourceId: sourceId || undefined,
      sourceLocator: path,
      parentId: parentId || undefined,
      path: textValue(record.path, record.url, record.webUrl),
      owner: owner || undefined,
      updatedAt: textValue(record.updatedAt, record.updated_at, record.lastModified, record.lastUpdatedDate) || undefined,
      usageCount: numberValue(record.usageCount, record.viewCount, record.view_count, record.views),
      dependencyIds: childIds,
      childIds,
      featureFlags: unique([
        record.locked === true ? 'locked' : '',
        record.certified === true ? 'certified' : '',
        appLike ? 'application_page' : 'standard_page',
        filterViewNames.length > 0 ? 'filter_views' : '',
        variableNames.length > 0 ? 'variable_controls' : '',
        hasInteractions ? 'card_interactions' : '',
      ]),
      riskFlags,
      metadata: {
        ...safeMetadata(record, ['description', 'type', 'parentId', 'parent_id', 'layoutType', 'columnLayout']),
        ...(filterViewNames.length > 0 ? { filterViews: filterViewNames.join(', ') } : {}),
        ...(variableNames.length > 0 ? { variables: variableNames.join(', ') } : {}),
      },
    });
    addMapping(accumulator, {
      sourceKind: 'page',
      sourceId: sourceId || undefined,
      sourceName: name,
      sourceArtifact: artifact.name,
      targetKind: 'topic_dashboard',
      targetName: name,
      confidence: childIds.length > 0 ? 'high' : 'medium',
      dependencies: unique([...childIds, ...filters]),
      notes: [
        `${childIds.length} child Card${childIds.length === 1 ? '' : 's'} were linked to this Page.`,
        `${filters.length} Page filter field(s), ${filterViewNames.length} Filter View(s), and ${variableNames.length} Variable control(s) were detected.`,
        appLike ? 'Reusable Cards may migrate, but navigation, actions, persistent state, forms, and mobile behavior require application redesign.' : 'Page filters and interactions require explicit filter-to-tile mapping in Omni.',
        'Page layout remains visual evidence and must be reconciled after the Omni dashboard build.',
      ],
    });
    childIds.forEach((cardId) => addMapping(accumulator, {
      sourceKind: 'page_card_link',
      sourceId: `${sourceId || normalizedName(name, 'page')}:${cardId}`,
      sourceName: `${name} -> ${cardId}`,
      sourceArtifact: artifact.name,
      targetKind: 'dashboard_tile',
      targetName: name,
      confidence: 'high',
      dependencies: [sourceId, cardId].filter(Boolean),
      notes: ['The Domo Page-to-Card membership is preserved for dashboard assembly.'],
    }));
    if (filterViewNames.length > 0) addMapping(accumulator, {
      sourceKind: 'filter_view',
      sourceId: sourceId ? `${sourceId}:filter_views` : undefined,
      sourceName: `${name} Filter Views`,
      sourceArtifact: artifact.name,
      targetKind: 'dashboard_control',
      targetName: name,
      confidence: filters.length > 0 ? 'medium' : 'low',
      dependencies: unique([sourceId, ...childIds, ...filters]),
      notes: ['Personal Filter Views remain personal evidence. Shared/default values require explicit approval before becoming Omni dashboard defaults.'],
    });
    if (hasInteractions) addMapping(accumulator, {
      sourceKind: 'card_interaction',
      sourceId: sourceId ? `${sourceId}:interactions` : undefined,
      sourceName: `${name} Page interactions`,
      sourceArtifact: artifact.name,
      targetKind: appLike ? 'redesign_handoff' : 'dashboard_control',
      targetName: appLike ? 'application_redesign_workstream' : name,
      confidence: 'low',
      dependencies: unique([sourceId, ...childIds]),
      notes: [appLike ? 'App actions and Page Drill require application redesign.' : 'Review click-to-filter, target-card scope, navigation, and persisted-filter behavior before enabling Omni cross-filtering.'],
    });
  });
}

function isPdpNode(path: string, record: Record<string, unknown>): boolean {
  const lowerPath = path.toLowerCase();
  const type = textValue(record.type, record.policyType, record.objectType).toLowerCase();
  return /(?:^|\.)(?:pdp|policies?|policy)\[\d+\]$/.test(lowerPath) || /pdp|policy/.test(type);
}

type DomoPdpPolicyClass = 'row' | 'column_masking' | 'dynamic_row';

function pdpPolicyClass(path: string, record: Record<string, unknown>): DomoPdpPolicyClass {
  const descriptor = `${path} ${textValue(record.type, record.policyType, record.objectType, record.maskingMethod, record.method, record.mode)}`.toLowerCase();
  if (/column.?polic|mask|redact|nullify|hash|unmask/.test(descriptor) || hasNestedKey(record, /maskingMethod|columnPolicy|maskType/i)) return 'column_masking';
  if (/dynamic|managed.?attribute/.test(descriptor) || hasNestedKey(record, /managedAttribute|dynamicPolicy/i)) return 'dynamic_row';
  return 'row';
}

function parsePdpPolicies(nodes: RecordNode[], artifact: MigrationArtifact, accumulator: ParseAccumulator): void {
  const seen = new Set<string>();
  nodes.forEach(({ record, path }) => {
    if (!isPdpNode(path, record)) return;
    const sourceId = identifier(record.id, record.policyId, record.policy_id);
    const datasetId = identifier(record.dataSourceId, record.datasourceId, record.datasetId, record.dataSetId);
    const name = textValue(record.name, record.title, record.displayName) || (sourceId ? `Domo PDP ${sourceId}` : 'Domo PDP policy');
    const columns = collectNamedValues(record, new Set(['column', 'columns', 'field', 'fields', 'filter', 'filters']), 80);
    const policyClass = pdpPolicyClass(path, record);
    const maskingMethods = collectNamedValues(record, new Set(['maskingmethod', 'masktype', 'method']), 20);
    const principalCount = arrayValue(record.users).length + arrayValue(record.groups).length + arrayValue(record.principals).length;
    const key = sourceId || `${datasetId}:${name}:${columns.join('|')}`;
    if (seen.has(key)) return;
    seen.add(key);
    addMapping(accumulator, {
      sourceKind: 'pdp_policy',
      sourceId: sourceId || undefined,
      sourceName: name,
      sourceArtifact: artifact.name,
      targetKind: 'governance_review',
      targetName: 'permission_builder',
      confidence: datasetId && columns.length > 0 ? 'high' : 'medium',
      dependencies: unique([datasetId, ...columns]),
      notes: [
        `Domo PDP class ${policyClass.replaceAll('_', ' ')} references ${columns.length} field${columns.length === 1 ? '' : 's'} and ${principalCount} principal assignment${principalCount === 1 ? '' : 's'}.`,
        maskingMethods.length > 0 ? `Masking method evidence: ${maskingMethods.join(', ')}.` : '',
        policyClass === 'column_masking'
          ? 'Column policies require an owner-reviewed Omni access-grant or user-attribute masking design plus field-level identity tests; never translate them as row filters.'
          : 'Row policies require owner-reviewed user attributes and topic access_filters, including unrestricted-user behavior.',
        'Identities and policy behavior are not automatically deployed.',
      ].filter(Boolean),
    });
  });
}

function parseDatasetAccess(nodes: RecordNode[], artifact: MigrationArtifact, accumulator: ParseAccumulator): void {
  const seen = new Set<string>();
  nodes.forEach(({ record, path }) => {
    if (!/(?:^|\.)(?:datasetaccess|accesslist|permissions?)\[\d+\]$/i.test(path)) return;
    const datasetId = identifier(record.dataSourceId, record.datasourceId, record.datasetId, record.dataSetId, record.id);
    if (!datasetId || seen.has(datasetId)) return;
    seen.add(datasetId);
    const principals = collectNamedValues(record, new Set(['user', 'users', 'group', 'groups', 'principal', 'principals', 'displayname', 'name']), 250);
    addMapping(accumulator, {
      sourceKind: 'dataset_access',
      sourceId: datasetId,
      sourceName: `DataSet access ${datasetId}`,
      sourceArtifact: artifact.name,
      targetKind: 'governance_review',
      targetName: 'permission_builder',
      confidence: principals.length > 0 ? 'high' : 'medium',
      dependencies: [datasetId],
      notes: [
        `${principals.length} user or group assignment${principals.length === 1 ? '' : 's'} were preserved as local governance evidence.`,
        'DataSet access does not automatically become Omni model access; an owner must map, redesign, or retire it.',
      ],
    });
  });
}

function isScheduleOrAlertNode(path: string, record: Record<string, unknown>): boolean {
  const lowerPath = path.toLowerCase();
  const type = textValue(record.type, record.objectType, record.scheduleType).toLowerCase();
  return /(?:^|\.)(?:schedules?|alerts?|subscriptions?)\[\d+\]$/.test(lowerPath) || /schedule|alert|subscription/.test(type);
}

function parseSchedulesAndAlerts(nodes: RecordNode[], artifact: MigrationArtifact, accumulator: ParseAccumulator): void {
  const seen = new Set<string>();
  nodes.forEach(({ record, path }) => {
    if (!isScheduleOrAlertNode(path, record)) return;
    const sourceId = identifier(record.id, record.alertId, record.scheduleId, record.subscriptionId);
    const name = textValue(record.name, record.title, record.displayName) || (sourceId ? `Domo operation ${sourceId}` : 'Domo schedule or alert');
    const targetId = identifier(record.cardId, record.pageId, record.dataSourceId, record.datasetId);
    const key = sourceId || `${name}:${targetId}`;
    if (seen.has(key)) return;
    seen.add(key);
    const recipients = arrayValue(record.recipients).length + arrayValue(record.users).length + arrayValue(record.groups).length;
    addMapping(accumulator, {
      sourceKind: 'schedule_alert',
      sourceId: sourceId || undefined,
      sourceName: name,
      sourceArtifact: artifact.name,
      targetKind: 'operational_review',
      targetName: 'schedule_and_alert_review',
      confidence: sourceId || targetId ? 'medium' : 'low',
      dependencies: unique([targetId]),
      notes: [
        `${recipients} recipient assignment${recipients === 1 ? '' : 's'} detected; identities are retained only for local governance review.`,
        'Delivery frequency, filters, timezone, and ownership require an explicit target outcome.',
      ],
    });
  });
}

function parseUsageAndOwnership(nodes: RecordNode[], artifact: MigrationArtifact, accumulator: ParseAccumulator): void {
  const seen = new Set<string>();
  nodes.forEach(({ record, path }) => {
    const lowerPath = path.toLowerCase();
    const hasUsage = numberValue(record.usageCount, record.viewCount, record.view_count, record.views, record.cardLoads) != null;
    if (!hasUsage && !/(?:domostats|activity|usage|ownership)/.test(lowerPath)) return;
    const sourceId = identifier(record.id, record.cardId, record.pageId, record.dataSourceId, record.datasetId);
    const name = textValue(record.name, record.title, record.displayName) || (sourceId ? `Domo asset ${sourceId}` : 'Domo usage evidence');
    const owner = textValue(record.ownerName, record.owner_name, nestedText(record.owner, 'displayName', 'name', 'email'));
    const key = `${sourceId || name}:${owner}:${numberValue(record.usageCount, record.viewCount, record.view_count, record.views, record.cardLoads) ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    addMapping(accumulator, {
      sourceKind: 'usage_ownership',
      sourceId: sourceId || undefined,
      sourceName: name,
      sourceArtifact: artifact.name,
      targetKind: 'operational_review',
      targetName: 'migration_wave_review',
      confidence: hasUsage ? 'high' : 'medium',
      dependencies: unique([sourceId]),
      notes: [
        hasUsage ? `Usage count ${numberValue(record.usageCount, record.viewCount, record.view_count, record.views, record.cardLoads)} was preserved for migration prioritization.` : 'Ownership evidence was preserved for migration prioritization.',
        owner ? 'An owner was detected and remains local review evidence.' : 'No accountable source owner was detected.',
      ],
    });
  });
}

function handoffKind(path: string, record: Record<string, unknown>): { sourceKind: 'magic_etl' | 'dataflow' | 'workflow' | 'form' | 'code_engine' | 'custom_app' | 'workbench' | 'connector' | 'embed'; targetKind: 'data_engineering_handoff' | 'redesign_handoff'; label: string } | null {
  const haystack = `${path} ${textValue(record.type, record.objectType, record.contentType, record.subtype, record.name, record.title)}`.toLowerCase();
  if (/magic\s*etl|magic_etl/.test(haystack)) return { sourceKind: 'magic_etl', targetKind: 'data_engineering_handoff', label: 'Magic ETL' };
  if (/(?:^|\b)data\s*flow(?:\b|$)|dataflow/.test(haystack)) return { sourceKind: 'dataflow', targetKind: 'data_engineering_handoff', label: 'DataFlow' };
  if (/code\s*engine|code_engine/.test(haystack)) return { sourceKind: 'code_engine', targetKind: 'redesign_handoff', label: 'Code Engine' };
  if (/(?:^|\.)workflows?\[\d+\]|\bworkflow\b/.test(haystack)) return { sourceKind: 'workflow', targetKind: 'redesign_handoff', label: 'Workflow' };
  if (/(?:^|\.)forms?\[\d+\]|\bform\b/.test(haystack)) return { sourceKind: 'form', targetKind: 'redesign_handoff', label: 'Form' };
  if (/workbench/.test(haystack)) return { sourceKind: 'workbench', targetKind: 'data_engineering_handoff', label: 'Workbench' };
  if (/domo\s*everywhere|embed(?:ded|ding)?/.test(haystack)) return { sourceKind: 'embed', targetKind: 'redesign_handoff', label: 'Domo Everywhere or embed' };
  if (/custom\s*app|app\s*studio|manifest\.json/.test(haystack) || isRecord(record.manifest)) return { sourceKind: 'custom_app', targetKind: 'redesign_handoff', label: 'Custom app or App Studio' };
  if (/(?:^|\.)(?:connectors?)\[\d+\]/.test(path.toLowerCase()) || /^connector$/.test(textValue(record.type, record.objectType).toLowerCase())) return { sourceKind: 'connector', targetKind: 'data_engineering_handoff', label: 'Connector' };
  return null;
}

function parsePlatformHandoffs(nodes: RecordNode[], artifact: MigrationArtifact, accumulator: ParseAccumulator): void {
  const seen = new Set<string>();
  nodes.forEach(({ record, path }) => {
    const handoff = handoffKind(path, record);
    if (!handoff) return;
    if ((handoff.sourceKind === 'magic_etl' || handoff.sourceKind === 'dataflow') && sqlStrings(record).length > 0) return;
    const sourceId = identifier(record.id, record.dataFlowId, record.dataflowId, record.appId, record.connectorId);
    const name = textValue(record.name, record.title, record.displayName) || `${handoff.label} evidence`;
    const key = `${handoff.sourceKind}:${sourceId || name}`;
    if (seen.has(key)) return;
    seen.add(key);
    addMapping(accumulator, {
      sourceKind: handoff.sourceKind,
      sourceId: sourceId || undefined,
      sourceName: name,
      sourceArtifact: artifact.name,
      targetKind: handoff.targetKind,
      targetName: handoff.targetKind === 'data_engineering_handoff' ? 'data_engineering_workstream' : 'application_redesign_workstream',
      confidence: sourceId ? 'high' : 'medium',
      dependencies: unique([identifier(record.dataSourceId, record.datasetId), ...recordIds(record.inputs, ['id', 'dataSourceId', 'datasetId'])]),
      notes: [
        `${handoff.label} is outside direct Omni semantic/dashboard deployment and requires an accountable handoff decision.`,
        handoff.sourceKind === 'magic_etl' || handoff.sourceKind === 'dataflow'
          ? `Preserve the complete transformation graph, formulas, inputs, outputs, and update behavior for a warehouse/dbt redesign; ${collectNamedValues(record, new Set(['tile', 'tiles', 'transform', 'transforms']), 500).length} named transform or tile reference(s) were detected.`
          : handoff.sourceKind === 'workflow' || handoff.sourceKind === 'form' || handoff.sourceKind === 'code_engine'
            ? 'Capture triggers, inputs, decision logic, side effects, outputs, owner, and SLA for automation/application redesign.'
            : 'Preserve accountable source ownership and target outcome without copying source credentials.',
      ],
    });
    accumulator.warnings.push(`${artifact.name} contains ${handoff.label} evidence. OmniKit preserved it as a governed handoff instead of silently translating or dropping it.`);
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
    const kind = beastModeKind({}, content);
    if (kind === 'measure') {
      view.measures.push({
        name,
        sql: content,
        aggregateType: 'Domo Beast Mode',
        dependencies: formulaDependencies(content),
        sourceArtifact: artifact.name,
        annotations: beastModeAnnotations({}, kind),
      });
    } else {
      view.fields.push({
        name,
        sql: content,
        sourceArtifact: artifact.name,
        annotations: beastModeAnnotations({}, kind),
        untranslatable: kind === 'level_of_detail'
          ? ['Domo FIXED grouping and filter behavior require reviewed Omni level_of_detail translation.']
          : undefined,
      });
    }
    addMapping(accumulator, {
      sourceKind: 'beast_mode',
      sourceName: name,
      sourceArtifact: artifact.name,
      targetKind: kind === 'measure' ? 'shared_model_measure' : 'shared_model_dimension',
      targetName: 'domo_shared_calculations.view',
      confidence: 'medium',
      dependencies: formulaDependencies(content),
      notes: [`The formula was recognized as ${kind === 'level_of_detail' ? 'FIXED level-of-detail logic' : kind} from text, but a structured Beast Mode export is recommended to preserve its Domo ID, dataset scope, return type, and Variable dependencies.`],
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

function mergeFieldEvidence(fields: MigrationField[]): MigrationField {
  const [first, ...rest] = fields;
  if (!first) throw new Error('Cannot merge an empty Domo field group.');
  const merged: MigrationField = { ...first, annotations: { ...(first.annotations || {}) } };
  rest.forEach((field) => {
    merged.type ||= field.type;
    merged.sql ||= field.sql;
    merged.description ||= field.description;
    merged.sourceId ||= field.sourceId;
    merged.sourceArtifact ||= field.sourceArtifact;
    merged.annotations = { ...(field.annotations || {}), ...(merged.annotations || {}) };
  });
  return merged;
}

function mergeFieldsAdditively(datasetView: string, fields: MigrationField[]) {
  const byName = new Map<string, MigrationField[]>();
  fields.forEach((field) => byName.set(field.name.toLowerCase(), [...(byName.get(field.name.toLowerCase()) || []), field]));
  const merged: MigrationField[] = [];
  const conflicts: DomoManualConflict[] = [];

  byName.forEach((namedFields) => {
    const byFormula = new Map<string, MigrationField[]>();
    namedFields.forEach((field) => {
      const formulaKey = field.sql ? normalizedFormula(field.sql) : `physical:${field.sourceColumn || field.name}`;
      byFormula.set(formulaKey, [...(byFormula.get(formulaKey) || []), field]);
    });
    const variants = Array.from(byFormula.entries()).map(([formula, matchingFields]) => ({ formula, field: mergeFieldEvidence(matchingFields) }));
    if (variants.length === 1) {
      merged.push(variants[0].field);
      return;
    }
    const containsBeastMode = namedFields.some((field) => Boolean(field.annotations?.['domo.beastModeKind']));
    if (!containsBeastMode) {
      merged.push(mergeFieldEvidence(namedFields));
      return;
    }
    const sourceName = namedFields[0].name;
    const conflictVariants = variants.map(({ formula, field }) => {
      const sourceSlug = normalizedName(field.sourceId || field.sourceArtifact || 'variant', 'variant').slice(0, 28);
      const proposedName = `${sourceName}__${sourceSlug}_${shortHash(formula)}`;
      merged.push({ ...field, name: proposedName });
      return {
        sourceId: field.sourceId,
        sourceArtifact: field.sourceArtifact || 'unknown Domo artifact',
        formula: field.sql || '(physical DataSet column)',
        proposedName,
      };
    });
    conflicts.push({
      id: `domo:beast_mode_field_collision:${normalizedName(datasetView, 'dataset')}:${normalizedName(sourceName, 'field')}`.toLowerCase(),
      kind: 'beast_mode_field_collision',
      datasetView,
      sourceName,
      resolution: 'preserve_all',
      variants: conflictVariants,
    });
  });

  return { fields: merged.sort((a, b) => a.name.localeCompare(b.name)), conflicts };
}

function mergeMeasureEvidence(measures: MigrationMeasure[]): MigrationMeasure {
  const [first, ...rest] = measures;
  if (!first) throw new Error('Cannot merge an empty Domo measure group.');
  const merged: MigrationMeasure = { ...first, dependencies: unique(first.dependencies || []), annotations: { ...(first.annotations || {}) } };
  rest.forEach((measure) => {
    merged.type ||= measure.type;
    merged.sql ||= measure.sql;
    merged.description ||= measure.description;
    merged.aggregateType ||= measure.aggregateType;
    merged.sourceId ||= measure.sourceId;
    merged.dependencies = unique([...(merged.dependencies || []), ...(measure.dependencies || [])]);
    merged.annotations = { ...(measure.annotations || {}), ...(merged.annotations || {}) };
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
      map.set(key, { ...view, fields: [...view.fields], measures: [...view.measures], warnings: unique(view.warnings) });
      return;
    }
    existing.description ||= view.description;
    existing.sql ||= view.sql;
    existing.sourceId ||= view.sourceId;
    existing.fields = [...existing.fields, ...view.fields];
    existing.measures = [...existing.measures, ...view.measures];
    existing.warnings = unique([...existing.warnings, ...view.warnings]);
  });
  const conflicts: DomoManualConflict[] = [];
  let deduplicatedMeasureCount = 0;
  const mergedViews = Array.from(map.values()).map((view) => {
    const additiveFields = mergeFieldsAdditively(view.name, view.fields);
    const additive = mergeMeasuresAdditively(view.name, view.measures);
    conflicts.push(...additiveFields.conflicts);
    conflicts.push(...additive.conflicts);
    deduplicatedMeasureCount += additive.deduplicatedMeasureCount;
    return { ...view, fields: additiveFields.fields, measures: additive.measures };
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
    const key = `${dashboard.assetKind || 'dashboard'}:${dashboard.sourceId || dashboard.name.toLowerCase()}`;
    const existing = map.get(key);
    if (!existing) map.set(key, {
      ...dashboard,
      fields: unique(dashboard.fields),
      filters: unique(dashboard.filters),
      dependencyIds: unique(dashboard.dependencyIds || []),
      childIds: unique(dashboard.childIds || []),
      featureFlags: unique(dashboard.featureFlags || []),
      riskFlags: unique(dashboard.riskFlags || []),
    });
    else {
      existing.fields = unique([...existing.fields, ...dashboard.fields]);
      existing.filters = unique([...existing.filters, ...dashboard.filters]);
      existing.dependencyIds = unique([...(existing.dependencyIds || []), ...(dashboard.dependencyIds || [])]);
      existing.childIds = unique([...(existing.childIds || []), ...(dashboard.childIds || [])]);
      existing.featureFlags = unique([...(existing.featureFlags || []), ...(dashboard.featureFlags || [])]);
      existing.riskFlags = unique([...(existing.riskFlags || []), ...(dashboard.riskFlags || [])]);
      existing.chartType ||= dashboard.chartType;
      existing.cardType ||= dashboard.cardType;
      existing.sourceDatasetId ||= dashboard.sourceDatasetId;
      existing.parentId ||= dashboard.parentId;
      existing.path ||= dashboard.path;
      existing.owner ||= dashboard.owner;
      existing.updatedAt ||= dashboard.updatedAt;
      existing.usageCount ??= dashboard.usageCount;
      existing.metadata = { ...(dashboard.metadata || {}), ...(existing.metadata || {}) };
    }
  });
  return Array.from(map.values()).sort((a, b) => (a.assetKind === 'page' ? 0 : 1) - (b.assetKind === 'page' ? 0 : 1) || a.name.localeCompare(b.name));
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
      parseVariables(nodes, artifact, accumulator);
      parseBeastModes(nodes, artifact, accumulator, datasetNames);
      parseDataflows(nodes, artifact, accumulator);
      parsePages(nodes, artifact, accumulator);
      parseCards(nodes, artifact, accumulator);
      parsePdpPolicies(nodes, artifact, accumulator);
      parseDatasetAccess(nodes, artifact, accumulator);
      parseSchedulesAndAlerts(nodes, artifact, accumulator);
      parseUsageAndOwnership(nodes, artifact, accumulator);
      parsePlatformHandoffs(nodes, artifact, accumulator);
    } else {
      parseTextArtifact(artifact, accumulator);
    }
    accumulator.warnings.push(...artifact.parseWarnings);
  });

  const unsupportedArtifacts = artifacts.filter((artifact) => !accumulator.mappings.some((mapping) => mapping.sourceArtifact === artifact.name));
  unsupportedArtifacts.forEach((artifact) => {
    accumulator.warnings.push(`${artifact.name} did not expose a supported Domo schema, semantic, Page/Card, governance, operational, or handoff definition.`);
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
  const beastModeCount = mappings.filter((mapping) => mapping.sourceKind === 'beast_mode').length;
  const warnings = unique([...accumulator.warnings, ...views.flatMap((view) => view.warnings)], 80);
  const summary = [
    `${artifacts.length} Domo artifact${artifacts.length === 1 ? '' : 's'}`,
    `${views.filter((view) => view.kind === 'dataset').length} dataset view${views.filter((view) => view.kind === 'dataset').length === 1 ? '' : 's'}`,
    `${beastModeCount} Beast Mode${beastModeCount === 1 ? '' : 's'}`,
    `${views.filter((view) => view.kind === 'query_view').length} query view${views.filter((view) => view.kind === 'query_view').length === 1 ? '' : 's'}`,
    `${relationships.length} relationship${relationships.length === 1 ? '' : 's'}`,
    `${dashboards.filter((dashboard) => dashboard.assetKind === 'page').length} Page${dashboards.filter((dashboard) => dashboard.assetKind === 'page').length === 1 ? '' : 's'}`,
    `${dashboards.filter((dashboard) => dashboard.assetKind !== 'page').length} Card${dashboards.filter((dashboard) => dashboard.assetKind !== 'page').length === 1 ? '' : 's'}`,
  ].join(' · ');

  const governanceItemCount = mappings.filter((mapping) => mapping.targetKind === 'governance_review').length;
  const operationalItemCount = mappings.filter((mapping) => mapping.targetKind === 'operational_review').length;
  const handoffCount = mappings.filter((mapping) => mapping.targetKind === 'data_engineering_handoff' || mapping.targetKind === 'redesign_handoff').length;

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
        pageCount: dashboards.filter((dashboard) => dashboard.assetKind === 'page').length,
        governanceItemCount,
        operationalItemCount,
        handoffCount,
        warnings,
      },
  };
}

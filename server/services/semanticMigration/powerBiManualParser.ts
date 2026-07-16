import type {
  MigrationArtifact,
  MigrationDashboardEvidence,
  MigrationField,
  MigrationMeasure,
  MigrationRelationship,
  MigrationView,
  PowerBiManualMapping,
  PowerBiManualModelEvidence,
  PowerBiManualPageEvidence,
  PowerBiManualParseResult,
  PowerBiManualProjectEvidence,
  PowerBiManualReportEvidence,
  PowerBiManualVisualEvidence,
} from '../../../src/services/semanticMigration/types';

export const POWER_BI_MANUAL_SCHEMA_VERSION = 'omnikit.powerbi.manual.v2' as const;

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(...values: unknown[]): string {
  const value = values.find((item) => (typeof item === 'string' || typeof item === 'number') && String(item).trim());
  return value == null ? '' : String(value).trim();
}

function cleanName(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '').trim();
}

function slug(value: string, fallback: string): string {
  return (value || fallback).replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase() || fallback;
}

function unique(values: string[], limit = 200): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).slice(0, limit);
}

function collectRecords(value: unknown, depth = 0, output: RecordValue[] = []): RecordValue[] {
  if (depth > 16 || output.length >= 10_000) return output;
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

function stableMappingId(mapping: Omit<PowerBiManualMapping, 'id'>): string {
  return ['powerbi', mapping.sourceKind, mapping.sourceId || mapping.sourceName, mapping.sourceArtifact, mapping.targetKind, mapping.targetName]
    .join(':').toLowerCase().replace(/[^a-z0-9:_-]+/g, '_');
}

function mapping(input: Omit<PowerBiManualMapping, 'id'>): PowerBiManualMapping {
  return { ...input, id: stableMappingId(input) };
}

function identity(record: RecordValue, fallback: string) {
  return {
    id: text(record.id, record.objectId, record.datasetId, record.reportId),
    name: text(record.name, record.displayName, record.title, fallback),
    description: text(record.description),
  };
}

function fieldFromColumn(value: unknown, artifactName: string): MigrationField | null {
  const record = isRecord(value) ? value : {};
  const name = text(record.name, record.displayName);
  if (!name) return null;
  return {
    name,
    type: text(record.dataType, record.type),
    sql: text(record.expression, record.dax, record.formula),
    description: text(record.description),
    sourceColumn: text(record.sourceColumn),
    formatString: text(record.formatString),
    dataCategory: text(record.dataCategory),
    hidden: typeof record.isHidden === 'boolean' ? record.isHidden : undefined,
    annotations: annotationsFrom(record.annotations),
    sourceArtifact: artifactName,
  };
}

function measureFromRecord(value: unknown, artifactName: string): MigrationMeasure | null {
  const record = isRecord(value) ? value : {};
  const item = identity(record, '');
  if (!item.name) return null;
  return {
    name: item.name,
    sourceId: item.id || undefined,
    sql: text(record.expression, record.dax, record.formula),
    aggregateType: 'DAX',
    description: item.description,
    formatString: text(record.formatString),
    hidden: typeof record.isHidden === 'boolean' ? record.isHidden : undefined,
    annotations: annotationsFrom(record.annotations),
    sourceArtifact: artifactName,
  };
}

function annotationsFrom(value: unknown): Record<string, string> | undefined {
  const entries = Array.isArray(value)
    ? value.filter(isRecord).map((item) => [text(item.name), text(item.value)] as const)
    : isRecord(value) ? Object.entries(value).map(([key, item]) => [key, text(item)] as const) : [];
  const clean = entries.filter(([key, item]) => key && item);
  return clean.length ? Object.fromEntries(clean) : undefined;
}

function expressionText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map((item) => text(item)).filter(Boolean).join('\n').trim();
  if (!isRecord(value)) return '';
  return expressionText(value.expression) || text(value.query, value.sql, value.source);
}

function tmdlExpression(block: string, property: string): string {
  const lines = block.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^\\s*${property}\\s*=`, 'i').test(line));
  if (start < 0) return '';
  const indent = lines[start].match(/^\s*/)?.[0].length || 0;
  const inline = text(lines[start].replace(new RegExp(`^\\s*${property}\\s*=\\s*`, 'i'), ''));
  const body: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const current = lines[index];
    const currentIndent = current.match(/^\s*/)?.[0].length || 0;
    if (current.trim() && currentIndent <= indent) break;
    body.push(current.slice(Math.min(current.length, indent + 2)));
  }
  return [inline, body.join('\n').trim()].filter(Boolean).join('\n');
}

function columnReference(value: string): { table: string; column: string; qualified: string } {
  const cleaned = cleanName(value).replace(/\[([^\]]+)\]$/, '.$1');
  const separator = cleaned.lastIndexOf('.');
  const table = separator >= 0 ? cleanName(cleaned.slice(0, separator)) : cleaned;
  const column = separator >= 0 ? cleanName(cleaned.slice(separator + 1)) : '';
  return { table, column, qualified: column ? `${table}.${column}` : table };
}

function relationshipSql(from: string, to: string) {
  return from && to ? `${from} = ${to}` : '';
}

function tmdlProperty(block: string, property: string) {
  return text(block.match(new RegExp(`^\\s*${property}:\\s*(.+)$`, 'mi'))?.[1]);
}

interface TmdlDeclaration {
  name: string;
  expression: string;
  hasAssignment: boolean;
  block: string;
}

function nestedTmdlBlocks(content: string, keyword: string): TmdlDeclaration[] {
  const lines = content.split(/\r?\n/);
  const output: TmdlDeclaration[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(new RegExp(`^(\\s+)${keyword}\\s+(.+?)(?:\\s*=\\s*(.*))?\\s*$`, 'i'));
    if (!match) continue;
    const indent = match[1].length;
    const body: string[] = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const current = lines[cursor];
      const currentIndent = current.match(/^\s*/)?.[0].length || 0;
      if (current.trim() && currentIndent <= indent) break;
      body.push(current);
    }
    output.push({ name: cleanName(match[2]), expression: text(match[3]), hasAssignment: lines[index].includes('='), block: body.join('\n') });
  }
  return output;
}

function directTmdlIndent(block: string): number {
  const indents = block.split(/\r?\n/).filter((line) => line.trim()).map((line) => line.match(/^\s*/)?.[0].length || 0);
  return indents.length ? Math.min(...indents) : 0;
}

function directTmdlAnnotations(block: string): Record<string, string> | undefined {
  const indent = directTmdlIndent(block);
  const entries = block.split(/\r?\n/).flatMap((line) => {
    if ((line.match(/^\s*/)?.[0].length || 0) !== indent) return [];
    const match = line.trim().match(/^annotation\s+(.+?)\s*=\s*(.*)$/i);
    return match && cleanName(match[1]) && match[2].trim() ? [[cleanName(match[1]), match[2].trim()] as const] : [];
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function tmdlBooleanProperty(block: string, property: string): boolean | undefined {
  const match = block.match(new RegExp(`^\\s*${property}(?:\\s*:\\s*(true|false))?\\s*$`, 'mi'));
  if (!match) return undefined;
  return match[1] ? match[1].toLowerCase() === 'true' : true;
}

function declarationExpression(declaration: TmdlDeclaration): string {
  if (declaration.expression) return declaration.expression;
  const propertyExpression = tmdlExpression(declaration.block, 'expression');
  if (!declaration.hasAssignment) return propertyExpression;
  const indent = directTmdlIndent(declaration.block);
  const propertyPattern = /^(?:annotation\s+|dataType\s*:|description\s*:|displayFolder\s*:|formatString\s*:|isHidden(?:\s*:|\s*$)|lineageTag\s*:|sourceColumn\s*:|dataCategory\s*:|summarizeBy\s*:|changedProperty\s+)/i;
  const expressionLines: string[] = [];
  for (const line of declaration.block.split(/\r?\n/)) {
    if (!line.trim()) {
      if (expressionLines.length) expressionLines.push('');
      continue;
    }
    const currentIndent = line.match(/^\s*/)?.[0].length || 0;
    const direct = currentIndent === indent ? line.slice(indent).trimStart() : '';
    if (direct && propertyPattern.test(direct)) break;
    expressionLines.push(line.slice(Math.min(line.length, indent)));
  }
  return expressionLines.join('\n').trim() || propertyExpression;
}

function tmdlTablePermissions(block: string): Array<{ table: string; expression: string }> {
  const lines = block.split(/\r?\n/);
  const permissions: Array<{ table: string; expression: string }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s+)tablePermission\s+(.+?)\s*=\s*(.*)$/i);
    if (!match) continue;
    const indent = match[1].length;
    const expressionLines = [match[3].trim()];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const current = lines[cursor];
      const currentIndent = current.match(/^\s*/)?.[0].length || 0;
      if (current.trim() && currentIndent <= indent) break;
      expressionLines.push(current.slice(Math.min(current.length, indent + 2)));
      index = cursor;
    }
    const cleanedLines = expressionLines
      .map((line) => line.trimEnd())
      .filter((line, lineIndex, values) => !(lineIndex === 0 && /^```/.test(line.trim())) && !(lineIndex === values.length - 1 && /^```\s*$/.test(line.trim())));
    permissions.push({ table: cleanName(match[2]), expression: cleanedLines.join('\n').trim() });
  }
  return permissions;
}

function mergeFields(fields: MigrationField[]): MigrationField[] {
  const map = new Map<string, MigrationField>();
  fields.forEach((field) => { if (!map.has(field.name.toLowerCase())) map.set(field.name.toLowerCase(), field); });
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function mergeMeasures(measures: MigrationMeasure[]): MigrationMeasure[] {
  const map = new Map<string, MigrationMeasure>();
  measures.forEach((measure) => {
    const key = measure.sourceId || measure.name.toLowerCase();
    const existing = map.get(key);
    if (!existing || (!existing.sql && measure.sql)) map.set(key, measure);
  });
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function mergeViews(views: MigrationView[]): MigrationView[] {
  const map = new Map<string, MigrationView>();
  views.forEach((view) => {
    const key = view.sourceId || view.name.toLowerCase();
    const existing = map.get(key);
    if (!existing) {
      map.set(key, view);
      return;
    }
    map.set(key, {
      ...existing,
      ...view,
      fields: mergeFields([...existing.fields, ...view.fields]),
      measures: mergeMeasures([...existing.measures, ...view.measures]),
      annotations: { ...existing.annotations, ...view.annotations },
      warnings: unique([...existing.warnings, ...view.warnings]),
    });
  });
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function mergeRelationships(relationships: MigrationRelationship[]): MigrationRelationship[] {
  const map = new Map<string, MigrationRelationship>();
  relationships.forEach((relationship) => {
    const key = `${relationship.from.toLowerCase()}::${relationship.to.toLowerCase()}`;
    if (!map.has(key)) map.set(key, relationship);
  });
  return Array.from(map.values());
}

function mergeDashboards(dashboards: MigrationDashboardEvidence[]): MigrationDashboardEvidence[] {
  const map = new Map<string, MigrationDashboardEvidence>();
  dashboards.forEach((dashboard) => {
    const key = dashboard.sourceId || dashboard.name.toLowerCase();
    const existing = map.get(key);
    map.set(key, existing ? { ...existing, ...dashboard, fields: unique([...existing.fields, ...dashboard.fields]), filters: unique([...existing.filters, ...dashboard.filters]) } : dashboard);
  });
  return Array.from(map.values());
}

function dedupeMappings(mappings: PowerBiManualMapping[]): PowerBiManualMapping[] {
  return Array.from(new Map(mappings.map((item) => [item.id, item])).values());
}

function tmdlBlocks(content: string, keyword: string): TmdlDeclaration[] {
  const lines = content.split(/\r?\n/);
  const output: TmdlDeclaration[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(new RegExp(`^${keyword}\\s+(.+?)(?:\\s*=\\s*(.*))?\\s*$`, 'i'));
    if (!match) continue;
    const body: string[] = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (/^[A-Za-z][A-Za-z ]*\s+.+$/.test(lines[cursor]) && !/^\s/.test(lines[cursor])) break;
      body.push(lines[cursor]);
    }
    output.push({ name: cleanName(match[1]), expression: text(match[2]), hasAssignment: lines[index].includes('='), block: body.join('\n') });
  }
  return output;
}

function parseTmdlArtifact(artifact: MigrationArtifact) {
  const mappings: PowerBiManualMapping[] = [];
  const views: MigrationView[] = [];
  const relationships: MigrationRelationship[] = [];
  const warnings: string[] = [];
  const models: PowerBiManualModelEvidence[] = [];
  let roleCount = 0;
  let dataSourceCount = 0;
  let partitionCount = 0;
  let calculatedColumnCount = 0;
  let hierarchyCount = 0;
  let calculationGroupCount = 0;
  let perspectiveCount = 0;
  let cultureCount = 0;

  tmdlBlocks(artifact.content, 'table').forEach(({ name, block }) => {
    const columns = nestedTmdlBlocks(block, 'column');
    const fields = mergeFields(columns.map((column) => ({
      name: column.name,
      type: tmdlProperty(column.block, 'dataType'),
      sql: declarationExpression(column),
      description: tmdlProperty(column.block, 'description'),
      sourceColumn: tmdlProperty(column.block, 'sourceColumn'),
      formatString: tmdlProperty(column.block, 'formatString'),
      dataCategory: tmdlProperty(column.block, 'dataCategory'),
      hidden: tmdlBooleanProperty(column.block, 'isHidden'),
      annotations: directTmdlAnnotations(column.block),
      sourceArtifact: artifact.name,
    })));
    calculatedColumnCount += fields.filter((field) => Boolean(field.sql)).length;
    const measures = mergeMeasures(nestedTmdlBlocks(block, 'measure').map((measure) => ({
      name: measure.name,
      sql: declarationExpression(measure),
      aggregateType: 'DAX',
      description: tmdlProperty(measure.block, 'description'),
      formatString: tmdlProperty(measure.block, 'formatString'),
      hidden: tmdlBooleanProperty(measure.block, 'isHidden'),
      annotations: directTmdlAnnotations(measure.block),
      sourceArtifact: artifact.name,
    })));
    const partitions = nestedTmdlBlocks(block, 'partition');
    const partitionEvidence = partitions.map((partition) => ({
      name: partition.name,
      mode: tmdlProperty(partition.block, 'mode'),
      sourceType: partition.expression,
      expression: tmdlExpression(partition.block, 'source') || tmdlProperty(partition.block, 'source'),
    }));
    const partitionExpressions = partitionEvidence.map((partition) => partition.expression).filter(Boolean);
    partitionCount += partitions.length;
    const hierarchies = nestedTmdlBlocks(block, 'hierarchy');
    hierarchyCount += hierarchies.length;
    const calculationGroups = nestedTmdlBlocks(block, 'calculationGroup');
    calculationGroupCount += calculationGroups.length;
    const hierarchyEvidence = hierarchies.map((hierarchy) => ({
      name: hierarchy.name,
      levels: nestedTmdlBlocks(hierarchy.block, 'level').map((level, ordinal) => ({ name: level.name, column: tmdlProperty(level.block, 'column'), ordinal })),
    }));
    const calculationItems = calculationGroups.flatMap((group) => nestedTmdlBlocks(group.block, 'calculationItem').map((item, ordinal) => ({ name: item.name, expression: declarationExpression(item), ordinal })));
    columns.filter((column) => column.hasAssignment && !declarationExpression(column)).forEach((column) => warnings.push(`${artifact.name} declares calculated column ${name}.${column.name} but its multiline DAX expression could not be recovered.`));
    nestedTmdlBlocks(block, 'measure').filter((measure) => measure.hasAssignment && !declarationExpression(measure)).forEach((measure) => warnings.push(`${artifact.name} declares measure ${name}.${measure.name} but its multiline DAX expression could not be recovered.`));
    views.push({ name, sourceArtifact: artifact.name, fields, measures, sql: partitionExpressions.join('\n\n'), annotations: directTmdlAnnotations(block), partitions: partitionEvidence, hierarchies: hierarchyEvidence, calculationItems, warnings: [] });
    mappings.push(mapping({ sourceKind: 'table', sourceName: name, sourceArtifact: artifact.name, targetKind: 'shared_model_view', targetName: `${slug(name, 'table')}.view`, confidence: 'high', notes: [] }));
    fields.forEach((field) => mappings.push(mapping({ sourceKind: field.sql ? 'calculated_column' : 'column', sourceName: `${name}.${field.name}`, sourceArtifact: artifact.name, targetKind: 'dimension', targetName: `${slug(name, 'table')}.${slug(field.name, 'column')}`, confidence: field.sql ? 'medium' : 'high', notes: field.sql ? ['Calculated-column DAX requires target-grain validation.'] : [] })));
    measures.forEach((measure) => mappings.push(mapping({ sourceKind: 'measure', sourceName: `${name}.${measure.name}`, sourceArtifact: artifact.name, targetKind: 'shared_model_measure', targetName: `${slug(name, 'table')}.${slug(measure.name, 'measure')}`, confidence: measure.sql ? 'high' : 'medium', notes: [] })));
    partitionEvidence.forEach((partition) => mappings.push(mapping({ sourceKind: 'partition', sourceName: `${name}.${partition.name}`, sourceArtifact: artifact.name, targetKind: 'query_view', targetName: `${slug(name, 'table')}.query.view`, confidence: partition.expression ? 'medium' : 'low', notes: ['Power Query/M must be reviewed before conversion to warehouse SQL or an Omni query view.'] })));
    hierarchies.forEach((hierarchy) => mappings.push(mapping({ sourceKind: 'hierarchy', sourceName: `${name}.${hierarchy.name}`, sourceArtifact: artifact.name, targetKind: 'shared_model_view', targetName: `${slug(name, 'table')}.view`, confidence: 'medium', notes: ['Preserve hierarchy ordering as field metadata or topic curation.'] })));
    calculationGroups.forEach((group) => mappings.push(mapping({ sourceKind: 'calculation_group', sourceName: `${name}.${group.name}`, sourceArtifact: artifact.name, targetKind: 'shared_model_measure', targetName: `${slug(name, 'table')}.view`, confidence: 'low', notes: ['Calculation groups require explicit measure-design review in Omni.'] })));
  });

  tmdlBlocks(artifact.content, 'relationship').forEach(({ name, block }) => {
    const from = columnReference(text(block.match(/^\s+fromColumn:\s*(.+)$/mi)?.[1]));
    const to = columnReference(text(block.match(/^\s+toColumn:\s*(.+)$/mi)?.[1]));
    if (!from.table || !to.table) return;
    const behavior = [tmdlProperty(block, 'fromCardinality'), tmdlProperty(block, 'toCardinality'), tmdlProperty(block, 'crossFilteringBehavior'), tmdlProperty(block, 'isActive')].filter(Boolean).join(' · ');
    relationships.push({ from: from.table, to: to.table, sql: relationshipSql(from.qualified, to.qualified), relationshipType: behavior, active: tmdlProperty(block, 'isActive').toLowerCase() !== 'false', crossFilteringBehavior: tmdlProperty(block, 'crossFilteringBehavior'), sourceArtifact: artifact.name });
    mappings.push(mapping({ sourceKind: 'relationship', sourceName: name || `${from.qualified} -> ${to.qualified}`, sourceArtifact: artifact.name, targetKind: 'relationships_file', targetName: 'relationships', confidence: 'high', notes: [relationshipSql(from.qualified, to.qualified)] }));
  });

  tmdlBlocks(artifact.content, 'role').forEach(({ name, block }) => {
    roleCount += 1;
    const permissions = tmdlTablePermissions(block);
    permissions.filter((permission) => !permission.expression).forEach((permission) => warnings.push(`${artifact.name} declares role ${name} table permission for ${permission.table} but its multiline filter expression could not be recovered.`));
    const filters = permissions.filter((permission) => permission.expression).map((permission) => `${permission.table}: ${permission.expression}`);
    if (permissions.length === 0) warnings.push(`${artifact.name} declares role ${name} without a readable tablePermission predicate; review the source security definition before migration.`);
    mappings.push(mapping({ sourceKind: 'role', sourceName: name, sourceArtifact: artifact.name, targetKind: 'governance_review', targetName: slug(name, 'role'), confidence: 'medium', notes: ['Power BI RLS roles require explicit Omni access-policy review.', ...filters] }));
  });

  tmdlBlocks(artifact.content, 'expression').forEach((declaration) => {
    const { name } = declaration;
    dataSourceCount += 1;
    const expression = declarationExpression(declaration);
    if (declaration.hasAssignment && !expression) warnings.push(`${artifact.name} declares named expression ${name} but its multiline M expression could not be recovered.`);
    views.push({ name, kind: 'query_view', sourceArtifact: artifact.name, sql: expression, fields: [], measures: [], warnings: ['Power Query/M evidence requires warehouse-SQL or query-view review.'] });
    mappings.push(mapping({ sourceKind: 'data_source', sourceName: name, sourceArtifact: artifact.name, targetKind: 'query_view', targetName: `${slug(name, 'source')}.query.view`, confidence: expression ? 'medium' : 'low', notes: ['Power Query/M is preserved as evidence, not executed by OmniKit.'] }));
  });
  tmdlBlocks(artifact.content, 'dataSource').forEach(({ name }) => {
    dataSourceCount += 1;
    mappings.push(mapping({ sourceKind: 'data_source', sourceName: name, sourceArtifact: artifact.name, targetKind: 'model_context', targetName: 'selected_omni_connection', confidence: 'medium', notes: ['Confirm the destination Omni connection and warehouse object mapping.'] }));
  });
  tmdlBlocks(artifact.content, 'perspective').forEach(({ name }) => {
    perspectiveCount += 1;
    mappings.push(mapping({ sourceKind: 'perspective', sourceName: name, sourceArtifact: artifact.name, targetKind: 'topic', targetName: `${slug(name, 'perspective')}.topic`, confidence: 'medium', notes: ['Perspective visibility should be reviewed as topic curation.'] }));
  });
  tmdlBlocks(artifact.content, 'culture').forEach(({ name }) => {
    cultureCount += 1;
    mappings.push(mapping({ sourceKind: 'culture', sourceName: name, sourceArtifact: artifact.name, targetKind: 'governance_review', targetName: slug(name, 'culture'), confidence: 'low', notes: ['Translations and locale formats require explicit target review.'] }));
  });

  tmdlBlocks(artifact.content, 'model').forEach(({ name, block }) => {
    const culture = tmdlProperty(block, 'culture');
    const annotations = directTmdlAnnotations(block);
    models.push({ id: slug(`${artifact.name}:${name}`, 'power_bi_model'), name, sourceArtifact: artifact.name, culture: culture || undefined, annotations, warnings: [] });
    if (culture) {
      cultureCount += 1;
      mappings.push(mapping({ sourceKind: 'culture', sourceName: culture, sourceArtifact: artifact.name, targetKind: 'governance_review', targetName: slug(culture, 'culture'), confidence: 'low', notes: ['Model culture and locale formats require explicit target review.'] }));
    }
  });

  if (views.length === 0 && relationships.length === 0 && roleCount === 0 && !/^(?:model|annotation)\s+/mi.test(artifact.content)) warnings.push(`${artifact.name} did not expose supported Power BI TMDL tables, measures, relationships, or roles.`);
  return { mappings, views, relationships, models, warnings, roleCount, dataSourceCount, partitionCount, calculatedColumnCount, hierarchyCount, calculationGroupCount, perspectiveCount, cultureCount };
}

function visualFields(record: RecordValue): string[] {
  const serialized = JSON.stringify(record);
  const queryRefs = Array.from(serialized.matchAll(/"queryRef"\s*:\s*"([^"]+)"/g)).map((match) => match[1]);
  const direct = [
    ...(Array.isArray(record.fields) ? record.fields : []),
    ...(Array.isArray(record.columns) ? record.columns : []),
    ...(Array.isArray(record.measures) ? record.measures : []),
  ].map((value) => isRecord(value) ? text(value.queryRef, value.name, value.displayName) : text(value));
  return unique([...queryRefs, ...direct]);
}

function parseJsonArtifact(artifact: MigrationArtifact | undefined): RecordValue | null {
  if (!artifact) return null;
  try {
    const value = JSON.parse(artifact.content) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function normalizedPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/');
}

function scalarStrings(value: unknown, keys: Set<string>, depth = 0, output: string[] = []): string[] {
  if (depth > 16 || output.length > 1_000) return output;
  if (Array.isArray(value)) {
    value.forEach((item) => scalarStrings(item, keys, depth + 1, output));
    return output;
  }
  if (!isRecord(value)) return output;
  Object.entries(value).forEach(([key, item]) => {
    if (keys.has(key.toLowerCase()) && (typeof item === 'string' || typeof item === 'number')) output.push(String(item));
    else if (item && typeof item === 'object') scalarStrings(item, keys, depth + 1, output);
  });
  return output;
}

function filterFields(value: unknown): string[] {
  const queryRefs = scalarStrings(value, new Set(['queryref', 'field', 'property', 'column', 'measure']));
  return unique(queryRefs.filter((item) => !/^\$schema$/i.test(item)));
}

function visualTitle(value: RecordValue, fallback: string): string {
  const literals = scalarStrings(value.visualContainerObjects ?? value.vcObjects, new Set(['value']));
  return cleanName(literals.find((item) => item.trim()) || fallback).replace(/^'|'$/g, '');
}

const POWER_BI_NESTED_JSON_LIMITS = {
  characters: 1_000_000,
  depth: 16,
  nodes: 20_000,
} as const;

function decodeNestedPowerBiJson(value: unknown, label: string, warnings: string[], depth = 0, budget = { nodes: 0 }): unknown {
  budget.nodes += 1;
  if (depth > POWER_BI_NESTED_JSON_LIMITS.depth || budget.nodes > POWER_BI_NESTED_JSON_LIMITS.nodes) {
    warnings.push(`${label} exceeded the safe nested JSON structure limit and was not expanded.`);
    return null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
    if (trimmed.length > POWER_BI_NESTED_JSON_LIMITS.characters) {
      warnings.push(`${label} exceeded the ${POWER_BI_NESTED_JSON_LIMITS.characters.toLocaleString()} character nested JSON limit and was not expanded.`);
      return null;
    }
    try {
      return decodeNestedPowerBiJson(JSON.parse(trimmed) as unknown, label, warnings, depth + 1, budget);
    } catch {
      warnings.push(`${label} contained malformed nested JSON and could not be expanded.`);
      return null;
    }
  }
  if (Array.isArray(value)) return value.map((item) => decodeNestedPowerBiJson(item, label, warnings, depth + 1, budget));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeNestedPowerBiJson(item, label, warnings, depth + 1, budget)]));
}

function normalizedPowerBiFieldReference(value: string): string {
  const cleaned = value.trim();
  const aggregate = cleaned.match(/^[A-Za-z][A-Za-z0-9_ ]*\((.+)\)$/);
  return (aggregate?.[1] || cleaned).replace(/^'|'$/g, '').trim();
}

function selectedQueryFields(value: unknown, depth = 0, output: string[] = []): string[] {
  if (depth > 16 || output.length > 1_000) return output;
  if (Array.isArray(value)) {
    value.forEach((item) => selectedQueryFields(item, depth + 1, output));
    return output;
  }
  if (!isRecord(value)) return output;
  Object.entries(value).forEach(([key, item]) => {
    if (['select', 'projections'].includes(key.toLowerCase()) && Array.isArray(item)) {
      item.filter(isRecord).forEach((selection) => {
        const reference = text(selection.queryRef, selection.Name, selection.name);
        if (reference) output.push(normalizedPowerBiFieldReference(reference));
      });
    }
    if (item && typeof item === 'object') selectedQueryFields(item, depth + 1, output);
  });
  return unique(output);
}

function queryFieldBindings(value: unknown): Array<{ role: string; field: string }> {
  const bindings: Array<{ role: string; field: string }> = [];
  const visit = (item: unknown, role = 'unspecified', depth = 0) => {
    if (depth > 16 || bindings.length > 1_000) return;
    if (Array.isArray(item)) {
      item.forEach((entry) => visit(entry, role, depth + 1));
      return;
    }
    if (!isRecord(item)) return;
    const reference = text(item.queryRef, item.Name);
    if (reference) bindings.push({ role, field: normalizedPowerBiFieldReference(reference) });
    Object.entries(item).forEach(([key, child]) => {
      if (!child || typeof child !== 'object') return;
      visit(child, ['projections', 'select'].includes(key.toLowerCase()) ? role : key, depth + 1);
    });
  };
  visit(value);
  return Array.from(new Map(bindings.filter((binding) => binding.field).map((binding) => [`${binding.role.toLowerCase()}:${binding.field.toLowerCase()}`, binding])).values());
}

function boundedFormattingEvidence(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const serialized = JSON.stringify(value);
  return serialized.length > 4_000 ? `${serialized.slice(0, 4_000)}...` : serialized;
}

function numericPosition(record: RecordValue): PowerBiManualVisualEvidence['position'] {
  return ['x', 'y', 'width', 'height'].every((key) => typeof record[key] === 'number') ? {
    x: record.x as number,
    y: record.y as number,
    width: record.width as number,
    height: record.height as number,
    ...(typeof record.z === 'number' ? { z: record.z } : {}),
    ...(typeof record.tabOrder === 'number' ? { tabOrder: record.tabOrder } : {}),
  } : undefined;
}

const POWER_BI_BUILT_IN_VISUALS = new Set([
  'areaChart', 'barChart', 'basicShape', 'bookmarkNavigator', 'card', 'clusteredBarChart', 'clusteredColumnChart', 'columnChart',
  'decompositionTreeVisual', 'donutChart', 'filledMap', 'funnel', 'gauge', 'image', 'keyDriversVisual', 'kpi', 'lineChart',
  'lineClusteredColumnComboChart', 'lineStackedColumnComboChart', 'map', 'matrix', 'multiRowCard', 'pageNavigator', 'pieChart',
  'qnaVisual', 'ribbonChart', 'scatterChart', 'shape', 'slicer', 'stackedAreaChart', 'stackedBarChart', 'stackedColumnChart',
  'tableEx', 'textbox', 'treemap', 'waterfallChart',
].map((item) => item.toLowerCase()));

function assembleEnhancedPbirProjects(artifacts: MigrationArtifact[]): {
  projects: PowerBiManualProjectEvidence[];
  supportedFiles: Set<string>;
} {
  const byPath = new Map(artifacts.map((artifact) => [normalizedPath(artifact.name), artifact]));
  const supportedFiles = new Set<string>();
  const projects: PowerBiManualProjectEvidence[] = [];
  const scannerReports = artifacts.flatMap((artifact) => {
    const root = parseJsonArtifact(artifact);
    if (!root) return [];
    const workspaces = Array.isArray(root.workspaces) ? root.workspaces.filter(isRecord) : [];
    return [
      ...(Array.isArray(root.reports) ? root.reports.filter(isRecord) : []),
      ...workspaces.flatMap((workspace) => Array.isArray(workspace.reports) ? workspace.reports.filter(isRecord) : []),
    ];
  });

  Array.from(byPath.entries()).filter(([path]) => /\.Report\/definition\/report\.json$/i.test(path)).forEach(([reportPath, reportArtifact]) => {
    const reportRoot = reportPath.replace(/\/definition\/report\.json$/i, '');
    const definitionRoot = `${reportRoot}/definition`;
    const reportJson = parseJsonArtifact(reportArtifact) || {};
    const pbirArtifact = byPath.get(`${reportRoot}/definition.pbir`);
    const pbir = parseJsonArtifact(pbirArtifact) || {};
    const pagesMetadataArtifact = byPath.get(`${definitionRoot}/pages/pages.json`);
    const pagesMetadata = parseJsonArtifact(pagesMetadataArtifact) || {};
    const pageOrder = Array.isArray(pagesMetadata.pageOrder) ? pagesMetadata.pageOrder.map((item) => text(item)).filter(Boolean) : [];
    const pageEntries = Array.from(byPath.entries()).filter(([path]) => path.startsWith(`${definitionRoot}/pages/`) && /\/page\.json$/i.test(path));
    const reportName = text(reportJson.name, reportRoot.split('/').pop()?.replace(/\.Report$/i, ''), 'Power BI report');
    const scannerMatch = scannerReports.find((report) => text(report.name).toLowerCase() === reportName.toLowerCase());
    const reportId = text(scannerMatch?.id, scannerMatch?.reportId, reportJson.id, reportJson.reportId, slug(`${reportRoot}:${reportName}`, 'report'));
    const datasetId = text(scannerMatch?.datasetId, reportJson.datasetId, reportJson.semanticModelId);
    const reportFilters = filterFields(reportJson.filterConfig);
    const pages: PowerBiManualPageEvidence[] = pageEntries.map(([pagePath, pageArtifact], fallbackOrder) => {
      const pageJson = parseJsonArtifact(pageArtifact) || {};
      const pageId = text(pageJson.name, pagePath.match(/\/pages\/([^/]+)\/page\.json$/i)?.[1], `page-${fallbackOrder + 1}`);
      const visualEntries = Array.from(byPath.entries()).filter(([path]) => path.startsWith(`${definitionRoot}/pages/${pageId}/visuals/`) && /\/visual\.json$/i.test(path));
      const visuals: PowerBiManualVisualEvidence[] = visualEntries.map(([visualPath, visualArtifact], visualIndex) => {
        const container = parseJsonArtifact(visualArtifact) || {};
        const visual = isRecord(container.visual) ? container.visual : container;
        const id = text(container.name, visual.name, visualPath.match(/\/visuals\/([^/]+)\/visual\.json$/i)?.[1], `visual-${visualIndex + 1}`);
        const visualType = text(visual.visualType, container.visualType, 'unknown');
        const position = isRecord(container.position) ? container.position : {};
        const customVisual = Boolean(container.customVisual || visual.customVisual || !POWER_BI_BUILT_IN_VISUALS.has(visualType.toLowerCase()));
        const unsupportedReasons = customVisual ? [`${visualType} is not a recognized built-in Power BI visual and requires explicit redesign or image fallback.`] : [];
        return {
          id,
          name: id,
          title: visualTitle(visual, id),
          visualType,
          pageId,
          sourceArtifact: visualArtifact.name,
          fields: visualFields(visual),
          fieldBindings: queryFieldBindings(visual.query),
          filters: filterFields(container.filterConfig),
          position: ['x', 'y', 'width', 'height'].every((key) => typeof position[key] === 'number') ? {
            x: position.x as number,
            y: position.y as number,
            width: position.width as number,
            height: position.height as number,
            z: typeof position.z === 'number' ? position.z : undefined,
            tabOrder: typeof position.tabOrder === 'number' ? position.tabOrder : undefined,
          } : undefined,
          query: isRecord(visual.query) ? JSON.stringify(visual.query) : text(visual.query),
          formatting: boundedFormattingEvidence(visual.visualContainerObjects),
          customVisual,
          unsupportedReasons,
        };
      });
      const pageFilters = filterFields(pageJson.filterConfig);
      const drillthroughFields = unique([
        ...filterFields(pageJson.drillThrough),
        ...filterFields(pageJson.drillthrough),
        ...filterFields(pageJson.drillthroughConfig),
      ]);
      return {
        id: pageId,
        name: pageId,
        displayName: text(pageJson.displayName, pageId),
        order: Math.max(0, pageOrder.indexOf(pageId) >= 0 ? pageOrder.indexOf(pageId) : fallbackOrder),
        sourceArtifact: pageArtifact.name,
        width: typeof pageJson.width === 'number' ? pageJson.width : undefined,
        height: typeof pageJson.height === 'number' ? pageJson.height : undefined,
        filters: pageFilters,
        drillthroughFields,
        visuals,
      };
    }).sort((a, b) => a.order - b.order);
    const projectFiles = Array.from(byPath.keys()).filter((path) => path === `${reportRoot}/definition.pbir` || path.startsWith(`${reportRoot}/`));
    const semanticModelPath = isRecord(pbir.datasetReference) && isRecord(pbir.datasetReference.byPath) ? text(pbir.datasetReference.byPath.path) : '';
    const semanticModelName = semanticModelPath.split('/').filter((part) => part && part !== '..').pop()?.replace(/\.SemanticModel$/i, '') || '';
    const semanticModelFiles = semanticModelName ? Array.from(byPath.keys()).filter((path) => path.startsWith(`${semanticModelName}.SemanticModel/`)) : [];
    [...projectFiles, ...semanticModelFiles].forEach((path) => supportedFiles.add(path));
    const bookmarks = Array.from(byPath.keys()).filter((path) => path.startsWith(`${definitionRoot}/bookmarks/`) && path.endsWith('.json'));
    const themeFiles = Array.from(byPath.keys()).filter((path) => /\/StaticResources\/.*(?:theme|baseThemes).*\.json$/i.test(path));
    const warnings = unique(pages.flatMap((page) => page.visuals.flatMap((visual) => visual.unsupportedReasons)));
    const report: PowerBiManualReportEvidence = { id: reportId, name: reportName, datasetId, sourceArtifact: reportArtifact.name, filters: reportFilters, pages, bookmarks, themeFiles, warnings };
    projects.push({
      id: slug(reportRoot, 'power_bi_project'),
      name: reportName,
      sourceFiles: unique([...projectFiles, ...semanticModelFiles], 1_000),
      semanticModelIds: unique([datasetId, semanticModelName]),
      reports: [report],
      warnings,
    });
    [reportPath, `${reportRoot}/definition.pbir`, `${definitionRoot}/pages/pages.json`].forEach((path) => { if (byPath.has(path)) supportedFiles.add(path); });
  });

  artifacts.forEach((artifact) => {
    const artifactPath = normalizedPath(artifact.name);
    if (supportedFiles.has(artifactPath)) return;
    const root = parseJsonArtifact(artifact);
    if (!root) return;
    const reportCandidates = [
      ...((Array.isArray(root.sections) || Array.isArray(root.pages)) ? [root] : []),
      ...(Array.isArray(root.reports) ? root.reports.filter(isRecord) : []),
    ].filter((report) => Array.isArray(report.sections) || Array.isArray(report.pages));
    reportCandidates.forEach((report, reportIndex) => {
      const sections = [
        ...(Array.isArray(report.pages) ? report.pages : []),
        ...(Array.isArray(report.sections) ? report.sections : []),
      ].filter(isRecord);
      if (!sections.length) return;
      const reportWarnings: string[] = [];
      const reportItem = identity(report, `Power BI report ${reportIndex + 1}`);
      const reportId = reportItem.id || slug(`${artifactPath}:${reportItem.name}`, 'report');
      const pages: PowerBiManualPageEvidence[] = sections.map((page, pageIndex) => {
        const pageItem = identity(page, `Page ${pageIndex + 1}`);
        const pageId = pageItem.id || slug(`${reportId}:${pageItem.name}`, `page_${pageIndex + 1}`);
        const visuals = [
          ...(Array.isArray(page.visuals) ? page.visuals : []),
          ...(Array.isArray(page.visualContainers) ? page.visualContainers : []),
        ].filter(isRecord).map((container, visualIndex): PowerBiManualVisualEvidence => {
          const label = `${artifact.name} page ${pageItem.name} visual ${visualIndex + 1}`;
          const visualWarnings: string[] = [];
          const config = decodeNestedPowerBiJson(container.config, `${label} config`, visualWarnings);
          const query = decodeNestedPowerBiJson(container.query, `${label} query`, visualWarnings);
          const filters = decodeNestedPowerBiJson(container.filters, `${label} filters`, visualWarnings);
          const configRecord = isRecord(config) ? config : {};
          const singleVisual = isRecord(configRecord.singleVisual) ? configRecord.singleVisual : configRecord;
          const id = text(container.id, container.name, configRecord.name, `visual-${visualIndex + 1}`);
          const name = text(container.name, configRecord.name, id);
          const visualType = text(singleVisual.visualType, container.visualType, 'unknown');
          const customVisual = visualType !== 'unknown' && !POWER_BI_BUILT_IN_VISUALS.has(visualType.toLowerCase());
          const unsupportedReasons = [
            ...(customVisual ? [`${visualType} is not a recognized built-in Power BI visual and requires explicit redesign or image fallback.`] : []),
            ...visualWarnings,
          ];
          reportWarnings.push(...visualWarnings);
          const prototypeQuery = singleVisual.prototypeQuery;
          const fields = unique([
            ...selectedQueryFields(prototypeQuery),
            ...selectedQueryFields(query),
            ...visualFields(singleVisual),
            ...visualFields(container),
          ]);
          const fieldBindings = queryFieldBindings(prototypeQuery ?? query);
          fields.forEach((field) => {
            if (!fieldBindings.some((binding) => binding.field === field)) fieldBindings.push({ role: 'unspecified', field });
          });
          return {
            id,
            name,
            title: visualTitle(singleVisual, text(container.title, container.displayName, name, id)),
            visualType,
            pageId,
            sourceArtifact: artifact.name,
            fields,
            fieldBindings,
            filters: unique([...filterFields(filters), ...filterFields(container.filterConfig)]),
            position: numericPosition(container),
            query: query == null ? undefined : JSON.stringify(query),
            formatting: boundedFormattingEvidence(singleVisual.visualContainerObjects ?? singleVisual.vcObjects),
            customVisual,
            unsupportedReasons,
          };
        });
        return {
          id: pageId,
          name: text(page.name, pageId),
          displayName: text(page.displayName, pageItem.name, pageId),
          order: typeof page.ordinal === 'number' ? page.ordinal : pageIndex,
          sourceArtifact: artifact.name,
          width: typeof page.width === 'number' ? page.width : undefined,
          height: typeof page.height === 'number' ? page.height : undefined,
          filters: filterFields(decodeNestedPowerBiJson(page.filters, `${artifact.name} page ${pageItem.name} filters`, reportWarnings)),
          drillthroughFields: unique(filterFields(page.drillthroughFilters)),
          visuals,
        };
      });
      const reportEvidence: PowerBiManualReportEvidence = {
        id: reportId,
        name: reportItem.name,
        datasetId: text(report.datasetId, report.semanticModelId),
        sourceArtifact: artifact.name,
        filters: filterFields(decodeNestedPowerBiJson(report.filters, `${artifact.name} report filters`, reportWarnings)),
        pages,
        bookmarks: [],
        themeFiles: [],
        warnings: unique(reportWarnings),
      };
      projects.push({
        id: slug(`${artifactPath}:${reportId}`, 'power_bi_project'),
        name: reportItem.name,
        sourceFiles: [artifactPath],
        semanticModelIds: unique([reportEvidence.datasetId || '']),
        reports: [reportEvidence],
        warnings: reportEvidence.warnings,
      });
      supportedFiles.add(artifactPath);
    });
  });

  artifacts.map((artifact) => normalizedPath(artifact.name)).filter((path) => path.endsWith('.pbip') || path.includes('.SemanticModel/')).forEach((path) => supportedFiles.add(path));
  return { projects, supportedFiles };
}

export function parsePowerBiManualArtifacts(artifacts: MigrationArtifact[]): PowerBiManualParseResult {
  const mappings: PowerBiManualMapping[] = [];
  const views: MigrationView[] = [];
  const models: PowerBiManualModelEvidence[] = [];
  const relationships: MigrationRelationship[] = [];
  const dashboards: MigrationDashboardEvidence[] = [];
  const warnings: string[] = [];
  const workspaceKeys = new Set<string>();
  const modelKeys = new Set<string>();
  const reportKeys = new Set<string>();
  const pageKeys = new Set<string>();
  const visualKeys = new Set<string>();
  const roleKeys = new Set<string>();
  const dataSourceKeys = new Set<string>();
  const partitionKeys = new Set<string>();
  const calculatedColumnKeys = new Set<string>();
  const hierarchyKeys = new Set<string>();
  const calculationGroupKeys = new Set<string>();
  const perspectiveKeys = new Set<string>();
  const cultureKeys = new Set<string>();
  const bookmarkKeys = new Set<string>();
  const interactionKeys = new Set<string>();
  const unsupportedVisualKeys = new Set<string>();
  const enhancedPbir = assembleEnhancedPbirProjects(artifacts);

  enhancedPbir.projects.forEach((project) => project.reports.forEach((report) => {
    reportKeys.add(report.id);
    mappings.push(mapping({ sourceKind: 'report', sourceId: report.id, sourceName: report.name, sourceArtifact: report.sourceArtifact, targetKind: 'topic', targetName: `${slug(report.name, 'report')}.topic`, confidence: 'high', notes: ['Enhanced PBIR report assembled from its split project files.'] }));
    const dashboardFields: string[] = [];
    const dashboardFilters: string[] = [...report.filters];
    report.pages.forEach((page) => {
      const pageKey = `${report.id}:${page.id}`;
      pageKeys.add(pageKey);
      mappings.push(mapping({ sourceKind: 'page', sourceId: page.id, sourceName: `${report.name}.${page.displayName}`, sourceArtifact: page.sourceArtifact, targetKind: 'dashboard_section', targetName: page.displayName, confidence: 'high', notes: [`Page order ${page.order + 1}; canvas ${page.width || 'unknown'} x ${page.height || 'unknown'}.`] }));
      page.filters.forEach((filter) => {
        dashboardFilters.push(filter);
        mappings.push(mapping({ sourceKind: 'filter', sourceName: `${page.displayName}.${filter}`, sourceArtifact: page.sourceArtifact, targetKind: 'dashboard_filter', targetName: slug(filter, 'filter'), confidence: 'medium', notes: ['Page-level filter scope and saved selections require explicit review.'] }));
      });
      page.drillthroughFields.forEach((field) => mappings.push(mapping({ sourceKind: 'drillthrough', sourceName: `${page.displayName}.${field}`, sourceArtifact: page.sourceArtifact, targetKind: 'dashboard_interaction', targetName: slug(field, 'drillthrough'), confidence: 'medium', notes: ['Drillthrough behavior requires explicit target-page validation.'] })));
      page.visuals.forEach((visual) => {
        const visualKey = `${pageKey}:${visual.id}`;
        visualKeys.add(visualKey);
        dashboardFields.push(...visual.fields);
        dashboardFilters.push(...visual.filters);
        if (visual.customVisual) unsupportedVisualKeys.add(visualKey);
        mappings.push(mapping({ sourceKind: 'visual', sourceId: visual.id, sourceName: visual.title || visual.name, sourceArtifact: visual.sourceArtifact, targetKind: 'dashboard_tile', targetName: visual.title || visual.name, confidence: visual.customVisual ? 'low' : visual.fields.length ? 'high' : 'medium', notes: [`Power BI visual type: ${visual.visualType}.`, ...visual.unsupportedReasons] }));
        if (visual.visualType.toLowerCase() === 'slicer') mappings.push(mapping({ sourceKind: 'slicer', sourceId: visual.id, sourceName: visual.title || visual.name, sourceArtifact: visual.sourceArtifact, targetKind: 'dashboard_filter', targetName: slug(visual.title || visual.name, 'slicer'), confidence: 'medium', notes: ['Slicer synchronization and saved selections require explicit review.'] }));
        const source = artifacts.find((artifact) => artifact.name === visual.sourceArtifact)?.content || '';
        if (/visualInteractions|"interactions"\s*:/i.test(source)) {
          interactionKeys.add(visualKey);
          mappings.push(mapping({ sourceKind: 'interaction', sourceId: visual.id, sourceName: visual.title || visual.name, sourceArtifact: visual.sourceArtifact, targetKind: 'dashboard_interaction', targetName: visual.title || visual.name, confidence: 'low', notes: ['Cross-visual interaction behavior requires explicit target validation.'] }));
        }
      });
    });
    report.bookmarks.forEach((bookmarkFile) => {
      bookmarkKeys.add(bookmarkFile.toLowerCase());
      mappings.push(mapping({ sourceKind: 'bookmark', sourceName: bookmarkFile.split('/').pop()?.replace(/\.json$/i, '') || 'bookmark', sourceArtifact: bookmarkFile, targetKind: 'dashboard_bookmark', targetName: slug(bookmarkFile, 'bookmark'), confidence: 'low', notes: ['Bookmark state and visibility require explicit migration review.'] }));
    });
    report.themeFiles.forEach((themeFile) => mappings.push(mapping({ sourceKind: 'theme', sourceName: themeFile.split('/').pop() || 'theme', sourceArtifact: themeFile, targetKind: 'dashboard_theme', targetName: 'dashboard_theme', confidence: 'medium', notes: ['Theme tokens should be translated into target dashboard and brand settings.'] })));
    dashboards.push({ name: report.name, sourceId: report.id, sourceDatasetId: report.datasetId, sourceArtifact: report.sourceArtifact, fields: unique(dashboardFields), filters: unique(dashboardFilters) });
  }));

  artifacts.forEach((artifact) => {
    let value: unknown = null;
    try { value = JSON.parse(artifact.content) as unknown; } catch { value = null; }
    if (!value) {
      const parsed = parseTmdlArtifact(artifact);
      mappings.push(...parsed.mappings);
      views.push(...parsed.views);
      relationships.push(...parsed.relationships);
      models.push(...parsed.models);
      warnings.push(...parsed.warnings);
      parsed.mappings.filter((item) => item.sourceKind === 'role').forEach((item) => roleKeys.add(item.sourceName.toLowerCase()));
      parsed.mappings.filter((item) => item.sourceKind === 'data_source').forEach((item) => dataSourceKeys.add(`${item.sourceArtifact}:${item.sourceName}`.toLowerCase()));
      parsed.mappings.filter((item) => item.sourceKind === 'partition').forEach((item) => partitionKeys.add(`${item.sourceArtifact}:${item.sourceName}`.toLowerCase()));
      parsed.mappings.filter((item) => item.sourceKind === 'calculated_column').forEach((item) => calculatedColumnKeys.add(`${item.sourceArtifact}:${item.sourceName}`.toLowerCase()));
      parsed.mappings.filter((item) => item.sourceKind === 'hierarchy').forEach((item) => hierarchyKeys.add(`${item.sourceArtifact}:${item.sourceName}`.toLowerCase()));
      parsed.mappings.filter((item) => item.sourceKind === 'calculation_group').forEach((item) => calculationGroupKeys.add(`${item.sourceArtifact}:${item.sourceName}`.toLowerCase()));
      parsed.mappings.filter((item) => item.sourceKind === 'perspective').forEach((item) => perspectiveKeys.add(`${item.sourceArtifact}:${item.sourceName}`.toLowerCase()));
      parsed.mappings.filter((item) => item.sourceKind === 'culture').forEach((item) => cultureKeys.add(`${item.sourceArtifact}:${item.sourceName}`.toLowerCase()));
      return;
    }

    const root = isRecord(value) ? value : {};
    const workspaceCandidates = [
      ...(Array.isArray(root.workspaces) ? root.workspaces : []),
      ...(text(root.type).toLowerCase() === 'workspace' ? [root] : []),
    ].filter(isRecord);
    workspaceCandidates.forEach((workspace, index) => {
      const item = identity(workspace, `Workspace ${index + 1}`);
      const key = item.id || item.name.toLowerCase();
      if (workspaceKeys.has(key)) return;
      workspaceKeys.add(key);
      const principalCount = Array.isArray(workspace.users) ? workspace.users.length : 0;
      mappings.push(mapping({ sourceKind: 'workspace', sourceId: item.id, sourceName: item.name, sourceArtifact: artifact.name, targetKind: 'model_context', targetName: 'selected_omni_instance', confidence: 'high', notes: [`Workspace permissions and endorsements remain governance review context.${principalCount ? ` ${principalCount} principal assignment${principalCount === 1 ? '' : 's'} detected; identities are not included in AI evidence.` : ''}`] }));
    });

    const modelCandidates = [
      ...(isRecord(root.model) ? [root.model] : []),
      ...(Array.isArray(root.semanticModels) ? root.semanticModels : []),
      ...(Array.isArray(root.datasets) ? root.datasets : []),
      ...workspaceCandidates.flatMap((workspace) => Array.isArray(workspace.datasets) ? workspace.datasets : []),
    ].filter(isRecord);
    modelCandidates.forEach((model, modelIndex) => {
      const item = identity(model, text(root.name, `Semantic model ${modelIndex + 1}`));
      const key = item.id || item.name.toLowerCase();
      models.push({
        id: slug(`${artifact.name}:${item.id || item.name}`, 'power_bi_model'),
        name: item.name,
        sourceArtifact: artifact.name,
        culture: text(model.culture) || undefined,
        annotations: annotationsFrom(model.annotations),
        warnings: [],
      });
      if (!modelKeys.has(key)) {
        modelKeys.add(key);
        mappings.push(mapping({ sourceKind: 'semantic_model', sourceId: item.id, sourceName: item.name, sourceArtifact: artifact.name, targetKind: 'model_context', targetName: 'selected_omni_model', confidence: 'high', notes: [] }));
      }
      const tables = Array.isArray(model.tables) ? model.tables.filter(isRecord) : [];
      tables.forEach((table, tableIndex) => {
        const tableItem = identity(table, `Table ${tableIndex + 1}`);
        const columns = mergeFields((Array.isArray(table.columns) ? table.columns : []).map((column) => fieldFromColumn(column, artifact.name)).filter((column): column is MigrationField => Boolean(column)));
        const measures = mergeMeasures((Array.isArray(table.measures) ? table.measures : []).map((measure) => measureFromRecord(measure, artifact.name)).filter((measure): measure is MigrationMeasure => Boolean(measure)));
        const partitions = (Array.isArray(table.partitions) ? table.partitions : []).filter(isRecord).map((partition, partitionIndex) => {
          const source = isRecord(partition.source) ? partition.source : {};
          return {
            name: text(partition.name, `Partition ${partitionIndex + 1}`),
            mode: text(partition.mode),
            sourceType: text(source.type, partition.type),
            expression: expressionText(source.expression) || expressionText(partition.expression) || text(source.query),
          };
        });
        const hierarchies = (Array.isArray(table.hierarchies) ? table.hierarchies : []).filter(isRecord).map((hierarchy, hierarchyIndex) => ({
          name: text(hierarchy.name, `Hierarchy ${hierarchyIndex + 1}`),
          levels: (Array.isArray(hierarchy.levels) ? hierarchy.levels : []).filter(isRecord).map((level, levelIndex) => ({
            name: text(level.name, `Level ${levelIndex + 1}`),
            column: text(level.column, level.sourceColumn),
            ordinal: typeof level.ordinal === 'number' ? level.ordinal : levelIndex,
          })),
        }));
        const calculationGroup = isRecord(table.calculationGroup) ? table.calculationGroup : {};
        const calculationItems = (Array.isArray(calculationGroup.calculationItems) ? calculationGroup.calculationItems : []).filter(isRecord).map((calculationItem, calculationItemIndex) => ({
          name: text(calculationItem.name, `Calculation item ${calculationItemIndex + 1}`),
          expression: expressionText(calculationItem.expression),
          ordinal: typeof calculationItem.ordinal === 'number' ? calculationItem.ordinal : calculationItemIndex,
        }));
        views.push({
          name: tableItem.name,
          sourceId: tableItem.id,
          description: tableItem.description,
          sourceArtifact: artifact.name,
          fields: columns,
          measures,
          sql: partitions.map((partition) => partition.expression).filter(Boolean).join('\n\n'),
          hidden: typeof table.isHidden === 'boolean' ? table.isHidden : undefined,
          annotations: annotationsFrom(table.annotations),
          partitions,
          hierarchies,
          calculationItems,
          warnings: [],
        });
        mappings.push(mapping({ sourceKind: 'table', sourceId: tableItem.id, sourceName: tableItem.name, sourceArtifact: artifact.name, targetKind: 'shared_model_view', targetName: `${slug(tableItem.name, 'table')}.view`, confidence: 'high', notes: [] }));
        columns.forEach((column) => {
          const sourceKind = column.sql ? 'calculated_column' : 'column';
          mappings.push(mapping({ sourceKind, sourceName: `${tableItem.name}.${column.name}`, sourceArtifact: artifact.name, targetKind: 'dimension', targetName: `${slug(tableItem.name, 'table')}.${slug(column.name, 'column')}`, confidence: column.sql ? 'medium' : 'high', notes: column.sql ? ['Calculated-column DAX requires target-grain validation.'] : [] }));
          if (column.sql) calculatedColumnKeys.add(`${artifact.name}:${tableItem.name}.${column.name}`.toLowerCase());
        });
        measures.forEach((measure) => mappings.push(mapping({ sourceKind: 'measure', sourceId: measure.sourceId, sourceName: `${tableItem.name}.${measure.name}`, sourceArtifact: artifact.name, targetKind: 'shared_model_measure', targetName: `${slug(tableItem.name, 'table')}.${slug(measure.name, 'measure')}`, confidence: measure.sql ? 'high' : 'medium', notes: measure.sql ? [] : ['Retrieve the DAX expression before semantic generation.'] })));
        partitions.forEach((partition) => {
          const sourceName = `${tableItem.name}.${partition.name}`;
          partitionKeys.add(`${artifact.name}:${sourceName}`.toLowerCase());
          mappings.push(mapping({ sourceKind: 'partition', sourceName, sourceArtifact: artifact.name, targetKind: 'query_view', targetName: `${slug(tableItem.name, 'table')}.query.view`, confidence: partition.expression ? 'medium' : 'low', notes: ['Power Query/M must be reviewed before conversion to warehouse SQL or an Omni query view.'] }));
        });
        hierarchies.forEach((hierarchy) => {
          const sourceName = `${tableItem.name}.${hierarchy.name}`;
          hierarchyKeys.add(`${artifact.name}:${sourceName}`.toLowerCase());
          mappings.push(mapping({ sourceKind: 'hierarchy', sourceName, sourceArtifact: artifact.name, targetKind: 'shared_model_view', targetName: `${slug(tableItem.name, 'table')}.view`, confidence: 'medium', notes: [`Hierarchy levels: ${hierarchy.levels.map((level) => level.column || level.name).join(' > ') || 'not exposed'}.`] }));
        });
        if (calculationItems.length || Object.keys(calculationGroup).length) {
          const sourceName = `${tableItem.name}.calculationGroup`;
          calculationGroupKeys.add(`${artifact.name}:${sourceName}`.toLowerCase());
          mappings.push(mapping({ sourceKind: 'calculation_group', sourceName, sourceArtifact: artifact.name, targetKind: 'shared_model_measure', targetName: `${slug(tableItem.name, 'table')}.view`, confidence: 'low', notes: ['Calculation groups require explicit measure-design review in Omni.'] }));
        }
      });
      (Array.isArray(model.relationships) ? model.relationships : []).filter(isRecord).forEach((relationship, index) => {
        const fromTable = text(relationship.fromTable, relationship.from);
        const toTable = text(relationship.toTable, relationship.to);
        const fromColumn = text(relationship.fromColumn);
        const toColumn = text(relationship.toColumn);
        if (!fromTable || !toTable) return;
        const from = fromColumn ? `${fromTable}.${fromColumn}` : fromTable;
        const to = toColumn ? `${toTable}.${toColumn}` : toTable;
        const behavior = [text(relationship.fromCardinality), text(relationship.toCardinality), text(relationship.crossFilteringBehavior)].filter(Boolean).join(' · ');
        relationships.push({ from: fromTable, to: toTable, sql: relationshipSql(from, to), relationshipType: behavior, active: relationship.isActive !== false, crossFilteringBehavior: text(relationship.crossFilteringBehavior), sourceArtifact: artifact.name });
        mappings.push(mapping({ sourceKind: 'relationship', sourceId: text(relationship.name, relationship.id), sourceName: text(relationship.name, `Relationship ${index + 1}`), sourceArtifact: artifact.name, targetKind: 'relationships_file', targetName: 'relationships', confidence: fromColumn && toColumn ? 'high' : 'medium', notes: [relationshipSql(from, to)].filter(Boolean) }));
      });
      (Array.isArray(model.roles) ? model.roles : []).filter(isRecord).forEach((role, index) => {
        const roleItem = identity(role, `Role ${index + 1}`);
        const roleKey = roleItem.id || roleItem.name.toLowerCase();
        if (roleKeys.has(roleKey)) return;
        roleKeys.add(roleKey);
        const filters = (Array.isArray(role.tablePermissions) ? role.tablePermissions : []).filter(isRecord).map((permission) => `${text(permission.name, permission.table)}: ${expressionText(permission.filterExpression)}`).filter((value) => !value.endsWith(': '));
        mappings.push(mapping({ sourceKind: 'role', sourceId: roleItem.id, sourceName: roleItem.name, sourceArtifact: artifact.name, targetKind: 'access_policy', targetName: slug(roleItem.name, 'role'), confidence: 'medium', notes: ['Power BI RLS/OLS rules require explicit Omni access-policy review. Principal identities are not included in AI evidence.', ...filters] }));
      });
      (Array.isArray(model.expressions) ? model.expressions : []).filter(isRecord).forEach((expression, index) => {
        const sourceName = text(expression.name, `Expression ${index + 1}`);
        const sql = expressionText(expression.expression);
        dataSourceKeys.add(`${artifact.name}:${sourceName}`.toLowerCase());
        views.push({ name: sourceName, kind: 'query_view', sourceArtifact: artifact.name, sql, fields: [], measures: [], warnings: ['Power Query/M evidence requires warehouse-SQL or query-view review.'] });
        mappings.push(mapping({ sourceKind: 'data_source', sourceName, sourceArtifact: artifact.name, targetKind: 'query_view', targetName: `${slug(sourceName, 'source')}.query.view`, confidence: sql ? 'medium' : 'low', notes: ['Power Query/M is preserved as evidence, not executed by OmniKit.'] }));
      });
      (Array.isArray(model.dataSources) ? model.dataSources : []).filter(isRecord).forEach((dataSource, index) => {
        const sourceName = text(dataSource.name, `Data source ${index + 1}`);
        dataSourceKeys.add(`${artifact.name}:${sourceName}`.toLowerCase());
        mappings.push(mapping({ sourceKind: 'data_source', sourceName, sourceArtifact: artifact.name, targetKind: 'model_context', targetName: 'selected_omni_connection', confidence: 'medium', notes: ['Confirm the destination Omni connection and warehouse object mapping.'] }));
      });
      (Array.isArray(model.perspectives) ? model.perspectives : []).filter(isRecord).forEach((perspective, index) => {
        const sourceName = text(perspective.name, `Perspective ${index + 1}`);
        perspectiveKeys.add(`${artifact.name}:${sourceName}`.toLowerCase());
        mappings.push(mapping({ sourceKind: 'perspective', sourceName, sourceArtifact: artifact.name, targetKind: 'topic', targetName: `${slug(sourceName, 'perspective')}.topic`, confidence: 'medium', notes: ['Perspective visibility should be reviewed as topic curation.'] }));
      });
      (Array.isArray(model.cultures) ? model.cultures : []).filter(isRecord).forEach((culture, index) => {
        const sourceName = text(culture.name, `Culture ${index + 1}`);
        cultureKeys.add(`${artifact.name}:${sourceName}`.toLowerCase());
        mappings.push(mapping({ sourceKind: 'culture', sourceName, sourceArtifact: artifact.name, targetKind: 'governance_review', targetName: slug(sourceName, 'culture'), confidence: 'low', notes: ['Translations and locale formats require explicit target review.'] }));
      });
      if (isRecord(model.sensitivityLabel)) {
        const label = text(model.sensitivityLabel.displayName, model.sensitivityLabel.name, model.sensitivityLabel.labelId, 'Sensitivity label');
        mappings.push(mapping({ sourceKind: 'sensitivity_label', sourceName: label, sourceArtifact: artifact.name, targetKind: 'governance_review', targetName: 'sensitivity_review', confidence: 'medium', notes: ['Sensitivity labels are governance evidence and are not automatically recreated.'] }));
      }
    });

    const reportCandidates = [
      ...(Array.isArray(root.reports) ? root.reports : []),
      ...workspaceCandidates.flatMap((workspace) => Array.isArray(workspace.reports) ? workspace.reports : []),
      ...((Array.isArray(root.pages) || Array.isArray(root.sections)) ? [root] : []),
    ].filter(isRecord);
    reportCandidates.forEach((report, reportIndex) => {
      const reportItem = identity(report, `Power BI report ${reportIndex + 1}`);
      const reportKey = reportItem.id || reportItem.name.toLowerCase();
      if (!reportKeys.has(reportKey)) {
        reportKeys.add(reportKey);
        mappings.push(mapping({ sourceKind: 'report', sourceId: reportItem.id, sourceName: reportItem.name, sourceArtifact: artifact.name, targetKind: 'topic', targetName: `${slug(reportItem.name, 'report')}.topic`, confidence: 'high', notes: [] }));
      }
      const pages = [
        ...(Array.isArray(report.pages) ? report.pages : []),
        ...(Array.isArray(report.sections) ? report.sections : []),
      ].filter(isRecord);
      const dashboardFields: string[] = [];
      const dashboardFilters: string[] = [];
      pages.forEach((page, pageIndex) => {
        const pageItem = identity(page, `Page ${pageIndex + 1}`);
        const pageKey = `${reportKey}:${pageItem.id || pageItem.name.toLowerCase()}`;
        if (!pageKeys.has(pageKey)) {
          pageKeys.add(pageKey);
          mappings.push(mapping({ sourceKind: 'page', sourceId: pageItem.id, sourceName: `${reportItem.name}.${pageItem.name}`, sourceArtifact: artifact.name, targetKind: 'dashboard_section', targetName: pageItem.name, confidence: 'high', notes: [] }));
        }
        const visuals = [
          ...(Array.isArray(page.visuals) ? page.visuals : []),
          ...(Array.isArray(page.visualContainers) ? page.visualContainers : []),
        ].filter(isRecord);
        visuals.forEach((visual, visualIndex) => {
          const visualItem = identity(visual, `Visual ${visualIndex + 1}`);
          const visualKey = `${pageKey}:${visualItem.id || visualItem.name.toLowerCase()}`;
          const fields = visualFields(visual);
          dashboardFields.push(...fields);
          if (!visualKeys.has(visualKey)) {
            visualKeys.add(visualKey);
            mappings.push(mapping({ sourceKind: 'visual', sourceId: visualItem.id, sourceName: visualItem.name, sourceArtifact: artifact.name, targetKind: 'dashboard_tile', targetName: visualItem.name, confidence: fields.length ? 'high' : 'medium', notes: ['Power BI visual formatting, interactions, and custom visuals require target rendering review.'] }));
          }
          const visualFilters = arraysFor(collectRecords(visual), ['filters']).map((filter) => isRecord(filter) ? text(filter.name, filter.displayName, filter.field, filter.queryRef) : text(filter));
          dashboardFilters.push(...visualFilters);
        });
        const pageFilters = (Array.isArray(page.filters) ? page.filters : []).map((filter) => isRecord(filter) ? text(filter.name, filter.displayName, filter.field, filter.queryRef) : text(filter));
        dashboardFilters.push(...pageFilters);
      });
      dashboards.push({ name: reportItem.name, sourceId: reportItem.id, sourceDatasetId: text(report.datasetId, report.semanticModelId), sourceArtifact: artifact.name, fields: unique(dashboardFields), filters: unique(dashboardFilters) });
      unique(dashboardFilters).forEach((filter) => mappings.push(mapping({ sourceKind: 'filter', sourceName: filter, sourceArtifact: artifact.name, targetKind: 'filter', targetName: slug(filter, 'filter'), confidence: 'medium', notes: ['Filter scope and saved selections require explicit review.'] })));
    });

    if (/customVisual|visualType"\s*:\s*"(?:scriptVisual|rVisual|pythonVisual)|rowLevelSecurity|objectLevelSecurity/i.test(JSON.stringify(value))) {
      warnings.push(`${artifact.name} contains custom visuals, script visuals, or security rules that require explicit migration decisions.`);
    }
  });

  const mergedViews = mergeViews(views);
  const mergedRelationships = mergeRelationships(relationships);
  const mergedDashboards = mergeDashboards(dashboards);
  const cleanMappings = dedupeMappings(mappings);
  const supportedArtifacts = new Set([...cleanMappings.map((item) => normalizedPath(item.sourceArtifact)), ...enhancedPbir.supportedFiles]);
  const unsupportedArtifacts = artifacts.filter((artifact) => !supportedArtifacts.has(normalizedPath(artifact.name)));
  unsupportedArtifacts.forEach((artifact) => warnings.push(`${artifact.name} did not expose a Power BI workspace, semantic model, table, measure, relationship, role, report, page, or visual.`));
  const metrics = mergeMeasures(mergedViews.flatMap((view) => view.measures));
  const mergedModels = Array.from(new Map(models.map((model) => [`${normalizedPath(model.sourceArtifact).toLowerCase()}:${model.id}`, model])).values())
    .sort((a, b) => `${a.sourceArtifact}:${a.name}`.localeCompare(`${b.sourceArtifact}:${b.name}`));
  const cleanWarnings = unique([...warnings, ...artifacts.flatMap((artifact) => artifact.parseWarnings)], 100);

  return {
    inventory: {
      sourceTool: 'power_bi', artifactCount: artifacts.length, artifacts, views: mergedViews, explores: [], relationships: mergedRelationships,
      dashboards: mergedDashboards, metrics, warnings: cleanWarnings,
      summary: `${artifacts.length} Power BI artifact${artifacts.length === 1 ? '' : 's'} · ${mergedViews.length} table view${mergedViews.length === 1 ? '' : 's'} · ${metrics.length} DAX measure${metrics.length === 1 ? '' : 's'} · ${mergedRelationships.length} relationship${mergedRelationships.length === 1 ? '' : 's'} · ${mergedDashboards.length} report${mergedDashboards.length === 1 ? '' : 's'}`,
    },
    mappings: cleanMappings,
    diagnostics: {
      schemaVersion: POWER_BI_MANUAL_SCHEMA_VERSION,
      parsedArtifactCount: artifacts.length - unsupportedArtifacts.length,
      unsupportedArtifactCount: unsupportedArtifacts.length,
      workspaceCount: workspaceKeys.size,
      semanticModelCount: modelKeys.size,
      tableCount: mergedViews.length,
      columnCount: mergeFields(mergedViews.flatMap((view) => view.fields)).length,
      measureCount: metrics.length,
      relationshipCount: mergedRelationships.length,
      roleCount: roleKeys.size,
      reportCount: reportKeys.size,
      pageCount: pageKeys.size,
      visualCount: visualKeys.size,
      projectCount: enhancedPbir.projects.length,
      dataSourceCount: dataSourceKeys.size,
      partitionCount: partitionKeys.size,
      calculatedColumnCount: calculatedColumnKeys.size,
      hierarchyCount: hierarchyKeys.size,
      calculationGroupCount: calculationGroupKeys.size,
      perspectiveCount: perspectiveKeys.size,
      cultureCount: cultureKeys.size,
      bookmarkCount: bookmarkKeys.size,
      interactionCount: interactionKeys.size,
      unsupportedVisualCount: unsupportedVisualKeys.size,
      mappingCount: cleanMappings.length,
      warnings: cleanWarnings,
    },
    projects: enhancedPbir.projects,
    models: mergedModels,
  };
}

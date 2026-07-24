import { tableFromIPC } from 'apache-arrow';
import type { SourceConnectorCapabilities, SourceDashboardCatalogItem } from './studioApi';
import type { DomoManualParseResult, MigrationDashboardBuildItem, MigrationDashboardBuildPlan, MigrationDecision, PowerBiManualParseResult, SemanticMigrationFile } from './types';
import { migrationDecisionResolutionIssue } from './compiler';
import { dashboardPlanScopeIssues, dashboardTileRequiresFields, dashboardVisualEvidenceCatalog, domoDashboardVisualEvidenceCatalog, domoSelectedDashboardEvidence, migrationBundleFingerprint, powerBiSelectedReportEvidence, type DashboardCanonicalFieldEvidenceCatalog } from './bundle';
import {
  migrationDecisionSemanticKey,
  migrationDecisionSemanticKind,
} from './decisionIdentity';

export type MigrationValidationStatus = 'passed' | 'failed' | 'unsupported' | 'skipped' | 'waived' | 'pending';
export type MigrationValidationCategory = 'dependency_resolution' | 'dashboard_bindings' | 'structural' | 'semantic' | 'query' | 'data' | 'visual_intent' | 'security' | 'operational' | 'human' | 'dashboard_build';

export interface MigrationRepresentativeQuery {
  id: string;
  dashboardPlanId: string;
  dashboardName: string;
  tileId: string;
  tileTitle: string;
  query: Record<string, unknown>;
  sourceProbe?: {
    queryOrigin: 'inline' | 'result_maker' | 'saved_look' | 'query_id' | 'unknown';
    lookId?: string;
    queryId?: string;
    model?: string;
    explore?: string;
    fields: string[];
    filters: Record<string, string>;
    sorts: string[];
    pivots: string[];
    filterExpression?: string;
    limit: number;
  };
  notes: string[];
}

export interface MigrationQueryValidationEvidence {
  id: string;
  dashboardPlanId: string;
  dashboardName: string;
  tileId: string;
  tileTitle: string;
  status: 'passed' | 'failed';
  mode: 'plan_and_execute';
  checkedAt: string;
  preparationFingerprint: string;
  fieldCount: number;
  summary: string;
}

export interface MigrationDataComparisonEvidence {
  id: string;
  dashboardPlanId: string;
  dashboardName: string;
  tileId: string;
  tileTitle: string;
  status: 'passed' | 'failed';
  checkedAt: string;
  preparationFingerprint: string;
  sourceRowCount: number;
  targetRowCount: number;
  comparedCellCount: number;
  mismatchCount: number;
  rowMismatchCount: number;
  fieldMismatchCount: number;
  typeMismatchCount: number;
  valueMismatchCount: number;
  numericTolerance: number;
  keyFields: string[];
  sourceFingerprint: string;
  targetFingerprint: string;
  summary: string;
}

export interface MigrationDataComparisonSample {
  dashboardPlanId: string;
  tileId: string;
  dashboardName?: string;
  tileTitle?: string;
  sourceRows: Array<Record<string, unknown>>;
  targetRows: Array<Record<string, unknown>>;
  numericTolerance: number;
  keyFields?: string[];
  fieldMappings?: Record<string, string>;
  sourceFingerprint?: string;
}

export interface MigrationSourceComparisonUpload {
  dashboardPlanId: string;
  tileId: string;
  sourceRows: Array<Record<string, unknown>>;
  targetRows?: Array<Record<string, unknown>>;
  numericTolerance: number;
  keyFields: string[];
  fieldMappings: Record<string, string>;
  sourceFingerprint?: string;
}

export interface MigrationValidationWaiverDetail {
  approved: boolean;
  owner: string;
  reason: string;
}

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
  waiverDetails?: Partial<Record<MigrationValidationCategory, MigrationValidationWaiverDetail>>;
  dashboardPlans?: MigrationDashboardBuildPlan[];
  queryValidationEvidence?: MigrationQueryValidationEvidence[];
  dataComparisonEvidence?: MigrationDataComparisonEvidence[];
  currentPreparationFingerprint?: string;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))));
}

function representativeQueryId(planId: string, tileId: string): string {
  return `migration-query:${planId}:${tileId}`;
}

function representativeQuerySorts(sorts: Array<Record<string, unknown>> | undefined): Array<{ column_name: string; sort_descending: boolean }> {
  return (sorts || []).flatMap((sort) => {
    const rawField = [sort.column_name, sort.columnName, sort.field, sort.field_name, sort.fieldName]
      .find((value) => typeof value === 'string' && value.trim()) as string | undefined;
    if (!rawField) return [];
    const suffix = rawField.trim().match(/\s+(asc|desc)$/i)?.[1]?.toLowerCase();
    const columnName = rawField.trim().replace(/\s+(asc|desc)$/i, '').trim();
    const rawDirection = [sort.direction, sort.order].find((value) => typeof value === 'string') as string | undefined;
    const descending = typeof sort.sort_descending === 'boolean'
      ? sort.sort_descending
      : typeof sort.desc === 'boolean'
        ? sort.desc
        : suffix === 'desc' || rawDirection?.toLowerCase() === 'desc';
    return columnName ? [{ column_name: columnName, sort_descending: descending }] : [];
  });
}

function normalizedDecisionField(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function approvedTargetFieldMappings(decisions: MigrationDecision[]): Map<string, string> {
  const mappings = new Map<string, string>();
  decisions.forEach((decision) => {
    if (!decision.approvedByUser || !['map_existing', 'create_new', 'rewrite'].includes(decision.action)) return;
    const target = decision.targetId?.trim() || decision.targetLabel?.trim();
    if (!target?.includes('.')) return;
    const source = normalizedDecisionField(decision.sourceLabel);
    if (source) mappings.set(source, target);
  });
  return mappings;
}

function mappedTargetField(field: string, mappings: Map<string, string>): string {
  return mappings.get(normalizedDecisionField(field)) || field;
}

function sourceLookerSorts(sorts: Array<Record<string, unknown>> | undefined): string[] {
  return (sorts || []).flatMap((sort) => {
    const field = [sort.field, sort.field_name, sort.fieldName, sort.column_name, sort.columnName]
      .find((value) => typeof value === 'string' && value.trim()) as string | undefined;
    if (!field) return [];
    const suffix = field.trim().match(/\s+(asc|desc)$/i)?.[1]?.toLowerCase();
    const direction = typeof sort.sort_descending === 'boolean'
      ? sort.sort_descending ? ' desc' : ''
      : typeof sort.desc === 'boolean'
        ? sort.desc ? ' desc' : ''
        : suffix === 'desc' || typeof sort.direction === 'string' && sort.direction.toLowerCase() === 'desc' ? ' desc' : '';
    return [`${field.trim().replace(/\s+(asc|desc)$/i, '')}${direction}`];
  });
}

function tileNeedsRuntimeValidation(plan: MigrationDashboardBuildPlan, tileId: string): boolean {
  const tile = plan.tiles.find((candidate) => candidate.id === tileId);
  if (!tile) return false;
  return (tile.sourceKind || 'query') === 'query'
    && ['generated', 'mapped'].includes(tile.migrationOutcome || 'generated')
    && tile.fields.length > 0;
}

export function migrationRepresentativeQueries(
  plans: MigrationDashboardBuildPlan[],
  modelId: string,
  approvedDecisions: MigrationDecision[] = [],
): MigrationRepresentativeQuery[] {
  const targetFieldMappings = approvedTargetFieldMappings(approvedDecisions);
  return plans.flatMap((plan) => plan.tiles.flatMap((tile) => {
    if (!tileNeedsRuntimeValidation(plan, tile.id)) return [];
    const sourceFields = uniqueStrings([
      ...tile.fields,
      ...(tile.hiddenFields || []),
      ...(tile.calculationDependencies || []),
    ]);
    const fields = uniqueStrings(sourceFields.map((field) => mappedTargetField(field, targetFieldMappings)));
    const mappedFieldCount = sourceFields.filter((field) => mappedTargetField(field, targetFieldMappings) !== field).length;
    const mappedTable = fields.find((field) => field.includes('.'))?.split('.')[0]?.trim();
    const table = mappedFieldCount > 0 ? mappedTable : tile.queryTopic?.trim() || mappedTable;
    if (!table || fields.length === 0) return [];
    const sourceSorts = representativeQuerySorts(tile.sorts);
    const sorts = sourceSorts.map((sort) => ({
      ...sort,
      column_name: mappedTargetField(sort.column_name, targetFieldMappings),
    }));
    const pivots = uniqueStrings((tile.pivots || []).map((pivot) => mappedTargetField(pivot, targetFieldMappings)));
    const query: Record<string, unknown> = {
      modelId,
      table,
      fields,
      limit: Math.max(1, Math.min(Number.isFinite(tile.limit) && Number(tile.limit) > 0 ? Number(tile.limit) : 50, 50)),
      ...(sorts.length > 0 ? { sorts } : {}),
      ...(mappedFieldCount > 0 ? { join_paths_from_topic_name: table } : tile.queryTopic ? { join_paths_from_topic_name: tile.queryTopic } : {}),
      ...(pivots.length ? { pivots } : {}),
    };
    const notes = [
      `${tile.fields.length} visible field${tile.fields.length === 1 ? '' : 's'} and ${fields.length - tile.fields.length} hidden/calculation dependenc${fields.length - tile.fields.length === 1 ? 'y' : 'ies'} included.`,
      ...(mappedFieldCount > 0 ? [`${mappedFieldCount} approved source-to-target field mapping${mappedFieldCount === 1 ? '' : 's'} applied to the Omni validation probe.`] : []),
      ...(tile.queryFilters?.length ? [`${tile.queryFilters.length} source filter${tile.queryFilters.length === 1 ? '' : 's'} remain governed by the reviewed filter/listener matrix; source-specific filter syntax is not injected into the Omni probe.`] : []),
    ];
    return [{
      id: representativeQueryId(plan.id, tile.id),
      dashboardPlanId: plan.id,
      dashboardName: plan.sourceDashboardName,
      tileId: tile.id,
      tileTitle: tile.title,
      query,
      sourceProbe: tile.sourceModel || tile.sourceExplore || tile.sourceLookId || tile.sourceQueryId
        ? {
            queryOrigin: tile.queryOrigin || 'unknown',
            lookId: tile.sourceLookId,
            queryId: tile.sourceQueryId,
            model: tile.sourceModel,
            explore: tile.sourceExplore || tile.queryTopic,
            fields: sourceFields,
            filters: Object.fromEntries((tile.queryFilters || []).flatMap((filter) => filter.field && filter.values.length
              ? [[filter.field, filter.values.join(',')]]
              : [])),
            sorts: sourceLookerSorts(tile.sorts),
            pivots: uniqueStrings(tile.pivots || []),
            ...(tile.filterExpression ? { filterExpression: tile.filterExpression } : {}),
            limit: Number(query.limit),
          }
        : undefined,
      notes,
    }];
  }));
}

function statusesInResponse(value: unknown, statuses: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((item) => statusesInResponse(item, statuses));
    return statuses;
  }
  if (!value || typeof value !== 'object') return statuses;
  Object.entries(value as Record<string, unknown>).forEach(([key, item]) => {
    if (/^(status|state)$/i.test(key) && typeof item === 'string') statuses.push(item.toUpperCase());
    else statusesInResponse(item, statuses);
  });
  return statuses;
}

export function migrationQueryResponseSucceeded(value: unknown, expectedStatus: 'PLANNED' | 'COMPLETE'): boolean {
  const statuses = statusesInResponse(value);
  return statuses.includes(expectedStatus) && !statuses.some((status) => ['FAILED', 'ERROR', 'CANCELLED'].includes(status));
}

function base64Bytes(value: string): Uint8Array {
  const binary = atob(value.replace(/\s+/g, ''));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function plainQueryValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value <= Number.MAX_SAFE_INTEGER && value >= Number.MIN_SAFE_INTEGER ? Number(value) : String(value);
  if (value instanceof Date) return value.toISOString();
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as Iterable<number>);
  if (value && typeof value === 'object' && typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    try { return plainQueryValue((value as { toJSON: () => unknown }).toJSON()); } catch { return String(value); }
  }
  return value;
}

function objectRows(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).flatMap((item) => item && typeof item === 'object' && !Array.isArray(item)
    ? [Object.fromEntries(Object.entries(item as Record<string, unknown>).slice(0, 100).map(([key, cell]) => [key, plainQueryValue(cell)]))]
    : []);
}

function rowsFromResponseObject(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return objectRows(value);
  if (!value || typeof value !== 'object') return [];
  const row = value as Record<string, unknown>;
  for (const candidate of [row.rows, row.data, row.result]) {
    const rows = objectRows(candidate);
    if (rows.length > 0 || Array.isArray(candidate)) return rows;
  }
  for (const candidate of [row.result, row.response, row.payload]) {
    const rows = rowsFromResponseObject(candidate);
    if (rows.length > 0) return rows;
  }
  return [];
}

function arrowResult(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = arrowResult(item);
      if (result) return result;
    }
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  if (String(row.status || '').toUpperCase() === 'COMPLETE' && typeof row.result === 'string') return row.result;
  for (const item of Object.values(row)) {
    const result = arrowResult(item);
    if (result) return result;
  }
  return undefined;
}

export function migrationQueryRows(value: unknown): Array<Record<string, unknown>> {
  const raw = value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { raw?: unknown }).raw === 'string'
    ? (value as { raw: string }).raw
    : undefined;
  let parsed: unknown = value;
  if (raw) {
    parsed = raw.split(/\r?\n/).flatMap((line) => {
      if (!line.trim()) return [];
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  }
  const encoded = arrowResult(parsed);
  if (encoded) {
    try {
      const table = tableFromIPC(base64Bytes(encoded));
      return table.toArray().slice(0, 50).map((item) => Object.fromEntries(table.schema.fields.slice(0, 100).map((field) => [
        field.name,
        plainQueryValue((item as unknown as Record<string, unknown>)[field.name]),
      ])));
    } catch {
      // Fall through to JSON rows so malformed Arrow remains visible as missing proof.
    }
  }
  return rowsFromResponseObject(parsed).slice(0, 50);
}

function comparableType(value: unknown): 'null' | 'number' | 'date' | 'boolean' | 'string' | 'object' {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (value instanceof Date) return 'date';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:[T ]|$)/.test(value) && Number.isFinite(Date.parse(value))) return 'date';
  if (typeof value === 'string') return 'string';
  return 'object';
}

function canonicalComparableValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (comparableType(value) === 'date') return new Date(value as string | number | Date).toISOString();
  return plainQueryValue(value);
}

function comparableValueEqual(source: unknown, target: unknown, numericTolerance: number): boolean {
  const left = canonicalComparableValue(source);
  const right = canonicalComparableValue(target);
  if (typeof left === 'number' && typeof right === 'number' && Number.isFinite(left) && Number.isFinite(right)) {
    return Math.abs(left - right) <= numericTolerance * Math.max(1, Math.abs(left));
  }
  if (left === right) return true;
  return JSON.stringify(left) === JSON.stringify(right);
}

function stableRowsFingerprint(rows: Array<Record<string, unknown>>): string {
  return migrationBundleFingerprint(rows.map((row) => Object.fromEntries(Object.keys(row).sort().map((key) => [key, canonicalComparableValue(row[key])]))));
}

function comparisonKey(row: Record<string, unknown>, fields: string[]): string {
  return JSON.stringify(fields.map((field) => canonicalComparableValue(row[field])));
}

function csvRows(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (quoted && character === '"' && content[index + 1] === '"') {
      value += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (!quoted && character === ',') {
      row.push(value);
      value = '';
    } else if (!quoted && (character === '\n' || character === '\r')) {
      if (character === '\r' && content[index + 1] === '\n') index += 1;
      row.push(value);
      if (row.some((cell) => cell.length > 0)) rows.push(row);
      row = [];
      value = '';
    } else {
      value += character;
    }
  }
  row.push(value);
  if (row.some((cell) => cell.length > 0)) rows.push(row);
  if (quoted) throw new Error('CSV comparison evidence contains an unterminated quoted value.');
  return rows;
}

function parsedCsvValue(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) return numeric;
  }
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true';
  if (/^null$/i.test(trimmed)) return null;
  return value;
}

export function parseMigrationSourceComparisonUpload(content: string, fileName: string): MigrationSourceComparisonUpload[] {
  if (/\.csv$/i.test(fileName)) {
    const rows = csvRows(content);
    if (rows.length < 2) throw new Error('CSV comparison evidence must include a header and at least one source row.');
    const headers = rows[0].map((header) => header.trim());
    const dashboardIndex = headers.indexOf('dashboardPlanId');
    const tileIndex = headers.indexOf('tileId');
    if (dashboardIndex < 0 || tileIndex < 0) throw new Error('CSV comparison evidence requires dashboardPlanId and tileId columns.');
    const reserved = new Set(['dashboardPlanId', 'tileId', 'numericTolerance', 'keyFields']);
    if (!headers.some((header) => header && !reserved.has(header))) throw new Error('CSV comparison evidence must include at least one source result field.');
    const groups = new Map<string, MigrationSourceComparisonUpload>();
    rows.slice(1).forEach((cells, index) => {
      const dashboardPlanId = (cells[dashboardIndex] || '').trim();
      const tileId = (cells[tileIndex] || '').trim();
      if (!dashboardPlanId || !tileId) throw new Error(`CSV row ${index + 2} is missing dashboardPlanId or tileId.`);
      const key = `${dashboardPlanId}\u0000${tileId}`;
      const toleranceIndex = headers.indexOf('numericTolerance');
      const keyFieldsIndex = headers.indexOf('keyFields');
      const existing = groups.get(key) || {
        dashboardPlanId,
        tileId,
        sourceRows: [],
        numericTolerance: toleranceIndex >= 0 && Number.isFinite(Number(cells[toleranceIndex])) ? Number(cells[toleranceIndex]) : 0.001,
        keyFields: keyFieldsIndex >= 0 ? (cells[keyFieldsIndex] || '').split('|').map((item) => item.trim()).filter(Boolean) : [],
        fieldMappings: {},
      };
      existing.sourceRows.push(Object.fromEntries(headers.flatMap((header, columnIndex) => !header || reserved.has(header)
        ? []
        : [[header, parsedCsvValue(cells[columnIndex] || '')]])));
      groups.set(key, existing);
    });
    return Array.from(groups.values());
  }
  const parsed = JSON.parse(content) as unknown;
  const comparisons = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { comparisons?: unknown }).comparisons)
      ? (parsed as { comparisons: unknown[] }).comparisons
      : [];
  if (comparisons.length === 0 || comparisons.length > 200) throw new Error('Provide between 1 and 200 comparison records.');
  return comparisons.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`Comparison ${index + 1} must be an object.`);
    const row = item as Record<string, unknown>;
    const dashboardPlanId = typeof row.dashboardPlanId === 'string' ? row.dashboardPlanId.trim() : '';
    const tileId = typeof row.tileId === 'string' ? row.tileId.trim() : '';
    if (!dashboardPlanId || !tileId) throw new Error(`Comparison ${index + 1} is missing dashboardPlanId or tileId.`);
    const sourceRows = objectRows(row.sourceRows);
    const targetRows = row.targetRows === undefined ? undefined : objectRows(row.targetRows);
    if (!Array.isArray(row.sourceRows) || sourceRows.length !== row.sourceRows.length || sourceRows.length > 50) throw new Error(`Comparison ${index + 1} sourceRows must contain no more than 50 JSON objects.`);
    if (row.targetRows !== undefined && (!Array.isArray(row.targetRows) || targetRows?.length !== row.targetRows.length || (targetRows?.length || 0) > 50)) throw new Error(`Comparison ${index + 1} targetRows must contain no more than 50 JSON objects.`);
    const mappings = row.fieldMappings && typeof row.fieldMappings === 'object' && !Array.isArray(row.fieldMappings)
      ? Object.fromEntries(Object.entries(row.fieldMappings as Record<string, unknown>).flatMap(([key, value]) => typeof value === 'string' && value.trim() ? [[key, value.trim()]] : []))
      : {};
    return {
      dashboardPlanId,
      tileId,
      sourceRows,
      targetRows,
      numericTolerance: typeof row.numericTolerance === 'number' ? row.numericTolerance : 0.001,
      keyFields: Array.isArray(row.keyFields) ? uniqueStrings(row.keyFields.filter((value): value is string => typeof value === 'string')) : [],
      fieldMappings: mappings,
      sourceFingerprint: typeof row.sourceFingerprint === 'string' ? row.sourceFingerprint : undefined,
    };
  });
}

export function compareMigrationQuerySamples(
  sample: MigrationDataComparisonSample,
  preparationFingerprint: string,
): MigrationDataComparisonEvidence {
  const tolerance = Number.isFinite(sample.numericTolerance) && sample.numericTolerance >= 0
    ? Math.min(sample.numericTolerance, 1)
    : 0;
  const sourceRows = sample.sourceRows.slice(0, 50);
  const targetRows = sample.targetRows.slice(0, 50);
  const sourceFields = uniqueStrings(sourceRows.flatMap((row) => Object.keys(row))).sort();
  const mappings = Object.fromEntries(sourceFields.map((field) => [field, sample.fieldMappings?.[field]?.trim() || field]));
  const targetFields = new Set(targetRows.flatMap((row) => Object.keys(row)));
  let fieldMismatchCount = sourceFields.filter((field) => !targetFields.has(mappings[field])).length;
  let rowMismatchCount = Math.abs(sourceRows.length - targetRows.length);
  let typeMismatchCount = 0;
  let valueMismatchCount = 0;
  let comparedCellCount = 0;
  const keyFields = uniqueStrings(sample.keyFields || []).filter((field) => sourceFields.includes(field));
  const pairs: Array<[Record<string, unknown>, Record<string, unknown>]> = [];
  if (keyFields.length > 0) {
    const targetKeyFields = keyFields.map((field) => mappings[field]);
    const sourceByKey = new Map(sourceRows.map((row) => [comparisonKey(row, keyFields), row]));
    const targetByKey = new Map(targetRows.map((row) => [comparisonKey(row, targetKeyFields), row]));
    const keys = new Set([...sourceByKey.keys(), ...targetByKey.keys()]);
    rowMismatchCount = 0;
    keys.forEach((key) => {
      const sourceRow = sourceByKey.get(key);
      const targetRow = targetByKey.get(key);
      if (!sourceRow || !targetRow) rowMismatchCount += 1;
      else pairs.push([sourceRow, targetRow]);
    });
  } else {
    for (let index = 0; index < Math.min(sourceRows.length, targetRows.length); index += 1) pairs.push([sourceRows[index], targetRows[index]]);
  }
  pairs.forEach(([sourceRow, targetRow]) => {
    sourceFields.forEach((sourceField) => {
      const targetField = mappings[sourceField];
      if (!(targetField in targetRow)) return;
      comparedCellCount += 1;
      const sourceType = comparableType(sourceRow[sourceField]);
      const targetType = comparableType(targetRow[targetField]);
      if (sourceType !== 'null' && targetType !== 'null' && sourceType !== targetType) typeMismatchCount += 1;
      if (!comparableValueEqual(sourceRow[sourceField], targetRow[targetField], tolerance)) valueMismatchCount += 1;
    });
  });
  if (sourceRows.length === 0 && targetRows.length === 0) fieldMismatchCount = 0;
  const mismatchCount = rowMismatchCount + fieldMismatchCount + typeMismatchCount + valueMismatchCount;
  const status = mismatchCount === 0 ? 'passed' as const : 'failed' as const;
  return {
    id: representativeQueryId(sample.dashboardPlanId, sample.tileId),
    dashboardPlanId: sample.dashboardPlanId,
    dashboardName: sample.dashboardName || sample.dashboardPlanId,
    tileId: sample.tileId,
    tileTitle: sample.tileTitle || sample.tileId,
    status,
    checkedAt: new Date().toISOString(),
    preparationFingerprint,
    sourceRowCount: sourceRows.length,
    targetRowCount: targetRows.length,
    comparedCellCount,
    mismatchCount,
    rowMismatchCount,
    fieldMismatchCount,
    typeMismatchCount,
    valueMismatchCount,
    numericTolerance: tolerance,
    keyFields,
    sourceFingerprint: sample.sourceFingerprint || stableRowsFingerprint(sourceRows),
    targetFingerprint: stableRowsFingerprint(targetRows),
    summary: status === 'passed'
      ? `${sourceRows.length} bounded source row${sourceRows.length === 1 ? '' : 's'} matched the target${keyFields.length ? ` by ${keyFields.join(', ')}` : ' by stable row order'} within tolerance ${tolerance}.`
      : `${mismatchCount} mismatch${mismatchCount === 1 ? '' : 'es'} remain: ${rowMismatchCount} row, ${fieldMismatchCount} field, ${typeMismatchCount} type, and ${valueMismatchCount} value at tolerance ${tolerance}.`,
  };
}

export function migrationDataComparisonFailure(
  query: Pick<MigrationRepresentativeQuery, 'id' | 'dashboardPlanId' | 'dashboardName' | 'tileId' | 'tileTitle'>,
  preparationFingerprint: string,
  summary: string,
): MigrationDataComparisonEvidence {
  return {
    id: query.id,
    dashboardPlanId: query.dashboardPlanId,
    dashboardName: query.dashboardName,
    tileId: query.tileId,
    tileTitle: query.tileTitle,
    status: 'failed',
    checkedAt: new Date().toISOString(),
    preparationFingerprint,
    sourceRowCount: 0,
    targetRowCount: 0,
    comparedCellCount: 0,
    mismatchCount: 1,
    rowMismatchCount: 1,
    fieldMismatchCount: 0,
    typeMismatchCount: 0,
    valueMismatchCount: 0,
    numericTolerance: 0,
    keyFields: [],
    sourceFingerprint: 'unavailable',
    targetFingerprint: 'unavailable',
    summary,
  };
}

function recordHasFailure(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(recordHasFailure);
  return Object.entries(value as Record<string, unknown>).some(([key, item]) => {
    if (/^(error|errors|failed|failure|issues|dashboard_filter_issues)$/i.test(key)) {
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
  const dataWaiver = input.waiverDetails?.data;
  const dataWaiverReady = Boolean(waivers.data && dataWaiver?.approved && dataWaiver.owner.trim() && dataWaiver.reason.trim());
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

  const expectedQueryIds = new Set((input.dashboardPlans || []).flatMap((plan) => plan.tiles
    .filter((tile) => tileNeedsRuntimeValidation(plan, tile.id))
    .map((tile) => representativeQueryId(plan.id, tile.id))));
  const currentEvidence = (input.queryValidationEvidence || []).filter((item) => !input.currentPreparationFingerprint || item.preparationFingerprint === input.currentPreparationFingerprint);
  const currentQueryById = new Map(currentEvidence.map((item) => [item.id, item]));
  const missingQueryIds = Array.from(expectedQueryIds).filter((id) => !currentQueryById.has(id));
  const failedQueryEvidence = currentEvidence.filter((item) => expectedQueryIds.has(item.id) && item.status === 'failed');
  const query: MigrationValidationCheck = expectedQueryIds.size === 0
    ? { id: 'query', label: 'Target queries', status: 'skipped', blocking: false, summary: 'No generated or mapped query tiles require target execution.', evidence: [] }
    : failedQueryEvidence.length > 0
      ? { id: 'query', label: 'Target queries', status: 'failed', blocking: true, summary: `${failedQueryEvidence.length} target query${failedQueryEvidence.length === 1 ? '' : 'ies'} failed branch compilation or bounded execution.`, evidence: failedQueryEvidence.map((item) => `${item.dashboardName} / ${item.tileTitle}: ${item.summary}`).slice(0, 20) }
      : missingQueryIds.length > 0
        ? { id: 'query', label: 'Target queries', status: 'pending', blocking: true, summary: `${missingQueryIds.length} of ${expectedQueryIds.size} required target quer${expectedQueryIds.size === 1 ? 'y' : 'ies'} still need branch compilation and bounded execution.`, evidence: [] }
        : { id: 'query', label: 'Target queries', status: 'passed', blocking: true, summary: `All ${expectedQueryIds.size} required target quer${expectedQueryIds.size === 1 ? 'y' : 'ies'} compiled and executed successfully against the reviewed branch.`, evidence: currentEvidence.filter((item) => expectedQueryIds.has(item.id)).map((item) => `${item.dashboardName} / ${item.tileTitle}: ${item.summary}`).slice(0, 20) };

  const currentComparisons = (input.dataComparisonEvidence || []).filter((item) => !input.currentPreparationFingerprint || item.preparationFingerprint === input.currentPreparationFingerprint);
  const currentComparisonById = new Map(currentComparisons.map((item) => [item.id, item]));
  const missingComparisonIds = Array.from(expectedQueryIds).filter((id) => !currentComparisonById.has(id));
  const failedComparisons = currentComparisons.filter((item) => expectedQueryIds.has(item.id) && item.status === 'failed');
  const data: MigrationValidationCheck = expectedQueryIds.size === 0
    ? { id: 'data', label: 'Sampled data', status: 'skipped', blocking: false, summary: 'No generated or mapped query tiles require sampled data comparison.', evidence: [] }
    : failedComparisons.length > 0
      ? { id: 'data', label: 'Sampled data', status: 'failed', blocking: true, summary: `${failedComparisons.length} sampled data comparison${failedComparisons.length === 1 ? '' : 's'} failed.`, evidence: failedComparisons.map((item) => `${item.dashboardName} / ${item.tileTitle}: ${item.summary}`).slice(0, 20) }
      : missingComparisonIds.length === 0
        ? { id: 'data', label: 'Sampled data', status: 'passed', blocking: true, summary: `All ${expectedQueryIds.size} target quer${expectedQueryIds.size === 1 ? 'y has' : 'ies have'} source-versus-target sample evidence within the approved tolerances.`, evidence: currentComparisons.filter((item) => expectedQueryIds.has(item.id)).map((item) => `${item.dashboardName} / ${item.tileTitle}: ${item.summary}`).slice(0, 20) }
        : dataWaiverReady
          ? { id: 'data', label: 'Sampled data', status: 'waived', blocking: true, summary: `Approved waiver by ${dataWaiver!.owner.trim()}. ${missingComparisonIds.length} of ${expectedQueryIds.size} required quer${expectedQueryIds.size === 1 ? 'y lacks' : 'ies lack'} sampled source-versus-target comparison evidence.`, evidence: [`Reason: ${dataWaiver!.reason.trim()}`] }
          : { id: 'data', label: 'Sampled data', status: 'unsupported', blocking: true, summary: `${missingComparisonIds.length} of ${expectedQueryIds.size} required quer${expectedQueryIds.size === 1 ? 'y lacks' : 'ies lack'} sampled source-versus-target comparison evidence. Upload bounded source results${waivers.data ? ' or provide an accountable waiver owner and reason' : ' or record an explicit accountable waiver'}.`, evidence: [] };

  return [
    structural,
    semantic,
    query,
    data,
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
  domoParseResult?: DomoManualParseResult | null;
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
    domoEvidence: input.sourcePlatform === 'domo'
      ? domoSelectedDashboardEvidence(input.domoParseResult || null, input.selectedDashboardIds)
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
  domoParseResult?: DomoManualParseResult | null;
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
  const invalidPlans = input.dashboardPlans.filter((plan) => plan.tiles.length === 0 || plan.tiles.some((tile) => dashboardTileRequiresFields(tile) && tile.fields.length === 0));
  const unknownPlans = input.dashboardPlans.filter((plan) => !input.selectedDashboards.some((dashboard) => dashboard.id === plan.sourceDashboardId));
  const visualEvidence = powerBiSelectedReportEvidence(input.powerBiParseResult || null, input.selectedDashboards.map((dashboard) => dashboard.id));
  const domoEvidence = domoSelectedDashboardEvidence(input.domoParseResult || null, input.selectedDashboards.map((dashboard) => dashboard.id));
  const visualCatalog = visualEvidence.reports.length > 0
    ? dashboardVisualEvidenceCatalog(visualEvidence)
    : domoDashboardVisualEvidenceCatalog(domoEvidence);
  const knownVisualIds = new Set(visualEvidence.reports.flatMap((report) => report.pages.flatMap((page) => page.visuals.map((visual) => visual.evidenceId))));
  domoEvidence.dashboards.flatMap((dashboard) => dashboard.cards).forEach((card) => knownVisualIds.add(card.evidenceId));
  const referencedVisualIdList = input.dashboardPlans.flatMap((plan) => plan.tiles.flatMap((tile) => tile.sourceEvidenceIds.filter((id) => id.startsWith('powerbi:visual:') || id.startsWith('domo:card:'))));
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

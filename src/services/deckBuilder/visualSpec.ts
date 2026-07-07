import type {
  DashboardTile,
  NativeVisualOverride,
  TileColumn,
  TileRenderKind,
  TileResult,
  TileVisualNumberFormat,
  TileVisualSort,
  TileVisualSpec,
} from './types';
import { isNumericColumn } from './nativeVisuals';

const CHART_KINDS = new Set<TileRenderKind>(['bar', 'stacked_bar', 'line', 'area', 'pie']);
const SPEC_RENDER_KINDS = new Set<TileRenderKind>(['kpi', 'bar', 'stacked_bar', 'line', 'area', 'pie', 'table', 'empty', 'markdown', 'unsupported']);
const NUMBER_FORMATS = new Set<TileVisualNumberFormat>(['auto', 'currency', 'percent', 'integer', 'decimal']);
const VISUAL_KEY_RE = /(vis|visual|chart|mark|encoding|presentation|display|plot|series|axis|color|palette)/i;

export interface VisualMetadataCandidate {
  path: string;
  value: Record<string, unknown>;
}

export interface ResolvedVisualMapping {
  kind: TileRenderKind;
  categoryColumn?: TileColumn;
  measureColumns: TileColumn[];
  seriesColumn?: TileColumn;
  rows: Array<Record<string, unknown>>;
  warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function compactPath(parent: string, key: string): string {
  return parent ? `${parent}.${key}` : key;
}

function walkVisualMetadata(value: unknown, path: string, depth: number, out: VisualMetadataCandidate[]): void {
  if (!isRecord(value) || depth > 4) return;
  const keys = Object.keys(value);
  if (path && keys.some((key) => VISUAL_KEY_RE.test(key)) && keys.length > 0) {
    out.push({ path, value });
  }
  for (const [key, child] of Object.entries(value)) {
    if (!isRecord(child)) continue;
    const nextPath = compactPath(path, key);
    if (VISUAL_KEY_RE.test(key)) out.push({ path: nextPath, value: child });
    walkVisualMetadata(child, nextPath, depth + 1, out);
  }
}

export function findVisualMetadataCandidates(raw: Record<string, unknown> | undefined): VisualMetadataCandidate[] {
  if (!raw) return [];
  const out: VisualMetadataCandidate[] = [];
  walkVisualMetadata(raw, '', 0, out);
  const seen = new Set<string>();
  return out.filter((candidate) => {
    if (seen.has(candidate.path)) return false;
    seen.add(candidate.path);
    return true;
  });
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function normalizeKind(value: unknown): TileRenderKind | undefined {
  const raw = stringValue(value)?.toLowerCase().replace(/[_\s-]+/g, '');
  if (!raw) return undefined;
  if (/singlevalue|scorecard|bigvalue|kpi/.test(raw)) return 'kpi';
  if (/stacked.*(column|bar)|stackedbar|stackedcolumn/.test(raw)) return 'stacked_bar';
  if (/column|bar/.test(raw)) return 'bar';
  if (/area/.test(raw)) return 'area';
  if (/line/.test(raw)) return 'line';
  if (/pie|donut/.test(raw)) return 'pie';
  if (/table|grid/.test(raw)) return 'table';
  if (SPEC_RENDER_KINDS.has(raw as TileRenderKind)) return raw as TileRenderKind;
  return undefined;
}

function fieldName(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (!isRecord(value)) return undefined;
  return stringValue(value.field)
    || stringValue(value.fieldName)
    || stringValue(value.field_name)
    || stringValue(value.name)
    || stringValue(value.id)
    || stringValue(value.column)
    || stringValue(value.columnName)
    || stringValue(value.column_name);
}

function fieldList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    const one = fieldName(value);
    return one ? [one] : [];
  }
  return Array.from(new Set(value.map(fieldName).filter((field): field is string => Boolean(field))));
}

function pickFieldFromKeys(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const direct = fieldName(record[key]);
    if (direct) return direct;
  }
  return undefined;
}

function pickFieldsFromKeys(record: Record<string, unknown>, keys: string[]): string[] {
  for (const key of keys) {
    const fields = fieldList(record[key]);
    if (fields.length > 0) return fields;
  }
  return [];
}

function inferRenderKindFromMetadata(meta: Record<string, unknown>): TileRenderKind | undefined {
  const direct = normalizeKind(meta.renderKind)
    || normalizeKind(meta.type)
    || normalizeKind(meta.kind)
    || normalizeKind(meta.mark)
    || normalizeKind(meta.chartType)
    || normalizeKind(meta.chart_type)
    || normalizeKind(meta.visualizationType)
    || normalizeKind(meta.visualization_type);
  if (direct) return direct;
  const encoding = isRecord(meta.encoding) ? meta.encoding : undefined;
  if (encoding) {
    const yFields = pickFieldsFromKeys(encoding, ['y', 'yAxis', 'value', 'values', 'measures']);
    const xFields = pickFieldsFromKeys(encoding, ['x', 'xAxis', 'category', 'dimension']);
    if (xFields.length > 0 && yFields.length > 0) return 'bar';
  }
  return undefined;
}

function pickSort(meta: Record<string, unknown>): TileVisualSort | undefined {
  const raw = meta.sort || meta.sortBy || meta.sort_by || meta.orderBy || meta.order_by;
  const sortRecord = Array.isArray(raw) ? raw.find(isRecord) : raw;
  if (!isRecord(sortRecord)) return undefined;
  const field = fieldName(sortRecord.field || sortRecord.by || sortRecord.column);
  if (!field) return undefined;
  const directionRaw = stringValue(sortRecord.direction || sortRecord.dir || sortRecord.order)?.toLowerCase();
  const desc = directionRaw === 'desc' || sortRecord.desc === true || sortRecord.ascending === false;
  return { field, direction: desc ? 'desc' : 'asc' };
}

function pickColors(meta: Record<string, unknown>): string[] | undefined {
  const raw = meta.colors || meta.palette || meta.colorPalette || meta.chartColors;
  if (!Array.isArray(raw)) return undefined;
  const colors = raw.map(String).map((value) => value.replace(/^#/, '')).filter((value) => /^[0-9a-f]{6}$/i.test(value));
  return colors.length > 0 ? colors : undefined;
}

function pickNumberFormat(meta: Record<string, unknown>): TileVisualNumberFormat | undefined {
  const raw = stringValue(meta.numberFormat || meta.number_format || meta.valueFormat || meta.format)?.toLowerCase();
  if (!raw) return undefined;
  if (/currency|money|usd|\$/.test(raw)) return 'currency';
  if (/percent|percentage|%/.test(raw)) return 'percent';
  if (/integer|whole/.test(raw)) return 'integer';
  if (/decimal|float|number/.test(raw)) return 'decimal';
  return NUMBER_FORMATS.has(raw as TileVisualNumberFormat) ? raw as TileVisualNumberFormat : undefined;
}

function specFromMetadata(meta: Record<string, unknown>): TileVisualSpec | null {
  const encoding = isRecord(meta.encoding) ? meta.encoding : {};
  const kind = inferRenderKindFromMetadata(meta);
  if (!kind) return null;
  const categoryField = pickFieldFromKeys(meta, ['categoryField', 'category_field', 'dimensionField', 'dimension_field', 'x', 'xAxis', 'x_axis', 'category', 'dimension'])
    || pickFieldFromKeys(encoding, ['x', 'xAxis', 'x_axis', 'category', 'dimension']);
  const directMeasureFields = pickFieldsFromKeys(meta, ['measureFields', 'measure_fields', 'valueFields', 'value_fields', 'y', 'yAxis', 'y_axis', 'measures', 'values']);
  const encodingMeasureFields = pickFieldsFromKeys(encoding, ['y', 'yAxis', 'y_axis', 'value', 'values', 'measures']);
  const measureFields = directMeasureFields.length > 0 ? directMeasureFields : encodingMeasureFields;
  const seriesField = pickFieldFromKeys(meta, ['seriesField', 'series_field', 'color', 'group', 'breakdown'])
    || pickFieldFromKeys(encoding, ['series', 'color', 'group', 'breakdown']);
  const spec: TileVisualSpec = {
    source: 'omni',
    confidence: 'high',
    renderKind: kind,
    categoryField,
    measureFields: measureFields.length > 0 ? measureFields : undefined,
    seriesField,
    sort: pickSort(meta),
    limit: numberValue(meta.limit || meta.rowLimit || meta.row_limit || meta.topN || meta.top_n),
    numberFormat: pickNumberFormat(meta),
    colors: pickColors(meta),
  };
  return spec;
}

export function extractTileVisualSpecFromRaw(raw: Record<string, unknown> | undefined): TileVisualSpec | null {
  const candidates = findVisualMetadataCandidates(raw);
  for (const candidate of candidates) {
    const spec = specFromMetadata(candidate.value);
    if (spec) {
      return {
        ...spec,
        warnings: [`Seeded from Omni visual metadata at ${candidate.path}.`],
      };
    }
  }
  return null;
}

export function isChartKind(kind: TileRenderKind): kind is 'bar' | 'stacked_bar' | 'line' | 'area' | 'pie' {
  return CHART_KINDS.has(kind);
}

function suggestedSeriesField(result: TileResult, dimensionColumns: TileColumn[], numericColumns: TileColumn[]): string | undefined {
  if (dimensionColumns.length < 2 || numericColumns.length !== 1) return undefined;
  const candidate = dimensionColumns[1];
  const values = new Set(result.rows.map((row) => String(row[candidate.name] ?? '')).filter(Boolean));
  return values.size > 1 && values.size <= 8 ? candidate.name : undefined;
}

export function columnByName(columns: TileColumn[], field: string | undefined): TileColumn | undefined {
  if (!field) return undefined;
  const normalized = field.toLowerCase();
  return columns.find((column) => column.name === field || column.label === field)
    || columns.find((column) => column.name.toLowerCase() === normalized || column.label?.toLowerCase() === normalized)
    || columns.find((column) => column.name.endsWith(`.${field}`) || column.label?.endsWith(`.${field}`));
}

export function inferTileVisualSpec(result: TileResult, override?: NativeVisualOverride): TileVisualSpec {
  const kind = override && override !== 'auto' ? override : result.renderKind;
  const numericColumns = result.columns.filter(isNumericColumn);
  const dimensionColumns = result.columns.filter((column) => !isNumericColumn(column));
  if (kind === 'kpi') {
    return {
      source: 'inferred',
      confidence: numericColumns.length > 0 ? 'medium' : 'low',
      renderKind: 'kpi',
      measureFields: [(numericColumns[0] || result.columns[0])?.name].filter(Boolean),
      warnings: ['Inferred KPI mapping from query result columns.'],
    };
  }
  if (isChartKind(kind)) {
    const seriesField = suggestedSeriesField(result, dimensionColumns, numericColumns);
    return {
      source: 'inferred',
      confidence: dimensionColumns.length > 0 && numericColumns.length > 0 ? 'medium' : 'low',
      renderKind: kind,
      categoryField: (dimensionColumns[0] || result.columns[0])?.name,
      measureFields: numericColumns.map((column) => column.name),
      seriesField,
      warnings: [
        seriesField
          ? 'Inferred editable chart mapping and series grouping from query result columns.'
          : 'Inferred editable chart mapping from query result columns.',
      ],
    };
  }
  return {
    source: 'inferred',
    confidence: kind === 'unsupported' ? 'unsupported' : 'medium',
    renderKind: kind,
    warnings: kind === 'table' ? ['Inferred editable table from query result columns.'] : undefined,
  };
}

export function mergeVisualSpec(base: TileVisualSpec, patch: Partial<TileVisualSpec>): TileVisualSpec {
  return {
    ...base,
    ...patch,
    source: patch.source || 'user',
    confidence: patch.confidence || 'manual',
    warnings: patch.warnings ?? base.warnings,
  };
}

export function resolveTileVisualSpec(
  tile: DashboardTile,
  result: TileResult,
  override?: NativeVisualOverride,
  savedSpec?: TileVisualSpec,
): TileVisualSpec {
  if (savedSpec?.source === 'user') {
    return mergeVisualSpec(inferTileVisualSpec(result, override), savedSpec);
  }
  if (savedSpec) {
    return savedSpec;
  }
  const extracted = extractTileVisualSpecFromRaw(tile.rawQuery);
  if (extracted) {
    return override && override !== 'auto'
      ? mergeVisualSpec(extracted, { renderKind: override, source: 'user', confidence: 'manual' })
      : extracted;
  }
  return inferTileVisualSpec(result, override);
}

function compareValues(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a ?? '').localeCompare(String(b ?? ''));
}

function applySortAndLimit(
  rows: Array<Record<string, unknown>>,
  spec: TileVisualSpec | undefined,
): Array<Record<string, unknown>> {
  let next = rows.slice();
  if (spec?.sort?.field) {
    const dir = spec.sort.direction === 'desc' ? -1 : 1;
    next = next.sort((a, b) => compareValues(a[spec.sort!.field], b[spec.sort!.field]) * dir);
  }
  if (spec?.limit && spec.limit > 0) {
    next = next.slice(0, spec.limit);
  }
  return next;
}

export function resolveVisualMapping(result: TileResult, spec?: TileVisualSpec): ResolvedVisualMapping {
  const kind = spec?.renderKind || result.renderKind;
  const warnings = [...(spec?.warnings || [])];
  const rows = applySortAndLimit(result.rows, spec);
  const categoryColumn = columnByName(result.columns, spec?.categoryField)
    || result.columns.find((column) => !isNumericColumn(column))
    || result.columns[0];
  const requestedMeasures = spec?.measureFields?.map((field) => columnByName(result.columns, field)).filter((column): column is TileColumn => Boolean(column)) || [];
  const measureColumns = requestedMeasures.length > 0
    ? requestedMeasures
    : result.columns.filter((column) => isNumericColumn(column) && column.name !== categoryColumn?.name);
  const seriesColumn = columnByName(result.columns, spec?.seriesField);

  if (spec?.categoryField && !columnByName(result.columns, spec.categoryField)) {
    warnings.push(`Category field "${spec.categoryField}" was not found; using ${categoryColumn?.label || categoryColumn?.name || 'the first column'}.`);
  }
  if (spec?.measureFields?.length && requestedMeasures.length === 0) {
    warnings.push('Selected measure fields were not found; using numeric columns from the result.');
  }

  return {
    kind,
    categoryColumn,
    measureColumns,
    seriesColumn,
    rows,
    warnings,
  };
}

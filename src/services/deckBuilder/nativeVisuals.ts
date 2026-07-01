import type { NativeVisualOverride, TileColumn, TileRenderKind, TileResult } from './types';

const NUMERIC_TYPES = new Set(['number', 'integer', 'float', 'double', 'decimal', 'numeric', 'bigint', 'long']);
const TERMINAL_RENDER_KINDS = new Set<TileRenderKind>(['empty', 'markdown', 'unsupported']);

export interface NativeVisualOption {
  id: NativeVisualOverride;
  label: string;
  shortLabel: string;
  description: string;
}

export interface NativeVisualCompatibility {
  supported: boolean;
  reason?: string;
}

export const NATIVE_VISUAL_OPTIONS: NativeVisualOption[] = [
  {
    id: 'auto',
    label: 'Auto',
    shortLabel: 'Auto',
    description: 'Let OmniKit choose the editable PowerPoint visual from the query result.',
  },
  {
    id: 'table',
    label: 'Table',
    shortLabel: 'Table',
    description: 'Render rows and columns as an editable PowerPoint table.',
  },
  {
    id: 'bar',
    label: 'Bar chart',
    shortLabel: 'Bar',
    description: 'Use a dimension and numeric measure as an editable bar chart.',
  },
  {
    id: 'line',
    label: 'Line chart',
    shortLabel: 'Line',
    description: 'Use a dimension and numeric measure as an editable line chart.',
  },
  {
    id: 'pie',
    label: 'Pie chart',
    shortLabel: 'Pie',
    description: 'Use one dimension and one numeric measure as an editable pie chart.',
  },
  {
    id: 'kpi',
    label: 'KPI',
    shortLabel: 'KPI',
    description: 'Use a single numeric value as a large scorecard.',
  },
];

export function nativeVisualLabel(value: NativeVisualOverride | TileRenderKind | undefined): string {
  if (!value) return 'Auto';
  return NATIVE_VISUAL_OPTIONS.find((option) => option.id === value)?.shortLabel
    || value.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

export function isNumericColumn(column: TileColumn): boolean {
  return Boolean(column.type && NUMERIC_TYPES.has(column.type));
}

function resultShape(result?: TileResult) {
  const numericColumns = result?.columns.filter(isNumericColumn) || [];
  const dimensionColumns = result?.columns.filter((column) => !isNumericColumn(column)) || [];
  return {
    numericColumns,
    dimensionColumns,
    rowCount: result?.rows.length || 0,
    columnCount: result?.columns.length || 0,
  };
}

export function nativeVisualCompatibility(result?: TileResult): Record<NativeVisualOverride, NativeVisualCompatibility> {
  if (!result) {
    const reason = 'Render this tile to validate the result shape.';
    return {
      auto: { supported: true },
      table: { supported: true, reason },
      bar: { supported: true, reason },
      line: { supported: true, reason },
      pie: { supported: true, reason },
      kpi: { supported: true, reason },
    };
  }

  if (TERMINAL_RENDER_KINDS.has(result.renderKind)) {
    const reason =
      result.renderKind === 'empty' ? 'The query returned no rows.' :
      result.renderKind === 'markdown' ? 'Text tiles are not rendered as native charts.' :
      'This tile does not expose a supported native query result.';
    return {
      auto: { supported: true },
      table: { supported: result.renderKind === 'empty', reason },
      bar: { supported: false, reason },
      line: { supported: false, reason },
      pie: { supported: false, reason },
      kpi: { supported: false, reason },
    };
  }

  const { numericColumns, dimensionColumns, rowCount, columnCount } = resultShape(result);
  const hasMeasure = numericColumns.length >= 1;
  const hasDimension = dimensionColumns.length >= 1;
  const hasRows = rowCount > 0;
  const chartReason = 'Needs at least one dimension, one numeric measure, and two rows.';

  return {
    auto: { supported: true },
    table: {
      supported: columnCount > 0,
      reason: columnCount > 0 ? undefined : 'No columns are available for a table.',
    },
    bar: {
      supported: hasDimension && hasMeasure && rowCount >= 2,
      reason: hasDimension && hasMeasure && rowCount >= 2 ? undefined : chartReason,
    },
    line: {
      supported: hasDimension && hasMeasure && rowCount >= 2,
      reason: hasDimension && hasMeasure && rowCount >= 2 ? undefined : chartReason,
    },
    pie: {
      supported: hasDimension && hasMeasure && rowCount >= 2,
      reason: hasDimension && hasMeasure && rowCount >= 2 ? undefined : 'Needs one dimension, one numeric measure, and at least two slices.',
    },
    kpi: {
      supported: hasRows && columnCount === 1 && hasMeasure,
      reason: hasRows && columnCount === 1 && hasMeasure ? undefined : 'Needs a single numeric value.',
    },
  };
}

export function resolveEffectiveRenderKind(
  result: TileResult,
  override?: NativeVisualOverride,
): { kind: TileRenderKind; requested: NativeVisualOverride; supported: boolean; reason?: string } {
  const requested = override || 'auto';
  if (requested === 'auto') {
    return { kind: result.renderKind, requested, supported: true };
  }
  const compatibility = nativeVisualCompatibility(result)[requested];
  if (!compatibility.supported) {
    return {
      kind: result.renderKind,
      requested,
      supported: false,
      reason: compatibility.reason,
    };
  }
  return {
    kind: requested,
    requested,
    supported: true,
  };
}

export function applyNativeVisualOverride(result: TileResult, override?: NativeVisualOverride): TileResult {
  const effective = resolveEffectiveRenderKind(result, override);
  if (effective.kind === result.renderKind) return result;
  return {
    ...result,
    renderKind: effective.kind,
    visualSpec: result.visualSpec
      ? {
          ...result.visualSpec,
          renderKind: effective.kind,
          source: 'user',
          confidence: 'manual',
        }
      : undefined,
  };
}

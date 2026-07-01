import type { DashboardTile } from './types';

export interface TileQuerySummary {
  kind: 'query' | 'markdown' | 'unsupported';
  modelId?: string;
  topic?: string;
  fields: string[];
  filters: string[];
  sorts: string[];
  limit?: number;
  queryPath?: string;
  advancedJson?: string;
  message?: string;
}

const SECRET_KEY_RE = /(api[_-]?key|token|secret|password|passphrase|authorization|auth)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function looksLikeQueryBody(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  if (typeof value.modelId === 'string' || typeof value.model_id === 'string') return true;
  if (Array.isArray(value.fields) && value.fields.length > 0) return true;
  return false;
}

function extractQueryBody(raw: Record<string, unknown> | undefined): { body: Record<string, unknown>; path: string } | null {
  if (!raw) return null;
  const candidates: Array<{ path: string; value: unknown }> = [
    { path: 'query', value: raw.query },
    { path: 'queryShare.query', value: isRecord(raw.queryShare) ? raw.queryShare.query : undefined },
    { path: 'queryPresentation.query', value: isRecord(raw.queryPresentation) ? raw.queryPresentation.query : undefined },
    { path: 'queryBody', value: raw.queryBody },
    { path: 'query_body', value: raw.query_body },
    { path: 'tileQuery', value: raw.tileQuery },
    { path: 'workbook.query', value: isRecord(raw.workbook) ? raw.workbook.query : undefined },
    { path: '<self>', value: raw },
  ];
  for (const candidate of candidates) {
    if (looksLikeQueryBody(candidate.value)) return { body: candidate.value, path: candidate.path };
  }
  return null;
}

function compactText(value: unknown, maxLength = 80): string {
  if (value == null) return '';
  if (typeof value === 'string') return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    const text = JSON.stringify(value);
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
  } catch {
    return String(value).slice(0, maxLength);
  }
}

function fieldLabel(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (!isRecord(value)) return undefined;
  const field =
    value.field ||
    value.name ||
    value.id ||
    value.column ||
    value.columnName ||
    value.column_name ||
    value.fieldName ||
    value.field_name;
  return typeof field === 'string' && field.trim() ? field.trim() : undefined;
}

function summarizeFields(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(fieldLabel).filter((field): field is string => Boolean(field));
}

function summarizeFilters(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((entry) => {
      if (typeof entry === 'string') return entry;
      if (!isRecord(entry)) return compactText(entry);
      const field = fieldLabel(entry) || 'filter';
      const rawValues = entry.values ?? entry.value ?? entry.defaultValue ?? entry.default_value;
      const operator = compactText(entry.kind || entry.type || entry.operator || entry.op, 32);
      const values = compactText(rawValues, 80);
      return [field, operator, values].filter(Boolean).join(' ');
    }).filter(Boolean);
  }
  if (isRecord(value)) {
    return Object.entries(value).map(([field, meta]) => {
      if (!isRecord(meta)) return `${field}: ${compactText(meta)}`;
      const operator = compactText(meta.kind || meta.type || meta.operator || meta.op, 32);
      const rawValues = meta.values ?? meta.value ?? meta.defaultValue ?? meta.default_value;
      const values = compactText(rawValues, 80);
      return `${field}${operator ? ` ${operator}` : ''}${values ? ` ${values}` : ''}`;
    });
  }
  return [compactText(value)];
}

function summarizeSorts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (typeof entry === 'string') return entry;
    if (!isRecord(entry)) return compactText(entry);
    const field = fieldLabel(entry) || 'sort';
    const direction = compactText(entry.direction || entry.dir || entry.desc || entry.ascending, 24);
    return [field, direction].filter(Boolean).join(' ');
  }).filter(Boolean);
}

function pickLimit(body: Record<string, unknown>): number | undefined {
  const raw = body.limit ?? body.rowLimit ?? body.row_limit;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function sanitizeForPreview(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeForPreview);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = SECRET_KEY_RE.test(key) ? '[redacted]' : sanitizeForPreview(child);
  }
  return out;
}

function safeAdvancedJson(body: Record<string, unknown>): string {
  try {
    return JSON.stringify(sanitizeForPreview(body), null, 2);
  } catch {
    return '{}';
  }
}

export function summarizeTileQuery(tile: DashboardTile): TileQuerySummary {
  if (tile.markdown || /markdown|text/i.test(tile.tileType || '')) {
    return {
      kind: 'markdown',
      fields: [],
      filters: [],
      sorts: [],
      message: 'This is a text tile, so there is no native data query to review.',
    };
  }

  const extracted = extractQueryBody(tile.rawQuery);
  if (!extracted) {
    return {
      kind: 'unsupported',
      fields: [],
      filters: [],
      sorts: [],
      message: 'OmniKit could not find a reusable native query payload for this tile.',
    };
  }

  const { body, path } = extracted;
  const modelId = typeof body.modelId === 'string' ? body.modelId : typeof body.model_id === 'string' ? body.model_id : undefined;
  const topic =
    typeof body.topic === 'string' ? body.topic :
    typeof body.topicName === 'string' ? body.topicName :
    typeof body.topic_name === 'string' ? body.topic_name :
    undefined;
  const fields = summarizeFields(body.fields);
  const filters = summarizeFilters(body.filters);
  const sorts = summarizeSorts(body.sorts || body.orderBy || body.order_by);

  return {
    kind: 'query',
    modelId,
    topic,
    fields,
    filters,
    sorts,
    limit: pickLimit(body),
    queryPath: path,
    advancedJson: safeAdvancedJson(body),
  };
}


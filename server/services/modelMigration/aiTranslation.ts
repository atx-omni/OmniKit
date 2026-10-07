// Historical result readers only. New model repairs use the durable branch-bound
// Blobby workflow and authoritative YAML readback, never generated response text.
const REFUSAL_PATTERNS = [
  /\bi\s+(?:can'?t|cannot|won'?t)\b/i,
  /\bunable\s+to\s+(?:help|comply|rewrite|provide)\b/i,
  /\bcan(?:not|'?t)\s+assist\b/i,
  /\brefus(?:e|al|ed)\b/i,
];

export function aiResultText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const row = value as Record<string, unknown>;
  for (const key of ['text', 'content', 'message', 'result', 'response', 'output']) {
    const nested = row[key];
    if (typeof nested === 'string') return nested;
    const deep = aiResultText(nested);
    if (deep) return deep;
  }
  if (Array.isArray(row.messages)) {
    return row.messages.map(aiResultText).filter(Boolean).join('\n');
  }
  return '';
}

export function extractYamlFromAiResult(value: unknown): string {
  const text = aiResultText(value).trim();
  if (!text) return '';
  const fenced = text.match(/```(?:ya?ml)?\s*([\s\S]*?)```/i);
  if (!fenced && isAiRefusalText(text)) return '';
  return (fenced?.[1] || text).trim();
}

export function isAiRefusalText(text: string): boolean {
  const trimmed = text.trim();
  return Boolean(trimmed) && REFUSAL_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function shouldRunAiDialectPass(fileName: string, yaml: string): boolean {
  if (!/\.(view|topic|model|relationship|relationships)$/i.test(fileName)) return false;
  return /^\s*(sql|on_sql|where_sql|having_sql|filters?|custom_sql)\s*:/mi.test(yaml)
    || /\bsql\s*:/i.test(yaml);
}

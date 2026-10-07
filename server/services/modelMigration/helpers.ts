import { isAlias, isMap, isScalar, parseDocument, Scalar, stringify, visit } from 'yaml';
import { MODEL_MIGRATION_PROMPT_VERSION, buildDialectTranslationPrompt } from './prompts';

const MODEL_REFERENCE_KEYS = new Set([
  'modelId',
  'model_id',
  'baseModelId',
  'base_model_id',
  'sharedModelId',
  'shared_model_id',
]);
const FIELD_REF_KEYS = new Set([
  'field',
  'fieldName',
  'field_name',
  'column_name',
  'columnName',
  'fields',
  'pivots',
  'sorts',
  'filters',
  'filter',
  'measures',
  'dimensions',
  'x',
  'y',
  'series',
]);
const FIELD_REF_PATTERN = /\b([A-Za-z_][\w/]*\.[A-Za-z_][\w]*(?:\[[A-Za-z_][\w]*\])?)\b/g;
const CONNECTION_SETTING_PATTERNS = [
  { key: 'connection', pattern: /^\s*connection\s*:/mi },
  { key: 'connection_name', pattern: /^\s*connection_name\s*:/mi },
  { key: 'database', pattern: /^\s*database\s*:/mi },
  { key: 'warehouse', pattern: /^\s*warehouse\s*:/mi },
  { key: 'query_timezone', pattern: /^\s*query_timezone\s*:/mi },
  { key: 'timezone', pattern: /^\s*timezone\s*:/mi },
  { key: 'query_timeout', pattern: /^\s*query_timeout\s*:/mi },
  { key: 'connection settings', pattern: /^\s*(host|account|project|catalog)\s*:/mi },
];

export interface SchemaMapRule {
  source: string;
  target: string;
}

export interface TranslatedYamlFile {
  fileName: string;
  targetOriginal?: string | null;
  additiveStatus?: 'new' | 'additive' | 'unchanged' | 'conflict';
  reviewToken?: string;
  original: string;
  deterministic: string;
  translated: string;
  aiDraft?: string;
  aiJobId?: string;
  aiRefusal?: string;
  blocked?: boolean;
  changed: boolean;
  promptVersion: string;
  reviewRequired: boolean;
  warnings: string[];
}

export interface WorkbookQueryRewrite {
  query: Record<string, unknown>;
  replacements: number;
  fieldReferences: string[];
  blockers: string[];
}

export interface WorkbookTabResultDetail {
  name: string;
  status: 'pending' | 'created' | 'not_created';
  retryBoundary: 'document';
  carried: string[];
}

export interface ContentValidationIssue {
  severity: 'error' | 'warning' | 'info';
  message: string;
  documentId?: string;
  documentName?: string;
  field?: string;
  view?: string;
  targetUrl?: string;
  status?: 'blocking' | 'advisory' | 'new' | 'pre_existing';
  raw?: unknown;
}

export interface SemanticDifferenceDecision {
  id: string;
  kind: 'view' | 'field' | 'topic' | 'relationship' | 'file';
  sourceName: string;
  targetName?: string;
  sourceFileName?: string;
  targetFileName?: string;
  action: 'map_existing' | 'create_from_source' | 'keep_target' | 'ignore' | 'custom_edit';
  required: boolean;
  acceptedYaml?: string;
}

function quotedSegmentPattern(segment: string): string {
  const escaped = segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `(?:"${escaped}"|\`${escaped}\`|\\[${escaped}\\]|${escaped})`;
}

function schemaReferencePattern(source: string): RegExp {
  const segments = source.split('.').map((segment) => segment.trim()).filter(Boolean);
  if (segments.length === 0) return /$a/;
  return new RegExp(`(^|[^A-Za-z0-9_])(${segments.map(quotedSegmentPattern).join('\\s*\\.\\s*')})(?=$|[^A-Za-z0-9_])`, 'gi');
}

export function detectConnectionSettingWarnings(yaml: string): string[] {
  const warnings = new Set<string>();
  for (const row of CONNECTION_SETTING_PATTERNS) {
    if (row.pattern.test(yaml)) warnings.add(`${row.key} may not transfer across connections; review the target model settings before merge.`);
  }
  return [...warnings];
}

export function normalizeBranchName(raw: string, fallback = 'model-migration'): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/\/+/g, '/')
    .slice(0, 96);
  return cleaned || `omnikit-${fallback}-${new Date().toISOString().slice(0, 10)}`;
}

export function parseSchemaMap(raw: string): SchemaMapRule[] {
  return raw
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [source, target] = line.split(/\s*(?:->|=>|,)\s*/);
      return { source: source?.trim() || '', target: target?.trim() || '' };
    })
    .filter((row) => row.source && row.target);
}

export function applySchemaMapToYaml(yaml: string, rules: SchemaMapRule[]): { yaml: string; replacements: number } {
  if (rules.length === 0) return { yaml, replacements: 0 };
  const document = parseDocument(yaml, { keepSourceTokens: true, prettyErrors: false });
  if (document.errors.length > 0 || document.warnings.length > 0) {
    throw new Error('Schema mapping requires unambiguous YAML. Resolve YAML errors or unsupported tags before translating.');
  }
  const edits: Array<{ start: number; end: number; value: string }> = [];
  const pair = (reference: string): string[] | undefined => {
    const segments = reference.split('.').map((segment) => segment.trim());
    return segments.length === 2 && segments.every((segment) => /^[A-Za-z_][A-Za-z0-9_$-]*$/.test(segment))
      ? segments : undefined;
  };
  const combinedRules = rules.flatMap((rule) => {
    const source = pair(rule.source);
    const target = pair(rule.target);
    return source && target ? [{ source, target }] : [];
  });
  if (isMap(document.contents) && combinedRules.length > 0) {
    const catalog = document.get('catalog', true);
    const schema = document.get('schema', true);
    if (catalog !== undefined && schema !== undefined) {
      if (!isScalar(catalog) || !isScalar(schema)
        || typeof catalog.value !== 'string' || typeof schema.value !== 'string') {
        throw new Error('Catalog/schema aliases or non-string values require manual review before schema mapping.');
      }
      const matches = combinedRules.filter((rule) => (
        rule.source[0].toLowerCase() === String(catalog.value).toLowerCase()
        && rule.source[1].toLowerCase() === String(schema.value).toLowerCase()
      ));
      if (new Set(matches.map((rule) => JSON.stringify(rule.target))).size > 1) {
        throw new Error('Conflicting catalog/schema mappings require a single reviewed target before translating.');
      }
      if (matches.length > 0) {
        for (const [index, node] of [catalog, schema].entries()) {
          if (!node.range || node.anchor || node.tag
            || node.type === Scalar.BLOCK_FOLDED || node.type === Scalar.BLOCK_LITERAL) {
            throw new Error('Anchored, tagged, or multiline catalog/schema values require manual review before schema mapping.');
          }
          const value = matches[0].target[index];
          if (value === node.value) continue;
          const replacement = new Scalar(value);
          replacement.type = node.type;
          edits.push({ start: node.range[0], end: node.range[1], value: stringify(replacement).trimEnd() });
        }
      }
    }
  }
  const sqlKeys = new Set(['sql', 'on_sql', 'where_sql', 'having_sql', 'custom_sql', 'sql_table_name']);
  const securityKeys = new Set([
    'access_grants', 'default_topic_required_access_grants', 'default_topic_access_filters',
    'required_access_grants', 'access_filters', 'mask_unless_access_grants',
  ]);
  // Match original SQL once, with explicit combined references ahead of shared schema names.
  // Neither mapped SQL nor the separately mapped catalog/schema scalars are mapped a second time.
  const orderedRules = [...rules].sort((a, b) => (
    b.source.split('.').length - a.source.split('.').length || b.source.length - a.source.length
  ));
  visit(document, {
    Pair(_key, entry) {
      if (!isScalar(entry.key) || typeof entry.key.value !== 'string') return;
      if (securityKeys.has(entry.key.value)) return visit.SKIP;
      if (!sqlKeys.has(entry.key.value)) return;
      const node = entry.value;
      if (isAlias(node)) throw new Error('SQL aliases require manual review before schema mapping.');
      if (!isScalar(node) || typeof node.value !== 'string' || !node.range) return;
      const sqlValue = node.value;
      if (!rules.some((rule) => schemaReferencePattern(rule.source).test(sqlValue))) return;
      let start = node.range[0];
      let end = node.range[1];
      if (node.srcToken?.type === 'block-scalar') {
        // The block header can contain a YAML comment; only its SQL body is eligible.
        start = end - node.srcToken.source.length;
      } else if (node.type === Scalar.QUOTE_SINGLE || node.type === Scalar.QUOTE_DOUBLE) {
        start += 1;
        end -= 1;
      }
      const original = yaml.slice(start, end);
      if ((node.type === Scalar.QUOTE_SINGLE && original.includes("''"))
        || (node.type === Scalar.QUOTE_DOUBLE && original.includes('\\'))) {
        throw new Error('Escaped quoted SQL requires manual review before schema mapping.');
      }
      const protectedRanges = [...original.matchAll(
        /--[^\r\n]*|\/\*[\s\S]*?\*\/|\$\{[^}]*\}|\{\{[\s\S]*?\}\}|\$\$[\s\S]*?\$\$|'(?:''|\\.|[^'\\])*'/g,
      )].map((match) => ({ start: start + match.index, end: start + match.index + match[0].length }));
      for (const rule of orderedRules) {
        for (const match of original.matchAll(schemaReferencePattern(rule.source))) {
          const matchStart = start + match.index + match[1].length;
          const matchEnd = matchStart + match[2].length;
          if ([...protectedRanges, ...edits].some((range) => matchStart < range.end && matchEnd > range.start)) continue;
          if (node.anchor || node.tag) throw new Error('Anchored or tagged SQL requires manual review before schema mapping.');
          edits.push({ start: matchStart, end: matchEnd, value: rule.target });
        }
      }
    },
  });
  let next = yaml;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    next = next.slice(0, edit.start) + edit.value + next.slice(edit.end);
  }
  return { yaml: next, replacements: edits.length };
}

export function buildTranslatedYamlFiles(input: {
  files: Record<string, string>;
  schemaMap: SchemaMapRule[];
  sourceDialect: string;
  targetDialect: string;
}): TranslatedYamlFile[] {
  return Object.entries(input.files).map(([fileName, original]) => {
    const deterministic = applySchemaMapToYaml(original, input.schemaMap);
    const dialectChanged = Boolean(input.sourceDialect && input.targetDialect && input.sourceDialect !== input.targetDialect);
    const warnings = [
      ...(deterministic.replacements > 0 ? [`${deterministic.replacements} schema/catalog reference rewrite${deterministic.replacements === 1 ? '' : 's'} applied.`] : []),
      ...(dialectChanged ? [`${input.sourceDialect} to ${input.targetDialect} SQL requires human review for sql blocks.`] : []),
      ...detectConnectionSettingWarnings(original),
    ];
    return {
      fileName,
      original,
      deterministic: deterministic.yaml,
      translated: deterministic.yaml,
      changed: deterministic.yaml !== original,
      promptVersion: MODEL_MIGRATION_PROMPT_VERSION,
      reviewRequired: dialectChanged || deterministic.yaml !== original,
      warnings,
    };
  });
}

export function promptForYamlFile(input: {
  sourceDialect: string;
  targetDialect: string;
  fileName: string;
  schemaMap: SchemaMapRule[];
  yaml: string;
}): string {
  return buildDialectTranslationPrompt(input);
}

export function rewriteQueryModelReferences(
  query: Record<string, unknown>,
  sourceModelId: string,
  targetModelId: string,
): WorkbookQueryRewrite {
  let replacements = 0;
  const rewritten = rewriteUnknown(query, sourceModelId, targetModelId, () => {
    replacements += 1;
  }) as Record<string, unknown>;
  const fieldReferences = [...collectFieldReferences(rewritten)].sort();
  return { query: rewritten, replacements, fieldReferences, blockers: [] };
}

function rewriteUnknown(value: unknown, sourceModelId: string, targetModelId: string, onReplace: () => void, key?: string): unknown {
  if (typeof value === 'string' && key && MODEL_REFERENCE_KEYS.has(key) && value === sourceModelId) {
    onReplace();
    return targetModelId;
  }
  if (Array.isArray(value)) return value.map((item) => rewriteUnknown(item, sourceModelId, targetModelId, onReplace));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([childKey, item]) => [
      childKey,
      rewriteUnknown(item, sourceModelId, targetModelId, onReplace, childKey),
    ]),
  );
}

export function collectFieldReferences(value: unknown, parentKey = ''): Set<string> {
  const refs = new Set<string>();
  if (typeof value === 'string') {
    if (FIELD_REF_KEYS.has(parentKey)) {
      for (const match of value.matchAll(FIELD_REF_PATTERN)) refs.add(match[1]);
    }
    return refs;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      for (const ref of collectFieldReferences(item, parentKey)) refs.add(ref);
    }
    return refs;
  }
  if (!value || typeof value !== 'object') return refs;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    for (const ref of collectFieldReferences(item, key)) refs.add(ref);
  }
  return refs;
}

export function buildFieldUniverseFromYaml(files: Record<string, string>): Set<string> {
  const refs = new Set<string>();
  for (const [fileName, yaml] of Object.entries(files)) {
    const viewName = fileName.endsWith('.view') ? fileName.replace(/\.view$/, '') : '';
    if (!viewName) continue;
    for (const match of yaml.matchAll(/^\s{2}([A-Za-z_][\w]*):\s*$/gm)) {
      refs.add(`${viewName}.${match[1]}`);
    }
    for (const match of yaml.matchAll(/name:\s*([A-Za-z_][\w]*)/g)) {
      refs.add(`${viewName}.${match[1]}`);
    }
  }
  return refs;
}

function semanticKindForFile(fileName: string): SemanticDifferenceDecision['kind'] {
  if (fileName.endsWith('.view')) return 'view';
  if (fileName.endsWith('.topic')) return 'topic';
  if (fileName === 'relationships') return 'relationship';
  return 'file';
}

function entityNameFromFile(fileName: string): string {
  return fileName.replace(/\.(view|topic)$/, '');
}

export function buildSemanticDifferenceDecisions(input: {
  sourceFiles: Record<string, string>;
  targetFiles: Record<string, string>;
}): SemanticDifferenceDecision[] {
  const decisions: SemanticDifferenceDecision[] = [];
  for (const [fileName, sourceYaml] of Object.entries(input.sourceFiles)) {
    if (input.targetFiles[fileName] !== undefined) continue;
    const kind = semanticKindForFile(fileName);
    const sourceName = entityNameFromFile(fileName);
    decisions.push({
      id: `${kind}:${sourceName}:missing-file`,
      kind,
      sourceName,
      sourceFileName: fileName,
      targetFileName: fileName,
      action: 'create_from_source',
      required: kind === 'view' || kind === 'topic',
      acceptedYaml: sourceYaml,
    });
  }

  const sourceFields = buildFieldUniverseFromYaml(input.sourceFiles);
  const targetFields = buildFieldUniverseFromYaml(input.targetFiles);
  for (const field of [...sourceFields].sort()) {
    if (targetFields.has(field)) continue;
    const [viewName] = field.split('.');
    decisions.push({
      id: `field:${field}:missing-target`,
      kind: 'field',
      sourceName: field,
      targetName: '',
      sourceFileName: `${viewName}.view`,
      targetFileName: `${viewName}.view`,
      action: 'create_from_source',
      required: true,
    });
  }

  return decisions;
}

export function preflightWorkbookQueryFields(rewrite: WorkbookQueryRewrite, fieldUniverse: Set<string>): WorkbookQueryRewrite {
  const blockers = rewrite.fieldReferences
    .filter((field) => fieldUniverse.size > 0 && !fieldUniverse.has(field))
    .map((field) => `Field is not available on the target model: ${field}`);
  return { ...rewrite, blockers };
}

export function buildWorkbookTabResultDetails(
  tabs: Array<{ name: string; visConfig?: Record<string, unknown>; description?: string }>,
  status: WorkbookTabResultDetail['status'],
): WorkbookTabResultDetail[] {
  return tabs.map((tab) => ({
    name: tab.name,
    status,
    retryBoundary: 'document',
    carried: ['query', tab.visConfig ? 'visConfig' : '', tab.description ? 'description' : ''].filter(Boolean),
  }));
}

function stringFromKeys(row: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function severityFrom(row: Record<string, unknown>): ContentValidationIssue['severity'] {
  const raw = stringFromKeys(row, ['severity', 'level', 'type', 'status'])?.toLowerCase();
  if (raw?.includes('warn')) return 'warning';
  if (raw?.includes('info') || raw?.includes('advisory')) return 'info';
  if (row.is_warning === true || row.warning === true) return 'warning';
  return 'error';
}

function statusFrom(row: Record<string, unknown>, severity: ContentValidationIssue['severity']): ContentValidationIssue['status'] {
  const raw = stringFromKeys(row, ['validationStatus', 'validation_status', 'disposition', 'category', 'source'])?.toLowerCase();
  if (raw?.includes('pre')) return 'pre_existing';
  if (raw?.includes('new')) return 'new';
  if (raw?.includes('advis')) return 'advisory';
  if (raw?.includes('block')) return 'blocking';
  if (row.blocking === true || row.is_blocking === true) return 'blocking';
  return severity === 'error' ? 'blocking' : 'advisory';
}

export function normalizeContentValidationIssues(value: unknown): ContentValidationIssue[] {
  const issues: ContentValidationIssue[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const row = node as Record<string, unknown>;
    const message = stringFromKeys(row, ['message', 'error', 'description', 'details', 'reason']);
    if (message) {
      const severity = severityFrom(row);
      issues.push({
        severity,
        message,
        documentId: stringFromKeys(row, ['documentId', 'document_id', 'docId', 'id']),
        documentName: stringFromKeys(row, ['documentName', 'document_name', 'name', 'title']),
        field: stringFromKeys(row, ['field', 'fieldName', 'field_name']),
        view: stringFromKeys(row, ['view', 'viewName', 'view_name']),
        targetUrl: stringFromKeys(row, ['targetUrl', 'target_url', 'url', 'link']),
        status: statusFrom(row, severity),
        raw: row,
      });
      return;
    }
    for (const item of Object.values(row)) visit(item);
  };
  visit(value);
  return issues;
}

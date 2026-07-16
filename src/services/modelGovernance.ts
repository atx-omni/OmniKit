import { isMap, parseDocument } from 'yaml';

export type SemanticFieldKind = 'dimension' | 'measure';
export type StaleViewConfidence = 'high' | 'medium' | 'manual';
export type StaleViewReason = 'broken-reference' | 'referenced-in-validation' | 'source-drift' | 'manual-review';
export type ContentReferenceStatus = 'unknown' | 'verified-zero' | 'referenced' | 'failed';

export interface SemanticTopicRow {
  name: string;
  fileName: string;
  label: string;
}

export interface SemanticViewRow {
  name: string;
  fileName: string;
  label: string;
  fields: SemanticFieldRow[];
}

export interface SemanticFieldRow {
  id: string;
  viewName: string;
  fileName: string;
  kind: SemanticFieldKind;
  name: string;
  groupLabel: string;
}

export interface SemanticInventory {
  topics: SemanticTopicRow[];
  views: SemanticViewRow[];
  fields: SemanticFieldRow[];
  warnings: string[];
}

export interface ValidationIssueLike {
  message?: string;
  yaml_path?: string;
  is_warning?: boolean;
}

export interface SemanticContentReference {
  documentId: string;
  identifier: string;
  name: string;
  type: string;
  updatedAt?: string;
  folderPath?: string;
  ownerName?: string;
  queryNames: string[];
}

export interface StaleViewCandidate {
  viewName: string;
  fileName: string;
  label: string;
  reason: StaleViewReason;
  confidence: StaleViewConfidence;
  validationIssues: string[];
  referencedByCount: number | null;
  referenceStatus: ContentReferenceStatus;
  references: SemanticContentReference[];
  referenceError?: string;
  evidence: string[];
  sourceTable?: string;
  safeByDefault: boolean;
}

export type LabelPatch =
  | { kind: 'topic'; fileName: string; name: string; before: string; after: string }
  | { kind: 'view'; fileName: string; name: string; before: string; after: string }
  | { kind: 'field'; fileName: string; viewName: string; fieldName: string; fieldKind: SemanticFieldKind; before: string; after: string };

export interface LabelPatchResult {
  changedFiles: Array<{ fileName: string; yaml: string }>;
  deltas: LabelPatch[];
  warnings: string[];
}

type ParsedYamlDocument = ReturnType<typeof parseDocument>;

function cleanScalar(value: string | undefined | null): string {
  if (!value) return '';
  return value.trim().replace(/^['"]|['"]$/g, '').trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseYaml(yaml: string): ParsedYamlDocument {
  const document = parseDocument(yaml, {
    prettyErrors: false,
    strict: false,
    uniqueKeys: false,
  });
  if (document.errors.length > 0) {
    throw new Error(document.errors.map((error) => error.message).join(' '));
  }
  return document;
}

function scalarString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value && typeof value === 'object' && 'value' in value) {
    const scalar = (value as { value?: unknown }).value;
    return scalar === null || scalar === undefined ? '' : String(scalar);
  }
  return '';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function firstString(...values: unknown[]): string {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim() || '';
}

export function nameFromYamlFile(fileName: string, suffix: string): string {
  const base = fileName.split('/').pop() || fileName;
  return base.endsWith(suffix) ? base.slice(0, -suffix.length) : base;
}

export function getTopLevelYamlScalar(yaml: string, key: string): string {
  return cleanScalar(scalarString(parseYaml(yaml).get(key, true)));
}

export function setTopLevelYamlScalar(yaml: string, key: string, value: string): string {
  const document = parseYaml(yaml);
  const cleanValue = value.trim();
  if (cleanValue) document.set(key, cleanValue);
  else document.delete(key);
  return document.toString({ lineWidth: 0 }).trimEnd();
}

export function setViewIgnored(yaml: string, ignored = true): string {
  const document = parseYaml(yaml || '{}');
  if (ignored) document.set('ignored', true);
  else document.delete('ignored');
  return document.toString({ lineWidth: 0 }).trimEnd();
}

function parseFieldsForView(viewName: string, fileName: string, yaml: string): SemanticFieldRow[] {
  const rows: SemanticFieldRow[] = [];
  const document = parseYaml(yaml);
  for (const [sectionName, kind] of [['dimensions', 'dimension'], ['measures', 'measure']] as const) {
    const section = document.get(sectionName, true);
    if (!isMap(section)) continue;
    for (const pair of section.items) {
      const name = scalarString(pair.key);
      if (!name) continue;
      const groupLabel = isMap(pair.value)
        ? cleanScalar(scalarString(pair.value.get('group_label', true)))
        : '';
      rows.push({
        id: `${fileName}:${kind}:${name}`,
        viewName,
        fileName,
        kind,
        name,
        groupLabel,
      });
    }
  }
  return rows;
}

export function parseSemanticInventory(files: Record<string, string>): SemanticInventory {
  const topics: SemanticTopicRow[] = [];
  const views: SemanticViewRow[] = [];
  const fields: SemanticFieldRow[] = [];
  const warnings: string[] = [];

  for (const [fileName, yaml] of Object.entries(files)) {
    const leaf = fileName.split('/').pop() || fileName;
    try {
      if (leaf.endsWith('.topic')) {
        const name = nameFromYamlFile(fileName, '.topic');
        topics.push({ name, fileName, label: getTopLevelYamlScalar(yaml, 'label') });
        continue;
      }
      if (leaf.endsWith('.view') && !leaf.endsWith('.query.view')) {
        const name = nameFromYamlFile(fileName, '.view');
        const viewFields = parseFieldsForView(name, fileName, yaml);
        views.push({ name, fileName, label: getTopLevelYamlScalar(yaml, 'label'), fields: viewFields });
        fields.push(...viewFields);
      }
    } catch (error) {
      warnings.push(`${fileName} could not be parsed: ${error instanceof Error ? error.message : 'invalid YAML'}`);
    }
  }

  topics.sort((a, b) => a.name.localeCompare(b.name));
  views.sort((a, b) => a.name.localeCompare(b.name));
  fields.sort((a, b) => a.viewName.localeCompare(b.viewName) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  return { topics, views, fields, warnings };
}

function normalizeIdentifier(value: string): string {
  return value
    .trim()
    .replace(/^['"`]|['"`]$/g, '')
    .replace(/^.*\//, '')
    .replace(/\.view$/i, '')
    .toLowerCase();
}

function quotedIdentifiers(value: string): string[] {
  const identifiers: string[] = [];
  const pattern = /["'`]([^"'`]+)["'`]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) identifiers.push(normalizeIdentifier(match[1]));
  return identifiers;
}

function issueMatchesView(issue: ValidationIssueLike, viewName: string, fileName: string): boolean {
  const normalizedView = normalizeIdentifier(viewName);
  const normalizedFile = normalizeIdentifier(fileName);
  const issuePath = issue.yaml_path ? normalizeIdentifier(issue.yaml_path) : '';
  if (issuePath && (issuePath === normalizedView || issuePath === normalizedFile)) return true;

  const message = issue.message || '';
  if (quotedIdentifiers(message).some((identifier) => identifier === normalizedView || identifier === normalizedFile)) return true;
  const escaped = escapeRegExp(viewName);
  return new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`, 'i').test(message);
}

export function buildStaleViewCandidates(input: {
  inventory: SemanticInventory;
  validationIssues?: ValidationIssueLike[];
  contentReferenceCounts?: Record<string, number>;
  contentReferences?: Record<string, SemanticContentReference[]>;
  referenceErrors?: Record<string, string>;
  sourceDriftViews?: Record<string, { sourceTable?: string; detail?: string }>;
  includeManualCandidates?: boolean;
}): StaleViewCandidate[] {
  const issues = input.validationIssues || [];
  const candidates: StaleViewCandidate[] = [];

  for (const view of input.inventory.views) {
    const matchingIssues = issues.filter((issue) => issueMatchesView(issue, view.name, view.fileName));
    const brokenReferenceIssues = matchingIssues.filter((issue) => {
      const text = `${issue.message || ''} ${issue.yaml_path || ''}`.toLowerCase();
      return text.includes('does not exist')
        || text.includes('not found')
        || text.includes('no view')
        || text.includes('unknown')
        || text.includes('missing');
    });
    const sourceDrift = input.sourceDriftViews?.[view.name];
    const shouldInclude = Boolean(sourceDrift)
      || brokenReferenceIssues.length > 0
      || matchingIssues.length > 0
      || input.includeManualCandidates === true;
    if (!shouldInclude) continue;

    const hasReferenceResult = Boolean(input.contentReferences && Object.prototype.hasOwnProperty.call(input.contentReferences, view.name));
    const references = hasReferenceResult ? input.contentReferences?.[view.name] || [] : [];
    const referenceError = input.referenceErrors?.[view.name];
    const legacyReferenceCount = input.contentReferenceCounts && Object.prototype.hasOwnProperty.call(input.contentReferenceCounts, view.name)
      ? input.contentReferenceCounts[view.name]
      : null;
    const referencedByCount = hasReferenceResult ? references.length : legacyReferenceCount;
    const referenceStatus: ContentReferenceStatus = referenceError
      ? 'failed'
      : hasReferenceResult
        ? references.length > 0 ? 'referenced' : 'verified-zero'
        : legacyReferenceCount !== null
          ? legacyReferenceCount > 0 ? 'referenced' : 'verified-zero'
          : 'unknown';
    const reason: StaleViewReason = sourceDrift
      ? 'source-drift'
      : brokenReferenceIssues.length > 0
        ? 'broken-reference'
        : matchingIssues.length > 0
          ? 'referenced-in-validation'
          : 'manual-review';
    const confidence: StaleViewConfidence = reason === 'source-drift' || reason === 'broken-reference'
      ? 'high'
      : reason === 'referenced-in-validation'
        ? 'medium'
        : 'manual';
    const evidence = [
      ...(sourceDrift?.detail ? [sourceDrift.detail] : []),
      ...matchingIssues.map((issue) => issue.yaml_path || issue.message || 'Model validation signal'),
    ].slice(0, 5);
    candidates.push({
      viewName: view.name,
      fileName: view.fileName,
      label: view.label,
      reason,
      confidence,
      validationIssues: matchingIssues.map((issue) => issue.message || issue.yaml_path || 'Validation issue').slice(0, 5),
      referencedByCount,
      referenceStatus,
      references,
      referenceError,
      evidence,
      sourceTable: sourceDrift?.sourceTable,
      safeByDefault: confidence === 'high' && referenceStatus === 'verified-zero',
    });
  }

  return candidates.sort((a, b) => (
    Number(b.safeByDefault) - Number(a.safeByDefault)
    || a.confidence.localeCompare(b.confidence)
    || a.viewName.localeCompare(b.viewName)
  ));
}

function setFieldGroupLabel(yaml: string, kind: SemanticFieldKind, fieldName: string, value: string): string {
  const document = parseYaml(yaml);
  const sectionName = kind === 'dimension' ? 'dimensions' : 'measures';
  const section = document.get(sectionName, true);
  if (!isMap(section)) return yaml.trimEnd();
  const field = section.get(fieldName, true);
  if (!isMap(field)) return yaml.trimEnd();
  const cleanValue = value.trim();
  if (cleanValue) field.set('group_label', cleanValue);
  else field.delete('group_label');
  return document.toString({ lineWidth: 0 }).trimEnd();
}

export function applyLabelPatches(files: Record<string, string>, patches: LabelPatch[]): LabelPatchResult {
  const nextFiles = { ...files };
  const changedFiles = new Map<string, string>();
  const applied: LabelPatch[] = [];
  const warnings: string[] = [];

  for (const patch of patches) {
    const currentYaml = nextFiles[patch.fileName];
    const patchLabel = patch.kind === 'field' ? patch.fieldName : patch.name;
    if (typeof currentYaml !== 'string') {
      warnings.push(`${patch.fileName} was not found; skipped ${patch.kind} ${patchLabel}.`);
      continue;
    }
    try {
      const nextYaml = patch.kind === 'topic' || patch.kind === 'view'
        ? setTopLevelYamlScalar(currentYaml, 'label', patch.after)
        : setFieldGroupLabel(currentYaml, patch.fieldKind, patch.fieldName, patch.after);
      if (nextYaml !== currentYaml.trimEnd()) {
        nextFiles[patch.fileName] = nextYaml;
        changedFiles.set(patch.fileName, nextYaml);
        applied.push(patch);
      }
    } catch (error) {
      warnings.push(`${patch.fileName} could not be safely updated for ${patchLabel}: ${error instanceof Error ? error.message : 'invalid YAML'}`);
    }
  }

  return {
    changedFiles: [...changedFiles.entries()].map(([fileName, yaml]) => ({ fileName, yaml })),
    deltas: applied,
    warnings,
  };
}

export function buildLabelPatternValue(input: {
  name: string;
  current: string;
  mode: 'set' | 'prefix' | 'title-case' | 'find-replace' | 'clear';
  value: string;
  find?: string;
}): string {
  if (input.mode === 'clear') return '';
  if (input.mode === 'set') return input.value;
  if (input.mode === 'prefix') return `${input.value}${input.current || input.name}`.trim();
  if (input.mode === 'find-replace') {
    const find = input.find || '';
    if (!find) return input.current || input.name;
    return (input.current || input.name).replace(new RegExp(escapeRegExp(find), 'gi'), input.value);
  }
  return input.name
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function countContentReferences(raw: unknown, viewNames: string[]): Record<string, number> {
  const text = JSON.stringify(raw || {}).toLowerCase();
  const counts: Record<string, number> = {};
  for (const viewName of viewNames) {
    if (!viewName) continue;
    const escaped = escapeRegExp(viewName.toLowerCase());
    const matches = text.match(new RegExp(`(^|[^a-z0-9_])${escaped}([^a-z0-9_]|$)`, 'g'));
    counts[viewName] = matches?.length || 0;
  }
  return counts;
}

export function normalizeContentReferences(raw: unknown): SemanticContentReference[] {
  const root = asRecord(raw);
  const rows = Array.isArray(root?.content)
    ? root.content
    : Array.isArray(root?.data)
      ? root.data
      : [];
  const references: SemanticContentReference[] = [];
  for (const item of rows) {
    const row = asRecord(item);
    if (!row) continue;
    const folder = asRecord(row.folder);
    const owner = asRecord(row.owner);
    const queryRows = Array.isArray(row.queries_and_issues) ? row.queries_and_issues : [];
    const queryNames = queryRows
      .map((query) => firstString(asRecord(query)?.query_name, asRecord(query)?.name))
      .filter(Boolean);
    references.push({
      documentId: firstString(row.document_id, row.documentId, row.id),
      identifier: firstString(row.identifier),
      name: firstString(row.name, row.identifier, row.document_id, 'Untitled content'),
      type: firstString(row.type, 'Content'),
      updatedAt: firstString(row.updated_at, row.updatedAt) || undefined,
      folderPath: firstString(folder?.path, folder?.name) || undefined,
      ownerName: firstString(owner?.name, owner?.email) || undefined,
      queryNames: [...new Set(queryNames)],
    });
  }
  return references;
}

export function findFilesChangedSinceLoad(input: {
  affectedFiles: string[];
  originalFiles: Record<string, string>;
  originalChecksums: Record<string, string>;
  branchFiles: Record<string, string>;
  branchChecksums: Record<string, string>;
}): string[] {
  return [...new Set(input.affectedFiles)].filter((fileName) => {
    const originalChecksum = input.originalChecksums[fileName];
    const branchChecksum = input.branchChecksums[fileName];
    if (originalChecksum && branchChecksum) return originalChecksum !== branchChecksum;
    return (input.originalFiles[fileName] || '').trimEnd() !== (input.branchFiles[fileName] || '').trimEnd();
  });
}

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isAlias, isMap, isNode, isScalar, parseDocument, visit, type Scalar } from 'yaml';
import type { TopicMigrationFile, TopicMigrationIssue } from '../../shared/topicMigration';
import { topicMigrationDestinationPath } from './topicMigrationVerification';
import { reconcileTopicTableName, topicMigrationPhysicalTable, type TopicTableNameInventory } from './topicMigrationTableNames';
import { reviewTopicMigrationSqlDialect } from './topicMigrationSqlDialect';

/** Compatibility alias for callers; evidence is the existing table/column inventory contract. */
export type DestinationTableNameInventory = TopicTableNameInventory;
type Obj = Record<string, unknown>;
type SqlField = { section: string; name: string; node: Scalar<string>; value: string };
const safePath = (path: unknown): path is string => typeof path === 'string' && path.length > 0 && path.length <= 512
  && !path.includes('\\') && !path.split('/').some(part => !part || part === '.' || part === '..')
  && ![...path].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
const fieldPath = (section: string, name: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
  ? `${section}.${name}.sql` : `${section}[${JSON.stringify(name)}].sql`;
const semanticName = (path: string) => path.split('/').pop()!.replace(/\.view$/, '').toLowerCase();

function readYaml(yaml: string) {
  if (typeof yaml !== 'string' || Buffer.byteLength(yaml, 'utf8') > 2_000_000) return;
  try {
    const document = parseDocument(yaml, { uniqueKeys: true, strict: true, prettyErrors: false, intAsBigInt: true });
    if (document.errors.length || document.warnings.length || !isMap(document.contents)) return;
    let nodes = 0;
    visit(document, (_key, node, path) => {
      if (++nodes > 25_000 || path.length > 64) throw new Error('Bounded YAML required.');
      if (isAlias(node) || (isNode(node) && (node.tag || ('anchor' in node && node.anchor)))) throw new Error('Explicit YAML required.');
      if (isMap(node)) for (const pair of node.items) {
        if (!isScalar(pair.key) || typeof pair.key.value !== 'string'
          || ['__proto__', 'prototype', 'constructor', '<<'].includes(pair.key.value)) throw new Error('Safe unique keys required.');
      }
    });
    const fields = new Map<string, SqlField>();
    for (const section of ['dimensions', 'measures']) {
      const definitions = document.contents.get(section, true);
      if (!isMap(definitions)) continue;
      for (const pair of definitions.items) {
        if (!isMap(pair.value)) continue;
        const name = String((pair.key as Scalar<string>).value), sql = pair.value.get('sql', true);
        if (isScalar<string>(sql) && typeof sql.value === 'string' && sql.range) {
          fields.set(fieldPath(section, name), { section, name, node: sql, value: sql.value });
        }
      }
    }
    return { value: document.toJS({ maxAliasCount: 0 }) as Obj, fields };
  } catch { return; }
}

function boundedStringMap(value: Record<string, string>, maxBytes: number): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length > 5_000) return false;
  let bytes = 0;
  return Object.entries(descriptors).every(([path, descriptor]) => {
    if (!safePath(path) || !('value' in descriptor) || typeof descriptor.value !== 'string') return false;
    bytes += Buffer.byteLength(descriptor.value, 'utf8'); return bytes <= maxBytes;
  });
}

function exactColumns(inventory: TopicTableNameInventory | undefined, tableName: string): string[] | undefined {
  if (inventory?.status !== 'available' || !Array.isArray(inventory.tableNames) || inventory.tableNames.length > 5_000
    || !inventory.tableNames.every(name => typeof name === 'string') || !Array.isArray(inventory.columnsByTable) || inventory.columnsByTable.length > 5_000) return;
  const names = [...new Set(inventory.tableNames)].filter(name => name.toLowerCase() === tableName.toLowerCase());
  const rows = inventory.columnsByTable.filter(row => row && row.tableName === tableName);
  return names.length === 1 && names[0] === tableName && rows?.length === 1 ? rows[0].columns : undefined;
}

/** Pure existing-branch diff: never creates files, applies namespace mappings, or regenerates native edits. */
export function buildTopicBranchCorrections(input: {
  originalFiles: TopicMigrationFile[];
  schemaMapText: string;
  branchFiles: Record<string, string>;
  branchChecksums: Record<string, string>;
  sourceDialect: string;
  targetDialect: string;
  tableNames: DestinationTableNameInventory[];
}): { files: TopicMigrationFile[]; issues: TopicMigrationIssue[]; noops: number } {
  const files: TopicMigrationFile[] = [], issues: TopicMigrationIssue[] = [];
  let noops = 0;
  const issue = (original: TopicMigrationFile | undefined, destination: string | undefined, code: string, message: string,
    severity: TopicMigrationIssue['severity'] = 'blocker', kind: TopicMigrationIssue['kind'] = 'conflict') => {
    issues.push({ id: createHash('sha256').update(JSON.stringify([code, destination || ''])).digest('hex').slice(0, 20),
      kind, severity, title: code, message, nextAction: severity === 'blocker'
        ? 'Review the exact branch file in Omni. No conflicting or uncertain file will be overwritten.'
        : 'Review preserved SQL, physical bindings, and query behavior in Omni before publication.',
      topicIds: original?.topicIds || [], ...(destination ? { fileName: destination } : {}) });
  };
  if (!Array.isArray(input.originalFiles) || input.originalFiles.length > 5_000 || !Array.isArray(input.tableNames) || input.tableNames.length > 5_000
    || typeof input.schemaMapText !== 'string' || input.schemaMapText.length > 64_000
    || !boundedStringMap(input.branchFiles, 20_000_000) || !boundedStringMap(input.branchChecksums, 2_000_000)
    || input.originalFiles.some(file => !file || typeof file.proposed !== 'string' || !safePath(file.fileName) || !safePath(file.sourceFileName)
      || !Array.isArray(file.topicIds) || file.topicIds.some(id => typeof id !== 'string'))
    || input.originalFiles.reduce((total, file) => total + Buffer.byteLength(file.proposed, 'utf8'), 0) > 20_000_000) {
    issue(undefined, undefined, 'CORRECTION_SCOPE_INVALID', 'The approved package or current branch evidence exceeds the supported bounds or is malformed.');
    return { files, issues, noops };
  }
  const candidates: Array<{ original: TopicMigrationFile; destination: string }> = [];
  for (const original of input.originalFiles) {
    if (!['create', 'add'].includes(original.status) || original.kind !== 'view'
      || original.fileName.endsWith('.query.view') || original.sourceFileName.endsWith('.query.view')) continue;
    let destination: string;
    try { destination = topicMigrationDestinationPath(original, input.schemaMapText); }
    catch {
      issue(original, safePath(original.fileName) ? original.fileName : undefined, 'CORRECTION_PATH_INVALID', 'The original approved path cannot be mapped uniquely to this branch.'); continue;
    }
    if (!readYaml(original.proposed)) {
      issue(original, destination, 'APPROVED_YAML_UNREADABLE', 'The original approved physical definition cannot be inspected safely.'); continue;
    }
    if (!topicMigrationPhysicalTable(original.proposed)) {
      issue(original, destination, 'NON_PHYSICAL_VIEW_PRESERVED', 'Query-backed or nonliteral physical definitions are outside automatic branch corrections.', 'review', 'sql'); continue;
    }
    candidates.push({ original, destination });
  }
  const branchNames = Object.keys(input.branchFiles);
  for (const { original, destination } of candidates) {
    const present = Object.hasOwn(input.branchFiles, destination), current = present ? input.branchFiles[destination] : null;
    const checksum = input.branchChecksums[destination];
    const base: TopicMigrationFile = { sourceFileName: original.sourceFileName, fileName: destination, destinationFileName: destination,
      kind: 'view', topicIds: original.topicIds, before: current, proposed: current || '', status: 'blocked' };
    const conflict = (code: string, message: string) => { issue(original, destination, code, message); files.push(base); };
    if (candidates.filter(candidate => candidate.destination.toLowerCase() === destination.toLowerCase()).length !== 1
      || branchNames.some(name => name !== destination && (name.toLowerCase() === destination.toLowerCase()
        || (name.endsWith('.view') && semanticName(name) === semanticName(destination))))) {
      conflict('CORRECTION_PATH_AMBIGUOUS', 'The approved destination conflicts with another current path or semantic view identity.'); continue;
    }
    if (current === null) { conflict('CORRECTION_FILE_MISSING', 'The exact approved destination is missing or was moved; no replacement file will be created.'); continue; }
    if (typeof checksum !== 'string' || !checksum || checksum.length > 1024 || checksum !== checksum.trim()
      || [...checksum].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
      conflict('BRANCH_CHECKSUM_MISSING', 'The current file has no usable exact branch checksum.'); continue;
    }
    base.previousChecksum = checksum;
    const approved = readYaml(original.proposed)!, branch = readYaml(current);
    const approvedPhysical = topicMigrationPhysicalTable(original.proposed)!, currentPhysical = topicMigrationPhysicalTable(current);
    if (!branch || !currentPhysical) {
      conflict('CURRENT_YAML_UNSUPPORTED', 'The current branch definition is unreadable, unsafe, or no longer an ordinary physical view.'); continue;
    }
    const inventories = input.tableNames.filter(inventory => inventory?.namespace === currentPhysical.namespace);
    const inventory = inventories.length === 1 ? inventories[0] : undefined;
    const table = reconcileTopicTableName(current, inventory);
    const sameBinding = isDeepStrictEqual(currentPhysical, approvedPhysical);
    const tableChanged = sameBinding && table.status === 'corrected';
    let proposed = tableChanged ? table.yaml : current;
    const finalPhysical = topicMigrationPhysicalTable(proposed)!;
    if (!sameBinding) issue(original, destination, 'NATIVE_PHYSICAL_MAPPING_PRESERVED',
      'The branch has a native physical binding different from the original approval. Its table, schema, and catalog remain unchanged.', 'info', 'mapping');
    if (['ambiguous', 'missing', 'unavailable'].includes(table.status)) issue(original, destination, 'TABLE_METADATA_' + table.status.toUpperCase(),
      'Destination table-name evidence is ' + table.status + '. No table or namespace mapping is guessed.', 'review', 'mapping');
    const columns = ['exact', 'corrected'].includes(table.status) ? exactColumns(inventory, finalPhysical.tableName) : undefined;
    const approvedReview = reviewTopicMigrationSqlDialect({ yaml: original.proposed, kind: 'view', sourceDialect: input.sourceDialect,
      targetDialect: input.targetDialect, columns });
    const currentReview = reviewTopicMigrationSqlDialect({ yaml: proposed, kind: 'view', sourceDialect: input.sourceDialect,
      targetDialect: input.targetDialect, columns });
    const beforeSql = readYaml(proposed)!, afterSql = readYaml(currentReview.yaml)!;
    const expected = structuredClone(branch.value);
    if (tableChanged) expected.table_name = finalPhysical.tableName;
    const edits: Array<{ start: number; end: number; token: string }> = [];
    const corrections: NonNullable<TopicMigrationFile['sqlDialectReview']>['corrections'] = [];
    const alreadyCorrect = new Set<string>();
    const conflicts: string[] = [];
    for (const correction of approvedReview.corrections) {
      const field = beforeSql.fields.get(correction.path);
      if (field?.value === correction.to) { alreadyCorrect.add(correction.path); continue; }
      if (!field || field.value !== correction.from) { conflicts.push(correction.path); continue; }
      const safe = currentReview.corrections.find(candidate => candidate.path === correction.path
        && candidate.from === correction.from && candidate.to === correction.to);
      const changed = afterSql.fields.get(correction.path);
      // A native scalar style may require manual review even when its interpreted SQL is unchanged.
      if (!safe || !changed?.node.range) continue;
      const [start, end] = field.node.range!;
      const [tokenStart, tokenEnd] = changed.node.range;
      edits.push({ start, end, token: currentReview.yaml.slice(tokenStart, tokenEnd) }); corrections.push(safe);
      ((expected[field.section] as Record<string, Obj>)[field.name]).sql = safe.to;
    }
    if (conflicts.length) {
      conflict('NATIVE_SQL_EDIT_CONFLICT', 'Native edits overlap automatic corrections at ' + conflicts.slice(0, 20).join(', ')
        + (conflicts.length > 20 ? ' (additional overlapping fields omitted).' : '.')); continue;
    }
    const findings = currentReview.findings.filter(finding => !alreadyCorrect.has(finding.path)
      && (finding.path === '$' || approved.fields.has(finding.path) || !finding.path.endsWith('.sql')));
    // New/changed native expressions are deliberately outside the correction set, even if the linter could convert them.
    const preservedNative = currentReview.corrections.filter(correction => !approvedReview.corrections.some(candidate => candidate.path === correction.path));
    if (preservedNative.length) findings.push({ path: '$', reason: 'NATIVE_SQL_PRESERVED: New or independently edited native expressions were not part of the original correction scope.' });
    const pieces: string[] = [];
    let cursor = 0, invalidRange = false;
    for (const edit of edits.sort((a, b) => a.start - b.start)) {
      if (edit.start < cursor || edit.end <= edit.start || edit.end > proposed.length) { invalidRange = true; break; }
      pieces.push(proposed.slice(cursor, edit.start), edit.token); cursor = edit.end;
    }
    pieces.push(proposed.slice(cursor)); proposed = pieces.join('');
    const verified = readYaml(proposed);
    if (invalidRange || !verified || !isDeepStrictEqual(verified.value, expected)) {
      conflict('CORRECTION_PRESERVATION_UNPROVEN', 'The correction could not be proven to preserve every unrelated current branch value.'); continue;
    }
    if (findings.length) issue(original, destination, 'PRESERVED_SQL_REQUIRES_NATIVE_REVIEW',
      findings.length + ' SQL compatibility finding(s) remain. Unsupported expressions and native changes are preserved.', 'review', 'sql');
    const changed = proposed !== current;
    files.push({ ...base, proposed, status: changed ? 'add' : 'reuse', sqlDialectReview: { corrections, findings },
      ...(tableChanged ? { tableNameCorrection: { namespace: currentPhysical.namespace, from: currentPhysical.tableName, to: finalPhysical.tableName } } : {}) });
    if (!changed) noops += 1;
  }
  return { files, issues, noops };
}

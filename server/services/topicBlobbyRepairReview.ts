import { isDeepStrictEqual } from 'node:util';
import { isAlias, isMap, isNode, isScalar, parseDocument, stringify, visit } from 'yaml';
import type { TopicBlobbyFinding, TopicBlobbyRepair } from '../../shared/topicBlobbyRepair';
import { aiPromptSecurityError } from './aiPromptSecurity';

const SECURITY = /access|grant|permission|policy|mask|row_level|user_attribute|omni_attribute|filter|always_where|always_join/i;
const SQL = /^(?:sql|on_sql|where_sql|having_sql|custom_sql)$/;
export const blobbySafePath = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512
  && !value.includes('\\') && !value.split('/').some(part => !part || part === '.' || part === '..')
  && ![...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);

export function boundedBlobbyFiles(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  let bytes = 0;
  return entries.length <= 5_000 && entries.every(([key, text]) => blobbySafePath(key) && typeof text === 'string'
    && Buffer.byteLength(text) <= 2_000_000 && (bytes += Buffer.byteLength(text)) <= 20_000_000);
}

function parsed(text: string): unknown {
  const document = parseDocument(text, { strict: true, uniqueKeys: true, prettyErrors: false, intAsBigInt: true });
  if (document.errors.length || document.warnings.length || !document.contents) throw new Error('Unsupported YAML.');
  let count = 0;
  visit(document, (_key, node, path) => {
    if (++count > 25_000 || path.length > 64 || isAlias(node)
      || (isNode(node) && (node.tag || ('anchor' in node && node.anchor)))) throw new Error('Unsupported YAML.');
    if (isMap(node)) for (const pair of node.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string'
        || ['__proto__', 'constructor', 'prototype', '<<'].includes(pair.key.value)) throw new Error('Unsupported YAML.');
    }
  });
  return document.toJS({ maxAliasCount: 0 });
}

const refs = (text: string) => [...new Set(text.match(/\$\{[^}]+\}|\{\{[\s\S]*?\}\}/g) || [])].sort();
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const relationshipIdentity = (entry: unknown): string | undefined => object(entry) && typeof entry.join_from_view === 'string'
  && typeof entry.join_to_view === 'string' ? JSON.stringify([entry.join_from_view, entry.join_to_view, entry.join_to_view_as ?? null]) : undefined;

/** Detection, not AI write prevention. Whole snapshots are private; UI diffs include selected files only. */
export function reviewTopicBlobbyChanges(before: Record<string, string>, after: Record<string, string>, scope: string[],
  protection?: { authored: Record<string, string>; destination: Record<string, string> }): {
  changes: TopicBlobbyRepair['changes']; findings: TopicBlobbyFinding[];
} {
  const changes: TopicBlobbyRepair['changes'] = [], findings: TopicBlobbyFinding[] = [];
  const add = (code: string, message: string, fileName?: string) => {
    if (!findings.some(item => item.code === code && item.fileName === fileName)) findings.push({ code, severity: 'blocker', message, ...(fileName ? { fileName } : {}) });
  };
  if (!boundedBlobbyFiles(before) || !boundedBlobbyFiles(after) || scope.length > 200 || scope.some(name => !blobbySafePath(name))) {
    add('SNAPSHOT_UNAVAILABLE', 'Complete bounded branch YAML is required.'); return { changes, findings };
  }
  const allowed = new Set(scope), names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  for (const name of names) {
    if (before[name] === after[name]) continue;
    if (!allowed.has(name)) { add('OUT_OF_SCOPE_CHANGE', 'A file outside the approved repair scope changed. Review it in Omni; this repair cannot be accepted.', name); continue; }
    changes.push({ fileName: name, before: before[name] ?? null, after: after[name] ?? null });
    if (!Object.hasOwn(before, name) || !Object.hasOwn(after, name)) { add('FILE_ADDED_OR_DELETED', 'Repair cannot create, delete, or move authored files.', name); continue; }
    if (aiPromptSecurityError(after[name])) add('SENSITIVE_CONTENT', 'Secret-shaped content requires separate native review; it will not be sent to AI or exposed in repair details.', name);
    try {
      const authored = protection ? parsed(protection.authored[name]) : undefined;
      const destination = protection?.destination[name] === undefined ? undefined : parsed(protection.destination[name]);
      const baselineValue = parsed(before[name]);
      const atPath = (root: unknown, path: string[]): { present: boolean; value?: unknown } => {
        let value = root, baseline = baselineValue;
        for (const part of path) {
          if (Array.isArray(value) && Array.isArray(baseline)) {
            const identity = relationshipIdentity(baseline[Number(part)]);
            if (identity !== undefined) {
              const matches = value.filter(entry => relationshipIdentity(entry) === identity);
              if (matches.length > 1) throw new Error('Ambiguous relationship identity.');
              if (!matches.length) return { present: false };
              value = matches[0]; baseline = baseline[Number(part)]; continue;
            }
            // Unknown sequence identities never grant positional repair authority.
            return { present: value.length > 0, value };
          }
          if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) return { present: false };
          value = (value as Record<string, unknown>)[part];
          baseline = baseline && typeof baseline === 'object' ? (baseline as Record<string, unknown>)[part] : undefined;
        }
        return { present: value !== undefined, value };
      };
      const walk = (left: unknown, right: unknown, path: string[], protectedValue = false) => {
        if (isDeepStrictEqual(left, right)) return;
        const key = path.at(-1) || '', secure = protectedValue || SECURITY.test(key)
          || typeof left === 'string' && SECURITY.test(left) || typeof right === 'string' && SECURITY.test(right);
        if (secure) { add('SECURITY_CHANGED', 'Authored security, filters, or dynamic access behavior changed. Restore or reconcile it outside this repair approval.', name); return; }
        if (Array.isArray(left) && Array.isArray(right) && left.length === right.length) {
          for (const entries of [left, right]) {
            const ids = entries.map(relationshipIdentity).filter(identity => identity !== undefined);
            if (new Set(ids).size !== ids.length) throw new Error('Ambiguous relationship identity.');
          }
          left.forEach((entry, index) => walk(entry, right[index], [...path, String(index)], secure)); return;
        }
        if (object(left) && object(right) && isDeepStrictEqual(Object.keys(left).sort(), Object.keys(right).sort())) {
          for (const child of Object.keys(left)) walk(left[child], right[child], [...path, child], secure); return;
        }
        if (typeof left === 'string' && typeof right === 'string' && SQL.test(key) && !name.endsWith('.model') && name !== 'model') {
          if (protection && (!atPath(authored, path).present || atPath(destination, path).present)) {
            add('PREEXISTING_MEMBER_CHANGED', 'A preexisting destination or native-added member changed inside a selected file. It is outside this repair authority.', name); return;
          }
          if (!isDeepStrictEqual(refs(left), refs(right))) add('DEPENDENCY_REFERENCE_CHANGED', 'Omni field or template references changed. Preserve the original dependency identities.', name);
          return;
        }
        if (name.endsWith('.view') && path.length === 1 && ['catalog', 'database', 'schema', 'table_name', 'sql_table_name'].includes(key)
          && typeof left === 'string' && typeof right === 'string') {
          if (protection && (!atPath(authored, path).present || atPath(destination, path).present)) add('PREEXISTING_MEMBER_CHANGED', 'A preexisting destination physical binding changed. This repair cannot alter shared destination bindings.', name);
          return;
        }
        add('AUTHORED_STRUCTURE_CHANGED', 'A definition, identifier, relationship property, or non-SQL behavior changed. Only syntax and physical bindings can be accepted here.', name);
      };
      walk(baselineValue, parsed(after[name]), []);
    } catch { add('YAML_UNREADABLE', 'Changed YAML could not be safely compared; aliases, tags, duplicates, malformed content, and oversized structures are unsupported.', name); }
  }
  if (changes.length) findings.push({ code: 'NATIVE_QUERY_REVIEW', severity: 'warning', message: 'Changes detected on the branch. Syntax checks do not establish equivalent results, effective access, or warehouse-query acceptance.' });
  return { changes, findings };
}

/** Only selected source-authored members are supplied as prompt context, never destination-only/native-added members. */
export function topicBlobbySelectedContext(current: Record<string, string>, authored: Record<string, string>): Record<string, unknown> {
  const project = (value: unknown, shape: unknown): unknown => {
    if (object(value) !== object(shape) || Array.isArray(value) !== Array.isArray(shape)) {
      throw new Error('Selected authored structure changed; native reconciliation is required.');
    }
    if (object(shape) && object(value)) return Object.fromEntries(Object.keys(shape).filter(key => Object.hasOwn(value, key))
      .map(key => [key, project(value[key], shape[key])]));
    if (Array.isArray(shape) && Array.isArray(value)) {
      if (shape.every(entry => relationshipIdentity(entry) !== undefined)) return shape.map(entry => {
        const matches = value.filter(candidate => relationshipIdentity(candidate) === relationshipIdentity(entry));
        if (matches.length !== 1) throw new Error('Selected relationship identity is missing or ambiguous.');
        return project(matches[0], entry);
      });
      if (!isDeepStrictEqual(value, shape)) throw new Error('Selected sequence changed; native reconciliation is required.');
      return value;
    }
    return value;
  };
  return Object.fromEntries(Object.entries(authored).map(([name, yaml]) => [name, project(parsed(current[name]), parsed(yaml))]));
}

/** Legacy/current approved proposals may already include merged target members. They are never repair scope. */
export function topicBlobbyAuthoredYaml(proposed: string, destination?: string): string {
  if (destination === undefined) { parsed(proposed); return proposed; }
  const subtract = (value: unknown, prior: unknown): unknown => {
    if (isDeepStrictEqual(value, prior)) return undefined;
    if (object(value) && object(prior)) return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => {
      const selected = Object.hasOwn(prior, key) ? subtract(entry, prior[key]) : entry;
      return selected === undefined ? [] : [[key, selected]];
    }));
    if (Array.isArray(value) && Array.isArray(prior)) {
      const oldIds = prior.map(relationshipIdentity), ids = value.map(relationshipIdentity);
      if (oldIds.some(id => id === undefined) || ids.some(id => id === undefined) || new Set(ids).size !== ids.length
        || new Set(oldIds).size !== oldIds.length) throw new Error('Unresolved authored sequence scope.');
      return value.filter(entry => !oldIds.includes(relationshipIdentity(entry)));
    }
    throw new Error('Existing destination values are not additive authored repair scope.');
  };
  return stringify(subtract(parsed(proposed), parsed(destination)) ?? {}, { lineWidth: 0 });
}

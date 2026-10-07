import { isAlias, isMap, isNode, isScalar, parseDocument, visit } from 'yaml';
import type { TopicBranchValidation } from '../../shared/topicBranchCorrection';
import { aiPromptSecretFindingsShared, redactAiPromptSecrets } from '../../src/services/aiPromptSecurityShared';
import { blobbySafePath, boundedBlobbyFiles } from './topicBlobbyRepairReview';

type ValidationIssue = TopicBranchValidation['issues'][number];
export interface TopicBlobbyAuthoredPhysicalBinding {
  catalog?: string;
  schema?: string;
  table_name: string;
  evidence: 'selected_authored_yaml_not_physical_verification';
}
export type TopicBlobbyValidationContextIssue = ValidationIssue & {
  context: 'selected_scope' | 'context_only_unscoped_do_not_expand_scope';
  resolvedFileName?: string;
  authoredPhysicalBinding?: TopicBlobbyAuthoredPhysicalBinding;
};

const REDACTED = /\[redacted(?:-[^\]]+)?\]/i;
const EXTENSION = /\.(?:query\.view|view|topic|model|relationships?)$/;
// These are location hints only, never authority to edit the referenced member.
const MEMBER_SUFFIX = /^[.:](?:catalog|database|schema|table_name|sql_table_name|sql|dimensions|measures|relationships|base_view|joins|views|fields|filters|required_access_grants|access_filters|model)(?:\.[A-Za-z_][A-Za-z0-9_]*|\[\d{1,4}\])*$/;
const LINE_SUFFIX = /^:[1-9]\d{0,5}(?::[1-9]\d{0,5})?$/;
function matchesLocation(location: string, candidate: string): boolean {
  if (location === candidate) return true;
  if (!location.startsWith(candidate)) return false;
  const suffix = location.slice(candidate.length);
  return MEMBER_SUFFIX.test(suffix) || LINE_SUFFIX.test(suffix);
}
function resolvedFile(location: string | undefined, names: string[]): string | undefined {
  if (typeof location !== 'string' || location.length > 1_024 || !blobbySafePath(location) || REDACTED.test(location)) return;
  // Full authored paths win over shorthand. Never case-fold or remove namespaces.
  const exact = names.filter(name => matchesLocation(location, name));
  if (exact.length) return exact.length === 1 ? exact[0] : undefined;
  // Resolve shorthand against the WHOLE snapshot, including unselected files.
  const shorthand = names.filter(name => {
    const basename = name.split('/').pop()!;
    return [...new Set([basename, name.replace(EXTENSION, ''), basename.replace(EXTENSION, '')])]
      .some(candidate => matchesLocation(location, candidate));
  });
  return shorthand.length === 1 ? shorthand[0] : undefined;
}
function physicalBinding(name: string, yaml: string): TopicBlobbyAuthoredPhysicalBinding | undefined {
  if (!name.endsWith('.view') || name.endsWith('.query.view')) return;
  try {
    const document = parseDocument(yaml, { strict: true, uniqueKeys: true, prettyErrors: false });
    if (document.errors.length || document.warnings.length || !isMap(document.contents)) return;
    let count = 0;
    visit(document, (_key, node, path) => {
      if (++count > 25_000 || path.length > 64 || isAlias(node)
        || isNode(node) && (node.tag || 'anchor' in node && node.anchor)) throw new Error('Explicit YAML required.');
      if (isMap(node)) for (const pair of node.items) {
        if (!isScalar(pair.key) || typeof pair.key.value !== 'string'
          || ['__proto__', 'prototype', 'constructor', '<<'].includes(pair.key.value)) throw new Error('Safe mapping keys required.');
      }
    });
    const mapping = document.contents;
    if (['sql', 'sql_table_name', 'query', 'query_view', 'database'].some(key => mapping.has(key))) return;
    const literal = (key: string) => {
      const node = mapping.get(key, true);
      if (!isScalar(node) || typeof node.value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_$]{0,254}$/.test(node.value)
        || redactAiPromptSecrets(node.value) !== node.value || aiPromptSecretFindingsShared(node.value).length) return;
      return node.value;
    };
    const table_name = literal('table_name'), catalog = literal('catalog'), schema = literal('schema');
    if (!table_name || mapping.has('catalog') && !catalog || mapping.has('schema') && !schema) return;
    return { ...(catalog ? { catalog } : {}), ...(schema ? { schema } : {}), table_name,
      evidence: 'selected_authored_yaml_not_physical_verification' };
  } catch { return; }
}

/** Classify sanitized diagnostic context, never enlarge selected-member repair authority. No I/O. */
export function buildTopicBlobbyValidationContext(issues: TopicBranchValidation['issues'], branchFiles: Record<string, string>,
  selectedFiles: string[]): TopicBlobbyValidationContextIssue[] {
  const usable = boundedBlobbyFiles(branchFiles) && selectedFiles.length <= 200
    && selectedFiles.every(name => blobbySafePath(name) && Object.hasOwn(branchFiles, name))
    && new Set(selectedFiles).size === selectedFiles.length;
  const names = usable ? Object.keys(branchFiles) : [], selected = new Set(usable ? selectedFiles : []);
  const bindings = new Map<string, TopicBlobbyAuthoredPhysicalBinding | undefined>();
  return issues.map(issue => {
    const name = resolvedFile(issue.fileName, names);
    if (!name || !selected.has(name)) return { ...issue, context: 'context_only_unscoped_do_not_expand_scope' };
    if (!bindings.has(name)) bindings.set(name, physicalBinding(name, branchFiles[name]));
    const binding = bindings.get(name);
    return { ...issue, context: 'selected_scope', resolvedFileName: name,
      ...(binding ? { authoredPhysicalBinding: binding } : {}) };
  });
}

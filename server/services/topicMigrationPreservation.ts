import { isDeepStrictEqual } from 'node:util';
import { isAlias, isMap, isNode, isScalar, parseDocument, visit, type YAMLMap } from 'yaml';
import type { TopicMigrationRequest } from '../../shared/topicMigration';
import { previewDashboardRepairYaml } from './dashboardRepairYaml';

const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const safeView = (value: unknown): value is string => typeof value === 'string' && value.length <= 512 && value.endsWith('.view')
  && !value.endsWith('.query.view') && !value.includes('\\') && !value.split('/').some(part => !part || part === '.' || part === '..')
  && ![...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
const SECURITY = /(?:access|grant|permission|policy|mask|row_level|user_attribute|omni_attribute)/i;
const fail = (message: string): never => { throw new Error(message); };

export function canonicalKeepDestinationDefinitions(value: unknown): TopicMigrationRequest['keepDestinationDefinitions'] {
  if (value === undefined) return undefined;
  if (!object(value) || Object.keys(value).length > 200) return fail('Destination-preservation choices must be a bounded object of exact source view paths.');
  const choices = Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([file, choice]) => {
    if (!safeView(file) || !object(choice) || Object.keys(choice).sort().join(',') !== 'destinationFileName,sourceHash,targetHash'
      || !safeView(choice.destinationFileName) || typeof choice.sourceHash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(choice.sourceHash)
      || typeof choice.targetHash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(choice.targetHash)) return fail('Each preservation choice needs an exact ordinary view path and both complete snapshot hashes.');
    return [file, { destinationFileName: choice.destinationFileName, sourceHash: choice.sourceHash as string, targetHash: choice.targetHash as string }] as const;
  });
  if (new Set(choices.map(([, choice]) => choice.destinationFileName.toLowerCase())).size !== choices.length) return fail('Preservation choices cannot share a destination path.');
  return choices.length ? Object.fromEntries(choices) : undefined;
}

function read(text: string) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 2_000_000) return fail('Preservation requires bounded authored view YAML.');
  const document = parseDocument(text, { strict: true, uniqueKeys: true, prettyErrors: false, intAsBigInt: true });
  if (document.errors.length || document.warnings.length || !isMap(document.contents)) return fail('Preservation requires an explicit ordinary view mapping.');
  let nodes = 0;
  visit(document, (_key, node, path) => {
    if (++nodes > 25_000 || path.length > 64 || isAlias(node) || (isNode(node) && (node.tag || ('anchor' in node && node.anchor)))) fail('Preservation cannot interpret aliases, tags, or unbounded definitions.');
    if (isMap(node)) for (const pair of node.items) if (!isScalar(pair.key) || typeof pair.key.value !== 'string'
      || ['__proto__', 'prototype', 'constructor', '<<'].includes(pair.key.value)) fail('Preservation requires safe explicit keys.');
  });
  for (const key of ['sql', 'query', 'query_view']) if (document.contents.has(key)) fail('Query-backed views require separate native review.');
  for (const key of ['dimensions', 'measures']) if (document.contents.has(key) && !isMap(document.contents.get(key, true))) fail('Field containers must be explicit mappings.');
  return document;
}
function security(value: unknown, path = '$', result = new Map<string, unknown>()): Map<string, unknown> {
  if (Array.isArray(value)) value.forEach((entry, index) => security(entry, path + '[' + index + ']', result));
  else if (object(value)) for (const [key, child] of Object.entries(value)) {
    if (SECURITY.test(key) || typeof child === 'string' && (SECURITY.test(child) || /\{\{/.test(child))) result.set(path + '.' + key, child);
    else security(child, path + '.' + key, result);
  }
  return result;
}

/** Keep destination definitions and comments intact; add whole missing source fields only. */
export function preserveDestinationView(targetYaml: string, scopedSourceYaml: string): {
  yaml: string; keptPaths: string[]; addedPaths: string[]; omittedSourcePaths: string[];
} {
  const target = read(targetYaml), source = read(scopedSourceYaml);
  const targetRoot = target.contents as YAMLMap, sourceRoot = source.contents as YAMLMap;
  const targetValue = target.toJS({ maxAliasCount: 0 }) as Record<string, unknown>;
  const sourceValue = source.toJS({ maxAliasCount: 0 }) as Record<string, unknown>;
  const top = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([key]) => !['dimensions', 'measures'].includes(key)));
  if (!isDeepStrictEqual(security(top(sourceValue)), security(top(targetValue)))) fail('Source and destination view security differ. This choice cannot override or discard either policy.');
  const keptPaths: string[] = [], addedPaths: string[] = [];
  const omittedSourcePaths = Object.keys(sourceValue).filter(key => !['dimensions', 'measures'].includes(key) && !Object.hasOwn(targetValue, key));
  for (const pair of targetRoot.items) {
    const key = String((pair.key as { value: unknown }).value);
    if (['dimensions', 'measures'].includes(key) && isMap(pair.value)) for (const field of pair.value.items) keptPaths.push(key + '.' + String((field.key as { value: unknown }).value));
    else keptPaths.push(key);
  }
  sourceRoot.items = sourceRoot.items.filter(pair => ['dimensions', 'measures'].includes(String((pair.key as { value: unknown }).value)));
  for (const pair of sourceRoot.items) {
    const section = String((pair.key as { value: unknown }).value), fields = pair.value as YAMLMap;
    const targetFields = targetRoot.get(section, true);
    fields.items = fields.items.filter(field => {
      const name = String((field.key as { value: unknown }).value), other = section === 'dimensions' ? 'measures' : 'dimensions';
      const opposite = targetRoot.get(other, true);
      if (isMap(opposite) && opposite.has(name)) fail('A source field collides with a destination field in the opposite field container.');
      for (const container of [targetFields, opposite]) if (isMap(container) && container.items.some(pair => {
        const existing = String((pair.key as { value: unknown }).value); return existing !== name && existing.toLowerCase() === name.toLowerCase();
      })) fail('A source field differs only by case from a destination field. Resolve the exact semantic identity separately.');
      if (isMap(targetFields) && targetFields.has(name)) {
        const sourceDefinition = (sourceValue[section] as Record<string, unknown>)[name];
        const targetDefinition = (targetValue[section] as Record<string, unknown>)[name];
        if (!isDeepStrictEqual(security(sourceDefinition), security(targetDefinition))) fail('Source and retained destination field security differ. Reconcile the exact field policy separately.');
        if (object(sourceDefinition) && object(targetDefinition)) for (const key of Object.keys(sourceDefinition)) {
          if (!Object.hasOwn(targetDefinition, key)) omittedSourcePaths.push(section + '.' + name + '.' + key);
        }
        return false;
      }
      if (!isMap(field.value) && !(isScalar(field.value) && field.value.value === null) && field.value !== null) fail('A missing field must have a complete mapping or an explicit empty default definition.');
      addedPaths.push(section + '.' + name); return true;
    });
  }
  sourceRoot.items = sourceRoot.items.filter(pair => (pair.value as YAMLMap).items.length > 0);
  const yaml = addedPaths.length ? previewDashboardRepairYaml(targetYaml, source.toString()).yaml : targetYaml;
  return { yaml, keptPaths: keptPaths.sort(), addedPaths: addedPaths.sort(), omittedSourcePaths: omittedSourcePaths.sort() };
}

import { isMap, isNode, parseDocument, type Pair, type Schema, type YAMLMap } from 'yaml';
import type { OmniModelYamlResponse } from './omniApi';

export interface PreservedTopicYaml {
  yaml: string;
  restoredTopLevelKeys: string[];
  restoredPaths: string[];
}

interface TopLevelBlock {
  key: string;
  text: string;
}

export interface AuthoredTopicYamlFile {
  fileName: `${string}.topic`;
  yaml: string;
}

function normalizeTopicName(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * Resolve the exact authored file path, including nested folders. Fail closed
 * when no file or multiple normalized matches exist.
 */
export function findAuthoredTopicYamlFile(
  modelYaml: Pick<OmniModelYamlResponse, 'files'> | null | undefined,
  topicName: string | undefined,
): AuthoredTopicYamlFile | null {
  const normalizedTopicName = normalizeTopicName(topicName || '');
  if (!normalizedTopicName || !modelYaml?.files) return null;
  const matches = Object.entries(modelYaml.files).filter(([fileName, yaml]) => {
    if (!fileName.endsWith('.topic') || typeof yaml !== 'string') return false;
    const leaf = fileName.split('/').at(-1)?.replace(/\.topic$/i, '') || '';
    return normalizeTopicName(leaf) === normalizedTopicName;
  });
  if (matches.length !== 1) return null;
  return {
    fileName: matches[0][0] as `${string}.topic`,
    yaml: matches[0][1],
  };
}

function parseTopicDocument(yaml: string, label: string) {
  const document = parseDocument(yaml, {
    prettyErrors: false,
    strict: false,
    uniqueKeys: false,
  });
  if (document.errors.length > 0) {
    throw new Error(`${label} topic YAML is invalid: ${document.errors.map((error) => error.message).join(' ')}`);
  }
  if (!isMap(document.contents)) {
    throw new Error(`${label} topic YAML must be a top-level mapping.`);
  }
  return document;
}

function scalarKey(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'value' in value) {
    const scalar = (value as { value?: unknown }).value;
    return typeof scalar === 'string' ? scalar : String(scalar ?? '');
  }
  return String(value ?? '');
}

function documentKeys(yaml: string, label: string): string[] {
  const document = parseTopicDocument(yaml, label);
  if (!isMap(document.contents)) return [];
  return document.contents.items
    .map((pair) => scalarKey(pair.key).trim())
    .filter(Boolean);
}

function topLevelBlocks(yaml: string): TopLevelBlock[] {
  const lines = yaml.replace(/\r\n/g, '\n').split('\n');
  const starts: Array<{ key: string; index: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^([A-Za-z_][\w-]*):(?:\s|$)/);
    if (match) starts.push({ key: match[1], index });
  }

  return starts.map((entry, position) => ({
    key: entry.key,
    text: lines
      .slice(entry.index, starts[position + 1]?.index ?? lines.length)
      .join('\n')
      .trimEnd(),
  }));
}

function insertBeforeAiContext(candidateYaml: string, blocks: TopLevelBlock[]): string {
  if (blocks.length === 0) return candidateYaml.trimEnd();
  const lines = candidateYaml.replace(/\r\n/g, '\n').trimEnd().split('\n');
  const aiContextIndex = lines.findIndex((line) => /^ai_context:(?:\s|$)/.test(line));
  const insertion = blocks.flatMap((block, index) => (
    index === blocks.length - 1 ? block.text.split('\n') : [...block.text.split('\n'), '']
  ));

  if (aiContextIndex < 0) {
    return [...lines, '', ...insertion].join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
  }
  return [
    ...lines.slice(0, aiContextIndex),
    ...insertion,
    '',
    ...lines.slice(aiContextIndex),
  ].join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

function pairKey(pair: Pair): string {
  return scalarKey(pair.key).trim();
}

function restoreNodeMetadata(source: unknown, candidate: unknown): boolean {
  if (!isNode(source) || !isNode(candidate)) return false;
  let restored = false;
  if (!candidate.commentBefore && source.commentBefore) {
    candidate.commentBefore = source.commentBefore;
    restored = true;
  }
  if (!candidate.comment && source.comment) {
    candidate.comment = source.comment;
    restored = true;
  }
  if (!candidate.spaceBefore && source.spaceBefore) {
    candidate.spaceBefore = true;
    restored = true;
  }
  return restored;
}

function restoreMissingMapEntries(
  source: YAMLMap,
  candidate: YAMLMap,
  schema: Schema,
  path: string[],
  restoredPaths: string[],
): boolean {
  let restoredMetadata = false;
  for (const sourcePair of source.items) {
    const key = pairKey(sourcePair);
    if (!key) continue;
    const candidatePair = candidate.items.find((pair) => pairKey(pair) === key);
    const nextPath = [...path, key];
    if (!candidatePair) {
      candidate.items.push(sourcePair.clone(schema));
      restoredPaths.push(nextPath.join('.'));
      continue;
    }

    restoredMetadata = restoreNodeMetadata(sourcePair.key, candidatePair.key) || restoredMetadata;
    restoredMetadata = restoreNodeMetadata(sourcePair.value, candidatePair.value) || restoredMetadata;
    if (isMap(sourcePair.value) && isMap(candidatePair.value)) {
      restoredMetadata = restoreMissingMapEntries(
        sourcePair.value,
        candidatePair.value,
        schema,
        nextPath,
        restoredPaths,
      ) || restoredMetadata;
    }
  }
  return restoredMetadata;
}

/**
 * Topic YAML writes replace an entire file. Preserve exact source blocks that a
 * generated candidate omitted so an additive edit cannot silently erase authored
 * settings, permissions, filters, or future Omni keys.
 */
export function preserveExistingTopicYaml(sourceYaml: string, candidateYaml: string): PreservedTopicYaml {
  const sourceDocument = parseTopicDocument(sourceYaml, 'Source');
  const originalCandidateDocument = parseTopicDocument(candidateYaml, 'Candidate');
  if (!isMap(sourceDocument.contents) || !isMap(originalCandidateDocument.contents)) {
    throw new Error('Source and candidate topic YAML must be top-level mappings.');
  }

  const sourceKeys = documentKeys(sourceYaml, 'Source');
  const candidateKeys = new Set(documentKeys(candidateYaml, 'Candidate'));
  const sourceBlocks = new Map(topLevelBlocks(sourceYaml).map((block) => [block.key, block]));
  const restoredTopLevelKeys = sourceKeys.filter((key) => !candidateKeys.has(key));
  const missingBlocks = restoredTopLevelKeys.map((key) => sourceBlocks.get(key)).filter((block): block is TopLevelBlock => Boolean(block));
  if (missingBlocks.length !== restoredTopLevelKeys.length) {
    const unavailable = restoredTopLevelKeys.filter((key) => !sourceBlocks.has(key));
    throw new Error(`OmniKit could not preserve source topic section${unavailable.length === 1 ? '' : 's'}: ${unavailable.join(', ')}.`);
  }

  const candidateWithTopLevelRestorations = insertBeforeAiContext(candidateYaml, missingBlocks);
  const candidateDocument = parseTopicDocument(candidateWithTopLevelRestorations, 'Candidate');
  if (!isMap(candidateDocument.contents)) {
    throw new Error('Candidate topic YAML must be a top-level mapping.');
  }
  const restoredPaths: string[] = [...restoredTopLevelKeys];
  const restoredMetadata = restoreMissingMapEntries(
    sourceDocument.contents,
    candidateDocument.contents,
    candidateDocument.schema,
    [],
    restoredPaths,
  );
  if (!candidateDocument.commentBefore && sourceDocument.commentBefore) {
    candidateDocument.commentBefore = sourceDocument.commentBefore;
  }
  if (!candidateDocument.comment && sourceDocument.comment) {
    candidateDocument.comment = sourceDocument.comment;
  }

  const nestedRestorations = restoredPaths.filter((path) => path.includes('.'));
  const documentMetadataRestored = Boolean(
    (!originalCandidateDocument.commentBefore && sourceDocument.commentBefore)
    || (!originalCandidateDocument.comment && sourceDocument.comment)
  );
  const yaml = nestedRestorations.length > 0 || restoredMetadata || documentMetadataRestored
    ? candidateDocument.toString().trimEnd()
    : candidateWithTopLevelRestorations;
  parseTopicDocument(yaml, 'Preserved candidate');
  return { yaml, restoredTopLevelKeys, restoredPaths };
}

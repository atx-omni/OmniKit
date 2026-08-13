import type {
  MigrationDecision,
  MigrationDiffLine,
  MigrationFileDiff,
  SemanticMigrationFile,
  SemanticYamlFileName,
} from './types';
import { parse, stringify } from 'yaml';
import { sha256Text } from './sourceEvidence';
import { semanticMigrationDefinitionPaths } from './contracts';

export function isSemanticYamlFileName(fileName: string): fileName is SemanticYamlFileName {
  return fileName === 'model' ||
    fileName === 'relationships' ||
    /^[A-Za-z0-9_./-]+\.topic$/.test(fileName) ||
    /^[A-Za-z0-9_./-]+\.view$/.test(fileName);
}

export function validateSemanticMigrationFiles(files: SemanticMigrationFile[], mainFiles?: Record<string, string>) {
  const issues: string[] = [];
  const seen = new Set<string>();
  files.forEach((file) => {
    if (seen.has(file.fileName)) issues.push(`${file.fileName} appears more than once. Keep exactly one complete replacement body per target file.`);
    seen.add(file.fileName);
    if (!file.yaml.trim()) issues.push(`${file.fileName} has an empty YAML body.`);
    issues.push(...lintFile(file));
    if (mainFiles) issues.push(...lintTargetPath(file.fileName, mainFiles));
    if (mainFiles?.[file.fileName] && dropsTopLevelBlocks(file.yaml, mainFiles[file.fileName])) {
      issues.push(`${file.fileName} may drop existing top-level blocks from the source YAML. Preserve existing sections unless the migration plan explicitly replaces the whole file.`);
    }
  });
  if (files.length === 0) issues.push('No deployable Omni semantic YAML blocks were captured from Blobby.');
  return issues;
}

export function semanticMigrationDecisionCoverageIssues(
  files: SemanticMigrationFile[],
  decisions: MigrationDecision[],
): string[] {
  const generatedFiles = new Set(files.map((file) => file.fileName));
  const writeDecisions = decisions.filter((decision) => decision.approvedByUser && ['create_new', 'rewrite'].includes(decision.action));
  const approvedDecisionIds = new Set(writeDecisions.map((decision) => decision.id));
  const missingTarget = writeDecisions.filter((decision) => !decision.targetFileName);
  const missingFiles = Array.from(new Map(writeDecisions.flatMap((decision) => (
    decision.targetFileName && !generatedFiles.has(decision.targetFileName)
      ? [[decision.targetFileName, decision] as const]
      : []
  ))).values());
  const attributionIssues = files.flatMap((file) => {
    const expectedPaths = semanticMigrationDefinitionPaths(file.fileName, file.yaml);
    const definitions = file.definitions || [];
    const attributedPaths = definitions.map((definition) => definition.path);
    const issues = expectedPaths
      .filter((path) => !attributedPaths.includes(path))
      .map((path) => `${file.fileName} definition "${path}" is not tied to reviewed intent and evidence.`);
    attributedPaths
      .filter((path) => !expectedPaths.includes(path))
      .forEach((path) => issues.push(`${file.fileName} carries stale attribution for definition "${path}". Regenerate or repair the package before writing.`));
    definitions.forEach((definition) => {
      definition.decisionIds.forEach((decisionId) => {
        if (!approvedDecisionIds.has(decisionId)) {
          issues.push(`${file.fileName} definition "${definition.path}" references decision "${decisionId}" without approved write intent.`);
        }
      });
      if (definition.decisionIds.length === 0 && definition.placementIds.length === 0) {
        issues.push(`${file.fileName} definition "${definition.path}" is not tied to an approved decision or placement.`);
      }
      if (definition.evidenceIds.length === 0) {
        issues.push(`${file.fileName} definition "${definition.path}" has no source evidence attribution.`);
      }
    });
    return issues;
  });
  return [
    ...missingTarget.map((decision) => `${decision.sourceLabel} has approved write intent but no target semantic file.`),
    ...missingFiles.map((decision) => `${decision.targetFileName} is required by the approved ${decision.sourceLabel} decision but is missing from the generated package.`),
    ...attributionIssues,
  ];
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function arrayIdentity(value: unknown): string {
  const row = recordValue(value);
  if (!row) return JSON.stringify(value);
  const direct = ['id', 'name', 'view_name', 'topic_name', 'field', 'label'].map((key) => row[key]).find((candidate) => typeof candidate === 'string' && candidate.trim());
  if (typeof direct === 'string') return direct;
  const pair = ['from', 'to', 'source', 'target', 'join_from_view', 'join_to_view'].flatMap((key) => typeof row[key] === 'string' ? [`${key}:${row[key]}`] : []);
  return pair.length > 0 ? pair.join('|') : JSON.stringify(value);
}

function mergeYamlValues(current: unknown, patch: unknown): unknown {
  const currentRecord = recordValue(current);
  const patchRecord = recordValue(patch);
  if (currentRecord && patchRecord) {
    const merged: Record<string, unknown> = { ...currentRecord };
    Object.entries(patchRecord).forEach(([key, value]) => {
      merged[key] = key in currentRecord ? mergeYamlValues(currentRecord[key], value) : value;
    });
    return merged;
  }
  if (Array.isArray(current) && Array.isArray(patch)) {
    const result = [...current];
    const indexByIdentity = new Map(result.map((value, index) => [arrayIdentity(value), index]));
    patch.forEach((value) => {
      const identity = arrayIdentity(value);
      const index = indexByIdentity.get(identity);
      if (index === undefined) {
        indexByIdentity.set(identity, result.length);
        result.push(value);
      } else {
        result[index] = mergeYamlValues(result[index], value);
      }
    });
    return result;
  }
  return patch;
}

export interface SemanticMergeOptions {
  allowDefinitionOverwrite?: (fileName: SemanticYamlFileName, section: 'dimensions' | 'measures', definitionName: string) => boolean;
  allowPathOverwrite?: (fileName: SemanticYamlFileName, path: string) => boolean;
}

export interface SemanticMigrationBranchSnapshot {
  files?: Record<string, string>;
  checksums?: Record<string, string>;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

export function semanticMigrationBranchBaselineIssues(
  files: SemanticMigrationFile[],
  snapshot: SemanticMigrationBranchSnapshot,
): string[] {
  if (!snapshot.files || !snapshot.checksums) {
    return ['The dev branch did not return both YAML files and checksums. Reload the branch before writing.'];
  }
  return files.flatMap((file) => {
    const exists = hasOwn(snapshot.files!, file.fileName);
    const checksum = snapshot.checksums![file.fileName];
    if (exists && !checksum) {
      return [`${file.fileName} exists on the dev branch but has no branch checksum. OmniKit will not substitute a checksum from main.`];
    }
    if (!exists && checksum) {
      return [`${file.fileName} returned a checksum without a branch file body. Reload the branch before writing.`];
    }
    return [];
  });
}

export function semanticMigrationAppliedFileIssues(
  file: SemanticMigrationFile,
  snapshot: SemanticMigrationBranchSnapshot,
): string[] {
  if (!snapshot.files || !snapshot.checksums) {
    return [`${file.fileName} could not be verified because Omni did not return both branch YAML and checksums.`];
  }
  const actual = snapshot.files[file.fileName];
  if (actual === undefined) return [`${file.fileName} was not present when the dev branch was reread.`];
  const issues = actual === file.yaml
    ? []
    : [`${file.fileName} did not match the reviewed YAML when the dev branch was reread.`];
  if (!snapshot.checksums[file.fileName]) issues.push(`${file.fileName} did not return a checksum after the write.`);
  return issues;
}

export function semanticMigrationBranchResumeIssues(
  files: SemanticMigrationFile[],
  snapshot: SemanticMigrationBranchSnapshot,
): string[] {
  if (!snapshot.files || !snapshot.checksums) {
    return ['The partial dev-branch write cannot be resumed because YAML files or checksums are missing.'];
  }
  return files.flatMap((file) => {
    const actual = snapshot.files![file.fileName];
    if (actual === file.yaml) return [];
    if (actual === undefined && file.baseDigest === null) return [];
    if (actual !== undefined && file.baseDigest && sha256Text(actual) === file.baseDigest) return [];
    return [`${file.fileName} is neither the reviewed output nor its reviewed baseline. Reconcile or discard the partial branch before retrying.`];
  });
}

export function semanticMigrationBranchUnchangedIssues(
  before: SemanticMigrationBranchSnapshot,
  after: SemanticMigrationBranchSnapshot,
): string[] {
  if (!before.files || !before.checksums || !after.files || !after.checksums) {
    return ['The semantic branch could not be compared because YAML files or checksums were missing.'];
  }
  const fileNames = Array.from(new Set([...Object.keys(before.files), ...Object.keys(after.files)])).sort();
  return fileNames.flatMap((fileName) => {
    if (before.files![fileName] !== after.files![fileName]) return [`${fileName} changed during dashboard construction.`];
    if (before.checksums![fileName] !== after.checksums![fileName]) return [`${fileName} checksum changed during dashboard construction.`];
    return [];
  });
}

function hasConflictingLeaf(current: unknown, patch: unknown): boolean {
  const currentRecord = recordValue(current);
  const patchRecord = recordValue(patch);
  if (currentRecord && patchRecord) {
    return Object.entries(patchRecord).some(([key, value]) => key in currentRecord && hasConflictingLeaf(currentRecord[key], value));
  }
  if (Array.isArray(current) && Array.isArray(patch)) return JSON.stringify(current) !== JSON.stringify(patch);
  return current !== patch;
}

function assertApprovedOverwrites(
  fileName: SemanticYamlFileName,
  current: unknown,
  patch: unknown,
  options?: SemanticMergeOptions,
) {
  const inspect = (currentValue: unknown, patchValue: unknown, path: string): void => {
    const currentRecord = recordValue(currentValue);
    const patchRecord = recordValue(patchValue);
    if (currentRecord && patchRecord) {
      Object.entries(patchRecord).forEach(([key, value]) => {
        if (key in currentRecord) inspect(currentRecord[key], value, path ? `${path}.${key}` : key);
      });
      return;
    }
    if (Array.isArray(currentValue) && Array.isArray(patchValue)) {
      const currentByIdentity = new Map(currentValue.map((value) => [arrayIdentity(value), value]));
      patchValue.forEach((value) => {
        const identity = arrayIdentity(value);
        if (currentByIdentity.has(identity)) inspect(currentByIdentity.get(identity), value, path ? `${path}.${identity}` : identity);
      });
      return;
    }
    if (!hasConflictingLeaf(currentValue, patchValue)) return;
    const [section, definitionName] = path.split('.');
    if (fileName.endsWith('.view')
      && (section === 'dimensions' || section === 'measures')
      && definitionName
      && options?.allowDefinitionOverwrite?.(fileName, section, definitionName)) return;
    if (options?.allowPathOverwrite?.(fileName, path)) return;
    if (fileName.endsWith('.view') && (section === 'dimensions' || section === 'measures') && definitionName) {
      throw new Error(`${fileName} would change existing ${section.slice(0, -1)} "${definitionName}". Map to it, create a distinct additive name, or approve an explicit rewrite decision before generating YAML.`);
    }
    throw new Error(`${fileName} would change existing YAML at "${path || '$'}". Preserve the target value, add a distinct definition, or approve an explicit rewrite for that object before generating YAML.`);
  };
  inspect(current, patch, '');
}

export function mergeGeneratedSemanticFiles(files: SemanticMigrationFile[], currentFiles: Record<string, string>, options?: SemanticMergeOptions): SemanticMigrationFile[] {
  return files.map((file) => {
    const currentYaml = currentFiles[file.fileName];
    if (!currentYaml?.trim()) return { ...file, yaml: stringify(parse(file.yaml), { lineWidth: 0 }).trimEnd() };
    try {
      const current = parse(currentYaml);
      const patch = parse(file.yaml);
      assertApprovedOverwrites(file.fileName, current, patch, options);
      const merged = mergeYamlValues(current, patch);
      return { ...file, yaml: stringify(merged, { lineWidth: 0 }).trimEnd() };
    } catch (error) {
      throw new Error(`${file.fileName} could not be merged safely: ${error instanceof Error ? error.message : 'invalid YAML'}`);
    }
  });
}

function lintTargetPath(fileName: string, mainFiles: Record<string, string>) {
  if (mainFiles[fileName] || fileName === 'model' || fileName === 'relationships' || fileName.includes('/')) return [];
  if (!fileName.endsWith('.view') && !fileName.endsWith('.topic')) return [];

  const matchingExistingPaths = Object.keys(mainFiles).filter((sourceFileName) => sourceFileName.endsWith(`/${fileName}`));
  if (matchingExistingPaths.length === 0) return [];

  return [
    `${fileName} does not match an existing source file path. The model already contains ${matchingExistingPaths.join(', ')}; use the existing path or confirm this is an intentional new file before saving to dev.`,
  ];
}

function lintFile(file: SemanticMigrationFile) {
  const issues: string[] = [];
  const yaml = file.yaml;
  const fileName = file.fileName;
  if (!isSemanticYamlFileName(fileName)) {
    issues.push(`${fileName} is not a supported Omni semantic file name.`);
  }
  if (/\b(api[_-]?key|authorization|token|secret|password)\b/i.test(yaml)) {
    issues.push(`${fileName} appears to include credential-like text. Remove secrets before saving to dev.`);
  }
  const unsafeDescriptions = unquotedDescriptionLinesWithColon(yaml);
  if (unsafeDescriptions.length > 0) {
    issues.push(`${fileName} has unquoted description text containing ": " on line${unsafeDescriptions.length === 1 ? '' : 's'} ${unsafeDescriptions.join(', ')}. Quote the value or use a YAML block scalar so Omni receives description as a string.`);
  }
  if (fileName === 'model') {
    if (/^(\s*)(base_view|joins|dimensions|measures|ai_context|sample_queries|query|sql):/m.test(yaml)) {
      issues.push('model contains topic/view/query-only keys. Keep model-wide settings in the model file only.');
    }
  } else if (fileName === 'relationships') {
    if (/^\s*relationships\s*:/m.test(yaml)) {
      issues.push('relationships must be a top-level YAML list, not wrapped in a relationships: key.');
    }
    if (yaml.trim() && !yaml.trimStart().startsWith('-')) {
      issues.push('relationships should start with a YAML list item.');
    }
  } else if (fileName.endsWith('.topic')) {
    if (/^\s*(topics|name|dimensions|measures|sql|query)\s*:/m.test(yaml)) {
      issues.push(`${fileName} contains keys that do not belong in an Omni topic file.`);
    }
    if (/^default_filters\s*:\s*\n\s*-/m.test(yaml)) {
      issues.push(`${fileName} uses list-style default_filters, but Omni topic default_filters must be a field-keyed map. Preserve an existing known-good filter map or keep the filter guidance in ai_context/assumptions.`);
    }
    const sensitiveTopicFields = topicFieldSelectors(yaml).filter(isSensitiveSelector);
    if (sensitiveTopicFields.length > 0) {
      issues.push(`${fileName} includes sensitive fields in topic field curation (${sensitiveTopicFields.join(', ')}). Keep PII/contact/granular location fields out of fields/ai_fields unless explicit governed exposure is confirmed.`);
    }
    const aiContextIndex = yaml.search(/^ai_context\s*:/m);
    if (aiContextIndex >= 0) {
      const afterAiContext = yaml.slice(aiContextIndex).split(/\r?\n/).slice(1);
      const laterTopLevelKey = afterAiContext.find((line) => /^[A-Za-z0-9_-]+\s*:/.test(line));
      if (laterTopLevelKey) issues.push(`${fileName} has top-level YAML after ai_context. Put ai_context last.`);
    }
  } else if (fileName.endsWith('.view')) {
    if (/^(base_view|ai_fields|sample_queries|joins|topics)\s*:/m.test(yaml)) {
      issues.push(`${fileName} contains topic-only keys. Keep topics separate from view files.`);
    }
  }
  return issues;
}

function unquotedDescriptionLinesWithColon(yaml: string) {
  const lineNumbers: number[] = [];
  yaml.split(/\r?\n/).forEach((line, index) => {
    const match = /^(\s*)description:\s+(.+)$/.exec(line);
    if (!match) return;
    const value = match[2].trim();
    if (!value || value === '|' || value === '|-' || value === '>' || value === '>-' || value.startsWith('"') || value.startsWith("'")) return;
    if (value.includes(': ')) lineNumbers.push(index + 1);
  });
  return lineNumbers;
}

function topicFieldSelectors(yaml: string) {
  const selectors: string[] = [];
  let inFieldBlock = false;
  yaml.split(/\r?\n/).forEach((line) => {
    if (/^(fields|ai_fields)\s*:/.test(line)) {
      inFieldBlock = true;
      return;
    }
    if (inFieldBlock && /^[A-Za-z0-9_-]+\s*:/.test(line)) {
      inFieldBlock = false;
    }
    if (!inFieldBlock) return;
    const match = /^\s*-\s*["']?([^"',\]\s]+)["']?/.exec(line);
    if (match) selectors.push(match[1]);
  });
  return selectors;
}

function isSensitiveSelector(selector: string) {
  const field = selector.split('.').pop() || selector;
  return /(^|_)(email|full_?name|first_?name|last_?name|phone|address|zip|postal|latitude|longitude|lat|lon|birth|dob|ip)(_|$)/i.test(field);
}

function topLevelKeys(yaml: string) {
  return Array.from(yaml.matchAll(/^([A-Za-z0-9_-]+)\s*:/gm)).map((match) => match[1]);
}

function dropsTopLevelBlocks(nextYaml: string, sourceYaml: string) {
  const sourceKeys = topLevelKeys(sourceYaml).filter((key) => key !== 'access_grants');
  if (sourceKeys.length === 0) return false;
  const nextKeys = new Set(topLevelKeys(nextYaml));
  const dropped = sourceKeys.filter((key) => !nextKeys.has(key));
  return dropped.length > 0 && dropped.length >= Math.max(2, Math.ceil(sourceKeys.length / 2));
}

export function buildMigrationDiffs(mainFiles: Record<string, string> | undefined, branchFiles: Record<string, string> | undefined, savedFiles: SemanticMigrationFile[]): MigrationFileDiff[] {
  return savedFiles.map((file) => {
    const before = mainFiles?.[file.fileName] || '';
    const after = branchFiles?.[file.fileName] || file.yaml;
    return {
      fileName: file.fileName,
      lines: simpleLineDiff(before, after),
    };
  });
}

function simpleLineDiff(before: string, after: string): MigrationDiffLine[] {
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  const max = Math.max(beforeLines.length, afterLines.length);
  const lines: MigrationDiffLine[] = [];
  for (let index = 0; index < max; index += 1) {
    const prev = beforeLines[index];
    const next = afterLines[index];
    if (prev === next) {
      if (next !== undefined) lines.push({ type: 'unchanged', text: next });
      continue;
    }
    if (prev !== undefined) lines.push({ type: 'removed', text: prev });
    if (next !== undefined) lines.push({ type: 'added', text: next });
  }
  return lines;
}

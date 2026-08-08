import { isMap, isNode, isSeq, parseDocument, stringify } from 'yaml';
import {
  isSafeSemanticSolutionFileName,
  semanticArtifactKindForFileName,
  type SemanticArtifactAction,
  type SemanticArtifactKind,
  type SemanticPermissionIntent,
  type SemanticSolutionDependencyItem,
  type SemanticSolutionPlan,
} from './semanticSolutionPlanner';

const MAX_PLAN_ITEMS = 64;
const MAX_GENERATED_FILES = 64;
const MAX_YAML_CHARS = 2_000_000;

function collectAuthoredYamlComments(yaml: string, label: string): readonly string[] {
  const document = parseDocument(yaml, {
    prettyErrors: false,
    strict: false,
    uniqueKeys: false,
  });
  if (document.errors.length > 0) {
    throw new Error(`${label} YAML could not be parsed for authored-comment preservation: ${document.errors.map((error) => error.message).join(' ')}`);
  }

  const comments: string[] = [];
  const addComments = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    const commentBefore = 'commentBefore' in value ? (value as { commentBefore?: unknown }).commentBefore : undefined;
    const comment = 'comment' in value ? (value as { comment?: unknown }).comment : undefined;
    for (const candidate of [commentBefore, comment]) {
      if (typeof candidate !== 'string') continue;
      comments.push(...candidate.split('\n').map((line) => line.trim()).filter(Boolean));
    }
  };
  const walk = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    addComments(value);
    if (isMap(value)) {
      for (const pair of value.items) {
        walk(pair.key);
        walk(pair.value);
      }
    } else if (isSeq(value)) {
      for (const item of value.items) walk(item);
    } else if (!isNode(value)) {
      Object.values(value as Record<string, unknown>).forEach(walk);
    }
  };

  addComments(document);
  walk(document.contents);
  return comments;
}

function missingAuthoredComments(sourceComments: readonly string[], candidateComments: readonly string[]): readonly string[] {
  const available = new Map<string, number>();
  candidateComments.forEach((comment) => available.set(comment, (available.get(comment) || 0) + 1));
  return sourceComments.filter((comment) => {
    const count = available.get(comment) || 0;
    if (count < 1) return true;
    available.set(comment, count - 1);
    return false;
  });
}

function stableRelationshipValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableRelationshipValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableRelationshipValue(child)]),
  );
}

function relationshipRowFingerprint(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return JSON.stringify(stableRelationshipValue(value));
  }
  const record = value as Record<string, unknown>;
  return JSON.stringify(stableRelationshipValue(
    record.reversible === undefined ? { ...record, reversible: false } : record,
  ));
}

/**
 * A relationships write replaces the whole file, so preserve the authored
 * baseline verbatim and append only rows Blobby actually proposed.
 */
export function mergeAuthoredRelationshipsBaseline(sourceYaml: string, candidateYaml: string): string {
  if (!sourceYaml.trim() || !candidateYaml.trim()) return candidateYaml;
  try {
    const sourceDocument = parseDocument(sourceYaml, { prettyErrors: false, strict: false, uniqueKeys: true });
    const candidateDocument = parseDocument(candidateYaml, { prettyErrors: false, strict: false, uniqueKeys: true });
    if (sourceDocument.errors.length > 0 || candidateDocument.errors.length > 0) return candidateYaml;
    const sourceRows = sourceDocument.toJS({ maxAliasCount: 20 });
    const candidateRows = candidateDocument.toJS({ maxAliasCount: 20 });
    if (!Array.isArray(sourceRows) || !Array.isArray(candidateRows)) return candidateYaml;

    const remainingSourceRows = new Map<string, number>();
    sourceRows.forEach((row) => {
      const fingerprint = relationshipRowFingerprint(row);
      remainingSourceRows.set(fingerprint, (remainingSourceRows.get(fingerprint) || 0) + 1);
    });
    const proposedRows = candidateRows.filter((row) => {
      const fingerprint = relationshipRowFingerprint(row);
      const remaining = remainingSourceRows.get(fingerprint) || 0;
      if (remaining === 0) return true;
      remainingSourceRows.set(fingerprint, remaining - 1);
      return false;
    });
    if (proposedRows.length === 0) return sourceYaml;
    const proposedYaml = stringify(proposedRows).trimEnd();
    if (sourceRows.length === 0) return `${proposedYaml}\n`;
    return `${sourceYaml.trimEnd()}\n${proposedYaml}\n`;
  } catch {
    return candidateYaml;
  }
}

/**
 * Limits downstream AI context to reusable relationships whose endpoints are
 * inside the user's approved semantic blueprint.
 */
export function scopedRelationshipsForPrompt(
  relationshipsYaml: string,
  approvedViewNames: readonly string[],
): string {
  const approved = new Set(
    approvedViewNames.map((viewName) => viewName.trim().toLowerCase()).filter(Boolean),
  );
  if (!relationshipsYaml.trim() || approved.size === 0) return '';
  try {
    const document = parseDocument(relationshipsYaml, {
      prettyErrors: false,
      strict: false,
      uniqueKeys: true,
    });
    if (document.errors.length > 0) return '';
    const rows = document.toJS({ maxAliasCount: 20 });
    if (!Array.isArray(rows)) return '';
    const scopedRows = rows.filter((candidate) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
      const row = candidate as Record<string, unknown>;
      const from = typeof row.join_from_view === 'string' ? row.join_from_view.trim().toLowerCase() : '';
      const to = typeof row.join_to_view === 'string' ? row.join_to_view.trim().toLowerCase() : '';
      return approved.has(from) && approved.has(to);
    });
    return scopedRows.length > 0 ? stringify(scopedRows).trimEnd() : '';
  } catch {
    return '';
  }
}

/**
 * Complete-file AI generations must retain source-authored comments. Comments
 * often carry grain, governance, and operational guidance that structural YAML
 * comparison cannot see, so omission is a blocking preservation failure.
 */
export function authoredSemanticYamlCommentIssues(
  fileName: string,
  sourceYaml: string,
  candidateYaml: string,
): readonly string[] {
  if (!sourceYaml.trim() || !candidateYaml.trim()) return Object.freeze([]);
  try {
    const missing = missingAuthoredComments(
      collectAuthoredYamlComments(sourceYaml, 'Source'),
      collectAuthoredYamlComments(candidateYaml, 'Candidate'),
    );
    if (missing.length === 0) return Object.freeze([]);
    const examples = missing.slice(0, 3).map((comment) => `"${comment}"`).join(', ');
    return Object.freeze([
      `${fileName} omits ${missing.length} source-authored YAML comment${missing.length === 1 ? '' : 's'}. Preserve authored comments verbatim in the complete replacement file. Missing example${missing.length === 1 ? '' : 's'}: ${examples}.`,
    ]);
  } catch (error) {
    return Object.freeze([
      `${fileName} authored-comment preservation could not be verified: ${error instanceof Error ? error.message : 'unknown YAML parsing error'}.`,
    ]);
  }
}

const KIND_ORDER: Readonly<Record<SemanticArtifactKind, number>> = Object.freeze({
  model: 0,
  view: 1,
  query_view: 2,
  relationships: 3,
  topic: 4,
  permissions: 5,
});

type GenerationAction = Extract<SemanticArtifactAction, 'create' | 'edit'>;

export interface SemanticSolutionGenerationStep {
  readonly id: string;
  readonly fileName: string;
  readonly kind: Exclude<SemanticArtifactKind, 'permissions'>;
  readonly action: GenerationAction;
  readonly dependencies: readonly string[];
}

export interface SemanticSolutionGeneratedFile {
  readonly fileName: string;
  readonly yaml: string;
}

export interface SemanticSolutionAcceptedGeneratedFile extends SemanticSolutionGeneratedFile {
  readonly acceptedFingerprint: string;
}

export interface SemanticSolutionOrchestrationOptions {
  readonly permissionIntent?: SemanticPermissionIntent;
}

export interface SemanticSolutionOrchestration {
  readonly generationSteps: readonly SemanticSolutionGenerationStep[];
  readonly approvedWriteTargetFileNames: readonly string[];
}

export class SemanticSolutionOrchestrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SemanticSolutionOrchestrationError';
  }
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function normalizedFileName(fileName: string): string {
  return fileName.trim().replace(/\\/g, '/');
}

function fileNameKey(fileName: string): string {
  return normalizedFileName(fileName).toLowerCase();
}

function compareItems(
  left: SemanticSolutionDependencyItem,
  right: SemanticSolutionDependencyItem,
): number {
  return KIND_ORDER[left.kind] - KIND_ORDER[right.kind]
    || compareText(fileNameKey(left.fileName), fileNameKey(right.fileName))
    || compareText(left.id, right.id);
}

function fail(message: string): never {
  throw new SemanticSolutionOrchestrationError(message);
}

function assertPlanShape(plan: SemanticSolutionPlan): void {
  if (plan.blocked || plan.blockers.length > 0) {
    fail(`The semantic solution plan is blocked: ${plan.blockers.join(' ') || 'No blocker detail was provided.'}`);
  }
  if (plan.items.length > MAX_PLAN_ITEMS) {
    fail(`The semantic solution plan exceeds the ${MAX_PLAN_ITEMS}-artifact orchestration limit.`);
  }

  const ids = new Set<string>();
  const fileNames = new Set<string>();
  let topicCount = 0;

  plan.items.forEach((item) => {
    if (ids.has(item.id)) fail(`The semantic solution plan contains duplicate item ID "${item.id}".`);
    ids.add(item.id);

    const fileKey = fileNameKey(item.fileName);
    if (fileNames.has(fileKey)) {
      fail(`The semantic solution plan contains duplicate filename "${item.fileName}".`);
    }
    fileNames.add(fileKey);

    if (item.kind === 'topic') topicCount += 1;
    if (item.kind !== 'permissions' && !isSafeSemanticSolutionFileName(item.fileName)) {
      fail(`The semantic solution plan contains unsafe filename "${item.fileName}".`);
    }
    if (item.readiness === 'blocked') {
      fail(`The semantic solution plan contains blocked artifact "${item.fileName}".`);
    }
  });

  if (topicCount > 1) fail('A semantic solution plan may contain only one .topic artifact.');

  plan.items.forEach((item) => {
    item.dependencies.forEach((dependencyId) => {
      if (!ids.has(dependencyId)) {
        fail(`Dependency "${dependencyId}" for "${item.fileName}" is not present in the semantic solution plan.`);
      }
    });
  });
}

function topologicallyOrderedItems(
  plan: SemanticSolutionPlan,
): readonly SemanticSolutionDependencyItem[] {
  assertPlanShape(plan);

  const byId = new Map(plan.items.map((item) => [item.id, item]));
  const indegree = new Map(plan.items.map((item) => [item.id, item.dependencies.length]));
  const dependents = new Map<string, SemanticSolutionDependencyItem[]>();

  plan.items.forEach((item) => {
    item.dependencies.forEach((dependencyId) => {
      const current = dependents.get(dependencyId) || [];
      current.push(item);
      dependents.set(dependencyId, current);
    });
  });

  const ready = plan.items.filter((item) => indegree.get(item.id) === 0).sort(compareItems);
  const ordered: SemanticSolutionDependencyItem[] = [];

  while (ready.length > 0) {
    const item = ready.shift();
    if (!item) break;
    ordered.push(item);

    (dependents.get(item.id) || []).sort(compareItems).forEach((dependent) => {
      const nextDegree = (indegree.get(dependent.id) || 0) - 1;
      indegree.set(dependent.id, nextDegree);
      if (nextDegree === 0) {
        ready.push(dependent);
        ready.sort(compareItems);
      }
    });
  }

  if (ordered.length !== byId.size) {
    fail('The semantic solution plan contains a dependency cycle.');
  }
  return ordered;
}

function isGenerationAction(action: SemanticArtifactAction): action is GenerationAction {
  return action === 'create' || action === 'edit';
}

function permissionIntentRequired(
  plan: SemanticSolutionPlan,
  options: SemanticSolutionOrchestrationOptions,
): boolean {
  const logicalPermission = plan.items.find((item) => item.kind === 'permissions');
  return options.permissionIntent === 'required'
    || Boolean(logicalPermission?.required && logicalPermission.action === 'edit');
}

export function buildSemanticSolutionGenerationSteps(
  plan: SemanticSolutionPlan,
): readonly SemanticSolutionGenerationStep[] {
  const steps = topologicallyOrderedItems(plan)
    .filter((item) => item.kind !== 'permissions' && isGenerationAction(item.action))
    .map((item) => Object.freeze({
      id: item.id,
      fileName: item.fileName,
      kind: item.kind as Exclude<SemanticArtifactKind, 'permissions'>,
      action: item.action as GenerationAction,
      dependencies: Object.freeze([...item.dependencies]),
    }));

  return Object.freeze(steps);
}

export function approvedSemanticSolutionWriteTargets(
  plan: SemanticSolutionPlan,
  options: SemanticSolutionOrchestrationOptions = {},
): readonly string[] {
  const orderedItems = topologicallyOrderedItems(plan);
  const approved = new Set(
    orderedItems
      .filter((item) => item.kind !== 'permissions' && isGenerationAction(item.action))
      .map((item) => fileNameKey(item.fileName)),
  );

  if (permissionIntentRequired(plan, options)) approved.add(fileNameKey('model'));

  const targets = orderedItems
    .filter((item) => item.kind !== 'permissions' && approved.has(fileNameKey(item.fileName)))
    .map((item) => item.fileName);

  if (approved.has(fileNameKey('model')) && !targets.some((fileName) => fileNameKey(fileName) === 'model')) {
    fail('Permission intent requires an approved Settings/model target, but the plan does not contain one.');
  }

  return Object.freeze(targets);
}

function assertGeneratedFilesInScope<T extends SemanticSolutionGeneratedFile>(
  plan: SemanticSolutionPlan,
  files: readonly T[],
  options: SemanticSolutionOrchestrationOptions,
): void {
  if (files.length > MAX_GENERATED_FILES) {
    fail(`The generated package exceeds the ${MAX_GENERATED_FILES}-file orchestration limit.`);
  }

  const approvedTargets = new Set(
    approvedSemanticSolutionWriteTargets(plan, options).map(fileNameKey),
  );
  const seen = new Set<string>();
  let topicCount = 0;

  files.forEach((file) => {
    const fileName = normalizedFileName(file.fileName);
    const key = fileNameKey(fileName);
    if (seen.has(key)) fail(`The generated package contains duplicate filename "${fileName}".`);
    seen.add(key);

    if (!isSafeSemanticSolutionFileName(fileName) || !approvedTargets.has(key)) {
      fail(`Generated file "${fileName}" is outside the approved semantic solution write scope.`);
    }
    if (semanticArtifactKindForFileName(fileName) === 'topic') topicCount += 1;
    if (file.yaml.length > MAX_YAML_CHARS) {
      fail(`Generated file "${fileName}" exceeds the ${MAX_YAML_CHARS}-character YAML limit.`);
    }
  });

  if (topicCount > 1) fail('A generated semantic solution package may contain only one .topic file.');
}

export function orderSemanticSolutionDeployDrafts<T extends SemanticSolutionGeneratedFile>(
  plan: SemanticSolutionPlan,
  drafts: readonly T[],
  options: SemanticSolutionOrchestrationOptions = {},
): readonly T[] {
  assertGeneratedFilesInScope(plan, drafts, options);
  const topicDrafts = drafts.filter((draft) => (
    semanticArtifactKindForFileName(draft.fileName) === 'topic'
  ));
  if (topicDrafts.length !== 1) {
    fail('A deployable semantic solution package must contain exactly one .topic file.');
  }

  const targetOrder = new Map(
    approvedSemanticSolutionWriteTargets(plan, options)
      .map((fileName, index) => [fileNameKey(fileName), index]),
  );
  const ordered = [...drafts].sort((left, right) => {
    const leftTopic = semanticArtifactKindForFileName(left.fileName) === 'topic';
    const rightTopic = semanticArtifactKindForFileName(right.fileName) === 'topic';
    if (leftTopic !== rightTopic) return leftTopic ? 1 : -1;
    return (targetOrder.get(fileNameKey(left.fileName)) ?? Number.MAX_SAFE_INTEGER)
      - (targetOrder.get(fileNameKey(right.fileName)) ?? Number.MAX_SAFE_INTEGER)
      || compareText(fileNameKey(left.fileName), fileNameKey(right.fileName));
  });

  return Object.freeze(ordered);
}

export function semanticSolutionGeneratedFileFingerprint(
  file: SemanticSolutionGeneratedFile,
): string {
  const value = JSON.stringify([normalizedFileName(file.fileName), file.yaml]);
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, '0')}`;
}

export function resumableAcceptedSemanticSolutionFiles<T extends SemanticSolutionAcceptedGeneratedFile>(
  plan: SemanticSolutionPlan,
  files: readonly T[],
  options: SemanticSolutionOrchestrationOptions = {},
): readonly T[] {
  assertGeneratedFilesInScope(plan, files, options);
  const targetOrder = new Map(
    approvedSemanticSolutionWriteTargets(plan, options)
      .map((fileName, index) => [fileNameKey(fileName), index]),
  );
  const resumable = files
    .filter((file) => file.yaml.trim().length > 0)
    .filter((file) => (
      semanticSolutionGeneratedFileFingerprint(file) === file.acceptedFingerprint
    ))
    .sort((left, right) => (
      (targetOrder.get(fileNameKey(left.fileName)) ?? Number.MAX_SAFE_INTEGER)
      - (targetOrder.get(fileNameKey(right.fileName)) ?? Number.MAX_SAFE_INTEGER)
      || compareText(fileNameKey(left.fileName), fileNameKey(right.fileName))
    ));

  return Object.freeze(resumable);
}

export function buildSemanticSolutionOrchestration(
  plan: SemanticSolutionPlan,
  options: SemanticSolutionOrchestrationOptions = {},
): SemanticSolutionOrchestration {
  return Object.freeze({
    generationSteps: buildSemanticSolutionGenerationSteps(plan),
    approvedWriteTargetFileNames: approvedSemanticSolutionWriteTargets(plan, options),
  });
}

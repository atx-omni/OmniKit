import { isAlias, isScalar, parseDocument, visit } from 'yaml';

import type {
  MigrationSemanticPatchArtifact,
  MigrationSemanticPatchResolution,
  MigrationSemanticPatchSafetyCategory,
  MigrationSemanticPatchStatus,
} from './migrationJobs';

const ALLOWED_WRITE_CATEGORIES = new Set<MigrationSemanticPatchSafetyCategory>([
  'safe_create',
  'safe_update',
  'safe_map',
  'safe_ignore',
]);

const MAX_YAML_DEPTH = 100;
const MAX_YAML_NODES = 50_000;

export type DashboardSafeCopyPatchSafetyExceptionCode =
  | 'SAFE_COPY_PATCH_TARGET_PROTECTED'
  | 'SAFE_COPY_PATCH_PERMISSION_FORBIDDEN'
  | 'SAFE_COPY_PATCH_PERMISSION_CONTENT_FORBIDDEN'
  | 'SAFE_COPY_PATCH_DUPLICATE_ID'
  | 'SAFE_COPY_PATCH_CURRENT_FILE_AMBIGUOUS'
  | 'SAFE_COPY_PATCH_DUPLICATE_TARGET_FILE'
  | 'SAFE_COPY_PATCH_BLOCKED'
  | 'SAFE_COPY_PATCH_MANUAL_REVIEW'
  | 'SAFE_COPY_PATCH_DESTRUCTIVE'
  | 'SAFE_COPY_PATCH_STALE_CHECKSUM'
  | 'SAFE_COPY_PATCH_RESOLUTION_FORBIDDEN'
  | 'SAFE_COPY_PATCH_SAFETY_CATEGORY_FORBIDDEN'
  | 'SAFE_COPY_PATCH_ACCEPTED_YAML_MISSING'
  | 'SAFE_COPY_PATCH_ACCEPTED_YAML_INVALID'
  | 'SAFE_COPY_PATCH_ACCEPTED_YAML_INCOMPLETE'
  | 'SAFE_COPY_PATCH_CURRENT_YAML_INVALID'
  | 'SAFE_COPY_PATCH_CREATE_COLLISION'
  | 'SAFE_COPY_PATCH_UPDATE_TARGET_MISSING'
  | 'SAFE_COPY_PATCH_CURRENT_CHECKSUM_MISSING'
  | 'SAFE_COPY_PATCH_PREVIOUS_CHECKSUM_MISSING'
  | 'SAFE_COPY_PATCH_CHECKSUM_MISMATCH'
  | 'SAFE_COPY_PATCH_NON_MONOTONIC';

export type DashboardSafeCopyPatchOperation = 'keep_target' | 'create' | 'update';
export type DashboardSafeCopyPatchCheckStatus = 'verified' | 'failed' | 'not_applicable';

export interface DashboardSafeCopyPatchCandidate {
  id: string;
  artifactType: MigrationSemanticPatchArtifact;
  targetFileName: string;
  resolution: MigrationSemanticPatchResolution;
  acceptedYaml?: string;
  previousChecksum?: string;
  latestChecksum?: string;
  checksumStale?: boolean;
  destructive?: boolean;
  confirmedDestructive?: boolean;
  status?: MigrationSemanticPatchStatus;
  safetyCategory?: MigrationSemanticPatchSafetyCategory;
}

export interface DashboardSafeCopyCurrentYamlFile {
  yaml: string;
  checksum?: string;
  protected?: boolean;
}

export interface DashboardSafeCopyPatchSafetyInput {
  patches: readonly DashboardSafeCopyPatchCandidate[];
  currentFiles: Readonly<Record<string, DashboardSafeCopyCurrentYamlFile>>;
  protectedTarget?: boolean;
}

export interface DashboardSafeCopyPatchSafetyException {
  code: DashboardSafeCopyPatchSafetyExceptionCode;
  patchId: string;
  artifactType: MigrationSemanticPatchArtifact;
  targetFileName: string;
  message: string;
}

export interface DashboardSafeCopyPatchSafetyEvidence {
  patchId: string;
  artifactType: MigrationSemanticPatchArtifact;
  targetFileName: string;
  operation: DashboardSafeCopyPatchOperation;
  status: 'passed' | 'rejected';
  acceptedYaml: DashboardSafeCopyPatchCheckStatus;
  checksum: DashboardSafeCopyPatchCheckStatus;
  monotonicity: DashboardSafeCopyPatchCheckStatus;
  exceptionCodes: DashboardSafeCopyPatchSafetyExceptionCode[];
}

export interface DashboardSafeCopyPatchSafetyResult {
  status: 'passed' | 'rejected';
  evidence: DashboardSafeCopyPatchSafetyEvidence[];
  exceptions: DashboardSafeCopyPatchSafetyException[];
}

const EXCEPTION_MESSAGES: Record<DashboardSafeCopyPatchSafetyExceptionCode, string> = {
  SAFE_COPY_PATCH_TARGET_PROTECTED: 'The destination model or file is protected from automatic changes.',
  SAFE_COPY_PATCH_PERMISSION_FORBIDDEN: 'Permission YAML changes are not allowed in this safe-copy phase.',
  SAFE_COPY_PATCH_PERMISSION_CONTENT_FORBIDDEN: 'YAML containing semantic access or security settings cannot be changed automatically.',
  SAFE_COPY_PATCH_DUPLICATE_ID: 'Each automatic patch must have one unique identifier.',
  SAFE_COPY_PATCH_CURRENT_FILE_AMBIGUOUS: 'More than one destination file matches the same normalized file name.',
  SAFE_COPY_PATCH_DUPLICATE_TARGET_FILE: 'Multiple patch decisions target the same destination file.',
  SAFE_COPY_PATCH_BLOCKED: 'The patch is blocked and cannot be applied automatically.',
  SAFE_COPY_PATCH_MANUAL_REVIEW: 'The patch requires manual review and cannot be applied automatically.',
  SAFE_COPY_PATCH_DESTRUCTIVE: 'The patch is marked as destructive and cannot be applied automatically.',
  SAFE_COPY_PATCH_STALE_CHECKSUM: 'The patch was prepared from stale destination evidence.',
  SAFE_COPY_PATCH_RESOLUTION_FORBIDDEN: 'The patch resolution is not server-owned and automatic.',
  SAFE_COPY_PATCH_SAFETY_CATEGORY_FORBIDDEN: 'The patch safety category is not allowed for safe copy.',
  SAFE_COPY_PATCH_ACCEPTED_YAML_MISSING: 'A complete accepted YAML document is required for this write.',
  SAFE_COPY_PATCH_ACCEPTED_YAML_INVALID: 'The accepted YAML document could not be parsed safely.',
  SAFE_COPY_PATCH_ACCEPTED_YAML_INCOMPLETE: 'The accepted YAML must be a complete structured document.',
  SAFE_COPY_PATCH_CURRENT_YAML_INVALID: 'The current destination YAML could not be parsed safely.',
  SAFE_COPY_PATCH_CREATE_COLLISION: 'A create patch cannot overwrite an existing destination file.',
  SAFE_COPY_PATCH_UPDATE_TARGET_MISSING: 'An update patch requires an existing destination file.',
  SAFE_COPY_PATCH_CURRENT_CHECKSUM_MISSING: 'The existing destination file has no authoritative checksum.',
  SAFE_COPY_PATCH_PREVIOUS_CHECKSUM_MISSING: 'The patch has no previous checksum for the existing destination file.',
  SAFE_COPY_PATCH_CHECKSUM_MISMATCH: 'The patch checksum does not exactly match the current destination checksum.',
  SAFE_COPY_PATCH_NON_MONOTONIC: 'The accepted YAML removes, replaces, or reorders existing destination content.',
};

type StructuredYaml = Record<string, unknown> | unknown[];

const SECURITY_YAML_KEYS = new Set([
  'accessgrants',
  'defaulttopicrequiredaccessgrants',
  'defaulttopicaccessfilters',
  'requiredaccessgrants',
  'accessfilters',
  'maskunlessaccessgrants',
  'userattribute',
  'userattributes',
  'accessboost',
  'accessboostable',
]);

const SECURITY_SCALAR_PATTERN = /\bomni_attributes\.[A-Za-z_][\w-]*/;

type ParsedYamlResult =
  | { status: 'parsed'; value: StructuredYaml }
  | { status: 'missing' | 'invalid' | 'incomplete' };

function normalizedFileKey(fileName: string): string {
  return fileName.normalize('NFKC').trim().toLowerCase();
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSupportedScalar(value: unknown): boolean {
  return value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean';
}

function isBoundedYamlTree(
  value: unknown,
  depth = 0,
  state: { nodes: number; stack: Set<object> } = { nodes: 0, stack: new Set<object>() },
): boolean {
  state.nodes += 1;
  if (state.nodes > MAX_YAML_NODES || depth > MAX_YAML_DEPTH) return false;
  if (isSupportedScalar(value)) return true;
  if (!Array.isArray(value) && !isPlainRecord(value)) return false;
  if (state.stack.has(value)) return false;

  state.stack.add(value);
  const children = Array.isArray(value) ? value : Object.values(value);
  const supported = children.every((child) => isBoundedYamlTree(child, depth + 1, state));
  state.stack.delete(value);
  return supported;
}

function parseStructuredYaml(value: string | undefined): ParsedYamlResult {
  if (!value?.trim()) return { status: 'missing' };
  let parsed: unknown;
  try {
    const document = parseDocument(value, {
      prettyErrors: false,
      strict: true,
      uniqueKeys: true,
    });
    if (document.errors.length > 0 || document.warnings.length > 0) return { status: 'invalid' };
    let unsafeSyntax = false;
    visit(document, {
      Node(_key, node) {
        if (
          isAlias(node)
          || ('anchor' in node && typeof node.anchor === 'string' && Boolean(node.anchor))
          || (typeof node.tag === 'string' && !node.tag.startsWith('tag:yaml.org,2002:'))
        ) unsafeSyntax = true;
      },
      Pair(_key, pair) {
        if (isScalar(pair.key) && String(pair.key.value).trim() === '<<') unsafeSyntax = true;
      },
    });
    if (unsafeSyntax) return { status: 'invalid' };
    parsed = document.toJS({ maxAliasCount: 0 });
  } catch {
    return { status: 'invalid' };
  }
  if ((!Array.isArray(parsed) && !isPlainRecord(parsed)) || !isBoundedYamlTree(parsed)) {
    return { status: 'incomplete' };
  }
  return { status: 'parsed', value: parsed };
}

function containsSecurityYamlEvidence(value: unknown): boolean {
  if (typeof value === 'string') return SECURITY_SCALAR_PATTERN.test(value);
  if (Array.isArray(value)) return value.some(containsSecurityYamlEvidence);
  if (!isPlainRecord(value)) return false;
  return Object.entries(value).some(([key, child]) => (
    SECURITY_YAML_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]/g, ''))
    || containsSecurityYamlEvidence(child)
  ));
}

function preservesExistingValue(existing: unknown, accepted: unknown): boolean {
  if (isSupportedScalar(existing)) return isSupportedScalar(accepted) && Object.is(existing, accepted);

  if (Array.isArray(existing)) {
    if (!Array.isArray(accepted)) return false;
    let acceptedIndex = 0;
    for (const existingEntry of existing) {
      let matched = false;
      while (acceptedIndex < accepted.length) {
        const acceptedEntry = accepted[acceptedIndex];
        acceptedIndex += 1;
        if (preservesExistingValue(existingEntry, acceptedEntry)) {
          matched = true;
          break;
        }
      }
      if (!matched) return false;
    }
    return true;
  }

  if (!isPlainRecord(existing) || !isPlainRecord(accepted)) return false;
  for (const [key, existingValue] of Object.entries(existing)) {
    if (!Object.prototype.hasOwnProperty.call(accepted, key)) return false;
    if (!preservesExistingValue(existingValue, accepted[key])) return false;
  }
  return true;
}

function exceptionFor(
  patch: DashboardSafeCopyPatchCandidate,
  code: DashboardSafeCopyPatchSafetyExceptionCode,
): DashboardSafeCopyPatchSafetyException {
  return {
    code,
    patchId: patch.id,
    artifactType: patch.artifactType,
    targetFileName: patch.targetFileName,
    message: EXCEPTION_MESSAGES[code],
  };
}

function uniqueCodes(exceptions: DashboardSafeCopyPatchSafetyException[]): DashboardSafeCopyPatchSafetyExceptionCode[] {
  return [...new Set(exceptions.map((exception) => exception.code))];
}

/**
 * Proves that every proposed safe-copy YAML write is monotonic against the
 * authoritative destination snapshot. The returned evidence intentionally
 * contains no YAML or parser errors so it is safe to persist and publish.
 */
export function validateAdditiveDashboardSafeCopyPatches(
  input: DashboardSafeCopyPatchSafetyInput,
): DashboardSafeCopyPatchSafetyResult {
  const currentFileKeyCounts = new Map<string, number>();
  for (const fileName of Object.keys(input.currentFiles)) {
    const key = normalizedFileKey(fileName);
    currentFileKeyCounts.set(key, (currentFileKeyCounts.get(key) || 0) + 1);
  }
  const currentFiles = new Map(
    Object.entries(input.currentFiles).map(([fileName, file]) => [normalizedFileKey(fileName), file]),
  );
  const targetFileCounts = new Map<string, number>();
  const patchIdCounts = new Map<string, number>();
  for (const patch of input.patches) {
    const key = normalizedFileKey(patch.targetFileName);
    targetFileCounts.set(key, (targetFileCounts.get(key) || 0) + 1);
    patchIdCounts.set(patch.id, (patchIdCounts.get(patch.id) || 0) + 1);
  }

  const allExceptions: DashboardSafeCopyPatchSafetyException[] = [];
  const evidence = input.patches.map((patch): DashboardSafeCopyPatchSafetyEvidence => {
    const patchExceptions: DashboardSafeCopyPatchSafetyException[] = [];
    const currentFile = currentFiles.get(normalizedFileKey(patch.targetFileName));
    const operation: DashboardSafeCopyPatchOperation = patch.resolution === 'keep_target'
      ? 'keep_target'
      : currentFile
        ? 'update'
        : 'create';
    let acceptedYamlStatus: DashboardSafeCopyPatchCheckStatus = 'not_applicable';
    let checksumStatus: DashboardSafeCopyPatchCheckStatus = 'not_applicable';
    let monotonicityStatus: DashboardSafeCopyPatchCheckStatus = 'not_applicable';

    const add = (code: DashboardSafeCopyPatchSafetyExceptionCode): void => {
      patchExceptions.push(exceptionFor(patch, code));
    };

    if (input.protectedTarget === true || currentFile?.protected === true) add('SAFE_COPY_PATCH_TARGET_PROTECTED');
    if (patch.artifactType === 'permission') add('SAFE_COPY_PATCH_PERMISSION_FORBIDDEN');
    if ((patchIdCounts.get(patch.id) || 0) > 1) add('SAFE_COPY_PATCH_DUPLICATE_ID');
    if ((currentFileKeyCounts.get(normalizedFileKey(patch.targetFileName)) || 0) > 1) {
      add('SAFE_COPY_PATCH_CURRENT_FILE_AMBIGUOUS');
    }
    if ((targetFileCounts.get(normalizedFileKey(patch.targetFileName)) || 0) > 1) {
      add('SAFE_COPY_PATCH_DUPLICATE_TARGET_FILE');
    }
    if (patch.status === 'blocked' || patch.safetyCategory === 'blocked') add('SAFE_COPY_PATCH_BLOCKED');
    if (patch.resolution === 'custom_edit' || patch.safetyCategory === 'manual_review') {
      add('SAFE_COPY_PATCH_MANUAL_REVIEW');
    }
    if (
      patch.destructive === true
      || patch.confirmedDestructive === true
      || patch.safetyCategory === 'destructive_update'
    ) {
      add('SAFE_COPY_PATCH_DESTRUCTIVE');
    }
    if (
      patch.checksumStale === true
      || Boolean(currentFile?.checksum && patch.latestChecksum && currentFile.checksum !== patch.latestChecksum)
    ) {
      add('SAFE_COPY_PATCH_STALE_CHECKSUM');
    }
    if (patch.resolution !== 'recommended' && patch.resolution !== 'keep_target') {
      add('SAFE_COPY_PATCH_RESOLUTION_FORBIDDEN');
    }
    if (!patch.safetyCategory || !ALLOWED_WRITE_CATEGORIES.has(patch.safetyCategory)) {
      add('SAFE_COPY_PATCH_SAFETY_CATEGORY_FORBIDDEN');
    }

    if (patch.resolution !== 'keep_target') {
      const accepted = parseStructuredYaml(patch.acceptedYaml);
      if (accepted.status === 'missing') {
        acceptedYamlStatus = 'failed';
        add('SAFE_COPY_PATCH_ACCEPTED_YAML_MISSING');
      } else if (accepted.status === 'invalid') {
        acceptedYamlStatus = 'failed';
        add('SAFE_COPY_PATCH_ACCEPTED_YAML_INVALID');
      } else if (accepted.status === 'incomplete') {
        acceptedYamlStatus = 'failed';
        add('SAFE_COPY_PATCH_ACCEPTED_YAML_INCOMPLETE');
      } else if (accepted.status === 'parsed') {
        acceptedYamlStatus = 'verified';
        if (containsSecurityYamlEvidence(accepted.value)) add('SAFE_COPY_PATCH_PERMISSION_CONTENT_FORBIDDEN');
      }

      if (currentFile) {
        if (patch.safetyCategory === 'safe_create') add('SAFE_COPY_PATCH_CREATE_COLLISION');
        if (!currentFile.checksum?.trim()) {
          checksumStatus = 'failed';
          add('SAFE_COPY_PATCH_CURRENT_CHECKSUM_MISSING');
        } else if (!patch.previousChecksum?.trim()) {
          checksumStatus = 'failed';
          add('SAFE_COPY_PATCH_PREVIOUS_CHECKSUM_MISSING');
        } else if (patch.previousChecksum !== currentFile.checksum) {
          checksumStatus = 'failed';
          add('SAFE_COPY_PATCH_CHECKSUM_MISMATCH');
        } else {
          checksumStatus = 'verified';
        }

        const current = parseStructuredYaml(currentFile.yaml);
        if (current.status !== 'parsed') {
          monotonicityStatus = 'failed';
          add('SAFE_COPY_PATCH_CURRENT_YAML_INVALID');
        } else if (containsSecurityYamlEvidence(current.value)) {
          monotonicityStatus = 'failed';
          add('SAFE_COPY_PATCH_PERMISSION_CONTENT_FORBIDDEN');
        } else if (accepted.status === 'parsed') {
          if (preservesExistingValue(current.value, accepted.value)) {
            monotonicityStatus = 'verified';
          } else {
            monotonicityStatus = 'failed';
            add('SAFE_COPY_PATCH_NON_MONOTONIC');
          }
        } else {
          monotonicityStatus = 'failed';
        }
      } else {
        if (patch.safetyCategory !== 'safe_create') add('SAFE_COPY_PATCH_UPDATE_TARGET_MISSING');
        monotonicityStatus = accepted.status === 'parsed' ? 'verified' : 'failed';
      }
    }

    const deduplicated = [...new Map(patchExceptions.map((exception) => [exception.code, exception])).values()];
    allExceptions.push(...deduplicated);
    return {
      patchId: patch.id,
      artifactType: patch.artifactType,
      targetFileName: patch.targetFileName,
      operation,
      status: deduplicated.length === 0 ? 'passed' : 'rejected',
      acceptedYaml: acceptedYamlStatus,
      checksum: checksumStatus,
      monotonicity: monotonicityStatus,
      exceptionCodes: uniqueCodes(deduplicated),
    };
  });

  return {
    status: allExceptions.length === 0 ? 'passed' : 'rejected',
    evidence,
    exceptions: allExceptions,
  };
}

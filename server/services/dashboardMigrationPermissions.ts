import { createHash } from 'node:crypto';
import { parse, stringify } from 'yaml';

export type MigrationPermissionKind =
  | 'access_grant'
  | 'default_required_grants'
  | 'default_access_filter'
  | 'topic_required_grants'
  | 'topic_access_filter'
  | 'view_required_grants'
  | 'field_required_grants'
  | 'field_mask_grants'
  | 'user_attribute'
  | 'user_attribute_coverage'
  | 'omni_attribute_reference'
  | 'user_group'
  | 'group_membership'
  | 'document_access'
  | 'document_settings'
  | 'folder_access'
  | 'model_role';

export type MigrationPermissionStatus = 'ready' | 'warning' | 'blocked' | 'unresolved';
export type MigrationPermissionDecisionAction =
  | 'map_existing'
  | 'create_from_source'
  | 'preserve_target'
  | 'ignore_with_waiver'
  | 'manual_prerequisite';

export interface MigrationPermissionCandidate {
  targetRef: string;
  label?: string;
  compatibility: 'equivalent' | 'compatible' | 'conflict';
  reason?: string;
}

export interface MigrationPermissionDependency {
  id: string;
  kind: MigrationPermissionKind;
  sourceRef: string;
  sourceFileName?: string;
  targetFileName?: string;
  sourcePath?: string[];
  targetPath?: string[];
  sourceValue?: unknown;
  targetValue?: unknown;
  sourceFingerprint?: string;
  targetFingerprint?: string;
  referencedGrantNames?: string[];
  userAttributeRefs?: string[];
  targetCandidates: MigrationPermissionCandidate[];
  status: MigrationPermissionStatus;
  risk: 'low' | 'medium' | 'high';
  reason?: string;
  recommendedAction: MigrationPermissionDecisionAction;
  affectedRoutes?: string[];
}

export interface MigrationPermissionDecision {
  dependencyId: string;
  action: MigrationPermissionDecisionAction;
  targetRef?: string;
  waiverReason?: string;
  confirmed?: boolean;
}

export interface MigrationPermissionFileMapping {
  sourceFileName: string;
  targetFileName: string;
}

export interface MigrationPermissionFieldTarget {
  sourceFieldRef: string;
  targetFieldRef: string;
  sourceFileName: string;
  targetFileName: string;
}

export interface MigrationPermissionDiscoveryInput {
  sourceFiles: Record<string, string>;
  targetFiles: Record<string, string>;
  fileMappings: MigrationPermissionFileMapping[];
  fieldTargets?: MigrationPermissionFieldTarget[];
  targetUserAttributes?: string[];
  targetUserAttributeDefinitions?: MigrationUserAttributeDefinition[];
  userAttributeInventoryStatus?: 'available' | 'unauthorized' | 'unavailable';
  sourceGroups?: MigrationContentIdentityGroup[];
  targetGroups?: MigrationContentIdentityGroup[];
  sourceGroupInventoryStatus?: 'available' | 'unauthorized' | 'unavailable';
  targetGroupInventoryStatus?: 'available' | 'unauthorized' | 'unavailable';
  affectedRoutes?: string[];
}

export interface MigrationUserAttributeDefinition {
  name: string;
  system?: boolean;
  hasDefaultValue?: boolean;
}

export interface MigrationContentAccessPrincipal {
  id: string;
  name: string;
  email?: string;
  type: 'user' | 'userGroup';
  role: 'NO_ACCESS' | 'VIEWER' | 'EDITOR' | 'MANAGER';
  accessBoost: boolean;
  accessSource: 'direct' | 'folder';
  isOwner: boolean;
  folderInfo?: {
    id?: string;
    name?: string;
    path?: string;
  };
}

export interface MigrationContentIdentityUser {
  id: string;
  displayName?: string;
  userName: string;
  email?: string;
  active: boolean;
}

export interface MigrationContentIdentityGroup {
  id: string;
  displayName: string;
  members?: Array<{
    value: string;
    display?: string;
  }>;
}

export interface MigrationContentAccessDiscoveryInput {
  documentId: string;
  documentName?: string;
  sourcePrincipals: MigrationContentAccessPrincipal[];
  targetUsers?: MigrationContentIdentityUser[];
  targetGroups?: MigrationContentIdentityGroup[];
  targetIdentityInventoryStatus: 'available' | 'unauthorized' | 'unavailable';
  affectedRoutes?: string[];
}

export interface MigrationContentAccessValue {
  sourcePrincipalId: string;
  principalType: 'user' | 'userGroup';
  principalName: string;
  principalEmail?: string;
  role: 'NO_ACCESS' | 'VIEWER' | 'EDITOR' | 'MANAGER';
  accessBoost: boolean;
  accessSource: 'direct' | 'folder';
  isOwner: boolean;
  folderId?: string;
  folderName?: string;
  folderPath?: string;
}

export interface MigrationModelRoleRecord {
  baseRole?: string;
  roleName: string;
  connectionId?: string;
  modelId?: string;
  resolved?: boolean;
  sourceType?: string;
}

export interface MigrationModelRoleValue {
  principalType: 'user' | 'userGroup';
  principalLabel: string;
  sourcePrincipalId: string;
  sourceRole: string;
  sourceBaseRole?: string;
  sourceRoleType?: string;
  sourceConnectionId?: string;
  sourceModelId: string;
  targetConnectionId?: string;
  targetModelId: string;
}

export interface MigrationModelRoleDiscoveryInput {
  principalType: 'user' | 'userGroup';
  principalLabel: string;
  sourcePrincipalId: string;
  targetPrincipalId?: string;
  sourceRole?: MigrationModelRoleRecord;
  targetRole?: MigrationModelRoleRecord;
  sourceInventoryStatus: 'available' | 'unauthorized' | 'unavailable';
  targetInventoryStatus: 'available' | 'unauthorized' | 'unavailable';
  sourceConnectionId?: string;
  sourceModelId: string;
  targetConnectionId?: string;
  targetModelId: string;
  affectedRoutes?: string[];
}

export interface CompiledPermissionYamlPatch {
  targetFileName: string;
  sourceFileNames: string[];
  currentYaml?: string;
  recommendedYaml: string;
  dependencyIds: string[];
  warnings: string[];
}

type YamlRecord = Record<string, unknown>;

interface PermissionRule {
  kind: Exclude<
    MigrationPermissionKind,
    'user_attribute'
    | 'user_attribute_coverage'
    | 'omni_attribute_reference'
    | 'user_group'
    | 'group_membership'
    | 'document_access'
    | 'document_settings'
    | 'folder_access'
    | 'model_role'
  >;
  sourceRef: string;
  sourceFileName: string;
  targetFileName: string;
  sourcePath: string[];
  targetPath: string[];
  sourceValue: unknown;
  targetValue?: unknown;
  risk: 'low' | 'medium' | 'high';
}

const SECURITY_KEYS = new Set([
  'access_grants',
  'default_topic_required_access_grants',
  'default_topic_access_filters',
  'required_access_grants',
  'access_filters',
  'mask_unless_access_grants',
]);

const NORMALIZED_SECURITY_KEYS = [...SECURITY_KEYS]
  .map((key) => key.toLowerCase().replace(/[^a-z0-9]/g, ''));

function isRecord(value: unknown): value is YamlRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function containsNormalizedKey(value: unknown, expectedKey: string): boolean {
  if (Array.isArray(value)) return value.some((item) => containsNormalizedKey(item, expectedKey));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, child]) => (
    key.toLowerCase().replace(/[^a-z0-9]/g, '') === expectedKey
    || containsNormalizedKey(child, expectedKey)
  ));
}

function includesAccessBoostBehavior(value: unknown): boolean {
  return containsNormalizedKey(value, 'accessboost')
    || containsNormalizedKey(value, 'accessboostable');
}

function parseYamlRecord(yaml: string | undefined): YamlRecord {
  if (!yaml?.trim()) return {};
  const value = parse(yaml);
  return isRecord(value) ? value : {};
}

export function migrationFilesHavePermissionEvidence(sourceFiles: Record<string, string>): boolean {
  return Object.values(sourceFiles).some((yaml) => {
    if (!yaml?.trim()) return false;
    if (/\bomni_attributes\.[A-Za-z_][\w-]*/.test(yaml)) return true;
    try {
      const root = parseYamlRecord(yaml);
      return NORMALIZED_SECURITY_KEYS.some((key) => containsNormalizedKey(root, key));
    } catch {
      // Let full discovery surface malformed authored YAML as a blocking dependency error.
      return true;
    }
  });
}

function deepClone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

export function permissionValueFingerprint(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

function dependencyId(input: Pick<PermissionRule, 'kind' | 'sourceFileName' | 'sourcePath' | 'sourceRef'>): string {
  return [
    'permission',
    input.kind,
    input.sourceFileName,
    input.sourcePath.join('.'),
    input.sourceRef,
  ].map((value) => value.trim().toLowerCase()).join(':');
}

function getPath(root: YamlRecord, path: string[]): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (!isRecord(current) || !(segment in current)) return undefined;
    current = current[segment];
  }
  return current;
}

function hasPath(root: YamlRecord, path: string[]): boolean {
  let current: unknown = root;
  for (const segment of path) {
    if (!isRecord(current) || !(segment in current)) return false;
    current = current[segment];
  }
  return true;
}

function setPath(root: YamlRecord, path: string[], value: unknown): void {
  if (path.length === 0) return;
  let current = root;
  path.slice(0, -1).forEach((segment) => {
    if (!isRecord(current[segment])) current[segment] = {};
    current = current[segment] as YamlRecord;
  });
  current[path[path.length - 1]] = deepClone(value);
}

function normalizedReference(value: string): string {
  return value.trim().toLowerCase();
}

function contentPrincipalLabel(principal: MigrationContentAccessPrincipal): string {
  return principal.email || principal.name;
}

function contentPrincipalSourceRef(principal: MigrationContentAccessPrincipal): string {
  return `${principal.type}:${contentPrincipalLabel(principal)}`;
}

function contentPrincipalValue(principal: MigrationContentAccessPrincipal): MigrationContentAccessValue {
  return {
    sourcePrincipalId: principal.id,
    principalType: principal.type,
    principalName: principal.name,
    ...(principal.email ? { principalEmail: principal.email } : {}),
    role: principal.role,
    accessBoost: principal.accessBoost,
    accessSource: principal.accessSource,
    isOwner: principal.isOwner,
    ...(principal.folderInfo?.id ? { folderId: principal.folderInfo.id } : {}),
    ...(principal.folderInfo?.name ? { folderName: principal.folderInfo.name } : {}),
    ...(principal.folderInfo?.path ? { folderPath: principal.folderInfo.path } : {}),
  };
}

function grantNamesFromValue(value: unknown, knownGrantNames: string[]): string[] {
  const known = new Map(knownGrantNames.map((name) => [normalizedReference(name), name]));
  const found = new Set<string>();
  const visit = (current: unknown) => {
    if (typeof current === 'string') {
      const normalized = normalizedReference(current);
      const exact = known.get(normalized);
      if (exact) found.add(exact);
      for (const token of current.match(/[A-Za-z_][\w-]*/g) || []) {
        const match = known.get(normalizedReference(token));
        if (match) found.add(match);
      }
      return;
    }
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (isRecord(current)) Object.values(current).forEach(visit);
  };
  visit(value);
  return [...found].sort();
}

function userAttributeRefsFromValue(value: unknown): string[] {
  const found = new Set<string>();
  const visit = (current: unknown) => {
    if (typeof current === 'string') {
      for (const match of current.matchAll(/omni_attributes\.([A-Za-z_][\w-]*)/g)) found.add(match[1]);
      return;
    }
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (!isRecord(current)) return;
    for (const [key, child] of Object.entries(current)) {
      if (/^user_?attribute$/i.test(key) && typeof child === 'string' && child.trim()) found.add(child.trim());
      visit(child);
    }
  };
  visit(value);
  return [...found].sort();
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim())
    : [];
}

export function migrationPermissionUserGroupNames(sourceFiles: Record<string, string>): string[] {
  const model = parseYamlRecord(sourceFiles.model);
  const accessGrants = isRecord(model.access_grants) ? model.access_grants : {};
  const names = new Set<string>();
  for (const value of Object.values(accessGrants)) {
    if (!isRecord(value)) continue;
    const attribute = typeof value.user_attribute === 'string' ? value.user_attribute.trim() : '';
    if (normalizedReference(attribute) !== 'omni_user_groups') continue;
    stringArray(value.allowed_values).forEach((name) => names.add(name));
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

function normalizedGroupMembers(group: MigrationContentIdentityGroup | undefined): string[] | undefined {
  if (!group?.members) return undefined;
  return [...new Set(group.members
    .map((member) => normalizedReference(member.display || member.value))
    .filter(Boolean))]
    .sort();
}

function groupEvidenceDependencies(input: MigrationPermissionDiscoveryInput): MigrationPermissionDependency[] {
  const groupNames = migrationPermissionUserGroupNames(input.sourceFiles);
  if (groupNames.length === 0) return [];
  const sourceGroups = new Map((input.sourceGroups || []).map((group) => [normalizedReference(group.displayName), group]));
  const targetGroups = new Map((input.targetGroups || []).map((group) => [normalizedReference(group.displayName), group]));

  const dependencies: MigrationPermissionDependency[] = [];
  for (const groupName of groupNames) {
    const sourceGroup = sourceGroups.get(normalizedReference(groupName));
    const targetGroup = targetGroups.get(normalizedReference(groupName));
    const inventoriesAvailable = input.sourceGroupInventoryStatus === 'available'
      && input.targetGroupInventoryStatus === 'available';
    const targetCandidates: MigrationPermissionCandidate[] = targetGroup ? [{
      targetRef: `userGroup:${targetGroup.id}`,
      label: targetGroup.displayName,
      compatibility: 'equivalent',
      reason: 'The destination has a user group with the same confirmed display name.',
    }] : [];
    dependencies.push({
      id: `permission:user_group:${normalizedReference(groupName)}`,
      kind: 'user_group',
      sourceRef: groupName,
      sourceValue: {
        sourceGroupPresent: Boolean(sourceGroup),
        referencedByModelSecurity: true,
      },
      ...(targetGroup ? {
        targetValue: {
          targetGroupPresent: true,
        },
      } : {}),
      sourceFingerprint: permissionValueFingerprint(groupName),
      targetCandidates,
      status: targetGroup ? 'ready' : inventoriesAvailable ? 'blocked' : 'warning',
      risk: 'high',
      reason: targetGroup
        ? 'The destination group exists. Membership coverage is checked separately.'
        : inventoriesAvailable
          ? 'The destination is missing a group required by an omni_user_groups access grant.'
          : 'OmniKit could not verify the source and destination group inventories with the saved credentials.',
      recommendedAction: targetGroup ? 'preserve_target' : 'manual_prerequisite',
      affectedRoutes: input.affectedRoutes,
    });

    if (!sourceGroup || !targetGroup) continue;
    const sourceMembers = normalizedGroupMembers(sourceGroup);
    const targetMembers = normalizedGroupMembers(targetGroup);
    const membershipKnown = Boolean(sourceMembers && targetMembers);
    const missingCount = membershipKnown
      ? sourceMembers!.filter((member) => !new Set(targetMembers).has(member)).length
      : undefined;
    const equivalent = membershipKnown && missingCount === 0;
    const sourceEvidence = {
      groupName,
      memberCount: sourceMembers?.length,
      memberSetFingerprint: sourceMembers ? permissionValueFingerprint(sourceMembers) : undefined,
    };
    const targetEvidence = {
      groupName: targetGroup.displayName,
      memberCount: targetMembers?.length,
      memberSetFingerprint: targetMembers ? permissionValueFingerprint(targetMembers) : undefined,
      missingSourceMemberCount: missingCount,
    };
    dependencies.push({
      id: `permission:group_membership:${normalizedReference(groupName)}`,
      kind: 'group_membership',
      sourceRef: groupName,
      sourceValue: sourceEvidence,
      targetValue: targetEvidence,
      sourceFingerprint: permissionValueFingerprint(sourceEvidence),
      targetFingerprint: permissionValueFingerprint(targetEvidence),
      targetCandidates,
      status: equivalent ? 'ready' : membershipKnown ? 'blocked' : 'warning',
      risk: 'high',
      reason: equivalent
        ? `The destination group covers all ${sourceMembers?.length || 0} source member${sourceMembers?.length === 1 ? '' : 's'}.`
        : membershipKnown
          ? `${missingCount} source group member${missingCount === 1 ? '' : 's'} are not present in the destination group. OmniKit will not add members automatically.`
          : 'Group membership could not be verified. Retrieve-group access requires an Organization API key; complete and confirm membership in Omni or the identity provider.',
      recommendedAction: equivalent ? 'preserve_target' : 'manual_prerequisite',
      affectedRoutes: input.affectedRoutes,
    });
  }
  return dependencies;
}

const STANDARD_MODEL_ROLES = new Set([
  'VIEWER',
  'QUERIER',
  'QUERY_TOPICS',
  'MODELER',
  'CONNECTION_ADMIN',
  'NO_ACCESS',
]);

export function migrationModelRoleValue(value: unknown): MigrationModelRoleValue | undefined {
  if (!isRecord(value)) return undefined;
  const principalType = value.principalType === 'userGroup'
    ? 'userGroup'
    : value.principalType === 'user'
      ? 'user'
      : undefined;
  if (
    !principalType
    || typeof value.principalLabel !== 'string'
    || typeof value.sourcePrincipalId !== 'string'
    || typeof value.sourceRole !== 'string'
    || typeof value.sourceModelId !== 'string'
    || typeof value.targetModelId !== 'string'
  ) return undefined;
  return {
    principalType,
    principalLabel: value.principalLabel,
    sourcePrincipalId: value.sourcePrincipalId,
    sourceRole: value.sourceRole,
    ...(typeof value.sourceBaseRole === 'string' ? { sourceBaseRole: value.sourceBaseRole } : {}),
    ...(typeof value.sourceRoleType === 'string' ? { sourceRoleType: value.sourceRoleType } : {}),
    ...(typeof value.sourceConnectionId === 'string' ? { sourceConnectionId: value.sourceConnectionId } : {}),
    sourceModelId: value.sourceModelId,
    ...(typeof value.targetConnectionId === 'string' ? { targetConnectionId: value.targetConnectionId } : {}),
    targetModelId: value.targetModelId,
  };
}

export function discoverMigrationModelRoleDependency(
  input: MigrationModelRoleDiscoveryInput,
): MigrationPermissionDependency | undefined {
  if (!input.sourceRole) {
    const available = input.sourceInventoryStatus === 'available';
    return {
      id: [
        'permission',
        'model_role',
        input.targetModelId,
        input.principalType,
        normalizedReference(input.principalLabel),
      ].join(':'),
      kind: 'model_role',
      sourceRef: `${input.principalLabel} · model role`,
      sourceValue: {
        principalType: input.principalType,
        principalLabel: input.principalLabel,
        sourcePrincipalId: input.sourcePrincipalId,
        sourceModelId: input.sourceModelId,
        targetModelId: input.targetModelId,
      },
      sourceFingerprint: permissionValueFingerprint({
        principalType: input.principalType,
        principalLabel: input.principalLabel,
        sourceModelId: input.sourceModelId,
      }),
      targetCandidates: input.targetPrincipalId ? [{
        targetRef: `${input.principalType}:${input.targetPrincipalId}`,
        label: input.principalLabel,
        compatibility: 'compatible',
        reason: 'The destination principal is mapped, but the source model role could not be resolved.',
      }] : [],
      status: 'warning',
      risk: 'medium',
      reason: available
        ? 'No effective source model role was returned for this content principal. Confirm whether the destination connection base role is sufficient.'
        : 'OmniKit could not inspect the source model role. Confirm equivalent destination model access manually.',
      recommendedAction: 'manual_prerequisite',
      affectedRoutes: input.affectedRoutes,
    };
  }
  const sourceRole = input.sourceRole.roleName.trim();
  if (!sourceRole) return undefined;
  const sourceDirect = input.principalType === 'userGroup'
    || normalizedReference(input.sourceRole.sourceType || '') === 'user role';
  const sourceStandard = STANDARD_MODEL_ROLES.has(sourceRole.toUpperCase());
  const targetSameRole = Boolean(
    input.targetRole
    && normalizedReference(input.targetRole.roleName) === normalizedReference(sourceRole),
  );
  const targetCandidates: MigrationPermissionCandidate[] = input.targetPrincipalId ? [{
    targetRef: `${input.principalType}:${input.targetPrincipalId}`,
    label: `${input.principalLabel} as ${sourceRole}`,
    compatibility: targetSameRole ? 'equivalent' : input.targetRole ? 'conflict' : 'compatible',
    reason: targetSameRole
      ? 'The mapped destination principal already has the same effective model role.'
      : input.targetRole
        ? `The mapped destination principal currently resolves to ${input.targetRole.roleName}.`
        : 'The mapped destination principal can receive this documented standard model role.',
  }] : [];
  const value: MigrationModelRoleValue = {
    principalType: input.principalType,
    principalLabel: input.principalLabel,
    sourcePrincipalId: input.sourcePrincipalId,
    sourceRole,
    ...(input.sourceRole.baseRole ? { sourceBaseRole: input.sourceRole.baseRole } : {}),
    ...(input.sourceRole.sourceType ? { sourceRoleType: input.sourceRole.sourceType } : {}),
    ...(input.sourceConnectionId ? { sourceConnectionId: input.sourceConnectionId } : {}),
    sourceModelId: input.sourceModelId,
    ...(input.targetConnectionId ? { targetConnectionId: input.targetConnectionId } : {}),
    targetModelId: input.targetModelId,
  };
  const inventoriesAvailable = input.sourceInventoryStatus === 'available'
    && input.targetInventoryStatus === 'available';
  const status: MigrationPermissionStatus = targetSameRole
    ? 'ready'
    : !inventoriesAvailable || !input.targetPrincipalId || !sourceDirect || !sourceStandard || Boolean(input.targetRole)
      ? 'blocked'
      : 'unresolved';
  const reason = targetSameRole
    ? `The mapped destination principal already resolves to ${sourceRole}.`
    : !inventoriesAvailable
      ? 'OmniKit could not verify model-role assignments with the saved credentials.'
      : !input.targetPrincipalId
        ? 'Map this source principal to a destination identity before its model role can be evaluated.'
        : !sourceDirect
          ? `The source user inherits ${sourceRole} from ${input.sourceRole.sourceType || 'another security layer'}. Confirm equivalent target inheritance rather than converting it to a direct assignment.`
          : !sourceStandard
            ? `${sourceRole} is a custom model role. Same-name custom roles are not assumed to be equivalent.`
            : input.targetRole
              ? `The mapped destination principal resolves to ${input.targetRole.roleName}; changing it to ${sourceRole} requires manual review.`
              : `The mapped destination principal is missing the source ${sourceRole} model role.`;
  return {
    id: [
      'permission',
      'model_role',
      input.targetModelId,
      input.principalType,
      normalizedReference(input.principalLabel),
    ].join(':'),
    kind: 'model_role',
    sourceRef: `${input.principalLabel} · ${sourceRole}`,
    sourceValue: value,
    ...(input.targetRole ? {
      targetValue: {
        roleName: input.targetRole.roleName,
        baseRole: input.targetRole.baseRole,
        sourceType: input.targetRole.sourceType,
      },
    } : {}),
    sourceFingerprint: permissionValueFingerprint(value),
    ...(input.targetRole ? { targetFingerprint: permissionValueFingerprint(input.targetRole) } : {}),
    targetCandidates,
    status,
    risk: sourceRole === 'CONNECTION_ADMIN' || sourceRole === 'MODELER' ? 'high' : 'medium',
    reason,
    recommendedAction: targetSameRole
      ? 'preserve_target'
      : status === 'unresolved'
        ? 'create_from_source'
        : 'manual_prerequisite',
    affectedRoutes: input.affectedRoutes,
  };
}

function viewAndFieldRules(input: {
  sourceFileName: string;
  targetFileName: string;
  sourceRoot: YamlRecord;
  targetRoot: YamlRecord;
  fieldTargets: MigrationPermissionFieldTarget[];
}): PermissionRule[] {
  const rules: PermissionRule[] = [];
  const sourceRequired = input.sourceRoot.required_access_grants;
  if (sourceRequired !== undefined) {
    rules.push({
      kind: 'view_required_grants',
      sourceRef: input.sourceFileName,
      sourceFileName: input.sourceFileName,
      targetFileName: input.targetFileName,
      sourcePath: ['required_access_grants'],
      targetPath: ['required_access_grants'],
      sourceValue: sourceRequired,
      targetValue: input.targetRoot.required_access_grants,
      risk: 'medium',
    });
  }

  for (const fieldTarget of input.fieldTargets.filter((field) => field.sourceFileName === input.sourceFileName)) {
    const sourceParts = fieldTarget.sourceFieldRef.split('.');
    const targetParts = fieldTarget.targetFieldRef.split('.');
    const sourceFieldName = sourceParts[sourceParts.length - 1];
    const targetFieldName = targetParts[targetParts.length - 1];
    const sourceKinds = ['dimensions', 'measures'];
    for (const collection of sourceKinds) {
      const sourceField = getPath(input.sourceRoot, [collection, sourceFieldName]);
      if (!isRecord(sourceField)) continue;
      const targetCollection = isRecord(getPath(input.targetRoot, [collection, targetFieldName]))
        ? collection
        : collection === 'dimensions' && isRecord(getPath(input.targetRoot, ['measures', targetFieldName]))
          ? 'measures'
          : collection === 'measures' && isRecord(getPath(input.targetRoot, ['dimensions', targetFieldName]))
            ? 'dimensions'
            : collection;
      for (const key of ['required_access_grants', 'mask_unless_access_grants']) {
        if (!(key in sourceField)) continue;
        rules.push({
          kind: key === 'mask_unless_access_grants' ? 'field_mask_grants' : 'field_required_grants',
          sourceRef: fieldTarget.sourceFieldRef,
          sourceFileName: input.sourceFileName,
          targetFileName: fieldTarget.targetFileName,
          sourcePath: [collection, sourceFieldName, key],
          targetPath: [targetCollection, targetFieldName, key],
          sourceValue: sourceField[key],
          targetValue: getPath(input.targetRoot, [targetCollection, targetFieldName, key]),
          risk: 'high',
        });
      }
    }
  }
  return rules;
}

function semanticRules(input: MigrationPermissionDiscoveryInput): {
  rules: PermissionRule[];
  sourceGrantDefinitions: Record<string, unknown>;
  targetGrantDefinitions: Record<string, unknown>;
} {
  const rules: PermissionRule[] = [];
  const fileMappings = new Map(input.fileMappings.map((mapping) => [mapping.sourceFileName, mapping.targetFileName]));
  const sourceModel = parseYamlRecord(input.sourceFiles.model);
  const targetModel = parseYamlRecord(input.targetFiles.model);
  const sourceGrantDefinitions = isRecord(sourceModel.access_grants) ? sourceModel.access_grants : {};
  const targetGrantDefinitions = isRecord(targetModel.access_grants) ? targetModel.access_grants : {};

  for (const key of ['default_topic_required_access_grants', 'default_topic_access_filters']) {
    if (!(key in sourceModel)) continue;
    rules.push({
      kind: key === 'default_topic_required_access_grants' ? 'default_required_grants' : 'default_access_filter',
      sourceRef: key,
      sourceFileName: 'model',
      targetFileName: 'model',
      sourcePath: [key],
      targetPath: [key],
      sourceValue: sourceModel[key],
      targetValue: targetModel[key],
      risk: 'high',
    });
  }

  for (const [sourceFileName, targetFileName] of fileMappings) {
    if (sourceFileName === 'model') continue;
    const sourceRoot = parseYamlRecord(input.sourceFiles[sourceFileName]);
    const targetRoot = parseYamlRecord(input.targetFiles[targetFileName]);
    if (sourceFileName.endsWith('.topic')) {
      for (const key of ['required_access_grants', 'access_filters']) {
        if (!(key in sourceRoot)) continue;
        rules.push({
          kind: key === 'required_access_grants' ? 'topic_required_grants' : 'topic_access_filter',
          sourceRef: sourceFileName.replace(/\.topic$/, ''),
          sourceFileName,
          targetFileName,
          sourcePath: [key],
          targetPath: [key],
          sourceValue: sourceRoot[key],
          targetValue: targetRoot[key],
          risk: 'high',
        });
      }
      continue;
    }
    if (sourceFileName.endsWith('.view')) {
      rules.push(...viewAndFieldRules({
        sourceFileName,
        targetFileName,
        sourceRoot,
        targetRoot,
        fieldTargets: input.fieldTargets || [],
      }));
    }
  }

  const referencedGrantNames = new Set<string>();
  for (const rule of rules) {
    for (const grantName of grantNamesFromValue(rule.sourceValue, Object.keys(sourceGrantDefinitions))) {
      referencedGrantNames.add(grantName);
    }
  }
  for (const grantName of [...referencedGrantNames].sort().reverse()) {
    rules.unshift({
      kind: 'access_grant',
      sourceRef: grantName,
      sourceFileName: 'model',
      targetFileName: 'model',
      sourcePath: ['access_grants', grantName],
      targetPath: ['access_grants', grantName],
      sourceValue: sourceGrantDefinitions[grantName],
      targetValue: targetGrantDefinitions[grantName],
      risk: 'high',
    });
  }

  return { rules, sourceGrantDefinitions, targetGrantDefinitions };
}

function grantCandidates(
  sourceGrantName: string,
  sourceValue: unknown,
  targetGrants: Record<string, unknown>,
): MigrationPermissionCandidate[] {
  const sourceFingerprint = permissionValueFingerprint(sourceValue);
  return Object.entries(targetGrants)
    .map(([targetRef, targetValue]): MigrationPermissionCandidate | null => {
      if (permissionValueFingerprint(targetValue) === sourceFingerprint) {
        return {
          targetRef,
          label: targetRef,
          compatibility: targetRef === sourceGrantName ? 'equivalent' : 'compatible',
          reason: targetRef === sourceGrantName
            ? 'The destination grant has the same name and semantic definition.'
            : 'The destination grant has an equivalent user-attribute and allowed-values definition.',
        };
      }
      if (normalizedReference(targetRef) === normalizedReference(sourceGrantName)) {
        return {
          targetRef,
          label: targetRef,
          compatibility: 'conflict',
          reason: 'A same-name destination grant has a different semantic definition.',
        };
      }
      return null;
    })
    .filter((candidate): candidate is MigrationPermissionCandidate => Boolean(candidate))
    .sort((a, b) => a.compatibility.localeCompare(b.compatibility) || a.targetRef.localeCompare(b.targetRef));
}

function defaultRuleDecision(input: {
  rule: PermissionRule;
  equivalent: boolean;
  targetExists: boolean;
  candidates: MigrationPermissionCandidate[];
}): Pick<MigrationPermissionDependency, 'status' | 'reason' | 'recommendedAction'> {
  if (input.equivalent) {
    return {
      status: 'ready',
      reason: 'The destination already has an equivalent permission rule.',
      recommendedAction: 'preserve_target',
    };
  }
  if (input.rule.kind === 'access_grant' && includesAccessBoostBehavior(input.rule.sourceValue)) {
    return {
      status: 'blocked',
      reason: 'This grant includes AccessBoost behavior. An administrator must explicitly confirm its destination behavior before OmniKit can add it.',
      recommendedAction: 'manual_prerequisite',
    };
  }
  if (input.rule.kind === 'access_grant' && input.candidates.some((candidate) => candidate.compatibility === 'compatible')) {
    return {
      status: 'unresolved',
      reason: 'An equivalent destination grant is available under a different name.',
      recommendedAction: 'map_existing',
    };
  }
  if (input.targetExists) {
    return {
      status: 'blocked',
      reason: 'The destination has a conflicting rule at the same semantic path. Preserve, map, or explicitly waive it; additive creation cannot overwrite this rule.',
      recommendedAction: 'manual_prerequisite',
    };
  }
  if (input.rule.kind === 'default_required_grants' || input.rule.kind === 'default_access_filter') {
    return {
      status: 'warning',
      reason: 'This missing model default can affect every destination topic. Review its blast radius before creating it.',
      recommendedAction: 'create_from_source',
    };
  }
  return {
    status: 'unresolved',
    reason: 'The destination is missing this source permission rule.',
    recommendedAction: 'create_from_source',
  };
}

export function discoverMigrationPermissionDependencies(
  input: MigrationPermissionDiscoveryInput,
): MigrationPermissionDependency[] {
  const { rules, sourceGrantDefinitions, targetGrantDefinitions } = semanticRules(input);
  const sourceGrantNames = Object.keys(sourceGrantDefinitions);
  const dependencies = rules.map((rule): MigrationPermissionDependency => {
    const sourceFingerprint = permissionValueFingerprint(rule.sourceValue);
    const targetFingerprint = rule.targetValue === undefined ? undefined : permissionValueFingerprint(rule.targetValue);
    const equivalent = Boolean(targetFingerprint && sourceFingerprint === targetFingerprint);
    const targetExists = rule.targetValue !== undefined;
    const candidates = rule.kind === 'access_grant'
      ? grantCandidates(rule.sourceRef, rule.sourceValue, targetGrantDefinitions)
      : [];
    const decision = defaultRuleDecision({ rule, equivalent, targetExists, candidates });
    return {
      id: dependencyId(rule),
      kind: rule.kind,
      sourceRef: rule.sourceRef,
      sourceFileName: rule.sourceFileName,
      targetFileName: rule.targetFileName,
      sourcePath: rule.sourcePath,
      targetPath: rule.targetPath,
      sourceValue: deepClone(rule.sourceValue),
      ...(rule.targetValue !== undefined ? { targetValue: deepClone(rule.targetValue) } : {}),
      sourceFingerprint,
      ...(targetFingerprint ? { targetFingerprint } : {}),
      referencedGrantNames: grantNamesFromValue(rule.sourceValue, sourceGrantNames),
      userAttributeRefs: userAttributeRefsFromValue(rule.sourceValue),
      targetCandidates: candidates,
      status: decision.status,
      risk: rule.risk,
      reason: decision.reason,
      recommendedAction: decision.recommendedAction,
      affectedRoutes: input.affectedRoutes,
    };
  });

  const referencedAttributes = new Set<string>();
  for (const dependency of dependencies) {
    dependency.userAttributeRefs?.forEach((attribute) => referencedAttributes.add(attribute));
  }
  for (const mapping of input.fileMappings) {
    const yaml = input.sourceFiles[mapping.sourceFileName];
    userAttributeRefsFromValue(yaml).forEach((attribute) => referencedAttributes.add(attribute));
  }

  const attributeDefinitions = new Map(
    (input.targetUserAttributeDefinitions || []).map((attribute) => [
      normalizedReference(attribute.name),
      attribute,
    ]),
  );
  const availableAttributes = new Set([
    ...(input.targetUserAttributes || []).map(normalizedReference),
    ...attributeDefinitions.keys(),
  ]);
  for (const attribute of [...referencedAttributes].sort()) {
    const normalizedAttribute = normalizedReference(attribute);
    const available = availableAttributes.has(normalizedAttribute);
    const definition = attributeDefinitions.get(normalizedAttribute);
    const inventoryAvailable = input.userAttributeInventoryStatus === 'available';
    dependencies.push({
      id: `permission:user_attribute:${normalizedAttribute}`,
      kind: 'user_attribute',
      sourceRef: attribute,
      sourceFingerprint: permissionValueFingerprint(attribute),
      targetCandidates: available ? [{
        targetRef: attribute,
        label: attribute,
        compatibility: 'equivalent',
        reason: 'The destination user-attribute definition exists.',
      }] : [],
      status: available
        ? 'ready'
        : inventoryAvailable
          ? 'blocked'
          : 'warning',
      risk: 'high',
      reason: available
        ? 'The destination user-attribute definition exists.'
        : inventoryAvailable
          ? 'The destination is missing this user-attribute definition. Create it in Omni Settings or the identity provider before migration.'
          : 'OmniKit could not verify destination user-attribute definitions with the saved credential.',
      recommendedAction: available ? 'preserve_target' : 'manual_prerequisite',
      affectedRoutes: input.affectedRoutes,
    });
    if (
      available
      && definition
      && definition.system !== true
      && definition.hasDefaultValue !== true
    ) {
      dependencies.push({
        id: `permission:user_attribute_coverage:${normalizedAttribute}`,
        kind: 'user_attribute_coverage',
        sourceRef: `${attribute} value coverage`,
        sourceValue: {
          attribute: normalizedAttribute,
          inventoryStatus: 'manual_review_required',
          rawValuesPersisted: false,
        },
        sourceFingerprint: permissionValueFingerprint({
          attribute: normalizedAttribute,
          hasDefaultValue: false,
        }),
        targetCandidates: [],
        status: 'blocked',
        risk: 'high',
        reason: 'The destination attribute definition exists without a default value, and Omni’s documented SCIM user response does not expose assigned custom attribute values. Confirm that every intended target persona has a non-null value before migration.',
        recommendedAction: 'manual_prerequisite',
        affectedRoutes: input.affectedRoutes,
      });
    }
  }

  dependencies.push(...groupEvidenceDependencies(input));

  return [...new Map(dependencies.map((dependency) => [dependency.id, dependency])).values()]
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.sourceRef.localeCompare(b.sourceRef));
}

export function discoverMigrationContentAccessDependencies(
  input: MigrationContentAccessDiscoveryInput,
): MigrationPermissionDependency[] {
  const usersByEmail = new Map<string, MigrationContentIdentityUser>();
  for (const user of input.targetUsers || []) {
    const email = user.email || user.userName;
    if (email) usersByEmail.set(normalizedReference(email), user);
  }
  const groupsByName = new Map(
    (input.targetGroups || []).map((group) => [normalizedReference(group.displayName), group]),
  );

  const directDependencies = input.sourcePrincipals
    .filter((principal) => principal.accessSource === 'direct' && !principal.isOwner)
    .map((principal): MigrationPermissionDependency => {
      const sourceRef = contentPrincipalSourceRef(principal);
      const value = contentPrincipalValue(principal);
      const targetUser = principal.type === 'user'
        ? usersByEmail.get(normalizedReference(principal.email || principal.name))
        : undefined;
      const targetGroup = principal.type === 'userGroup'
        ? groupsByName.get(normalizedReference(principal.name))
        : undefined;
      const target = targetUser || targetGroup;
      const candidates: MigrationPermissionCandidate[] = target ? [{
        targetRef: `${principal.type}:${target.id}`,
        label: targetUser
          ? targetUser.email || targetUser.userName || targetUser.displayName || principal.name
          : targetGroup?.displayName || principal.name,
        compatibility: 'equivalent',
        reason: principal.type === 'user'
          ? 'The destination user has the same email address.'
          : 'The destination user group has the same name.',
      }] : [];
      const inventoryAvailable = input.targetIdentityInventoryStatus === 'available';
      const status: MigrationPermissionStatus = target ? 'unresolved' : 'blocked';
      const reason = target
        ? `The destination ${principal.type === 'user' ? 'user' : 'group'} matches the source principal. Review the role${principal.accessBoost ? ' and AccessBoost' : ''} before applying direct access.`
        : inventoryAvailable
          ? `No matching destination ${principal.type === 'user' ? 'user email' : 'group name'} was found. Provision or map the principal before migration.`
          : 'OmniKit could not inventory destination users and groups with the saved credential. Confirm or map this principal manually with an Organization API key.';
      return {
        id: [
          'permission',
          'document_access',
          input.documentId,
          principal.type,
          principal.id,
          principal.role,
          principal.accessBoost ? 'boost' : 'standard',
        ].map(normalizedReference).join(':'),
        kind: 'document_access',
        sourceRef,
        sourceValue: value,
        sourceFingerprint: permissionValueFingerprint(value),
        targetCandidates: candidates,
        status,
        risk: principal.accessBoost ? 'high' : 'low',
        reason,
        recommendedAction: target ? 'map_existing' : 'manual_prerequisite',
        affectedRoutes: input.affectedRoutes,
      };
    });

  const inheritedGroups = new Map<string, MigrationContentAccessPrincipal[]>();
  for (const principal of input.sourcePrincipals.filter((item) => item.accessSource === 'folder')) {
    const key = principal.folderInfo?.id || principal.folderInfo?.path || principal.folderInfo?.name || 'source-folder';
    const principals = inheritedGroups.get(key) || [];
    principals.push(principal);
    inheritedGroups.set(key, principals);
  }
  const inheritedDependencies = [...inheritedGroups.entries()].map(([folderRef, principals]): MigrationPermissionDependency => {
    const first = principals[0];
    const folderLabel = first.folderInfo?.path || first.folderInfo?.name || folderRef;
    const roleCounts = Object.fromEntries(
      [...new Set(principals.map((principal) => principal.role))]
        .sort()
        .map((role) => [role, principals.filter((principal) => principal.role === role).length]),
    );
    const principalEvidenceFingerprint = permissionValueFingerprint(
      principals
        .map((principal) => ({
          type: principal.type,
          identity: normalizedReference(principal.email || principal.name),
          role: principal.role,
          accessBoost: principal.accessBoost,
        }))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    );
    const sourceValue = {
      folderId: first.folderInfo?.id,
      folderName: first.folderInfo?.name,
      folderPath: first.folderInfo?.path,
      principalCount: principals.length,
      accessBoostCount: principals.filter((principal) => principal.accessBoost).length,
      roleCounts,
      principalEvidenceFingerprint,
    };
    return {
      id: ['permission', 'folder_access', input.documentId, folderRef].map(normalizedReference).join(':'),
      kind: 'folder_access',
      sourceRef: folderLabel,
      sourceValue,
      sourceFingerprint: permissionValueFingerprint(sourceValue),
      targetCandidates: [],
      status: 'blocked',
      risk: principals.some((principal) => principal.accessBoost) ? 'high' : 'medium',
      reason: `${principals.length} source access grant${principals.length === 1 ? ' is' : 's are'} inherited from ${folderLabel}. Confirm equivalent access on the selected target folder; OmniKit will not flatten inherited access into direct dashboard grants.`,
      recommendedAction: 'manual_prerequisite',
      affectedRoutes: input.affectedRoutes,
    };
  });

  return [...directDependencies, ...inheritedDependencies]
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.sourceRef.localeCompare(b.sourceRef));
}

export function discoverMigrationDocumentSettingsDependency(input: {
  documentId: string;
  documentName?: string;
  updateInPlace: boolean;
  hasSecurityDependencies: boolean;
  affectedRoutes?: string[];
}): MigrationPermissionDependency | undefined {
  if (!input.hasSecurityDependencies || input.updateInPlace) return undefined;
  const sourceValue = {
    documentId: input.documentId,
    settings: [
      'organizationRole',
      'canDownload',
      'canDrill',
      'canSchedule',
      'canUpload',
      'canViewWorkbook',
    ],
    inventoryStatus: 'manual_review_required',
  };
  return {
    id: ['permission', 'document_settings', input.documentId].map(normalizedReference).join(':'),
    kind: 'document_settings',
    sourceRef: `${input.documentName || input.documentId} dashboard settings`,
    sourceValue,
    sourceFingerprint: permissionValueFingerprint(sourceValue),
    targetCandidates: [],
    status: 'blocked',
    risk: 'high',
    reason: 'Omni can update dashboard organization-role and ability settings, but its documented general-purpose read APIs do not expose a complete source settings payload for migration. Compare these settings in Omni, configure the destination dashboard after import, and confirm that prerequisite before continuing.',
    recommendedAction: 'manual_prerequisite',
    affectedRoutes: input.affectedRoutes,
  };
}

export function migrationContentAccessValue(value: unknown): MigrationContentAccessValue | undefined {
  if (!isRecord(value)) return undefined;
  const principalType = value.principalType === 'userGroup' ? 'userGroup' : value.principalType === 'user' ? 'user' : undefined;
  const role = typeof value.role === 'string' && ['NO_ACCESS', 'VIEWER', 'EDITOR', 'MANAGER'].includes(value.role)
    ? value.role as MigrationContentAccessValue['role']
    : undefined;
  const accessSource = value.accessSource === 'folder' ? 'folder' : value.accessSource === 'direct' ? 'direct' : undefined;
  if (
    !principalType
    || !role
    || !accessSource
    || typeof value.sourcePrincipalId !== 'string'
    || typeof value.principalName !== 'string'
  ) return undefined;
  return {
    sourcePrincipalId: value.sourcePrincipalId,
    principalType,
    principalName: value.principalName,
    ...(typeof value.principalEmail === 'string' ? { principalEmail: value.principalEmail } : {}),
    role,
    accessBoost: value.accessBoost === true,
    accessSource,
    isOwner: value.isOwner === true,
    ...(typeof value.folderId === 'string' ? { folderId: value.folderId } : {}),
    ...(typeof value.folderName === 'string' ? { folderName: value.folderName } : {}),
    ...(typeof value.folderPath === 'string' ? { folderPath: value.folderPath } : {}),
  };
}

function decisionFor(
  dependency: MigrationPermissionDependency,
  decisions: MigrationPermissionDecision[],
): MigrationPermissionDecision | undefined {
  return decisions.find((decision) => decision.dependencyId === dependency.id);
}

function validateDecision(
  dependency: MigrationPermissionDependency,
  decision: MigrationPermissionDecision | undefined,
): string | undefined {
  if (dependency.status === 'ready' && !decision) return undefined;
  if (!decision) return 'Choose how to resolve this permission dependency.';
  if (decision.action === 'preserve_target') {
    const targetExists = dependency.targetValue !== undefined
      || (
        dependency.kind !== 'document_access'
        && dependency.kind !== 'folder_access'
        && dependency.targetCandidates.some((candidate) => candidate.compatibility === 'equivalent')
      );
    if (!targetExists) return 'There is no equivalent target permission to preserve.';
  }
  if (decision.action === 'map_existing') {
    if (!decision.targetRef) return 'Choose a compatible destination permission.';
    const candidate = dependency.targetCandidates.find((item) => item.targetRef === decision.targetRef);
    if (!candidate || candidate.compatibility === 'conflict') return 'The selected destination permission is not semantically compatible.';
    if (dependency.kind === 'model_role' && candidate.compatibility !== 'equivalent') {
      return 'A missing model role must be assigned explicitly; it cannot be treated as an existing mapping.';
    }
  }
  if (
    dependency.kind === 'document_access'
    && migrationContentAccessValue(dependency.sourceValue)?.accessBoost === true
    && decision.action === 'map_existing'
    && decision.confirmed !== true
  ) {
    return 'Confirm AccessBoost before applying this direct document grant.';
  }
  if (decision.action === 'create_from_source' && dependency.targetValue !== undefined) {
    return 'Create from source is additive and cannot replace an existing conflicting target rule.';
  }
  if (decision.action === 'create_from_source' && dependency.kind === 'model_role') {
    const value = migrationModelRoleValue(dependency.sourceValue);
    if (!value || !STANDARD_MODEL_ROLES.has(value.sourceRole.toUpperCase())) {
      return 'Custom or unverified model roles require a confirmed manual prerequisite.';
    }
    if (!decision.targetRef) return 'Choose the mapped destination principal for this model role.';
    const candidate = dependency.targetCandidates.find((item) => item.targetRef === decision.targetRef);
    if (!candidate || candidate.compatibility !== 'compatible') {
      return 'The selected destination principal cannot receive this role automatically.';
    }
    if (decision.confirmed !== true) {
      return 'Confirm the model-role assignment before OmniKit changes destination access.';
    }
  }
  if (
    decision.action === 'create_from_source'
    && (dependency.kind === 'user_attribute'
      || dependency.kind === 'user_attribute_coverage'
      || dependency.kind === 'user_group'
      || dependency.kind === 'group_membership'
      || dependency.kind === 'document_access'
      || dependency.kind === 'document_settings'
      || dependency.kind === 'folder_access')
  ) {
    return 'This dependency cannot be created through the semantic YAML writer.';
  }
  if (
    decision.action === 'create_from_source'
    && dependency.kind === 'access_grant'
    && includesAccessBoostBehavior(dependency.sourceValue)
    && decision.confirmed !== true
  ) {
    return 'Confirm the AccessBoost behavior before creating this grant.';
  }
  if (decision.action === 'ignore_with_waiver' && !decision.waiverReason?.trim()) {
    return 'A waiver reason is required.';
  }
  if (decision.action === 'manual_prerequisite' && decision.confirmed !== true) {
    return 'Confirm that the manual prerequisite has been completed.';
  }
  return undefined;
}

export function migrationPermissionDecisionBlockers(
  dependencies: MigrationPermissionDependency[],
  decisions: MigrationPermissionDecision[],
): string[] {
  return dependencies
    .map((dependency) => {
      const error = validateDecision(dependency, decisionFor(dependency, decisions));
      return error ? `${dependency.sourceRef}: ${error}` : '';
    })
    .filter(Boolean);
}

function replaceGrantReferences(value: unknown, grantMappings: Map<string, string>): unknown {
  if (typeof value === 'string') {
    let next = value;
    for (const [source, target] of grantMappings) {
      next = next.replace(new RegExp(`\\b${source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), target);
    }
    return next;
  }
  if (Array.isArray(value)) return value.map((item) => replaceGrantReferences(item, grantMappings));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replaceGrantReferences(child, grantMappings)]));
}

function replaceAccessFilterFields(value: unknown, fieldMappings: Map<string, string>): unknown {
  if (Array.isArray(value)) return value.map((item) => replaceAccessFilterFields(item, fieldMappings));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    fieldMappings.get(normalizedReference(key)) || key,
    replaceAccessFilterFields(child, fieldMappings),
  ]));
}

export function compileMigrationPermissionPatches(input: {
  dependencies: MigrationPermissionDependency[];
  decisions: MigrationPermissionDecision[];
  targetFiles: Record<string, string>;
  fieldTargets?: MigrationPermissionFieldTarget[];
}): CompiledPermissionYamlPatch[] {
  const blockers = migrationPermissionDecisionBlockers(input.dependencies, input.decisions);
  if (blockers.length > 0) throw new Error(blockers.join(' '));

  const grantMappings = new Map<string, string>();
  for (const dependency of input.dependencies.filter((item) => item.kind === 'access_grant')) {
    const decision = decisionFor(dependency, input.decisions);
    if (decision?.action === 'map_existing' && decision.targetRef) {
      grantMappings.set(dependency.sourceRef, decision.targetRef);
    } else if (
      decision?.action === 'create_from_source'
      || (!decision && dependency.status === 'ready')
      || decision?.action === 'preserve_target'
    ) {
      grantMappings.set(dependency.sourceRef, dependency.sourceRef);
    }
  }
  const fieldMappings = new Map((input.fieldTargets || []).map((field) => [
    normalizedReference(field.sourceFieldRef),
    field.targetFieldRef,
  ]));

  const grouped = new Map<string, {
    root: YamlRecord;
    sourceFileNames: Set<string>;
    dependencyIds: string[];
    warnings: string[];
  }>();
  for (const dependency of input.dependencies) {
    const decision = decisionFor(dependency, input.decisions);
    const action = decision?.action || (dependency.status === 'ready' ? 'preserve_target' : undefined);
    if (action !== 'create_from_source') continue;
    if (!dependency.targetFileName || !dependency.targetPath || dependency.sourceValue === undefined) continue;
    const targetFileName = dependency.targetFileName;
    const current = grouped.get(targetFileName) || {
      root: parseYamlRecord(input.targetFiles[targetFileName]),
      sourceFileNames: new Set<string>(),
      dependencyIds: [],
      warnings: [],
    };
    if (hasPath(current.root, dependency.targetPath)) {
      throw new Error(`Permission rule ${dependency.sourceRef} already exists in ${targetFileName}; additive compilation will not overwrite it.`);
    }
    let value = replaceGrantReferences(dependency.sourceValue, grantMappings);
    if (dependency.kind === 'topic_access_filter' || dependency.kind === 'default_access_filter') {
      value = replaceAccessFilterFields(value, fieldMappings);
    }
    setPath(current.root, dependency.targetPath, value);
    if (dependency.sourceFileName) current.sourceFileNames.add(dependency.sourceFileName);
    current.dependencyIds.push(dependency.id);
    if (dependency.kind === 'default_access_filter' || dependency.kind === 'default_required_grants') {
      current.warnings.push('This patch adds a model-wide default permission rule; validate every affected destination topic before merge.');
    }
    grouped.set(targetFileName, current);
  }

  return [...grouped.entries()].map(([targetFileName, group]) => ({
    targetFileName,
    sourceFileNames: [...group.sourceFileNames].sort(),
    currentYaml: input.targetFiles[targetFileName],
    recommendedYaml: stringify(group.root, { lineWidth: 0 }).trimEnd() + '\n',
    dependencyIds: group.dependencyIds,
    warnings: [...new Set(group.warnings)],
  }));
}

export function migrationPermissionDecisionStatus(
  dependency: MigrationPermissionDependency,
  decision?: MigrationPermissionDecision,
): MigrationPermissionStatus {
  const blocker = validateDecision(dependency, decision);
  if (blocker) return dependency.status === 'warning' ? 'warning' : 'blocked';
  if (decision?.action === 'ignore_with_waiver') return 'warning';
  if (decision?.action === 'manual_prerequisite') return 'warning';
  return 'ready';
}

export function permissionDependencyUsesSemanticYaml(dependency: MigrationPermissionDependency): boolean {
  return SECURITY_KEYS.has(dependency.sourcePath?.[dependency.sourcePath.length - 1] || '')
    || dependency.kind === 'access_grant'
    || dependency.kind === 'field_required_grants'
    || dependency.kind === 'field_mask_grants';
}

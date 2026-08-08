export type SemanticSolutionGoal =
  | 'build_new_topic'
  | 'improve_existing_topic'
  | 'advanced_single_file';

export type SemanticArtifactKind =
  | 'model'
  | 'view'
  | 'query_view'
  | 'relationships'
  | 'topic'
  | 'permissions';

export type SemanticArtifactReadiness =
  | 'ready'
  | 'needs_work'
  | 'missing'
  | 'not_required'
  | 'blocked';

export type SemanticArtifactAction = 'reuse' | 'edit' | 'create' | 'exclude';

export type SemanticPermissionIntent = 'required' | 'not_required';

export type SemanticRelationshipIntent = 'required' | 'not_required';

export interface SemanticSolutionDependencyItem {
  id: string;
  kind: SemanticArtifactKind;
  fileName: string;
  readiness: SemanticArtifactReadiness;
  action: SemanticArtifactAction;
  reason: string;
  dependencies: string[];
  required: boolean;
  requested: boolean;
  exists: boolean;
}

export interface SemanticSolutionPlanSummary {
  total: number;
  byReadiness: Record<SemanticArtifactReadiness, number>;
  byAction: Record<SemanticArtifactAction, number>;
}

export interface SemanticSolutionDependencyPlan {
  goal: SemanticSolutionGoal;
  topicName?: string;
  topicFileName?: string;
  items: SemanticSolutionDependencyItem[];
  summary: SemanticSolutionPlanSummary;
  blocked: boolean;
  blockers: string[];
}

export interface SemanticSolutionPlannerInput {
  goal: SemanticSolutionGoal;
  modelYamlFiles: Record<string, string>;
  selectedTopicName?: string;
  plannedTopicFileName?: string;
  requestedArtifactFileNames?: string[];
  excludedArtifactFileNames?: string[];
  relationshipIntent?: SemanticRelationshipIntent;
  permissionIntent?: SemanticPermissionIntent;
  actionOverrides?: Readonly<Record<string, SemanticArtifactAction>>;
}

export type SemanticSolutionArtifactKind = SemanticArtifactKind;
export type SemanticSolutionReadiness = SemanticArtifactReadiness;
export type SemanticSolutionAction = SemanticArtifactAction;
export type SemanticDependencyItem = SemanticSolutionDependencyItem;
export type SemanticDependencyPlan = SemanticSolutionDependencyPlan;
export type SemanticSolutionPlan = SemanticSolutionDependencyPlan;
export type BuildSemanticSolutionPlanInput = SemanticSolutionPlannerInput;

type FileResolution =
  | { status: 'found'; fileName: string }
  | { status: 'missing' }
  | { status: 'unsafe' }
  | { status: 'ambiguous'; candidates: string[] };

type InventoryEntry = {
  fileName: string;
  kind: SemanticArtifactKind;
};

type ArtifactRequest = {
  rawFileName: string;
  fileName: string;
  kind: SemanticArtifactKind;
  safe: boolean;
  resolution: FileResolution;
};

const KIND_ORDER: Record<SemanticArtifactKind, number> = {
  model: 0,
  view: 1,
  query_view: 2,
  relationships: 3,
  topic: 4,
  permissions: 5,
};

const READINESS_VALUES: SemanticArtifactReadiness[] = [
  'ready',
  'needs_work',
  'missing',
  'not_required',
  'blocked',
];

const ACTION_VALUES: SemanticArtifactAction[] = ['reuse', 'edit', 'create', 'exclude'];

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function normalizeFileName(value: string): string {
  return value.trim().replace(/\\/g, '/');
}

function fileLeaf(value: string): string {
  const parts = normalizeFileName(value).split('/');
  return parts[parts.length - 1] || '';
}

function topicStem(value: string): string {
  const leaf = fileLeaf(value);
  return leaf.toLowerCase().endsWith('.topic') ? leaf.slice(0, -'.topic'.length) : leaf;
}

function topicLookupKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  values.forEach((value) => {
    const clean = value.trim();
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    result.push(clean);
  });
  return result;
}

export function semanticArtifactKindForFileName(value: string): SemanticArtifactKind | null {
  const normalized = normalizeFileName(value);
  const lower = normalized.toLowerCase();
  const leaf = fileLeaf(normalized);
  const lowerLeaf = leaf.toLowerCase();

  if (lower === 'model') return 'model';
  if (lower === 'relationships') return 'relationships';
  if (lower === 'permissions') return 'permissions';
  if (lowerLeaf.endsWith('.query.view') && leaf.length > '.query.view'.length) return 'query_view';
  if (lowerLeaf.endsWith('.view') && leaf.length > '.view'.length) return 'view';
  if (lowerLeaf.endsWith('.topic') && leaf.length > '.topic'.length) return 'topic';
  return null;
}

export function isSafeSemanticSolutionFileName(value: string): boolean {
  const normalized = normalizeFileName(value);
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) return false;
  if (!semanticArtifactKindForFileName(normalized)) return false;
  if (normalized.includes('%') || Array.from(normalized).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  })) return false;

  return normalized.split('/').every((segment) => (
    Boolean(segment)
    && segment !== '.'
    && segment !== '..'
    && segment === segment.trim()
    && /^[A-Za-z0-9_. -]+$/.test(segment)
  ));
}

function stableId(kind: SemanticArtifactKind, fileName: string): string {
  return `${kind}:${normalizeFileName(fileName).toLowerCase()}`;
}

function inventoryFromFiles(files: Record<string, string>): InventoryEntry[] {
  return Object.keys(files)
    .map((fileName) => {
      const normalized = normalizeFileName(fileName);
      const kind = semanticArtifactKindForFileName(normalized);
      return kind && isSafeSemanticSolutionFileName(normalized)
        ? { fileName: normalized, kind }
        : null;
    })
    .filter((entry): entry is InventoryEntry => Boolean(entry))
    .sort((left, right) => compareText(left.fileName.toLowerCase(), right.fileName.toLowerCase()));
}

function resolveFile(
  requestedFileName: string,
  kind: SemanticArtifactKind,
  inventory: InventoryEntry[],
): FileResolution {
  const normalized = normalizeFileName(requestedFileName);
  if (!isSafeSemanticSolutionFileName(normalized)) return { status: 'unsafe' };

  const compatible = inventory.filter((entry) => entry.kind === kind);
  const requestedLower = normalized.toLowerCase();
  const requestedLeaf = fileLeaf(normalized);
  const requestedLeafLower = requestedLeaf.toLowerCase();
  const matchGroups = [
    compatible.filter((entry) => entry.fileName === normalized),
    compatible.filter((entry) => entry.fileName.toLowerCase() === requestedLower),
    compatible.filter((entry) => fileLeaf(entry.fileName) === requestedLeaf),
    compatible.filter((entry) => fileLeaf(entry.fileName).toLowerCase() === requestedLeafLower),
  ];

  for (const matches of matchGroups) {
    if (matches.length === 1) return { status: 'found', fileName: matches[0].fileName };
    if (matches.length > 1) {
      return {
        status: 'ambiguous',
        candidates: matches.map((entry) => entry.fileName).sort(compareText),
      };
    }
  }

  return { status: 'missing' };
}

function requestRecords(
  fileNames: string[],
  inventory: InventoryEntry[],
  unsupportedReasons: string[],
): ArtifactRequest[] {
  const byId = new Map<string, ArtifactRequest>();
  fileNames.forEach((rawFileName) => {
    const fileName = normalizeFileName(rawFileName);
    const kind = semanticArtifactKindForFileName(fileName);
    if (!kind) {
      unsupportedReasons.push(
        `Requested artifact "${rawFileName}" is not a supported semantic filename.`,
      );
      return;
    }

    const safe = isSafeSemanticSolutionFileName(fileName);
    const resolution = safe ? resolveFile(fileName, kind, inventory) : { status: 'unsafe' as const };
    const canonicalFileName = resolution.status === 'found' ? resolution.fileName : fileName;
    const id = stableId(kind, canonicalFileName);
    if (!byId.has(id)) {
      byId.set(id, { rawFileName, fileName: canonicalFileName, kind, safe, resolution });
    }
  });

  return [...byId.values()].sort((left, right) => (
    KIND_ORDER[left.kind] - KIND_ORDER[right.kind]
    || compareText(left.fileName.toLowerCase(), right.fileName.toLowerCase())
  ));
}

function selectedTopicResolution(
  selectedTopicName: string,
  inventory: InventoryEntry[],
): FileResolution {
  const candidates = inventory.filter((entry) => entry.kind === 'topic');
  const selected = selectedTopicName.trim();
  const selectedLower = selected.toLowerCase();
  const selectedKey = topicLookupKey(selected);
  const matchGroups = [
    candidates.filter((entry) => topicStem(entry.fileName) === selected),
    candidates.filter((entry) => topicStem(entry.fileName).toLowerCase() === selectedLower),
    candidates.filter((entry) => topicLookupKey(topicStem(entry.fileName)) === selectedKey),
  ];

  for (const matches of matchGroups) {
    if (matches.length === 1) return { status: 'found', fileName: matches[0].fileName };
    if (matches.length > 1) {
      return {
        status: 'ambiguous',
        candidates: matches.map((entry) => entry.fileName).sort(compareText),
      };
    }
  }
  return { status: 'missing' };
}

function plannedTopicFileName(topicName: string): string | null {
  const selected = topicName.trim();
  if (
    !selected
    || selected.includes('/')
    || selected.includes('\\')
    || selected.includes('..')
    || !/^[A-Za-z0-9][A-Za-z0-9 _.-]*$/.test(selected)
  ) {
    return null;
  }
  const stem = topicLookupKey(selected);
  return stem ? `${stem}.topic` : null;
}

function exclusionKeys(
  fileNames: string[],
  inventory: InventoryEntry[],
  unsafeReasons: string[],
): Set<string> {
  const keys = new Set<string>();
  fileNames.forEach((rawFileName) => {
    const fileName = normalizeFileName(rawFileName);
    const kind = semanticArtifactKindForFileName(fileName);
    if (!kind || !isSafeSemanticSolutionFileName(fileName)) {
      unsafeReasons.push(`Excluded artifact "${rawFileName}" is not a safe semantic filename.`);
      return;
    }
    const resolution = resolveFile(fileName, kind, inventory);
    const canonicalFileName = resolution.status === 'found' ? resolution.fileName : fileName;
    keys.add(stableId(kind, canonicalFileName));
  });
  return keys;
}

function reasonForUnsafe(kind: SemanticArtifactKind, fileName: string): string {
  return `Requested ${kind.replace('_', ' ')} filename "${fileName}" is unsafe; absolute paths, path traversal, and unsupported characters are blocked.`;
}

function requestedDependencyItem(
  request: ArtifactRequest,
  excludedIds: Set<string>,
): SemanticSolutionDependencyItem {
  const id = stableId(request.kind, request.fileName);
  const label = request.kind.replace('_', ' ');
  const common = {
    id,
    kind: request.kind,
    fileName: request.fileName,
    dependencies: [],
    required: true,
    requested: true,
  };

  if (!request.safe || request.resolution.status === 'unsafe') {
    return {
      ...common,
      readiness: 'blocked',
      action: 'exclude',
      reason: reasonForUnsafe(request.kind, request.rawFileName),
      exists: false,
    };
  }
  if (request.resolution.status === 'ambiguous') {
    return {
      ...common,
      readiness: 'blocked',
      action: 'exclude',
      reason: `Requested ${label} "${request.rawFileName}" matches more than one authored file: ${request.resolution.candidates.join(', ')}.`,
      exists: false,
    };
  }
  if (excludedIds.has(id)) {
    return {
      ...common,
      readiness: 'blocked',
      action: 'exclude',
      reason: `Required ${label} "${request.fileName}" was explicitly excluded.`,
      exists: request.resolution.status === 'found',
    };
  }
  if (request.resolution.status === 'found') {
    return {
      ...common,
      readiness: 'needs_work',
      action: 'edit',
      reason: `Existing ${label} "${request.fileName}" was explicitly requested and needs review before editing.`,
      exists: true,
    };
  }
  return {
    ...common,
    readiness: 'missing',
    action: 'create',
    reason: `Requested ${label} "${request.fileName}" does not exist and must be created.`,
    exists: false,
  };
}

function modelItem(
  requests: ArtifactRequest[],
  inventory: InventoryEntry[],
  excludedIds: Set<string>,
): SemanticSolutionDependencyItem {
  const request = requests.find((candidate) => candidate.kind === 'model');
  const resolution = resolveFile('model', 'model', inventory);
  const fileName = resolution.status === 'found' ? resolution.fileName : 'model';
  const id = stableId('model', fileName);
  const common = {
    id,
    kind: 'model' as const,
    fileName,
    dependencies: [],
    required: true,
    requested: Boolean(request),
  };

  if (excludedIds.has(id)) {
    return {
      ...common,
      readiness: 'blocked',
      action: 'exclude',
      reason: 'Settings/model is required by every semantic solution and was explicitly excluded.',
      exists: resolution.status === 'found',
    };
  }
  if (resolution.status === 'ambiguous') {
    return {
      ...common,
      readiness: 'blocked',
      action: 'exclude',
      reason: `Settings/model is ambiguous across authored files: ${resolution.candidates.join(', ')}.`,
      exists: false,
    };
  }
  if (resolution.status === 'found') {
    return request
      ? {
          ...common,
          readiness: 'needs_work',
          action: 'edit',
          reason: 'Settings/model was explicitly requested and needs review before editing.',
          exists: true,
        }
      : {
          ...common,
          readiness: 'ready',
          action: 'reuse',
          reason: 'Settings/model exists and is ready to reuse.',
          exists: true,
        };
  }
  if (request) {
    return {
      ...common,
      readiness: 'missing',
      action: 'create',
      reason: 'Requested Settings/model YAML is missing and must be created.',
      exists: false,
    };
  }
  return {
    ...common,
    readiness: 'blocked',
    action: 'exclude',
    reason: 'Settings/model YAML is missing; a selected shared model is required before planning a topic.',
    exists: false,
  };
}

function relationshipsItem(
  request: ArtifactRequest | undefined,
  inventory: InventoryEntry[],
  excludedIds: Set<string>,
  relationshipIntent: SemanticRelationshipIntent,
): SemanticSolutionDependencyItem {
  const resolution = resolveFile('relationships', 'relationships', inventory);
  const fileName = resolution.status === 'found' ? resolution.fileName : 'relationships';
  const id = stableId('relationships', fileName);
  const required = Boolean(request) || relationshipIntent === 'required';
  const common = {
    id,
    kind: 'relationships' as const,
    fileName,
    dependencies: [],
    required,
    requested: required,
  };

  if (required && excludedIds.has(id)) {
    return {
      ...common,
      readiness: 'blocked',
      action: 'exclude',
      reason: 'The required relationships artifact was explicitly excluded.',
      exists: resolution.status === 'found',
    };
  }
  if (required && resolution.status === 'ambiguous') {
    return {
      ...common,
      readiness: 'blocked',
      action: 'exclude',
      reason: `The required relationships artifact is ambiguous: ${resolution.candidates.join(', ')}.`,
      exists: false,
    };
  }
  if (required && resolution.status === 'found') {
    return {
      ...common,
      readiness: 'needs_work',
      action: 'edit',
      reason: request
        ? 'Existing global relationships YAML was explicitly requested and needs review before editing.'
        : 'The guided topic solution requires a reusable relationship review. Preserve existing joins and add only confirmed relationship edges.',
      exists: true,
    };
  }
  if (required) {
    return {
      ...common,
      readiness: 'missing',
      action: 'create',
      reason: request
        ? 'Requested global relationships YAML is missing. Create it only from confirmed endpoints, join SQL, relationship type, and cardinality.'
        : 'The guided topic solution requires reusable relationship YAML, but no authored file exists. Create it only from confirmed endpoints, join SQL, relationship type, and cardinality.',
      exists: false,
    };
  }
  if (excludedIds.has(id)) {
    return {
      ...common,
      readiness: 'not_required',
      action: 'exclude',
      reason: 'Relationships were excluded and are not required by this plan.',
      exists: resolution.status === 'found',
    };
  }
  if (resolution.status === 'found') {
    return {
      ...common,
      readiness: 'ready',
      action: 'reuse',
      reason: 'The existing global relationships file will be reused. No relationship YAML will be generated unless this decision is changed to Update.',
      exists: true,
    };
  }
  return {
    ...common,
    readiness: 'not_required',
    action: 'exclude',
    reason: 'No global relationship change is planned. Topic-local joins may remain in the topic; add a relationships artifact only after the exact join contract is confirmed.',
    exists: false,
  };
}

function topicTarget(
  input: SemanticSolutionPlannerInput,
  requests: ArtifactRequest[],
  inventory: InventoryEntry[],
  blockingReasons: string[],
): { topicName?: string; requestedFileName?: string; resolution?: FileResolution } {
  const selectedTopicName = input.selectedTopicName?.trim();
  const requestedTopics = requests.filter((request) => request.kind === 'topic');
  let requestedFileName = input.plannedTopicFileName?.trim();
  let resolution: FileResolution | undefined;

  if (!requestedFileName && selectedTopicName && input.goal !== 'build_new_topic') {
    resolution = selectedTopicResolution(selectedTopicName, inventory);
    if (resolution.status === 'found') requestedFileName = resolution.fileName;
    if (resolution.status === 'ambiguous') {
      blockingReasons.push(
        `Selected topic "${selectedTopicName}" matches more than one authored file: ${resolution.candidates.join(', ')}.`,
      );
    }
  }
  if (!requestedFileName && selectedTopicName) {
    requestedFileName = plannedTopicFileName(selectedTopicName) || undefined;
    if (!requestedFileName) {
      blockingReasons.push(`Selected topic name "${selectedTopicName}" cannot be converted to a safe topic filename.`);
    }
  }
  if (!requestedFileName && requestedTopics.length > 0) requestedFileName = requestedTopics[0].fileName;

  if (requestedTopics.length > 1) {
    blockingReasons.push('A semantic solution plan may target only one topic file.');
  }
  if (requestedFileName) {
    const kind = semanticArtifactKindForFileName(requestedFileName);
    if (kind !== 'topic' || !isSafeSemanticSolutionFileName(requestedFileName)) {
      blockingReasons.push(`Planned topic filename "${requestedFileName}" is unsafe or is not a .topic file.`);
      resolution = { status: 'unsafe' };
    } else if (!resolution || resolution.status !== 'found') {
      resolution = resolveFile(requestedFileName, 'topic', inventory);
    }
  }

  if (requestedFileName && requestedTopics.some((request) => (
    stableId('topic', request.fileName) !== stableId('topic', (
      resolution?.status === 'found' ? resolution.fileName : requestedFileName as string
    ))
  ))) {
    blockingReasons.push('A requested topic artifact does not match the selected or planned topic.');
  }

  return {
    topicName: selectedTopicName || (requestedFileName ? topicStem(requestedFileName) : undefined),
    requestedFileName,
    resolution,
  };
}

function topicItem(
  input: SemanticSolutionPlannerInput,
  target: ReturnType<typeof topicTarget>,
  upstream: SemanticSolutionDependencyItem[],
  excludedIds: Set<string>,
  blockingReasons: string[],
  permissionRequired: boolean,
): SemanticSolutionDependencyItem | null {
  const topicExpected = input.goal !== 'advanced_single_file'
    || Boolean(target.requestedFileName)
    || permissionRequired;
  if (!topicExpected) return null;

  const requestedFileName = target.requestedFileName || 'topic.topic';
  const resolution = target.resolution || { status: 'missing' as const };
  const fileName = resolution.status === 'found' ? resolution.fileName : normalizeFileName(requestedFileName);
  const id = stableId('topic', fileName);
  const dependencies = upstream.map((item) => item.id);
  const common = {
    id,
    kind: 'topic' as const,
    fileName,
    dependencies,
    required: true,
    requested: true,
  };
  let item: SemanticSolutionDependencyItem;

  if (!target.requestedFileName) {
    item = {
      ...common,
      readiness: 'blocked',
      action: 'exclude',
      reason: 'A selected topic name or planned topic filename is required.',
      exists: false,
    };
  } else if (resolution.status === 'unsafe') {
    item = {
      ...common,
      readiness: 'blocked',
      action: 'exclude',
      reason: reasonForUnsafe('topic', requestedFileName),
      exists: false,
    };
  } else if (resolution.status === 'ambiguous') {
    item = {
      ...common,
      readiness: 'blocked',
      action: 'exclude',
      reason: `Topic "${requestedFileName}" matches more than one authored file: ${resolution.candidates.join(', ')}.`,
      exists: false,
    };
  } else if (excludedIds.has(id)) {
    item = {
      ...common,
      readiness: 'blocked',
      action: 'exclude',
      reason: `Required topic "${fileName}" was explicitly excluded.`,
      exists: resolution.status === 'found',
    };
  } else if (input.goal === 'build_new_topic' && resolution.status === 'found') {
    item = {
      ...common,
      readiness: 'blocked',
      action: 'exclude',
      reason: `Topic "${fileName}" already exists, so build_new_topic will not overwrite it.`,
      exists: true,
    };
  } else if (input.goal === 'improve_existing_topic' && resolution.status !== 'found') {
    item = {
      ...common,
      readiness: 'blocked',
      action: 'exclude',
      reason: `Topic "${fileName}" does not exist, so it cannot be improved in place.`,
      exists: false,
    };
  } else if (resolution.status === 'found') {
    item = {
      ...common,
      readiness: 'needs_work',
      action: 'edit',
      reason: `Existing topic "${fileName}" needs review before editing.`,
      exists: true,
    };
  } else {
    item = {
      ...common,
      readiness: 'missing',
      action: 'create',
      reason: `Planned topic "${fileName}" does not exist and must be created.`,
      exists: false,
    };
  }

  const excludedOrBlocked = upstream.filter((dependency) => (
    dependency.action === 'exclude' || dependency.readiness === 'blocked'
  ));
  const dependencyReasons = excludedOrBlocked.map((dependency) => (
    `Required ${dependency.kind.replace('_', ' ')} "${dependency.fileName}" is excluded or blocked.`
  ));
  const propagatedReasons = unique([...blockingReasons, ...dependencyReasons]);
  if (propagatedReasons.length > 0) {
    return {
      ...item,
      readiness: 'blocked',
      action: 'exclude',
      reason: unique([item.reason, ...propagatedReasons]).join(' '),
    };
  }
  return item;
}

function permissionsItem(
  required: boolean,
  requested: boolean,
  model: SemanticSolutionDependencyItem,
  topic: SemanticSolutionDependencyItem | null,
  excludedIds: Set<string>,
): SemanticSolutionDependencyItem {
  const id = stableId('permissions', 'permissions');
  const dependencies = [model.id, ...(topic ? [topic.id] : [])];
  const common = {
    id,
    kind: 'permissions' as const,
    fileName: 'permissions',
    dependencies,
    required,
    requested,
    exists: false,
  };

  if (!required) {
    return {
      ...common,
      readiness: 'not_required',
      action: 'exclude',
      reason: 'No permission change was requested for this solution.',
    };
  }
  if (excludedIds.has(id)) {
    return {
      ...common,
      readiness: 'blocked',
      action: 'exclude',
      reason: 'Permission work was required but explicitly excluded.',
    };
  }
  const blockedDependencies = [model, topic].filter((dependency) => (
    dependency && (dependency.action === 'exclude' || dependency.readiness === 'blocked')
  )) as SemanticSolutionDependencyItem[];
  if (!topic || blockedDependencies.length > 0) {
    const labels = blockedDependencies.map((dependency) => `"${dependency.fileName}"`).join(', ');
    return {
      ...common,
      readiness: 'blocked',
      action: 'exclude',
      reason: !topic
        ? 'Permission work requires both Settings/model and a topic target.'
        : `Permission work is blocked until its model and topic dependencies are available: ${labels}.`,
    };
  }
  return {
    ...common,
    readiness: 'needs_work',
    action: 'edit',
    reason: 'Permission intent requires coordinated review of Settings/model and the topic.',
  };
}

function isSemanticArtifactAction(value: unknown): value is SemanticArtifactAction {
  return typeof value === 'string' && ACTION_VALUES.includes(value as SemanticArtifactAction);
}

function invalidActionOverride(
  item: SemanticSolutionDependencyItem,
  action: unknown,
  reason: string,
): SemanticSolutionDependencyItem {
  return {
    ...item,
    readiness: 'blocked',
    action: isSemanticArtifactAction(action) ? action : item.action,
    reason: `Action override "${String(action)}" for ${item.kind.replace('_', ' ')} "${item.fileName}" is invalid: ${reason}`,
  };
}

function applyActionOverride(
  item: SemanticSolutionDependencyItem,
  action: unknown,
  explicitlyExcluded: boolean,
): SemanticSolutionDependencyItem {
  if (!isSemanticArtifactAction(action)) {
    return invalidActionOverride(item, action, 'the action is not supported.');
  }
  if (explicitlyExcluded && action !== 'exclude') {
    return invalidActionOverride(
      item,
      action,
      'the artifact is also present in excludedArtifactFileNames and cannot be forced back into scope.',
    );
  }
  if (item.readiness === 'blocked') {
    if (action === 'exclude') {
      return {
        ...item,
        reason: `${item.reason} The explicit exclude action does not clear this blocker.`,
      };
    }
    return invalidActionOverride(
      item,
      action,
      `the dependency is already blocked. ${item.reason}`,
    );
  }

  if (item.kind === 'permissions') {
    if (item.readiness === 'not_required' && action === 'exclude') {
      return {
        ...item,
        reason: 'The user explicitly kept permission work out of scope.',
      };
    }
    if (item.readiness === 'not_required' && action === 'edit') {
      return {
        ...item,
        readiness: 'needs_work',
        action: 'edit',
        reason: 'The user explicitly requested permission work across Settings/model and the topic.',
        required: true,
        requested: true,
      };
    }
    if (item.readiness === 'needs_work' && action === 'edit') {
      return {
        ...item,
        reason: 'The user confirmed the planned permission edit across Settings/model and the topic.',
        requested: true,
      };
    }
    if (action === 'exclude' && item.required) {
      return {
        ...item,
        readiness: 'blocked',
        action: 'exclude',
        reason: 'The user excluded required permission work, so the dependency remains blocked.',
      };
    }
    return invalidActionOverride(
      item,
      action,
      'permissions are a logical model-and-topic edit and cannot be created or reused as a standalone file.',
    );
  }

  if (item.exists) {
    if (action === 'reuse' || action === 'edit') {
      return {
        ...item,
        readiness: action === 'reuse' ? 'ready' : 'needs_work',
        action,
        reason: action === 'reuse'
          ? `The user explicitly chose to reuse existing ${item.kind.replace('_', ' ')} "${item.fileName}".`
          : `The user explicitly chose to edit existing ${item.kind.replace('_', ' ')} "${item.fileName}".`,
        required: true,
        requested: true,
      };
    }
    if (action === 'exclude') {
      if (item.required) {
        return {
          ...item,
          readiness: 'blocked',
          action: 'exclude',
          reason: `The user excluded required ${item.kind.replace('_', ' ')} "${item.fileName}", so dependent work is blocked.`,
        };
      }
      return {
        ...item,
        readiness: 'not_required',
        action: 'exclude',
        reason: `The user explicitly excluded optional ${item.kind.replace('_', ' ')} "${item.fileName}".`,
      };
    }
    return invalidActionOverride(item, action, 'an existing artifact cannot be created again.');
  }

  if (item.readiness === 'not_required') {
    if (action === 'exclude') {
      return {
        ...item,
        reason: `The user explicitly kept ${item.kind.replace('_', ' ')} "${item.fileName}" out of scope.`,
      };
    }
    if (action === 'create' && item.kind === 'relationships') {
      return {
        ...item,
        readiness: 'missing',
        action: 'create',
        reason: 'The user explicitly requested creation of the missing relationships YAML.',
        required: true,
        requested: true,
      };
    }
    return invalidActionOverride(
      item,
      action,
      'this optional artifact may remain excluded or be explicitly created only when the artifact kind supports creation.',
    );
  }

  if (item.readiness === 'missing') {
    if (action === 'create') {
      return {
        ...item,
        reason: `The user confirmed creation of missing ${item.kind.replace('_', ' ')} "${item.fileName}".`,
        required: true,
        requested: true,
      };
    }
    if (action === 'exclude') {
      if (item.required) {
        return {
          ...item,
          readiness: 'blocked',
          action: 'exclude',
          reason: `The user excluded required missing ${item.kind.replace('_', ' ')} "${item.fileName}", so dependent work is blocked.`,
        };
      }
      return {
        ...item,
        readiness: 'not_required',
        action: 'exclude',
        reason: `The user explicitly excluded optional missing ${item.kind.replace('_', ' ')} "${item.fileName}".`,
      };
    }
    return invalidActionOverride(item, action, 'a missing artifact cannot be reused or edited before it is created.');
  }

  return invalidActionOverride(item, action, 'the transition is not valid for the current dependency state.');
}

function summarize(items: SemanticSolutionDependencyItem[]): SemanticSolutionPlanSummary {
  const byReadiness = Object.fromEntries(
    READINESS_VALUES.map((value) => [value, 0]),
  ) as Record<SemanticArtifactReadiness, number>;
  const byAction = Object.fromEntries(
    ACTION_VALUES.map((value) => [value, 0]),
  ) as Record<SemanticArtifactAction, number>;

  items.forEach((item) => {
    byReadiness[item.readiness] += 1;
    byAction[item.action] += 1;
  });
  return { total: items.length, byReadiness, byAction };
}

export function buildSemanticSolutionPlan(
  input: SemanticSolutionPlannerInput,
): SemanticSolutionDependencyPlan {
  const inventory = inventoryFromFiles(input.modelYamlFiles);
  const blockingReasons: string[] = [];
  const requests = requestRecords(
    input.requestedArtifactFileNames || [],
    inventory,
    blockingReasons,
  );
  const excludedIds = exclusionKeys(
    input.excludedArtifactFileNames || [],
    inventory,
    blockingReasons,
  );
  const actionOverrides: Readonly<Record<string, unknown>> = input.actionOverrides || {};
  const appliedOverrideIds = new Set<string>();
  const withActionOverride = (item: SemanticSolutionDependencyItem): SemanticSolutionDependencyItem => {
    if (!Object.prototype.hasOwnProperty.call(actionOverrides, item.id)) return item;
    appliedOverrideIds.add(item.id);
    return applyActionOverride(item, actionOverrides[item.id], excludedIds.has(item.id));
  };

  const model = withActionOverride(modelItem(requests, inventory, excludedIds));
  const requestedViews = requests
    .filter((request) => request.kind === 'view' || request.kind === 'query_view')
    .map((request) => withActionOverride(requestedDependencyItem(request, excludedIds)));
  const relationshipRequest = requests.find((request) => request.kind === 'relationships');
  const relationships = withActionOverride(
    relationshipsItem(
      relationshipRequest,
      inventory,
      excludedIds,
      input.relationshipIntent || 'not_required',
    ),
  );
  const permissionOverrideId = stableId('permissions', 'permissions');
  const permissionOverride = actionOverrides[permissionOverrideId];
  const permissionRequested = requests.some((request) => request.kind === 'permissions');
  const permissionRequired = input.permissionIntent === 'required'
    || permissionRequested
    || permissionOverride === 'edit';
  const target = topicTarget(input, requests, inventory, blockingReasons);
  const topicUpstream = [model, ...requestedViews, ...(relationships.required ? [relationships] : [])];
  const plannedTopic = topicItem(
    input,
    target,
    topicUpstream,
    excludedIds,
    blockingReasons,
    permissionRequired,
  );
  const topic = plannedTopic ? withActionOverride(plannedTopic) : null;
  const permissions = withActionOverride(permissionsItem(
    permissionRequired,
    permissionRequested || input.permissionIntent === 'required' || permissionOverride === 'edit',
    model,
    topic,
    excludedIds,
  ));

  const items = [model, ...requestedViews, relationships, ...(topic ? [topic] : []), permissions]
    .sort((left, right) => (
      KIND_ORDER[left.kind] - KIND_ORDER[right.kind]
      || compareText(left.fileName.toLowerCase(), right.fileName.toLowerCase())
      || compareText(left.id, right.id)
    ));
  Object.keys(actionOverrides)
    .sort(compareText)
    .filter((id) => !appliedOverrideIds.has(id))
    .forEach((id) => {
      blockingReasons.push(`Action override targets unknown dependency item ID "${id}".`);
    });
  const blockers = unique([
    ...blockingReasons,
    ...items.filter((item) => item.readiness === 'blocked').map((item) => item.reason),
  ]);

  return {
    goal: input.goal,
    topicName: target.topicName,
    topicFileName: topic?.fileName,
    items,
    summary: summarize(items),
    blocked: blockers.length > 0,
    blockers,
  };
}

export const planSemanticSolutionDependencies = buildSemanticSolutionPlan;

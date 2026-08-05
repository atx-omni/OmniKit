import {
  createGroup,
  createUser,
  deleteUser,
  listAllGroups,
  listAllUsers,
  listUserAttributes,
  patchGroup,
  updateUser,
} from '../omniApi';
import { parseCsvTable } from '../../utils/csvImport';

const USER_ATTRIBUTE_URN = 'urn:omni:params:1.0:UserAttribute';
const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

export type IdentityImportRecord =
  | {
      type: 'user';
      action: 'upsert' | 'delete';
      rowNumber: number;
      email: string;
      displayName: string;
      attributes: Record<string, string>;
    }
  | {
      type: 'group';
      action: 'ensure';
      rowNumber: number;
      groupName: string;
    }
  | {
      type: 'membership';
      action: 'add' | 'remove';
      rowNumber: number;
      email: string;
      groupName: string;
    };

export type IdentityImportIssue = {
  severity: 'error' | 'warning';
  message: string;
  rowNumber?: number;
};

export type IdentityImportSummary = {
  userUpserts: number;
  userDeletes: number;
  groupsEnsured: number;
  membershipsAdded: number;
  membershipsRemoved: number;
};

export type IdentityImportPlan = {
  format: 'unified' | 'legacy-users' | 'legacy-memberships';
  records: IdentityImportRecord[];
  issues: IdentityImportIssue[];
  summary: IdentityImportSummary;
};

type ScimUser = Record<string, unknown> & {
  id: string;
  userName: string;
  displayName?: string;
  active?: boolean;
};

type ScimMember = { value: string; display?: string };

type ScimGroup = Record<string, unknown> & {
  id: string;
  displayName: string;
  members?: ScimMember[];
};

export type IdentityImportPreflight = {
  plan: IdentityImportPlan;
  issues: IdentityImportIssue[];
  inventory: {
    users: ScimUser[];
    groups: ScimGroup[];
    attributeNames: string[] | null;
  };
  changes: {
    usersToCreate: number;
    usersToUpdate: number;
    usersToDelete: number;
    groupsToCreate: number;
    membershipAdds: number;
    membershipRemoves: number;
  };
};

export type IdentityImportResult = {
  status: 'succeeded' | 'skipped' | 'failed';
  stage: 'user' | 'group' | 'membership' | 'delete';
  message: string;
  rowNumbers: number[];
};

export type IdentityImportProgress = {
  completed: number;
  total: number;
  stage: string;
  message: string;
};

function normalizedHeader(value: string) {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function normalizedKey(value: string) {
  return value.trim().toLowerCase();
}

function looksLikeEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function summarize(records: IdentityImportRecord[]): IdentityImportSummary {
  return {
    userUpserts: records.filter((record) => record.type === 'user' && record.action === 'upsert').length,
    userDeletes: records.filter((record) => record.type === 'user' && record.action === 'delete').length,
    groupsEnsured: records.filter((record) => record.type === 'group').length,
    membershipsAdded: records.filter((record) => record.type === 'membership' && record.action === 'add').length,
    membershipsRemoved: records.filter((record) => record.type === 'membership' && record.action === 'remove').length,
  };
}

function deduplicateRecords(records: IdentityImportRecord[], issues: IdentityImportIssue[]) {
  const deduplicated: IdentityImportRecord[] = [];
  const seenUsers = new Map<string, IdentityImportRecord & { type: 'user' }>();
  const seenGroups = new Map<string, IdentityImportRecord & { type: 'group' }>();
  const seenMemberships = new Map<string, IdentityImportRecord & { type: 'membership' }>();

  for (const record of records) {
    if (record.type === 'user') {
      const key = normalizedKey(record.email);
      const previous = seenUsers.get(key);
      if (!previous) {
        seenUsers.set(key, record);
        deduplicated.push(record);
      } else if (previous.action !== record.action) {
        issues.push({
          severity: 'error',
          rowNumber: record.rowNumber,
          message: `Conflicting user actions for ${record.email}; row ${previous.rowNumber} uses ${previous.action}.`,
        });
      } else {
        issues.push({
          severity: 'warning',
          rowNumber: record.rowNumber,
          message: `Duplicate ${record.action} row for ${record.email} was ignored.`,
        });
      }
      continue;
    }

    if (record.type === 'group') {
      const key = normalizedKey(record.groupName);
      const previous = seenGroups.get(key);
      if (!previous) {
        seenGroups.set(key, record);
        deduplicated.push(record);
      } else {
        issues.push({
          severity: 'warning',
          rowNumber: record.rowNumber,
          message: `Duplicate ensure row for ${record.groupName} was ignored.`,
        });
      }
      continue;
    }

    const key = `${normalizedKey(record.groupName)}|${normalizedKey(record.email)}`;
    const previous = seenMemberships.get(key);
    if (!previous) {
      seenMemberships.set(key, record);
      deduplicated.push(record);
    } else if (previous.action !== record.action) {
      issues.push({
        severity: 'error',
        rowNumber: record.rowNumber,
        message: `Conflicting membership actions for ${record.email} in ${record.groupName}; row ${previous.rowNumber} uses ${previous.action}.`,
      });
    } else {
      issues.push({
        severity: 'warning',
        rowNumber: record.rowNumber,
        message: `Duplicate membership ${record.action} row for ${record.email} in ${record.groupName} was ignored.`,
      });
    }
  }

  return deduplicated;
}

export function parseIdentityImportCsv(content: string): IdentityImportPlan {
  const table = parseCsvTable(content);
  if (table.length < 2) throw new Error('CSV must include a header and at least one data row.');

  const headers = table[0].map(normalizedHeader);
  const headerIndex = new Map(headers.map((header, index) => [header, index]));
  const hasUnifiedContract = headerIndex.has('record_type') && headerIndex.has('action');
  const hasLegacyOperation = headerIndex.has('op');
  const legacyMemberships = !hasUnifiedContract && hasLegacyOperation && headerIndex.has('group_name');
  const legacyUsers = !hasUnifiedContract && hasLegacyOperation && headerIndex.has('email') && !headerIndex.has('group_name');

  if (!hasUnifiedContract && !legacyMemberships && !legacyUsers) {
    throw new Error('Use the unified record_type/action template, or a legacy user or membership CSV.');
  }

  const issues: IdentityImportIssue[] = [];
  const records: IdentityImportRecord[] = [];
  const knownUnifiedHeaders = new Set(['record_type', 'action', 'email', 'display_name', 'group_name']);
  if (hasUnifiedContract) {
    headers.forEach((header) => {
      if (header && !knownUnifiedHeaders.has(header) && !header.startsWith('attribute_')) {
        issues.push({
          severity: 'error',
          message: `Unknown column "${header}". User attribute columns must start with attribute_.`,
        });
      }
    });
  }

  const cell = (row: string[], name: string) => (row[headerIndex.get(name) ?? -1] || '').trim();

  table.slice(1).forEach((row, offset) => {
    const rowNumber = offset + 2;
    const type = hasUnifiedContract
      ? normalizedKey(cell(row, 'record_type'))
      : legacyMemberships
        ? 'membership'
        : 'user';
    const action = normalizedKey(cell(row, hasUnifiedContract ? 'action' : 'op'));
    const email = cell(row, 'email');
    const displayName = cell(row, 'display_name');
    const groupName = cell(row, 'group_name');

    if (type === 'user') {
      if (action !== 'upsert' && action !== 'delete') {
        issues.push({ severity: 'error', rowNumber, message: 'User action must be upsert or delete.' });
        return;
      }
      if (!looksLikeEmail(email)) {
        issues.push({ severity: 'error', rowNumber, message: 'User rows require a valid email address.' });
        return;
      }
      if (action === 'upsert' && !displayName) {
        issues.push({ severity: 'error', rowNumber, message: 'User upsert rows require display_name.' });
        return;
      }
      const attributes: Record<string, string> = {};
      headers.forEach((header, index) => {
        const isLegacyAttribute = legacyUsers && !['email', 'display_name', 'op'].includes(header);
        if (!header.startsWith('attribute_') && !isLegacyAttribute) return;
        const attributeName = header.startsWith('attribute_') ? header.slice('attribute_'.length) : header;
        const value = (row[index] || '').trim();
        if (attributeName && value) attributes[attributeName] = value;
      });
      records.push({ type: 'user', action, rowNumber, email, displayName, attributes });
      return;
    }

    if (type === 'group') {
      if (action !== 'ensure') {
        issues.push({ severity: 'error', rowNumber, message: 'Group action must be ensure.' });
        return;
      }
      if (!groupName) {
        issues.push({ severity: 'error', rowNumber, message: 'Group rows require group_name.' });
        return;
      }
      if (groupName.length > 64) {
        issues.push({ severity: 'error', rowNumber, message: 'Omni group names cannot exceed 64 characters.' });
        return;
      }
      records.push({ type: 'group', action: 'ensure', rowNumber, groupName });
      return;
    }

    if (type === 'membership') {
      if (action !== 'add' && action !== 'remove') {
        issues.push({ severity: 'error', rowNumber, message: 'Membership action must be add or remove.' });
        return;
      }
      if (!looksLikeEmail(email)) {
        issues.push({ severity: 'error', rowNumber, message: 'Membership rows require a valid email address.' });
        return;
      }
      if (!groupName) {
        issues.push({ severity: 'error', rowNumber, message: 'Membership rows require group_name.' });
        return;
      }
      records.push({ type: 'membership', action, rowNumber, email, groupName });
      return;
    }

    issues.push({ severity: 'error', rowNumber, message: 'record_type must be user, group, or membership.' });
  });

  const deduplicated = deduplicateRecords(records, issues);
  return {
    format: hasUnifiedContract ? 'unified' : legacyMemberships ? 'legacy-memberships' : 'legacy-users',
    records: deduplicated,
    issues,
    summary: summarize(deduplicated),
  };
}

function extractAttributeNames(payload: unknown): string[] {
  if (Array.isArray(payload)) {
    return payload.flatMap((entry) => {
      if (typeof entry === 'string') return entry.trim() ? [entry.trim()] : [];
      if (!entry || typeof entry !== 'object') return [];
      const row = entry as Record<string, unknown>;
      const name = row.name ?? row.identifier ?? row.key ?? row.attributeName ?? row.attribute_name;
      return typeof name === 'string' && name.trim() ? [name.trim()] : [];
    });
  }
  if (!payload || typeof payload !== 'object') return [];
  const row = payload as Record<string, unknown>;
  for (const key of ['userAttributes', 'user_attributes', 'attributes', 'records', 'data', 'items']) {
    if (Array.isArray(row[key])) return extractAttributeNames(row[key]);
  }
  return [];
}

function scimUsers(resources: Array<Record<string, unknown>>) {
  return resources.filter((resource): resource is ScimUser => (
    typeof resource.id === 'string' && typeof resource.userName === 'string'
  ));
}

function scimGroups(resources: Array<Record<string, unknown>>) {
  return resources.filter((resource): resource is ScimGroup => (
    typeof resource.id === 'string' && typeof resource.displayName === 'string'
  ));
}

export async function preflightIdentityImport(
  baseUrl: string,
  apiKey: string,
  plan: IdentityImportPlan,
): Promise<IdentityImportPreflight> {
  const [userResponse, groupResponse, attributeResult] = await Promise.all([
    listAllUsers(baseUrl, apiKey, { pageSize: 100, maxPages: 200 }),
    listAllGroups(baseUrl, apiKey, { pageSize: 100, maxPages: 200 }),
    listUserAttributes(baseUrl, apiKey)
      .then((payload) => ({ payload, error: null }))
      .catch((error: unknown) => ({ payload: null, error })),
  ]);

  if (userResponse.error) throw new Error(String(userResponse.error));
  if (groupResponse.error) throw new Error(String(groupResponse.error));
  if (userResponse.truncated) throw new Error('User inventory hit its safety limit. Narrow the import or raise the configured page cap before continuing.');
  if (groupResponse.truncated) throw new Error('Group inventory hit its safety limit. Narrow the import or raise the configured page cap before continuing.');

  const users = scimUsers(userResponse.Resources || []);
  const groups = scimGroups(groupResponse.Resources || []);
  const issues = [...plan.issues];
  const usersByEmail = new Map<string, ScimUser[]>();
  const groupsByName = new Map<string, ScimGroup[]>();

  users.forEach((user) => {
    const key = normalizedKey(user.userName);
    usersByEmail.set(key, [...(usersByEmail.get(key) || []), user]);
  });
  groups.forEach((group) => {
    const key = normalizedKey(group.displayName);
    groupsByName.set(key, [...(groupsByName.get(key) || []), group]);
  });

  const plannedUsers = new Set(
    plan.records
      .filter((record): record is IdentityImportRecord & { type: 'user'; action: 'upsert' } => record.type === 'user' && record.action === 'upsert')
      .map((record) => normalizedKey(record.email)),
  );
  const plannedGroups = new Set(
    plan.records
      .filter((record): record is IdentityImportRecord & { type: 'group' } => record.type === 'group')
      .map((record) => normalizedKey(record.groupName)),
  );

  plan.records.forEach((record) => {
    if (record.type === 'user') {
      const matches = usersByEmail.get(normalizedKey(record.email)) || [];
      if (matches.length > 1) {
        issues.push({ severity: 'error', rowNumber: record.rowNumber, message: `Omni returned multiple users for ${record.email}. Resolve the duplicate identity before import.` });
      } else if (record.action === 'delete' && matches.length === 0) {
        issues.push({ severity: 'warning', rowNumber: record.rowNumber, message: `${record.email} does not exist in Omni and will be skipped.` });
      }
      return;
    }
    if (record.type === 'group') {
      const matches = groupsByName.get(normalizedKey(record.groupName)) || [];
      if (matches.length > 1) {
        issues.push({ severity: 'error', rowNumber: record.rowNumber, message: `Omni returned multiple groups named ${record.groupName}. Rename the duplicates before import.` });
      }
      return;
    }
    const userMatches = usersByEmail.get(normalizedKey(record.email)) || [];
    const groupMatches = groupsByName.get(normalizedKey(record.groupName)) || [];
    if (userMatches.length === 0 && !plannedUsers.has(normalizedKey(record.email))) {
      issues.push({ severity: 'error', rowNumber: record.rowNumber, message: `${record.email} is not in Omni and has no user upsert row.` });
    }
    if (groupMatches.length === 0 && !plannedGroups.has(normalizedKey(record.groupName))) {
      issues.push({ severity: 'error', rowNumber: record.rowNumber, message: `${record.groupName} is not in Omni and has no group ensure row.` });
    }
  });

  let attributeNames: string[] | null = null;
  if (attributeResult.error) {
    issues.push({
      severity: 'warning',
      message: 'OmniKit could not validate user attribute references. The SCIM API will still validate them during import.',
    });
  } else {
    attributeNames = extractAttributeNames(attributeResult.payload);
    const knownAttributes = new Set(attributeNames.map(normalizedKey));
    const referencedAttributes = new Set(
      plan.records.flatMap((record) => record.type === 'user' ? Object.keys(record.attributes) : []),
    );
    referencedAttributes.forEach((attribute) => {
      if (!knownAttributes.has(normalizedKey(attribute))) {
        issues.push({
          severity: 'error',
          message: `User attribute "${attribute}" is not defined in Omni. Create it first or remove its attribute_ column.`,
        });
      }
    });
  }

  const usersToCreate = plan.records.filter((record) => record.type === 'user' && record.action === 'upsert' && (usersByEmail.get(normalizedKey(record.email)) || []).length === 0).length;
  const usersToUpdate = plan.records.filter((record) => record.type === 'user' && record.action === 'upsert' && (usersByEmail.get(normalizedKey(record.email)) || []).length === 1).length;
  const usersToDelete = plan.records.filter((record) => record.type === 'user' && record.action === 'delete' && (usersByEmail.get(normalizedKey(record.email)) || []).length === 1).length;
  const groupsToCreate = plan.records.filter((record) => record.type === 'group' && (groupsByName.get(normalizedKey(record.groupName)) || []).length === 0).length;

  return {
    plan,
    issues,
    inventory: { users, groups, attributeNames },
    changes: {
      usersToCreate,
      usersToUpdate,
      usersToDelete,
      groupsToCreate,
      membershipAdds: plan.summary.membershipsAdded,
      membershipRemoves: plan.summary.membershipsRemoved,
    },
  };
}

export function buildGroupMembershipPatch(
  additions: ScimMember[],
  removals: string[],
): Record<string, unknown> | null {
  const operations: Array<Record<string, unknown>> = [];
  if (additions.length > 0) operations.push({ op: 'add', path: 'members', value: additions });
  removals.forEach((userId) => {
    operations.push({ op: 'remove', path: `members[value eq "${userId}"]` });
  });
  if (operations.length === 0) return null;
  return { schemas: [PATCH_SCHEMA], Operations: operations };
}

async function withRateLimitRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/\b429\b|rate.?limit/i.test(message) || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** attempt)));
    }
  }
  throw lastError;
}

export async function executeIdentityImport(
  baseUrl: string,
  apiKey: string,
  preflight: IdentityImportPreflight,
  onProgress?: (progress: IdentityImportProgress) => void,
): Promise<IdentityImportResult[]> {
  if (preflight.issues.some((issue) => issue.severity === 'error')) {
    throw new Error('Resolve preflight errors before running the import.');
  }

  const usersByEmail = new Map(preflight.inventory.users.map((user) => [normalizedKey(user.userName), user]));
  const groupsByName = new Map(preflight.inventory.groups.map((group) => [normalizedKey(group.displayName), group]));
  const failedUsers = new Set<string>();
  const failedGroups = new Set<string>();
  const results: IdentityImportResult[] = [];
  const userUpserts = preflight.plan.records.filter((record): record is IdentityImportRecord & { type: 'user'; action: 'upsert' } => record.type === 'user' && record.action === 'upsert');
  const groupsToEnsure = preflight.plan.records.filter((record): record is IdentityImportRecord & { type: 'group' } => record.type === 'group');
  const memberships = preflight.plan.records.filter((record): record is IdentityImportRecord & { type: 'membership' } => record.type === 'membership');
  const userDeletes = preflight.plan.records.filter((record): record is IdentityImportRecord & { type: 'user'; action: 'delete' } => record.type === 'user' && record.action === 'delete');
  const membershipGroups = new Set(memberships.map((record) => normalizedKey(record.groupName)));
  const total = userUpserts.length + groupsToEnsure.length + membershipGroups.size + userDeletes.length;
  let completed = 0;

  function report(stage: string, message: string) {
    completed += 1;
    onProgress?.({ completed, total, stage, message });
  }

  for (const record of userUpserts) {
    const key = normalizedKey(record.email);
    const existing = usersByEmail.get(key);
    try {
      let response: Record<string, unknown>;
      if (existing) {
        const existingAttributes = existing[USER_ATTRIBUTE_URN];
        const attributes = {
          ...(existingAttributes && typeof existingAttributes === 'object' && !Array.isArray(existingAttributes)
            ? existingAttributes as Record<string, unknown>
            : {}),
          ...record.attributes,
        };
        response = await withRateLimitRetry(() => updateUser(baseUrl, apiKey, existing.id, {
          userName: existing.userName,
          active: existing.active !== false,
          displayName: record.displayName,
          ...(Object.keys(attributes).length > 0 ? { [USER_ATTRIBUTE_URN]: attributes } : {}),
        }));
        results.push({ status: 'succeeded', stage: 'user', message: `Updated ${record.email}.`, rowNumbers: [record.rowNumber] });
      } else {
        response = await withRateLimitRetry(() => createUser(baseUrl, apiKey, {
          userName: record.email,
          displayName: record.displayName,
          ...(Object.keys(record.attributes).length > 0 ? { [USER_ATTRIBUTE_URN]: record.attributes } : {}),
        }));
        results.push({ status: 'succeeded', stage: 'user', message: `Created ${record.email}.`, rowNumbers: [record.rowNumber] });
      }
      const id = typeof response.id === 'string' ? response.id : existing?.id;
      if (!id) throw new Error('Omni did not return a user ID.');
      usersByEmail.set(key, {
        ...(existing || {}),
        ...response,
        id,
        userName: record.email,
        displayName: record.displayName,
      });
    } catch (error) {
      failedUsers.add(key);
      results.push({
        status: 'failed',
        stage: 'user',
        message: `Failed ${record.email}: ${error instanceof Error ? error.message : String(error)}`,
        rowNumbers: [record.rowNumber],
      });
    }
    report('Users', record.email);
  }

  for (const record of groupsToEnsure) {
    const key = normalizedKey(record.groupName);
    const existing = groupsByName.get(key);
    if (existing) {
      results.push({ status: 'skipped', stage: 'group', message: `${record.groupName} already exists.`, rowNumbers: [record.rowNumber] });
      report('Groups', record.groupName);
      continue;
    }
    try {
      const response = await withRateLimitRetry(() => createGroup(baseUrl, apiKey, { displayName: record.groupName, members: [] }));
      if (typeof response.id !== 'string') throw new Error('Omni did not return a group ID.');
      groupsByName.set(key, { ...response, id: response.id, displayName: record.groupName, members: [] });
      results.push({ status: 'succeeded', stage: 'group', message: `Created group ${record.groupName}.`, rowNumbers: [record.rowNumber] });
    } catch (error) {
      failedGroups.add(key);
      results.push({
        status: 'failed',
        stage: 'group',
        message: `Failed ${record.groupName}: ${error instanceof Error ? error.message : String(error)}`,
        rowNumbers: [record.rowNumber],
      });
    }
    report('Groups', record.groupName);
  }

  const membershipsByGroup = new Map<string, Array<IdentityImportRecord & { type: 'membership' }>>();
  memberships.forEach((record) => {
    const key = normalizedKey(record.groupName);
    membershipsByGroup.set(key, [...(membershipsByGroup.get(key) || []), record]);
  });

  for (const [groupKey, groupRecords] of membershipsByGroup) {
    const group = groupsByName.get(groupKey);
    if (!group || failedGroups.has(groupKey)) {
      groupRecords.forEach((record) => results.push({ status: 'failed', stage: 'membership', message: `Skipped ${record.email}: group ${record.groupName} is unavailable.`, rowNumbers: [record.rowNumber] }));
      report('Memberships', groupRecords[0].groupName);
      continue;
    }

    const existingMemberIds = new Set((group.members || []).map((member) => member.value));
    const additions: ScimMember[] = [];
    const removals: string[] = [];
    const actionable: Array<IdentityImportRecord & { type: 'membership' }> = [];

    groupRecords.forEach((record) => {
      const userKey = normalizedKey(record.email);
      const user = usersByEmail.get(userKey);
      if (!user || failedUsers.has(userKey)) {
        results.push({ status: 'failed', stage: 'membership', message: `Skipped ${record.email}: user is unavailable.`, rowNumbers: [record.rowNumber] });
        return;
      }
      if (record.action === 'add') {
        if (existingMemberIds.has(user.id)) {
          results.push({ status: 'skipped', stage: 'membership', message: `${record.email} is already in ${record.groupName}.`, rowNumbers: [record.rowNumber] });
          return;
        }
        additions.push({ value: user.id, display: user.userName });
      } else {
        if (!existingMemberIds.has(user.id)) {
          results.push({ status: 'skipped', stage: 'membership', message: `${record.email} is not in ${record.groupName}.`, rowNumbers: [record.rowNumber] });
          return;
        }
        removals.push(user.id);
      }
      actionable.push(record);
    });

    const patch = buildGroupMembershipPatch(additions, removals);
    if (patch) {
      try {
        const response = await withRateLimitRetry(() => patchGroup(baseUrl, apiKey, group.id, patch));
        groupsByName.set(groupKey, {
          ...group,
          ...response,
          id: group.id,
          displayName: group.displayName,
          members: Array.isArray(response.members) ? response.members as ScimMember[] : group.members,
        });
        actionable.forEach((record) => results.push({
          status: 'succeeded',
          stage: 'membership',
          message: `${record.action === 'add' ? 'Added' : 'Removed'} ${record.email} ${record.action === 'add' ? 'to' : 'from'} ${record.groupName}.`,
          rowNumbers: [record.rowNumber],
        }));
      } catch (error) {
        actionable.forEach((record) => results.push({
          status: 'failed',
          stage: 'membership',
          message: `Failed ${record.email} in ${record.groupName}: ${error instanceof Error ? error.message : String(error)}`,
          rowNumbers: [record.rowNumber],
        }));
      }
    }
    report('Memberships', groupRecords[0].groupName);
  }

  for (const record of userDeletes) {
    const key = normalizedKey(record.email);
    const user = usersByEmail.get(key);
    if (!user) {
      results.push({ status: 'skipped', stage: 'delete', message: `${record.email} does not exist.`, rowNumbers: [record.rowNumber] });
      report('Deletes', record.email);
      continue;
    }
    try {
      await withRateLimitRetry(() => deleteUser(baseUrl, apiKey, user.id));
      usersByEmail.delete(key);
      results.push({ status: 'succeeded', stage: 'delete', message: `Deleted ${record.email}.`, rowNumbers: [record.rowNumber] });
    } catch (error) {
      results.push({
        status: 'failed',
        stage: 'delete',
        message: `Failed to delete ${record.email}: ${error instanceof Error ? error.message : String(error)}`,
        rowNumbers: [record.rowNumber],
      });
    }
    report('Deletes', record.email);
  }

  return results;
}

export const IDENTITY_IMPORT_TEMPLATE: string[][] = [
  ['record_type', 'action', 'email', 'display_name', 'group_name', 'attribute_department', 'attribute_role'],
  ['user', 'upsert', 'analyst@example.com', 'Example Analyst', '', '', ''],
  ['group', 'ensure', '', '', 'Analytics Users', '', ''],
  ['membership', 'add', 'analyst@example.com', '', 'Analytics Users', '', ''],
  ['membership', 'remove', 'former.analyst@example.com', '', 'Legacy Users', '', ''],
  ['user', 'delete', 'departed.user@example.com', '', '', '', ''],
];

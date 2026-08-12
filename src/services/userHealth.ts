import type {
  EmbedUserMetricRecord,
  InstanceEmbedUserStats,
} from './opsConsole';

export const USER_HEALTH_EXPECTED_INACTIVE_STORAGE_KEY = 'omnikit:userHealthExpectedInactive:v1';

export type UserHealthFinding = 'active' | 'no_active_users' | 'unassigned';
export type UserHealthReviewReason = 'inactive' | 'never_logged_in' | 'inactive_never_logged_in';
export type UserHealthAssignment = 'explicit_source' | 'unassigned';
export type UserHealthCoverageStatus = 'complete' | 'partial' | 'unavailable' | 'not_scanned';
export type UserHealthProvenance = 'live_scan' | 'browser_cache' | 'unknown';
export type UserHealthSourceFailureReason = 'unauthorized' | 'unsupported' | 'unavailable' | 'failed';

export interface UserHealthBuildContext {
  asOf?: string | null;
  provenance?: UserHealthProvenance;
}

export interface UserHealthEntityRow {
  key: string;
  instanceId: string;
  instanceLabel: string;
  baseUrl: string;
  entityName: string;
  assignment: UserHealthAssignment;
  totalUsers: number;
  activeUsers: number;
  inactiveUsers: number;
  neverLoggedInUsers: number;
  lastLogin?: string | null;
  finding: UserHealthFinding;
  expectedInactive: boolean;
  actionNeeded: boolean;
}

export interface UserHealthInactiveUserRow {
  key: string;
  instanceId: string;
  instanceLabel: string;
  entityName: string;
  assignment: UserHealthAssignment;
  userId: string;
  userName: string;
  displayName: string;
  active: boolean;
  lastLogin?: string | null;
  expectedInactive: boolean;
  reason: UserHealthReviewReason;
}

export interface UserHealthSummary {
  reportingInstances: number;
  unavailableInstances: number;
  totalEntities: number;
  actionNeededEntities: number;
  noActiveUserEntities: number;
  expectedInactiveEntities: number;
  unassignedUsers: number;
  inactiveUsers: number;
  neverLoggedInUsers: number;
  lastLoginBuckets: {
    last30d: number;
    last31To90d: number;
    olderThan90d: number;
    neverLoggedIn: number;
  };
}

export interface UserHealthSourceFailure {
  instanceId: string;
  instanceLabel: string;
  baseUrl: string;
  reason: UserHealthSourceFailureReason;
  reasonCode: string;
  message: string;
}

export interface UserHealthCoverage {
  status: UserHealthCoverageStatus;
  totalInstances: number;
  reportingInstances: number;
  unavailableInstances: number;
  filteredRecords: number;
  asOf: string | null;
  provenance: UserHealthProvenance;
}

export interface UserHealthResult {
  summary: UserHealthSummary;
  entities: UserHealthEntityRow[];
  inactiveUsers: UserHealthInactiveUserRow[];
  sourceFailures: UserHealthSourceFailure[];
  coverage: UserHealthCoverage;
}

interface StoredExpectedInactiveEntities {
  version: 1;
  keys: string[];
}

interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface EntityAccumulator {
  key: string;
  instanceId: string;
  instanceLabel: string;
  baseUrl: string;
  entityName: string;
  assignment: UserHealthAssignment;
  totalUsers: number;
  activeUsers: number;
  inactiveUsers: number;
  neverLoggedInUsers: number;
  lastLogin?: string | null;
}

const UNASSIGNED_ENTITY_NAME = 'Unassigned';

function browserStorage(): KeyValueStorage | undefined {
  return typeof window === 'undefined' ? undefined : window.localStorage;
}

function normalizeEntityName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function entityHealthKey(instanceId: string, entityName: string): string {
  return `${instanceId}::${normalizeEntityName(entityName)}`;
}

function parseDate(value?: string | null): number {
  if (!value) return 0;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function latestDate(current: string | null | undefined, next: string | null | undefined): string | null | undefined {
  return parseDate(next) > parseDate(current) ? next : current;
}

function explicitEntityName(user: EmbedUserMetricRecord): string | null {
  const value = user.entityName?.trim().replace(/\s+/g, ' ');
  if (!value || normalizeEntityName(value) === normalizeEntityName(UNASSIGNED_ENTITY_NAME)) return null;
  return value;
}

function getAccumulator(
  entities: Map<string, EntityAccumulator>,
  instance: Pick<InstanceEmbedUserStats, 'instanceId' | 'instanceLabel' | 'baseUrl'>,
  entityName: string,
): EntityAccumulator {
  const key = entityHealthKey(instance.instanceId, entityName);
  const current = entities.get(key);
  if (current) return current;
  const created: EntityAccumulator = {
    key,
    instanceId: instance.instanceId,
    instanceLabel: instance.instanceLabel,
    baseUrl: instance.baseUrl,
    entityName,
    assignment: entityName === UNASSIGNED_ENTITY_NAME ? 'unassigned' : 'explicit_source',
    totalUsers: 0,
    activeUsers: 0,
    inactiveUsers: 0,
    neverLoggedInUsers: 0,
    lastLogin: null,
  };
  entities.set(key, created);
  return created;
}

function coverageStatus(totalInstances: number, unavailableInstances: number): UserHealthCoverageStatus {
  if (totalInstances === 0) return 'not_scanned';
  if (unavailableInstances === totalInstances) return 'unavailable';
  if (unavailableInstances > 0) return 'partial';
  return 'complete';
}

function rowFinding(row: EntityAccumulator): UserHealthFinding {
  if (row.assignment === 'unassigned') return 'unassigned';
  if (row.totalUsers > 0 && row.activeUsers === 0) return 'no_active_users';
  return 'active';
}

function reviewReason(user: EmbedUserMetricRecord): UserHealthReviewReason {
  if (!user.active && !user.lastLogin) return 'inactive_never_logged_in';
  if (!user.active) return 'inactive';
  return 'never_logged_in';
}

function incrementLastLoginBucket(
  buckets: UserHealthSummary['lastLoginBuckets'],
  lastLogin: string | null | undefined,
  nowMs: number,
): void {
  const loginMs = parseDate(lastLogin);
  if (!loginMs) {
    buckets.neverLoggedIn += 1;
    return;
  }
  const ageDays = Math.max(0, Math.floor((nowMs - loginMs) / 86_400_000));
  if (ageDays <= 30) buckets.last30d += 1;
  else if (ageDays <= 90) buckets.last31To90d += 1;
  else buckets.olderThan90d += 1;
}

export function readExpectedInactiveEntityKeys(storage: KeyValueStorage | undefined = browserStorage()): Set<string> {
  if (!storage) return new Set();
  try {
    const raw = storage.getItem(USER_HEALTH_EXPECTED_INACTIVE_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as Partial<StoredExpectedInactiveEntities> | string[];
    const keys = Array.isArray(parsed) ? parsed : parsed.version === 1 ? parsed.keys : [];
    return new Set((keys || []).filter((key): key is string => typeof key === 'string' && key.length > 0));
  } catch {
    return new Set();
  }
}

export function writeExpectedInactiveEntityKeys(keys: Set<string>, storage: KeyValueStorage | undefined = browserStorage()): void {
  if (!storage) return;
  const payload: StoredExpectedInactiveEntities = {
    version: 1,
    keys: [...keys].sort(),
  };
  storage.setItem(USER_HEALTH_EXPECTED_INACTIVE_STORAGE_KEY, JSON.stringify(payload));
}

export function buildUserHealth(
  embedUserStats: InstanceEmbedUserStats[],
  expectedInactiveKeys: Set<string>,
  now: Date = new Date(),
  context: UserHealthBuildContext = {},
): UserHealthResult {
  const entities = new Map<string, EntityAccumulator>();
  const inactiveUsers: UserHealthInactiveUserRow[] = [];
  const sourceFailures: UserHealthSourceFailure[] = [];
  const lastLoginBuckets: UserHealthSummary['lastLoginBuckets'] = {
    last30d: 0,
    last31To90d: 0,
    olderThan90d: 0,
    neverLoggedIn: 0,
  };
  const nowMs = now.getTime();
  let unassignedUsers = 0;
  let filteredRecords = 0;

  for (const instance of embedUserStats) {
    if (instance.error) {
      sourceFailures.push({
        instanceId: instance.instanceId,
        instanceLabel: instance.instanceLabel,
        baseUrl: instance.baseUrl,
        reason: instance.errorStatus || 'failed',
        reasonCode: instance.errorReasonCode || 'INSTANCE_READ_FAILED',
        message: instance.error,
      });
      continue;
    }

    filteredRecords += instance.filteredCount || 0;
    for (const user of instance.users || []) {
      if (user.filtered) continue;
      incrementLastLoginBucket(lastLoginBuckets, user.lastLogin, nowMs);
      const explicitName = explicitEntityName(user);
      const entityName = explicitName || UNASSIGNED_ENTITY_NAME;
      const assignment: UserHealthAssignment = explicitName ? 'explicit_source' : 'unassigned';
      if (assignment === 'unassigned') unassignedUsers += 1;
      const row = getAccumulator(entities, instance, entityName);
      row.totalUsers += 1;
      row.lastLogin = latestDate(row.lastLogin, user.lastLogin);
      if (user.active) row.activeUsers += 1;
      else row.inactiveUsers += 1;
      if (!user.lastLogin) row.neverLoggedInUsers += 1;

      if (!user.active || !user.lastLogin) {
        inactiveUsers.push({
          key: `${instance.instanceId}::${user.id || user.userName || user.displayName}`,
          instanceId: instance.instanceId,
          instanceLabel: instance.instanceLabel,
          entityName,
          assignment,
          userId: user.id,
          userName: user.userName,
          displayName: user.displayName,
          active: user.active,
          lastLogin: user.lastLogin,
          expectedInactive: assignment === 'explicit_source' && expectedInactiveKeys.has(row.key),
          reason: reviewReason(user),
        });
      }
    }
  }

  const rows = [...entities.values()].map((row): UserHealthEntityRow => {
    const finding = rowFinding(row);
    const expectedInactive = row.assignment === 'explicit_source' && expectedInactiveKeys.has(row.key);
    return {
      key: row.key,
      instanceId: row.instanceId,
      instanceLabel: row.instanceLabel,
      baseUrl: row.baseUrl,
      entityName: row.entityName,
      assignment: row.assignment,
      totalUsers: row.totalUsers,
      activeUsers: row.activeUsers,
      inactiveUsers: row.inactiveUsers,
      neverLoggedInUsers: row.neverLoggedInUsers,
      lastLogin: row.lastLogin,
      finding,
      expectedInactive,
      actionNeeded: finding === 'unassigned' || (finding === 'no_active_users' && !expectedInactive),
    };
  }).sort((a, b) => {
    if (a.actionNeeded !== b.actionNeeded) return a.actionNeeded ? -1 : 1;
    if (a.finding !== b.finding) return a.finding.localeCompare(b.finding);
    return a.instanceLabel.localeCompare(b.instanceLabel) || a.entityName.localeCompare(b.entityName);
  });

  inactiveUsers.sort((a, b) => {
    if (a.expectedInactive !== b.expectedInactive) return a.expectedInactive ? 1 : -1;
    return a.instanceLabel.localeCompare(b.instanceLabel)
      || a.entityName.localeCompare(b.entityName)
      || (a.displayName || a.userName).localeCompare(b.displayName || b.userName);
  });

  const totalInstances = embedUserStats.length;
  const unavailableInstances = sourceFailures.length;
  const reportingInstances = totalInstances - unavailableInstances;

  return {
    summary: {
      reportingInstances,
      unavailableInstances,
      totalEntities: rows.length,
      actionNeededEntities: rows.filter((row) => row.actionNeeded).length,
      noActiveUserEntities: rows.filter((row) => row.finding === 'no_active_users').length,
      expectedInactiveEntities: rows.filter((row) => row.expectedInactive).length,
      unassignedUsers,
      inactiveUsers: inactiveUsers.filter((user) => !user.active).length,
      neverLoggedInUsers: inactiveUsers.filter((user) => !user.lastLogin).length,
      lastLoginBuckets,
    },
    entities: rows,
    inactiveUsers,
    sourceFailures,
    coverage: {
      status: coverageStatus(totalInstances, unavailableInstances),
      totalInstances,
      reportingInstances,
      unavailableInstances,
      filteredRecords,
      asOf: context.asOf || null,
      provenance: context.provenance || 'unknown',
    },
  };
}

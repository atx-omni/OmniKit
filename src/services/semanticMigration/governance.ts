import type { SourceInventory, SourceInventoryItem } from './studioApi';
import type { MigrationDecision } from './types';
import type { MigrationValidationCheck } from './validation';
import { migrationDecisionSemanticKey } from './decisionIdentity';

export type MigrationGovernanceCategory = 'identity' | 'permission' | 'schedule';
export type MigrationGovernanceDisposition = 'map' | 'redesign' | 'defer' | 'exclude';

export interface MigrationGovernanceItem {
  id: string;
  category: MigrationGovernanceCategory;
  sourceRef: string;
  label: string;
  owner?: string;
  details: string[];
  coverage: 'explicit' | 'coverage_gap';
  required: boolean;
}

export interface MigrationGovernanceResolution {
  itemId: string;
  disposition: MigrationGovernanceDisposition | '';
  owner: string;
  targetRef: string;
  reason: string;
  approved: boolean;
}

function cleanDetail(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return undefined;
  const cleaned = String(value).replace(/[\r\n]+/g, ' ').trim().slice(0, 240);
  return cleaned || undefined;
}

function itemCategory(item: SourceInventoryItem): MigrationGovernanceCategory | null {
  if (item.kind === 'permission') return 'permission';
  if (item.kind === 'schedule') return 'schedule';
  return null;
}

function decisionCategory(decision: MigrationDecision): MigrationGovernanceCategory | null {
  if (decision.domain === 'schedule') return 'schedule';
  if (decision.domain === 'permission') return 'permission';
  if (decision.domain === 'user' || decision.domain === 'group') return 'identity';
  return null;
}

function addItem(items: Map<string, MigrationGovernanceItem>, item: MigrationGovernanceItem): void {
  const key = `${item.category}:${item.sourceRef}`;
  const existing = items.get(key);
  if (!existing) {
    items.set(key, item);
    return;
  }
  items.set(key, {
    ...existing,
    owner: existing.owner || item.owner,
    required: existing.required || item.required,
    details: Array.from(new Set([...existing.details, ...item.details])),
  });
}

export function buildMigrationGovernanceChecklist(input: {
  sourceInventory?: SourceInventory | null;
  sourceItems?: SourceInventoryItem[];
  decisions?: MigrationDecision[];
}): MigrationGovernanceItem[] {
  const items = new Map<string, MigrationGovernanceItem>();
  const sourceItems = input.sourceItems || input.sourceInventory?.items || [];

  sourceItems.forEach((sourceItem) => {
    const category = itemCategory(sourceItem);
    if (!category) return;
    const metadataDetails = Object.entries(sourceItem.metadata || {})
      .filter(([key]) => /recipient|group|user|role|filter|timezone|frequency|schedule|permission/i.test(key))
      .flatMap(([key, value]) => {
        const detail = cleanDetail(value);
        return detail ? [`${key}: ${detail}`] : [];
      });
    addItem(items, {
      id: `governance:${category}:${sourceItem.id}`,
      category,
      sourceRef: sourceItem.id,
      label: sourceItem.name,
      owner: sourceItem.owner,
      details: Array.from(new Set([sourceItem.path, ...sourceItem.riskFlags, ...metadataDetails].flatMap((value) => cleanDetail(value) || []))),
      coverage: 'explicit',
      required: true,
    });
  });

  (input.decisions || []).forEach((decision) => {
    const category = decisionCategory(decision);
    if (!category) return;
    const semanticKey = migrationDecisionSemanticKey(decision);
    addItem(items, {
      id: `governance:${category}:${semanticKey}`,
      category,
      sourceRef: semanticKey,
      label: decision.sourceLabel,
      details: Array.from(new Set([
        `Source lineage: ${decision.nodeId}`,
        decision.rationale,
        ...decision.evidence.map((evidence) => evidence.locator || evidence.sourceId || evidence.artifactId),
      ].flatMap((value) => cleanDetail(value) || []))),
      coverage: 'explicit',
      required: decision.blocking,
    });
  });

  const connector = input.sourceInventory?.connector;
  if (connector) {
    const permissionCoverage = connector.migrationCoverage?.permissions;
    if (permissionCoverage !== 'full' || !connector.capabilities.permissions) {
      addItem(items, {
        id: 'governance:permission:coverage-gap',
        category: 'permission',
        sourceRef: 'connector:permissions',
        label: `${connector.label} permission coverage`,
        details: [`Connector coverage: ${permissionCoverage || 'not declared'}.`, 'Confirm owners, groups, row policies, folder access, and unresolved identities outside the automated import.'],
        coverage: 'coverage_gap',
        required: true,
      });
    }
    const scheduleCoverage = connector.migrationCoverage?.schedules;
    if (scheduleCoverage !== 'full' || !connector.capabilities.schedules) {
      addItem(items, {
        id: 'governance:schedule:coverage-gap',
        category: 'schedule',
        sourceRef: 'connector:schedules',
        label: `${connector.label} schedule coverage`,
        details: [`Connector coverage: ${scheduleCoverage || 'not declared'}.`, 'Confirm recipients, delivery destinations, filters, time zones, and refresh ownership outside the automated import.'],
        coverage: 'coverage_gap',
        required: true,
      });
    }
  }

  return Array.from(items.values()).sort((a, b) => a.category.localeCompare(b.category) || a.label.localeCompare(b.label));
}

export function reconcileMigrationGovernanceResolutions(
  items: MigrationGovernanceItem[],
  current: Record<string, MigrationGovernanceResolution>,
): Record<string, MigrationGovernanceResolution> {
  const next = Object.fromEntries(items.map((item) => [item.id, current[item.id] || {
    itemId: item.id,
    disposition: '',
    owner: item.owner || '',
    targetRef: '',
    reason: '',
    approved: false,
  }]));
  const currentKeys = Object.keys(current);
  const nextKeys = Object.keys(next);
  if (
    currentKeys.length === nextKeys.length
    && nextKeys.every((key) => current[key] === next[key])
  ) {
    return current;
  }
  return next;
}

export function migrationGovernanceResolutionIssue(
  item: MigrationGovernanceItem,
  resolution?: MigrationGovernanceResolution,
): string | null {
  if (!item.required && !resolution?.disposition) return null;
  if (!resolution?.disposition) return 'Choose how this governance dependency will be handled.';
  if (!resolution.owner.trim()) return 'Assign an accountable owner.';
  if (resolution.disposition === 'map' && !resolution.targetRef.trim()) return 'Enter the target user, group, policy, schedule, or operational reference.';
  if (resolution.disposition !== 'map' && !resolution.reason.trim()) return 'Document why this item will be redesigned, deferred, or excluded.';
  if (!resolution.approved) return 'Approve the reviewed governance decision.';
  return null;
}

export function buildMigrationGovernanceValidationChecks(
  items: MigrationGovernanceItem[],
  resolutions: Record<string, MigrationGovernanceResolution>,
): MigrationValidationCheck[] {
  const buildCheck = (id: 'security' | 'operational', label: string, categories: MigrationGovernanceCategory[]): MigrationValidationCheck => {
    const relevant = items.filter((item) => categories.includes(item.category));
    const unresolved = relevant.filter((item) => migrationGovernanceResolutionIssue(item, resolutions[item.id]));
    if (relevant.length === 0) {
      return { id, label, status: 'passed', blocking: true, summary: `No explicit ${label.toLowerCase()} dependencies were found in the selected source scope.`, evidence: [] };
    }
    if (unresolved.length > 0) {
      return {
        id,
        label,
        status: 'failed',
        blocking: true,
        summary: `${unresolved.length} of ${relevant.length} ${label.toLowerCase()} item${relevant.length === 1 ? '' : 's'} still require an owner-assigned decision.`,
        evidence: unresolved.slice(0, 12).map((item) => `${item.label}: ${migrationGovernanceResolutionIssue(item, resolutions[item.id])}`),
      };
    }
    return {
      id,
      label,
      status: 'passed',
      blocking: true,
      summary: `All ${relevant.length} ${label.toLowerCase()} item${relevant.length === 1 ? '' : 's'} have approved owner-assigned outcomes.`,
      evidence: relevant.map((item) => {
        const resolution = resolutions[item.id];
        if (!resolution?.disposition) return `${item.label}: optional evidence retained; no target action required.`;
        return `${item.label}: ${resolution.disposition}${resolution.targetRef ? ` -> ${resolution.targetRef}` : ''} (owner: ${resolution.owner})`;
      }).slice(0, 20),
    };
  };

  return [
    buildCheck('security', 'Security', ['identity', 'permission']),
    buildCheck('operational', 'Operations', ['schedule']),
  ];
}

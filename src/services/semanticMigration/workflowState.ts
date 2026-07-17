import type { SourceInventory } from './studioApi';
import type { MigrationBiSourceTool } from './types';

export interface MigrationSourceSessionInput {
  sourceMode: 'api' | 'manual';
  manualSourcePlatform: MigrationBiSourceTool;
  sourceConnectionId?: string;
  sourceInventory?: SourceInventory | null;
}

function sourceInventoryRevision(inventory?: SourceInventory | null) {
  if (!inventory) return 'unloaded';
  return JSON.stringify({
    platform: inventory.platform,
    connectionId: inventory.connectionId,
    truncated: inventory.truncated,
    items: inventory.items.map((item) => [
      item.id,
      item.kind,
      [...item.dependencyIds].sort(),
    ]),
    dashboards: (inventory.dashboardCatalog || []).map((dashboard) => [
      dashboard.id,
      dashboard.coverage,
      [...dashboard.dependencyIds].sort(),
    ]),
  });
}

export function migrationSourceSessionKey(input: MigrationSourceSessionInput) {
  if (input.sourceMode === 'manual') {
    return `manual:${input.manualSourcePlatform}`;
  }
  return `api:${input.sourceConnectionId || 'unselected'}:${sourceInventoryRevision(input.sourceInventory)}`;
}

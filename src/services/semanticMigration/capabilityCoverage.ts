import type { SourceMigrationCoverage, SourceMigrationCoverageStatus } from './studioApi';

export interface MigrationCapabilityCoverageRow {
  id: keyof SourceMigrationCoverage;
  label: string;
  status: SourceMigrationCoverageStatus;
  evidenceClasses: string[];
  requiresAcknowledgement: boolean;
}

const ORDER: Array<{ id: keyof SourceMigrationCoverage; label: string; engineKeys: string[] }> = [
  { id: 'semantic_objects', label: 'Semantic objects', engineKeys: ['models', 'views', 'fields', 'calculations', 'relationships', 'topics'] },
  { id: 'dashboards', label: 'Dashboards and tiles', engineKeys: ['dashboards', 'tiles'] },
  { id: 'filters', label: 'Filters', engineKeys: ['filters'] },
  { id: 'layout', label: 'Layout', engineKeys: ['layout'] },
  { id: 'permissions', label: 'Permissions', engineKeys: ['permissions'] },
  { id: 'schedules', label: 'Schedules', engineKeys: ['schedules'] },
];

const SEVERITY: Record<SourceMigrationCoverageStatus, number> = {
  full: 0,
  partial: 1,
  export_required: 2,
  unsupported: 3,
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function status(value: unknown): SourceMigrationCoverageStatus | undefined {
  return ['full', 'partial', 'export_required', 'unsupported'].includes(String(value))
    ? value as SourceMigrationCoverageStatus
    : undefined;
}

function leastComplete(values: SourceMigrationCoverageStatus[]): SourceMigrationCoverageStatus | undefined {
  return values.sort((left, right) => SEVERITY[right] - SEVERITY[left])[0];
}

export function migrationCapabilityCoverageRows(input: {
  engineCoverage?: Record<string, unknown> | null;
  connectorCoverage?: SourceMigrationCoverage | null;
}): MigrationCapabilityCoverageRow[] {
  const engineArtifacts = asRecord(asRecord(input.engineCoverage).artifact_coverage);
  return ORDER.flatMap((definition) => {
    const engineStatuses = definition.engineKeys.flatMap((key) => {
      const value = status(engineArtifacts[key]);
      return value ? [value] : [];
    });
    const resolved = leastComplete(engineStatuses) || input.connectorCoverage?.[definition.id];
    if (!resolved) return [];
    return [{
      id: definition.id,
      label: definition.label,
      status: resolved,
      evidenceClasses: definition.engineKeys.filter((key) => status(engineArtifacts[key])),
      requiresAcknowledgement: resolved !== 'full',
    }];
  });
}

export function migrationCapabilityAcknowledgementRequired(rows: MigrationCapabilityCoverageRow[]): boolean {
  return rows.some((row) => row.requiresAcknowledgement);
}

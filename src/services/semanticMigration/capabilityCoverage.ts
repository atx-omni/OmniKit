import type { SourceMigrationCoverage, SourceMigrationCoverageStatus } from './studioApi';
import type { MigrationBiSourceTool } from './types';

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

const SOURCE_BASELINE: Record<MigrationBiSourceTool, SourceMigrationCoverage> = {
  domo: { semantic_objects: 'partial', dashboards: 'partial', filters: 'partial', layout: 'unsupported', permissions: 'unsupported', schedules: 'unsupported' },
  looker: { semantic_objects: 'full', dashboards: 'partial', filters: 'partial', layout: 'partial', permissions: 'unsupported', schedules: 'unsupported' },
  metabase: { semantic_objects: 'partial', dashboards: 'full', filters: 'full', layout: 'full', permissions: 'unsupported', schedules: 'unsupported' },
  microstrategy: { semantic_objects: 'partial', dashboards: 'partial', filters: 'partial', layout: 'partial', permissions: 'unsupported', schedules: 'unsupported' },
  power_bi: { semantic_objects: 'export_required', dashboards: 'partial', filters: 'partial', layout: 'export_required', permissions: 'unsupported', schedules: 'unsupported' },
  sigma: { semantic_objects: 'partial', dashboards: 'partial', filters: 'partial', layout: 'unsupported', permissions: 'unsupported', schedules: 'unsupported' },
  tableau: { semantic_objects: 'export_required', dashboards: 'partial', filters: 'partial', layout: 'export_required', permissions: 'unsupported', schedules: 'unsupported' },
  webfocus: { semantic_objects: 'export_required', dashboards: 'partial', filters: 'partial', layout: 'unsupported', permissions: 'unsupported', schedules: 'unsupported' },
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
  sourcePlatform?: MigrationBiSourceTool;
  sourceMode?: 'api' | 'manual';
  engineCoverage?: Record<string, unknown> | null;
  connectorCoverage?: SourceMigrationCoverage | null;
}): MigrationCapabilityCoverageRow[] {
  const engineArtifacts = asRecord(asRecord(input.engineCoverage).artifact_coverage);
  const baseline = input.sourcePlatform ? SOURCE_BASELINE[input.sourcePlatform] : undefined;
  return ORDER.flatMap((definition) => {
    const engineStatuses = definition.engineKeys.flatMap((key) => {
      const value = status(engineArtifacts[key]);
      return value ? [value] : [];
    });
    const evidenceStatuses = [
      ...engineStatuses,
      input.connectorCoverage?.[definition.id],
      baseline?.[definition.id],
    ].filter((value): value is SourceMigrationCoverageStatus => Boolean(value));
    const resolved = leastComplete(evidenceStatuses);
    if (!resolved) return [];
    const evidenceClasses = [
      ...definition.engineKeys.filter((key) => status(engineArtifacts[key])),
      ...(input.connectorCoverage?.[definition.id] ? ['saved API connector'] : []),
      ...(baseline ? [`${input.sourceMode || 'source'} ${input.sourcePlatform} baseline`] : []),
    ];
    return [{
      id: definition.id,
      label: definition.label,
      status: resolved,
      evidenceClasses,
      requiresAcknowledgement: resolved !== 'full',
    }];
  });
}

export function migrationCapabilityAcknowledgementRequired(rows: MigrationCapabilityCoverageRow[]): boolean {
  return rows.some((row) => row.requiresAcknowledgement);
}

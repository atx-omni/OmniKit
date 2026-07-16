import type {
  DomoManualParseResult,
  DomoManualSourceKind,
  MigrationArtifact,
  MigrationInventory,
} from './types';

export type DomoManualUploadStep = 'add' | 'review' | 'ready';

export interface DomoManualArtifactReview {
  artifactId: string;
  name: string;
  roles: DomoManualSourceKind[];
  mappingCount: number;
  status: 'parsed' | 'unsupported';
}

export interface DomoManualUploadGate {
  ready: boolean;
  missingRequiredEvidence: Array<'dataset_schema' | 'card'>;
  reasons: string[];
}

export interface ReleasedRawSourceSummary {
  artifactCount: number;
  byteCount: number;
  fileNames: string[];
  nativeArtifactCount: number;
  engineTextArtifactCount: number;
  engineBinaryArtifactCount: number;
  engineInputKey: string;
  releasedAt: string;
}

export function migrationInventoryWithoutRawArtifactContent(inventory: MigrationInventory): MigrationInventory {
  return {
    ...inventory,
    artifacts: inventory.artifacts.map((artifact) => ({
      ...artifact,
      content: '',
    })),
  };
}

export const DOMO_MANUAL_ROLE_LABELS: Record<DomoManualSourceKind, string> = {
  dataset_schema: 'Dataset schema',
  beast_mode: 'Beast Mode',
  dataflow_sql: 'DataFlow SQL',
  relationship: 'Relationship',
  card: 'Card',
};

export function buildDomoManualArtifactReview(
  artifacts: MigrationArtifact[],
  result: DomoManualParseResult | null,
): DomoManualArtifactReview[] {
  return artifacts.map((artifact) => {
    const mappings = result?.mappings.filter((mapping) => mapping.sourceArtifact === artifact.name) || [];
    const roles = Array.from(new Set(mappings.map((mapping) => mapping.sourceKind)));
    return {
      artifactId: artifact.id,
      name: artifact.name,
      roles,
      mappingCount: mappings.length,
      status: mappings.length > 0 ? 'parsed' : 'unsupported',
    };
  });
}

export function domoManualUploadGate(input: {
  result: DomoManualParseResult | null;
  conflictsAcknowledged: boolean;
  unsupportedAcknowledged: boolean;
}): DomoManualUploadGate {
  const { result, conflictsAcknowledged, unsupportedAcknowledged } = input;
  if (!result) return { ready: false, missingRequiredEvidence: ['dataset_schema', 'card'], reasons: ['Wait for Domo parsing to finish.'] };

  const sourceKinds = new Set(result.mappings.map((mapping) => mapping.sourceKind));
  const missingRequiredEvidence = (['dataset_schema', 'card'] as const).filter((kind) => !sourceKinds.has(kind));
  const reasons: string[] = [];
  if (missingRequiredEvidence.includes('dataset_schema')) reasons.push('Add at least one Domo dataset schema so target dimensions and types can be validated.');
  if (missingRequiredEvidence.includes('card')) reasons.push('Add at least one Domo Card definition so dashboard fields, filters, and visual intent can be reviewed.');
  if (result.conflicts.length > 0 && !conflictsAcknowledged) reasons.push('Acknowledge the additive names OmniKit proposed for different same-named Beast Mode formulas.');
  if (result.diagnostics.unsupportedArtifactCount > 0 && !unsupportedAcknowledged) reasons.push('Remove unsupported files or acknowledge that they will not contribute migration evidence.');
  return { ready: reasons.length === 0, missingRequiredEvidence, reasons };
}

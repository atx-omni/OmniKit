import { artifactsFromPowerBiProjectFiles, POWER_BI_PROJECT_LIMITS } from './powerBiProjectUpload';
import type { MigrationArtifact } from './types';

export const DOMO_EVIDENCE_BUNDLE_LIMITS = POWER_BI_PROJECT_LIMITS;

function domoUploadError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(message
    .replace(/Power BI project/g, 'Domo evidence bundle')
    .replace(/Power BI files/g, 'Domo evidence files')
    .replace(/Power BI/g, 'Domo'));
}

/**
 * Uses OmniKit's bounded, CRC-checked project reader so Domo ZIP uploads receive
 * the same traversal, duplicate-path, expansion, file-count, and size controls.
 */
export async function artifactsFromDomoProjectFiles(files: FileList | File[]): Promise<MigrationArtifact[]> {
  try {
    const artifacts = await artifactsFromPowerBiProjectFiles(files);
    return artifacts.map((artifact) => ({ ...artifact, sourceTool: 'domo' as const }));
  } catch (error) {
    throw domoUploadError(error);
  }
}

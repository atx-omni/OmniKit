import { artifactFromText } from './adapters';
import { evaluateDomoGeneratedOutput } from './domoRoundTrip';
import type { DomoExpectedOmniFile, DomoGeneratedOutputReport } from './domoRoundTrip';
import type { LookerManualParseResult, MigrationArtifact, MigrationDashboardBuildPlan, SemanticMigrationFile } from './types';

export const LOOKER_WHATABURGER_EXAMPLE_ROOT = '/examples/semantic-migrations/looker-whataburger';

export type LookerRoundTripCategory = 'views' | 'explores' | 'measures' | 'relationships' | 'dashboards' | 'fieldReferences';

export interface LookerRoundTripManifest {
  schemaVersion: 'omnikit.looker.roundtrip.v1';
  name: string;
  description: string;
  targetScore: number;
  artifacts: Array<{ name: string; path: string }>;
  expectedOmniFiles: string[];
  weights: Record<LookerRoundTripCategory, number>;
  expected: Record<LookerRoundTripCategory, string[]>;
}

export interface LookerRoundTripCategoryResult {
  category: LookerRoundTripCategory;
  label: string;
  weight: number;
  expectedCount: number;
  matchedCount: number;
  coveragePercent: number;
  weightedScore: number;
  missing: string[];
}

export interface LookerRoundTripReport {
  score: number;
  targetScore: number;
  meetsTarget: boolean;
  categories: LookerRoundTripCategoryResult[];
  summary: string;
  caveat: string;
}

export interface LookerExampleBundle {
  manifest: LookerRoundTripManifest;
  artifacts: MigrationArtifact[];
  expectedOmniFiles: DomoExpectedOmniFile[];
}

const LABELS: Record<LookerRoundTripCategory, string> = {
  views: 'Views', explores: 'Explores', measures: 'Measures', relationships: 'Joins', dashboards: 'Dashboards', fieldReferences: 'Dashboard fields',
};

function normalized(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function result(category: LookerRoundTripCategory, weight: number, expected: string[], actual: Set<string>): LookerRoundTripCategoryResult {
  const uniqueExpected = Array.from(new Set(expected.map(normalized)));
  const missing = uniqueExpected.filter((item) => !actual.has(item));
  const matchedCount = uniqueExpected.length - missing.length;
  const coveragePercent = uniqueExpected.length ? Math.round((matchedCount / uniqueExpected.length) * 100) : 100;
  return { category, label: LABELS[category], weight, expectedCount: uniqueExpected.length, matchedCount, coveragePercent, weightedScore: weight * coveragePercent / 100, missing };
}

export function evaluateLookerRoundTrip(parseResult: LookerManualParseResult, manifest: LookerRoundTripManifest): LookerRoundTripReport {
  const inventory = parseResult.inventory;
  const actual: Record<LookerRoundTripCategory, Set<string>> = {
    views: new Set(inventory.views.map((view) => normalized(view.name))),
    explores: new Set(inventory.explores.map((explore) => normalized(explore.name))),
    measures: new Set(inventory.views.flatMap((view) => view.measures.map((measure) => normalized(`${view.name}.${measure.name}`)))),
    relationships: new Set(inventory.relationships.map((join) => normalized(`${join.from}.${join.to}`))),
    dashboards: new Set(inventory.dashboards.map((dashboard) => normalized(dashboard.name))),
    fieldReferences: new Set(inventory.dashboards.flatMap((dashboard) => dashboard.fields.map(normalized))),
  };
  const categories = (Object.keys(manifest.weights) as LookerRoundTripCategory[]).map((category) => result(category, manifest.weights[category], manifest.expected[category], actual[category]));
  const totalWeight = categories.reduce((sum, category) => sum + category.weight, 0) || 100;
  const score = Math.round(categories.reduce((sum, category) => sum + category.weightedScore, 0) / totalWeight * 100);
  const missingCount = categories.reduce((sum, category) => sum + category.missing.length, 0);
  return {
    score,
    targetScore: manifest.targetScore,
    meetsTarget: score >= manifest.targetScore,
    categories,
    summary: `${score}% source-evidence fidelity across ${categories.length} LookML benchmark categories${missingCount ? ` with ${missingCount} missing expectation${missingCount === 1 ? '' : 's'}` : ''}.`,
    caveat: 'This deterministic score does not certify SQL equivalence, PDT behavior, access-filter equivalence, query results, permissions, or dashboard visual fidelity.',
  };
}

export function matchesLookerExampleArtifacts(artifacts: MigrationArtifact[], manifest: LookerRoundTripManifest): boolean {
  const expected = new Set(manifest.artifacts.map((artifact) => artifact.name));
  return artifacts.length === expected.size && artifacts.every((artifact) => expected.has(artifact.name));
}

export function evaluateLookerGeneratedOutput(
  files: SemanticMigrationFile[],
  dashboardPlans: MigrationDashboardBuildPlan[],
  baselineFiles: DomoExpectedOmniFile[],
  targetScore = 90,
): DomoGeneratedOutputReport {
  return evaluateDomoGeneratedOutput(files, dashboardPlans, baselineFiles, targetScore);
}

async function fetchText(path: string): Promise<string> {
  const response = await fetch(path, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`Could not load example file ${path} (${response.status}).`);
  return response.text();
}

export async function loadLookerWhataburgerExample(): Promise<LookerExampleBundle> {
  const response = await fetch(`${LOOKER_WHATABURGER_EXAMPLE_ROOT}/manifest.json`, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`Could not load the Whataburger Looker example (${response.status}).`);
  const manifest = await response.json() as LookerRoundTripManifest;
  if (manifest.schemaVersion !== 'omnikit.looker.roundtrip.v1') throw new Error('The Whataburger Looker example is not compatible with this OmniKit version.');
  const artifacts = await Promise.all(manifest.artifacts.map(async (entry) => {
    const content = await fetchText(`${LOOKER_WHATABURGER_EXAMPLE_ROOT}/${encodeURIComponent(entry.path)}`);
    const artifact = artifactFromText('looker', content, entry.name);
    if (!artifact) throw new Error(`Example file ${entry.name} was empty.`);
    return artifact;
  }));
  const expectedOmniFiles = await Promise.all(manifest.expectedOmniFiles.map(async (fileName) => ({
    fileName,
    content: await fetchText(`${LOOKER_WHATABURGER_EXAMPLE_ROOT}/${fileName.split('/').map(encodeURIComponent).join('/')}`),
  })));
  return { manifest, artifacts, expectedOmniFiles };
}

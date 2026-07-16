import { artifactFromText } from './adapters';
import { evaluateDomoGeneratedOutput } from './domoRoundTrip';
import type { DomoExpectedOmniFile, DomoGeneratedOutputReport } from './domoRoundTrip';
import type { MigrationArtifact, MigrationDashboardBuildPlan, PowerBiManualParseResult, SemanticMigrationFile } from './types';

export const POWER_BI_WHATABURGER_EXAMPLE_ROOT = '/examples/semantic-migrations/power-bi-whataburger';

export type PowerBiRoundTripCategory = 'workspaces' | 'semanticModels' | 'tables' | 'columns' | 'measures' | 'relationships' | 'reports' | 'pages' | 'visuals' | 'fieldReferences';

export interface PowerBiRoundTripManifest {
  schemaVersion: 'omnikit.powerbi.roundtrip.v1';
  name: string;
  description: string;
  targetScore: number;
  artifacts: Array<{ name: string; path: string }>;
  expectedOmniFiles: string[];
  weights: Record<PowerBiRoundTripCategory, number>;
  expected: Record<PowerBiRoundTripCategory, string[]>;
}

export interface PowerBiRoundTripCategoryResult {
  category: PowerBiRoundTripCategory;
  label: string;
  weight: number;
  expectedCount: number;
  matchedCount: number;
  coveragePercent: number;
  weightedScore: number;
  missing: string[];
}

export interface PowerBiRoundTripReport {
  score: number;
  targetScore: number;
  meetsTarget: boolean;
  categories: PowerBiRoundTripCategoryResult[];
  summary: string;
  caveat: string;
}

export interface PowerBiExampleBundle {
  manifest: PowerBiRoundTripManifest;
  artifacts: MigrationArtifact[];
  expectedOmniFiles: DomoExpectedOmniFile[];
}

const LABELS: Record<PowerBiRoundTripCategory, string> = {
  workspaces: 'Workspaces', semanticModels: 'Semantic models', tables: 'Tables', columns: 'Columns', measures: 'DAX measures', relationships: 'Relationships', reports: 'Reports', pages: 'Pages', visuals: 'Visuals', fieldReferences: 'Visual fields',
};

function normalized(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function categoryResult(category: PowerBiRoundTripCategory, weight: number, expected: string[], actual: Set<string>): PowerBiRoundTripCategoryResult {
  const uniqueExpected = Array.from(new Set(expected.map(normalized)));
  const missing = uniqueExpected.filter((item) => !actual.has(item));
  const matchedCount = uniqueExpected.length - missing.length;
  const coveragePercent = uniqueExpected.length ? Math.round(matchedCount / uniqueExpected.length * 100) : 100;
  return { category, label: LABELS[category], weight, expectedCount: uniqueExpected.length, matchedCount, coveragePercent, weightedScore: weight * coveragePercent / 100, missing };
}

export function evaluatePowerBiRoundTrip(result: PowerBiManualParseResult, manifest: PowerBiRoundTripManifest): PowerBiRoundTripReport {
  const namesFor = (kind: string) => new Set(result.mappings.filter((item) => item.sourceKind === kind).map((item) => normalized(item.sourceName.includes('.') ? item.sourceName.split('.').pop() || item.sourceName : item.sourceName)));
  const actual: Record<PowerBiRoundTripCategory, Set<string>> = {
    workspaces: namesFor('workspace'),
    semanticModels: namesFor('semantic_model'),
    tables: new Set(result.inventory.views.map((view) => normalized(view.name))),
    columns: new Set(result.inventory.views.flatMap((view) => view.fields.map((field) => normalized(field.name)))),
    measures: new Set(result.inventory.metrics.map((measure) => normalized(measure.name))),
    relationships: new Set(result.inventory.relationships.map((relationship) => normalized(`${relationship.from}.${relationship.to}`))),
    reports: namesFor('report'),
    pages: namesFor('page'),
    visuals: namesFor('visual'),
    fieldReferences: new Set(result.inventory.dashboards.flatMap((dashboard) => dashboard.fields.map(normalized))),
  };
  const categories = (Object.keys(manifest.weights) as PowerBiRoundTripCategory[]).map((category) => categoryResult(category, manifest.weights[category], manifest.expected[category], actual[category]));
  const totalWeight = categories.reduce((sum, category) => sum + category.weight, 0) || 100;
  const score = Math.round(categories.reduce((sum, category) => sum + category.weightedScore, 0) / totalWeight * 100);
  const missingCount = categories.reduce((sum, category) => sum + category.missing.length, 0);
  return {
    score,
    targetScore: manifest.targetScore,
    meetsTarget: score >= manifest.targetScore,
    categories,
    summary: `${score}% source-evidence fidelity across ${categories.length} Power BI benchmark categories${missingCount ? ` with ${missingCount} missing expectation${missingCount === 1 ? '' : 's'}` : ''}.`,
    caveat: 'This deterministic score does not certify DAX result parity, Power Query behavior, RLS equivalence, custom visuals, bookmarks, interactions, or pixel-level report fidelity.',
  };
}

export function matchesPowerBiExampleArtifacts(artifacts: MigrationArtifact[], manifest: PowerBiRoundTripManifest): boolean {
  const expected = new Set(manifest.artifacts.map((artifact) => artifact.name));
  return artifacts.length === expected.size && artifacts.every((artifact) => expected.has(artifact.name));
}

export function evaluatePowerBiGeneratedOutput(files: SemanticMigrationFile[], dashboardPlans: MigrationDashboardBuildPlan[], baselineFiles: DomoExpectedOmniFile[], targetScore = 90): DomoGeneratedOutputReport {
  return evaluateDomoGeneratedOutput(files, dashboardPlans, baselineFiles, targetScore);
}

async function fetchText(path: string): Promise<string> {
  const response = await fetch(path, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`Could not load example file ${path} (${response.status}).`);
  return response.text();
}

export async function loadPowerBiWhataburgerExample(): Promise<PowerBiExampleBundle> {
  const response = await fetch(`${POWER_BI_WHATABURGER_EXAMPLE_ROOT}/manifest.json`, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`Could not load the Whataburger Power BI example (${response.status}).`);
  const manifest = await response.json() as PowerBiRoundTripManifest;
  if (manifest.schemaVersion !== 'omnikit.powerbi.roundtrip.v1') throw new Error('The Whataburger Power BI example is not compatible with this OmniKit version.');
  const artifacts = await Promise.all(manifest.artifacts.map(async (entry) => {
    const content = await fetchText(`${POWER_BI_WHATABURGER_EXAMPLE_ROOT}/${encodeURIComponent(entry.path)}`);
    const artifact = artifactFromText('power_bi', content, entry.name);
    if (!artifact) throw new Error(`Example file ${entry.name} was empty.`);
    return artifact;
  }));
  const expectedOmniFiles = await Promise.all(manifest.expectedOmniFiles.map(async (fileName) => ({ fileName, content: await fetchText(`${POWER_BI_WHATABURGER_EXAMPLE_ROOT}/${fileName.split('/').map(encodeURIComponent).join('/')}`) })));
  return { manifest, artifacts, expectedOmniFiles };
}

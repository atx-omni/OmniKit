import { artifactFromText } from './adapters';
import { evaluateDomoGeneratedOutput } from './domoRoundTrip';
import type { DomoExpectedOmniFile, DomoGeneratedOutputReport } from './domoRoundTrip';
import type { MicroStrategyManualParseResult, MigrationArtifact, MigrationDashboardBuildPlan, SemanticMigrationFile } from './types';

export const MICROSTRATEGY_WHATABURGER_EXAMPLE_ROOT = '/examples/semantic-migrations/microstrategy-whataburger';

export type MicroStrategyRoundTripCategory = 'projects' | 'cubes' | 'reports' | 'attributes' | 'metrics' | 'relationships' | 'dashboards' | 'visualizations' | 'fieldReferences';

export interface MicroStrategyRoundTripManifest {
  schemaVersion: 'omnikit.microstrategy.roundtrip.v1';
  name: string;
  description: string;
  targetScore: number;
  artifacts: Array<{ name: string; path: string }>;
  expectedOmniFiles: string[];
  weights: Record<MicroStrategyRoundTripCategory, number>;
  expected: Record<MicroStrategyRoundTripCategory, string[]>;
}

export interface MicroStrategyRoundTripCategoryResult {
  category: MicroStrategyRoundTripCategory;
  label: string;
  weight: number;
  expectedCount: number;
  matchedCount: number;
  coveragePercent: number;
  weightedScore: number;
  missing: string[];
}

export interface MicroStrategyRoundTripReport {
  score: number;
  targetScore: number;
  meetsTarget: boolean;
  categories: MicroStrategyRoundTripCategoryResult[];
  summary: string;
  caveat: string;
}

export interface MicroStrategyExampleBundle {
  manifest: MicroStrategyRoundTripManifest;
  artifacts: MigrationArtifact[];
  expectedOmniFiles: DomoExpectedOmniFile[];
}

const LABELS: Record<MicroStrategyRoundTripCategory, string> = {
  projects: 'Projects', cubes: 'Cubes', reports: 'Reports', attributes: 'Attributes', metrics: 'Metrics', relationships: 'Relationships', dashboards: 'Dashboards', visualizations: 'Visualizations', fieldReferences: 'Dashboard fields',
};

function normalized(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function categoryResult(category: MicroStrategyRoundTripCategory, weight: number, expected: string[], actual: Set<string>): MicroStrategyRoundTripCategoryResult {
  const uniqueExpected = Array.from(new Set(expected.map(normalized)));
  const missing = uniqueExpected.filter((item) => !actual.has(item));
  const matchedCount = uniqueExpected.length - missing.length;
  const coveragePercent = uniqueExpected.length ? Math.round(matchedCount / uniqueExpected.length * 100) : 100;
  return { category, label: LABELS[category], weight, expectedCount: uniqueExpected.length, matchedCount, coveragePercent, weightedScore: weight * coveragePercent / 100, missing };
}

export function evaluateMicroStrategyRoundTrip(result: MicroStrategyManualParseResult, manifest: MicroStrategyRoundTripManifest): MicroStrategyRoundTripReport {
  const mappings = result.mappings;
  const namesFor = (kind: string) => new Set(mappings.filter((item) => item.sourceKind === kind).map((item) => normalized(item.sourceName.includes('.') ? item.sourceName.split('.').pop() || item.sourceName : item.sourceName)));
  const actual: Record<MicroStrategyRoundTripCategory, Set<string>> = {
    projects: namesFor('project'),
    cubes: new Set(result.inventory.views.map((view) => normalized(view.name))),
    reports: namesFor('report'),
    attributes: new Set(result.inventory.views.flatMap((view) => view.fields.map((field) => normalized(field.name)))),
    metrics: new Set(result.inventory.metrics.map((metric) => normalized(metric.name))),
    relationships: new Set(result.inventory.relationships.map((relationship) => normalized(`${relationship.from}.${relationship.to}`))),
    dashboards: new Set(result.inventory.dashboards.map((dashboard) => normalized(dashboard.name))),
    visualizations: namesFor('visualization'),
    fieldReferences: new Set(result.inventory.dashboards.flatMap((dashboard) => dashboard.fields.map(normalized))),
  };
  const categories = (Object.keys(manifest.weights) as MicroStrategyRoundTripCategory[]).map((category) => categoryResult(category, manifest.weights[category], manifest.expected[category], actual[category]));
  const totalWeight = categories.reduce((sum, category) => sum + category.weight, 0) || 100;
  const score = Math.round(categories.reduce((sum, category) => sum + category.weightedScore, 0) / totalWeight * 100);
  const missingCount = categories.reduce((sum, category) => sum + category.missing.length, 0);
  return {
    score,
    targetScore: manifest.targetScore,
    meetsTarget: score >= manifest.targetScore,
    categories,
    summary: `${score}% source-evidence fidelity across ${categories.length} MicroStrategy benchmark categories${missingCount ? ` with ${missingCount} missing expectation${missingCount === 1 ? '' : 's'}` : ''}.`,
    caveat: 'This deterministic score does not certify metric-result parity, prompts, selectors, security filters, derived elements, report limits, permissions, or dashboard visual fidelity.',
  };
}

export function matchesMicroStrategyExampleArtifacts(artifacts: MigrationArtifact[], manifest: MicroStrategyRoundTripManifest): boolean {
  const expected = new Set(manifest.artifacts.map((artifact) => artifact.name));
  return artifacts.length === expected.size && artifacts.every((artifact) => expected.has(artifact.name));
}

export function evaluateMicroStrategyGeneratedOutput(files: SemanticMigrationFile[], dashboardPlans: MigrationDashboardBuildPlan[], baselineFiles: DomoExpectedOmniFile[], targetScore = 90): DomoGeneratedOutputReport {
  return evaluateDomoGeneratedOutput(files, dashboardPlans, baselineFiles, targetScore);
}

async function fetchText(path: string): Promise<string> {
  const response = await fetch(path, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`Could not load example file ${path} (${response.status}).`);
  return response.text();
}

export async function loadMicroStrategyWhataburgerExample(): Promise<MicroStrategyExampleBundle> {
  const response = await fetch(`${MICROSTRATEGY_WHATABURGER_EXAMPLE_ROOT}/manifest.json`, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`Could not load the Whataburger MicroStrategy example (${response.status}).`);
  const manifest = await response.json() as MicroStrategyRoundTripManifest;
  if (manifest.schemaVersion !== 'omnikit.microstrategy.roundtrip.v1') throw new Error('The Whataburger MicroStrategy example is not compatible with this OmniKit version.');
  const artifacts = await Promise.all(manifest.artifacts.map(async (entry) => {
    const content = await fetchText(`${MICROSTRATEGY_WHATABURGER_EXAMPLE_ROOT}/${encodeURIComponent(entry.path)}`);
    const artifact = artifactFromText('microstrategy', content, entry.name);
    if (!artifact) throw new Error(`Example file ${entry.name} was empty.`);
    return artifact;
  }));
  const expectedOmniFiles = await Promise.all(manifest.expectedOmniFiles.map(async (fileName) => ({ fileName, content: await fetchText(`${MICROSTRATEGY_WHATABURGER_EXAMPLE_ROOT}/${fileName.split('/').map(encodeURIComponent).join('/')}`) })));
  return { manifest, artifacts, expectedOmniFiles };
}

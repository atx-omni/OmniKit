import { evaluateDomoGeneratedOutput } from './domoRoundTrip';
import type { DomoExpectedOmniFile, DomoGeneratedOutputReport } from './domoRoundTrip';
import type { LookerManualParseResult, MigrationDashboardBuildPlan, SemanticMigrationFile } from './types';

export type LookerRoundTripCategory = 'views' | 'explores' | 'measures' | 'relationships' | 'dashboards' | 'fieldReferences';

export interface LookerRoundTripManifest {
  schemaVersion: 'omnikit.looker.roundtrip.v1';
  synthetic: true;
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

export function evaluateLookerGeneratedOutput(
  files: SemanticMigrationFile[],
  dashboardPlans: MigrationDashboardBuildPlan[],
  baselineFiles: DomoExpectedOmniFile[],
  targetScore = 90,
): DomoGeneratedOutputReport {
  return evaluateDomoGeneratedOutput(files, dashboardPlans, baselineFiles, targetScore);
}

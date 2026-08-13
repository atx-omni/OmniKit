import { calculateMicroStrategyEvidenceIntegrity } from './microStrategyEvidence';
import type { MicroStrategyEvidenceBundle, MicroStrategyEvidenceIntegrityScore } from './microStrategyEvidence';
import type { MicroStrategyManualParseResult } from './types';

export type MicroStrategyRoundTripCategory = 'projects' | 'cubes' | 'reports' | 'attributes' | 'metrics' | 'relationships' | 'dashboards' | 'visualizations' | 'fieldReferences';

export interface MicroStrategyRoundTripManifest {
  schemaVersion: 'omnikit.microstrategy.roundtrip.v1';
  synthetic: true;
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
  evidenceIntegrity: MicroStrategyEvidenceIntegrityScore;
  blockers: string[];
  summary: string;
  caveat: string;
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

type MicroStrategyEvidenceAwareParseResult = MicroStrategyManualParseResult & { evidence?: MicroStrategyEvidenceBundle };

function missingEvidenceIntegrity(): MicroStrategyEvidenceIntegrityScore {
  return {
    score: 0,
    band: 'incomplete',
    eligibleForControlledLiveAcceptance: false,
    components: {
      documentationTraceability: 0,
      deterministicParserCoverage: 0,
      explicitUnsupportedBehavior: 0,
      sourceToTargetVerification: 0,
      independentReview: 0,
    },
    automaticBlockers: ['Typed MicroStrategy evidence is missing from the parser result.'],
    verification: 'none',
  };
}

export function evaluateMicroStrategyRoundTrip(result: MicroStrategyEvidenceAwareParseResult, manifest: MicroStrategyRoundTripManifest): MicroStrategyRoundTripReport {
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
  const evidenceIntegrity = result.evidence
    ? calculateMicroStrategyEvidenceIntegrity(result.evidence, { verification: manifest.synthetic ? 'fixture' : 'none', independentReview: false })
    : missingEvidenceIntegrity();
  return {
    score,
    targetScore: manifest.targetScore,
    meetsTarget: score >= manifest.targetScore,
    categories,
    evidenceIntegrity,
    blockers: evidenceIntegrity.automaticBlockers,
    summary: `${score}% source-evidence fidelity across ${categories.length} MicroStrategy benchmark categories${missingCount ? ` with ${missingCount} missing expectation${missingCount === 1 ? '' : 's'}` : ''}.`,
    caveat: 'This evaluation does not certify metric-result parity, prompted behavior, selectors, security filters, derived elements, report limits, permissions, or dashboard visual fidelity.',
  };
}

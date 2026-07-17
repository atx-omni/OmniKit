import { parse } from 'yaml';
import type {
  DomoManualParseResult,
  MigrationDashboardBuildPlan,
  SemanticMigrationFile,
} from './types';

export type DomoRoundTripCategory = 'datasets' | 'queryViews' | 'measures' | 'relationships' | 'cards' | 'fieldReferences';

export interface DomoRoundTripManifest {
  schemaVersion: 'omnikit.domo.roundtrip.v1';
  synthetic: true;
  name: string;
  description: string;
  targetScore: number;
  artifacts: Array<{ name: string; path: string }>;
  expectedOmniFiles: string[];
  weights: Record<DomoRoundTripCategory, number>;
  expected: {
    datasets: Array<{ name: string; sourceId: string; fields: string[] }>;
    queryViews: Array<{ name: string; fields: string[] }>;
    measures: Array<{ view: string; name: string; formula: string }>;
    relationships: Array<{ from: string; to: string }>;
    cards: Array<{ name: string; sourceDatasetId: string; chartType: string; fields: string[]; filters: string[] }>;
  };
  omniBaseline: {
    topic: string;
    dashboard: string;
    queryViews: string[];
    notes: string[];
  };
}

export interface DomoExpectedOmniFile {
  fileName: string;
  content: string;
}

export interface DomoRoundTripCategoryResult {
  category: DomoRoundTripCategory;
  label: string;
  weight: number;
  expectedCount: number;
  matchedCount: number;
  coveragePercent: number;
  weightedScore: number;
  missing: string[];
}

export interface DomoRoundTripReport {
  score: number;
  targetScore: number;
  meetsTarget: boolean;
  grade: 'excellent' | 'ready_for_review' | 'needs_attention' | 'incomplete';
  categories: DomoRoundTripCategoryResult[];
  summary: string;
  caveat: string;
}

export type DomoGeneratedOutputCategory = 'files' | 'dimensions' | 'measures' | 'relationships' | 'topic' | 'dashboard';

export interface DomoGeneratedOutputCategoryResult {
  category: DomoGeneratedOutputCategory;
  label: string;
  expectedCount: number;
  matchedCount: number;
  coveragePercent: number;
  missing: string[];
}

export interface DomoGeneratedOutputReport {
  score: number;
  targetScore: number;
  meetsTarget: boolean;
  categories: DomoGeneratedOutputCategoryResult[];
  summary: string;
  caveat: string;
}

const CATEGORY_LABELS: Record<DomoRoundTripCategory, string> = {
  datasets: 'Dataset schemas',
  queryViews: 'SQL DataFlows',
  measures: 'Beast Modes',
  relationships: 'Relationships',
  cards: 'Cards',
  fieldReferences: 'Field references',
};

function normalized(value: string | undefined): string {
  return (value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function normalizedFormula(value: string | undefined): string {
  return (value || '').replace(/\s+/g, '').toLowerCase();
}

function categoryResult(
  category: DomoRoundTripCategory,
  weight: number,
  expected: string[],
  actual: Set<string>,
): DomoRoundTripCategoryResult {
  const uniqueExpected = Array.from(new Set(expected));
  const missing = uniqueExpected.filter((item) => !actual.has(item));
  const matchedCount = uniqueExpected.length - missing.length;
  const coveragePercent = uniqueExpected.length === 0 ? 100 : Math.round((matchedCount / uniqueExpected.length) * 100);
  return {
    category,
    label: CATEGORY_LABELS[category],
    weight,
    expectedCount: uniqueExpected.length,
    matchedCount,
    coveragePercent,
    weightedScore: uniqueExpected.length === 0 ? weight : (matchedCount / uniqueExpected.length) * weight,
    missing,
  };
}

function datasetFieldKey(viewName: string, fieldName: string): string {
  return `dataset:${normalized(viewName)}:${normalized(fieldName)}`;
}

function queryFieldKey(viewName: string, fieldName: string): string {
  return `query:${normalized(viewName)}:${normalized(fieldName)}`;
}

function cardFieldKey(cardName: string, fieldName: string): string {
  return `card:${normalized(cardName)}:${normalized(fieldName)}`;
}

export function evaluateDomoRoundTrip(
  result: DomoManualParseResult,
  manifest: DomoRoundTripManifest,
): DomoRoundTripReport {
  const datasetKeys = new Set(result.inventory.views
    .filter((view) => view.kind === 'dataset')
    .map((view) => `${normalized(view.sourceId)}:${normalized(view.name)}`));
  const queryViewKeys = new Set(result.inventory.views
    .filter((view) => view.kind === 'query_view')
    .map((view) => normalized(view.name)));
  const measureKeys = new Set(result.inventory.views.flatMap((view) => view.measures.map((measure) =>
    `${normalized(view.name)}:${normalized(measure.originalName || measure.name)}:${normalizedFormula(measure.sql)}`)));
  const relationshipKeys = new Set(result.inventory.relationships.map((relationship) =>
    `${normalized(relationship.from)}:${normalized(relationship.to)}`));
  const cardKeys = new Set(result.inventory.dashboards.map((card) =>
    `${normalized(card.name)}:${normalized(card.sourceDatasetId)}:${normalized(card.chartType)}`));
  const fieldReferenceKeys = new Set<string>();
  result.inventory.views.forEach((view) => {
    view.fields.forEach((field) => fieldReferenceKeys.add(view.kind === 'query_view'
      ? queryFieldKey(view.name, field.name)
      : datasetFieldKey(view.name, field.name)));
  });
  result.inventory.dashboards.forEach((card) => {
    card.fields.forEach((field) => fieldReferenceKeys.add(cardFieldKey(card.name, field)));
    card.filters.forEach((field) => fieldReferenceKeys.add(cardFieldKey(card.name, field)));
  });

  const categories = [
    categoryResult('datasets', manifest.weights.datasets, manifest.expected.datasets.map((dataset) => `${normalized(dataset.sourceId)}:${normalized(dataset.name)}`), datasetKeys),
    categoryResult('queryViews', manifest.weights.queryViews, manifest.expected.queryViews.map((view) => normalized(view.name)), queryViewKeys),
    categoryResult('measures', manifest.weights.measures, manifest.expected.measures.map((measure) => `${normalized(measure.view)}:${normalized(measure.name)}:${normalizedFormula(measure.formula)}`), measureKeys),
    categoryResult('relationships', manifest.weights.relationships, manifest.expected.relationships.map((relationship) => `${normalized(relationship.from)}:${normalized(relationship.to)}`), relationshipKeys),
    categoryResult('cards', manifest.weights.cards, manifest.expected.cards.map((card) => `${normalized(card.name)}:${normalized(card.sourceDatasetId)}:${normalized(card.chartType)}`), cardKeys),
    categoryResult('fieldReferences', manifest.weights.fieldReferences, [
      ...manifest.expected.datasets.flatMap((view) => view.fields.map((field) => datasetFieldKey(view.name, field))),
      ...manifest.expected.queryViews.flatMap((view) => view.fields.map((field) => queryFieldKey(view.name, field))),
      ...manifest.expected.cards.flatMap((card) => [...card.fields, ...card.filters].map((field) => cardFieldKey(card.name, field))),
    ], fieldReferenceKeys),
  ];
  const totalWeight = categories.reduce((sum, category) => sum + category.weight, 0) || 100;
  const score = Math.round((categories.reduce((sum, category) => sum + category.weightedScore, 0) / totalWeight) * 100);
  const grade: DomoRoundTripReport['grade'] = score >= 95
    ? 'excellent'
    : score >= manifest.targetScore
      ? 'ready_for_review'
      : score >= 75
        ? 'needs_attention'
        : 'incomplete';
  const missingCount = categories.reduce((sum, category) => sum + category.missing.length, 0);
  return {
    score,
    targetScore: manifest.targetScore,
    meetsTarget: score >= manifest.targetScore,
    grade,
    categories,
    summary: `${score}% source-evidence fidelity across ${categories.length} benchmark categories${missingCount ? ` with ${missingCount} missing expectation${missingCount === 1 ? '' : 's'}` : ''}.`,
    caveat: 'This score measures deterministic parser recovery before AI translation. It does not certify generated Omni YAML, query-result parity, permissions, or visual styling.',
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function keys(value: unknown): string[] {
  return Object.keys(asRecord(value));
}

function outputCategory(
  category: DomoGeneratedOutputCategory,
  label: string,
  expected: Set<string>,
  actual: Set<string>,
): DomoGeneratedOutputCategoryResult {
  const missing = Array.from(expected).filter((item) => !actual.has(item)).sort();
  const matchedCount = expected.size - missing.length;
  return {
    category,
    label,
    expectedCount: expected.size,
    matchedCount,
    coveragePercent: expected.size === 0 ? 100 : Math.round((matchedCount / expected.size) * 100),
    missing,
  };
}

function semanticFileKey(fileName: string): string {
  return fileName.split('/').pop()?.toLowerCase() || fileName.toLowerCase();
}

function parsedYamlFiles(files: Array<{ fileName: string; content: string }>): Map<string, unknown> {
  return new Map(files.flatMap((file) => {
    if (file.fileName.endsWith('.json')) return [];
    try { return [[semanticFileKey(file.fileName), parse(file.content)] as const]; } catch { return []; }
  }));
}

export function evaluateDomoGeneratedOutput(
  files: SemanticMigrationFile[],
  dashboardPlans: MigrationDashboardBuildPlan[],
  baselineFiles: DomoExpectedOmniFile[],
  targetScore = 90,
): DomoGeneratedOutputReport {
  const baselineYaml = parsedYamlFiles(baselineFiles);
  const generatedYaml = parsedYamlFiles(files.map((file) => ({ fileName: file.fileName, content: file.yaml })));
  const expectedSemanticFiles = new Set(Array.from(baselineYaml.keys()));
  const generatedSemanticFiles = new Set(Array.from(generatedYaml.keys()));
  const expectedDimensions = new Set<string>();
  const actualDimensions = new Set<string>();
  const expectedMeasures = new Set<string>();
  const actualMeasures = new Set<string>();
  const expectedRelationships = new Set<string>();
  const actualRelationships = new Set<string>();
  const expectedTopic = new Set<string>();
  const actualTopic = new Set<string>();

  baselineYaml.forEach((value, fileName) => {
    const record = asRecord(value);
    if (fileName.endsWith('.view')) {
      keys(record.dimensions).forEach((name) => expectedDimensions.add(`${fileName}:${normalized(name)}`));
      keys(record.measures).forEach((name) => expectedMeasures.add(`${fileName}:${normalized(name)}`));
    } else if (fileName === 'relationships' && Array.isArray(value)) {
      value.forEach((row) => {
        const relationship = asRecord(row);
        expectedRelationships.add(`${normalized(String(relationship.join_from_view || ''))}:${normalized(String(relationship.join_to_view || ''))}`);
      });
    } else if (fileName.endsWith('.topic')) {
      expectedTopic.add(`base:${normalized(String(record.base_view || ''))}`);
      keys(record.views).forEach((name) => expectedTopic.add(`view:${normalized(name)}`));
    }
  });
  generatedYaml.forEach((value, fileName) => {
    const record = asRecord(value);
    if (fileName.endsWith('.view')) {
      keys(record.dimensions).forEach((name) => actualDimensions.add(`${fileName}:${normalized(name)}`));
      keys(record.measures).forEach((name) => actualMeasures.add(`${fileName}:${normalized(name)}`));
    } else if (fileName === 'relationships' && Array.isArray(value)) {
      value.forEach((row) => {
        const relationship = asRecord(row);
        actualRelationships.add(`${normalized(String(relationship.join_from_view || ''))}:${normalized(String(relationship.join_to_view || ''))}`);
      });
    } else if (fileName.endsWith('.topic')) {
      actualTopic.add(`base:${normalized(String(record.base_view || ''))}`);
      keys(record.views).forEach((name) => actualTopic.add(`view:${normalized(name)}`));
    }
  });

  const dashboardBaseline = baselineFiles.find((file) => file.fileName.endsWith('NorthstarDashboard.build.json'));
  const expectedTiles = new Set<string>();
  if (dashboardBaseline) {
    try {
      const parsed = asRecord(JSON.parse(dashboardBaseline.content));
      const tiles = Array.isArray(parsed.tiles) ? parsed.tiles : [];
      tiles.forEach((tile) => expectedTiles.add(normalized(String(asRecord(tile).title || ''))));
    } catch { /* Invalid baselines are exposed as missing dashboard expectations below. */ }
  }
  const actualTiles = new Set(dashboardPlans.flatMap((plan) => plan.tiles.map((tile) => normalized(tile.title))));
  const categories = [
    outputCategory('files', 'Semantic files', expectedSemanticFiles, generatedSemanticFiles),
    outputCategory('dimensions', 'Dimensions', expectedDimensions, actualDimensions),
    outputCategory('measures', 'Measures', expectedMeasures, actualMeasures),
    outputCategory('relationships', 'Relationships', expectedRelationships, actualRelationships),
    outputCategory('topic', 'Topic scope', expectedTopic, actualTopic),
    outputCategory('dashboard', 'Dashboard tiles', expectedTiles, actualTiles),
  ];
  const weights: Record<DomoGeneratedOutputCategory, number> = { files: 15, dimensions: 20, measures: 20, relationships: 15, topic: 15, dashboard: 15 };
  const score = Math.round(categories.reduce((sum, category) => sum + (category.coveragePercent / 100) * weights[category.category], 0));
  const missingCount = categories.reduce((sum, category) => sum + category.missing.length, 0);
  return {
    score,
    targetScore,
    meetsTarget: score >= targetScore,
    categories,
    summary: `${score}% generated-output coverage${missingCount ? ` with ${missingCount} missing baseline item${missingCount === 1 ? '' : 's'}` : ''}.`,
    caveat: 'This structural comparison does not prove SQL equivalence, metric-result parity, permissions, or visual fidelity. Those remain required migration validations.',
  };
}

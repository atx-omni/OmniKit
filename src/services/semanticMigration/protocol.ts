export const SEMANTIC_MIGRATION_PROTOCOL_VERSION = '1.0';
export const SEMANTIC_MIGRATION_PROMPT_VERSION = 'semantic-migration-2026-07-09.v1';
export const SEMANTIC_MIGRATION_CANONICAL_SCHEMA_VERSION = '1.0';

export interface SemanticMigrationEvaluationFixture {
  id: string;
  sourcePlatform: string;
  expectedNodeKinds: string[];
  expectedDecisionActions: string[];
  forbiddenOutputPatterns: string[];
}

export const SEMANTIC_MIGRATION_EVALUATION_FIXTURES: SemanticMigrationEvaluationFixture[] = [
  {
    id: 'renamed-measure-map',
    sourcePlatform: 'dbt',
    expectedNodeKinds: ['measure'],
    expectedDecisionActions: ['map_existing'],
    forbiddenOutputPatterns: ['api_key', 'password', 'direct production write'],
  },
  {
    id: 'missing-view-create',
    sourcePlatform: 'sigma',
    expectedNodeKinds: ['view', 'field', 'dashboard'],
    expectedDecisionActions: ['create_new', 'rewrite'],
    forbiddenOutputPatterns: ['unreviewed delete', 'skip validation'],
  },
  {
    id: 'proprietary-expression-defer',
    sourcePlatform: 'webfocus',
    expectedNodeKinds: ['measure'],
    expectedDecisionActions: ['defer'],
    forbiddenOutputPatterns: ['invented SQL', 'silent fallback'],
  },
];

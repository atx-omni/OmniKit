export type DomoTranslationDisposition = 'translate' | 'review' | 'handoff';

export interface DomoDevelopmentTranslationRule {
  source: string;
  omniTarget: string;
  disposition: DomoTranslationDisposition;
  requiredEvidence: string[];
  guidance: string;
}

/** Prompt-facing Domo rules. They define evidence and review boundaries, not parity claims. */
export const DOMO_DEVELOPMENT_TRANSLATION_RULES: DomoDevelopmentTranslationRule[] = [
  {
    source: 'DataSet schema',
    omniTarget: 'database-backed shared model view',
    disposition: 'review',
    requiredEvidence: ['DataSet ID', 'typed columns', 'target warehouse table or approved replacement'],
    guidance: 'A Domo DataSet is not automatically a physical target table. Confirm the target relation before generating a shared view.',
  },
  {
    source: 'row-level Beast Mode',
    omniTarget: 'dimension',
    disposition: 'translate',
    requiredEvidence: ['formula', 'DataSet scope', 'return type', 'referenced columns'],
    guidance: 'Translate the expression into the target warehouse dialect and keep its Card-scoped or DataSet-scoped ownership visible.',
  },
  {
    source: 'aggregate or analytic Beast Mode',
    omniTarget: 'measure',
    disposition: 'translate',
    requiredEvidence: ['formula', 'aggregation classification', 'DataSet grain', 'filter-context assumptions'],
    guidance: 'Prefer Omni aggregate types where equivalent; otherwise use reviewed SQL and validate grouped results against Domo.',
  },
  {
    source: 'FIXED Beast Mode',
    omniTarget: 'level-of-detail dimension',
    disposition: 'review',
    requiredEvidence: ['FIXED BY/ADD/REMOVE clause', 'filter allow/deny behavior', 'DataSet grain'],
    guidance: 'Map to Omni level_of_detail only after grouping and filter-cancellation semantics are proven equivalent.',
  },
  {
    source: 'Domo Variable used by a Beast Mode',
    omniTarget: 'dashboard control plus reviewed model expression',
    disposition: 'review',
    requiredEvidence: ['variable type', 'default value', 'allowed values or range', 'dependent Beast Modes', 'Card/Page control scope'],
    guidance: 'Do not inline one current value. Preserve the interactive choice and validate every dependent expression.',
  },
  {
    source: 'SQL DataFlow transform',
    omniTarget: 'query view or warehouse/dbt model',
    disposition: 'review',
    requiredEvidence: ['engine/dialect', 'SQL', 'inputs', 'outputs', 'output grain', 'update method'],
    guidance: 'A SELECT can become a query view only when dialect and grain are valid. Recursion, snapshots, append processing, and scheduling remain data-engineering concerns.',
  },
  {
    source: 'Magic ETL graph',
    omniTarget: 'warehouse/dbt transformation handoff',
    disposition: 'handoff',
    requiredEvidence: ['complete tile graph', 'tile configuration', 'inputs', 'outputs', 'update behavior'],
    guidance: 'Preserve the graph and formulas as evidence. Do not claim conversion to Omni YAML without a deterministic graph translator and result parity.',
  },
  {
    source: 'DataFlow join',
    omniTarget: 'relationship or query-view join',
    disposition: 'review',
    requiredEvidence: ['join keys', 'join type', 'cardinality', 'fanout behavior', 'null behavior'],
    guidance: 'A recovered ON predicate does not prove relationship cardinality. Validate fanout before creating an Omni relationship.',
  },
  {
    source: 'Card Analyzer query',
    omniTarget: 'Omni dashboard tile query and visualization',
    disposition: 'review',
    requiredEvidence: ['DataSet', 'fields', 'Beast Modes', 'filters', 'sorts', 'limit', 'date grain', 'summary number', 'chart properties'],
    guidance: 'Card metadata alone is not a complete Analyzer query. Missing query bindings remain blocking evidence, not values for the AI to invent.',
  },
  {
    source: 'Card drill path',
    omniTarget: 'drill_fields or drill_queries',
    disposition: 'review',
    requiredEvidence: ['ordered layers', 'DataSet per layer', 'fields', 'filters', 'sorts', 'limits'],
    guidance: 'Only translate drills when layer-to-layer filtering and any DataSet change can be reproduced through valid Omni relationships.',
  },
  {
    source: 'Page filter, Filter View, filter Card, or Card interaction',
    omniTarget: 'dashboard filter, control, or cross-filter setting',
    disposition: 'review',
    requiredEvidence: ['field and type', 'default values', 'target Cards', 'persistence', 'interaction behavior'],
    guidance: 'Preserve filter-to-tile mappings and defaults. Personal Filter Views do not become shared defaults without approval.',
  },
  {
    source: 'Standard Page',
    omniTarget: 'dashboard with ordered tile membership',
    disposition: 'translate',
    requiredEvidence: ['Page ID', 'Card membership', 'layout', 'filters', 'ownership'],
    guidance: 'Use the Page as the migration unit and reconcile layout and interactions after dashboard construction.',
  },
  {
    source: 'Story or App Studio app',
    omniTarget: 'dashboard/application redesign',
    disposition: 'handoff',
    requiredEvidence: ['pages', 'navigation', 'actions', 'persistent filters', 'controls', 'forms', 'mobile behavior'],
    guidance: 'Migrate reusable Cards and semantic dependencies, but treat application navigation and action behavior as an explicit redesign.',
  },
  {
    source: 'PDP row policy',
    omniTarget: 'user attribute and topic access_filter',
    disposition: 'review',
    requiredEvidence: ['policy type', 'DataSet', 'columns', 'values or managed attributes', 'principal assignments'],
    guidance: 'Require a security owner to prove row visibility equivalence and unrestricted-user behavior before deployment.',
  },
  {
    source: 'PDP column policy or masking',
    omniTarget: 'access grant or user-attribute field masking',
    disposition: 'review',
    requiredEvidence: ['column', 'data type', 'masking method', 'precedence', 'assignments'],
    guidance: 'Never reduce column masking to a row filter. Require field-level result tests for each identity class.',
  },
  {
    source: 'Workflow, Form, or Code Engine package',
    omniTarget: 'automation/application redesign handoff',
    disposition: 'handoff',
    requiredEvidence: ['trigger', 'inputs', 'decision logic', 'side effects', 'outputs', 'owner', 'SLA'],
    guidance: 'These are executable application processes, not semantic objects. Preserve them as separately owned redesign work.',
  },
  {
    source: 'Workbench job, connector, or ingestion configuration',
    omniTarget: 'data-platform handoff',
    disposition: 'handoff',
    requiredEvidence: ['source', 'destination', 'schedule', 'update mode', 'owner'],
    guidance: 'Do not copy source credentials. Recreate ingestion in the approved data platform and map its output to the Omni connection.',
  },
  {
    source: 'Schedule, alert, sharing, ownership, or usage',
    omniTarget: 'operational/governance decision',
    disposition: 'review',
    requiredEvidence: ['source object', 'recipients or principals', 'timezone', 'frequency or condition', 'owner'],
    guidance: 'Use usage for wave planning. Recreate delivery and access only after recipients, filters, and ownership are approved.',
  },
];

function ruleLine(rule: DomoDevelopmentTranslationRule): string {
  return `- ${rule.source} -> ${rule.omniTarget} [${rule.disposition}]. Evidence: ${rule.requiredEvidence.join(', ')}. ${rule.guidance}`;
}

export function domoDevelopmentPromptGuidance(): string {
  return [
    'Domo migration practice:',
    '- Treat Domo evidence as a dependency graph: Page -> Card -> DataSet -> fields/Beast Modes -> DataFlows/relationships -> PDP/operations. Scope every proposal to the selected Page or Card closure.',
    '- Preserve Beast Mode scope, ownership, lock/archive state, validity, return type, aggregation/analytic classification, function dependencies, and Variable dependencies. Card-scoped and DataSet-scoped calculations are not interchangeable.',
    '- Exact repeated formulas may map to one reusable target field. Same-name different formulas remain additive, blocking decisions; never overwrite by name alone.',
    '- The AI proposes typed decisions only. It must not invent missing Analyzer JSON, relationship cardinality, PDP semantics, operational recipients, or application behavior.',
    ...DOMO_DEVELOPMENT_TRANSLATION_RULES.map(ruleLine),
  ].join('\n');
}

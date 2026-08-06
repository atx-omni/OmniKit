import type { MigrationBiSourceTool } from './types';

export interface MigrationSourceDocumentationReference {
  title: string;
  url: string;
  authority: string;
  artifactClasses: string[];
  reviewedAt: string;
}

export const MIGRATION_SOURCE_DOCUMENTATION: Partial<Record<MigrationBiSourceTool, MigrationSourceDocumentationReference[]>> = {
  domo: [
    {
      title: 'Domo API overview',
      url: 'https://www.domo.com/docs/portal/API-Reference/overview',
      authority: 'Domo documentation',
      artifactClasses: ['authentication', 'dataset', 'card', 'page', 'API scope'],
      reviewedAt: '2026-08-05',
    },
    {
      title: 'Domo Beast Modes API',
      url: 'https://www.domo.com/docs/portal/bff3ab39f7a6b-beast-modes',
      authority: 'Domo documentation',
      artifactClasses: ['Beast Mode', 'calculation', 'dataset binding'],
      reviewedAt: '2026-08-05',
    },
    {
      title: 'Beast Mode FIXED Functions',
      url: 'https://www.domo.com/docs/s/article/4408174643607',
      authority: 'Domo documentation',
      artifactClasses: ['Beast Mode', 'FIXED level of detail', 'filter behavior'],
      reviewedAt: '2026-08-05',
    },
    {
      title: 'Variables overview',
      url: 'https://www.domo.com/docs/s/article/7903767835031',
      authority: 'Domo documentation',
      artifactClasses: ['Variable', 'default value', 'Beast Mode dependency', 'dashboard control'],
      reviewedAt: '2026-08-05',
    },
    {
      title: 'Get Chart Card Definition',
      url: 'https://www.domo.com/docs/portal/42d54af2095ac-get-chart-card-definition',
      authority: 'Domo documentation',
      artifactClasses: ['Analyzer query', 'chart type', 'field binding', 'filter', 'calculated field', 'quick filter'],
      reviewedAt: '2026-08-05',
    },
    {
      title: 'Get Drill Properties',
      url: 'https://www.domo.com/docs/portal/0945428d284ab-get-drill-properties',
      authority: 'Domo documentation',
      artifactClasses: ['Card drill path', 'drill order'],
      reviewedAt: '2026-08-05',
    },
    {
      title: 'Create a SQL DataFlow',
      url: 'https://www.domo.com/docs/s/article/360042922994',
      authority: 'Domo documentation',
      artifactClasses: ['SQL DataFlow', 'transform', 'input dataset', 'output dataset'],
      reviewedAt: '2026-08-05',
    },
    {
      title: 'Magic ETL Tiles: Combine Data',
      url: 'https://www.domo.com/docs/s/article/360044876194',
      authority: 'Domo documentation',
      artifactClasses: ['Magic ETL', 'relationship', 'join', 'join key', 'join type', 'cardinality'],
      reviewedAt: '2026-08-05',
    },
    {
      title: 'Optimizing a SQL DataFlow',
      url: 'https://www.domo.com/docs/s/article/360042923014',
      authority: 'Domo documentation',
      artifactClasses: ['SQL DataFlow', 'JOIN predicate', 'input relationship trace', 'query-view candidate'],
      reviewedAt: '2026-08-05',
    },
    {
      title: 'Magic ETL',
      url: 'https://www.domo.com/docs/s/topic/0TO5w000000ZanvGAC/magic-etl',
      authority: 'Domo documentation',
      artifactClasses: ['Magic ETL', 'tile graph', 'input dataset', 'output dataset', 'data-engineering handoff'],
      reviewedAt: '2026-08-05',
    },
    {
      title: 'Personalized Data Permissions',
      url: 'https://www.domo.com/docs/s/article/360042934614',
      authority: 'Domo documentation',
      artifactClasses: ['PDP policy', 'row policy', 'column policy', 'user and group assignment'],
      reviewedAt: '2026-08-05',
    },
    {
      title: 'Page Filters and Filter Views on Dashboards',
      url: 'https://www.domo.com/docs/s/article/360042923914?language=en_US',
      authority: 'Domo documentation',
      artifactClasses: ['Page filter', 'Filter View', 'Card interaction', 'dashboard control'],
      reviewedAt: '2026-08-05',
    },
    {
      title: 'Domo Workflows API',
      url: 'https://www.domo.com/docs/portal/API-Reference/Product-APIs/Workflows',
      authority: 'Domo documentation',
      artifactClasses: ['workflow operation', 'workflow permission', 'redesign handoff'],
      reviewedAt: '2026-08-05',
    },
  ],
  looker: [
    {
      title: 'Looker API authentication',
      url: 'https://docs.cloud.google.com/looker/docs/api-auth',
      authority: 'Google Cloud Looker documentation',
      artifactClasses: ['authentication', 'API scope', 'service account'],
      reviewedAt: '2026-08-05',
    },
    {
      title: 'Looker API reference',
      url: 'https://docs.cloud.google.com/looker/docs/reference/looker-api/latest',
      authority: 'Google Cloud Looker documentation',
      artifactClasses: ['dashboard', 'query', 'LookML model', 'folder', 'schedule'],
      reviewedAt: '2026-08-05',
    },
    {
      title: 'Looker access_filter',
      url: 'https://docs.cloud.google.com/looker/docs/reference/param-explore-access-filter',
      authority: 'Google Cloud Looker documentation',
      artifactClasses: ['access filter', 'user attribute', 'row-level security'],
      reviewedAt: '2026-08-05',
    },
    {
      title: 'Looker derived table methods',
      url: 'https://docs.cloud.google.com/looker/docs/reference/looker-api/latest/methods/DerivedTable',
      authority: 'Google Cloud Looker documentation',
      artifactClasses: ['PDT', 'derived table', 'dependency graph'],
      reviewedAt: '2026-08-05',
    },
    {
      title: 'LookML refinements',
      url: 'https://docs.cloud.google.com/looker/docs/lookml-refinements',
      authority: 'Google Cloud Looker documentation',
      artifactClasses: ['view refinement', 'Explore refinement', 'include order', 'dependency graph'],
      reviewedAt: '2026-08-05',
    },
    {
      title: 'LookML include parameter',
      url: 'https://docs.cloud.google.com/looker/docs/reference/param-model-include',
      authority: 'Google Cloud Looker documentation',
      artifactClasses: ['include', 'project dependency', 'view', 'Explore'],
      reviewedAt: '2026-08-05',
    },
    {
      title: 'LookML access grants',
      url: 'https://docs.cloud.google.com/looker/docs/reference/param-model-access-grant',
      authority: 'Google Cloud Looker documentation',
      artifactClasses: ['access grant', 'permission', 'user attribute', 'governance'],
      reviewedAt: '2026-08-05',
    },
    {
      title: 'Building LookML dashboards',
      url: 'https://docs.cloud.google.com/looker/docs/building-lookml-dashboards',
      authority: 'Google Cloud Looker documentation',
      artifactClasses: ['dashboard', 'tile', 'visual', 'filter', 'layout'],
      reviewedAt: '2026-08-05',
    },
    {
      title: 'Looker to Omni migration skill',
      url: 'https://docs.omni.co/guides/migrations/looker-to-omni-skill',
      authority: 'Omni documentation',
      artifactClasses: ['LookML', 'Omni model', 'migration validation'],
      reviewedAt: '2026-08-05',
    },
  ],
  metabase: [
    {
      title: 'Metabase API documentation',
      url: 'https://www.metabase.com/docs/latest/api-documentation',
      authority: 'Metabase documentation',
      artifactClasses: ['API contract', 'dashboard', 'card', 'collection'],
      reviewedAt: '2026-08-05',
    },
    {
      title: 'Metabase API changelog',
      url: 'https://www.metabase.com/docs/latest/developers-guide/api-changelog',
      authority: 'Metabase documentation',
      artifactClasses: ['API compatibility', 'MBQL version', 'removed endpoint'],
      reviewedAt: '2026-08-05',
    },
    {
      title: 'Metabase dashboard filters and parameters',
      url: 'https://www.metabase.com/docs/latest/dashboards/filters',
      authority: 'Metabase documentation',
      artifactClasses: ['dashboard filter', 'parameter', 'card mapping'],
      reviewedAt: '2026-08-05',
    },
    {
      title: 'Metabase collection permissions',
      url: 'https://www.metabase.com/docs/latest/permissions/collections',
      authority: 'Metabase documentation',
      artifactClasses: ['collection', 'permission', 'governance handoff'],
      reviewedAt: '2026-08-05',
    },
  ],
  webfocus: [
    {
      title: 'WebFOCUS RESTful Web Services',
      url: 'https://docs.tibco.com/pub/wf-wf/9.3.3/doc/html/embedded-bi-user/02REST_WS16.htm',
      authority: 'TIBCO WebFOCUS documentation',
      artifactClasses: ['repository', 'report procedure', 'parameters', 'schedule and library metadata'],
      reviewedAt: '2026-08-05',
    },
    {
      title: 'WebFOCUS Master File syntax',
      url: 'https://docs.tibco.com/pub/wf-wf/9.3.4/doc/html/describing-data-lang/ids17.htm',
      authority: 'TIBCO WebFOCUS documentation',
      artifactClasses: ['Master File', 'segment', 'field', 'alias', 'data type'],
      reviewedAt: '2026-08-05',
    },
    {
      title: 'WebFOCUS JOIN command',
      url: 'https://docs.tibco.com/pub/wf-wf/9.3.4/doc/html/describing-data-lang/join85.htm',
      authority: 'TIBCO WebFOCUS documentation',
      artifactClasses: ['join', 'relationship', 'cardinality evidence'],
      reviewedAt: '2026-08-05',
    },
  ],
  microstrategy: [
    {
      title: 'View report and document details',
      url: 'https://www2.microstrategy.com/producthelp/current/MSTRWeb/WebHelp/Lang_1033/Content/View_report_details.htm',
      authority: 'Strategy product documentation',
      artifactClasses: ['report', 'document', 'attributes', 'metrics', 'filters', 'SQL', 'execution evidence'],
      reviewedAt: '2026-08-05',
    },
    {
      title: 'Accessing data in a document: The dataset',
      url: 'https://www2.microstrategy.com/producthelp/Current/ReportDesigner/WebHelp/Lang_1033/Content/Accessing_data_in_a_document__The_dataset_report.htm',
      authority: 'Strategy product documentation',
      artifactClasses: ['dataset report', 'Intelligent Cube', 'document dependency'],
      reviewedAt: '2026-08-05',
    },
  ],
  tableau: [
    {
      title: 'Tableau Metadata API',
      url: 'https://help.tableau.com/current/api/metadata_api/en-us/',
      authority: 'Tableau documentation',
      artifactClasses: ['workbook', 'data source', 'field', 'lineage', 'external asset'],
      reviewedAt: '2026-08-05',
    },
    {
      title: 'Tableau REST API publishing resources',
      url: 'https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api_concepts_publish.htm',
      authority: 'Tableau documentation',
      artifactClasses: ['TWB', 'TWBX', 'TDS', 'TDSX', 'extract resource'],
      reviewedAt: '2026-08-05',
    },
    {
      title: 'Tableau calculation functions',
      url: 'https://help.tableau.com/current/pro/desktop/en-us/functions_all_categories.htm',
      authority: 'Tableau documentation',
      artifactClasses: ['calculated field', 'aggregate calculation', 'table calculation', 'LOD expression'],
      reviewedAt: '2026-08-05',
    },
  ],
  power_bi: [
    {
      title: 'Power BI REST APIs',
      url: 'https://learn.microsoft.com/en-us/rest/api/power-bi/',
      authority: 'Microsoft Learn',
      artifactClasses: ['workspace', 'semantic model', 'report', 'dashboard', 'administration'],
      reviewedAt: '2026-08-05',
    },
    {
      title: 'Power BI Desktop project semantic model folder',
      url: 'https://learn.microsoft.com/en-us/power-bi/developer/projects/projects-dataset',
      authority: 'Microsoft Learn',
      artifactClasses: ['PBIP', 'TMDL', 'semantic model definition', 'table', 'field', 'measure', 'relationship'],
      reviewedAt: '2026-08-05',
    },
    {
      title: 'Power BI Desktop project report folder',
      url: 'https://learn.microsoft.com/en-us/power-bi/developer/projects/projects-report',
      authority: 'Microsoft Learn',
      artifactClasses: ['PBIR', 'report', 'page', 'visual', 'filter', 'bookmark'],
      reviewedAt: '2026-08-05',
    },
  ],
  sigma: [
    {
      title: 'About the Sigma REST API',
      url: 'https://help.sigmacomputing.com/docs/get-started-with-sigmas-api',
      authority: 'Sigma documentation',
      artifactClasses: ['authentication', 'workbook', 'dataset', 'team', 'connection'],
      reviewedAt: '2026-08-05',
    },
    {
      title: 'List elements in a workbook',
      url: 'https://help.sigmacomputing.com/reference/list-workbook-elements',
      authority: 'Sigma documentation',
      artifactClasses: ['workbook', 'page', 'element', 'control', 'pagination'],
      reviewedAt: '2026-08-05',
    },
    {
      title: 'Data model representation with a metric',
      url: 'https://help.sigmacomputing.com/docs/example-representation-data-model-with-a-table-and-a-metric',
      authority: 'Sigma documentation',
      artifactClasses: ['data model', 'table element', 'metric', 'column identity'],
      reviewedAt: '2026-08-05',
    },
    {
      title: 'Data model representation with a relationship',
      url: 'https://help.sigmacomputing.com/docs/example-representation-data-model-with-a-table-and-a-relationship',
      authority: 'Sigma documentation',
      artifactClasses: ['data model', 'table element', 'relationship', 'join key'],
      reviewedAt: '2026-08-05',
    },
    {
      title: 'List materialization schedules for a data model',
      url: 'https://help.sigmacomputing.com/reference/list-data-model-materialization-schedules',
      authority: 'Sigma documentation',
      artifactClasses: ['materialization', 'schedule', 'pagination'],
      reviewedAt: '2026-08-05',
    },
    {
      title: 'Add version tags to workbooks and data models',
      url: 'https://help.sigmacomputing.com/docs/add-version-tags-to-workbooks-and-data-models',
      authority: 'Sigma documentation',
      artifactClasses: ['workbook version', 'data model version', 'source pin'],
      reviewedAt: '2026-08-05',
    },
    {
      title: 'Sigma basics',
      url: 'https://help.sigmacomputing.com/docs/sigma-basics',
      authority: 'Sigma documentation',
      artifactClasses: ['data model', 'dataset', 'workbook', 'element dependency'],
      reviewedAt: '2026-08-05',
    },
  ],
};

export function migrationSourceDocumentation(source: MigrationBiSourceTool): MigrationSourceDocumentationReference[] {
  return (MIGRATION_SOURCE_DOCUMENTATION[source] || []).map((reference) => ({
    ...reference,
    artifactClasses: [...reference.artifactClasses],
  }));
}

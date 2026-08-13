import { migrationSourceDocumentation, type MigrationSourceDocumentationReference } from './sourceDocumentation';
import type { MigrationBiSourceTool } from './types';

export type MigrationSourceSetupMode = 'api' | 'manual';

export interface MigrationSourceSetupPath {
  mode: MigrationSourceSetupMode;
  title: string;
  summary: string;
  prerequisites: string[];
  steps: string[];
  fields?: string[];
  collects: string[];
  boundaries: string[];
  acceptedArtifacts?: string[];
  documentation: MigrationSourceDocumentationReference[];
}

export interface MigrationSourceSetupGuideDefinition {
  source: MigrationBiSourceTool;
  label: string;
  availabilityLabel: string;
  api?: MigrationSourceSetupPath;
  manual: MigrationSourceSetupPath;
}

function officialDocuments(source: MigrationBiSourceTool, urls: string[]): MigrationSourceDocumentationReference[] {
  const registered = migrationSourceDocumentation(source);
  return urls.map((url) => {
    const match = registered.find((reference) => reference.url === url);
    if (!match) throw new Error(`Source setup documentation is not registered for ${source}: ${url}`);
    return match;
  });
}

const DOMO_DOCS = officialDocuments('domo', [
  'https://www.domo.com/docs/portal/API-Reference/overview',
  'https://www.domo.com/docs/api-reference/beast-modes/get-all-beast-modes',
  'https://www.domo.com/docs/portal/42d54af2095ac-get-chart-card-definition',
]);

const LOOKER_DOCS = officialDocuments('looker', [
  'https://cloud.google.com/looker/docs/reference/looker-api/latest/methods/ApiAuth/login',
  'https://cloud.google.com/looker/docs/reference/looker-api/latest/methods/LookmlModel/lookml_model_explore',
  'https://cloud.google.com/looker/docs/reference/looker-api/latest/methods/Dashboard/dashboard',
]);

const SIGMA_DOCS = officialDocuments('sigma', [
  'https://help.sigmacomputing.com/reference/post-token',
  'https://help.sigmacomputing.com/reference/get-data-model-spec',
  'https://help.sigmacomputing.com/reference/get-workbook',
]);

const METABASE_DOCS = officialDocuments('metabase', [
  'https://www.metabase.com/docs/latest/people-and-groups/api-keys',
  'https://www.metabase.com/docs/latest/installation-and-operation/serialization',
  'https://www.metabase.com/docs/latest/api-documentation',
]);

const TABLEAU_DOCS = officialDocuments('tableau', [
  'https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api_concepts_auth.htm',
  'https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api_ref_workbooks_and_views.htm',
  'https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api_ref_data_sources.htm',
]);

const POWER_BI_DOCS = officialDocuments('power_bi', [
  'https://learn.microsoft.com/en-us/power-bi/enterprise/service-premium-service-principal',
  'https://learn.microsoft.com/en-us/rest/api/fabric/semanticmodel/items/get-semantic-model-definition',
  'https://learn.microsoft.com/en-us/rest/api/fabric/report/items/get-report-definition',
  'https://learn.microsoft.com/en-us/power-bi/developer/projects/projects-dataset',
  'https://learn.microsoft.com/en-us/power-bi/developer/projects/projects-report',
]);

const STRATEGY_DOCS = officialDocuments('microstrategy', [
  'https://microstrategy.github.io/rest-api-docs/getting-started/authentication/',
  'https://microstrategy.github.io/rest-api-docs/common-workflows/analytics/manage-reports/manage-report-objects/retrieve-a-reports-definition/',
  'https://microstrategy.github.io/rest-api-docs/common-workflows/modeling/manage-metric-objects/retrieve-a-metrics-definition/',
]);

const WEBFOCUS_DOCS = officialDocuments('webfocus', [
  'https://docs.tibco.com/webfocus/8207/doc/html/topic/com.ibi.help.portal/source/change_management.htm',
  'https://docs.tibco.com/webfocus/8207/doc/html/topic/com.ibi.help.syn/source/intro.htm',
]);

export const MIGRATION_SOURCE_SETUP_GUIDES: Record<MigrationBiSourceTool, MigrationSourceSetupGuideDefinition> = {
  domo: {
    source: 'domo',
    label: 'Domo',
    availabilityLabel: 'Saved API + Manual Files',
    api: {
      mode: 'api',
      title: 'Connect Domo with documented APIs',
      summary: 'A Product API developer token provides the primary tenant-scoped evidence. Optional Platform OAuth client credentials add documented Chart Card, drill, and PDP definitions.',
      prerequisites: [
        'Use a dedicated Domo user whose access is limited to the Pages, Cards, DataSets, and governance evidence in migration scope.',
        'Have the Domo tenant URL and a Product API developer token available.',
        'For Chart Card and PDP definitions, also obtain a Domo Platform OAuth client ID and client secret.',
      ],
      steps: [
        'Sign in as the dedicated migration user and create a developer token using Domo’s documented Product API setup.',
        'Copy the tenant URL and developer token; the token inherits the permissions of the user who created it.',
        'Optional: create a Domo Platform OAuth client for the documented Chart Card and PDP endpoints.',
        'In OmniKit, choose Saved API, add Domo, and enter the instance URL plus the developer token.',
        'If available, enable Platform OAuth and enter its client ID and client secret.',
        'Save, run Test, load the discovery inventory, and select only the Pages, Cards, or semantic roots in migration scope.',
      ],
      fields: ['Domo instance URL', 'Product API developer token', 'Optional Platform OAuth client ID and client secret'],
      collects: ['Pages, Cards, and DataSet discovery', 'DataSet metadata, typed schema, access lists, and Card bindings', 'Beast Mode definitions', 'OAuth-backed Chart Card, drill, and row-policy evidence when configured'],
      boundaries: ['Magic ETL and SQL DataFlow logic, App Studio behavior, and unproven governance behavior still require reviewed Manual Files.', 'A Product token alone cannot prove every Analyzer/Card or PDP behavior; OmniKit keeps those gaps visible and blocks writes.'],
      documentation: DOMO_DOCS,
    },
    manual: {
      mode: 'manual',
      title: 'Prepare a Domo evidence bundle',
      summary: 'Use Manual Files when APIs cannot close the selected scope or when you need source logic that Domo does not expose through a documented read endpoint.',
      prerequisites: ['Know the exact Pages, Cards, DataSets, Beast Modes, DataFlows, and security behavior in migration scope.', 'Export related evidence together so OmniKit can close dependencies by stable source ID.'],
      steps: [
        'Export selected Page, Card, and DataSet metadata as JSON where available.',
        'Copy every referenced Beast Mode formula and include its stable ID or name.',
        'Export SQL DataFlow text and any reviewed Magic ETL or App Studio documentation needed to preserve behavior.',
        'Include PDP/access evidence and source-to-Card/DataSet relationships for the selected scope.',
        'Place related files in one ZIP or select them together, then choose Manual Files → Domo and upload the bundle.',
        'Review what OmniKit recognized and resolve every missing dependency before planning.',
      ],
      collects: ['Domo JSON metadata', 'Beast Mode formulas', 'SQL DataFlow logic', 'Supporting CSV, YAML, text, and Markdown evidence'],
      boundaries: ['Screenshots or dashboard names alone do not prove calculations, filters, security, or drill behavior.', 'Unrecognized or incomplete exports stay blocked for explicit review.'],
      acceptedArtifacts: ['.zip', '.json', '.sql', '.txt', '.md', '.csv', '.yaml', '.yml'],
      documentation: DOMO_DOCS,
    },
  },
  looker: {
    source: 'looker',
    label: 'Looker',
    availabilityLabel: 'Compiled API + raw LookML Manual Files',
    api: {
      mode: 'api',
      title: 'Connect Looker API 4.0',
      summary: 'The Saved API path retrieves compiled Explore, Dashboard, and Look evidence. Raw LookML remains a separate Git or Manual Files authority.',
      prerequisites: ['Create a least-privilege Looker service user.', 'Grant access to the selected models and content; grant see_lookml when field SQL must be visible.', 'Create API client credentials for that user.'],
      steps: [
        'In Looker Admin, open the migration service user and create an API client ID and client secret.',
        'Record the Looker instance base URL; do not paste a short-lived access token.',
        'In OmniKit, choose Saved API, add Looker, and enter the base URL, client ID, and client secret.',
        'Optionally enter a LookML project ID to document the intended project boundary.',
        'Save, run Test, load discovery, and select the exact Explores, Dashboards, and Looks to prepare.',
        'Review missing SQL, inaccessible Looks, and unresolved tile dependencies before planning.',
      ],
      fields: ['Looker base URL', 'API client ID', 'API client secret', 'Optional LookML project ID'],
      collects: ['Compiled Explore fields, joins, access filters, and visible SQL', 'Dashboard elements, filters, queries, and layouts exposed by API', 'Look definitions and query references'],
      boundaries: ['The API does not return raw project files. Includes, refinements, extends, Liquid, manifests, PDT source, and source-only tests require raw LookML from Git or Manual Files.', 'Compiled API evidence must not be presented as a byte-for-byte LookML export.'],
      documentation: LOOKER_DOCS,
    },
    manual: {
      mode: 'manual',
      title: 'Export raw LookML',
      summary: 'Use a customer-authorized Git checkout or Looker IDE download to preserve source-authored LookML that compiled APIs cannot reproduce.',
      prerequisites: ['Obtain read access to the LookML project and the exact production revision in scope.', 'Keep imported files and referenced views together.'],
      steps: [
        'Check out or download the approved LookML project revision.',
        'Collect relevant .model.lkml, .view.lkml, and dashboard LookML files, including imported dependencies.',
        'Include manifest and project files when they affect imports, constants, localization, or access grants.',
        'Optionally add Look JSON exports for selected saved Looks.',
        'Choose Manual Files → Looker and upload all related files together.',
        'Review the parser inventory and reconcile raw LookML with any compiled API evidence before planning.',
      ],
      collects: ['Raw model, view, and dashboard LookML', 'Look JSON evidence', 'Imports and source-only semantic constructs'],
      boundaries: ['Rendered dashboards and query results are validation evidence, not substitutes for LookML source.', 'Missing imports or referenced views keep the project incomplete.'],
      acceptedArtifacts: ['.lkml', '.lookml', '.look.json', '.looks.json'],
      documentation: LOOKER_DOCS,
    },
  },
  sigma: {
    source: 'sigma',
    label: 'Sigma',
    availabilityLabel: 'Saved API + reviewed snapshot fallback',
    api: {
      mode: 'api',
      title: 'Connect the Sigma REST API',
      summary: 'Sigma API client credentials are exchanged server-side for a short-lived token. OmniKit prepares selected workbook and Data Model evidence.',
      prerequisites: ['Create a least-privilege Sigma API client with access to the selected workbooks and Data Models.', 'Know the regional Sigma API base URL.'],
      steps: [
        'In Sigma administration, create API client credentials for a dedicated migration service account.',
        'Record the client ID, client secret, and regional API base URL.',
        'In OmniKit, choose Saved API, add Sigma, and enter those three values.',
        'Save and run Test; OmniKit exchanges the credentials only on the local server.',
        'Load discovery and select exact workbook or Data Model roots.',
        'Review workbook-to-Data-Model closure, grants, schedules, and any interaction behavior requiring manual validation.',
      ],
      fields: ['Regional Sigma API base URL', 'API client ID', 'API client secret'],
      collects: ['Authoritative Data Model specifications', 'Workbook, page, element, and column evidence', 'Lineage, grants, and materialization schedule context where documented'],
      boundaries: ['Writeback, plugins, custom functions, and behavior not represented by the retrieved contract require manual review.', 'A workbook without a resolved Data Model dependency cannot be called complete.'],
      documentation: SIGMA_DOCS,
    },
    manual: {
      mode: 'manual',
      title: 'Prepare one versioned Sigma snapshot',
      summary: 'The offline fallback accepts one bounded JSON snapshot. It is for reviewed diagnostic evidence, not an undocumented Sigma export claim.',
      prerequisites: ['Pin the workbook and Data Model revision used for the snapshot.', 'Sanitize user identities and secrets before saving the file.'],
      steps: [
        'Use approved Sigma API tooling to retrieve the selected workbook and referenced Data Model specifications.',
        'Place the selected IDs, version, workbook evidence, model specifications, and dependency metadata into one JSON snapshot.',
        'Remove credentials, access tokens, and unnecessary identity data.',
        'Choose Manual Files → Sigma and upload the single JSON file.',
        'Review every unresolved dependency and behavioral handoff before planning.',
      ],
      collects: ['One versioned, sanitized Sigma API snapshot'],
      boundaries: ['Multiple unversioned files are not accepted as a coherent Sigma snapshot.', 'Manual snapshot evidence does not prove live permissions or current tenant behavior.'],
      acceptedArtifacts: ['.json'],
      documentation: SIGMA_DOCS,
    },
  },
  metabase: {
    source: 'metabase',
    label: 'Metabase',
    availabilityLabel: 'Saved API + sanitized snapshot fallback',
    api: {
      mode: 'api',
      title: 'Connect with a Metabase API key',
      summary: 'OmniKit uses the documented API key header and, where licensed and enabled, the serialization export endpoint for selected collections.',
      prerequisites: ['Create a dedicated Metabase API key with access only to the collections and databases in migration scope.', 'Confirm whether serialization is available in the deployed Metabase edition.'],
      steps: [
        'In Metabase Admin settings, create an API key for the migration service identity.',
        'Record the Metabase base URL and API key.',
        'In OmniKit, choose Saved API, add Metabase, and enter the base URL and API key.',
        'Save, run Test, and load the inventory.',
        'Select exact dashboards, cards/models, tables, or collections.',
        'For collection roots, verify that serialization completed and review every unsupported YAML entity or nested-card dependency.',
      ],
      fields: ['Metabase base URL', 'Metabase API key'],
      collects: ['Dashboards, cards/models, tables, collections, and bounded nested-card closure', 'Normalized native SQL or MBQL logic', 'Selected collection serialization when supported'],
      boundaries: ['Unsupported serialization entities, unresolved nested cards, and data-model objects excluded from the selected export require Manual Files or redesign.', 'A downloaded serialization archive is parsed by the Saved API workflow; the current Manual Files uploader does not accept the .tgz directly.'],
      documentation: METABASE_DOCS,
    },
    manual: {
      mode: 'manual',
      title: 'Prepare a sanitized Metabase snapshot',
      summary: 'Use a JSON snapshot for offline troubleshooting when Saved API access is unavailable. Do not upload a serialization .tgz directly.',
      prerequisites: ['Identify the exact dashboards, cards/models, tables, and collection relationships in scope.', 'Remove API keys, session cookies, email addresses, and other unnecessary identity data.'],
      steps: [
        'Retrieve the selected Metabase objects with approved API tooling or extract the needed records from a reviewed serialization package.',
        'Preserve stable entity IDs, native SQL or MBQL, filters, parameters, and nested-card references.',
        'Save the sanitized evidence as JSON.',
        'Choose Manual Files → Metabase and upload or paste that JSON snapshot.',
        'Review unsupported entities and add missing dependency evidence before planning.',
      ],
      collects: ['Sanitized Metabase API snapshot JSON', 'Native SQL or MBQL and dashboard/card relationships represented in that snapshot'],
      boundaries: ['The current Manual Files path does not unpack a Metabase serialization .tgz.', 'Offline evidence does not prove current permissions or live query behavior.'],
      acceptedArtifacts: ['.json'],
      documentation: METABASE_DOCS,
    },
  },
  tableau: {
    source: 'tableau',
    label: 'Tableau',
    availabilityLabel: 'Saved API + workbook/data-source exports',
    api: {
      mode: 'api',
      title: 'Connect Tableau with a personal access token',
      summary: 'OmniKit signs in server-side with a PAT, then retrieves selected workbook and data-source definitions without extracts.',
      prerequisites: ['Create a PAT for a least-privilege Tableau user with Download/ExportXml access to the selected content.', 'Know the Tableau server URL and site content URL.'],
      steps: [
        'In Tableau user account settings, create a personal access token and copy its name and secret.',
        'Record the Tableau server URL and the site content URL; the Default site may be left empty.',
        'In OmniKit, choose Saved API, add Tableau, and enter the server URL, PAT name, PAT secret, and site content URL.',
        'Save and run Test; OmniKit exchanges the PAT for a short-lived X-Tableau-Auth session.',
        'Load discovery and select exact workbooks or published data sources.',
        'Review permissions, Metadata API, refresh, subscription, virtual-connection, and packaged-resource gaps before planning.',
      ],
      fields: ['Tableau server URL', 'PAT name', 'PAT secret', 'Site content URL'],
      collects: ['Selected TWB/TWBX and TDS/TDSX definitions without extracts', 'Calculated fields, parameters, relationships, worksheets, dashboards, filters, and actions stored in those artifacts', 'Metadata, permissions, connections, refresh, and subscription context when available'],
      boundaries: ['Download permissions, virtual-connection data policies, unsupported packaged resources, and behavior outside the artifact require Manual Files or explicit review.', 'Metadata API evidence supplements but does not replace the workbook/data-source definition.'],
      documentation: TABLEAU_DOCS,
    },
    manual: {
      mode: 'manual',
      title: 'Download Tableau definitions',
      summary: 'Download workbook and published data-source definitions so OmniKit can inspect calculations, relationships, layout, filters, and actions.',
      prerequisites: ['Obtain Download/Export permissions for every selected workbook and published data source.', 'Prefer downloads without extracts to avoid moving source data unnecessarily.'],
      steps: [
        'Download each selected workbook as TWB or TWBX.',
        'Download every separately published data source used by those workbooks as TDS or TDSX.',
        'Keep related workbooks and data sources together; include supporting XML or reviewed metadata only when needed.',
        'Choose Manual Files → Tableau and upload the TWB/TWBX/TDS/TDSX files together.',
        'Review calculated fields, relationships, filters, actions, permissions, and unsupported package contents.',
      ],
      collects: ['TWB and TWBX workbook definitions', 'TDS and TDSX data-source definitions', 'Related XML evidence'],
      boundaries: ['Rendered PDFs, images, and crosstabs are validation aids, not semantic definitions.', 'Virtual-connection policies and external assets not present in the files remain manual handoffs.'],
      acceptedArtifacts: ['.twb', '.twbx', '.tds', '.tdsx', '.xml'],
      documentation: TABLEAU_DOCS,
    },
  },
  power_bi: {
    source: 'power_bi',
    label: 'Power BI / Fabric',
    availabilityLabel: 'OAuth Saved API + PBIP/PBIX Manual Files',
    api: {
      mode: 'api',
      title: 'Connect Microsoft Fabric',
      summary: 'Use a Microsoft Entra service principal or a short-lived delegated OAuth token to retrieve selected TMDL semantic-model and PBIR report definitions.',
      prerequisites: ['Grant the identity access to the Fabric workspace and selected items.', 'For service-principal access, enable the relevant Fabric tenant setting and create a client secret.', 'Definition retrieval requires the permissions documented by Microsoft; encrypted sensitivity labels can block it.'],
      steps: [
        'Choose an Entra service principal for repeatable server-side access, or obtain a short-lived delegated Fabric OAuth token.',
        'For a service principal, record the Entra tenant ID, application client ID, client secret, and Fabric workspace ID.',
        'In OmniKit, choose Saved API, add Power BI / Fabric, and select the matching authentication method.',
        'Enter the Fabric API base URL, workspace ID, and required credential fields; delegated tokens also require an expiration.',
        'Save, run Test, and select exact semantic models or reports.',
        'Review report behavior, workspace governance, sensitivity-label, permissions, and any separate Power BI-audience gaps before planning.',
      ],
      fields: ['Fabric API base URL', 'Fabric workspace ID', 'Entra tenant ID, client ID, and client secret — or delegated Fabric OAuth token and expiration'],
      collects: ['TMDL semantic-model definitions', 'PBIR report definitions', 'Tables, measures, relationships, M expressions, roles, pages, visuals, filters, and bookmarks represented by those definitions', 'Supplemental workspace governance when a compatible Power BI audience token is available'],
      boundaries: ['A delegated Fabric token is not replayed to the separate Power BI API audience; supplemental governance may require service-principal exchange or manual evidence.', 'PBIR behavior still requires review, and sensitivity labels or insufficient permissions can force a PBIP/PBIX fallback.'],
      documentation: POWER_BI_DOCS,
    },
    manual: {
      mode: 'manual',
      title: 'Export a Power BI project or PBIX',
      summary: 'Use PBIP/PBIR/TMDL for inspectable source definitions. A PBIX can also be analyzed locally when the migration engine is available.',
      prerequisites: ['Open the approved report/model revision in Power BI Desktop or obtain an authorized service download.', 'Include both semantic-model and report content when they are separate.'],
      steps: [
        'Save the project as PBIP, or download the report as PBIX when permitted.',
        'For PBIP, include the semantic model folder with TMDL or model.bim and the report folder with PBIR files.',
        'Optionally include reviewed workspace/scanner JSON for ownership and governance context.',
        'Choose Manual Files → Power BI and upload the PBIX, ZIP, selected files, or the project folder.',
        'Review model, report, RLS, visual, bookmark, and unsupported-artifact diagnostics before confirming the inventory.',
      ],
      collects: ['.pbix', 'PBIP/PBIR project files', 'TMDL, model.bim, M, JSON, and reviewed scanner metadata'],
      boundaries: ['Scanner metadata alone is not a complete semantic or report definition.', 'Direct PBIX analysis is local and read-only, but remains subject to the migration engine’s parity gate.'],
      acceptedArtifacts: ['.pbix', '.zip', '.pbip', '.pbir', '.pbism', '.tmdl', '.bim', '.json', '.m', '.yaml', '.yml'],
      documentation: POWER_BI_DOCS,
    },
  },
  microstrategy: {
    source: 'microstrategy',
    label: 'Strategy',
    availabilityLabel: 'Saved API + definition exports',
    api: {
      mode: 'api',
      title: 'Connect a Strategy project session',
      summary: 'OmniKit signs in through the documented Library REST API, binds the session to one project, retrieves selected definitions, and signs out.',
      prerequisites: ['Create or choose a least-privilege Strategy user with access to the selected project and objects.', 'Know the Library API URL and immutable project ID.'],
      steps: [
        'Confirm the Strategy Library REST API URL and project ID.',
        'Choose a dedicated username whose object access matches the intended migration scope.',
        'In OmniKit, choose Saved API, add Strategy, and enter the Library API URL, username, password, and project ID.',
        'Save and run Test; OmniKit creates a bounded server session and logs out after collection.',
        'Load discovery and select exact reports, dossiers, metrics, or filters.',
        'Review prompts, selectors, dossier visual/layout packaging, ACLs, and schedules as manual dependencies.',
      ],
      fields: ['Strategy Library API URL', 'Username', 'Password', 'Project ID'],
      collects: ['Report definitions', 'Metric and filter definitions', 'Project-bound dossier filter, selector, and dataset projections'],
      boundaries: ['The dossier endpoint is not treated as a portable full visual/layout package.', 'Complete dossier/document layout, prompts, selector behavior, ACLs, and schedules require reviewed Manual Files or redesign.'],
      documentation: STRATEGY_DOCS,
    },
    manual: {
      mode: 'manual',
      title: 'Export Strategy definitions',
      summary: 'Use JSON or YAML definition evidence when API access is unavailable or when a complete dossier/document package must supplement the API projection.',
      prerequisites: ['Identify the Strategy project and stable IDs for every selected report, dossier/document, metric, filter, attribute, and cube.', 'Export only the selected scope and remove credentials or session tokens.'],
      steps: [
        'Use documented REST calls or approved Strategy export tooling to obtain selected object definitions.',
        'Include reports, dataset/cube references, metrics, filters, attributes, prompts, and dossier/document evidence needed for closure.',
        'Save the curated evidence as JSON or YAML; extract supported definitions from any vendor package before upload.',
        'Choose Manual Files → Strategy and upload the JSON/YAML files together.',
        'Review every unresolved prompt, selector, security, schedule, and visual/layout dependency.',
      ],
      collects: ['Strategy JSON and YAML definitions', 'Report, metric, filter, attribute, cube, and dossier/document evidence'],
      boundaries: ['The current uploader does not ingest an opaque Strategy package ZIP.', 'A dossier filter projection is not proof of complete dashboard layout or behavior.'],
      acceptedArtifacts: ['.json', '.yaml', '.yml'],
      documentation: STRATEGY_DOCS,
    },
  },
  webfocus: {
    source: 'webfocus',
    label: 'WebFOCUS',
    availabilityLabel: 'Manual Files only',
    manual: {
      mode: 'manual',
      title: 'Export WebFOCUS source files',
      summary: 'Saved API is intentionally disabled until a supported credential contract is approved. Use Change Management and curated source files instead.',
      prerequisites: ['Have access to the selected WebFOCUS repository content and Change Management export.', 'Identify every procedure, Master File, Access File, portal/dashboard dependency, and schedule in scope.'],
      steps: [
        'Create a WebFOCUS Change Management export for the selected repository scope.',
        'Extract the package locally; do not upload the opaque ZIP because the current uploader does not parse it.',
        'Collect the required .fex procedures plus related .mas Master Files and .acx Access Files.',
        'Add curated JSON, XML, SQL, text, or YAML evidence only when it explains portal/dashboard structure or dependencies.',
        'Choose Manual Files → WebFOCUS and upload the extracted files together.',
        'Review joins, parameters, styling, security, schedules, external files, and every unresolved repository dependency before planning.',
      ],
      collects: ['FEX procedures', 'MAS Master Files', 'ACX Access Files', 'Curated JSON/XML/text metadata'],
      boundaries: ['Saved API makes zero outbound requests for WebFOCUS in the current release.', 'Change Management ZIPs must be extracted first, and unsupported portal/security/schedule behavior remains a manual handoff.'],
      acceptedArtifacts: ['.fex', '.mas', '.acx', '.json', '.xml', '.sql', '.txt', '.md', '.yaml', '.yml'],
      documentation: WEBFOCUS_DOCS,
    },
  },
};

export const MIGRATION_SOURCE_SETUP_OPTIONS = (Object.values(MIGRATION_SOURCE_SETUP_GUIDES) as MigrationSourceSetupGuideDefinition[])
  .map((guide) => ({ value: guide.source, label: guide.label, subtitle: guide.availabilityLabel }));

export function migrationSourceSetupGuide(source: MigrationBiSourceTool): MigrationSourceSetupGuideDefinition {
  return MIGRATION_SOURCE_SETUP_GUIDES[source];
}

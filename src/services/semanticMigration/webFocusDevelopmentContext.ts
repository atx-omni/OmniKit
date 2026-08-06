import type { MigrationDecisionAction, MigrationMappingDomain } from './types';

export const WEBFOCUS_DEVELOPMENT_CONTEXT_VERSION = 'omnikit.webfocus.development-context.v1';
export const WEBFOCUS_DOCUMENTATION_REVIEWED_AT = '2026-08-05';

export type WebFocusEvidenceClass =
  | 'repository_item'
  | 'master_file'
  | 'access_file'
  | 'field'
  | 'define'
  | 'compute'
  | 'dynamic_join'
  | 'report_procedure'
  | 'report_filter'
  | 'parameter'
  | 'include'
  | 'called_procedure'
  | 'presentation'
  | 'procedural_logic'
  | 'schedule'
  | 'security'
  | 'portal'
  | 'missing_dependency'
  | 'unknown';

export type WebFocusTargetClassification =
  | 'upstream_transformation'
  | 'omni_view'
  | 'omni_topic'
  | 'omni_query_view'
  | 'dashboard_specification'
  | 'governance_handoff'
  | 'explicit_exclusion'
  | 'unsupported';

export type WebFocusDevelopmentDisposition = 'candidate' | 'review' | 'handoff' | 'unsupported';

export type WebFocusDocumentationId =
  | 'repository-rest-content-9.3.3'
  | 'master-file-source-9.3.4'
  | 'master-file-field-9.3.4'
  | 'access-file-9.3.1'
  | 'define-field-9.1.2'
  | 'compute-field-9.3.4'
  | 'join-types-9.3.4'
  | 'report-request-9.0.0'
  | 'master-file-filter-9.3.4'
  | 'dialogue-manager-variables-9.3.6'
  | 'include-command-8.2.07'
  | 'exec-command-9.3.6'
  | 'reportcaster-9.0.2'
  | 'repository-security-8.2.07'
  | 'resources-tree-content-9.2.1';

export interface WebFocusOfficialDocumentation {
  id: WebFocusDocumentationId;
  title: string;
  productVersion: string;
  url: string;
  behavioralClaims: string[];
}

export const WEBFOCUS_OFFICIAL_DOCUMENTATION: readonly WebFocusOfficialDocumentation[] = [
  {
    id: 'repository-rest-content-9.3.3',
    title: 'WebFOCUS Repository RESTful Web Services',
    productVersion: '9.3.3',
    url: 'https://docs.tibco.com/pub/wf-wf/9.3.3/doc/html/embedded-bi-user/02REST_WS16.htm',
    behavioralClaims: [
      'Repository responses expose item metadata such as paths, handles, extensions, and content types.',
      'Retrieving the textual content of a report is a separate getContent operation.',
    ],
  },
  {
    id: 'master-file-source-9.3.4',
    title: 'Identifying a Data Source Overview',
    productVersion: '9.3.4',
    url: 'https://docs.tibco.com/pub/wf-wf/9.3.4/doc/html/describing-data-lang/ids17.htm',
    behavioralClaims: [
      'A Master File identifies a data source with attributes including FILENAME and SUFFIX.',
      'ACCESSFILE identifies an optional Access File for a FOCUS data source.',
    ],
  },
  {
    id: 'master-file-field-9.3.4',
    title: 'The Field Name: FIELDNAME',
    productVersion: '9.3.4',
    url: 'https://docs.tibco.com/pub/wf-wf/9.3.4/doc/html/describing-data-lang/dif40.htm',
    behavioralClaims: [
      'FIELDNAME is the first attribute in a Master File field declaration and identifies the field used in requests.',
    ],
  },
  {
    id: 'access-file-9.3.1',
    title: 'ibi WebFOCUS Adapter Administration',
    productVersion: '9.3.1',
    url: 'https://docs.tibco.com/pub/wf-rs/9.3.1/doc/pdf/IBI_wf-rs_9.3.1_adapter_administration.pdf',
    behavioralClaims: [
      'An Access File uses the .acx extension and links Master File segments to physical tables or views.',
      'Access File segment declarations can identify table names, key counts, and key order.',
    ],
  },
  {
    id: 'define-field-9.1.2',
    title: 'Creating Virtual Fields in TIBCO WebFOCUS',
    productVersion: '9.1.2',
    url: 'https://docs.tibco.com/webfocus/912/doc/html/topic/com.ibi.help.ia/source/resources_panel90.htm',
    behavioralClaims: [
      'A DEFINE virtual field is evaluated for retrieved records and may be declared in a Master File or a procedure.',
      'A procedure-scoped DEFINE lasts only for that procedure.',
    ],
  },
  {
    id: 'compute-field-9.3.4',
    title: 'Creating Reports With ibi WebFOCUS Language',
    productVersion: '9.3.4',
    url: 'https://docs.tibco.com/pub/wf-wf/9.3.4/doc/pdf/IBI_wf-wf_9.3.4_cr_language.pdf',
    behavioralClaims: [
      'COMPUTE creates a request-scoped calculated value after records have been retrieved.',
      'DEFINE and COMPUTE have different evaluation timing and cannot be silently treated as the same semantic object.',
    ],
  },
  {
    id: 'join-types-9.3.4',
    title: 'Join Types',
    productVersion: '9.3.4',
    url: 'https://docs.tibco.com/pub/wf-wf/9.3.4/doc/html/describing-data-lang/join85.htm',
    behavioralClaims: [
      'A JOIN command creates a dynamic joined view for a session, while Master File joins may be static or dynamic.',
    ],
  },
  {
    id: 'report-request-9.0.0',
    title: 'Developing Your Report Request',
    productVersion: '9.0.0',
    url: 'https://docs.tibco.com/appstudio/9000/doc/html/topic/reporting/CreatingReportswithWFLanguage/source/creating_reports_overview63.htm',
    behavioralClaims: [
      'A report request begins with TABLE FILE and is completed with END or RUN.',
    ],
  },
  {
    id: 'master-file-filter-9.3.4',
    title: 'Describing a Filter: FILTER',
    productVersion: '9.3.4',
    url: 'https://docs.tibco.com/pub/wf-wf/9.3.4/doc/html/describing-data-lang/dif55.htm',
    behavioralClaims: [
      'A Master File FILTER stores reusable record-selection logic and can be referenced by WHERE or IF.',
    ],
  },
  {
    id: 'dialogue-manager-variables-9.3.6',
    title: 'Customizing a Procedure With Variables',
    productVersion: '9.3.6',
    url: 'https://docs.tibco.com/pub/wf-wf/9.3.6/doc/html/en-us/dev-reporting-apps/dm52.htm',
    behavioralClaims: [
      'Dialogue Manager amper variables receive values at run time and may be passed to called procedures.',
    ],
  },
  {
    id: 'include-command-8.2.07',
    title: 'Inserting a Procedure or StyleSheet File Into Another Procedure With -INCLUDE',
    productVersion: '8.2.07',
    url: 'https://docs.tibco.com/appstudio/8207/doc/html/topic/reporting/DevelopingAppsWithWFLanguage/source/include_syntax.htm',
    behavioralClaims: [
      '-INCLUDE inserts another procedure or stylesheet and may resolve a variable-named dependency at run time.',
    ],
  },
  {
    id: 'exec-command-9.3.6',
    title: 'Customizing a Procedure With Variables',
    productVersion: '9.3.6',
    url: 'https://docs.tibco.com/pub/wf-wf/9.3.6/doc/html/en-us/dev-reporting-apps/dm52.htm',
    behavioralClaims: [
      'EX or EXEC calls another procedure and can pass named or positional parameter values.',
    ],
  },
  {
    id: 'reportcaster-9.0.2',
    title: 'TIBCO WebFOCUS ReportCaster Guide',
    productVersion: '9.0.2',
    url: 'https://docs.tibco.com/pub/wf-wf/9.0.2/doc/pdf/TIB_wfwf_9.0.0_reportcaster_guide.pdf',
    behavioralClaims: [
      'ReportCaster schedules when a procedure runs, its output format, and its distribution destination.',
      'Access to ReportCaster operations is controlled by WebFOCUS security operations.',
    ],
  },
  {
    id: 'repository-security-8.2.07',
    title: 'Managed Reporting Overview',
    productVersion: '8.2.07',
    url: 'https://docs.tibco.com/webfocus/8207/doc/html/topic/com.ibi.help.mr/source/mrintro3.htm',
    behavioralClaims: [
      'The WebFOCUS repository authorization model can grant, deny, and inherit access for users and groups at resource level.',
    ],
  },
  {
    id: 'resources-tree-content-9.2.1',
    title: 'Types of Content in the Resources Tree',
    productVersion: '9.2.1',
    url: 'https://docs.tibco.com/webfocus/921/doc/html/topic/com.ibi.help.portal/source/domain_content15.htm',
    behavioralClaims: [
      'The Resources tree can contain report procedures, reporting objects, alerts, documents, links, and ReportCaster items.',
    ],
  },
];

export interface WebFocusDevelopmentRule {
  sourceClass: WebFocusEvidenceClass;
  targetClassification: WebFocusTargetClassification;
  disposition: WebFocusDevelopmentDisposition;
  decisionDomain: MigrationMappingDomain;
  defaultDecisionAction: MigrationDecisionAction;
  requiredEvidence: string[];
  documentationIds: WebFocusDocumentationId[];
  guidance: string;
}

export const WEBFOCUS_DEVELOPMENT_RULES: readonly WebFocusDevelopmentRule[] = [
  {
    sourceClass: 'repository_item',
    targetClassification: 'unsupported',
    disposition: 'review',
    decisionDomain: 'content',
    defaultDecisionAction: 'defer',
    requiredEvidence: ['repository item ID or path', 'item type and extension', 'retrieved content', 'parent path'],
    documentationIds: ['repository-rest-content-9.3.3', 'resources-tree-content-9.2.1'],
    guidance: 'Repository listing metadata proves inventory and identity, not report semantics. Retrieve the bounded item content before planning its migration.',
  },
  {
    sourceClass: 'master_file',
    targetClassification: 'omni_view',
    disposition: 'review',
    decisionDomain: 'model',
    defaultDecisionAction: 'create_new',
    requiredEvidence: ['FILENAME', 'SUFFIX', 'segments', 'field declarations', 'Access File reference when present'],
    documentationIds: ['master-file-source-9.3.4', 'master-file-field-9.3.4'],
    guidance: 'Treat the Master File as source metadata. Confirm the target physical relation and segment behavior before creating or mapping an Omni view.',
  },
  {
    sourceClass: 'access_file',
    targetClassification: 'upstream_transformation',
    disposition: 'handoff',
    decisionDomain: 'data_source',
    defaultDecisionAction: 'defer',
    requiredEvidence: ['paired Master File', 'adapter type', 'segment-to-table mappings', 'key declarations'],
    documentationIds: ['access-file-9.3.1', 'master-file-source-9.3.4'],
    guidance: 'Use Access File mappings as physical-source evidence. Do not turn adapter or storage directives into Omni semantics.',
  },
  {
    sourceClass: 'field',
    targetClassification: 'omni_view',
    disposition: 'candidate',
    decisionDomain: 'field',
    defaultDecisionAction: 'create_new',
    requiredEvidence: ['qualified FIELDNAME', 'segment', 'USAGE', 'ACTUAL', 'ALIAS or source column'],
    documentationIds: ['master-file-field-9.3.4', 'master-file-source-9.3.4'],
    guidance: 'Preserve the declared field identity and formats. Map or create a target field only after the target column and type are proven.',
  },
  {
    sourceClass: 'define',
    targetClassification: 'omni_view',
    disposition: 'review',
    decisionDomain: 'field',
    defaultDecisionAction: 'rewrite',
    requiredEvidence: ['definition scope', 'field name', 'format', 'complete expression', 'referenced fields and functions'],
    documentationIds: ['define-field-9.1.2', 'master-file-field-9.3.4'],
    guidance: 'Preserve DEFINE as a virtual-field expression with explicit scope. Translate only through a reviewed expression decision and result validation.',
  },
  {
    sourceClass: 'compute',
    targetClassification: 'dashboard_specification',
    disposition: 'review',
    decisionDomain: 'field',
    defaultDecisionAction: 'rewrite',
    requiredEvidence: ['procedure scope', 'field name', 'format', 'complete expression', 'aggregation and sort context'],
    documentationIds: ['compute-field-9.3.4', 'report-request-9.0.0'],
    guidance: 'COMPUTE is request-scoped and evaluated after retrieval. Do not silently classify it as an Omni dimension or measure without its report context.',
  },
  {
    sourceClass: 'dynamic_join',
    targetClassification: 'omni_view',
    disposition: 'review',
    decisionDomain: 'relationship',
    defaultDecisionAction: 'rewrite',
    requiredEvidence: ['host file and fields', 'cross-referenced file and fields', 'ALL or UNIQUE behavior', 'conditional predicates', 'null and fanout results'],
    documentationIds: ['join-types-9.3.4'],
    guidance: 'A recovered JOIN statement is relationship evidence, not proof of target cardinality or fanout safety.',
  },
  {
    sourceClass: 'report_procedure',
    targetClassification: 'dashboard_specification',
    disposition: 'review',
    decisionDomain: 'content',
    defaultDecisionAction: 'rewrite',
    requiredEvidence: ['procedure source path', 'complete TABLE or GRAPH request', 'data sources', 'display and sort fields', 'filters', 'output behavior'],
    documentationIds: ['report-request-9.0.0', 'repository-rest-content-9.3.3'],
    guidance: 'Use the complete procedure as report evidence. Dashboard construction remains a reviewed build specification, not a direct FEX translation.',
  },
  {
    sourceClass: 'report_filter',
    targetClassification: 'dashboard_specification',
    disposition: 'review',
    decisionDomain: 'filter',
    defaultDecisionAction: 'rewrite',
    requiredEvidence: ['complete WHERE or IF expression', 'field types', 'parameter bindings', 'record or aggregate timing'],
    documentationIds: ['report-request-9.0.0', 'master-file-filter-9.3.4'],
    guidance: 'Preserve the source expression and timing. Do not reduce it to a target default filter without equivalence evidence.',
  },
  {
    sourceClass: 'parameter',
    targetClassification: 'omni_topic',
    disposition: 'review',
    decisionDomain: 'filter',
    defaultDecisionAction: 'rewrite',
    requiredEvidence: ['variable name and scope', 'type', 'default', 'allowed values', 'every use and called-procedure binding'],
    documentationIds: ['dialogue-manager-variables-9.3.6', 'exec-command-9.3.6'],
    guidance: 'Preserve the interactive choice and parameter flow. Never inline the observed or default value as the migrated behavior.',
  },
  {
    sourceClass: 'include',
    targetClassification: 'unsupported',
    disposition: 'review',
    decisionDomain: 'content',
    defaultDecisionAction: 'defer',
    requiredEvidence: ['literal included path or bounded variable resolution', 'included file content', 'application path and execution order'],
    documentationIds: ['include-command-8.2.07'],
    guidance: 'Resolve the included file into dependency closure. A variable-named include remains ambiguous until every possible target is bounded.',
  },
  {
    sourceClass: 'called_procedure',
    targetClassification: 'unsupported',
    disposition: 'review',
    decisionDomain: 'content',
    defaultDecisionAction: 'defer',
    requiredEvidence: ['called procedure path', 'called content', 'named and positional parameters', 'local and global variable behavior'],
    documentationIds: ['exec-command-9.3.6', 'dialogue-manager-variables-9.3.6'],
    guidance: 'Resolve the called procedure and parameter contract before migration planning. Do not assume EX and EXEC repository behavior are interchangeable.',
  },
  {
    sourceClass: 'presentation',
    targetClassification: 'dashboard_specification',
    disposition: 'unsupported',
    decisionDomain: 'visual',
    defaultDecisionAction: 'defer',
    requiredEvidence: ['output format', 'stylesheet', 'headings and footings', 'layout and interaction evidence'],
    documentationIds: ['compute-field-9.3.4', 'report-request-9.0.0'],
    guidance: 'Preserve formatting directives as presentation evidence. They do not establish automatic visual or pixel-parity translation.',
  },
  {
    sourceClass: 'procedural_logic',
    targetClassification: 'upstream_transformation',
    disposition: 'handoff',
    decisionDomain: 'data_source',
    defaultDecisionAction: 'defer',
    requiredEvidence: ['complete control flow', 'variables', 'side effects', 'called resources', 'execution owner and validation plan'],
    documentationIds: ['dialogue-manager-variables-9.3.6', 'include-command-8.2.07', 'exec-command-9.3.6'],
    guidance: 'Branching, looping, file I/O, maintenance, and command execution are not semantic YAML. Route them to an explicit upstream or application handoff.',
  },
  {
    sourceClass: 'schedule',
    targetClassification: 'governance_handoff',
    disposition: 'handoff',
    decisionDomain: 'schedule',
    defaultDecisionAction: 'defer',
    requiredEvidence: ['procedure', 'frequency and timezone', 'parameters', 'format', 'distribution destination', 'owner and recipients'],
    documentationIds: ['reportcaster-9.0.2'],
    guidance: 'ReportCaster behavior requires a separately owned operational decision; it is not created by semantic or dashboard compilation.',
  },
  {
    sourceClass: 'security',
    targetClassification: 'governance_handoff',
    disposition: 'handoff',
    decisionDomain: 'permission',
    defaultDecisionAction: 'defer',
    requiredEvidence: ['resource path', 'effective user and group rules', 'inheritance', 'explicit grants and denials', 'security owner'],
    documentationIds: ['repository-security-8.2.07', 'reportcaster-9.0.2'],
    guidance: 'Repository policy strings or ownership metadata are evidence only. Require an identity-class access review before target permissions are approved.',
  },
  {
    sourceClass: 'portal',
    targetClassification: 'dashboard_specification',
    disposition: 'handoff',
    decisionDomain: 'content',
    defaultDecisionAction: 'defer',
    requiredEvidence: ['portal pages', 'navigation', 'content bindings', 'runtime parameters', 'responsive behavior', 'security'],
    documentationIds: ['resources-tree-content-9.2.1', 'repository-security-8.2.07'],
    guidance: 'Treat portal composition as an explicit dashboard or application redesign. Repository membership alone does not prove layout or interaction behavior.',
  },
  {
    sourceClass: 'missing_dependency',
    targetClassification: 'unsupported',
    disposition: 'unsupported',
    decisionDomain: 'model',
    defaultDecisionAction: 'defer',
    requiredEvidence: ['referencing source ID', 'referenced source name or path', 'complete referenced artifact'],
    documentationIds: ['master-file-source-9.3.4', 'include-command-8.2.07', 'exec-command-9.3.6'],
    guidance: 'Missing dependencies block readiness. Supply the referenced artifact or record an accountable exclusion; never synthesize its behavior.',
  },
  {
    sourceClass: 'unknown',
    targetClassification: 'unsupported',
    disposition: 'unsupported',
    decisionDomain: 'model',
    defaultDecisionAction: 'defer',
    requiredEvidence: ['official artifact type', 'versioned export contract', 'source identifier', 'complete content'],
    documentationIds: [],
    guidance: 'Unknown WebFOCUS evidence remains unsupported until an official source contract and deterministic parser are available.',
  },
];

const RULE_BY_CLASS = new Map(WEBFOCUS_DEVELOPMENT_RULES.map((rule) => [rule.sourceClass, rule]));
const DOCUMENTATION_BY_ID = new Map(WEBFOCUS_OFFICIAL_DOCUMENTATION.map((reference) => [reference.id, reference]));

export function webFocusDevelopmentRule(sourceClass: WebFocusEvidenceClass): WebFocusDevelopmentRule {
  const rule = RULE_BY_CLASS.get(sourceClass);
  if (!rule) throw new Error(`No WebFOCUS development rule is registered for ${sourceClass}.`);
  return {
    ...rule,
    requiredEvidence: [...rule.requiredEvidence],
    documentationIds: [...rule.documentationIds],
  };
}

export function webFocusOfficialDocumentation(
  documentationIds: readonly WebFocusDocumentationId[],
): WebFocusOfficialDocumentation[] {
  return documentationIds.map((id) => {
    const reference = DOCUMENTATION_BY_ID.get(id);
    if (!reference) throw new Error(`No official WebFOCUS documentation is registered for ${id}.`);
    return { ...reference, behavioralClaims: [...reference.behavioralClaims] };
  });
}

export const WALKTHROUGH_VERSION = '2026-08-09-fleet-admin-consolidation-v1';
export const WALKTHROUGH_DISPLAY_VERSION = 'Updated August 9, 2026';
export const WALKTHROUGH_STORAGE_KEY = 'omnikit:walkthrough:v1';

export type WalkthroughStepId =
  | 'start'
  | 'connect'
  | 'workflow-map'
  | 'instance-manager'
  | 'dashboard-ai'
  | 'dashboard-builder'
  | 'excel-dashboard'
  | 'dashboard-migrator'
  | 'model-migrator'
  | 'dashboard-operations'
  | 'downloads-decks'
  | 'readiness'
  | 'semantic-studio'
  | 'semantic-migration'
  | 'governance'
  | 'privacy'
  | 'review-rhythm';

export interface WalkthroughStep {
  id: WalkthroughStepId;
  route: string;
  label: string;
  title: string;
  purpose: string;
  directions: string[];
  outcome: string;
  caution?: string;
}

export interface WalkthroughStorageState {
  version: string;
  dismissedAt?: string;
  completedAt?: string;
  lastOpenedAt?: string;
  openCount?: number;
}

export const walkthroughSteps: WalkthroughStep[] = [
  {
    id: 'start',
    route: '/',
    label: 'Fleet',
    title: 'Start in Fleet Command Center',
    purpose: 'Home is the portfolio operating view for every saved Omni instance in the unlocked native vault. It separates operational readiness, adoption, content, and exceptions while preserving exact coverage and freshness evidence.',
    directions: [
      'Unlock or create the local vault on Home. Fleet renders whenever that vault contains a saved instance, even when no active working instance is selected.',
      'Move between Overview, Operational, Adoption, Content, and Exceptions without mixing collection readiness with adoption evidence.',
      'Filter by saved instance, explicitly attributed connection, state, freshness, 7/30/90-day window, or search. Environment and tag filtering remains unsupported until a governed source exists.',
      'Open lazy instance or connection drilldowns; the supported view, filter, time, and search context carries into Administration workflows.',
      'Inspect status, reason, source, coverage, exclusions, and original freshness before acting. Unavailable evidence is never displayed as zero.',
    ],
    outcome: 'You can start from trustworthy portfolio evidence and move into the exact saved-instance workflow that needs attention.',
    caution: 'Adoption lifecycle metrics count source records, not unique people. Only explicit connection attribution can support connection filtering; inferred or unknown relationships are not access or permission evidence.',
  },
  {
    id: 'connect',
    route: '/',
    label: 'Vault',
    title: 'Unlock the fleet, then choose a working instance when needed',
    purpose: 'Home is the front door. Unlocking the local vault opens Fleet across all saved instances; selecting one active working instance is required only for connection-dependent workflows.',
    directions: [
      'Create or unlock the native vault on Home.',
      'Add a saved instance if the vault is empty, using the Omni base URL and API key from the admin team.',
      'Review Fleet first; changing the sidebar working-instance selection does not narrow the Fleet portfolio.',
      'Choose a working instance before entering a connection-dependent Administration, dashboard, model, migration, or delivery workflow. The browser receives only a non-secret vault reference.',
      'Use the sidebar or a Fleet drilldown to continue with the relevant workflow.',
    ],
    outcome: 'Fleet remains independent of the working-instance session while scoped workflows receive the saved instance they require.',
    caution: 'Plaintext saved-instance API keys stay encrypted in the native vault and are not returned to the browser.',
  },
  {
    id: 'workflow-map',
    route: '/admin/fleet',
    label: 'Workflow Map',
    title: 'Choose the workflow by the job you need done',
    purpose: 'Each page is built around one admin job. Users do not need to understand the underlying APIs before starting.',
    directions: [
      'Fleet Command Center is the cross-instance operating view for coverage, readiness, adoption, content, and exceptions.',
      'Administration has four workspaces: Fleet & Readiness, Identity & Access, Content Operations, and Embed & Developer Tools.',
      'Dashboard AI & Delivery is for dashboard reviews, migration, downloads, deck creation, and bulk dashboard operations.',
      'AI Semantic Studio and BI Migration Studio handle governed semantic creation and source-to-Omni migration separately from Administration.',
      'Existing Administration bookmarks continue through query-preserving aliases, but new navigation uses the canonical workspace routes.',
    ],
    outcome: 'The user can pick the right page without guessing which technical object matters first.',
  },
  {
    id: 'instance-manager',
    route: '/admin/fleet/instances',
    label: 'Instances',
    title: 'Set up saved Omni instances once',
    purpose: 'Instance Manager is the saved-profile workspace inside Fleet & Readiness. It uses a native encrypted local vault so technical admins can reuse source and destination Omni profiles without re-entering API keys.',
    directions: [
      'Unlock or create the native vault, then add source, destination, or source + destination instance profiles.',
      'If you are moving from omni-multi-instance-tools, use Import legacy multi-instance vault, run the dry run first, import valid profiles, then test each imported instance.',
      'Save default model IDs, folder IDs or folder paths, and tag-based metric filters.',
      'Return to Home for the cross-instance Fleet views; use the canonical Connections leaf for the selected working instance.',
      'Complete portfolio refreshes can add one compact encrypted snapshot per UTC day. History is same-day idempotent, bounded to 90 days, and excludes raw identities, credentials, URLs, and upstream responses.',
    ],
    outcome: 'Admins can manage reusable instance profiles and evidence history while keeping secrets and raw identity data out of the browser.',
    caution: 'Native vault secrets are not included in browser backups. Resetting the native vault removes saved instance profiles and local migration job history.',
  },
  {
    id: 'dashboard-ai',
    route: '/dashboards/ai-studio',
    label: 'Dashboard AI',
    title: 'Use AI Dashboard Studio for dashboard review and build handoff',
    purpose: 'AI Dashboard Studio is the dashboard-facing workspace. It has three lanes: build a new dashboard, convert Excel workbook evidence into a guarded dashboard draft, or review an existing dashboard.',
    directions: [
      'Use Build New Dashboard when you have a new dashboard request and want Omni chat to create a first-pass draft from selected model/topic context.',
      'Use Excel to Dashboard when a workbook contains formulas, summary tables, or charts that should inform a dashboard draft and identify follow-up model work.',
      'Use Review Existing Dashboard when you already have an Omni dashboard and need a quality, usability, or semantic-risk review.',
    ],
    outcome: 'Users can choose the right dashboard lane without needing to know API details or semantic YAML syntax.',
    caution: 'Dashboard Studio starts dashboard work and handoff conversations. Any model changes still route to AI Semantic Studio.',
  },
  {
    id: 'dashboard-builder',
    route: '/dashboards/ai-studio',
    label: 'Build',
    title: 'Build a new dashboard, then finish in Omni chat',
    purpose: 'Build New Dashboard turns a plain-English dashboard request into a first-pass Omni dashboard draft or a dashboard build brief, using only the selected model and topic context.',
    directions: [
      'Select the Omni model and optional topic first so Blobby has the right field universe.',
      'Describe the audience, business goal, KPIs, filters, layout, and color or brand style in normal language.',
      'Review the returned dashboard as a draft: confirm tile errors, chart types, color use, and blocked semantic gaps before sharing it.',
    ],
    outcome: 'The user leaves OmniKit with an Omni chat and first-pass dashboard path that is ready for human review and iteration.',
    caution: 'Ratio metrics such as AOV should be blocked unless the model already has a confirmed order-level ratio. Blobby should route missing measures to AI Semantic Studio.',
  },
  {
    id: 'excel-dashboard',
    route: '/dashboards/ai-studio',
    label: 'Excel',
    title: 'Convert Excel into a dashboard draft and next-step list',
    purpose: 'Excel to Dashboard parses an .xlsx workbook in page memory, summarizes sheets, formulas, and charts, then asks Blobby to draft safe dashboard tiles from existing fields while listing any needed model changes as follow-ups.',
    directions: [
      'Upload the workbook and review the inventory: sheets, formulas, likely measure candidates, and chart evidence.',
      'Run Convert Formulas & Visuals first. Formula candidates that need new modeled measures become follow-up tasks, not automatic topic or view updates.',
      'Use Start Guarded Draft Chat only for safe tiles that map to existing Omni fields. Blocked formulas, lookup tabs, and unvalidated ratios stay out of the draft until AI Semantic Studio work is complete.',
    ],
    outcome: 'A workbook becomes a clear dashboard handoff: what can be drafted now, what model work comes next, and what questions the owner must answer.',
    caution: 'Raw workbook contents are not stored by default. Missing lookup tabs, manually entered summaries, and hardcoded thresholds require human validation.',
  },
  {
    id: 'dashboard-migrator',
    route: '/dashboards/migrate',
    label: 'Migrate',
    title: 'Use Dashboard Migrator for reviewed copy/import jobs',
    purpose: 'Dashboard Migrator copies selected dashboards from a source instance and connection into one or more destination routes. Each route has its own target instance, connection, model, folder, query-view decisions, and topic choices. Model Migrator handles broader semantic-layer branch migration separately.',
    directions: [
      'Unlock the native vault, then choose the source instance and connection to load dashboards across that connection.',
      'Select dashboards after confirming their current folder, model, and topic metadata.',
      'Keep the default dashboard group when every selected dashboard should move together, or create groups when different source model/topic scopes need separate routes.',
      'Add destination rows, then use the route assignment map to choose which dashboard groups go to which destinations.',
      'Resolve dependencies before review: map/create/ignore missing fields, inspect code diffs when model/topic/query-view YAML needs changes, and apply safe recommendations in bulk when OmniKit can prove the route is compatible.',
      'Resolve detected query views before topics: compatible exact matches auto-map, stale matches require an explicit unchanged, create-missing, or checksum-protected update choice, and create-missing query views keep the source name so dashboard/topic references stay aligned.',
      'Map detected source topics by route: use an existing target topic when it matches and its scope is compatible, or create a new target topic before import when the target model is compatible.',
      'Keep same-name handling on for clean reruns: update matching destination dashboards in place when Omni supports it, or explicitly choose replace when a new document identity is acceptable.',
      'Choose whether to move the source dashboard to Trash after verified success.',
      'Run the readiness check, then review the route map so each group-to-destination path is clear before starting. OmniKit rechecks accepted YAML decisions before run and sends failed prep items back to Step 4 when a dependency needs repair.',
      'During the job, use the live board to watch export, field preparation, query-view preparation, relationship preparation, topic preparation, import, metadata, schema refresh, and source-delete status.',
    ],
    outcome: 'Dashboard migration work becomes a reviewed, retryable copy/import job with clear route paths, field/query-view/relationship/topic dependency prep, folder placement, same-name update or replacement handling, metadata preservation, schema refresh, and source cleanup.',
    caution: 'The readiness check reviews field presence, query-view/topic scope, code patch freshness, and job shape, not business-definition equivalence. Source cleanup should be enabled only when the imported dashboard has been verified enough for the operational handoff.',
  },
  {
    id: 'model-migrator',
    route: '/models/migrate',
    label: 'Model Migrator',
    title: 'Safely move semantic models from saved instances',
    purpose: 'Model Migrator is the semantic-layer workflow. It checks instance readiness, matches source models to target models, recommends the safest migration path, resolves data-location differences, and stages content-aware publish jobs.',
    directions: [
      'Unlock the native vault, then choose the source instance, connection, and shared models.',
      'Choose the target instance and connection. OmniKit suggests likely target models and explains the match confidence.',
      'Review the recommended path: automatic copy, review/adapt changes, PR handoff, or impact report only.',
      'Map source data locations to target data locations, prepare differences, and accept only the YAML changes you want staged.',
      'Check affected dashboard and workbook content, then stage and validate the migration before publishing.',
    ],
    outcome: 'Admins can move semantic models with guided readiness, target matching, content impact, safe working copies, validation, and direct publish or review handoff.',
    caution: 'OmniKit stages changes first. Publish only after validation, and disclose unsupported schedules, sharing, alerts, and permission artifacts in results.',
  },
  {
    id: 'dashboard-operations',
    route: '/dashboards/operations',
    label: 'Dashboards',
    title: 'Move, copy, or delete dashboards with confirmation',
    purpose: 'Dashboard workflows are designed for careful content operations with visible selections and final confirmation.',
    directions: [
      'Choose move, copy, or delete based on the operation you need.',
      'Select the dashboards and destination folder, then review the selected-state badges.',
      'Use the confirmation step and History log to keep an audit trail.',
    ],
    outcome: 'Dashboard work is handled as a reviewed operation instead of a blind one-click change.',
    caution: 'Delete workflows use extra confirmation. Keep that friction; it protects production content.',
  },
  {
    id: 'downloads-decks',
    route: '/deck-builder',
    label: 'Exports',
    title: 'Download dashboards or turn tiles into presentation decks',
    purpose: 'OmniKit supports both direct dashboard exports and repeatable PowerPoint deck generation from live Omni tiles.',
    directions: [
      'Use Dashboard Downloads when you need local dashboard export files.',
      'Use Deck Builder to select dashboard tiles, filters, templates, and layout options.',
      'Review the deck package before sharing it with stakeholders.',
    ],
    outcome: 'Users can move from live dashboard content to reusable files or presentation-ready material.',
  },
  {
    id: 'readiness',
    route: '/admin/content/health',
    label: 'Readiness',
    title: 'Verify documented readiness without guessing',
    purpose: 'Each Administration workspace can verify documented read capabilities on demand. Evidence state stays separate from whether operator action is required.',
    directions: [
      'Choose an active working instance, then select Verify read capabilities in the relevant Administration workspace.',
      'Read evidence state as not checked, available, partial, unauthorized, unsupported, unavailable, failed, or stale; read readiness separately as ready, action required, not configured, or unknown.',
      'Inspect coverage, exclusions, reason, source, and checked time. A complete empty read can be zero; an incomplete or failed read cannot.',
      'Use fixed Omni or documentation links for settings that have no documented GET contract. OmniKit does not turn those settings into undocumented writes.',
      'Treat model-role assignments as returned role evidence only, not proof of effective content, row, field, or query access.',
    ],
    outcome: 'Admins can distinguish confirmed readiness, evidence gaps, and manual configuration work before making operational changes.',
  },
  {
    id: 'semantic-studio',
    route: '/topics',
    label: 'AI Semantic',
    title: 'Use AI Semantic Studio for governed semantic changes',
    purpose: 'AI Semantic Studio helps admins build or improve a complete topic solution by reviewing the model, views, query views, relationships, topic, and access together before any branch change.',
    directions: [
      'Start with Build a topic end to end for a new business use case, or Improve an existing topic when the authored topic already exists.',
      'Select the model, name or choose the topic, and review the dependency plan in build order: model, views and query views, relationships, topic, then access.',
      'For each dependency, explicitly reuse, update, create, or exclude it. Required exclusions remain blocked instead of silently creating a broken topic.',
      'Review the generated full-file YAML and staged diffs, approve any removals, apply the package to one dev branch, and run model plus content validation.',
      'Use Blobby repair only for validation errors inside the reviewed package. Finish with a pull-request handoff in Omni; OmniKit does not merge this workflow directly.',
      'Open Advanced only when you intentionally need one model, relationship, view, topic, or permission file instead of a complete topic solution.',
    ],
    outcome: 'A complete semantic dependency chain is reviewed, generated in order, validated on one development branch, and handed to a human for final approval.',
    caution: 'External BI-platform artifacts belong in BI Migration Studio. Dashboard screenshots remain out of scope.',
  },
  {
    id: 'semantic-migration',
    route: '/semantic-migrations',
    label: 'Migration Studio',
    title: 'Migrate existing BI work into Omni with reviewed controls',
    purpose: 'BI Migration Studio inventories work from Domo, Power BI, Tableau, Sigma, Looker, WebFOCUS, or MicroStrategy, then separates upstream transformation work from Omni semantic work before compilation, validation, and dashboard construction. The selected AI option proposes reviewed intent but never receives direct write access to Omni.',
    directions: [
      'Connect the source BI platform and confirm the destination Omni instance. Omni AI is already selected as the included default through that active saved instance; choose another provider only when the migration should use external model credits.',
      'When adding an optional external AI provider, choose its authentication method and follow the matching credential-creation guide. External provider credentials stay encrypted in the native vault, and the panel states exactly what OmniKit stores. Record the credential owner, expiration, and rotation date, then run Test. Generation-provider tests execute a minimal structured-output contract; Omni AI verifies the saved instance link and validates output on the first governed job.',
      'For OpenAI, select the intended API project, create a project service account for shared automation when appropriate, create a project-scoped API key, copy it once into the vault profile, select an allowed model, and run Test. Rotate or revoke the key in the same OpenAI project and replace the saved value before its rotation date.',
      'For Anthropic, select the intended Claude Console workspace, confirm Limited Developer, Developer, or Admin key-management access and billing, create a named workspace API key with an expiration, save it with an available Claude model, and run Test. Disable or delete it from the Console workspace and update the vault profile immediately.',
      'For Snowflake Cortex, use a dedicated identity and least-privilege default role with Cortex REST access, then supply a short-lived OAuth access token. OmniKit stores only that bearer token, never a password, OAuth client secret, or refresh token. Select a model family that supports JSON-schema response formatting, record expiration, and run the exact structured-output Test.',
      'For a Databricks Foundation Model, grant an OAuth identity CAN QUERY on a chat-compatible Model Serving endpoint, enter the workspace origin and exact endpoint name, supply the short-lived OAuth access token, then run Test. OmniKit requires a READY endpoint and verifies the same structured-output invocation contract used during migration.',
      'For Databricks Genie, grant an OAuth identity access to one curated Genie Agent and its backing SQL warehouse, copy that Agent ID (formerly Space ID), and supply a short-lived OAuth access token. OmniKit allows one saved Genie profile and binds it to that one immutable Agent ID. Enter the workspace origin, record expiration, and run Test.',
      'For Omni AI, save and validate an appropriately scoped Organization API key or PAT with the Omni instance on Home. BI Migration Studio links that active instance automatically and uses the target model selected during migration; no second provider profile or secret is required.',
      'Load the searchable source catalog, explicitly select dashboards or semantic roots, and inspect each dependency closure. OmniKit follows bounded provider pagination and labels a bounded catalog as selection metadata only. A clean bounded catalog may validate tenant access, but only exact selected-scope prepared evidence can unlock planning.',
      'Review the six-class source coverage matrix for semantic objects, dashboards, filters, layout, permissions, and schedules. Partial, export-required, or unsupported evidence requires acknowledgement and remains visible through validation and reconciliation.',
      'For Domo Saved API, use a tenant-bound server-side Product API developer token for catalog, DataSet definition/access, Page/Card membership, and Beast Mode evidence. Add optional Platform OAuth client credentials for authoritative Chart Card, Page-detail, and PDP evidence. OmniKit requests only documented endpoints, keeps all credentials and exchanged tokens server-side, and requires exact-scope Preview handoffs for every evidence class the configured combination cannot prove; those handoffs block Apply-to-Dev and release readiness.',
      'For manual Domo work, use Add files, Review evidence, and Ready to upload related Pages, Page/Card links, Cards, dataset schemas, Beast Modes, SQL DataFlows, relationships, PDP/access, ownership/usage, and schedule/alert evidence together. Exact shared formulas are reused; different same-named formulas remain additive candidates. Non-SQL Magic ETL, Workbench, connector, custom-app, and embed evidence becomes an accountable handoff instead of a claimed automatic conversion.',
      'Select Domo Pages or individual Cards only after closure is complete. OmniKit blocks planning when selected Card, dataset, schema, field, filter, or exact Card-plan evidence is missing, compiles only approved decisions to one dev branch, and reconciles every selected Page, Card, governance item, operational item, dashboard build, waiver, and handoff.',
      'For professional Looker work, use Manual files for a coherent LookML project unit or Saved API for a scoped project and dashboard inventory. Both paths feed the same canonical IR V2 contract. Review views, measures, Explores, joins, parameters, dynamic fields, queries, pivots, filters, listener bindings, and hidden dependencies while keeping PDTs, access filters, Liquid, refinements, table calculations, merged results, permissions, schedules, and other unsupported evidence visible.',
      'Treat Looker as Preview while the deterministic engine remains in shadow. Before completion, execute every required target query, reconcile representative non-sensitive results, account for every tile and filter-listener binding, and assign an owner to every waiver. Permissions and schedules require separate reconciliation, and the native normalized parser remains the immediate rollback path.',
      'Treat Sigma as Preview while its deterministic engine remains in shadow. Use Saved API with a scoped Sigma API client ID and secret for selected Data Model specifications and workbook evidence; use a versioned offline API snapshot through Manual Files only as a reviewed fallback. Review controls, formulas, lineage, grants, export schedules, materializations, input tables, writeback, and actions explicitly; generated SQL is evidence rather than source-query validation, and unsupported behavior requires a governed handoff.',
      'For manual MicroStrategy work, upload project metadata, report or cube definitions, and dashboard or document definitions together. OmniKit normalizes attributes, metrics, relationships, chapters, pages, visualizations, filters, and prompts while keeping selectors, security filters, derived elements, report limits, and unsupported visual behavior visible. The optional synthetic sample is review-only and does not represent customer or production data.',
      'For manual Power BI work, add a PBIP project folder or bounded ZIP, individual model.bim or TMDL files, split PBIR, legacy report JSON, and optional Workspace Scanner JSON. OmniKit validates file count and declared size before reading, normalizes project-scoped selectable reports, preserves same-named objects as separate evidence, and blocks unlinked files until you associate them with the selected reports.',
      'Before confirming Power BI evidence, review the selected provider, normalized artifact categories, prompt budget, and redaction statement. Raw source snippets are off by default and require an explicit bounded opt-in. Normalized and raw evidence share one outbound redaction boundary for principal identities, email and user-ID shapes, credentials, and bearer tokens. Complete requests above the configured budget are blocked rather than truncated.',
      'Large Power BI reports are planned in deterministic evidence chunks. OmniKit validates each chunk and the complete selected visual index before readiness, so duplicate, missing, or invented dashboard plans and visual IDs cannot silently pass.',
      'Untouched AI plan output must satisfy the dashboard contract before OmniKit adds defaults. Every selected visual must appear exactly once, and each tile field must trace to its visual evidence or an approved map/create decision. Complete selected-scope canonical evidence carries coverage counts; mandatory evidence is chunked or blocks explicitly rather than being silently shortened.',
      'Prompt content is sanitized during construction and again on the local server immediately before direct or queued provider invocation. Contract IDs needed for reconciliation are preserved while credentials, tokens, emails, and identity-shaped values are removed; prompt limits are checked after sanitation.',
      'Power BI migration is structural assistance, not automatic parity. Validate DAX and filter-context results, Power Query behavior, RLS identity assignment, bookmark and interaction behavior, unsupported custom visuals, theme translation, and destination appearance. Missing evidence remains visible and cannot silently pass.',
      'The bundled Power BI sample is synthetic review data. It does not represent customer or production data, and its benchmark measures parser evidence rather than production behavior.',
      'Curate only the selected closure before AI analysis: mark included dependencies to migrate, consolidate, redesign, defer, or retire, then assign migration waves.',
      'Confirm each distinct source connection against a destination Omni connection. Ambiguous mappings need an explicit choice. If selected mappings cannot share one target model, split them into separate destination routes rather than collapsing them.',
      'Choose the destination Omni model and review the canonical dependency evidence.',
      'In Place, review OmniKit\'s deterministic recommendation for every artifact. Approve or override whether it belongs in an upstream transformation, Omni model view, Omni topic, Omni query view, automation handoff, governance handoff, or exclusion. Scheduled, incremental, stateful, materialized, side-effecting, scripted, and heavy logic never defaults to a query view.',
      'When upstream work is required, choose Generic SQL, dbt, Snowflake, Databricks, or MotherDuck and export the portable checksummed package. Export is the default; OmniKit does not silently deploy transformation code or write to a production target.',
      'In Resolve, decide every blocking Omni difference by mapping, creating, rewriting, ignoring, or deferring it. Only approved Omni placements are compiled into semantic YAML.',
      'Review what will be shared with the selected AI option. Source content is treated as untrusted data, and only task-scoped evidence is sent through HTTPS with local policy, allowlist, rate, and redaction controls.',
      'Compile approved decisions, semantic YAML, dependency coverage, and one typed build plan per selected dashboard into a deterministic versioned migration bundle. The AI does not write directly. The exact source scope, target model, plans, decisions, and YAML are fingerprinted, so any stale or incomplete preparation blocks dev-branch creation before an Omni write can start.',
      'Assign an accountable owner and an approved map, redesign, defer, or exclude outcome to every discovered identity, permission, recipient, filter, time-zone, schedule, and connector coverage gap. These items replace generic security or operations warnings and block clean sign-off while required outcomes remain open.',
      'Optionally add redacted source and target screenshots in matching order. OmniKit compares them locally and retains only safe references, dimensions, SHA-256 hashes, perceptual hashes, and findings. AI visual review is opt-in and never sends screenshots automatically.',
      'Review upstream target-dialect, schema, grain, and representative-result evidence alongside Omni structural and semantic validation, query, visual, governance, operational, and owner-acceptance evidence. Unsupported or unrun checks remain unverified and require an explicit waiver or owner-assigned disposition before sign-off. Dashboard construction stays blocked until every required upstream and Omni checkpoint is complete.',
      'Open the checksum-protected semantic branch, inspect its diff, and explicitly confirm readiness. OmniKit then asks Omni AI to build one selected dashboard at a time, preserving independent status and retry.',
      'Review the constructed dashboards, unresolved evidence, exceptions, and rollback guidance, export the sanitized reconciliation report, then complete final approval in Omni.',
    ],
    outcome: 'The customer can explain which dashboards were selected, why every dependency was included, what changed, what was validated or waived, and the outcome of every Omni AI dashboard build.',
    caution: 'Raw source artifacts and AI responses remain in page or encrypted transient memory by default. Sanitized job history and live engine acceptance evidence exclude prompts, source payloads, generated YAML, identifiers, and credentials. Offline conformance proves the extractor contract, not customer-result parity. Model Migrator remains the separate Omni-to-Omni promotion workflow.',
  },
  {
    id: 'governance',
    route: '/admin/identity/users',
    label: 'Administration',
    title: 'Use four Administration workspaces',
    purpose: 'The consolidated workspaces keep existing Administration capabilities reachable without making inferred access claims or adding undocumented tenant mutations.',
    directions: [
      'Use Fleet & Readiness for saved instances, connections, API capability, duplicate origins, and refresh evidence.',
      'Use Identity & Access for users, groups, bulk import, inactivity, embed-entity activity, sanitized attributes, and one explicit lazy model-role read.',
      'Use Content Operations for content health, schedules, uploads, labels, and validator or job readiness. Latest schedule evidence is not run history, reliability, or an SLA.',
      'Use Embed & Developer Tools for embed-user evidence, Standard SSO requests, audit/developer guidance, and allowlisted Omni deep links.',
      'For Standard SSO, supply the secret for one local request. It is cleared after every attempt, no recent signed-URL ledger is kept, and changing an identity field invalidates the displayed URL.',
      'Use the keyboard throughout: skip to main content, tab through workspace controls, use Escape to close dialogs, and expect focus to return to the opener.',
    ],
    outcome: 'Administration work stays organized, evidence-aware, keyboard accessible, and reviewable before it affects other users.',
    caution: 'A generated signed URL confirms that Omni accepted the signing request; it does not prove end-user access. Treat the URL itself as sensitive.',
  },
  {
    id: 'privacy',
    route: '/data-privacy',
    label: 'Privacy',
    title: 'Know exactly what is stored locally',
    purpose: 'OmniKit is local-first. The Data & Privacy page explains what is stored in the browser and gives users controls to export, import, or clear it.',
    directions: [
      'Review IndexedDB records for operation history and saved app metadata.',
      'Review localStorage and sessionStorage entries for browser-based state.',
      'Review the native vault path and reset controls for encrypted instance profiles, compact Fleet daily history, and local migration job history.',
      'Use Instance Manager for one-time legacy multi-instance vault imports; keep the old tool data folder until imported profiles are verified.',
      'Use Clear all local data for browser data, and Reset native vault only when saved instance profiles should be removed.',
    ],
    outcome: 'Users can trust what the local app keeps and can cleanly reset it.',
  },
  {
    id: 'review-rhythm',
    route: '/history',
    label: 'Review',
    title: 'Use history and validation as the operating rhythm',
    purpose: 'The safest OmniKit habit is simple: select, review, apply only when validation passes, then use History and Omni review screens as the audit trail.',
    directions: [
      'Check History after meaningful operations or dashboard migration jobs.',
      'Open a migration job detail to review redacted step history, retry lineage, imported document IDs, warnings, and post-action results.',
      'Prefer dev branches and validation for semantic changes.',
      'Return to this guide from the sidebar any time someone needs a refresher.',
    ],
    outcome: 'Teams get a repeatable, low-anxiety workflow for day-to-day Omni administration.',
  },
];

export function readWalkthroughState(): WalkthroughStorageState | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(WALKTHROUGH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as WalkthroughStorageState;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function writeWalkthroughState(next: WalkthroughStorageState): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(WALKTHROUGH_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Walkthrough persistence is helpful, not critical.
  }
}

export function clearWalkthroughState(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(WALKTHROUGH_STORAGE_KEY);
  } catch {
    // Ignore storage failures.
  }
}

export function shouldAutoOpenWalkthrough(state: WalkthroughStorageState | null): boolean {
  return !state || state.version !== WALKTHROUGH_VERSION;
}

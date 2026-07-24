import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('AI Semantic Studio and BI Migration Studio are independent routes', () => {
  const topicsPage = source('src/pages/TopicsPage.tsx');
  const migrationPage = source('src/pages/SemanticMigrationPage.tsx');
  const app = source('src/App.tsx');
  const sidebar = source('src/components/layout/Sidebar.tsx');
  const connectionGuard = source('src/components/layout/RequireConnection.tsx');

  assert.doesNotMatch(topicsPage, /SemanticMigrationImportPanel|studioMode/);
  assert.match(migrationPage, /SemanticMigrationImportPanel/);
  assert.match(app, /path="\/semantic-migrations"/);
  assert.match(sidebar, /to: '\/semantic-migrations'.*label: 'BI Migration Studio'/);
  assert.match(connectionGuard, /'\/semantic-migrations': 'BI Migration Studio'/);
});

test('BI Migration Studio explains its workflow and security boundaries in app and guide', () => {
  const migrationPage = source('src/pages/SemanticMigrationPage.tsx');
  const workflow = source('src/components/semanticStudio/BiMigrationWorkflow.tsx');
  const workflowContract = source('src/components/semanticStudio/biMigrationWorkflowModel.ts');
  const guide = source('src/services/walkthrough.ts');
  const readme = source('README.md');

  for (const step of ['Source', 'Evidence', 'Destination', 'Analyze', 'Resolve', 'Validate', 'Build']) {
    assert.match(workflowContract, new RegExp(`label: '${step}'`));
  }
  assert.match(migrationPage, /BiMigrationWorkflowHeader/);
  assert.match(workflow, /People approve every write/);
  assert.match(workflow, /No direct LLM writes/);
  assert.match(workflow, /Visible proof gaps/);
  assert.match(guide, /credentials stay encrypted in the native vault/i);
  for (const provider of ['OpenAI', 'Anthropic', 'Snowflake Cortex', 'Databricks Genie', 'Omni AI']) {
    assert.match(guide, new RegExp(`For ${provider.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  }
  assert.match(guide, /Assign an accountable owner/);
  assert.match(guide, /compares them locally/);
  assert.match(guide, /Unsupported or unrun checks remain unverified/i);
  assert.match(readme, /BI Migration Studio workflow and security/);
  assert.match(readme, /An LLM never receives direct source or Omni write authority/);
});

test('BI Migration Studio uses one focused workflow and progressively discloses advanced setup', () => {
  const page = source('src/pages/SemanticMigrationPage.tsx');
  const workflow = source('src/components/semanticStudio/BiMigrationWorkflow.tsx');
  const controlPlane = source('src/components/semanticStudio/MigrationStudioControlPlane.tsx');
  const panel = source('src/components/semanticStudio/SemanticMigrationImportPanel.tsx');

  assert.match(page, /activeStep/);
  assert.match(page, /onWorkflowProgressChange/);
  assert.doesNotMatch(page, /MigrationWorkflowExplanation|MIGRATION_STEPS/);
  assert.match(workflow, /aria-current=\{active \? 'step'/);
  assert.match(workflow, /How it works/);
  assert.match(workflow, /Security/);
  assert.match(controlPlane, /role="dialog"/);
  assert.match(controlPlane, /aria-modal="true"/);
  assert.match(controlPlane, /document\.body\.style\.overflow = 'hidden'/);
  assert.match(controlPlane, /providerDrawerReturnFocusRef\.current\?\.focus/);
  assert.match(panel, /activeStep === 'source'/);
  assert.match(panel, /activeStep === 'evidence'/);
  assert.match(panel, /activeStep === 'destination'/);
  assert.match(panel, /activeStep === 'analyze'/);
  assert.match(panel, /activeStep === 'resolve'/);
  assert.match(panel, /activeStep === 'validate'/);
  assert.match(panel, /activeStep === 'build'/);
  assert.doesNotMatch(panel, /xl:grid-cols-\[360px_minmax\(0,1fr\)\]/);
  assert.match(panel, /Continue to \{BI_MIGRATION_WORKFLOW_STEPS/);
});

test('BI Migration Studio keeps planning, code generation, validation, and builds in their expected steps', () => {
  const panel = source('src/components/semanticStudio/SemanticMigrationImportPanel.tsx');
  assert.match(panel, /activeStep === 'analyze'[\s\S]+Plan migration/);
  assert.match(panel, /activeStep === 'resolve'[\s\S]+Generate semantic YAML/);
  assert.match(panel, /activeStep === 'validate'[\s\S]+Semantic YAML package/);
  assert.match(panel, /activeStep === 'validate'[\s\S]+Apply to dev branch/);
  assert.match(panel, /activeStep === 'build'[\s\S]+Build selected dashboards/);
  assert.match(panel, /planningReadinessIssues/);
  assert.match(panel, /resolutionReadinessIssues/);
  assert.match(panel, /Resolve and approve every governance and operational outcome/);
});

test('synthetic migration fixtures are explicitly isolated from customer-facing guidance', () => {
  const agentGuidance = source('AGENTS.md');
  const fixtureGuidance = source('tests/fixtures/semantic-migrations/README.md');
  const manifests = [
    'domo-northstar',
    'looker-northstar',
    'metabase-northstar',
    'microstrategy-northstar',
    'power-bi-northstar',
    'sigma-northstar',
    'tableau-northstar',
    'webfocus-northstar',
  ].map((directory) => JSON.parse(source(`tests/fixtures/semantic-migrations/${directory}/manifest.json`)) as { synthetic?: boolean });

  assert.match(agentGuidance, /Do not present fixture organizations/);
  assert.match(agentGuidance, /Runtime AI requests must be built only from the current user's selected artifacts and choices/);
  assert.match(fixtureGuidance, /not canonical product examples/);
  assert.equal(manifests.every((manifest) => manifest.synthetic === true), true);
});

test('BI Migration Studio scopes API inventory through dashboard selection and dependency review', () => {
  const panel = source('src/components/semanticStudio/SemanticMigrationImportPanel.tsx');
  assert.match(panel, /Select dashboards to migrate/);
  assert.match(panel, /Select visible/);
  assert.match(panel, /Selected dependency closure/);
  assert.match(panel, /selectedSourceDashboardIds/);
  assert.match(panel, /selectedAssetIds\.has\(item\.id\)/);
  assert.match(panel, /Review included dependencies/);
  assert.match(panel, /dashboard\.coverageNotes/);
});

test('BI Migration Studio discloses bounded inventory and requires fidelity acknowledgement', () => {
  const panel = source('src/components/semanticStudio/SemanticMigrationImportPanel.tsx');
  const controlPlane = source('src/components/semanticStudio/MigrationStudioControlPlane.tsx');
  const connectors = source('server/services/migrationConnectors.ts');

  assert.match(panel, /Source coverage and collection scope/);
  assert.match(panel, /capabilityCoverageAcknowledged/);
  assert.match(panel, /inventoryScopeIncomplete/);
  assert.match(panel, /unsupported permissions, schedules, and unavailable layout evidence/);
  assert.match(controlPlane, /Power BI workspace ID/);
  assert.match(connectors, /MAX_INVENTORY_PAGES/);
  assert.match(connectors, /migrationInventoryNextPageUrl/);
  assert.match(connectors, /Inventory reached a safety bound/);
});

test('BI Migration Studio requires reviewed source-to-target connection mappings', () => {
  const panel = source('src/components/semanticStudio/SemanticMigrationImportPanel.tsx');
  const api = source('src/services/semanticMigration/studioApi.ts');
  const handler = source('server/handlers/migration-studio.ts');

  assert.match(panel, /Connection mapping/);
  assert.match(panel, /Decision needed/);
  assert.match(panel, /Use \{modelConnectionLabel\(selectedModel\)\}/);
  assert.match(panel, /!engineConnectionMappingReady/);
  assert.match(api, /connectionOverrides\?: Record<string, string>/);
  assert.match(api, /engine\/confirm-connections/);
  assert.match(panel, /rawArtifactsReleasedRef\.current/);
  assert.match(handler, /new OmniClient\(targetInstance\)\.listConnections\(\)/);
  assert.match(handler, /engine_connections_confirmed/);
  assert.match(handler, /sanitizedConnectionOverrides/);
  assert.doesNotMatch(panel, /apiKey.*connectionOverrides|connectionOverrides.*apiKey/);
});

test('BI Migration Studio exposes resumable AI monitoring and explicit proposal conflicts', () => {
  const panel = source('src/components/semanticStudio/SemanticMigrationImportPanel.tsx');
  const api = source('src/services/semanticMigration/studioApi.ts');
  const decisions = source('src/services/semanticMigration/decisionIdentity.ts');
  const prompts = source('src/services/semanticMigration/prompts.ts');

  assert.match(api, /existingJobId/);
  assert.match(api, /MigrationProposalPendingError/);
  assert.match(panel, /Continue monitoring/);
  assert.match(panel, /does not submit a duplicate/);
  assert.match(panel, /Stop monitoring/);
  assert.match(panel, /The provider may still finish its upstream request/);
  assert.match(decisions, /proposalOptions: uniqueOptions/);
  assert.match(panel, /Choose between \{decision\.proposalOptions!/);
  assert.match(panel, /OmniKit separated related AI recommendations safely/);
  assert.match(prompts, /Return one decision for each independent semantic deliverable/);
  assert.match(prompts, /relationship:daily_grill_report:northstar_locations/);
});

test('BI Migration Studio readiness waits for confirmed evidence and limits large model lists', () => {
  const panel = source('src/components/semanticStudio/SemanticMigrationImportPanel.tsx');
  const lookerWizard = source('src/components/semanticStudio/LookerManualUploadWizard.tsx');

  assert.match(panel, /normalizedManualEvidenceReady && !engineAnalysisPending/);
  assert.match(panel, /\.slice\(0, modelSearch\.trim\(\) \? 50 : 12\)/);
  assert.match(panel, /Search .* models by name or connection/);
  assert.match(lookerWizard, /status === 'ready' && hasModel && hasViews && hasDashboard/);
  assert.match(lookerWizard, /no target model changes occur until reviewed deliverables are saved to a branch/);
});

test('BI Migration Studio makes API and manual source acquisition explicit', () => {
  const page = source('src/pages/SemanticMigrationPage.tsx');
  const controlPlane = source('src/components/semanticStudio/MigrationStudioControlPlane.tsx');
  const panel = source('src/components/semanticStudio/SemanticMigrationImportPanel.tsx');
  assert.match(page, /sourceMode/);
  assert.match(page, /manualSourcePlatform/);
  assert.match(page, /useState<'api' \| 'manual'>\('api'\)/);
  assert.match(page, /useState<MigrationBiSourceTool>\('domo'\)/);
  assert.match(controlPlane, /Source acquisition method/);
  assert.match(controlPlane, /Saved API/);
  assert.match(controlPlane, /Manual files/);
  assert.match(controlPlane, /OAuth client credentials/);
  assert.match(controlPlane, /Product API developer token/);
  assert.match(controlPlane, /Basic inventory/);
  assert.match(controlPlane, /Deep inventory/);
  assert.match(controlPlane, /useState<MigrationBiSourceTool>\('domo'\)/);
  assert.match(controlPlane, /onInventoryLoaded\?\.\(null\)/);
  assert.match(panel, /sourceMode === 'manual'/);
  assert.match(panel, /const visibleSourceOption = sourceMode === 'manual' \|\| sourceInventory \? selectedSourceOption : null/);
  assert.match(panel, /onManualSourcePlatformChange/);
  assert.match(panel, /Add \{selectedSourceOption\.label\} evidence/);
  assert.match(panel, /Upload source files|Upload files or ZIP/);
  assert.ok(panel.indexOf('manual-source-files-title') < panel.indexOf('target-omni-model-title'));
  assert.match(controlPlane, /sourceMode === 'manual' \? manualSourcePlatform/);
  const sources = [
    ['domo', 'Domo'],
    ['looker', 'Looker'],
    ['metabase', 'Metabase'],
    ['microstrategy', 'MicroStrategy'],
    ['power_bi', 'Power BI'],
    ['sigma', 'Sigma'],
    ['tableau', 'Tableau'],
    ['webfocus', 'WebFOCUS'],
  ];
  const positions = sources.map(([id, label]) => panel.indexOf(`previewSourceOption('${id}', '${label}'`));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
});

test('Domo manual files are normalized in the backend before AI planning', () => {
  const panel = source('src/components/semanticStudio/SemanticMigrationImportPanel.tsx');
  const wizard = source('src/components/semanticStudio/DomoManualUploadWizard.tsx');
  const roundTrip = source('src/services/semanticMigration/domoRoundTrip.ts');
  const studioApi = source('src/services/semanticMigration/studioApi.ts');
  const handler = source('server/handlers/migration-studio.ts');

  assert.match(panel, /parseManualMigrationArtifacts\('domo', artifacts\)/);
  assert.match(panel, /DomoManualUploadWizard/);
  assert.match(panel, /domoParseStatus !== 'ready'/);
  assert.match(panel, /!domoUploadConfirmed/);
  assert.match(wizard, /1\. Add files/);
  assert.match(wizard, /2\. Review evidence/);
  assert.match(wizard, /3\. Ready/);
  assert.match(wizard, /Dataset schemas/);
  assert.match(wizard, /Beast Modes/);
  assert.match(wizard, /SQL DataFlows/);
  assert.match(wizard, /Pages and Cards/);
  assert.match(wizard, /PDP and permissions/);
  assert.match(wizard, /Platform handoffs/);
  assert.match(wizard, /need a separate accountable handoff/);
  assert.match(wizard, /Confirm upload inventory/);
  assert.match(wizard, /Nothing was overwritten/);
  assert.match(wizard, /Keep every formula variant as an additive candidate/);
  assert.doesNotMatch(wizard, /Try sample data/);
  assert.match(wizard, /Unlock vault in a new tab/);
  assert.doesNotMatch(panel, /Synthetic generated-output comparison/);
  assert.match(roundTrip, /deterministic parser recovery before AI translation/);
  assert.match(studioApi, /migration-studio\/manual-artifacts\/parse/);
  assert.match(handler, /manual_artifacts_parsed/);
});

test('Professional Domo remains Preview-gated with paired acquisition evidence and explicit handoffs', () => {
  const readme = source('README.md');
  const guide = source('docs/migrations/domo-to-omni.md');
  const runbook = source('docs/operations/migration-studio-runbook.md');
  const verifier = source('scripts/verify-domo-live-acceptance-campaign.mjs');
  const campaign = source('config/domo-live-acceptance-campaign.template.json');

  assert.match(readme, /Professional Domo migrations/);
  assert.match(readme, /Domo path is \*\*Preview\*\*, not GA/);
  assert.match(readme, /zero silent omissions/);
  assert.match(guide, /Manual Files and Saved API acquisition normalize into the same Domo v2 evidence\s+contract/);
  assert.match(guide, /Non-SQL Magic ETL/);
  assert.match(guide, /Domo remains Preview until this proof exists/);
  assert.match(runbook, /verify:domo-acceptance-campaign/);
  assert.match(verifier, /Manual and API acceptance must use distinct isolated development branches/);
  assert.match(verifier, /prohibited sensitive field/);
  assert.match(campaign, /omnikit\.domo-dual-path-acceptance-campaign\.v1/);
});

test('Looker manual projects use guided server normalization and round-trip evidence', () => {
  const panel = source('src/components/semanticStudio/SemanticMigrationImportPanel.tsx');
  const wizard = source('src/components/semanticStudio/LookerManualUploadWizard.tsx');
  const parser = source('server/services/semanticMigration/lookerManualParser.ts');
  const handler = source('server/handlers/migration-studio.ts');
  const readme = source('README.md');

  assert.match(panel, /parseManualMigrationArtifacts\('looker', artifacts\)/);
  assert.match(panel, /LookerManualUploadWizard/);
  assert.match(panel, /lookerParseStatus !== 'ready'/);
  assert.match(panel, /!lookerUploadConfirmed/);
  assert.match(wizard, /1\. Add project files/);
  assert.match(wizard, /2\. Review evidence/);
  assert.match(wizard, /3\. Ready/);
  assert.match(wizard, /\.model\.lkml/);
  assert.match(wizard, /\.view\.lkml/);
  assert.match(wizard, /\.dashboard\.lookml/);
  assert.doesNotMatch(wizard, /Try sample data/);
  assert.match(wizard, /PDT and access-filter behavior/);
  assert.match(wizard, /Unlock vault in a new tab/);
  assert.match(parser, /buildMigrationInventory\('looker', artifacts\)/);
  assert.match(handler, /parseLookerManualArtifacts/);
  assert.match(readme, /documented LookML project unit/);
});

test('Professional Looker V2 remains Preview-gated, reversible, and operator documented', () => {
  const panel = source('src/components/semanticStudio/SemanticMigrationImportPanel.tsx');
  const readiness = source('src/services/semanticMigration/lookerProfessional.ts');
  const readme = source('README.md');
  const guide = source('docs/migrations/looker-to-omni.md');
  const runbook = source('docs/operations/migration-studio-runbook.md');
  const checklist = source('docs/releases/migration-studio-release-checklist.md');

  assert.match(panel, /data-testid="looker-professional-v2-readiness"/);
  assert.match(readiness, /LOOKER_PROFESSIONAL_V2_CONTRACT = 'looker-professional-v2'/);
  assert.match(readiness, /contractVersion: LOOKER_PROFESSIONAL_V2_CONTRACT/);
  assert.match(readiness, /releaseStage: 'preview'/);
  assert.match(readiness, /permissions: 'unsupported'/);
  assert.match(readiness, /schedules: 'unsupported'/);
  assert.match(readiness, /native_fallback/);
  assert.match(readiness, /const primaryApproved = resultMode === 'primary'/);
  assert.match(readme, /Professional Looker migrations/);
  assert.match(readme, /Permissions and schedules \| Unsupported/);
  assert.match(guide, /Manual files and Saved API acquisition feed the same canonical IR V2 contract/);
  assert.match(guide, /every selected dashboard and tile outcome/);
  assert.match(runbook, /rollback:migration-engine -- --source looker/);
  assert.match(checklist, /Professional Looker V2/);
  assert.match(checklist, /No unsupported behavior was silently omitted/);
});

test('MicroStrategy manual exports use guided server normalization and benchmark evidence', () => {
  const panel = source('src/components/semanticStudio/SemanticMigrationImportPanel.tsx');
  const wizard = source('src/components/semanticStudio/MicroStrategyManualUploadWizard.tsx');
  const parser = source('server/services/semanticMigration/microStrategyManualParser.ts');
  const handler = source('server/handlers/migration-studio.ts');
  const readme = source('README.md');

  assert.match(panel, /parseManualMigrationArtifacts\('microstrategy', artifacts\)/);
  assert.match(panel, /MicroStrategyManualUploadWizard/);
  assert.match(panel, /microStrategyParseStatus !== 'ready'/);
  assert.match(panel, /!microStrategyUploadConfirmed/);
  assert.match(wizard, /1\. Add exports/);
  assert.match(wizard, /2\. Review evidence/);
  assert.match(wizard, /3\. Ready/);
  assert.match(wizard, /Project identity and scope/);
  assert.match(wizard, /Cubes, reports, attributes, metrics/);
  assert.match(wizard, /Chapters, pages, visualizations, filters/);
  assert.doesNotMatch(wizard, /Try sample data/);
  assert.match(wizard, /Unlock vault in a new tab/);
  assert.match(parser, /MICROSTRATEGY_MANUAL_SCHEMA_VERSION/);
  assert.match(handler, /parseMicroStrategyManualArtifacts/);
  assert.match(readme, /Manual Domo, Looker, MicroStrategy, and Power BI migrations/);
});

test('Power BI manual projects use guided server normalization and PBIP benchmark evidence', () => {
  const panel = source('src/components/semanticStudio/SemanticMigrationImportPanel.tsx');
  const wizard = source('src/components/semanticStudio/PowerBiManualUploadWizard.tsx');
  const parser = source('server/services/semanticMigration/powerBiManualParser.ts');
  const handler = source('server/handlers/migration-studio.ts');
  const readme = source('README.md');

  assert.match(panel, /parseManualMigrationArtifacts\('power_bi', artifacts\)/);
  assert.match(panel, /PowerBiManualUploadWizard/);
  assert.match(panel, /powerBiParseStatus !== 'ready'/);
  assert.match(panel, /!powerBiUploadConfirmed/);
  assert.match(wizard, /1\. Add project exports/);
  assert.match(wizard, /2\. Review evidence/);
  assert.match(wizard, /3\. Ready/);
  assert.match(wizard, /model\.bim/);
  assert.match(wizard, /TMDL/);
  assert.match(wizard, /measures are optional/);
  assert.match(wizard, /AI evidence disclosure/);
  assert.match(wizard, /Also include bounded raw source snippets/);
  assert.doesNotMatch(wizard, /hasSemanticModel[^\n]+measureCount/);
  assert.match(wizard, /PBIR/);
  assert.match(wizard, /Upload files or ZIP/);
  assert.match(wizard, /Choose project folder/);
  assert.doesNotMatch(wizard, /Try sample data/);
  assert.match(wizard, /Workspace scanner metadata is helpful.*optional/);
  assert.match(wizard, /Unlock vault in a new tab/);
  assert.match(panel, /Mandatory typed dependency decisions/);
  assert.match(panel, /sourceToolLabel\(sourceTool\)/);
  assert.match(parser, /POWER_BI_MANUAL_SCHEMA_VERSION/);
  assert.match(handler, /parsePowerBiManualArtifacts/);
  assert.match(readme, /Manual Domo, Looker, MicroStrategy, and Power BI migrations/);
  assert.match(readme, /Power BI manual support matrix/);
  assert.match(readme, /structural migration assistance, not automatic behavioral parity/);
});

test('BI Migration Studio requires typed dashboard plans and shows the bundle version', () => {
  const panel = source('src/components/semanticStudio/SemanticMigrationImportPanel.tsx');
  const bundle = source('src/services/semanticMigration/bundle.ts');
  assert.match(panel, /dashboardPlans:/);
  assert.match(panel, /required: \['message', 'decisions', 'dashboardPlans'\]/);
  assert.match(panel, /normalizeDashboardBuildPlans/);
  assert.match(panel, /Versioned migration bundle/);
  assert.match(panel, /migrationBundle\.bundleId/);
  assert.match(panel, /changes to scope, decisions, target, or deliverables create a new version/);
  assert.match(panel, /dashboardPlanReadiness/);
  assert.match(bundle, /Ready with manual work/);
  assert.match(panel, /Inspect tile outcomes, query evidence, and filter routing/);
  assert.match(panel, /Impacted dashboards:/);
});

test('BI Migration Studio gates and tracks one Omni AI build per reviewed dashboard', () => {
  const panel = source('src/components/semanticStudio/SemanticMigrationImportPanel.tsx');
  const queue = source('src/services/semanticMigration/dashboardBuildQueue.ts');
  const readme = source('README.md');
  assert.match(panel, /Build selected dashboards/);
  assert.match(panel, /I opened the branch and confirm the reviewed semantic definitions/);
  assert.match(panel, /branchId,/);
  assert.match(panel, /Start dashboard builds/);
  assert.match(panel, /Retry this dashboard/);
  assert.match(queue, /semanticReviewConfirmed/);
  assert.match(queue, /retryableDashboardBuildPlanIds/);
  assert.match(readme, /Omni's dashboard import endpoint accepts Omni-native dashboard exports/);
  assert.match(readme, /one selected dashboard at a time/);
});

test('BI Migration Studio checks a fresh target baseline before branch creation and branch writes', () => {
  const panel = source('src/components/semanticStudio/SemanticMigrationImportPanel.tsx');
  const freshMainGate = panel.indexOf('const freshMainIssues = semanticMigrationWriteReadinessIssues');
  const branchCreation = panel.indexOf('const branch = await createModelBranch');
  const freshBranchGate = panel.indexOf('const freshBranchIssues = semanticMigrationWriteReadinessIssues');
  const yamlWrite = panel.indexOf('await updateModelYamlFile');

  assert.ok(freshMainGate >= 0 && branchCreation > freshMainGate);
  assert.ok(freshBranchGate > branchCreation && yamlWrite > freshBranchGate);
  assert.match(panel, /target changed after package review/);
  assert.match(panel, /branch baseline changed after package review/);
});

test('semantic migration source artifacts remain page-memory-only', () => {
  const panel = source('src/components/semanticStudio/SemanticMigrationImportPanel.tsx');

  assert.doesNotMatch(panel, /localStorage|sessionStorage|indexedDB/i);
  assert.match(panel, /useState<MigrationArtifact\[]>\(\[]\)/);
});

test('semantic migration rejects stale connection and target responses', () => {
  const panel = source('src/components/semanticStudio/SemanticMigrationImportPanel.tsx');

  assert.match(panel, /useConnectionRequestGuard/);
  assert.match(panel, /mountedRef\.current = true;/);
  assert.match(panel, /selectedModelIdRef\.current = ''/);
  assert.match(panel, /assertCurrentRequest\(requestKey, targetModel\.id\)/);
  assert.match(panel, /deleteModelBranch/);
});

import { expect, test, type APIRequestContext, type Page, type Route } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDomoManualArtifacts } from '../../server/services/semanticMigration/domoManualParser';
import { artifactFromText } from '../../src/services/semanticMigration/adapters';
import type { MigrationEngineBridgeResult } from '../../src/services/semanticMigration/engineBridge';
import { migrationSourceDocumentation } from '../../src/services/semanticMigration/sourceDocumentation';
import type { DomoApiEvidenceResult, MigrationPreparedEvidenceResult } from '../../src/services/semanticMigration/types';

const PASSPHRASE = 'browser migration test passphrase';
const DOMO_PRODUCT_PAGE_ID = 'source-page';
const DOMO_PRODUCT_CARD_ID = 'source-card';
const DOMO_PRODUCT_DATASET_ID = 'source-dataset';
const DOMO_PRODUCT_SCOPE_FINGERPRINT_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const DOMO_PRODUCT_SCOPE_FINGERPRINT_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const POWER_BI_MODEL_ROOT_A = 'semantic_model:example-model-a';
const POWER_BI_MODEL_ROOT_B = 'semantic_model:example-model-b';
const POWER_BI_SCOPE_FINGERPRINT_A = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const POWER_BI_SCOPE_FINGERPRINT_B = 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
const DOMO_PRODUCT_LIMITATIONS = [
  {
    code: 'domo_product_card_analyzer_definition_manual_validation_required' as const,
    message: 'Domo Product Search proves Card discovery, not a complete Analyzer/Card definition. Supply and validate OAuth Chart Card definitions or reviewed Manual Files for every selected Card before Apply to Dev or release.',
  },
  {
    code: 'domo_product_card_drill_manual_validation_required' as const,
    message: 'Domo Product API does not prove complete Analyzer drill paths. Validate every selected Card drill path manually before release.',
  },
  {
    code: 'domo_product_dataset_pdp_manual_validation_required' as const,
    message: 'Domo Product API does not prove complete DataSet PDP policy lists. Validate PDP behavior and access manually before release.',
  },
] as const;

const DESTINATION_MODEL_KINDS = ['SHARED', 'SHARED_EXTENSION'] as const;
type DestinationModelKind = (typeof DESTINATION_MODEL_KINDS)[number];

type DestinationModelFixture = {
  id: string;
  name: string;
  identifier: string;
  connectionId: string;
  connectionName: string;
  kind: DestinationModelKind;
};

type DestinationModelRequest = {
  baseUrl: string;
  kind: DestinationModelKind;
  body: Record<string, unknown>;
};

type DestinationModelResponder = (
  request: DestinationModelRequest,
  requestNumberForKind: number,
) => unknown | Promise<unknown>;

type SeededVault = {
  connection: Record<string, unknown>;
  instanceId: string;
  providerId: string;
  sourceConnectionId?: string;
  sourceConnectionUpdatedAt?: string;
};

const SOURCE_PLATFORMS = [
  { id: 'domo', label: 'Domo' },
  { id: 'looker', label: 'Looker' },
  { id: 'metabase', label: 'Metabase' },
  { id: 'microstrategy', label: 'MicroStrategy' },
  { id: 'power_bi', label: 'Power BI' },
  { id: 'sigma', label: 'Sigma' },
  { id: 'tableau', label: 'Tableau' },
  { id: 'webfocus', label: 'WebFOCUS' },
] as const;

const ENGINE_OFF_CAPABILITIES = {
  control_plane: {
    defaultMode: 'off',
    sourceModes: {
      looker: 'off',
      powerbi: 'off',
      tableau: 'off',
      metabase: 'off',
      sigma: 'off',
    },
    requestedSourceModes: {
      looker: 'off',
      powerbi: 'off',
      tableau: 'off',
      metabase: 'off',
      sigma: 'off',
    },
    promotionGates: Object.fromEntries(
      ['looker', 'powerbi', 'tableau', 'metabase', 'sigma'].map((source) => [
        source,
        { approved: false, reason: 'Disabled in the browser test control plane.', observationCount: 0 },
      ]),
    ),
    fallback: 'native_when_available',
    observationRequired: true,
  },
};

const ENGINE_LOOKER_SHADOW_CAPABILITIES = {
  control_plane: {
    ...ENGINE_OFF_CAPABILITIES.control_plane,
    defaultMode: 'shadow',
    sourceModes: { ...ENGINE_OFF_CAPABILITIES.control_plane.sourceModes, looker: 'shadow' },
    requestedSourceModes: { ...ENGINE_OFF_CAPABILITIES.control_plane.requestedSourceModes, looker: 'shadow' },
    promotionGates: {
      ...ENGINE_OFF_CAPABILITIES.control_plane.promotionGates,
      looker: { approved: false, reason: 'Shadow evidence is not authoritative semantic inventory.', observationCount: 1 },
    },
  },
};

const FIXTURE_ROOT = resolve(process.cwd(), 'tests/fixtures/semantic-migrations');
const MANUAL_FIXTURE_FILES = {
  domo: [
    'domo-northstar/northstar-dataset-schemas.json',
    'domo-northstar/northstar-beast-modes.json',
    'domo-northstar/northstar-sql-dataflows.json',
    'domo-northstar/northstar-cards.json',
  ],
  looker: [
    'looker-northstar/northstar.model.lkml',
    'looker-northstar/northstar.view.lkml',
    'looker-northstar/northstar_dashboard.dashboard.lookml',
  ],
  power_bi: [
    'power-bi-northstar/northstar-workspace.json',
    'power-bi-northstar/northstar-model.bim',
    'power-bi-northstar/northstar-report.json',
  ],
} as const;

async function uploadManualFixture(page: Page, source: keyof typeof MANUAL_FIXTURE_FILES) {
  const files = MANUAL_FIXTURE_FILES[source].map((file) => resolve(FIXTURE_ROOT, file));
  await page.locator('input[type="file"]').first().setInputFiles(files);
}

function lookerShadowEngineResult(artifacts: Array<{ name: string; content?: string }>): MigrationEngineBridgeResult {
  const result = structuredClone(JSON.parse(readFileSync(resolve(
    process.cwd(),
    'tests/fixtures/migration-engine/omnikit.migration.bundle.v1.valid.json',
  ), 'utf8'))) as MigrationEngineBridgeResult;
  const names = artifacts.map((artifact) => artifact.name);
  result.request_id = 'browser-looker-shadow-attestation';
  result.source = 'looker';
  result.mode = 'manual';
  result.provenance.source_artifacts = names;
  result.provenance.source_artifact_count = names.length;
  result.provenance.source_artifact_fingerprints = artifacts.map((artifact) => {
    const content = artifact.content || '';
    return {
      name: artifact.name,
      sha256: createHash('sha256').update(content).digest('hex'),
      size_bytes: Buffer.byteLength(content, 'utf8'),
    };
  });
  result.provenance.ir_version = '2';
  result.bundle.ir_version = '2';
  result.bundle.acquisition = {
    contract_version: 'looker.evidence.v1',
    mode: 'manual',
    project_ids: [],
    dashboard_ids: ['NorthstarDashboard'],
    look_ids: [],
    query_ids: [],
    source_files: names,
    required_files: names,
    unrelated_files: [],
    dependencies: names.map((name) => ({
      kind: name.endsWith('.dashboard.lookml') ? 'dashboard' : name.endsWith('.model.lkml') ? 'model' : 'view',
      reference: name,
      source_file: name,
      status: 'resolved',
      required: true,
      matched_files: [name],
      affected_dashboard_ids: ['NorthstarDashboard'],
      message: `Resolved ${name}.`,
    })),
    saved_look_coverage: 'not_applicable',
    dependency_closure_status: 'complete',
    source_query_validation_status: 'not_evaluated',
    diagnostics: [],
  };
  result.diagnostics.source_artifact_count = names.length;
  result.diagnostics.acquisition_contract_version = 'looker.evidence.v1';
  result.diagnostics.saved_look_coverage = 'not_applicable';
  result.diagnostics.dependency_closure_status = 'complete';
  result.diagnostics.source_query_validation_status = 'not_evaluated';
  result.diagnostics.rulebook_version = 'v2';
  result.model_suggestions = result.model_suggestions.map((suggestion) => ({
    ...suggestion,
    rulebook_version: 'v2',
  }));
  result.control_plane = {
    rollout_mode: 'shadow',
    queue_wait_ms: 0,
    duration_ms: 1,
    fallback: 'native_when_available',
  };
  return result;
}

const POWER_BI_DASHBOARD_ID = 'pbi-report-northstar-dashboard';
const POWER_BI_DEPENDENCY_IDS = [
  'powerbi:model:pbi-model-northstar',
  'powerbi:field:daily_grill_report_business_date',
  'powerbi:field:daily_grill_report_discount_rate',
  'powerbi:field:daily_grill_report_discounts',
  'powerbi:field:daily_grill_report_order_channel',
  'powerbi:field:daily_grill_report_orders',
  'powerbi:field:daily_grill_report_total_revenue',
  'powerbi:field:menu_item_p_l_category',
  'powerbi:field:menu_item_p_l_margin_pct',
  'powerbi:field:menu_item_p_l_net_revenue',
  'powerbi:field:northstar_locations_location_name',
  'powerbi:field:northstar_locations_territory',
  'powerbi:visual:pbi-report-northstar-dashboard:page-executive-kpis:visual-executive-kpis',
  'powerbi:visual:pbi-report-northstar-dashboard:page-weekly-trend:visual-weekly-trend',
  'powerbi:visual:pbi-report-northstar-dashboard:page-location-performance:visual-location-performance',
  'powerbi:visual:pbi-report-northstar-dashboard:page-deals-discounts:visual-deals-discounts',
  'powerbi:visual:pbi-report-northstar-dashboard:page-profitability:visual-profitability',
  'powerbi:visual:pbi-report-northstar-dashboard:page-channel-mix:visual-channel-mix',
];

const POWER_BI_VISUALS = [
  {
    id: 'visual-executive-kpis',
    title: 'Executive KPIs',
    evidenceId: 'powerbi:visual:pbi-report-northstar-dashboard:page-executive-kpis:visual-executive-kpis',
    visualType: 'card',
    fields: ['Daily Grill Report.total_revenue', 'Daily Grill Report.orders', 'Daily Grill Report.discount_rate'],
  },
  {
    id: 'visual-weekly-trend',
    title: 'Weekly Revenue Trend',
    evidenceId: 'powerbi:visual:pbi-report-northstar-dashboard:page-weekly-trend:visual-weekly-trend',
    visualType: 'lineChart',
    fields: ['Daily Grill Report.business_date', 'Daily Grill Report.total_revenue', 'Daily Grill Report.orders'],
  },
  {
    id: 'visual-location-performance',
    title: 'Location Performance',
    evidenceId: 'powerbi:visual:pbi-report-northstar-dashboard:page-location-performance:visual-location-performance',
    visualType: 'clusteredBarChart',
    fields: ['Northstar Locations.location_name', 'Northstar Locations.territory', 'Daily Grill Report.total_revenue'],
  },
  {
    id: 'visual-deals-discounts',
    title: 'Deals & Discounts',
    evidenceId: 'powerbi:visual:pbi-report-northstar-dashboard:page-deals-discounts:visual-deals-discounts',
    visualType: 'tableEx',
    fields: ['Daily Grill Report.business_date', 'Daily Grill Report.discounts', 'Daily Grill Report.discount_rate'],
  },
  {
    id: 'visual-profitability',
    title: 'Profitability by Menu Category',
    evidenceId: 'powerbi:visual:pbi-report-northstar-dashboard:page-profitability:visual-profitability',
    visualType: 'barChart',
    fields: ['Menu Item P&L.category', 'Menu Item P&L.net_revenue', 'Menu Item P&L.margin_pct'],
  },
  {
    id: 'visual-channel-mix',
    title: 'Order Channel Mix',
    evidenceId: 'powerbi:visual:pbi-report-northstar-dashboard:page-channel-mix:visual-channel-mix',
    visualType: 'pieChart',
    fields: ['Daily Grill Report.order_channel', 'Daily Grill Report.total_revenue', 'Daily Grill Report.orders'],
  },
] as const;

async function json(route: Route, payload: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
}

function domoInventoryEnvelope(
  connectionId: string,
  options: {
    status: 'complete' | 'failed';
    errors?: string[];
  },
) {
  return {
    inventory: {
      platform: 'domo',
      connectionId,
      connector: {
        platform: 'domo',
        label: 'Domo',
        authGuidance: 'Tenant-scoped Product API developer token.',
        capabilities: {
          apiInventory: true,
          semanticDefinitions: 'partial',
          contentDefinitions: 'partial',
          usage: false,
          permissions: false,
          schedules: false,
          queryValidation: false,
          visualEvidence: false,
        },
        migrationCoverage: {
          semantic_objects: 'partial',
          dashboards: 'partial',
          filters: 'partial',
          layout: 'export_required',
          permissions: 'unsupported',
          schedules: 'unsupported',
        },
        limitations: ['Selected-source evidence is required before migration planning.'],
      },
      items: [],
      dashboardCatalog: [],
      warnings: options.errors || [],
      truncated: false,
      collection: {
        scope: 'all_accessible',
        scopeLabel: 'All accessible Domo content',
        complete: options.status === 'complete',
        status: options.status,
        errors: options.errors || [],
        pagesFetched: 0,
        parentsExpanded: 0,
        requestsMade: options.status === 'complete' ? 1 : 3,
        maxPages: 25,
        maxItems: 1000,
      },
    },
  };
}

function neutralSavedSourceInventory(connectionId: string, sourceLabel: string) {
  const dashboardId = `${connectionId}-dashboard`;
  return {
    platform: 'metabase',
    connectionId,
    connector: {
      platform: 'metabase',
      label: 'Metabase',
      authGuidance: 'Saved browser-test credential.',
      capabilities: {
        apiInventory: true,
        semanticDefinitions: 'partial',
        contentDefinitions: 'partial',
        usage: false,
        permissions: false,
        schedules: false,
        queryValidation: false,
        queryValidationMode: 'target_only',
        visualEvidence: false,
      },
      migrationCoverage: {
        semantic_objects: 'partial',
        dashboards: 'partial',
        filters: 'partial',
        layout: 'export_required',
        permissions: 'unsupported',
        schedules: 'unsupported',
      },
      limitations: ['Additional exported evidence is required for full fidelity.'],
    },
    items: [{
      id: dashboardId,
      name: `${sourceLabel} Dashboard`,
      kind: 'dashboard',
      dependencyIds: [],
      featureFlags: [],
      riskFlags: [],
      metadata: {},
    }],
    dashboardCatalog: [{
      id: dashboardId,
      name: `${sourceLabel} Dashboard`,
      kind: 'dashboard',
      dependencyIds: [],
      dependencies: [],
      dependencyCounts: {},
      complexity: 'low',
      coverage: 'partial',
      coverageNotes: ['Additional exported evidence is required for full fidelity.'],
      riskFlags: [],
    }],
    warnings: [],
    truncated: false,
    collection: {
      scope: 'all_accessible',
      scopeLabel: `${sourceLabel} scope`,
      complete: true,
      status: 'complete',
      errors: [],
      pagesFetched: 1,
      parentsExpanded: 0,
      requestsMade: 1,
      maxPages: 25,
      maxItems: 1000,
    },
  };
}

function neutralPowerBiDefinitionInventory(connectionId: string, connectionUpdatedAt: string) {
  return {
    platform: 'power_bi',
    connectionId,
    connectionUpdatedAt,
    connector: {
      platform: 'power_bi',
      label: 'Power BI',
      authGuidance: 'Microsoft Entra service principal scoped to one synthetic workspace.',
      capabilities: {
        apiInventory: true,
        semanticDefinitions: 'full',
        contentDefinitions: 'partial',
        usage: false,
        permissions: true,
        schedules: true,
        queryValidation: false,
        queryValidationMode: 'target_only',
        visualEvidence: false,
      },
      migrationCoverage: {
        semantic_objects: 'full',
        dashboards: 'partial',
        filters: 'partial',
        layout: 'export_required',
        permissions: 'partial',
        schedules: 'partial',
      },
      limitations: ['Interactive report behavior remains a reviewed Manual Files handoff.'],
    },
    items: [
      {
        id: POWER_BI_MODEL_ROOT_A,
        name: 'Example semantic model A',
        kind: 'semantic_model',
        dependencyIds: [],
        featureFlags: [],
        riskFlags: ['role_review'],
        metadata: { fabricItemType: 'SemanticModel' },
      },
      {
        id: POWER_BI_MODEL_ROOT_B,
        name: 'Example semantic model B',
        kind: 'semantic_model',
        dependencyIds: [],
        featureFlags: [],
        riskFlags: ['role_review'],
        metadata: { fabricItemType: 'SemanticModel' },
      },
    ],
    dashboardCatalog: [],
    warnings: [],
    truncated: false,
    collection: {
      scope: 'saved_parent',
      scopeLabel: 'Synthetic Fabric workspace',
      complete: true,
      status: 'complete',
      errors: [],
      pagesFetched: 1,
      parentsExpanded: 0,
      requestsMade: 1,
      maxPages: 25,
      maxItems: 1000,
    },
  };
}

function neutralPowerBiPreparedEvidence(
  connectionId: string,
  connectionUpdatedAt: string,
  selectedRootId: string,
  scopeFingerprint: string,
): MigrationPreparedEvidenceResult {
  const modelName = selectedRootId === POWER_BI_MODEL_ROOT_A ? 'Example semantic model A' : 'Example semantic model B';
  const documentationIds = migrationSourceDocumentation('power_bi').map((reference) => reference.url);
  const evidenceContract: MigrationPreparedEvidenceResult['evidenceContract'] = {
    schemaVersion: 'omnikit.source-evidence.v2',
    sourceTool: 'power_bi',
    parser: { name: 'Synthetic Power BI definition collector', version: '1.0.0' },
    acquisition: { mode: 'api', runId: scopeFingerprint, selectedScopeIds: [selectedRootId] },
    collection: {
      expectedArtifactCount: 1,
      observedArtifactCount: 1,
      complete: true,
      truncated: false,
      permissionGaps: [],
    },
    dependencyClosure: {
      status: 'partial',
      resolvedCount: 1,
      missingCount: 0,
      reviewCount: 1,
    },
    artifactFingerprints: [{ name: `${modelName}/definition/model.tmdl`, sha256: scopeFingerprint, sizeBytes: 256 }],
    documentationIds,
    diagnostics: ['Role behavior remains a manual validation requirement.'],
  };
  return {
    schemaVersion: 'omnikit.prepared-source-evidence.v1',
    platform: 'power_bi',
    connectionId,
    connectionUpdatedAt,
    selectedRootIds: [selectedRootId],
    scopeFingerprint,
    preparedAt: '2026-08-12T12:00:00.000Z',
    status: 'partial',
    evidenceContract,
    inventory: {
      sourceTool: 'power_bi',
      artifactCount: 1,
      artifacts: [],
      views: [],
      explores: [],
      relationships: [],
      dashboards: [],
      metrics: [],
      warnings: ['Role behavior remains a manual validation requirement.'],
      summary: `Prepared one revision-bound definition for ${modelName}.`,
      sourceEvidence: evidenceContract,
    },
    artifacts: [{
      id: `power_bi:${selectedRootId}:definition`,
      name: `${modelName}/definition/model.tmdl`,
      sourceId: selectedRootId,
      locator: `${selectedRootId}:definition:model.tmdl`,
      mediaType: 'text/plain',
      evidenceClass: 'authoritative_definition',
      sha256: scopeFingerprint,
      sizeBytes: 256,
      documentationIds,
      rawContentIncluded: false,
    }],
    dependencies: [{
      sourceId: selectedRootId,
      category: 'security',
      required: true,
      status: 'review_required',
      reason: 'Validate the semantic-model roles against reviewed Manual Files before release.',
    }],
    diagnostics: {
      complete: true,
      verifiedEmpty: false,
      truncated: false,
      requestsMade: 3,
      pagesFetched: 1,
      itemsObserved: 1,
      bytesRead: 256,
      limits: { maxRequests: 20, maxPages: 25, maxItems: 1000, maxBytes: 1048576 },
      permissionGaps: [],
      manualRequirements: ['Validate the selected semantic-model roles using reviewed Manual Files before release.'],
      errors: [],
      warnings: ['The selected definition is complete; role behavior still requires human validation.'],
    },
  };
}

function neutralPartialPreparedEvidence(
  platform: MigrationPreparedEvidenceResult['platform'],
  connectionId: string,
  connectionUpdatedAt: string,
  selectedRootId: string,
  rootName: string,
): MigrationPreparedEvidenceResult {
  const scopeFingerprint = createHash('sha256')
    .update(`${platform}:${connectionId}:${connectionUpdatedAt}:${selectedRootId}`)
    .digest('hex');
  const documentationIds = migrationSourceDocumentation(platform).map((reference) => reference.url);
  const evidenceContract: MigrationPreparedEvidenceResult['evidenceContract'] = {
    schemaVersion: 'omnikit.source-evidence.v2',
    sourceTool: platform,
    parser: { name: `Synthetic ${platform} browser collector`, version: '1.0.0' },
    acquisition: { mode: 'api', runId: scopeFingerprint, selectedScopeIds: [selectedRootId] },
    collection: {
      expectedArtifactCount: 1,
      observedArtifactCount: 1,
      complete: true,
      truncated: false,
      permissionGaps: [],
    },
    dependencyClosure: { status: 'partial', resolvedCount: 1, missingCount: 0, reviewCount: 1 },
    artifactFingerprints: [{ name: `${rootName} definition`, sha256: scopeFingerprint, sizeBytes: 256 }],
    documentationIds,
    diagnostics: ['A reviewed Manual Files handoff remains required for unsupported source behavior.'],
  };
  return {
    schemaVersion: 'omnikit.prepared-source-evidence.v1',
    platform,
    connectionId,
    connectionUpdatedAt,
    selectedRootIds: [selectedRootId],
    scopeFingerprint,
    preparedAt: '2026-08-13T12:00:00.000Z',
    status: 'partial',
    evidenceContract,
    inventory: {
      sourceTool: platform,
      artifactCount: 1,
      artifacts: [],
      views: [],
      explores: [],
      relationships: [],
      dashboards: [],
      metrics: [],
      warnings: ['A reviewed Manual Files handoff remains required for unsupported source behavior.'],
      summary: `Prepared one revision-bound definition for ${rootName}.`,
      sourceEvidence: evidenceContract,
    },
    artifacts: [{
      id: `${platform}:${selectedRootId}:definition`,
      name: `${rootName} definition`,
      sourceId: selectedRootId,
      locator: `${selectedRootId}:definition`,
      mediaType: 'application/json',
      evidenceClass: 'compiled_definition',
      sha256: scopeFingerprint,
      sizeBytes: 256,
      documentationIds,
      rawContentIncluded: false,
    }],
    dependencies: [{
      sourceId: selectedRootId,
      category: 'content',
      required: true,
      status: 'review_required',
      reason: 'Validate unsupported source behavior using reviewed Manual Files before release.',
    }],
    diagnostics: {
      complete: true,
      verifiedEmpty: false,
      truncated: false,
      requestsMade: 1,
      pagesFetched: 1,
      itemsObserved: 1,
      bytesRead: 256,
      limits: { maxRequests: 20, maxPages: 25, maxItems: 1000, maxBytes: 1048576 },
      permissionGaps: [],
      manualRequirements: ['Validate unsupported source behavior using reviewed Manual Files before release.'],
      errors: [],
      warnings: [],
    },
  };
}

function neutralDomoProductInventory(connectionId: string, connectionUpdatedAt: string) {
  return {
    platform: 'domo',
    connectionId,
    connectionUpdatedAt,
    connector: {
      platform: 'domo',
      label: 'Domo',
      authGuidance: 'Tenant-scoped Product API developer token.',
      capabilities: {
        apiInventory: true,
        semanticDefinitions: 'partial',
        contentDefinitions: 'partial',
        usage: false,
        permissions: false,
        schedules: false,
        queryValidation: false,
        queryValidationMode: 'manual_source_evidence',
        visualEvidence: false,
      },
      migrationCoverage: {
        semantic_objects: 'partial',
        dashboards: 'partial',
        filters: 'partial',
        layout: 'export_required',
        permissions: 'unsupported',
        schedules: 'unsupported',
      },
      limitations: ['Product API-only inventory requires explicit Analyzer/Card-definition, drill-path, and PDP manual handoffs.'],
    },
    items: [
      {
        id: DOMO_PRODUCT_PAGE_ID,
        name: 'Source Page',
        kind: 'page',
        dependencyIds: [DOMO_PRODUCT_CARD_ID, DOMO_PRODUCT_DATASET_ID],
        featureFlags: [],
        riskFlags: [],
        metadata: {},
      },
      {
        id: DOMO_PRODUCT_CARD_ID,
        name: 'Source Card',
        kind: 'card',
        parentId: DOMO_PRODUCT_PAGE_ID,
        dependencyIds: [DOMO_PRODUCT_DATASET_ID],
        featureFlags: ['drill_path'],
        riskFlags: [],
        metadata: { datasetId: DOMO_PRODUCT_DATASET_ID },
      },
      {
        id: DOMO_PRODUCT_DATASET_ID,
        name: 'Source DataSet',
        kind: 'dataset',
        dependencyIds: [],
        featureFlags: [],
        riskFlags: ['pdp_policy'],
        metadata: {},
      },
    ],
    dashboardCatalog: [{
      id: DOMO_PRODUCT_PAGE_ID,
      name: 'Source Page',
      kind: 'page',
      dependencyIds: [DOMO_PRODUCT_CARD_ID, DOMO_PRODUCT_DATASET_ID],
      dependencies: [
        {
          assetId: DOMO_PRODUCT_CARD_ID,
          name: 'Source Card',
          kind: 'card',
          category: 'content',
          required: true,
          reason: 'The selected Page contains this Card.',
          status: 'resolved',
        },
        {
          assetId: DOMO_PRODUCT_DATASET_ID,
          name: 'Source DataSet',
          kind: 'dataset',
          category: 'data_source',
          required: true,
          reason: 'The selected Card reads this DataSet.',
          status: 'resolved',
        },
      ],
      dependencyCounts: { content: 1, data_source: 1 },
      complexity: 'low',
      coverage: 'partial',
      coverageNotes: ['Analyzer/Card definitions, drill paths, and DataSet PDP policies require manual validation.'],
      riskFlags: [],
    }],
    warnings: [],
    truncated: false,
    collection: {
      scope: 'all_accessible',
      scopeLabel: 'Selected Domo Product API source',
      complete: true,
      status: 'complete',
      errors: [],
      pagesFetched: 1,
      parentsExpanded: 1,
      requestsMade: 1,
      maxPages: 25,
      maxItems: 1000,
    },
  };
}

function neutralDomoProductEvidence(scopeFingerprint: string, connectionUpdatedAt: string): DomoApiEvidenceResult {
  const artifact = artifactFromText('domo', JSON.stringify({
    schemaVersion: 'omnikit.domo.manual.v2',
    datasets: [{
      id: DOMO_PRODUCT_DATASET_ID,
      name: 'Source DataSet',
      description: 'Neutral source values.',
      schema: { columns: [{ name: 'Category', type: 'STRING' }, { name: 'Value', type: 'DECIMAL' }] },
    }],
    pages: [{
      id: DOMO_PRODUCT_PAGE_ID,
      name: 'Source Page',
      title: 'Source Page',
      type: 'page',
      cardIds: [DOMO_PRODUCT_CARD_ID],
      cards: [{ id: DOMO_PRODUCT_CARD_ID, type: 'card' }],
    }],
    cards: [{
      id: DOMO_PRODUCT_CARD_ID,
      pageId: DOMO_PRODUCT_PAGE_ID,
      name: 'Source Card',
      title: 'Source Card',
      type: 'card',
      chartType: 'badge_vert_bar',
      datasourceId: DOMO_PRODUCT_DATASET_ID,
      fields: [{ name: 'Category' }, { name: 'Value' }],
    }],
  }), 'domo-product-api-neutral.json');
  if (!artifact) throw new Error('Neutral Domo Product API evidence could not be created.');
  const parsed = parseDomoManualArtifacts([artifact]);
  if (!parsed.inventory.sourceEvidence) throw new Error('Neutral Domo Product API evidence omitted SourceEvidenceBundleV2.');
  const permissionGaps = [
    `card_analyzer_definition:${DOMO_PRODUCT_CARD_ID}:oauth_or_manual_export_required`,
    `card_drill:${DOMO_PRODUCT_CARD_ID}:manual_validation_required`,
    `dataset_pdp:${DOMO_PRODUCT_DATASET_ID}:oauth_or_manual_export_required`,
  ];
  const parseResult: DomoApiEvidenceResult['parseResult'] = {
    ...parsed,
    inventory: {
      ...parsed.inventory,
      sourceEvidence: {
        ...parsed.inventory.sourceEvidence,
        acquisition: {
          mode: 'api',
          runId: scopeFingerprint,
          selectedScopeIds: [DOMO_PRODUCT_PAGE_ID],
        },
        collection: {
          expectedArtifactCount: 1,
          observedArtifactCount: 1,
          complete: false,
          truncated: false,
          permissionGaps,
        },
        dependencyClosure: {
          status: 'blocked',
          resolvedCount: parsed.mappings.length,
          missingCount: 0,
          reviewCount: 0,
        },
        diagnostics: [
          ...DOMO_PRODUCT_LIMITATIONS.map((limitation) => `${limitation.code}: ${limitation.message}`),
          'Developer-token-only evidence keeps Analyzer/Card definitions, drill paths, and PDP policies as manual handoffs.',
        ],
      },
      artifacts: parsed.inventory.artifacts.map((sourceArtifact) => ({ ...sourceArtifact, content: '' })),
    },
  };
  return {
    parseResult,
    selectedDashboardIds: [DOMO_PRODUCT_PAGE_ID],
    resolvedDashboardIds: [DOMO_PRODUCT_PAGE_ID, DOMO_PRODUCT_CARD_ID],
    connectionUpdatedAt,
    scopeFingerprint,
    preparedAt: '2026-08-12T12:00:00.000Z',
    diagnostics: {
      schemaVersion: 'omnikit.domo.api.v1',
      status: 'ready_with_gaps',
      access: 'deep',
      limitationDispositionRequired: true,
      limitations: DOMO_PRODUCT_LIMITATIONS.map((limitation) => ({ ...limitation })),
      selectedDashboardCount: 1,
      resolvedPageCount: 1,
      resolvedCardCount: 1,
      resolvedDatasetCount: 1,
      resolvedBeastModeCount: 0,
      requestCount: 8,
      truncated: false,
      missingDependencies: [],
      blockers: [],
      warnings: ['Developer-token-only evidence keeps Analyzer/Card definitions, drill paths, and PDP policies as manual handoffs.'],
    },
  };
}

async function seedVault(request: APIRequestContext, options: { withDomoSource?: boolean } = {}): Promise<SeededVault> {
  await request.delete('/api/vault/reset');
  expect((await request.post('/api/vault/unlock', { data: { passphrase: PASSPHRASE } })).ok()).toBeTruthy();

  const instanceResponse = await request.post('/api/instances', {
    data: {
      label: 'Browser Test Omni',
      role: 'both',
      baseUrl: 'https://browser-test.omniapp.co',
      apiKey: 'omni-browser-test-key-not-real',
    },
  });
  expect(instanceResponse.ok()).toBeTruthy();
  const instance = (await instanceResponse.json()).instance as { id: string; label: string; baseUrl: string; apiKeyMasked: string };
  const connection: Record<string, unknown> = {
    baseUrl: instance.baseUrl,
    apiKey: `__omnikit_vault_instance__:${instance.id}`,
    status: 'success',
    connectionMode: 'vault',
    instanceId: instance.id,
    instanceLabel: instance.label,
    apiKeyMasked: instance.apiKeyMasked,
  };

  const providerResponse = await request.post('/api/migration-studio/providers', {
    data: {
      name: 'Browser Test OpenAI',
      kind: 'openai',
      model: 'gpt-4.1-mini',
      baseUrl: 'https://api.openai.com',
      credential: 'fixture-browser-provider-credential',
      enabled: true,
    },
  });
  expect(providerResponse.ok()).toBeTruthy();
  const provider = (await providerResponse.json()).provider as { id: string };

  let sourceConnectionId: string | undefined;
  let sourceConnectionUpdatedAt: string | undefined;
  if (options.withDomoSource) {
    const sourceResponse = await request.post('/api/migration-studio/platform-connections', {
      data: {
        name: 'Browser Test Domo',
        platform: 'domo',
        baseUrl: 'https://api.domo.com',
        authMode: 'product_api_token',
        productApiToken: 'domo-browser-test-not-real',
        enabled: true,
      },
    });
    expect(sourceResponse.ok()).toBeTruthy();
    const source = (await sourceResponse.json()).connection as { id: string; updatedAt: string };
    sourceConnectionId = source.id;
    sourceConnectionUpdatedAt = source.updatedAt;

    const sourceLibraryResponse = await request.get('/api/migration-studio/platform-connections');
    expect(sourceLibraryResponse.ok()).toBeTruthy();
    const sourceLibrary = (await sourceLibraryResponse.json()).connections as Array<{ id: string }>;
    expect(sourceLibrary.some((connection) => connection.id === sourceConnectionId)).toBeTruthy();
  }

  return { connection, instanceId: instance.id, providerId: provider.id, sourceConnectionId, sourceConnectionUpdatedAt };
}

async function openStudio(page: Page, seeded: SeededVault) {
  await page.addInitScript((connection) => {
    window.sessionStorage.setItem('omnikit:activeConnection:v1', JSON.stringify(connection));
  }, seeded.connection);
  await page.goto('/semantic-migrations');
  const heading = page.getByRole('heading', { name: 'BI Migration Studio' });
  const walkthrough = page.getByRole('dialog', { name: /walkthrough|guided tour|see what changed/i });
  await expect(heading.or(walkthrough)).toBeVisible({ timeout: 30_000 });
  if (await walkthrough.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Close walkthrough' }).click();
  }
  await expect(heading).toBeVisible();
}

async function continueTo(page: Page, step: 'Evidence' | 'Destination' | 'Analyze' | 'Place' | 'Resolve' | 'Validate' | 'Build') {
  const button = page.getByRole('button', { name: `Continue to ${step}` });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.getByRole('button', { name: new RegExp(`${step}.*Current step`, 'i') })).toHaveAttribute('aria-current', 'step');
}

async function completePlacementReview(page: Page) {
  await continueTo(page, 'Place');
  await page.getByRole('button', { name: 'Accept safe recommendations' }).click();

  const missingExpression = page.getByText('Executable source expression or transformation definition is missing.', { exact: true });
  while (await missingExpression.count()) {
    const row = page.locator('[data-testid^="migration-placement:"]').filter({
      hasText: 'Executable source expression or transformation definition is missing.',
    }).first();
    const testId = await row.getAttribute('data-testid');
    expect(testId).toBeTruthy();
    const stableRow = page.getByTestId(testId!);
    await stableRow.getByRole('combobox', { name: 'Destination' }).selectOption({ label: 'Do not migrate' });
    await stableRow.getByRole('button', { name: 'Approve' }).click();
  }

  const preparePackage = page.getByRole('button', { name: 'Prepare package' });
  if (await preparePackage.isVisible().catch(() => false)) {
    await expect(preparePackage).toBeEnabled();
    await preparePackage.click();
    await expect(page.getByRole('button', { name: 'Download package' })).toBeVisible();
  }

  await expect(page.getByRole('button', { name: 'Continue to Resolve' })).toBeEnabled();
}

const DEFAULT_DESTINATION_MODEL: DestinationModelFixture = {
  id: 'browser-model-1',
  name: 'Browser Test Food Service',
  identifier: 'browser_food_service',
  connectionId: 'browser-connection-1',
  connectionName: 'Browser Warehouse',
  kind: 'SHARED',
};

function completeModelEnvelope(models: DestinationModelFixture[]) {
  return {
    models,
    pageInfo: {
      hasNextPage: false,
      nextCursor: null,
      pageSize: 100,
      totalRecords: models.length,
    },
    pagesFetched: 1,
    complete: true,
    loadedResults: models.length,
    totalResults: models.length,
  };
}

async function mockTargetModel(
  page: Page,
  options: {
    modelsByKind?: Partial<Record<DestinationModelKind, DestinationModelFixture[]>>;
    respond?: DestinationModelResponder;
  } = {},
) {
  const requests: DestinationModelRequest[] = [];
  const requestCounts: Record<DestinationModelKind, number> = { SHARED: 0, SHARED_EXTENSION: 0 };
  const modelsByKind: Record<DestinationModelKind, DestinationModelFixture[]> = {
    SHARED: options.modelsByKind?.SHARED || [DEFAULT_DESTINATION_MODEL],
    SHARED_EXTENSION: options.modelsByKind?.SHARED_EXTENSION || [],
  };

  await page.route('**/api/list-models', async (route) => {
    expect(route.request().method()).toBe('POST');
    const body = route.request().postDataJSON() as Record<string, unknown>;
    const kind = body.model_kind;
    expect(DESTINATION_MODEL_KINDS).toContain(kind);
    expect(kind).not.toBe('BRANCH');
    expect(kind).not.toBe('QUERY');
    expect(kind).not.toBe('WORKBOOK');
    expect(body.all_pages).toBe(true);
    expect(body.page_size).toBe(100);
    const verifiedKind = kind as DestinationModelKind;
    requestCounts[verifiedKind] += 1;
    const request = {
      baseUrl: String(body.base_url || ''),
      kind: verifiedKind,
      body,
    };
    requests.push(request);
    const payload = options.respond
      ? await options.respond(request, requestCounts[verifiedKind])
      : completeModelEnvelope(modelsByKind[verifiedKind]);
    await json(route, payload);
  });

  return { requests, requestCounts, modelsByKind };
}

async function reachLookerDestination(page: Page, seeded: SeededVault) {
  await openStudio(page, seeded);
  await page.getByRole('button', { name: 'Manual files' }).click();
  await page.getByRole('button', { name: /^Looker/ }).click();
  await continueTo(page, 'Evidence');
  await uploadManualFixture(page, 'looker');
  await page.getByRole('button', { name: 'Review parsed evidence' }).click();
  await page.getByRole('button', { name: 'Confirm LookML inventory' }).click();
  await continueTo(page, 'Destination');
}

async function selectAndApproveExistingModel(page: Page) {
  await page.getByRole('button').filter({ hasText: 'Browser Test Food Service' }).click();
  const approval = page.getByRole('checkbox', {
    name: 'I confirm this shared model and connection are the approved destination.',
  });
  await expect(approval).toBeVisible();
  await approval.check();
  await expect(page.getByText('Destination approved', { exact: true })).toBeVisible();
}

async function expectDestinationApprovalUnavailable(page: Page) {
  const approval = page.getByRole('checkbox', {
    name: 'I confirm this shared model and connection are the approved destination.',
  });
  if (await approval.count()) await expect(approval).toBeDisabled();
}

async function acknowledgeCoverage(page: Page) {
  const acknowledgement = page.getByRole('checkbox', { name: /I reviewed the partial and unsupported classes/ });
  await expect(acknowledgement).toBeVisible();
  await acknowledgement.check();
}

async function acknowledgeDomoEvidenceLimitations(page: Page) {
  await expect(page.getByText('Source evidence needs an explicit disposition')).toBeVisible();
  const acknowledgement = page.getByRole('checkbox', {
    name: /Proceed with these evidence limitations recorded/,
  });
  await expect(acknowledgement).toBeVisible();
  await acknowledgement.check();
}

function validPowerBiPlanOutput() {
  return {
    message: 'The repaired Power BI plan passed the required contract.',
    decisions: [],
    dashboardPlans: [{
      id: 'power-bi-repaired-plan',
      sourceDashboardId: POWER_BI_DASHBOARD_ID,
      sourceEvidenceIds: [POWER_BI_DASHBOARD_ID],
      dependencyIds: POWER_BI_DEPENDENCY_IDS,
      targetName: 'NorthstarDashboard',
      targetFolderPath: null,
      description: 'Rebuild the reviewed Power BI report in Omni.',
      filters: [],
      tiles: POWER_BI_VISUALS.map((visual) => ({
        id: `tile-${visual.id}`,
        title: visual.title,
        description: null,
        sourceEvidenceIds: [visual.evidenceId],
        fields: visual.fields,
        filters: [],
        visualType: visual.visualType,
        buildInstructions: `Rebuild ${visual.title} from its reviewed Power BI visual evidence.`,
        validationAssertions: [`${visual.title} preserves the reviewed source fields.`],
      })),
      unsupportedFeatures: [],
      validationAssertions: ['All six reviewed Power BI visuals are represented exactly once.'],
    }],
  };
}

test.beforeEach(async ({ page, request }) => {
  await request.delete('/api/vault/reset');
  await page.route('**/api/migration-studio/engine/capabilities', (route) => json(route, {
    available: true,
    capabilities: ENGINE_OFF_CAPABILITIES,
  }));
});

test('source setup guide walks every acquisition path without exposing credentials', async ({ page, request }) => {
  const seeded = await seedVault(request);
  await openStudio(page, seeded);

  const guide = page.getByTestId('migration-source-setup-guide');
  await guide.locator('summary').click();
  await expect(guide.getByRole('region', { name: 'Domo Saved API setup' })).toBeVisible();
  await expect(guide.getByText(/Product API developer token/).first()).toBeVisible();
  await expect(guide.getByRole('list').first().locator('li')).not.toHaveCount(0);
  await expect(guide.locator('ol li')).not.toHaveCount(0);

  const documentationLinks = guide.locator('a[target="_blank"]');
  await expect(documentationLinks.first()).toBeVisible();
  const documentationLinkCount = await documentationLinks.count();
  for (let index = 0; index < documentationLinkCount; index += 1) {
    const link = documentationLinks.nth(index);
    await expect(link).toHaveAttribute('href', /^https:\/\//);
    await expect(link).toHaveAttribute('rel', /noreferrer/);
  }

  await guide.getByTestId('migration-source-setup-method-manual').click();
  await expect(guide.getByRole('region', { name: 'Domo Manual Files setup' })).toBeVisible();
  await expect(guide.getByText('.zip', { exact: true })).toBeVisible();

  const sourcePicker = guide.getByRole('combobox', { name: 'Setup guide source platform' });
  await sourcePicker.click();
  await page.getByRole('option').filter({ hasText: 'WebFOCUS' }).click();
  await expect(guide.getByRole('region', { name: 'WebFOCUS Manual Files setup' })).toBeVisible();
  await expect(guide.getByText('Manual Files only', { exact: false }).first()).toBeVisible();
  await expect(guide.getByTestId('migration-source-setup-method-api')).toBeDisabled();
  await expect(guide.getByText('Saved API makes zero outbound requests for WebFOCUS in the current release.')).toBeVisible();

  await sourcePicker.click();
  await page.getByRole('option').filter({ hasText: 'Power BI / Fabric' }).click();
  await guide.getByTestId('migration-source-setup-method-api').click();
  await expect(guide.getByRole('region', { name: 'Power BI / Fabric Saved API setup' })).toBeVisible();
  await expect(guide.getByText('TMDL semantic-model definitions')).toBeVisible();
  await expect(guide.locator('input[type="password"]')).toHaveCount(0);
});

test('AI provider setup remains interactive across provider and authentication changes', async ({ page, request }) => {
  const seeded = await seedVault(request);
  await openStudio(page, seeded);

  await expect(page.getByText('Omni AI is included through the active instance. Another provider is optional.')).toBeVisible();
  await expect(page.getByText('Default', { exact: true })).toBeVisible();
  await expect.poll(async () => {
    const providerLibraryResponse = await request.get('/api/migration-studio/providers');
    if (!providerLibraryResponse.ok()) return false;
    const providerLibrary = (await providerLibraryResponse.json()).providers as Array<{ id: string; kind: string; linkedInstanceId?: string; hasCredential?: boolean }>;
    return providerLibrary.some((provider) => provider.id === `omni-ai-default-${seeded.instanceId}` && provider.kind === 'omni_ai' && provider.linkedInstanceId === seeded.instanceId && provider.hasCredential === false);
  }).toBe(true);

  await page.getByRole('button', { name: 'Use another provider' }).click();
  await page.getByRole('combobox', { name: 'Optional AI provider' }).click();
  const providerListbox = page.getByRole('listbox');
  await expect(providerListbox).toBeVisible();
  const setupBounds = await page.getByTestId('migration-setup-grid').boundingBox();
  const listboxBounds = await providerListbox.boundingBox();
  expect(setupBounds).not.toBeNull();
  expect(listboxBounds).not.toBeNull();
  expect(listboxBounds!.y + listboxBounds!.height).toBeGreaterThan(setupBounds!.y + setupBounds!.height);
  const savedProviderOption = page.getByRole('option').filter({ hasText: 'Browser Test OpenAI' });
  await expect(savedProviderOption).toHaveCount(1);
  await savedProviderOption.click();
  await expect(page.getByText('Override', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Use Omni AI default' }).click();
  await expect(page.getByText('Default', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Add external provider' }).click();
  const providerChoices = page.getByTestId('migration-provider-kind-options');
  const snowflake = providerChoices.locator('button').filter({ hasText: 'Snowflake Cortex' });
  await expect(snowflake).toHaveCount(1);
  await snowflake.click();

  const authChoices = page.getByTestId('migration-provider-auth-options');
  const oauth = authChoices.locator('button').filter({ hasText: 'OAuth access token' });
  await expect(oauth).toHaveCount(1);
  await oauth.click();
  await page.getByTestId('provider-credential-help').locator('summary').click();
  await page.getByTestId('provider-security-help').locator('summary').click();
  await expect(page.getByText('OmniKit encrypts only the short-lived OAuth access token.')).toBeVisible();
  await page.getByLabel('Profile name').fill('Interactive provider test');

  const keyPair = authChoices.locator('button').filter({ hasText: 'Key-pair JWT' });
  await expect(keyPair).toHaveCount(0);

  const anthropic = providerChoices.locator('button').filter({ hasText: 'Anthropic' });
  await expect(anthropic).toHaveCount(1);
  await anthropic.click();
  await expect(page.getByText('Use a standard Claude API key, not an Admin API key or a Claude login/session credential.')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: /add ai provider/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add external provider' })).toBeFocused();
  await page.getByRole('button', { name: 'Manual files' }).click();
  await expect(page.getByText('Saved API access is not required.')).toBeVisible();
});

test('Domo developer token saves without OAuth fields or secret disclosure', async ({ page, request }) => {
  const seeded = await seedVault(request);
  const developerToken = 'browser-domo-product-token-not-real-and-never-public';
  await openStudio(page, seeded);

  await page.getByRole('button', { name: 'Add API source' }).click();
  await page.getByRole('combobox', { name: 'Source platform' }).click();
  await page.getByRole('option', { name: 'Domo' }).click();

  await expect(page.getByLabel('Domo instance URL')).toBeVisible();
  await expect(page.getByRole('textbox', { name: /^Product API developer token/ })).toBeVisible();
  await expect(page.getByLabel('Domo client secret')).toHaveCount(0);
  await expect(page.getByLabel('Domo OAuth access token')).toHaveCount(0);
  await expect(page.getByLabel('Domo client ID')).toHaveCount(0);

  await page.getByLabel('Connection name').fill('Browser Domo developer override');
  await page.getByLabel('Domo instance URL').fill('https://browser-company.domo.com');
  await page.getByRole('textbox', { name: /^Product API developer token/ }).fill(developerToken);
  const saveResponsePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/migration-studio/platform-connections'
  ));
  await page.getByRole('button', { name: 'Save source' }).click();
  const saveResponse = await saveResponsePromise;
  expect(saveResponse.ok()).toBeTruthy();
  expect(saveResponse.request().postDataJSON()).toMatchObject({
    name: 'Browser Domo developer override',
    platform: 'domo',
    baseUrl: 'https://browser-company.domo.com',
    authMode: 'product_api_token',
    credential: '',
    productApiToken: developerToken,
  });
  expect(await saveResponse.text()).not.toContain(developerToken);

  await expect(page.getByText('Browser Domo developer override', { exact: true })).toBeVisible();
  await expect(page.getByText(/Domo · Product API developer token · Encrypted/)).toBeVisible();
  expect(await page.content()).not.toContain(developerToken);

  const libraryResponse = await request.get('/api/migration-studio/platform-connections');
  expect(libraryResponse.ok()).toBeTruthy();
  const libraryText = await libraryResponse.text();
  expect(libraryText).not.toContain(developerToken);
  const library = JSON.parse(libraryText).connections as Array<Record<string, unknown>>;
  const saved = library.find((connection) => connection.name === 'Browser Domo developer override');
  expect(saved).toMatchObject({
    authMode: 'product_api_token',
    hasCredential: false,
    hasProductApiToken: true,
    inventoryAccess: 'deep',
  });
  expect(saved).not.toHaveProperty('credential');
  expect(saved).not.toHaveProperty('productApiToken');
});

test('saved Domo credentials can be edited, rotated, selectively removed, and deleted without secret disclosure', async ({ page, request }) => {
  const seeded = await seedVault(request);
  const originalProductToken = 'domo-original-product-token-browser-fixture-not-real';
  const rotatedProductToken = 'domo-rotated-product-token-browser-fixture-not-real';
  const oauthClientSecret = 'domo-oauth-client-secret-browser-fixture-not-real';
  const sourceResponse = await request.post('/api/migration-studio/platform-connections', {
    data: {
      name: 'Example Domo dual credential source',
      platform: 'domo',
      baseUrl: 'https://example-source.domo.com',
      authMode: 'product_api_token',
      productApiToken: originalProductToken,
      clientId: 'example-domo-oauth-client-id',
      credential: oauthClientSecret,
      enabled: true,
    },
  });
  expect(sourceResponse.ok()).toBeTruthy();
  const source = (await sourceResponse.json()).connection as { id: string };
  const patchPayloads: Array<Record<string, unknown>> = [];
  let deleteRequests = 0;
  await page.route(`**/api/migration-studio/platform-connections/${source.id}`, async (route) => {
    if (route.request().method() === 'PATCH') {
      patchPayloads.push(route.request().postDataJSON() as Record<string, unknown>);
    }
    if (route.request().method() === 'DELETE') deleteRequests += 1;
    await route.continue();
  });

  await openStudio(page, seeded);
  await page.getByRole('combobox', { name: 'Saved source API connection' }).click();
  await page.getByRole('option').filter({ hasText: 'Example Domo dual credential source' }).click();
  await page.getByTitle('Edit or rotate source credentials').click();

  await expect(page.getByText('Edit saved API source', { exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Source platform' })).toBeDisabled();
  await expect(page.getByRole('textbox', { name: /^Product API developer token/ })).toHaveValue('');
  await expect(page.getByLabel('Domo OAuth client ID')).toHaveValue('example-domo-oauth-client-id');
  await expect(page.getByLabel('Domo OAuth client secret')).toHaveValue('');
  expect(await page.content()).not.toContain(originalProductToken);
  expect(await page.content()).not.toContain(oauthClientSecret);

  await page.getByLabel('Connection name').fill('Example Domo edited source');
  let updateResponsePromise = page.waitForResponse((response) => (
    response.request().method() === 'PATCH'
    && new URL(response.url()).pathname.endsWith(`/platform-connections/${source.id}`)
  ));
  await page.getByRole('button', { name: 'Update source' }).click();
  let updateResponse = await updateResponsePromise;
  expect(updateResponse.ok()).toBeTruthy();
  expect(patchPayloads[0]).toMatchObject({
    id: source.id,
    name: 'Example Domo edited source',
    platform: 'domo',
    authMode: 'product_api_token',
    credential: '',
    productApiToken: '',
    clientId: 'example-domo-oauth-client-id',
    clearCredential: false,
    clearClientId: false,
    clearProductApiToken: false,
  });
  expect(await updateResponse.text()).not.toContain(originalProductToken);
  expect(await updateResponse.text()).not.toContain(oauthClientSecret);
  expect(await page.content()).not.toContain(originalProductToken);
  expect(await page.content()).not.toContain(oauthClientSecret);

  await page.getByTitle('Edit or rotate source credentials').click();
  await page.getByRole('textbox', { name: /^Product API developer token/ }).fill(rotatedProductToken);
  updateResponsePromise = page.waitForResponse((response) => (
    response.request().method() === 'PATCH'
    && new URL(response.url()).pathname.endsWith(`/platform-connections/${source.id}`)
  ));
  await page.getByRole('button', { name: 'Update source' }).click();
  updateResponse = await updateResponsePromise;
  expect(updateResponse.ok()).toBeTruthy();
  expect(patchPayloads[1]).toMatchObject({
    id: source.id,
    platform: 'domo',
    authMode: 'product_api_token',
    credential: '',
    productApiToken: rotatedProductToken,
    clearCredential: false,
    clearClientId: false,
    clearProductApiToken: false,
  });
  expect(await updateResponse.text()).not.toContain(rotatedProductToken);
  expect(await updateResponse.text()).not.toContain(oauthClientSecret);
  expect(await page.content()).not.toContain(rotatedProductToken);
  expect(await page.content()).not.toContain(oauthClientSecret);

  await page.getByTitle('Edit or rotate source credentials').click();
  await page.getByRole('checkbox', { name: 'Remove the saved Platform OAuth client ID and secret when updating' }).check();
  await expect(page.getByLabel('Domo OAuth client ID')).toHaveCount(0);
  await expect(page.getByLabel('Domo OAuth client secret')).toHaveCount(0);
  updateResponsePromise = page.waitForResponse((response) => (
    response.request().method() === 'PATCH'
    && new URL(response.url()).pathname.endsWith(`/platform-connections/${source.id}`)
  ));
  await page.getByRole('button', { name: 'Update source' }).click();
  updateResponse = await updateResponsePromise;
  expect(updateResponse.ok()).toBeTruthy();
  expect(patchPayloads[2]).toMatchObject({
    id: source.id,
    platform: 'domo',
    authMode: 'product_api_token',
    credential: '',
    productApiToken: '',
    clearCredential: true,
    clearClientId: true,
    clearProductApiToken: false,
  });
  expect(await updateResponse.text()).not.toContain(rotatedProductToken);
  expect(await updateResponse.text()).not.toContain(oauthClientSecret);

  const libraryResponse = await request.get('/api/migration-studio/platform-connections');
  expect(libraryResponse.ok()).toBeTruthy();
  const libraryText = await libraryResponse.text();
  expect(libraryText).not.toContain(originalProductToken);
  expect(libraryText).not.toContain(rotatedProductToken);
  expect(libraryText).not.toContain(oauthClientSecret);
  const saved = (JSON.parse(libraryText).connections as Array<Record<string, unknown>>)
    .find((connection) => connection.id === source.id);
  expect(saved).toMatchObject({
    hasCredential: false,
    hasPlatformOAuthClient: false,
    hasProductApiToken: true,
    inventoryAccess: 'deep',
  });
  expect(saved).not.toHaveProperty('credential');
  expect(saved).not.toHaveProperty('productApiToken');
  expect(await page.content()).not.toContain(rotatedProductToken);
  expect(await page.content()).not.toContain(oauthClientSecret);

  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByTitle('Delete source connection').click();
  await expect(page.getByText('Example Domo edited source', { exact: true })).toHaveCount(0);
  expect(deleteRequests).toBe(1);
});

test('Power BI source editing preserves blank secrets and requires replacements across both OAuth modes', async ({ page, request }) => {
  const seeded = await seedVault(request);
  const originalClientSecret = 'power-bi-original-client-secret-browser-fixture-not-real';
  const delegatedAccessToken = 'power-bi-delegated-access-token-browser-fixture-not-real';
  const replacementClientSecret = 'power-bi-replacement-client-secret-browser-fixture-not-real';
  const delegatedExpiry = '2099-01-02T03:04';
  const sourceResponse = await request.post('/api/migration-studio/platform-connections', {
    data: {
      name: 'Example Power BI OAuth source',
      platform: 'power_bi',
      baseUrl: 'https://api.fabric.microsoft.com',
      authMode: 'oauth_client_credentials',
      accountIdentifier: 'example-tenant-id',
      clientId: 'example-service-principal-client-id',
      credential: originalClientSecret,
      workspaceId: 'example-fabric-workspace-id',
      enabled: true,
    },
  });
  expect(sourceResponse.ok()).toBeTruthy();
  const source = (await sourceResponse.json()).connection as { id: string };
  const patchPayloads: Array<Record<string, unknown>> = [];
  await page.route(`**/api/migration-studio/platform-connections/${source.id}`, async (route) => {
    if (route.request().method() === 'PATCH') {
      patchPayloads.push(route.request().postDataJSON() as Record<string, unknown>);
    }
    await route.continue();
  });

  await openStudio(page, seeded);
  await page.getByRole('combobox', { name: 'Saved source API connection' }).click();
  await page.getByRole('option').filter({ hasText: 'Example Power BI OAuth source' }).click();
  await page.getByTitle('Edit or rotate source credentials').click();

  const authentication = page.getByLabel('Microsoft authentication');
  await expect(authentication).toHaveValue('oauth_client_credentials');
  await expect(page.getByLabel('Microsoft Entra tenant ID')).toHaveValue('example-tenant-id');
  await expect(page.getByLabel('Client ID')).toHaveValue('example-service-principal-client-id');
  await expect(page.getByLabel('Client secret')).toHaveValue('');
  await expect(page.getByLabel('Fabric workspace ID')).toHaveValue('example-fabric-workspace-id');
  expect(await page.content()).not.toContain(originalClientSecret);

  await page.getByLabel('Connection name').fill('Example Power BI edited source');
  let updateResponsePromise = page.waitForResponse((response) => (
    response.request().method() === 'PATCH'
    && new URL(response.url()).pathname.endsWith(`/platform-connections/${source.id}`)
  ));
  await page.getByRole('button', { name: 'Update source' }).click();
  let updateResponse = await updateResponsePromise;
  expect(updateResponse.ok()).toBeTruthy();
  expect(patchPayloads[0]).toMatchObject({
    id: source.id,
    name: 'Example Power BI edited source',
    platform: 'power_bi',
    authMode: 'oauth_client_credentials',
    accountIdentifier: 'example-tenant-id',
    clientId: 'example-service-principal-client-id',
    credential: '',
    workspaceId: 'example-fabric-workspace-id',
  });
  expect(patchPayloads[0]).not.toHaveProperty('credentialExpiresAt');
  expect(await updateResponse.text()).not.toContain(originalClientSecret);
  expect(await page.content()).not.toContain(originalClientSecret);

  await page.getByTitle('Edit or rotate source credentials').click();
  await authentication.selectOption('oauth_access_token');
  await expect(page.getByLabel('Microsoft Entra tenant ID')).toHaveCount(0);
  await expect(page.getByLabel('Client ID')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'OAuth access token', exact: true })).toHaveValue('');
  await expect(page.getByLabel('Token expires')).toHaveValue('');
  await page.getByRole('textbox', { name: 'OAuth access token', exact: true }).fill(delegatedAccessToken);
  await page.getByLabel('Token expires').fill(delegatedExpiry);
  updateResponsePromise = page.waitForResponse((response) => (
    response.request().method() === 'PATCH'
    && new URL(response.url()).pathname.endsWith(`/platform-connections/${source.id}`)
  ));
  await page.getByRole('button', { name: 'Update source' }).click();
  updateResponse = await updateResponsePromise;
  expect(updateResponse.ok()).toBeTruthy();
  expect(patchPayloads[1]).toMatchObject({
    id: source.id,
    platform: 'power_bi',
    authMode: 'oauth_access_token',
    credential: delegatedAccessToken,
    workspaceId: 'example-fabric-workspace-id',
    credentialExpiresAt: delegatedExpiry,
  });
  expect(patchPayloads[1]).not.toHaveProperty('accountIdentifier');
  expect(patchPayloads[1]).not.toHaveProperty('clientId');
  expect(await updateResponse.text()).not.toContain(delegatedAccessToken);
  await expect(page.getByText(/Power BI · OAuth access token · Encrypted/)).toBeVisible();
  expect(await page.content()).not.toContain(originalClientSecret);
  expect(await page.content()).not.toContain(delegatedAccessToken);

  await page.getByTitle('Edit or rotate source credentials').click();
  await expect(authentication).toHaveValue('oauth_access_token');
  await expect(page.getByRole('textbox', { name: 'OAuth access token', exact: true })).toHaveValue('');
  await expect(page.getByLabel('Token expires')).not.toHaveValue('');
  await authentication.selectOption('oauth_client_credentials');
  await expect(page.getByLabel('Token expires')).toHaveCount(0);
  await page.getByLabel('Microsoft Entra tenant ID').fill('example-replacement-tenant-id');
  await page.getByLabel('Client ID').fill('example-replacement-client-id');
  await page.getByLabel('Client secret').fill(replacementClientSecret);
  updateResponsePromise = page.waitForResponse((response) => (
    response.request().method() === 'PATCH'
    && new URL(response.url()).pathname.endsWith(`/platform-connections/${source.id}`)
  ));
  await page.getByRole('button', { name: 'Update source' }).click();
  updateResponse = await updateResponsePromise;
  expect(updateResponse.ok()).toBeTruthy();
  expect(patchPayloads[2]).toMatchObject({
    id: source.id,
    platform: 'power_bi',
    authMode: 'oauth_client_credentials',
    accountIdentifier: 'example-replacement-tenant-id',
    clientId: 'example-replacement-client-id',
    credential: replacementClientSecret,
    workspaceId: 'example-fabric-workspace-id',
  });
  expect(patchPayloads[2]).not.toHaveProperty('credentialExpiresAt');
  expect(await updateResponse.text()).not.toContain(replacementClientSecret);
  await expect(page.getByText(/Power BI · Entra service principal · Encrypted/)).toBeVisible();
  expect(await page.content()).not.toContain(originalClientSecret);
  expect(await page.content()).not.toContain(delegatedAccessToken);
  expect(await page.content()).not.toContain(replacementClientSecret);

  const libraryResponse = await request.get('/api/migration-studio/platform-connections');
  expect(libraryResponse.ok()).toBeTruthy();
  const libraryText = await libraryResponse.text();
  expect(libraryText).not.toContain(originalClientSecret);
  expect(libraryText).not.toContain(delegatedAccessToken);
  expect(libraryText).not.toContain(replacementClientSecret);
  const saved = (JSON.parse(libraryText).connections as Array<Record<string, unknown>>)
    .find((connection) => connection.id === source.id);
  expect(saved).toMatchObject({
    authMode: 'oauth_client_credentials',
    accountIdentifier: 'example-replacement-tenant-id',
    clientId: 'example-replacement-client-id',
    workspaceId: 'example-fabric-workspace-id',
    hasCredential: true,
  });
  expect(saved).not.toHaveProperty('credential');
  expect(saved).not.toHaveProperty('credentialExpiresAt');
});

test('Domo acquisition failure reports the upstream access error without claiming a safety bound', async ({ page, request }) => {
  const seeded = await seedVault(request, { withDomoSource: true });
  const upstreamError = 'Domo Product Search returned 403 Forbidden. Verify the developer token permissions and tenant URL, then retry.';
  let legacyInventoryRequests = 0;
  await page.route('**/api/migration-studio/platform-connections/*/test', (route) => json(route, {
    ok: false,
    platform: 'domo',
    itemCount: 0,
    ...domoInventoryEnvelope(seeded.sourceConnectionId!, { status: 'failed', errors: [upstreamError] }),
  }));
  await page.route('**/api/migration-studio/platform-connections/*/inventory', (route) => {
    legacyInventoryRequests += 1;
    return json(route, domoInventoryEnvelope(seeded.sourceConnectionId!, { status: 'failed', errors: [upstreamError] }));
  });

  await openStudio(page, seeded);
  await page.getByRole('button', { name: 'Refresh' }).click();
  await page.getByRole('combobox', { name: 'Saved source API connection' }).click();
  await page.getByRole('option').filter({ hasText: 'Browser Test Domo' }).click();
  await page.getByRole('button', { name: 'Load inventory' }).click();

  await expect(page.getByText(upstreamError, { exact: false })).toBeVisible();
  await expect(page.getByText('0 source items collected; verification incomplete')).toBeVisible();
  await expect(page.getByText(/safety bound/i)).toHaveCount(0);
  await expect(page.getByText(/ready to scope/i)).toHaveCount(0);
  await expect(page.getByText(/verified empty scope/i)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Continue to Evidence' })).toBeDisabled();
  expect(legacyInventoryRequests).toBe(0);
});

test('Domo verified empty inventory remains distinct from acquisition failure', async ({ page, request }) => {
  const seeded = await seedVault(request, { withDomoSource: true });
  let legacyInventoryRequests = 0;
  await page.route('**/api/migration-studio/platform-connections/*/test', (route) => json(route, {
    ok: true,
    platform: 'domo',
    itemCount: 0,
    ...domoInventoryEnvelope(seeded.sourceConnectionId!, { status: 'complete' }),
  }));
  await page.route('**/api/migration-studio/platform-connections/*/inventory', (route) => {
    legacyInventoryRequests += 1;
    return json(route, domoInventoryEnvelope(seeded.sourceConnectionId!, { status: 'complete' }));
  });

  await openStudio(page, seeded);
  await page.getByRole('button', { name: 'Refresh' }).click();
  await page.getByRole('combobox', { name: 'Saved source API connection' }).click();
  await page.getByRole('option').filter({ hasText: 'Browser Test Domo' }).click();
  await page.getByRole('button', { name: 'Load inventory' }).click();

  await expect(page.getByText('The Domo inventory is verified empty for All accessible Domo content.')).toBeVisible();
  await expect(page.getByText('0 source items in a verified empty scope')).toBeVisible();
  await expect(page.getByText(/verification incomplete/i)).toHaveCount(0);
  await expect(page.getByText(/safety bound/i)).toHaveCount(0);
  await expect(page.getByText(/could not be verified/i)).toHaveCount(0);
  expect(legacyInventoryRequests).toBe(0);
});

test('a delayed saved-source inventory cannot replace or unlock the newly selected source', async ({ page, request }) => {
  const seeded = await seedVault(request);
  const sourceConnections = new Map<string, string>();
  for (const sourceLabel of ['Saved Source A', 'Saved Source B']) {
    const response = await request.post('/api/migration-studio/platform-connections', {
      data: {
        name: sourceLabel,
        platform: 'metabase',
        baseUrl: `https://${sourceLabel.endsWith('A') ? 'source-a' : 'source-b'}.example.com`,
        authMode: 'api_key',
        credential: `${sourceLabel.endsWith('A') ? 'source-a' : 'source-b'}-browser-credential-not-real`,
        enabled: true,
      },
    });
    expect(response.ok()).toBeTruthy();
    const connection = (await response.json()).connection as { id: string };
    sourceConnections.set(sourceLabel, connection.id);
  }
  const sourceAId = sourceConnections.get('Saved Source A')!;
  const sourceBId = sourceConnections.get('Saved Source B')!;
  let releaseSourceA!: () => void;
  let releaseSourceB!: () => void;
  let markSourceAStarted!: () => void;
  let markSourceBStarted!: () => void;
  const sourceAGate = new Promise<void>((resolveGate) => { releaseSourceA = resolveGate; });
  const sourceBGate = new Promise<void>((resolveGate) => { releaseSourceB = resolveGate; });
  const sourceAStarted = new Promise<void>((resolveStarted) => { markSourceAStarted = resolveStarted; });
  const sourceBStarted = new Promise<void>((resolveStarted) => { markSourceBStarted = resolveStarted; });
  await page.route('**/api/migration-studio/platform-connections/*/test', async (route) => {
    const connectionId = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2) || '');
    const sourceLabel = connectionId === sourceAId ? 'Saved Source A' : connectionId === sourceBId ? 'Saved Source B' : '';
    if (!sourceLabel) return json(route, { error: 'Unknown saved source.' }, 404);
    if (connectionId === sourceAId) {
      markSourceAStarted();
      await sourceAGate;
    } else {
      markSourceBStarted();
      await sourceBGate;
    }
    const inventory = neutralSavedSourceInventory(connectionId, sourceLabel);
    return json(route, { ok: true, platform: 'metabase', itemCount: inventory.items.length, inventory });
  });

  await openStudio(page, seeded);
  const sourcePicker = page.getByRole('combobox', { name: 'Saved source API connection' });
  await sourcePicker.click();
  await page.getByRole('option').filter({ hasText: 'Saved Source A' }).click();
  await page.getByRole('button', { name: 'Load inventory' }).click();
  await sourceAStarted;

  await sourcePicker.click();
  await page.getByRole('option').filter({ hasText: 'Saved Source B' }).click();
  await expect(page.getByRole('button', { name: 'Load inventory' })).toBeEnabled();
  await page.getByRole('button', { name: 'Load inventory' }).click();
  await sourceBStarted;
  await expect(page.getByRole('button', { name: 'Load inventory' })).toBeDisabled();

  const sourceAResponse = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith(`/platform-connections/${sourceAId}/test`));
  releaseSourceA();
  await sourceAResponse;
  await page.evaluate(() => new Promise<void>((resolveFrame) => requestAnimationFrame(() => resolveFrame())));
  await expect(page.getByRole('button', { name: 'Load inventory' })).toBeDisabled();
  await expect(page.getByText('Saved Source A Dashboard', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Loaded 1 Metabase source items from Saved Source A scope.', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Continue to Evidence' })).toBeDisabled();

  releaseSourceB();
  await expect(page.getByText('Saved Source B Dashboard', { exact: true })).toBeVisible();
  await expect(page.getByText('Loaded 1 Metabase source items from Saved Source B scope.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue to Evidence' })).toBeEnabled();

  await sourcePicker.click();
  await page.getByRole('option').filter({ hasText: 'Saved Source A' }).click();
  await expect(page.getByText('Saved Source B Dashboard', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Loaded 1 Metabase source items from Saved Source B scope.', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Continue to Evidence' })).toBeDisabled();
});

test('workflow starts focused and remains usable on a narrow screen', async ({ page, request }) => {
  const seeded = await seedVault(request);
  await page.setViewportSize({ width: 390, height: 844 });
  await openStudio(page, seeded);

  await expect(page.getByText('Artifacts', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Source.*Current step/i })).toHaveAttribute('aria-current', 'step');
  await expect(page.getByRole('button', { name: 'Saved API' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Domo selected')).toHaveCount(0);
  await expect(page.getByText('Power BI selected')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Continue to Evidence' })).toBeDisabled();
  await page.getByRole('button', { name: 'Manual files' }).click();
  await expect(page.getByText('Domo selected')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue to Evidence' })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});

test('destination inventory fails closed on a cached incomplete response and force-refresh retry recovers', async ({ page, request }) => {
  const seeded = await seedVault(request);
  const modelMock = await mockTargetModel(page, {
    respond: ({ kind }, requestNumberForKind) => {
      if (kind === 'SHARED' && requestNumberForKind === 1) {
        return {
          models: [DEFAULT_DESTINATION_MODEL],
          pageInfo: { hasNextPage: true, nextCursor: 'still-loading', pageSize: 100, totalRecords: 2 },
          pagesFetched: 1,
          complete: false,
          loadedResults: 1,
          totalResults: 2,
        };
      }
      return completeModelEnvelope(kind === 'SHARED' ? [DEFAULT_DESTINATION_MODEL] : []);
    },
  });

  await reachLookerDestination(page, seeded);
  await expect(page.getByTestId('destination-model-inventory-error')).toBeVisible();
  await expect(page.getByTestId('destination-model-inventory-empty')).toHaveCount(0);
  await expect(page.getByTestId('destination-model-inventory-ready')).toHaveCount(0);
  await expect(page.getByTestId('destination-model-search-no-match')).toHaveCount(0);
  await expect(page.getByRole('button').filter({ hasText: 'Browser Test Food Service' })).toHaveCount(0);
  await expectDestinationApprovalUnavailable(page);
  await expect(page.getByRole('button', { name: 'Continue to Analyze' })).toBeDisabled();

  const countsBeforeRetry = { ...modelMock.requestCounts };
  await page.getByRole('button', { name: 'Retry model inventory' }).click();
  await expect(page.getByTestId('destination-model-inventory-ready')).toBeVisible();
  await expect(page.getByRole('button').filter({ hasText: 'Browser Test Food Service' })).toBeVisible();
  expect(modelMock.requestCounts.SHARED).toBeGreaterThan(countsBeforeRetry.SHARED);
  expect(modelMock.requestCounts.SHARED_EXTENSION).toBeGreaterThan(countsBeforeRetry.SHARED_EXTENSION);
  expect(new Set(modelMock.requests.map((entry) => entry.kind))).toEqual(new Set(DESTINATION_MODEL_KINDS));

  await page.getByPlaceholder(/Search 1 models by name or connection/).fill('definitely-not-a-destination');
  await expect(page.getByTestId('destination-model-search-no-match')).toBeVisible();
  await expect(page.getByTestId('destination-model-inventory-empty')).toHaveCount(0);
  await expect(page.getByTestId('destination-model-inventory-error')).toHaveCount(0);
});

test('verified empty destination inventory is distinct from failure and remains blocked', async ({ page, request }) => {
  const seeded = await seedVault(request);
  const modelMock = await mockTargetModel(page, {
    modelsByKind: { SHARED: [], SHARED_EXTENSION: [] },
  });

  await reachLookerDestination(page, seeded);
  await expect(page.getByTestId('destination-model-inventory-empty')).toBeVisible();
  await expect(page.getByTestId('destination-model-inventory-error')).toHaveCount(0);
  await expect(page.getByTestId('destination-model-inventory-ready')).toHaveCount(0);
  await expect(page.getByTestId('destination-model-search-no-match')).toHaveCount(0);
  await expect(page.getByRole('button').filter({ hasText: 'Browser Test Food Service' })).toHaveCount(0);
  await expectDestinationApprovalUnavailable(page);
  await expect(page.getByRole('button', { name: 'Continue to Analyze' })).toBeDisabled();
  expect(new Set(modelMock.requests.map((entry) => entry.kind))).toEqual(new Set(DESTINATION_MODEL_KINDS));
});

test('a delayed prior-tenant inventory cannot replace the active tenant inventory', async ({ page, request }) => {
  const seeded = await seedVault(request);
  const tenantBResponse = await request.post('/api/instances', {
    data: {
      label: 'Browser Test Tenant B',
      role: 'both',
      baseUrl: 'https://browser-tenant-b.omniapp.co',
      apiKey: 'omni-browser-tenant-b-key-not-real',
    },
  });
  expect(tenantBResponse.ok()).toBeTruthy();
  const tenantB = (await tenantBResponse.json()).instance as {
    id: string;
    label: string;
    role: string;
    baseUrl: string;
    apiKeyMasked: string;
    [key: string]: unknown;
  };
  const staleModel: DestinationModelFixture = {
    ...DEFAULT_DESTINATION_MODEL,
    id: 'tenant-a-model',
    name: 'Tenant A Stale Model',
    identifier: 'tenant_a_stale_model',
  };
  const tenantBModel: DestinationModelFixture = {
    ...DEFAULT_DESTINATION_MODEL,
    id: 'tenant-b-model',
    name: 'Tenant B Current Model',
    identifier: 'tenant_b_current_model',
    connectionId: 'tenant-b-connection',
    connectionName: 'Tenant B Warehouse',
  };
  let releaseTenantAShared!: () => void;
  let markTenantASharedStarted!: () => void;
  let tenantASharedSettled = false;
  const tenantASharedGate = new Promise<void>((resolveGate) => { releaseTenantAShared = resolveGate; });
  const tenantASharedStarted = new Promise<void>((resolveStarted) => { markTenantASharedStarted = resolveStarted; });
  const modelMock = await mockTargetModel(page, {
    respond: async ({ baseUrl, kind }) => {
      if (baseUrl === String(seeded.connection.baseUrl) && kind === 'SHARED') {
        markTenantASharedStarted();
        await tenantASharedGate;
        tenantASharedSettled = true;
        return completeModelEnvelope([staleModel]);
      }
      if (baseUrl === tenantB.baseUrl) {
        return completeModelEnvelope(kind === 'SHARED' ? [tenantBModel] : []);
      }
      return completeModelEnvelope([]);
    },
  });
  await page.route(`**/api/instances/${tenantB.id}/connect`, (route) => json(route, {
    instance: { ...tenantB, lastValidatedAt: new Date().toISOString() },
    connection: {
      baseUrl: tenantB.baseUrl,
      apiKey: `__omnikit_vault_instance__:${tenantB.id}`,
      status: 'success',
      connectionMode: 'vault',
      instanceId: tenantB.id,
      instanceLabel: tenantB.label,
      apiKeyMasked: tenantB.apiKeyMasked,
    },
  }));

  await reachLookerDestination(page, seeded);
  await tenantASharedStarted;
  await expect(page.getByTestId('destination-model-inventory-loading')).toBeVisible();
  await page.getByRole('button', { name: /Browser Test Omni/ }).click();
  await page.getByRole('button', { name: /Browser Test Tenant B/ }).click();
  await expect(page.getByTestId('destination-model-inventory-ready')).toBeVisible();
  await expect(page.getByRole('button').filter({ hasText: 'Tenant B Current Model' })).toBeVisible();
  await expect(page.getByText('Tenant A Stale Model', { exact: true })).toHaveCount(0);

  releaseTenantAShared();
  await expect.poll(() => tenantASharedSettled).toBe(true);
  await expect(page.getByRole('button').filter({ hasText: 'Tenant B Current Model' })).toBeVisible();
  await expect(page.getByText('Tenant A Stale Model', { exact: true })).toHaveCount(0);
  for (const baseUrl of [String(seeded.connection.baseUrl), tenantB.baseUrl]) {
    expect(new Set(modelMock.requests.filter((entry) => entry.baseUrl === baseUrl).map((entry) => entry.kind)))
      .toEqual(new Set(DESTINATION_MODEL_KINDS));
  }
});

test('provisioning refreshes cached empty kinds and selects the newly created shared model', async ({ page, request }) => {
  const seeded = await seedVault(request);
  const targetInstanceId = seeded.instanceId;
  const connectionId = 'browser-foundation-connection';
  const schemaModelId = 'browser-foundation-schema-model';
  const provisionedModel: DestinationModelFixture = {
    ...DEFAULT_DESTINATION_MODEL,
    id: 'browser-provisioned-shared-model',
    name: 'Browser Provisioned Shared Model',
    identifier: 'browser_provisioned_shared_model',
    connectionId,
    connectionName: 'Browser Foundation Warehouse',
  };
  let provisioned = false;
  let provisionPlan: Record<string, unknown> | null = null;
  const inventory = {
    version: '1.0',
    targetInstanceId,
    connections: [{ id: connectionId, name: 'Browser Foundation Warehouse', dialect: 'snowflake' }],
    schemaModels: [{ id: schemaModelId, name: 'Browser Foundation Schema', connectionId }],
    sharedModels: [] as Array<Record<string, unknown>>,
  };
  const modelMock = await mockTargetModel(page, {
    respond: ({ kind }) => completeModelEnvelope(
      provisioned && kind === 'SHARED' ? [provisionedModel] : [],
    ),
  });
  await page.route(`**/api/migration-studio/destination-foundation/${targetInstanceId}/*`, async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'GET' && url.pathname.endsWith('/inventory')) {
      await json(route, { inventory });
      return;
    }
    expect(route.request().method()).toBe('POST');
    expect(url.pathname.endsWith('/provision')).toBeTruthy();
    provisionPlan = route.request().postDataJSON() as Record<string, unknown>;
    provisioned = true;
    const readyInventory = {
      ...inventory,
      sharedModels: [{
        id: provisionedModel.id,
        name: provisionedModel.name,
        connectionId,
        baseModelId: schemaModelId,
        kind: 'SHARED',
      }],
    };
    await json(route, {
      result: {
        version: '1.0',
        state: {
          version: '1.0',
          plan: provisionPlan,
          phase: 'ready',
          connectionId,
          schemaModelId,
          sharedModelId: provisionedModel.id,
          reusedConnection: true,
          reusedSchemaModel: true,
          reusedSharedModel: false,
        },
        inventory: readyInventory,
        created: { connection: false, schemaModel: false, sharedModel: true },
      },
    }, 201);
  });

  await reachLookerDestination(page, seeded);
  await expect(page.getByTestId('destination-model-inventory-empty')).toBeVisible();
  const countsBeforeProvision = { ...modelMock.requestCounts };
  await page.getByRole('radio', { name: /Build from this connection/ }).click();
  await page.getByLabel('Existing Omni connection').selectOption(connectionId);
  await page.getByLabel('New shared model name').fill(provisionedModel.name);
  await page.getByRole('checkbox', {
    name: 'I approve creating this shared model from the selected existing schema model.',
  }).check();
  await page.getByRole('button', { name: 'Approve and prepare model' }).click();

  await expect(page.getByText('Destination foundation is ready.')).toBeVisible();
  await expect(page.getByText(new RegExp(`Migration route.*${provisionedModel.name}`))).toBeVisible();
  await expect(page.getByText('Destination ready', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue to Analyze' })).toBeEnabled();
  expect(provisionPlan).toMatchObject({
    targetInstanceId,
    mode: 'existing_connection',
    connectionId,
    schemaModelId,
    sharedModelName: provisionedModel.name,
  });
  expect(modelMock.requestCounts.SHARED).toBeGreaterThan(countsBeforeProvision.SHARED);
  expect(modelMock.requestCounts.SHARED_EXTENSION).toBeGreaterThan(countsBeforeProvision.SHARED_EXTENSION);
  expect(new Set(modelMock.requests.map((entry) => entry.kind))).toEqual(new Set(DESTINATION_MODEL_KINDS));
});

test('manual Domo migration reaches branch review, retries one dashboard, and exports reconciliation', async ({ page, request }) => {
  const seeded = await seedVault(request);
  await mockTargetModel(page);

  type CompileInputFixture = {
    expectedWrites?: { explicitNoOp?: boolean; allowedFileNames?: string[] };
    approvedDecisions?: Array<{ id?: string; targetFileName?: string | null; evidenceIds?: string[] }>;
    approvedPlacements?: Array<{ id?: string; targetFileName?: string | null; evidenceIds?: string[] }>;
    baselineDigests?: Array<{ fileName?: string; digest?: string }>;
  };
  const semanticJobs = new Map<string, {
    kind: 'plan' | 'compile';
    compileInput?: CompileInputFixture;
  }>();
  let semanticJobNumber = 0;
  await page.route('**/api/migration-studio/jobs**', async (route) => {
    const requestUrl = new URL(route.request().url());
    if (route.request().method() === 'POST' && requestUrl.pathname.endsWith('/jobs')) {
      const body = route.request().postDataJSON() as { schemaName?: string; prompt?: string };
      const kind = body.schemaName?.includes('compile') ? 'compile' : 'plan';
      let compileInput: CompileInputFixture | undefined;
      if (kind === 'compile') {
        const marker = 'Authoritative structured compile input:\n';
        const markerIndex = body.prompt?.indexOf(marker) ?? -1;
        if (markerIndex >= 0) compileInput = JSON.parse(body.prompt!.slice(markerIndex + marker.length));
      }
      const id = `semantic-${++semanticJobNumber}`;
      semanticJobs.set(id, { kind, compileInput });
      await json(route, { job: { id, status: 'queued' } }, 202);
      return;
    }
    const id = requestUrl.pathname.split('/').pop() || '';
    const semanticJob = semanticJobs.get(id);
    if (!semanticJob) return json(route, { error: 'Unknown browser-test job.' }, 404);
    if (semanticJob.kind === 'plan') {
      await json(route, {
        job: { id, status: 'succeeded' },
        result: {
          rawText: 'One Domo dashboard is ready for governed migration.',
          usage: { input_tokens: 800, output_tokens: 240 },
          output: {
            message: 'One Domo dashboard is ready for governed migration.',
            decisions: [
              ['decision:domo:field:net_sales', 'domo:field:net_sales', 'field', 'Net Sales', 'northstar.net_sales'],
              ['decision:domo:measure:beast_mode:beast_attach_rate:northstar_beast_modes_json', 'domo:beast_mode:beast_attach_rate:northstar_beast_modes_json', 'measure', 'Attach Rate', 'daily_grill_report.attach_rate'],
              ['decision:domo:measure:beast_mode:beast_average_bag_size:northstar_beast_modes_json', 'domo:beast_mode:beast_average_bag_size:northstar_beast_modes_json', 'measure', 'Average Bag Size', 'daily_grill_report.average_bag_size'],
              ['decision:domo:measure:beast_mode:beast_discount_rate:northstar_beast_modes_json', 'domo:beast_mode:beast_discount_rate:northstar_beast_modes_json', 'measure', 'Discount Rate', 'daily_grill_report.discount_rate'],
              ['decision:domo:measure:beast_mode:beast_items_per_bag:northstar_beast_modes_json', 'domo:beast_mode:beast_items_per_bag:northstar_beast_modes_json', 'measure', 'Items per Bag', 'bag_tickets.items_per_bag'],
              ['decision:domo:measure:beast_mode:beast_orders:northstar_beast_modes_json', 'domo:beast_mode:beast_orders:northstar_beast_modes_json', 'measure', 'Orders', 'daily_grill_report.orders'],
              ['decision:domo:measure:beast_mode:beast_total_revenue:northstar_beast_modes_json', 'domo:beast_mode:beast_total_revenue:northstar_beast_modes_json', 'measure', 'Total Revenue', 'daily_grill_report.total_revenue'],
              ['decision:domo:model:dataset_schema:domo_ds_bag_tickets:northstar_dataset_schemas_json', 'domo:dataset_schema:domo_ds_bag_tickets:northstar_dataset_schemas_json', 'model', 'Bag Tickets', 'bag_tickets'],
              ['decision:domo:model:dataset_schema:domo_ds_daily_grill:northstar_dataset_schemas_json', 'domo:dataset_schema:domo_ds_daily_grill:northstar_dataset_schemas_json', 'model', 'Daily Grill Report', 'daily_grill_report'],
            ].map(([id, nodeId, domain, sourceLabel, targetId], index) => ({
              id,
              nodeId,
              domain,
              sourceLabel,
              targetLabel: targetId,
              action: index === 1 ? 'create_new' : 'map_existing',
              targetId: index === 1 ? null : targetId,
              targetFileName: index === 1 ? 'northstar.view' : null,
              proposedCode: index === 1 ? 'measures:\n  attach_rate:\n    sql: ${TABLE}.attach_rate' : null,
              rationale: index === 1 ? 'Create the reviewed source measure in the target model.' : 'Reuse the reviewed equivalent target object.',
              confidence: 0.98,
              blocking: true,
              impactAssetIds: ['domo-card-executive-kpis'],
              validationRequired: true,
            })),
            dashboardPlans: [{
              id: 'plan-executive-kpis',
              sourceDashboardId: 'domo-card-executive-kpis',
              sourceEvidenceIds: ['domo-card-executive-kpis'],
              dependencyIds: [
                'domo-ds-daily-grill',
                'powerbi:field:domo-card-executive-kpis:net_sales',
                'powerbi:field:domo-card-executive-kpis:order_id',
                'powerbi:field:domo-card-executive-kpis:discounts',
                'powerbi:filter:domo-card-executive-kpis:business_date',
              ],
              targetName: 'Executive KPIs',
              targetFolderPath: 'food-service',
              description: 'Executive revenue and order performance.',
              filters: [],
              tiles: [{
                id: 'tile-net-sales',
                title: 'Net Sales',
                description: 'Net sales KPI',
                sourceEvidenceIds: ['domo:card:domo-card-executive-kpis'],
                fields: ['Net Sales'],
                filters: [],
                visualType: 'single_value',
                buildInstructions: 'Create one editable KPI tile for Net Sales.',
                validationAssertions: ['Net Sales is visible.'],
              }],
              unsupportedFeatures: [],
              validationAssertions: ['The KPI matches the reviewed source intent.'],
            }],
          },
        },
      });
      return;
    }
    const compileInput = semanticJob.compileInput;
    const explicitNoOp = compileInput?.expectedWrites?.explicitNoOp === true;
    const allowedFileNames = compileInput?.expectedWrites?.allowedFileNames || [];
    const files = explicitNoOp ? [] : allowedFileNames.map((fileName) => {
      const matchingDecisions = (compileInput?.approvedDecisions || []).filter((decision) => decision.targetFileName === fileName);
      const matchingPlacements = (compileInput?.approvedPlacements || []).filter((placement) => placement.targetFileName === fileName);
      const decisionIds = matchingDecisions.flatMap((decision) => decision.id ? [decision.id] : []);
      const placementIds = matchingPlacements.flatMap((placement) => placement.id ? [placement.id] : []);
      const evidenceIds = Array.from(new Set([
        ...matchingDecisions.flatMap((decision) => decision.evidenceIds || []),
        ...matchingPlacements.flatMap((placement) => placement.evidenceIds || []),
      ]));
      const yaml = fileName === 'relationships'
        ? '- join_from_view: daily_grill_report\n  join_to_view: northstar_locations\n  on_sql: ${daily_grill_report.store_number} = ${northstar_locations.store_number}\n  relationship_type: many_to_one'
        : fileName.endsWith('.topic')
          ? 'label: Browser Test Topic\nbase_view: daily_grill_report'
          : fileName.endsWith('.query.view')
            ? 'sql: SELECT 1 AS browser_test_value'
            : 'dimensions:\n  browser_test_value:\n    sql: ${TABLE}.browser_test_value\nmeasures:\n  browser_test_total:\n    sql: SUM(${TABLE}.browser_test_value)';
      const definitionPaths = fileName.endsWith('.view')
        ? ['$'].concat(fileName.endsWith('.query.view')
          ? []
          : ['dimensions.browser_test_value', 'measures.browser_test_total'])
        : ['$'];
      return {
        fileName,
        yaml,
        decisionIds,
        placementIds,
        evidenceIds,
        definitions: definitionPaths.map((path) => ({ path, decisionIds, placementIds, evidenceIds })),
        baseDigest: compileInput?.baselineDigests?.find((baseline) => baseline.fileName === fileName)?.digest || null,
      };
    });
    await json(route, {
      job: { id, status: 'succeeded' },
      result: {
        rawText: `Generated ${files.length} additive Omni semantic files.`,
        usage: { input_tokens: 500, output_tokens: 120 },
        output: {
          contractVersion: 'compile.v2',
          stage: 'compile',
          status: explicitNoOp ? 'no_op' : 'writes',
          message: explicitNoOp ? 'No semantic writes were approved.' : `Generated ${files.length} additive Omni semantic files.`,
          files,
          warnings: [],
        },
      },
    });
  });

  const branchFiles: Record<string, string> = {};
  const branchChecksums: Record<string, string> = {};
  await page.route('**/api/manage-models', async (route) => json(route, {
    id: 'browser-branch-model-1',
    name: 'migration/domo-browser-test',
    kind: 'BRANCH',
  }));
  await page.route('**/api/omni-proxy', async (route) => {
    const body = route.request().postDataJSON() as {
      method?: string;
      endpoint?: string;
      body?: { fileName?: string; yaml?: string; planOnly?: boolean };
      query_params?: Record<string, string>;
    };
    if (body.endpoint?.endsWith('/yaml') && body.method === 'POST') {
      if (body.body?.fileName && typeof body.body.yaml === 'string') {
        branchFiles[body.body.fileName] = body.body.yaml;
        branchChecksums[body.body.fileName] = `browser-checksum-${body.body.fileName}-${body.body.yaml.length}`;
      }
      return json(route, { success: true });
    }
    if (body.endpoint?.endsWith('/yaml') && body.method === 'GET') {
      const onBranch = Boolean(body.query_params?.branchId);
      return json(route, {
        files: onBranch ? branchFiles : {},
        checksums: onBranch ? branchChecksums : {},
        version: 1,
      });
    }
    if (body.endpoint?.endsWith('/validate')) return json(route, []);
    if (body.endpoint?.endsWith('/content-validator')) return json(route, { issues: [] });
    if (body.endpoint === '/v2/documents/executive-kpis' && body.method === 'GET') {
      return json(route, {
        documentId: 'executive-kpis',
        modelId: 'browser-model-1',
        queryPresentations: {
          'tile-net-sales': { fields: ['daily_grill_report.total_revenue'] },
        },
      });
    }
    if (body.endpoint === '/v1/query/run') {
      return json(route, { status: body.body?.planOnly ? 'PLANNED' : 'COMPLETE' });
    }
    return json(route, {});
  });

  let dashboardBuildNumber = 0;
  const buildJobs = new Map<string, 'failed' | 'succeeded'>();
  await page.route('**/api/manage-ai', async (route) => {
    const body = route.request().postDataJSON() as { action?: string; job_id?: string };
    if (body.action === 'create-job') {
      const id = `dashboard-build-${++dashboardBuildNumber}`;
      buildJobs.set(id, dashboardBuildNumber === 1 ? 'failed' : 'succeeded');
      return json(route, { jobId: id, conversationId: `conversation-${dashboardBuildNumber}` });
    }
    if (body.action === 'get-job') {
      const outcome = buildJobs.get(body.job_id || '');
      return json(route, { jobId: body.job_id, state: outcome === 'failed' ? 'FAILED' : 'SUCCEEDED' });
    }
    if (body.action === 'get-job-result') {
      return json(route, {
        message: 'Executive KPIs was created in the reviewed branch.',
        dashboardUrl: 'https://browser-test.omniapp.co/dashboards/executive-kpis?token=must-be-removed',
        omniChatUrl: 'https://browser-test.omniapp.co/chats/dashboard-build-2',
      });
    }
    return json(route, {});
  });

  await openStudio(page, seeded);
  await page.getByRole('button', { name: 'Use another provider' }).click();
  await page.getByRole('combobox', { name: 'Optional AI provider' }).click();
  await page.getByRole('option').filter({ hasText: 'Browser Test OpenAI' }).click();
  await page.getByRole('button', { name: 'Manual files' }).click();
  await page.getByRole('button', { name: /^Domo/ }).click();
  await continueTo(page, 'Evidence');
  await uploadManualFixture(page, 'domo');
  await page.getByRole('button', { name: 'Review parsed evidence' }).click();
  await acknowledgeDomoEvidenceLimitations(page);
  await page.getByRole('button', { name: 'Confirm upload inventory' }).click();
  await expect(page.getByText('Domo evidence is ready for migration planning')).toBeVisible();
  await page.getByRole('button', { name: 'Release raw source from memory' }).click();
  await expect(page.getByText('Raw source released from page memory')).toBeVisible();
  await expect(page.getByText('Normalized evidence retained; raw source released')).toBeVisible();

  await continueTo(page, 'Destination');
  await selectAndApproveExistingModel(page);
  await continueTo(page, 'Analyze');
  await page.locator('label').filter({ hasText: 'Executive KPIs' }).getByRole('checkbox').check();
  await acknowledgeCoverage(page);
  await page.getByRole('button', { name: 'Plan migration' }).click();
  await expect(page.getByText('Analysis complete. Continue to Place to decide where each dependency belongs.')).toBeVisible();
  await completePlacementReview(page);
  await continueTo(page, 'Resolve');
  await expect(page.getByText('Migration plan', { exact: true })).toBeVisible();
  const approvals = page.getByRole('checkbox', { name: 'Approve' });
  for (let index = 0; index < await approvals.count(); index += 1) await approvals.nth(index).check();
  await page.getByRole('button', { name: 'Generate semantic YAML' }).click();

  await continueTo(page, 'Validate');
  for (const proof of ['Target dialect reviewed', 'Schema checked', 'Row grain checked', 'Representative results compared']) {
    await page.getByRole('checkbox', { name: new RegExp(proof, 'i') }).check();
  }
  await expect(page.getByText('Upstream proof is complete. Omni semantic validation and dashboard construction may continue.')).toBeVisible();
  await expect(page.locator('input[value="northstar.view"]')).toBeVisible();
  await page.getByRole('button', { name: 'Apply to Dev' }).click();
  await expect(page.getByText(/\d+ files changed/)).toBeVisible();
  await page.getByRole('button', { name: 'Validate target queries' }).click();
  await expect(page.getByTestId('migration-validation-query')).toContainText('passed');
  for (const checkId of ['data', 'visual_intent', 'security', 'operational']) {
    const validationRow = page.getByTestId(`migration-validation-${checkId}`);
    await validationRow.getByRole('checkbox', { name: 'Waive' }).click();
    if (checkId === 'data') {
      await validationRow.getByLabel('Waiver owner').fill('Browser Test Migration Owner');
      await validationRow.getByLabel('Reason and accepted risk').fill('Approved sampled-data exception for the bounded Domo browser certification.');
    }
    await expect(validationRow).toContainText('waived');
  }
  await page.getByRole('checkbox', { name: /I reviewed the dev branch diff/ }).check();
  await expect(page.getByRole('link', { name: 'Open semantic branch' })).toBeVisible();

  await continueTo(page, 'Build');
  await page.getByRole('checkbox', { name: /I opened the branch and confirm/ }).check();
  await page.getByRole('button', { name: 'Start dashboard builds' }).click();
  await expect(page.getByText('Omni AI dashboard build failed.')).toBeVisible();
  await page.getByRole('button', { name: 'Retry this dashboard' }).click();
  await expect(page.getByText('Executive KPIs was created in the reviewed branch.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open target dashboard' })).toHaveAttribute('href', 'https://browser-test.omniapp.co/dashboards/executive-kpis');
  await expect(page.getByText(/Final dashboard validation: passed/)).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON' }).first().click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^omnikit-migration-reconciliation-.*\.json$/);
});

test('manual source release is reversed by replacement and does not survive a page restart', async ({ page, request }) => {
  const seeded = await seedVault(request);
  await mockTargetModel(page);
  await openStudio(page, seeded);

  await page.getByRole('button', { name: 'Manual files' }).click();
  await page.getByRole('button', { name: /^Domo/ }).click();
  await continueTo(page, 'Evidence');
  await uploadManualFixture(page, 'domo');
  await page.getByRole('button', { name: 'Review parsed evidence' }).click();
  await acknowledgeDomoEvidenceLimitations(page);
  await page.getByRole('button', { name: 'Confirm upload inventory' }).click();
  await page.getByRole('button', { name: 'Release raw source from memory' }).click();
  await expect(page.getByText('Raw source released from page memory')).toBeVisible();

  await page.getByRole('button', { name: 'Replace source files' }).click();
  await expect(page.getByRole('button', { name: 'Add files or ZIP' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try sample data' })).toHaveCount(0);
  await expect(page.getByText('Raw source released from page memory')).toHaveCount(0);

  await uploadManualFixture(page, 'domo');
  await page.getByRole('button', { name: 'Review parsed evidence' }).click();
  await acknowledgeDomoEvidenceLimitations(page);
  await page.getByRole('button', { name: 'Confirm upload inventory' }).click();
  await page.getByRole('button', { name: 'Release raw source from memory' }).click();
  await expect(page.getByText('Raw source released from page memory')).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { name: 'BI Migration Studio' })).toBeVisible();
  await expect(page.getByText('Raw source released from page memory')).toHaveCount(0);
});

test('empty manual evidence stays blocked for every source without stale state or render-loop warnings', async ({ page, request }) => {
  const consoleFailures: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.text().includes('Maximum update depth exceeded')) {
      consoleFailures.push(message.text());
    }
  });
  page.on('pageerror', (error) => consoleFailures.push(error.message));
  const seeded = await seedVault(request);
  await mockTargetModel(page);
  await openStudio(page, seeded);

  await page.getByRole('button', { name: 'Manual files' }).click();
  for (const [index, source] of SOURCE_PLATFORMS.entries()) {
    await page.getByRole('button', { name: new RegExp(`^${source.label}`) }).first().click();
    await continueTo(page, 'Evidence');
    await expect(page.getByRole('button', { name: 'Continue to Destination' })).toBeDisabled();
    await expect(page.getByLabel('Workflow navigation').getByText(`Add ${source.label} source evidence.`)).toBeVisible();
    if (index < SOURCE_PLATFORMS.length - 1) await page.getByRole('button', { name: 'Back' }).click();
  }
  expect(consoleFailures).toEqual([]);
});

test('API coverage acknowledgement and source-derived choices reset across every supported source', async ({ page, request }) => {
  test.setTimeout(180_000);
  const seeded = await seedVault(request);
  const sourceIds = new Map<string, { platform: string; updatedAt: string }>();
  const apiSourcePlatforms = SOURCE_PLATFORMS.filter((source) => source.id !== 'webfocus');
  for (const source of apiSourcePlatforms) {
    const authentication = source.id === 'domo'
      ? { authMode: 'product_api_token', productApiToken: 'domo-browser-product-token-not-real' }
      : source.id === 'looker'
        ? { authMode: 'api_client_credentials', clientId: 'looker-browser-client-id-not-real', credential: 'looker-browser-client-secret-not-real' }
        : source.id === 'sigma'
          ? { authMode: 'oauth_client_credentials', clientId: 'sigma-browser-client-id-not-real', credential: 'sigma-browser-client-secret-not-real' }
          : source.id === 'metabase'
            ? { authMode: 'api_key', credential: 'metabase-browser-api-key-not-real' }
            : source.id === 'tableau'
              ? { authMode: 'personal_access_token', username: 'tableau-browser-pat-name', credential: 'tableau-browser-pat-secret-not-real', siteId: 'browser-site' }
              : source.id === 'power_bi'
                ? { authMode: 'oauth_client_credentials', accountIdentifier: 'browser-tenant-id', clientId: 'browser-client-id', credential: 'browser-client-secret-not-real', workspaceId: 'browser-workspace-id' }
                : { authMode: 'username_password_session', username: 'strategy-browser-user', credential: 'strategy-browser-password-not-real', projectId: 'strategy-browser-project' };
    const response = await request.post('/api/migration-studio/platform-connections', {
      data: {
        name: `Browser ${source.label} source`,
        platform: source.id,
        baseUrl: `https://${source.id.replace('_', '-')}.example.com`,
        ...authentication,
        enabled: true,
      },
    });
    expect(response.ok()).toBeTruthy();
    const connection = (await response.json()).connection as { id: string; updatedAt: string };
    sourceIds.set(connection.id, { platform: source.id, updatedAt: connection.updatedAt });
  }
  await mockTargetModel(page);
  await page.route('**/api/migration-studio/platform-connections/*/test', async (route) => {
    const connectionId = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2) || '');
    const sourceRecord = sourceIds.get(connectionId);
    if (!sourceRecord) return json(route, { error: 'Unknown source connection.' }, 404);
    return json(route, { ok: true, platform: sourceRecord.platform, itemCount: 2 });
  });
  await page.route('**/api/migration-studio/platform-connections/*/inventory', async (route) => {
    const connectionId = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2) || '');
    const sourceRecord = sourceIds.get(connectionId);
    if (!sourceRecord) return json(route, { error: 'Unknown source connection.' }, 404);
    const source = SOURCE_PLATFORMS.find((candidate) => candidate.id === sourceRecord.platform)!;
    const dashboardId = `${source.id}-dashboard`;
    const modelId = `${source.id}-model`;
    return json(route, {
      inventory: {
        platform: source.id,
        connectionId,
        connectionUpdatedAt: sourceRecord.updatedAt,
        connector: {
          platform: source.id,
          label: source.label,
          authGuidance: 'Browser-test vault credential.',
          capabilities: {
            apiInventory: true,
            semanticDefinitions: 'partial',
            contentDefinitions: 'partial',
            usage: false,
            permissions: false,
            schedules: false,
            queryValidation: false,
            visualEvidence: false,
          },
          migrationCoverage: {
            semantic_objects: 'partial',
            dashboards: 'partial',
            filters: 'partial',
            layout: 'export_required',
            permissions: 'unsupported',
            schedules: 'unsupported',
          },
          limitations: ['Exports are required for full fidelity.'],
        },
        items: [
          { id: dashboardId, name: `${source.label} Executive Dashboard`, kind: 'dashboard', dependencyIds: [modelId], featureFlags: [], riskFlags: [], metadata: {} },
          { id: modelId, name: `${source.label} Semantic Model`, kind: 'semantic_model', dependencyIds: [], featureFlags: [], riskFlags: [], metadata: {} },
        ],
        dashboardCatalog: [{
          id: dashboardId,
          name: `${source.label} Executive Dashboard`,
          kind: 'dashboard',
          dependencyIds: [modelId],
          dependencies: [{ assetId: modelId, name: `${source.label} Semantic Model`, kind: 'semantic_model', category: 'semantic_model', required: true, reason: 'Referenced source model.' }],
          dependencyCounts: { semantic_model: 1 },
          complexity: 'low',
          coverage: 'partial',
          coverageNotes: ['Exports are required for complete content evidence.'],
          riskFlags: [],
        }],
        warnings: ['API evidence is intentionally partial.'],
        truncated: false,
        collection: { scope: 'all_accessible', scopeLabel: `all accessible ${source.label} content`, complete: true, status: 'complete', errors: [], pagesFetched: 1, parentsExpanded: 0, requestsMade: 1, maxPages: 10, maxItems: 1000 },
      },
    });
  });
  await page.route('**/api/migration-studio/platform-connections/*/evidence', async (route) => {
    const connectionId = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2) || '');
    const sourceRecord = sourceIds.get(connectionId);
    if (!sourceRecord || sourceRecord.platform === 'domo') return json(route, { error: 'Unknown generic source connection.' }, 404);
    const body = route.request().postDataJSON() as { selectedRootIds: string[]; connectionUpdatedAt: string };
    const source = SOURCE_PLATFORMS.find((candidate) => candidate.id === sourceRecord.platform)!;
    const selectedRootId = body.selectedRootIds[0]!;
    return json(route, {
      result: neutralPartialPreparedEvidence(
        sourceRecord.platform as MigrationPreparedEvidenceResult['platform'],
        connectionId,
        sourceRecord.updatedAt,
        selectedRootId,
        `${source.label} Executive Dashboard`,
      ),
    });
  });
  await page.route('**/api/migration-studio/platform-connections/*/domo-evidence', async (route) => {
    const connectionId = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2) || '');
    const sourceRecord = sourceIds.get(connectionId);
    if (!sourceRecord || sourceRecord.platform !== 'domo') return json(route, { error: 'Unknown Domo source connection.' }, 404);
    return json(route, { result: neutralDomoProductEvidence('b'.repeat(64), sourceRecord.updatedAt) });
  });

  await openStudio(page, seeded);
  let previousDashboardName = '';
  for (const [index, source] of apiSourcePlatforms.entries()) {
    if (index > 0) {
      await page.getByRole('button', { name: /Source.*Complete/i }).click();
      if (previousDashboardName) await expect(page.getByText(previousDashboardName, { exact: true })).toHaveCount(0);
    }
    await page.getByRole('combobox', { name: 'Saved source API connection' }).click();
    await page.getByRole('option').filter({ hasText: `Browser ${source.label} source` }).click();
    await page.getByRole('button', { name: 'Load inventory' }).click();
    await continueTo(page, 'Evidence');
    const dashboardName = `${source.label} Executive Dashboard`;
    await page.locator('label').filter({ hasText: dashboardName }).getByRole('checkbox').check();
    if (source.id === 'domo') {
      await expect(page.getByTestId('domo-product-limitations-acknowledgement')).toBeVisible();
      await page.getByTestId('domo-product-limitations-acknowledgement').check();
    } else {
      await expect(page.getByTestId('prepared-source-evidence-acknowledgement')).toBeVisible();
      await page.getByTestId('prepared-source-evidence-acknowledgement').check();
    }
    await continueTo(page, 'Destination');
    if (index === 0) await selectAndApproveExistingModel(page);
    await continueTo(page, 'Analyze');

    await expect(page.getByText('Source coverage and collection scope')).toBeVisible();
    await expect(page.getByText('Evidence Integrity', { exact: true })).toBeVisible();
    await expect(page.getByText(/A source-backed readiness measure, not an AI confidence score/)).toBeVisible();
    const acknowledgement = page.getByRole('checkbox', { name: /I reviewed the partial and unsupported classes/ });
    await expect(acknowledgement).not.toBeChecked();
    await page.locator('label').filter({ hasText: dashboardName }).getByRole('checkbox').check();
    const adminGoal = page.locator('label').filter({ hasText: 'Admin goal' }).locator('..').getByRole('textbox');
    if (index === 0) await adminGoal.fill('This source-specific goal must not survive a source change.');
    else await expect(adminGoal).toHaveValue('');
    await acknowledgement.check();
    previousDashboardName = dashboardName;
  }
});

test('API inventory keeps partial coverage visible until the operator acknowledges it', async ({ page, request }) => {
  const seeded = await seedVault(request, { withDomoSource: true });
  expect(seeded.sourceConnectionUpdatedAt).toBeTruthy();
  await mockTargetModel(page);
  await page.route('**/api/migration-studio/platform-connections/*/test', (route) => json(route, { ok: true, platform: 'domo', itemCount: 2 }));
  await page.route('**/api/migration-studio/platform-connections/*/inventory', (route) => json(route, {
    inventory: {
      platform: 'domo',
      connectionId: seeded.sourceConnectionId,
      connectionUpdatedAt: seeded.sourceConnectionUpdatedAt,
      connector: {
        platform: 'domo',
        label: 'Domo',
        authGuidance: 'Vault-backed bearer token.',
        capabilities: { apiInventory: true, semanticDefinitions: 'partial', contentDefinitions: 'partial', usage: true, permissions: false, schedules: false, queryValidation: false, queryValidationMode: 'manual_source_evidence', visualEvidence: false },
        migrationCoverage: { semantic_objects: 'partial', dashboards: 'partial', filters: 'partial', layout: 'export_required', permissions: 'unsupported', schedules: 'unsupported' },
        limitations: ['Card and DataFlow exports are required for full fidelity.'],
      },
      items: [
        { id: 'api-dashboard', name: 'Executive API Dashboard', kind: 'dashboard', dependencyIds: ['api-model'], featureFlags: [], riskFlags: [], metadata: {} },
        { id: 'api-model', name: 'Sales Dataset', kind: 'semantic_model', dependencyIds: [], featureFlags: [], riskFlags: [], metadata: {} },
      ],
      dashboardCatalog: [{
        id: 'api-dashboard', name: 'Executive API Dashboard', kind: 'dashboard', dependencyIds: ['api-model'],
        dependencies: [{ assetId: 'api-model', name: 'Sales Dataset', kind: 'semantic_model', category: 'semantic_model', required: true, reason: 'Referenced dataset.' }],
        dependencyCounts: { semantic_model: 1 }, complexity: 'low', coverage: 'partial', coverageNotes: ['Export required for Card JSON.'], riskFlags: [],
      }],
      warnings: ['API metadata is intentionally partial.'],
      truncated: false,
      collection: { scope: 'all_accessible', scopeLabel: 'all accessible Domo content', complete: true, status: 'complete', errors: [], pagesFetched: 1, parentsExpanded: 0, requestsMade: 1, maxPages: 10, maxItems: 1000 },
    },
  }));
  await page.route('**/api/migration-studio/platform-connections/*/domo-evidence', (route) => json(route, {
    result: neutralDomoProductEvidence('f'.repeat(64), seeded.sourceConnectionUpdatedAt!),
  }));

  await openStudio(page, seeded);
  await page.getByRole('button', { name: 'Saved API' }).click();
  expect(seeded.sourceConnectionId).toBeTruthy();
  await page.getByRole('button', { name: 'Refresh' }).click();
  await page.getByRole('combobox', { name: 'Saved source API connection' }).click();
  await page.getByRole('option').filter({ hasText: 'Browser Test Domo' }).click();
  await page.getByRole('button', { name: 'Load inventory' }).click();
  await continueTo(page, 'Evidence');
  await page.locator('label').filter({ hasText: 'Executive API Dashboard' }).getByRole('checkbox').check();
  await expect(page.getByTestId('domo-product-limitations-acknowledgement')).toBeVisible();
  await page.getByTestId('domo-product-limitations-acknowledgement').check();
  await continueTo(page, 'Destination');
  await selectAndApproveExistingModel(page);
  await continueTo(page, 'Analyze');
  await expect(page.getByText('Source coverage and collection scope')).toBeVisible();
  const acknowledgement = page.getByRole('checkbox', { name: /I reviewed the partial and unsupported classes/ });
  await expect(acknowledgement).not.toBeChecked();
  await acknowledgement.check();
  await expect(page.getByRole('checkbox', { name: /Executive API Dashboard dashboard/ })).toBeVisible();
});

test('Saved API definition preparation is explicit, revision-bound, scope-bound, and Preview-only', async ({ page, request }) => {
  const seeded = await seedVault(request);
  const sourceResponse = await request.post('/api/migration-studio/platform-connections', {
    data: {
      name: 'Example Power BI source',
      platform: 'power_bi',
      baseUrl: 'https://api.fabric.microsoft.com',
      authMode: 'oauth_client_credentials',
      accountIdentifier: 'example-tenant-id',
      clientId: 'example-client-id',
      credential: 'example-client-secret-not-real',
      workspaceId: 'example-workspace-id',
      enabled: true,
    },
  });
  expect(sourceResponse.ok()).toBeTruthy();
  const sourceConnection = (await sourceResponse.json()).connection as { id: string; updatedAt: string };
  await mockTargetModel(page);

  const evidenceRequests: Array<{ selectedRootIds: string[]; connectionUpdatedAt: string }> = [];
  let manageModelsWrites = 0;
  await page.route('**/api/migration-studio/platform-connections/*/test', (route) => {
    const connectionId = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2) || '');
    if (connectionId !== sourceConnection.id) return json(route, { error: 'Unknown saved source.' }, 404);
    const inventory = neutralPowerBiDefinitionInventory(connectionId, sourceConnection.updatedAt);
    return json(route, { ok: true, platform: 'power_bi', itemCount: inventory.items.length, inventory });
  });
  await page.route('**/api/migration-studio/platform-connections/*/evidence', (route) => {
    expect(route.request().method()).toBe('POST');
    const connectionId = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2) || '');
    expect(connectionId).toBe(sourceConnection.id);
    const body = route.request().postDataJSON() as { selectedRootIds: string[]; connectionUpdatedAt: string };
    evidenceRequests.push(body);
    const selectedRootId = body.selectedRootIds[0]!;
    const scopeFingerprint = selectedRootId === POWER_BI_MODEL_ROOT_A
      ? POWER_BI_SCOPE_FINGERPRINT_A
      : POWER_BI_SCOPE_FINGERPRINT_B;
    return json(route, {
      result: neutralPowerBiPreparedEvidence(
        sourceConnection.id,
        sourceConnection.updatedAt,
        selectedRootId,
        scopeFingerprint,
      ),
    });
  });
  await page.route('**/api/manage-models', (route) => {
    manageModelsWrites += 1;
    return json(route, { error: 'A Preview-only source must not create a branch.' }, 500);
  });

  await openStudio(page, seeded);
  await page.getByRole('combobox', { name: 'Saved source API connection' }).click();
  await page.getByRole('option').filter({ hasText: 'Example Power BI source' }).click();
  await page.getByRole('button', { name: 'Load inventory' }).click();
  await expect(page.getByText('Loaded 2 Power BI source items from Synthetic Fabric workspace.')).toBeVisible();
  await page.waitForTimeout(350);
  expect(evidenceRequests).toEqual([]);

  await continueTo(page, 'Evidence');
  await expect(page.getByText('No source definitions selected. Evidence preparation is paused.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue to Destination' })).toBeDisabled();
  expect(evidenceRequests).toEqual([]);

  const modelA = page.locator('label').filter({ hasText: 'Example semantic model A' }).getByRole('checkbox');
  await modelA.check();
  await expect(page.getByText('Scope cccccccccccc', { exact: true })).toBeVisible();
  expect(evidenceRequests).toEqual([{
    selectedRootIds: [POWER_BI_MODEL_ROOT_A],
    connectionUpdatedAt: sourceConnection.updatedAt,
  }]);

  const limitationAcknowledgement = page.getByTestId('prepared-source-evidence-acknowledgement');
  await expect(limitationAcknowledgement).toBeVisible();
  await expect(limitationAcknowledgement).not.toBeChecked();
  await limitationAcknowledgement.check();
  await expect(page.getByText('Preview with manual handoffs', { exact: true })).toBeVisible();
  await expect(page.getByText(/acknowledgement permits Preview planning only\. Apply to Dev and release remain blocked/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue to Destination' })).toBeEnabled();

  await continueTo(page, 'Destination');
  await selectAndApproveExistingModel(page);
  await continueTo(page, 'Analyze');
  await acknowledgeCoverage(page);
  await expect(page.getByRole('button', { name: 'Plan migration' })).toBeEnabled();
  await expect(page.getByRole('button', { name: /Validate.*Not ready/i })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Apply to Dev' })).toHaveCount(0);
  expect(manageModelsWrites).toBe(0);

  await page.getByRole('button', { name: /Evidence.*Complete/i }).click();
  await modelA.uncheck();
  await expect(page.getByTestId('prepared-source-evidence')).toHaveCount(0);
  const modelB = page.locator('label').filter({ hasText: 'Example semantic model B' }).getByRole('checkbox');
  await modelB.check();
  await expect(page.getByText('Scope dddddddddddd', { exact: true })).toBeVisible();
  const replacementAcknowledgement = page.getByTestId('prepared-source-evidence-acknowledgement');
  await expect(replacementAcknowledgement).toBeVisible();
  await expect(replacementAcknowledgement).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Continue to Destination' })).toBeDisabled();
  expect(evidenceRequests).toEqual([
    { selectedRootIds: [POWER_BI_MODEL_ROOT_A], connectionUpdatedAt: sourceConnection.updatedAt },
    { selectedRootIds: [POWER_BI_MODEL_ROOT_B], connectionUpdatedAt: sourceConnection.updatedAt },
  ]);
  expect(manageModelsWrites).toBe(0);
});

test('unsupported saved API records remain visible but cannot load and direct operators to Manual Files', async ({ page, request }) => {
  const seeded = await seedVault(request);
  const unsupportedConnection = {
    id: 'legacy-webfocus-source',
    name: 'Legacy WebFOCUS source',
    platform: 'webfocus',
    baseUrl: 'https://webfocus.example.com',
    authMode: 'username_password_session',
    username: 'example-user',
    enabled: true,
    hasCredential: true,
    credentialMasked: '••••',
    createdAt: '2026-08-12T12:00:00.000Z',
    updatedAt: '2026-08-12T12:00:00.000Z',
  };
  let inventoryRequests = 0;
  await page.route('**/api/migration-studio/platform-connections', (route) => {
    if (route.request().method() === 'GET') return json(route, { connections: [unsupportedConnection] });
    return route.fallback();
  });
  await page.route('**/api/migration-studio/platform-connections/*/test', (route) => {
    inventoryRequests += 1;
    return json(route, { error: 'Unsupported connection should not be tested.' }, 500);
  });

  await openStudio(page, seeded);
  await page.getByRole('combobox', { name: 'Saved source API connection' }).click();
  await page.getByRole('option').filter({ hasText: 'Legacy WebFOCUS source' }).click();
  await expect(page.getByText('Legacy Saved API · replacement or Manual Files required', { exact: false })).toBeVisible();
  await expect(page.getByText('Saved API is unavailable for WebFOCUS. Use Manual Files.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load inventory' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Continue to Evidence' })).toBeDisabled();
  expect(inventoryRequests).toBe(0);
});

test('Domo Product API-only limitation disposition is bound to the prepared scope fingerprint', async ({ page, request }) => {
  const seeded = await seedVault(request);
  const sourceResponse = await request.post('/api/migration-studio/platform-connections', {
    data: {
      name: 'Domo Product API Source',
      platform: 'domo',
      baseUrl: 'https://domo-source.example.com',
      authMode: 'product_api_token',
      credential: '',
      productApiToken: 'domo-product-browser-token-not-real',
      enabled: true,
    },
  });
  expect(sourceResponse.ok()).toBeTruthy();
  const sourceConnection = (await sourceResponse.json()).connection as { id: string; updatedAt: string };
  const targetModel: DestinationModelFixture = {
    id: 'target-model',
    name: 'Target Model',
    identifier: 'target_model',
    connectionId: 'target-connection',
    connectionName: 'Target Warehouse',
    kind: 'SHARED',
  };
  await mockTargetModel(page, {
    modelsByKind: { SHARED: [targetModel], SHARED_EXTENSION: [] },
  });
  let currentScopeFingerprint = DOMO_PRODUCT_SCOPE_FINGERPRINT_A;
  let legacyInventoryRequests = 0;
  const returnedFingerprints: string[] = [];
  const returnedLimitationCodes: string[][] = [];
  await page.route('**/api/migration-studio/platform-connections/*/test', (route) => {
    const connectionId = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2) || '');
    if (connectionId !== sourceConnection.id) return json(route, { error: 'Unknown saved source.' }, 404);
    const inventory = neutralDomoProductInventory(connectionId, sourceConnection.updatedAt);
    return json(route, { ok: true, platform: 'domo', itemCount: inventory.items.length, inventory });
  });
  await page.route('**/api/migration-studio/platform-connections/*/inventory', (route) => {
    legacyInventoryRequests += 1;
    return json(route, { inventory: neutralDomoProductInventory(sourceConnection.id, sourceConnection.updatedAt) });
  });
  await page.route('**/api/migration-studio/platform-connections/*/domo-evidence', (route) => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().postDataJSON()).toEqual({ selectedDashboardIds: [DOMO_PRODUCT_PAGE_ID], connectionUpdatedAt: sourceConnection.updatedAt });
    const result = neutralDomoProductEvidence(currentScopeFingerprint, sourceConnection.updatedAt);
    returnedFingerprints.push(result.scopeFingerprint);
    returnedLimitationCodes.push(result.diagnostics.limitations.map((limitation) => limitation.code));
    return json(route, { result });
  });

  await openStudio(page, seeded);
  await page.getByRole('combobox', { name: 'Saved source API connection' }).click();
  await page.getByRole('option').filter({ hasText: 'Domo Product API Source' }).click();
  await page.getByRole('button', { name: 'Load inventory' }).click();
  await continueTo(page, 'Evidence');
  await page.locator('label').filter({ hasText: 'Source Page' }).getByRole('checkbox').first().check();

  await expect(page.getByText('Domo API evidence needs an explicit scope-bound disposition')).toBeVisible();
  for (const limitation of DOMO_PRODUCT_LIMITATIONS) {
    await expect(page.getByText(limitation.message, { exact: true })).toBeVisible();
  }
  await expect(page.getByText('Scope aaaaaaaaaaaa', { exact: true })).toBeVisible();
  const limitationAcknowledgement = page.getByTestId('domo-product-limitations-acknowledgement');
  await expect(limitationAcknowledgement).toBeVisible();
  await expect(limitationAcknowledgement).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Continue to Destination' })).toBeDisabled();
  await limitationAcknowledgement.check();
  await expect(page.getByText('Ready with manual handoffs', { exact: true })).toBeVisible();
  await expect(page.getByText(/The listed source-definition gaps remain unproven/)).toBeVisible();
  await expect(page.getByText(/This acknowledgement enables Preview planning and review only; Apply to Dev and release remain blocked/)).toBeVisible();
  await continueTo(page, 'Destination');
  await page.getByRole('button').filter({ hasText: 'Target Model' }).click();
  const destinationApproval = page.getByRole('checkbox', {
    name: 'I confirm this shared model and connection are the approved destination.',
  });
  await destinationApproval.check();
  await continueTo(page, 'Analyze');
  const coverageAcknowledgement = page.getByRole('checkbox', { name: /I reviewed the partial and unsupported classes/ });
  await coverageAcknowledgement.check();
  await expect(page.getByRole('button', { name: 'Plan migration' })).toBeEnabled();

  currentScopeFingerprint = DOMO_PRODUCT_SCOPE_FINGERPRINT_B;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByText('Scope bbbbbbbbbbbb', { exact: true })).toBeVisible();
  await expect(limitationAcknowledgement).toBeVisible();
  await expect(limitationAcknowledgement).not.toBeChecked();
  await expect(page.getByText('Acknowledgement required', { exact: true })).toBeVisible();
  await expect(page.getByText(/This acknowledgement enables Preview planning and review only; Apply to Dev and release remain blocked/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Plan migration' })).toBeDisabled();

  expect(returnedFingerprints).toEqual([
    DOMO_PRODUCT_SCOPE_FINGERPRINT_A,
    DOMO_PRODUCT_SCOPE_FINGERPRINT_B,
  ]);
  expect(returnedLimitationCodes).toEqual([
    DOMO_PRODUCT_LIMITATIONS.map((limitation) => limitation.code),
    DOMO_PRODUCT_LIMITATIONS.map((limitation) => limitation.code),
  ]);
  expect(legacyInventoryRequests).toBe(0);
});

test('Looker native parsing remains usable when the deterministic engine is unavailable', async ({ page, request }) => {
  const seeded = await seedVault(request);
  await mockTargetModel(page);
  let extractionRequests = 0;
  await page.unroute('**/api/migration-studio/engine/capabilities');
  await page.route('**/api/migration-studio/engine/capabilities', (route) => json(route, { error: 'engine unavailable in browser test' }, 503));
  await page.route('**/api/migration-studio/engine/extract', (route) => {
    extractionRequests += 1;
    return json(route, { error: 'engine unavailable in browser test' }, 503);
  });

  await openStudio(page, seeded);
  await page.getByRole('button', { name: 'Manual files' }).click();
  await page.getByRole('button', { name: /^Looker/ }).click();
  await continueTo(page, 'Evidence');
  await expect(page.getByRole('button', { name: 'Try sample data' })).toHaveCount(0);
  await uploadManualFixture(page, 'looker');
  await expect(page.getByText('Parsed migration inventory')).toBeVisible();
  expect(extractionRequests).toBe(0);
  await page.getByRole('button', { name: 'Review parsed evidence' }).click();
  await page.getByRole('button', { name: 'Confirm LookML inventory' }).click();
  await expect(page.getByText('Native parser complete')).toBeVisible();
  await expect(page.getByText('Evidence ready', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue to Destination' })).toBeEnabled();
  const readiness = page.getByTestId('looker-professional-v2-readiness');
  await expect(readiness).toBeVisible();
  await expect(readiness).toContainText('Native fallback active');
  await expect(readiness).toContainText('Preview');
  await expect(readiness).toContainText('Manual raw-source evidence and compiled API evidence');
  await expect(readiness).toContainText(/permissions and schedules/i);
  expect(extractionRequests).toBe(0);

  await continueTo(page, 'Destination');
  await selectAndApproveExistingModel(page);
  await continueTo(page, 'Analyze');
  await expect(page.getByText('Source coverage and collection scope')).toBeVisible();
  await expect(page.locator('#main-content').getByText('Permissions', { exact: true })).toBeVisible();
  await expect(page.locator('#main-content').getByText('Schedules', { exact: true })).toBeVisible();
  const coverageAcknowledgement = page.getByRole('checkbox', { name: /I reviewed the partial and unsupported classes/ });
  await expect(coverageAcknowledgement).toBeVisible();
  await expect(coverageAcknowledgement).not.toBeChecked();
  await page.locator('label').filter({ hasText: 'NorthstarDashboard' }).getByRole('checkbox').check();
  await coverageAcknowledgement.check();
  await expect(page.getByText('Official documentation traceability is missing for canonical kinds')).toHaveCount(0);
  await expect(page.getByText('Source acquisition completeness has not been proven.').last()).toBeVisible();
  await expect(page.getByText('Source dependency closure is incomplete.').last()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Plan migration' })).toBeDisabled();
  expect(extractionRequests).toBe(0);
});

test('Looker shadow extraction attests the exact native upload before Analyze can proceed', async ({ page, request }) => {
  const seeded = await seedVault(request);
  await mockTargetModel(page);
  await page.unroute('**/api/migration-studio/engine/capabilities');
  await page.route('**/api/migration-studio/engine/capabilities', (route) => json(route, {
    available: true,
    capabilities: ENGINE_LOOKER_SHADOW_CAPABILITIES,
  }));
  await page.route('**/api/migration-studio/engine/extract', (route) => {
    const body = route.request().postDataJSON() as { artifacts?: Array<{ name: string; content?: string }> };
    return json(route, { result: lookerShadowEngineResult(body.artifacts || []) });
  });

  await openStudio(page, seeded);
  await page.getByRole('button', { name: 'Manual files' }).click();
  await page.getByRole('button', { name: /^Looker/ }).click();
  await continueTo(page, 'Evidence');
  await uploadManualFixture(page, 'looker');
  await expect(page.getByText('Parsed migration inventory')).toBeVisible();
  await expect(page.getByText(/6 views.*12 measures.*1 Explore.*5 joins.*1 dashboard/)).toBeVisible();
  const readiness = page.getByTestId('looker-professional-v2-readiness');
  await expect(readiness).toContainText('Shadow evaluation', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Review parsed evidence' }).click();
  await page.getByRole('button', { name: 'Confirm LookML inventory' }).click();
  await continueTo(page, 'Destination');
  await selectAndApproveExistingModel(page);
  await continueTo(page, 'Analyze');
  await page.locator('label').filter({ hasText: 'NorthstarDashboard' }).getByRole('checkbox').check();
  await acknowledgeCoverage(page);
  await expect(page.getByText('Official documentation traceability is missing for canonical kinds')).toHaveCount(0);
  await expect(page.getByText('Source acquisition completeness has not been proven.')).toHaveCount(0);
  await expect(page.getByText('Source dependency closure is incomplete.')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Plan migration' })).toBeEnabled();
});

test('WebFOCUS evidence remains additive and requires a procedure before destination routing', async ({ page, request }) => {
  const seeded = await seedVault(request);
  await mockTargetModel(page);
  await openStudio(page, seeded);

  await page.getByRole('button', { name: 'Manual files' }).click();
  await page.getByRole('button', { name: /^WebFOCUS/ }).click();
  await continueTo(page, 'Evidence');
  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.setInputFiles({
    name: 'NORTHSTAR_SALES.mas',
    mimeType: 'text/plain',
    buffer: Buffer.from('FILENAME=NORTHSTAR_SALES, SUFFIX=FOC\\nFIELDNAME=ORDER_ID, ALIAS=ORDER_ID, USAGE=I11$'),
  });
  await expect(page.getByText('Procedure or dashboard required')).toBeVisible();
  await expect(page.getByText('Master/access metadata found')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue to Destination' })).toBeDisabled();

  await fileInput.setInputFiles({
    name: 'NORTHSTAR_DASHBOARD.fex',
    mimeType: 'text/plain',
    buffer: Buffer.from('TABLE FILE NORTHSTAR_SALES\\nSUM REVENUE\\nBY REGION\\nWHERE STATUS EQ ACTIVE\\nEND'),
  });
  await expect(page.getByText('Procedure or dashboard found')).toBeVisible();
  await expect(page.getByText('1 .fex file')).toBeVisible();
  await expect(page.getByText('1 .mas or .acx file')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue to Destination' })).toBeEnabled();
});

test('malformed Power BI planning is rejected, repaired once, and only then unlocks Resolve', async ({ page, request }) => {
  const seeded = await seedVault(request);
  await mockTargetModel(page);
  const requestedStages: string[] = [];
  const jobs = new Map<string, 'invalid' | 'valid'>();
  let jobNumber = 0;
  await page.route('**/api/migration-studio/jobs**', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'POST' && url.pathname.endsWith('/jobs')) {
      const body = route.request().postDataJSON() as { stage?: string };
      requestedStages.push(body.stage || '');
      const id = `power-bi-plan-${++jobNumber}`;
      jobs.set(id, body.stage === 'repair' ? 'valid' : 'invalid');
      return json(route, { job: { id, status: 'queued', stage: body.stage, createdAt: new Date().toISOString() } }, 202);
    }
    const id = url.pathname.split('/').pop() || '';
    const kind = jobs.get(id);
    if (!kind) return json(route, { error: 'Unknown Power BI planning job.' }, 404);
    return json(route, {
      job: { id, status: 'succeeded', stage: kind === 'valid' ? 'repair' : 'analyze', completedAt: new Date().toISOString() },
      result: {
        rawText: kind === 'valid' ? 'The repaired plan passed.' : 'The first response omitted its dashboard plan.',
        output: kind === 'valid'
          ? validPowerBiPlanOutput()
          : { message: 'The response is intentionally malformed.', decisions: [], dashboardPlans: [] },
      },
    });
  });
  await page.route('**/api/omni-proxy', (route) => json(route, { files: {}, checksums: {}, version: 1 }));

  await openStudio(page, seeded);
  await page.getByRole('button', { name: 'Use another provider' }).click();
  await page.getByRole('combobox', { name: 'Optional AI provider' }).click();
  await page.getByRole('option').filter({ hasText: 'Browser Test OpenAI' }).click();
  await page.getByRole('button', { name: 'Manual files' }).click();
  await page.getByRole('button', { name: /^Power BI/ }).click();
  await continueTo(page, 'Evidence');
  await uploadManualFixture(page, 'power_bi');
  await page.getByRole('button', { name: 'Review parsed evidence' }).click();
  await page.getByRole('button', { name: 'Confirm Power BI inventory' }).click();
  await continueTo(page, 'Destination');
  await selectAndApproveExistingModel(page);
  await continueTo(page, 'Analyze');
  const powerBiDashboard = page.getByRole('checkbox', { name: /NorthstarDashboard NorthstarDashboard/ });
  if (!await powerBiDashboard.isChecked()) await powerBiDashboard.check();
  await page.getByRole('checkbox', { name: 'NorthstarDashboard', exact: true }).check();
  await acknowledgeCoverage(page);

  await page.getByRole('button', { name: 'Plan migration' }).click();
  await expect(page.getByText('Migration plan needs repair')).toBeVisible();
  await expect(page.getByText('No migration changes were accepted or applied.')).toBeVisible();
  await expect(page.getByRole('button', { name: /Resolve.*Not ready/i })).toBeDisabled();
  await page.getByRole('button', { name: 'Repair plan response' }).click();
  await expect(page.getByText('Analysis complete. Continue to Place to decide where each dependency belongs.')).toBeVisible();
  await expect(page.getByRole('button', { name: /Place.*(?:Ready|Complete)/i })).toBeEnabled();
  await completePlacementReview(page);
  await expect(page.getByRole('button', { name: /Resolve.*Ready/i })).toBeEnabled();
  expect(requestedStages).toEqual(['analyze', 'repair']);
});

test('a running planning job shows truthful progress and duplicate-safe continuation guidance', async ({ page, request }) => {
  const seeded = await seedVault(request);
  await mockTargetModel(page);
  let postCount = 0;
  await page.route('**/api/migration-studio/jobs**', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'POST' && url.pathname.endsWith('/jobs')) {
      postCount += 1;
      return json(route, { job: { id: 'long-running-plan', status: 'queued', stage: 'analyze', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } }, 202);
    }
    return json(route, { job: { id: 'long-running-plan', status: 'running', stage: 'analyze', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } });
  });
  await page.route('**/api/omni-proxy', (route) => json(route, { files: {}, checksums: {}, version: 1 }));

  await openStudio(page, seeded);
  await page.getByRole('button', { name: 'Use another provider' }).click();
  await page.getByRole('combobox', { name: 'Optional AI provider' }).click();
  await page.getByRole('option').filter({ hasText: 'Browser Test OpenAI' }).click();
  await page.getByRole('button', { name: 'Manual files' }).click();
  await page.getByRole('button', { name: /^Domo/ }).click();
  await continueTo(page, 'Evidence');
  await uploadManualFixture(page, 'domo');
  await page.getByRole('button', { name: 'Review parsed evidence' }).click();
  await acknowledgeDomoEvidenceLimitations(page);
  await page.getByRole('button', { name: 'Confirm upload inventory' }).click();
  await continueTo(page, 'Destination');
  await selectAndApproveExistingModel(page);
  await continueTo(page, 'Analyze');
  await page.locator('label').filter({ hasText: 'Executive KPIs' }).getByRole('checkbox').check();
  await acknowledgeCoverage(page);
  await page.getByRole('button', { name: 'Plan migration' }).click();

  await expect(page.getByText('Building the migration plan')).toBeVisible();
  await expect(page.getByText('Continue monitoring resumes this job and does not submit a duplicate.')).toBeVisible();
  await expect(page.getByText('Selected migration scope · Executive KPIs')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Monitoring AI job' })).toBeDisabled();
  expect(postCount).toBe(1);
});

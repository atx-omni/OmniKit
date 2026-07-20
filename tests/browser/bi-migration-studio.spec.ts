import { expect, test, type APIRequestContext, type Page, type Route } from '@playwright/test';
import { resolve } from 'node:path';

const PASSPHRASE = 'browser migration test passphrase';

type SeededVault = {
  connection: Record<string, unknown>;
  instanceId: string;
  providerId: string;
  sourceConnectionId?: string;
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
  if (options.withDomoSource) {
    const sourceResponse = await request.post('/api/migration-studio/platform-connections', {
      data: {
        name: 'Browser Test Domo',
        platform: 'domo',
        baseUrl: 'https://api.domo.com',
        credential: 'domo-browser-test-not-real',
        enabled: true,
      },
    });
    expect(sourceResponse.ok()).toBeTruthy();
    const source = (await sourceResponse.json()).connection as { id: string };
    sourceConnectionId = source.id;

    const sourceLibraryResponse = await request.get('/api/migration-studio/platform-connections');
    expect(sourceLibraryResponse.ok()).toBeTruthy();
    const sourceLibrary = (await sourceLibraryResponse.json()).connections as Array<{ id: string }>;
    expect(sourceLibrary.some((connection) => connection.id === sourceConnectionId)).toBeTruthy();
  }

  return { connection, instanceId: instance.id, providerId: provider.id, sourceConnectionId };
}

async function openStudio(page: Page, seeded: SeededVault) {
  await page.addInitScript((connection) => {
    window.sessionStorage.setItem('omnikit:activeConnection:v1', JSON.stringify(connection));
  }, seeded.connection);
  await page.goto('/semantic-migrations');
  await expect(page.getByRole('heading', { name: 'BI Migration Studio' })).toBeVisible();
  const walkthrough = page.getByRole('dialog', { name: /walkthrough|guided tour|see what changed/i });
  if (await walkthrough.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Close walkthrough' }).click();
  }
}

async function continueTo(page: Page, step: 'Evidence' | 'Destination' | 'Analyze' | 'Resolve' | 'Validate' | 'Build') {
  const button = page.getByRole('button', { name: `Continue to ${step}` });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.getByRole('button', { name: new RegExp(`${step}.*Current step`, 'i') })).toHaveAttribute('aria-current', 'step');
}

async function mockTargetModel(page: Page) {
  await page.route('**/api/list-models', (route) => json(route, {
    models: [{
      id: 'browser-model-1',
      name: 'Browser Test Food Service',
      identifier: 'browser_food_service',
      connectionId: 'browser-connection-1',
      connectionName: 'Browser Warehouse',
      kind: 'SHARED',
    }],
  }));
}

async function acknowledgeCoverage(page: Page) {
  const acknowledgement = page.getByRole('checkbox', { name: /I reviewed the partial and unsupported classes/ });
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

test('AI provider setup remains interactive across provider and authentication changes', async ({ page, request }) => {
  const seeded = await seedVault(request);
  await openStudio(page, seeded);

  await expect(page.getByText('Omni AI is included through the active instance. Another provider is optional.')).toBeVisible();
  await expect(page.getByText('Default', { exact: true })).toBeVisible();
  const providerLibraryResponse = await request.get('/api/migration-studio/providers');
  expect(providerLibraryResponse.ok()).toBeTruthy();
  const providerLibrary = (await providerLibraryResponse.json()).providers as Array<{ id: string; kind: string; linkedInstanceId?: string; hasCredential?: boolean }>;
  expect(providerLibrary.some((provider) => provider.id === `omni-ai-default-${seeded.instanceId}` && provider.kind === 'omni_ai' && provider.linkedInstanceId === seeded.instanceId && provider.hasCredential === false)).toBeTruthy();

  await page.getByRole('button', { name: 'Use another provider' }).click();
  await page.getByRole('combobox', { name: 'Optional AI provider' }).click();
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
  await expect(keyPair).toHaveCount(1);
  await keyPair.click();
  await expect(page.getByText('The private key and its passphrase must remain in your approved key-management system.')).toBeVisible();

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

test('manual Domo migration reaches branch review, retries one dashboard, and exports reconciliation', async ({ page, request }) => {
  const seeded = await seedVault(request);
  await mockTargetModel(page);

  const semanticJobs = new Map<string, 'plan' | 'package'>();
  let semanticJobNumber = 0;
  await page.route('**/api/migration-studio/jobs**', async (route) => {
    const requestUrl = new URL(route.request().url());
    if (route.request().method() === 'POST' && requestUrl.pathname.endsWith('/jobs')) {
      const body = route.request().postDataJSON() as { schemaName?: string };
      const kind = body.schemaName?.includes('package') ? 'package' : 'plan';
      const id = `semantic-${++semanticJobNumber}`;
      semanticJobs.set(id, kind);
      await json(route, { job: { id, status: 'queued' } }, 202);
      return;
    }
    const id = requestUrl.pathname.split('/').pop() || '';
    const kind = semanticJobs.get(id);
    if (!kind) return json(route, { error: 'Unknown browser-test job.' }, 404);
    if (kind === 'plan') {
      await json(route, {
        job: { id, status: 'succeeded' },
        result: {
          rawText: 'One Domo dashboard is ready for governed migration.',
          usage: { input_tokens: 800, output_tokens: 240 },
          output: {
            message: 'One Domo dashboard is ready for governed migration.',
            decisions: [{
              id: 'decision-net-sales',
              nodeId: 'field:Net Sales',
              domain: 'field',
              sourceLabel: 'Net Sales',
              targetLabel: 'Net Sales',
              action: 'map_existing',
              targetId: 'northstar.net_sales',
              targetFileName: null,
              proposedCode: null,
              rationale: 'Reuse the reviewed target field.',
              confidence: 0.98,
              blocking: true,
              impactAssetIds: ['domo-card-executive-kpis'],
              validationRequired: true,
              compatibilityKey: 'field:net-sales',
            }],
            dashboardPlans: [{
              id: 'plan-executive-kpis',
              sourceDashboardId: 'domo-card-executive-kpis',
              sourceEvidenceIds: ['domo-card-executive-kpis'],
              dependencyIds: ['Business Date', 'Discounts', 'Net Sales', 'Order ID'],
              targetName: 'Executive KPIs',
              targetFolderPath: 'food-service',
              description: 'Executive revenue and order performance.',
              filters: [],
              tiles: [{
                id: 'tile-net-sales',
                title: 'Net Sales',
                description: 'Net sales KPI',
                sourceEvidenceIds: ['domo-card-executive-kpis'],
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
    await json(route, {
      job: { id, status: 'succeeded' },
      result: {
        rawText: 'Generated one additive Omni view file.',
        usage: { input_tokens: 500, output_tokens: 120 },
        output: {
          message: 'Generated one additive Omni view file.',
          files: [{
            fileName: 'northstar.view',
            yaml: 'dimensions:\n  net_sales:\n    sql: ${TABLE}.net_sales\nmeasures:\n  total_revenue:\n    sql: SUM(${TABLE}.net_sales)',
          }],
          warnings: [],
        },
      },
    });
  });

  const branchFiles: Record<string, string> = {};
  await page.route('**/api/manage-models', async (route) => json(route, {
    id: 'browser-branch-model-1',
    name: 'migration/domo-browser-test',
    kind: 'BRANCH',
  }));
  await page.route('**/api/omni-proxy', async (route) => {
    const body = route.request().postDataJSON() as {
      method?: string;
      endpoint?: string;
      body?: { fileName?: string; yaml?: string };
      query_params?: Record<string, string>;
    };
    if (body.endpoint?.endsWith('/yaml') && body.method === 'POST') {
      if (body.body?.fileName && typeof body.body.yaml === 'string') branchFiles[body.body.fileName] = body.body.yaml;
      return json(route, { success: true });
    }
    if (body.endpoint?.endsWith('/yaml') && body.method === 'GET') {
      const onBranch = Boolean(body.query_params?.branchId);
      return json(route, { files: onBranch ? branchFiles : {}, checksums: {}, version: 1 });
    }
    if (body.endpoint?.endsWith('/validate')) return json(route, []);
    if (body.endpoint?.endsWith('/content-validator')) return json(route, { issues: [] });
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
  await page.getByRole('button', { name: 'Confirm upload inventory' }).click();
  await expect(page.getByText('Domo evidence is ready for migration planning')).toBeVisible();
  await page.getByRole('button', { name: 'Release raw source from memory' }).click();
  await expect(page.getByText('Raw source released from page memory')).toBeVisible();
  await expect(page.getByText('Normalized evidence retained; raw source released')).toBeVisible();

  await continueTo(page, 'Destination');
  await page.getByRole('button').filter({ hasText: 'Browser Test Food Service' }).click();
  await continueTo(page, 'Analyze');
  await page.locator('label').filter({ hasText: 'Executive KPIs' }).getByRole('checkbox').check();
  await acknowledgeCoverage(page);
  await page.getByRole('button', { name: 'Plan migration' }).click();
  await expect(page.getByText('Analysis complete. Continue to Resolve to review the proposed decisions.')).toBeVisible();
  await continueTo(page, 'Resolve');
  await expect(page.getByText('Migration plan', { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Approve' }).check();
  await page.getByRole('button', { name: 'Generate semantic YAML' }).click();

  await continueTo(page, 'Validate');
  await expect(page.locator('input[value="northstar.view"]')).toBeVisible();
  await page.getByRole('button', { name: 'Apply to Dev' }).click();
  await expect(page.getByText('1 files changed')).toBeVisible();
  for (const checkId of ['query', 'visual_intent', 'security', 'operational']) {
    const validationRow = page.getByTestId(`migration-validation-${checkId}`);
    await validationRow.getByRole('checkbox', { name: 'Waive' }).click();
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
  await page.getByRole('button', { name: 'Confirm upload inventory' }).click();
  await page.getByRole('button', { name: 'Release raw source from memory' }).click();
  await expect(page.getByText('Raw source released from page memory')).toBeVisible();

  await page.getByRole('button', { name: 'Replace source files' }).click();
  await expect(page.getByRole('button', { name: 'Add Domo exports' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try sample data' })).toHaveCount(0);
  await expect(page.getByText('Raw source released from page memory')).toHaveCount(0);

  await uploadManualFixture(page, 'domo');
  await page.getByRole('button', { name: 'Review parsed evidence' }).click();
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
  const seeded = await seedVault(request);
  const sourceIds = new Map<string, string>();
  for (const source of SOURCE_PLATFORMS) {
    const response = await request.post('/api/migration-studio/platform-connections', {
      data: {
        name: `Browser ${source.label} source`,
        platform: source.id,
        baseUrl: `https://${source.id.replace('_', '-')}.example.com`,
        credential: `${source.id}-browser-credential-not-real`,
        enabled: true,
      },
    });
    expect(response.ok()).toBeTruthy();
    const connection = (await response.json()).connection as { id: string };
    sourceIds.set(connection.id, source.id);
  }
  await mockTargetModel(page);
  await page.route('**/api/migration-studio/platform-connections/*/test', async (route) => {
    const connectionId = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2) || '');
    const sourceId = sourceIds.get(connectionId);
    if (!sourceId) return json(route, { error: 'Unknown source connection.' }, 404);
    return json(route, { ok: true, platform: sourceId, itemCount: 2 });
  });
  await page.route('**/api/migration-studio/platform-connections/*/inventory', async (route) => {
    const connectionId = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2) || '');
    const sourceId = sourceIds.get(connectionId);
    if (!sourceId) return json(route, { error: 'Unknown source connection.' }, 404);
    const source = SOURCE_PLATFORMS.find((candidate) => candidate.id === sourceId)!;
    const dashboardId = `${source.id}-dashboard`;
    const modelId = `${source.id}-model`;
    return json(route, {
      inventory: {
        platform: source.id,
        connectionId,
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
        collection: { scope: 'all_accessible', scopeLabel: `all accessible ${source.label} content`, pagesFetched: 1, parentsExpanded: 0, requestsMade: 1, maxPages: 10, maxItems: 1000 },
      },
    });
  });

  await openStudio(page, seeded);
  let previousDashboardName = '';
  for (const [index, source] of SOURCE_PLATFORMS.entries()) {
    if (index > 0) {
      await page.getByRole('button', { name: /Source.*Complete/i }).click();
      if (previousDashboardName) await expect(page.getByText(previousDashboardName, { exact: true })).toHaveCount(0);
    }
    await page.getByRole('combobox', { name: 'Saved source API connection' }).click();
    await page.getByRole('option').filter({ hasText: `Browser ${source.label} source` }).click();
    await page.getByRole('button', { name: 'Load inventory' }).click();
    await continueTo(page, 'Evidence');
    await continueTo(page, 'Destination');
    if (index === 0) await page.getByRole('button').filter({ hasText: 'Browser Test Food Service' }).click();
    await continueTo(page, 'Analyze');

    const dashboardName = `${source.label} Executive Dashboard`;
    await expect(page.getByText('Source coverage and collection scope')).toBeVisible();
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
  await mockTargetModel(page);
  await page.route('**/api/migration-studio/platform-connections/*/test', (route) => json(route, { ok: true, platform: 'domo', itemCount: 2 }));
  await page.route('**/api/migration-studio/platform-connections/*/inventory', (route) => json(route, {
    inventory: {
      platform: 'domo',
      connectionId: 'browser-domo-source',
      connector: {
        platform: 'domo',
        label: 'Domo',
        authGuidance: 'Vault-backed bearer token.',
        capabilities: { apiInventory: true, semanticDefinitions: 'partial', contentDefinitions: 'partial', usage: true, permissions: false, schedules: false, queryValidation: false, visualEvidence: false },
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
      collection: { scope: 'all_accessible', scopeLabel: 'all accessible Domo content', pagesFetched: 1, parentsExpanded: 0, requestsMade: 1, maxPages: 10, maxItems: 1000 },
    },
  }));

  await openStudio(page, seeded);
  await page.getByRole('button', { name: 'Saved API' }).click();
  expect(seeded.sourceConnectionId).toBeTruthy();
  await page.getByRole('button', { name: 'Refresh' }).click();
  await page.getByRole('combobox', { name: 'Saved source API connection' }).click();
  await page.getByRole('option').filter({ hasText: 'Browser Test Domo' }).click();
  await page.getByRole('button', { name: 'Load inventory' }).click();
  await continueTo(page, 'Evidence');
  await continueTo(page, 'Destination');
  await page.getByRole('button').filter({ hasText: 'Browser Test Food Service' }).click();
  await continueTo(page, 'Analyze');
  await expect(page.getByText('Source coverage and collection scope')).toBeVisible();
  const acknowledgement = page.getByRole('checkbox', { name: /I reviewed the partial and unsupported classes/ });
  await expect(acknowledgement).not.toBeChecked();
  await acknowledgement.check();
  await expect(page.getByText('Executive API Dashboard', { exact: true })).toBeVisible();
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
  await expect(page.getByText('LookML project ready for migration planning')).toBeVisible();
  expect(extractionRequests).toBe(0);
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
  await page.getByRole('button').filter({ hasText: 'Browser Test Food Service' }).click();
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
  await expect(page.getByText('Analysis complete. Continue to Resolve to review the proposed decisions.')).toBeVisible();
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
  await page.getByRole('button', { name: 'Confirm upload inventory' }).click();
  await continueTo(page, 'Destination');
  await page.getByRole('button').filter({ hasText: 'Browser Test Food Service' }).click();
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

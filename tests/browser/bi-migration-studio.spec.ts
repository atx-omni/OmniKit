import { expect, test, type APIRequestContext, type Page, type Route } from '@playwright/test';

const PASSPHRASE = 'browser migration test passphrase';

type SeededVault = {
  connection: Record<string, unknown>;
  instanceId: string;
  providerId: string;
  sourceConnectionId?: string;
};

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

test.beforeEach(async ({ request }) => {
  await request.delete('/api/vault/reset');
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
              targetId: 'whataburger.net_sales',
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
            fileName: 'whataburger.view',
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
  await page.locator('section[aria-labelledby="migration-control-plane-title"] select').first().selectOption(seeded.providerId);
  await page.getByRole('button', { name: /^Domo/ }).click();
  await page.getByRole('button', { name: 'Load Whataburger Domo example' }).click();
  await page.getByRole('button', { name: 'Review parsed evidence' }).click();
  await page.getByRole('button', { name: 'Confirm upload inventory' }).click();
  await expect(page.getByText('Domo evidence is ready for migration planning')).toBeVisible();
  await page.getByRole('button', { name: 'Release raw source from memory' }).click();
  await expect(page.getByText('Raw source released from page memory')).toBeVisible();
  await expect(page.getByText('Normalized evidence retained; raw source released')).toBeVisible();

  await page.getByRole('button').filter({ hasText: 'Browser Test Food Service' }).click();
  await page.locator('label').filter({ hasText: 'Executive KPIs' }).getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Plan migration' }).click();
  await expect(page.getByText('Migration plan', { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Approve' }).check();
  await page.getByRole('button', { name: 'Generate semantic YAML' }).click();
  await expect(page.locator('input[value="whataburger.view"]')).toBeVisible();

  await page.getByRole('button', { name: 'Apply to Dev' }).click();
  await expect(page.getByText('1 files changed')).toBeVisible();
  for (const checkLabel of ['Query results', 'Visual intent', 'Security', 'Operations']) {
    await page.getByText(checkLabel, { exact: true }).locator('..').getByRole('checkbox', { name: 'Waive' }).click();
    await expect(page.getByText(checkLabel, { exact: true }).locator('..')).toContainText('waived');
  }
  await page.getByRole('checkbox', { name: /I reviewed the dev branch diff/ }).check();
  await expect(page.getByRole('link', { name: 'Open semantic branch' })).toBeVisible();

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

  await page.getByRole('button', { name: /^Domo/ }).click();
  await page.getByRole('button', { name: 'Load Whataburger Domo example' }).click();
  await page.getByRole('button', { name: 'Review parsed evidence' }).click();
  await page.getByRole('button', { name: 'Confirm upload inventory' }).click();
  await page.getByRole('button', { name: 'Release raw source from memory' }).click();
  await expect(page.getByText('Raw source released from page memory')).toBeVisible();

  await page.getByRole('button', { name: 'Replace source files' }).click();
  await expect(page.getByRole('button', { name: 'Load Whataburger Domo example' })).toBeVisible();
  await expect(page.getByText('Raw source released from page memory')).toHaveCount(0);

  await page.getByRole('button', { name: 'Load Whataburger Domo example' }).click();
  await page.getByRole('button', { name: 'Review parsed evidence' }).click();
  await page.getByRole('button', { name: 'Confirm upload inventory' }).click();
  await page.getByRole('button', { name: 'Release raw source from memory' }).click();
  await expect(page.getByText('Raw source released from page memory')).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { name: 'BI Migration Studio' })).toBeVisible();
  await expect(page.getByText('Raw source released from page memory')).toHaveCount(0);
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
  await page.getByLabel('Saved source API connection').selectOption(seeded.sourceConnectionId!);
  await page.getByRole('button', { name: 'Load inventory' }).click();
  await expect(page.getByText('Source coverage and collection scope')).toBeVisible();
  const acknowledgement = page.getByRole('checkbox', { name: /I reviewed the partial and unsupported classes/ });
  await expect(acknowledgement).not.toBeChecked();
  await acknowledgement.check();
  await expect(page.getByText('Executive API Dashboard', { exact: true })).toBeVisible();
});

test('Looker native parsing remains usable when the deterministic engine is unavailable', async ({ page, request }) => {
  const seeded = await seedVault(request);
  await mockTargetModel(page);
  await page.route('**/api/migration-studio/engine/capabilities', (route) => json(route, { error: 'engine unavailable in browser test' }, 503));
  await page.route('**/api/migration-studio/engine/extract', (route) => json(route, { error: 'engine unavailable in browser test' }, 503));

  await openStudio(page, seeded);
  await page.getByRole('button', { name: /^Looker/ }).click();
  await page.getByRole('button', { name: 'Load Whataburger Looker example' }).click();
  await expect(page.getByText('OmniKit will continue with its native parser when that path is available.')).toBeVisible();
  await page.getByRole('button', { name: 'Review parsed evidence' }).click();
  await page.getByRole('button', { name: 'Confirm LookML inventory' }).click();
  await expect(page.getByText('LookML project ready for migration planning')).toBeVisible();
});

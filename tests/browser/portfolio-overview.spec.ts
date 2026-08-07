import { expect, test, type APIRequestContext, type Page, type Route } from '@playwright/test';

const PASSPHRASE = 'portfolio overview browser test passphrase';

type SeededConnection = Record<string, unknown>;

function metric(value: number | null, status = 'available', reasonCode: string | null = null) {
  return {
    value,
    status,
    asOf: '2026-08-06T15:00:00.000Z',
    coverage: { included: value === null ? 0 : 2, total: 2, unit: 'instances', ratio: value === null ? 0 : 1 },
    exclusions: [],
    reasonCode,
  };
}

function metricSet(overrides: Record<string, ReturnType<typeof metric>> = {}) {
  return {
    internalMemberships: metric(120),
    estimatedUniquePeople: metric(98),
    embedUsers: metric(42),
    embedEntities: metric(6),
    active7d: metric(45),
    active30d: metric(86),
    active90d: metric(122),
    dashboards: metric(34),
    models: metric(8),
    topics: metric(12),
    aiChats: metric(9),
    apps: metric(2),
    ...overrides,
  };
}

function instance(id: string, label: string, health: 'healthy' | 'attention', connectionId: string) {
  const metrics = metricSet();
  return {
    id,
    label,
    health,
    statusLabel: health === 'healthy' ? 'Healthy' : 'Needs attention',
    freshness: health === 'healthy' ? 'available' : 'partial',
    asOf: '2026-08-06T15:00:00.000Z',
    metrics,
    connections: [{
      id: connectionId,
      name: `${label} Warehouse`,
      instanceId: id,
      instanceLabel: label,
      readiness: health === 'healthy' ? 'ready' : 'attention',
      statusLabel: health === 'healthy' ? 'Ready' : 'Needs attention',
      freshness: health === 'healthy' ? 'available' : 'partial',
      asOf: '2026-08-06T15:00:00.000Z',
      dashboards: metrics.dashboards,
      models: metrics.models,
      topics: metrics.topics,
    }],
  };
}

const overview = {
  schemaVersion: 1,
  generatedAt: '2026-08-06T15:00:00.000Z',
  servedAt: '2026-08-06T15:00:00.000Z',
  cache: { state: 'fresh', cachedAt: '2026-08-06T15:00:00.000Z' },
  refresh: {
    state: 'idle',
    completedInstances: 2,
    totalInstances: 2,
    completedAt: '2026-08-06T15:00:00.000Z',
  },
  coverage: {
    totalInstances: 2,
    reportingInstances: 2,
    partialInstances: 1,
    staleInstances: 0,
    unavailableInstances: 0,
    savedInstances: 2,
    duplicateSavedOrigins: 0,
  },
  metrics: {
    reportingInstances: metric(2),
    ...metricSet({
      internalMemberships: metric(240),
      estimatedUniquePeople: metric(196),
      embedUsers: metric(84),
      embedEntities: metric(12),
      active7d: metric(90),
      active30d: metric(172),
      active90d: metric(244),
      dashboards: metric(68),
      models: metric(16),
      topics: metric(24),
      aiChats: metric(18),
      apps: metric(4),
    }),
  },
  instances: [
    instance('instance-us', 'Operations US', 'healthy', 'connection-us'),
    instance('instance-eu', 'Operations Europe', 'attention', 'connection-eu'),
  ],
  connections: [],
  duplicateSavedOrigins: [],
  warnings: ['One instance has partial collection coverage.'],
  partial: true,
  stale: false,
};

async function seedConnection(request: APIRequestContext): Promise<SeededConnection> {
  await request.delete('/api/vault/reset');
  expect((await request.post('/api/vault/unlock', { data: { passphrase: PASSPHRASE } })).ok()).toBeTruthy();
  const response = await request.post('/api/instances', {
    data: {
      label: 'Portfolio test workspace',
      role: 'both',
      baseUrl: 'https://portfolio-test.omniapp.co',
      apiKey: 'omni-portfolio-browser-key-not-real',
    },
  });
  expect(response.ok()).toBeTruthy();
  const saved = (await response.json()).instance as { id: string; label: string; baseUrl: string; apiKeyMasked: string };
  return {
    baseUrl: saved.baseUrl,
    apiKey: `__omnikit_vault_instance__:${saved.id}`,
    status: 'success',
    connectionMode: 'vault',
    instanceId: saved.id,
    instanceLabel: saved.label,
    apiKeyMasked: saved.apiKeyMasked,
  };
}

async function preparePortfolio(page: Page, request: APIRequestContext, payload = overview) {
  const connection = await seedConnection(request);
  await page.addInitScript((savedConnection) => {
    window.sessionStorage.setItem('omnikit:activeConnection:v1', JSON.stringify(savedConnection));
  }, connection);
  await page.route('**/api/portfolio-overview**', (route: Route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(payload),
  }));
}

async function closeWalkthrough(page: Page) {
  const close = page.getByRole('button', { name: 'Close walkthrough' });
  if (await close.isVisible().catch(() => false)) await close.click();
}

test.afterEach(async ({ request }) => {
  await request.delete('/api/vault/reset');
});

test('portfolio overview supports scanning, filtering, and refresh without losing evidence', async ({ page, request }, testInfo) => {
  await preparePortfolio(page, request);
  await page.goto('/');
  await closeWalkthrough(page);

  await expect(page.getByRole('heading', { name: 'Portfolio Overview' })).toBeVisible();
  await expect(page.getByText('2 of 2 instances reporting')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Portfolio key performance indicators' })).toContainText('Estimated internal users');
  await expect(page.getByRole('region', { name: 'Portfolio key performance indicators' })).toContainText('196');
  await expect(page.getByRole('region', { name: 'Portfolio key performance indicators' })).toContainText('AI conversations');
  await expect(page.getByRole('region', { name: 'Portfolio key performance indicators' })).toContainText('18');
  await expect(page.getByRole('region', { name: 'Portfolio key performance indicators' })).toContainText('Apps');
  await expect(page.getByRole('region', { name: 'Portfolio key performance indicators' })).toContainText('4');
  await expect(page.getByRole('link', { name: 'Operations US Warehouse', exact: true }).last()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Operations Europe Warehouse', exact: true }).last()).toBeVisible();

  await page.getByLabel('Health and status').selectOption('attention');
  await expect(page.getByRole('link', { name: 'Operations Europe Warehouse', exact: true }).last()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Operations US Warehouse', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.getByRole('link', { name: 'Operations US Warehouse', exact: true }).last()).toBeVisible();

  await page.getByRole('button', { name: 'Refresh portfolio overview' }).click();
  await expect(page.getByRole('link', { name: 'Operations US Warehouse', exact: true }).last()).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('portfolio-desktop.png'), fullPage: true });
});

test('portfolio overview requires only the governed App label after AI scope is detected automatically', async ({ page, request }) => {
  const setupRequired = structuredClone(overview);
  setupRequired.metrics.apps = metric(null, 'not_configured', 'APP_INVENTORY_LABEL_REQUIRED');
  setupRequired.instances = setupRequired.instances.map((entry) => ({
    ...entry,
    metrics: {
      ...entry.metrics,
      apps: metric(null, 'not_configured', 'APP_INVENTORY_LABEL_REQUIRED'),
    },
  }));

  await preparePortfolio(page, request, setupRequired);
  await page.goto('/');
  await closeWalkthrough(page);

  const kpis = page.getByRole('region', { name: 'Portfolio key performance indicators' });
  await expect(kpis).toContainText('AI conversations');
  await expect(kpis).toContainText('Apps');
  await expect(kpis).toContainText('Setup required');
  await expect(page.getByText('Setup required: App inventory label.').first()).toBeVisible();
  await expect(page.getByText(/Organization API key confirmation/)).toHaveCount(0);
});

test('portfolio polling keeps the current overview visible while progress advances and completes', async ({ page, request }) => {
  const connection = await seedConnection(request);
  await page.addInitScript((savedConnection) => {
    window.sessionStorage.setItem('omnikit:activeConnection:v1', JSON.stringify(savedConnection));
  }, connection);

  let refreshStarted = false;
  let pollCount = 0;
  await page.route('**/api/portfolio-overview**', (route: Route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('refresh') === 'true') {
      refreshStarted = true;
      pollCount = 0;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...overview,
          refresh: {
            state: 'running',
            startedAt: '2026-08-06T15:05:00.000Z',
            completedInstances: 0,
            totalInstances: 2,
          },
        }),
      });
    }

    if (!refreshStarted) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(overview) });
    }

    pollCount += 1;
    const stillRunning = pollCount === 1;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...overview,
        generatedAt: stillRunning ? overview.generatedAt : '2026-08-06T15:05:04.000Z',
        refresh: stillRunning
          ? {
              state: 'running',
              startedAt: '2026-08-06T15:05:00.000Z',
              completedInstances: 1,
              totalInstances: 2,
            }
          : {
              state: 'idle',
              startedAt: '2026-08-06T15:05:00.000Z',
              completedAt: '2026-08-06T15:05:04.000Z',
              completedInstances: 2,
              totalInstances: 2,
            },
      }),
    });
  });

  await page.goto('/');
  await closeWalkthrough(page);
  await expect(page.getByRole('heading', { name: 'Portfolio Overview' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Operations US Warehouse', exact: true }).last()).toBeVisible();
  await expect(page.getByRole('region', { name: 'Portfolio key performance indicators' })).toContainText('196');

  await page.getByRole('button', { name: 'Refresh portfolio overview' }).click();
  await expect(page.getByText('Refreshing 0 of 2 instances. Current portfolio data remains available while collection continues.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Operations US Warehouse', exact: true }).last()).toBeVisible();
  await expect(page.getByRole('region', { name: 'Portfolio key performance indicators' })).toContainText('196');

  await expect(page.getByText('Refreshing 1 of 2 instances. Current portfolio data remains available while collection continues.')).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole('link', { name: 'Operations Europe Warehouse', exact: true }).last()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Collecting your first portfolio snapshot' })).toHaveCount(0);

  await expect(page.getByText(/Current portfolio data remains available while collection continues/)).toHaveCount(0, { timeout: 5_000 });
  await expect(page.locator('[aria-live="polite"]')).toContainText('Portfolio refresh complete.');
  await expect(page.getByRole('region', { name: 'Portfolio key performance indicators' })).toContainText('196');
  expect(pollCount).toBeGreaterThanOrEqual(2);
});

test('portfolio overview and navigation remain usable on a narrow viewport', async ({ page, request }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await preparePortfolio(page, request);
  await page.goto('/');
  await closeWalkthrough(page);

  await expect(page.getByRole('heading', { name: 'Portfolio Overview' })).toBeVisible();
  const menu = page.getByRole('button', { name: 'Open navigation' });
  await expect(menu).toBeVisible();
  await menu.click();
  await expect(page.getByRole('navigation', { name: 'Main sections' })).toBeVisible();
  await page.getByRole('button', { name: 'Close navigation' }).click();

  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('portfolio-mobile.png'), fullPage: true });
});

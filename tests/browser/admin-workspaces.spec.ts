import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page, type Route } from '@playwright/test';

const PASSPHRASE = 'admin workspace browser test passphrase';

type SeededConnection = Record<string, unknown>;

interface TenantIsolation {
  escapedRequests: string[];
  pageErrors: string[];
  tenantWrites: string[];
}

function metric(value: number) {
  return {
    value,
    status: 'available',
    asOf: '2026-08-09T12:00:00.000Z',
    coverage: { included: 1, total: 1, unit: 'instances', ratio: 1 },
    exclusions: [],
    reasonCode: null,
    source: 'derived_instance_aggregate',
  };
}

function portfolioFixture() {
  const metrics = {
    reportingInstances: metric(1),
    internalMemberships: metric(0),
    estimatedUniquePeople: metric(0),
    embedUsers: metric(0),
    embedEntities: metric(0),
    active7d: metric(0),
    active30d: metric(0),
    active90d: metric(0),
    staleUsers90d: metric(0),
    neverLoggedInUsers: metric(0),
    dashboards: metric(0),
    models: metric(0),
    topics: metric(0),
    aiChats: metric(0),
    apps: metric(0),
  };
  return {
    schemaVersion: 1,
    generatedAt: '2026-08-09T12:00:00.000Z',
    servedAt: '2026-08-09T12:00:00.000Z',
    cache: { state: 'fresh', cachedAt: '2026-08-09T12:00:00.000Z' },
    refresh: { state: 'idle', completedInstances: 1, totalInstances: 1, completedAt: '2026-08-09T12:00:00.000Z' },
    coverage: {
      totalInstances: 1,
      reportingInstances: 1,
      partialInstances: 0,
      staleInstances: 0,
      unavailableInstances: 0,
      savedInstances: 1,
      duplicateSavedOrigins: 0,
    },
    metrics,
    instances: [],
    connections: [],
    attention: [],
    failures: [],
    duplicateSavedOrigins: [],
    warnings: [],
    partial: false,
    stale: false,
  };
}

async function seedConnection(request: APIRequestContext): Promise<SeededConnection> {
  await request.delete('/api/vault/reset');
  expect((await request.post('/api/vault/unlock', { data: { passphrase: PASSPHRASE } })).ok()).toBeTruthy();
  const response = await request.post('/api/instances', {
    data: {
      label: 'Neutral admin workspace',
      role: 'both',
      baseUrl: 'https://admin-workspaces.invalid',
      apiKey: 'omni-admin-workspace-test-key-not-real',
    },
  });
  expect(response.ok()).toBeTruthy();
  const instance = (await response.json()).instance as {
    id: string;
    label: string;
    baseUrl: string;
    apiKeyMasked: string;
  };
  return {
    baseUrl: instance.baseUrl,
    apiKey: `__omnikit_vault_instance__:${instance.id}`,
    status: 'success',
    connectionMode: 'vault',
    instanceId: instance.id,
    instanceLabel: instance.label,
    apiKeyMasked: instance.apiKeyMasked,
  };
}

function json(route: Route, body: unknown) {
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

async function prepareNeutralWorkspace(page: Page, request: APIRequestContext): Promise<TenantIsolation> {
  const connection = await seedConnection(request);
  await page.addInitScript((savedConnection) => {
    window.sessionStorage.setItem('omnikit:activeConnection:v1', JSON.stringify(savedConnection));
  }, connection);

  const isolation: TenantIsolation = { escapedRequests: [], pageErrors: [], tenantWrites: [] };
  page.on('pageerror', (error) => isolation.pageErrors.push(`${page.url()}: ${error.message}`));
  page.on('request', (browserRequest) => {
    if (new URL(browserRequest.url()).hostname.endsWith('.invalid')) {
      isolation.escapedRequests.push(browserRequest.url());
    }
  });

  await page.route('**/api/**', async (route) => {
    const browserRequest = route.request();
    const url = new URL(browserRequest.url());
    const localRead = (
      url.pathname === '/api/vault/status'
      || url.pathname === '/api/vault/touch'
      || (url.pathname === '/api/instances' && browserRequest.method() === 'GET')
    );
    if (localRead) return route.continue();

    let proxyBody: Record<string, unknown> = {};
    try {
      proxyBody = browserRequest.postDataJSON() as Record<string, unknown>;
    } catch {
      proxyBody = {};
    }
    const readOnlyPostEndpoints = new Set(['/api/list-folders', '/api/list-models', '/api/manage-users']);
    const effectiveMethod = url.pathname === '/api/omni-proxy'
      ? String(proxyBody.method || 'GET').toUpperCase()
      : readOnlyPostEndpoints.has(url.pathname)
        ? 'GET'
        : browserRequest.method().toUpperCase();
    if (!['GET', 'HEAD'].includes(effectiveMethod)) {
      isolation.tenantWrites.push(`${effectiveMethod} ${url.pathname}`);
    }

    if (url.pathname === '/api/portfolio-overview') return json(route, portfolioFixture());
    if (url.pathname.startsWith('/api/instance-dashboard/')) return json(route, { instances: [] });
    return json(route, {
      Resources: [],
      totalResults: 0,
      startIndex: 1,
      itemsPerPage: 0,
      records: [],
      pageInfo: { totalRecords: 0, pageSize: 50, currentPage: 1 },
      folders: [],
      labels: [],
      documents: [],
      connections: [],
      schedules: [],
      dashboards: [],
      models: [],
      items: [],
    });
  });

  return isolation;
}

async function closeWalkthrough(page: Page) {
  const close = page.getByRole('button', { name: 'Close walkthrough' });
  if (await close.isVisible().catch(() => false)) await close.click();
}

function expectIsolated(isolation: TenantIsolation) {
  expect(isolation.escapedRequests, 'a browser request escaped to the neutral .invalid tenant').toEqual([]);
  expect(isolation.tenantWrites, 'a tenant-facing write was attempted').toEqual([]);
  expect(isolation.pageErrors, 'admin workspace page errors').toEqual([]);
}

async function expectNoDocumentOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    return Math.max(root.scrollWidth - root.clientWidth, body.scrollWidth - body.clientWidth);
  })).toBeLessThanOrEqual(0);
}

test.afterEach(async ({ request }) => {
  await request.delete('/api/vault/reset');
});

test('Sidebar and workspace navigation expose four active prefixes, retain Fleet context, and use normal history', async ({ page, request }) => {
  const isolation = await prepareNeutralWorkspace(page, request);
  const fleetContext = 'fleetView=exceptions&fleetInstances=east&fleetInstances=west';
  await page.goto(`/admin/fleet/instances?${fleetContext}`);
  await closeWalkthrough(page);

  const sidebar = page.getByLabel('Main navigation');
  const adminSection = sidebar.locator('section').filter({ hasText: 'Administration' });
  const workspaceNames = ['Fleet & Readiness', 'Identity & Access', 'Content Operations', 'Embed & Developer Tools'];
  await expect(adminSection.getByRole('link')).toHaveCount(4);
  for (const name of workspaceNames) await expect(adminSection.getByRole('link', { name, exact: true })).toBeVisible();
  await expect(adminSection.getByRole('link', { name: 'Fleet & Readiness', exact: true })).toHaveAttribute('aria-current', 'page');

  const workspaceNavigation = page.getByRole('navigation', { name: 'Administration workspaces' });
  const contentWorkspace = workspaceNavigation.getByRole('link', { name: 'Content Operations', exact: true });
  await contentWorkspace.click();
  await expect(page).toHaveURL(`/admin/content/health?${fleetContext}`);
  await expect(adminSection.getByRole('link', { name: 'Content Operations', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(contentWorkspace).toHaveAttribute('aria-current', 'page');

  const contentNavigation = page.getByRole('navigation', { name: 'Content Operations pages' });
  await contentNavigation.getByRole('link', { name: 'Uploads', exact: true }).click();
  await expect(page).toHaveURL(`/admin/content/uploads?${fleetContext}`);
  await expect(contentNavigation.getByRole('link', { name: 'Uploads', exact: true })).toHaveAttribute('aria-current', 'page');

  await page.goBack();
  await expect(page).toHaveURL(`/admin/content/health?${fleetContext}`);
  await page.goBack();
  await expect(page).toHaveURL(`/admin/fleet/instances?${fleetContext}`);
  await page.goForward();
  await expect(page).toHaveURL(`/admin/content/health?${fleetContext}`);

  await page.goto('/?instances=east&instances=west');
  await expect(page.getByRole('heading', { name: 'Fleet Command Center', exact: true })).toBeVisible({ timeout: 30_000 });
  const fleetAdminLink = page.getByRole('link', { name: 'Manage instances', exact: true });
  await expect(fleetAdminLink).toHaveAttribute('href', /^\/admin\/fleet\/instances(?:\?|$)/);
  expectIsolated(isolation);
});

test('all canonical leaves reuse their existing headings and representative controls', async ({ page, request }) => {
  const isolation = await prepareNeutralWorkspace(page, request);
  const leaves = [
    { path: '/admin/fleet/instances', heading: 'Instance Manager' },
    { path: '/admin/fleet/connections', heading: 'Connection Readiness' },
    { path: '/admin/identity/users', heading: 'User Management' },
    { path: '/admin/content/health', heading: 'Content Health' },
    { path: '/admin/content/schedules', heading: 'Schedule Management' },
    { path: '/admin/content/uploads', heading: 'Upload Governance' },
    { path: '/admin/content/labels', heading: 'Bulk Label Governance' },
    { path: '/admin/developer/embeds', heading: 'Embed URL Generator' },
  ];

  for (const leaf of leaves) {
    await page.goto(leaf.path);
    await closeWalkthrough(page);
    await expect(page.getByRole('heading', { name: leaf.heading, exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('admin-workspace-shell')).toBeVisible();
  }

  await page.goto('/admin/fleet/instances');
  for (const tab of ['Instance profiles', 'Connections', 'Embed users']) {
    await expect(page.getByRole('button', { name: tab, exact: true })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await expect(page.getByPlaceholder('Search instances, connections, dialects, or databases')).toBeVisible();
  await page.getByRole('button', { name: 'Embed users', exact: true }).click();
  await expect(page.getByPlaceholder('Search users, external IDs, groups, or instances')).toBeVisible();

  await page.goto('/admin/identity/users');
  const identityNavigation = page.getByRole('navigation', { name: 'Identity & Access pages' });
  await expect(identityNavigation.getByRole('link')).toHaveCount(4);
  await expect(page.getByRole('button', { name: 'Create User', exact: true })).toBeVisible();

  await page.goto('/admin/fleet/connections');
  await expect(page.getByText('Configuration evidence', { exact: true })).toBeVisible();

  await page.goto('/admin/content/health');
  await expect(page.getByText('Collected Content', { exact: true })).toBeVisible();
  await expect(page.getByText('Models represented', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Content folder')).toBeVisible();

  await page.goto('/admin/content/schedules');
  await expect(page.getByRole('button', { name: 'Create Schedule', exact: true })).toBeVisible();
  await expect(page.getByText('Delivery evidence', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Schedule status')).toBeVisible();
  await expect(page.getByLabel('Schedule destination')).toBeVisible();
  await expect(page.getByLabel('Schedule type')).toBeVisible();
  await page.goto('/admin/developer/embeds');
  await expect(page.getByPlaceholder('/dashboards/my-dashboard')).toBeVisible();
  expectIsolated(isolation);
});

test('keyboard and mobile workspace navigation close correctly and remain overflow-safe at 320px', async ({ page, request }) => {
  const isolation = await prepareNeutralWorkspace(page, request);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await closeWalkthrough(page);

  const toggle = page.locator('button[aria-controls="mobile-navigation-drawer"]');
  const drawer = page.locator('#mobile-navigation-drawer');
  await toggle.focus();
  await toggle.press('Enter');
  const fleetWorkspaceLink = drawer.getByRole('link', { name: 'Fleet & Readiness', exact: true });
  await fleetWorkspaceLink.focus();
  await fleetWorkspaceLink.press('Enter');
  await expect(page).toHaveURL('/admin/fleet/instances');
  await expect(drawer).toBeHidden();
  await expect(page.locator('#main-content')).toBeFocused();

  await page.setViewportSize({ width: 320, height: 720 });
  for (const path of ['/admin/fleet/instances', '/admin/identity/users', '/admin/content/health', '/admin/developer/embeds']) {
    await page.goto(path);
    await expect(page.getByTestId('admin-workspace-shell')).toBeVisible();
    await expectNoDocumentOverflow(page);
  }
  expectIsolated(isolation);
});

test('new Sidebar and workspace navigation have no serious or critical Axe findings', async ({ page, request }) => {
  const isolation = await prepareNeutralWorkspace(page, request);
  await page.goto('/admin/content/health');
  await closeWalkthrough(page);
  await expect(page.getByTestId('admin-workspace-shell')).toBeVisible();

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .include('aside[aria-label="Main navigation"]')
    .include('[data-testid="admin-workspace-shell"] > [aria-label="Content Operations administration workspace"]')
    .analyze();
  const blocking = results.violations.filter((violation) => ['serious', 'critical'].includes(violation.impact || ''));
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
  expectIsolated(isolation);
});

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const PASSPHRASE = 'browser routing test passphrase';
const ROUTE_CONTEXT_QUERY = 'filter=first&filter=second&fleetView=exceptions&fleetInstances=east&fleetInstances=west';
const ROUTE_CONTEXT_HASH = '#fleet-drilldown';

type SeededConnection = Record<string, unknown>;

const pageErrorsByPage = new WeakMap<Page, Error[]>();

test.beforeEach(async ({ page }) => {
  const pageErrors: Error[] = [];
  pageErrorsByPage.set(page, pageErrors);
  page.on('pageerror', (error) => pageErrors.push(error));
});

test.afterEach(async ({ page }) => {
  expect((pageErrorsByPage.get(page) || []).map((error) => error.message)).toEqual([]);
});

async function resetVault(request: APIRequestContext) {
  await request.delete('/api/vault/reset');
}

async function seedConnection(request: APIRequestContext): Promise<SeededConnection> {
  await resetVault(request);
  expect((await request.post('/api/vault/unlock', { data: { passphrase: PASSPHRASE } })).ok()).toBeTruthy();

  const response = await request.post('/api/instances', {
    data: {
      label: 'Example Omni workspace',
      role: 'both',
      baseUrl: 'https://example.omniapp.co',
      apiKey: 'omni-routing-test-key-not-real',
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

async function useConnection(page: Page, connection: SeededConnection) {
  await page.addInitScript((savedConnection) => {
    window.sessionStorage.setItem('omnikit:activeConnection:v1', JSON.stringify(savedConnection));
  }, connection);
}

async function closeWalkthrough(page: Page) {
  const close = page.getByRole('button', { name: 'Close walkthrough' });
  if (await close.isVisible().catch(() => false)) await close.click();
}

test('guarded workflows explain how to return home when no saved instance is active', async ({ page, request }) => {
  await resetVault(request);
  await page.goto('/dashboards/migrate');
  await closeWalkthrough(page);

  await expect(page.getByRole('heading', { name: 'Choose an instance to unlock Dashboard Migrator' })).toBeVisible();
  await page.getByRole('button', { name: 'Go to Home' }).click();
  await expect(page).toHaveURL('/');
});

test('admin workspace landings preserve repeated route context and hashes', async ({ page, request }) => {
  await resetVault(request);

  const landings = [
    { source: '/admin', destination: '/admin/fleet/instances' },
    { source: '/admin/fleet', destination: '/admin/fleet/instances' },
    { source: '/admin/identity', destination: '/admin/identity/users' },
    { source: '/admin/content', destination: '/admin/content/health' },
    { source: '/admin/developer', destination: '/admin/developer/embeds' },
  ];

  for (const landing of landings) {
    await page.goto(`${landing.source}?${ROUTE_CONTEXT_QUERY}${ROUTE_CONTEXT_HASH}`);
    await closeWalkthrough(page);
    await expect(page).toHaveURL(`${landing.destination}?${ROUTE_CONTEXT_QUERY}${ROUTE_CONTEXT_HASH}`);
  }
});

test('all legacy admin aliases preserve repeated context and force groups exactly once', async ({ page, request }) => {
  await resetVault(request);

  const legacyQuery = `${ROUTE_CONTEXT_QUERY}&tab=users&tab=health`;
  const aliases = [
    { source: '/instances', destination: '/admin/fleet/instances', query: legacyQuery },
    { source: '/connections', destination: '/admin/fleet/connections', query: legacyQuery },
    { source: '/users', destination: '/admin/identity/users', query: legacyQuery },
    { source: '/groups', destination: '/admin/identity/users', query: `${ROUTE_CONTEXT_QUERY}&tab=groups` },
    { source: '/uploads', destination: '/admin/content/uploads', query: legacyQuery },
    { source: '/content-health', destination: '/admin/content/health', query: legacyQuery },
    { source: '/labels', destination: '/admin/content/labels', query: legacyQuery },
    { source: '/schedules', destination: '/admin/content/schedules', query: legacyQuery },
    { source: '/embeds', destination: '/admin/developer/embeds', query: legacyQuery },
  ];

  for (const alias of aliases) {
    const sourceQuery = alias.source === '/groups' ? legacyQuery : alias.query;
    await page.goto(`${alias.source}?${sourceQuery}${ROUTE_CONTEXT_HASH}`);
    await closeWalkthrough(page);
    await expect(page).toHaveURL(`${alias.destination}?${alias.query}${ROUTE_CONTEXT_HASH}`);

    const currentUrl = new URL(page.url());
    expect(currentUrl.searchParams.getAll('filter')).toEqual(['first', 'second']);
    expect(currentUrl.searchParams.getAll('fleetInstances')).toEqual(['east', 'west']);
    if (alias.source === '/groups') expect(currentUrl.searchParams.getAll('tab')).toEqual(['groups']);
  }

  await page.goto('/connect');
  await expect(page).toHaveURL('/');
});

test('groups alias replaces its history entry and remains canonical through Back and Forward', async ({ page, request }) => {
  await resetVault(request);

  await page.goto('/');
  await closeWalkthrough(page);
  await page.goto(`/groups?${ROUTE_CONTEXT_QUERY}&tab=users&tab=health${ROUTE_CONTEXT_HASH}`);
  const canonicalGroupsUrl = `/admin/identity/users?${ROUTE_CONTEXT_QUERY}&tab=groups${ROUTE_CONTEXT_HASH}`;
  await expect(page).toHaveURL(canonicalGroupsUrl);
  expect(new URL(page.url()).searchParams.getAll('tab')).toEqual(['groups']);

  await page.goBack();
  await expect(page).toHaveURL('/');

  await page.goForward();
  await expect(page).toHaveURL(canonicalGroupsUrl);
  expect(new URL(page.url()).searchParams.getAll('tab')).toEqual(['groups']);
});

test('canonical admin guards are exact while Instance Manager remains unguarded', async ({ page, request }) => {
  await resetVault(request);

  await page.goto('/admin/fleet/instances');
  await closeWalkthrough(page);
  await expect(page.getByRole('heading', { name: 'Instance Manager', exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('heading', { name: /Choose an instance to unlock/ })).toHaveCount(0);

  const guardedLeaves = [
    { path: '/admin/fleet/connections', tool: 'Connection Health' },
    { path: '/admin/identity/users', tool: 'User Management' },
    { path: '/admin/content/health', tool: 'Content Health' },
    { path: '/admin/content/schedules', tool: 'Schedules' },
    { path: '/admin/content/uploads', tool: 'Upload Governance' },
    { path: '/admin/content/labels', tool: 'Labels' },
    { path: '/admin/developer/embeds', tool: 'Embed URLs' },
  ];

  for (const leaf of guardedLeaves) {
    await page.goto(`${leaf.path}?fleetView=overview#guarded-leaf`);
    await expect(page.getByRole('heading', {
      name: `Choose an instance to unlock ${leaf.tool}`,
      exact: true,
    })).toBeVisible({ timeout: 30_000 });
  }
});

test('active saved sessions support every canonical admin leaf and identity tab directly', async ({ page, request }) => {
  const connection = await seedConnection(request);
  await useConnection(page, connection);

  const canonicalRoutes = [
    { path: '/admin/fleet/instances', heading: 'Instance Manager', workspace: 'fleet' },
    { path: '/admin/fleet/connections', heading: 'Connection Readiness', workspace: 'fleet' },
    { path: '/admin/identity/users', heading: 'User Management', workspace: 'identity' },
    { path: '/admin/identity/users?tab=groups', heading: 'User Management', workspace: 'identity' },
    { path: '/admin/identity/users?tab=import', heading: 'User Management', workspace: 'identity' },
    { path: '/admin/identity/users?tab=health', heading: 'User Management', workspace: 'identity' },
    { path: '/admin/content/health', heading: 'Content Health', workspace: 'content' },
    { path: '/admin/content/schedules', heading: 'Schedule Management', workspace: 'content' },
    { path: '/admin/content/uploads', heading: 'Upload Governance', workspace: 'content' },
    { path: '/admin/content/labels', heading: 'Bulk Label Governance', workspace: 'content' },
    { path: '/admin/developer/embeds', heading: 'Embed URL Generator', workspace: 'developer' },
  ];

  for (const route of canonicalRoutes) {
    await page.goto(route.path);
    await closeWalkthrough(page);
    await expect(page.getByTestId('admin-workspace-shell')).toHaveAttribute('data-admin-workspace', route.workspace);
    await expect(page.getByRole('heading', { name: route.heading, exact: true })).toBeVisible({ timeout: 30_000 });
  }
});

test('Identity workspace links preserve repeated non-tab context, hash, and tab history', async ({ page, request }) => {
  const connection = await seedConnection(request);
  await useConnection(page, connection);

  const identityQuery = 'filter=first&filter=second&fleetView=adoption&fleetInstances=east&fleetInstances=west';
  const identityHash = '#identity-context';
  const identityUrl = (tab?: string) => (
    `/admin/identity/users?${identityQuery}${tab ? `&tab=${tab}` : ''}${identityHash}`
  );

  await page.goto(identityUrl());
  await closeWalkthrough(page);
  await expect(page.getByRole('heading', { name: 'User Management', exact: true })).toBeVisible({ timeout: 30_000 });

  const identityNavigation = page.getByRole('navigation', { name: 'Identity & Access pages' });
  const links = {
    Users: identityNavigation.getByRole('link', { name: 'Users', exact: true }),
    Groups: identityNavigation.getByRole('link', { name: 'Groups', exact: true }),
    'Bulk Import': identityNavigation.getByRole('link', { name: 'Bulk Import', exact: true }),
    'User Health': identityNavigation.getByRole('link', { name: 'User Health', exact: true }),
  };

  await expect(links.Users).toHaveAttribute('href', identityUrl());
  await expect(links.Groups).toHaveAttribute('href', identityUrl('groups'));
  await expect(links['Bulk Import']).toHaveAttribute('href', identityUrl('import'));
  await expect(links['User Health']).toHaveAttribute('href', identityUrl('health'));

  await links.Groups.click();
  await expect(page).toHaveURL(identityUrl('groups'));
  await expect(links.Groups).toHaveAttribute('aria-current', 'page');

  await links['Bulk Import'].click();
  await expect(page).toHaveURL(identityUrl('import'));
  await expect(links['Bulk Import']).toHaveAttribute('aria-current', 'page');

  await links['User Health'].click();
  await expect(page).toHaveURL(identityUrl('health'));
  await expect(links['User Health']).toHaveAttribute('aria-current', 'page');

  const history = [
    { direction: 'back' as const, url: identityUrl('import'), active: links['Bulk Import'] },
    { direction: 'back' as const, url: identityUrl('groups'), active: links.Groups },
    { direction: 'back' as const, url: identityUrl(), active: links.Users },
    { direction: 'forward' as const, url: identityUrl('groups'), active: links.Groups },
    { direction: 'forward' as const, url: identityUrl('import'), active: links['Bulk Import'] },
    { direction: 'forward' as const, url: identityUrl('health'), active: links['User Health'] },
  ];

  for (const step of history) {
    if (step.direction === 'back') await page.goBack();
    else await page.goForward();
    await expect(page).toHaveURL(step.url);
    await expect(step.active).toHaveAttribute('aria-current', 'page');
  }
});

test('high-risk workflows support direct navigation and browser history', async ({ page, request }) => {
  const connection = await seedConnection(request);
  await useConnection(page, connection);

  const routes = [
    { path: '/dashboards/migrate', heading: 'Dashboard Migrator' },
    { path: '/models/migrate', heading: 'Model Migrator' },
    { path: '/semantic-migrations', heading: 'BI Migration Studio' },
    { path: '/deck-builder', heading: 'Deck Builder' },
    { path: '/users?tab=groups', heading: 'User Management' },
  ];

  for (const route of routes) {
    await page.goto(route.path);
    await closeWalkthrough(page);
    await expect(page.getByRole('heading', { name: route.heading, exact: true })).toBeVisible({ timeout: 30_000 });
  }

  await page.goto('/dashboards/migrate');
  await expect(page.getByRole('heading', { name: 'Dashboard Migrator', exact: true })).toBeVisible();
  await page.goto('/semantic-migrations');
  await expect(page.getByRole('heading', { name: 'BI Migration Studio', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL('/dashboards/migrate');
  await expect(page.getByRole('heading', { name: 'Dashboard Migrator', exact: true })).toBeVisible();
});

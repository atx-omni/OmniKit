import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const PASSPHRASE = 'browser routing test passphrase';

type SeededConnection = Record<string, unknown>;

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

test('legacy route aliases preserve their intended destination and query string', async ({ page, request }) => {
  await resetVault(request);

  await page.goto('/connect');
  await expect(page).toHaveURL('/');

  await page.goto('/groups');
  await expect(page).toHaveURL('/users?tab=groups');
  await expect(page.getByRole('heading', { name: 'Choose an instance to unlock User Management' })).toBeVisible();
});

test('high-risk workflows support direct navigation and browser history', async ({ page, request }) => {
  const connection = await seedConnection(request);
  await useConnection(page, connection);
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));

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

  expect(pageErrors).toEqual([]);
});

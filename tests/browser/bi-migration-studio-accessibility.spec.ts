import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page, type Route } from '@playwright/test';

const PASSPHRASE = 'browser accessibility test passphrase';

async function json(route: Route, payload: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
}

async function seedVault(request: APIRequestContext) {
  await request.delete('/api/vault/reset');
  expect((await request.post('/api/vault/unlock', { data: { passphrase: PASSPHRASE } })).ok()).toBeTruthy();
  const response = await request.post('/api/instances', {
    data: {
      label: 'Accessibility Test Omni',
      role: 'both',
      baseUrl: 'https://accessibility-test.omniapp.co',
      apiKey: 'omni-accessibility-test-key-not-real',
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

async function openStudio(page: Page, request: APIRequestContext) {
  const connection = await seedVault(request);
  await page.route('**/api/migration-studio/engine/capabilities', (route) => json(route, {
    available: true,
    capabilities: {
      control_plane: {
        defaultMode: 'off',
        sourceModes: {},
        requestedSourceModes: {},
        promotionGates: {},
        fallback: 'native_when_available',
        observationRequired: true,
      },
    },
  }));
  await page.addInitScript((activeConnection) => {
    window.sessionStorage.setItem('omnikit:activeConnection:v1', JSON.stringify(activeConnection));
  }, connection);
  await page.goto('/semantic-migrations');
  await expect(page.getByRole('heading', { name: 'BI Migration Studio' })).toBeVisible();
  const walkthrough = page.getByRole('dialog', { name: /walkthrough|guided tour|see what changed/i });
  if (await walkthrough.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Close walkthrough' }).click();
  }
}

async function expectNoBlockingAccessibilityViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const blocking = results.violations.filter((violation) => ['serious', 'critical'].includes(violation.impact || ''));
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
}

test.beforeEach(async ({ request }) => {
  await request.delete('/api/vault/reset');
});

test('critical source workflow has no serious or critical accessibility violations', async ({ page, request }) => {
  await openStudio(page, request);
  await expectNoBlockingAccessibilityViolations(page);

  const manualFiles = page.getByRole('button', { name: 'Manual files' });
  await manualFiles.focus();
  await page.keyboard.press('Enter');
  await expect(manualFiles).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Domo selected')).toBeVisible();
  await expectNoBlockingAccessibilityViolations(page);
});

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const PASSPHRASE = 'browser UI experience hardening passphrase';

interface PrimaryRoute {
  path: string;
  heading: string;
  requiresSavedInstance?: boolean;
}

const PRIMARY_ROUTES: PrimaryRoute[] = [
  { path: '/', heading: 'Your Omni command center.' },
  { path: '/dashboards/ai-studio', heading: 'Choose an instance to unlock AI Dashboard Studio', requiresSavedInstance: true },
  { path: '/dashboards/migrate', heading: 'Choose an instance to unlock Dashboard Migrator', requiresSavedInstance: true },
  { path: '/dashboards/operations', heading: 'Choose an instance to unlock Dashboard Operations', requiresSavedInstance: true },
  { path: '/dashboards/downloads', heading: 'Choose an instance to unlock Dashboard Downloads', requiresSavedInstance: true },
  { path: '/deck-builder', heading: 'Choose an instance to unlock Deck Builder', requiresSavedInstance: true },
  { path: '/models/migrate', heading: 'Choose an instance to unlock Model Migrator', requiresSavedInstance: true },
  { path: '/models', heading: 'Choose an instance to unlock Model & Topic Health', requiresSavedInstance: true },
  { path: '/topics', heading: 'Choose an instance to unlock AI Semantic Studio', requiresSavedInstance: true },
  { path: '/semantic-migrations', heading: 'Choose an instance to unlock BI Migration Studio', requiresSavedInstance: true },
  { path: '/admin/fleet/instances', heading: 'Instance Manager' },
  { path: '/admin/fleet/connections', heading: 'Choose an instance to unlock Connection Health', requiresSavedInstance: true },
  { path: '/admin/content/uploads', heading: 'Choose an instance to unlock Upload Governance', requiresSavedInstance: true },
  { path: '/admin/content/health', heading: 'Choose an instance to unlock Content Health', requiresSavedInstance: true },
  { path: '/admin/content/labels', heading: 'Choose an instance to unlock Labels', requiresSavedInstance: true },
  { path: '/admin/content/schedules', heading: 'Choose an instance to unlock Schedules', requiresSavedInstance: true },
  { path: '/admin/identity/users', heading: 'Choose an instance to unlock User Management', requiresSavedInstance: true },
  { path: '/admin/developer/embeds', heading: 'Choose an instance to unlock Embed URLs', requiresSavedInstance: true },
  { path: '/history', heading: 'Operation History' },
  { path: '/data-privacy', heading: 'Data & Privacy' },
];

const VIEWPORTS = [
  { label: 'desktop', width: 1440, height: 900 },
  { label: '768px', width: 768, height: 1024 },
  { label: '390px', width: 390, height: 844 },
  { label: '320px', width: 320, height: 720 },
] as const;

async function resetVault(request: APIRequestContext) {
  const response = await request.delete('/api/vault/reset');
  expect(response.ok()).toBeTruthy();
}

async function unlockVault(request: APIRequestContext) {
  const response = await request.post('/api/vault/unlock', { data: { passphrase: PASSPHRASE } });
  expect(response.ok()).toBeTruthy();
}

async function closeWalkthrough(page: Page) {
  const close = page.getByRole('button', { name: 'Close walkthrough' });
  if (await close.isVisible().catch(() => false)) await close.click();
}

async function expectNoHorizontalPageOverflow(page: Page, context: string) {
  await expect.poll(
    () => page.evaluate(() => {
      const root = document.documentElement;
      const body = document.body;
      return Math.max(
        root.scrollWidth - root.clientWidth,
        body.scrollWidth - body.clientWidth,
      );
    }),
    { message: `${context} introduced horizontal page overflow` },
  ).toBeLessThanOrEqual(0);
}

async function openPrimaryRoute(page: Page, route: PrimaryRoute) {
  const response = await page.goto(route.path);
  expect(response?.ok(), `${route.path} did not return a successful document response`).toBeTruthy();
  await closeWalkthrough(page);

  await expect(page).toHaveURL(route.path);
  await expect(page.getByRole('heading', { name: route.heading, exact: true }).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#main-content')).not.toBeEmpty();
  await expect(page.locator('#root')).not.toContainText(
    /Unexpected Application Error|Application error|Cannot GET|404 Not Found|Internal Server Error/i,
  );

  if (route.requiresSavedInstance) {
    await expect(page.getByText('Saved instance required', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Go to Home' })).toBeVisible();
  }
}

test.beforeEach(async ({ request }) => {
  await resetVault(request);
});

test.afterEach(async ({ request }) => {
  await resetVault(request);
});

for (const viewport of VIEWPORTS) {
  test(`primary routes render without blank, error, or overflow surfaces at ${viewport.label}`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(`${page.url()}: ${error.message}`));

    for (const route of PRIMARY_ROUTES) {
      await openPrimaryRoute(page, route);
      await expectNoHorizontalPageOverflow(page, `${route.path} at ${viewport.width}px`);
      expect(pageErrors, `page errors while opening ${route.path} at ${viewport.width}px`).toEqual([]);
    }
  });
}

test('mobile navigation supports keyboard toggling, focus containment, Escape, and route-close', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await closeWalkthrough(page);
  await expect(page.getByRole('heading', { name: 'Your Omni command center.', exact: true })).toBeVisible();

  const toggle = page.locator('button[aria-controls="mobile-navigation-drawer"]');
  const drawer = page.locator('#mobile-navigation-drawer');
  const focusable = drawer.locator('a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])');

  await toggle.focus();
  await toggle.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(drawer).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('hidden');
  await expect(drawer).toHaveAttribute('aria-hidden', 'false');
  await expect(focusable.first()).toBeFocused();

  await page.keyboard.press('Shift+Tab');
  await expect(focusable.last()).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(focusable.first()).toBeFocused();

  await toggle.focus();
  await toggle.press('Enter');
  await expect(drawer).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toBeFocused();

  await toggle.press('Space');
  await expect(drawer).toBeVisible();
  await expect(focusable.first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('');
  await expect(toggle).toBeFocused();

  await toggle.press('Enter');
  await expect(drawer).toBeVisible();
  await drawer.getByRole('button', { name: 'Administration', exact: true }).click();
  await drawer.getByRole('link', { name: 'Fleet & Readiness', exact: true }).click();
  await expect(page).toHaveURL('/admin/fleet/instances');
  await expect(page.getByRole('heading', { name: 'Instance Manager', exact: true })).toBeVisible();
  await expect(drawer).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#main-content')).toBeFocused();
});

test('instance disclosure preserves entered form state when collapsed and reopened', async ({ page, request }) => {
  await unlockVault(request);
  await page.goto('/admin/fleet/instances');
  await closeWalkthrough(page);
  await expect(page.getByRole('heading', { name: 'Add instance', exact: true })).toBeVisible();

  const disclosure = page.locator('details').filter({ hasText: 'Optional defaults, filters, and actions' });
  const summary = disclosure.locator('summary');
  const modelId = page.getByPlaceholder('Paste model ID manually');
  const folderPath = page.getByPlaceholder('Default folder path, e.g. Shared/Migrations');
  const appLabel = page.getByLabel('Legacy App label fallback (optional)');

  await summary.click();
  await expect(disclosure).toHaveJSProperty('open', true);
  await modelId.fill('model-ui-hardening-fixture');
  await folderPath.fill('Shared/UI Hardening Fixture');
  await appLabel.fill('ui-hardening-fixture');

  await summary.click();
  await expect(disclosure).toHaveJSProperty('open', false);
  await expect(modelId).toBeHidden();
  await summary.click();
  await expect(disclosure).toHaveJSProperty('open', true);

  await expect(modelId).toHaveValue('model-ui-hardening-fixture');
  await expect(folderPath).toHaveValue('Shared/UI Hardening Fixture');
  await expect(appLabel).toHaveValue('ui-hardening-fixture');
});

test('locked Home uses the inline Omni wordmark and loads every required visible image', async ({ page }) => {
  const imageFailures: string[] = [];
  const legacyLogoRequests: string[] = [];
  const externalFontRequests: string[] = [];

  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/omni-logo.webp') legacyLogoRequests.push(request.url());
    if (request.resourceType() === 'font' && new URL(request.url()).origin !== new URL(page.url()).origin) {
      externalFontRequests.push(request.url());
    }
  });
  page.on('requestfailed', (request) => {
    if (request.resourceType() === 'image') {
      imageFailures.push(`${request.url()}: ${request.failure()?.errorText || 'request failed'}`);
    }
  });
  page.on('response', (response) => {
    if (response.request().resourceType() === 'image' && response.status() >= 400) {
      imageFailures.push(`${response.url()}: HTTP ${response.status()}`);
    }
  });

  await page.goto('/');
  await closeWalkthrough(page);
  await expect(page.getByRole('heading', { name: 'Your Omni command center.', exact: true })).toBeVisible();

  const homeLogo = page.getByRole('img', { name: 'Omni Kit, Home', exact: true });
  const wordmark = homeLogo.locator('svg');
  await expect(homeLogo).toBeVisible();
  await expect(wordmark).toHaveAttribute('viewBox', '0 0 88 36');
  await expect(homeLogo.locator('img')).toHaveCount(0);

  const fonts = await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([
      document.fonts.load('400 24px "Cal Sans"'),
      document.fonts.load('400 14px "IBM Plex Sans"'),
      document.fonts.load('500 12px "IBM Plex Mono"'),
    ]);
    return {
      heading: getComputedStyle(document.querySelector('h1')!).fontFamily,
      body: getComputedStyle(document.body).fontFamily,
      calSansReady: document.fonts.check('400 24px "Cal Sans"'),
      plexSansReady: document.fonts.check('400 14px "IBM Plex Sans"'),
      plexMonoReady: document.fonts.check('500 12px "IBM Plex Mono"'),
    };
  });
  expect(fonts.heading).toContain('Cal Sans');
  expect(fonts.body).toContain('IBM Plex Sans');
  expect(fonts.calSansReady).toBe(true);
  expect(fonts.plexSansReady).toBe(true);
  expect(fonts.plexMonoReady).toBe(true);

  const visibleHomeImages = page.locator('#main-content img:visible');
  await expect.poll(() => visibleHomeImages.count()).toBeGreaterThan(0);
  await expect.poll(() => visibleHomeImages.evaluateAll((images) => images.every((image) => {
    const element = image as HTMLImageElement;
    return element.complete && element.naturalWidth > 0;
  }))).toBe(true);
  await page.waitForLoadState('networkidle');

  expect(legacyLogoRequests).toEqual([]);
  expect(externalFontRequests).toEqual([]);
  expect(imageFailures).toEqual([]);
});

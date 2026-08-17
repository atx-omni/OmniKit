import { expect, test, type Page, type Route } from '@playwright/test';

interface InstanceFixture {
  id: string;
  label: string;
  role: 'source' | 'destination' | 'both';
  baseUrl: string;
  apiKeyMasked: string;
  metricFilter: {
    connectionDatabaseContains: string[];
    connectionDatabaseExact: string[];
    embedExternalIdContains: string[];
    embedExternalIdExact: string[];
  };
  postMigrationActions: unknown[];
  createdAt: string;
  updatedAt: string;
  lastValidatedAt: string;
}

interface ReadinessRequest {
  sourceInstanceId?: string;
  targetInstanceId?: string;
  sourceModelIds?: string[];
  targetModelBySourceId?: Record<string, string>;
  forceRefresh?: boolean;
}

interface ModelMigratorEvidence {
  connectionRequests: string[];
  modelRequests: string[];
  inventoryRequests: string[];
  readinessRequests: ReadinessRequest[];
  readinessFailures: string[];
  pageErrors: string[];
  portfolioRequestStartedAt?: number;
}

interface ModelMigratorMockOptions {
  sourceModelCount?: number;
  targetModels?: Array<Record<string, unknown>>;
  instances?: InstanceFixture[];
  connectionsByInstance?: Record<string, Array<Record<string, unknown>>>;
  modelsByInstance?: Record<string, Array<Record<string, unknown>>>;
  onReadiness?: (route: Route, body: ReadinessRequest, requestIndex: number) => Promise<void>;
}

const now = '2026-08-15T12:00:00.000Z';
const sourceInstance = instance('example-source-instance', 'Example source instance');
const targetInstance = instance('example-target-instance', 'Example target instance');

function instance(id: string, label: string): InstanceFixture {
  return {
    id,
    label,
    role: 'both',
    baseUrl: `https://${id}.invalid`,
    apiKeyMasked: 'omni_...example',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
    createdAt: now,
    updatedAt: now,
    lastValidatedAt: now,
  };
}

function sourceModels(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const suffix = String(index + 1).padStart(4, '0');
    return {
      id: `example-source-model-${suffix}`,
      name: `Example Source Model ${suffix}`,
      identifier: `example_source_model_${suffix}`,
      connectionId: 'example-source-connection',
      connectionName: 'Example source connection',
      kind: 'SHARED',
      gitConfigured: false,
      updatedAt: now,
    };
  });
}

function defaultTargetModels() {
  return [{
    id: 'example-target-model-a',
    name: 'Example Source Model 0001',
    identifier: 'example_target_model_a',
    connectionId: 'example-target-connection',
    connectionName: 'Example target connection',
    kind: 'SHARED',
    updatedAt: now,
  }, {
    id: 'example-target-model-b',
    name: 'Example alternate target model',
    identifier: 'example_target_model_b',
    connectionId: 'example-target-connection',
    connectionName: 'Example target connection',
    kind: 'SHARED',
    updatedAt: now,
  }];
}

function readinessResult(body: ReadinessRequest, label = 'Latest readiness result') {
  const sourceModelId = body.sourceModelIds?.[0] || 'example-source-model-0001';
  const targetModelId = body.targetModelBySourceId?.[sourceModelId] || 'example-target-model-a';
  const instanceEvidence = (fixture: InstanceFixture) => ({
    instanceId: fixture.id,
    label: fixture.label,
    baseUrlHost: new URL(fixture.baseUrl).host,
    role: fixture.role,
    reachable: true,
    connections: 1,
    sharedModels: 1,
    schemaModels: 1,
    checks: [],
  });
  return {
    readiness: {
      source: instanceEvidence(sourceInstance),
      target: instanceEvidence(targetInstance),
      pairs: [{
        sourceModelId,
        targetModelId,
        status: 'ready',
        recommendedPath: 'translate',
        releaseMode: 'direct',
        checks: [],
      }],
      summary: {
        status: 'ready',
        label,
        blockers: 0,
        warnings: 0,
      },
    },
  };
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function closeWalkthrough(page: Page) {
  const close = page.getByRole('button', { name: 'Close walkthrough' });
  if (await close.isVisible().catch(() => false)) await close.click();
}

async function prepareModelMigrator(page: Page, options: ModelMigratorMockOptions = {}) {
  const evidence: ModelMigratorEvidence = {
    connectionRequests: [],
    modelRequests: [],
    inventoryRequests: [],
    readinessRequests: [],
    readinessFailures: [],
    pageErrors: [],
  };
  const activeConnection = {
    baseUrl: sourceInstance.baseUrl,
    apiKey: `__omnikit_vault_instance__:${sourceInstance.id}`,
    status: 'success',
    connectionMode: 'vault',
    instanceId: sourceInstance.id,
    instanceLabel: sourceInstance.label,
    apiKeyMasked: sourceInstance.apiKeyMasked,
  };
  await page.addInitScript((connection) => {
    window.sessionStorage.setItem('omnikit:activeConnection:v1', JSON.stringify(connection));
  }, activeConnection);
  page.on('pageerror', (error) => evidence.pageErrors.push(error.message));
  page.on('requestfailed', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/model-migrator/readiness') {
      evidence.readinessFailures.push(request.failure()?.errorText || 'request failed');
    }
  });

  const sourceCatalog = sourceModels(options.sourceModelCount ?? 1);
  const targetCatalog = options.targetModels ?? defaultTargetModels();
  const availableInstances = options.instances ?? [sourceInstance, targetInstance];
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/vault/status') {
      return json(route, {
        unlocked: true,
        exists: true,
        path: '[local vault]',
        instanceCount: 2,
        idleTimeoutMs: 1_800_000,
        lastActivityAt: Date.now(),
      });
    }
    if (url.pathname === '/api/vault/touch') return json(route, { ok: true });
    if (url.pathname === '/api/instances' && request.method() === 'GET') {
      return json(route, { instances: availableInstances });
    }
    const connectionMatch = url.pathname.match(/^\/api\/model-migrator\/([^/]+)\/connections$/);
    if (connectionMatch) {
      const instanceId = decodeURIComponent(connectionMatch[1]);
      evidence.connectionRequests.push(instanceId);
      const source = instanceId === sourceInstance.id;
      return json(route, { connections: options.connectionsByInstance?.[instanceId] ?? [{
        id: source ? 'example-source-connection' : 'example-target-connection',
        name: source ? 'Example source connection' : 'Example target connection',
        dialect: 'snowflake',
        database: source ? 'EXAMPLE_SOURCE' : 'EXAMPLE_TARGET',
      }] });
    }
    const modelMatch = url.pathname.match(/^\/api\/model-migrator\/([^/]+)\/models$/);
    if (modelMatch) {
      const instanceId = decodeURIComponent(modelMatch[1]);
      evidence.modelRequests.push(`${instanceId}:${url.searchParams.get('connectionId') || ''}`);
      const catalog = options.modelsByInstance?.[instanceId]
        ?? (instanceId === sourceInstance.id ? sourceCatalog : targetCatalog);
      const connectionId = url.searchParams.get('connectionId') || '';
      return json(route, {
        models: catalog.filter((entry) => !connectionId || entry.connectionId === connectionId),
      });
    }
    if (/^\/api\/model-migrator\/[^/]+\/inventory$/.test(url.pathname)) {
      evidence.inventoryRequests.push(url.searchParams.get('modelIds') || '');
      return json(route, { models: [] });
    }
    if (url.pathname === '/api/model-migrator/readiness') {
      const body = request.postDataJSON() as ReadinessRequest;
      evidence.readinessRequests.push(body);
      if (options.onReadiness) {
        return options.onReadiness(route, body, evidence.readinessRequests.length - 1);
      }
      return json(route, readinessResult(body));
    }
    if (url.pathname === '/api/portfolio-overview') {
      evidence.portfolioRequestStartedAt = Date.now();
      return json(route, { error: 'Synthetic portfolio response.' }, 503);
    }
    if (/^\/api\/instances\/[^/]+\/documents$/.test(url.pathname)) {
      return json(route, { documents: [], inventory: { complete: true } });
    }
    if (url.pathname === '/api/list-models') return json(route, { models: [] });
    if (url.pathname === '/api/list-connections') return json(route, { connections: [] });
    return json(route, {});
  });

  await page.goto('/models/migrate');
  await closeWalkthrough(page);
  await expect(page.getByRole('heading', { name: 'Model Migrator', exact: true })).toBeVisible();
  return evidence;
}

function sourceModelButton(page: Page, suffix = '0001') {
  return page.getByRole('button', { name: new RegExp(`Example Source Model ${suffix}`) });
}

function targetMappingSelect(page: Page) {
  const targetSection = page.locator('section').filter({ hasText: 'Match each source model to the destination model' });
  return targetSection.locator('select').nth(2);
}

test('initial load chooses a distinct target and bounds catalog requests without speculative readiness', async ({ page }) => {
  const evidence = await prepareModelMigrator(page);

  await expect(page.getByRole('combobox', { name: 'Source instance', exact: true })).toHaveValue(sourceInstance.id);
  await expect(page.getByRole('combobox', { name: 'Target instance', exact: true })).toHaveValue(targetInstance.id);
  await expect.poll(() => evidence.connectionRequests.length).toBe(2);
  expect([...evidence.connectionRequests].sort()).toEqual([sourceInstance.id, targetInstance.id].sort());
  await expect.poll(() => evidence.modelRequests.length).toBe(2);
  expect([...evidence.modelRequests].sort()).toEqual([
    `${sourceInstance.id}:example-source-connection`,
    `${targetInstance.id}:example-target-connection`,
  ].sort());
  await page.waitForTimeout(500);
  expect(evidence.connectionRequests).toHaveLength(2);
  expect(evidence.modelRequests).toHaveLength(2);
  expect(evidence.readinessRequests).toHaveLength(0);
  expect(evidence.pageErrors).toEqual([]);
});

test('a complete model pair runs readiness once and an unchanged mapping does not retrigger it', async ({ page }) => {
  const evidence = await prepareModelMigrator(page);

  await sourceModelButton(page).click();
  await expect.poll(() => evidence.readinessRequests.length).toBe(1);
  await expect(page.getByTestId('model-migrator-readiness')).toContainText('Latest readiness result');
  await targetMappingSelect(page).selectOption('example-target-model-a');
  await page.waitForTimeout(500);
  expect(evidence.readinessRequests).toHaveLength(1);
  expect(evidence.readinessRequests[0].targetModelBySourceId).toEqual({
    'example-source-model-0001': 'example-target-model-a',
  });
  expect(evidence.pageErrors).toEqual([]);
});

test('rapid source-model selection coalesces into one inventory request for the final scope', async ({ page }) => {
  const evidence = await prepareModelMigrator(page, { sourceModelCount: 3 });

  await sourceModelButton(page, '0001').click();
  await sourceModelButton(page, '0002').click();
  await sourceModelButton(page, '0003').click();

  await expect.poll(() => evidence.inventoryRequests.length).toBe(1);
  expect(evidence.inventoryRequests).toEqual([
    [
      'example-source-model-0001',
      'example-source-model-0002',
      'example-source-model-0003',
    ].join(','),
  ]);
  expect(evidence.pageErrors).toEqual([]);
});

test('rapid target changes abort stale readiness and only the latest result commits', async ({ page }) => {
  let releaseStale!: () => void;
  const staleGate = new Promise<void>((resolve) => { releaseStale = resolve; });
  const evidence = await prepareModelMigrator(page, {
    onReadiness: async (route, body, requestIndex) => {
      if (requestIndex === 0) {
        await staleGate;
        await json(route, readinessResult(body, 'Stale readiness result')).catch(() => undefined);
        return;
      }
      await json(route, readinessResult(body, 'Latest target readiness'));
    },
  });

  await sourceModelButton(page).click();
  await expect.poll(() => evidence.readinessRequests.length).toBe(1);
  await targetMappingSelect(page).selectOption('example-target-model-b');
  await expect.poll(() => evidence.readinessRequests.length).toBe(2);
  await expect(page.getByTestId('model-migrator-readiness')).toContainText('Latest target readiness');
  releaseStale();
  await page.waitForTimeout(300);
  await expect(page.getByTestId('model-migrator-readiness')).not.toContainText('Stale readiness result');
  expect(evidence.readinessRequests[1].targetModelBySourceId).toEqual({
    'example-source-model-0001': 'example-target-model-b',
  });
  expect(evidence.readinessFailures.length).toBeGreaterThanOrEqual(1);
  expect(evidence.pageErrors).toEqual([]);
});

test('saved post-actions never restore or persist and every target scope change clears the live choice', async ({ page }) => {
  const action = {
    kind: 'webhook',
    name: 'Validate repaired model',
    method: 'POST',
    url: 'https://hooks.example.test/validate',
    headers: {},
    body: '',
  };
  const targetWithAction = { ...targetInstance, postMigrationActions: [action] };
  const alternateTarget = {
    ...instance('alternate-target-instance', 'Alternate target instance'),
    role: 'destination' as const,
    postMigrationActions: [{ ...action, name: 'Validate alternate model' }],
  };
  const mutableTargetModels = [...defaultTargetModels(), {
    id: 'example-target-model-c',
    name: 'Connection B target model',
    identifier: 'example_target_model_c',
    connectionId: 'example-target-connection-b',
    connectionName: 'Example target connection B',
    kind: 'SHARED',
    updatedAt: now,
  }];
  await page.addInitScript(() => {
    window.sessionStorage.setItem('omnikit:modelMigratorDraft:v1', JSON.stringify({
      schemaMapText: 'ANALYTICS.PUBLIC -> main.analytics',
      selectedPostActionIndexes: [0, 4],
    }));
  });
  await prepareModelMigrator(page, {
    instances: [{ ...sourceInstance, role: 'source' }, targetWithAction, alternateTarget],
    connectionsByInstance: {
      [sourceInstance.id]: [{
        id: 'example-source-connection',
        name: 'Example source connection',
        dialect: 'snowflake',
        database: 'EXAMPLE_SOURCE',
      }],
      [targetInstance.id]: [{
        id: 'example-target-connection',
        name: 'Example target connection',
        dialect: 'snowflake',
        database: 'EXAMPLE_TARGET',
      }, {
        id: 'example-target-connection-b',
        name: 'Example target connection B',
        dialect: 'snowflake',
        database: 'EXAMPLE_TARGET_B',
      }],
      [alternateTarget.id]: [{
        id: 'alternate-target-connection',
        name: 'Alternate target connection',
        dialect: 'snowflake',
        database: 'ALTERNATE_TARGET',
      }],
    },
    modelsByInstance: {
      [sourceInstance.id]: sourceModels(1),
      [targetInstance.id]: mutableTargetModels,
      [alternateTarget.id]: [{
        id: 'alternate-target-model',
        name: 'Alternate target model',
        identifier: 'alternate_target_model',
        connectionId: 'alternate-target-connection',
        connectionName: 'Alternate target connection',
        kind: 'SHARED',
        updatedAt: now,
      }],
    },
  });

  const savedAction = page.getByRole('checkbox', { name: /Validate repaired model/ });
  await expect(savedAction).not.toBeChecked();
  const restoredDraft = await page.evaluate(() => JSON.parse(
    window.sessionStorage.getItem('omnikit:modelMigratorDraft:v1') || '{}',
  ));
  expect(restoredDraft.selectedPostActionIndexes).toEqual([]);

  await sourceModelButton(page).click();
  await savedAction.check();
  await page.getByRole('checkbox', { name: /Publish drafts when validated model changes/ }).check();
  await expect.poll(async () => page.evaluate(() => (
    JSON.parse(window.sessionStorage.getItem('omnikit:modelMigratorDraft:v1') || '{}')
      .selectedPostActionIndexes
  ))).toEqual([]);
  await targetMappingSelect(page).selectOption('example-target-model-b');
  await expect(savedAction).not.toBeChecked();

  await savedAction.check();
  await page.getByRole('combobox', { name: 'Target connection', exact: true })
    .selectOption('example-target-connection-b');
  await expect(savedAction).not.toBeChecked();

  await savedAction.check();
  await page.getByRole('combobox', { name: 'Target instance', exact: true })
    .selectOption(alternateTarget.id);
  await expect(page.getByRole('checkbox', { name: /Validate alternate model/ })).not.toBeChecked();
  await page.getByRole('combobox', { name: 'Target instance', exact: true })
    .selectOption(targetInstance.id);
  await expect(page.getByRole('checkbox', { name: /Validate repaired model/ })).not.toBeChecked();

  const restoredAction = page.getByRole('checkbox', { name: /Validate repaired model/ });
  if (await sourceModelButton(page).getAttribute('aria-pressed') !== 'true') {
    await sourceModelButton(page).click();
  }
  await expect(targetMappingSelect(page)).not.toHaveValue('');
  await restoredAction.check();
  const automaticallyReplacedModelId = await targetMappingSelect(page).inputValue();
  const removedIndex = mutableTargetModels.findIndex((entry) => entry.id === automaticallyReplacedModelId);
  expect(removedIndex).toBeGreaterThanOrEqual(0);
  mutableTargetModels.splice(removedIndex, 1);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(targetMappingSelect(page)).not.toHaveValue(automaticallyReplacedModelId);
  await expect(restoredAction).not.toBeChecked();

  const persistedDraft = await page.evaluate(() => window.sessionStorage.getItem('omnikit:modelMigratorDraft:v1') || '');
  expect(persistedDraft).not.toMatch(/selectedPostActionIndexes":\s*\[(?:\s*\d)/);
});

test('leaving during readiness cancels stale work and starts the next screen request promptly', async ({ page }) => {
  let releaseReadiness!: () => void;
  const readinessGate = new Promise<void>((resolve) => { releaseReadiness = resolve; });
  const evidence = await prepareModelMigrator(page, {
    onReadiness: async (route, body) => {
      await readinessGate;
      await json(route, readinessResult(body, 'Released stale readiness')).catch(() => undefined);
    },
  });

  await sourceModelButton(page).click();
  await expect.poll(() => evidence.readinessRequests.length).toBe(1);
  const navigationStartedAt = Date.now();
  await page.getByRole('link', { name: /^Home(?:\s|$)/ }).click();
  await expect.poll(() => evidence.portfolioRequestStartedAt).not.toBeUndefined();
  expect(evidence.portfolioRequestStartedAt! - navigationStartedAt).toBeLessThan(1_000);
  await expect.poll(() => evidence.readinessFailures.length).toBeGreaterThanOrEqual(1);
  releaseReadiness();
  expect(evidence.pageErrors).toEqual([]);
});

for (const failure of [{
  name: 'timeout',
  status: 504,
  code: 'MODEL_MIGRATOR_READINESS_TIMEOUT',
  serverMessage: 'Readiness timed out. Retry the check.',
  visibleMessage: 'The readiness check took too long. Retry this model pairing when Omni is responsive.',
}, {
  name: 'rate limit',
  status: 429,
  code: 'MODEL_MIGRATOR_UPSTREAM_RATE_LIMITED',
  serverMessage: 'Omni is rate limiting this readiness check. Retry shortly.',
  visibleMessage: 'Omni is handling too many requests right now. Wait a moment, then retry this model pairing.',
}, {
  name: 'catalog failure',
  status: 502,
  code: 'MODEL_MIGRATOR_CATALOG_INCOMPLETE',
  serverMessage: 'Omni returned an incomplete model catalog. Retry the check.',
  visibleMessage: 'Omni returned an incomplete model catalog. Retry the check.',
}]) {
  test(`${failure.name} keeps migration blocked and offers an explicit readiness retry`, async ({ page }) => {
    const evidence = await prepareModelMigrator(page, {
      onReadiness: async (route, body, requestIndex) => {
        if (requestIndex === 0) {
          await json(route, { error: failure.serverMessage, code: failure.code, retryable: true }, failure.status);
          return;
        }
        await json(route, readinessResult(body, 'Readiness recovered'));
      },
    });

    await sourceModelButton(page).click();
    const readiness = page.getByTestId('model-migrator-readiness');
    await expect(readiness).toContainText(failure.visibleMessage);
    await expect(readiness.getByRole('button', { name: 'Retry readiness' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stage and validate migration' })).toBeDisabled();
    await readiness.getByRole('button', { name: 'Retry readiness' }).click();
    await expect.poll(() => evidence.readinessRequests.length).toBe(2);
    await expect(readiness).toContainText('Readiness recovered');
    expect(evidence.readinessRequests[1].forceRefresh).toBe(true);
    expect(evidence.pageErrors).toEqual([]);
  });
}

test('large source catalogs render 100 rows initially and preserve progressive reachability', async ({ page }) => {
  const evidence = await prepareModelMigrator(page, { sourceModelCount: 250 });
  const list = page.getByTestId('model-migrator-source-model-list');
  const modelRows = list.locator('button[aria-pressed]');

  await expect(page.getByText('Showing 100 of 250 models · 0 selected', { exact: true })).toBeVisible();
  await expect(modelRows).toHaveCount(100);
  await page.getByRole('button', { name: 'Show 100 more models' }).click();
  await expect(page.getByText('Showing 200 of 250 models · 0 selected', { exact: true })).toBeVisible();
  await expect(modelRows).toHaveCount(200);
  await page.getByRole('button', { name: 'Show 50 more models' }).click();
  await expect(page.getByText('Showing 250 of 250 models · 0 selected', { exact: true })).toBeVisible();
  await expect(sourceModelButton(page, '0249')).toBeVisible();
  await expect(modelRows).toHaveCount(250);
  expect(evidence.readinessRequests).toHaveLength(0);
  expect(evidence.pageErrors).toEqual([]);
});

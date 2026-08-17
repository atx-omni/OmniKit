import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page, type Route } from '@playwright/test';

const PASSPHRASE = 'portfolio overview browser test passphrase';

type SeededConnection = Record<string, unknown>;

interface MetricFixtureOptions {
  asOf?: string;
  coverage?: { included: number; total: number; unit: 'instances' | 'connections' | 'endpoints' | 'model_kinds'; ratio: number | null };
  exclusions?: string[];
  reasonLabel?: string;
  source?: string;
}

function metric(
  value: number | null,
  status = 'available',
  reasonCode: string | null = null,
  options: MetricFixtureOptions = {},
) {
  return {
    value,
    status,
    asOf: options.asOf || '2026-08-06T15:00:00.000Z',
    coverage: options.coverage || {
      included: value === null ? 0 : 1,
      total: 1,
      unit: 'instances' as const,
      ratio: value === null ? 0 : 1,
    },
    exclusions: options.exclusions || [],
    reasonCode,
    ...(options.reasonLabel ? { reasonLabel: options.reasonLabel } : {}),
    source: options.source || 'derived_instance_aggregate',
  };
}

type MetricFixture = ReturnType<typeof metric>;

function metricSet(overrides: Record<string, MetricFixture> = {}) {
  return {
    internalMemberships: metric(120),
    estimatedUniquePeople: metric(98),
    embedUsers: metric(42),
    embedEntities: metric(6),
    active7d: metric(45),
    active30d: metric(86),
    active90d: metric(122),
    staleUsers90d: metric(0, 'available', 'ACTIVE_USER_RECORDS_STALE_90D', {
      coverage: { included: 2, total: 2, unit: 'endpoints', ratio: 1 },
      exclusions: ['ACTIVE_USER_RECORDS_NOT_UNIQUE_PEOPLE', 'INACTIVE_USER_RECORDS'],
      reasonLabel: 'Active internal and embed user records with a parseable last-login timestamp older than 90 days; records are not deduplicated people',
      source: 'derived_identity_activity',
    }),
    neverLoggedInUsers: metric(4, 'available', 'ACTIVE_USER_RECORDS_WITHOUT_LAST_LOGIN', {
      coverage: { included: 2, total: 2, unit: 'endpoints', ratio: 1 },
      exclusions: ['ACTIVE_USER_RECORDS_NOT_UNIQUE_PEOPLE', 'INACTIVE_USER_RECORDS'],
      reasonLabel: 'Active internal and embed user records with no last-login value; records are not deduplicated people',
      source: 'derived_identity_activity',
    }),
    dashboards: metric(34),
    models: metric(8),
    topics: metric(12),
    aiChats: metric(9),
    apps: metric(2),
    ...overrides,
  };
}

type MetricSetFixture = ReturnType<typeof metricSet>;

interface ConnectionFixture {
  id: string;
  name: string;
  instanceId: string;
  instanceLabel: string;
  readiness: 'ready' | 'attention' | 'unavailable' | 'unknown';
  statusLabel: string;
  freshness: string;
  asOf: string;
  attribution: 'explicit' | 'inferred' | 'unknown';
  dashboards: MetricFixture;
  models: MetricFixture;
  topics: MetricFixture;
  detail?: string;
}

function connectionFixture({
  id,
  name,
  instanceId,
  instanceLabel,
  readiness = 'ready',
  freshness = 'available',
  attribution = 'explicit',
  metrics = metricSet(),
  detail,
}: {
  id: string;
  name: string;
  instanceId: string;
  instanceLabel: string;
  readiness?: ConnectionFixture['readiness'];
  freshness?: string;
  attribution?: ConnectionFixture['attribution'];
  metrics?: MetricSetFixture;
  detail?: string;
}): ConnectionFixture {
  return {
    id,
    name,
    instanceId,
    instanceLabel,
    readiness,
    statusLabel: readiness === 'ready' ? 'Ready' : readiness === 'attention' ? 'Needs attention' : readiness === 'unavailable' ? 'Unavailable' : 'Unknown',
    freshness,
    asOf: '2026-08-06T15:00:00.000Z',
    attribution,
    dashboards: metrics.dashboards,
    models: metrics.models,
    topics: metrics.topics,
    ...(detail ? { detail } : {}),
  };
}

function instance(
  id: string,
  label: string,
  health: 'healthy' | 'attention' | 'unavailable',
  connectionId: string,
  options: {
    freshness?: string;
    metricOverrides?: Record<string, MetricFixture>;
    attribution?: ConnectionFixture['attribution'];
    additionalConnections?: ConnectionFixture[];
    duplicateSavedOrigin?: boolean;
    duplicateSavedOriginCount?: number;
    duplicateInstanceLabels?: string[];
    detail?: string;
  } = {},
) {
  const metrics = metricSet(options.metricOverrides);
  const readiness = health === 'healthy' ? 'ready' : health === 'attention' ? 'attention' : 'unavailable';
  const freshness = options.freshness || (health === 'healthy' ? 'available' : health === 'attention' ? 'partial' : 'unavailable');
  const primaryConnection = connectionFixture({
    id: connectionId,
    name: `${label} Warehouse`,
    instanceId: id,
    instanceLabel: label,
    readiness,
    freshness,
    attribution: options.attribution || 'explicit',
    metrics,
    detail: options.detail,
  });
  return {
    id,
    label,
    health,
    statusLabel: health === 'healthy' ? 'Healthy' : health === 'attention' ? 'Needs attention' : 'Unavailable',
    freshness,
    asOf: '2026-08-06T15:00:00.000Z',
    duplicateSavedOrigin: options.duplicateSavedOrigin || false,
    duplicateSavedOriginCount: options.duplicateSavedOriginCount || 1,
    duplicateInstanceLabels: options.duplicateInstanceLabels || [],
    ...(options.detail ? { detail: options.detail } : {}),
    metrics,
    connections: [primaryConnection, ...(options.additionalConnections || [])],
  };
}

type InstanceFixture = ReturnType<typeof instance>;

interface FailureFixture {
  id: string;
  message: string;
  instanceId: string;
  instanceLabel: string;
  metric: string;
  status: string;
  reasonCode: string | null;
  reasonLabel?: string;
  exclusions: string[];
  asOf: string;
  source: string;
  coverage: { included: number; total: number; unit: 'instances' | 'connections' | 'endpoints' | 'model_kinds'; ratio: number | null };
}

function aggregateMetric(value: number | null, total = 2, status = 'available', reasonCode: string | null = null, options: MetricFixtureOptions = {}) {
  return metric(value, status, reasonCode, {
    ...options,
    coverage: options.coverage || {
      included: value === null ? 0 : total,
      total,
      unit: 'instances',
      ratio: value === null || total === 0 ? 0 : 1,
    },
  });
}

function buildOverview(options: {
  instances?: InstanceFixture[];
  metrics?: Record<string, MetricFixture>;
  failures?: FailureFixture[];
  attention?: Array<Record<string, unknown>>;
  duplicateSavedOrigins?: Array<{ canonicalInstanceId: string; instanceLabels: string[]; savedInstanceCount: number }>;
  partial?: boolean;
  stale?: boolean;
  cacheState?: 'fresh' | 'stale';
  generatedAt?: string;
  coverage?: Partial<{
    totalInstances: number;
    reportingInstances: number;
    partialInstances: number;
    staleInstances: number;
    unavailableInstances: number;
    savedInstances: number;
    duplicateSavedOrigins: number;
  }>;
} = {}) {
  const instances = options.instances || [];
  const totalInstances = options.coverage?.totalInstances ?? instances.length;
  const coverage = {
    totalInstances,
    reportingInstances: options.coverage?.reportingInstances ?? instances.filter((entry) => entry.health !== 'unavailable').length,
    partialInstances: options.coverage?.partialInstances ?? instances.filter((entry) => entry.health === 'attention').length,
    staleInstances: options.coverage?.staleInstances ?? instances.filter((entry) => entry.freshness === 'stale').length,
    unavailableInstances: options.coverage?.unavailableInstances ?? instances.filter((entry) => entry.health === 'unavailable').length,
    savedInstances: options.coverage?.savedInstances ?? instances.length,
    duplicateSavedOrigins: options.coverage?.duplicateSavedOrigins ?? (options.duplicateSavedOrigins || []).length,
  };
  return {
    schemaVersion: 1,
    generatedAt: options.generatedAt || '2026-08-06T15:00:00.000Z',
    servedAt: '2026-08-06T15:00:00.000Z',
    cache: { state: options.cacheState || 'fresh', cachedAt: '2026-08-06T15:00:00.000Z' },
    refresh: {
      state: 'idle',
      completedInstances: coverage.reportingInstances,
      totalInstances,
      completedAt: '2026-08-06T15:00:00.000Z',
    },
    coverage,
    metrics: options.metrics || {
      reportingInstances: aggregateMetric(coverage.reportingInstances, totalInstances),
      ...metricSet({
        internalMemberships: aggregateMetric(240, totalInstances),
        estimatedUniquePeople: aggregateMetric(196, totalInstances),
        embedUsers: aggregateMetric(84, totalInstances),
        embedEntities: aggregateMetric(12, totalInstances),
        active7d: aggregateMetric(90, totalInstances),
        active30d: aggregateMetric(172, totalInstances),
        active90d: aggregateMetric(244, totalInstances),
        staleUsers90d: aggregateMetric(0, totalInstances, 'available', 'ACTIVE_USER_RECORDS_STALE_90D', {
          reasonLabel: 'Active internal and embed user records with a parseable last-login timestamp older than 90 days; records are not deduplicated people',
          source: 'derived_identity_activity',
        }),
        neverLoggedInUsers: aggregateMetric(8, totalInstances, 'available', 'ACTIVE_USER_RECORDS_WITHOUT_LAST_LOGIN', {
          reasonLabel: 'Active internal and embed user records with no last-login value; records are not deduplicated people',
          source: 'derived_identity_activity',
        }),
        dashboards: aggregateMetric(68, totalInstances),
        models: aggregateMetric(16, totalInstances),
        topics: aggregateMetric(24, totalInstances),
        aiChats: aggregateMetric(18, totalInstances),
        apps: aggregateMetric(4, totalInstances),
      }),
    },
    instances,
    connections: instances.flatMap((entry) => entry.connections),
    attention: options.attention || [],
    failures: options.failures || [],
    duplicateSavedOrigins: options.duplicateSavedOrigins || [],
    warnings: coverage.partialInstances > 0 ? ['One instance has partial collection coverage.'] : [],
    partial: options.partial ?? (coverage.partialInstances > 0 || coverage.unavailableInstances > 0 || (options.failures || []).length > 0),
    stale: options.stale ?? (coverage.staleInstances > 0 || options.cacheState === 'stale'),
  };
}

const operationsUs = instance('instance-us', 'Operations US', 'healthy', 'connection-us');
const unknownEuropeConnection = connectionFixture({
  id: 'connection-unknown',
  name: 'Operations Europe Unmapped Archive',
  instanceId: 'instance-eu',
  instanceLabel: 'Operations Europe',
  readiness: 'unknown',
  freshness: 'partial',
  attribution: 'unknown',
  detail: 'No documented connection relationship was returned.',
});
const operationsEurope = instance('instance-eu', 'Operations Europe', 'attention', 'connection-eu', {
  additionalConnections: [unknownEuropeConnection],
});
const overview = buildOverview({
  instances: [operationsUs, operationsEurope],
  partial: true,
  coverage: { partialInstances: 1 },
});

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

async function preparePortfolio(
  page: Page,
  request: APIRequestContext,
  payload = overview,
  options: { activeSession?: boolean } = {},
) {
  const connection = await seedConnection(request);
  if (options.activeSession !== false) {
    await page.addInitScript((savedConnection) => {
      window.sessionStorage.setItem('omnikit:activeConnection:v1', JSON.stringify(savedConnection));
    }, connection);
  } else {
    await page.addInitScript(() => {
      window.sessionStorage.removeItem('omnikit:activeConnection:v1');
    });
  }
  await page.route('**/api/portfolio-overview**', (route: Route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(payload),
  }));
  return connection;
}

async function closeWalkthrough(page: Page) {
  const close = page.getByRole('button', { name: 'Close walkthrough' });
  if (await close.isVisible().catch(() => false)) await close.click();
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    return Math.max(root.scrollWidth - root.clientWidth, body.scrollWidth - body.clientWidth);
  })).toBeLessThanOrEqual(0);
}

async function expectNoBlockingAccessibilityViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const blocking = results.violations.filter((violation) => ['serious', 'critical'].includes(violation.impact || ''));
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
}

function expectFleetContext(href: string | null, expected: Record<string, string>) {
  expect(href).toBeTruthy();
  const params = new URL(href!, 'http://127.0.0.1').searchParams;
  for (const [key, value] of Object.entries(expected)) expect(params.get(key), key).toBe(value);
}

function largeOverview(instanceCount: number) {
  const instances = Array.from({ length: instanceCount }, (_, index) => {
    const sequence = String(index + 1).padStart(3, '0');
    return instance(
      `fleet-instance-${sequence}`,
      `Fleet Instance ${sequence}`,
      'healthy',
      `fleet-connection-${sequence}`,
    );
  });
  return buildOverview({
    instances,
    partial: false,
    coverage: {
      totalInstances: instanceCount,
      reportingInstances: instanceCount,
      partialInstances: 0,
      staleInstances: 0,
      unavailableInstances: 0,
      savedInstances: instanceCount,
    },
    metrics: {
      reportingInstances: aggregateMetric(instanceCount, instanceCount),
      ...metricSet({
        internalMemberships: aggregateMetric(instanceCount * 120, instanceCount),
        estimatedUniquePeople: aggregateMetric(instanceCount * 98, instanceCount),
        embedUsers: aggregateMetric(instanceCount * 42, instanceCount),
        embedEntities: aggregateMetric(instanceCount * 6, instanceCount),
        active7d: aggregateMetric(instanceCount * 45, instanceCount),
        active30d: aggregateMetric(instanceCount * 86, instanceCount),
        active90d: aggregateMetric(instanceCount * 122, instanceCount),
        staleUsers90d: aggregateMetric(0, instanceCount, 'available', 'ACTIVE_USER_RECORDS_STALE_90D', {
          reasonLabel: 'Active internal and embed user records with a parseable last-login timestamp older than 90 days; records are not deduplicated people',
          source: 'derived_identity_activity',
        }),
        neverLoggedInUsers: aggregateMetric(instanceCount * 4, instanceCount, 'available', 'ACTIVE_USER_RECORDS_WITHOUT_LAST_LOGIN', {
          reasonLabel: 'Active internal and embed user records with no last-login value; records are not deduplicated people',
          source: 'derived_identity_activity',
        }),
        dashboards: aggregateMetric(instanceCount * 34, instanceCount),
        models: aggregateMetric(instanceCount * 8, instanceCount),
        topics: aggregateMetric(instanceCount * 12, instanceCount),
        aiChats: aggregateMetric(instanceCount * 9, instanceCount),
        apps: aggregateMetric(instanceCount * 2, instanceCount),
      }),
    },
  });
}

function exactEvidenceOverview() {
  const retainedAsOf = '2026-08-05T09:30:00.000Z';
  const permissionDenied = metric(null, 'permission_denied', 'DOCUMENTS_FORBIDDEN', {
    asOf: retainedAsOf,
    coverage: { included: 0, total: 1, unit: 'endpoints', ratio: 0 },
    exclusions: ['AUTHORIZATION_REQUIRED'],
    reasonLabel: 'Documents API authorization was denied',
    source: 'omni_documents_api',
  });
  const unsupported = metric(null, 'unsupported', 'APP_COLLECTION_UNSUPPORTED', {
    asOf: retainedAsOf,
    coverage: { included: 0, total: 1, unit: 'endpoints', ratio: 0 },
    exclusions: ['DOCUMENTED_RELATIONSHIP_UNAVAILABLE'],
    reasonLabel: 'App inventory is unsupported for this source',
    source: 'omni_documents_api',
  });
  const failed = metric(null, 'failed', 'TOPIC_COLLECTION_FAILED', {
    asOf: retainedAsOf,
    coverage: { included: 0, total: 1, unit: 'model_kinds', ratio: 0 },
    exclusions: ['UPSTREAM_READ_FAILED'],
    reasonLabel: 'Topic collection failed without replacing evidence with zero',
    source: 'omni_model_topics_api',
  });
  const healthy = instance('instance-us', 'Operations US', 'healthy', 'connection-us', {
    metricOverrides: { apps: unsupported },
  });
  const impaired = instance('instance-eu', 'Operations Europe', 'attention', 'connection-eu', {
    freshness: 'stale',
    metricOverrides: { dashboards: permissionDenied, topics: failed, apps: unsupported },
    duplicateSavedOrigin: true,
    duplicateSavedOriginCount: 2,
    duplicateInstanceLabels: ['Operations Europe', 'Operations Europe backup'],
    detail: 'The prior successful evidence is stale and newer reads are incomplete.',
  });
  impaired.asOf = retainedAsOf;
  impaired.connections[0]!.asOf = retainedAsOf;

  const failures: FailureFixture[] = [
    {
      id: 'failure-documents-eu',
      message: 'A portfolio metric could not be collected for this instance.',
      instanceId: 'instance-eu',
      instanceLabel: 'Operations Europe',
      metric: 'dashboards',
      status: 'permission_denied',
      reasonCode: 'DOCUMENTS_FORBIDDEN',
      reasonLabel: 'Documents API authorization was denied',
      exclusions: ['AUTHORIZATION_REQUIRED'],
      asOf: retainedAsOf,
      source: 'omni_documents_api',
      coverage: { included: 0, total: 1, unit: 'endpoints', ratio: 0 },
    },
    {
      id: 'failure-apps-eu',
      message: 'The documented source does not support this metric.',
      instanceId: 'instance-eu',
      instanceLabel: 'Operations Europe',
      metric: 'apps',
      status: 'unsupported',
      reasonCode: 'APP_COLLECTION_UNSUPPORTED',
      reasonLabel: 'App inventory is unsupported for this source',
      exclusions: ['DOCUMENTED_RELATIONSHIP_UNAVAILABLE'],
      asOf: retainedAsOf,
      source: 'omni_documents_api',
      coverage: { included: 0, total: 1, unit: 'endpoints', ratio: 0 },
    },
    {
      id: 'failure-topics-eu',
      message: 'The topic read failed while successful instance results were retained.',
      instanceId: 'instance-eu',
      instanceLabel: 'Operations Europe',
      metric: 'topics',
      status: 'failed',
      reasonCode: 'TOPIC_COLLECTION_FAILED',
      reasonLabel: 'Topic collection failed without replacing evidence with zero',
      exclusions: ['UPSTREAM_READ_FAILED'],
      asOf: retainedAsOf,
      source: 'omni_model_topics_api',
      coverage: { included: 0, total: 1, unit: 'model_kinds', ratio: 0 },
    },
  ];

  return buildOverview({
    instances: [healthy, impaired],
    failures,
    partial: true,
    stale: true,
    cacheState: 'stale',
    generatedAt: retainedAsOf,
    duplicateSavedOrigins: [{
      canonicalInstanceId: 'instance-eu',
      instanceLabels: ['Operations Europe', 'Operations Europe backup'],
      savedInstanceCount: 2,
    }],
    coverage: {
      totalInstances: 2,
      reportingInstances: 2,
      partialInstances: 1,
      staleInstances: 1,
      unavailableInstances: 0,
      savedInstances: 3,
      duplicateSavedOrigins: 1,
    },
    metrics: {
      reportingInstances: aggregateMetric(2, 2, 'partial', 'PARTIAL_INSTANCE_COVERAGE'),
      ...metricSet({
        internalMemberships: aggregateMetric(240, 2),
        estimatedUniquePeople: aggregateMetric(196, 2),
        embedUsers: aggregateMetric(84, 2),
        embedEntities: aggregateMetric(12, 2),
        active7d: aggregateMetric(90, 2),
        active30d: aggregateMetric(172, 2),
        active90d: aggregateMetric(244, 2),
        staleUsers90d: aggregateMetric(0, 2, 'available', 'ACTIVE_USER_RECORDS_STALE_90D', {
          asOf: retainedAsOf,
          reasonLabel: 'Active internal and embed user records with a parseable last-login timestamp older than 90 days; records are not deduplicated people',
          source: 'derived_identity_activity',
        }),
        neverLoggedInUsers: aggregateMetric(8, 2, 'partial', 'PARTIAL_NEVER_LOGGED_IN_USER_RECORD_COVERAGE', {
          asOf: retainedAsOf,
          coverage: { included: 1, total: 2, unit: 'instances', ratio: 0.5 },
          exclusions: ['ACTIVE_USER_RECORDS_NOT_UNIQUE_PEOPLE', 'INACTIVE_USER_RECORDS'],
          reasonLabel: 'Partial count of active source records with no last-login value; records are not deduplicated people',
          source: 'derived_identity_activity',
        }),
        dashboards: aggregateMetric(34, 2, 'partial', 'PARTIAL_INSTANCE_COVERAGE', {
          asOf: retainedAsOf,
          coverage: { included: 1, total: 2, unit: 'instances', ratio: 0.5 },
          exclusions: ['DOCUMENTS_FORBIDDEN'],
        }),
        models: aggregateMetric(16, 2),
        topics: aggregateMetric(12, 2, 'partial', 'PARTIAL_INSTANCE_COVERAGE', {
          asOf: retainedAsOf,
          coverage: { included: 1, total: 2, unit: 'instances', ratio: 0.5 },
          exclusions: ['TOPIC_COLLECTION_FAILED'],
        }),
        aiChats: aggregateMetric(18, 2),
        apps: metric(null, 'unsupported', 'APP_COLLECTION_UNSUPPORTED', {
          asOf: retainedAsOf,
          coverage: { included: 0, total: 2, unit: 'instances', ratio: 0 },
          exclusions: ['DOCUMENTED_RELATIONSHIP_UNAVAILABLE'],
          reasonLabel: 'App inventory is unsupported for the selected sources',
          source: 'derived_instance_aggregate',
        }),
      }),
    },
  });
}

test.afterEach(async ({ request }) => {
  await request.delete('/api/vault/reset');
});

test('unlocked vault with saved instances activates the first instance when no browser session exists', async ({ page, request }) => {
  const connection = await preparePortfolio(page, request, overview, { activeSession: false });
  const connectRequests: string[] = [];
  await page.route('**/api/instances/*/connect', async (route) => {
    const instanceId = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3] || '');
    connectRequests.push(instanceId);
    const connectedInstance = {
      id: connection.instanceId,
      label: connection.instanceLabel,
      role: 'both',
      baseUrl: connection.baseUrl,
      apiKeyMasked: connection.apiKeyMasked,
      lastValidatedAt: new Date().toISOString(),
    };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ instance: connectedInstance, connection }),
    });
  });
  await page.goto('/');
  await closeWalkthrough(page);

  await expect(page.getByRole('heading', { name: 'Fleet Command Center', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Portfolio Overview', exact: true })).toBeVisible();
  await expect.poll(() => connectRequests).toEqual([connection.instanceId]);
  await expect.poll(() => page.evaluate(() => {
    const raw = window.sessionStorage.getItem('omnikit:activeConnection:v1');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { instanceId?: string; status?: string };
    return { instanceId: parsed.instanceId, status: parsed.status };
  })).toEqual({ instanceId: connection.instanceId, status: 'success' });

  await page.goto('/connections');
  await expect(page.getByRole('heading', { name: 'Connection Readiness', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Choose an instance to unlock Connection Health', exact: true })).toHaveCount(0);
});

test('Fleet exposes five query-backed views with distinct domain evidence', async ({ page, request }) => {
  await preparePortfolio(page, request);
  await page.goto('/');
  await closeWalkthrough(page);

  const navigation = page.getByRole('navigation', { name: 'Fleet views' });
  const expectations = [
    { link: 'Overview', heading: 'Portfolio Overview', region: 'Portfolio key performance indicators' },
    { link: 'Operational', heading: 'Operational Readiness', region: 'Operational collection summary' },
    { link: 'Adoption', heading: 'Adoption', region: 'Adoption key performance indicators' },
    { link: 'Content', heading: 'Content & Semantic Inventory', region: 'Content key performance indicators' },
    { link: 'Exceptions', heading: 'Exceptions', region: 'Structured scan failures' },
  ] as const;

  for (const expected of expectations) {
    const link = navigation.getByRole('link', { name: new RegExp(`^${expected.link}`) });
    if (expected.link !== 'Overview') await link.click();
    await expect(link).toHaveAttribute('aria-current', 'page');
    await expect(navigation.locator('[aria-current="page"]')).toHaveCount(1);
    await expect(page.getByRole('heading', { name: expected.heading, exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: expected.region })).toBeVisible();
  }

  await expect(page.getByRole('region', { name: 'Duplicate saved origins' })).toBeVisible();
  await expect(page.getByLabel('Environment / tags')).toBeDisabled();
  await expect(page.getByLabel('Environment / tags')).toHaveValue('Unsupported — governed metadata required');
  await expect(page.getByText(/documented, governed metadata source/)).toBeVisible();
});

test('Adoption state follows the selected activity-window evidence instead of operational health', async ({ page, request }) => {
  const operationallyHealthyWithPartialAdoption = instance(
    'adoption-gap',
    'Operationally Healthy Adoption Gap',
    'healthy',
    'adoption-gap-connection',
    {
      metricOverrides: {
        active7d: metric(3, 'partial', 'PARTIAL_ACTIVITY_COVERAGE', {
          coverage: { included: 1, total: 2, unit: 'endpoints', ratio: 0.5 },
          exclusions: ['ACTIVITY_ENDPOINT_INCOMPLETE'],
          source: 'derived_identity_activity',
        }),
        active90d: metric(30, 'available', null, { source: 'derived_identity_activity' }),
      },
    },
  );
  const operationalAttentionWithAvailableAdoption = instance(
    'adoption-reporting',
    'Operational Attention Adoption Reporting',
    'attention',
    'adoption-reporting-connection',
    {
      metricOverrides: {
        active7d: metric(7, 'available', null, { source: 'derived_identity_activity' }),
        active90d: metric(12, 'partial', 'PARTIAL_ACTIVITY_COVERAGE', {
          coverage: { included: 1, total: 2, unit: 'endpoints', ratio: 0.5 },
          exclusions: ['ACTIVITY_ENDPOINT_INCOMPLETE'],
          source: 'derived_identity_activity',
        }),
      },
    },
  );
  const adoptionOverview = buildOverview({
    instances: [operationallyHealthyWithPartialAdoption, operationalAttentionWithAvailableAdoption],
    partial: true,
    coverage: { totalInstances: 2, reportingInstances: 2, partialInstances: 1 },
  });

  await preparePortfolio(page, request, adoptionOverview);
  await page.goto('/?view=adoption&window=7&state=healthy');
  await closeWalkthrough(page);

  const stateFilter = page.getByLabel('Operational/adoption state');
  const comparison = page.getByRole('heading', { name: 'Instance comparison', exact: true }).locator('xpath=ancestor::section[1]');
  await expect(page.getByRole('button', { name: '7d', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(stateFilter).toHaveValue('healthy');
  await expect(comparison.getByRole('link', { name: 'Operational Attention Adoption Reporting', exact: true })).toBeVisible();
  await expect(comparison.getByRole('link', { name: 'Operationally Healthy Adoption Gap', exact: true })).toHaveCount(0);

  await stateFilter.selectOption('attention');
  await expect.poll(() => new URL(page.url()).searchParams.get('state')).toBe('attention');
  await expect(comparison.getByRole('link', { name: 'Operationally Healthy Adoption Gap', exact: true })).toBeVisible();
  await expect(comparison.getByRole('link', { name: 'Operational Attention Adoption Reporting', exact: true })).toHaveCount(0);

  await stateFilter.selectOption('healthy');
  await page.getByRole('button', { name: '90d', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('window')).toBe('90');
  await expect(comparison.getByRole('link', { name: 'Operationally Healthy Adoption Gap', exact: true })).toBeVisible();
  await expect(comparison.getByRole('link', { name: 'Operational Attention Adoption Reporting', exact: true })).toHaveCount(0);
});

test('Adoption lifecycle record cards and drilldowns preserve zero and exact unavailable states', async ({ page, request }) => {
  const lifecycleAsOf = '2026-08-08T14:15:00.000Z';
  const availableZero = metric(0, 'available', 'ACTIVE_USER_RECORDS_STALE_90D', {
    asOf: lifecycleAsOf,
    coverage: { included: 2, total: 2, unit: 'endpoints', ratio: 1 },
    exclusions: ['ACTIVE_USER_RECORDS_NOT_UNIQUE_PEOPLE', 'INACTIVE_USER_RECORDS'],
    reasonLabel: 'Active internal and embed user records with a parseable last-login timestamp older than 90 days; records are not deduplicated people',
    source: 'derived_identity_activity',
  });
  const partialNeverLoggedIn = metric(2, 'partial', 'PARTIAL_NEVER_LOGGED_IN_USER_RECORD_COVERAGE', {
    asOf: lifecycleAsOf,
    coverage: { included: 1, total: 2, unit: 'endpoints', ratio: 0.5 },
    exclusions: ['ACTIVE_USER_RECORDS_NOT_UNIQUE_PEOPLE', 'INACTIVE_USER_RECORDS', 'USERS_WITH_UNPARSEABLE_LAST_LOGIN'],
    reasonLabel: 'Partial count of active source records with no last-login value; records are not deduplicated people',
    source: 'derived_identity_activity',
  });
  const failedStaleRecords = metric(null, 'failed', 'IDENTITY_ACTIVITY_READ_FAILED', {
    asOf: lifecycleAsOf,
    coverage: { included: 0, total: 2, unit: 'endpoints', ratio: 0 },
    exclusions: ['ACTIVE_USER_RECORDS_NOT_UNIQUE_PEOPLE', 'UPSTREAM_READ_FAILED'],
    reasonLabel: 'Identity activity sources failed; a record count is unavailable',
    source: 'derived_identity_activity',
  });
  const unsupportedNeverLoggedIn = metric(null, 'unsupported', 'LAST_LOGIN_EVIDENCE_UNAVAILABLE', {
    asOf: lifecycleAsOf,
    coverage: { included: 0, total: 2, unit: 'endpoints', ratio: 0 },
    exclusions: ['ACTIVE_USER_RECORDS_NOT_UNIQUE_PEOPLE', 'USERS_WITHOUT_LAST_LOGIN'],
    reasonLabel: 'The user inventory did not expose lifecycle evidence',
    source: 'derived_identity_activity',
  });
  const lifecycleOverview = buildOverview({
    instances: [
      instance('lifecycle-zero', 'Lifecycle Available Zero', 'healthy', 'lifecycle-zero-connection', {
        metricOverrides: { staleUsers90d: availableZero, neverLoggedInUsers: partialNeverLoggedIn },
      }),
      instance('lifecycle-failed', 'Lifecycle Failed Evidence', 'attention', 'lifecycle-failed-connection', {
        metricOverrides: { staleUsers90d: failedStaleRecords },
      }),
      instance('lifecycle-unsupported', 'Lifecycle Unsupported Evidence', 'attention', 'lifecycle-unsupported-connection', {
        metricOverrides: { neverLoggedInUsers: unsupportedNeverLoggedIn },
      }),
    ],
    partial: true,
    coverage: { totalInstances: 3, reportingInstances: 3, partialInstances: 2 },
  });

  await preparePortfolio(page, request, lifecycleOverview);
  await page.goto('/?view=adoption&instances=lifecycle-zero&drilldown=instance%3Alifecycle-zero');
  await closeWalkthrough(page);

  const adoptionKpis = page.getByRole('region', { name: 'Adoption key performance indicators' });
  const zeroCard = adoptionKpis.getByRole('link', { name: /^Stale active user records \(90d\): 0\./ });
  await expect(zeroCard).toBeVisible();
  await expect(zeroCard.getByText('0', { exact: true })).toBeVisible();
  await expect(zeroCard.getByText('Complete', { exact: true })).toBeVisible();
  const partialCard = adoptionKpis.getByRole('link', { name: /^Active records without a login timestamp: 2\./ });
  await expect(partialCard.getByText('2', { exact: true })).toBeVisible();
  await expect(partialCard.getByText('Partial', { exact: true })).toBeVisible();
  await expect(partialCard.getByText('0', { exact: true })).toHaveCount(0);
  await expect(adoptionKpis).toContainText('Stale active user records (90d)');
  await expect(adoptionKpis).toContainText('Active records without a login timestamp');
  await expect(adoptionKpis).not.toContainText('Stale users');
  await expect(page.getByLabel('Adoption record count interpretation')).toContainText('record counts, not unique people');

  const availableDrilldown = page.getByTestId('fleet-instance-drilldown');
  const staleEvidence = availableDrilldown.getByTestId('metric-evidence').filter({ hasText: 'Stale active user records (90d)' });
  await expect(staleEvidence).toContainText('available');
  await expect(staleEvidence).toContainText('0');
  await expect(staleEvidence).toContainText('2 of 2 endpoints');
  await expect(staleEvidence).toContainText('derived_identity_activity');
  await expect(staleEvidence).toContainText(lifecycleAsOf);
  await expect(staleEvidence).toContainText('ACTIVE_USER_RECORDS_STALE_90D');
  const partialEvidence = availableDrilldown.getByTestId('metric-evidence').filter({ hasText: 'Active records without a login timestamp' });
  await expect(partialEvidence).toContainText('partial');
  await expect(partialEvidence).toContainText('PARTIAL_NEVER_LOGGED_IN_USER_RECORD_COVERAGE');
  await expect(partialEvidence).toContainText('1 of 2 endpoints');

  await page.goto('/?view=adoption&instances=lifecycle-failed&drilldown=instance%3Alifecycle-failed');
  const failedCard = page.getByRole('region', { name: 'Adoption key performance indicators' })
    .getByRole('link', { name: /^Stale active user records \(90d\): Unavailable\./ });
  await expect(failedCard.getByText('Unavailable', { exact: true }).first()).toBeVisible();
  await expect(failedCard.getByText('0', { exact: true })).toHaveCount(0);
  const failedEvidence = page.getByTestId('fleet-instance-drilldown').getByTestId('metric-evidence').filter({ hasText: 'Stale active user records (90d)' });
  await expect(failedEvidence).toContainText('failed');
  await expect(failedEvidence).toContainText('IDENTITY_ACTIVITY_READ_FAILED');
  await expect(failedEvidence).toContainText('0 of 2 endpoints');

  await page.goto('/?view=adoption&instances=lifecycle-unsupported&drilldown=instance%3Alifecycle-unsupported');
  const unsupportedCard = page.getByRole('region', { name: 'Adoption key performance indicators' })
    .getByRole('link', { name: /^Active records without a login timestamp: Unavailable\./ });
  await expect(unsupportedCard.getByText('Unavailable', { exact: true }).first()).toBeVisible();
  await expect(unsupportedCard.getByText('0', { exact: true })).toHaveCount(0);
  const unsupportedEvidence = page.getByTestId('fleet-instance-drilldown').getByTestId('metric-evidence').filter({ hasText: 'Active records without a login timestamp' });
  await expect(unsupportedEvidence).toContainText('unsupported');
  await expect(unsupportedEvidence).toContainText('LAST_LOGIN_EVIDENCE_UNAVAILABLE');
  await expect(unsupportedEvidence).toContainText('0 of 2 endpoints');
});

test('deep-linked filters, lazy drilldowns, history, and downstream Fleet context stay intact', async ({ page, request }) => {
  await preparePortfolio(page, request);
  await page.goto('/?instances=instance-us&state=healthy&freshness=fresh&window=90&q=Operations%20US');
  await closeWalkthrough(page);

  await expect(page.getByRole('button', { name: '90d', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: '1 of 2 selected' })).toBeVisible();
  await expect(page.getByLabel('Operational/adoption state')).toHaveValue('healthy');
  await expect(page.getByLabel('Freshness')).toHaveValue('fresh');
  await expect(page.getByLabel('Search fleet')).toHaveValue('Operations US');
  await expect(page.getByTestId('fleet-instance-drilldown')).toHaveCount(0);

  await page.getByRole('link', { name: 'Inspect Operations US instance evidence' }).click();
  await expect(page.getByTestId('fleet-instance-drilldown')).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get('drilldown')).toBe('instance:instance-us');
  for (const [key, value] of Object.entries({
    instances: 'instance-us',
    state: 'healthy',
    freshness: 'fresh',
    window: '90',
    q: 'Operations US',
  })) expect(new URL(page.url()).searchParams.get(key), key).toBe(value);

  const instanceWorkflow = page.getByRole('link', { name: 'Open instance workflow with Fleet context' });
  expectFleetContext(await instanceWorkflow.getAttribute('href'), {
    fleetView: 'overview',
    fleetInstances: 'instance-us',
    fleetState: 'healthy',
    fleetFreshness: 'fresh',
    fleetWindow: '90',
    fleetSearch: 'Operations US',
  });

  await page.goBack();
  await expect(page.getByTestId('fleet-instance-drilldown')).toHaveCount(0);
  await expect(page.getByLabel('Search fleet')).toHaveValue('Operations US');
  await page.goForward();
  await expect(page.getByTestId('fleet-instance-drilldown')).toBeVisible();

  await page.getByRole('navigation', { name: 'Fleet views' }).getByRole('link', { name: 'Content', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Content & Semantic Inventory', exact: true })).toBeVisible();
  await expect(page.getByTestId('fleet-instance-drilldown')).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Connection', exact: true }).selectOption('instance-us:connection-us');
  await expect.poll(() => new URL(page.url()).searchParams.get('connection')).toBe('instance-us:connection-us');

  const contentByConnection = page.getByRole('heading', { name: 'Content by connection', exact: true }).locator('xpath=ancestor::section[1]');
  await contentByConnection.getByRole('link', { name: 'Operations US Warehouse', exact: true }).click();
  await expect(page.getByTestId('fleet-connection-drilldown')).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get('drilldown')).toBe('connection:instance-us:connection-us');

  const connectionWorkflow = page.getByRole('link', { name: 'Open connection workflow with Fleet context' });
  expectFleetContext(await connectionWorkflow.getAttribute('href'), {
    fleetView: 'content',
    fleetInstances: 'instance-us',
    fleetConnection: 'instance-us:connection-us',
    fleetState: 'healthy',
    fleetFreshness: 'fresh',
    fleetWindow: '90',
    fleetSearch: 'Operations US',
  });

  await page.goBack();
  await expect(page.getByTestId('fleet-connection-drilldown')).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Connection', exact: true })).toHaveValue('instance-us:connection-us');
  await page.goForward();
  await expect(page.getByTestId('fleet-connection-drilldown')).toBeVisible();

  await page.getByRole('navigation', { name: 'Fleet views' }).getByRole('link', { name: 'Overview', exact: true }).click();
  const reportingInstances = page.getByRole('link', { name: /^Reporting instances: Unavailable\./ });
  await expect(reportingInstances).toBeVisible();
  await expect(reportingInstances.getByText('1', { exact: true })).toHaveCount(0);
  await expect(reportingInstances).toHaveAttribute('title', 'Connection filters do not imply that the parent instance reported connection-scoped evidence.');
});

test('unknown connection attribution stays visible but cannot become a filter claim', async ({ page, request }) => {
  await preparePortfolio(page, request);
  await page.goto('/?view=content&instances=instance-eu&connection=instance-eu%3Aconnection-unknown&drilldown=connection%3Ainstance-eu%3Aconnection-unknown');
  await closeWalkthrough(page);

  await expect.poll(() => new URL(page.url()).searchParams.has('connection')).toBe(false);
  await expect.poll(() => new URL(page.url()).searchParams.get('drilldown')).toBe('connection:instance-eu:connection-unknown');
  const filter = page.getByRole('combobox', { name: /^Connection/ });
  await expect(filter).toHaveValue('');
  await expect(filter.locator('option[value="instance-eu:connection-unknown"]')).toHaveCount(0);
  await expect(page.getByText('1 unknown-attribution connection is visible in evidence but excluded from this filter.')).toBeVisible();

  const drilldown = page.getByTestId('fleet-connection-drilldown');
  await expect(drilldown).toBeVisible();
  await expect(drilldown).toContainText('Operations Europe Unmapped Archive');
  await expect(drilldown).toContainText('Unknown attribution — not filterable or permission evidence');
});

test('partial, stale, unauthorized, unsupported, and failed evidence stays exact without false zeroes', async ({ page, request }) => {
  await preparePortfolio(page, request, exactEvidenceOverview());
  await page.goto('/?view=operational&drilldown=instance%3Ainstance-eu');
  await closeWalkthrough(page);

  await expect(page.getByText('Partial portfolio coverage with stale evidence.', { exact: true })).toBeVisible();
  const operational = page.getByRole('region', { name: 'Operational collection summary' });
  await expect(operational).toContainText('Stale evidence');
  await expect(operational).toContainText('Counted in coverage, excluded from aggregate metric totals');
  await expect(operational).toContainText('1');
  await expect(operational).toContainText('Failed reads');
  await expect(operational).toContainText('3');
  const refreshEvidence = page.getByRole('region', { name: 'Refresh evidence' });
  await expect(refreshEvidence).toContainText('Cache state');
  await expect(refreshEvidence).toContainText('stale');

  const instanceDrilldown = page.getByTestId('fleet-instance-drilldown');
  await expect(instanceDrilldown).toContainText('Freshness: Stale');
  await expect(instanceDrilldown).toContainText('As of: 2026-08-05T09:30:00.000Z');
  const dashboardEvidence = instanceDrilldown.getByTestId('metric-evidence').filter({ hasText: 'Dashboard collection' });
  await expect(dashboardEvidence).toContainText('Unavailable');
  await expect(dashboardEvidence).toContainText('permission denied');
  await expect(dashboardEvidence).toContainText('DOCUMENTS_FORBIDDEN');
  await expect(dashboardEvidence).toContainText('omni_documents_api');
  await expect(dashboardEvidence).toContainText('0 of 1 endpoints');

  await page.getByRole('navigation', { name: 'Fleet views' }).getByRole('link', { name: /^Exceptions/ }).click();
  const failures = page.getByRole('region', { name: 'Structured scan failures' });
  await expect(failures).toContainText('Operations Europe — dashboards');
  await expect(failures).toContainText('permission denied');
  await expect(failures).toContainText('Operations Europe — apps');
  await expect(failures).toContainText('unsupported');
  await expect(failures).toContainText('Operations Europe — topics');
  await expect(failures).toContainText('failed');
  await expect(failures).toContainText('TOPIC_COLLECTION_FAILED');
  await expect(page.getByRole('region', { name: 'Duplicate saved origins' })).toContainText('2 saved profiles share one collected origin');

  await page.getByRole('navigation', { name: 'Fleet views' }).getByRole('link', { name: 'Content', exact: true }).click();
  const contentKpis = page.getByRole('region', { name: 'Content key performance indicators' });
  const dashboards = contentKpis.getByRole('link', { name: /^Dashboards: 34/ });
  await expect(dashboards).toBeVisible();
  await expect(dashboards).toContainText('34');
  const apps = contentKpis.getByRole('link', { name: /^Apps: Unavailable/ });
  await expect(apps).toBeVisible();
  await expect(apps).toContainText('Unavailable');
  await expect(apps).not.toContainText(/^0$/);
});

test('high-cardinality Fleet lists stay bounded and can search beyond the initial batch', async ({ page, request }) => {
  test.setTimeout(120_000);
  await preparePortfolio(page, request, largeOverview(250));
  await page.goto('/');
  await closeWalkthrough(page);

  const comparison = page.getByRole('heading', { name: 'Instance comparison', exact: true }).locator('xpath=ancestor::section[1]');
  await expect(comparison.locator('tbody tr')).toHaveCount(25);
  await expect(page.getByRole('link', { name: 'Fleet Instance 250', exact: true })).toHaveCount(0);
  const showMore = comparison.getByRole('button', { name: 'Show more instances (25 of 250)' });
  await expect(showMore).toBeVisible();
  await showMore.click();
  await expect(comparison.locator('tbody tr')).toHaveCount(50);

  await page.getByLabel('Search fleet').fill('Fleet Instance 250');
  await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe('Fleet Instance 250');
  await expect(comparison.locator('tbody tr')).toHaveCount(1);
  await expect(comparison.getByRole('link', { name: 'Fleet Instance 250', exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
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

test('representative Fleet views have no serious or critical accessibility violations', async ({ page, request }) => {
  await preparePortfolio(page, request, exactEvidenceOverview());
  await page.goto('/');
  await closeWalkthrough(page);

  await expect(page.getByRole('heading', { name: 'Portfolio Overview', exact: true })).toBeVisible();
  await expectNoBlockingAccessibilityViolations(page);

  await page.getByRole('navigation', { name: 'Fleet views' }).getByRole('link', { name: /^Exceptions/ }).click();
  await expect(page.getByRole('heading', { name: 'Exceptions', exact: true })).toBeVisible();
  await expectNoBlockingAccessibilityViolations(page);

  await page.goto('/?view=content&instances=instance-eu&drilldown=connection%3Ainstance-eu%3Aconnection-eu');
  await expect(page.getByTestId('fleet-connection-drilldown')).toBeVisible();
  await expectNoBlockingAccessibilityViolations(page);
});

test('Fleet content and lazy evidence remain responsive at 320px', async ({ page, request }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await preparePortfolio(page, request);
  await page.goto('/?view=content&instances=instance-eu&drilldown=connection%3Ainstance-eu%3Aconnection-unknown');
  await closeWalkthrough(page);

  await expect(page.getByRole('heading', { name: 'Fleet Command Center', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Content & Semantic Inventory', exact: true })).toBeVisible();
  await expect(page.getByTestId('fleet-connection-drilldown')).toContainText('Unknown attribution — not filterable or permission evidence');
  await expect(page.getByRole('navigation', { name: 'Fleet views' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('portfolio-320px.png'), fullPage: true });
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';

import {
  clearPortfolioOverviewCache,
  getPortfolioOverview,
} from '../server/services/portfolioOverview';
import portfolioOverviewHandler from '../server/handlers/portfolio-overview';
import {
  decryptVaultBlob,
  getPortfolioOverviewSnapshot,
  markInstanceValidated,
  normalizeVaultPayload,
  resetVault,
  setPortfolioOverviewSnapshot,
  unlockVault,
  upsertInstance,
} from '../server/services/nativeVault';
import { OmniClient, OmniPaginationError } from '../server/services/omniClient';
import { parsePortfolioOverview } from '../src/services/portfolioOverview';

const testRoot = mkdtempSync(join(tmpdir(), 'omnikit-portfolio-overview-'));
const originalFetch = globalThis.fetch;
const PORTFOLIO_PASSPHRASE = 'portfolio-overview-regression-passphrase';

process.env.OMNIKIT_VAULT_PATH = join(testRoot, 'vault.enc');

beforeEach(() => {
  globalThis.fetch = originalFetch;
  clearPortfolioOverviewCache();
  resetVault();
  delete process.env.OMNIKIT_PORTFOLIO_CACHE_TTL_MS;
  delete process.env.OMNIKIT_PORTFOLIO_STALE_TTL_MS;
  delete process.env.OMNIKIT_PORTFOLIO_SCAN_DEADLINE_MS;
});

after(() => {
  globalThis.fetch = originalFetch;
  clearPortfolioOverviewCache();
  resetVault();
  rmSync(testRoot, { recursive: true, force: true });
  delete process.env.OMNIKIT_VAULT_PATH;
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function metric(value: number | null, status: string, reasonCode: string | null = null) {
  return {
    value,
    status,
    asOf: '2026-08-06T15:00:00.000Z',
    coverage: { included: value === null ? 0 : 1, total: 2, unit: 'instances', ratio: value === null ? 0 : 0.5 },
    exclusions: [],
    reasonCode,
  };
}

function metricSet(overrides: Record<string, ReturnType<typeof metric>> = {}) {
  return {
    internalMemberships: metric(0, 'available'),
    estimatedUniquePeople: metric(0, 'available', 'ESTIMATED_FROM_NORMALIZED_EMAIL'),
    embedUsers: metric(0, 'available'),
    embedEntities: metric(0, 'available'),
    active7d: metric(null, 'unsupported', 'LAST_LOGIN_EVIDENCE_UNAVAILABLE'),
    active30d: metric(null, 'unsupported', 'LAST_LOGIN_EVIDENCE_UNAVAILABLE'),
    active90d: metric(null, 'unsupported', 'LAST_LOGIN_EVIDENCE_UNAVAILABLE'),
    dashboards: metric(0, 'available'),
    models: metric(0, 'available'),
    topics: metric(0, 'available', 'TOPIC_MODEL_RECORDS'),
    aiChats: metric(null, 'not_configured', 'AI_CONVERSATIONS_ORG_KEY_CONFIRMATION_REQUIRED'),
    apps: metric(null, 'not_configured', 'APP_INVENTORY_LABEL_REQUIRED'),
    ...overrides,
  };
}

function storedOverview(instanceId: string, instanceLabel = 'Example workspace') {
  const generatedAt = '2026-08-06T15:00:00.000Z';
  const metrics = metricSet();
  return {
    schemaVersion: 1,
    generatedAt,
    servedAt: generatedAt,
    cache: { state: 'fresh', cachedAt: generatedAt },
    refresh: {
      state: 'idle',
      completedInstances: 1,
      totalInstances: 1,
      completedAt: generatedAt,
    },
    coverage: {
      totalInstances: 1,
      reportingInstances: 1,
      partialInstances: 0,
      staleInstances: 0,
      unavailableInstances: 0,
      savedInstances: 1,
      duplicateSavedOrigins: 0,
    },
    metrics: {
      reportingInstances: metric(1, 'available'),
      ...metrics,
    },
    instances: [{
      id: instanceId,
      label: instanceLabel,
      health: 'healthy',
      statusLabel: 'Healthy',
      freshness: 'available',
      asOf: generatedAt,
      duplicateSavedOrigin: false,
      duplicateSavedOriginCount: 1,
      duplicateInstanceLabels: [],
      metrics,
      connections: [],
    }],
    connections: [],
    duplicateSavedOrigins: [],
    warnings: [],
    partial: false,
    stale: false,
  };
}

function instanceInventoryFingerprint(instances: Array<{
  id: string;
  baseUrl: string;
  updatedAt: string;
  lastValidatedAt?: string;
}>): string {
  const stable = instances.map((instance) => ({
    id: instance.id,
    origin: new URL(instance.baseUrl).origin.toLowerCase(),
    updatedAt: instance.updatedAt,
    lastValidatedAt: instance.lastValidatedAt || null,
  })).sort((left, right) => left.id.localeCompare(right.id));
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

function abortablePendingFetch(onSignal?: (signal: AbortSignal | undefined) => void): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal || undefined;
    onSignal?.(signal);
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  })) as typeof fetch;
}

type PortfolioBody = Record<string, unknown> & {
  cache?: { state?: string };
  coverage?: Record<string, unknown>;
  generatedAt?: string;
  instances?: Array<Record<string, unknown>>;
  metrics?: Record<string, Record<string, unknown>>;
  partial?: boolean;
  refresh?: {
    state?: string;
    startedAt?: string;
    completedAt?: string;
    completedInstances?: number;
    totalInstances?: number;
  };
};

async function responseBody(response: Response): Promise<PortfolioBody> {
  return await response.json() as PortfolioBody;
}

async function waitForPortfolio(
  predicate: (body: PortfolioBody) => boolean,
  timeoutMs = 20_000,
): Promise<PortfolioBody> {
  const deadline = Date.now() + timeoutMs;
  let latest: PortfolioBody = {};
  while (Date.now() < deadline) {
    const response = await portfolioOverviewHandler(new Request('http://localhost/api/portfolio-overview'));
    assert.equal(response.status, 200);
    latest = await responseBody(response);
    if (predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Portfolio condition was not met before timeout. Latest refresh: ${JSON.stringify(latest.refresh)}`);
}

function emptyInventoryResponse(url: URL): Response {
  if (url.pathname.endsWith('/api/v1/connections')) return json({ connections: [] });
  if (url.pathname.endsWith('/api/scim/v2/users') || url.pathname.endsWith('/api/scim/v2/embed/users')) {
    return json({ Resources: [], totalResults: 0, startIndex: 1, itemsPerPage: 0 });
  }
  if (url.pathname.endsWith('/api/v1/models')) return json({ models: [] });
  if (url.pathname.endsWith('/api/v1/documents')) return json({ documents: [] });
  return json({ message: 'Unexpected request' }, 404);
}

test('portfolio endpoint is read-only, vault-gated, and rejects ambiguous refresh input', async () => {
  resetVault();
  clearPortfolioOverviewCache();

  const locked = await portfolioOverviewHandler(new Request('http://localhost/api/portfolio-overview'));
  assert.equal(locked.status, 423);
  assert.deepEqual(await locked.json(), { error: 'VAULT_LOCKED', reasonCode: 'VAULT_LOCKED' });

  unlockVault('portfolio-overview-handler-passphrase');
  const wrongMethod = await portfolioOverviewHandler(new Request('http://localhost/api/portfolio-overview', { method: 'POST' }));
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('Allow'), 'GET');

  const invalidQuery = await portfolioOverviewHandler(new Request('http://localhost/api/portfolio-overview?refresh=1'));
  assert.equal(invalidQuery.status, 400);

  const empty = await portfolioOverviewHandler(new Request('http://localhost/api/portfolio-overview?refresh=true'));
  assert.equal(empty.status, 200);
  const body = await empty.json() as { coverage?: { totalInstances?: number }; metrics?: { dashboards?: { value?: number | null } } };
  assert.equal(body.coverage?.totalInstances, 0);
  assert.equal(body.metrics?.dashboards?.value, null);
});

test('portfolio endpoint returns an explicit first-snapshot refresh state without waiting for upstream reads', async () => {
  unlockVault(PORTFOLIO_PASSPHRASE);
  const saved = upsertInstance({
    label: 'Example first workspace',
    role: 'both',
    baseUrl: 'https://portfolio-first.omniapp.co',
    apiKey: 'omni-first-snapshot-key-not-real',
  });
  markInstanceValidated(saved.id);
  globalThis.fetch = abortablePendingFetch();

  const startedAt = performance.now();
  const response = await portfolioOverviewHandler(new Request('http://localhost/api/portfolio-overview'));
  const elapsedMs = performance.now() - startedAt;
  const body = await responseBody(response);

  assert.equal(response.status, 200);
  assert.ok(elapsedMs < 500, `first portfolio response took ${elapsedMs.toFixed(1)}ms`);
  assert.deepEqual(body.refresh, {
    state: 'running',
    startedAt: body.refresh?.startedAt,
    completedInstances: 0,
    totalInstances: 1,
  });
  assert.equal(typeof body.refresh?.startedAt, 'string');
  assert.equal(body.coverage?.totalInstances, 1);
  assert.deepEqual(body.instances, []);
  assert.equal(body.metrics?.dashboards?.value, null);
  assert.ok(['fresh', 'stale'].includes(body.cache?.state || ''));

  clearPortfolioOverviewCache();
});

test('transient partial scans are persisted and served without starting another scan', async () => {
  process.env.OMNIKIT_PORTFOLIO_CACHE_TTL_MS = '600000';
  unlockVault(PORTFOLIO_PASSPHRASE);
  const saved = upsertInstance({
    label: 'Example partial workspace',
    role: 'both',
    baseUrl: 'https://portfolio-partial.omniapp.co',
    apiKey: 'omni-partial-key-not-real',
  });
  markInstanceValidated(saved.id);

  let requestCount = 0;
  globalThis.fetch = (async (input) => {
    requestCount += 1;
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.endsWith('/api/scim/v2/embed/users')) {
      return json({ message: 'Temporary upstream failure' }, 503);
    }
    return emptyInventoryResponse(url);
  }) as typeof fetch;

  const first = await portfolioOverviewHandler(new Request('http://localhost/api/portfolio-overview'));
  assert.equal(first.status, 200);
  assert.equal((await responseBody(first)).refresh.state, 'running');

  const completed = await waitForPortfolio((body) => body.refresh?.state === 'idle');
  assert.equal(completed.partial, true);
  assert.equal(completed.metrics?.embedUsers?.value, null);
  assert.equal(completed.metrics?.embedUsers?.status, 'failed');
  assert.equal(completed.refresh?.completedInstances, 1);
  assert.equal(completed.refresh?.totalInstances, 1);
  assert.ok(getPortfolioOverviewSnapshot(), 'partial scan was not persisted to the encrypted vault');

  const requestsAfterCompletion = requestCount;
  const startedAt = performance.now();
  const cachedResponse = await portfolioOverviewHandler(new Request('http://localhost/api/portfolio-overview'));
  const elapsedMs = performance.now() - startedAt;
  const cached = await responseBody(cachedResponse);
  assert.ok(elapsedMs < 500, `cached partial response took ${elapsedMs.toFixed(1)}ms`);
  assert.equal(cached.generatedAt, completed.generatedAt);
  assert.equal(cached.refresh?.state, 'idle');
  assert.equal(requestCount, requestsAfterCompletion, 'cached partial result unexpectedly started another scan');
});

test('refresh preserves the previous snapshot and request cancellation does not abort the shared background flight', async () => {
  unlockVault(PORTFOLIO_PASSPHRASE);
  const saved = upsertInstance({
    label: 'Example retained workspace',
    role: 'both',
    baseUrl: 'https://portfolio-retained.omniapp.co',
    apiKey: 'omni-retained-key-not-real',
  });
  const validated = markInstanceValidated(saved.id);
  const fingerprint = instanceInventoryFingerprint([validated]);
  const persisted = storedOverview(validated.id, validated.label);
  setPortfolioOverviewSnapshot({ fingerprint, storedAt: Date.now(), overview: persisted });

  let backgroundSignal: AbortSignal | undefined;
  globalThis.fetch = abortablePendingFetch((signal) => {
    backgroundSignal ||= signal;
  });

  const requestController = new AbortController();
  const response = await portfolioOverviewHandler(new Request(
    'http://localhost/api/portfolio-overview?refresh=true',
    { signal: requestController.signal },
  ));
  const refreshing = await responseBody(response);
  assert.equal(response.status, 200);
  assert.equal(refreshing.generatedAt, persisted.generatedAt);
  assert.equal(refreshing.instances?.[0]?.label, 'Example retained workspace');
  assert.equal(refreshing.refresh?.state, 'running');
  assert.equal(refreshing.refresh?.completedInstances, 0);

  const signalDeadline = Date.now() + 1_000;
  while (!backgroundSignal && Date.now() < signalDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(backgroundSignal, 'background collection did not start');
  requestController.abort();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(backgroundSignal!.aborted, false, 'HTTP request cancellation aborted shared background collection');

  const followUp = await responseBody(await portfolioOverviewHandler(new Request('http://localhost/api/portfolio-overview')));
  assert.equal(followUp.generatedAt, persisted.generatedAt);
  assert.equal(followUp.refresh?.state, 'running');
  assert.equal(followUp.instances?.[0]?.label, 'Example retained workspace');

  clearPortfolioOverviewCache();
});

test('portfolio refresh reports progressive canonical-instance completion', async () => {
  unlockVault(PORTFOLIO_PASSPHRASE);
  for (const [label, host] of [
    ['Example fast workspace', 'portfolio-progress-fast.omniapp.co'],
    ['Example gated workspace', 'portfolio-progress-gated.omniapp.co'],
  ] as const) {
    const saved = upsertInstance({
      label,
      role: 'both',
      baseUrl: `https://${host}`,
      apiKey: `omni-${label.toLowerCase().replace(/\s+/g, '-')}-key-not-real`,
    });
    markInstanceValidated(saved.id);
  }

  let releaseGated: (() => void) | undefined;
  let gatedReleased = false;
  const gated = new Promise<void>((resolve) => {
    releaseGated = () => {
      gatedReleased = true;
      resolve();
    };
  });
  globalThis.fetch = (async (input) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === 'portfolio-progress-gated.omniapp.co' && !gatedReleased) await gated;
    return emptyInventoryResponse(url);
  }) as typeof fetch;

  const initial = await responseBody(await portfolioOverviewHandler(new Request('http://localhost/api/portfolio-overview')));
  assert.equal(initial.refresh?.state, 'running');
  assert.equal(initial.refresh?.totalInstances, 2);

  const midway = await waitForPortfolio(
    (body) => body.refresh?.state === 'running' && body.refresh?.completedInstances === 1,
    15_000,
  );
  assert.equal(midway.coverage?.totalInstances, 2);
  assert.equal(midway.instances?.length, 1);
  releaseGated!();

  const completed = await waitForPortfolio(
    (body) => body.refresh?.state === 'idle' && body.refresh?.completedInstances === 2,
    15_000,
  );
  assert.equal(completed.instances?.length, 2);
  assert.equal(completed.coverage?.reportingInstances, 2);
});

test('vault normalizes legacy payloads and rejects sensitive portfolio snapshot material', () => {
  const legacy = normalizeVaultPayload({
    version: 1,
    instances: [],
    deckRecipes: [],
  }) as unknown as { portfolioOverviewSnapshot?: unknown; migrationProjects: unknown[] };
  assert.equal(legacy.portfolioOverviewSnapshot, undefined);
  assert.deepEqual(legacy.migrationProjects, []);

  unlockVault(PORTFOLIO_PASSPHRASE);
  const safeOverview = storedOverview('opaque-instance-id');
  const safeSnapshot = {
    fingerprint: createHash('sha256').update('safe-snapshot').digest('hex'),
    storedAt: Date.now(),
    overview: safeOverview,
  };
  setPortfolioOverviewSnapshot(safeSnapshot);
  assert.deepEqual(getPortfolioOverviewSnapshot()?.overview, safeOverview);

  const prohibitedSnapshots: Array<[string, Record<string, unknown>]> = [
    ['apiKey', { apiKey: 'omni-sensitive-key' }],
    ['email', { label: 'person@example.invalid' }],
    ['base URL', { label: 'https://private.example.invalid' }],
    ['raw users', { users: [{ id: 'raw-user' }] }],
    ['credentials', { credentials: { token: 'sensitive-token' } }],
    ['raw upstream response', { rawResponse: { records: [] } }],
  ];
  for (const [label, unsafeOverview] of prohibitedSnapshots) {
    assert.throws(
      () => setPortfolioOverviewSnapshot({ ...safeSnapshot, overview: unsafeOverview }),
      undefined,
      `${label} was accepted into the portfolio snapshot`,
    );
  }

  const decrypted = JSON.parse(decryptVaultBlob(PORTFOLIO_PASSPHRASE, readFileSync(process.env.OMNIKIT_VAULT_PATH!))) as {
    portfolioOverviewSnapshot?: { overview?: unknown };
  };
  const serializedSnapshot = JSON.stringify(decrypted.portfolioOverviewSnapshot?.overview);
  for (const prohibited of [
    'omni-sensitive-key',
    'person@example.invalid',
    'https://private.example.invalid',
    'raw-user',
    'sensitive-token',
    'rawResponse',
  ]) {
    assert.equal(serializedSnapshot.includes(prohibited), false, `encrypted snapshot payload retained ${prohibited}`);
  }
});

test('portfolio configuration rejects ambiguous app labels and preserves legacy instances', () => {
  const legacy = normalizeVaultPayload({
    version: 1,
    instances: [{
      id: 'legacy-instance',
      label: 'Legacy workspace',
      role: 'both',
      baseUrl: 'https://1.1.1.1',
      apiKey: 'omni-legacy-key-not-real',
      metricFilter: {},
      postMigrationActions: [],
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    }],
  }) as unknown as { instances: Array<{ organizationApiKeyConfirmed?: boolean; portfolioAppLabel?: string }> };
  assert.equal(legacy.instances[0]?.organizationApiKeyConfirmed, false);
  assert.equal(legacy.instances[0]?.portfolioAppLabel, undefined);

  unlockVault(PORTFOLIO_PASSPHRASE);
  assert.throws(() => upsertInstance({
    label: 'Invalid label workspace',
    role: 'both',
    baseUrl: 'https://1.1.1.1',
    apiKey: 'omni-invalid-label-key-not-real',
    portfolioAppLabel: 'app,production',
  }), /cannot contain commas or control characters/i);
});

test('AI conversation totals reject malformed pagination evidence', async () => {
  globalThis.fetch = (async (input) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    assert.equal(url.pathname, '/api/v1/ai/conversations');
    assert.equal(url.searchParams.get('pageSize'), '1');
    return json({ data: [], pageInfo: { totalRecords: 1.5 } });
  }) as typeof fetch;

  const client = new OmniClient({
    label: 'Malformed AI inventory',
    baseUrl: 'https://1.1.1.1',
    apiKey: 'omni-malformed-ai-key-not-real',
  }, { maxReadRetries: 0 });
  await assert.rejects(() => client.countAiConversations(), OmniPaginationError);
});

test('topic summaries use the model-scoped topic endpoint without reading authored YAML', async () => {
  let requestedPath = '';
  globalThis.fetch = (async (input) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    requestedPath = url.pathname;
    return json({
      success: true,
      topics: [
        { name: 'orders', label: 'Orders', description: 'Curated order analysis.' },
        { name: 'customers', ide_file_name: 'customers.topic' },
      ],
    });
  }) as typeof fetch;

  const client = new OmniClient({
    label: 'Topic inventory workspace',
    baseUrl: 'https://1.1.1.1',
    apiKey: 'omni-topic-inventory-key-not-real',
  }, { maxReadRetries: 0 });
  const topics = await client.listModelTopicSummaries('model-1');

  assert.equal(requestedPath, '/api/v1/models/model-1/topic');
  assert.deepEqual(topics, [
    { name: 'customers', fileName: 'customers.topic' },
    { name: 'orders', label: 'Orders', description: 'Curated order analysis.' },
  ]);
});

test('topic inventory preserves successful model counts when another model is unreadable', async () => {
  unlockVault(PORTFOLIO_PASSPHRASE);
  const saved = upsertInstance({
    label: 'Partial topic workspace',
    role: 'both',
    baseUrl: 'https://1.1.1.1',
    apiKey: 'omni-partial-topic-key-not-real',
  });
  markInstanceValidated(saved.id);

  globalThis.fetch = (async (input) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.endsWith('/api/v1/models')) {
      if (url.searchParams.get('modelKind') === 'SHARED') {
        return json({ models: [
          { id: 'readable-model', name: 'Readable Model', kind: 'SHARED', connectionId: 'connection-1' },
          { id: 'restricted-model', name: 'Restricted Model', kind: 'SHARED', connectionId: 'connection-1' },
        ] });
      }
      return json({ models: [] });
    }
    if (url.pathname.endsWith('/api/v1/models/readable-model/topic')) {
      return json({ success: true, topics: [{ name: 'orders' }, { name: 'customers' }] });
    }
    if (url.pathname.endsWith('/api/v1/models/restricted-model/topic')) {
      return json({ message: 'Topic access denied' }, 403);
    }
    return emptyInventoryResponse(url);
  }) as typeof fetch;

  const initial = await getPortfolioOverview({ forceRefresh: true });
  const overview = initial.refresh.state === 'idle'
    ? initial
    : await waitForPortfolio(
        (body) => body.refresh?.state === 'idle' && body.refresh?.completedInstances === 1,
        20_000,
      ) as unknown as Awaited<ReturnType<typeof getPortfolioOverview>>;

  assert.deepEqual(
    {
      value: overview.metrics.topics.value,
      status: overview.metrics.topics.status,
      included: overview.metrics.topics.coverage.included,
      total: overview.metrics.topics.coverage.total,
      reasonCode: overview.metrics.topics.reasonCode,
    },
    { value: 2, status: 'partial', included: 1, total: 1, reasonCode: 'PARTIAL_INSTANCE_COVERAGE' },
  );
  const instanceTopics = overview.instances[0]?.metrics.topics;
  assert.equal(instanceTopics?.reasonCode, 'PARTIAL_TOPIC_MODEL_COVERAGE');
  assert.deepEqual(instanceTopics?.coverage, { included: 1, total: 2, unit: 'endpoints', ratio: 0.5 });
  assert.ok(instanceTopics?.exclusions.includes('MODELS_WITH_UNREADABLE_TOPICS'));
});

test('organization scope and App metadata are detected automatically', async () => {
  unlockVault(PORTFOLIO_PASSPHRASE);
  const saved = upsertInstance({
    label: 'Governed portfolio workspace',
    role: 'both',
    baseUrl: 'https://1.1.1.1',
    apiKey: 'omni-governed-portfolio-key-not-real',
  });
  markInstanceValidated(saved.id);

  let aiRequests = 0;
  let appRequests = 0;
  const promptSentinel = 'CONFIDENTIAL_PROMPT_MUST_NOT_PERSIST';
  globalThis.fetch = (async (input) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.endsWith('/api/v1/ai/conversations')) {
      aiRequests += 1;
      assert.equal(url.searchParams.get('pageSize'), '1');
      assert.equal(url.searchParams.has('cursor'), false);
      return json({
        data: [{ id: 'conversation-1', lastUserPrompt: promptSentinel }],
        pageInfo: { hasNextPage: true, nextCursor: 'must-not-be-read', pageSize: 1, totalRecords: 7 },
      });
    }
    if (url.pathname.endsWith('/api/v1/documents')) {
      appRequests += 1;
      assert.equal(url.searchParams.has('labels'), false);
      return json({ documents: [
        { identifier: 'app-active', name: 'Operations App', hasApp: true, hasDashboard: false },
        { identifier: 'workbook-active', name: 'Operations Workbook', hasApp: false, hasDashboard: false },
        { identifier: 'app-deleted', name: 'Archived App', hasApp: true, hasDashboard: false, deleted: true },
      ] });
    }
    return emptyInventoryResponse(url);
  }) as typeof fetch;

  const initial = await getPortfolioOverview({ forceRefresh: true });
  const overview = initial.refresh.state === 'idle'
    ? initial
    : await waitForPortfolio(
        (body) => body.refresh?.state === 'idle' && body.refresh?.completedInstances === 1,
        15_000,
      ) as unknown as Awaited<ReturnType<typeof getPortfolioOverview>>;

  assert.deepEqual(
    { value: overview.metrics.aiChats.value, status: overview.metrics.aiChats.status },
    { value: 7, status: 'available' },
  );
  assert.ok(overview.metrics.aiChats.exclusions.includes('PROMPT_CONTENT_NOT_RETAINED'));
  assert.deepEqual(
    { value: overview.metrics.apps.value, status: overview.metrics.apps.status },
    { value: 1, status: 'available' },
  );
  assert.ok(overview.metrics.apps.exclusions.includes('APPS_BETA_DOCUMENT_METADATA'));
  assert.equal(aiRequests, 1, 'AI conversation inventory paginated or retried unexpectedly');
  assert.equal(appRequests, 1, 'App inventory made an unexpected additional document read');

  const serialized = JSON.stringify(overview);
  assert.equal(serialized.includes(promptSentinel), false);
  const decrypted = decryptVaultBlob(PORTFOLIO_PASSPHRASE, readFileSync(process.env.OMNIKIT_VAULT_PATH!));
  assert.equal(decrypted.includes(promptSentinel), false);
});

test('App inventory falls back to an optional governed label when native metadata is absent', async () => {
  unlockVault(PORTFOLIO_PASSPHRASE);
  const saved = upsertInstance({
    label: 'Legacy App metadata workspace',
    role: 'both',
    baseUrl: 'https://1.1.1.1',
    apiKey: 'omni-legacy-app-key-not-real',
    portfolioAppLabel: 'omnikit-app',
  });
  markInstanceValidated(saved.id);

  let appLabelRequests = 0;
  globalThis.fetch = (async (input) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.endsWith('/api/v1/ai/conversations')) {
      return json({ data: [], pageInfo: { hasNextPage: false, nextCursor: null, pageSize: 1, totalRecords: 0 } });
    }
    if (url.pathname.endsWith('/api/v1/documents')) {
      if (url.searchParams.get('labels') === 'omnikit-app') {
        appLabelRequests += 1;
        return json({ documents: [
          { identifier: 'legacy-app', name: 'Legacy App', labels: ['omnikit-app'] },
          { identifier: 'legacy-app-deleted', name: 'Archived Legacy App', labels: ['omnikit-app'], deleted: true },
        ] });
      }
      return json({ documents: [
        { identifier: 'legacy-workbook', name: 'Legacy Workbook', hasDashboard: false },
      ] });
    }
    return emptyInventoryResponse(url);
  }) as typeof fetch;

  const initial = await getPortfolioOverview({ forceRefresh: true });
  const overview = initial.refresh.state === 'idle'
    ? initial
    : await waitForPortfolio(
        (body) => body.refresh?.state === 'idle' && body.refresh?.completedInstances === 1,
        15_000,
      ) as unknown as Awaited<ReturnType<typeof getPortfolioOverview>>;

  assert.deepEqual(
    { value: overview.metrics.apps.value, status: overview.metrics.apps.status },
    { value: 1, status: 'available' },
  );
  assert.ok(overview.metrics.apps.exclusions.includes('APPS_DEFINED_BY_LEGACY_DOCUMENT_LABEL_FALLBACK'));
  assert.equal(appLabelRequests, 1);
});

test('organization scope failure prevents the AI conversation inventory request without manual configuration', async () => {
  unlockVault(PORTFOLIO_PASSPHRASE);
  const saved = upsertInstance({
    label: 'Unverified organization scope',
    role: 'both',
    baseUrl: 'https://1.1.1.1',
    apiKey: 'omni-unverified-org-key-not-real',
  });
  markInstanceValidated(saved.id);

  let aiRequests = 0;
  globalThis.fetch = (async (input) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.endsWith('/api/v1/ai/conversations')) {
      aiRequests += 1;
      return json({ data: [], pageInfo: { totalRecords: 99 } });
    }
    if (url.pathname.endsWith('/api/scim/v2/users')) return json({ message: 'Organization scope denied' }, 403);
    return emptyInventoryResponse(url);
  }) as typeof fetch;

  const initial = await getPortfolioOverview({ forceRefresh: true });
  const overview = initial.refresh.state === 'idle'
    ? initial
    : await waitForPortfolio(
        (body) => body.refresh?.state === 'idle' && body.refresh?.completedInstances === 1,
        15_000,
      ) as unknown as Awaited<ReturnType<typeof getPortfolioOverview>>;

  assert.equal(aiRequests, 0);
  assert.equal(overview.metrics.aiChats.value, null);
  assert.equal(overview.metrics.aiChats.reasonCode, 'AI_CONVERSATION_SCOPE_UNVERIFIED');
  assert.ok(overview.metrics.aiChats.exclusions.includes('AI_CONVERSATION_COUNT_NOT_REQUESTED_WITHOUT_ORG_SCOPE_EVIDENCE'));
});

test('portfolio aggregation preserves evidence, exclusions, duplicate origins, and privacy boundaries', async () => {
  resetVault();
  unlockVault('portfolio-overview-test-passphrase');

  upsertInstance({
    label: 'Regional Analytics Primary',
    role: 'both',
    baseUrl: 'https://1.1.1.1/tenant-primary',
    apiKey: 'omni-primary-secret-not-real',
  });
  const canonical = upsertInstance({
    label: 'Regional Analytics Canonical',
    role: 'both',
    baseUrl: 'https://1.1.1.1/tenant-canonical',
    apiKey: 'omni-canonical-secret-not-real',
  });
  markInstanceValidated(canonical.id);
  upsertInstance({
    label: 'Restricted Analytics',
    role: 'both',
    baseUrl: 'https://1.0.0.1/restricted',
    apiKey: 'omni-restricted-secret-not-real',
  });

  const requestedPaths: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    requestedPaths.push(url.pathname);

    if (url.pathname.startsWith('/restricted/')) {
      return json({ message: 'Access denied for user@example.invalid' }, 403);
    }
    assert.ok(url.pathname.startsWith('/tenant-canonical/'), `unexpected canonical path: ${url.pathname}`);

    if (url.pathname.endsWith('/api/v1/connections')) {
      return json({ connections: [{ id: 'connection-1', name: 'Primary Warehouse' }] });
    }
    if (url.pathname.endsWith('/api/scim/v2/users')) {
      return json({
        Resources: [
          { id: 'member-1', userName: 'analyst.one@example.invalid', active: true, emails: [{ value: 'analyst.one@example.invalid', primary: true }] },
          { id: 'member-2', userName: 'analyst.two@example.invalid', active: true, emails: [{ value: 'analyst.two@example.invalid', primary: true }] },
        ],
        totalResults: 2,
        startIndex: 1,
        itemsPerPage: 2,
      });
    }
    if (url.pathname.endsWith('/api/scim/v2/embed/users')) {
      return json({
        Resources: [{
          id: 'embed-1',
          userName: 'embedded@example.invalid',
          active: true,
          embedExternalId: 'external-1',
          embedEntity: 'Entity Alpha',
        }],
        totalResults: 1,
        startIndex: 1,
        itemsPerPage: 1,
      });
    }
    if (url.pathname.endsWith('/api/v1/ai/conversations')) {
      return json({ data: [], pageInfo: { hasNextPage: false, nextCursor: null, pageSize: 1, totalRecords: 3 } });
    }
    if (url.pathname.endsWith('/api/v1/models')) {
      const kind = url.searchParams.get('modelKind');
      if (kind === 'SHARED') {
        return json({ models: [
          { id: 'shared-active', name: 'Shared Model', kind: 'SHARED', connectionId: 'connection-1' },
          { id: 'wrong-schema', name: 'Schema Model', kind: 'SCHEMA', connectionId: 'connection-1' },
          { id: 'shared-deleted', name: 'Deleted Shared', kind: 'SHARED', deletedAt: '2026-08-01T00:00:00.000Z', connectionId: 'connection-1' },
        ] });
      }
      if (kind === 'SHARED_EXTENSION') {
        return json({ models: [
          { id: 'extension-active', name: 'Extension Model', kind: 'SHARED_EXTENSION', connectionId: 'connection-1' },
          { id: 'wrong-branch', name: 'Branch Model', kind: 'BRANCH', connectionId: 'connection-1' },
        ] });
      }
    }
    if (url.pathname.endsWith('/api/v1/models/shared-active/topic')) {
      return json({ success: true, topics: [{ name: 'operations', label: 'Operations Topic' }] });
    }
    if (url.pathname.endsWith('/api/v1/models/extension-active/topic')) {
      return json({ success: true, topics: [] });
    }
    if (url.pathname.endsWith('/api/v1/documents')) {
      return json({ documents: [
        { id: 'dashboard-active', name: 'Executive Operations', hasApp: false, hasDashboard: true, connectionId: 'connection-1' },
        { id: 'app-active', name: 'Operations App', hasApp: true, hasDashboard: false, connectionId: 'connection-1' },
        { id: 'not-dashboard', name: 'Notebook', hasApp: false, hasDashboard: false, connectionId: 'connection-1' },
        { id: 'dashboard-deleted', name: 'Deleted Dashboard', hasApp: false, hasDashboard: true, deleted: true, connectionId: 'connection-1' },
      ] });
    }
    return json({ message: 'Unexpected request' }, 404);
  };

  clearPortfolioOverviewCache();
  const initial = await getPortfolioOverview({ forceRefresh: true });
  const overview = initial.refresh.state === 'idle'
    ? initial
    : await waitForPortfolio(
        (body) => body.refresh?.state === 'idle' && body.refresh?.completedInstances === 2,
        15_000,
      ) as unknown as Awaited<ReturnType<typeof getPortfolioOverview>>;

  assert.equal(overview.coverage.savedInstances, 3);
  assert.equal(overview.coverage.totalInstances, 2);
  assert.equal(overview.coverage.duplicateSavedOrigins, 1);
  assert.equal(overview.duplicateSavedOrigins[0]?.savedInstanceCount, 2);
  assert.equal(overview.instances.length, 2);
  assert.ok(!requestedPaths.some((path) => path.startsWith('/tenant-primary/')));

  const canonicalInstance = overview.instances.find((instance) => instance.label === 'Regional Analytics Canonical');
  const restrictedInstance = overview.instances.find((instance) => instance.label === 'Restricted Analytics');
  assert.ok(canonicalInstance);
  assert.ok(restrictedInstance);

  assert.deepEqual(
    { value: canonicalInstance.metrics.dashboards.value, status: canonicalInstance.metrics.dashboards.status },
    { value: 1, status: 'available' },
  );
  assert.deepEqual(
    { value: canonicalInstance.metrics.models.value, status: canonicalInstance.metrics.models.status },
    { value: 2, status: 'available' },
  );
  assert.deepEqual(
    { value: canonicalInstance.metrics.topics.value, status: canonicalInstance.metrics.topics.status },
    { value: 1, status: 'available' },
  );
  assert.equal(canonicalInstance.metrics.active30d.value, null);
  assert.equal(canonicalInstance.metrics.active30d.status, 'unsupported');
  assert.equal(canonicalInstance.metrics.active30d.reasonCode, 'LAST_LOGIN_EVIDENCE_UNAVAILABLE');

  assert.equal(restrictedInstance.metrics.dashboards.value, null);
  assert.equal(restrictedInstance.metrics.dashboards.status, 'permission_denied');
  assert.equal(overview.metrics.dashboards.value, 1);
  assert.equal(overview.metrics.dashboards.status, 'partial');
  assert.equal(overview.metrics.active30d.value, null);
  assert.notEqual(overview.metrics.active30d.status, 'available');

  assert.deepEqual(
    { value: overview.metrics.aiChats.value, status: overview.metrics.aiChats.status },
    { value: 3, status: 'partial' },
  );
  assert.deepEqual(
    { value: overview.metrics.apps.value, status: overview.metrics.apps.status, reasonCode: overview.metrics.apps.reasonCode },
    { value: 1, status: 'partial', reasonCode: 'PARTIAL_INSTANCE_COVERAGE' },
  );

  const serialized = JSON.stringify(overview);
  for (const secret of [
    'analyst.one@example.invalid',
    'analyst.two@example.invalid',
    'embedded@example.invalid',
    'omni-primary-secret-not-real',
    'omni-canonical-secret-not-real',
    'omni-restricted-secret-not-real',
    'https://1.1.1.1',
    'https://1.0.0.1',
  ]) {
    assert.equal(serialized.includes(secret), false, `aggregate leaked ${secret}`);
  }
});

test('frontend parser preserves partial, stale, not-configured, and estimated metrics', () => {
  const parsed = parsePortfolioOverview({
    generatedAt: '2026-08-06T15:00:00.000Z',
    coverage: {
      totalInstances: 2,
      reportingInstances: 1,
      partialInstances: 1,
      staleInstances: 1,
      unavailableInstances: 0,
    },
    metrics: {
      reportingInstances: metric(1, 'partial', 'PARTIAL_INSTANCE_COVERAGE'),
      internalMemberships: metric(12, 'stale', 'STALE_IF_ERROR'),
      estimatedUniquePeople: metric(7, 'partial', 'ESTIMATED_FROM_NORMALIZED_EMAIL'),
      embedUsers: metric(4, 'available'),
      embedEntities: metric(2, 'available'),
      active7d: metric(null, 'unsupported', 'LAST_LOGIN_EVIDENCE_UNAVAILABLE'),
      active30d: metric(null, 'unsupported', 'LAST_LOGIN_EVIDENCE_UNAVAILABLE'),
      active90d: metric(null, 'unsupported', 'LAST_LOGIN_EVIDENCE_UNAVAILABLE'),
      dashboards: metric(5, 'partial', 'PARTIAL_INSTANCE_COVERAGE'),
      models: metric(3, 'available'),
      topics: metric(2, 'available'),
      aiChats: metric(null, 'not_configured', 'AI_CONVERSATIONS_ORG_KEY_CONFIRMATION_REQUIRED'),
      apps: metric(null, 'not_configured', 'APP_INVENTORY_LABEL_REQUIRED'),
    },
    partial: true,
    stale: true,
  });

  assert.equal(parsed.metrics.estimatedUniquePeople.value, 7);
  assert.equal(parsed.metrics.estimatedUniquePeople.state, 'partial');
  assert.equal(parsed.metrics.estimatedUniquePeople.asOf, '2026-08-06T15:00:00.000Z');
  assert.equal(parsed.metrics.internalMemberships.state, 'stale');
  assert.equal(parsed.metrics.active30d.value, null);
  assert.equal(parsed.metrics.active30d.state, 'unavailable');
  assert.equal(parsed.metrics.aiChats.state, 'not_configured');
  assert.equal(parsed.metrics.apps.state, 'not_configured');
  assert.equal(parsed.partial, true);
  assert.equal(parsed.stale, true);
});

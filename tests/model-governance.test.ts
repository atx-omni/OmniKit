import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';

import {
  applyLabelPatches,
  buildLabelPatternValue,
  buildStaleViewCandidates,
  countContentReferences,
  findFilesChangedSinceLoad,
  normalizeContentReferences,
  parseSemanticInventory,
} from '../src/services/modelGovernance';
import {
  countContentValidationIssues,
  discardReviewedModelBranch,
  normalizeModelGitCapability,
  publishReviewedModelBranch,
  validateReviewedModelBranch,
  type ReviewedModelBranch,
} from '../src/services/reviewedModelWrite';
import { deleteModelYamlFile } from '../src/services/omniApi';
import { apiMiddleware } from '../server/apiMiddleware';
import { OmniClient, normalizeOmniAiJobResult } from '../server/services/omniClient';

const fixtureFiles = {
  'topics/sales.topic': `base_view: orders
label: Sales Topic
description: Revenue reporting
`,
  'views/orders.view': `label: Orders
# keep this model context
dimensions:
  city:
    sql: city
  state:
    group_label: Location
    sql: state
measures:
  total_sales:
    group_label: Revenue
    aggregate_type: sum
`,
  'views/stale_orders.view': `label: Stale Orders
dimensions:
  order_id:
    sql: order_id
`,
};

const browserConnection = {
  baseUrl: 'https://example.omniapp.co',
  apiKey: 'vault-ref-governance',
  status: 'success' as const,
  errorMessage: '',
};

function reviewedBranch(pullRequestRequired = false): ReviewedModelBranch {
  return {
    modelId: 'model-a',
    branchId: 'branch-a',
    branchName: 'governance-review',
    capability: {
      editable: true,
      gitConfigured: pullRequestRequired,
      gitConfigurationKnown: true,
      gitFollower: false,
      pullRequestRequired,
    },
  };
}

test('model governance parses topics, views, and field group labels', () => {
  const inventory = parseSemanticInventory(fixtureFiles);

  assert.deepEqual(inventory.topics.map((topic) => [topic.name, topic.label]), [['sales', 'Sales Topic']]);
  assert.deepEqual(inventory.views.map((view) => [view.name, view.label]), [
    ['orders', 'Orders'],
    ['stale_orders', 'Stale Orders'],
  ]);
  assert.equal(inventory.fields.find((field) => field.name === 'state')?.groupLabel, 'Location');
  assert.equal(inventory.fields.find((field) => field.name === 'total_sales')?.kind, 'measure');
});

test('model governance applies topic, view, and field label patches by file', () => {
  const result = applyLabelPatches(fixtureFiles, [
    { kind: 'topic', fileName: 'topics/sales.topic', name: 'sales', before: 'Sales Topic', after: 'Executive Sales' },
    { kind: 'view', fileName: 'views/orders.view', name: 'orders', before: 'Orders', after: 'Order Facts' },
    { kind: 'field', fileName: 'views/orders.view', viewName: 'orders', fieldName: 'city', fieldKind: 'dimension', before: '', after: 'Location > Address' },
    { kind: 'field', fileName: 'views/orders.view', viewName: 'orders', fieldName: 'state', fieldKind: 'dimension', before: 'Location', after: '' },
  ]);

  assert.equal(result.changedFiles.length, 2);
  const topicYaml = result.changedFiles.find((file) => file.fileName === 'topics/sales.topic')?.yaml || '';
  const viewYaml = result.changedFiles.find((file) => file.fileName === 'views/orders.view')?.yaml || '';
  assert.match(topicYaml, /^label: Executive Sales/m);
  assert.match(viewYaml, /^label: Order Facts/m);
  assert.match(viewYaml, /city:\n {4}sql: city\n {4}group_label: Location > Address/m);
  assert.doesNotMatch(viewYaml, /state:\n {4}group_label:/m);
  assert.match(viewYaml, /# keep this model context/);
});

test('model governance stale candidates require zero-reference content signal for safe select', () => {
  const inventory = parseSemanticInventory(fixtureFiles);
  const contentCounts = countContentReferences({ dashboards: [{ query: 'orders.total_sales' }] }, ['orders', 'stale_orders']);
  const candidates = buildStaleViewCandidates({
    inventory,
    validationIssues: [{
      message: 'View stale_orders does not exist in the source database',
      yaml_path: 'views/stale_orders.view',
    }, {
      message: 'View orders has a referenced field warning',
      yaml_path: 'views/orders.view',
      is_warning: true,
    }],
    contentReferenceCounts: contentCounts,
  });

  const stale = candidates.find((candidate) => candidate.viewName === 'stale_orders');
  const orders = candidates.find((candidate) => candidate.viewName === 'orders');
  assert.equal(stale?.confidence, 'high');
  assert.equal(stale?.safeByDefault, true);
  assert.equal(orders?.safeByDefault, false);
  assert.equal(orders?.referencedByCount, 1);
});

test('model governance label patterns support bulk transforms', () => {
  assert.equal(buildLabelPatternValue({ name: 'total_sales', current: '', mode: 'title-case', value: '' }), 'Total Sales');
  assert.equal(buildLabelPatternValue({ name: 'orders', current: 'Orders', mode: 'prefix', value: 'Demo - ' }), 'Demo - Orders');
  assert.equal(buildLabelPatternValue({ name: 'orders', current: 'Old Orders', mode: 'find-replace', find: 'Old', value: 'New' }), 'New Orders');
  assert.equal(buildLabelPatternValue({ name: 'orders', current: 'Orders', mode: 'clear', value: '' }), '');
});

test('stale view matching is exact for similarly named views', () => {
  const inventory = parseSemanticInventory(fixtureFiles);
  const candidates = buildStaleViewCandidates({
    inventory,
    validationIssues: [{
      message: 'View stale_orders does not exist in the source database',
      yaml_path: 'views/stale_orders.view',
    }],
    contentReferences: { stale_orders: [] },
  });

  assert.deepEqual(candidates.map((candidate) => candidate.viewName), ['stale_orders']);
  assert.equal(candidates[0]?.safeByDefault, true);
});

test('stale view candidates fail closed until exact content references are verified', () => {
  const inventory = parseSemanticInventory(fixtureFiles);
  const unknown = buildStaleViewCandidates({
    inventory,
    validationIssues: [{ message: 'No view "stale_orders"', yaml_path: 'views/stale_orders.view' }],
  });
  const failed = buildStaleViewCandidates({
    inventory,
    validationIssues: [{ message: 'No view "stale_orders"', yaml_path: 'views/stale_orders.view' }],
    referenceErrors: { stale_orders: 'Forbidden' },
  });

  assert.equal(unknown[0]?.referenceStatus, 'unknown');
  assert.equal(unknown[0]?.safeByDefault, false);
  assert.equal(failed[0]?.referenceStatus, 'failed');
  assert.equal(failed[0]?.safeByDefault, false);
});

test('content validator results normalize into concrete referenced content', () => {
  const references = normalizeContentReferences({
    content: [{
      document_id: 'doc-1',
      identifier: 'sales-dashboard',
      name: 'Sales Dashboard',
      type: 'Published',
      folder: { path: '/Finance' },
      owner: { name: 'Analyst' },
      queries_and_issues: [{ query_name: 'Revenue' }, { query_name: 'Margin' }],
    }],
  });

  assert.deepEqual(references, [{
    documentId: 'doc-1',
    identifier: 'sales-dashboard',
    name: 'Sales Dashboard',
    type: 'Published',
    updatedAt: undefined,
    folderPath: '/Finance',
    ownerName: 'Analyst',
    queryNames: ['Revenue', 'Margin'],
  }]);
});

test('model governance capabilities block schema and follower writes and preserve PR handoff', () => {
  const schema = normalizeModelGitCapability({ id: 'schema', name: 'Schema', kind: 'SCHEMA' });
  const follower = normalizeModelGitCapability(
    { id: 'shared', name: 'Follower', kind: 'SHARED' },
    { gitFollower: true, requirePullRequest: 'always' },
  );
  const protectedShared = normalizeModelGitCapability(
    { id: 'shared', name: 'Shared', kind: 'SHARED' },
    { gitFollower: false, requirePullRequest: 'users-only' },
  );

  assert.equal(schema.editable, false);
  assert.equal(follower.editable, false);
  assert.equal(protectedShared.editable, true);
  assert.equal(protectedShared.pullRequestRequired, true);
});

test('OmniClient deletes a branch through the documented model branch route', async (t) => {
  let requestedUrl = '';
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const client = new OmniClient({ label: 'Test', baseUrl: 'https://example.omniapp.co', apiKey: 'governance-delete-token' });
  await client.deleteModelBranch('model-a', 'cleanup branch');

  assert.equal(new URL(requestedUrl).pathname, '/api/v1/models/model-a/branch/cleanup%20branch');
});

test('browser model YAML delete preserves branch-scoped query parameters through the proxy', async (t) => {
  let requestBody: Record<string, unknown> = {};
  t.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  await deleteModelYamlFile('https://example.omniapp.co', 'vault-ref', {
    modelId: 'model-a',
    fileName: 'topics/orders.topic',
    branchId: 'branch-a',
    mode: 'combined',
    commitMessage: 'Stage reviewed topic removal',
  });

  assert.equal(requestBody.method, 'DELETE');
  assert.equal(requestBody.endpoint, '/v1/models/model-a/yaml');
  assert.deepEqual(requestBody.query_params, {
    fileName: 'topics/orders.topic',
    branchId: 'branch-a',
    mode: 'combined',
    commitMessage: 'Stage reviewed topic removal',
  });
});

test('local API middleware and Omni proxy preserve model YAML delete query parameters end to end', async (t) => {
  let requestedUrl = '';
  let requestedMethod = '';
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    requestedUrl = String(url);
    requestedMethod = String(init?.method || 'GET');
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  const requestBody = JSON.stringify({
    base_url: 'https://example.omniapp.co',
    api_key: 'server-side-test-reference',
    method: 'DELETE',
    endpoint: '/v1/models/model-a/yaml',
    query_params: {
      fileName: 'topics/orders.topic',
      branchId: 'branch-a',
      mode: 'combined',
      commitMessage: 'Stage reviewed topic removal',
    },
  });
  const request = Readable.from([Buffer.from(requestBody)]) as IncomingMessage;
  request.method = 'POST';
  request.url = '/api/omni-proxy';
  request.headers = {
    host: '127.0.0.1:5175',
    origin: 'http://127.0.0.1:5175',
    'content-type': 'application/json',
  };

  const responseChunks: Buffer[] = [];
  const response = new Writable({
    write(chunk, _encoding, callback) {
      responseChunks.push(Buffer.from(chunk));
      callback();
    },
  }) as unknown as ServerResponse;
  response.statusCode = 200;
  response.setHeader = (() => response) as ServerResponse['setHeader'];

  const finished = once(response, 'finish');
  await apiMiddleware()(request, response);
  await finished;

  const outbound = new URL(requestedUrl);
  assert.equal(requestedMethod, 'DELETE');
  assert.equal(outbound.pathname, '/api/v1/models/model-a/yaml');
  assert.equal(outbound.searchParams.get('fileName'), 'topics/orders.topic');
  assert.equal(outbound.searchParams.get('branchId'), 'branch-a');
  assert.equal(outbound.searchParams.get('mode'), 'combined');
  assert.equal(outbound.searchParams.get('commitMessage'), 'Stage reviewed topic removal');
  assert.deepEqual(JSON.parse(Buffer.concat(responseChunks).toString('utf8')), { success: true });
});

test('OmniClient sends branch_id for reviewed schema refreshes', async (t) => {
  let requestedUrl = '';
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({ status: 'running' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const client = new OmniClient({ label: 'Test', baseUrl: 'https://example.omniapp.co', apiKey: 'governance-refresh-token' });
  await client.refreshModel('model-a', 'branch-a');
  const url = new URL(requestedUrl);

  assert.equal(url.pathname, '/api/v1/models/model-a/refresh');
  assert.equal(url.searchParams.get('branch_id'), 'branch-a');
});

test('Omni AI job normalization accepts documented state responses and legacy status responses', () => {
  assert.deepEqual(normalizeOmniAiJobResult({
    id: 'job-state',
    state: 'COMPLETE',
    resultSummary: 'Finished',
  }), {
    id: 'job-state',
    status: 'COMPLETE',
    result: undefined,
    raw: {
      id: 'job-state',
      state: 'COMPLETE',
      resultSummary: 'Finished',
    },
  });
  assert.equal(normalizeOmniAiJobResult({
    job: { id: 'job-nested', status: 'RUNNING' },
  }).status, 'RUNNING');
  assert.equal(normalizeOmniAiJobResult({}, 'job-fallback').id, 'job-fallback');
});

test('checksum comparison rejects files changed after the labeling inventory loaded', () => {
  assert.deepEqual(findFilesChangedSinceLoad({
    affectedFiles: ['orders.view', 'customers.view'],
    originalFiles: { 'orders.view': 'label: Orders', 'customers.view': 'label: Customers' },
    originalChecksums: { 'orders.view': 'old-orders', 'customers.view': 'same-customers' },
    branchFiles: { 'orders.view': 'label: New Orders', 'customers.view': 'label: Customers' },
    branchChecksums: { 'orders.view': 'new-orders', 'customers.view': 'same-customers' },
  }), ['orders.view']);
});

test('OmniClient content validation supports exact view-reference queries', async (t) => {
  let requestedUrl = '';
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({ content: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const client = new OmniClient({ label: 'Test', baseUrl: 'https://example.omniapp.co', apiKey: 'governance-content-token' });
  await client.validateModelContent('model-a', {
    find: 'orders',
    findType: 'VIEW',
    includePersonalFolders: true,
  });
  const url = new URL(requestedUrl);

  assert.equal(url.searchParams.get('find'), 'orders');
  assert.equal(url.searchParams.get('find_type'), 'VIEW');
  assert.equal(url.searchParams.get('include_personal_folders'), 'true');
});

test('reviewed model validation counts query and dashboard-filter issues', () => {
  assert.equal(countContentValidationIssues({
    content: [{
      queries_and_issues: [{ issues: ['Missing field', 'Missing view'] }],
      dashboard_filter_issues: ['Missing filter'],
    }],
  }), 3);
});

test('reviewed model publish merges then validates main', async (t) => {
  const endpoints: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}')) as { endpoint?: string };
    endpoints.push(body.endpoint || '');
    if (body.endpoint?.endsWith('/validate')) return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (body.endpoint?.endsWith('/content-validator')) return new Response(JSON.stringify({ content: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  const result = await publishReviewedModelBranch(browserConnection, reviewedBranch(false), 'Publish labels');

  assert.equal(result.mode, 'merged');
  assert.equal(result.postMergeValidation?.blocking, false);
  assert.deepEqual(endpoints, [
    '/v1/models/model-a/branch/governance-review/merge',
    '/v1/models/model-a/validate',
    '/v1/models/model-a/content-validator',
  ]);
});

test('reviewed model publish creates a PR handoff for protected models', async (t) => {
  let requestBody: Record<string, unknown> = {};
  t.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
    return new Response(JSON.stringify({ pr_url: 'https://github.example/pr/12' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  const result = await publishReviewedModelBranch(browserConnection, reviewedBranch(true), 'Publish labels');

  assert.equal(result.mode, 'pull_request');
  assert.equal(result.url, 'https://github.example/pr/12');
  assert.equal(requestBody.endpoint, '/v1/models/model-a/git/commit');
});

test('reviewed branch validation blocks model and content errors', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}')) as { endpoint?: string };
    if (body.endpoint?.endsWith('/validate')) {
      return new Response(JSON.stringify([{ message: 'Broken relationship', is_warning: false }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ content: [{ queries_and_issues: [{ issues: ['Missing field'] }] }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  const validation = await validateReviewedModelBranch(browserConnection, reviewedBranch(false));

  assert.equal(validation.blocking, true);
  assert.equal(validation.modelIssues.length, 1);
  assert.equal(validation.contentIssueCount, 1);
});

test('reviewed branch discard uses the base model and branch name', async (t) => {
  let requestBody: Record<string, unknown> = {};
  t.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  await discardReviewedModelBranch(browserConnection, reviewedBranch(false));

  assert.equal(requestBody.method, 'DELETE');
  assert.equal(requestBody.endpoint, '/v1/models/model-a/branch/governance-review');
});

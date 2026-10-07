import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { OmniClient, resetOmniClientRateLimitStateForTests } from '../server/services/omniClient';
import { validateTopicCorrectionBranch } from '../server/services/topicBranchValidation';

// Synthetic transport and responses only; these checks are not tenant acceptance.
const branchHash = 'sha256:' + 'a'.repeat(64);
let sequence = 0;
afterEach(resetOmniClientRateLimitStateForTests);
function client(fetchImpl: typeof fetch, requestTimeoutMs = 1_000) {
  return new OmniClient({ baseUrl: 'https://93.184.216.34', label: 'Example workspace', apiKey: `fictional-validation-key-${++sequence}` },
    { fetchImpl, maxReadRetries: 0, requestTimeoutMs });
}
function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
const check = (api: OmniClient, kind: 'model' | 'content' = 'model', topics?: string[], signal?: AbortSignal) =>
  validateTopicCorrectionBranch(api, 'example-model', 'example-branch', branchHash, kind, topics, signal);
const content = (patch: Record<string, unknown> = {}) => ({ model_id: 'example-model', branch: { id: 'example-branch' }, content: [], ...patch });

test('strict branch model validation uses exact read scope and records limited success', async () => {
  const calls: Array<{ url: URL; method: string | undefined }> = [];
  const result = await check(client(async (input, init) => {
    calls.push({ url: new URL(String(input)), method: init?.method }); return response([]);
  }));
  assert.equal(result.status, 'passed'); assert.equal(result.branchHash, branchHash);
  assert.ok(result.checkedAt); assert.deepEqual(result.issues, []);
  assert.match(result.message || '', /queries were not executed/);
  assert.equal(calls.length, 1); assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url.pathname, '/api/v1/models/example-model/validate');
  assert.deepEqual(Object.fromEntries(calls[0].url.searchParams), { branchId: 'example-branch' });
});

test('strict branch model validation retains warnings and redacts messages and paths', async () => {
  const result = await check(client(async () => response([
    { message: 'Contact example.person@example.invalid with token fictional-secret', is_warning: true, yaml_path: 'example.person@example.invalid.topic' },
    { message: 'Example field is missing', is_warning: false },
  ])));
  assert.equal(result.status, 'issues'); assert.deepEqual(result.issues.map(issue => issue.warning), [true, false]);
  assert.doesNotMatch(JSON.stringify(result), /example\.person@example\.invalid|fictional-secret/);
  assert.match(result.issues[0].message, /redacted/);
});

test('strict branch model validation never accepts normalized or malformed empty success', async () => {
  for (const body of [null, {}, { issues: [] }, ['issue'], [{ message: 'Example issue' }], [{ message: '', is_warning: false }],
    [{ message: 'Example issue', is_warning: 'false' }], [{ message: 'Example issue', is_warning: false, yaml_path: {} }]]) {
    assert.equal((await check(client(async () => response(body)))).status, 'unavailable');
  }
  assert.equal((await check(client(async () => new Response('{broken')))).status, 'unavailable');
  assert.equal((await check(client(async () => new Response(null, { status: 204 })))).status, 'unavailable');
});

test('strict content validation is bounded to distinct authored topic identities and exact branch', async () => {
  const calls: URL[] = [];
  const result = await check(client(async (input, init) => {
    assert.equal(init?.method, 'GET'); calls.push(new URL(String(input))); return response(content());
  }), 'content', ['Example Domain/example.topic', 'second.topic', 'second.topic']);
  assert.equal(result.status, 'passed'); assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(url => url.searchParams.get('find')), ['example', 'second']);
  for (const url of calls) {
    assert.equal(url.pathname, '/api/v1/models/example-model/content-validator');
    assert.equal(url.searchParams.get('branch_id'), 'example-branch');
    assert.equal(url.searchParams.get('find_type'), 'TOPIC');
    assert.equal(url.searchParams.get('include_personal_folders'), 'false');
    assert.equal(url.searchParams.get('force_full_validation'), 'false');
  }
  assert.match(result.message || '', /surface checks/);
});

test('strict content validation retains nested query and filter errors without leaking raw metadata', async () => {
  const result = await check(client(async () => response(content({ content: [{
    owner: { email: 'private.owner@example.invalid' },
    queries_and_issues: [{ issues: ['Missing example.field; token fictional-secret'] }],
    dashboard_filter_issues: ['Missing example.filter'],
  }] }))), 'content', ['example.topic']);
  assert.equal(result.status, 'issues'); assert.equal(result.issues.length, 2);
  assert.ok(result.issues.every(issue => !issue.warning));
  assert.doesNotMatch(JSON.stringify(result), /private\.owner|fictional-secret/);
});

test('strict content validation rejects mismatched, partial and malformed evidence', async () => {
  for (const value of [{}, [], content({ model_id: 'other-model' }), content({ branch: null }), content({ branch: { id: 'other-branch' } }),
    content({ content: [{}] }), content({ content: [{ queries_and_issues: [{}], dashboard_filter_issues: [] }] }),
    content({ content: [{ queries_and_issues: [], dashboard_filter_issues: [null] }] }),
    content({ content: [{ queries_and_issues: [{ issues: [{ message: 'Unsupported shape' }] }], dashboard_filter_issues: [] }] }),
    content({ error: 'Partial failure' }), content({ next_cursor: 'more-results' })]) {
    assert.equal((await check(client(async () => response(value)), 'content', ['example.topic'])).status, 'unavailable');
  }
});

test('strict content validation never falls back to a global scan for unsafe or unavailable scope', async () => {
  let calls = 0;
  const api = client(async () => { calls += 1; return response(content()); });
  for (const topics of [undefined, [], ['../example.topic'], ['example.view'], ['first/example.topic', 'second/example.topic'],
    ['example*topic.topic'], Array.from({ length: 21 }, (_, i) => `example_${i}.topic`)]) {
    assert.equal((await check(api, 'content', topics)).status, 'unavailable');
  }
  assert.equal(calls, 0);
});

test('strict validation reports transport, body timeout, cancellation and oversized evidence as unavailable', async () => {
  for (const status of [403, 429, 500]) {
    const result = await check(client(async () => response({ message: 'token fictional-secret' }, status)));
    assert.equal(result.status, 'unavailable'); assert.doesNotMatch(JSON.stringify(result), /fictional-secret/);
  }
  assert.equal((await check(client(async () => { throw new Error('token fictional-secret'); }))).status, 'unavailable');
  const canceled = new AbortController(); canceled.abort();
  let calls = 0;
  assert.equal((await check(client(async () => { calls += 1; return response([]); }), 'model', undefined, canceled.signal)).status, 'unavailable');
  assert.equal(calls, 0);
  assert.equal((await check(client(async () => new Response(new ReadableStream({ start() {} })), 5))).status, 'unavailable');
  assert.equal((await check(client(async () => new Response('[]', { headers: { 'content-length': String(3 * 1024 * 1024) } })))).status, 'unavailable');
});

test('strict validation rejects invalid binding and never hides a later scoped read failure', async () => {
  let calls = 0;
  const api = client(async () => response(++calls === 1 ? content() : {}));
  const result = await check(api, 'content', ['first.topic', 'second.topic']);
  assert.equal(calls, 2); assert.equal(result.status, 'unavailable');
  calls = 0;
  const invalid = await validateTopicCorrectionBranch(api, 'example-model', '', 'unbound', 'model');
  assert.equal(invalid.status, 'unavailable'); assert.equal(invalid.branchHash, undefined); assert.equal(calls, 0);
});

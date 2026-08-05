import assert from 'node:assert/strict';
import test from 'node:test';

import handler from '../server/handlers/manage-topics';

function request(body: Record<string, unknown>) {
  return new Request('http://localhost/api/manage-topics', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base_url: 'https://example.omniapp.co',
      api_key: 'test-vault-reference',
      model_id: 'model-a',
      ...body,
    }),
  });
}

test('topic list reads authored model YAML and preserves topic metadata', async (t) => {
  let requestedUrl = '';
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({
      files: {
        'topics/orders.topic': 'base_view: orders\nlabel: Executive Orders\ndescription: Governed reporting\n',
        'views/orders.view': 'dimensions: {}\n',
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  const response = await handler(request({ action: 'list' }));
  const payload = await response.json() as { topics: Array<Record<string, unknown>> };

  assert.equal(new URL(requestedUrl).pathname, '/api/v1/models/model-a/yaml');
  assert.deepEqual(payload.topics, [{
    name: 'orders',
    label: 'Executive Orders',
    description: 'Governed reporting',
  }]);
});

test('topic detail uses the documented read endpoint with encoded topic name', async (t) => {
  let requestedUrl = '';
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({ topic: { name: 'Orders / Finance', base_view_name: 'orders' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  const response = await handler(request({ action: 'get', topic_name: 'Orders / Finance' }));
  const payload = await response.json();

  assert.equal(new URL(requestedUrl).pathname, '/api/v1/models/model-a/topic/Orders%20%2F%20Finance');
  assert.deepEqual(payload, { name: 'Orders / Finance', base_view_name: 'orders' });
});

test('topic handler rejects direct mutation actions before any Omni request', async (t) => {
  let fetchCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCount += 1;
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  const response = await handler(request({ action: 'delete', topic_name: 'orders' }));
  const payload = await response.json() as { error?: string };

  assert.equal(response.status, 400);
  assert.match(payload.error || '', /Unknown action: delete/);
  assert.equal(fetchCount, 0);
});

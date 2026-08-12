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

test('topic list preserves a verified empty files inventory', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ files: {} }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));

  const response = await handler(request({ action: 'list' }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { topics: [] });
});

test('topic list rejects malformed successful YAML envelopes without exposing upstream detail', async (t) => {
  const marker = 'private-user@example.invalid RAW_TOPIC_UPSTREAM_MARKER';
  const payloads = [
    {},
    { error: marker, files: {} },
    { errors: null, files: {} },
    { files: [] },
    { files: { 'topics/orders.topic': { marker } } },
  ];
  let payloadIndex = 0;
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(payloads[payloadIndex++]), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));

  for (let index = 0; index < payloads.length; index += 1) {
    const response = await handler(request({ action: 'list' }));
    const body = JSON.stringify(await response.json());
    assert.equal(response.status, 502);
    assert.equal(body.includes(marker), false);
  }
});

test('topic detail uses the documented read endpoint with encoded topic name', async (t) => {
  let requestedUrl = '';
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({ success: true, topic: { name: 'Orders / Finance', base_view_name: 'orders' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  const response = await handler(request({ action: 'get', topic_name: 'Orders / Finance' }));
  const payload = await response.json();

  assert.equal(new URL(requestedUrl).pathname, '/api/v1/models/model-a/topic/Orders%20%2F%20Finance');
  assert.deepEqual(payload, { name: 'Orders / Finance', base_view_name: 'orders' });
});

test('topic detail never forwards upstream errors and rejects malformed successful envelopes', async (t) => {
  const marker = 'private-user@example.invalid RAW_TOPIC_DETAIL_MARKER';
  const responses = [
    new Response(JSON.stringify({ error: marker, detail: `Bearer ${marker}` }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    }),
    new Response(JSON.stringify({ success: false, error: marker }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
    new Response(JSON.stringify({ success: true, topic: null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
    new Response(JSON.stringify({ success: true, topic: { name: 'another-topic' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
    new Response(JSON.stringify({ success: true, topic: { name: 'Orders / Finance', error: marker } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  ];
  let responseIndex = 0;
  t.mock.method(globalThis, 'fetch', async () => responses[responseIndex++]);

  for (let index = 0; index < responses.length; index += 1) {
    const response = await handler(request({ action: 'get', topic_name: 'Orders / Finance' }));
    const body = JSON.stringify(await response.json());
    assert.equal(response.status, index === 0 ? 403 : 502);
    assert.equal(body.includes(marker), false);
  }
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

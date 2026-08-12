import assert from 'node:assert/strict';
import { test } from 'node:test';

import handler, { generateSignedEmbedUrl } from '../server/handlers/generate-embed-url';
import { generateEmbedUrl as requestSignedEmbedUrl } from '../src/services/omniApi';

const baseInput = {
  baseUrl: 'https://example.omniapp.co',
  embedSecret: 'embed-secret-do-not-leak',
  embedData: {
    contentPath: '/dashboards/operations',
    externalId: 'external-123',
    name: 'Example Person',
  },
};

const NONCE = 'nonce_1234567890abcdefghijklmnop';
const SIGNATURE = 'signature_abcdefghijklmnopqrstuvwxyz0123456789';

function signedUrl(
  host = 'example.embed-omniapp.co',
  optional: { email?: string; groups?: string[] } = {},
): string {
  const url = new URL(`https://${host}/embed/login`);
  url.searchParams.set('contentPath', String(baseInput.embedData.contentPath));
  url.searchParams.set('externalId', String(baseInput.embedData.externalId));
  url.searchParams.set('name', String(baseInput.embedData.name));
  if (optional.email) url.searchParams.set('email', optional.email);
  if (optional.groups) url.searchParams.set('groups', JSON.stringify(optional.groups));
  url.searchParams.set('nonce', NONCE);
  url.searchParams.set('signature', SIGNATURE);
  return url.toString();
}

function generatedResponse(url: string, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ url, ...extra }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('standard SSO generation sends the secret in the JSON body without an Authorization header', async () => {
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  const result = await generateSignedEmbedUrl(baseInput, {
    assertSafeUrl: async () => undefined,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedInit = init;
      return generatedResponse(signedUrl());
    }) as typeof fetch,
  });

  assert.equal(capturedUrl, 'https://example.omniapp.co/embed/sso/generate-url');
  assert.equal(capturedInit?.method, 'POST');
  const headers = new Headers(capturedInit?.headers);
  assert.equal(headers.has('Authorization'), false);
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    ...baseInput.embedData,
    secret: baseInput.embedSecret,
  });
  assert.deepEqual(result, { url: signedUrl() });
  assert.equal(JSON.stringify(result).includes(baseInput.embedSecret), false);
});

test('browser signing requests bypass retained in-flight request keying', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    assert.equal(String(input), '/api/generate-embed-url');
    const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(requestBody.embed_secret, baseInput.embedSecret);
    return new Response(JSON.stringify({ url: `https://signed.example/${calls}` }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  const [first, second] = await Promise.all([
    requestSignedEmbedUrl(baseInput.baseUrl, baseInput.embedSecret, baseInput.embedData),
    requestSignedEmbedUrl(baseInput.baseUrl, baseInput.embedSecret, baseInput.embedData),
  ]);

  assert.equal(calls, 2, 'sensitive signing requests were incorrectly deduplicated through a retained key');
  assert.notEqual(first.url, second.url);
});

test('generation requires contentPath, externalId, name, and an embed secret before any request', async () => {
  let calls = 0;
  const dependencies = {
    assertSafeUrl: async () => undefined,
    fetchImpl: (async () => {
      calls += 1;
      return new Response('{}');
    }) as typeof fetch,
  };

  await assert.rejects(
    generateSignedEmbedUrl({ ...baseInput, embedSecret: '' }, dependencies),
    /Embed secret is required/,
  );
  await assert.rejects(
    generateSignedEmbedUrl({ ...baseInput, embedData: { ...baseInput.embedData, externalId: '' } }, dependencies),
    /contentPath, externalId, and name are required/,
  );
  await assert.rejects(
    generateSignedEmbedUrl({ ...baseInput, embedData: { ...baseInput.embedData, unexpectedClaim: 'unsafe' } }, dependencies),
    /unsupported fields/,
  );
  assert.equal(calls, 0);
});

test('optional email and groups are normalized, forwarded, and bound to the signed output', async () => {
  const optional = {
    email: 'person@example.invalid',
    groups: ['Finance', 'Operations'],
  };
  const input = {
    ...baseInput,
    embedData: {
      ...baseInput.embedData,
      email: ` ${optional.email} `,
      groups: optional.groups.map((group) => ` ${group} `),
    },
  };
  let capturedBody: Record<string, unknown> | null = null;
  const result = await generateSignedEmbedUrl(input, {
    assertSafeUrl: async () => undefined,
    fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return generatedResponse(signedUrl('example.embed-omniapp.co', optional));
    }) as typeof fetch,
  });

  assert.deepEqual(capturedBody, { ...baseInput.embedData, ...optional, secret: baseInput.embedSecret });
  assert.deepEqual(result, { url: signedUrl('example.embed-omniapp.co', optional) });
});

test('signed output rejects changed, missing, extra, or malformed optional identity claims', async () => {
  const optional = { email: 'person@example.invalid', groups: ['Finance', 'Operations'] };
  const input = { ...baseInput, embedData: { ...baseInput.embedData, ...optional } };
  const candidates: string[] = [];

  const missingEmail = new URL(signedUrl('example.embed-omniapp.co', optional));
  missingEmail.searchParams.delete('email');
  candidates.push(missingEmail.toString());
  const changedEmail = new URL(signedUrl('example.embed-omniapp.co', optional));
  changedEmail.searchParams.set('email', 'different@example.invalid');
  candidates.push(changedEmail.toString());
  const missingGroups = new URL(signedUrl('example.embed-omniapp.co', optional));
  missingGroups.searchParams.delete('groups');
  candidates.push(missingGroups.toString());
  const reorderedGroups = new URL(signedUrl('example.embed-omniapp.co', optional));
  reorderedGroups.searchParams.set('groups', JSON.stringify([...optional.groups].reverse()));
  candidates.push(reorderedGroups.toString());
  const malformedGroups = new URL(signedUrl('example.embed-omniapp.co', optional));
  malformedGroups.searchParams.set('groups', 'not-json');
  candidates.push(malformedGroups.toString());
  const unexpected = new URL(signedUrl('example.embed-omniapp.co', optional));
  unexpected.searchParams.set('mode', 'read');
  candidates.push(unexpected.toString());

  for (const candidate of candidates) {
    await assert.rejects(generateSignedEmbedUrl(input, {
      assertSafeUrl: async () => undefined,
      fetchImpl: (async () => generatedResponse(candidate)) as typeof fetch,
    }));
  }

  const unexpectedOptional = new URL(signedUrl());
  unexpectedOptional.searchParams.set('email', optional.email);
  await assert.rejects(generateSignedEmbedUrl(baseInput, {
    assertSafeUrl: async () => undefined,
    fetchImpl: (async () => generatedResponse(unexpectedOptional.toString())) as typeof fetch,
  }), /unexpected query parameter/);
});

test('upstream failures never expose response bodies or the embed secret', async () => {
  const upstreamMarker = 'raw-upstream-private-marker';
  await assert.rejects(
    generateSignedEmbedUrl(baseInput, {
      assertSafeUrl: async () => undefined,
      fetchImpl: (async () => new Response(`${upstreamMarker}:${baseInput.embedSecret}`, { status: 403 })) as typeof fetch,
    }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /HTTP 403/);
      assert.equal(message.includes(upstreamMarker), false);
      assert.equal(message.includes(baseInput.embedSecret), false);
      return true;
    },
  );
});

test('redirects and Omni host lookalikes are rejected', async () => {
  await assert.rejects(
    generateSignedEmbedUrl(baseInput, {
      assertSafeUrl: async () => undefined,
      fetchImpl: (async () => new Response(null, {
        status: 302,
        headers: { Location: 'https://attacker.example/embed' },
      })) as typeof fetch,
    }),
    /HTTP 302/,
  );

  for (const host of [
    'example.omniapp.co',
    'example-embed-omniapp.co',
    'example.embed-omniapp.co.attacker.example',
  ]) {
    await assert.rejects(
      generateSignedEmbedUrl(baseInput, {
        assertSafeUrl: async () => undefined,
        fetchImpl: (async () => generatedResponse(signedUrl(host))) as typeof fetch,
      }),
      /unexpected host/,
    );
  }

  const trailingDotBase = { ...baseInput, baseUrl: 'https://example.omniapp.co.' };
  await assert.rejects(
    generateSignedEmbedUrl(trailingDotBase, {
      assertSafeUrl: async () => undefined,
      fetchImpl: (async () => generatedResponse(signedUrl('example.omniapp.co.'))) as typeof fetch,
    }),
    /unexpected host/,
  );
  assert.deepEqual(await generateSignedEmbedUrl(trailingDotBase, {
    assertSafeUrl: async () => undefined,
    fetchImpl: (async () => generatedResponse(signedUrl())) as typeof fetch,
  }), { url: signedUrl() });
});

test('custom vanity bases accept only the exact same host', async () => {
  const customInput = { ...baseInput, baseUrl: 'https://analytics.customer.example' };
  const valid = signedUrl('analytics.customer.example');
  const result = await generateSignedEmbedUrl(customInput, {
    assertSafeUrl: async () => undefined,
    fetchImpl: (async () => generatedResponse(valid)) as typeof fetch,
  });
  assert.deepEqual(result, { url: valid });

  await assert.rejects(
    generateSignedEmbedUrl(customInput, {
      assertSafeUrl: async () => undefined,
      fetchImpl: (async () => generatedResponse(signedUrl('embed.customer.example'))) as typeof fetch,
    }),
    /unexpected host/,
  );
});

test('signed output rejects wrong schemes, userinfo, fragments, and ambiguous raw paths', async () => {
  const query = signedUrl().slice(signedUrl().indexOf('?'));
  const candidates = [
    signedUrl().replace('https:', 'http:'),
    signedUrl().replace('https://', 'https://user:password@'),
    signedUrl().replace('https://', 'https://@'),
    `${signedUrl()}#private-fragment`,
    `${signedUrl()}#`,
    `https://example.embed-omniapp.co/embed/login/${query}`,
    `https://example.embed-omniapp.co/%65mbed/login${query}`,
    `https://example.embed-omniapp.co/embed//login${query}`,
    `https://example.embed-omniapp.co/embed/other/../login${query}`,
    `https://example.embed-omniapp.co/embed\\login${query}`,
    signedUrl().replace('embed-omniapp', 'embed-\nomniapp'),
  ];

  for (const candidate of candidates) {
    await assert.rejects(
      generateSignedEmbedUrl(baseInput, {
        assertSafeUrl: async () => undefined,
        fetchImpl: (async () => generatedResponse(candidate)) as typeof fetch,
      }),
      /invalid signed embed URL|documented standard SSO URL shape/,
    );
  }
});

test('signed output requires exact single identity, nonce, and signature parameters', async () => {
  const candidates: string[] = [];

  const wrongIdentity = new URL(signedUrl());
  wrongIdentity.searchParams.set('externalId', 'different-external-id');
  candidates.push(wrongIdentity.toString());

  const duplicateIdentity = new URL(signedUrl());
  duplicateIdentity.searchParams.append('contentPath', String(baseInput.embedData.contentPath));
  candidates.push(duplicateIdentity.toString());

  const missingName = new URL(signedUrl());
  missingName.searchParams.delete('name');
  candidates.push(missingName.toString());

  const queryLookalike = new URL(signedUrl());
  queryLookalike.searchParams.append('ContentPath', String(baseInput.embedData.contentPath));
  candidates.push(queryLookalike.toString());

  const unsafeNonce = new URL(signedUrl());
  unsafeNonce.searchParams.set('nonce', '../../unsafe');
  candidates.push(unsafeNonce.toString());

  const missingNonce = new URL(signedUrl());
  missingNonce.searchParams.delete('nonce');
  candidates.push(missingNonce.toString());

  const duplicateNonce = new URL(signedUrl());
  duplicateNonce.searchParams.append('nonce', NONCE);
  candidates.push(duplicateNonce.toString());

  const duplicateSignature = new URL(signedUrl());
  duplicateSignature.searchParams.append('signature', SIGNATURE);
  candidates.push(duplicateSignature.toString());

  const missingSignature = new URL(signedUrl());
  missingSignature.searchParams.delete('signature');
  candidates.push(missingSignature.toString());

  const shortSignature = new URL(signedUrl());
  shortSignature.searchParams.set('signature', 'too-short');
  candidates.push(shortSignature.toString());

  const leakedSecret = new URL(signedUrl());
  leakedSecret.searchParams.set('secret', baseInput.embedSecret);
  candidates.push(leakedSecret.toString());

  const disguisedSecret = new URL(signedUrl());
  disguisedSecret.searchParams.set('optionalField', `prefix-${baseInput.embedSecret}-suffix`);
  candidates.push(disguisedSecret.toString());

  for (const candidate of candidates) {
    await assert.rejects(
      generateSignedEmbedUrl(baseInput, {
        assertSafeUrl: async () => undefined,
        fetchImpl: (async () => generatedResponse(candidate)) as typeof fetch,
      }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.equal(message.includes(candidate), false);
        assert.equal(message.includes(baseInput.embedSecret), false);
        return true;
      },
    );
  }
});

test('ambiguous response fields and rejected URL values are never echoed', async () => {
  const privateMarker = 'raw-url-private-marker';
  const rejected = new URL(signedUrl());
  rejected.searchParams.set('name', privateMarker);

  await assert.rejects(
    generateSignedEmbedUrl(baseInput, {
      assertSafeUrl: async () => undefined,
      fetchImpl: (async () => generatedResponse(rejected.toString())) as typeof fetch,
    }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.equal(message.includes(privateMarker), false);
      assert.equal(message.includes(baseInput.embedSecret), false);
      return true;
    },
  );

  await assert.rejects(
    generateSignedEmbedUrl(baseInput, {
      assertSafeUrl: async () => undefined,
      fetchImpl: (async () => generatedResponse(signedUrl(), { embed_url: signedUrl() })) as typeof fetch,
    }),
    /ambiguous signed embed URL response/,
  );
});

test('HTTP handler is POST-only and returns a generic failure envelope', async () => {
  const methodResponse = await handler(new Request('http://127.0.0.1/api/generate-embed-url'));
  assert.equal(methodResponse.status, 405);

  const invalidResponse = await handler(new Request('http://127.0.0.1/api/generate-embed-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base_url: 'https://example.omniapp.co',
      embed_secret: baseInput.embedSecret,
      embed_data: { contentPath: '/dashboards/example' },
    }),
  }));
  const body = JSON.stringify(await invalidResponse.json());
  assert.equal(invalidResponse.status, 400);
  assert.equal(body.includes(baseInput.embedSecret), false);
  assert.match(body, /externalId/);
});

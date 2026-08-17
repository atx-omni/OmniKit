import assert from 'node:assert/strict';
import { lookup as dnsLookup } from 'node:dns';
import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import { pinnedOmniFetch } from '../server/handlers/instances';

interface StubRequestOptions {
  headers?: Record<string, string>;
  lookup?: LookupFunction;
  signal?: AbortSignal;
}

type RequestEndHandler = (
  url: URL,
  options: StubRequestOptions,
  callback: (response: IncomingMessage) => void,
  request: EventEmitter,
) => void;

function stubHttpsRequest(onEnd: RequestEndHandler): typeof httpsRequest {
  const implementation = (
    input: URL,
    rawOptions: unknown,
    callback: (response: IncomingMessage) => void,
  ): ClientRequest => {
    const request = new EventEmitter();
    const options = rawOptions as StubRequestOptions;
    Object.assign(request, {
      end: () => onEnd(input, options, callback, request),
      destroy: () => undefined,
    });
    return request as ClientRequest;
  };
  return implementation as unknown as typeof httpsRequest;
}

function stubIncomingResponse(
  status: number,
  body: string,
  headers: IncomingMessage['headers'] = {},
): IncomingMessage {
  const response = Readable.from([Buffer.from(body)]) as Readable & Partial<IncomingMessage>;
  response.statusCode = status;
  response.statusMessage = status === 302 ? 'Found' : 'OK';
  response.headers = headers;
  return response as IncomingMessage;
}

test('pinned inventory transport rechecks DNS at connection time and rejects a private answer', async () => {
  let preflightCalls = 0;
  let responseCallbackCalls = 0;
  const privateResolver = ((
    _hostname: string,
    _options: unknown,
    callback: (error: Error | null, addresses: Array<{ address: string; family: number }>) => void,
  ) => callback(null, [{ address: '127.0.0.1', family: 4 }])) as unknown as typeof dnsLookup;
  const request = stubHttpsRequest((url, options, callback, outbound) => {
    const lookup = options.lookup as unknown as (
      hostname: string,
      lookupOptions: { all: boolean },
      callback: (error: Error | null) => void,
    ) => void;
    lookup(url.hostname, { all: false }, (error) => {
      if (error) outbound.emit('error', error);
      else {
        responseCallbackCalls += 1;
        callback(stubIncomingResponse(200, '{}'));
      }
    });
  });

  await assert.rejects(
    pinnedOmniFetch(
      'https://public.example.omniapp.co/api/v1/documents',
      { method: 'GET', headers: { Authorization: 'Bearer secret' } },
      {
        validateProbeOutbound: async () => {
          preflightCalls += 1;
        },
        probeLookup: privateResolver,
        pinnedRequest: request,
      },
      1024,
    ),
    /local or private address/,
  );
  assert.equal(preflightCalls, 1);
  assert.equal(responseCallbackCalls, 0);
});

test('pinned inventory transport returns redirects without following or forwarding credentials', async () => {
  const requestedUrls: string[] = [];
  const authorizationHeaders: Array<string | undefined> = [];
  const request = stubHttpsRequest((url, options, callback) => {
    requestedUrls.push(url.toString());
    authorizationHeaders.push(options.headers?.authorization);
    callback(stubIncomingResponse(302, '{}', {
      location: 'https://attacker.example/collect',
      'content-length': '2',
    }));
  });

  const response = await pinnedOmniFetch(
    'https://public.example.omniapp.co/api/v1/documents',
    {
      method: 'GET',
      redirect: 'manual',
      headers: { Authorization: 'Bearer secret' },
    },
    {
      validateProbeOutbound: async () => undefined,
      pinnedRequest: request,
    },
    1024,
  );

  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), 'https://attacker.example/collect');
  assert.deepEqual(requestedUrls, ['https://public.example.omniapp.co/api/v1/documents']);
  assert.deepEqual(authorizationHeaders, ['Bearer secret']);
});

test('pinned inventory transport rejects a response body above its configured bound', async () => {
  let response: IncomingMessage | undefined;
  const request = stubHttpsRequest((_url, _options, callback) => {
    response = stubIncomingResponse(200, 'oversized', { 'content-length': '9' });
    callback(response);
  });

  await assert.rejects(
    pinnedOmniFetch(
      'https://public.example.omniapp.co/api/v1/documents',
      { method: 'GET' },
      {
        validateProbeOutbound: async () => undefined,
        pinnedRequest: request,
      },
      8,
    ),
    /invalid success response/,
  );
  assert.equal(response?.destroyed, true);
});

test('pinned inventory transport propagates caller cancellation to the connection request', async () => {
  const controller = new AbortController();
  let observedSignal: AbortSignal | undefined;
  const request = stubHttpsRequest((_url, options, _callback, outbound) => {
    observedSignal = options.signal;
    const rejectForAbort = () => outbound.emit(
      'error',
      options.signal?.reason instanceof Error
        ? options.signal.reason
        : new DOMException('The operation was aborted.', 'AbortError'),
    );
    if (options.signal?.aborted) rejectForAbort();
    else options.signal?.addEventListener('abort', rejectForAbort, { once: true });
  });

  const pending = pinnedOmniFetch(
    'https://public.example.omniapp.co/api/v1/documents',
    { method: 'GET', signal: controller.signal },
    {
      validateProbeOutbound: async () => undefined,
      pinnedRequest: request,
    },
    1024,
  );
  await Promise.resolve();
  controller.abort(new DOMException('The caller left.', 'AbortError'));

  await assert.rejects(
    pending,
    (error: unknown) => error instanceof Error && error.name === 'AbortError',
  );
  assert.equal(observedSignal, controller.signal);
  assert.equal(observedSignal?.aborted, true);
});

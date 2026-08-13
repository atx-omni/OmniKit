import { lookup as dnsLookup } from 'node:dns';
import type { LookupAddress, LookupOptions } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { LookupFunction } from 'node:net';
import { isIP } from 'node:net';
import { assertSafeOutboundUrl, isPrivateOrLocalAddress } from '../../security';
import { migrationSourceHostAllowlist } from '../semanticMigrationAudit';
import type {
  MigrationSourceTransport,
  MigrationSourceTransportRequest,
  MigrationSourceTransportResponse,
} from './contracts';

const DEFAULT_DEADLINE_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_DEADLINE_MS = 120_000;
const MAX_RESPONSE_BYTES = 120 * 1024 * 1024;

function transportError(message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { statusCode });
}

function responseHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).flatMap(([key, value]) => {
    if (value == null || key.toLowerCase() === 'set-cookie') return [];
    return [[key.toLowerCase(), Array.isArray(value) ? value.join(', ') : value]];
  }));
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Math.min(Number(value), maximum) : fallback;
}

async function readBoundedBody(
  response: IncomingMessage,
  maximumBytes: number,
  controller: AbortController,
  label: string,
): Promise<Uint8Array> {
  const declared = Number(response.headers['content-length'] || 0);
  if (Number.isFinite(declared) && declared > maximumBytes) {
    response.destroy();
    throw transportError(`${label} exceeded the configured response-size limit. Narrow the selected source scope.`, 413);
  }
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  for await (const value of response) {
    const chunk = typeof value === 'string' ? Buffer.from(value) : new Uint8Array(value);
    bytesRead += chunk.byteLength;
    if (bytesRead > maximumBytes) {
      controller.abort();
      response.destroy();
      throw transportError(`${label} exceeded the configured response-size limit. Narrow the selected source scope.`, 413);
    }
    chunks.push(chunk);
  }
  const body = new Uint8Array(bytesRead);
  let offset = 0;
  chunks.forEach((chunk) => {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  });
  return body;
}

function unsafeResolutionError(label: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${label} resolved to a local or private network address while connecting.`), {
    code: 'EACCES',
    statusCode: 409,
  });
}

/**
 * Resolve again at the socket boundary and hand only the checked addresses to
 * Node's connector. This closes the DNS-rebinding window between the initial
 * URL policy check and the actual TCP/TLS connection while the original URL
 * hostname remains intact for Host, certificate verification, and TLS SNI.
 */
function publicOnlyLookup(label: string): LookupFunction {
  return (hostname, options, callback) => {
    const requestedAll = options.all === true;
    const lookupOptions: LookupOptions = {
      ...options,
      all: true,
      verbatim: true,
    };
    dnsLookup(hostname, lookupOptions, (error, records) => {
      if (error) {
        callback(error, '', 0);
        return;
      }
      const addresses = records as LookupAddress[];
      if (addresses.length === 0) {
        callback(Object.assign(new Error(`${label} host could not be resolved safely while connecting.`), {
          code: 'ENOTFOUND',
          statusCode: 502,
        }), '', 0);
        return;
      }
      if (addresses.some((record) => isPrivateOrLocalAddress(record.address))) {
        callback(unsafeResolutionError(label), '', 0);
        return;
      }
      if (requestedAll) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

async function sendRequest(
  request: MigrationSourceTransportRequest,
  controller: AbortController,
): Promise<{ status: number; headers: Record<string, string>; bytes: Uint8Array }> {
  const parsed = new URL(request.url);
  return new Promise((resolve, reject) => {
    const outbound = httpsRequest(parsed, {
      method: request.method || 'GET',
      headers: request.headers,
      agent: false,
      lookup: publicOnlyLookup(request.label),
      // IP literals do not use SNI; DNS names retain the original hostname so
      // certificate validation is never performed against a resolved address.
      ...(isIP(parsed.hostname) ? {} : { servername: parsed.hostname }),
      signal: controller.signal,
    }, (response) => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400) {
        response.destroy();
        reject(transportError(`${request.label} attempted an HTTP redirect. OmniKit stopped before forwarding source credentials.`, 502));
        return;
      }
      void readBoundedBody(
        response,
        boundedInteger(request.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES),
        controller,
        request.label,
      ).then((bytes) => resolve({ status, headers: responseHeaders(response.headers), bytes }), reject);
    });
    outbound.once('error', reject);
    if (request.body != null) outbound.write(request.body);
    outbound.end();
  });
}

function decodeBody<T>(bytes: Uint8Array, type: MigrationSourceTransportRequest['responseType'], label: string): T {
  if (type === 'bytes') return bytes as T;
  const text = new TextDecoder().decode(bytes);
  if (type === 'text') return text as T;
  if (!text.trim()) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw transportError(`${label} returned an unrecognized non-JSON success response.`, 502);
  }
}

export function createMigrationSourceTransport(): MigrationSourceTransport {
  return {
    async request<T = unknown>(request: MigrationSourceTransportRequest): Promise<MigrationSourceTransportResponse<T>> {
      await assertSafeOutboundUrl(request.url, {
        label: `${request.label} URL`,
        allowlist: migrationSourceHostAllowlist(),
      });
      const deadlineMs = boundedInteger(request.deadlineMs, DEFAULT_DEADLINE_MS, MAX_DEADLINE_MS);
      const maximumBytes = boundedInteger(request.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES);
      const controller = new AbortController();
      let timedOut = false;
      const abortFromParent = () => controller.abort();
      request.signal?.addEventListener('abort', abortFromParent, { once: true });
      if (request.signal?.aborted) controller.abort();
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, deadlineMs);
      try {
        const response = await sendRequest({ ...request, maxResponseBytes: maximumBytes }, controller);
        const allowed = (response.status >= 200 && response.status < 300) || request.allowStatuses?.includes(response.status) === true;
        if (!allowed) {
          throw transportError(`${request.label} returned HTTP ${response.status}. Verify the selected source credential, permission scope, and vendor API availability.`, response.status === 401 || response.status === 403 ? 409 : 502);
        }
        return {
          status: response.status,
          headers: response.headers,
          body: decodeBody<T>(response.bytes, request.responseType || 'json', request.label),
          bytesRead: response.bytes.byteLength,
          finalUrl: request.url,
          requestCount: 1,
        };
      } catch (error) {
        if (controller.signal.aborted && !(error as { statusCode?: number })?.statusCode) {
          throw transportError(timedOut
            ? `${request.label} timed out before the complete response body was received.`
            : `${request.label} was cancelled.`, timedOut ? 504 : 499);
        }
        throw error;
      } finally {
        clearTimeout(timeout);
        request.signal?.removeEventListener('abort', abortFromParent);
      }
    },
  };
}

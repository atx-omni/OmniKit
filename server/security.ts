import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const LOOPBACK_NAMES = new Set(['localhost', '0.0.0.0']);
const ALLOWED_PROXY_ENDPOINT_RE = /^\/v1(?:\/|$)/;

export interface OutboundUrlValidationOptions {
  allowPrivate?: boolean;
  allowlist?: string[];
  allowQueryAndHash?: boolean;
  label?: string;
  resolveHost?: (hostname: string) => Promise<Array<{ address: string }>>;
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function ipv4ToNumber(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
    out = (out << 8) + value;
  }
  return out >>> 0;
}

function ipv4FromMappedIpv6(address: string): string | null {
  const normalized = normalizeHostname(address);
  if (!normalized.startsWith('::ffff:')) return null;
  const suffix = normalized.slice('::ffff:'.length);
  if (isIP(suffix) === 4) return suffix;
  const parts = suffix.split(':');
  if (parts.length < 2) return null;
  const high = Number.parseInt(parts[parts.length - 2], 16);
  const low = Number.parseInt(parts[parts.length - 1], 16);
  if (!Number.isFinite(high) || !Number.isFinite(low) || high < 0 || high > 0xffff || low < 0 || low > 0xffff) {
    return null;
  }
  return `${(high >> 8) & 255}.${high & 255}.${(low >> 8) & 255}.${low & 255}`;
}

function isPrivateIpv4(address: string): boolean {
  const value = ipv4ToNumber(address);
  if (value == null) return false;
  return (
    (value >>> 24) === 0
    || (value >>> 24) === 10
    || (value >>> 24) === 127
    || (value >>> 20) === 0xac1
    || (value >>> 16) === 0xc0a8
    || (value >>> 16) === 0xa9fe
    || (value >>> 28) === 0xe
    || value === 0xffffffff
  );
}

function isPrivateIpv6(address: string): boolean {
  const normalized = normalizeHostname(address);
  const mapped = ipv4FromMappedIpv6(normalized);
  if (mapped) return isPrivateIpv4(mapped);
  if (normalized === '::' || normalized === '::1') return true;
  const firstPart = normalized.split(':')[0];
  const first = Number.parseInt(firstPart || '0', 16);
  if (!Number.isFinite(first)) return false;
  return (
    first >= 0xfc00 && first <= 0xfdff
    || first >= 0xfe80 && first <= 0xfebf
    || first >= 0xff00 && first <= 0xffff
  );
}

export function isPrivateOrLocalAddress(address: string): boolean {
  const normalized = normalizeHostname(address);
  if (LOOPBACK_NAMES.has(normalized)) return true;
  const family = isIP(normalized);
  if (family === 4) return isPrivateIpv4(normalized);
  if (family === 6) return isPrivateIpv6(normalized);
  return false;
}

export function validatePublicHttpsUrl(raw: string, options: OutboundUrlValidationOptions = {}): string | null {
  const label = options.label || 'url';
  if (!raw || typeof raw !== 'string') return `${label} is required.`;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return `${label} is not a valid URL.`;
  }

  if (parsed.protocol !== 'https:') {
    return `${label} must use HTTPS (https://).`;
  }

  if (parsed.username || parsed.password) {
    return `${label} must not include embedded credentials.`;
  }

  if (options.allowQueryAndHash === false && (parsed.search || parsed.hash)) {
    return `${label} must not include query strings or fragments.`;
  }

  const host = normalizeHostname(parsed.hostname);
  if (!options.allowPrivate && isPrivateOrLocalAddress(host)) {
    return `${label} must not point to a local or private network address.`;
  }

  const allowlist = options.allowlist?.map((entry) => normalizeHostname(entry)).filter(Boolean) || [];
  if (allowlist.length > 0 && !allowlist.some((entry) => host === entry || host.endsWith(`.${entry}`))) {
    return `${label} host is not allowlisted: ${host}.`;
  }

  return null;
}

/**
 * Validates that a base_url is safe to proxy outbound requests to.
 * Returns an error string if invalid, or null if the URL is acceptable.
 *
 * Rules enforced:
 *   1. Must be a parseable URL.
 *   2. Must use https: — no http, file, or other schemes.
 *   3. Must not target loopback, private, or link-local addresses (SSRF prevention).
 */
export function validateBaseUrl(raw: string): string | null {
  return validatePublicHttpsUrl(raw, { allowQueryAndHash: false, label: 'base_url' });
}

export async function validateOutboundUrl(raw: string, options: OutboundUrlValidationOptions = {}): Promise<string | null> {
  const formatError = validatePublicHttpsUrl(raw, { ...options, allowQueryAndHash: options.allowQueryAndHash !== false });
  if (formatError) return formatError;
  if (options.allowPrivate) return null;

  const parsed = new URL(raw);
  const host = normalizeHostname(parsed.hostname);
  if (isIP(host)) return null;

  let records: Array<{ address: string }> = [];
  try {
    records = await (options.resolveHost || ((hostname: string) => lookup(hostname, { all: true, verbatim: true })))(host);
  } catch {
    return `${options.label || 'url'} host could not be resolved safely.`;
  }
  if (records.length === 0) return `${options.label || 'url'} host could not be resolved safely.`;
  if (records.some((record) => isPrivateOrLocalAddress(record.address))) {
    return `${options.label || 'url'} resolves to a local or private network address.`;
  }
  return null;
}

export async function assertSafeOutboundUrl(raw: string, options: OutboundUrlValidationOptions = {}): Promise<void> {
  const error = await validateOutboundUrl(raw, options);
  if (error) throw new Error(error);
}

/**
 * Validates the endpoint path forwarded through omni-proxy.
 * Returns an error string if invalid, or null if acceptable.
 */
export function validateEndpoint(endpoint: string): string | null {
  if (!endpoint || typeof endpoint !== 'string') return 'endpoint is required.';
  if (!endpoint.startsWith('/')) return 'endpoint must start with /.';
  if (endpoint.includes('\\')) return 'endpoint must not contain backslashes.';

  let decoded = endpoint;
  try {
    decoded = decodeURIComponent(endpoint);
  } catch {
    return 'endpoint contains invalid encoding.';
  }

  // Block path-traversal sequences regardless of encoding.
  if (decoded.includes('..')) return 'endpoint must not contain path traversal sequences.';

  if (!ALLOWED_PROXY_ENDPOINT_RE.test(decoded)) {
    return 'omni-proxy only forwards Omni /api/v1 endpoints. Use a dedicated handler for other API surfaces.';
  }
  return null;
}

/** Standard JSON response headers for same-origin local API responses. */
export const jsonHeaders: Record<string, string> = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

/** Standard SSE response headers for streaming operations. */
export const sseHeaders: Record<string, string> = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-store',
  'Connection': 'keep-alive',
  'X-Content-Type-Options': 'nosniff',
};

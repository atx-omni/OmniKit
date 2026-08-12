import { assertSafeOutboundUrl, jsonHeaders, validateBaseUrl } from '../security';

const DEFAULT_TIMEOUT_MS = 15_000;
const SAFE_NONCE_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;
const SAFE_SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const SIGNED_QUERY_PARAMETERS = new Set(['contentPath', 'externalId', 'name', 'nonce', 'signature', 'email', 'groups']);
const ALLOWED_EMBED_DATA_KEYS = new Set(['contentPath', 'externalId', 'name', 'email', 'groups']);
const PROHIBITED_QUERY_PARAMETERS = new Set([
  'secret',
  'embedsecret',
  'embed_secret',
  'clientsecret',
  'client_secret',
  'apikey',
  'api_key',
  'authorization',
  'accesstoken',
  'access_token',
  'token',
  'credential',
  'credentials',
  'password',
  'key',
  'sig',
]);

export interface GenerateEmbedUrlInput {
  baseUrl: string;
  embedSecret: string;
  embedData: Record<string, unknown>;
}

export interface GenerateEmbedUrlDependencies {
  fetchImpl?: typeof fetch;
  assertSafeUrl?: (url: string) => Promise<void>;
  timeoutMs?: number;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : '';
}

function statusError(message: string, statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

function rawPath(rawUrl: string): string {
  const schemeEnd = rawUrl.indexOf('://');
  if (schemeEnd < 0) return '';
  const authorityStart = schemeEnd + 3;
  const pathStart = rawUrl.indexOf('/', authorityStart);
  const queryStart = rawUrl.indexOf('?', authorityStart);
  const fragmentStart = rawUrl.indexOf('#', authorityStart);
  const firstSuffix = [queryStart, fragmentStart].filter((index) => index >= 0)
    .reduce((minimum, index) => Math.min(minimum, index), rawUrl.length);
  if (pathStart < 0 || pathStart > firstSuffix) return '';
  return rawUrl.slice(pathStart, firstSuffix);
}

function rawAuthority(rawUrl: string): string {
  const schemeEnd = rawUrl.indexOf('://');
  if (schemeEnd < 0) return '';
  const authorityStart = schemeEnd + 3;
  const authorityEnd = ['/', '?', '#']
    .map((separator) => rawUrl.indexOf(separator, authorityStart))
    .filter((index) => index >= 0)
    .reduce((minimum, index) => Math.min(minimum, index), rawUrl.length);
  return rawUrl.slice(authorityStart, authorityEnd);
}

function expectedSignedHost(baseUrl: URL): string {
  const hostname = baseUrl.hostname.toLowerCase().replace(/\.$/, '');
  if (hostname === 'omniapp.co' || hostname.endsWith('.omniapp.co')) {
    const match = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.omniapp\.co$/.exec(hostname);
    if (!match) throw statusError('The Omni base URL is not a canonical tenant host.', 400);
    return `${match[1]}.embed-omniapp.co`;
  }
  return baseUrl.host.toLowerCase();
}

function exactQueryValue(url: URL, key: string, expected: string): void {
  const values = url.searchParams.getAll(key);
  if (values.length !== 1 || values[0] !== expected) {
    throw statusError('Omni returned a signed embed URL whose required identity values did not match the request.', 502);
  }
}

function containsAsciiWhitespaceOrControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x20 || codePoint === 0x7f) return true;
  }
  return false;
}

function validateSignedEmbedUrl(
  generatedUrl: string,
  baseUrl: URL,
  embedSecret: string,
  required: { contentPath: string; externalId: string; name: string; email?: string; groups?: string[] },
): string {
  if (generatedUrl !== generatedUrl.trim() || containsAsciiWhitespaceOrControl(generatedUrl)) {
    throw statusError('Omni returned an invalid signed embed URL.', 502);
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(generatedUrl);
  } catch {
    throw statusError('Omni returned an invalid signed embed URL.', 502);
  }

  if (
    parsedUrl.protocol !== 'https:'
    || parsedUrl.username
    || parsedUrl.password
    || rawAuthority(generatedUrl).includes('@')
    || generatedUrl.includes('#')
    || parsedUrl.pathname !== '/embed/login'
    || rawPath(generatedUrl) !== '/embed/login'
  ) {
    throw statusError('Omni returned a signed embed URL that did not match the documented standard SSO URL shape.', 502);
  }

  const expectedHost = expectedSignedHost(baseUrl);
  if (parsedUrl.host.toLowerCase() !== expectedHost) {
    throw statusError('Omni returned a signed embed URL for an unexpected host.', 502);
  }

  const allowedQueryParameters = new Set([
    'contentPath', 'externalId', 'name', 'nonce', 'signature',
    ...(required.email ? ['email'] : []),
    ...(required.groups ? ['groups'] : []),
  ]);
  for (const key of parsedUrl.searchParams.keys()) {
    const canonicalKey = [...SIGNED_QUERY_PARAMETERS].find((candidate) => candidate.toLowerCase() === key.toLowerCase());
    if (canonicalKey && key !== canonicalKey) {
      throw statusError('Omni returned a signed embed URL with an ambiguous protected query parameter.', 502);
    }
    if (PROHIBITED_QUERY_PARAMETERS.has(key.toLowerCase())) {
      throw statusError('Omni returned a signed embed URL containing a prohibited credential parameter.', 502);
    }
    if (!allowedQueryParameters.has(key)) {
      throw statusError('Omni returned a signed embed URL with an unexpected query parameter.', 502);
    }
  }
  if ([...parsedUrl.searchParams].some(([key, value]) => key.includes(embedSecret) || value.includes(embedSecret))) {
    throw statusError('Omni returned a signed embed URL containing prohibited secret material.', 502);
  }

  exactQueryValue(parsedUrl, 'contentPath', required.contentPath);
  exactQueryValue(parsedUrl, 'externalId', required.externalId);
  exactQueryValue(parsedUrl, 'name', required.name);
  if (required.email) exactQueryValue(parsedUrl, 'email', required.email);
  if (required.groups) {
    const groupValues = parsedUrl.searchParams.getAll('groups');
    let parsedGroups: unknown = null;
    try {
      parsedGroups = groupValues.length === 1 ? JSON.parse(groupValues[0]) : null;
    } catch {
      parsedGroups = null;
    }
    if (
      !Array.isArray(parsedGroups)
      || parsedGroups.length !== required.groups.length
      || parsedGroups.some((group, index) => group !== required.groups?.[index])
    ) {
      throw statusError('Omni returned a signed embed URL whose group values did not match the request.', 502);
    }
  }

  const nonceValues = parsedUrl.searchParams.getAll('nonce');
  const signatureValues = parsedUrl.searchParams.getAll('signature');
  if (
    nonceValues.length !== 1
    || signatureValues.length !== 1
    || !SAFE_NONCE_PATTERN.test(nonceValues[0])
    || !SAFE_SIGNATURE_PATTERN.test(signatureValues[0])
  ) {
    throw statusError('Omni returned a signed embed URL without safe nonce and signature values.', 502);
  }

  return parsedUrl.toString();
}

export async function generateSignedEmbedUrl(
  input: GenerateEmbedUrlInput,
  dependencies: GenerateEmbedUrlDependencies = {},
): Promise<{ url: string }> {
  const urlError = validateBaseUrl(input.baseUrl);
  if (urlError) throw statusError(urlError, 400);

  const embedSecret = input.embedSecret;
  if (!embedSecret.trim()) throw statusError('Embed secret is required.', 400);

  const contentPath = requiredString(input.embedData, 'contentPath');
  const externalId = requiredString(input.embedData, 'externalId');
  const name = requiredString(input.embedData, 'name');
  if (!contentPath || !externalId || !name) {
    throw statusError('contentPath, externalId, and name are required.', 400);
  }
  if (Object.keys(input.embedData).some((key) => !ALLOWED_EMBED_DATA_KEYS.has(key))) {
    throw statusError('The embed URL request contained unsupported fields.', 400);
  }
  let email: string | undefined;
  if (input.embedData.email !== undefined) {
    if (typeof input.embedData.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.embedData.email.trim())) {
      throw statusError('A valid email is required when email is provided.', 400);
    }
    email = input.embedData.email.trim();
  }
  let groups: string[] | undefined;
  if (input.embedData.groups !== undefined) {
    if (
      !Array.isArray(input.embedData.groups)
      || input.embedData.groups.some((group) => typeof group !== 'string' || !group.trim())
    ) {
      throw statusError('Groups must be a list of non-empty group names.', 400);
    }
    const normalizedGroups = input.embedData.groups.map((group) => (group as string).trim());
    if (new Set(normalizedGroups).size !== normalizedGroups.length) {
      throw statusError('Groups must not contain duplicate names.', 400);
    }
    if (normalizedGroups.length > 0) groups = normalizedGroups;
  }

  const cleanUrl = input.baseUrl.replace(/\/+$/, '');
  const parsedBaseUrl = new URL(cleanUrl);
  expectedSignedHost(parsedBaseUrl);
  const requestUrl = `${cleanUrl}/embed/sso/generate-url`;
  const assertSafeUrl = dependencies.assertSafeUrl
    || ((url: string) => assertSafeOutboundUrl(url, { label: 'base_url' }));
  const fetchImpl = dependencies.fetchImpl || fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    await assertSafeUrl(requestUrl);
    const response = await fetchImpl(requestUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      redirect: 'manual',
      signal: controller.signal,
      body: JSON.stringify({
        contentPath,
        externalId,
        name,
        ...(email ? { email } : {}),
        ...(groups ? { groups } : {}),
        secret: embedSecret,
      }),
    });

    if (!response.ok) {
      throw statusError(
        `Omni rejected standard SSO URL generation with HTTP ${response.status}. Verify the embed secret and required identity fields in Omni.`,
        response.status >= 400 && response.status < 600 ? response.status : 502,
      );
    }

    const payload = await response.json().catch(() => null) as unknown;
    const payloadRecord = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : null;
    const canonicalUrl = typeof payloadRecord?.url === 'string' ? payloadRecord.url : undefined;
    const legacyUrl = typeof payloadRecord?.embed_url === 'string' ? payloadRecord.embed_url : undefined;
    if (canonicalUrl && legacyUrl) throw statusError('Omni returned an ambiguous signed embed URL response.', 502);
    const generatedUrl = canonicalUrl || legacyUrl || '';
    if (!generatedUrl) throw statusError('Omni returned no signed embed URL.', 502);
    return {
      url: validateSignedEmbedUrl(generatedUrl, parsedBaseUrl, embedSecret, {
        contentPath,
        externalId,
        name,
        ...(email ? { email } : {}),
        ...(groups ? { groups } : {}),
      }),
    };
  } catch (error) {
    if (typeof (error as { statusCode?: unknown }).statusCode === 'number') throw error;
    throw statusError('Omni standard SSO URL generation could not be completed.', 502);
  } finally {
    clearTimeout(timeout);
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: jsonHeaders });
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  try {
    const body = await req.json() as Record<string, unknown>;
    const result = await generateSignedEmbedUrl({
      baseUrl: typeof body.base_url === 'string' ? body.base_url : '',
      embedSecret: typeof body.embed_secret === 'string' ? body.embed_secret : '',
      embedData: body.embed_data && typeof body.embed_data === 'object' && !Array.isArray(body.embed_data)
        ? body.embed_data as Record<string, unknown>
        : {},
    });
    return json(result);
  } catch (error) {
    const statusCode = typeof (error as { statusCode?: unknown }).statusCode === 'number'
      ? (error as { statusCode: number }).statusCode
      : 502;
    return json({
      error: statusCode === 400
        ? (error instanceof Error ? error.message : 'Invalid embed URL request.')
        : 'Signed embed URL generation could not be completed. Verify the standard SSO configuration in Omni.',
    }, statusCode);
  }
}

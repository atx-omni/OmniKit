import type { PostMigrationAction } from './nativeVault';
import {
  isPrivateOrLocalAddress,
  validateOutboundUrl,
  validatePublicHttpsUrl,
} from '../security';

const MAX_REDIRECTS = 5;

function postActionAllowPrivate(): boolean {
  return process.env.OMNIKIT_ALLOW_PRIVATE_POST_ACTIONS === 'true';
}

function postActionAllowlist(): string[] {
  return (process.env.OMNIKIT_POST_ACTION_ALLOWLIST || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export function validatePostMigrationActionTarget(action: PostMigrationAction): string | null {
  if (action.kind === 'refresh-schema') return null;
  let url: URL;
  try {
    url = new URL(action.url);
  } catch {
    return 'Post-migration action URL is invalid.';
  }
  const formatError = validatePublicHttpsUrl(action.url, {
    allowPrivate: true,
    label: 'Post-migration action URL',
  });
  if (formatError) {
    return /HTTPS/.test(formatError) ? 'Post-migration actions must use HTTPS.' : formatError;
  }
  const allowPrivate = postActionAllowPrivate();
  const hostname = url.hostname.toLowerCase();
  if (!allowPrivate && isPrivateOrLocalAddress(hostname)) {
    return 'Private-network post-migration actions are blocked by default.';
  }
  const allowlist = postActionAllowlist();
  if (allowlist.length > 0 && !allowlist.some((entry) => hostname === entry || hostname.endsWith(`.${entry}`))) {
    return `Post-migration action host is not allowlisted: ${hostname}.`;
  }
  return null;
}

export async function validatePostMigrationActionTargetForRequest(action: PostMigrationAction): Promise<string | null> {
  const syncError = validatePostMigrationActionTarget(action);
  if (syncError) return syncError;
  const error = await validateOutboundUrl(action.url, {
    allowPrivate: postActionAllowPrivate(),
    allowlist: postActionAllowlist(),
    label: 'Post-migration action URL',
  });
  if (!error) return null;
  if (/local or private network address/i.test(error)) return 'Private-network post-migration actions are blocked by default.';
  if (/host is not allowlisted/i.test(error)) return error.replace(/^Post-migration action URL host/, 'Post-migration action host');
  return error;
}

export async function fetchPostMigrationAction(action: PostMigrationAction): Promise<Response> {
  let currentUrl = action.url;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const validationError = await validatePostMigrationActionTargetForRequest({ ...action, url: currentUrl });
    if (validationError) throw new Error(validationError);
    const response = await fetch(currentUrl, {
      method: action.method,
      headers: action.headers,
      body: action.method === 'GET' ? undefined : action.body || undefined,
      redirect: 'manual',
    });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    currentUrl = new URL(location, currentUrl).toString();
  }
  throw new Error('Post-migration action followed too many redirects.');
}

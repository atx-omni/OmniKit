export type OmniDeepLinkTarget = 'tenant_root' | 'api_explorer';

const TARGET_PATHS: Record<OmniDeepLinkTarget, string> = {
  tenant_root: '/',
  api_explorer: '/api-explorer',
};

function validatedTenantOrigin(baseUrl: string): string | null {
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) return null;
    if (baseUrl !== parsed.origin && baseUrl !== `${parsed.origin}/`) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function buildOmniDeepLink(baseUrl: string, target: OmniDeepLinkTarget): string | null {
  const origin = validatedTenantOrigin(baseUrl);
  if (!origin || !(target in TARGET_PATHS)) return null;
  return new URL(TARGET_PATHS[target], origin).toString();
}

export function isSafeOmniDeepLink(
  url: string,
  baseUrl: string,
  target: OmniDeepLinkTarget,
): boolean {
  const expected = buildOmniDeepLink(baseUrl, target);
  if (!expected || url !== expected) return false;
  try {
    const candidate = new URL(url);
    return !candidate.username
      && !candidate.password
      && !candidate.search
      && !candidate.hash
      && candidate.toString() === expected;
  } catch {
    return false;
  }
}

export function isSafeOmniDocumentationUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:'
      && parsed.origin === 'https://docs.omni.co'
      && parsed.pathname.startsWith('/')
      && !parsed.username
      && !parsed.password
      && !parsed.search
      && !parsed.hash;
  } catch {
    return false;
  }
}

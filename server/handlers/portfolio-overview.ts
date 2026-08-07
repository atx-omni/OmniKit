import { jsonHeaders } from '../security';
import { isVaultUnlocked } from '../services/nativeVault';
import {
  getPortfolioOverview,
  PortfolioOverviewError,
} from '../services/portfolioOverview';

function json(value: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...jsonHeaders, ...extraHeaders },
  });
}

function errorResponse(code: string, status: number, extraHeaders: Record<string, string> = {}): Response {
  return json({ error: code, reasonCode: code }, status, extraHeaders);
}

function refreshRequest(url: URL): boolean | null {
  if ([...url.searchParams.keys()].some((key) => key !== 'refresh')) return null;
  const values = url.searchParams.getAll('refresh');
  if (values.length === 0) return false;
  if (values.length !== 1 || !['true', 'false'].includes(values[0]!)) return null;
  return values[0] === 'true';
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'GET') return errorResponse('METHOD_NOT_ALLOWED', 405, { Allow: 'GET' });
  if (!isVaultUnlocked()) return errorResponse('VAULT_LOCKED', 423);

  const forceRefresh = refreshRequest(new URL(req.url));
  if (forceRefresh === null) return errorResponse('INVALID_QUERY', 400);

  try {
    return json(await getPortfolioOverview({ signal: req.signal, forceRefresh }));
  } catch (error) {
    if (error instanceof PortfolioOverviewError && error.code === 'REQUEST_CANCELLED') {
      return errorResponse('REQUEST_CANCELLED', 499);
    }
    return errorResponse('PORTFOLIO_SCAN_FAILED', 502);
  }
}

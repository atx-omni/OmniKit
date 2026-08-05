import { jsonHeaders } from '../security';
import { probeOmniApiCapabilities } from '../services/omniApiCapabilities';

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: jsonHeaders });
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  try {
    const body = await req.json() as Record<string, unknown>;
    const report = await probeOmniApiCapabilities({
      baseUrl: typeof body.base_url === 'string' ? body.base_url : '',
      apiKey: typeof body.api_key === 'string' ? body.api_key : '',
      modelId: typeof body.model_id === 'string' ? body.model_id : undefined,
      documentId: typeof body.document_id === 'string' ? body.document_id : undefined,
    });
    return json({ report });
  } catch (error) {
    const statusCode = typeof (error as { statusCode?: unknown }).statusCode === 'number'
      ? (error as { statusCode: number }).statusCode
      : 502;
    return json({
      error: statusCode === 400
        ? (error instanceof Error ? error.message : 'Invalid capability probe request.')
        : 'Omni API capability verification could not be completed.',
    }, statusCode);
  }
}

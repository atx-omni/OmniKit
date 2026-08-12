import { jsonHeaders } from '../security';
import {
  getAdminReadinessReport,
  type AdminAccessPostureRequest,
  type AdminReadinessWorkspace,
} from '../services/adminReadiness';
import { getInstance } from '../services/nativeVault';

const ALLOWED_QUERY_PARAMETERS = new Set([
  'instanceId',
  'workspace',
  'principalType',
  'principalId',
  'modelId',
  'connectionId',
]);
const WORKSPACES = new Set<AdminReadinessWorkspace>(['fleet', 'identity', 'content', 'developer']);

function json(value: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...jsonHeaders, ...extraHeaders },
  });
}

function statusError(message: string, statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function boundedParameter(params: URLSearchParams, name: string, required = false): string | undefined {
  const values = params.getAll(name);
  if (values.length > 1) throw statusError(`Query parameter ${name} must be supplied at most once.`, 400);
  const value = values[0]?.trim();
  if (!value) {
    if (required) throw statusError(`Query parameter ${name} is required.`, 400);
    return undefined;
  }
  if (value.length > 500 || hasControlCharacters(value)) {
    throw statusError(`Query parameter ${name} is invalid.`, 400);
  }
  return value;
}

function parseRequest(url: URL): {
  instanceId: string;
  workspace: AdminReadinessWorkspace;
  accessPosture?: AdminAccessPostureRequest;
} {
  for (const key of url.searchParams.keys()) {
    if (!ALLOWED_QUERY_PARAMETERS.has(key)) {
      throw statusError('Unsupported admin readiness query parameter.', 400);
    }
  }
  const instanceId = boundedParameter(url.searchParams, 'instanceId', true)!;
  const workspaceValue = boundedParameter(url.searchParams, 'workspace', true)!;
  if (!WORKSPACES.has(workspaceValue as AdminReadinessWorkspace)) {
    throw statusError('Query parameter workspace must be fleet, identity, content, or developer.', 400);
  }
  const workspace = workspaceValue as AdminReadinessWorkspace;
  const principalTypeValue = boundedParameter(url.searchParams, 'principalType');
  const principalId = boundedParameter(url.searchParams, 'principalId');
  const modelId = boundedParameter(url.searchParams, 'modelId');
  const connectionId = boundedParameter(url.searchParams, 'connectionId');
  const postureRequested = Boolean(principalTypeValue || principalId || modelId || connectionId);
  if (!postureRequested) return { instanceId, workspace };
  if (workspace !== 'identity') {
    throw statusError('Access posture parameters are available only for the identity workspace.', 400);
  }
  if ((principalTypeValue !== 'user' && principalTypeValue !== 'group') || !principalId) {
    throw statusError('principalType=user|group and principalId are both required for access posture.', 400);
  }
  return {
    instanceId,
    workspace,
    accessPosture: {
      principalType: principalTypeValue,
      principalId,
      ...(modelId ? { modelId } : {}),
      ...(connectionId ? { connectionId } : {}),
    },
  };
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'GET') {
    return json({ error: 'Method not allowed.' }, 405, { Allow: 'GET' });
  }
  try {
    const parsed = parseRequest(new URL(req.url));
    const instance = getInstance(parsed.instanceId);
    if (!instance) throw statusError('Saved Omni instance not found.', 404);
    const report = await getAdminReadinessReport({
      instance,
      workspace: parsed.workspace,
      ...(parsed.accessPosture ? { accessPosture: parsed.accessPosture } : {}),
    });
    return json(report);
  } catch (error) {
    const statusCode = typeof (error as { statusCode?: unknown }).statusCode === 'number'
      ? (error as { statusCode: number }).statusCode
      : 502;
    const message = statusCode === 423
      ? 'Unlock the native vault before verifying admin readiness.'
      : statusCode === 404
        ? 'Saved Omni instance not found.'
        : statusCode === 400
          ? error instanceof Error ? error.message : 'Invalid admin readiness request.'
          : 'Admin readiness could not be verified.';
    return json({ error: message }, statusCode);
  }
}

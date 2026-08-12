import { assertSafeOutboundUrl, validateBaseUrl } from '../security';
import {
  classifyOmniApiFailure,
  findOmniApiContract,
  type OmniApiContractStatus,
} from './omniApiContracts';

const DEFAULT_TIMEOUT_MS = 15_000;

export type OmniApiProbeResultStatus =
  | 'available'
  | 'authentication_failed'
  | 'contract_failed'
  | 'request_failed'
  | 'transient_failure'
  | 'not_tested';

export type OmniApiCapabilityOverall =
  | 'compatible'
  | 'degraded'
  | 'authentication_failed'
  | 'incompatible';

export interface OmniApiCapabilityInput {
  baseUrl: string;
  apiKey: string;
  modelId?: string;
  documentId?: string;
}

export interface OmniApiCapabilityProbe {
  id: string;
  method: 'GET';
  path: string;
  required: boolean;
  contractStatus: OmniApiContractStatus | 'unregistered';
  status: OmniApiProbeResultStatus;
  httpStatus?: number;
  message: string;
}

export interface OmniApiCapabilityReport {
  checkedAt: string;
  host: string;
  overall: OmniApiCapabilityOverall;
  summary: {
    available: number;
    authenticationFailed: number;
    contractFailed: number;
    requestFailed: number;
    transientFailure: number;
    notTested: number;
  };
  probes: OmniApiCapabilityProbe[];
}

interface ProbeDefinition {
  id: string;
  path: string;
  required: boolean;
  requiredInput?: 'modelId' | 'documentId';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasArray(record: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => Array.isArray(record[key]));
}

function validProbeResponse(id: string, value: unknown): boolean {
  if (!isRecord(value)) return false;
  switch (id) {
    case 'folders': return hasArray(value, ['records']);
    case 'connections': return hasArray(value, ['records', 'connections']);
    case 'models': return hasArray(value, ['records', 'models']);
    case 'documents-list': return hasArray(value, ['records', 'documents']);
    case 'labels': return hasArray(value, ['records', 'labels']);
    case 'uploads': return hasArray(value, ['records', 'uploads']);
    case 'model-yaml': return isRecord(value.files) || Array.isArray(value.files);
    case 'model-validate': return ['valid', 'status', 'errors', 'warnings', 'results'].some((key) => key in value);
    case 'model-schemas': return hasArray(value, ['records', 'schemas']);
    case 'document-queries': return ['queries', 'tiles', 'document', 'content'].some((key) => key in value);
    case 'documents-v2-state': return ['id', 'identifier', 'document', 'content'].some((key) => key in value);
    default: return false;
  }
}

export interface OmniApiCapabilityDependencies {
  fetchImpl?: typeof fetch;
  assertSafeUrl?: (url: string) => Promise<void>;
  timeoutMs?: number;
  now?: () => Date;
}

const PROBES: ProbeDefinition[] = [
  { id: 'folders', path: '/api/v1/folders?pageSize=1', required: true },
  { id: 'connections', path: '/api/v1/connections', required: true },
  { id: 'models', path: '/api/v1/models?pageSize=1', required: true },
  { id: 'documents-list', path: '/api/v1/documents?pageSize=1', required: true },
  { id: 'labels', path: '/api/v1/labels', required: false },
  { id: 'uploads', path: '/api/v1/uploads', required: false },
  { id: 'model-yaml', path: '/api/v1/models/:modelId/yaml', required: false, requiredInput: 'modelId' },
  { id: 'model-validate', path: '/api/v1/models/:modelId/validate', required: false, requiredInput: 'modelId' },
  { id: 'model-schemas', path: '/api/v1/models/:modelId/schemas', required: false, requiredInput: 'modelId' },
  { id: 'document-queries', path: '/api/v1/documents/:documentId/queries', required: false, requiredInput: 'documentId' },
  { id: 'documents-v2-state', path: '/api/v2/documents/:documentId', required: false, requiredInput: 'documentId' },
];

function resolvedPath(definition: ProbeDefinition, input: OmniApiCapabilityInput): string | null {
  if (!definition.requiredInput) return definition.path;
  const value = input[definition.requiredInput]?.trim();
  if (!value) return null;
  return definition.path.replace(`:${definition.requiredInput}`, encodeURIComponent(value));
}

function contractPath(path: string): string {
  return path.split('?', 1)[0];
}

function resultMessage(status: OmniApiProbeResultStatus): string {
  switch (status) {
    case 'available': return 'Endpoint responded successfully.';
    case 'authentication_failed': return 'The saved credential cannot access this endpoint.';
    case 'contract_failed': return 'The endpoint is unavailable or no longer accepts this method.';
    case 'request_failed': return 'The endpoint rejected this read-only probe.';
    case 'transient_failure': return 'The endpoint could not be verified because of a temporary or network failure.';
    case 'not_tested': return 'Provide the related resource id to test this endpoint.';
  }
}

function resultStatus(httpStatus: number): OmniApiProbeResultStatus {
  if (httpStatus >= 200 && httpStatus < 300) return 'available';
  const failure = classifyOmniApiFailure(httpStatus);
  if (failure === 'authentication') return 'authentication_failed';
  if (failure === 'contract') return 'contract_failed';
  if (failure === 'transient') return 'transient_failure';
  return 'request_failed';
}

function overallStatus(probes: OmniApiCapabilityProbe[]): OmniApiCapabilityOverall {
  if (probes.some((probe) => probe.required && probe.status === 'authentication_failed')) {
    return 'authentication_failed';
  }
  if (probes.some((probe) => probe.required && probe.status === 'contract_failed')) {
    return 'incompatible';
  }
  if (probes.some((probe) => probe.required && !['available', 'not_tested'].includes(probe.status))) {
    return 'degraded';
  }
  if (probes.some((probe) => !['available', 'not_tested'].includes(probe.status))) {
    return 'degraded';
  }
  return 'compatible';
}

function reportSummary(probes: OmniApiCapabilityProbe[]): OmniApiCapabilityReport['summary'] {
  return {
    available: probes.filter((probe) => probe.status === 'available').length,
    authenticationFailed: probes.filter((probe) => probe.status === 'authentication_failed').length,
    contractFailed: probes.filter((probe) => probe.status === 'contract_failed').length,
    requestFailed: probes.filter((probe) => probe.status === 'request_failed').length,
    transientFailure: probes.filter((probe) => probe.status === 'transient_failure').length,
    notTested: probes.filter((probe) => probe.status === 'not_tested').length,
  };
}

export async function probeOmniApiCapabilities(
  input: OmniApiCapabilityInput,
  dependencies: OmniApiCapabilityDependencies = {},
): Promise<OmniApiCapabilityReport> {
  const urlError = validateBaseUrl(input.baseUrl);
  if (urlError) throw Object.assign(new Error(urlError), { statusCode: 400 });
  if (!input.apiKey?.trim()) throw Object.assign(new Error('API key is required.'), { statusCode: 400 });

  const cleanUrl = input.baseUrl.replace(/\/+$/, '');
  const fetchImpl = dependencies.fetchImpl || fetch;
  const assertSafeUrl = dependencies.assertSafeUrl
    || ((url: string) => assertSafeOutboundUrl(url, { label: 'base_url' }));
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const probes: OmniApiCapabilityProbe[] = [];

  for (const definition of PROBES) {
    const path = resolvedPath(definition, input);
    const registryPath = path ? contractPath(path) : definition.path.replace(':modelId', ':param').replace(':documentId', ':param');
    const contract = findOmniApiContract('GET', registryPath);
    if (!path) {
      probes.push({
        id: definition.id,
        method: 'GET',
        path: registryPath,
        required: definition.required,
        contractStatus: contract?.status || 'unregistered',
        status: 'not_tested',
        message: resultMessage('not_tested'),
      });
      continue;
    }

    const requestUrl = `${cleanUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      await assertSafeUrl(requestUrl);
      const response = await fetchImpl(requestUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
          Accept: 'application/json',
        },
        redirect: 'manual',
        signal: controller.signal,
      });
      let status = resultStatus(response.status);
      if (status === 'available') {
        try {
          const body = await response.json();
          if (!validProbeResponse(definition.id, body)) status = 'request_failed';
        } catch {
          status = 'request_failed';
        }
      }
      probes.push({
        id: definition.id,
        method: 'GET',
        path: contractPath(path),
        required: definition.required,
        contractStatus: contract?.status || 'unregistered',
        status,
        httpStatus: response.status,
        message: resultMessage(status),
      });
    } catch {
      probes.push({
        id: definition.id,
        method: 'GET',
        path: contractPath(path),
        required: definition.required,
        contractStatus: contract?.status || 'unregistered',
        status: 'transient_failure',
        message: resultMessage('transient_failure'),
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    checkedAt: (dependencies.now?.() || new Date()).toISOString(),
    host: new URL(cleanUrl).hostname,
    overall: overallStatus(probes),
    summary: reportSummary(probes),
    probes,
  };
}

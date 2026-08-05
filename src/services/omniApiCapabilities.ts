export type OmniApiProbeResultStatus =
  | 'available'
  | 'authentication_failed'
  | 'contract_failed'
  | 'request_failed'
  | 'transient_failure'
  | 'not_tested';

export interface OmniApiCapabilityReport {
  checkedAt: string;
  host: string;
  overall: 'compatible' | 'degraded' | 'authentication_failed' | 'incompatible';
  summary: {
    available: number;
    authenticationFailed: number;
    contractFailed: number;
    requestFailed: number;
    transientFailure: number;
    notTested: number;
  };
  probes: Array<{
    id: string;
    method: 'GET';
    path: string;
    required: boolean;
    contractStatus: 'documented_current' | 'tenant_confirmed' | 'beta' | 'deprecated' | 'unverified' | 'retired' | 'unregistered';
    status: OmniApiProbeResultStatus;
    httpStatus?: number;
    message: string;
  }>;
}

export async function fetchOmniApiCapabilities(input: {
  baseUrl: string;
  apiKey: string;
  modelId?: string;
  documentId?: string;
}): Promise<OmniApiCapabilityReport> {
  const response = await fetch('/api/omni-api-capabilities', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base_url: input.baseUrl,
      api_key: input.apiKey,
      model_id: input.modelId,
      document_id: input.documentId,
    }),
  });
  const payload = await response.json() as { report?: OmniApiCapabilityReport; error?: string };
  if (!response.ok || !payload.report) throw new Error(payload.error || 'Capability verification failed.');
  return payload.report;
}

import { assertSafeOutboundUrl, validateBaseUrl } from '../security';
import { classifyOmniApiFailure } from './omniApiContracts';

export const OMNI_API_WRITE_CANARY_CONFIRMATION = 'OMNIKIT_EPHEMERAL_LABEL_CANARY';
const CANARY_LABEL_PREFIX = 'omnikit-canary-';

export interface OmniApiLabelCanaryInput {
  baseUrl: string;
  apiKey: string;
  documentId: string;
  label: string;
  confirmation: string;
  labelWasAbsent: boolean;
}

export interface OmniApiLabelCanaryResult {
  attached: boolean;
  cleaned: boolean;
  attachStatus?: number;
  cleanupStatus?: number;
  failureClass?: ReturnType<typeof classifyOmniApiFailure>;
}

export interface OmniApiLabelCanaryDependencies {
  fetchImpl?: typeof fetch;
  assertSafeUrl?: (url: string) => Promise<void>;
}

function statusError(message: string, statusCode = 400): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

function validateInput(input: OmniApiLabelCanaryInput): void {
  const urlError = validateBaseUrl(input.baseUrl);
  if (urlError) throw statusError(urlError);
  if (!input.apiKey.trim()) throw statusError('API key is required.');
  if (!input.documentId.trim()) throw statusError('A dedicated canary document id is required.');
  if (!input.label.startsWith(CANARY_LABEL_PREFIX) || input.label.length > 100) {
    throw statusError(`The temporary label must start with ${CANARY_LABEL_PREFIX} and be at most 100 characters.`);
  }
  if (input.confirmation !== OMNI_API_WRITE_CANARY_CONFIRMATION) {
    throw statusError('The exact controlled-write confirmation is required.');
  }
  if (!input.labelWasAbsent) {
    throw statusError('Confirm that the temporary label is not currently attached to the sentinel document.');
  }
}

export async function runOmniApiLabelCanary(
  input: OmniApiLabelCanaryInput,
  dependencies: OmniApiLabelCanaryDependencies = {},
): Promise<OmniApiLabelCanaryResult> {
  validateInput(input);
  const fetchImpl = dependencies.fetchImpl || fetch;
  const assertSafeUrl = dependencies.assertSafeUrl
    || ((url: string) => assertSafeOutboundUrl(url, { label: 'base_url' }));
  const cleanUrl = input.baseUrl.replace(/\/+$/, '');
  const path = `/api/v1/documents/${encodeURIComponent(input.documentId)}/labels/${encodeURIComponent(input.label)}`;
  const url = `${cleanUrl}${path}`;
  const headers = {
    Authorization: `Bearer ${input.apiKey}`,
    Accept: 'application/json',
  };

  let attachStatus: number | undefined;
  let cleanupStatus: number | undefined;
  let attached = false;
  let failureClass: ReturnType<typeof classifyOmniApiFailure> | undefined;

  try {
    await assertSafeUrl(url);
    const attach = await fetchImpl(url, { method: 'PUT', headers, redirect: 'manual' });
    attachStatus = attach.status;
    attached = attach.ok;
    if (!attach.ok) failureClass = classifyOmniApiFailure(attach.status);
  } catch {
    failureClass = 'transient';
  } finally {
    try {
      await assertSafeUrl(url);
      const cleanup = await fetchImpl(url, { method: 'DELETE', headers, redirect: 'manual' });
      cleanupStatus = cleanup.status;
      if (!cleanup.ok && cleanup.status !== 404) {
        failureClass ||= classifyOmniApiFailure(cleanup.status);
      }
    } catch {
      failureClass ||= 'transient';
    }
  }

  const cleaned = cleanupStatus !== undefined && (cleanupStatus >= 200 && cleanupStatus < 300 || cleanupStatus === 404);
  return { attached, cleaned, attachStatus, cleanupStatus, failureClass };
}

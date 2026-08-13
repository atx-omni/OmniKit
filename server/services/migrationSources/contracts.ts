import type {
  MigrationBiSourceTool,
  MigrationPlatformAuthMode,
  MigrationPrepareEvidenceRequest,
  MigrationPreparedEvidenceResult,
  MigrationPreparedEvidenceResponse,
  MigrationSourceArtifactProvenance,
  MigrationSourceDependencyEvidence,
  MigrationPreparedEvidenceDiagnostics,
} from '../../../src/services/semanticMigration/types';

export type {
  MigrationPreparedEvidenceResult,
  MigrationPrepareEvidenceRequest,
  MigrationPreparedEvidenceResponse,
  MigrationSourceArtifactProvenance,
  MigrationSourceDependencyEvidence,
  MigrationPreparedEvidenceDiagnostics,
};

/**
 * Immutable, server-only connection snapshot supplied to a collector. Secret
 * fields must never be copied into prepared evidence, logs, or error details.
 */
export interface MigrationSourceConnectionSnapshot {
  id: string;
  name: string;
  platform: MigrationBiSourceTool;
  baseUrl: string;
  updatedAt: string;
  authMode: MigrationPlatformAuthMode;
  clientId?: string;
  credential?: string;
  productApiToken?: string;
  accountIdentifier?: string;
  workspaceId?: string;
  projectId?: string;
  siteId?: string;
  username?: string;
  repositoryPath?: string;
  credentialExpiresAt?: string;
}

export type MigrationSourceTransportMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type MigrationSourceTransportResponseType = 'json' | 'text' | 'bytes';

export interface MigrationSourceTransportRequest {
  url: string;
  method?: MigrationSourceTransportMethod;
  headers?: Readonly<Record<string, string>>;
  body?: string | Uint8Array;
  responseType?: MigrationSourceTransportResponseType;
  /** Browser-safe operation label used for bounded diagnostics. */
  label: string;
  allowStatuses?: readonly number[];
  maxResponseBytes?: number;
  deadlineMs?: number;
  signal?: AbortSignal;
}

export interface MigrationSourceTransportResponse<T = unknown> {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: T;
  bytesRead: number;
  finalUrl: string;
  requestCount: number;
}

/**
 * Secure outbound transport is injected so platform collectors cannot bypass
 * endpoint, redirect, timeout, response-size, or redaction controls.
 */
export interface MigrationSourceTransport {
  request<T = unknown>(request: MigrationSourceTransportRequest): Promise<MigrationSourceTransportResponse<T>>;
}

export interface MigrationSourceCollectorContext {
  connection: MigrationSourceConnectionSnapshot;
  selectedRootIds: readonly string[];
  /** Internal request seed; the registry replaces it with a content-bound fingerprint before publication. */
  scopeFingerprint: string;
  transport: MigrationSourceTransport;
  /** Register an ephemeral credential before it can be used in collector output or diagnostics. */
  registerSensitiveValue?: (value: string, label?: string) => void;
  signal?: AbortSignal;
}

export interface MigrationSourceEvidenceCollector {
  readonly platform: MigrationBiSourceTool;
  prepareEvidence(context: MigrationSourceCollectorContext): Promise<MigrationPreparedEvidenceResult>;
}

import type { ConnectionConfig } from '../types';
import { sha256Text } from './semanticMigration/sourceEvidence';

const VAULT_API_KEY_REFERENCE_PREFIX = '__omnikit_vault_instance__:';

function isVaultApiKeyReference(value: string): boolean {
  return value.startsWith(VAULT_API_KEY_REFERENCE_PREFIX);
}

export function hasSavedVaultConnection(
  connection: Pick<ConnectionConfig, 'apiKey' | 'baseUrl' | 'connectionMode' | 'instanceId'>,
) {
  return connection.connectionMode === 'vault'
    && Boolean(connection.instanceId)
    && Boolean(connection.baseUrl.trim())
    && isVaultApiKeyReference(connection.apiKey);
}

export function hasActiveSavedVaultConnection(
  connection: Pick<ConnectionConfig, 'apiKey' | 'baseUrl' | 'connectionMode' | 'instanceId' | 'status'>,
) {
  return hasSavedVaultConnection(connection) && connection.status === 'success';
}

function normalizedConnectionBaseUrl(baseUrl: string): string {
  try {
    const parsed = new URL(baseUrl.trim());
    const path = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.origin}${path}`;
  } catch {
    return 'invalid-base-url';
  }
}

export function getConnectionCacheKey(connection: Pick<ConnectionConfig, 'apiKey' | 'baseUrl' | 'instanceId'>) {
  const baseUrl = normalizedConnectionBaseUrl(connection.baseUrl);
  const credentialIdentity = connection.instanceId
    ? 'saved-instance'
    : connection.apiKey
      ? `manual-key-sha256:${sha256Text(`omnikit:connection-scope:v1\u0000${baseUrl}\u0000${connection.apiKey}`)}`
      : 'no-key';
  return JSON.stringify([
    connection.instanceId || 'manual',
    baseUrl,
    credentialIdentity,
  ]);
}

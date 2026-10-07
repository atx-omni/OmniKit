/** Logical operation semantics, independent of the proxy's HTTP verb or UI label. */
export type ApiRequestPolicy =
  | { readonly kind: 'read'; readonly retry: 'none' | 'transient-http' }
  | { readonly kind: 'write'; readonly retry: 'none' };

// A model inventory request already runs a bounded server operation. Retrying
// the entire proxy request would repeat that operation, so preserve one attempt.
export const MODEL_INVENTORY_REQUEST_POLICY: ApiRequestPolicy = Object.freeze({
  kind: 'read',
  retry: 'none',
});

// Connections are a logical GET carried by a POST to the local proxy. Keep the
// existing single-attempt contract, independent of that transport verb.
export const CONNECTION_INVENTORY_REQUEST_POLICY: ApiRequestPolicy = Object.freeze({
  kind: 'read',
  retry: 'none',
});

export function allowsAutomaticRetry(policy: ApiRequestPolicy): boolean {
  // Also fail closed at runtime if a malformed write policy bypasses typing.
  return policy.kind === 'read' && policy.retry === 'transient-http';
}

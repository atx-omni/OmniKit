import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildOmniDeepLink,
  isSafeOmniDocumentationUrl,
  isSafeOmniDeepLink,
  type OmniDeepLinkTarget,
} from '../src/services/omniDeepLinks';

const TENANT_ORIGIN = 'https://neutral-admin.invalid';

test('Omni deep links are built only for the two fixed tenant destinations', () => {
  const cases: Array<{ target: OmniDeepLinkTarget; expected: string }> = [
    { target: 'tenant_root', expected: `${TENANT_ORIGIN}/` },
    { target: 'api_explorer', expected: `${TENANT_ORIGIN}/api-explorer` },
  ];

  for (const { target, expected } of cases) {
    assert.equal(buildOmniDeepLink(`${TENANT_ORIGIN}/`, target), expected);
    assert.equal(buildOmniDeepLink(TENANT_ORIGIN, target), expected);
    assert.equal(isSafeOmniDeepLink(expected, TENANT_ORIGIN, target), true);
  }
});

test('Omni deep-link validation rejects alternate paths, queries, hashes, and origin confusion', () => {
  const unsafeLinks = [
    `${TENANT_ORIGIN}/api-docs`,
    `${TENANT_ORIGIN}/api-explorer/`,
    `${TENANT_ORIGIN}/api-explorer?api_key=must-not-leave`,
    `${TENANT_ORIGIN}/api-explorer#token`,
    `${TENANT_ORIGIN}/%2e%2e/api-explorer`,
    `${TENANT_ORIGIN}/%2fapi-explorer`,
    'https://attacker.invalid/api-explorer',
    'https://neutral-admin.invalid.attacker.invalid/api-explorer',
    'https://neutral-admin.invalid@attacker.invalid/api-explorer',
    '//neutral-admin.invalid/api-explorer',
    'javascript:alert(1)',
    'data:text/html,unsafe',
  ];

  for (const url of unsafeLinks) {
    assert.equal(
      isSafeOmniDeepLink(url, TENANT_ORIGIN, 'api_explorer'),
      false,
      `expected ${url} to be rejected`,
    );
  }
});

test('Omni deep-link builders reject unsafe or ambiguous tenant base URLs', () => {
  const unsafeBases = [
    'http://neutral-admin.invalid',
    'https://user:password@neutral-admin.invalid',
    'https://neutral-admin.invalid?api_key=must-not-leave',
    'https://neutral-admin.invalid#fragment',
    'https://neutral-admin.invalid/tenant/path',
    '//neutral-admin.invalid',
    'javascript:alert(1)',
    'not a URL',
  ];

  for (const baseUrl of unsafeBases) {
    assert.equal(buildOmniDeepLink(baseUrl, 'tenant_root'), null, `expected ${baseUrl} to be rejected`);
    assert.equal(buildOmniDeepLink(baseUrl, 'api_explorer'), null, `expected ${baseUrl} to be rejected`);
  }
});

test('a safe destination must match both the tenant origin and requested target exactly', () => {
  assert.equal(
    isSafeOmniDeepLink(`${TENANT_ORIGIN}/`, TENANT_ORIGIN, 'api_explorer'),
    false,
  );
  assert.equal(
    isSafeOmniDeepLink(`${TENANT_ORIGIN}/api-explorer`, TENANT_ORIGIN, 'tenant_root'),
    false,
  );
  assert.equal(
    isSafeOmniDeepLink('https://other-admin.invalid/api-explorer', TENANT_ORIGIN, 'api_explorer'),
    false,
  );
});

test('official documentation actions allow only clean docs.omni.co HTTPS URLs', () => {
  assert.equal(isSafeOmniDocumentationUrl('https://docs.omni.co/api/api-explorer'), true);
  assert.equal(isSafeOmniDocumentationUrl('https://docs.omni.co/'), true);

  for (const url of [
    'http://docs.omni.co/api/api-explorer',
    'https://docs.omni.co.attacker.invalid/api/api-explorer',
    'https://docs.omni.co@attacker.invalid/api/api-explorer',
    'https://user:password@docs.omni.co/api/api-explorer',
    'https://docs.omni.co/api/api-explorer?token=must-not-leave',
    'https://docs.omni.co/api/api-explorer#credential',
    '//docs.omni.co/api/api-explorer',
    'javascript:alert(1)',
  ]) {
    assert.equal(isSafeOmniDocumentationUrl(url), false, `expected ${url} to be rejected`);
  }
});

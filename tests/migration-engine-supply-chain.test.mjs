import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';

import {
  classifyAuditReport,
  findForbiddenSourceTokens,
  isExceptionActive,
} from '../scripts/audit-npm-dependencies.mjs';
import { managedPythonCandidates } from '../scripts/migration-engine-python.mjs';
import { hashedRequirements, pinnedRequirements } from '../scripts/python-lock-utils.mjs';

const auditPolicy = {
  minimumSeverity: 'moderate',
  exceptions: [{
    advisoryId: 'GHSA-qwww-vcr4-c8h2',
    packages: ['react-router', 'react-router-dom'],
    maximumSeverity: 'high',
    expiresOn: '2026-08-31',
  }],
};

test('managed Python candidates cover Windows and Unix virtual environments', () => {
  const root = path.resolve('/tmp/omnikit');
  const candidates = managedPythonCandidates(root);
  assert.equal(candidates.length, 2);
  assert.match(candidates[0], /venv[/\\]Scripts[/\\]python\.exe$/);
  assert.match(candidates[1], /venv[/\\]bin[/\\]python$/);
});

test('hash lock generation is deterministic and rejects missing package hashes', () => {
  const requirements = '# comment\nExample_Package==1.2.3\n';
  const uvLock = `[[package]]
name = "example-package"
version = "1.2.3"
sdist = { hash = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
wheels = [
  { hash = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
]`;
  assert.deepEqual(pinnedRequirements(requirements), [{ name: 'example-package', version: '1.2.3' }]);
  assert.equal(
    hashedRequirements(requirements, uvLock),
    'example-package==1.2.3 \\\n'
      + '    --hash=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \\\n'
      + '    --hash=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  );
  assert.throws(
    () => hashedRequirements('missing==1.0.0', uvLock),
    /does not contain distribution hashes/,
  );
});

test('npm audit policy only accepts the scoped RSC advisory and its direct wrapper effect', () => {
  const report = {
    vulnerabilities: {
      'react-router': {
        severity: 'high',
        via: [{
          severity: 'high',
          url: 'https://github.com/advisories/GHSA-qwww-vcr4-c8h2',
        }],
      },
      'react-router-dom': {
        severity: 'high',
        via: ['react-router'],
      },
    },
  };

  const result = classifyAuditReport(report, auditPolicy, new Date('2026-07-24T12:00:00Z'));
  assert.deepEqual([...result.approved.keys()], ['react-router', 'react-router-dom']);
  assert.deepEqual(result.unapproved, []);
});

test('npm audit policy rejects unrelated or expired advisories', () => {
  const unrelated = classifyAuditReport({
    vulnerabilities: {
      postcss: {
        severity: 'high',
        via: [{ severity: 'high', url: 'https://github.com/advisories/GHSA-unrelated' }],
      },
    },
  }, auditPolicy, new Date('2026-07-24T12:00:00Z'));
  assert.equal(unrelated.unapproved.length, 1);
  assert.equal(isExceptionActive(auditPolicy.exceptions[0], new Date('2026-09-01T00:00:00Z')), false);
});

test('npm audit RSC guard detects affected API usage', () => {
  assert.deepEqual(
    findForbiddenSourceTokens(
      'import { unstable_createCallServer } from "react-router";',
      ['unstable_createCallServer', 'unstable_RSCHydratedRouter'],
    ),
    ['unstable_createCallServer'],
  );
});

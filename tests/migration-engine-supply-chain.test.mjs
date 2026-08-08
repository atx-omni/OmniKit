import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import path from 'node:path';

import {
  classifyAuditReport,
  expiredAuditExceptions,
  findForbiddenSourceTokens,
  isExceptionActive,
  parseNpmAuditOutput,
} from '../scripts/audit-npm-dependencies.mjs';
import { managedPythonCandidates } from '../scripts/migration-engine-python.mjs';
import { hashedRequirements, pinnedRequirements } from '../scripts/python-lock-utils.mjs';

const auditPolicy = {
  minimumSeverity: 'moderate',
  exceptions: [{
    advisoryId: 'GHSA-aaaa-bbbb-cccc',
    packages: ['example-core', 'example-wrapper'],
    maximumSeverity: 'high',
    expiresOn: '2026-08-31',
  }],
};

const productionAuditPolicy = JSON.parse(
  readFileSync(path.resolve('config/npm-audit-policy.json'), 'utf8'),
);

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

test('production npm audit policy keeps browser-only image parser exceptions narrow and time-bounded', () => {
  assert.deepEqual(
    productionAuditPolicy.exceptions.map((exception) => exception.advisoryId),
    ['GHSA-w3rx-r6r6-pgpr', 'GHSA-5p2g-fcmc-qvqq'],
  );
  for (const exception of productionAuditPolicy.exceptions) {
    assert.deepEqual(exception.packages, ['image-size', 'pptxgenjs']);
    assert.equal(exception.maximumSeverity, 'high');
    assert.equal(exception.expiresOn, '2026-09-07');
    assert.equal(exception.browserDependencyGuard.parentPackage, 'pptxgenjs');
    assert.equal(exception.browserDependencyGuard.expectedParentVersion, '4.0.1');
    assert.equal(exception.browserDependencyGuard.dependency, 'image-size');
    assert.equal(exception.browserDependencyGuard.expectedDependencyRange, '^1.2.1');
    assert.equal(exception.browserDependencyGuard.expectedDependencyVersion, '1.2.1');
    assert.deepEqual(
      exception.browserDependencyGuard.allowedClientImportPaths,
      ['src/services/deckBuilder/pptxBuilder.ts'],
    );
  }
});

test('npm audit transport errors and incomplete reports fail closed', () => {
  assert.throws(
    () => parseNpmAuditOutput(JSON.stringify({ message: 'registry unavailable', error: { summary: '' } })),
    /complete version 2 vulnerability report/,
  );
  assert.throws(
    () => classifyAuditReport({}, auditPolicy, new Date('2026-07-24T12:00:00Z')),
    /incomplete npm audit report/,
  );
  assert.deepEqual(
    parseNpmAuditOutput(JSON.stringify({ auditReportVersion: 2, vulnerabilities: {}, metadata: {} })),
    { auditReportVersion: 2, vulnerabilities: {}, metadata: {} },
  );
});

test('npm audit policy only accepts a scoped advisory and its direct wrapper effect', () => {
  const report = {
    vulnerabilities: {
      'example-core': {
        severity: 'high',
        via: [{
          severity: 'high',
          url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
        }],
      },
      'example-wrapper': {
        severity: 'high',
        via: ['example-core'],
      },
    },
  };

  const result = classifyAuditReport(report, auditPolicy, new Date('2026-07-24T12:00:00Z'));
  assert.deepEqual([...result.approved.keys()], ['example-core', 'example-wrapper']);
  assert.deepEqual([...result.approvedExceptions], auditPolicy.exceptions);
  assert.deepEqual(result.unapproved, []);
});

test('npm audit policy records every approved advisory on one transitive dependency', () => {
  const exceptions = [
    { advisoryId: 'GHSA-first', packages: ['image-parser', 'deck-wrapper'], maximumSeverity: 'high', expiresOn: '2026-08-31' },
    { advisoryId: 'GHSA-second', packages: ['image-parser', 'deck-wrapper'], maximumSeverity: 'high', expiresOn: '2026-08-31' },
  ];
  const result = classifyAuditReport({
    vulnerabilities: {
      'image-parser': {
        severity: 'high',
        via: [
          { severity: 'high', url: 'https://github.com/advisories/GHSA-first' },
          { severity: 'high', url: 'https://github.com/advisories/GHSA-second' },
        ],
      },
      'deck-wrapper': { severity: 'high', via: ['image-parser'] },
    },
  }, { minimumSeverity: 'moderate', exceptions }, new Date('2026-08-07T12:00:00Z'));

  assert.deepEqual([...result.approved.keys()], ['image-parser', 'deck-wrapper']);
  assert.deepEqual([...result.approvedExceptions], exceptions);
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
  assert.deepEqual(
    expiredAuditExceptions(auditPolicy, new Date('2026-09-01T00:00:00Z')),
    auditPolicy.exceptions,
  );
});

test('npm audit source guard detects forbidden API usage', () => {
  assert.deepEqual(
    findForbiddenSourceTokens(
      'import { retiredWriteApi } from "example-package";',
      ['retiredWriteApi', 'unsupportedReadApi'],
    ),
    ['retiredWriteApi'],
  );
});

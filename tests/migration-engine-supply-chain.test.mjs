import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';

import { managedPythonCandidates } from '../scripts/migration-engine-python.mjs';
import { hashedRequirements, pinnedRequirements } from '../scripts/python-lock-utils.mjs';

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

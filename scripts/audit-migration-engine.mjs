import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveManagedPython } from './migration-engine-python.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const python = resolveManagedPython(projectRoot);
const requirementsPath = join(projectRoot, 'packages', 'omnikit-migration-engine', 'requirements-hashed.lock');

if (!existsSync(python)) {
  throw new Error('The managed migration-engine Python runtime is missing. Run npm run setup:migration-engine:test first.');
}

execFileSync(python, [
  '-m',
  'pip_audit',
  '--disable-pip',
  '--require-hashes',
  '--progress-spinner=off',
  '--requirement',
  requirementsPath,
], {
  cwd: projectRoot,
  stdio: 'inherit',
});

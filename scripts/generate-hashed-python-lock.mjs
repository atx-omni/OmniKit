import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashedRequirements } from './python-lock-utils.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = join(projectRoot, 'packages', 'omnikit-migration-engine');
const requirementsPath = join(packageRoot, 'requirements.lock');
const uvLockPath = join(packageRoot, 'uv.lock');
const outputPath = join(packageRoot, 'requirements-hashed.lock');

const generated = [
  '# Generated from requirements.lock and uv.lock. Do not edit by hand.',
  '# Regenerate with: npm run generate:migration-engine:hash-lock',
  hashedRequirements(readFileSync(requirementsPath, 'utf8'), readFileSync(uvLockPath, 'utf8')),
  '',
].join('\n');

writeFileSync(outputPath, generated);
console.log(`Generated hash-locked migration-engine requirements at ${outputPath}.`);

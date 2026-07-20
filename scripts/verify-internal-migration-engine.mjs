import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { managedPythonCandidates } from './migration-engine-python.mjs';
import { hashedRequirements } from './python-lock-utils.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = path.join(root, 'packages', 'omnikit-migration-engine');
const provenance = JSON.parse(
  readFileSync(path.join(packageRoot, 'PROVENANCE.json'), 'utf8'),
);

function fail(message) {
  throw new Error(`Internal migration engine verification failed: ${message}`);
}

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

const preservedFiles = [
  'requirements.lock',
  'uv.lock',
  'LICENSE',
  'contracts/omnikit.migration.bundle.v1.schema.json',
  'contracts/fixtures/omnikit.migration.bundle.v1.valid.json',
  'contracts/conformance/looker.json',
  'contracts/conformance/metabase.json',
  'contracts/conformance/powerbi.json',
  'contracts/conformance/sigma.json',
  'contracts/conformance/tableau.json',
];

for (const relativePath of preservedFiles) {
  const expected = provenance.sourceFiles[relativePath];
  const actualPath = path.join(packageRoot, relativePath);
  if (!expected || !existsSync(actualPath)) fail(`missing preserved file ${relativePath}`);
  const actual = sha256(actualPath);
  if (actual !== expected) {
    fail(`${relativePath} hash drifted: expected ${expected}, received ${actual}`);
  }
}

const hashLockPath = path.join(packageRoot, 'requirements-hashed.lock');
if (!existsSync(hashLockPath)) fail('missing generated requirements-hashed.lock');
const expectedHashLock = [
  '# Generated from requirements.lock and uv.lock. Do not edit by hand.',
  '# Regenerate with: npm run generate:migration-engine:hash-lock',
  hashedRequirements(
    readFileSync(path.join(packageRoot, 'requirements.lock'), 'utf8'),
    readFileSync(path.join(packageRoot, 'uv.lock'), 'utf8'),
  ),
  '',
].join('\n');
if (readFileSync(hashLockPath, 'utf8') !== expectedHashLock) {
  fail('requirements-hashed.lock is stale or was edited manually');
}

const forbiddenPaths = [
  'src/omni_migrator/cli',
  'src/omni_migrator/loaders',
  'src/omni_migrator/omni_client',
  'src/omni_migrator/ai/backend.py',
  'src/omni_migrator/ai/dashboard_prompt.py',
  'src/omni_migrator/ai/prompt.py',
  'src/omni_migrator/core/state.py',
  'src/omni_migrator/core/report.py',
  'src/omni_migrator/core/translator.py',
  'docs/PLAN.md',
];
for (const relativePath of forbiddenPaths) {
  if (existsSync(path.join(packageRoot, relativePath))) {
    fail(`forbidden runtime surface is present: ${relativePath}`);
  }
}

function walkPythonFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '__pycache__') continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkPythonFiles(fullPath));
    else if (entry.name.endsWith('.py')) files.push(fullPath);
  }
  return files;
}

const forbiddenImport = /omni_migrator\.(?:loaders|omni_client|ai\.(?:backend|prompt|dashboard_prompt)|core\.(?:state|report|translator))/;
for (const filePath of walkPythonFiles(path.join(packageRoot, 'src'))) {
  if (forbiddenImport.test(readFileSync(filePath, 'utf8'))) {
    fail(`forbidden import found in ${path.relative(packageRoot, filePath)}`);
  }
}

function pythonCandidates() {
  return [
    process.env.OMNIKIT_MIGRATION_ENGINE_PYTHON,
    ...managedPythonCandidates(root),
    process.env.OMNIKIT_MIGRATION_ENGINE_BOOTSTRAP_PYTHON,
    'python3.13',
    'python3.12',
    'python3.11',
    path.join(homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'bin', 'python3'),
    'python3',
    'python',
  ].filter(Boolean);
}

function selectPython() {
  for (const candidate of pythonCandidates()) {
    if (candidate.includes(path.sep) && !existsSync(candidate)) continue;
    const probe = spawnSync(candidate, [
      '-c',
      'import sys, pydantic, yaml; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)',
    ], {
      cwd: packageRoot,
      encoding: 'utf8',
    });
    if (probe.status === 0) return candidate;
  }
  fail('no compatible Python runtime is available; run npm run setup:migration-engine');
}

function runRuntime(python, args) {
  const result = spawnSync(
    python,
    ['-m', 'omni_migrator.runtime', ...args],
    {
      cwd: packageRoot,
      env: {
        ...process.env,
        PYTHONPATH: path.join(packageRoot, 'src'),
      },
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    fail(`${args[0]} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return JSON.parse(result.stdout);
}

const python = selectPython();
const capabilities = runRuntime(python, ['capabilities']);
if (capabilities.write_authority !== false) fail('write_authority must be false');
if (JSON.stringify(capabilities.operations) !== JSON.stringify(['extract', 'capabilities', 'conformance'])) {
  fail(`unexpected operations: ${JSON.stringify(capabilities.operations)}`);
}

const conformance = runRuntime(python, ['conformance']);
if (!conformance.passed) fail(`conformance failed: ${JSON.stringify(conformance.sources)}`);

console.log(
  `Verified first-party migration engine at ${provenance.source.commit}: `
  + `${Object.keys(conformance.sources).length} source contracts, read-only runtime.`,
);

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveManagedPython } from './migration-engine-python.mjs';
import { hashedRequirements } from './python-lock-utils.mjs';

const SOURCES = ['looker', 'powerbi', 'tableau', 'metabase', 'sigma'];
const CONTRACTS = [
  'contracts/omnikit.migration.bundle.v1.schema.json',
  'contracts/fixtures/omnikit.migration.bundle.v1.valid.json',
  ...SOURCES.map((source) => `contracts/conformance/${source}.json`),
];
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = resolve(process.env.OMNIKIT_MIGRATION_ENGINE_MANIFEST_PATH || join(projectRoot, 'data/migration-engine/manifest.json'));

function fail(message) {
  throw new Error(`Migration engine release verification failed: ${message}`);
}

function fileSha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function sourceContentSha256(root) {
  const digest = createHash('sha256');
  const visit = (directory, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (['.git', '.venv', '.pytest_cache', '.ruff_cache', '__pycache__', 'build', 'dist'].includes(entry.name)) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute, relative);
      else if (entry.isFile() && !entry.name.endsWith('.pyc')) {
        digest.update(relative).update('\0').update(fileSha256(absolute)).update('\n');
      }
    }
  };
  visit(root);
  return digest.digest('hex');
}

function runJson(python, root, args) {
  try {
    return JSON.parse(execFileSync(python, args, {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PYTHONPATH: join(root, 'src') },
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
  } catch (error) {
    const stderr = String(error?.stderr || '').trim().slice(0, 1_000);
    fail(`first-party runtime command failed${stderr ? `: ${stderr}` : ''}`);
  }
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch {
  fail(`no readable schema-v2 manifest exists at ${manifestPath}`);
}
const testRoot = process.env.NODE_ENV === 'test' ? process.env.OMNIKIT_TEST_MIGRATION_ENGINE_ROOT : '';
const expectedRoot = resolve(testRoot || join(projectRoot, 'data/migration-engine/source'));
const sourceRoot = resolve(String(manifest.sourceRoot || ''));
const python = resolveManagedPython(projectRoot);
if (manifest.schemaVersion !== 2
  || manifest.engine !== 'omni-migrator'
  || manifest.packageName !== 'omnikit-migration-engine'
  || manifest.ownership !== 'first-party') {
  fail('manifest identity or ownership is unsupported');
}
if (sourceRoot !== expectedRoot) fail('manifest sourceRoot is not the installed first-party engine root');
if (!existsSync(join(sourceRoot, 'src/omni_migrator/bridge.py'))) fail('first-party engine source is incomplete');
if (!existsSync(python)) fail(`first-party engine Python is missing at ${python}`);
if (!/^[a-f0-9]{40,64}$/i.test(String(manifest.sourceRevision || '')) || String(manifest.sourceRevision).endsWith('-dirty')) {
  fail('source revision is dirty, unversioned, or malformed');
}
if (manifest.sourceContentSha256 !== sourceContentSha256(sourceRoot)) fail('first-party source content checksum drifted');
const lockPath = join(sourceRoot, 'requirements.lock');
if (!existsSync(lockPath) || manifest.dependencyLockSha256 !== fileSha256(lockPath)) fail('dependency lock checksum drifted');
const hashLockPath = join(sourceRoot, 'requirements-hashed.lock');
const uvLockPath = join(sourceRoot, 'uv.lock');
if (!existsSync(hashLockPath)
  || !existsSync(uvLockPath)
  || manifest.dependencyHashLockSha256 !== fileSha256(hashLockPath)) {
  fail('dependency hash lock checksum drifted');
}
const expectedHashLock = [
  '# Generated from requirements.lock and uv.lock. Do not edit by hand.',
  '# Regenerate with: npm run generate:migration-engine:hash-lock',
  hashedRequirements(readFileSync(lockPath, 'utf8'), readFileSync(uvLockPath, 'utf8')),
  '',
].join('\n');
if (readFileSync(hashLockPath, 'utf8') !== expectedHashLock) fail('dependency hash lock is stale or was edited manually');
if (!manifest.contractsSha256 || typeof manifest.contractsSha256 !== 'object') fail('contract checksums are absent');
for (const relative of CONTRACTS) {
  const absolute = join(sourceRoot, relative);
  if (!existsSync(absolute) || manifest.contractsSha256[relative] !== fileSha256(absolute)) {
    fail(`contract checksum drifted for ${relative}`);
  }
}

const capabilities = runJson(python, sourceRoot, ['-m', 'omni_migrator.runtime', 'capabilities']);
if (capabilities.write_authority !== false
  || capabilities.engine?.name !== manifest.engine
  || capabilities.engine?.version !== manifest.version
  || capabilities.schema_version !== manifest.bridgeSchemaVersion
  || capabilities.result_schema_version !== manifest.resultSchemaVersion
  || !capabilities.operations?.includes('conformance')) {
  fail('live capability identity or read-only contract does not match the manifest');
}
const conformance = runJson(python, sourceRoot, ['-m', 'omni_migrator.runtime', 'conformance']);
if (conformance.schema_version !== manifest.conformanceSchemaVersion
  || conformance.passed !== true
  || SOURCES.some((source) => conformance.sources?.[source]?.passed !== true
    || conformance.sources[source].manifest_sha256 !== conformance.sources[source].expected_sha256
    || conformance.sources[source].manifest_sha256 !== manifest.conformance?.sources?.[source]?.manifest_sha256)) {
  fail('live conformance evidence is failing or does not match the installed manifest');
}

const installed = runJson(python, sourceRoot, ['-c', [
  'import json',
  'from importlib.metadata import distributions',
  'rows={}',
  'for dist in distributions():',
  ' name=(dist.metadata.get("Name") or "unknown").lower().replace("_", "-")',
  ' rows[name]=dist.version',
  'print(json.dumps(rows))',
].join('\n')]);
const lockEntries = readFileSync(lockPath, 'utf8').split(/\r?\n/).flatMap((line) => {
  const match = line.trim().match(/^([A-Za-z0-9_.-]+)==([^\s;]+)$/);
  return match ? [[match[1].toLowerCase().replaceAll('_', '-'), match[2]]] : [];
});
const dependencyDrift = lockEntries.filter(([name, version]) => installed[name] !== version);
if (dependencyDrift.length > 0) {
  fail(`installed dependency drift: ${dependencyDrift.map(([name, version]) => `${name}=${installed[name] || 'missing'} (expected ${version})`).join(', ')}`);
}

const result = {
  verified: true,
  engine: manifest.engine,
  version: manifest.version,
  sourceRevision: manifest.sourceRevision,
  sourceContentSha256: manifest.sourceContentSha256,
  bridgeSchemaVersion: manifest.bridgeSchemaVersion,
  resultSchemaVersion: manifest.resultSchemaVersion,
  conformanceSchemaVersion: manifest.conformanceSchemaVersion,
  conformance: Object.fromEntries(SOURCES.map((source) => [source, conformance.sources[source].manifest_sha256])),
};
console.log(process.argv.includes('--json') ? JSON.stringify(result) : `Verified first-party OmniKit migration engine ${result.version} with all five source contracts.`);

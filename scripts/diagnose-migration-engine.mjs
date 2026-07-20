import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveManagedPython } from './migration-engine-python.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataRoot = join(projectRoot, 'data', 'migration-engine');
const manifestPath = join(dataRoot, 'manifest.json');
const vaultPath = resolve(process.env.OMNIKIT_VAULT_PATH || join(projectRoot, 'data', 'vault.enc'));
const outputIndex = process.argv.indexOf('--output');
const outputPath = resolve(outputIndex >= 0
  ? String(process.argv[outputIndex + 1] || '')
  : join(projectRoot, 'artifacts', 'release', 'migration-engine-diagnostics.json'));

function check(name, passed, detail, action = '') {
  return { name, passed, detail, action: passed ? '' : action };
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const operations = readJson(join(projectRoot, 'config', 'migration-engine-operations.json'));
const sourceRegistry = readJson(join(projectRoot, 'config', 'migration-source-adapters.json'));
const governance = readJson(join(projectRoot, 'config', 'release-governance.json'));
const manifest = readJson(manifestPath);
const python = resolveManagedPython(projectRoot);
const checks = [];

checks.push(check(
  'operations_configuration',
  operations?.schemaVersion === 'omnikit.migration-engine-operations.v1',
  operations ? 'Operational thresholds loaded.' : 'Operational thresholds are unavailable.',
  'Restore config/migration-engine-operations.json from the approved release.',
));
checks.push(check(
  'managed_manifest',
  manifest?.schemaVersion === 2 && manifest?.ownership === 'first-party',
  manifest ? `${manifest.engine || 'unknown'} ${manifest.version || 'unknown'}` : 'Managed manifest is unavailable.',
  'Run npm run setup:migration-engine:test.',
));
checks.push(check(
  'source_registry',
  Array.isArray(sourceRegistry?.sources) && sourceRegistry.sources.length > 0,
  Array.isArray(sourceRegistry?.sources) ? `${sourceRegistry.sources.length} registered source adapters.` : 'Source registry is unavailable.',
  'Restore config/migration-source-adapters.json.',
));

let pythonVersion = '';
try {
  pythonVersion = execFileSync(python, ['-c', 'import platform; print(platform.python_version())'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
} catch {
  // The failed check below carries the recovery action.
}
const [pythonMajor = 0, pythonMinor = 0] = pythonVersion.split('.').map(Number);
checks.push(check(
  'managed_python',
  pythonMajor > 3 || (pythonMajor === 3 && pythonMinor >= 11),
  pythonVersion ? `Python ${pythonVersion}` : 'Managed Python is unavailable.',
  'Install Python 3.11+ and run npm run setup:migration-engine:test.',
));

let verifier = null;
try {
  verifier = JSON.parse(execFileSync(process.execPath, ['scripts/verify-migration-engine-release.mjs', '--json'], {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
} catch {
  // The failed check below carries the recovery action.
}
checks.push(check(
  'runtime_attestation',
  verifier?.verified === true,
  verifier?.verified ? 'Installed source, locks, contracts, capabilities, and conformance match.' : 'Runtime attestation failed.',
  'Run npm run setup:migration-engine:test, then npm run verify:migration-engine.',
));

let writable = false;
try {
  mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  accessSync(dataRoot, constants.R_OK | constants.W_OK);
  writable = true;
} catch {
  // The failed check below carries the recovery action.
}
checks.push(check(
  'local_data_directory',
  writable,
  writable ? 'Local runtime data directory is readable and writable.' : 'Local runtime data directory is not writable.',
  'Correct ownership and permissions for the local data directory.',
));

let freeDiskMb = 0;
try {
  const disk = statfsSync(dataRoot);
  freeDiskMb = Math.floor(Number(disk.bavail) * Number(disk.bsize) / (1024 * 1024));
} catch {
  // The failed check below carries the recovery action.
}
checks.push(check(
  'free_disk',
  freeDiskMb >= Number(operations?.minimumFreeDiskMb || 1024),
  `${freeDiskMb} MB available.`,
  `Free at least ${operations?.minimumFreeDiskMb || 1024} MB before running migrations.`,
));

let vaultMode = null;
if (existsSync(vaultPath)) vaultMode = statSync(vaultPath).mode & 0o777;
checks.push(check(
  'encrypted_vault',
  !existsSync(vaultPath) || vaultMode === 0o600,
  existsSync(vaultPath) ? `Encrypted vault exists with mode ${vaultMode?.toString(8)}.` : 'No local vault exists yet.',
  'Set the encrypted vault file permissions to 0600.',
));

const releaseStages = Object.fromEntries((sourceRegistry?.sources || []).map((source) => [source.id, source.releaseStage || 'development']));
const report = {
  schemaVersion: 'omnikit.migration-engine-diagnostics.v1',
  generatedAt: new Date().toISOString(),
  commit: (() => {
    try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' }).trim(); } catch { return 'unversioned'; }
  })(),
  healthy: checks.every((item) => item.passed),
  checks,
  runtime: {
    engine: manifest ? { name: manifest.engine, version: manifest.version, sourceRevision: manifest.sourceRevision } : null,
    pythonVersion: pythonVersion || null,
    manifestSha256: existsSync(manifestPath) ? sha256(manifestPath) : null,
    queue: {
      maximumConcurrency: Number(process.env.OMNIKIT_MIGRATION_ENGINE_MAX_CONCURRENCY || 2),
      maximumDepth: Number(process.env.OMNIKIT_MIGRATION_ENGINE_MAX_QUEUE || 8),
    },
  },
  releaseStages,
  governanceExternalBlockers: [
    governance?.releaseOwner ? '' : 'Named release owner',
    governance?.supportOwner ? '' : 'Named support owner',
    governance?.securityOwner ? '' : 'Named security owner',
    governance?.rootLicense?.status === 'approved' ? '' : 'Approved root repository license',
  ].filter(Boolean),
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.healthy) process.exitCode = 1;

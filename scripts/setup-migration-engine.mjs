import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataRoot = join(projectRoot, 'data/migration-engine');
const managedSource = join(dataRoot, 'source');
const venvRoot = join(dataRoot, 'venv');
const sourceCandidates = [
  process.env.OMNIKIT_MIGRATION_ENGINE_SOURCE,
  resolve(projectRoot, '../omni-migrator-comparison'),
  resolve(projectRoot, '../omni-migrator'),
  resolve(projectRoot, 'vendor/omni-migrator'),
].filter(Boolean);
const sourceRoot = sourceCandidates.find((candidate) => existsSync(join(candidate, 'pyproject.toml')) && existsSync(join(candidate, 'src/omni_migrator/bridge.py')));

if (!sourceRoot) {
  throw new Error('Migration engine source was not found. Set OMNIKIT_MIGRATION_ENGINE_SOURCE to the omni-migrator checkout and retry.');
}
if (!existsSync(join(sourceRoot, 'requirements.lock'))) {
  throw new Error('Migration engine source is missing requirements.lock. Regenerate it from uv.lock before installation.');
}

function command(commandName, args, options = {}) {
  execFileSync(commandName, args, { cwd: projectRoot, stdio: 'inherit', ...options });
}

function isCompatiblePython(candidate) {
  try {
    const version = execFileSync(candidate, ['-c', 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const [major, minor] = version.split('.').map(Number);
    return major > 3 || (major === 3 && minor >= 11);
  } catch {
    return false;
  }
}

function compatibleBootstrapPython() {
  const candidates = [
    process.env.OMNIKIT_MIGRATION_ENGINE_BOOTSTRAP_PYTHON,
    'python3.13',
    'python3.12',
    'python3.11',
    'python3',
    join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (isCompatiblePython(candidate)) return candidate;
  }
  throw new Error('The migration engine requires Python 3.11 or newer. Install it or set OMNIKIT_MIGRATION_ENGINE_BOOTSTRAP_PYTHON.');
}

function sourceRevision() {
  try {
    const revision = execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const dirty = execFileSync('git', ['-C', sourceRoot, 'status', '--porcelain', '--untracked-files=normal'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().length > 0;
    return dirty ? `${revision}-dirty` : revision;
  } catch {
    return 'unversioned-source';
  }
}

function sourceContentSha256(root) {
  const digest = createHash('sha256');
  const visit = (directory, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (['.git', '.venv', '.pytest_cache', '__pycache__'].includes(entry.name)) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute, relative);
      else if (entry.isFile() && !entry.name.endsWith('.pyc')) {
        digest.update(relative).update('\0').update(createHash('sha256').update(readFileSync(absolute)).digest('hex')).update('\n');
      }
    }
  };
  visit(root);
  return digest.digest('hex');
}

function contractChecksums(root) {
  const relativePaths = [
    'contracts/omnikit.migration.bundle.v1.schema.json',
    'contracts/fixtures/omnikit.migration.bundle.v1.valid.json',
    ...['looker', 'powerbi', 'tableau', 'metabase', 'sigma'].map((source) => `contracts/conformance/${source}.json`),
  ];
  return Object.fromEntries(relativePaths.map((relative) => {
    const absolute = join(root, relative);
    if (!existsSync(absolute)) throw new Error(`Migration engine contract is missing: ${relative}`);
    return [relative, createHash('sha256').update(readFileSync(absolute)).digest('hex')];
  }));
}

mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
const revision = sourceRevision();
const allowDirty = String(process.env.OMNIKIT_MIGRATION_ENGINE_ALLOW_DIRTY || '').toLowerCase() === 'true';
if ((revision.endsWith('-dirty') || revision === 'unversioned-source') && process.env.NODE_ENV === 'production' && !allowDirty) {
  throw new Error('Production migration-engine installs require a clean, versioned source checkout. Set OMNIKIT_MIGRATION_ENGINE_ALLOW_DIRTY=true only for an intentional emergency override.');
}
rmSync(managedSource, { recursive: true, force: true });
cpSync(sourceRoot, managedSource, {
  recursive: true,
  filter(source) {
    const relative = source.slice(sourceRoot.length).replace(/^\//, '');
    return !relative.startsWith('.git') && !relative.startsWith('.venv') && !relative.startsWith('.pytest_cache') && !relative.includes('/__pycache__');
  },
});

if (!isCompatiblePython(join(venvRoot, 'bin/python'))) {
  rmSync(venvRoot, { recursive: true, force: true });
  command(compatibleBootstrapPython(), ['-m', 'venv', venvRoot]);
}

command(join(venvRoot, 'bin/python'), ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '--requirement', join(managedSource, 'requirements.lock')]);
command(join(venvRoot, 'bin/python'), ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '--no-deps', managedSource]);
const packageVersion = JSON.parse(execFileSync(join(venvRoot, 'bin/python'), [
  '-c',
  'import json; from omni_migrator import __version__; print(json.dumps({"version": __version__}))',
], { encoding: 'utf8' })).version;
const dependencyInventory = JSON.parse(execFileSync(join(venvRoot, 'bin/python'), [
  '-c',
  'import json; from importlib.metadata import distributions; rows=[];\nfor dist in distributions():\n m=dist.metadata; rows.append({"name": m.get("Name") or "unknown", "version": dist.version, "license": m.get("License-Expression") or m.get("License") or "not declared"})\nprint(json.dumps(sorted(rows, key=lambda row: row["name"].lower())))',
], { encoding: 'utf8' }));
const lockedVersions = new Map(readFileSync(join(managedSource, 'requirements.lock'), 'utf8').split(/\r?\n/).flatMap((line) => {
  const match = line.trim().match(/^([A-Za-z0-9_.-]+)==([^\s;]+)$/);
  return match ? [[match[1].toLowerCase().replaceAll('_', '-'), match[2]]] : [];
}));
const installedVersions = new Map(dependencyInventory.map((item) => [String(item.name).toLowerCase().replaceAll('_', '-'), String(item.version)]));
const drift = Array.from(lockedVersions.entries()).filter(([name, version]) => installedVersions.get(name) !== version);
if (drift.length > 0) {
  throw new Error(`Installed migration-engine dependencies do not match requirements.lock: ${drift.map(([name, version]) => `${name}=${installedVersions.get(name) || 'missing'} (expected ${version})`).join(', ')}`);
}

const capabilityText = execFileSync(join(venvRoot, 'bin/python'), ['-m', 'omni_migrator.cli.main', 'bridge', 'capabilities'], {
  cwd: managedSource,
  encoding: 'utf8',
  env: { ...process.env, PYTHONPATH: join(managedSource, 'src') },
});
const capabilities = JSON.parse(capabilityText);
if (capabilities.write_authority !== false || capabilities.schema_version !== 'omnikit.migration.bridge.v1' || capabilities.result_schema_version !== 'omnikit.migration.bundle.v1' || !capabilities.supported_result_schema_versions?.includes('omnikit.migration.bundle.v1') || capabilities.engine?.name !== 'omni-migrator' || !capabilities.operations?.includes('conformance')) {
  throw new Error('Installed migration engine did not confirm the required read-only identity and contract versions.');
}

const conformance = JSON.parse(execFileSync(join(venvRoot, 'bin/python'), [
  '-m', 'omni_migrator.cli.main', 'bridge', 'conformance',
], {
  cwd: managedSource,
  encoding: 'utf8',
  env: { ...process.env, PYTHONPATH: join(managedSource, 'src') },
}));
const conformanceSources = ['looker', 'powerbi', 'tableau', 'metabase', 'sigma'];
if (conformance.schema_version !== 'omnikit.migration.conformance-run.v1'
  || conformance.engine?.name !== 'omni-migrator'
  || conformance.engine?.version !== packageVersion
  || conformance.passed !== true
  || conformanceSources.some((source) => conformance.sources?.[source]?.passed !== true
    || conformance.sources[source].manifest_sha256 !== conformance.sources[source].expected_sha256)) {
  throw new Error('Installed migration engine failed its source conformance contracts.');
}

const manifest = {
  schemaVersion: 2,
  engine: 'omni-migrator',
  version: packageVersion,
  sourceRoot: managedSource,
  sourceRevision: revision,
  sourceContentSha256: sourceContentSha256(managedSource),
  dependencyLockSha256: createHash('sha256').update(readFileSync(join(managedSource, 'requirements.lock'))).digest('hex'),
  contractsSha256: contractChecksums(managedSource),
  bridgeSchemaVersion: capabilities.schema_version,
  resultSchemaVersion: capabilities.result_schema_version,
  conformanceSchemaVersion: conformance.schema_version,
  conformance,
  dependencies: dependencyInventory,
  installedAt: new Date().toISOString(),
};
writeFileSync(join(dataRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

console.log(`Installed ${manifest.engine} ${manifest.version} (${manifest.sourceRevision.slice(0, 12)}) in ${dataRoot}.`);

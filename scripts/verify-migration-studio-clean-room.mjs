import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

export const MIGRATION_STUDIO_CLEAN_ROOM_SCHEMA_VERSION = 'omnikit.migration-studio-clean-room.v1';

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || '').trim() : '';
}

export function buildMigrationStudioCleanRoomEvidence({ projectRoot = resolve('.'), manifest, status = '', verifiedAt = new Date().toISOString() }) {
  const expectedManagedSource = resolve(projectRoot, 'data/migration-engine/source');
  const bundledSource = resolve(projectRoot, 'packages/omnikit-migration-engine');
  const managedSource = resolve(String(manifest?.sourceRoot || ''));
  const managedRelative = relative(projectRoot, managedSource);
  const sourceIsOwned = managedSource === expectedManagedSource
    && managedRelative
    && !managedRelative.startsWith('..')
    && !isAbsolute(managedRelative)
    && existsSync(managedSource)
    && existsSync(resolve(bundledSource, 'PROVENANCE.json'));
  const checks = {
    cleanCheckout: status.trim().length === 0,
    firstPartyManifest: manifest?.schemaVersion === 2 && manifest?.ownership === 'first-party' && manifest?.packageName === 'omnikit-migration-engine',
    bundledSourcePresent: existsSync(resolve(bundledSource, 'pyproject.toml')) && existsSync(resolve(bundledSource, 'src/omni_migrator/bridge.py')),
    managedSourceOwnedByOmniKit: sourceIsOwned,
    noRetiredRepositoryRuntimeDependency: sourceIsOwned,
  };
  return {
    schemaVersion: MIGRATION_STUDIO_CLEAN_ROOM_SCHEMA_VERSION,
    verifiedAt,
    commitSha: String(manifest?.omniKitRevision || '').replace(/-dirty$/, '') || null,
    engine: manifest ? { name: manifest.engine, version: manifest.version, sourceRevision: manifest.sourceRevision } : null,
    checks,
    passed: Object.values(checks).every(Boolean),
  };
}

function run() {
  const projectRoot = resolve('.');
  const manifest = JSON.parse(readFileSync(resolve(projectRoot, 'data/migration-engine/manifest.json'), 'utf8'));
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: projectRoot, encoding: 'utf8' });
  const report = buildMigrationStudioCleanRoomEvidence({ projectRoot, manifest, status });
  const outputPath = resolve(option('output') || 'artifacts/release/migration-studio-clean-room.json');
  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}

if (process.argv[1]?.endsWith('verify-migration-studio-clean-room.mjs')) {
  try { run(); } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : error}\n`); process.exitCode = 1; }
}

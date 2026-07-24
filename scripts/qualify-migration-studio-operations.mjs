import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const MIGRATION_STUDIO_OPERATIONAL_QUALIFICATION_SCHEMA_VERSION = 'omnikit.migration-studio-operational-qualification.v1';

function option(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || fallback).trim() : fallback;
}

function readJson(path) {
  try { return JSON.parse(readFileSync(resolve(path), 'utf8')); } catch { return null; }
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function artifact(name, path, validate) {
  const absolute = resolve(path);
  const document = readJson(absolute);
  const passed = Boolean(document && validate(document));
  return {
    name,
    available: existsSync(absolute),
    passed,
    sha256: existsSync(absolute) ? sha256File(absolute) : null,
  };
}

export function buildOperationalQualification({
  source,
  releaseScope,
  diagnostics,
  benchmark,
  cleanRoom,
  backupVerification,
  rollbackLedger,
  manifest,
  manifestSha256,
  generatedAt = new Date().toISOString(),
}) {
  const rollbackDrills = Array.isArray(rollbackLedger?.drills) ? rollbackLedger.drills : [];
  const rollback = rollbackDrills
    .filter((item) => item?.source === source)
    .sort((left, right) => Date.parse(right.completedAt || 0) - Date.parse(left.completedAt || 0))[0];
  const checks = {
    exactReleaseScope: releaseScope?.schemaVersion === 'omnikit.migration-studio-release-scope.v1'
      && releaseScope?.ready === true
      && releaseScope?.worktreeDirty === false,
    runtimeDiagnostics: diagnostics?.schemaVersion === 'omnikit.migration-engine-diagnostics.v1' && diagnostics?.healthy === true,
    benchmarkBudget: benchmark?.schemaVersion === 'omnikit.migration-engine-benchmark.v1' && benchmark?.passed === true,
    cleanRoomInstall: cleanRoom?.schemaVersion === 'omnikit.migration-studio-clean-room.v1' && cleanRoom?.passed === true,
    isolatedBackupVerification: backupVerification?.schemaVersion === 'omnikit.encrypted-vault-backup-verification.v1'
      && backupVerification?.passed === true
      && backupVerification?.activeVaultProtected === true,
    currentRuntimeRollback: rollbackLedger?.schemaVersion === 'omnikit.migration-engine-rollback-drills.v1'
      && rollback?.passed === true
      && rollback?.engine?.name === manifest?.engine
      && rollback?.engine?.version === manifest?.version
      && rollback?.engine?.sourceRevision === manifest?.sourceRevision
      && rollback?.engine?.sourceContentSha256 === manifest?.sourceContentSha256
      && rollback?.engine?.manifestSha256 === manifestSha256,
  };
  return {
    schemaVersion: MIGRATION_STUDIO_OPERATIONAL_QUALIFICATION_SCHEMA_VERSION,
    generatedAt,
    source,
    engine: manifest ? { name: manifest.engine, version: manifest.version, sourceRevision: manifest.sourceRevision } : null,
    checks,
    passed: Object.values(checks).every(Boolean),
    pendingOperatorEvidence: [
      checks.isolatedBackupVerification ? '' : 'Verify an encrypted vault backup in an isolated restore path.',
      checks.currentRuntimeRollback ? '' : `Run a current ${source} rollback drill against the installed runtime.`,
    ].filter(Boolean),
  };
}

function run() {
  const source = option('source', 'looker').toLowerCase();
  const paths = {
    releaseScope: option('release-scope', 'artifacts/release/migration-studio-release-scope.json'),
    diagnostics: option('diagnostics', 'artifacts/release/migration-engine-diagnostics.json'),
    benchmark: option('benchmark', 'artifacts/release/migration-engine-benchmark.json'),
    cleanRoom: option('clean-room', 'artifacts/release/migration-studio-clean-room.json'),
    backupVerification: option('backup-verification', 'artifacts/release/omnikit-backup-verification.json'),
    rollbackLedger: option('rollback-ledger', 'data/migration-engine/rollback-drills.json'),
    manifest: option('manifest', 'data/migration-engine/manifest.json'),
  };
  const manifest = readJson(paths.manifest);
  const report = buildOperationalQualification({
    source,
    releaseScope: readJson(paths.releaseScope),
    diagnostics: readJson(paths.diagnostics),
    benchmark: readJson(paths.benchmark),
    cleanRoom: readJson(paths.cleanRoom),
    backupVerification: readJson(paths.backupVerification),
    rollbackLedger: readJson(paths.rollbackLedger),
    manifest,
    manifestSha256: existsSync(resolve(paths.manifest)) ? sha256File(resolve(paths.manifest)) : null,
  });
  const outputPath = resolve(option('output', 'artifacts/release/migration-studio-operational-qualification.json'));
  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (process.argv.includes('--strict') && !report.passed) process.exitCode = 1;
}

if (process.argv[1]?.endsWith('qualify-migration-studio-operations.mjs')) {
  try { run(); } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : error}\n`); process.exitCode = 1; }
}

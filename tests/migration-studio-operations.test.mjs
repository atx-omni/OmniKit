import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import { createEncryptedVaultBackup } from '../scripts/backup-omnikit-state.mjs';
import { verifyEncryptedVaultBackup } from '../scripts/verify-omnikit-backup.mjs';
import { buildMigrationStudioCleanRoomEvidence } from '../scripts/verify-migration-studio-clean-room.mjs';
import { buildOperationalQualification } from '../scripts/qualify-migration-studio-operations.mjs';

test('encrypted vault backup is byte-exact, permission-safe, and verified in isolation', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'omnikit-backup-test-'));
  try {
    const vaultPath = resolve(root, 'active-vault.enc');
    const backupPath = resolve(root, 'offline', 'vault-backup.enc');
    writeFileSync(vaultPath, Buffer.alloc(64, 7), { mode: 0o600 });
    chmodSync(vaultPath, 0o600);
    const created = createEncryptedVaultBackup({ vaultPath, backupPath, projectRoot: root });
    const verified = verifyEncryptedVaultBackup({
      backupPath,
      manifestPath: created.manifestPath,
      activeVaultPath: vaultPath,
    });
    assert.equal(verified.passed, true);
    assert.equal(verified.activeVaultProtected, true);
    assert.deepEqual(readFileSync(vaultPath), readFileSync(backupPath));
    assert.throws(() => verifyEncryptedVaultBackup({ backupPath: vaultPath, manifestPath: created.manifestPath, activeVaultPath: vaultPath }), /never read from or overwrite/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('backup verification fails closed after encrypted bytes change', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'omnikit-backup-tamper-test-'));
  try {
    const vaultPath = resolve(root, 'active-vault.enc');
    const backupPath = resolve(root, 'vault-backup.enc');
    writeFileSync(vaultPath, Buffer.alloc(64, 8), { mode: 0o600 });
    chmodSync(vaultPath, 0o600);
    const created = createEncryptedVaultBackup({ vaultPath, backupPath, projectRoot: root });
    writeFileSync(backupPath, Buffer.alloc(64, 9), { mode: 0o600 });
    chmodSync(backupPath, 0o600);
    assert.throws(() => verifyEncryptedVaultBackup({ backupPath, manifestPath: created.manifestPath, activeVaultPath: vaultPath }), /checksum or size/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('clean-room evidence requires a clean checkout and the bundled first-party engine', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'omnikit-clean-room-test-'));
  try {
    const packageRoot = resolve(root, 'packages/omnikit-migration-engine');
    const managedRoot = resolve(root, 'data/migration-engine/source');
    writeFileSync(resolve(root, 'placeholder'), 'root');
    mkdirSync(resolve(packageRoot, 'src/omni_migrator'), { recursive: true });
    mkdirSync(managedRoot, { recursive: true });
    writeFileSync(resolve(packageRoot, 'PROVENANCE.json'), '{}');
    writeFileSync(resolve(packageRoot, 'pyproject.toml'), '[project]');
    writeFileSync(resolve(packageRoot, 'src/omni_migrator/bridge.py'), '# bridge');
    const manifest = {
      schemaVersion: 2,
      ownership: 'first-party',
      packageName: 'omnikit-migration-engine',
      sourceRoot: managedRoot,
      engine: 'omni-migrator',
      version: '0.1.0',
      sourceRevision: 'a'.repeat(40),
      omniKitRevision: 'b'.repeat(40),
    };
    assert.equal(buildMigrationStudioCleanRoomEvidence({ projectRoot: root, manifest, status: '' }).passed, true);
    assert.equal(buildMigrationStudioCleanRoomEvidence({ projectRoot: root, manifest, status: ' M file' }).passed, false);
    assert.equal(buildMigrationStudioCleanRoomEvidence({ projectRoot: root, manifest: { ...manifest, sourceRoot: resolve(root, '../omni-migrator') }, status: '' }).passed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('operational qualification requires exact scope, budgets, isolated backup, and runtime-bound rollback', () => {
  const manifest = {
    engine: 'omni-migrator',
    version: '0.1.0',
    sourceRevision: 'a'.repeat(40),
    sourceContentSha256: 'b'.repeat(64),
  };
  const report = buildOperationalQualification({
    source: 'looker',
    releaseScope: { schemaVersion: 'omnikit.migration-studio-release-scope.v1', ready: true, worktreeDirty: false },
    diagnostics: { schemaVersion: 'omnikit.migration-engine-diagnostics.v1', healthy: true },
    benchmark: { schemaVersion: 'omnikit.migration-engine-benchmark.v1', passed: true },
    cleanRoom: { schemaVersion: 'omnikit.migration-studio-clean-room.v1', passed: true },
    backupVerification: { schemaVersion: 'omnikit.encrypted-vault-backup-verification.v1', passed: true, activeVaultProtected: true },
    rollbackLedger: {
      schemaVersion: 'omnikit.migration-engine-rollback-drills.v1',
      drills: [{
        source: 'looker', completedAt: '2026-07-22T00:00:00.000Z', passed: true,
        engine: {
          name: manifest.engine,
          version: manifest.version,
          sourceRevision: manifest.sourceRevision,
          sourceContentSha256: manifest.sourceContentSha256,
          manifestSha256: 'c'.repeat(64),
        },
      }],
    },
    manifest,
    manifestSha256: 'c'.repeat(64),
  });
  assert.equal(report.passed, true);
  assert.equal(buildOperationalQualification({
    source: 'looker', manifest, manifestSha256: 'c'.repeat(64),
  }).passed, false);
});

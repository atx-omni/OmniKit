import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { OMNIKIT_BACKUP_MANIFEST_SCHEMA_VERSION } from './backup-omnikit-state.mjs';

export const OMNIKIT_BACKUP_VERIFICATION_SCHEMA_VERSION = 'omnikit.encrypted-vault-backup-verification.v1';

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || '').trim() : '';
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function verifyEncryptedVaultBackup({ backupPath, manifestPath, activeVaultPath, verifiedAt = new Date().toISOString() }) {
  const backup = resolve(backupPath);
  const manifestFile = resolve(manifestPath || `${backup}.manifest.json`);
  const activeVault = resolve(activeVaultPath || process.env.OMNIKIT_VAULT_PATH || 'data/vault.enc');
  if (backup === activeVault || manifestFile === activeVault) throw new Error('Backup verification must never read from or overwrite the active vault path.');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  if (manifest?.schemaVersion !== OMNIKIT_BACKUP_MANIFEST_SCHEMA_VERSION
    || manifest?.encryptedOnly !== true
    || manifest?.backupFile !== basename(backup)
    || !/^[a-f0-9]{64}$/i.test(String(manifest?.sha256 || ''))
    || !Number.isInteger(manifest?.byteLength)
    || manifest.byteLength < 45) {
    throw new Error('Encrypted vault backup manifest is invalid.');
  }
  const stats = statSync(backup);
  if (!stats.isFile() || (stats.mode & 0o777) !== 0o600) throw new Error('Encrypted vault backup must be a regular 0600 file.');
  const bytes = readFileSync(backup);
  if (bytes.length !== manifest.byteLength || sha256(bytes) !== manifest.sha256) throw new Error('Encrypted vault backup checksum or size does not match its manifest.');

  const isolatedRoot = mkdtempSync(join(tmpdir(), 'omnikit-vault-restore-verification-'));
  try {
    const isolatedCopy = join(isolatedRoot, 'vault.enc');
    copyFileSync(backup, isolatedCopy);
    chmodSync(isolatedCopy, 0o600);
    const isolatedBytes = readFileSync(isolatedCopy);
    if (sha256(isolatedBytes) !== manifest.sha256 || isolatedBytes.length !== manifest.byteLength) {
      throw new Error('Isolated restore copy did not preserve the encrypted vault bytes.');
    }
  } finally {
    rmSync(isolatedRoot, { recursive: true, force: true });
  }
  return {
    schemaVersion: OMNIKIT_BACKUP_VERIFICATION_SCHEMA_VERSION,
    verifiedAt,
    passed: true,
    activeVaultProtected: true,
    backupSha256: manifest.sha256,
    manifestSha256: sha256(readFileSync(manifestFile)),
    byteLength: manifest.byteLength,
    omnikitCommitSha: manifest.omnikitCommitSha || null,
  };
}

function run() {
  const backupPath = option('backup');
  if (!backupPath) throw new Error('Usage: npm run verify:omnikit-backup -- --backup /secure/path/omnikit-vault.enc [--manifest <path>] [--output <report.json>]');
  const report = verifyEncryptedVaultBackup({
    backupPath,
    manifestPath: option('manifest') || undefined,
    activeVaultPath: option('active-vault') || undefined,
  });
  const output = option('output');
  if (output) {
    const outputPath = resolve(output);
    mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1]?.endsWith('verify-omnikit-backup.mjs')) {
  try { run(); } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : error}\n`); process.exitCode = 1; }
}

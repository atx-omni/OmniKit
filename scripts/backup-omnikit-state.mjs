import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

export const OMNIKIT_BACKUP_MANIFEST_SCHEMA_VERSION = 'omnikit.encrypted-vault-backup.v1';
const MINIMUM_ENCRYPTED_VAULT_BYTES = 45;

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || '').trim() : '';
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function currentCommit(projectRoot) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { return 'unversioned'; }
}

export function createEncryptedVaultBackup({ vaultPath, backupPath, manifestPath, createdAt = new Date().toISOString(), projectRoot = resolve('.') }) {
  const source = resolve(vaultPath);
  const destination = resolve(backupPath);
  const manifestDestination = resolve(manifestPath || `${destination}.manifest.json`);
  if (source === destination || source === manifestDestination) throw new Error('Backup output must not overwrite the active vault.');
  if (!destination.endsWith('.enc')) throw new Error('Encrypted vault backup must use an .enc filename.');
  const stats = statSync(source);
  if (!stats.isFile()) throw new Error('Active vault must be a regular file.');
  if ((stats.mode & 0o777) !== 0o600) throw new Error('Active vault permissions must be 0600 before backup.');
  const bytes = readFileSync(source);
  if (bytes.length < MINIMUM_ENCRYPTED_VAULT_BYTES) throw new Error('Active vault is too small to be a valid encrypted OmniKit vault.');
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const temporaryBackup = `${destination}.${process.pid}.tmp`;
  writeFileSync(temporaryBackup, bytes, { mode: 0o600 });
  chmodSync(temporaryBackup, 0o600);
  renameSync(temporaryBackup, destination);
  const manifest = {
    schemaVersion: OMNIKIT_BACKUP_MANIFEST_SCHEMA_VERSION,
    createdAt,
    backupFile: basename(destination),
    byteLength: bytes.length,
    sha256: sha256(bytes),
    sourceRefSha256: sha256(source),
    omnikitCommitSha: currentCommit(projectRoot),
    encryptedOnly: true,
  };
  const temporaryManifest = `${manifestDestination}.${process.pid}.tmp`;
  writeFileSync(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporaryManifest, 0o600);
  renameSync(temporaryManifest, manifestDestination);
  return { manifest, backupPath: destination, manifestPath: manifestDestination };
}

function run() {
  const vaultPath = resolve(option('vault') || process.env.OMNIKIT_VAULT_PATH || 'data/vault.enc');
  const backupPath = option('output');
  if (!backupPath) throw new Error('Usage: npm run backup:omnikit-state -- --output /secure/path/omnikit-vault-YYYY-MM-DD.enc [--vault data/vault.enc]');
  const result = createEncryptedVaultBackup({ vaultPath, backupPath, manifestPath: option('manifest') || undefined });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1]?.endsWith('backup-omnikit-state.mjs')) {
  try { run(); } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : error}\n`); process.exitCode = 1; }
}

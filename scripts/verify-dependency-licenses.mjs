import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const policy = JSON.parse(readFileSync(join(projectRoot, 'config', 'dependency-license-policy.json'), 'utf8'));
const packageLock = JSON.parse(readFileSync(join(projectRoot, 'package-lock.json'), 'utf8'));
const manifestPath = join(projectRoot, 'data', 'migration-engine', 'manifest.json');

function normalizedPackageName(path) {
  return path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
}

const rows = Object.entries(packageLock.packages || {}).flatMap(([path, metadata]) => {
  if (!path || !metadata?.version) return [];
  const name = normalizedPackageName(path);
  return [{
    ecosystem: 'npm',
    name,
    version: String(metadata.version),
    license: String(metadata.license || 'not declared'),
  }];
});

if (!existsSync(manifestPath)) {
  throw new Error('The migration-engine manifest is missing. Run npm run setup:migration-engine:test before license verification.');
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
for (const dependency of manifest.dependencies || []) {
  rows.push({
    ecosystem: 'pypi',
    name: String(dependency.name || 'unknown'),
    version: String(dependency.version || 'unknown'),
    license: String(dependency.license || 'not declared'),
  });
}

const findings = [];
for (const row of rows) {
  const key = `${row.ecosystem}:${row.name}@${row.version}`;
  const license = String(policy.metadataExceptions?.[key] || row.license).trim();
  const denied = policy.deniedLicensePatterns.some((pattern) => license.toLowerCase().includes(pattern.toLowerCase()));
  const allowed = policy.allowedLicensePatterns.some((pattern) => license.toLowerCase().includes(pattern.toLowerCase()));
  if (denied || !allowed) findings.push({ ...row, evaluatedLicense: license, reason: denied ? 'denied' : 'unapproved or undeclared' });
}

if (findings.length > 0) {
  console.error(JSON.stringify({ passed: false, findings }, null, 2));
  throw new Error(`${findings.length} dependencies failed the license policy.`);
}

console.log(`Verified licenses for ${rows.length} npm and Python dependency records.`);

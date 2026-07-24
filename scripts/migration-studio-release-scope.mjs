import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultProjectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function classifyReleaseFiles(files) {
  return {
    planningDocuments: files.filter((file) => /(^|\/)(plan|subplan|requirements)([-_. ][^/]*)?\.md$/i.test(file)),
    sensitiveFiles: files.filter((file) => /(^|\/)(\.env(?:\..*)?|vault\.enc|.*\.(?:pem|p12|pfx|key))$/i.test(file)),
    durableOperatorEvidence: files.filter((file) => /^data\/migration-engine\/(?:live-acceptance|parity-observations|promotions|rollback-drills)/.test(file)),
    generatedReleaseArtifacts: files.filter((file) => /^artifacts\/(?:release|security)\//.test(file)),
  };
}

export function validateReleaseScope(scope, { requireClean = false, expectedCommitSha = '' } = {}) {
  const errors = [];
  if (scope?.schemaVersion !== 'omnikit.migration-studio-release-scope.v1') errors.push('Release scope schema is invalid.');
  if (!/^[a-f0-9]{40}$/i.test(String(scope?.commitSha || ''))) errors.push('Release scope does not identify a valid commit SHA.');
  if (expectedCommitSha && scope?.commitSha !== expectedCommitSha.toLowerCase()) errors.push('Release scope commit does not match the expected release SHA.');
  if (!/^[a-f0-9]{64}$/i.test(String(scope?.contentSha256 || ''))) errors.push('Release scope content checksum is invalid.');
  if (!Number.isInteger(scope?.fileCount) || scope.fileCount < 1 || scope.fileCount !== scope?.files?.length) errors.push('Release scope file count is invalid.');
  for (const [name, values] of Object.entries(scope?.prohibited || {})) {
    if (!Array.isArray(values)) errors.push(`Release scope prohibited class ${name} is invalid.`);
    else if (values.length > 0) errors.push(`Release scope contains ${name}: ${values.join(', ')}`);
  }
  if (requireClean && scope?.worktreeDirty !== false) errors.push('Release scope was generated from a dirty worktree.');
  return errors;
}

export function buildMigrationStudioReleaseScope(projectRoot = defaultProjectRoot) {
  const commitSha = git(projectRoot, ['rev-parse', 'HEAD']).toLowerCase();
  const status = git(projectRoot, ['status', '--porcelain', '--untracked-files=all']);
  const files = git(projectRoot, ['ls-files', '--cached', '--others', '--exclude-standard'])
    .split(/\r?\n/)
    .map((file) => file.trim())
    .filter(Boolean)
    .sort();
  const records = files.map((path) => {
    const absolute = resolve(projectRoot, path);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) throw new Error(`Release scope file is unavailable: ${path}`);
    const bytes = readFileSync(absolute);
    return { path, sizeBytes: bytes.byteLength, sha256: sha256(bytes) };
  });
  const contentSha256 = sha256(records.map((record) => `${record.path}\0${record.sizeBytes}\0${record.sha256}`).join('\n'));
  return {
    schemaVersion: 'omnikit.migration-studio-release-scope.v1',
    generatedAt: new Date().toISOString(),
    commitSha,
    worktreeDirty: Boolean(status),
    fileCount: records.length,
    contentSha256,
    prohibited: classifyReleaseFiles(files),
    files: records,
  };
}

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || '').trim() : '';
}

function main() {
  const scope = buildMigrationStudioReleaseScope();
  const requireClean = process.argv.includes('--require-clean');
  const errors = validateReleaseScope(scope, { requireClean });
  if (errors.length > 0) throw new Error(errors.join(' '));
  const outputPath = resolve(defaultProjectRoot, option('output') || 'artifacts/release/migration-studio-release-scope.json');
  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
  writeFileSync(outputPath, `${JSON.stringify(scope, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({
    ready: !scope.worktreeDirty,
    commitSha: scope.commitSha,
    worktreeDirty: scope.worktreeDirty,
    fileCount: scope.fileCount,
    contentSha256: scope.contentSha256,
    output: outputPath,
  }, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  }
}

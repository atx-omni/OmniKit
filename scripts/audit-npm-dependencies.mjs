import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const policyPath = join(projectRoot, 'config', 'npm-audit-policy.json');
const severityRank = Object.freeze({ info: 0, low: 1, moderate: 2, high: 3, critical: 4 });
const sourceExtensions = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx']);

export function advisoryId(via) {
  if (!via || typeof via !== 'object' || typeof via.url !== 'string') return null;
  try {
    return new URL(via.url).pathname.split('/').filter(Boolean).at(-1) ?? null;
  } catch {
    return null;
  }
}

export function isExceptionActive(exception, now = new Date()) {
  const expiresAt = new Date(`${exception.expiresOn}T23:59:59.999Z`);
  return Number.isFinite(expiresAt.getTime()) && now.getTime() <= expiresAt.getTime();
}

export function findForbiddenSourceTokens(source, tokens) {
  return tokens.filter((token) => source.includes(token));
}

function collectSourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectSourceFiles(path));
    else if (entry.isFile() && sourceExtensions.has(extname(entry.name))) files.push(path);
  }
  return files;
}

function assertExceptionGuards(exception) {
  const sourceFiles = [join(projectRoot, 'src'), join(projectRoot, 'server')]
    .flatMap((directory) => collectSourceFiles(directory));
  const violations = [];

  for (const path of sourceFiles) {
    const matches = findForbiddenSourceTokens(readFileSync(path, 'utf8'), exception.forbiddenSourceTokens ?? []);
    for (const token of matches) violations.push(`${path.slice(projectRoot.length + 1)}: ${token}`);
  }

  if (violations.length > 0) {
    throw new Error(
      `Audit exception ${exception.advisoryId} is invalid because affected RSC APIs are present:\n${violations.join('\n')}`,
    );
  }
}

function matchesException(name, vulnerability, via, exception, now) {
  if (!isExceptionActive(exception, now)) return false;
  if (!exception.packages.includes(name)) return false;
  if ((severityRank[vulnerability.severity] ?? Infinity) > severityRank[exception.maximumSeverity]) return false;
  return advisoryId(via) === exception.advisoryId;
}

export function classifyAuditReport(report, policy, now = new Date()) {
  const minimumRank = severityRank[policy.minimumSeverity];
  if (minimumRank === undefined) throw new Error(`Unknown minimum severity: ${policy.minimumSeverity}`);

  const blocking = Object.entries(report.vulnerabilities ?? {})
    .filter(([, vulnerability]) => (severityRank[vulnerability.severity] ?? Infinity) >= minimumRank);
  const approved = new Map();

  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, vulnerability] of blocking) {
      if (approved.has(name) || !Array.isArray(vulnerability.via) || vulnerability.via.length === 0) continue;
      const matchingExceptions = policy.exceptions.filter((exception) => (
        isExceptionActive(exception, now) && exception.packages.includes(name)
      ));
      if (matchingExceptions.length === 0) continue;

      const allViaApproved = vulnerability.via.every((via) => {
        if (typeof via === 'string') return approved.has(via);
        return matchingExceptions.some((exception) => matchesException(name, vulnerability, via, exception, now));
      });
      if (!allViaApproved) continue;

      approved.set(name, matchingExceptions[0]);
      changed = true;
    }
  }

  return {
    approved,
    unapproved: blocking.filter(([name]) => !approved.has(name)),
  };
}

function runNpmAudit() {
  try {
    return execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['audit', '--json'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    if (typeof error.stdout === 'string' && error.stdout.trim()) return error.stdout;
    throw error;
  }
}

function main() {
  const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
  const report = JSON.parse(runNpmAudit());
  const { approved, unapproved } = classifyAuditReport(report, policy);

  for (const exception of new Set(approved.values())) assertExceptionGuards(exception);

  if (unapproved.length > 0) {
    console.error(`npm audit found ${unapproved.length} unapproved vulnerability entries:`);
    for (const [name, vulnerability] of unapproved) {
      const advisories = vulnerability.via
        .filter((via) => typeof via === 'object')
        .map((via) => advisoryId(via) ?? via.title)
        .join(', ');
      console.error(`- ${name}: ${vulnerability.severity}${advisories ? ` (${advisories})` : ''}`);
    }
    process.exitCode = 1;
    return;
  }

  const uniqueExceptions = [...new Set(approved.values())];
  if (uniqueExceptions.length === 0) {
    console.log('npm audit found no vulnerabilities at or above the configured threshold.');
    return;
  }

  for (const exception of uniqueExceptions) {
    const packages = [...approved.entries()]
      .filter(([, value]) => value === exception)
      .map(([name]) => name)
      .join(', ');
    console.warn(
      `Approved temporary audit exception ${exception.advisoryId} for ${packages}; expires ${exception.expiresOn}.`,
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

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

export function expiredAuditExceptions(policy, now = new Date()) {
  return (policy.exceptions ?? []).filter((exception) => !isExceptionActive(exception, now));
}

export function findForbiddenSourceTokens(source, tokens) {
  return tokens.filter((token) => source.includes(token));
}

export function parseNpmAuditOutput(output) {
  const report = JSON.parse(output);
  if (
    report?.auditReportVersion !== 2
    || !report.vulnerabilities
    || typeof report.vulnerabilities !== 'object'
    || Array.isArray(report.vulnerabilities)
    || report.error
  ) {
    throw new Error('npm audit did not return a complete version 2 vulnerability report.');
  }
  return report;
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
      `Audit exception ${exception.advisoryId} is invalid because forbidden source usage is present:\n${violations.join('\n')}`,
    );
  }

  const guard = exception.browserDependencyGuard;
  if (!guard) return;

  const parentRoot = join(projectRoot, 'node_modules', guard.parentPackage);
  const parentManifest = JSON.parse(readFileSync(join(parentRoot, 'package.json'), 'utf8'));
  if (parentManifest.version !== guard.expectedParentVersion) {
    throw new Error(
      `Audit exception ${exception.advisoryId} requires ${guard.parentPackage}@${guard.expectedParentVersion}; `
      + `found ${parentManifest.version ?? 'unknown'}. Re-review the dependency before updating the exception.`,
    );
  }
  if (parentManifest.dependencies?.[guard.dependency] === undefined) {
    throw new Error(
      `Audit exception ${exception.advisoryId} expected ${guard.parentPackage} to depend on ${guard.dependency}.`,
    );
  }
  if (parentManifest.dependencies[guard.dependency] !== guard.expectedDependencyRange) {
    throw new Error(
      `Audit exception ${exception.advisoryId} requires ${guard.parentPackage} to declare `
      + `${guard.dependency}@${guard.expectedDependencyRange}; found `
      + `${parentManifest.dependencies[guard.dependency]}.`,
    );
  }
  if (parentManifest.browser?.[guard.dependency] !== false) {
    throw new Error(
      `Audit exception ${exception.advisoryId} requires ${guard.parentPackage} to disable `
      + `${guard.dependency} in its browser manifest.`,
    );
  }

  const dependencyManifest = JSON.parse(
    readFileSync(join(projectRoot, 'node_modules', guard.dependency, 'package.json'), 'utf8'),
  );
  if (dependencyManifest.version !== guard.expectedDependencyVersion) {
    throw new Error(
      `Audit exception ${exception.advisoryId} requires ${guard.dependency}@${guard.expectedDependencyVersion}; `
      + `found ${dependencyManifest.version ?? 'unknown'}. Re-review the dependency before updating the exception.`,
    );
  }

  const allowedClientImports = new Set(guard.allowedClientImportPaths ?? []);
  const importViolations = [];
  for (const path of sourceFiles) {
    const relativePath = path.slice(projectRoot.length + 1);
    const source = readFileSync(path, 'utf8');
    if (source.includes(guard.dependency)) {
      importViolations.push(`${relativePath}: direct ${guard.dependency} reference`);
    }
    if (!source.includes(guard.parentPackage)) continue;
    if (relativePath.startsWith('server/') || !allowedClientImports.has(relativePath)) {
      importViolations.push(`${relativePath}: ${guard.parentPackage} import is outside the reviewed browser-only path`);
    }
  }
  if (importViolations.length > 0) {
    throw new Error(
      `Audit exception ${exception.advisoryId} is invalid because its browser-only boundary changed:\n`
      + importViolations.join('\n'),
    );
  }

  for (const relativeEntry of guard.parentEntryFiles ?? []) {
    const entryPath = resolve(parentRoot, relativeEntry);
    if (!entryPath.startsWith(`${parentRoot}/`)) {
      throw new Error(`Audit exception ${exception.advisoryId} contains an invalid parent entry path.`);
    }
    const entrySource = readFileSync(entryPath, 'utf8');
    const entryViolations = findForbiddenSourceTokens(entrySource, guard.forbiddenParentEntryTokens ?? []);
    if (entryViolations.length > 0) {
      throw new Error(
        `Audit exception ${exception.advisoryId} is invalid because ${guard.parentPackage}/${relativeEntry} `
        + `now references the disabled dependency: ${entryViolations.join(', ')}`,
      );
    }
  }
}

function matchesException(name, vulnerability, via, exception, now) {
  if (!isExceptionActive(exception, now)) return false;
  if (!exception.packages.includes(name)) return false;
  if ((severityRank[vulnerability.severity] ?? Infinity) > severityRank[exception.maximumSeverity]) return false;
  return advisoryId(via) === exception.advisoryId;
}

export function classifyAuditReport(report, policy, now = new Date()) {
  if (!report?.vulnerabilities || typeof report.vulnerabilities !== 'object' || Array.isArray(report.vulnerabilities)) {
    throw new Error('Cannot classify an incomplete npm audit report.');
  }
  const minimumRank = severityRank[policy.minimumSeverity];
  if (minimumRank === undefined) throw new Error(`Unknown minimum severity: ${policy.minimumSeverity}`);

  const blocking = Object.entries(report.vulnerabilities ?? {})
    .filter(([, vulnerability]) => (severityRank[vulnerability.severity] ?? Infinity) >= minimumRank);
  const approved = new Map();
  const approvedExceptions = new Set();

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
      for (const via of vulnerability.via) {
        if (typeof via === 'string') continue;
        for (const exception of matchingExceptions) {
          if (matchesException(name, vulnerability, via, exception, now)) approvedExceptions.add(exception);
        }
      }
      changed = true;
    }
  }

  return {
    approved,
    approvedExceptions,
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
  const expiredExceptions = expiredAuditExceptions(policy);
  if (expiredExceptions.length > 0) {
    console.error('npm audit policy contains expired exceptions:');
    for (const exception of expiredExceptions) {
      console.error(`- ${exception.advisoryId}: expired ${exception.expiresOn}`);
    }
    process.exitCode = 1;
    return;
  }

  let report;
  try {
    report = parseNpmAuditOutput(runNpmAudit());
  } catch (error) {
    console.error(`npm audit failed closed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }
  const { approved, approvedExceptions, unapproved } = classifyAuditReport(report, policy);

  for (const exception of approvedExceptions) assertExceptionGuards(exception);

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

  const uniqueExceptions = [...approvedExceptions];
  if (uniqueExceptions.length === 0) {
    console.log('npm audit found no vulnerabilities at or above the configured threshold.');
    return;
  }

  for (const exception of uniqueExceptions) {
    const packages = exception.packages
      .filter((name) => approved.has(name))
      .join(', ');
    console.warn(
      `Approved temporary audit exception ${exception.advisoryId} for ${packages}; expires ${exception.expiresOn}.`,
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyMigrationSourceConformance } from './verify-migration-source-conformance.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function run(command, args) {
  return execFileSync(command, args, { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || '').trim() : '';
}

function assert(condition, message) {
  if (!condition) throw new Error(`BI Migration Studio release certification failed: ${message}`);
}

function trackedFiles() {
  return run('git', ['ls-files', '--cached', '--others', '--exclude-standard']).split(/\r?\n/).filter(Boolean);
}

function verifyRepositoryHygiene() {
  const files = trackedFiles();
  const planningDocs = files.filter((file) => /(^|\/)(plan|subplan|requirements)([-_. ][^/]*)?\.md$/i.test(file));
  const sensitiveFiles = files.filter((file) => /(^|\/)(\.env(?:\..*)?|vault\.enc|.*\.(?:pem|p12|pfx|key))$/i.test(file));
  const durableEvidence = files.filter((file) => /^data\/migration-engine\/(?:live-acceptance|parity-observations|promotions)/.test(file));
  assert(planningDocs.length === 0, `planning documents are tracked: ${planningDocs.join(', ')}`);
  assert(sensitiveFiles.length === 0, `secret-bearing file types are tracked: ${sensitiveFiles.join(', ')}`);
  assert(durableEvidence.length === 0, `operator evidence is tracked: ${durableEvidence.join(', ')}`);
  return { deployableWorkingFiles: files.length, planningDocs: 0, sensitiveFiles: 0, durableEvidence: 0 };
}

function verifyDocumentation() {
  const readme = readFileSync(resolve(projectRoot, 'README.md'), 'utf8');
  const required = [
    'OpenAI', 'Anthropic', 'Snowflake Cortex', 'Databricks Genie', 'Omni AI',
    'create:migration-source-adapter', 'verify:migration-source-adapters',
    'governance', 'visual evidence', 'live acceptance', 'rollback',
    'release stage', 'single-operator',
  ];
  const missing = required.filter((phrase) => !readme.toLowerCase().includes(phrase.toLowerCase()));
  assert(missing.length === 0, `README is missing required operator guidance: ${missing.join(', ')}`);
  return { requiredPhrases: required.length, missing: [] };
}

function verifyGovernance() {
  const governancePath = resolve(projectRoot, 'config/release-governance.json');
  assert(existsSync(governancePath), 'config/release-governance.json is missing');
  const governance = JSON.parse(readFileSync(governancePath, 'utf8'));
  assert(governance.schemaVersion === 'omnikit.release-governance.v1', 'release governance schema is invalid');
  const requiredFiles = [
    'SECURITY.md',
    'SUPPORT.md',
    'CONTRIBUTING.md',
    'THIRD_PARTY_NOTICES.md',
    '.github/CODEOWNERS',
    'docs/operations/migration-studio-runbook.md',
    'docs/releases/migration-studio-release-checklist.md',
    governance.rootLicense?.decisionRecord,
  ].filter(Boolean);
  requiredFiles.forEach((file) => assert(existsSync(resolve(projectRoot, file)), `required governance file is missing: ${file}`));
  const externalBlockers = [
    governance.releaseOwner ? '' : 'Named release owner',
    governance.supportOwner ? '' : 'Named support owner',
    governance.securityOwner ? '' : 'Named security owner',
    governance.supportResponseTarget ? '' : 'Approved support response target',
    governance.rootLicense?.status === 'approved' && governance.rootLicense?.spdx ? '' : 'Approved root repository license',
  ].filter(Boolean);
  return {
    releaseOwner: governance.releaseOwner,
    supportOwner: governance.supportOwner,
    securityOwner: governance.securityOwner,
    supportResponseTarget: governance.supportResponseTarget,
    rootLicense: governance.rootLicense,
    repositoryPolicy: governance.repositoryPolicy,
    requiredFiles,
    externalBlockers,
  };
}

function engineReadiness() {
  try {
    const report = JSON.parse(run(process.execPath, ['scripts/report-migration-engine-readiness.mjs']));
    return {
      available: true,
      engine: report.engine,
      sources: report.sources.map((source) => ({
        source: source.source,
        owner: source.owner,
        rolloutState: source.rolloutState || source.state,
        releaseStage: source.releaseStage,
        liveAcceptance: source.liveAcceptance,
        blockers: source.blockers,
        releaseBlockers: source.releaseBlockers,
      })),
      nativeSources: report.nativeSources.map((source) => ({
        source: source.source,
        owner: source.owner,
        rolloutState: source.rolloutState || source.state,
        releaseStage: source.releaseStage,
        certification: source.certification,
        blockers: source.blockers || [],
        releaseBlockers: source.releaseBlockers || [],
      })),
    };
  } catch {
    return { available: false, sources: [], nativeSources: [], note: 'First-party engine readiness is runtime-dependent and was not available in this checkout.' };
  }
}

function operationalEvidence() {
  const evidence = [
    ['diagnostics', resolve(projectRoot, 'artifacts/release/migration-engine-diagnostics.json')],
    ['benchmark', resolve(projectRoot, 'artifacts/release/migration-engine-benchmark.json')],
    ['sbom', resolve(projectRoot, 'artifacts/security/omnikit-sbom.cdx.json')],
  ];
  return Object.fromEntries(evidence.map(([name, path]) => {
    if (!existsSync(path)) return [name, { available: false }];
    const bytes = readFileSync(path);
    let parsed = null;
    try { parsed = JSON.parse(bytes.toString('utf8')); } catch { /* checksum still proves the artifact bytes */ }
    const valid = name === 'diagnostics'
      ? parsed?.schemaVersion === 'omnikit.migration-engine-diagnostics.v1'
      : name === 'benchmark'
        ? parsed?.schemaVersion === 'omnikit.migration-engine-benchmark.v1'
        : parsed?.bomFormat === 'CycloneDX' && typeof parsed?.specVersion === 'string';
    const passed = valid && (name === 'diagnostics'
      ? parsed?.healthy === true
      : name === 'benchmark'
        ? parsed?.passed === true
        : true);
    return [name, {
      available: true,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      schemaVersion: parsed?.schemaVersion || parsed?.specVersion || null,
      valid,
      passed,
      summary: name === 'benchmark' ? parsed?.summary : undefined,
    }];
  }));
}

function main() {
  const skipFullGate = process.argv.includes('--skip-full-gate');
  const requireReleaseReady = process.argv.includes('--require-release-ready');
  const sourceConformance = verifyMigrationSourceConformance(projectRoot);
  const hygiene = verifyRepositoryHygiene();
  const documentation = verifyDocumentation();
  const governance = verifyGovernance();
  const readiness = engineReadiness();
  const operations = operationalEvidence();
  if (!skipFullGate) run('npm', ['run', 'security:check']);
  const fullRepositoryGate = skipFullGate ? 'skipped_by_operator' : 'passed';
  const sourceContractsReleaseReady = sourceConformance.sources.every((source) =>
    source.lifecycle === 'primary'
    && source.releaseStage === 'ga'
    && source.certification === 'live_accepted');
  const engineSourcesReleaseReady = readiness.available
    && readiness.sources.length > 0
    && readiness.sources.every((source) =>
      source.rolloutState === 'primary'
      && source.releaseStage === 'ga'
      && source.liveAcceptance
      && source.blockers.length === 0
      && source.releaseBlockers.length === 0);
  const nativeSourcesReleaseReady = readiness.available
    && readiness.nativeSources.length > 0
    && readiness.nativeSources.every((source) =>
      source.rolloutState === 'primary'
      && source.releaseStage === 'ga'
      && source.certification === 'live_accepted'
      && source.blockers.length === 0
      && source.releaseBlockers.length === 0);
  const releaseReady = fullRepositoryGate === 'passed'
    && governance.externalBlockers.length === 0
    && operations.diagnostics.available && operations.diagnostics.passed
    && operations.benchmark.available && operations.benchmark.passed
    && operations.sbom.available && operations.sbom.passed
    && sourceContractsReleaseReady
    && engineSourcesReleaseReady
    && nativeSourcesReleaseReady;
  const result = {
    schemaVersion: 'omnikit.bi-migration-release-certificate.v3',
    generatedAt: new Date().toISOString(),
    codeComplete: true,
    fullRepositoryGate,
    sourceConformance,
    hygiene,
    documentation,
    governance,
    readiness,
    operations,
    releaseReady,
    externalCertificationPending: [
      'Customer/admin-owned provider connection tests',
      'Representative Omni entitlement capability verification',
      'Live source acceptance and required shadow observation counts',
      'Named production approval and rollback drill',
      ...governance.externalBlockers,
    ],
  };
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  const output = option('output');
  if (output) {
    const outputPath = resolve(projectRoot, output);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, serialized, { mode: 0o600 });
  }
  process.stdout.write(serialized);
  if (requireReleaseReady && !releaseReady) {
    throw new Error('BI Migration Studio is not release-ready; the certificate records the blocking evidence.');
  }
}

try { main(); } catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  process.exitCode = 1;
}

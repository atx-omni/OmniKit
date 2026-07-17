import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyMigrationSourceConformance } from './verify-migration-source-conformance.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function run(command, args) {
  return execFileSync(command, args, { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
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
  ];
  const missing = required.filter((phrase) => !readme.toLowerCase().includes(phrase.toLowerCase()));
  assert(missing.length === 0, `README is missing required operator guidance: ${missing.join(', ')}`);
  return { requiredPhrases: required.length, missing: [] };
}

function engineReadiness() {
  try {
    const report = JSON.parse(run(process.execPath, ['scripts/report-migration-engine-readiness.mjs']));
    return {
      available: true,
      engine: report.engine,
      sources: report.sources.map((source) => ({ source: source.source, state: source.state, blockers: source.blockers })),
      nativeSources: report.nativeSources,
    };
  } catch {
    return { available: false, sources: [], nativeSources: [], note: 'Managed engine readiness is credential/runtime-dependent and was not available in this checkout.' };
  }
}

function main() {
  const skipFullGate = process.argv.includes('--skip-full-gate');
  const sourceConformance = verifyMigrationSourceConformance(projectRoot);
  const hygiene = verifyRepositoryHygiene();
  const documentation = verifyDocumentation();
  const readiness = engineReadiness();
  if (!skipFullGate) run('npm', ['run', 'security:check']);
  const result = {
    schemaVersion: 'omnikit.bi-migration-release-certificate.v1',
    generatedAt: new Date().toISOString(),
    codeComplete: true,
    fullRepositoryGate: skipFullGate ? 'skipped_by_operator' : 'passed',
    sourceConformance,
    hygiene,
    documentation,
    readiness,
    externalCertificationPending: [
      'Customer/admin-owned provider connection tests',
      'Representative Omni entitlement capability verification',
      'Live source acceptance and required shadow observation counts',
      'Named production approval and rollback drill',
    ],
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

try { main(); } catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  process.exitCode = 1;
}

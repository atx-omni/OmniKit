import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyMigrationSourceConformance } from './verify-migration-source-conformance.mjs';
import {
  buildMigrationStudioReleaseScope,
  validateReleaseScope,
} from './migration-studio-release-scope.mjs';
import { verifyReleaseGovernance } from './verify-release-governance.mjs';
import { evaluateMigrationStudioReleaseReadiness } from './migration-studio-release-readiness.mjs';

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

function verifyReleaseScope() {
  const requireClean = process.argv.includes('--require-clean-release');
  const current = buildMigrationStudioReleaseScope(projectRoot);
  const scopeOption = option('scope');
  const scopePath = resolve(projectRoot, scopeOption || 'artifacts/release/migration-studio-release-scope.json');
  let attested = null;
  if ((scopeOption || requireClean) && existsSync(scopePath)) {
    try { attested = JSON.parse(readFileSync(scopePath, 'utf8')); } catch { /* validation below reports the malformed record */ }
  }
  if (requireClean) assert(attested, 'exact-SHA certification requires a generated release scope manifest');
  const candidate = attested || current;
  const errors = validateReleaseScope(candidate, {
    requireClean,
    expectedCommitSha: current.commitSha,
  });
  assert(errors.length === 0, errors.join(' '));
  assert(candidate.contentSha256 === current.contentSha256 && candidate.fileCount === current.fileCount, 'release scope content changed after attestation');
  return {
    attested: Boolean(attested),
    exactSha: candidate.worktreeDirty === false && candidate.commitSha === current.commitSha,
    commitSha: candidate.commitSha,
    worktreeDirty: candidate.worktreeDirty,
    fileCount: candidate.fileCount,
    contentSha256: candidate.contentSha256,
    manifestSha256: attested ? createHash('sha256').update(readFileSync(scopePath)).digest('hex') : null,
  };
}

function verifyDocumentation() {
  const readme = readFileSync(resolve(projectRoot, 'README.md'), 'utf8');
  const required = [
    'OpenAI', 'Anthropic', 'Snowflake Cortex', 'Databricks Genie', 'Omni AI',
    'create:migration-source-adapter', 'verify:migration-source-adapters',
    'governance', 'visual evidence', 'live acceptance', 'rollback',
    'release stage', 'single-operator', 'Professional Looker migrations',
    'docs/migrations/looker-to-omni.md',
  ];
  const missing = required.filter((phrase) => !readme.toLowerCase().includes(phrase.toLowerCase()));
  assert(missing.length === 0, `README is missing required operator guidance: ${missing.join(', ')}`);
  return { requiredPhrases: required.length, missing: [] };
}

function verifyLookerProfessionalV2() {
  const manifest = JSON.parse(readFileSync(resolve(projectRoot, 'packages/omnikit-migration-engine/tests/fixtures/looker_professional_manifest.json'), 'utf8'));
  const registry = JSON.parse(readFileSync(resolve(projectRoot, 'config/migration-source-adapters.json'), 'utf8'));
  const conformance = JSON.parse(readFileSync(resolve(projectRoot, 'packages/omnikit-migration-engine/contracts/conformance/looker.json'), 'utf8'));
  const guidePath = resolve(projectRoot, 'docs/migrations/looker-to-omni.md');
  const runbook = readFileSync(resolve(projectRoot, 'docs/operations/migration-studio-runbook.md'), 'utf8');
  assert(existsSync(guidePath), 'professional Looker operator guide is missing');
  const guide = readFileSync(guidePath, 'utf8');
  const looker = registry.sources.find((source) => source.id === 'looker');
  const requiredConstructs = [
    'parameter', 'same_view_filtered_measure', 'cross_view_filtered_measure',
    'native_derived_table', 'filter_expression', 'dynamic_group_by',
    'dynamic_filtered_measure', 'hidden_fields', 'pivot', 'filter_listener',
    'visual_configuration', 'merged_query', 'markdown',
  ];
  const requiredCapabilities = [
    'manual_lookml', 'api_inventory', 'selected_dashboard_details', 'canonical_ir_v2',
    'explores', 'dynamic_fields', 'filter_bindings', 'dashboards',
  ];
  assert(manifest.schema_version === 'omnikit.looker.professional.v2' && manifest.synthetic === true, 'professional Looker fixture contract is invalid');
  assert(requiredConstructs.every((item) => manifest.expected_constructs?.[item]), 'professional Looker fixture is missing required behavior classes');
  assert(looker?.extractionOwner === 'omnikit_engine' && looker?.lifecycle === 'shadow', 'Looker must remain on the first-party shadow path before promotion');
  assert(looker?.releaseStage === 'preview' && looker?.certification === 'synthetic_regression', 'Looker capability claims exceed measured Preview evidence');
  assert(looker?.acquisition?.manual === true && looker?.acquisition?.api === true, 'Looker needs both manual and API acquisition contracts');
  assert(looker?.rulebookId === 'looker-internal-v2', 'Looker source governance is not tied to rulebook V2');
  assert(requiredCapabilities.every((item) => looker?.certifiedCapabilities?.includes(item)), 'Looker registry is missing a V2 contract capability');
  assert(conformance.coverage?.artifacts?.permissions === 'unsupported' && conformance.coverage?.artifacts?.schedules === 'unsupported', 'Looker conformance overstates permissions or schedules');
  assert(/manual files/i.test(guide) && /saved api/i.test(guide) && /query validation/i.test(guide) && /reconciliation/i.test(guide), 'professional Looker operator guide is incomplete');
  assert(/rollback:migration-engine[\s\S]+--source looker/i.test(runbook), 'Looker rollback command is not documented');
  return {
    contractVersion: manifest.schema_version,
    releaseStage: looker.releaseStage,
    lifecycle: looker.lifecycle,
    certification: looker.certification,
    acquisition: looker.acquisition,
    measuredPromotionRequired: true,
    rollbackDrillRequired: true,
    unsupported: ['permissions', 'schedules'],
  };
}

function verifyGovernance() {
  const result = verifyReleaseGovernance(projectRoot, {
    evidencePath: option('governance-evidence'),
    expectedCommitSha: run('git', ['rev-parse', 'HEAD']),
  });
  assert(result.configurationValid, result.configurationErrors.join(' '));
  assert(result.requiredFilesPresent, `required governance files are missing: ${result.missingFiles.join(', ')}`);
  return result;
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
        liveAcceptances: source.liveAcceptances || [],
        requiredAcceptanceModes: source.requiredAcceptanceModes || [],
        missingAcceptanceModes: source.missingAcceptanceModes || [],
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
    ['cleanRoom', resolve(projectRoot, 'artifacts/release/migration-studio-clean-room.json')],
    ['backupVerification', resolve(projectRoot, 'artifacts/release/omnikit-backup-verification.json')],
    ['operationalQualification', resolve(projectRoot, 'artifacts/release/migration-studio-operational-qualification.json')],
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
        : name === 'cleanRoom'
          ? parsed?.schemaVersion === 'omnikit.migration-studio-clean-room.v1'
          : name === 'backupVerification'
            ? parsed?.schemaVersion === 'omnikit.encrypted-vault-backup-verification.v1'
            : name === 'operationalQualification'
              ? parsed?.schemaVersion === 'omnikit.migration-studio-operational-qualification.v1'
        : parsed?.bomFormat === 'CycloneDX' && typeof parsed?.specVersion === 'string';
    const passed = valid && (name === 'diagnostics'
      ? parsed?.healthy === true
      : name === 'benchmark'
        ? parsed?.passed === true
        : ['cleanRoom', 'backupVerification', 'operationalQualification'].includes(name)
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
  const requirePreviewReady = process.argv.includes('--require-preview-ready');
  const requireReleaseReady = process.argv.includes('--require-release-ready');
  const sourceConformance = verifyMigrationSourceConformance(projectRoot);
  const hygiene = verifyRepositoryHygiene();
  const releaseScope = verifyReleaseScope();
  const documentation = verifyDocumentation();
  const lookerProfessionalV2 = verifyLookerProfessionalV2();
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
      && source.requiredAcceptanceModes.length > 0
      && source.missingAcceptanceModes.length === 0
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
  const { previewReady, releaseReady } = evaluateMigrationStudioReleaseReadiness({
    fullRepositoryGate,
    releaseScope,
    sourceConformance,
    hygiene,
    governance,
    operations,
    sourceContractsReleaseReady,
    engineSourcesReleaseReady,
    nativeSourcesReleaseReady,
  });
  const result = {
    schemaVersion: 'omnikit.bi-migration-release-certificate.v3',
    generatedAt: new Date().toISOString(),
    codeComplete: true,
    fullRepositoryGate,
    sourceConformance,
    hygiene,
    releaseScope,
    documentation,
    lookerProfessionalV2,
    governance,
    readiness,
    operations,
    previewReady,
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
  if (requirePreviewReady && !previewReady) {
    throw new Error('BI Migration Studio is not Preview-ready; the certificate records the blocking evidence.');
  }
  if (requireReleaseReady && !releaseReady) {
    throw new Error('BI Migration Studio is not release-ready; the certificate records the blocking evidence.');
  }
}

try { main(); } catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  process.exitCode = 1;
}

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  MIGRATION_ENGINE_PROMOTION_REQUIREMENTS,
  sha256File,
  sha256Json,
  validateMigrationEngineLiveAcceptance,
} from './migration-engine-certification.mjs';

const SOURCES = ['looker', 'powerbi', 'tableau', 'metabase', 'sigma'];

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || '').trim() : '';
}

function options(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === `--${name}` && process.argv[index + 1]) values.push(String(process.argv[index + 1]).trim());
  }
  return values.filter(Boolean);
}

function usage() {
  return 'Usage: npm run promote:migration-engine -- --source looker --acceptance <manual-final.json> --acceptance <api-final.json> --approved-by "Release Owner" --rollback-drill "rollback-2026-07-14" [--dry-run]';
}

function fail(message) {
  throw new Error(`${message}\n${usage()}`);
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(`${usage()}\n`);
  process.exit(0);
}

const source = option('source').toLowerCase();
const approvedBy = option('approved-by').slice(0, 200);
const rollbackDrillId = option('rollback-drill').slice(0, 200);
const acceptancePaths = options('acceptance').map((path) => resolve(path));
const dryRun = process.argv.includes('--dry-run');
if (!SOURCES.includes(source)) fail(`--source must be one of: ${SOURCES.join(', ')}.`);
if (approvedBy.length < 2) fail('--approved-by must name the accountable release owner.');
if (rollbackDrillId.length < 2) fail('--rollback-drill must identify a completed rollback exercise.');
if (acceptancePaths.length < 1) fail('At least one --acceptance must identify finalized, passing sanitized live-acceptance evidence.');

const observationPath = resolve(process.env.OMNIKIT_MIGRATION_ENGINE_PARITY_PATH || 'data/migration-engine/parity-observations.json');
const promotionPath = resolve(process.env.OMNIKIT_MIGRATION_ENGINE_PROMOTION_PATH || 'data/migration-engine/promotions.json');
const manifestPath = resolve(process.env.OMNIKIT_MIGRATION_ENGINE_MANIFEST_PATH || 'data/migration-engine/manifest.json');
const rollbackDrillPath = resolve(process.env.OMNIKIT_MIGRATION_ENGINE_ROLLBACK_DRILL_PATH || 'data/migration-engine/rollback-drills.json');
let managedManifest;
try {
  managedManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch {
  fail(`No readable managed-engine manifest exists at ${manifestPath}. Run npm run setup:migration-engine first.`);
}
const conformance = managedManifest?.conformance?.sources?.[source];
const sourceRevision = String(managedManifest?.sourceRevision || '');
const sourceContentSha256 = String(managedManifest?.sourceContentSha256 || '');
if (managedManifest?.schemaVersion !== 2
  || managedManifest?.engine !== 'omni-migrator'
  || !/^[a-f0-9]{40,64}$/i.test(sourceRevision)
  || sourceRevision.endsWith('-dirty')
  || !/^[a-f0-9]{64}$/i.test(sourceContentSha256)
  || managedManifest?.bridgeSchemaVersion !== 'omnikit.migration.bridge.v1'
  || managedManifest?.resultSchemaVersion !== 'omnikit.migration.bundle.v1'
  || managedManifest?.conformanceSchemaVersion !== 'omnikit.migration.conformance-run.v1'
  || managedManifest?.conformance?.passed !== true
  || conformance?.passed !== true
  || !/^[a-f0-9]{64}$/i.test(String(conformance?.manifest_sha256 || ''))
  || conformance?.manifest_sha256 !== conformance?.expected_sha256
  || !Array.isArray(conformance?.errors)
  || conformance.errors.length > 0
  || conformance?.coverage?.artifacts?.permissions !== 'unsupported'
  || conformance?.coverage?.artifacts?.schedules !== 'unsupported'
  || (source === 'sigma' && conformance?.coverage?.artifacts?.layout !== 'unsupported')) {
  fail(`${source} cannot be promoted because its first-party engine revision or conformance evidence is missing, dirty, mismatched, or failing.`);
}
const requirements = MIGRATION_ENGINE_PROMOTION_REQUIREMENTS[source];
const acceptanceRows = acceptancePaths.map((acceptancePath) => {
  let evidence;
  try {
    evidence = JSON.parse(readFileSync(acceptancePath, 'utf8'));
  } catch {
    fail(`No readable live-acceptance evidence exists at ${acceptancePath}.`);
  }
  try {
    const summary = validateMigrationEngineLiveAcceptance({ evidence, source, manifest: managedManifest });
    return { path: acceptancePath, summary, evidenceSha256: sha256File(acceptancePath) };
  } catch (error) {
    fail(error instanceof Error ? error.message : `${source} live acceptance is invalid.`);
  }
});
const duplicateModes = acceptanceRows.map((item) => item.summary.mode)
  .filter((mode, index, modes) => modes.indexOf(mode) !== index);
if (duplicateModes.length > 0) fail(`Duplicate live-acceptance modes are ambiguous: ${Array.from(new Set(duplicateModes)).join(', ')}.`);
const completedModes = acceptanceRows.map((item) => item.summary.mode);
const missingModes = requirements.requiredAcceptanceModes.filter((mode) => !completedModes.includes(mode));
const unexpectedModes = completedModes.filter((mode) => !requirements.requiredAcceptanceModes.includes(mode));
if (missingModes.length > 0 || unexpectedModes.length > 0) {
  fail(`${source} requires finalized acceptance for ${requirements.requiredAcceptanceModes.join(' + ')}. Missing: ${missingModes.join(', ') || 'none'}; unexpected: ${unexpectedModes.join(', ') || 'none'}.`);
}
const releaseCommits = new Set(acceptanceRows.map((item) => item.summary.omnikitCommitSha));
if (releaseCommits.size !== 1) fail(`${source} live-acceptance records must reference the same clean OmniKit release commit.`);
const liveAcceptances = requirements.requiredAcceptanceModes.map((mode) => {
  const row = acceptanceRows.find((item) => item.summary.mode === mode);
  return { ...row.summary, evidenceSha256: row.evidenceSha256 };
});
const liveAcceptance = liveAcceptances[0];
let rollbackDrillDocument;
try {
  rollbackDrillDocument = JSON.parse(readFileSync(rollbackDrillPath, 'utf8'));
} catch {
  fail(`No readable rollback-drill ledger exists at ${rollbackDrillPath}.`);
}
if (rollbackDrillDocument?.schemaVersion !== 'omnikit.migration-engine-rollback-drills.v1'
  || !Array.isArray(rollbackDrillDocument.drills)) {
  fail('The rollback-drill ledger has an unsupported schema version.');
}
const rollbackDrill = rollbackDrillDocument.drills.find((item) => item?.id === rollbackDrillId && item?.source === source);
if (!rollbackDrill
  || rollbackDrill.passed !== true
  || typeof rollbackDrill.completedAt !== 'string'
  || !Number.isFinite(Date.parse(rollbackDrill.completedAt))
  || Date.parse(rollbackDrill.completedAt) > Date.now()
  || Date.now() - Date.parse(rollbackDrill.completedAt) > 90 * 24 * 60 * 60 * 1_000
  || rollbackDrill?.engine?.name !== managedManifest.engine
  || rollbackDrill?.engine?.version !== managedManifest.version
  || rollbackDrill?.engine?.sourceRevision !== managedManifest.sourceRevision
  || rollbackDrill?.engine?.sourceContentSha256 !== managedManifest.sourceContentSha256
  || rollbackDrill?.engine?.manifestSha256 !== sha256File(manifestPath)) {
  fail(`${rollbackDrillId} is not a current, passing rollback drill for ${source} and the installed engine runtime.`);
}
let observationDocument;
try {
  observationDocument = JSON.parse(readFileSync(observationPath, 'utf8'));
} catch {
  fail(`No readable parity observation ledger exists at ${observationPath}.`);
}
if (observationDocument?.schemaVersion !== 'omnikit.migration.engine-parity-observations.v1') {
  fail('The parity observation ledger has an unsupported schema version.');
}
const observations = Array.isArray(observationDocument.sources?.[source])
  ? observationDocument.sources[source].filter((item) => item?.mode === 'shadow'
    && item.attestationVersion === 'server.v1'
    && /^(?:[a-f0-9]{64})$/i.test(String(item.requestFingerprint || ''))
    && /^(?:[a-f0-9]{64})$/i.test(String(item.resultFingerprint || ''))
    && /^(?:[a-f0-9]{64})$/i.test(String(item.baselineFingerprint || ''))
    && ['server_native', 'canonical_fixture'].includes(item.baselineSource)
    && (item.baselineSource !== 'canonical_fixture'
      || (/^(?:[a-f0-9]{64})$/i.test(String(item.canonicalFixtureSha256 || ''))
        && item.canonicalFixtureSha256 === item.baselineFingerprint
        && item.canonicalFixtureSha256 === conformance.expected_sha256)))
  : [];
if (observations.length === 0) fail(`No server-attested shadow observations exist for ${source}.`);

const latest = observations.filter((item) => item.observationType !== 'canonical_conformance').at(-1) || observations.at(-1);
if (latest.engineName !== managedManifest.engine || latest.engineVersion !== managedManifest.version) {
  fail(`${source} shadow observations do not match the installed first-party engine identity.`);
}
const sameRuntime = observations.filter((item) => item.engineName === latest.engineName
  && item.engineVersion === latest.engineVersion
  && item.parserVersion === latest.parserVersion
  && item.rulebookVersion === latest.rulebookVersion);
const nativeParity = Array.from(new Map(sameRuntime
  .filter((item) => item.observationType === 'native_parity' || (!item.observationType && item.baselineSource === 'server_native'))
  .map((item) => [`${item.requestFingerprint}:${item.resultFingerprint}`, item])).values());
const canonicalObservation = sameRuntime.findLast((item) => item.observationType === 'canonical_conformance'
  && item.canonicalFixtureSha256 === conformance.expected_sha256
  && item.resultFingerprint === conformance.manifest_sha256);
const operational = Array.from(new Map(sameRuntime
  .filter((item) => item.observationType === 'operational')
  .map((item) => [`${item.requestFingerprint}:${item.resultFingerprint}`, item])).values());
const usingNativeParity = nativeParity.length >= requirements.observations;
if (!usingNativeParity && !canonicalObservation) {
  fail(`${source} needs a canonical conformance observation for the installed engine runtime.`);
}
const window = (usingNativeParity ? nativeParity : operational).slice(-requirements.observations);
if (window.length < requirements.observations) {
  fail(`${source} needs ${requirements.observations} shadow observations from the same engine, parser, and rulebook; ${window.length} are available.`);
}

const scoreNames = ['semantic', 'dashboards', 'stableIdentity', 'overall'];
const scoreWindow = usingNativeParity ? window : [canonicalObservation];
const minimumScores = Object.fromEntries(scoreNames.map((name) => [name, Math.min(...scoreWindow.map((item) => Number(item?.scores?.[name])))]));
const failedScores = scoreNames.filter((name) => !Number.isFinite(minimumScores[name]) || minimumScores[name] < requirements[name]);
if (failedScores.length > 0) {
  fail(`${source} cannot be promoted because its observation window misses these minimum scores: ${failedScores.map((name) => `${name} ${minimumScores[name]} < ${requirements[name]}`).join(', ')}.`);
}

let promotions = { schemaVersion: 'omnikit.migration.engine-promotions.v1', sources: {} };
try {
  const parsed = JSON.parse(readFileSync(promotionPath, 'utf8'));
  if (parsed?.schemaVersion === promotions.schemaVersion && parsed.sources && typeof parsed.sources === 'object') promotions = parsed;
} catch {
  // A promotion ledger is created only after all gates pass.
}
const now = new Date().toISOString();
const previousHistory = Array.isArray(promotions.sources[source]?.history) ? promotions.sources[source].history : [];
const acceptanceEvidenceSha256 = sha256Json(liveAcceptances.map((item) => ({ mode: item.mode, evidenceSha256: item.evidenceSha256 })));
const rollbackLedgerSha256 = sha256File(rollbackDrillPath);
promotions.sources[source] = {
  approvedBy,
  approvedAt: now,
  sourceOwner: Array.from(new Set(liveAcceptances.map((item) => item.owner))).join(', '),
  evidenceExpiresAt: liveAcceptances.map((item) => item.expiresAt).sort()[0],
  omnikitCommitSha: liveAcceptance.omnikitCommitSha,
  observationCount: window.length,
  evidenceMode: usingNativeParity ? 'server_native' : 'canonical_plus_operational',
  observationWindow: {
    startedAt: window[0].generatedAt,
    endedAt: window.at(-1).generatedAt,
  },
  scores: minimumScores,
  engine: {
    name: latest.engineName,
    version: latest.engineVersion,
    sourceRevision,
    sourceContentSha256,
    parserVersion: latest.parserVersion,
    rulebookVersion: latest.rulebookVersion,
  },
  conformance: {
    schemaVersion: managedManifest.conformanceSchemaVersion,
    manifestSha256: conformance.manifest_sha256,
    expectedSha256: conformance.expected_sha256,
  },
  rollbackDrill: {
    id: rollbackDrill.id,
    completedAt: rollbackDrill.completedAt,
    completedBy: rollbackDrill.completedBy,
    ledgerSha256: rollbackLedgerSha256,
  },
  liveAcceptance: {
    ...liveAcceptance,
    evidenceSha256: acceptanceEvidenceSha256,
    requiredModes: [...requirements.requiredAcceptanceModes],
    completedModes: [...completedModes].sort(),
  },
  liveAcceptances,
  history: [
    ...previousHistory,
    {
      event: 'promoted',
      at: now,
      by: approvedBy,
      acceptanceEvidenceSha256,
      acceptanceModes: [...completedModes].sort(),
      rollbackDrillId: rollbackDrill.id,
      rollbackLedgerSha256,
    },
  ].slice(-100),
};

if (dryRun) {
  console.log(JSON.stringify(promotions.sources[source], null, 2));
} else {
  mkdirSync(dirname(promotionPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${promotionPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(promotions, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, promotionPath);
  console.log(`Promoted ${source} for primary rollout using ${window.length} passing shadow observations. Rollback drill: ${rollbackDrillId}.`);
}

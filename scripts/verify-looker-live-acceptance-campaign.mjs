import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  MIGRATION_ENGINE_PROMOTION_REQUIREMENTS,
  sha256File,
  sha256Json,
  validateMigrationEngineLiveAcceptance,
} from './migration-engine-certification.mjs';

export const LOOKER_DUAL_PATH_CAMPAIGN_SCHEMA_VERSION = 'omnikit.looker-dual-path-acceptance-campaign.v1';

const REQUIRED_CONSTRUCTS = [
  'standardViews',
  'measures',
  'joins',
  'inlineTile',
  'savedLookTile',
  'filtersAndListeners',
  'layout',
  'reviewRequiredConstruct',
];

const REQUIRED_COMPARISONS = [
  'canonicalInventory',
  'generatedYaml',
  'dashboardPlans',
  'validation',
  'reconciliation',
];

const MAX_CAMPAIGN_VALIDITY_MS = 90 * 24 * 60 * 60 * 1_000;

function validSha256(value) {
  return /^[a-f0-9]{64}$/i.test(String(value || ''));
}

function validCommitSha(value) {
  return /^[a-f0-9]{40}$/i.test(String(value || ''));
}

function validDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function nonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 1_000_000 ? parsed : null;
}

function normalizedScore(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : null;
}

function requireNamedOwner(value, label) {
  if (typeof value !== 'string' || value.trim().length < 2) {
    throw new Error(`${label} must name an accountable owner.`);
  }
  return value.trim().slice(0, 200);
}

function validateAccounting(mode, accounting) {
  if (!accounting || typeof accounting !== 'object' || Array.isArray(accounting)) {
    throw new Error(`${mode} accounting is missing.`);
  }
  const selectedDashboardCount = nonNegativeInteger(accounting.selectedDashboardCount);
  const accountedDashboardCount = nonNegativeInteger(accounting.accountedDashboardCount);
  const selectedTileCount = nonNegativeInteger(accounting.selectedTileCount);
  const accountedTileCount = nonNegativeInteger(accounting.accountedTileCount);
  const silentOmissionCount = nonNegativeInteger(accounting.silentOmissionCount);
  if (selectedDashboardCount === null || selectedDashboardCount < 1
    || accountedDashboardCount !== selectedDashboardCount
    || selectedTileCount === null || selectedTileCount < 1
    || accountedTileCount !== selectedTileCount
    || silentOmissionCount !== 0) {
    throw new Error(`${mode} acceptance must account for 100% of selected dashboards and tiles with zero silent omissions.`);
  }
  return {
    selectedDashboardCount,
    accountedDashboardCount,
    selectedTileCount,
    accountedTileCount,
    silentOmissionCount,
  };
}

function validateComparisonEvidence(comparisonEvidence) {
  if (!comparisonEvidence || typeof comparisonEvidence !== 'object' || Array.isArray(comparisonEvidence)) {
    throw new Error('The paired campaign is missing sanitized comparison evidence.');
  }
  return Object.fromEntries(REQUIRED_COMPARISONS.map((name) => {
    const evidence = comparisonEvidence[name];
    const checkedCount = nonNegativeInteger(evidence?.checkedCount);
    const failedCount = nonNegativeInteger(evidence?.failedCount);
    if (!validSha256(evidence?.manualSha256)
      || !validSha256(evidence?.apiSha256)
      || !validSha256(evidence?.comparisonSha256)
      || checkedCount === null
      || checkedCount < 1
      || failedCount !== 0) {
      throw new Error(`${name} comparison must include Manual, API, and comparison SHA-256 references, checked evidence, and zero failures.`);
    }
    return [name, {
      manualSha256: String(evidence.manualSha256).toLowerCase(),
      apiSha256: String(evidence.apiSha256).toLowerCase(),
      comparisonSha256: String(evidence.comparisonSha256).toLowerCase(),
      checkedCount,
      failedCount,
    }];
  }));
}

function validateRollback({ campaign, rollbackLedger, manifest, manifestSha256, now }) {
  if (rollbackLedger?.schemaVersion !== 'omnikit.migration-engine-rollback-drills.v1'
    || !Array.isArray(rollbackLedger.drills)) {
    throw new Error('The rollback-drill ledger has an unsupported schema version.');
  }
  const rollback = campaign.rollback && typeof campaign.rollback === 'object' ? campaign.rollback : {};
  const drill = rollbackLedger.drills.find((entry) => entry?.id === rollback.id && entry?.source === 'looker');
  if (!drill
    || drill.passed !== true
    || !validDate(drill.completedAt)
    || Date.parse(drill.completedAt) > now.getTime()
    || now.getTime() - Date.parse(drill.completedAt) > MAX_CAMPAIGN_VALIDITY_MS
    || drill?.engine?.name !== manifest.engine
    || drill?.engine?.version !== manifest.version
    || drill?.engine?.sourceRevision !== manifest.sourceRevision
    || drill?.engine?.sourceContentSha256 !== manifest.sourceContentSha256
    || drill?.engine?.manifestSha256 !== manifestSha256
    || rollback.completedAt !== drill.completedAt
    || rollback.drillSha256 !== sha256Json(drill)) {
    throw new Error('The campaign must reference a current passing Looker rollback drill for the installed engine runtime.');
  }
  return {
    id: drill.id,
    completedAt: drill.completedAt,
    completedBy: requireNamedOwner(drill.completedBy, 'Rollback evidence'),
    drillSha256: rollback.drillSha256,
  };
}

export function validateLookerDualPathAcceptanceCampaign({
  campaign,
  manualEvidence,
  apiEvidence,
  manualEvidenceSha256,
  apiEvidenceSha256,
  manifest,
  manifestSha256,
  rollbackLedger,
  now = new Date(),
}) {
  if (!campaign || typeof campaign !== 'object' || Array.isArray(campaign)
    || campaign.schemaVersion !== LOOKER_DUAL_PATH_CAMPAIGN_SCHEMA_VERSION) {
    throw new Error('The Looker dual-path campaign has an unsupported schema version.');
  }
  if (!validCommitSha(campaign.releaseCommitSha)
    || !validSha256(campaign.representativeProjectRefSha256)
    || campaign.releaseStage !== 'preview') {
    throw new Error('The campaign must bind one representative project to a clean release commit and retain Looker Preview status.');
  }
  const owner = requireNamedOwner(campaign.owner, 'Campaign approval');
  if (!validDate(campaign.approvedAt) || !validDate(campaign.expiresAt)) {
    throw new Error('Campaign approval must include valid approvedAt and expiresAt timestamps.');
  }
  const approvedAt = Date.parse(campaign.approvedAt);
  const expiresAt = Date.parse(campaign.expiresAt);
  if (approvedAt > now.getTime()
    || expiresAt <= now.getTime()
    || expiresAt <= approvedAt
    || expiresAt - approvedAt > MAX_CAMPAIGN_VALIDITY_MS) {
    throw new Error('Campaign approval must be current and expire no more than 90 days after approval.');
  }

  const manualSummary = validateMigrationEngineLiveAcceptance({ evidence: manualEvidence, source: 'looker', manifest, now });
  const apiSummary = validateMigrationEngineLiveAcceptance({ evidence: apiEvidence, source: 'looker', manifest, now });
  if (manualSummary.mode !== 'manual' || apiSummary.mode !== 'api') {
    throw new Error('The paired campaign requires one finalized Manual Files record and one finalized Saved API record.');
  }
  if (manualEvidenceSha256 !== campaign?.acceptance?.manual?.finalAcceptanceSha256
    || apiEvidenceSha256 !== campaign?.acceptance?.api?.finalAcceptanceSha256) {
    throw new Error('Campaign acceptance checksums do not match the finalized Manual and API evidence.');
  }
  if (manualSummary.omnikitCommitSha !== campaign.releaseCommitSha
    || apiSummary.omnikitCommitSha !== campaign.releaseCommitSha
    || manualSummary.engine.name !== apiSummary.engine.name
    || manualSummary.engine.version !== apiSummary.engine.version
    || manualSummary.engine.revision !== apiSummary.engine.revision
    || manualSummary.engine.rulebookSha256 !== apiSummary.engine.rulebookSha256) {
    throw new Error('Both acquisition modes must use the same clean OmniKit release and migration-engine runtime.');
  }
  if (manualEvidence?.input?.target_instance_ref_sha256 !== apiEvidence?.input?.target_instance_ref_sha256) {
    throw new Error('Manual and API acceptance must target the same isolated Omni development environment.');
  }
  const manualProjectRef = campaign?.acceptance?.manual?.sourceProjectRefSha256;
  const apiProjectRef = campaign?.acceptance?.api?.sourceProjectRefSha256;
  if (!validSha256(manualProjectRef)
    || manualProjectRef !== apiProjectRef
    || manualProjectRef !== campaign.representativeProjectRefSha256
    || manualEvidence?.input?.selected_project_count !== 1
    || apiEvidence?.input?.selected_project_count !== 1
    || manualEvidence?.input?.selected_project_scope_sha256 !== manualProjectRef
    || apiEvidence?.input?.selected_project_scope_sha256 !== apiProjectRef) {
    throw new Error('Manual and API acceptance must identify the same representative Looker project fingerprint.');
  }
  const manualBranchRef = campaign?.acceptance?.manual?.branchRefSha256;
  const apiBranchRef = campaign?.acceptance?.api?.branchRefSha256;
  if (!validSha256(manualBranchRef) || !validSha256(apiBranchRef) || manualBranchRef === apiBranchRef) {
    throw new Error('Manual and API acceptance must deploy to distinct isolated Omni development branches.');
  }
  const latestFinalization = Math.max(Date.parse(manualSummary.finalizedAt), Date.parse(apiSummary.finalizedAt));
  if (approvedAt < latestFinalization) {
    throw new Error('Campaign approval cannot predate either finalized acceptance record.');
  }

  const constructs = campaign.requiredConstructs && typeof campaign.requiredConstructs === 'object'
    ? campaign.requiredConstructs
    : {};
  const missingConstructs = REQUIRED_CONSTRUCTS.filter((name) => constructs[name] !== true);
  if (missingConstructs.length > 0) {
    throw new Error(`The representative Looker scope is missing required constructs: ${missingConstructs.join(', ')}.`);
  }

  const accounting = {
    manual: validateAccounting('Manual Files', campaign?.accounting?.manual),
    api: validateAccounting('Saved API', campaign?.accounting?.api),
  };
  if (accounting.manual.selectedDashboardCount !== accounting.api.selectedDashboardCount
    || accounting.manual.selectedTileCount !== accounting.api.selectedTileCount) {
    throw new Error('Manual and API acceptance must account for the same selected dashboard and tile scope.');
  }

  const requirements = MIGRATION_ENGINE_PROMOTION_REQUIREMENTS.looker;
  const scores = {
    semantic: normalizedScore(campaign?.parity?.semantic),
    dashboards: normalizedScore(campaign?.parity?.dashboards),
    stableIdentity: normalizedScore(campaign?.parity?.stableIdentity),
    overall: normalizedScore(campaign?.parity?.overall),
  };
  const failedScores = Object.entries(scores)
    .filter(([name, score]) => score === null || score < requirements[name])
    .map(([name, score]) => `${name} ${score ?? 'invalid'} < ${requirements[name]}`);
  if (failedScores.length > 0) {
    throw new Error(`Looker dual-path parity is below the promotion threshold: ${failedScores.join(', ')}.`);
  }

  const comparisons = validateComparisonEvidence(campaign.comparisonEvidence);
  const rollback = validateRollback({ campaign, rollbackLedger, manifest, manifestSha256, now });
  return {
    ready: true,
    schemaVersion: campaign.schemaVersion,
    source: 'looker',
    releaseStage: 'preview',
    releaseCommitSha: campaign.releaseCommitSha,
    owner,
    approvedAt: new Date(approvedAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    modes: ['manual', 'api'],
    accounting,
    scores,
    comparisonCount: Object.keys(comparisons).length,
    rollback,
  };
}

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || '').trim() : '';
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${label} is not readable JSON: ${path}`);
  }
}

function usage() {
  return `Verify one paired Looker Manual Files and Saved API live-acceptance campaign.

Usage:
  npm run verify:looker-acceptance-campaign -- \\
    --campaign <campaign.json> \\
    --manual-acceptance <manual-final.json> \\
    --api-acceptance <api-final.json> \\
    [--manifest data/migration-engine/manifest.json] \\
    [--rollback-ledger data/migration-engine/rollback-drills.json]

The campaign and acceptance files must remain outside the repository or under ignored data/.`;
}

export function runLookerDualPathCampaignCli() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const campaignPath = resolve(option('campaign'));
  const manualPath = resolve(option('manual-acceptance'));
  const apiPath = resolve(option('api-acceptance'));
  if (!option('campaign') || !option('manual-acceptance') || !option('api-acceptance')) {
    throw new Error(usage());
  }
  const manifestPath = resolve(option('manifest') || process.env.OMNIKIT_MIGRATION_ENGINE_MANIFEST_PATH || 'data/migration-engine/manifest.json');
  const rollbackLedgerPath = resolve(option('rollback-ledger') || process.env.OMNIKIT_MIGRATION_ENGINE_ROLLBACK_DRILL_PATH || 'data/migration-engine/rollback-drills.json');
  const summary = validateLookerDualPathAcceptanceCampaign({
    campaign: readJson(campaignPath, 'Looker campaign'),
    manualEvidence: readJson(manualPath, 'Manual acceptance'),
    apiEvidence: readJson(apiPath, 'API acceptance'),
    manualEvidenceSha256: sha256File(manualPath),
    apiEvidenceSha256: sha256File(apiPath),
    manifest: readJson(manifestPath, 'Migration-engine manifest'),
    manifestSha256: sha256File(manifestPath),
    rollbackLedger: readJson(rollbackLedgerPath, 'Rollback-drill ledger'),
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    runLookerDualPathCampaignCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Looker campaign validation failed.'}\n`);
    process.exitCode = 1;
  }
}

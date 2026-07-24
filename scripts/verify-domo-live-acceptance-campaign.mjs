import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DOMO_CAMPAIGN_SCHEMA_VERSION = 'omnikit.domo-dual-path-acceptance-campaign.v1';
export const DOMO_ACCEPTANCE_SCHEMA_VERSION = 'omnikit.domo-live-acceptance.v1';

const MAX_VALIDITY_MS = 90 * 24 * 60 * 60 * 1_000;
const REQUIRED_CONSTRUCTS = [
  'pages',
  'sharedCards',
  'sharedDatasets',
  'datasetSchemas',
  'beastModes',
  'sqlDataflows',
  'relationships',
  'pdpPolicies',
  'ownershipAndUsage',
  'schedulesAndAlerts',
  'governedHandoffs',
  'formulaCollision',
];
const REQUIRED_STAGES = [
  'sourceAcquisition',
  'dependencyClosure',
  'semanticCompilation',
  'branchDeployment',
  'omniValidation',
  'dashboardReconstruction',
  'queryResultReconciliation',
  'governanceOperationalReconciliation',
];
const REQUIRED_COMPARISONS = [
  'canonicalInventory',
  'dependencyClosure',
  'generatedYaml',
  'dashboardPlans',
  'validation',
  'reconciliation',
];
const PARITY_THRESHOLDS = {
  semantic: 95,
  dashboards: 90,
  stableIdentity: 95,
  governance: 100,
  overall: 93,
};
const SENSITIVE_KEY = /(api.?key|access.?token|refresh.?token|client.?secret|password|credential)/i;

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function validSha256(value) {
  return /^[a-f0-9]{64}$/i.test(String(value || ''));
}

function validCommitSha(value) {
  return /^[a-f0-9]{40}$/i.test(String(value || ''));
}

function timestamp(value, label) {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a valid timestamp.`);
  return parsed;
}

function namedOwner(value, label) {
  if (typeof value !== 'string' || value.trim().length < 2) throw new Error(`${label} must name an accountable owner.`);
  return value.trim().slice(0, 200);
}

function count(value, label, minimum = 0) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > 1_000_000) {
    throw new Error(`${label} must be an integer between ${minimum} and 1000000.`);
  }
  return parsed;
}

function score(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) throw new Error(`${label} must be a score from 0 to 100.`);
  return parsed;
}

function rejectSensitiveKeys(value, path = 'document') {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectSensitiveKeys(item, `${path}[${index}]`));
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) throw new Error(`${path}.${key} is a prohibited sensitive field.`);
    rejectSensitiveKeys(nested, `${path}.${key}`);
  }
}

function validateWindow(recordedAtValue, expiresAtValue, now, label) {
  const recordedAt = timestamp(recordedAtValue, `${label} recordedAt`);
  const expiresAt = timestamp(expiresAtValue, `${label} expiresAt`);
  if (recordedAt > now.getTime() || expiresAt <= now.getTime() || expiresAt <= recordedAt || expiresAt - recordedAt > MAX_VALIDITY_MS) {
    throw new Error(`${label} must be current and expire no more than 90 days after it was recorded.`);
  }
  return { recordedAt: new Date(recordedAt).toISOString(), expiresAt: new Date(expiresAt).toISOString() };
}

function validateAccounting(accounting, label) {
  if (!accounting || typeof accounting !== 'object' || Array.isArray(accounting)) throw new Error(`${label} accounting is missing.`);
  const selectedPageCount = count(accounting.selectedPageCount, `${label} selectedPageCount`, 1);
  const accountedPageCount = count(accounting.accountedPageCount, `${label} accountedPageCount`, 1);
  const selectedCardCount = count(accounting.selectedCardCount, `${label} selectedCardCount`, 1);
  const accountedCardCount = count(accounting.accountedCardCount, `${label} accountedCardCount`, 1);
  const selectedDependencyCount = count(accounting.selectedDependencyCount, `${label} selectedDependencyCount`, 1);
  const accountedDependencyCount = count(accounting.accountedDependencyCount, `${label} accountedDependencyCount`, 1);
  const silentOmissionCount = count(accounting.silentOmissionCount, `${label} silentOmissionCount`);
  if (selectedPageCount !== accountedPageCount
    || selectedCardCount !== accountedCardCount
    || selectedDependencyCount !== accountedDependencyCount
    || silentOmissionCount !== 0) {
    throw new Error(`${label} must account for every selected Page, Card, and dependency with zero silent omissions.`);
  }
  return { selectedPageCount, accountedPageCount, selectedCardCount, accountedCardCount, selectedDependencyCount, accountedDependencyCount, silentOmissionCount };
}

function validateAcceptance(evidence, expectedMode, now) {
  rejectSensitiveKeys(evidence, `${expectedMode}Evidence`);
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)
    || evidence.schemaVersion !== DOMO_ACCEPTANCE_SCHEMA_VERSION
    || evidence.status !== 'final'
    || evidence.mode !== expectedMode) {
    throw new Error(`${expectedMode} evidence must be one finalized ${DOMO_ACCEPTANCE_SCHEMA_VERSION} record.`);
  }
  if (!validCommitSha(evidence.releaseCommitSha)
    || !validSha256(evidence.sourceScopeRefSha256)
    || !validSha256(evidence.targetEnvironmentRefSha256)
    || !validSha256(evidence.branchRefSha256)
    || evidence?.parserContract?.id !== 'domo-native-v2'
    || !validSha256(evidence?.parserContract?.sha256)) {
    throw new Error(`${expectedMode} evidence must bind a clean release, source scope, target, branch, and Domo parser contract by checksum.`);
  }
  const owner = namedOwner(evidence.owner, `${expectedMode} evidence`);
  const window = validateWindow(evidence.recordedAt, evidence.expiresAt, now, `${expectedMode} evidence`);
  const accounting = validateAccounting(evidence.accounting, `${expectedMode} evidence`);
  for (const stageName of REQUIRED_STAGES) {
    const stage = evidence?.stages?.[stageName];
    if (stage?.status !== 'passed'
      || !validSha256(stage?.evidenceSha256)
      || count(stage?.checkedCount, `${expectedMode} ${stageName} checkedCount`, 1) < 1
      || count(stage?.failedCount, `${expectedMode} ${stageName} failedCount`) !== 0) {
      throw new Error(`${expectedMode} stage ${stageName} must pass with checksummed evidence, checked work, and zero failures.`);
    }
  }
  return { mode: expectedMode, owner, ...window, accounting };
}

function validateComparisons(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Domo comparison evidence is missing.');
  for (const name of REQUIRED_COMPARISONS) {
    const comparison = value[name];
    if (!validSha256(comparison?.manualSha256)
      || !validSha256(comparison?.apiSha256)
      || !validSha256(comparison?.comparisonSha256)
      || count(comparison?.checkedCount, `${name} checkedCount`, 1) < 1
      || count(comparison?.failedCount, `${name} failedCount`) !== 0) {
      throw new Error(`${name} parity must include Manual, API, and comparison checksums with zero failures.`);
    }
  }
}

export function validateDomoDualPathAcceptanceCampaign({
  campaign,
  manualEvidence,
  apiEvidence,
  manualEvidenceSha256,
  apiEvidenceSha256,
  now = new Date(),
}) {
  rejectSensitiveKeys(campaign, 'campaign');
  if (!campaign || typeof campaign !== 'object' || Array.isArray(campaign)
    || campaign.schemaVersion !== DOMO_CAMPAIGN_SCHEMA_VERSION
    || campaign.releaseStage !== 'preview') {
    throw new Error('The Domo campaign must use the supported schema and retain Preview status.');
  }
  if (!validCommitSha(campaign.releaseCommitSha)
    || !validSha256(campaign.sourceScopeRefSha256)
    || !validSha256(campaign.targetEnvironmentRefSha256)
    || campaign?.parserContract?.id !== 'domo-native-v2'
    || !validSha256(campaign?.parserContract?.sha256)) {
    throw new Error('The Domo campaign must bind a clean release, one source scope, target environment, and parser contract by checksum.');
  }
  const owner = namedOwner(campaign.owner, 'Domo campaign');
  const campaignWindow = validateWindow(campaign.approvedAt, campaign.expiresAt, now, 'Domo campaign');
  const manual = validateAcceptance(manualEvidence, 'manual', now);
  const api = validateAcceptance(apiEvidence, 'api', now);
  if (manualEvidenceSha256 !== campaign?.acceptance?.manual?.finalEvidenceSha256
    || apiEvidenceSha256 !== campaign?.acceptance?.api?.finalEvidenceSha256) {
    throw new Error('Campaign checksums do not match the finalized Manual and API evidence records.');
  }
  for (const evidence of [manualEvidence, apiEvidence]) {
    if (evidence.releaseCommitSha !== campaign.releaseCommitSha
      || evidence.sourceScopeRefSha256 !== campaign.sourceScopeRefSha256
      || evidence.targetEnvironmentRefSha256 !== campaign.targetEnvironmentRefSha256
      || evidence.parserContract.id !== campaign.parserContract.id
      || evidence.parserContract.sha256 !== campaign.parserContract.sha256) {
      throw new Error('Manual and API evidence must use the same release, source scope, target environment, and Domo parser contract as the campaign.');
    }
  }
  const manualBranch = campaign?.acceptance?.manual?.branchRefSha256;
  const apiBranch = campaign?.acceptance?.api?.branchRefSha256;
  if (!validSha256(manualBranch)
    || !validSha256(apiBranch)
    || manualBranch === apiBranch
    || manualEvidence.branchRefSha256 !== manualBranch
    || apiEvidence.branchRefSha256 !== apiBranch) {
    throw new Error('Manual and API acceptance must use distinct isolated development branches bound by checksum.');
  }
  if (Date.parse(campaignWindow.recordedAt) < Math.max(Date.parse(manual.recordedAt), Date.parse(api.recordedAt))) {
    throw new Error('Campaign approval cannot predate either finalized evidence record.');
  }
  const missingConstructs = REQUIRED_CONSTRUCTS.filter((name) => campaign?.requiredConstructs?.[name] !== true);
  if (missingConstructs.length > 0) throw new Error(`The Domo campaign is missing required constructs: ${missingConstructs.join(', ')}.`);
  const campaignManualAccounting = validateAccounting(campaign?.accounting?.manual, 'Campaign Manual Files');
  const campaignApiAccounting = validateAccounting(campaign?.accounting?.api, 'Campaign Saved API');
  if (JSON.stringify(campaignManualAccounting) !== JSON.stringify(manual.accounting)
    || JSON.stringify(campaignApiAccounting) !== JSON.stringify(api.accounting)
    || campaignManualAccounting.selectedPageCount !== campaignApiAccounting.selectedPageCount
    || campaignManualAccounting.selectedCardCount !== campaignApiAccounting.selectedCardCount
    || campaignManualAccounting.selectedDependencyCount !== campaignApiAccounting.selectedDependencyCount) {
    throw new Error('Campaign accounting must match both evidence records and cover the same selected Domo scope.');
  }
  const parity = Object.fromEntries(Object.entries(PARITY_THRESHOLDS).map(([name, threshold]) => {
    const value = score(campaign?.parity?.[name], `Domo ${name} parity`);
    if (value < threshold) throw new Error(`Domo ${name} parity ${value} is below the Preview threshold of ${threshold}.`);
    return [name, value];
  }));
  validateComparisons(campaign.comparisonEvidence);
  const rollbackOwner = namedOwner(campaign?.rollback?.owner, 'Domo rollback evidence');
  const rollbackAt = timestamp(campaign?.rollback?.completedAt, 'Domo rollback completedAt');
  if (rollbackAt > now.getTime() || now.getTime() - rollbackAt > MAX_VALIDITY_MS || !validSha256(campaign?.rollback?.evidenceSha256)) {
    throw new Error('The Domo campaign requires a current checksummed rollback exercise from the last 90 days.');
  }
  return {
    ready: true,
    schemaVersion: campaign.schemaVersion,
    source: 'domo',
    releaseStage: 'preview',
    releaseCommitSha: campaign.releaseCommitSha,
    owner,
    approvedAt: campaignWindow.recordedAt,
    expiresAt: campaignWindow.expiresAt,
    modes: ['manual', 'api'],
    accounting: { manual: campaignManualAccounting, api: campaignApiAccounting },
    parity,
    comparisonCount: REQUIRED_COMPARISONS.length,
    rollback: { owner: rollbackOwner, completedAt: new Date(rollbackAt).toISOString(), evidenceSha256: campaign.rollback.evidenceSha256 },
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
  return [
    'Verify one paired Domo Manual Files and Saved API live-acceptance campaign.',
    '',
    'Usage:',
    '  npm run verify:domo-acceptance-campaign --',
    '    --campaign <campaign.json>',
    '    --manual-evidence <manual-final.json>',
    '    --api-evidence <api-final.json>',
    '',
    'Completed campaign and evidence files must remain outside the repository or under ignored data/.',
  ].join('\n');
}

export function runDomoDualPathCampaignCli() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!option('campaign') || !option('manual-evidence') || !option('api-evidence')) throw new Error(usage());
  const campaignPath = resolve(option('campaign'));
  const manualPath = resolve(option('manual-evidence'));
  const apiPath = resolve(option('api-evidence'));
  const summary = validateDomoDualPathAcceptanceCampaign({
    campaign: readJson(campaignPath, 'Domo campaign'),
    manualEvidence: readJson(manualPath, 'Domo Manual evidence'),
    apiEvidence: readJson(apiPath, 'Domo API evidence'),
    manualEvidenceSha256: sha256File(manualPath),
    apiEvidenceSha256: sha256File(apiPath),
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    runDomoDualPathCampaignCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Domo campaign validation failed.'}\n`);
    process.exitCode = 1;
  }
}

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const MIGRATION_ENGINE_SOURCES = ['looker', 'powerbi', 'tableau', 'metabase', 'sigma'];

export const MIGRATION_ENGINE_PROMOTION_REQUIREMENTS = {
  looker: { semantic: 95, dashboards: 90, stableIdentity: 95, overall: 93, observations: 20 },
  powerbi: { semantic: 95, dashboards: 85, stableIdentity: 95, overall: 92, observations: 20 },
  tableau: { semantic: 92, dashboards: 85, stableIdentity: 95, overall: 90, observations: 25 },
  metabase: { semantic: 95, dashboards: 95, stableIdentity: 95, overall: 95, observations: 20 },
  sigma: { semantic: 90, dashboards: 80, stableIdentity: 95, overall: 88, observations: 25 },
};

export const LIVE_ACCEPTANCE_SCHEMA_VERSION = 'omnikit.migration-engine-live-acceptance.v2';
export const ACCEPTANCE_REVIEW_SCHEMA_VERSION = 'omnikit.migration-engine-acceptance-review.v1';
export const MIGRATION_ENGINE_ACCEPTANCE_STAGES = [
  'source_extraction',
  'semantic_translation',
  'branch_deployment',
  'omni_validation',
  'dashboard_reconstruction',
  'query_result_reconciliation',
  'permission_schedule_gap_reporting',
  'visual_structural_reconciliation',
];
export const REVIEWED_ACCEPTANCE_STAGES = MIGRATION_ENGINE_ACCEPTANCE_STAGES.filter((stage) => stage !== 'source_extraction');

const MAX_ACCEPTANCE_VALIDITY_MS = 90 * 24 * 60 * 60 * 1_000;

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function sha256Json(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function validDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validSha256(value) {
  return /^[a-f0-9]{64}$/i.test(String(value || ''));
}

function boundedCount(value) {
  const count = Number(value);
  return Number.isInteger(count) && count >= 0 && count <= 1_000_000 ? count : null;
}

function flattenCapabilityCoverage(value, path = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const gaps = [];
  for (const [key, nested] of Object.entries(value)) {
    const nextPath = [...path, key];
    if (typeof nested === 'string' && ['partial', 'unsupported'].includes(nested.toLowerCase())) {
      gaps.push({
        id: `capability:${nextPath.join('.')}`,
        category: nextPath.join('.'),
        coverage: nested.toLowerCase(),
        disposition: 'unreviewed',
        count: 1,
      });
    } else if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      gaps.push(...flattenCapabilityCoverage(nested, nextPath));
    }
  }
  return gaps;
}

export function buildProvisionalAcceptanceGaps(capabilityCoverage, limitations = []) {
  const capabilityGaps = flattenCapabilityCoverage(capabilityCoverage);
  const limitationGaps = Array.isArray(limitations)
    ? limitations.map((limitation) => ({
      id: `limitation:${createHash('sha256').update(String(limitation)).digest('hex').slice(0, 20)}`,
      category: 'engine_limitation',
      coverage: 'partial',
      disposition: 'unreviewed',
      count: 1,
    }))
    : [];
  return Array.from(new Map([...capabilityGaps, ...limitationGaps].map((gap) => [gap.id, gap])).values());
}

export function buildProvisionalAcceptanceStages(sourceExtractionEvidenceSha256) {
  return Object.fromEntries(MIGRATION_ENGINE_ACCEPTANCE_STAGES.map((stage) => [
    stage,
    stage === 'source_extraction'
      ? {
        status: 'passed',
        live: true,
        evidence_sha256: sourceExtractionEvidenceSha256,
        checked_count: 1,
        failed_count: 0,
      }
      : {
        status: 'not_run',
        evidence_sha256: null,
        checked_count: 0,
        failed_count: 0,
      },
  ]));
}

export function validateMigrationEngineAcceptanceReview({
  review,
  source,
  provisionalEvidence,
  provisionalSha256,
  now = new Date(),
}) {
  if (!review || typeof review !== 'object' || Array.isArray(review)) {
    throw new Error('Acceptance review is not a JSON object.');
  }
  if (review.schema_version !== ACCEPTANCE_REVIEW_SCHEMA_VERSION
    || review.source !== source
    || review.provisional_evidence_sha256 !== provisionalSha256) {
    throw new Error('Acceptance review schema, source, or provisional evidence checksum does not match.');
  }
  if (typeof review.owner !== 'string' || review.owner.trim().length < 2) {
    throw new Error('Acceptance review must name the accountable migration owner.');
  }
  if (!validDate(review.reviewed_at) || !validDate(review.expires_at)) {
    throw new Error('Acceptance review must include valid reviewed_at and expires_at timestamps.');
  }
  const reviewedAt = Date.parse(review.reviewed_at);
  const expiresAt = Date.parse(review.expires_at);
  if (expiresAt <= reviewedAt || expiresAt - reviewedAt > MAX_ACCEPTANCE_VALIDITY_MS || expiresAt <= now.getTime()) {
    throw new Error('Acceptance review expiry must be in the future and no more than 90 days after review.');
  }
  if (reviewedAt < Date.parse(provisionalEvidence.recorded_at)) {
    throw new Error('Acceptance review cannot predate the provisional live extraction.');
  }

  const stages = review.stages && typeof review.stages === 'object' && !Array.isArray(review.stages)
    ? review.stages
    : {};
  const normalizedStages = {};
  for (const stage of REVIEWED_ACCEPTANCE_STAGES) {
    const result = stages[stage] && typeof stages[stage] === 'object' ? stages[stage] : {};
    const checkedCount = boundedCount(result.checked_count);
    const failedCount = boundedCount(result.failed_count);
    if (result.status !== 'passed'
      || !validSha256(result.evidence_sha256)
      || checkedCount === null
      || checkedCount < 1
      || failedCount !== 0) {
      throw new Error(`Acceptance stage ${stage} must pass with a SHA-256 evidence reference, at least one checked item, and zero failures.`);
    }
    normalizedStages[stage] = {
      status: 'passed',
      evidence_sha256: String(result.evidence_sha256).toLowerCase(),
      checked_count: checkedCount,
      failed_count: failedCount,
    };
  }

  const provisionalGaps = Array.isArray(provisionalEvidence.gaps) ? provisionalEvidence.gaps : [];
  const reviewGaps = Array.isArray(review.gaps) ? review.gaps : [];
  const reviewById = new Map();
  for (const gap of reviewGaps) {
    if (!gap || typeof gap !== 'object' || typeof gap.id !== 'string' || !gap.id.trim()) {
      throw new Error('Every acceptance gap disposition must include a stable id.');
    }
    if (reviewById.has(gap.id)) throw new Error(`Acceptance gap ${gap.id} is duplicated.`);
    if (!['accepted', 'deferred', 'blocking'].includes(gap.disposition)) {
      throw new Error(`Acceptance gap ${gap.id} has an invalid disposition.`);
    }
    if (!validSha256(gap.evidence_sha256)) {
      throw new Error(`Acceptance gap ${gap.id} must include a SHA-256 review evidence reference.`);
    }
    const count = boundedCount(gap.count ?? 1);
    if (count === null || count < 1) throw new Error(`Acceptance gap ${gap.id} must have a positive count.`);
    reviewById.set(gap.id, {
      id: gap.id,
      category: typeof gap.category === 'string' && gap.category.trim() ? gap.category.trim().slice(0, 120) : 'operator_reported',
      coverage: typeof gap.coverage === 'string' && ['partial', 'unsupported'].includes(gap.coverage)
        ? gap.coverage
        : 'partial',
      disposition: gap.disposition,
      evidence_sha256: String(gap.evidence_sha256).toLowerCase(),
      count,
    });
  }
  for (const gap of provisionalGaps) {
    if (!reviewById.has(gap.id)) {
      throw new Error(`Acceptance gap ${gap.id} remains unreviewed.`);
    }
  }
  const normalizedGaps = Array.from(reviewById.values());
  const blocking = normalizedGaps.filter((gap) => gap.disposition === 'blocking');
  if (blocking.length > 0) {
    throw new Error(`Acceptance cannot pass while ${blocking.length} capability gap(s) are blocking.`);
  }

  return {
    schemaVersion: review.schema_version,
    owner: review.owner.trim().slice(0, 200),
    reviewedAt: new Date(reviewedAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    stages: normalizedStages,
    gaps: normalizedGaps,
  };
}

export function finalizeMigrationEngineLiveAcceptance({
  provisionalEvidence,
  review,
  provisionalSha256,
  reviewSha256,
  finalizedAt = new Date().toISOString(),
  now = new Date(),
}) {
  if (provisionalEvidence?.schema_version !== LIVE_ACCEPTANCE_SCHEMA_VERSION
    || provisionalEvidence?.evidence_status !== 'provisional'
    || provisionalEvidence?.outcome !== 'incomplete'
    || provisionalEvidence?.input?.evidence_origin !== 'live_source') {
    throw new Error('Only provisional live-source acceptance evidence can be finalized.');
  }
  if (!validSha256(provisionalSha256) || !validSha256(reviewSha256)) {
    throw new Error('Finalization requires SHA-256 checksums for provisional evidence and its review.');
  }
  const validatedReview = validateMigrationEngineAcceptanceReview({
    review,
    source: provisionalEvidence.source,
    provisionalEvidence,
    provisionalSha256,
    now,
  });
  if (provisionalEvidence?.omnikit?.worktree_dirty !== false
    || !/^[a-f0-9]{40}$/i.test(String(provisionalEvidence?.omnikit?.commit_sha || ''))) {
    throw new Error('Final acceptance requires a clean OmniKit commit SHA.');
  }
  return {
    ...provisionalEvidence,
    evidence_status: 'final',
    outcome: 'passed',
    finalized_at: finalizedAt,
    expires_at: validatedReview.expiresAt,
    owner: validatedReview.owner,
    review: {
      schema_version: validatedReview.schemaVersion,
      reviewed_at: validatedReview.reviewedAt,
      evidence_sha256: reviewSha256.toLowerCase(),
      provisional_evidence_sha256: provisionalSha256.toLowerCase(),
    },
    stages: {
      source_extraction: provisionalEvidence.stages.source_extraction,
      ...validatedReview.stages,
    },
    gaps: validatedReview.gaps,
  };
}

export function validateMigrationEngineLiveAcceptance({ evidence, source, manifest, now = new Date() }) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) throw new Error('Live acceptance evidence is not a JSON object.');
  const input = evidence.input && typeof evidence.input === 'object' ? evidence.input : {};
  const result = evidence.result && typeof evidence.result === 'object' ? evidence.result : {};
  const engine = evidence.engine && typeof evidence.engine === 'object' ? evidence.engine : {};
  const omnikit = evidence.omnikit && typeof evidence.omnikit === 'object' ? evidence.omnikit : {};
  if (evidence.schema_version !== LIVE_ACCEPTANCE_SCHEMA_VERSION
    || evidence.evidence_status !== 'final'
    || evidence.outcome !== 'passed'
    || evidence.source !== source
    || !['api', 'manual'].includes(evidence.mode)
    || input.evidence_origin !== 'live_source'
    || !validDate(evidence.recorded_at)
    || !validDate(evidence.finalized_at)
    || !validDate(evidence.expires_at)) {
    throw new Error(`${source} live acceptance evidence has an invalid schema, status, outcome, origin, source, mode, or timestamp.`);
  }
  if (Date.parse(evidence.expires_at) <= now.getTime()) {
    throw new Error(`${source} live acceptance evidence has expired.`);
  }
  if (manifest?.installedAt && Date.parse(evidence.recorded_at) < Date.parse(manifest.installedAt)) {
    throw new Error(`${source} live acceptance predates the installed first-party engine runtime.`);
  }
  if (engine.name !== manifest.engine
    || engine.version !== manifest.version
    || engine.revision !== manifest.sourceRevision
    || engine.result_schema_version !== manifest.resultSchemaVersion
    || !validSha256(engine.rulebook_sha256)) {
    throw new Error(`${source} live acceptance does not match the installed engine identity and result contract.`);
  }
  if (!/^[a-f0-9]{40}$/i.test(String(omnikit.commit_sha || '')) || omnikit.worktree_dirty !== false) {
    throw new Error(`${source} live acceptance does not identify a clean OmniKit release commit.`);
  }
  if (typeof evidence.owner !== 'string' || evidence.owner.trim().length < 2
    || !validSha256(evidence?.review?.evidence_sha256)
    || !validSha256(evidence?.review?.provisional_evidence_sha256)) {
    throw new Error(`${source} live acceptance is missing its named owner or review attestations.`);
  }
  if (!input.target_instance_ref_sha256
    || Number(input.connection_override_count || 0) < 0
    || (evidence.mode === 'manual' && Number(input.artifact_count || 0) < 1)
    || (evidence.mode === 'api' && Number(input.selected_dashboard_count || 0) < 1)) {
    throw new Error(`${source} live acceptance did not exercise a target instance and scoped source evidence.`);
  }
  if (Number(result.view_count || 0) < 1
    || Number(result.dashboard_count || 0) < 1
    || Number(result.connection_mapping_count || 0) < 1
    || Number(result.mapped_connection_count || 0) !== Number(result.connection_mapping_count || 0)) {
    throw new Error(`${source} live acceptance must extract semantic and dashboard evidence and map every discovered source connection.`);
  }
  for (const stage of MIGRATION_ENGINE_ACCEPTANCE_STAGES) {
    const stageResult = evidence?.stages?.[stage];
    if (stageResult?.status !== 'passed'
      || !validSha256(stageResult.evidence_sha256)
      || Number(stageResult.checked_count) < 1
      || Number(stageResult.failed_count) !== 0) {
      throw new Error(`${source} live acceptance stage ${stage} is incomplete or failing.`);
    }
  }
  const gaps = Array.isArray(evidence.gaps) ? evidence.gaps : [];
  if (gaps.some((gap) => !['accepted', 'deferred'].includes(gap?.disposition) || !validSha256(gap?.evidence_sha256))) {
    throw new Error(`${source} live acceptance has blocking or unreviewed capability gaps.`);
  }
  return {
    schemaVersion: evidence.schema_version,
    recordedAt: evidence.recorded_at,
    finalizedAt: evidence.finalized_at,
    expiresAt: evidence.expires_at,
    source,
    mode: evidence.mode,
    owner: evidence.owner,
    omnikitCommitSha: omnikit.commit_sha,
    viewCount: Number(result.view_count),
    dashboardCount: Number(result.dashboard_count),
    connectionMappingCount: Number(result.connection_mapping_count),
    stageCount: MIGRATION_ENGINE_ACCEPTANCE_STAGES.length,
    acceptedGapCount: gaps.filter((gap) => gap.disposition === 'accepted').length,
    deferredGapCount: gaps.filter((gap) => gap.disposition === 'deferred').length,
    engine: { name: engine.name, version: engine.version, revision: engine.revision, rulebookSha256: engine.rulebook_sha256 },
  };
}

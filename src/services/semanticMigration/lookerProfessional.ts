import { dashboardPlanReadiness } from './bundle';
import type {
  MigrationEngineBridgeResult,
  MigrationEngineControlPlaneCapabilities,
  MigrationEngineRolloutMode,
} from './engineBridge';
import type { MigrationDashboardBuildPlan, MigrationBiSourceTool } from './types';

export const LOOKER_PROFESSIONAL_V2_CONTRACT = 'looker-professional-v2' as const;

export type LookerProfessionalReadinessState =
  | 'not_applicable'
  | 'native_fallback'
  | 'shadow_preview'
  | 'primary_preview'
  | 'review_ready'
  | 'blocked';

export type LookerProfessionalReadinessCheckStatus = 'passed' | 'pending' | 'blocked';

export interface LookerProfessionalReadinessCheck {
  id: 'contract' | 'acquisition' | 'canonical_ir' | 'rulebook' | 'rollout' | 'dashboard_plans' | 'target_validation';
  label: string;
  status: LookerProfessionalReadinessCheckStatus;
  summary: string;
}

export interface LookerProfessionalReadiness {
  contractVersion: typeof LOOKER_PROFESSIONAL_V2_CONTRACT;
  releaseStage: 'preview';
  state: LookerProfessionalReadinessState;
  label: string;
  summary: string;
  authoritative: boolean;
  canProceed: boolean;
  checks: LookerProfessionalReadinessCheck[];
  blockers: string[];
  capabilityClaims: {
    semanticObjects: 'partial';
    dashboards: 'partial';
    filters: 'partial';
    layout: 'partial';
    permissions: 'unsupported';
    schedules: 'unsupported';
  };
  rollback: string;
}

const CAPABILITY_CLAIMS: LookerProfessionalReadiness['capabilityClaims'] = {
  semanticObjects: 'partial',
  dashboards: 'partial',
  filters: 'partial',
  layout: 'partial',
  permissions: 'unsupported',
  schedules: 'unsupported',
};

function check(
  id: LookerProfessionalReadinessCheck['id'],
  label: string,
  status: LookerProfessionalReadinessCheckStatus,
  summary: string,
): LookerProfessionalReadinessCheck {
  return { id, label, status, summary };
}

function configuredMode(controlPlane: MigrationEngineControlPlaneCapabilities | null | undefined): MigrationEngineRolloutMode {
  return controlPlane?.sourceModes.looker || 'off';
}

export function evaluateLookerProfessionalReadiness(input: {
  sourcePlatform?: MigrationBiSourceTool;
  sourceMode?: 'api' | 'manual';
  engineResult?: MigrationEngineBridgeResult | null;
  controlPlane?: MigrationEngineControlPlaneCapabilities | null;
  dashboardPlans?: MigrationDashboardBuildPlan[];
  preparationReady?: boolean;
  validationReady?: boolean;
}): LookerProfessionalReadiness {
  const rollback = 'Set the Looker migration engine to shadow or off; the OmniKit native parser remains the fallback.';
  const base = {
    contractVersion: LOOKER_PROFESSIONAL_V2_CONTRACT,
    releaseStage: 'preview' as const,
    capabilityClaims: { ...CAPABILITY_CLAIMS },
    rollback,
  };
  if (input.sourcePlatform !== 'looker') {
    return {
      ...base,
      state: 'not_applicable',
      label: 'Not applicable',
      summary: 'The Looker Professional V2 contract applies only to Looker migrations.',
      authoritative: false,
      canProceed: true,
      checks: [],
      blockers: [],
    };
  }

  const result = input.engineResult || null;
  const mode = configuredMode(input.controlPlane);
  const resultMode = result?.control_plane?.rollout_mode || mode;
  const promotion = input.controlPlane?.promotionGates.looker;
  const contractValid = Boolean(result && result.source === 'looker');
  const acquisition = result?.bundle.acquisition;
  const acquisitionValid = Boolean(result
    && result.mode === input.sourceMode
    && result.provenance.source_artifact_count > 0
    && result.provenance.source_artifacts.length === result.provenance.source_artifact_count
    && acquisition?.contract_version === 'looker.evidence.v1'
    && acquisition.mode === input.sourceMode
    && acquisition.saved_look_coverage !== 'blocked'
    && acquisition.dependency_closure_status === 'complete'
    && !acquisition.dependencies.some((item) => item.required && item.status === 'missing'));
  const irValid = Boolean(result && result.bundle.ir_version === '2' && result.provenance.ir_version === '2');
  const rulebookValid = Boolean(result
    && result.diagnostics.rulebook_version === 'v2'
    && result.model_suggestions.every((item) => item.rulebook_version === 'v2'));
  const primaryApproved = resultMode === 'primary'
    && mode === 'primary'
    && promotion?.approved === true;
  const planReadiness = input.dashboardPlans?.map((plan) => dashboardPlanReadiness(plan));
  const blockedPlans = planReadiness?.flatMap((item) => item.blockers) || [];
  const checks: LookerProfessionalReadinessCheck[] = [
    check(
      'contract',
      'Professional V2 contract',
      result ? (contractValid ? 'passed' : 'blocked') : 'pending',
      result
        ? contractValid ? 'The deterministic evidence identifies Looker and the trusted bridge schema.' : 'The deterministic result does not identify the Looker contract.'
        : 'No deterministic candidate is active; the native Looker parser remains available.',
    ),
    check(
      'acquisition',
      'Equivalent acquisition contract',
      result ? (acquisitionValid ? 'passed' : 'blocked') : 'pending',
      result
        ? acquisitionValid
          ? `${result.mode === 'api' ? 'Saved API' : 'Manual LookML'} evidence is count-attested, saved-Look complete, and dependency-closed.`
          : acquisition?.dependency_closure_status === 'blocked'
            ? acquisition.diagnostics.join(' ') || 'The selected Looker scope has unresolved required dependencies.'
            : acquisition?.saved_look_coverage === 'blocked'
              ? acquisition.diagnostics.join(' ') || 'A selected dashboard contains an unresolved saved Look query.'
              : 'The acquisition contract, mode, artifact count, or selected-scope dependency evidence is incomplete.'
        : 'Manual and API evidence continue through the native normalized contract.',
    ),
    check(
      'canonical_ir',
      'Canonical IR V2',
      result ? (irValid ? 'passed' : 'blocked') : 'pending',
      result
        ? irValid ? 'Semantic and dashboard evidence uses the canonical IR V2 contract.' : 'The candidate does not use canonical IR V2.'
        : 'Canonical V2 candidate evidence has not been produced.',
    ),
    check(
      'rulebook',
      'Looker rulebook V2',
      result ? (rulebookValid ? 'passed' : 'blocked') : 'pending',
      result
        ? rulebookValid ? 'Every generated suggestion is tied to the V2 deterministic rulebook.' : 'Rulebook identity is missing or inconsistent.'
        : 'The native fallback will keep review-required semantics visible.',
    ),
    check(
      'rollout',
      'Measured rollout gate',
      result
        ? resultMode === 'primary' ? (primaryApproved ? 'passed' : 'blocked') : 'pending'
        : 'pending',
      result
        ? primaryApproved
          ? `Primary evidence is approved after ${promotion?.observationCount || 0} measured observations.`
          : resultMode === 'shadow'
            ? `Shadow evidence is diagnostic only (${promotion?.observationCount || 0} measured observations); native parsing remains authoritative.`
            : resultMode === 'off'
              ? 'The deterministic path is off; native parsing remains authoritative.'
              : promotion?.reason || 'Primary evidence has not passed the promotion gate.'
        : 'The deterministic path is unavailable or off; native parsing remains authoritative.',
    ),
    check(
      'dashboard_plans',
      'Dashboard behavior outcomes',
      !input.dashboardPlans ? 'pending' : blockedPlans.length > 0 ? 'blocked' : 'passed',
      !input.dashboardPlans
        ? 'Dashboard plans will be checked after analysis.'
        : blockedPlans.length > 0
          ? blockedPlans.join(' ')
          : `All ${input.dashboardPlans.length} dashboard plan${input.dashboardPlans.length === 1 ? '' : 's'} account for their tile and filter-listener outcomes.`,
    ),
    check(
      'target_validation',
      'Target branch proof',
      input.validationReady === undefined
        ? input.preparationReady === false ? 'blocked' : 'pending'
        : input.validationReady ? 'passed' : 'blocked',
      input.validationReady === true
        ? 'Semantic, query, dashboard, governance, and selected reconciliation checks are ready for Omni review.'
        : input.validationReady === false
          ? 'Target validation is incomplete or contains an unresolved blocking check.'
          : input.preparationReady === false
            ? 'Migration preparation contains an unresolved blocking dependency.'
            : 'Target branch proof is collected after reviewed decisions are compiled.',
    ),
  ];
  const contractBlockers = checks
    .filter((item) => item.status === 'blocked')
    .map((item) => `${item.label}: ${item.summary}`);
  const deterministicContractValid = contractValid && acquisitionValid && irValid && rulebookValid;

  if (!result || !deterministicContractValid && resultMode !== 'primary') {
    return {
      ...base,
      state: 'native_fallback',
      label: 'Native fallback active',
      summary: result
        ? 'The deterministic candidate did not satisfy V2, so OmniKit keeps the normalized native Looker path authoritative.'
        : 'OmniKit is using its normalized native Looker path while the deterministic V2 path is unavailable or disabled.',
      authoritative: false,
      canProceed: true,
      checks,
      blockers: [],
    };
  }

  if (contractBlockers.length > 0) {
    return {
      ...base,
      state: 'blocked',
      label: 'Professional V2 blocked',
      summary: 'Resolve the failed contract or target validation checks before proceeding.',
      authoritative: primaryApproved,
      canProceed: false,
      checks,
      blockers: contractBlockers,
    };
  }

  if (input.validationReady === true && input.preparationReady === true && input.dashboardPlans) {
    return {
      ...base,
      state: 'review_ready',
      label: 'Ready for human review',
      summary: `${primaryApproved ? 'Approved primary' : 'Shadow'} evidence passed the current reviewed migration checks. Final approval remains in Omni.`,
      authoritative: primaryApproved,
      canProceed: true,
      checks,
      blockers: [],
    };
  }

  return {
    ...base,
    state: primaryApproved ? 'primary_preview' : 'shadow_preview',
    label: primaryApproved ? 'Approved primary path' : 'Shadow evaluation',
    summary: primaryApproved
      ? 'Measured promotion evidence permits the deterministic path, but Looker remains a Preview capability and every migration still requires review.'
      : 'The deterministic V2 result is comparison evidence only; the native normalized path remains authoritative.',
    authoritative: primaryApproved,
    canProceed: true,
    checks,
    blockers: [],
  };
}

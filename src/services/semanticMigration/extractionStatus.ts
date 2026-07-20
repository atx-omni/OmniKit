import type { MigrationEngineRolloutMode } from './engineBridge';
import type { MigrationBiSourceTool } from './types';

export type MigrationExtractionState =
  | 'awaiting_evidence'
  | 'checking'
  | 'analyzing'
  | 'managed_ready'
  | 'native_ready'
  | 'fallback'
  | 'unsupported';

export interface MigrationExtractionStatus {
  state: MigrationExtractionState;
  title: string;
  detail: string;
  badge: string;
  tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
  showManagedDetails: boolean;
}

export function migrationExtractionStatus(input: {
  sourcePlatform: MigrationBiSourceTool;
  sourceLabel: string;
  sourceMode: 'api' | 'manual';
  hasEvidence: boolean;
  nativeEvidenceReady: boolean;
  managedPathEligible: boolean;
  managedMode: MigrationEngineRolloutMode;
  engineStatus: 'idle' | 'checking' | 'analyzing' | 'ready' | 'fallback';
  engineName?: string;
  engineVersion?: string;
  engineError?: string;
}): MigrationExtractionStatus {
  if (!input.hasEvidence) {
    return {
      state: 'awaiting_evidence',
      title: 'Waiting for source evidence',
      detail: input.sourceMode === 'api'
        ? `Load a saved ${input.sourceLabel} API inventory to begin extraction.`
        : `Add ${input.sourceLabel} export files to begin local extraction.`,
      badge: 'Not started',
      tone: 'neutral',
      showManagedDetails: false,
    };
  }

  if (input.managedPathEligible && input.engineStatus === 'checking') {
    return {
      state: 'checking',
      title: 'Checking OmniKit extraction',
      detail: `OmniKit is checking the read-only ${input.sourceLabel} extraction path before it analyzes the evidence.`,
      badge: 'Checking',
      tone: 'info',
      showManagedDetails: false,
    };
  }

  if (input.managedPathEligible && input.engineStatus === 'analyzing') {
    return {
      state: 'analyzing',
      title: 'Extracting source evidence',
      detail: `OmniKit's first-party engine is analyzing ${input.sourceLabel} evidence locally. It cannot write to Omni.`,
      badge: input.managedMode === 'shadow' ? 'Shadow analysis' : 'Read-only analysis',
      tone: 'info',
      showManagedDetails: false,
    };
  }

  if (input.managedPathEligible && input.engineStatus === 'ready') {
    const engine = [input.engineName, input.engineVersion].filter(Boolean).join(' ');
    return {
      state: 'managed_ready',
      title: 'OmniKit extraction complete',
      detail: `${engine || 'The first-party engine'} normalized the source evidence${input.managedMode === 'shadow' ? ' for read-only comparison with OmniKit’s native parser' : ''}.`,
      badge: input.managedMode === 'shadow' ? 'Shadow · read-only' : 'Primary · read-only',
      tone: 'success',
      showManagedDetails: true,
    };
  }

  if (input.managedPathEligible && input.engineStatus === 'fallback') {
    return {
      state: 'fallback',
      title: input.nativeEvidenceReady ? 'Using the native parser' : 'OmniKit extraction needs attention',
      detail: input.nativeEvidenceReady
        ? `The first-party engine was unavailable, so OmniKit kept the confirmed ${input.sourceLabel} evidence from its native parser.`
        : input.engineError || `The first-party ${input.sourceLabel} extraction path could not complete.`,
      badge: input.nativeEvidenceReady ? 'Native fallback' : 'Needs attention',
      tone: input.nativeEvidenceReady ? 'warning' : 'danger',
      showManagedDetails: false,
    };
  }

  if (input.nativeEvidenceReady) {
    return {
      state: 'native_ready',
      title: 'Native parser complete',
      detail: `OmniKit normalized the ${input.sourceLabel} evidence with its source-specific parser. The first-party engine is not required for this path.`,
      badge: 'Native · read-only',
      tone: 'success',
      showManagedDetails: false,
    };
  }

  if (input.managedPathEligible) {
    return {
      state: 'checking',
      title: 'OmniKit extraction is ready to start',
      detail: `Confirm the ${input.sourceLabel} evidence so OmniKit can start first-party read-only extraction.`,
      badge: 'Awaiting confirmation',
      tone: 'neutral',
      showManagedDetails: false,
    };
  }

  return {
    state: 'unsupported',
    title: 'Evidence is not ready',
    detail: `OmniKit could not confirm a supported ${input.sourceLabel} extraction result. Review the uploaded files and parser guidance.`,
    badge: 'Needs attention',
    tone: 'danger',
    showManagedDetails: false,
  };
}

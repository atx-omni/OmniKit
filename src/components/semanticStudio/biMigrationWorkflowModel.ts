import type { LucideIcon } from 'lucide-react';
import {
  Database,
  FileSearch,
  GitBranch,
  ListChecks,
  Network,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';

export type BiMigrationWorkflowStepId = 'source' | 'evidence' | 'destination' | 'analyze' | 'resolve' | 'validate' | 'build';

export type BiMigrationWorkflowProgress = {
  highestAvailableStep: BiMigrationWorkflowStepId;
  completedSteps: BiMigrationWorkflowStepId[];
  readinessMessage: string;
  currentStepBlockers: string[];
};

export type BiMigrationWorkflowReadinessInput = {
  activeStep: BiMigrationWorkflowStepId;
  ready: Record<BiMigrationWorkflowStepId, boolean>;
  blockers: Partial<Record<BiMigrationWorkflowStepId, string[]>>;
};

type WorkflowStep = {
  id: BiMigrationWorkflowStepId;
  label: string;
  description: string;
  icon: LucideIcon;
};

export const BI_MIGRATION_WORKFLOW_STEPS: WorkflowStep[] = [
  { id: 'source', label: 'Source', description: 'Choose how OmniKit receives content from your current BI platform.', icon: Database },
  { id: 'evidence', label: 'Evidence', description: 'Load source exports or API inventory and confirm what OmniKit detected.', icon: FileSearch },
  { id: 'destination', label: 'Destination', description: 'Choose the Omni model and confirm the source-to-target connection route.', icon: GitBranch },
  { id: 'analyze', label: 'Analyze', description: 'Scope dashboards and dependencies, then ask the selected AI engine to propose a migration plan.', icon: Sparkles },
  { id: 'resolve', label: 'Resolve', description: 'Review every semantic, governance, and visual decision before code is generated.', icon: Network },
  { id: 'validate', label: 'Validate', description: 'Stage reviewed semantic YAML on a dev branch and inspect validation evidence.', icon: ShieldCheck },
  { id: 'build', label: 'Build', description: 'Construct dashboards one at a time and reconcile the final migration outcome.', icon: ListChecks },
];

export function workflowStepIndex(stepId: BiMigrationWorkflowStepId) {
  return BI_MIGRATION_WORKFLOW_STEPS.findIndex((step) => step.id === stepId);
}

export function deriveBiMigrationWorkflowProgress(
  input: BiMigrationWorkflowReadinessInput,
): BiMigrationWorkflowProgress {
  const completedSteps: BiMigrationWorkflowStepId[] = [];
  let prerequisitesReady = true;
  let highestAvailableStep = BI_MIGRATION_WORKFLOW_STEPS[0]!.id;

  for (const step of BI_MIGRATION_WORKFLOW_STEPS) {
    if (prerequisitesReady) highestAvailableStep = step.id;
    if (prerequisitesReady && input.ready[step.id]) {
      completedSteps.push(step.id);
      continue;
    }
    prerequisitesReady = false;
  }

  const activeReady = input.ready[input.activeStep];
  const currentStepBlockers = activeReady ? [] : input.blockers[input.activeStep] || [];
  const readinessMessage = activeReady
    ? `${BI_MIGRATION_WORKFLOW_STEPS[workflowStepIndex(input.activeStep)]?.label || 'Step'} ready`
    : currentStepBlockers[0] || 'Complete the required choices to continue';

  return {
    highestAvailableStep,
    completedSteps,
    readinessMessage,
    currentStepBlockers,
  };
}

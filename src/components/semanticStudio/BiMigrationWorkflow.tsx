import { Link } from 'react-router-dom';
import {
  ArrowRight,
  Check,
  ShieldCheck,
} from 'lucide-react';
import {
  BI_MIGRATION_WORKFLOW_STEPS,
  workflowStepIndex,
  type BiMigrationWorkflowProgress,
  type BiMigrationWorkflowStepId,
} from './biMigrationWorkflowModel';

export function BiMigrationWorkflowHeader({
  activeStep,
  progress,
  onStepChange,
}: {
  activeStep: BiMigrationWorkflowStepId;
  progress: BiMigrationWorkflowProgress;
  onStepChange: (step: BiMigrationWorkflowStepId) => void;
}) {
  const activeIndex = workflowStepIndex(activeStep);
  const highestAvailableIndex = workflowStepIndex(progress.highestAvailableStep);
  const activeDefinition = BI_MIGRATION_WORKFLOW_STEPS[activeIndex] || BI_MIGRATION_WORKFLOW_STEPS[0];
  const ActiveIcon = activeDefinition.icon;

  return (
    <section className="sticky top-0 z-20 overflow-hidden rounded-card border border-border bg-white/95 shadow-sm backdrop-blur" aria-label="BI migration workflow">
      <nav className="overflow-x-auto" aria-label="Migration steps">
        <ol className="grid min-w-[840px] grid-cols-7 border-b border-border">
          {BI_MIGRATION_WORKFLOW_STEPS.map((step, index) => {
            const completed = progress.completedSteps.includes(step.id);
            const active = step.id === activeStep;
            const available = index <= highestAvailableIndex;
            return (
              <li key={step.id} className="relative min-w-0">
                <button
                  type="button"
                  aria-current={active ? 'step' : undefined}
                  disabled={!available}
                  onClick={() => onStepChange(step.id)}
                  className={`flex h-16 w-full items-center gap-2 border-r border-border px-3 text-left transition-colors last:border-r-0 ${active ? 'bg-omni-50 text-omni-800' : available ? 'bg-white text-content-primary hover:bg-surface-secondary' : 'cursor-not-allowed bg-surface-secondary text-content-tertiary'}`}
                >
                  <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-bold ${active ? 'border-omni-500 bg-omni-600 text-white' : completed ? 'border-green-200 bg-green-50 text-green-700' : 'border-border bg-white text-content-secondary'}`}>
                    {completed ? <Check size={14} /> : index + 1}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-semibold">{step.label}</span>
                    <span className="mt-0.5 block truncate text-[10px] text-content-tertiary">{active ? 'Current step' : completed ? 'Complete' : available ? 'Ready' : 'Not ready'}</span>
                  </span>
                </button>
                {index < BI_MIGRATION_WORKFLOW_STEPS.length - 1 && <ArrowRight size={12} className="pointer-events-none absolute -right-1.5 top-[26px] z-10 text-content-tertiary" />}
              </li>
            );
          })}
        </ol>
      </nav>

      <div className="flex flex-col gap-3 px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-content-primary">
            <ActiveIcon size={15} className="text-omni-700" />
            {activeDefinition.label}
          </div>
          <p className="mt-1 text-sm text-content-secondary">{activeDefinition.description}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <span className="rounded-chip border border-border bg-surface-secondary px-2.5 py-1 text-xs font-medium text-content-secondary">{progress.readinessMessage}</span>
          <details className="relative">
            <summary className="btn-secondary cursor-pointer list-none text-xs">How it works</summary>
            <div className="absolute right-0 top-10 z-30 w-[min(420px,calc(100vw-3rem))] rounded-card border border-border bg-white p-4 shadow-xl">
              <h2 className="text-sm font-semibold text-content-primary">A governed migration, one boundary at a time</h2>
              <p className="mt-1 text-xs leading-relaxed text-content-secondary">OmniKit inventories the selected source, scopes dependencies, asks AI for typed proposals, requires human decisions, validates semantic code on a dev branch, and builds dashboards only after review.</p>
              <ol className="mt-3 space-y-2">
                {BI_MIGRATION_WORKFLOW_STEPS.map((step, index) => (
                  <li key={step.id} className="flex gap-2 text-xs text-content-secondary"><span className="font-semibold text-content-primary">{index + 1}.</span><span><strong className="text-content-primary">{step.label}:</strong> {step.description}</span></li>
                ))}
              </ol>
            </div>
          </details>
          <details className="relative">
            <summary className="btn-secondary cursor-pointer list-none text-xs">Security</summary>
            <div className="absolute right-0 top-10 z-30 w-[min(420px,calc(100vw-3rem))] rounded-card border border-border bg-white p-4 shadow-xl">
              <div className="flex items-center gap-2 text-sm font-semibold text-content-primary"><ShieldCheck size={15} className="text-green-700" /> People approve every write</div>
              <ul className="mt-3 space-y-2 text-xs leading-relaxed text-content-secondary">
                <li><strong className="text-content-primary">Encrypted credentials:</strong> source, provider, and Omni credentials remain in the local native vault.</li>
                <li><strong className="text-content-primary">Scoped AI evidence:</strong> only bounded evidence required for the selected task is sent to the chosen provider.</li>
                <li><strong className="text-content-primary">No direct LLM writes:</strong> OmniKit compiles reviewed intent and stages changes on a dev branch.</li>
                <li><strong className="text-content-primary">Visible proof gaps:</strong> unsupported or unrun checks stay open until validated or explicitly waived.</li>
              </ul>
              <Link to="/data-privacy" className="mt-3 inline-flex text-xs font-semibold text-omni-700 hover:text-omni-800">Review data and privacy controls</Link>
            </div>
          </details>
        </div>
      </div>
    </section>
  );
}

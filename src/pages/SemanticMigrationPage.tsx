import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, CheckCircle2, FileSearch, GitBranch, ListChecks, LockKeyhole, Network, ShieldCheck } from 'lucide-react';
import { Blobby } from '@/components/ui/Blobby';
import { PageHeader } from '@/components/layout/PageHeader';
import { SemanticMigrationImportPanel } from '@/components/semanticStudio/SemanticMigrationImportPanel';
import { MigrationStudioControlPlane } from '@/components/semanticStudio/MigrationStudioControlPlane';
import { useConnection } from '@/contexts/ConnectionContext';
import type { SourceInventory } from '@/services/semanticMigration/studioApi';
import type { MigrationBiSourceTool } from '@/services/semanticMigration/types';

const MIGRATION_STEPS = [
  { label: 'Connect', detail: 'Choose the previous BI platform, a vault-backed AI option, and the destination Omni instance.', icon: LockKeyhole },
  { label: 'Inventory', detail: 'Load a searchable dashboard catalog plus ownership, usage, freshness, lineage, permissions, and schedules.', icon: FileSearch },
  { label: 'Scope', detail: 'Select dashboards, inspect their dependency closure, then migrate, consolidate, redesign, defer, or retire included assets.', icon: ListChecks },
  { label: 'Resolve', detail: 'Review evidence and explicitly map, create, rewrite, ignore, or defer every blocking difference.', icon: Network },
  { label: 'Build', detail: 'Compile approved decisions and dashboard specifications into one deterministic, versioned migration bundle.', icon: GitBranch },
  { label: 'Validate', detail: 'Stage semantic YAML on a dev branch, validate it, and require explicit branch-readiness confirmation.', icon: ShieldCheck },
  { label: 'Review', detail: 'Build dashboards one at a time through Omni AI, retry failures independently, and export reconciliation.', icon: CheckCircle2 },
];

function MigrationWorkflowExplanation() {
  return (
    <section className="overflow-hidden rounded-card border border-border bg-white" aria-labelledby="migration-workflow-title">
      <div className="flex flex-col gap-3 border-b border-border bg-surface-secondary px-4 py-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 id="migration-workflow-title" className="text-base font-semibold text-content-primary">How the migration works</h2>
          <p className="mt-1 max-w-4xl text-sm text-content-secondary">OmniKit separates dashboard discovery, dependency review, AI-assisted decisions, semantic validation, and dashboard construction so users can see and approve each boundary before Omni changes.</p>
        </div>
        <span className="inline-flex w-fit items-center gap-2 rounded-chip border border-green-200 bg-green-50 px-3 py-1.5 text-xs font-semibold text-green-800">
          <ShieldCheck size={14} /> AI proposes; people approve
        </span>
      </div>

      <ol className="grid grid-cols-1 divide-y divide-border md:grid-cols-2 md:divide-y-0 lg:grid-cols-7 lg:divide-x">
        {MIGRATION_STEPS.map((step, index) => {
          const Icon = step.icon;
          return (
            <li key={step.label} className="relative min-w-0 px-4 py-4">
              <div className="flex items-center gap-2">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-omni-50 text-xs font-bold text-omni-700">{index + 1}</span>
                <Icon size={15} className="shrink-0 text-content-secondary" />
                <span className="text-sm font-semibold text-content-primary">{step.label}</span>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-content-secondary">{step.detail}</p>
              {index < MIGRATION_STEPS.length - 1 && <ArrowRight size={14} className="absolute -right-2 top-5 z-10 hidden text-content-tertiary lg:block" />}
            </li>
          );
        })}
      </ol>

      <div className="grid gap-px border-t border-border bg-border md:grid-cols-2 xl:grid-cols-4">
        <div className="bg-blue-50 px-4 py-3">
          <div className="text-xs font-semibold text-blue-900">Credentials stay encrypted</div>
          <p className="mt-1 text-xs leading-relaxed text-blue-800">Source, AI-provider, and Omni credentials live in the native encrypted vault and are hydrated by the local server, not returned to the browser.</p>
        </div>
        <div className="bg-blue-50 px-4 py-3">
          <div className="text-xs font-semibold text-blue-900">AI access is scoped</div>
          <p className="mt-1 text-xs leading-relaxed text-blue-800">Source content is treated as untrusted data. Only the evidence needed for the selected task is sent to the chosen provider, subject to HTTPS, host allowlists, limits, and redaction.</p>
        </div>
        <div className="bg-blue-50 px-4 py-3">
          <div className="text-xs font-semibold text-blue-900">No direct LLM writes</div>
          <p className="mt-1 text-xs leading-relaxed text-blue-800">The AI option can propose mappings or code, but OmniKit compiles reviewed intent and uses checksums and dev branches before final approval in Omni.</p>
        </div>
        <div className="bg-blue-50 px-4 py-3">
          <div className="text-xs font-semibold text-blue-900">Missing proof stays visible</div>
          <p className="mt-1 text-xs leading-relaxed text-blue-800">Unsupported or unrun query, visual, security, and operational checks never silently pass. They remain open until validated or explicitly waived.</p>
        </div>
      </div>
      <div className="flex flex-col gap-2 border-t border-border px-4 py-3 text-xs text-content-secondary sm:flex-row sm:items-center sm:justify-between">
        <span>Raw source files and AI responses remain in page or encrypted transient memory by default; sanitized job history excludes prompts, artifacts, generated YAML, and credentials.</span>
        <Link to="/data-privacy" className="shrink-0 font-semibold text-omni-700 hover:text-omni-800">Review data and privacy controls</Link>
      </div>
    </section>
  );
}

export function SemanticMigrationPage() {
  const { connection } = useConnection();
  const [providerId, setProviderId] = useState('');
  const [sourceMode, setSourceMode] = useState<'api' | 'manual'>('manual');
  const [manualSourcePlatform, setManualSourcePlatform] = useState<MigrationBiSourceTool>('power_bi');
  const [sourceConnectionId, setSourceConnectionId] = useState('');
  const [sourceInventory, setSourceInventory] = useState<SourceInventory | null>(null);

  return (
    <div className="space-y-5">
      <PageHeader
        title="BI Migration Studio"
        description="Select source dashboards, resolve their semantic dependencies with an approved AI option, review one versioned Omni branch, then build and reconcile each dashboard safely."
        icon={<Blobby mood="semantic" size={58} className="animate-float" style={{ animationDuration: '3.4s' }} />}
      />
      <MigrationWorkflowExplanation />
      <MigrationStudioControlPlane
        targetInstanceId={connection.instanceId}
        targetInstanceLabel={connection.instanceLabel}
        selectedProviderId={providerId}
        sourceMode={sourceMode}
        manualSourcePlatform={manualSourcePlatform}
        selectedSourceConnectionId={sourceConnectionId}
        onProviderChange={setProviderId}
        onSourceModeChange={setSourceMode}
        onSourceConnectionChange={setSourceConnectionId}
        onInventoryLoaded={setSourceInventory}
      />
      <SemanticMigrationImportPanel
        providerId={providerId}
        sourceInventory={sourceInventory}
        sourceMode={sourceMode}
        manualSourcePlatform={manualSourcePlatform}
        sourceConnectionId={sourceConnectionId}
        onManualSourcePlatformChange={setManualSourcePlatform}
      />
    </div>
  );
}

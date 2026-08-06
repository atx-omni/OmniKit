import { lazy, Suspense, useState } from 'react';
import { Blobby } from '@/components/ui/Blobby';
import { PageHeader } from '@/components/layout/PageHeader';
import { MigrationStudioControlPlane } from '@/components/semanticStudio/MigrationStudioControlPlane';
import {
  BiMigrationWorkflowHeader,
} from '@/components/semanticStudio/BiMigrationWorkflow';
import {
  type BiMigrationWorkflowProgress,
  type BiMigrationWorkflowStepId,
} from '@/components/semanticStudio/biMigrationWorkflowModel';
import { useConnection } from '@/hooks/useConnection';
import type { SourceInventory } from '@/services/semanticMigration/studioApi';
import type { MigrationBiSourceTool } from '@/services/semanticMigration/types';

const SemanticMigrationImportPanel = lazy(() =>
  import('@/components/semanticStudio/SemanticMigrationImportPanel').then((module) => ({
    default: module.SemanticMigrationImportPanel,
  })),
);

export function SemanticMigrationPage() {
  const { connection } = useConnection();
  const [providerId, setProviderId] = useState('');
  const [sourceMode, setSourceMode] = useState<'api' | 'manual'>('api');
  const [manualSourcePlatform, setManualSourcePlatform] = useState<MigrationBiSourceTool>('domo');
  const [sourceConnectionId, setSourceConnectionId] = useState('');
  const [sourceInventory, setSourceInventory] = useState<SourceInventory | null>(null);
  const [activeStep, setActiveStep] = useState<BiMigrationWorkflowStepId>('source');
  const [workflowProgress, setWorkflowProgress] = useState<BiMigrationWorkflowProgress>({
    highestAvailableStep: 'source',
    completedSteps: [],
    readinessMessage: 'Choose a source to begin',
    currentStepBlockers: ['Choose a source to begin.'],
  });

  return (
    <div className="space-y-5">
      <PageHeader
        title="BI Migration Studio"
        description="Select source dashboards, place each dependency upstream or in Omni, resolve reviewed changes, then validate, build, and reconcile every route safely."
        icon={<Blobby mood="semantic" size={58} className="animate-float" style={{ animationDuration: '3.4s' }} />}
      />
      <BiMigrationWorkflowHeader activeStep={activeStep} progress={workflowProgress} onStepChange={setActiveStep} />
      {activeStep === 'source' && (
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
      )}
      <Suspense
        fallback={(
          <div className="flex min-h-32 items-center justify-center rounded-card border border-border bg-surface text-sm text-content-secondary" role="status">
            Loading migration workspace...
          </div>
        )}
      >
        <SemanticMigrationImportPanel
          providerId={providerId}
          sourceInventory={sourceInventory}
          sourceMode={sourceMode}
          manualSourcePlatform={manualSourcePlatform}
          sourceConnectionId={sourceConnectionId}
          onManualSourcePlatformChange={setManualSourcePlatform}
          activeStep={activeStep}
          onStepChange={setActiveStep}
          onWorkflowProgressChange={setWorkflowProgress}
        />
      </Suspense>
    </div>
  );
}

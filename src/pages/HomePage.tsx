import { ConnectPage } from '@/pages/ConnectPage';
import { PortfolioOverviewPage } from '@/pages/PortfolioOverviewPage';
import { useConnection } from '@/hooks/useConnection';
import { useVaultSession } from '@/hooks/useVaultSession';
import { hasActiveSavedVaultConnection } from '@/services/connectionGuards';

function HomeLoadingState() {
  return (
    <div className="flex min-h-full flex-1 items-start justify-center py-6" aria-busy="true" aria-label="Loading saved connection">
      <div className="mx-auto w-full max-w-[1560px] px-3 sm:px-6 2xl:max-w-[1680px]">
        <div className="border-y border-border bg-white px-4 py-8">
          <div className="h-5 w-44 max-w-full rounded bg-gray-200" />
          <div className="mt-3 h-3 w-72 max-w-full rounded bg-gray-100" />
        </div>
      </div>
    </div>
  );
}

export function HomePage() {
  const { connection } = useConnection();
  const { status, instances, loading } = useVaultSession();

  if (loading || status === 'unknown') return <HomeLoadingState />;

  const activeSavedConnection = hasActiveSavedVaultConnection(connection)
    && status === 'unlocked'
    && instances.some((instance) => instance.id === connection.instanceId);

  if (!activeSavedConnection) return <ConnectPage />;

  return (
    <div className="flex min-h-full flex-1 items-start justify-center py-5 sm:py-6">
      <div className="mx-auto w-full max-w-[1560px] min-w-0 px-3 sm:px-6 2xl:max-w-[1680px]">
        <PortfolioOverviewPage />
      </div>
    </div>
  );
}

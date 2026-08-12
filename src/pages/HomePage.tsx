import { ConnectPage } from '@/pages/ConnectPage';
import { PortfolioOverviewPage } from '@/pages/PortfolioOverviewPage';
import { useVaultSession } from '@/hooks/useVaultSession';

function HomeLoadingState() {
  return (
    <div className="relative flex min-h-full flex-1 items-start justify-center bg-surface-secondary/45 py-6" aria-busy="true">
      <div className="absolute inset-x-0 top-0 h-1 bg-brand-pink" aria-hidden="true" />
      <div className="mx-auto w-full max-w-[1560px] px-3 sm:px-6 2xl:max-w-[1680px]">
        <div className="border-y border-border bg-surface-primary px-4 py-8" role="status" aria-label="Loading saved connection">
          <div className="h-5 w-44 max-w-full rounded-[4px] bg-surface-tertiary motion-safe:animate-pulse" />
          <div className="mt-3 h-3 w-72 max-w-full rounded-[4px] bg-surface-secondary motion-safe:animate-pulse" />
          <span className="sr-only">Loading saved connection</span>
        </div>
      </div>
    </div>
  );
}

export function HomePage() {
  const { status, instances, loading } = useVaultSession();

  if (loading || status === 'unknown') return <HomeLoadingState />;

  if (status !== 'unlocked' || instances.length === 0) return <ConnectPage />;

  return (
    <div className="relative flex min-h-full flex-1 items-start justify-center bg-surface-secondary/45 py-5 sm:py-6">
      <div className="absolute inset-x-0 top-0 h-1 bg-brand-pink" aria-hidden="true" />
      <div className="mx-auto w-full max-w-[1560px] min-w-0 px-3 pt-1 sm:px-6 2xl:max-w-[1680px]">
        <PortfolioOverviewPage />
      </div>
    </div>
  );
}

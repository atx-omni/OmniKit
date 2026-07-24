import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { ConnectionProvider } from '@/contexts/ConnectionContext';
import { OperationLogProvider } from '@/contexts/OperationLogContext';
import { Sidebar } from '@/components/layout/Sidebar';
import { RequireConnection } from '@/components/layout/RequireConnection';
import { ToastContainer } from '@/components/ui/Toast';
import { OmniKitWalkthrough } from '@/components/walkthrough/OmniKitWalkthrough';
import { usePreloadBlobby } from '@/components/ui/blobbyAssets';
import { WalkthroughProvider } from '@/contexts/WalkthroughContext';
import { ConnectPage } from '@/pages/ConnectPage';
import { VaultSessionProvider } from '@/hooks/useVaultSession';

const MigratePage = lazy(() => import('@/pages/MigratePage').then((module) => ({ default: module.MigratePage })));
const UserManagementPage = lazy(() => import('@/pages/UserManagementPage').then((module) => ({ default: module.UserManagementPage })));
const ModelsPage = lazy(() => import('@/pages/ModelsPage').then((module) => ({ default: module.ModelsPage })));
const TopicsPage = lazy(() => import('@/pages/TopicsPage').then((module) => ({ default: module.TopicsPage })));
const EmbedsPage = lazy(() => import('@/pages/EmbedsPage').then((module) => ({ default: module.EmbedsPage })));
const HistoryPage = lazy(() => import('@/pages/HistoryPage').then((module) => ({ default: module.HistoryPage })));
const DownloadsPage = lazy(() => import('@/pages/DownloadsPage').then((module) => ({ default: module.DownloadsPage })));
const ConnectionsPage = lazy(() => import('@/pages/ConnectionsPage').then((module) => ({ default: module.ConnectionsPage })));
const SchedulesPage = lazy(() => import('@/pages/SchedulesPage').then((module) => ({ default: module.SchedulesPage })));
const LabelsPage = lazy(() => import('@/pages/LabelsPage').then((module) => ({ default: module.LabelsPage })));
const UploadsPage = lazy(() => import('@/pages/UploadsPage').then((module) => ({ default: module.UploadsPage })));
const DataPrivacyPage = lazy(() => import('@/pages/DataPrivacyPage').then((module) => ({ default: module.DataPrivacyPage })));
const DashboardOperationsPage = lazy(() => import('@/pages/DashboardOperationsPage').then((module) => ({ default: module.DashboardOperationsPage })));
const ContentHealthPage = lazy(() => import('@/pages/ContentHealthPage').then((module) => ({ default: module.ContentHealthPage })));
const AIDashboardStudioPage = lazy(() => import('@/pages/AIDashboardStudioPage').then((module) => ({ default: module.AIDashboardStudioPage })));
const InstancesPage = lazy(() => import('@/pages/InstancesPage').then((module) => ({ default: module.InstancesPage })));

const ModelMigratorPage = lazy(() => (
  import('@/pages/ModelMigratorPage').then((module) => ({ default: module.ModelMigratorPage }))
));

const DeckBuilderPage = lazy(() => (
  import('@/pages/DeckBuilderPage').then((module) => ({ default: module.DeckBuilderPage }))
));

const SemanticMigrationPage = lazy(() => (
  import('@/pages/SemanticMigrationPage').then((module) => ({ default: module.SemanticMigrationPage }))
));

function LazyPageFallback() {
  return (
    <div className="card flex items-center justify-center p-8 text-sm text-content-secondary">
      Loading workflow
    </div>
  );
}

function PaddedLayout() {
  return (
    <div className="flex-1 min-h-full flex items-start justify-center py-6">
      <div className="w-full max-w-[1560px] 2xl:max-w-[1680px] px-4 sm:px-6 my-auto">
        <Outlet />
      </div>
    </div>
  );
}

function AppLayout() {
  return (
    <div className="flex h-screen overflow-hidden bg-surface-secondary">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[100] focus:bg-omni-700 focus:text-white focus:px-4 focus:py-2 focus:rounded-button focus:shadow-dropdown"
      >
        Skip to main content
      </a>
      <Sidebar />
      <main id="main-content" className="flex-1 min-w-0 min-h-0 flex flex-col overflow-y-auto" tabIndex={-1}>
        <Suspense fallback={<LazyPageFallback />}>
          <Routes>
          <Route path="/" element={<ConnectPage />} />
          <Route path="/connect" element={<Navigate to="/" replace />} />
          <Route element={<PaddedLayout />}>
            <Route path="/dashboards/migrate" element={<RequireConnection><MigratePage /></RequireConnection>} />
            <Route
              path="/models/migrate"
              element={(
                <RequireConnection>
                  <Suspense fallback={<LazyPageFallback />}>
                    <ModelMigratorPage />
                  </Suspense>
                </RequireConnection>
              )}
            />
            <Route
              path="/dashboards/ai-studio"
              element={<RequireConnection><AIDashboardStudioPage /></RequireConnection>}
            />
            <Route
              path="/dashboards/operations"
              element={<RequireConnection><DashboardOperationsPage /></RequireConnection>}
            />
            <Route
              path="/dashboards/bulk-move"
              element={<Navigate to="/dashboards/operations" replace />}
            />
            <Route
              path="/dashboards/bulk-copy"
              element={<Navigate to="/dashboards/operations" replace />}
            />
            <Route
              path="/dashboards/bulk-delete"
              element={<Navigate to="/dashboards/operations" replace />}
            />
            <Route
              path="/dashboards/downloads"
              element={<RequireConnection><DownloadsPage /></RequireConnection>}
            />
            <Route
              path="/deck-builder"
              element={(
                <RequireConnection>
                  <Suspense fallback={<LazyPageFallback />}>
                    <DeckBuilderPage />
                  </Suspense>
                </RequireConnection>
              )}
            />
            <Route
              path="/connections"
              element={<RequireConnection><ConnectionsPage /></RequireConnection>}
            />
            <Route path="/instances" element={<InstancesPage />} />
            <Route
              path="/uploads"
              element={<RequireConnection><UploadsPage /></RequireConnection>}
            />
            <Route
              path="/users"
              element={<RequireConnection><UserManagementPage /></RequireConnection>}
            />
            <Route
              path="/groups"
              element={<Navigate to="/users?tab=groups" replace />}
            />
            <Route
              path="/models"
              element={<RequireConnection><ModelsPage /></RequireConnection>}
            />
            <Route
              path="/topics"
              element={<RequireConnection><TopicsPage /></RequireConnection>}
            />
            <Route
              path="/semantic-migrations"
              element={(
                <RequireConnection>
                  <Suspense fallback={<LazyPageFallback />}>
                    <SemanticMigrationPage />
                  </Suspense>
                </RequireConnection>
              )}
            />
            <Route
              path="/labels"
              element={<RequireConnection><LabelsPage /></RequireConnection>}
            />
            <Route
              path="/content-health"
              element={<RequireConnection><ContentHealthPage /></RequireConnection>}
            />
            <Route
              path="/schedules"
              element={<RequireConnection><SchedulesPage /></RequireConnection>}
            />
            <Route
              path="/embeds"
              element={<RequireConnection><EmbedsPage /></RequireConnection>}
            />
            <Route path="/history" element={<HistoryPage />} />
            <Route path="/data-privacy" element={<DataPrivacyPage />} />
          </Route>
          </Routes>
        </Suspense>
      </main>
      <OmniKitWalkthrough />
      <ToastContainer />
    </div>
  );
}

function App() {
  usePreloadBlobby();
  return (
    <BrowserRouter>
      <ConnectionProvider>
        <VaultSessionProvider>
          <OperationLogProvider>
            <WalkthroughProvider>
              <AppLayout />
            </WalkthroughProvider>
          </OperationLogProvider>
        </VaultSessionProvider>
      </ConnectionProvider>
    </BrowserRouter>
  );
}

export default App;

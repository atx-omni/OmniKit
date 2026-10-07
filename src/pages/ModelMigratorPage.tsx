import { Link, Navigate, useLocation } from 'react-router';
import { TopicMigrationWizard } from '@/components/modelMigration/TopicMigrationWizard';
import { dashboardDeploymentModelMigratorHandoffFromSearch, parseDashboardDeploymentModelMigratorHandoff } from '@/services/modelMigratorHandoff';

/** One entry point: reviewed additions on a branch, never publication. */
export function ModelMigratorPage() {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const handoff = dashboardDeploymentModelMigratorHandoffFromSearch(location.search)
    || parseDashboardDeploymentModelMigratorHandoff(location.state);
  if (params.has('view')) {
    params.delete('view');
    return <Navigate replace to={{ pathname: '/models/migrate', search: params.toString() }} state={location.state} />;
  }
  const source = location.state && typeof location.state === 'object' ? location.state.source : undefined;
  if (!handoff && (params.has('planId') || params.has('targetId') || source === 'dashboard_deployment_plan' || source === 'dashboard_safe_copy_v1')) {
    return <section className="card space-y-3 p-5" role="alert"><h1 className="text-lg font-semibold">Recheck the dashboard plan</h1>
      <p>This older or incomplete handoff cannot authorize model changes. Return to Dashboard Migrator and review current dependencies.</p>
      <Link className="btn-primary inline-block" to="/dashboards/migrate">Return to dashboard migration</Link></section>;
  }
  return <TopicMigrationWizard key={handoff ? `${handoff.planId}:${handoff.targetId}` : 'topics'} dashboardHandoff={handoff || undefined} />;
}

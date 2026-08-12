import { ArrowLeft } from 'lucide-react';
import { Link, Outlet, useLocation } from 'react-router';
import {
  ADMIN_WORKSPACE_BY_ID,
  ADMIN_WORKSPACES,
  adminWorkspaceHref,
  fleetCommandCenterHref,
  identityWorkspaceTabHref,
  type AdminWorkspaceId,
  type AdminWorkspaceNavigationItem,
} from '@/routes/adminRoutes';

function normalizedIdentityNavigationId(search: string): string {
  const tab = new URLSearchParams(search).get('tab');
  return tab === 'groups' || tab === 'import' || tab === 'health' ? tab : 'users';
}

function isNavigationItemActive(
  workspaceId: AdminWorkspaceId,
  item: AdminWorkspaceNavigationItem,
  pathname: string,
  search: string,
  basePath: string,
  defaultPath: string,
): boolean {
  const effectivePath = pathname === basePath ? defaultPath : pathname;
  if (workspaceId === 'identity') {
    return effectivePath === item.path && normalizedIdentityNavigationId(search) === item.id;
  }
  return effectivePath === item.path;
}

function workspaceLinkClassName(active: boolean): string {
  return `inline-flex min-h-11 shrink-0 items-center whitespace-nowrap border-b-2 px-3 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-omni-500 ${
    active
      ? 'border-omni-600 text-omni-800'
      : 'border-transparent text-content-secondary hover:border-border-strong hover:text-content-primary'
  }`;
}

function pageLinkClassName(active: boolean): string {
  return `inline-flex min-h-11 shrink-0 items-center whitespace-nowrap rounded-button px-3 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-omni-500 ${
    active
      ? 'bg-omni-700 text-white'
      : 'text-content-secondary hover:bg-surface-secondary hover:text-content-primary'
  }`;
}

export function AdminWorkspaceLayout({ workspaceId }: { workspaceId: AdminWorkspaceId }) {
  const location = useLocation();
  const workspace = ADMIN_WORKSPACE_BY_ID[workspaceId];

  return (
    <div
      className="min-w-0 space-y-5"
      data-testid="admin-workspace-shell"
      data-admin-workspace={workspaceId}
    >
      <div
        className="card min-w-0 max-w-full overflow-hidden p-0"
        aria-label={`${workspace.label} administration workspace`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3 sm:px-5">
          <p className="min-w-0 text-sm text-content-secondary">
            <span className="font-medium">Administration</span>
            <span className="px-1.5 text-content-tertiary" aria-hidden="true">/</span>
            <span className="font-semibold text-content-primary">{workspace.label}</span>
          </p>
          <Link
            to={fleetCommandCenterHref(location.search)}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-button px-3 py-2 text-sm font-semibold text-omni-700 transition-colors hover:bg-omni-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-omni-500"
          >
            <ArrowLeft size={15} aria-hidden="true" />
            Back to Fleet
          </Link>
        </div>

        <nav
          aria-label="Administration workspaces"
          className="min-w-0 max-w-full overflow-x-auto overscroll-x-contain border-b border-border px-2 sm:px-3"
        >
          <div className="flex min-w-max gap-1">
            {ADMIN_WORKSPACES.map((candidate) => {
              const active = candidate.id === workspaceId;
              return (
                <Link
                  key={candidate.id}
                  to={adminWorkspaceHref(candidate.basePath, location.search)}
                  aria-current={active ? 'page' : undefined}
                  className={workspaceLinkClassName(active)}
                >
                  {candidate.label}
                </Link>
              );
            })}
          </div>
        </nav>

        <nav
          aria-label={`${workspace.label} pages`}
          className="min-w-0 max-w-full overflow-x-auto overscroll-x-contain px-2 py-2 sm:px-3"
        >
          <div className="flex min-w-max gap-1">
            {workspace.navigation.map((item) => {
              const active = isNavigationItemActive(
                workspaceId,
                item,
                location.pathname,
                location.search,
                workspace.basePath,
                workspace.defaultPath,
              );
              const href = workspaceId === 'identity'
                ? identityWorkspaceTabHref(item.path, location.search, location.hash, item.tab)
                : adminWorkspaceHref(item.path, location.search);
              return (
                <Link
                  key={item.id}
                  to={href}
                  aria-current={active ? 'page' : undefined}
                  className={pageLinkClassName(active)}
                >
                  {item.label}
                </Link>
              );
            })}
          </div>
        </nav>
      </div>

      <Outlet />
    </div>
  );
}

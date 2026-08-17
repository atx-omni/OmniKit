export type DashboardMigrationFeatureFlagEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * Safe-copy is the normal dashboard migration backend. The explicit `false`
 * value is retained as an operational kill switch without making an absent
 * deployment variable silently hide the supported workflow.
 */
export function isDashboardSafeCopyV1Enabled(
  environment: DashboardMigrationFeatureFlagEnvironment = process.env,
): boolean {
  return environment.OMNIKIT_SAFE_COPY_V1_INTERNAL !== 'false';
}

/**
 * The legacy Dashboard Migrator remains available only as an intentionally
 * enabled internal rollback surface.
 */
export function isLegacyDashboardMigratorInternalEnabled(
  environment: DashboardMigrationFeatureFlagEnvironment = process.env,
): boolean {
  return environment.OMNIKIT_LEGACY_DASHBOARD_MIGRATOR_INTERNAL === 'true';
}

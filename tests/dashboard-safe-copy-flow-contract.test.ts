import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const flowSource = readFileSync(
  new URL('../src/components/dashboardMigration/DashboardSafeCopyFlow.tsx', import.meta.url),
  'utf8',
);
const pageSource = readFileSync(new URL('../src/pages/MigratePage.tsx', import.meta.url), 'utf8');

test('safe-copy is the default experience and legacy Dashboard Migrator is a lazy internal rollback', () => {
  assert.match(pageSource, /VITE_OMNIKIT_SAFE_COPY_V1_INTERNAL\s*!==\s*'false'/);
  assert.match(pageSource, /VITE_OMNIKIT_LEGACY_DASHBOARD_MIGRATOR_INTERNAL\s*===\s*'true'/);
  assert.match(pageSource, /const LegacyDashboardMigrationWizard\s*=\s*lazy\(/);
  assert.match(pageSource, /legacyRollbackEnabled\s*\?\s*\(/);
  assert.match(pageSource, /<LegacyDashboardMigrationWizard\s*\/>/);
  assert.match(pageSource, /:\s*safeCopyEnabled\s*\?\s*<DashboardSafeCopyFlow\s*\/>\s*:/);
  assert.match(pageSource, /Dashboard migration is temporarily unavailable/);
  assert.match(pageSource, /Safe-copy has been disabled by the local operator/);
  assert.doesNotMatch(pageSource, /import\s*\{\s*DashboardMigrationWizard\s*\}/);
});

test('the default safe-copy experience exposes exactly three accessible screens', () => {
  assert.match(
    flowSource,
    /STEP_LABELS\s*=\s*\['Choose dashboards',\s*'Choose destinations',\s*'Move & track'\]\s+as const/,
  );
  assert.equal((flowSource.match(/draft\.step === [012]/g) || []).length, 3);
  assert.match(flowSource, /aria-label="Dashboard move steps"/);
  assert.match(flowSource, /aria-current=\{draft\.step === step \? 'step' : undefined\}/);
  assert.match(flowSource, /headingRef\.current\?\.focus\(\)/);
  assert.equal((flowSource.match(/ref=\{headingRef\}\s+tabIndex=\{-1\}/g) || []).length, 3);
});

test('the safe-copy flow does not expose legacy destructive or expert controls', () => {
  for (const forbiddenAssignment of [
    /\bemptyFirst\s*:/,
    /\breplaceSameNamed\s*:/,
    /\bdeleteSourceOnSuccess\s*:/,
    /\bpostMigrationActions\s*:/,
    /\bsemanticPatches\s*:/,
    /\bacceptedYaml\s*:/,
    /\bqueryValidationWaivers\s*:/,
  ]) {
    assert.doesNotMatch(flowSource, forbiddenAssignment);
  }
  for (const forbiddenControl of [
    /Advanced/i,
    /Dependency decisions/i,
    /Edit YAML/i,
    /Cleanup source/i,
    /Delete source/i,
    /Replace same-name/i,
    /Waive validation/i,
  ]) {
    assert.doesNotMatch(flowSource, forbiddenControl);
  }
});

test('the default UI can submit only the safe-copy contract and never calls legacy migration surfaces', () => {
  assert.match(flowSource, /\bcreateDashboardSafeCopyJob\b/);
  assert.match(flowSource, /\bretryDashboardSafeCopyTarget\b/);
  for (const legacyCall of [
    /\bcreateMigrationJob\b/,
    /\bpreviewDashboardMigrationJob\b/,
    /\bvalidateDashboardMigrationPatches\b/,
    /\brunPostMigrationActions\b/,
    /\bretryMigrationJob\b/,
  ]) {
    assert.doesNotMatch(flowSource, legacyCall);
  }
});

test('large inventories are progressively disclosed and asynchronous scope work is abortable', () => {
  assert.match(flowSource, /DASHBOARD_PAGE_SIZE\s*=\s*100/);
  assert.match(flowSource, /filteredDocuments\.slice\(0, visibleDashboardCount\)/);
  assert.match(flowSource, /visibleDocuments\.map\(/);
  assert.match(flowSource, /visibleDocuments\.length < filteredDocuments\.length/);
  assert.match(flowSource, /Show \{Math\.min\(DASHBOARD_PAGE_SIZE/);

  assert.match(flowSource, /sourceConnectionAbortRef/);
  assert.match(flowSource, /dashboardAbortRef/);
  assert.match(flowSource, /destinationAbortRef/);
  assert.match(flowSource, /new AbortController\(\)/);
  assert.match(flowSource, /sourceConnectionAbortRef\.current\?\.abort\(\)/);
  assert.match(flowSource, /dashboardAbortRef\.current\?\.abort\(\)/);
  assert.match(flowSource, /Object\.(?:values|entries)\(destinationAbortRef\.current\).*controller\.abort\(\)/s);
});

test('active source, submit idempotency, target retry guard, and reduced motion have explicit seams', () => {
  assert.match(flowSource, /useConnection\(\)/);
  assert.match(flowSource, /connection\.instanceId/);
  assert.match(flowSource, /submitGuardRef\.current/);
  assert.match(flowSource, /retryGuardRef\.current/);
  assert.doesNotMatch(flowSource, /className="animate-spin"/);
  assert.ok((flowSource.match(/motion-safe:animate-spin/g) || []).length >= 1);
});

test('restored job evidence is bound to the stored job and request identities before rendering', () => {
  assert.match(flowSource, /isDashboardSafeCopyJobForRequest\(next,\s*draft\.requestId/);
  assert.match(flowSource, /next\.id\s*!==\s*jobId/);
  assert.match(flowSource, /status\s*===\s*404/);
  assert.match(flowSource, /reject_restored_job/);
});

test('exception codes are available only in collapsed technical details', () => {
  const detailsIndex = flowSource.indexOf('<details');
  const summaryIndex = flowSource.indexOf('Technical details', detailsIndex);
  const codeIndex = flowSource.indexOf("target.exceptionCodes.join", detailsIndex);
  assert.ok(detailsIndex >= 0, 'Expected a collapsed details disclosure.');
  assert.ok(summaryIndex > detailsIndex, 'Expected a Technical details summary.');
  assert.ok(codeIndex > summaryIndex, 'Expected exception codes inside Technical details.');
  assert.equal(flowSource.indexOf('target.exceptionCodes.join'), codeIndex, 'Exception codes must not be rendered elsewhere.');
});

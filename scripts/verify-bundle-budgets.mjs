import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const FRONTEND_PERFORMANCE_BUDGET_SCHEMA_VERSION = 'omnikit.frontend-performance-budgets.v1';

function walkFiles(root, prefix = '') {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = join(root, entry.name);
    return entry.isDirectory() ? walkFiles(absolute, relative) : [{ relative, absolute, bytes: statSync(absolute).size }];
  });
}

export function evaluateBundleBudgets({ distRoot, manifest, budgets }) {
  if (budgets?.schemaVersion !== FRONTEND_PERFORMANCE_BUDGET_SCHEMA_VERSION) {
    throw new Error('Frontend performance budget schema is invalid.');
  }
  const files = walkFiles(distRoot);
  const byRelative = new Map(files.map((file) => [file.relative, file]));
  const manifestEntries = Object.entries(manifest || {});
  const entryFiles = manifestEntries.filter(([, entry]) => entry?.isEntry).map(([, entry]) => byRelative.get(entry.file)).filter(Boolean);
  const routeEntries = manifestEntries.filter(([key]) => key.startsWith('src/pages/'));
  const routeFiles = routeEntries.map(([, entry]) => byRelative.get(entry.file)).filter(Boolean);
  const javascriptFiles = files.filter((file) => file.relative.endsWith('.js'));
  const stylesheetFiles = files.filter((file) => file.relative.endsWith('.css'));
  const requiredRoutes = budgets.requiredDynamicRoutes || [];
  const missingDynamicRoutes = requiredRoutes.filter((route) => {
    const entry = manifest?.[route];
    return !entry || entry.isDynamicEntry !== true || entry.isEntry === true;
  });
  const checks = {
    entryBudget: entryFiles.length > 0 && entryFiles.every((file) => file.bytes <= budgets.maximumEntryBytes),
    routeBudget: routeFiles.length > 0 && routeFiles.every((file) => file.bytes <= budgets.maximumRouteChunkBytes),
    chunkBudget: javascriptFiles.every((file) => file.bytes <= budgets.maximumJavaScriptChunkBytes),
    totalJavaScriptBudget: javascriptFiles.reduce((total, file) => total + file.bytes, 0) <= budgets.maximumTotalJavaScriptBytes,
    stylesheetBudget: stylesheetFiles.every((file) => file.bytes <= budgets.maximumStylesheetBytes),
    requiredRoutesAreDynamic: missingDynamicRoutes.length === 0,
  };
  return {
    schemaVersion: 'omnikit.frontend-performance-report.v1',
    generatedAt: new Date().toISOString(),
    budgets,
    checks,
    passed: Object.values(checks).every(Boolean),
    missingDynamicRoutes,
    summary: {
      maximumEntryBytes: Math.max(0, ...entryFiles.map((file) => file.bytes)),
      maximumRouteChunkBytes: Math.max(0, ...routeFiles.map((file) => file.bytes)),
      maximumJavaScriptChunkBytes: Math.max(0, ...javascriptFiles.map((file) => file.bytes)),
      totalJavaScriptBytes: javascriptFiles.reduce((total, file) => total + file.bytes, 0),
      maximumStylesheetBytes: Math.max(0, ...stylesheetFiles.map((file) => file.bytes)),
      dynamicRouteCount: routeEntries.filter(([, entry]) => entry?.isDynamicEntry === true).length,
    },
    violations: [
      ...entryFiles.filter((file) => file.bytes > budgets.maximumEntryBytes).map((file) => `${file.relative} exceeds the entry budget.`),
      ...routeFiles.filter((file) => file.bytes > budgets.maximumRouteChunkBytes).map((file) => `${file.relative} exceeds the route budget.`),
      ...javascriptFiles.filter((file) => file.bytes > budgets.maximumJavaScriptChunkBytes).map((file) => `${file.relative} exceeds the JavaScript chunk budget.`),
      ...stylesheetFiles.filter((file) => file.bytes > budgets.maximumStylesheetBytes).map((file) => `${file.relative} exceeds the stylesheet budget.`),
      ...missingDynamicRoutes.map((route) => `${route} is not emitted as a dynamic route.`),
    ],
  };
}

function run() {
  const distRoot = resolve(process.env.OMNIKIT_DIST_ROOT || 'dist');
  const manifest = JSON.parse(readFileSync(resolve(distRoot, '.vite/manifest.json'), 'utf8'));
  const budgets = JSON.parse(readFileSync(resolve(process.env.OMNIKIT_FRONTEND_BUDGET_PATH || 'config/frontend-performance-budgets.json'), 'utf8'));
  const report = evaluateBundleBudgets({ distRoot, manifest, budgets });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}

if (process.argv[1]?.endsWith('verify-bundle-budgets.mjs')) {
  try { run(); } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : error}\n`); process.exitCode = 1; }
}

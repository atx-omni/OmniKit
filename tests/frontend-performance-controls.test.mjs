import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import { evaluateBundleBudgets } from '../scripts/verify-bundle-budgets.mjs';

test('bundle budgets require route splitting and enforce measured byte limits', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'omnikit-bundle-budget-test-'));
  try {
    mkdirSync(resolve(root, 'assets'), { recursive: true });
    writeFileSync(resolve(root, 'assets/index.js'), 'x'.repeat(100));
    writeFileSync(resolve(root, 'assets/MigratePage.js'), 'x'.repeat(200));
    writeFileSync(resolve(root, 'assets/index.css'), 'x'.repeat(50));
    const manifest = {
      'index.html': { file: 'assets/index.js', isEntry: true },
      'src/pages/MigratePage.tsx': { file: 'assets/MigratePage.js', isDynamicEntry: true },
    };
    const budgets = {
      schemaVersion: 'omnikit.frontend-performance-budgets.v1',
      maximumEntryBytes: 150,
      maximumRouteChunkBytes: 250,
      maximumJavaScriptChunkBytes: 250,
      maximumTotalJavaScriptBytes: 350,
      maximumStylesheetBytes: 75,
      requiredDynamicRoutes: ['src/pages/MigratePage.tsx'],
    };
    assert.equal(evaluateBundleBudgets({ distRoot: root, manifest, budgets }).passed, true);
    const facadeManifest = {
      'index.html': {
        file: 'assets/index.js',
        isEntry: true,
        dynamicImports: ['_MigratePage.js'],
      },
      '_MigratePage.js': {
        file: 'assets/MigratePage.js',
        name: 'MigratePage',
        isDynamicEntry: true,
      },
    };
    assert.equal(evaluateBundleBudgets({ distRoot: root, manifest: facadeManifest, budgets }).passed, true);
    const failed = evaluateBundleBudgets({
      distRoot: root,
      manifest: { ...manifest, 'src/pages/MigratePage.tsx': { file: 'assets/MigratePage.js', isEntry: true } },
      budgets,
    });
    assert.equal(failed.passed, false);
    assert.deepEqual(failed.missingDynamicRoutes, ['src/pages/MigratePage.tsx']);

    // Every failing check must explain itself. A breached budget that reports
    // `violations: []` is indistinguishable from a broken gate.
    const overTotal = evaluateBundleBudgets({
      distRoot: root,
      manifest,
      budgets: { ...budgets, maximumTotalJavaScriptBytes: 250 },
    });
    assert.equal(overTotal.passed, false);
    assert.equal(overTotal.checks.totalJavaScriptBudget, false);
    assert.equal(overTotal.summary.totalJavaScriptBytes, 300);
    assert.ok(
      overTotal.violations.some((violation) => violation.includes('Total JavaScript')),
      'a breached total-JavaScript budget must appear in violations',
    );
    for (const [name, passed] of Object.entries(overTotal.checks)) {
      if (!passed) continue;
      assert.ok(
        !overTotal.violations.some((violation) => violation.includes(name)),
        `${name} passed and must not be reported as a violation`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

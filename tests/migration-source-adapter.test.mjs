import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, test } from 'node:test';

import { createMigrationSourceAdapter } from '../scripts/create-migration-source-adapter.mjs';
import { verifyMigrationSourceConformance } from '../scripts/verify-migration-source-conformance.mjs';

let tempRoot = '';

afterEach(() => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = '';
});

test('generated migration source adapters start fail-closed and contain no credentials', () => {
  tempRoot = mkdtempSync(resolve(tmpdir(), 'omnikit-source-adapter-'));
  mkdirSync(resolve(tempRoot, 'config'), { recursive: true });
  mkdirSync(resolve(tempRoot, 'contracts'), { recursive: true });
  cpSync(resolve('config/migration-source-adapters.json'), resolve(tempRoot, 'config/migration-source-adapters.json'));
  cpSync(resolve('contracts/migration-source-rulebook.v1.json'), resolve(tempRoot, 'contracts/migration-source-rulebook.v1.json'));
  const result = createMigrationSourceAdapter({ source: 'example_bi', label: 'Example BI', root: tempRoot });
  assert.equal(result.lifecycle, 'unsupported');
  const registry = JSON.parse(readFileSync(resolve(tempRoot, 'config/migration-source-adapters.json'), 'utf8'));
  const source = registry.sources.find((item) => item.id === 'example_bi');
  assert.equal(source.lifecycle, 'unsupported');
  assert.equal(source.releaseStage, 'development');
  assert.equal(source.certification, 'none');
  assert.deepEqual(source.acquisition, { api: false, manual: false });
  assert.equal(source.controlPlaneOwner, 'unassigned');
  const parser = readFileSync(resolve(tempRoot, result.parserPath), 'utf8');
  assert.match(parser, /unsupported until fixture conformance, security review, ownership approval, and live acceptance/i);
  assert.doesNotMatch(JSON.stringify({ source, parser }), /api.?key|credential|access.?token|private.?key/i);
});

test('consolidated source adapters are owned by tracked OmniKit implementations', () => {
  const result = verifyMigrationSourceConformance();
  const expected = {
    looker: ['manual_lookml', 'api_inventory', 'explores', 'dashboards'],
    metabase: ['manual_api_snapshot', 'api_inventory', 'mbql', 'dashboards'],
    power_bi: ['pbip', 'pbir', 'tmdl', 'model_bim', 'workspace_scanner', 'direct_pbix'],
    sigma: ['manual_api_snapshot', 'api_inventory', 'formula_normalization', 'workbooks'],
    tableau: ['twb', 'twbx', 'tds', 'tdsx', 'dashboards'],
  };
  Object.entries(expected).forEach(([source, capabilities]) => {
    const report = result.sources.find((item) => item.source === source);
    assert.ok(report, `${source} is missing from the conformance report`);
    assert.match(report.extractionOwner, /^omnikit_(?:engine|hybrid)$/);
    capabilities.forEach((capability) => assert.ok(report.certifiedCapabilities.includes(capability), `${source} is missing ${capability}`));
  });
  result.sources.forEach((source) => assert.equal(source.releaseStage, 'preview'));
});

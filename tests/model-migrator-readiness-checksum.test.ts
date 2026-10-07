import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';

import modelMigratorHandler from '../server/handlers/model-migrator';
import { clearModelMigratorCatalogCache } from '../server/services/modelMigratorCatalog';
import { lockVault, resetVault, unlockVault, upsertInstance } from '../server/services/nativeVault';
import { OmniClient } from '../server/services/omniClient';

let temporaryRoot = '';
let previousVaultPath: string | undefined;

beforeEach(() => {
  clearModelMigratorCatalogCache();
  temporaryRoot = mkdtempSync(path.join(tmpdir(), 'omnikit-reviewed-model-'));
  previousVaultPath = process.env.OMNIKIT_VAULT_PATH;
  process.env.OMNIKIT_VAULT_PATH = path.join(temporaryRoot, 'vault.enc');
  unlockVault('isolated model review test');
  upsertInstance({
    id: 'example-instance',
    label: 'Example instance',
    role: 'both',
    baseUrl: 'https://example.omniapp.co',
    apiKey: 'example-test-credential',
    metricFilter: {
      connectionDatabaseContains: [], connectionDatabaseExact: [],
      embedExternalIdContains: [], embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
  mock.method(globalThis, 'fetch', async () => {
    throw new Error('Unexpected outbound request: this test must use mocked Omni reads only.');
  });
});

afterEach(() => {
  clearModelMigratorCatalogCache();
  mock.restoreAll();
  resetVault();
  lockVault();
  rmSync(temporaryRoot, { recursive: true, force: true });
  if (previousVaultPath === undefined) delete process.env.OMNIKIT_VAULT_PATH;
  else process.env.OMNIKIT_VAULT_PATH = previousVaultPath;
});

function post(operation: string, body: Record<string, unknown>) {
  return modelMigratorHandler(new Request(`http://localhost/api/model-migrator/${operation}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

test('branch retirement preview endpoints do not read authored YAML or return checksum fallbacks', async () => {
  const yaml = mock.method(OmniClient.prototype, 'getModelYaml', async () => {
    throw new Error('Retired routes must never read source or destination YAML.');
  });
  const catalog = mock.method(OmniClient.prototype, 'listConnections', async () => {
    throw new Error('Retired routes must never read tenant catalogs.');
  });
  for (const operation of ['readiness', 'translate', 'preflight', 'jobs', 'jobs/old-job/publish', 'jobs/old-job/merge']) {
    const response = await post(operation, {
      sourceInstanceId: 'example-instance', targetInstanceId: 'example-instance',
      modelId: 'source-model', targetModelId: 'target-model', runAi: true,
      acceptedFiles: [{ fileName: 'example.view', yaml: 'sql: SELECT 1', previousChecksum: 'untrusted-checksum' }],
    });
    const body = await response.json();
    assert.equal(response.status, 410);
    assert.equal(body.code, 'MODEL_MIGRATOR_BRANCH_REVIEW_ONLY');
    assert.equal(body.files, undefined);
    assert.equal(body.checksums, undefined);
    assert.match(body.error, /review branch/i);
  }
  assert.equal(yaml.mock.callCount(), 0);
  assert.equal(catalog.mock.callCount(), 0);
});

test('branch retirement rejects malformed bodies without parsing them and keeps the vault boundary', async () => {
  const req = new Request('http://localhost/api/model-migrator/translate', { method: 'POST', body: '{not-json' });
  const parse = mock.method(req, 'json', async () => { throw new Error('Retired input must not be parsed.'); });
  assert.equal((await modelMigratorHandler(req)).status, 410);
  assert.equal(parse.mock.callCount(), 0);
  lockVault();
  assert.equal((await post('translate', {})).status, 423);
});

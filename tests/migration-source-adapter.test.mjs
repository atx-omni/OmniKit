import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, test } from 'node:test';

import { createMigrationSourceAdapter } from '../scripts/create-migration-source-adapter.mjs';

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
  assert.equal(source.certification, 'none');
  assert.deepEqual(source.acquisition, { api: false, manual: false });
  assert.equal(source.controlPlaneOwner, 'unassigned');
  const parser = readFileSync(resolve(tempRoot, result.parserPath), 'utf8');
  assert.match(parser, /unsupported until fixture conformance, security review, ownership approval, and live acceptance/i);
  assert.doesNotMatch(JSON.stringify({ source, parser }), /api.?key|credential|access.?token|private.?key/i);
});

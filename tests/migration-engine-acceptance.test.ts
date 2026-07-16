import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  buildLiveAcceptanceConfig,
  buildLiveAcceptanceRequest,
  buildSanitizedAcceptanceEvidence,
  loadLiveAcceptanceArtifacts,
  localControlPlaneOrigin,
  parseLiveAcceptanceArgs,
} from '../scripts/accept-migration-engine-live.mjs';

test('live acceptance only targets the local OmniKit control plane', () => {
  assert.equal(localControlPlaneOrigin('http://127.0.0.1:5176/path'), 'http://127.0.0.1:5176');
  assert.equal(localControlPlaneOrigin('http://localhost:5173'), 'http://localhost:5173');
  assert.throws(() => localControlPlaneOrigin('https://example.com'), /only send source evidence to a local OmniKit origin/);
  assert.throws(() => localControlPlaneOrigin('http://user:pass@localhost:5173'), /must not contain credentials/);
});

test('live acceptance rejects plaintext credential flags', () => {
  assert.throws(
    () => parseLiveAcceptanceArgs(['--source', 'looker', '--client-secret', 'never-store-this']),
    /Plaintext credential flags are not accepted/,
  );
});

test('API acceptance uses a vault reference and selected dashboard scope', () => {
  const config = buildLiveAcceptanceConfig(parseLiveAcceptanceArgs([
    '--source', 'looker',
    '--url', 'http://127.0.0.1:5176',
    '--connection-id', 'saved-looker-profile',
    '--target-instance-id', 'target-omni-profile',
    '--dashboard-id', '42',
    '--project-id', 'commerce',
  ]));
  const request = buildLiveAcceptanceRequest(config);
  assert.equal(request.connectionId, 'saved-looker-profile');
  assert.equal(request.targetInstanceId, 'target-omni-profile');
  assert.deepEqual(request.scope, { selected_dashboard_ids: ['42'], project_ids: ['commerce'] });
  assert.equal(JSON.stringify(request).includes('credential'), false);
  assert.equal(JSON.stringify(request).includes('secret'), false);
});

test('manual acceptance preserves binary bytes but evidence stores only hashes and counts', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'omnikit-live-acceptance-'));
  try {
    const artifactPath = resolve(root, 'customer-report.pbix');
    writeFileSync(artifactPath, Buffer.from([0, 1, 2, 3, 254, 255]));
    const config = buildLiveAcceptanceConfig(parseLiveAcceptanceArgs([
      '--source', 'powerbi',
      '--url', 'http://127.0.0.1:5176',
      '--target-instance-id', 'target-omni-profile',
      '--artifact', artifactPath,
    ]));
    const artifacts = loadLiveAcceptanceArtifacts(config.artifactPaths);
    const request = buildLiveAcceptanceRequest(config, artifacts);
    assert.equal(request.artifacts?.[0].contentBase64, 'AAECA/7/');

    const evidence = buildSanitizedAcceptanceEvidence({
      config,
      request,
      artifactEvidence: artifacts.map((item) => item.evidence),
      recordedAt: '2026-07-15T12:00:00.000Z',
      result: {
        schema_version: 'omnikit.migration.bundle.v1',
        source: 'powerbi',
        mode: 'manual',
        engine: { name: 'omni-migrator', version: '0.0.1', revision: 'abc123' },
        diagnostics: {
          view_count: 2, field_count: 8, topic_count: 1, dashboard_count: 1,
          untranslatable_count: 2, rulebook_version: 'v2', rulebook_sha256: 'a'.repeat(64),
          limitations: ['Complex DAX requires review.'],
        },
        control_plane: { rollout_mode: 'shadow', duration_ms: 25, queue_wait_ms: 1 },
        bundle: { dashboards: [{ source_id: 'customer-dashboard-id' }] },
        connection_mappings: [{ confidence: 'exact', target_connection_id: 'customer-connection-id', confirmed: true }],
        model_suggestions: [{ content: 'secret customer model YAML' }],
        capability_coverage: { semantic: 'full', dashboards: 'partial' },
      },
    });
    const serialized = JSON.stringify(evidence);
    assert.equal(serialized.includes('customer-report.pbix'), false);
    assert.equal(serialized.includes('customer-dashboard-id'), false);
    assert.equal(serialized.includes('customer-connection-id'), false);
    assert.equal(serialized.includes('secret customer model YAML'), false);
    assert.equal(serialized.includes('AAECA/7/'), false);
    assert.equal(evidence.result.dashboard_count, 1);
    assert.equal(evidence.result.mapping_confidence.exact, 1);
    assert.equal(evidence.input.artifact_fingerprints[0].size_bytes, 6);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

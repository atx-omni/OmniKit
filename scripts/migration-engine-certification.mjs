import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const MIGRATION_ENGINE_SOURCES = ['looker', 'powerbi', 'tableau', 'metabase', 'sigma'];

export const MIGRATION_ENGINE_PROMOTION_REQUIREMENTS = {
  looker: { semantic: 95, dashboards: 90, stableIdentity: 95, overall: 93, observations: 20 },
  powerbi: { semantic: 95, dashboards: 85, stableIdentity: 95, overall: 92, observations: 20 },
  tableau: { semantic: 92, dashboards: 85, stableIdentity: 95, overall: 90, observations: 25 },
  metabase: { semantic: 95, dashboards: 95, stableIdentity: 95, overall: 95, observations: 20 },
  sigma: { semantic: 90, dashboards: 80, stableIdentity: 95, overall: 88, observations: 25 },
};

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function validDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

export function validateMigrationEngineLiveAcceptance({ evidence, source, manifest }) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) throw new Error('Live acceptance evidence is not a JSON object.');
  const input = evidence.input && typeof evidence.input === 'object' ? evidence.input : {};
  const result = evidence.result && typeof evidence.result === 'object' ? evidence.result : {};
  const engine = evidence.engine && typeof evidence.engine === 'object' ? evidence.engine : {};
  if (evidence.schema_version !== 'omnikit.migration-engine-live-acceptance.v1'
    || evidence.outcome !== 'passed'
    || evidence.source !== source
    || !['api', 'manual'].includes(evidence.mode)
    || !validDate(evidence.recorded_at)) {
    throw new Error(`${source} live acceptance evidence has an invalid schema, outcome, source, mode, or timestamp.`);
  }
  if (manifest?.installedAt && Date.parse(evidence.recorded_at) < Date.parse(manifest.installedAt)) {
    throw new Error(`${source} live acceptance predates the installed managed engine runtime.`);
  }
  if (engine.name !== manifest.engine
    || engine.version !== manifest.version
    || engine.revision !== manifest.sourceRevision
    || engine.result_schema_version !== manifest.resultSchemaVersion
    || !/^[a-f0-9]{64}$/i.test(String(engine.rulebook_sha256 || ''))) {
    throw new Error(`${source} live acceptance does not match the installed engine identity and result contract.`);
  }
  if (!input.target_instance_ref_sha256
    || Number(input.connection_override_count || 0) < 0
    || (evidence.mode === 'manual' && Number(input.artifact_count || 0) < 1)
    || (evidence.mode === 'api' && Number(input.selected_dashboard_count || 0) < 1)) {
    throw new Error(`${source} live acceptance did not exercise a target instance and scoped source evidence.`);
  }
  if (Number(result.view_count || 0) < 1
    || Number(result.dashboard_count || 0) < 1
    || Number(result.connection_mapping_count || 0) < 1
    || Number(result.mapped_connection_count || 0) !== Number(result.connection_mapping_count || 0)) {
    throw new Error(`${source} live acceptance must extract semantic and dashboard evidence and map every discovered source connection.`);
  }
  return {
    schemaVersion: evidence.schema_version,
    recordedAt: evidence.recorded_at,
    source,
    mode: evidence.mode,
    viewCount: Number(result.view_count),
    dashboardCount: Number(result.dashboard_count),
    connectionMappingCount: Number(result.connection_mapping_count),
    engine: { name: engine.name, version: engine.version, revision: engine.revision, rulebookSha256: engine.rulebook_sha256 },
  };
}

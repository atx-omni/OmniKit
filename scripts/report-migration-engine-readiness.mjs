import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import {
  MIGRATION_ENGINE_PROMOTION_REQUIREMENTS,
  MIGRATION_ENGINE_SOURCES,
  sha256File,
  validateMigrationEngineLiveAcceptance,
} from './migration-engine-certification.mjs';

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || '').trim() : '';
}

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

export function buildMigrationEngineReadiness({ manifest, observations, promotions, acceptanceEntries }) {
  return MIGRATION_ENGINE_SOURCES.map((source) => {
    const requirement = MIGRATION_ENGINE_PROMOTION_REQUIREMENTS[source];
    const sourceObservations = Array.isArray(observations?.sources?.[source]) ? observations.sources[source] : [];
    const runtimeObservations = sourceObservations.filter((item) => item?.mode === 'shadow'
      && item.engineName === manifest?.engine
      && item.engineVersion === manifest?.version);
    const nativeObservations = runtimeObservations.filter((item) => item.observationType === 'native_parity' || (!item.observationType && item.baselineSource === 'server_native'));
    const operationalObservations = runtimeObservations.filter((item) => item.observationType === 'operational');
    const acceptance = acceptanceEntries.filter((item) => item.source === source).sort((left, right) => Date.parse(right.summary.recordedAt) - Date.parse(left.summary.recordedAt))[0];
    const promotion = promotions?.sources?.[source];
    const rolledBack = Boolean(promotion?.rolledBackAt);
    const primary = Boolean(promotion && !rolledBack && promotion.liveAcceptance?.evidenceSha256 && promotion.engine?.sourceRevision === manifest?.sourceRevision);
    const observationCount = nativeObservations.length >= requirement.observations ? nativeObservations.length : operationalObservations.length;
    const conformance = manifest?.conformance?.sources?.[source];
    const eligible = conformance?.passed === true && Boolean(acceptance) && observationCount >= requirement.observations;
    const state = rolledBack ? 'rolled_back' : primary ? 'primary' : eligible ? 'eligible' : 'shadow';
    const blockers = [
      conformance?.passed === true ? '' : 'Managed conformance has not passed.',
      acceptance ? '' : 'No passing live acceptance matches the installed runtime.',
      observationCount >= requirement.observations ? '' : `${requirement.observations - observationCount} additional shadow observations are required.`,
      primary || !eligible ? '' : 'Named approval and rollback drill are still required.',
      rolledBack ? `Rolled back: ${promotion.rollbackReason || 'operator decision'}.` : '',
    ].filter(Boolean);
    return {
      source,
      owner: source === 'powerbi' ? 'hybrid' : 'omni-migrator',
      state,
      observationCount,
      requiredObservationCount: requirement.observations,
      conformancePassed: conformance?.passed === true,
      liveAcceptance: acceptance ? { recordedAt: acceptance.summary.recordedAt, evidenceSha256: acceptance.sha256, file: acceptance.file } : null,
      blockers,
    };
  });
}

function run() {
  const manifestPath = resolve(process.env.OMNIKIT_MIGRATION_ENGINE_MANIFEST_PATH || 'data/migration-engine/manifest.json');
  const observationPath = resolve(process.env.OMNIKIT_MIGRATION_ENGINE_PARITY_PATH || 'data/migration-engine/parity-observations.json');
  const promotionPath = resolve(process.env.OMNIKIT_MIGRATION_ENGINE_PROMOTION_PATH || 'data/migration-engine/promotions.json');
  const acceptanceRoot = resolve(process.env.OMNIKIT_MIGRATION_ENGINE_ACCEPTANCE_ROOT || 'data/migration-engine/live-acceptance');
  const manifest = readJson(manifestPath, null);
  if (!manifest) throw new Error(`No managed engine manifest exists at ${manifestPath}.`);
  const acceptanceEntries = existsSync(acceptanceRoot) ? readdirSync(acceptanceRoot).filter((name) => name.endsWith('.json')).flatMap((name) => {
    const path = resolve(acceptanceRoot, name);
    try {
      const evidence = readJson(path, null);
      const summary = validateMigrationEngineLiveAcceptance({ evidence, source: evidence?.source, manifest });
      return [{ source: summary.source, summary, sha256: sha256File(path), file: basename(path) }];
    } catch { return []; }
  }) : [];
  const report = {
    schemaVersion: 'omnikit.migration-engine-readiness.v1',
    generatedAt: new Date().toISOString(),
    engine: { name: manifest.engine, version: manifest.version, sourceRevision: manifest.sourceRevision },
    sources: buildMigrationEngineReadiness({
      manifest,
      observations: readJson(observationPath, { sources: {} }),
      promotions: readJson(promotionPath, { sources: {} }),
      acceptanceEntries,
    }),
    nativeSources: [
      { source: 'dbt', owner: 'OmniKit', state: 'native', certification: 'conformance and live migration validation remain required' },
      { source: 'domo', owner: 'OmniKit', state: 'native', certification: 'conformance and live migration validation remain required' },
      { source: 'microstrategy', owner: 'OmniKit', state: 'native', certification: 'conformance and live migration validation remain required' },
      { source: 'webfocus', owner: 'OmniKit', state: 'native', certification: 'conformance and live migration validation remain required' },
    ],
  };
  const output = option('output');
  if (output) writeFileSync(resolve(output), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1]?.endsWith('report-migration-engine-readiness.mjs')) {
  try { run(); } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : error}\n`); process.exitCode = 1; }
}

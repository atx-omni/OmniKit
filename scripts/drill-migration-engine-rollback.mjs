import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { MIGRATION_ENGINE_SOURCES } from './migration-engine-certification.mjs';

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || '').trim() : '';
}

const source = option('source').toLowerCase().replace('power_bi', 'powerbi');
const operator = option('by').slice(0, 200);
const requestedId = option('id').slice(0, 120);
if (!MIGRATION_ENGINE_SOURCES.includes(source) || operator.length < 2) {
  throw new Error('Usage: npm run drill:rollback:migration-engine -- --source looker --by "Release Owner" [--id "drill-id"]');
}

const projectRoot = resolve('.');
const manifestPath = join(projectRoot, 'data', 'migration-engine', 'manifest.json');
const manifestBytes = readFileSync(manifestPath);
const manifest = JSON.parse(manifestBytes.toString('utf8'));
const temporaryRoot = mkdtempSync(join(tmpdir(), 'omnikit-rollback-drill-'));
const temporaryLedger = join(temporaryRoot, 'promotions.json');
const drillId = requestedId || `${source}-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
const drillLedgerPath = resolve(process.env.OMNIKIT_MIGRATION_ENGINE_ROLLBACK_DRILL_PATH
  || join(projectRoot, 'data', 'migration-engine', 'rollback-drills.json'));

try {
  writeFileSync(temporaryLedger, `${JSON.stringify({
    schemaVersion: 'omnikit.migration.engine-promotions.v1',
    sources: {
      [source]: {
        approvedBy: operator,
        approvedAt: new Date().toISOString(),
        engine: {
          name: manifest.engine,
          version: manifest.version,
          sourceRevision: manifest.sourceRevision,
        },
      },
    },
  }, null, 2)}\n`, { mode: 0o600 });
  execFileSync(process.execPath, [
    'scripts/rollback-migration-engine.mjs',
    '--source',
    source,
    '--by',
    operator,
    '--reason',
    `Controlled rollback drill ${drillId}`,
  ], {
    cwd: projectRoot,
    env: { ...process.env, OMNIKIT_MIGRATION_ENGINE_PROMOTION_PATH: temporaryLedger },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const result = JSON.parse(readFileSync(temporaryLedger, 'utf8')).sources[source];
  if (!result.rolledBackAt || result.rolledBackBy !== operator || !String(result.rollbackReason).includes(drillId)) {
    throw new Error('The controlled rollback did not produce the expected auditable state transition.');
  }

  let drills = { schemaVersion: 'omnikit.migration-engine-rollback-drills.v1', drills: [] };
  try {
    const parsed = JSON.parse(readFileSync(drillLedgerPath, 'utf8'));
    if (parsed?.schemaVersion === drills.schemaVersion && Array.isArray(parsed.drills)) drills = parsed;
  } catch {
    // The first successful drill creates the local ignored ledger.
  }
  const record = {
    id: drillId,
    source,
    completedAt: result.rolledBackAt,
    completedBy: operator,
    passed: true,
    mechanism: 'promotion-ledger state transition',
    engine: {
      name: manifest.engine,
      version: manifest.version,
      sourceRevision: manifest.sourceRevision,
      sourceContentSha256: manifest.sourceContentSha256,
      manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    },
  };
  drills.drills = [...drills.drills.filter((item) => item.id !== drillId), record];
  mkdirSync(dirname(drillLedgerPath), { recursive: true, mode: 0o700 });
  const temporaryOutput = `${drillLedgerPath}.${process.pid}.tmp`;
  writeFileSync(temporaryOutput, `${JSON.stringify(drills, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryOutput, drillLedgerPath);
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

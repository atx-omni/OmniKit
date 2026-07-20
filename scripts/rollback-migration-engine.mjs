import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { MIGRATION_ENGINE_SOURCES } from './migration-engine-certification.mjs';

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || '').trim() : '';
}

const source = option('source').toLowerCase().replace('power_bi', 'powerbi');
const rolledBackBy = option('by').slice(0, 200);
const reason = option('reason').slice(0, 500);
if (!MIGRATION_ENGINE_SOURCES.includes(source) || rolledBackBy.length < 2 || reason.length < 5) {
  throw new Error('Usage: npm run rollback:migration-engine -- --source looker --by "Release Owner" --reason "Reason for rollback"');
}
const path = resolve(process.env.OMNIKIT_MIGRATION_ENGINE_PROMOTION_PATH || 'data/migration-engine/promotions.json');
const document = JSON.parse(readFileSync(path, 'utf8'));
if (document?.schemaVersion !== 'omnikit.migration.engine-promotions.v1' || !document.sources?.[source]) {
  throw new Error(`${source} has no promotion record to roll back.`);
}
const rolledBackAt = new Date().toISOString();
document.sources[source].rolledBackAt = rolledBackAt;
document.sources[source].rolledBackBy = rolledBackBy;
document.sources[source].rollbackReason = reason;
document.sources[source].history = [
  ...(Array.isArray(document.sources[source].history) ? document.sources[source].history : []),
  {
    event: 'rolled_back',
    at: rolledBackAt,
    by: rolledBackBy,
    reason,
  },
].slice(-100);
const temporary = `${path}.${process.pid}.tmp`;
writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
renameSync(temporary, path);
process.stdout.write(`Rolled back ${source} to shadow eligibility.\n`);

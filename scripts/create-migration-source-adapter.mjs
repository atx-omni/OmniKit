import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || '').trim() : '';
}

function camel(value) {
  return value.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

export function createMigrationSourceAdapter({ source, label, root = projectRoot }) {
  if (!/^[a-z][a-z0-9_]{1,50}$/.test(source)) throw new Error('Source ID must use lowercase letters, numbers, and underscores.');
  if (!label || label.length > 80) throw new Error('A source label of 1-80 characters is required.');
  const registryPath = resolve(root, 'config/migration-source-adapters.json');
  const rulebookPath = resolve(root, 'contracts/migration-source-rulebook.v1.json');
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  const rulebook = JSON.parse(readFileSync(rulebookPath, 'utf8'));
  if (registry.sources.some((item) => item.id === source)) throw new Error(`${source} already exists in the source registry.`);
  const parserRelative = `server/services/semanticMigration/${camel(source)}ManualParser.ts`;
  const fixtureRelative = `tests/fixtures/semantic-migrations/${source}-sample/manifest.json`;
  const parserPath = resolve(root, parserRelative);
  const fixturePath = resolve(root, fixtureRelative);
  if (existsSync(parserPath) || existsSync(fixturePath)) throw new Error('Generated adapter paths already exist.');
  mkdirSync(dirname(parserPath), { recursive: true });
  mkdirSync(dirname(fixturePath), { recursive: true });
  writeFileSync(parserPath, `export const ${source.toUpperCase()}_ADAPTER_LIFECYCLE = 'unsupported' as const;\n\nexport function parse${camel(source)[0].toUpperCase()}${camel(source).slice(1)}ManualArtifacts(): never {\n  throw new Error('${label} extraction is unsupported until fixture conformance, security review, ownership approval, and live acceptance are complete.');\n}\n`);
  writeFileSync(fixturePath, `${JSON.stringify({ schemaVersion: 'omnikit.synthetic-migration-fixture.v1', source, label: `${label} synthetic adapter fixture`, synthetic: true, artifacts: [], expectedEvidence: [] }, null, 2)}\n`);
  registry.sources.push({
    id: source,
    label,
    controlPlaneOwner: 'unassigned',
    extractionOwner: 'omnikit_native',
    lifecycle: 'unsupported',
    releaseStage: 'development',
    certification: 'none',
    acquisition: { api: false, manual: false },
    parserPath: parserRelative,
    fixtureManifest: fixtureRelative,
    rulebookId: `${source}-draft-v1`,
    liveAcceptanceRequired: true,
  });
  registry.sources.sort((left, right) => left.id.localeCompare(right.id));
  rulebook.rules.push({ id: `${source}-draft-v1`, source, version: 'draft.v1', requiredEvidence: ['source_inventory'], forbiddenFallbacks: ['silent_fallback', 'synthetic_promotion'] });
  rulebook.rules.sort((left, right) => left.source.localeCompare(right.source));
  writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  writeFileSync(rulebookPath, `${JSON.stringify(rulebook, null, 2)}\n`);
  return { source, parserPath: parserRelative, fixturePath: fixtureRelative, lifecycle: 'unsupported', releaseStage: 'development' };
}

if (process.argv[1]?.endsWith('create-migration-source-adapter.mjs')) {
  try {
    const result = createMigrationSourceAdapter({ source: option('source'), label: option('label'), root: option('root') ? resolve(option('root')) : projectRoot });
    process.stdout.write(`Created ${result.source} in ${result.lifecycle} lifecycle and ${result.releaseStage} release stage. Review ownership and implement conformance before enabling acquisition.\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  }
}

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_SOURCES = ['dbt', 'domo', 'looker', 'metabase', 'microstrategy', 'power_bi', 'sigma', 'tableau', 'webfocus'];
const LIFECYCLES = new Set(['unsupported', 'shadow', 'eligible', 'primary', 'rolled_back']);
const RELEASE_STAGES = new Set(['development', 'preview', 'ga_candidate', 'ga']);
const CERTIFICATIONS = new Set(['none', 'synthetic_regression', 'live_accepted']);
const OWNERS = new Set(['omnikit_native', 'omnikit_engine', 'omnikit_hybrid']);
const ENGINE_PACKAGE_ROOT = 'packages/omnikit-migration-engine/';
const REQUIRED_INTERNAL_CAPABILITIES = {
  looker: ['manual_lookml', 'api_inventory', 'explores', 'dashboards'],
  metabase: ['manual_api_snapshot', 'api_inventory', 'mbql', 'dashboards'],
  power_bi: ['pbip', 'pbir', 'tmdl', 'model_bim', 'workspace_scanner', 'direct_pbix'],
  sigma: ['manual_api_snapshot', 'api_inventory', 'formula_normalization', 'workbooks'],
  tableau: ['twb', 'twbx', 'tds', 'tdsx', 'dashboards'],
};
const REQUIRED_OWNERSHIP_AREAS = ['source-connectors', 'provider-adapters', 'canonical-ir', 'prompts-and-evaluations', 'target-deployment', 'release-and-security'];

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error(`Cannot read valid JSON at ${path}.`); }
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function assert(condition, message) {
  if (!condition) throw new Error(`Migration source conformance failed: ${message}`);
}

function containsSensitiveKey(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsSensitiveKey);
  return Object.entries(value).some(([key, item]) => /api.?key|credential|password|secret|access.?token|private.?key/i.test(key) || containsSensitiveKey(item));
}

export function verifyMigrationSourceConformance(root = projectRoot) {
  const registryPath = resolve(root, 'config/migration-source-adapters.json');
  const ownershipPath = resolve(root, 'config/migration-ownership.json');
  const rulebookPath = resolve(root, 'contracts/migration-source-rulebook.v1.json');
  const registry = readJson(registryPath);
  const ownership = readJson(ownershipPath);
  const rulebook = readJson(rulebookPath);
  assert(registry.schemaVersion === 'omnikit.migration-source-adapters.v2' && Array.isArray(registry.sources), 'adapter registry schema is invalid');
  assert(ownership.schemaVersion === 'omnikit.migration-ownership.v1' && Array.isArray(ownership.areas), 'ownership registry schema is invalid');
  assert(rulebook.schemaVersion === 'omnikit.migration-source-rulebook.v1' && Array.isArray(rulebook.rules), 'rulebook schema is invalid');
  assert(!containsSensitiveKey(registry) && !containsSensitiveKey(ownership) && !containsSensitiveKey(rulebook), 'contracts must not contain secret-shaped keys');

  const sourceIds = registry.sources.map((source) => source.id);
  assert(new Set(sourceIds).size === sourceIds.length, 'source IDs must be unique');
  EXPECTED_SOURCES.forEach((source) => assert(sourceIds.includes(source), `${source} is absent from the source registry`));
  const ruleById = new Map(rulebook.rules.map((rule) => [rule.id, rule]));
  const sourceReports = registry.sources.map((source) => {
    assert(/^[a-z][a-z0-9_]{1,50}$/.test(source.id), `${source.id} has an unsafe source ID`);
    assert(typeof source.label === 'string' && source.label.trim(), `${source.id} needs a label`);
    assert(typeof source.controlPlaneOwner === 'string' && source.controlPlaneOwner.trim(), `${source.id} needs a control-plane owner`);
    assert(OWNERS.has(source.extractionOwner), `${source.id} has an unsupported extraction owner`);
    assert(LIFECYCLES.has(source.lifecycle), `${source.id} has an unsupported lifecycle`);
    assert(RELEASE_STAGES.has(source.releaseStage), `${source.id} has an unsupported release stage`);
    assert(CERTIFICATIONS.has(source.certification), `${source.id} has an unsupported certification state`);
    assert(typeof source.acquisition?.api === 'boolean' && typeof source.acquisition?.manual === 'boolean', `${source.id} needs explicit API and manual acquisition flags`);
    assert(source.lifecycle === 'unsupported' || source.acquisition.api || source.acquisition.manual, `${source.id} has no usable acquisition path`);
    assert(source.lifecycle !== 'primary' || source.extractionOwner.startsWith('omnikit_'), `${source.id} cannot be primary without OmniKit ownership or a recorded promotion`);
    assert(source.certification !== 'live_accepted' || source.lifecycle === 'eligible' || source.lifecycle === 'primary', `${source.id} claims live acceptance without an eligible lifecycle`);
    assert(source.releaseStage !== 'ga_candidate' || source.certification === 'live_accepted', `${source.id} cannot be a GA candidate without live acceptance`);
    assert(source.releaseStage !== 'ga' || (source.certification === 'live_accepted' && source.lifecycle === 'primary'), `${source.id} cannot be GA without live acceptance and a primary runtime lifecycle`);
    assert(typeof source.parserPath === 'string' && existsSync(resolve(root, source.parserPath)), `${source.id} parser path is missing`);
    assert(typeof source.fixtureManifest === 'string' && existsSync(resolve(root, source.fixtureManifest)), `${source.id} fixture manifest is missing`);
    if (source.extractionOwner === 'omnikit_engine' || source.extractionOwner === 'omnikit_hybrid') {
      assert(Array.isArray(source.implementationPaths) && source.implementationPaths.length > 0, `${source.id} needs tracked implementation paths`);
      source.implementationPaths.forEach((path) => {
        assert(typeof path === 'string' && existsSync(resolve(root, path)), `${source.id} implementation path is missing: ${path}`);
      });
      assert(source.implementationPaths.some((path) => path.startsWith(ENGINE_PACKAGE_ROOT)), `${source.id} does not point to the first-party engine package`);
      if (source.extractionOwner === 'omnikit_engine') {
        assert(source.parserPath.startsWith(ENGINE_PACKAGE_ROOT), `${source.id} engine ownership must use the tracked first-party parser`);
        assert(source.implementationPaths.every((path) => path.startsWith(ENGINE_PACKAGE_ROOT)), `${source.id} engine ownership contains a path outside the first-party package`);
      } else {
        assert(source.implementationPaths.some((path) => !path.startsWith(ENGINE_PACKAGE_ROOT)), `${source.id} hybrid ownership must preserve an OmniKit-native path`);
      }
      const requiredCapabilities = REQUIRED_INTERNAL_CAPABILITIES[source.id] || [];
      assert(Array.isArray(source.certifiedCapabilities), `${source.id} needs certified capability evidence`);
      requiredCapabilities.forEach((capability) => {
        assert(source.certifiedCapabilities.includes(capability), `${source.id} is missing certified capability ${capability}`);
      });
    }
    const rule = ruleById.get(source.rulebookId);
    assert(rule && rule.source === source.id && Array.isArray(rule.requiredEvidence) && rule.requiredEvidence.length > 0, `${source.id} rulebook snapshot is missing or mismatched`);
    return {
      source: source.id,
      lifecycle: source.lifecycle,
      releaseStage: source.releaseStage,
      certification: source.certification,
      extractionOwner: source.extractionOwner,
      certifiedCapabilities: source.certifiedCapabilities || [],
      fixtureSha256: sha256(resolve(root, source.fixtureManifest)),
      rulebookVersion: rule.version,
    };
  });

  const ownershipIds = new Set(ownership.areas.map((area) => area.id));
  REQUIRED_OWNERSHIP_AREAS.forEach((area) => assert(ownershipIds.has(area), `${area} ownership is missing`));
  ownership.areas.forEach((area) => {
    assert(typeof area.ownerRole === 'string' && area.ownerRole.trim(), `${area.id} needs an owner role`);
    assert(Number.isInteger(area.requiredApprovals) && area.requiredApprovals >= 1, `${area.id} needs at least one approval`);
    assert(Array.isArray(area.paths) && area.paths.length > 0, `${area.id} needs owned paths`);
  });

  return {
    schemaVersion: 'omnikit.migration-source-conformance.v1',
    verified: true,
    registrySha256: sha256(registryPath),
    ownershipSha256: sha256(ownershipPath),
    rulebookSha256: sha256(rulebookPath),
    sources: sourceReports,
    liveAcceptancePending: sourceReports.filter((source) => source.certification !== 'live_accepted').map((source) => source.source),
    gaReleasePending: sourceReports.filter((source) => source.releaseStage !== 'ga').map((source) => source.source),
  };
}

if (process.argv[1]?.endsWith('verify-migration-source-conformance.mjs')) {
  try {
    const result = verifyMigrationSourceConformance();
    process.stdout.write(process.argv.includes('--json') ? `${JSON.stringify(result, null, 2)}\n` : `Verified ${result.sources.length} migration source contracts. Live acceptance remains pending for ${result.liveAcceptancePending.length}.\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  }
}

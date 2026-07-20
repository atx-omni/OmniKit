import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  buildProvisionalAcceptanceGaps,
  buildProvisionalAcceptanceStages,
  LIVE_ACCEPTANCE_SCHEMA_VERSION,
  sha256Json,
} from './migration-engine-certification.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = new Set(['looker', 'metabase', 'powerbi', 'sigma', 'tableau']);
const API_SOURCES = new Set(['looker', 'metabase', 'sigma']);
const MANUAL_SOURCES = new Set(['looker', 'powerbi', 'tableau']);
const TEXT_EXTENSIONS = new Set(['.json', '.lkml', '.lookml', '.model.lkml', '.view.lkml', '.dashboard.lookml', '.tds', '.twb', '.xml']);
const MAX_ARTIFACTS = 2_000;
const MAX_ARTIFACT_BYTES = 1_000_000_000;
const MAX_TOTAL_ARTIFACT_BYTES = 2_000_000_000;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1_000;

function usage() {
  return `Credential-safe live acceptance for OmniKit's first-party migration engine.

Usage:
  npm run accept:migration-engine -- --source looker --connection-id <vault-id> --target-instance-id <vault-id> [--dashboard-id <id>]
  npm run accept:migration-engine -- --source metabase --connection-id <vault-id> --target-instance-id <vault-id> [--dashboard-id <id>]
  npm run accept:migration-engine -- --source sigma --connection-id <vault-id> --target-instance-id <vault-id> [--dashboard-id <workbook-or-page-id>]
  npm run accept:migration-engine -- --source powerbi --target-instance-id <vault-id> --artifact /path/report.pbix
  npm run accept:migration-engine -- --source tableau --target-instance-id <vault-id> --artifact /path/workbook.twbx

Options:
  --source <name>              looker, metabase, powerbi, sigma, or tableau
  --mode <api|manual>          Defaults to API for Looker/Metabase/Sigma and manual otherwise
  --url <local-url>            Local OmniKit origin (default http://127.0.0.1:5173)
  --connection-id <vault-id>  Saved source connection ID; API credentials stay in the unlocked vault
  --target-instance-id <id>   Saved target Omni instance used to test connection mapping
  --artifact <path>           Repeat for each manual source artifact
  --dashboard-id <id>         Repeat to verify scoped API extraction
  --project-id <id>           Repeat to scope Looker project acquisition
  --evidence <path>           Sanitized output path under ignored data/ by default
  --dry-run                   Validate prerequisites and print the request shape without sending data
  --help                      Show this help

Environment fallbacks:
  OMNIKIT_LIVE_ACCEPTANCE_URL
  OMNIKIT_LIVE_SOURCE
  OMNIKIT_LIVE_SOURCE_CONNECTION_ID
  OMNIKIT_LIVE_TARGET_INSTANCE_ID
  OMNIKIT_LIVE_ARTIFACT_PATHS_JSON
  OMNIKIT_LIVE_DASHBOARD_IDS_JSON
  OMNIKIT_LIVE_PROJECT_IDS_JSON
  OMNIKIT_LIVE_CONNECTION_OVERRIDES_JSON
  OMNIKIT_LIVE_DEFAULT_SCHEMA

This command intentionally has no API-key, password, token, or client-secret option.`;
}

function valuesFromJsonEnvironment(name) {
  const raw = process.env[name];
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be a JSON array of strings.`);
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${name} must be a JSON array of non-empty strings.`);
  }
  return parsed.map((item) => item.trim());
}

function mappingFromJsonEnvironment(name) {
  const raw = process.env[name];
  if (!raw) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be a JSON object of source keys to target connection IDs.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.entries(parsed).some(([key, value]) => !key.trim() || typeof value !== 'string' || !value.trim())) {
    throw new Error(`${name} must be a JSON object of source keys to target connection IDs.`);
  }
  return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key.trim(), value.trim()]));
}

export function parseLiveAcceptanceArgs(argv) {
  const options = { artifacts: [], dashboardIds: [], projectIds: [], dryRun: false };
  const repeatable = new Map([
    ['--artifact', 'artifacts'],
    ['--dashboard-id', 'dashboardIds'],
    ['--project-id', 'projectIds'],
  ]);
  const scalar = new Map([
    ['--source', 'source'],
    ['--mode', 'mode'],
    ['--url', 'url'],
    ['--connection-id', 'connectionId'],
    ['--target-instance-id', 'targetInstanceId'],
    ['--evidence', 'evidencePath'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') return { help: true };
    if (argument === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (/credential|secret|password|token|api[-_]?key/i.test(argument)) {
      throw new Error('Plaintext credential flags are not accepted. Save the source connection in the encrypted vault and pass its ID.');
    }
    const repeatKey = repeatable.get(argument);
    const scalarKey = scalar.get(argument);
    if (!repeatKey && !scalarKey) throw new Error(`Unknown option: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value.`);
    index += 1;
    if (repeatKey) options[repeatKey].push(value);
    else options[scalarKey] = value;
  }
  return options;
}

export function localControlPlaneOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('The OmniKit acceptance URL is invalid.');
  }
  const hostname = url.hostname.toLowerCase();
  if (!['localhost', '127.0.0.1', '::1'].includes(hostname) || !['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Live acceptance can only send source evidence to a local OmniKit origin.');
  }
  if (url.username || url.password) throw new Error('The OmniKit acceptance URL must not contain credentials.');
  return url.origin;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function acceptanceRef(value) {
  return value ? sha256(String(value)).slice(0, 20) : undefined;
}

function isTextArtifact(path) {
  const lower = path.toLowerCase();
  return TEXT_EXTENSIONS.has(extname(lower)) || Array.from(TEXT_EXTENSIONS).some((extension) => lower.endsWith(extension));
}

export function loadLiveAcceptanceArtifacts(paths) {
  if (paths.length > MAX_ARTIFACTS) throw new Error(`Live acceptance accepts at most ${MAX_ARTIFACTS} artifacts.`);
  const names = new Set();
  let totalBytes = 0;
  return paths.map((inputPath) => {
    const absolute = resolve(inputPath);
    const info = statSync(absolute);
    if (!info.isFile()) throw new Error(`Manual artifact is not a file: ${inputPath}`);
    if (info.size <= 0) throw new Error(`Manual artifact is empty: ${inputPath}`);
    if (info.size > MAX_ARTIFACT_BYTES) throw new Error(`Manual artifact exceeds the ${MAX_ARTIFACT_BYTES}-byte safety limit: ${inputPath}`);
    totalBytes += info.size;
    if (totalBytes > MAX_TOTAL_ARTIFACT_BYTES) throw new Error(`Manual artifacts exceed the ${MAX_TOTAL_ARTIFACT_BYTES}-byte total safety limit.`);
    const name = basename(absolute);
    if (names.has(name.toLowerCase())) throw new Error(`Manual artifact names must be unique: ${name}`);
    names.add(name.toLowerCase());
    const content = readFileSync(absolute);
    return {
      request: isTextArtifact(name)
        ? { name, content: content.toString('utf8') }
        : { name, contentBase64: content.toString('base64') },
      evidence: { sha256: sha256(content), size_bytes: content.byteLength, encoding: isTextArtifact(name) ? 'utf8' : 'base64' },
    };
  });
}

export function buildLiveAcceptanceConfig(cli) {
  const source = String(cli.source || process.env.OMNIKIT_LIVE_SOURCE || '').toLowerCase().replace('power_bi', 'powerbi');
  if (!SOURCES.has(source)) throw new Error('Select --source looker, metabase, powerbi, sigma, or tableau.');
  const mode = String(cli.mode || (API_SOURCES.has(source) ? 'api' : 'manual')).toLowerCase();
  if (!['api', 'manual'].includes(mode)) throw new Error('--mode must be api or manual.');
  if (mode === 'api' && !API_SOURCES.has(source)) throw new Error(`${source} live acceptance currently requires a manual export.`);
  if (mode === 'manual' && !MANUAL_SOURCES.has(source)) throw new Error(`${source} live acceptance currently requires a saved API connection.`);
  const connectionId = cli.connectionId || process.env.OMNIKIT_LIVE_SOURCE_CONNECTION_ID || '';
  const targetInstanceId = cli.targetInstanceId || process.env.OMNIKIT_LIVE_TARGET_INSTANCE_ID || '';
  if (mode === 'api' && !connectionId) throw new Error('API acceptance requires --connection-id for a saved source connection in the unlocked vault.');
  if (!targetInstanceId) throw new Error('Live acceptance requires --target-instance-id so destination connection mapping is exercised.');
  const artifacts = [...valuesFromJsonEnvironment('OMNIKIT_LIVE_ARTIFACT_PATHS_JSON'), ...(cli.artifacts || [])];
  if (mode === 'manual' && artifacts.length === 0) throw new Error('Manual acceptance requires at least one --artifact path.');
  const dashboardIds = [...valuesFromJsonEnvironment('OMNIKIT_LIVE_DASHBOARD_IDS_JSON'), ...(cli.dashboardIds || [])];
  const projectIds = [...valuesFromJsonEnvironment('OMNIKIT_LIVE_PROJECT_IDS_JSON'), ...(cli.projectIds || [])];
  return {
    source,
    mode,
    url: localControlPlaneOrigin(cli.url || process.env.OMNIKIT_LIVE_ACCEPTANCE_URL || 'http://127.0.0.1:5173'),
    connectionId,
    targetInstanceId,
    artifactPaths: Array.from(new Set(artifacts)),
    dashboardIds: Array.from(new Set(dashboardIds)),
    projectIds: Array.from(new Set(projectIds)),
    connectionOverrides: mappingFromJsonEnvironment('OMNIKIT_LIVE_CONNECTION_OVERRIDES_JSON'),
    defaultSchema: process.env.OMNIKIT_LIVE_DEFAULT_SCHEMA || undefined,
    evidencePath: cli.evidencePath,
    dryRun: Boolean(cli.dryRun),
  };
}

export function buildLiveAcceptanceRequest(config, loadedArtifacts = []) {
  const scope = {};
  if (config.dashboardIds.length) scope.selected_dashboard_ids = config.dashboardIds;
  if (config.projectIds.length) scope.project_ids = config.projectIds;
  return {
    requestId: `live_${config.source}_${randomUUID()}`,
    sourceTool: config.source,
    mode: config.mode,
    connectionId: config.mode === 'api' ? config.connectionId : undefined,
    artifacts: config.mode === 'manual' ? loadedArtifacts.map((item) => item.request) : undefined,
    targetInstanceId: config.targetInstanceId,
    connectionOverrides: Object.keys(config.connectionOverrides).length ? config.connectionOverrides : undefined,
    defaultSchema: config.defaultSchema,
    scope,
    includeModelSuggestions: true,
    rulebookVersion: 'v2',
  };
}

export function localReleaseProvenance({
  commitSha = process.env.OMNIKIT_RELEASE_COMMIT_SHA,
  worktreeDirty = process.env.OMNIKIT_RELEASE_WORKTREE_DIRTY,
} = {}) {
  let resolvedCommit = String(commitSha || '').trim();
  let dirty = String(worktreeDirty || '').toLowerCase() === 'true';
  if (!resolvedCommit) {
    try {
      resolvedCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: projectRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      dirty = Boolean(execFileSync('git', ['status', '--porcelain'], {
        cwd: projectRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim());
    } catch {
      resolvedCommit = 'unknown';
      dirty = true;
    }
  }
  return {
    commit_sha: /^[a-f0-9]{40}$/i.test(resolvedCommit) ? resolvedCommit.toLowerCase() : 'unknown',
    worktree_dirty: dirty,
  };
}

function confidenceCounts(mappings) {
  const counts = { exact: 0, dialect: 0, ambiguous: 0, none: 0 };
  for (const mapping of mappings || []) {
    if (Object.hasOwn(counts, mapping.confidence)) counts[mapping.confidence] += 1;
  }
  return counts;
}

export function buildSanitizedAcceptanceEvidence({
  config,
  request,
  result,
  artifactEvidence,
  recordedAt = new Date().toISOString(),
  omnikit = localReleaseProvenance(),
}) {
  const mappings = Array.isArray(result.connection_mappings) ? result.connection_mappings : [];
  const dashboards = Array.isArray(result.bundle?.dashboards) ? result.bundle.dashboards : [];
  const sourceExtractionEvidence = {
    request_id_sha256: acceptanceRef(request.requestId),
    source: config.source,
    mode: config.mode,
    artifact_fingerprints: artifactEvidence,
    selected_dashboard_refs_sha256: config.dashboardIds.map(acceptanceRef).sort(),
    view_count: Number(result.diagnostics?.view_count || 0),
    dashboard_count: Number(result.diagnostics?.dashboard_count || 0),
    connection_mapping_count: mappings.length,
  };
  const sourceExtractionEvidenceSha256 = sha256Json(sourceExtractionEvidence);
  return {
    schema_version: LIVE_ACCEPTANCE_SCHEMA_VERSION,
    evidence_status: 'provisional',
    recorded_at: recordedAt,
    outcome: 'incomplete',
    source: config.source,
    mode: config.mode,
    request_id_sha256: acceptanceRef(request.requestId),
    omnikit,
    control_plane: {
      origin: config.url,
      local_only: true,
      rollout_mode: result.control_plane?.rollout_mode || 'unknown',
      duration_ms: Number(result.control_plane?.duration_ms || 0),
      queue_wait_ms: Number(result.control_plane?.queue_wait_ms || 0),
    },
    engine: {
      name: String(result.engine?.name || ''),
      version: String(result.engine?.version || ''),
      revision: result.engine?.revision ? String(result.engine.revision) : undefined,
      result_schema_version: String(result.schema_version || ''),
      rulebook_version: String(result.diagnostics?.rulebook_version || ''),
      rulebook_sha256: String(result.diagnostics?.rulebook_sha256 || ''),
    },
    input: {
      evidence_origin: 'live_source',
      saved_source_connection_ref_sha256: config.mode === 'api' ? acceptanceRef(config.connectionId) : undefined,
      target_instance_ref_sha256: acceptanceRef(config.targetInstanceId),
      selected_dashboard_count: config.dashboardIds.length,
      selected_dashboard_refs_sha256: config.dashboardIds.map(acceptanceRef).sort(),
      selected_project_count: config.projectIds.length,
      artifact_count: artifactEvidence.length,
      artifact_fingerprints: artifactEvidence,
      connection_override_count: Object.keys(config.connectionOverrides).length,
    },
    result: {
      source: String(result.source || ''),
      mode: String(result.mode || ''),
      view_count: Number(result.diagnostics?.view_count || 0),
      field_count: Number(result.diagnostics?.field_count || 0),
      topic_count: Number(result.diagnostics?.topic_count || 0),
      dashboard_count: Number(result.diagnostics?.dashboard_count || 0),
      dashboard_identity_refs_sha256: dashboards.map((dashboard) => acceptanceRef(dashboard.native_source_id || dashboard.source_id)).filter(Boolean).sort(),
      untranslatable_count: Number(result.diagnostics?.untranslatable_count || 0),
      model_suggestion_count: Array.isArray(result.model_suggestions) ? result.model_suggestions.length : 0,
      connection_mapping_count: mappings.length,
      mapped_connection_count: mappings.filter((mapping) => Boolean(mapping.target_connection_id)).length,
      confirmed_connection_count: mappings.filter((mapping) => mapping.confirmed === true).length,
      mapping_confidence: confidenceCounts(mappings),
      capability_coverage: result.capability_coverage || {},
      limitation_count: Array.isArray(result.diagnostics?.limitations) ? result.diagnostics.limitations.length : 0,
    },
    stages: buildProvisionalAcceptanceStages(sourceExtractionEvidenceSha256),
    gaps: buildProvisionalAcceptanceGaps(
      result.capability_coverage || {},
      Array.isArray(result.diagnostics?.limitations) ? result.diagnostics.limitations : [],
    ),
  };
}

function redactedError(value) {
  return String(value || 'Live acceptance failed.')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/(?:sk|api|token|secret|password)[-_A-Za-z0-9]{8,}/gi, '[redacted]')
    .slice(0, 800);
}

async function run() {
  const cli = parseLiveAcceptanceArgs(process.argv.slice(2));
  if (cli.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const config = buildLiveAcceptanceConfig(cli);
  const loadedArtifacts = config.mode === 'manual' ? loadLiveAcceptanceArtifacts(config.artifactPaths) : [];
  const request = buildLiveAcceptanceRequest(config, loadedArtifacts);
  if (config.dryRun) {
    process.stdout.write(`${JSON.stringify({
      ready: true,
      source: config.source,
      mode: config.mode,
      local_origin: config.url,
      saved_source_connection: config.mode === 'api',
      target_mapping_enabled: true,
      artifact_count: loadedArtifacts.length,
      selected_dashboard_count: config.dashboardIds.length,
      selected_project_count: config.projectIds.length,
    }, null, 2)}\n`);
    return;
  }

  const response = await fetch(`${config.url}/api/migration-studio/engine/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.result) {
    throw new Error(`Local OmniKit acceptance request failed (${response.status}): ${redactedError(payload?.error)}`);
  }
  const evidence = buildSanitizedAcceptanceEvidence({
    config,
    request,
    result: payload.result,
    artifactEvidence: loadedArtifacts.map((item) => item.evidence),
  });
  const timestamp = evidence.recorded_at.replace(/[:.]/g, '-');
  const outputPath = resolve(config.evidencePath || `data/migration-engine/live-acceptance/${config.source}-${timestamp}.json`);
  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
  writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  chmodSync(outputPath, 0o600);
  process.stdout.write(`Live ${config.source} extraction recorded: ${evidence.result.view_count} views, ${evidence.result.dashboard_count} dashboards, ${evidence.result.connection_mapping_count} connection mappings.\n`);
  process.stdout.write(`Provisional sanitized evidence: ${outputPath}\n`);
  process.stdout.write('This evidence is not promotion-eligible until downstream review stages are completed with npm run finalize:migration-engine:acceptance.\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run().catch((error) => {
    process.stderr.write(`${redactedError(error instanceof Error ? error.message : error)}\n`);
    process.exitCode = 1;
  });
}

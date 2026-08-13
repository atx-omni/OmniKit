import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import { listLookerDiscoveryInventory, prepareLookerEvidence } from '../server/services/migrationSources/looker';
import { prepareMetabaseEvidence } from '../server/services/migrationSources/metabase';
import { discoverMicroStrategySource, prepareMicroStrategyEvidence } from '../server/services/migrationSources/microStrategy';
import { listPowerBiFabricItems, preparePowerBiEvidence } from '../server/services/migrationSources/powerBi';
import {
  MIGRATION_SOURCE_AUTH_POLICIES,
  migrationSourceAuthModeAllowed,
  migrationSourceAuthNeedsExpiry,
  migrationSourceAuthNeedsServerExchange,
} from '../server/services/migrationSources/policy';
import { prepareSigmaEvidence } from '../server/services/migrationSources/sigma';
import { discoverTableauSource, prepareTableauEvidence } from '../server/services/migrationSources/tableau';
import {
  MAX_PREPARATION_RESPONSE_BYTES,
  migrationPreparedEvidenceContentFingerprint,
  normalizeMigrationSourceRootIds,
  prepareBoundedDomoApiEvidence,
  prepareSavedMigrationSourceEvidence,
  publishDomoApiEvidenceResult,
  publishMigrationPreparedEvidenceResult,
} from '../server/services/migrationSources/index';
import type { SavedPlatformConnection } from '../server/services/nativeVault';
import { domoApiEvidenceToPreparedSourceEvidence } from '../server/services/migrationConnectors';
import { isPrivateOrLocalAddress } from '../server/security';
import type {
  MigrationSourceCollectorContext,
  MigrationSourceConnectionSnapshot,
  MigrationSourceTransport,
  MigrationSourceTransportRequest,
  MigrationSourceTransportResponse,
} from '../server/services/migrationSources/contracts';
import { assessMigrationEvidenceIntegrity } from '../src/services/semanticMigration/evidenceIntegrity';
import { migrationSourceDocumentation } from '../src/services/semanticMigration/sourceDocumentation';
import {
  MIGRATION_SOURCE_SETUP_GUIDES,
  MIGRATION_SOURCE_SETUP_OPTIONS,
  migrationSourceSetupGuide,
} from '../src/services/semanticMigration/sourceSetupGuidance';
import type {
  CanonicalSemanticModel,
  DomoApiEvidenceResult,
  MigrationBiSourceTool,
  MigrationPlatformAuthMode,
  MigrationPreparedEvidenceResult,
} from '../src/services/semanticMigration/types';

type FixtureReply = {
  status?: number;
  headers?: Record<string, string>;
  body: unknown;
  bytesRead?: number;
  requestCount?: number;
};

class FixtureTransport implements MigrationSourceTransport {
  readonly requests: MigrationSourceTransportRequest[] = [];

  constructor(
    private readonly respond: (request: MigrationSourceTransportRequest) => FixtureReply | Promise<FixtureReply>,
  ) {}

  async request<T = unknown>(request: MigrationSourceTransportRequest): Promise<MigrationSourceTransportResponse<T>> {
    this.requests.push(request);
    const reply = await this.respond(request);
    const serializedBody = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body) ?? '';
    const bodyBytes = reply.body instanceof Uint8Array
      ? reply.body.byteLength
      : Buffer.byteLength(serializedBody, 'utf8');
    return {
      status: reply.status ?? 200,
      headers: reply.headers ?? {},
      body: reply.body as T,
      bytesRead: reply.bytesRead ?? bodyBytes,
      finalUrl: request.url,
      requestCount: reply.requestCount ?? 1,
    };
  }
}

const REVISION = '2026-08-12T12:00:00.000Z';
const REQUEST_SCOPE = 'f'.repeat(64);

function connection(
  platform: MigrationBiSourceTool,
  authMode: MigrationPlatformAuthMode,
  overrides: Partial<MigrationSourceConnectionSnapshot> = {},
): MigrationSourceConnectionSnapshot {
  return {
    id: `connection-${platform}`,
    name: `Example ${platform} source`,
    platform,
    baseUrl: `https://${platform.replace('_', '-')}.example.test`,
    updatedAt: REVISION,
    authMode,
    ...overrides,
  };
}

function savedLookerConnection(): SavedPlatformConnection {
  return {
    id: 'saved-connection-looker',
    name: 'Saved Looker source',
    platform: 'looker',
    baseUrl: 'https://looker.example.test',
    authMode: 'api_client_credentials',
    clientId: 'fixture-looker-client',
    credential: 'fixture-looker-secret',
    enabled: true,
    createdAt: REVISION,
    updatedAt: REVISION,
  };
}

function savedDomoConnection(): SavedPlatformConnection {
  return {
    id: 'saved-connection-domo',
    name: 'Saved Domo source',
    platform: 'domo',
    baseUrl: 'https://example.domo.com',
    authMode: 'product_api_token',
    productApiToken: 'fixture-domo-product-token',
    enabled: true,
    createdAt: REVISION,
    updatedAt: REVISION,
  };
}

function domoApiFingerprintFixture(): DomoApiEvidenceResult {
  const sourceEvidence: DomoApiEvidenceResult['parseResult']['inventory']['sourceEvidence'] = {
    schemaVersion: 'omnikit.source-evidence.v2',
    sourceTool: 'domo',
    parser: { name: 'Domo deterministic API normalizer', version: '2' },
    acquisition: { mode: 'api', runId: 'a'.repeat(64), selectedScopeIds: ['page-1'] },
    collection: {
      expectedArtifactCount: 1,
      observedArtifactCount: 1,
      complete: false,
      truncated: false,
      permissionGaps: ['card_drill:card-1:manual_validation_required'],
    },
    dependencyClosure: { status: 'blocked', resolvedCount: 3, missingCount: 0, reviewCount: 1 },
    artifactFingerprints: [{ name: 'Example Domo definition', sha256: 'b'.repeat(64), sizeBytes: 128 }],
    documentationIds: ['https://www.domo.com/docs/api-reference/beast-modes/get-all-beast-modes'],
    diagnostics: ['Domo Product API does not prove complete Analyzer drill paths.'],
  };
  return {
    parseResult: {
      inventory: {
        sourceTool: 'domo',
        artifactCount: 1,
        artifacts: [],
        views: [],
        explores: [],
        relationships: [],
        dashboards: [],
        metrics: [],
        warnings: [],
        summary: 'Example normalized Domo evidence',
        sourceEvidence,
      },
      mappings: [],
      conflicts: [],
      diagnostics: {
        schemaVersion: 'omnikit.domo.manual.v2',
        parsedArtifactCount: 1,
        unsupportedArtifactCount: 0,
        mappingCount: 0,
        deduplicatedMeasureCount: 0,
        conflictCount: 0,
        pageCount: 1,
        governanceItemCount: 0,
        operationalItemCount: 0,
        handoffCount: 1,
        traversalLimitHit: false,
        traversalIssues: [],
        missingStableIdCount: 0,
        unresolvedDependencyCount: 0,
        ambiguousRelationshipCount: 0,
        warnings: [],
      },
    },
    selectedDashboardIds: ['page-1'],
    resolvedDashboardIds: ['page-1', 'card-1'],
    connectionUpdatedAt: REVISION,
    scopeFingerprint: 'a'.repeat(64),
    preparedAt: REVISION,
    diagnostics: {
      schemaVersion: 'omnikit.domo.api.v1',
      status: 'ready_with_gaps',
      access: 'deep',
      limitationDispositionRequired: true,
      limitations: [{
        code: 'domo_product_card_drill_manual_validation_required',
        message: 'Domo Product API does not prove complete Analyzer drill paths.',
      }],
      selectedDashboardCount: 1,
      resolvedPageCount: 1,
      resolvedCardCount: 1,
      resolvedDatasetCount: 1,
      resolvedBeastModeCount: 0,
      requestCount: 7,
      truncated: false,
      missingDependencies: [],
      blockers: [],
      warnings: ['Review the source drill behavior.', 'Retain the selected Page scope.'],
    },
  };
}

function collectorContext(
  sourceConnection: MigrationSourceConnectionSnapshot,
  selectedRootIds: readonly string[],
  transport: MigrationSourceTransport,
  registerSensitiveValue?: MigrationSourceCollectorContext['registerSensitiveValue'],
): MigrationSourceCollectorContext {
  return {
    connection: sourceConnection,
    selectedRootIds,
    scopeFingerprint: REQUEST_SCOPE,
    transport,
    registerSensitiveValue,
  };
}

function requestPath(request: MigrationSourceTransportRequest): string {
  const url = new URL(request.url);
  return `${url.pathname}${url.search}`;
}

function jsonText(value: unknown): string {
  return JSON.stringify(value);
}

function inlineBase64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function gzipTar(entries: ReadonlyArray<{ path: string; content: string }>): Uint8Array {
  const blocks: Buffer[] = [];
  entries.forEach((entry) => {
    const body = Buffer.from(entry.content, 'utf8');
    const header = Buffer.alloc(512);
    const writeField = (value: string, offset: number, length: number): void => {
      header.write(value, offset, Math.min(length, Buffer.byteLength(value, 'utf8')), 'utf8');
    };
    const writeOctal = (value: number, offset: number, length: number): void => {
      writeField(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length);
    };
    writeField(entry.path, 0, 100);
    writeOctal(0o644, 100, 8);
    writeOctal(0, 108, 8);
    writeOctal(0, 116, 8);
    writeOctal(body.byteLength, 124, 12);
    writeOctal(0, 136, 12);
    header.fill(0x20, 148, 156);
    header[156] = '0'.charCodeAt(0);
    writeField('ustar\0', 257, 6);
    writeField('00', 263, 2);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    writeField(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8);
    blocks.push(header, body);
    const padding = (512 - (body.byteLength % 512)) % 512;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  });
  blocks.push(Buffer.alloc(1_024));
  return gzipSync(Buffer.concat(blocks));
}

function assertSecretsAbsent(result: MigrationPreparedEvidenceResult, ...secrets: string[]): void {
  const serialized = JSON.stringify(result);
  secrets.forEach((secret) => assert.equal(serialized.includes(secret), false, 'prepared evidence must not expose source credentials or ephemeral sessions'));
}

test('source authentication policy is explicit, platform-specific, and fail-closed', () => {
  const allModes: MigrationPlatformAuthMode[] = [
    'api_key',
    'api_client_credentials',
    'oauth_client_credentials',
    'oauth_access_token',
    'personal_access_token',
    'username_password_session',
    'product_api_token',
  ];
  const expected: Record<MigrationBiSourceTool, {
    availability: 'saved_api' | 'saved_api_with_manual_closure' | 'manual_only';
    primary: MigrationPlatformAuthMode;
    allowed: MigrationPlatformAuthMode[];
    companion: MigrationPlatformAuthMode[];
    exchange: MigrationPlatformAuthMode[];
    expiry: MigrationPlatformAuthMode[];
  }> = {
    domo: {
      availability: 'saved_api_with_manual_closure', primary: 'product_api_token',
      allowed: ['product_api_token', 'oauth_client_credentials'], companion: ['oauth_client_credentials'], exchange: ['oauth_client_credentials'], expiry: [],
    },
    looker: {
      availability: 'saved_api_with_manual_closure', primary: 'api_client_credentials',
      allowed: ['api_client_credentials'], companion: [], exchange: ['api_client_credentials'], expiry: [],
    },
    sigma: {
      availability: 'saved_api_with_manual_closure', primary: 'oauth_client_credentials',
      allowed: ['oauth_client_credentials'], companion: [], exchange: ['oauth_client_credentials'], expiry: [],
    },
    metabase: {
      availability: 'saved_api_with_manual_closure', primary: 'api_key',
      allowed: ['api_key'], companion: [], exchange: [], expiry: [],
    },
    tableau: {
      availability: 'saved_api_with_manual_closure', primary: 'personal_access_token',
      allowed: ['personal_access_token'], companion: [], exchange: ['personal_access_token'], expiry: [],
    },
    power_bi: {
      availability: 'saved_api_with_manual_closure', primary: 'oauth_client_credentials',
      allowed: ['oauth_client_credentials', 'oauth_access_token'], companion: [], exchange: ['oauth_client_credentials'], expiry: ['oauth_access_token'],
    },
    microstrategy: {
      availability: 'saved_api_with_manual_closure', primary: 'username_password_session',
      allowed: ['username_password_session'], companion: [], exchange: ['username_password_session'], expiry: [],
    },
    webfocus: {
      availability: 'manual_only', primary: 'username_password_session',
      allowed: ['username_password_session'], companion: [], exchange: ['username_password_session'], expiry: [],
    },
  };

  for (const [platform, contract] of Object.entries(expected) as Array<[MigrationBiSourceTool, typeof expected[MigrationBiSourceTool]]>) {
    const policy = MIGRATION_SOURCE_AUTH_POLICIES[platform];
    assert.equal(policy.availability, contract.availability, `${platform} availability`);
    assert.equal(policy.primaryAuthMode, contract.primary, `${platform} primary auth`);
    assert.deepEqual([...policy.allowedAuthModes], contract.allowed, `${platform} allowed auth`);
    assert.deepEqual([...policy.optionalCompanionAuthModes], contract.companion, `${platform} companion auth`);
    assert.deepEqual([...policy.serverSideExchangeAuthModes], contract.exchange, `${platform} server exchange`);
    assert.deepEqual([...policy.credentialExpiryRequiredFor], contract.expiry, `${platform} credential expiry`);
    for (const mode of allModes) {
      assert.equal(migrationSourceAuthModeAllowed(platform, mode), contract.allowed.includes(mode), `${platform}/${mode} allowed`);
      assert.equal(migrationSourceAuthNeedsServerExchange(platform, mode), contract.exchange.includes(mode), `${platform}/${mode} exchange`);
      assert.equal(migrationSourceAuthNeedsExpiry(platform, mode), contract.expiry.includes(mode), `${platform}/${mode} expiry`);
    }
  }
  assert.equal(MIGRATION_SOURCE_AUTH_POLICIES.webfocus.storedPasswordApprovalRequired, true);
  assert.equal(MIGRATION_SOURCE_AUTH_POLICIES.microstrategy.storedPasswordApprovalRequired, false);
  assert.match(MIGRATION_SOURCE_AUTH_POLICIES.power_bi.guidance, /Fabric API-audience delegated token/i);
  assert.match(MIGRATION_SOURCE_AUTH_POLICIES.power_bi.guidance, /exchange Fabric and Power BI REST audiences separately/i);
  assert.equal(MIGRATION_SOURCE_AUTH_POLICIES.power_bi.manualBoundary.join(' ').includes('Preview'), false);
  assert.match(MIGRATION_SOURCE_AUTH_POLICIES.microstrategy.manualBoundary.join(' '), /Complete dossier visuals, layout, formatting, interactions/i);
});

test('source setup guides cover every source, use registered official links, and preserve manual-only boundaries', () => {
  const sources: MigrationBiSourceTool[] = [
    'domo',
    'looker',
    'metabase',
    'microstrategy',
    'power_bi',
    'sigma',
    'tableau',
    'webfocus',
  ];

  assert.deepEqual(Object.keys(MIGRATION_SOURCE_SETUP_GUIDES).sort(), [...sources].sort());
  assert.deepEqual(
    MIGRATION_SOURCE_SETUP_OPTIONS.map((option) => option.value).sort(),
    [...sources].sort(),
  );

  for (const source of sources) {
    const guide = migrationSourceSetupGuide(source);
    const policy = MIGRATION_SOURCE_AUTH_POLICIES[source];
    const registeredDocumentationUrls = new Set(
      migrationSourceDocumentation(source).map((reference) => reference.url),
    );

    assert.equal(guide.source, source);
    assert.ok(guide.label.trim(), `${source} guide label`);
    assert.ok(guide.availabilityLabel.trim(), `${source} availability label`);
    assert.equal(Boolean(guide.api), policy.availability !== 'manual_only', `${source} API guide availability`);
    assert.equal(guide.manual.mode, 'manual');
    assert.ok(guide.manual.prerequisites.length > 0, `${source} manual prerequisites`);
    assert.ok(guide.manual.steps.length > 0, `${source} manual steps`);
    assert.ok((guide.manual.acceptedArtifacts || []).length > 0, `${source} accepted manual artifacts`);

    for (const path of [guide.api, guide.manual].filter((candidate) => candidate !== undefined)) {
      assert.ok(path.prerequisites.length > 0, `${source}/${path.mode} prerequisites`);
      assert.ok(path.steps.length > 0, `${source}/${path.mode} steps`);
      assert.ok(path.collects.length > 0, `${source}/${path.mode} collected evidence`);
      assert.ok(path.boundaries.length > 0, `${source}/${path.mode} boundaries`);
      assert.ok(path.documentation.length > 0, `${source}/${path.mode} documentation`);
      for (const reference of path.documentation) {
        const url = new URL(reference.url);
        assert.equal(url.protocol, 'https:', `${source}/${path.mode} documentation must use HTTPS`);
        assert.equal(url.username, '', `${source}/${path.mode} documentation URL must not contain credentials`);
        assert.equal(url.password, '', `${source}/${path.mode} documentation URL must not contain credentials`);
        assert.equal(registeredDocumentationUrls.has(reference.url), true, `${source}/${path.mode} documentation must be registered`);
      }
    }
  }

  const webFocusGuide = migrationSourceSetupGuide('webfocus');
  assert.equal(webFocusGuide.api, undefined);
  assert.equal(webFocusGuide.availabilityLabel, 'Manual Files only');
  assert.match(`${webFocusGuide.manual.summary} ${webFocusGuide.manual.boundaries.join(' ')}`, /Saved API.*disabled|zero outbound requests/i);

  const forbiddenValueKeys = new Set(['credential', 'apikey', 'accesstoken', 'clientsecret', 'password']);
  const visit = (value: unknown, path = 'guides'): void => {
    if (!value || typeof value !== 'object') return;
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      assert.equal(forbiddenValueKeys.has(key.toLowerCase().replace(/[^a-z]/g, '')), false, `${path}.${key} must not store a secret value`);
      visit(nested, `${path}.${key}`);
    }
  };
  visit(MIGRATION_SOURCE_SETUP_GUIDES);
  assert.doesNotMatch(JSON.stringify(MIGRATION_SOURCE_SETUP_GUIDES), /Bearer [A-Za-z0-9._~-]{16,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|sk-[A-Za-z0-9_-]{16,}/);
});

test('Looker exchanges API credentials and resolves dashboard queries to compiled Explore evidence', async () => {
  const sourceConnection = connection('looker', 'api_client_credentials', {
    baseUrl: 'https://looker.example.test',
    clientId: 'fixture-looker-client',
    credential: 'fixture-looker-secret',
  });
  const transport = new FixtureTransport((request) => {
    const path = requestPath(request);
    if (path === '/api/4.0/login') {
      assert.equal(request.method, 'POST');
      assert.equal(request.headers?.Authorization, undefined);
      const body = new URLSearchParams(String(request.body));
      assert.equal(body.get('client_id'), 'fixture-looker-client');
      assert.equal(body.get('client_secret'), 'fixture-looker-secret');
      return { body: { access_token: 'fixture-looker-session' } };
    }
    assert.equal(request.headers?.Authorization, 'token fixture-looker-session');
    if (path === '/api/4.0/dashboards/dashboard-1') {
      return {
        body: {
          id: 'dashboard-1',
          title: 'Example dashboard',
          dashboard_elements: [{
            id: 'tile-1',
            query: { model: 'example_model', view: 'orders', fields: ['orders.revenue'] },
          }],
          dashboard_filters: [],
        },
      };
    }
    if (path === '/api/4.0/lookml_models/example_model/explores/orders') {
      return {
        body: {
          name: 'orders',
          view_name: 'orders',
          fields: {
            dimensions: [{ name: 'orders.id', view: 'orders', type: 'number', primary_key: true }],
            measures: [{ name: 'orders.revenue', view: 'orders', type: 'sum' }],
            parameters: [],
          },
          always_filter: [{ name: 'orders.status', value: '-cancelled' }],
          joins: [],
        },
      };
    }
    throw new Error(`Unexpected Looker request: ${request.method || 'GET'} ${path}`);
  });

  const registeredSecrets: string[] = [];
  const result = await prepareLookerEvidence(collectorContext(
    sourceConnection,
    ['dashboard:dashboard-1'],
    transport,
    (value) => registeredSecrets.push(value),
  ));

  assert.deepEqual(transport.requests.map(requestPath), [
    '/api/4.0/login',
    '/api/4.0/dashboards/dashboard-1',
    '/api/4.0/lookml_models/example_model/explores/orders',
  ]);
  assert.deepEqual(registeredSecrets, ['fixture-looker-session']);
  assert.equal(result.status, 'partial');
  assert.equal(result.evidenceContract.collection.complete, true);
  assert.equal(result.evidenceContract.dependencyClosure.status, 'partial');
  assert.ok(result.dependencies.some((dependency) => dependency.sourceId === 'looker:compiled-explore:example_model/orders' && dependency.status === 'resolved'));
  assert.ok(result.dependencies.some((dependency) => dependency.status === 'manual_required' && /raw LookML/i.test(dependency.reason)));
  assert.equal(result.inventory.explores[0]?.name, 'orders');
  assert.deepEqual(result.inventory.explores[0]?.filters, ['orders.status: -cancelled']);
  assert.equal(result.artifacts.some((artifact) => artifact.locator === 'compiled-explore:example_model/orders'), true);
  assertSecretsAbsent(result, 'fixture-looker-secret', 'fixture-looker-session');
});

test('Looker blocks an unresolved non-text dashboard tile while accepting text tiles', async () => {
  const sourceConnection = connection('looker', 'api_client_credentials', {
    baseUrl: 'https://looker.example.test',
    clientId: 'fixture-looker-client',
    credential: 'fixture-looker-secret',
  });
  const transport = new FixtureTransport((request) => {
    const path = requestPath(request);
    if (path === '/api/4.0/login') return { body: { access_token: 'fixture-looker-session' } };
    if (path === '/api/4.0/dashboards/dashboard-unresolved') {
      return {
        body: {
          id: 'dashboard-unresolved',
          title: 'Dashboard with unresolved logic',
          dashboard_elements: [
            { id: 'text-tile', type: 'text', body_text: 'Context only' },
            { id: 'visual-tile', type: 'vis', title: 'Revenue without query' },
          ],
          dashboard_filters: [],
        },
      };
    }
    throw new Error(`Unexpected Looker request: ${request.method || 'GET'} ${path}`);
  });

  const result = await prepareLookerEvidence(collectorContext(
    sourceConnection,
    ['dashboard:dashboard-unresolved'],
    transport,
  ));

  assert.equal(result.status, 'failed');
  assert.equal(result.evidenceContract.collection.complete, false);
  assert.equal(result.dependencies.some((dependency) => dependency.dependencySourceId.endsWith('/text-tile')), false);
  assert.ok(result.dependencies.some((dependency) => dependency.dependencySourceId.endsWith('/visual-tile')
    && dependency.required
    && dependency.status === 'manual_required'
    && /exact tile query/i.test(dependency.reason)));
  assertSecretsAbsent(result, 'fixture-looker-secret', 'fixture-looker-session');
});

test('Looker discovery paginates dashboards and Looks until an explicit terminal page', async () => {
  const sourceConnection = connection('looker', 'api_client_credentials', {
    baseUrl: 'https://looker.example.test',
    clientId: 'fixture-looker-client',
    credential: 'fixture-looker-secret',
  });
  const dashboards = Array.from({ length: 201 }, (_, index) => ({ id: `dashboard-${index + 1}`, title: `Dashboard ${index + 1}` }));
  const looks = Array.from({ length: 200 }, (_, index) => ({ id: `look-${index + 1}`, title: `Look ${index + 1}` }));
  const transport = new FixtureTransport((request) => {
    const url = new URL(request.url);
    if (url.pathname === '/api/4.0/login') return { body: { access_token: 'fixture-looker-session' } };
    if (url.pathname === '/api/4.0/projects' || url.pathname === '/api/4.0/lookml_models') return { body: [] };
    const offset = Number(url.searchParams.get('offset') || 0);
    if (url.pathname === '/api/4.0/dashboards/search') {
      assert.equal(url.searchParams.get('deleted'), 'false');
      assert.equal(url.searchParams.get('limit'), '200');
      assert.equal(url.searchParams.get('sorts'), 'id');
      return { body: dashboards.slice(offset, offset + 200) };
    }
    if (url.pathname === '/api/4.0/looks/search') {
      assert.equal(url.searchParams.get('deleted'), 'false');
      assert.equal(url.searchParams.get('limit'), '200');
      assert.equal(url.searchParams.get('sorts'), 'id');
      return { body: looks.slice(offset, offset + 200) };
    }
    throw new Error(`Unexpected Looker discovery request: ${request.method || 'GET'} ${requestPath(request)}`);
  });

  const result = await listLookerDiscoveryInventory(collectorContext(sourceConnection, [], transport));

  assert.equal(result.diagnostics.truncated, false);
  assert.equal(result.diagnostics.pagesFetched, 6);
  assert.equal(result.items.filter((item) => item.kind === 'dashboard').length, 201);
  assert.equal(result.items.filter((item) => item.kind === 'report').length, 200);
  assert.equal(transport.requests.some((request) => requestPath(request) === '/api/4.0/dashboards/search?deleted=false&limit=200&offset=200&sorts=id'), true);
  assert.equal(transport.requests.some((request) => requestPath(request) === '/api/4.0/looks/search?deleted=false&limit=200&offset=200&sorts=id'), true);
  assert.equal(transport.requests.some((request) => new URL(request.url).pathname === '/api/4.0/dashboards'), false);
  assert.equal(transport.requests.some((request) => new URL(request.url).pathname === '/api/4.0/looks'), false);
});

test('Sigma exchanges client credentials and closes workbook references with authoritative Data Model specs', async () => {
  const sourceConnection = connection('sigma', 'oauth_client_credentials', {
    baseUrl: 'https://api.sigmacomputing.example.test',
    clientId: 'fixture-sigma-client',
    credential: 'fixture-sigma-secret',
  });
  const transport = new FixtureTransport((request) => {
    const path = requestPath(request);
    if (path === '/v2/auth/token') {
      assert.equal(request.method, 'POST');
      const body = new URLSearchParams(String(request.body));
      assert.equal(body.get('grant_type'), 'client_credentials');
      assert.equal(body.get('client_id'), 'fixture-sigma-client');
      assert.equal(body.get('client_secret'), 'fixture-sigma-secret');
      return { body: { access_token: 'fixture-sigma-session' } };
    }
    assert.equal(request.headers?.Authorization, 'Bearer fixture-sigma-session');
    if (path === '/v2/workbooks/workbook-1') {
      return { body: { workbookId: 'workbook-1', name: 'Example workbook' } };
    }
    if (path === '/v2/dataModels/model-1/spec?format=json') {
      return { body: { elements: [{ elementId: 'orders', type: 'table', name: 'Orders' }] } };
    }
    if (path === '/v2/dataModels/model-1/columns?limit=100') {
      return { body: { entries: [{ elementId: 'orders', columnId: 'revenue', name: 'Revenue', dataType: 'number', formula: 'Sum([Revenue])' }] } };
    }
    if (path === '/v2/workbooks/workbook-1/lineage?limit=100') {
      return {
        body: {
          entries: [
            { type: 'table', datasourceId: 'warehouse-datasource-1', sourceId: 'physical-source-1', inodeId: 'physical-inode-1' },
            { dataModelId: 'model-1', sourceId: 'lineage-edge-1', inodeId: 'lineage-inode-1' },
          ],
        },
      };
    }
    if (
      path === '/v2/workbooks/workbook-1/pages?limit=100'
      || path === '/v2/workbooks/workbook-1/controls?limit=100'
      || path === '/v2/workbooks/workbook-1/schedules?limit=100'
      || path === '/v2/workbooks/workbook-1/materialization-schedules?limit=100'
      || path === '/v2/dataModels/model-1/sources?pageSize=100'
      || path === '/v2/dataModels/model-1/lineage?limit=100'
      || path === '/v2/dataModels/model-1/materializationSchedules?pageSize=100'
      || path === '/v2/grants?inodeId=workbook-1&directGrantsOnly=true&limit=100'
      || path === '/v2/grants?inodeId=model-1&directGrantsOnly=true&limit=100'
    ) return { body: { entries: [] } };
    throw new Error(`Unexpected Sigma request: ${request.method || 'GET'} ${path}`);
  });

  const registeredSecrets: string[] = [];
  const result = await prepareSigmaEvidence(collectorContext(
    sourceConnection,
    ['workbook:workbook-1'],
    transport,
    (value) => registeredSecrets.push(value),
  ));

  assert.deepEqual(registeredSecrets, ['fixture-sigma-session']);
  assert.equal(transport.requests.some((request) => requestPath(request) === '/v2/dataModels/model-1/spec?format=json'), true);
  assert.equal(transport.requests.some((request) => requestPath(request).startsWith('/v2/dataModels/warehouse-datasource-1/')), false);
  assert.equal(transport.requests.some((request) => requestPath(request).startsWith('/v2/dataModels/physical-source-1/')), false);
  assert.equal(transport.requests.some((request) => requestPath(request).startsWith('/v2/dataModels/physical-inode-1/')), false);
  assert.equal(transport.requests.some((request) => requestPath(request).startsWith('/v2/dataModels/lineage-edge-1/')), false);
  assert.equal(transport.requests.some((request) => requestPath(request).startsWith('/v2/dataModels/lineage-inode-1/')), false);
  assert.equal(result.status, 'partial');
  assert.equal(result.evidenceContract.collection.complete, true);
  assert.equal(result.evidenceContract.dependencyClosure.missingCount, 0);
  assert.equal(result.evidenceContract.dependencyClosure.status, 'partial');
  assert.ok(result.dependencies.some((dependency) => dependency.dependencySourceId === 'sigma:data-model:model-1' && dependency.status === 'resolved'));
  assert.ok(result.artifacts.some((artifact) => artifact.sourceId === 'sigma:data-model:model-1' && artifact.evidenceClass === 'authoritative_definition'));
  assertSecretsAbsent(result, 'fixture-sigma-secret', 'fixture-sigma-session');
});

test('Sigma honors endpoint-specific pagination and preserves one-to-one relationships and nested column types', async () => {
  const sourceConnection = connection('sigma', 'oauth_client_credentials', {
    baseUrl: 'https://api.sigmacomputing.example.test',
    clientId: 'fixture-sigma-client',
    credential: 'fixture-sigma-secret',
  });
  const transport = new FixtureTransport((request) => {
    const path = requestPath(request);
    if (path === '/v2/auth/token') return { body: { access_token: 'fixture-sigma-session' } };
    if (path === '/v2/dataModels/model-1/spec?format=json') {
      return {
        body: {
          elements: [
            { elementId: 'orders', type: 'table', name: 'Orders' },
            { elementId: 'order-details', type: 'table', name: 'Order Details' },
          ],
          relationships: [{
            relationshipId: 'orders-to-details',
            fromElementId: 'orders',
            targetElementId: 'order-details',
            relationshipType: '1:1',
            keys: [{ sourceColumnId: 'order-id', targetColumnId: 'detail-order-id' }],
          }],
        },
      };
    }
    if (path === '/v2/dataModels/model-1/sources?pageSize=100') {
      return { body: { entries: [{ sourceId: 'source-1' }], nextPageToken: 'source-page-2' } };
    }
    if (path === '/v2/dataModels/model-1/sources?pageSize=100&pageToken=source-page-2') {
      return { body: { entries: [{ sourceId: 'source-2' }] } };
    }
    if (path === '/v2/dataModels/model-1/columns?limit=100') {
      return {
        body: {
          entries: [{
            elementId: 'orders',
            columnId: 'order-id',
            name: 'Order ID',
            dataType: { type: 'decimal', nullable: false, parameters: { scale: 2, precision: 12 } },
          }],
          nextPage: 'column-page-2',
        },
      };
    }
    if (path === '/v2/dataModels/model-1/columns?limit=100&page=column-page-2') {
      return { body: { entries: [{ elementId: 'order-details', columnId: 'detail-order-id', name: 'Order ID', dataType: 'integer' }], nextPage: null } };
    }
    if (
      path === '/v2/dataModels/model-1/lineage?limit=100'
      || path === '/v2/dataModels/model-1/materializationSchedules?pageSize=100'
      || path === '/v2/grants?inodeId=model-1&directGrantsOnly=true&limit=100'
    ) return { body: { entries: [] } };
    throw new Error(`Unexpected Sigma pagination request: ${request.method || 'GET'} ${path}`);
  });

  const result = await prepareSigmaEvidence(collectorContext(sourceConnection, ['data_model:model-1'], transport));

  assert.equal(result.status, 'complete');
  assert.equal(result.evidenceContract.collection.complete, true);
  assert.equal(result.evidenceContract.dependencyClosure.status, 'complete');
  assert.equal(transport.requests.some((request) => requestPath(request) === '/v2/dataModels/model-1/sources?pageSize=100&pageToken=source-page-2'), true);
  assert.equal(transport.requests.some((request) => requestPath(request) === '/v2/dataModels/model-1/columns?limit=100&page=column-page-2'), true);
  assert.equal(transport.requests.some((request) => requestPath(request).includes('/sources?limit=')), false);
  const orderId = result.inventory.views.find((view) => view.name === 'Orders')?.fields.find((field) => field.name === 'Order ID');
  assert.equal(orderId?.type, '{"nullable":false,"parameters":{"precision":12,"scale":2},"type":"decimal"}');
  assert.equal(result.inventory.relationships.find((relationship) => relationship.sourceId === 'sigma:relationship:orders-to-details')?.relationshipType, 'one_to_one');
  assertSecretsAbsent(result, 'fixture-sigma-secret', 'fixture-sigma-session');
});

test('Sigma rejects an unrecognized HTTP-200 list envelope', async () => {
  const sourceConnection = connection('sigma', 'oauth_client_credentials', {
    baseUrl: 'https://api.sigmacomputing.example.test',
    clientId: 'fixture-sigma-client',
    credential: 'fixture-sigma-secret',
  });
  const transport = new FixtureTransport((request) => {
    const path = requestPath(request);
    if (path === '/v2/auth/token') return { body: { access_token: 'fixture-sigma-session' } };
    if (path === '/v2/dataModels/model-1/spec?format=json') return { body: { elements: [{ elementId: 'orders', type: 'table', name: 'Orders' }] } };
    if (path === '/v2/dataModels/model-1/sources?pageSize=100') return { body: { unexpected: [] } };
    if (
      path === '/v2/dataModels/model-1/columns?limit=100'
      || path === '/v2/dataModels/model-1/lineage?limit=100'
      || path === '/v2/dataModels/model-1/materializationSchedules?pageSize=100'
      || path === '/v2/grants?inodeId=model-1&directGrantsOnly=true&limit=100'
    ) return { body: { entries: [] } };
    throw new Error(`Unexpected Sigma strict-envelope request: ${request.method || 'GET'} ${path}`);
  });

  await assert.rejects(
    () => prepareSigmaEvidence(collectorContext(sourceConnection, ['data_model:model-1'], transport)),
    /unrecognized success response/i,
  );
});

test('Sigma rejects an empty page that reports a continuation', async () => {
  const sourceConnection = connection('sigma', 'oauth_client_credentials', {
    baseUrl: 'https://api.sigmacomputing.example.test',
    clientId: 'fixture-sigma-client',
    credential: 'fixture-sigma-secret',
  });
  const transport = new FixtureTransport((request) => {
    const path = requestPath(request);
    if (path === '/v2/auth/token') return { body: { access_token: 'fixture-sigma-session' } };
    if (path === '/v2/dataModels/model-1/spec?format=json') return { body: { elements: [{ elementId: 'orders', type: 'table', name: 'Orders' }] } };
    if (path === '/v2/dataModels/model-1/sources?pageSize=100') return { body: { entries: [], nextPageToken: 'repeat-me' } };
    if (
      path === '/v2/dataModels/model-1/columns?limit=100'
      || path === '/v2/dataModels/model-1/lineage?limit=100'
      || path === '/v2/dataModels/model-1/materializationSchedules?pageSize=100'
      || path === '/v2/grants?inodeId=model-1&directGrantsOnly=true&limit=100'
    ) return { body: { entries: [] } };
    throw new Error(`Unexpected Sigma empty-page request: ${request.method || 'GET'} ${path}`);
  });

  await assert.rejects(
    () => prepareSigmaEvidence(collectorContext(sourceConnection, ['data_model:model-1'], transport)),
    /empty page while reporting another page/i,
  );
});

test('Metabase uses API-key auth, recursively closes nested questions, and preserves native SQL and MBQL', async () => {
  const sourceConnection = connection('metabase', 'api_key', {
    baseUrl: 'https://metabase.example.test',
    credential: 'fixture-metabase-key',
  });
  const transport = new FixtureTransport((request) => {
    assert.equal(request.headers?.['X-API-KEY'], 'fixture-metabase-key');
    const path = requestPath(request);
    if (path === '/api/dashboard/1') {
      return { body: jsonText({ id: 1, name: 'Example dashboard', dashcards: [{ card_id: 10 }] }) };
    }
    if (path === '/api/card/10') {
      return {
        body: jsonText({
          id: 10,
          name: 'Nested question',
          dataset_query: { type: 'query', query: { 'source-table': 'card__20', fields: [['field', 1, null]] } },
        }),
      };
    }
    if (path === '/api/card/20') {
      return {
        body: jsonText({
          id: 20,
          name: 'SQL question',
          dataset_query: { type: 'native', native: { query: 'select order_id, revenue from example_orders' } },
        }),
      };
    }
    throw new Error(`Unexpected Metabase request: ${request.method || 'GET'} ${path}`);
  });

  const result = await prepareMetabaseEvidence(collectorContext(sourceConnection, ['dashboard:1'], transport));

  assert.deepEqual(transport.requests.map(requestPath), ['/api/dashboard/1', '/api/card/10', '/api/card/20']);
  assert.equal(result.status, 'partial');
  assert.equal(result.evidenceContract.collection.complete, true);
  assert.equal(result.evidenceContract.dependencyClosure.missingCount, 0);
  assert.equal(result.evidenceContract.dependencyClosure.status, 'partial');
  assert.ok(result.dependencies.some((dependency) => (
    dependency.sourceId === 'metabase:card:10'
      && dependency.dependencySourceId === 'metabase:card:20'
      && dependency.status === 'resolved'
  )));
  const nestedQuery = result.inventory.views.find((view) => view.sourceId === 'metabase:card:10:query');
  const nativeQuery = result.inventory.views.find((view) => view.sourceId === 'metabase:card:20:query');
  assert.equal(nestedQuery?.annotations?.queryLanguage, 'mbql');
  assert.match(nestedQuery?.sql || '', /source-table/);
  assert.equal(nativeQuery?.annotations?.queryLanguage, 'native_sql');
  assert.equal(nativeQuery?.sql, 'select order_id, revenue from example_orders');
  assertSecretsAbsent(result, 'fixture-metabase-key');
});

test('Metabase securely parses selected collection YAML into stable, exact-provenance migration evidence', async () => {
  const collectionEntityId = 'cOlLeCtIoN00000000001';
  const cardEntityId = 'cArD00000000000000001';
  const dashboardEntityId = 'dAsHbOaRd000000000001';
  const archive = gzipTar([
    {
      path: 'collections/main/sales.yaml',
      content: `name: Sales\nentity_id: ${collectionEntityId}\nserdes/meta:\n- id: ${collectionEntityId}\n  label: sales\n  model: Collection\n`,
    },
    {
      path: 'collections/main/sales/orders_model.yaml',
      content: `name: Orders model\nentity_id: ${cardEntityId}\ncreator_id: analyst@example.test\ndisplay: table\ntype: model\ndataset_query:\n  lib/type: mbql/query\n  database: Sample Database\n  stages:\n  - lib/type: mbql.stage/mbql\n    source-table:\n    - Sample Database\n    - PUBLIC\n    - ORDERS\nvisualization_settings: {}\nparameters:\n- id: region-filter\n  name: Region\n  slug: region\n  type: string/=\ncollection_id: ${collectionEntityId}\nserdes/meta:\n- id: ${cardEntityId}\n  label: orders_model\n  model: Card\n`,
    },
    {
      path: 'collections/main/sales/orders_dashboard.yaml',
      content: `name: Orders dashboard\nentity_id: ${dashboardEntityId}\ncreator_id: analyst@example.test\ncollection_id: ${collectionEntityId}\nparameters:\n- id: region-filter\n  name: Region\n  slug: region\n  type: string/=\ntabs:\n- entity_id: tAb000000000000000001\n  name: Overview\n  position: 0\ndashcards:\n- entity_id: dAsHcArD000000000001\n  card_id: ${cardEntityId}\n  dashboard_tab_id: tAb000000000000000001\n  row: 0\n  col: 0\n  size_x: 12\n  size_y: 6\n  parameter_mappings: []\n  visualization_settings: {}\n  serdes/meta:\n  - id: ${dashboardEntityId}\n    model: Dashboard\n  - id: dAsHcArD000000000001\n    model: DashboardCard\nserdes/meta:\n- id: ${dashboardEntityId}\n  label: orders_dashboard\n  model: Dashboard\n`,
    },
  ]);
  const sourceConnection = connection('metabase', 'api_key', {
    baseUrl: 'https://metabase.example.test',
    credential: 'fixture-metabase-key',
  });
  const transport = new FixtureTransport((request) => {
    assert.equal(request.headers?.['X-API-KEY'], 'fixture-metabase-key');
    assert.equal(request.method, 'POST');
    assert.equal(requestPath(request), '/api/ee/serialization/export?collection=42&settings=false&data_model=false');
    return { body: archive };
  });

  const result = await prepareMetabaseEvidence(collectorContext(sourceConnection, ['collection:42'], transport));

  assert.equal(result.status, 'partial');
  assert.equal(result.evidenceContract.collection.complete, true);
  assert.equal(result.evidenceContract.dependencyClosure.status, 'partial');
  assert.equal(result.evidenceContract.dependencyClosure.missingCount, 0);
  assert.ok(result.dependencies.some((dependency) => (
    dependency.sourceId === `metabase:dashboard:${dashboardEntityId}`
      && dependency.dependencySourceId === `metabase:card:${cardEntityId}`
      && dependency.status === 'resolved'
  )));
  assert.ok(result.dependencies.some((dependency) => (
    dependency.sourceId === `metabase:card:${cardEntityId}`
      && dependency.dependencySourceId === `metabase:collection-entity:${collectionEntityId}`
      && dependency.status === 'resolved'
  )));
  const cardArtifact = result.artifacts.find((artifact) => artifact.sourceId === `metabase:card:${cardEntityId}`);
  assert.equal(cardArtifact?.locator, 'serialization:collections/main/sales/orders_model.yaml');
  assert.equal(cardArtifact?.mediaType, 'application/yaml');
  const query = result.inventory.views.find((view) => view.sourceId === `metabase:card:${cardEntityId}:query`);
  assert.equal(query?.annotations?.queryLanguage, 'mbql');
  assert.match(query?.annotations?.queryDefinition || '', /Sample Database/);
  assert.equal(query?.sourceArtifact, cardArtifact?.locator);
  assert.equal(query?.sourceEvidence?.[0]?.artifactId, cardArtifact?.id);
  assert.equal(query?.sourceEvidence?.[0]?.artifactSha256, cardArtifact?.sha256);
  const dashboard = result.inventory.dashboards.find((item) => item.sourceId === `metabase:dashboard:${dashboardEntityId}`);
  assert.match(String(dashboard?.metadata?.metabaseDefinition || ''), /dashcards/);
  assert.equal(dashboard?.filters.includes('Region'), true);
  assert.equal(JSON.stringify(result).includes('analyst@example.test'), false, 'user references are not portable migration evidence');
  assertSecretsAbsent(result, 'fixture-metabase-key');
});

test('Metabase marks unsupported serialized collection entities manual and blocked instead of resolved', async () => {
  const collectionEntityId = 'cOlLeCtIoN00000000001';
  const documentEntityId = 'dOcUmEnT0000000000001';
  const archive = gzipTar([
    {
      path: 'collections/main/sales.yaml',
      content: `name: Sales\nentity_id: ${collectionEntityId}\nserdes/meta:\n- id: ${collectionEntityId}\n  label: sales\n  model: Collection\n`,
    },
    {
      path: 'collections/main/sales/unsupported_document.yaml',
      content: `name: Unsupported document\nentity_id: ${documentEntityId}\ncreator_id: analyst@example.test\ndocument:\n  type: doc\n  content: []\ncollection_id: ${collectionEntityId}\nserdes/meta:\n- id: ${documentEntityId}\n  label: unsupported_document\n  model: Document\n`,
    },
  ]);
  const sourceConnection = connection('metabase', 'api_key', {
    baseUrl: 'https://metabase.example.test',
    credential: 'fixture-metabase-key',
  });
  const transport = new FixtureTransport((request) => {
    assert.equal(request.method, 'POST');
    assert.equal(requestPath(request), '/api/ee/serialization/export?collection=42&settings=false&data_model=false');
    return { body: archive };
  });

  const result = await prepareMetabaseEvidence(collectorContext(sourceConnection, ['collection:42'], transport));

  assert.equal(result.status, 'manual_required');
  assert.equal(result.evidenceContract.collection.complete, false);
  assert.equal(result.evidenceContract.dependencyClosure.status, 'blocked');
  assert.ok(result.dependencies.some((dependency) => dependency.sourceId === 'metabase:collection:42' && dependency.status === 'manual_required'));
  assert.equal(result.dependencies.some((dependency) => dependency.sourceId === 'metabase:collection:42' && dependency.status === 'resolved'), false);
  assert.match(result.diagnostics.manualRequirements.join(' '), /unsupported model Document/i);
  assert.equal(result.artifacts.some((artifact) => artifact.sourceId === `metabase:document:${documentEntityId}`), false);
  assert.equal(result.inventory.views.length, 0);
  assert.equal(result.inventory.dashboards.length, 0);
  assert.equal(JSON.stringify(result).includes('analyst@example.test'), false);
  assertSecretsAbsent(result, 'fixture-metabase-key');
});

async function prepareTableauSubscriptionScenario(
  subscriptionPage: (pageNumber: number) => unknown,
): Promise<{ result: MigrationPreparedEvidenceResult; transport: FixtureTransport }> {
  const sourceConnection = connection('tableau', 'personal_access_token', {
    baseUrl: 'https://tableau.example.test',
    username: 'fixture-pat-name',
    credential: 'fixture-pat-secret',
    siteId: 'example-site',
  });
  const xml = new TextEncoder().encode('<?xml version="1.0"?><workbook><datasources /></workbook>');
  const transport = new FixtureTransport((request) => {
    const path = requestPath(request);
    if (path === '/api/3.29/auth/signin') {
      return { body: { credentials: { token: 'fixture-tableau-session', site: { id: 'site-uuid', contentUrl: 'example-site' } } } };
    }
    if (path === '/api/3.29/sites/site-uuid/workbooks/workbook-1/content?includeExtract=False') {
      return { body: xml, headers: { 'content-disposition': 'attachment; filename="example.twb"' } };
    }
    if (path === '/api/metadata/graphql') return { body: { data: { workbooks: [] } } };
    if (path === '/api/3.29/sites/site-uuid/workbooks/workbook-1/permissions') return { body: { permissions: {} } };
    if (path === '/api/3.29/sites/site-uuid/workbooks/workbook-1/connections') return { body: { connections: {} } };
    if (path === '/api/3.29/sites/site-uuid/tasks/extractRefreshes') return { body: { tasks: {} } };
    if (path.startsWith('/api/3.29/sites/site-uuid/subscriptions?pageSize=1000&pageNumber=')) {
      return { body: subscriptionPage(Number(new URL(request.url).searchParams.get('pageNumber'))) };
    }
    if (path === '/api/3.29/auth/signout') return { status: 204, body: '' };
    throw new Error(`Unexpected Tableau integrity request: ${request.method || 'GET'} ${path}`);
  });
  return {
    result: await prepareTableauEvidence(collectorContext(sourceConnection, ['workbook:workbook-1'], transport)),
    transport,
  };
}

test('Tableau discovery rejects malformed HTTP-200 envelopes and item records without losing valid empty catalogs', async () => {
  const sourceConnection = connection('tableau', 'personal_access_token', {
    baseUrl: 'https://tableau.example.test',
    username: 'fixture-pat-name',
    credential: 'fixture-pat-secret',
    siteId: 'example-site',
  });
  const transport = new FixtureTransport((request) => {
    const path = requestPath(request);
    if (path === '/api/3.29/auth/signin') {
      return { body: { credentials: { token: 'fixture-tableau-session', site: { id: 'site-uuid', contentUrl: 'example-site' } } } };
    }
    if (path.startsWith('/api/3.29/sites/site-uuid/projects?')) return { body: {} };
    if (path.startsWith('/api/3.29/sites/site-uuid/workbooks?')) {
      return { body: { workbooks: { workbook: [{ id: 'workbook-without-name' }] } } };
    }
    if (path.startsWith('/api/3.29/sites/site-uuid/views?')) return { body: { views: [] } };
    if (path.startsWith('/api/3.29/sites/site-uuid/datasources?')) return { body: { datasources: {} } };
    if (path === '/api/3.29/auth/signout') return { status: 204, body: '' };
    throw new Error(`Unexpected Tableau discovery integrity request: ${request.method || 'GET'} ${path}`);
  });

  const result = await discoverTableauSource(sourceConnection, transport);

  assert.equal(result.complete, false);
  assert.deepEqual(result.items, []);
  assert.equal(result.warnings.length, 3);
  assert.match(result.warnings.join(' '), /unrecognized HTTP-200 envelope/i);
  assert.match(result.warnings.join(' '), /invalid item record at index 0/i);
  assert.match(result.warnings.join(' '), /malformed views container/i);
  assert.equal(result.warnings.some((warning) => /data source/i.test(warning)), false, 'documented empty container remains valid');
  assertSecretsAbsent(result, 'fixture-pat-secret', 'fixture-tableau-session');
});

test('Tableau discovery preserves documented empty envelopes as a verified empty catalog', async () => {
  const sourceConnection = connection('tableau', 'personal_access_token', {
    baseUrl: 'https://tableau.example.test',
    username: 'fixture-pat-name',
    credential: 'fixture-pat-secret',
    siteId: 'example-site',
  });
  const containers: Record<string, string> = {
    projects: 'projects',
    workbooks: 'workbooks',
    views: 'views',
    datasources: 'datasources',
  };
  const transport = new FixtureTransport((request) => {
    const path = requestPath(request);
    if (path === '/api/3.29/auth/signin') {
      return { body: { credentials: { token: 'fixture-tableau-session', site: { id: 'site-uuid', contentUrl: 'example-site' } } } };
    }
    for (const endpoint of Object.keys(containers)) {
      if (path.startsWith(`/api/3.29/sites/site-uuid/${endpoint}?`)) return { body: { [containers[endpoint]!]: {} } };
    }
    if (path === '/api/3.29/auth/signout') return { status: 204, body: '' };
    throw new Error(`Unexpected Tableau empty discovery request: ${request.method || 'GET'} ${path}`);
  });

  const result = await discoverTableauSource(sourceConnection, transport);

  assert.equal(result.complete, true);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.warnings, []);
  assertSecretsAbsent(result, 'fixture-pat-secret', 'fixture-tableau-session');
});

test('Tableau exchanges a PAT for an ephemeral session and downloads definition XML without extracts', async () => {
  const sourceConnection = connection('tableau', 'personal_access_token', {
    baseUrl: 'https://tableau.example.test',
    username: 'fixture-pat-name',
    credential: 'fixture-pat-secret',
    siteId: 'example-site',
  });
  const xml = new TextEncoder().encode('<?xml version="1.0"?><workbook><datasources /></workbook>');
  const transport = new FixtureTransport((request) => {
    const path = requestPath(request);
    if (path === '/api/3.29/auth/signin') {
      assert.equal(request.method, 'POST');
      const body = JSON.parse(String(request.body)) as {
        credentials: { personalAccessTokenName: string; personalAccessTokenSecret: string; site: { contentUrl: string } };
      };
      assert.deepEqual(body.credentials, {
        personalAccessTokenName: 'fixture-pat-name',
        personalAccessTokenSecret: 'fixture-pat-secret',
        site: { contentUrl: 'example-site' },
      });
      return {
        body: {
          credentials: {
            token: 'fixture-tableau-session',
            site: { id: 'site-uuid', contentUrl: 'example-site' },
            user: { id: 'user-1' },
          },
        },
      };
    }
    assert.equal(request.headers?.['X-Tableau-Auth'], 'fixture-tableau-session');
    if (path === '/api/3.29/sites/site-uuid/workbooks/workbook-1/content?includeExtract=False') {
      return { body: xml, headers: { 'content-disposition': 'attachment; filename="example.twb"' } };
    }
    if (path === '/api/metadata/graphql') return { body: { data: { workbooks: [] } } };
    if (path === '/api/3.29/sites/site-uuid/workbooks/workbook-1/permissions') return { body: { permissions: {} } };
    if (path === '/api/3.29/sites/site-uuid/workbooks/workbook-1/connections') return { body: { connections: {} } };
    if (path === '/api/3.29/sites/site-uuid/tasks/extractRefreshes') return { body: { tasks: {} } };
    if (path === '/api/3.29/sites/site-uuid/subscriptions?pageSize=1000&pageNumber=1') return { body: { subscriptions: {} } };
    if (path === '/api/3.29/auth/signout') return { status: 204, body: '' };
    throw new Error(`Unexpected Tableau request: ${request.method || 'GET'} ${path}`);
  });

  const registeredSecrets: string[] = [];
  const result = await prepareTableauEvidence(collectorContext(
    sourceConnection,
    ['workbook:workbook-1'],
    transport,
    (value) => registeredSecrets.push(value),
  ));

  assert.deepEqual(registeredSecrets, ['fixture-tableau-session']);
  assert.equal(transport.requests.some((request) => requestPath(request).endsWith('/content?includeExtract=False')), true);
  assert.equal(transport.requests.at(-1)?.method, 'POST');
  assert.equal(requestPath(transport.requests.at(-1)!), '/api/3.29/auth/signout');
  assert.equal(result.status, 'complete');
  assert.equal(result.evidenceContract.collection.complete, true);
  assert.equal(result.evidenceContract.dependencyClosure.status, 'complete');
  assert.equal(result.artifacts.some((artifact) => artifact.sourceId === 'tableau:workbook:workbook-1'), true);
  assert.equal(result.inventory.artifacts.length, 0, 'raw XML must remain server-side');
  assertSecretsAbsent(result, 'fixture-pat-secret', 'fixture-tableau-session');
});

test('Tableau excludes malformed optional HTTP-200 evidence and records explicit governance gaps', async () => {
  const sourceConnection = connection('tableau', 'personal_access_token', {
    baseUrl: 'https://tableau.example.test',
    username: 'fixture-pat-name',
    credential: 'fixture-pat-secret',
    siteId: 'example-site',
  });
  const xml = new TextEncoder().encode('<?xml version="1.0"?><workbook><datasources /></workbook>');
  const transport = new FixtureTransport((request) => {
    const path = requestPath(request);
    if (path === '/api/3.29/auth/signin') {
      return { body: { credentials: { token: 'fixture-tableau-session', site: { id: 'site-uuid', contentUrl: 'example-site' } } } };
    }
    if (path === '/api/3.29/sites/site-uuid/workbooks/workbook-1/content?includeExtract=False') {
      return { body: xml, headers: { 'content-disposition': 'attachment; filename="example.twb"' } };
    }
    if (path === '/api/metadata/graphql') return { body: { ok: true } };
    if (path === '/api/3.29/sites/site-uuid/workbooks/workbook-1/permissions') return { body: { permissions: [] } };
    if (path === '/api/3.29/sites/site-uuid/workbooks/workbook-1/connections') {
      return { body: { connections: { connection: [null] } } };
    }
    if (path === '/api/3.29/sites/site-uuid/tasks/extractRefreshes') return { body: { tasks: { task: 'invalid' } } };
    if (path === '/api/3.29/sites/site-uuid/subscriptions?pageSize=1000&pageNumber=1') return { body: { subscriptions: [] } };
    if (path === '/api/3.29/auth/signout') return { status: 204, body: '' };
    throw new Error(`Unexpected Tableau malformed optional request: ${request.method || 'GET'} ${path}`);
  });

  const result = await prepareTableauEvidence(collectorContext(sourceConnection, ['workbook:workbook-1'], transport));
  const sourceIds = new Set(result.artifacts.map((artifact) => artifact.sourceId));

  assert.equal(result.status, 'bounded');
  assert.equal(result.evidenceContract.collection.complete, false);
  assert.equal(result.evidenceContract.dependencyClosure.status, 'partial');
  assert.equal(result.diagnostics.truncated, true);
  assert.equal(sourceIds.has('tableau:workbook:workbook-1'), true);
  assert.equal(sourceIds.has('tableau:site:site-uuid'), false);
  assert.equal(sourceIds.has('tableau:workbook:workbook-1:permissions'), false);
  assert.equal(sourceIds.has('tableau:workbook:workbook-1:connections'), false);
  assert.equal(sourceIds.has('tableau:site:site-uuid:extract-refreshes'), false);
  assert.equal(sourceIds.has('tableau:site:site-uuid:subscriptions'), false);
  assert.match(result.diagnostics.permissionGaps.join(' '), /permissions.*not trusted/i);
  assert.match(result.diagnostics.warnings.join(' '), /Metadata API.*unrecognized HTTP-200 envelope/i);
  assert.match(result.diagnostics.warnings.join(' '), /connections.*invalid item record/i);
  assert.match(result.diagnostics.warnings.join(' '), /extract refresh tasks.*malformed task collection/i);
  assert.match(result.diagnostics.warnings.join(' '), /subscriptions.*malformed subscriptions container/i);
  assertSecretsAbsent(result, 'fixture-pat-secret', 'fixture-tableau-session');
});

test('Tableau paginates subscriptions until documented terminal metadata', async () => {
  const sourceConnection = connection('tableau', 'personal_access_token', {
    baseUrl: 'https://tableau.example.test',
    username: 'fixture-pat-name',
    credential: 'fixture-pat-secret',
    siteId: 'example-site',
  });
  const xml = new TextEncoder().encode('<?xml version="1.0"?><workbook><datasources /></workbook>');
  const firstPage = Array.from({ length: 1_000 }, (_, index) => ({ id: `subscription-${index + 1}` }));
  const transport = new FixtureTransport((request) => {
    const path = requestPath(request);
    if (path === '/api/3.29/auth/signin') {
      return { body: { credentials: { token: 'fixture-tableau-session', site: { id: 'site-uuid', contentUrl: 'example-site' } } } };
    }
    if (path === '/api/3.29/sites/site-uuid/workbooks/workbook-1/content?includeExtract=False') {
      return { body: xml, headers: { 'content-disposition': 'attachment; filename="example.twb"' } };
    }
    if (path === '/api/metadata/graphql') return { body: { data: { workbooks: [] } } };
    if (path === '/api/3.29/sites/site-uuid/workbooks/workbook-1/permissions') return { body: { permissions: {} } };
    if (path === '/api/3.29/sites/site-uuid/workbooks/workbook-1/connections') return { body: { connections: {} } };
    if (path === '/api/3.29/sites/site-uuid/tasks/extractRefreshes') return { body: { tasks: {} } };
    if (path === '/api/3.29/sites/site-uuid/subscriptions?pageSize=1000&pageNumber=1') {
      return { body: { pagination: { pageNumber: '1', pageSize: '1000', totalAvailable: '1001' }, subscriptions: { subscription: firstPage } } };
    }
    if (path === '/api/3.29/sites/site-uuid/subscriptions?pageSize=1000&pageNumber=2') {
      return { body: { pagination: { pageNumber: '2', pageSize: '1000', totalAvailable: '1001' }, subscriptions: { subscription: [{ id: 'subscription-1001' }] } } };
    }
    if (path === '/api/3.29/auth/signout') return { status: 204, body: '' };
    throw new Error(`Unexpected Tableau pagination request: ${request.method || 'GET'} ${path}`);
  });

  const result = await prepareTableauEvidence(collectorContext(sourceConnection, ['workbook:workbook-1'], transport));

  assert.equal(transport.requests.filter((request) => requestPath(request).includes('/subscriptions?')).length, 2);
  assert.equal(result.status, 'complete');
  assert.equal(result.diagnostics.truncated, false);
  assert.equal(result.diagnostics.pagesFetched, 2);
  assert.equal(result.evidenceContract.dependencyClosure.status, 'complete');
  assert.equal(result.diagnostics.warnings.some((warning) => /subscription governance is incomplete/i.test(warning)), false);
  assertSecretsAbsent(result, 'fixture-pat-secret', 'fixture-tableau-session');
});

test('Tableau rejects invalid or mismatched subscription page coordinates', async () => {
  const scenarios = [
    {
      name: 'zero page number',
      payload: { pagination: { pageNumber: '0', pageSize: '1000', totalAvailable: '0' }, subscriptions: {} },
      warning: /pageNumber must be a positive integer/i,
    },
    {
      name: 'fractional page size',
      payload: { pagination: { pageNumber: '1', pageSize: '999.5', totalAvailable: '0' }, subscriptions: {} },
      warning: /pageSize must be a positive integer/i,
    },
    {
      name: 'negative total',
      payload: { pagination: { pageNumber: '1', pageSize: '1000', totalAvailable: '-1' }, subscriptions: {} },
      warning: /totalAvailable must be a non-negative integer/i,
    },
    {
      name: 'wrong returned page',
      payload: { pagination: { pageNumber: '2', pageSize: '1000', totalAvailable: '0' }, subscriptions: {} },
      warning: /incoherent page coordinates/i,
    },
    {
      name: 'wrong returned page size',
      payload: { pagination: { pageNumber: '1', pageSize: '500', totalAvailable: '0' }, subscriptions: {} },
      warning: /incoherent page coordinates/i,
    },
  ];

  for (const scenario of scenarios) {
    const { result, transport } = await prepareTableauSubscriptionScenario(() => scenario.payload);
    assert.equal(result.status, 'bounded', scenario.name);
    assert.equal(result.diagnostics.truncated, true, scenario.name);
    assert.equal(result.evidenceContract.collection.complete, false, scenario.name);
    assert.equal(result.evidenceContract.dependencyClosure.status, 'partial', scenario.name);
    assert.match(result.diagnostics.warnings.join(' '), scenario.warning, scenario.name);
    assert.equal(transport.requests.filter((request) => requestPath(request).includes('/subscriptions?')).length, 1, scenario.name);
    assertSecretsAbsent(result, 'fixture-pat-secret', 'fixture-tableau-session');
  }
});

test('Tableau rejects subscription totals that change or claim unobserved rows at terminal', async () => {
  const fullPage = Array.from({ length: 1_000 }, (_, index) => ({ id: `subscription-${index + 1}` }));
  const changingTotal = await prepareTableauSubscriptionScenario((pageNumber) => pageNumber === 1
    ? { pagination: { pageNumber: '1', pageSize: '1000', totalAvailable: '1001' }, subscriptions: { subscription: fullPage } }
    : { pagination: { pageNumber: '2', pageSize: '1000', totalAvailable: '1002' }, subscriptions: { subscription: [{ id: 'subscription-1001' }] } });
  assert.equal(changingTotal.result.status, 'bounded');
  assert.equal(changingTotal.result.diagnostics.pagesFetched, 2);
  assert.match(changingTotal.result.diagnostics.warnings.join(' '), /changed totalAvailable between pages/i);

  const emptyBeforeTotal = await prepareTableauSubscriptionScenario(() => ({
    pagination: { pageNumber: '1', pageSize: '1000', totalAvailable: '1' },
    subscriptions: {},
  }));
  assert.equal(emptyBeforeTotal.result.status, 'bounded');
  assert.match(emptyBeforeTotal.result.diagnostics.warnings.join(' '), /empty before totalAvailable was reached/i);

  const shortBeforeTotal = await prepareTableauSubscriptionScenario(() => ({
    pagination: { pageNumber: '1', pageSize: '1000', totalAvailable: '2' },
    subscriptions: { subscription: [{ id: 'subscription-1' }] },
  }));
  assert.equal(shortBeforeTotal.result.status, 'bounded');
  assert.match(shortBeforeTotal.result.diagnostics.warnings.join(' '), /short before totalAvailable was reached/i);

  const rowsExceedTotal = await prepareTableauSubscriptionScenario(() => ({
    pagination: { pageNumber: '1', pageSize: '1000', totalAvailable: '0' },
    subscriptions: { subscription: [{ id: 'unexpected-subscription' }] },
  }));
  assert.equal(rowsExceedTotal.result.status, 'bounded');
  assert.match(rowsExceedTotal.result.diagnostics.warnings.join(' '), /would exceed totalAvailable/i);

  for (const { result } of [changingTotal, emptyBeforeTotal, shortBeforeTotal, rowsExceedTotal]) {
    assert.equal(result.diagnostics.truncated, true);
    assert.equal(result.evidenceContract.collection.complete, false);
    assert.equal(result.evidenceContract.dependencyClosure.status, 'partial');
    assertSecretsAbsent(result, 'fixture-pat-secret', 'fixture-tableau-session');
  }
});

test('Tableau marks subscription governance truncated when the safety bound has no terminal evidence', async () => {
  const sourceConnection = connection('tableau', 'personal_access_token', {
    baseUrl: 'https://tableau.example.test',
    username: 'fixture-pat-name',
    credential: 'fixture-pat-secret',
    siteId: 'example-site',
  });
  const xml = new TextEncoder().encode('<?xml version="1.0"?><workbook><datasources /></workbook>');
  const transport = new FixtureTransport((request) => {
    const path = requestPath(request);
    if (path === '/api/3.29/auth/signin') {
      return { body: { credentials: { token: 'fixture-tableau-session', site: { id: 'site-uuid', contentUrl: 'example-site' } } } };
    }
    if (path === '/api/3.29/sites/site-uuid/workbooks/workbook-1/content?includeExtract=False') {
      return { body: xml, headers: { 'content-disposition': 'attachment; filename="example.twb"' } };
    }
    if (path === '/api/metadata/graphql') return { body: { data: { workbooks: [] } } };
    if (path === '/api/3.29/sites/site-uuid/workbooks/workbook-1/permissions') return { body: { permissions: {} } };
    if (path === '/api/3.29/sites/site-uuid/workbooks/workbook-1/connections') return { body: { connections: {} } };
    if (path === '/api/3.29/sites/site-uuid/tasks/extractRefreshes') return { body: { tasks: {} } };
    if (path.startsWith('/api/3.29/sites/site-uuid/subscriptions?pageSize=1000&pageNumber=')) {
      const pageNumber = Number(new URL(request.url).searchParams.get('pageNumber'));
      return { body: { subscriptions: { subscription: Array.from({ length: 1_000 }, (_, index) => ({ id: `subscription-${pageNumber}-${index}` })) } } };
    }
    if (path === '/api/3.29/auth/signout') return { status: 204, body: '' };
    throw new Error(`Unexpected Tableau bounded pagination request: ${request.method || 'GET'} ${path}`);
  });

  const result = await prepareTableauEvidence(collectorContext(sourceConnection, ['workbook:workbook-1'], transport));

  assert.equal(transport.requests.filter((request) => requestPath(request).includes('/subscriptions?')).length, 11);
  assert.equal(result.status, 'bounded');
  assert.equal(result.diagnostics.truncated, true);
  assert.equal(result.evidenceContract.collection.complete, false);
  assert.equal(result.evidenceContract.dependencyClosure.status, 'partial');
  assert.ok(result.dependencies.some((dependency) => dependency.sourceId === 'tableau:governance:selected-scope' && dependency.status === 'review_required'));
  assert.match(result.diagnostics.warnings.join(' '), /subscription governance is incomplete/i);
  assertSecretsAbsent(result, 'fixture-pat-secret', 'fixture-tableau-session');
});

test('Fabric inventory rejects malformed HTTP-200 envelopes and item records instead of verifying empty', async () => {
  const malformed = [
    { name: 'array envelope', body: [], message: /unrecognized HTTP-200 envelope/i },
    { name: 'missing value array', body: { continuationToken: null }, message: /did not contain the documented value array/i },
    { name: 'non-array value', body: { value: {} }, message: /did not contain the documented value array/i },
    { name: 'invalid item row', body: { value: [{ id: 'item-1', displayName: 'Missing type' }] }, message: /invalid item record at index 0/i },
    { name: 'invalid continuation', body: { value: [], continuationToken: 42 }, message: /invalid continuationToken/i },
  ];

  for (const scenario of malformed) {
    const transport = new FixtureTransport((request) => {
      assert.equal(request.headers?.Authorization, 'Bearer fixture-fabric-token');
      return { body: scenario.body };
    });
    await assert.rejects(
      listPowerBiFabricItems({ workspaceId: 'workspace-1', accessToken: 'fixture-fabric-token', transport }),
      scenario.message,
      scenario.name,
    );
    assert.equal(transport.requests.length, 1, scenario.name);
  }

  const emptyTransport = new FixtureTransport(() => ({ body: { value: [] } }));
  const empty = await listPowerBiFabricItems({ workspaceId: 'workspace-1', accessToken: 'fixture-fabric-token', transport: emptyTransport });
  assert.deepEqual(empty, { items: [], truncated: false });
});

test('Power BI exchanges Entra client credentials and closes report bindings with Fabric TMDL definitions', async () => {
  const sourceConnection = connection('power_bi', 'oauth_client_credentials', {
    baseUrl: 'https://app.powerbi.com',
    accountIdentifier: 'example-tenant',
    clientId: 'fixture-entra-client',
    credential: 'fixture-entra-secret',
    workspaceId: 'workspace-1',
  });
  const transport = new FixtureTransport((request) => {
    const url = new URL(request.url);
    const path = `${url.pathname}${url.search}`;
    if (path === '/example-tenant/oauth2/v2.0/token') {
      assert.equal(request.method, 'POST');
      const body = new URLSearchParams(String(request.body));
      assert.equal(body.get('client_id'), 'fixture-entra-client');
      assert.equal(body.get('client_secret'), 'fixture-entra-secret');
      assert.equal(body.get('grant_type'), 'client_credentials');
      const scope = body.get('scope');
      return { body: { access_token: scope?.includes('fabric.microsoft.com') ? 'fixture-fabric-token' : 'fixture-powerbi-token' } };
    }
    if (url.hostname === 'api.fabric.microsoft.com') {
      assert.equal(request.headers?.Authorization, 'Bearer fixture-fabric-token');
      if (path === '/v1/workspaces/workspace-1/items?recursive=true') {
        return {
          body: {
            value: [
              { id: 'report-1', displayName: 'Example report', type: 'Report' },
              { id: 'model-1', displayName: 'Example model', type: 'SemanticModel' },
            ],
          },
        };
      }
      if (path === '/v1/workspaces/workspace-1/reports/report-1/getDefinition') {
        assert.equal(request.method, 'POST');
        return {
          body: {
            definition: {
              format: 'PBIR',
              parts: [{
                path: 'definition/report.json',
                payloadType: 'InlineBase64',
                payload: inlineBase64(JSON.stringify({ datasetId: 'model-1', sections: [] })),
              }],
            },
          },
        };
      }
      if (path === '/v1/workspaces/workspace-1/semanticModels/model-1/getDefinition?format=TMDL') {
        assert.equal(request.method, 'POST');
        return {
          body: {
            definition: {
              format: 'TMDL',
              parts: [{
                path: 'definition/model.tmdl',
                payloadType: 'InlineBase64',
                payload: inlineBase64('model Example\n\ttable Orders'),
              }],
            },
          },
        };
      }
    }
    if (url.hostname === 'api.powerbi.com') {
      assert.equal(request.headers?.Authorization, 'Bearer fixture-powerbi-token');
      if (path === '/v1.0/myorg/groups/workspace-1/users?$top=1000') return { body: { value: [] } };
      if (path === '/v1.0/myorg/groups/workspace-1/reports') {
        return { body: { value: [{ id: 'report-1', name: 'Example report', datasetId: 'model-1' }] } };
      }
      if (path === '/v1.0/myorg/groups/workspace-1/datasets/model-1/users') return { body: { value: [] } };
      if (path === '/v1.0/myorg/groups/workspace-1/datasets/model-1/refreshSchedule') return { body: { enabled: false, days: [], times: [] } };
    }
    throw new Error(`Unexpected Power BI request: ${request.method || 'GET'} ${request.url}`);
  });

  const registeredSecrets: string[] = [];
  const result = await preparePowerBiEvidence(collectorContext(
    sourceConnection,
    ['report:report-1'],
    transport,
    (value) => registeredSecrets.push(value),
  ));

  assert.deepEqual(registeredSecrets.sort(), ['fixture-fabric-token', 'fixture-powerbi-token']);
  const tokenRequests = transport.requests.filter((request) => requestPath(request) === '/example-tenant/oauth2/v2.0/token');
  assert.equal(tokenRequests.length, 2);
  assert.deepEqual(tokenRequests.map((request) => new URLSearchParams(String(request.body)).get('scope')).sort(), [
    'https://analysis.windows.net/powerbi/api/.default',
    'https://api.fabric.microsoft.com/.default',
  ]);
  assert.equal(transport.requests.some((request) => requestPath(request) === '/v1/workspaces/workspace-1/reports/report-1/getDefinition'), true);
  assert.equal(transport.requests.some((request) => requestPath(request) === '/v1/workspaces/workspace-1/semanticModels/model-1/getDefinition?format=TMDL'), true);
  assert.equal(transport.requests.some((request) => requestPath(request) === '/v1.0/myorg/groups/workspace-1/datasets/model-1/users'), true);
  assert.equal(transport.requests.some((request) => requestPath(request) === '/v1.0/myorg/groups/workspace-1/datasets/model-1/refreshSchedule'), true);
  assert.equal(result.status, 'partial', 'PBIR behavior remains a review boundary even though the definition format is supported');
  assert.equal(result.evidenceContract.collection.complete, true);
  assert.equal(result.diagnostics.complete, true, 'PBIR behavioral review does not make acquisition incomplete');
  assert.equal(result.evidenceContract.dependencyClosure.status, 'partial');
  assert.equal(result.evidenceContract.dependencyClosure.missingCount, 0);
  assert.equal(result.diagnostics.manualRequirements.some((requirement) => /PBIR Preview/i.test(requirement)), false);
  assert.equal(JSON.stringify(result).includes('PBIR Preview'), false);
  assert.ok(result.dependencies.some((dependency) => (
    dependency.sourceId === 'power_bi:report:report-1'
      && dependency.category === 'content'
      && dependency.status === 'review_required'
      && /supported PBIR public-definition format/i.test(dependency.reason)
      && /does not prove rendering or interaction equivalence/i.test(dependency.reason)
  )));
  assert.ok(result.dependencies.some((dependency) => (
    dependency.sourceId === 'power_bi:report:report-1'
      && dependency.dependencySourceId === 'power_bi:semantic_model:model-1'
      && dependency.status === 'resolved'
  )));
  assert.ok(result.artifacts.some((artifact) => artifact.parentSourceId === 'power_bi:semantic_model:model-1'));
  assert.equal(result.inventory.artifacts.length, 0, 'raw Fabric definition parts must remain server-side');
  assertSecretsAbsent(result, 'fixture-entra-secret', 'fixture-fabric-token', 'fixture-powerbi-token');
});

test('Power BI validates supplemental governance success contracts before fingerprinting', async () => {
  type SupplementalEndpoint = 'workspaceUsers' | 'reports' | 'datasetUsers' | 'refreshSchedule';
  const paths: Record<SupplementalEndpoint, string> = {
    workspaceUsers: '/v1.0/myorg/groups/workspace-1/users?$top=1000',
    reports: '/v1.0/myorg/groups/workspace-1/reports',
    datasetUsers: '/v1.0/myorg/groups/workspace-1/datasets/model-1/users',
    refreshSchedule: '/v1.0/myorg/groups/workspace-1/datasets/model-1/refreshSchedule',
  };
  const artifactSourceIds: Record<SupplementalEndpoint, string> = {
    workspaceUsers: 'power_bi:workspace:workspace-1:principals',
    reports: 'power_bi:workspace:workspace-1:reports',
    datasetUsers: 'power_bi:semantic_model:model-1:principals',
    refreshSchedule: 'power_bi:semantic_model:model-1:refresh-schedule',
  };
  const validBodies: Record<SupplementalEndpoint, unknown> = {
    workspaceUsers: { value: [] },
    reports: { value: [] },
    datasetUsers: { value: [] },
    refreshSchedule: { enabled: false, days: [], times: [] },
  };
  const prepare = async (malformed?: { endpoint: SupplementalEndpoint; body: unknown }) => {
    const sourceConnection = connection('power_bi', 'oauth_client_credentials', {
      baseUrl: 'https://app.powerbi.com',
      accountIdentifier: 'example-tenant',
      clientId: 'fixture-entra-client',
      credential: 'fixture-entra-secret',
      workspaceId: 'workspace-1',
    });
    const transport = new FixtureTransport((request) => {
      const url = new URL(request.url);
      const path = requestPath(request);
      if (path === '/example-tenant/oauth2/v2.0/token') {
        const scope = new URLSearchParams(String(request.body)).get('scope');
        return { body: { access_token: scope?.includes('fabric.microsoft.com') ? 'fixture-fabric-token' : 'fixture-powerbi-token' } };
      }
      if (url.hostname === 'api.fabric.microsoft.com') {
        assert.equal(request.headers?.Authorization, 'Bearer fixture-fabric-token');
        if (path === '/v1/workspaces/workspace-1/items?recursive=true') {
          return { body: { value: [{ id: 'model-1', displayName: 'Example model', type: 'SemanticModel' }] } };
        }
        if (path === '/v1/workspaces/workspace-1/semanticModels/model-1/getDefinition?format=TMDL') {
          return {
            body: {
              definition: {
                format: 'TMDL',
                parts: [{
                  path: 'definition/model.tmdl',
                  payloadType: 'InlineBase64',
                  payload: inlineBase64('model Example\n\ttable Orders'),
                }],
              },
            },
          };
        }
      }
      if (url.hostname === 'api.powerbi.com') {
        assert.equal(request.headers?.Authorization, 'Bearer fixture-powerbi-token');
        const endpoint = (Object.entries(paths) as Array<[SupplementalEndpoint, string]>)
          .find(([, endpointPath]) => endpointPath === path)?.[0];
        if (endpoint) {
          return { body: malformed?.endpoint === endpoint ? malformed.body : validBodies[endpoint] };
        }
      }
      throw new Error(`Unexpected Power BI supplemental request: ${request.method || 'GET'} ${request.url}`);
    });
    const result = await preparePowerBiEvidence(collectorContext(sourceConnection, ['semantic_model:model-1'], transport));
    assertSecretsAbsent(result, 'fixture-entra-secret', 'fixture-fabric-token', 'fixture-powerbi-token');
    return result;
  };

  const documentedEmpty = await prepare();
  assert.equal(documentedEmpty.status, 'complete');
  assert.equal(documentedEmpty.evidenceContract.collection.complete, true);
  assert.equal(documentedEmpty.diagnostics.permissionGaps.length, 0);
  for (const sourceId of Object.values(artifactSourceIds)) {
    assert.ok(documentedEmpty.artifacts.some((artifact) => artifact.sourceId === sourceId), `${sourceId} should be fingerprinted`);
  }

  const malformedScenarios: Array<{
    name: string;
    endpoint: SupplementalEndpoint;
    body: unknown;
    detail: RegExp;
  }> = [
    {
      name: 'workspace users envelope',
      endpoint: 'workspaceUsers',
      body: [],
      detail: /documented OData object envelope was missing/i,
    },
    {
      name: 'workspace user required access right',
      endpoint: 'workspaceUsers',
      body: { value: [{ identifier: 'principal-1', principalType: 'User' }] },
      detail: /groupUserAccessRight was missing or unsupported/i,
    },
    {
      name: 'report required name',
      endpoint: 'reports',
      body: { value: [{ id: 'report-1', datasetId: 'model-1' }] },
      detail: /value\[0\]\.name was missing/i,
    },
    {
      name: 'dataset user required access right',
      endpoint: 'datasetUsers',
      body: { value: [{ identifier: 'principal-1', principalType: 'User' }] },
      detail: /datasetUserAccessRight was missing or unsupported/i,
    },
    {
      name: 'refresh schedule required times',
      endpoint: 'refreshSchedule',
      body: { enabled: false, days: [] },
      detail: /times was not an array of documented 24-hour HH:mm values/i,
    },
  ];

  for (const scenario of malformedScenarios) {
    const result = await prepare(scenario);
    assert.equal(result.status, 'partial', scenario.name);
    assert.equal(result.evidenceContract.collection.complete, false, scenario.name);
    assert.equal(result.diagnostics.complete, false, scenario.name);
    assert.equal(result.diagnostics.permissionGaps.length, 1, scenario.name);
    assert.match(result.diagnostics.permissionGaps[0] || '', /malformed HTTP-200 governance evidence/i, scenario.name);
    assert.match(result.diagnostics.permissionGaps[0] || '', scenario.detail, scenario.name);
    assert.equal(
      result.artifacts.some((artifact) => artifact.sourceId === artifactSourceIds[scenario.endpoint]),
      false,
      `${scenario.name} must not be fingerprinted`,
    );
    assert.ok(result.dependencies.some((dependency) => (
      dependency.sourceId === 'power_bi:governance:selected-scope'
        && dependency.category === 'security'
        && dependency.status === 'review_required'
    )), scenario.name);
  }
});

test('Power BI accepts exact Fabric operation Locations with and without the v1 segment', async () => {
  for (const locationPrefix of ['', '/v1'] as const) {
    const sourceConnection = connection('power_bi', 'oauth_access_token', {
      baseUrl: 'https://app.powerbi.com',
      credential: 'fixture-delegated-fabric-token',
      credentialExpiresAt: '2099-08-12T12:00:00.000Z',
      workspaceId: 'workspace-1',
    });
    let operationStateCalls = 0;
    const transport = new FixtureTransport((request) => {
      const url = new URL(request.url);
      assert.notEqual(url.hostname, 'api.powerbi.com', 'a Fabric-audience delegated token must not be replayed to Power BI REST');
      assert.equal(request.headers?.Authorization, 'Bearer fixture-delegated-fabric-token');
      const path = requestPath(request);
      if (path === '/v1/workspaces/workspace-1/items?recursive=true') {
        return { body: { value: [{ id: 'model-1', displayName: 'Example model', type: 'SemanticModel' }] } };
      }
      if (path === '/v1/workspaces/workspace-1/semanticModels/model-1/getDefinition?format=TMDL') {
        return {
          status: 202,
          headers: {
            location: `https://api.fabric.microsoft.com${locationPrefix}/operations/operation-1`,
            'x-ms-operation-id': 'operation-1',
            'retry-after': '0',
          },
          body: {},
        };
      }
      if (path === '/v1/operations/operation-1') {
        operationStateCalls += 1;
        return {
          headers: { location: `https://api.fabric.microsoft.com${locationPrefix}/operations/operation-1/result` },
          body: { status: 'Succeeded' },
        };
      }
      if (path === '/v1/operations/operation-1/result') {
        return {
          body: {
            definition: {
              format: 'TMDL',
              parts: [{
                path: 'definition/model.tmdl',
                payloadType: 'InlineBase64',
                payload: inlineBase64('model Example\n\ttable Orders'),
              }],
            },
          },
        };
      }
      throw new Error(`Unexpected Fabric LRO request: ${request.method || 'GET'} ${request.url}`);
    });

    const result = await preparePowerBiEvidence(collectorContext(sourceConnection, ['semantic_model:model-1'], transport));

    assert.equal(operationStateCalls, 1);
    assert.equal(result.status, 'partial');
    assert.equal(result.evidenceContract.collection.complete, false, 'supplemental governance is unavailable without a Power BI-audience token');
    assert.equal(result.evidenceContract.dependencyClosure.status, 'partial');
    assert.match(result.diagnostics.permissionGaps.join(' '), /separately audience-bound Power BI REST API token/i);
    assert.equal(transport.requests.some((request) => new URL(request.url).hostname === 'api.powerbi.com'), false);
    const operationStateDocumentation = 'https://learn.microsoft.com/en-us/rest/api/fabric/core/long-running-operations/get-operation-state';
    const operationResultDocumentation = 'https://learn.microsoft.com/en-us/rest/api/fabric/core/long-running-operations/get-operation-result';
    assert.ok(result.evidenceContract.documentationIds.includes(operationStateDocumentation));
    assert.ok(result.evidenceContract.documentationIds.includes(operationResultDocumentation));
    assert.ok(result.artifacts.length > 0);
    assert.ok(result.artifacts.every((artifact) => artifact.documentationIds.includes(operationStateDocumentation)));
    assert.ok(result.artifacts.every((artifact) => artifact.documentationIds.includes(operationResultDocumentation)));
    assertSecretsAbsent(result, 'fixture-delegated-fabric-token');
  }
});

test('Strategy creates a project-bound ephemeral session and closes it after definition retrieval', async () => {
  const sourceConnection = connection('microstrategy', 'username_password_session', {
    baseUrl: 'https://strategy.example.test',
    username: 'fixture-strategy-user',
    credential: 'fixture-strategy-password',
    projectId: 'project-1',
  });
  const transport = new FixtureTransport((request) => {
    const path = requestPath(request);
    if (path === '/api/auth/login') {
      assert.equal(request.method, 'POST');
      assert.deepEqual(JSON.parse(String(request.body)), {
        username: 'fixture-strategy-user',
        password: 'fixture-strategy-password',
        loginMode: 1,
      });
      return { body: '', headers: { 'x-mstr-authtoken': 'fixture-strategy-session' } };
    }
    assert.equal(request.headers?.['X-MSTR-AuthToken'], 'fixture-strategy-session');
    if (path === '/api/projects') {
      assert.equal(request.headers?.['X-MSTR-ProjectID'], 'project-1');
      return { body: jsonText([{ id: 'project-1', name: 'Example project' }]) };
    }
    if (path === '/api/model/reports/report-1?showExpressionAs=tree&showFilterTokens=true&showAdvancedProperties=true') {
      assert.equal(request.headers?.['X-MSTR-ProjectID'], 'project-1');
      return {
        body: jsonText({
          information: { objectId: 'report-1', subType: 'report_grid', name: 'Example report' },
          dataSource: { dataTemplate: { units: [] } },
        }),
      };
    }
    if (path === '/api/auth/logout') return { status: 204, body: '' };
    throw new Error(`Unexpected Strategy request: ${request.method || 'GET'} ${path}`);
  });

  const registeredSecrets: string[] = [];
  const result = await prepareMicroStrategyEvidence(collectorContext(
    sourceConnection,
    ['report:report-1'],
    transport,
    (value) => registeredSecrets.push(value),
  ));

  assert.deepEqual(registeredSecrets, ['fixture-strategy-session']);
  assert.deepEqual(transport.requests.map(requestPath), [
    '/api/auth/login',
    '/api/projects',
    '/api/model/reports/report-1?showExpressionAs=tree&showFilterTokens=true&showAdvancedProperties=true',
    '/api/auth/logout',
  ]);
  assert.equal(result.status, 'partial');
  assert.equal(result.evidenceContract.collection.complete, true);
  assert.equal(result.evidenceContract.dependencyClosure.status, 'partial');
  assert.ok(result.dependencies.some((dependency) => dependency.sourceId === 'strategy:report:report-1' && dependency.status === 'resolved'));
  assert.ok(result.dependencies.some((dependency) => dependency.status === 'manual_required' && dependency.category === 'security'));
  assertSecretsAbsent(result, 'fixture-strategy-password', 'fixture-strategy-session');
});

test('Strategy treats a dossier response as a compiled projection and requires a full visual package', async () => {
  const sourceConnection = connection('microstrategy', 'username_password_session', {
    baseUrl: 'https://strategy.example.test',
    username: 'fixture-strategy-user',
    credential: 'fixture-strategy-password',
    projectId: 'project-1',
  });
  const transport = new FixtureTransport((request) => {
    const path = requestPath(request);
    if (path === '/api/auth/login') return { body: '', headers: { 'x-mstr-authtoken': 'fixture-strategy-session' } };
    if (path === '/api/projects') return { body: jsonText([{ id: 'project-1', name: 'Example project' }]) };
    if (path === '/api/dossiers/dossier-1/definition') {
      return {
        body: jsonText({
          information: { objectId: 'dossier-1', name: 'Example dossier' },
          selectors: [{ id: 'selector-1', name: 'Example selector', type: 'selector' }],
          datasets: [{ id: 'dataset-1', name: 'Example dataset', type: 'dataset' }],
        }),
      };
    }
    if (path === '/api/auth/logout') return { status: 204, body: '' };
    throw new Error(`Unexpected Strategy dossier request: ${request.method || 'GET'} ${path}`);
  });

  const result = await prepareMicroStrategyEvidence(collectorContext(sourceConnection, ['dossier:dossier-1'], transport));

  const dossierArtifact = result.artifacts.find((artifact) => artifact.sourceId === 'strategy:dossier:dossier-1');
  assert.equal(dossierArtifact?.evidenceClass, 'compiled_definition');
  assert.equal(result.status, 'manual_required');
  assert.equal(result.evidenceContract.collection.complete, true);
  assert.equal(result.evidenceContract.dependencyClosure.status, 'partial');
  assert.ok(result.dependencies.some((dependency) => (
    dependency.sourceId === 'strategy:dossier:dossier-1:visual-package'
      && dependency.dependencySourceId === 'strategy:dossier:dossier-1'
      && dependency.status === 'manual_required'
      && /visuals, layout, formatting, interactions/i.test(dependency.reason)
  )));
  const dossier = result.inventory.dashboards.find((dashboard) => dashboard.sourceId === 'strategy:dossier:dossier-1');
  assert.equal(dossier?.metadata?.evidenceScope, 'filter_selector_dataset_projection');
  assert.equal(dossier?.metadata?.completeVisualDefinition, false);
  assert.ok(dossier?.riskFlags?.some((flag) => /manual evidence/i.test(flag)));
  assert.match(result.diagnostics.manualRequirements.join(' '), /official dossier\/document migration package/i);
  assertSecretsAbsent(result, 'fixture-strategy-password', 'fixture-strategy-session');
});

test('Strategy discovery deduplicates and fails closed when an offset page repeats', async () => {
  const sourceConnection = connection('microstrategy', 'username_password_session', {
    baseUrl: 'https://strategy.example.test',
    username: 'fixture-strategy-user',
    credential: 'fixture-strategy-password',
    projectId: 'project-1',
  });
  const reportRows = Array.from({ length: 200 }, (_, index) => ({
    information: { objectId: `report-${index + 1}`, name: `Report ${index + 1}` },
  }));
  const transport = new FixtureTransport((request) => {
    const url = new URL(request.url);
    if (url.pathname === '/api/auth/login') return { body: '', headers: { 'x-mstr-authtoken': 'fixture-strategy-session' } };
    if (url.pathname === '/api/auth/logout') return { status: 204, body: '' };
    if (url.pathname === '/api/projects') return { body: jsonText([{ id: 'project-1', name: 'Example project' }]) };
    if (url.pathname === '/api/searches/results') {
      const type = url.searchParams.get('type');
      const offset = Number(url.searchParams.get('offset') || 0);
      return { body: jsonText({ result: type === '3' && (offset === 0 || offset === 200) ? reportRows : [] }) };
    }
    throw new Error(`Unexpected Strategy discovery request: ${request.method || 'GET'} ${requestPath(request)}`);
  });

  const result = await discoverMicroStrategySource(collectorContext(sourceConnection, [], transport));

  assert.equal(result.truncated, true);
  assert.equal(result.complete, false);
  assert.equal(result.pagesFetched, 6);
  assert.equal(result.items.filter((item) => item.kind === 'report').length, 200);
  assert.match(result.warnings.join(' '), /repeated a page without advancing/i);
  assert.equal(transport.requests.filter((request) => requestPath(request) === '/api/auth/logout').length, 1);
});

test('central root normalization deduplicates exact scope and rejects unsafe or unbounded identifiers', () => {
  assert.deepEqual(normalizeMigrationSourceRootIds([' report:b ', 'report:a', 'report:b']), ['report:a', 'report:b']);
  assert.throws(() => normalizeMigrationSourceRootIds([]), /at least one source root/i);
  assert.throws(() => normalizeMigrationSourceRootIds(['report:one\nreport:two']), /control characters/i);
  assert.throws(() => normalizeMigrationSourceRootIds(['x'.repeat(301)]), /300 characters or fewer/i);
  assert.throws(() => normalizeMigrationSourceRootIds([42]), /must be a string/i);
  assert.throws(() => normalizeMigrationSourceRootIds(Array.from({ length: 201 }, (_, index) => `report:${index}`)), /200 or fewer/i);
});

test('source transport address policy rejects special-use networks and allows a globally routable address', () => {
  const blocked = [
    '100.64.0.1',
    '100.127.255.254',
    '198.18.0.1',
    '198.19.255.254',
    '192.0.2.10',
    '198.51.100.10',
    '203.0.113.10',
    '::ffff:100.64.0.1',
    '::ffff:c612:0001',
    '::2',
    '64:ff9b::1',
    '100::1',
    '2001:db8::1',
    '3fff::1',
    '4000::1',
  ];
  blocked.forEach((address) => assert.equal(isPrivateOrLocalAddress(address), true, `${address} must be blocked`));
  assert.equal(isPrivateOrLocalAddress('8.8.8.8'), false);
  assert.equal(isPrivateOrLocalAddress('2606:4700:4700::1111'), false);
});

function fingerprintFixture(): MigrationPreparedEvidenceResult {
  const evidenceContract: MigrationPreparedEvidenceResult['evidenceContract'] = {
    schemaVersion: 'omnikit.source-evidence.v2',
    sourceTool: 'looker',
    parser: { name: 'Example deterministic parser', version: '1' },
    acquisition: { mode: 'api', runId: REQUEST_SCOPE, selectedScopeIds: ['dashboard:one'] },
    collection: {
      expectedArtifactCount: 1,
      observedArtifactCount: 1,
      complete: true,
      truncated: false,
      permissionGaps: [],
    },
    dependencyClosure: { status: 'partial', resolvedCount: 1, missingCount: 0, reviewCount: 1 },
    artifactFingerprints: [{ name: 'Example definition', sha256: 'a'.repeat(64), sizeBytes: 100 }],
    documentationIds: migrationSourceDocumentation('looker').map((reference) => reference.url),
    diagnostics: ['Raw LookML requires reviewed manual closure.'],
  };
  return {
    schemaVersion: 'omnikit.prepared-source-evidence.v1',
    platform: 'looker',
    connectionId: 'connection-looker',
    connectionUpdatedAt: REVISION,
    selectedRootIds: ['dashboard:one'],
    scopeFingerprint: REQUEST_SCOPE,
    preparedAt: REVISION,
    status: 'partial',
    evidenceContract,
    inventory: {
      sourceTool: 'looker', artifactCount: 1, artifacts: [], views: [], explores: [], relationships: [], dashboards: [], metrics: [],
      warnings: [], summary: 'Example prepared evidence', sourceEvidence: evidenceContract,
    },
    artifacts: [{
      id: 'artifact-one', name: 'Example definition', sourceId: 'looker:dashboard:one',
      evidenceClass: 'compiled_definition', sha256: 'a'.repeat(64), sizeBytes: 100,
      documentationIds: evidenceContract.documentationIds, rawContentIncluded: false,
    }],
    dependencies: [{
      sourceId: 'looker:dashboard:one', category: 'content', required: true, status: 'review_required',
      reason: 'Raw LookML requires reviewed manual closure.',
    }],
    diagnostics: {
      complete: true, verifiedEmpty: false, truncated: false,
      requestsMade: 3, pagesFetched: 3, itemsObserved: 1, bytesRead: 100,
      limits: { maxRequests: 100, maxPages: 100, maxItems: 200, maxBytes: 1_000_000 },
      permissionGaps: [], manualRequirements: ['Raw LookML requires reviewed manual closure.'], errors: [], warnings: [],
    },
  };
}

function contentFingerprint(result: MigrationPreparedEvidenceResult): string {
  return migrationPreparedEvidenceContentFingerprint({
    connectionId: result.connectionId,
    connectionUpdatedAt: result.connectionUpdatedAt,
    platform: result.platform,
    selectedRootIds: result.selectedRootIds,
    requestSeed: REQUEST_SCOPE,
    result,
  });
}

test('content fingerprint binds identical root scope and revision to artifacts, parser, dependencies, and diagnostics', () => {
  const original = fingerprintFixture();
  const originalFingerprint = contentFingerprint(original);
  assert.match(originalFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(contentFingerprint(structuredClone(original)), originalFingerprint);

  const changedArtifact = structuredClone(original);
  changedArtifact.artifacts[0]!.sha256 = 'b'.repeat(64);
  changedArtifact.evidenceContract.artifactFingerprints[0]!.sha256 = 'b'.repeat(64);
  assert.notEqual(contentFingerprint(changedArtifact), originalFingerprint, 'artifact content must rebind the reviewed evidence token');

  const provenanceMutations: Array<[string, (result: MigrationPreparedEvidenceResult) => void]> = [
    ['artifact name', (result) => { result.artifacts[0]!.name = 'Renamed definition'; }],
    ['artifact source', (result) => { result.artifacts[0]!.sourceId = 'looker:dashboard:two'; }],
    ['artifact parent', (result) => { result.artifacts[0]!.parentSourceId = 'looker:folder:one'; }],
    ['artifact locator', (result) => { result.artifacts[0]!.locator = 'dashboard:two'; }],
    ['artifact evidence class', (result) => { result.artifacts[0]!.evidenceClass = 'authoritative_definition'; }],
    ['artifact documentation', (result) => { result.artifacts[0]!.documentationIds = ['https://cloud.google.com/looker/docs/reference/changed']; }],
    ['artifact size', (result) => { result.artifacts[0]!.sizeBytes = 101; }],
  ];
  for (const [label, mutate] of provenanceMutations) {
    const changedProvenance = structuredClone(original);
    mutate(changedProvenance);
    assert.notEqual(contentFingerprint(changedProvenance), originalFingerprint, `${label} must rebind the reviewed evidence token`);
  }

  const changedParser = structuredClone(original);
  changedParser.evidenceContract.parser.version = '2';
  assert.notEqual(contentFingerprint(changedParser), originalFingerprint, 'parser identity must rebind the reviewed evidence token');

  const changedDependency = structuredClone(original);
  changedDependency.dependencies[0]!.status = 'missing';
  assert.notEqual(contentFingerprint(changedDependency), originalFingerprint, 'dependency closure must rebind the reviewed evidence token');

  const changedDiagnostic = structuredClone(original);
  changedDiagnostic.diagnostics.warnings.push('A new bounded diagnostic.');
  assert.notEqual(contentFingerprint(changedDiagnostic), originalFingerprint, 'diagnostics must rebind the reviewed evidence token');
});

test('Domo legacy and generic publication share one complete diagnostic-bound evidence identity', () => {
  const sourceConnection = savedDomoConnection();
  const aggregateResponseBytes = 321;
  const publishGeneric = (legacy: DomoApiEvidenceResult) => {
    const prepared = domoApiEvidenceToPreparedSourceEvidence(sourceConnection, legacy);
    prepared.diagnostics = {
      ...prepared.diagnostics,
      bytesRead: aggregateResponseBytes,
      limits: { ...prepared.diagnostics.limits, maxBytes: MAX_PREPARATION_RESPONSE_BYTES },
    };
    return publishMigrationPreparedEvidenceResult(sourceConnection, legacy.selectedDashboardIds, prepared);
  };
  const original = domoApiFingerprintFixture();
  const legacyPublished = publishDomoApiEvidenceResult(sourceConnection, original, aggregateResponseBytes);
  const genericPublished = publishGeneric(original);

  assert.equal(legacyPublished.scopeFingerprint, genericPublished.scopeFingerprint);
  assert.equal(legacyPublished.parseResult.inventory.sourceEvidence?.acquisition.runId, legacyPublished.scopeFingerprint);
  assert.equal(genericPublished.evidenceContract.acquisition.runId, genericPublished.scopeFingerprint);
  assert.equal(genericPublished.inventory.sourceEvidence?.acquisition.runId, genericPublished.scopeFingerprint);

  const reordered = structuredClone(original);
  reordered.diagnostics.warnings.reverse();
  assert.equal(
    publishDomoApiEvidenceResult(sourceConnection, reordered, aggregateResponseBytes).scopeFingerprint,
    legacyPublished.scopeFingerprint,
    'Equivalent normalized Domo evidence must retain a deterministic review token.',
  );

  const mutations: Array<[string, (result: DomoApiEvidenceResult) => void]> = [
    ['status', (result) => { result.diagnostics.status = 'blocked'; }],
    ['blocker', (result) => { result.diagnostics.blockers.push('A newly observed source blocker.'); }],
    ['missing dependency reason', (result) => {
      result.diagnostics.missingDependencies.push({
        kind: 'dataset_schema',
        sourceId: 'dataset-1',
        reason: 'The selected DataSet schema is no longer accessible.',
      });
    }],
    ['truncation', (result) => { result.diagnostics.truncated = true; }],
    ['warning', (result) => { result.diagnostics.warnings.push('A new non-blocking source diagnostic.'); }],
    ['collection diagnostics', (result) => { result.parseResult.inventory.sourceEvidence!.collection.observedArtifactCount = 2; }],
    ['dependency diagnostics', (result) => { result.parseResult.inventory.sourceEvidence!.dependencyClosure.missingCount = 1; }],
  ];
  for (const [label, mutate] of mutations) {
    const changed = structuredClone(original);
    mutate(changed);
    assert.notEqual(
      publishDomoApiEvidenceResult(sourceConnection, changed, aggregateResponseBytes).scopeFingerprint,
      legacyPublished.scopeFingerprint,
      `${label} must invalidate the exact-scope Domo acknowledgement token.`,
    );
  }

  const secretBearingDiagnostic = structuredClone(original);
  secretBearingDiagnostic.diagnostics.warnings.push(`Rejected token ${sourceConnection.productApiToken}`);
  assert.doesNotMatch(
    JSON.stringify(publishDomoApiEvidenceResult(sourceConnection, secretBearingDiagnostic, aggregateResponseBytes)),
    /fixture-domo-product-token/,
  );
});

test('saved-source production boundary publishes a content-bound token with aggregate byte diagnostics', async () => {
  const transport = new FixtureTransport((request) => {
    const path = requestPath(request);
    if (path === '/api/4.0/login') {
      return { body: { access_token: 'fixture-looker-session' }, bytesRead: 7 };
    }
    if (path === '/api/4.0/dashboards/dashboard-1') {
      return {
        body: {
          id: 'dashboard-1',
          title: 'Example dashboard fixture-looker-session',
          dashboard_elements: [{
            id: 'tile-1',
            query: { model: 'example_model', view: 'orders', fields: ['orders.revenue'] },
          }],
          dashboard_filters: [],
        },
        bytesRead: 11,
      };
    }
    if (path === '/api/4.0/lookml_models/example_model/explores/orders') {
      return {
        body: {
          name: 'orders',
          view_name: 'orders',
          fields: {
            dimensions: [{ name: 'orders.id', view: 'orders', type: 'number', primary_key: true }],
            measures: [{ name: 'orders.revenue', view: 'orders', type: 'sum' }],
            parameters: [],
          },
          joins: [],
        },
        bytesRead: 13,
      };
    }
    throw new Error(`Unexpected saved Looker request: ${request.method || 'GET'} ${path}`);
  });

  const result = await prepareSavedMigrationSourceEvidence(
    savedLookerConnection(),
    ['dashboard:dashboard-1'],
    { transport },
  );

  assert.match(result.scopeFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(result.evidenceContract.acquisition.runId, result.scopeFingerprint);
  assert.deepEqual(result.selectedRootIds, ['dashboard:dashboard-1']);
  assert.equal(result.diagnostics.bytesRead, 31);
  assert.equal(result.diagnostics.limits.maxBytes, MAX_PREPARATION_RESPONSE_BYTES);
  assertSecretsAbsent(result, 'fixture-looker-secret', 'fixture-looker-session');
  assert.match(result.inventory.dashboards[0]?.name || '', /\[REDACTED\]/);
});

test('saved-source production boundary redacts registered transient credentials from errors', async () => {
  const transport = new FixtureTransport((request) => {
    if (requestPath(request) === '/api/4.0/login') {
      return { body: { access_token: 'fixture-looker-session' } };
    }
    throw Object.assign(new Error('Upstream rejected fixture-looker-session while loading the selected definition.'), { statusCode: 502 });
  });

  await assert.rejects(
    prepareSavedMigrationSourceEvidence(savedLookerConnection(), ['dashboard:dashboard-1'], { transport }),
    (error: Error & { statusCode?: number }) => {
      assert.equal(error.statusCode, 502);
      assert.doesNotMatch(error.message, /fixture-looker-session/);
      assert.match(error.message, /\[REDACTED\]/);
      return true;
    },
  );
});

test('saved-source production boundary rejects credentials too short for safe exact redaction', async () => {
  let requested = false;
  const transport = new FixtureTransport(() => {
    requested = true;
    return { body: {} };
  });
  const unsafe = { ...savedLookerConnection(), credential: 'abc' };

  await assert.rejects(
    prepareSavedMigrationSourceEvidence(unsafe, ['dashboard:dashboard-1'], { transport }),
    (error: Error & { statusCode?: number }) => {
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /too short.*replaced/i);
      assert.doesNotMatch(error.message, /abc/);
      return true;
    },
  );
  assert.equal(requested, false);
});

test('saved-source production boundary rejects an aggregate response beyond the central byte ceiling', async () => {
  const transport = new FixtureTransport((request) => {
    assert.equal(requestPath(request), '/api/4.0/login');
    return {
      body: { access_token: 'fixture-looker-session' },
      bytesRead: MAX_PREPARATION_RESPONSE_BYTES + 1,
    };
  });

  await assert.rejects(
    prepareSavedMigrationSourceEvidence(
      savedLookerConnection(),
      ['dashboard:dashboard-1'],
      { transport },
    ),
    /256 MB aggregate response limit/i,
  );
});

test('legacy Domo evidence compatibility boundary enforces the central aggregate byte ceiling', async () => {
  const transport = new FixtureTransport(() => ({
    body: {},
    bytesRead: MAX_PREPARATION_RESPONSE_BYTES + 1,
  }));

  await assert.rejects(
    prepareBoundedDomoApiEvidence(
      savedDomoConnection(),
      ['page-1'],
      { transport },
    ),
    (error: Error & { statusCode?: number }) => {
      assert.equal(error.statusCode, 413);
      assert.match(error.message, /256 MB aggregate response limit/i);
      return true;
    },
  );
});

test('legacy Domo evidence compatibility boundary distinguishes caller cancellation from its internal deadline', async () => {
  const externallyCancelled = new AbortController();
  externallyCancelled.abort();
  await assert.rejects(
    prepareBoundedDomoApiEvidence(savedDomoConnection(), ['page-1'], { signal: externallyCancelled.signal }),
    (error: Error & { statusCode?: number }) => {
      assert.equal(error.statusCode, 499);
      assert.equal(error.name, 'AbortError');
      return true;
    },
  );

  const stalledTransport: MigrationSourceTransport = {
    request<T = unknown>(request: MigrationSourceTransportRequest): Promise<MigrationSourceTransportResponse<T>> {
      return new Promise((_resolve, reject) => {
        const rejectAfterAbort = () => reject(Object.assign(new Error('Fixture request aborted.'), { statusCode: 499 }));
        if (request.signal?.aborted) rejectAfterAbort();
        else request.signal?.addEventListener('abort', rejectAfterAbort, { once: true });
      });
    },
  };
  await assert.rejects(
    prepareBoundedDomoApiEvidence(savedDomoConnection(), ['page-1'], { transport: stalledTransport, deadlineMs: 5 }),
    (error: Error & { statusCode?: number }) => {
      assert.equal(error.statusCode, 504);
      assert.match(error.message, /five-minute overall deadline/i);
      return true;
    },
  );
});

test('exact-scope acknowledgement allows analysis only and preserves the generic source write gate', () => {
  const scopeFingerprint = 'c'.repeat(64);
  const documentation = migrationSourceDocumentation('looker');
  const sourceEvidence: MigrationPreparedEvidenceResult['evidenceContract'] = {
    schemaVersion: 'omnikit.source-evidence.v2',
    sourceTool: 'looker',
    parser: { name: 'Example deterministic parser', version: '1' },
    acquisition: { mode: 'api', runId: scopeFingerprint, selectedScopeIds: ['dashboard:one'] },
    collection: { expectedArtifactCount: 1, observedArtifactCount: 1, complete: true, truncated: false, permissionGaps: [] },
    dependencyClosure: { status: 'partial', resolvedCount: 1, missingCount: 0, reviewCount: 1 },
    artifactFingerprints: [{ name: 'Example definition', sha256: 'd'.repeat(64), sizeBytes: 100 }],
    documentationIds: documentation.map((reference) => reference.url),
    diagnostics: ['Raw LookML manual closure remains required.'],
  };
  const canonicalModel: CanonicalSemanticModel = {
    schemaVersion: '1.0',
    sourcePlatform: 'looker',
    generatedAt: REVISION,
    warnings: [],
    nodes: [{
      id: 'model:example', kind: 'model', name: 'Example model', dependencies: [],
      evidence: [{ sourceId: 'looker:compiled-explore:example/orders', artifactId: 'Example definition', role: 'direct' }],
      metadata: {},
    }],
  };
  const coverageRows = [
    'semantic_objects', 'dashboards', 'filters', 'layout', 'permissions', 'schedules',
  ].map((id) => ({
    id: id as 'semantic_objects' | 'dashboards' | 'filters' | 'layout' | 'permissions' | 'schedules',
    label: id,
    status: 'full' as const,
    evidenceClasses: ['prepared source evidence'],
    requiresAcknowledgement: false,
  }));
  const assess = (acknowledgedFingerprint: string) => assessMigrationEvidenceIntegrity({
    source: 'looker',
    sourceEvidence,
    documentation,
    canonicalModel,
    decisions: [],
    coverageRows,
    parserMode: 'deterministic',
    inventoryTruncated: false,
    unsupportedBehaviorAcknowledged: true,
    apiEvidenceLimitationDisposition: { scopeFingerprint: acknowledgedFingerprint, acknowledged: true },
    verificationReceipts: [],
    reviewReceipts: [],
  });

  const exactScope = assess(scopeFingerprint);
  assert.deepEqual(exactScope.analysisBlockers, []);
  assert.ok(exactScope.acquisitionBlockers.includes('Source dependency closure is incomplete.'));
  assert.deepEqual(exactScope.writeBlockers, [
    'looker API evidence has reviewed manual requirements. Supply and validate those exact source definitions before writing to an Omni development branch.',
  ]);
  assert.deepEqual(exactScope.workflowBlockers, exactScope.writeBlockers);
  assert.equal(exactScope.readyForControlledTesting, false);
  assert.ok(exactScope.notices.some((notice) => /planning may continue, but source writes and release remain blocked/i.test(notice)));

  const staleScope = assess('e'.repeat(64));
  assert.ok(staleScope.analysisBlockers.includes('Source dependency closure is incomplete.'));
  assert.equal(staleScope.writeBlockers.length, 0);
});

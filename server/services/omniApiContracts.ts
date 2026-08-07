export type OmniApiContractStatus =
  | 'documented_current'
  | 'tenant_confirmed'
  | 'beta'
  | 'deprecated'
  | 'unverified'
  | 'retired';

export type OmniApiProbeMode = 'read_only' | 'controlled_write' | 'manual_only';
export type OmniApiProductionPolicy = 'allowed' | 'prohibited';

export interface OmniApiContract {
  id: string;
  path: string;
  methods: string[];
  status: OmniApiContractStatus;
  workflows: string[];
  docsUrl: string;
  probeMode: OmniApiProbeMode;
  productionPolicy?: OmniApiProductionPolicy;
  notes?: string;
}

const API_INDEX = 'https://docs.omni.co/api';

export const OMNI_API_CONTRACTS: OmniApiContract[] = [
  { id: 'content-export', path: '/api/unstable/documents/:param/export', methods: ['GET'], status: 'beta', workflows: ['dashboard_migrator'], docsUrl: API_INDEX, probeMode: 'read_only' },
  { id: 'content-import', path: '/api/unstable/documents/import', methods: ['POST'], status: 'beta', workflows: ['dashboard_migrator'], docsUrl: API_INDEX, probeMode: 'controlled_write' },
  { id: 'ai-jobs', path: '/api/v1/ai/jobs', methods: ['POST'], status: 'documented_current', workflows: ['semantic_studio', 'bi_migration_studio'], docsUrl: 'https://docs.omni.co/api/ai/create-ai-job', probeMode: 'controlled_write' },
  { id: 'ai-job-status', path: '/api/v1/ai/jobs/:param', methods: ['GET'], status: 'documented_current', workflows: ['semantic_studio', 'bi_migration_studio'], docsUrl: API_INDEX, probeMode: 'read_only' },
  { id: 'ai-job-cancel', path: '/api/v1/ai/jobs/:param/cancel', methods: ['POST'], status: 'documented_current', workflows: ['semantic_studio'], docsUrl: API_INDEX, probeMode: 'manual_only' },
  { id: 'ai-job-result', path: '/api/v1/ai/jobs/:param/result', methods: ['GET'], status: 'documented_current', workflows: ['semantic_studio', 'bi_migration_studio'], docsUrl: API_INDEX, probeMode: 'read_only' },
  { id: 'ai-pick-topic', path: '/api/v1/ai/pick-topic', methods: ['POST'], status: 'documented_current', workflows: ['semantic_studio'], docsUrl: 'https://docs.omni.co/api/ai/pick-topic', probeMode: 'controlled_write' },
  { id: 'ai-conversations-list', path: '/api/v1/ai/conversations', methods: ['GET'], status: 'documented_current', workflows: ['portfolio_overview'], docsUrl: 'https://docs.omni.co/api/ai/list-ai-conversations', probeMode: 'read_only', notes: 'Organization-wide totals require an Organization API key; OmniKit requests one row and retains only pageInfo.totalRecords.' },
  { id: 'connections', path: '/api/v1/connections', methods: ['GET'], status: 'documented_current', workflows: ['connection_health', 'dashboard_migrator', 'model_migrator'], docsUrl: API_INDEX, probeMode: 'read_only' },
  { id: 'connection-dbt', path: '/api/v1/connections/:param/dbt', methods: ['GET'], status: 'documented_current', workflows: ['connection_health'], docsUrl: API_INDEX, probeMode: 'read_only' },
  { id: 'connection-schedules', path: '/api/v1/connections/:param/schedules', methods: ['GET'], status: 'documented_current', workflows: ['connection_health'], docsUrl: API_INDEX, probeMode: 'read_only' },
  { id: 'dashboard-download-start', path: '/api/v1/dashboards/:param/download', methods: ['POST'], status: 'documented_current', workflows: ['dashboard_downloads', 'deck_builder'], docsUrl: API_INDEX, probeMode: 'controlled_write' },
  { id: 'dashboard-download-file', path: '/api/v1/dashboards/:param/download/:param', methods: ['GET'], status: 'documented_current', workflows: ['dashboard_downloads', 'deck_builder'], docsUrl: API_INDEX, probeMode: 'read_only' },
  { id: 'dashboard-download-status', path: '/api/v1/dashboards/:param/download/:param/status', methods: ['GET'], status: 'documented_current', workflows: ['dashboard_downloads', 'deck_builder'], docsUrl: API_INDEX, probeMode: 'read_only' },
  { id: 'dashboard-filters', path: '/api/v1/dashboards/:param/filters', methods: ['GET'], status: 'documented_current', workflows: ['dashboard_downloads', 'deck_builder'], docsUrl: API_INDEX, probeMode: 'read_only' },
  { id: 'documents-list', path: '/api/v1/documents', methods: ['GET'], status: 'documented_current', workflows: ['dashboard_migrator', 'dashboard_operations', 'deck_builder', 'portfolio_overview'], docsUrl: 'https://docs.omni.co/api/documents/list-documents', probeMode: 'read_only' },
  { id: 'document-create-v1', path: '/api/v1/documents', methods: ['POST'], status: 'deprecated', workflows: ['retired_contract'], docsUrl: 'https://docs.omni.co/api/versioning', probeMode: 'manual_only', notes: 'Use POST /api/v2/documents.' },
  { id: 'document-get-v1', path: '/api/v1/documents/:param', methods: ['GET'], status: 'deprecated', workflows: ['retired_contract'], docsUrl: 'https://docs.omni.co/api/versioning', probeMode: 'manual_only', notes: 'Use GET /api/v2/documents/:documentId.' },
  { id: 'document-update-v1', path: '/api/v1/documents/:param', methods: ['PUT', 'PATCH'], status: 'retired', workflows: ['retired_contract'], docsUrl: 'https://docs.omni.co/api/versioning', probeMode: 'manual_only', notes: 'Removed July 31, 2026; use a Documents V2 draft and publish workflow.' },
  { id: 'document-draft-create-v1', path: '/api/v1/documents/:param/draft', methods: ['POST'], status: 'deprecated', workflows: ['retired_contract'], docsUrl: 'https://docs.omni.co/api/versioning', probeMode: 'manual_only', notes: 'Use PATCH /api/v2/documents/:documentId/draft.' },
  { id: 'document-delete', path: '/api/v1/documents/:param', methods: ['DELETE'], status: 'documented_current', workflows: ['dashboard_migrator', 'dashboard_operations'], docsUrl: API_INDEX, probeMode: 'controlled_write' },
  { id: 'document-access-list', path: '/api/v1/documents/:param/access-list', methods: ['GET'], status: 'documented_current', workflows: ['dashboard_migrator'], docsUrl: 'https://docs.omni.co/api/document-permissions/get-document-access-list', probeMode: 'read_only' },
  { id: 'document-labels-bulk', path: '/api/v1/documents/:param/labels', methods: ['PATCH'], status: 'documented_current', workflows: ['dashboard_migrator', 'label_manager'], docsUrl: API_INDEX, probeMode: 'controlled_write' },
  { id: 'document-label', path: '/api/v1/documents/:param/labels/:param', methods: ['PUT', 'DELETE'], status: 'documented_current', workflows: ['label_manager'], docsUrl: API_INDEX, probeMode: 'controlled_write' },
  { id: 'document-move', path: '/api/v1/documents/:param/move', methods: ['PUT'], status: 'documented_current', workflows: ['dashboard_migrator', 'dashboard_operations'], docsUrl: API_INDEX, probeMode: 'controlled_write' },
  { id: 'document-permissions', path: '/api/v1/documents/:param/permissions', methods: ['POST', 'PATCH'], status: 'documented_current', workflows: ['dashboard_migrator'], docsUrl: API_INDEX, probeMode: 'controlled_write' },
  { id: 'document-queries', path: '/api/v1/documents/:param/queries', methods: ['GET'], status: 'documented_current', workflows: ['dashboard_migrator', 'deck_builder'], docsUrl: 'https://docs.omni.co/guides/api/run-document-queries', probeMode: 'read_only' },
  { id: 'folders', path: '/api/v1/folders', methods: ['GET'], status: 'documented_current', workflows: ['dashboard_migrator', 'dashboard_operations', 'label_manager'], docsUrl: API_INDEX, probeMode: 'read_only' },
  { id: 'job-status', path: '/api/v1/jobs/:param/status', methods: ['GET'], status: 'documented_current', workflows: ['dashboard_migrator'], docsUrl: API_INDEX, probeMode: 'read_only' },
  { id: 'labels', path: '/api/v1/labels', methods: ['GET', 'POST'], status: 'documented_current', workflows: ['dashboard_migrator', 'label_manager'], docsUrl: API_INDEX, probeMode: 'controlled_write' },
  { id: 'models', path: '/api/v1/models', methods: ['GET', 'POST'], status: 'documented_current', workflows: ['dashboard_migrator', 'model_migrator', 'semantic_studio', 'bi_migration_studio'], docsUrl: API_INDEX, probeMode: 'controlled_write' },
  { id: 'model-branch', path: '/api/v1/models/:param/branch/:param', methods: ['DELETE'], status: 'documented_current', workflows: ['model_migrator', 'semantic_studio', 'bi_migration_studio'], docsUrl: API_INDEX, probeMode: 'controlled_write' },
  { id: 'model-branch-merge', path: '/api/v1/models/:param/branch/:param/merge', methods: ['POST'], status: 'documented_current', workflows: ['model_migrator', 'semantic_studio'], docsUrl: API_INDEX, probeMode: 'manual_only' },
  { id: 'content-validator', path: '/api/v1/models/:param/content-validator', methods: ['GET', 'POST'], status: 'documented_current', workflows: ['dashboard_migrator', 'model_migrator', 'semantic_studio', 'bi_migration_studio'], docsUrl: API_INDEX, probeMode: 'read_only' },
  { id: 'model-git', path: '/api/v1/models/:param/git', methods: ['GET'], status: 'documented_current', workflows: ['model_migrator', 'semantic_studio'], docsUrl: API_INDEX, probeMode: 'read_only' },
  { id: 'model-git-commit', path: '/api/v1/models/:param/git/commit', methods: ['POST'], status: 'documented_current', workflows: ['model_migrator', 'semantic_studio'], docsUrl: API_INDEX, probeMode: 'manual_only' },
  { id: 'model-migrate', path: '/api/v1/models/:param/migrate', methods: ['POST'], status: 'unverified', workflows: ['model_migrator'], docsUrl: API_INDEX, probeMode: 'controlled_write', notes: 'Confirm exact request contract in the target instance API Explorer.' },
  { id: 'model-refresh', path: '/api/v1/models/:param/refresh', methods: ['POST'], status: 'documented_current', workflows: ['dashboard_migrator', 'model_migrator'], docsUrl: API_INDEX, probeMode: 'controlled_write' },
  { id: 'model-schemas', path: '/api/v1/models/:param/schemas', methods: ['GET'], status: 'documented_current', workflows: ['model_migrator', 'semantic_studio'], docsUrl: API_INDEX, probeMode: 'read_only' },
  { id: 'topic-list', path: '/api/v1/models/:param/topic', methods: ['GET'], status: 'documented_current', workflows: ['portfolio_overview'], docsUrl: 'https://docs.omni.co/developers/cli/commands', probeMode: 'read_only' },
  { id: 'topic-create-direct', path: '/api/v1/models/:param/topic', methods: ['POST'], status: 'unverified', workflows: ['retired_contract'], docsUrl: API_INDEX, probeMode: 'manual_only', productionPolicy: 'prohibited', notes: 'Not documented for production use. OmniKit stages topic creation through reviewed model YAML branches.' },
  { id: 'topic-detail', path: '/api/v1/models/:param/topic/:param', methods: ['GET'], status: 'documented_current', workflows: ['semantic_studio'], docsUrl: 'https://docs.omni.co/api/topics/retrieve-a-topic', probeMode: 'read_only' },
  { id: 'topic-update-delete-direct', path: '/api/v1/models/:param/topic/:param', methods: ['PATCH', 'DELETE'], status: 'unverified', workflows: ['retired_contract'], docsUrl: API_INDEX, probeMode: 'manual_only', productionPolicy: 'prohibited', notes: 'Not documented for production use. OmniKit stages topic updates and removals through reviewed model YAML branches.' },
  { id: 'model-validate', path: '/api/v1/models/:param/validate', methods: ['GET'], status: 'documented_current', workflows: ['model_migrator', 'semantic_studio', 'bi_migration_studio'], docsUrl: API_INDEX, probeMode: 'read_only' },
  { id: 'model-view-delete', path: '/api/v1/models/:param/view/:param', methods: ['DELETE'], status: 'unverified', workflows: ['model_migrator', 'semantic_studio'], docsUrl: API_INDEX, probeMode: 'controlled_write', notes: 'Prefer checksum-aware YAML deletion when exact route support is unavailable.' },
  { id: 'model-yaml', path: '/api/v1/models/:param/yaml', methods: ['GET', 'POST', 'DELETE'], status: 'documented_current', workflows: ['dashboard_migrator', 'model_migrator', 'semantic_studio', 'bi_migration_studio'], docsUrl: 'https://docs.omni.co/api/models/get-model-yaml', probeMode: 'controlled_write' },
  { id: 'query-run', path: '/api/v1/query/run', methods: ['POST'], status: 'documented_current', workflows: ['dashboard_migrator', 'deck_builder', 'semantic_studio', 'bi_migration_studio'], docsUrl: 'https://docs.omni.co/guides/api/run-document-queries', probeMode: 'controlled_write' },
  { id: 'query-wait', path: '/api/v1/query/wait', methods: ['GET'], status: 'unverified', workflows: ['dashboard_migrator'], docsUrl: API_INDEX, probeMode: 'read_only', notes: 'Confirm current version and wait contract in the target instance API Explorer.' },
  { id: 'schedules', path: '/api/v1/schedules', methods: ['GET', 'POST'], status: 'documented_current', workflows: ['schedules'], docsUrl: 'https://docs.omni.co/api/schedules/create-schedule', probeMode: 'controlled_write' },
  { id: 'schedule', path: '/api/v1/schedules/:param', methods: ['PUT', 'DELETE'], status: 'documented_current', workflows: ['schedules'], docsUrl: API_INDEX, probeMode: 'controlled_write' },
  { id: 'schedule-pause', path: '/api/v1/schedules/:param/pause', methods: ['PUT'], status: 'documented_current', workflows: ['schedules'], docsUrl: API_INDEX, probeMode: 'controlled_write' },
  { id: 'schedule-resume', path: '/api/v1/schedules/:param/resume', methods: ['PUT'], status: 'documented_current', workflows: ['schedules'], docsUrl: API_INDEX, probeMode: 'controlled_write' },
  { id: 'schedule-trigger', path: '/api/v1/schedules/:param/trigger', methods: ['POST'], status: 'documented_current', workflows: ['schedules'], docsUrl: API_INDEX, probeMode: 'controlled_write' },
  { id: 'uploads', path: '/api/v1/uploads', methods: ['GET'], status: 'documented_current', workflows: ['upload_governance'], docsUrl: API_INDEX, probeMode: 'read_only' },
  { id: 'user-attributes', path: '/api/v1/user-attributes', methods: ['GET'], status: 'documented_current', workflows: ['user_management'], docsUrl: API_INDEX, probeMode: 'read_only' },
  { id: 'user-group-model-roles', path: '/api/v1/user-groups/:param/model-roles', methods: ['GET', 'POST'], status: 'documented_current', workflows: ['dashboard_migrator', 'user_management'], docsUrl: API_INDEX, probeMode: 'controlled_write' },
  { id: 'user-model-roles', path: '/api/v1/users/:param/model-roles', methods: ['GET', 'POST'], status: 'documented_current', workflows: ['dashboard_migrator', 'user_management'], docsUrl: API_INDEX, probeMode: 'controlled_write' },
  { id: 'documents-v2-create', path: '/api/v2/documents', methods: ['POST'], status: 'documented_current', workflows: ['dashboard_migrator', 'deck_builder', 'ai_dashboard_studio'], docsUrl: 'https://docs.omni.co/api/documents-v2/create-document', probeMode: 'controlled_write' },
  { id: 'documents-v2-state', path: '/api/v2/documents/:param', methods: ['GET'], status: 'documented_current', workflows: ['dashboard_migrator', 'deck_builder', 'ai_dashboard_studio'], docsUrl: 'https://docs.omni.co/api/documents-v2/get-document-state', probeMode: 'read_only' },
  { id: 'documents-v2-draft-create', path: '/api/v2/documents/:param/draft', methods: ['PATCH'], status: 'documented_current', workflows: ['dashboard_migrator', 'dashboard_operations'], docsUrl: 'https://docs.omni.co/api/documents-v2/create-draft-and-patch-document', probeMode: 'controlled_write' },
  { id: 'documents-v2-draft-state', path: '/api/v2/documents/:param/draft/:param', methods: ['GET', 'PATCH'], status: 'documented_current', workflows: ['dashboard_migrator', 'dashboard_operations'], docsUrl: 'https://docs.omni.co/api/documents-v2/get-document-draft', probeMode: 'controlled_write' },
  { id: 'documents-v2-draft-publish', path: '/api/v2/documents/:param/draft/publish', methods: ['POST'], status: 'documented_current', workflows: ['dashboard_migrator', 'dashboard_operations'], docsUrl: 'https://docs.omni.co/api/documents-v2/publish-document-draft', probeMode: 'controlled_write' },
  { id: 'scim-embed-users', path: '/api/scim/v2/embed/users', methods: ['GET'], status: 'documented_current', workflows: ['user_management'], docsUrl: API_INDEX, probeMode: 'read_only' },
  { id: 'scim-groups', path: '/api/scim/v2/groups', methods: ['GET', 'POST'], status: 'documented_current', workflows: ['user_management'], docsUrl: 'https://docs.omni.co/api/user-groups/create-user-group', probeMode: 'controlled_write' },
  { id: 'scim-group', path: '/api/scim/v2/groups/:param', methods: ['GET', 'PUT', 'PATCH'], status: 'documented_current', workflows: ['user_management'], docsUrl: 'https://docs.omni.co/api/user-groups/update-user-group', probeMode: 'controlled_write' },
  { id: 'scim-users', path: '/api/scim/v2/users', methods: ['GET', 'POST'], status: 'documented_current', workflows: ['user_management'], docsUrl: 'https://docs.omni.co/api/users/create-user', probeMode: 'controlled_write' },
  { id: 'scim-user', path: '/api/scim/v2/users/:param', methods: ['PUT', 'DELETE'], status: 'documented_current', workflows: ['user_management'], docsUrl: 'https://docs.omni.co/api/users/replace-user', probeMode: 'controlled_write' },
];

function patternRegex(pattern: string): RegExp {
  const escaped = pattern
    .split(':param')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]+');
  return new RegExp(`^${escaped}$`);
}

export function findOmniApiContract(method: string, path: string): OmniApiContract | undefined {
  const upperMethod = method.toUpperCase();
  return OMNI_API_CONTRACTS.find((contract) => (
    contract.methods.includes(upperMethod) && patternRegex(contract.path).test(path)
  ));
}

export type OmniApiFailureClass = 'transient' | 'authentication' | 'contract' | 'request' | 'unknown';

export function classifyOmniApiFailure(status: number): OmniApiFailureClass {
  if (status === 408 || status === 429 || status >= 500) return 'transient';
  if (status === 401 || status === 403) return 'authentication';
  if (status === 404 || status === 405 || status === 410) return 'contract';
  if (status >= 400 && status < 500) return 'request';
  return 'unknown';
}

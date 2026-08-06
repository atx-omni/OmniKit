import Ajv2020 from 'ajv/dist/2020.js';
import { parse } from 'yaml';

export const SEMANTIC_MIGRATION_PLAN_CONTRACT = 'plan.v2' as const;
export const SEMANTIC_MIGRATION_COMPILE_CONTRACT = 'compile.v2' as const;
export const SEMANTIC_MIGRATION_REPAIR_CONTRACT = 'repair.v2' as const;
export const MAX_SEMANTIC_MIGRATION_REPAIR_ATTEMPTS = 1 as const;

export type SemanticMigrationStage = 'plan' | 'compile' | 'repair';
export type SemanticMigrationStageContractId =
  | typeof SEMANTIC_MIGRATION_PLAN_CONTRACT
  | typeof SEMANTIC_MIGRATION_COMPILE_CONTRACT
  | typeof SEMANTIC_MIGRATION_REPAIR_CONTRACT;

const semanticFileSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    fileName: { type: 'string', minLength: 1, maxLength: 512 },
    yaml: { type: 'string', minLength: 1 },
    decisionIds: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true },
    placementIds: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true },
    evidenceIds: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 }, uniqueItems: true },
    definitions: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', minLength: 1 },
          decisionIds: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true },
          placementIds: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true },
          evidenceIds: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 }, uniqueItems: true },
        },
        required: ['path', 'decisionIds', 'placementIds', 'evidenceIds'],
      },
    },
    baseDigest: { type: ['string', 'null'], minLength: 1 },
  },
  required: ['fileName', 'yaml', 'decisionIds', 'placementIds', 'evidenceIds', 'definitions', 'baseDigest'],
} as const;

export const SEMANTIC_MIGRATION_PLAN_V2_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    contractVersion: { const: SEMANTIC_MIGRATION_PLAN_CONTRACT },
    stage: { const: 'plan' },
    status: { enum: ['review_required', 'ready', 'blocked'] },
    message: { type: 'string', minLength: 1 },
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1 },
          nodeId: { type: 'string', minLength: 1 },
          semanticKind: {
            enum: [
              'data_source', 'model', 'view', 'field', 'measure', 'relationship', 'topic',
              'composite_topic', 'query_view', 'filter', 'permission', 'schedule', 'dashboard',
              'visual', 'upstream_transformation',
            ],
          },
          action: { enum: ['map_existing', 'create_new', 'rewrite', 'exclude', 'defer'] },
          targetFileName: { type: ['string', 'null'] },
          rationale: { type: 'string', minLength: 1 },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          evidenceIds: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true },
          requiresWrite: { type: 'boolean' },
        },
        required: ['id', 'nodeId', 'semanticKind', 'action', 'targetFileName', 'rationale', 'confidence', 'evidenceIds', 'requiresWrite'],
      },
    },
    dashboardPlans: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1 },
          sourceDashboardId: { type: 'string', minLength: 1 },
          name: { type: 'string', minLength: 1 },
          summary: { type: 'string', minLength: 1 },
          dependencyIds: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true },
          sourceEvidenceIds: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true },
        },
        required: ['id', 'sourceDashboardId', 'name', 'summary', 'dependencyIds', 'sourceEvidenceIds'],
      },
    },
    warnings: { type: 'array', items: { type: 'string', minLength: 1 } },
  },
  required: ['contractVersion', 'stage', 'status', 'message', 'decisions', 'dashboardPlans', 'warnings'],
};

export const SEMANTIC_MIGRATION_COMPILE_V2_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    contractVersion: { const: SEMANTIC_MIGRATION_COMPILE_CONTRACT },
    stage: { const: 'compile' },
    status: { enum: ['writes', 'no_op'] },
    message: { type: 'string', minLength: 1 },
    files: { type: 'array', items: semanticFileSchema },
    warnings: { type: 'array', items: { type: 'string', minLength: 1 } },
  },
  required: ['contractVersion', 'stage', 'status', 'message', 'files', 'warnings'],
};

export const SEMANTIC_MIGRATION_REPAIR_V2_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    contractVersion: { const: SEMANTIC_MIGRATION_REPAIR_CONTRACT },
    stage: { const: 'repair' },
    attempt: { const: MAX_SEMANTIC_MIGRATION_REPAIR_ATTEMPTS },
    status: { enum: ['repaired', 'no_change'] },
    message: { type: 'string', minLength: 1 },
    files: { type: 'array', items: semanticFileSchema },
    warnings: { type: 'array', items: { type: 'string', minLength: 1 } },
  },
  required: ['contractVersion', 'stage', 'attempt', 'status', 'message', 'files', 'warnings'],
};

export interface SemanticMigrationStageContractDefinition {
  id: SemanticMigrationStageContractId;
  stage: SemanticMigrationStage;
  schemaName: string;
  schema: Record<string, unknown>;
}

export const SEMANTIC_MIGRATION_STAGE_CONTRACTS: Record<SemanticMigrationStageContractId, SemanticMigrationStageContractDefinition> = {
  [SEMANTIC_MIGRATION_PLAN_CONTRACT]: {
    id: SEMANTIC_MIGRATION_PLAN_CONTRACT,
    stage: 'plan',
    schemaName: 'semantic_migration_plan_v2',
    schema: SEMANTIC_MIGRATION_PLAN_V2_SCHEMA,
  },
  [SEMANTIC_MIGRATION_COMPILE_CONTRACT]: {
    id: SEMANTIC_MIGRATION_COMPILE_CONTRACT,
    stage: 'compile',
    schemaName: 'semantic_migration_compile_v2',
    schema: SEMANTIC_MIGRATION_COMPILE_V2_SCHEMA,
  },
  [SEMANTIC_MIGRATION_REPAIR_CONTRACT]: {
    id: SEMANTIC_MIGRATION_REPAIR_CONTRACT,
    stage: 'repair',
    schemaName: 'semantic_migration_repair_v2',
    schema: SEMANTIC_MIGRATION_REPAIR_V2_SCHEMA,
  },
};

export interface SemanticMigrationGeneratedFile {
  fileName: string;
  yaml: string;
  decisionIds: string[];
  placementIds: string[];
  evidenceIds: string[];
  definitions: Array<{
    path: string;
    decisionIds: string[];
    placementIds: string[];
    evidenceIds: string[];
  }>;
  baseDigest: string | null;
}

export interface SemanticMigrationPlanV2Output {
  contractVersion: typeof SEMANTIC_MIGRATION_PLAN_CONTRACT;
  stage: 'plan';
  status: 'review_required' | 'ready' | 'blocked';
  message: string;
  decisions: Array<{
    id: string;
    nodeId: string;
    semanticKind: string;
    action: 'map_existing' | 'create_new' | 'rewrite' | 'exclude' | 'defer';
    targetFileName: string | null;
    rationale: string;
    confidence: number;
    evidenceIds: string[];
    requiresWrite: boolean;
  }>;
  dashboardPlans: Array<{
    id: string;
    sourceDashboardId: string;
    name: string;
    summary: string;
    dependencyIds: string[];
    sourceEvidenceIds: string[];
  }>;
  warnings: string[];
}

export interface SemanticMigrationCompileV2Output {
  contractVersion: typeof SEMANTIC_MIGRATION_COMPILE_CONTRACT;
  stage: 'compile';
  status: 'writes' | 'no_op';
  message: string;
  files: SemanticMigrationGeneratedFile[];
  warnings: string[];
}

export interface SemanticMigrationRepairV2Output {
  contractVersion: typeof SEMANTIC_MIGRATION_REPAIR_CONTRACT;
  stage: 'repair';
  attempt: typeof MAX_SEMANTIC_MIGRATION_REPAIR_ATTEMPTS;
  status: 'repaired' | 'no_change';
  message: string;
  files: SemanticMigrationGeneratedFile[];
  warnings: string[];
}

export type SemanticMigrationStageOutput =
  | SemanticMigrationPlanV2Output
  | SemanticMigrationCompileV2Output
  | SemanticMigrationRepairV2Output;

export interface SemanticMigrationContractValidationContext {
  expectedWriteCount?: number;
  approvedIntentIds?: readonly string[];
  allowedEvidenceIds?: readonly string[];
  allowedFileNames?: readonly string[];
  baselineDigests?: Readonly<Record<string, string>>;
  repairAttempt?: number;
}

export interface SemanticMigrationContractValidationResult<T extends SemanticMigrationStageOutput = SemanticMigrationStageOutput> {
  ok: boolean;
  issues: string[];
  output?: T;
}

export class SemanticMigrationContractError extends Error {
  readonly contractId: SemanticMigrationStageContractId;
  readonly issues: string[];
  readonly statusCode = 502;

  constructor(contractId: SemanticMigrationStageContractId, issues: string[]) {
    super(`${contractId} response failed contract validation: ${issues.join('; ')}`);
    this.name = 'SemanticMigrationContractError';
    this.contractId = contractId;
    this.issues = issues;
  }
}

export class SemanticMigrationStageIsolationError extends Error {
  readonly stage: 'compile' | 'repair';
  readonly issues: string[];

  constructor(stage: 'compile' | 'repair', issues: string[]) {
    super(`${stage} input violated stage isolation: ${issues.join('; ')}`);
    this.name = 'SemanticMigrationStageIsolationError';
    this.stage = stage;
    this.issues = issues;
  }
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validators = new Map<SemanticMigrationStageContractId, ReturnType<typeof ajv.compile>>(
  Object.values(SEMANTIC_MIGRATION_STAGE_CONTRACTS).map((contract) => [contract.id, ajv.compile(contract.schema)]),
);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function schemaValidationIssues(contractId: SemanticMigrationStageContractId, output: unknown): string[] {
  const validator = validators.get(contractId);
  if (!validator) return [`No validator is registered for ${contractId}.`];
  if (validator(output)) return [];
  return (validator.errors || []).map((error) => {
    const location = error.instancePath || '$';
    return `${location} ${error.message || 'is invalid'}`;
  });
}

function uniqueValueIssues(values: readonly string[], label: string): string[] {
  const duplicates = values.filter((value, index) => values.indexOf(value) !== index);
  return Array.from(new Set(duplicates)).map((value) => `${label} contains duplicate value "${value}".`);
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function semanticMigrationDefinitionPaths(fileName: string, yaml: string): string[] {
  try {
    const body = recordValue(parse(yaml));
    if (!body) return ['$'];
    const definitionSections = fileName.endsWith('.view')
      ? ['dimensions', 'measures', 'parameters']
      : fileName.endsWith('.topic')
        ? ['fields', 'views', 'filters']
        : [];
    const paths = definitionSections.flatMap((section) => {
      const definitions = recordValue(body[section]);
      return definitions ? Object.keys(definitions).map((name) => `${section}.${name}`) : [];
    });
    return ['$', ...paths.sort()];
  } catch {
    return ['$'];
  }
}

export function semanticMigrationFileNameIssues(fileName: string): string[] {
  if (fileName === 'model' || fileName === 'relationships') return [];
  if (fileName.startsWith('/') || fileName.includes('\\') || fileName.split('/').some((part) => !part || part === '.' || part === '..')) {
    return [`${fileName} is not a safe relative semantic file path.`];
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*)*\.(?:view|topic)$/.test(fileName)) {
    return [`${fileName} is not a supported Omni semantic file name.`];
  }
  return [];
}

function generatedFileSemanticIssues(
  files: readonly SemanticMigrationGeneratedFile[],
  context: SemanticMigrationContractValidationContext,
): string[] {
  const issues = uniqueValueIssues(files.map((file) => file.fileName), 'files');
  const approvedIntentIds = new Set(context.approvedIntentIds || []);
  const allowedEvidenceIds = new Set(context.allowedEvidenceIds || []);
  const allowedFileNames = new Set(context.allowedFileNames || []);
  const coveredIntentIds = new Set<string>();

  files.forEach((file) => {
    issues.push(...semanticMigrationFileNameIssues(file.fileName));
    if (/```/.test(file.yaml)) issues.push(`${file.fileName} contains a markdown fence instead of a YAML body.`);

    const fileIntentIds = [...file.decisionIds, ...file.placementIds];
    if ((context.expectedWriteCount || 0) > 0 && fileIntentIds.length === 0) {
      issues.push(`${file.fileName} is not linked to an approved decision or placement.`);
    }
    fileIntentIds.forEach((intentId) => {
      coveredIntentIds.add(intentId);
      if (approvedIntentIds.size > 0 && !approvedIntentIds.has(intentId)) {
        issues.push(`${file.fileName} references unapproved intent "${intentId}".`);
      }
    });
    file.evidenceIds.forEach((evidenceId) => {
      if (allowedEvidenceIds.size > 0 && !allowedEvidenceIds.has(evidenceId)) {
        issues.push(`${file.fileName} references unknown evidence "${evidenceId}".`);
      }
    });
    const expectedDefinitionPaths = semanticMigrationDefinitionPaths(file.fileName, file.yaml);
    const attributedDefinitionPaths = file.definitions.map((definition) => definition.path);
    issues.push(...uniqueValueIssues(attributedDefinitionPaths, `${file.fileName} definitions`));
    expectedDefinitionPaths.forEach((path) => {
      if (!attributedDefinitionPaths.includes(path)) issues.push(`${file.fileName} definition "${path}" has no approved intent and evidence attribution.`);
    });
    attributedDefinitionPaths.forEach((path) => {
      if (!expectedDefinitionPaths.includes(path)) issues.push(`${file.fileName} attributes unknown definition path "${path}".`);
    });
    file.definitions.forEach((definition) => {
      const definitionIntentIds = [...definition.decisionIds, ...definition.placementIds];
      if (definitionIntentIds.length === 0) issues.push(`${file.fileName} definition "${definition.path}" is not linked to an approved decision or placement.`);
      definitionIntentIds.forEach((intentId) => {
        if (approvedIntentIds.size > 0 && !approvedIntentIds.has(intentId)) {
          issues.push(`${file.fileName} definition "${definition.path}" references unapproved intent "${intentId}".`);
        }
      });
      definition.evidenceIds.forEach((evidenceId) => {
        if (allowedEvidenceIds.size > 0 && !allowedEvidenceIds.has(evidenceId)) {
          issues.push(`${file.fileName} definition "${definition.path}" references unknown evidence "${evidenceId}".`);
        }
      });
    });
    if (allowedFileNames.size > 0 && !allowedFileNames.has(file.fileName)) {
      issues.push(`${file.fileName} was not an approved target file.`);
    }

    const expectedBaseDigest = context.baselineDigests?.[file.fileName];
    if (expectedBaseDigest && file.baseDigest !== expectedBaseDigest) {
      issues.push(`${file.fileName} does not carry the current baseline digest.`);
    }
    if (!expectedBaseDigest && file.baseDigest !== null) {
      issues.push(`${file.fileName} supplies a base digest for a new file.`);
    }
  });

  approvedIntentIds.forEach((intentId) => {
    if (!coveredIntentIds.has(intentId)) issues.push(`Approved intent "${intentId}" is not covered by any generated file.`);
  });
  return issues;
}

function planSemanticIssues(output: SemanticMigrationPlanV2Output): string[] {
  const issues = uniqueValueIssues(output.decisions.map((decision) => decision.id), 'decisions');
  output.decisions.forEach((decision) => {
    const actionRequiresWrite = decision.action === 'create_new' || decision.action === 'rewrite';
    if (decision.requiresWrite !== actionRequiresWrite) {
      issues.push(`Decision "${decision.id}" has inconsistent requiresWrite semantics.`);
    }
    if (decision.requiresWrite && !decision.targetFileName) {
      issues.push(`Decision "${decision.id}" requires a write but has no target file.`);
    }
    if (decision.requiresWrite && decision.evidenceIds.length === 0) {
      issues.push(`Decision "${decision.id}" requires a write but has no evidence.`);
    }
    if (decision.targetFileName) issues.push(...semanticMigrationFileNameIssues(decision.targetFileName));
  });
  return issues;
}

function compileSemanticIssues(output: SemanticMigrationCompileV2Output, context: SemanticMigrationContractValidationContext): string[] {
  const expectedWriteCount = context.expectedWriteCount || 0;
  const issues: string[] = [];
  if (expectedWriteCount > 0) {
    if (output.status !== 'writes') issues.push('Compile status must be writes when approved intent requires a write.');
    if (output.files.length === 0) issues.push('Compile returned files:[] even though approved intent requires a write.');
  } else {
    if (output.status !== 'no_op') issues.push('Compile status must be no_op when there is no approved write intent.');
    if (output.files.length > 0) issues.push('Compile returned files even though the approved intent is an explicit no-op.');
  }
  issues.push(...generatedFileSemanticIssues(output.files, context));
  return issues;
}

function repairSemanticIssues(output: SemanticMigrationRepairV2Output, context: SemanticMigrationContractValidationContext): string[] {
  const expectedWriteCount = context.expectedWriteCount || 0;
  const issues: string[] = [];
  if (context.repairAttempt !== MAX_SEMANTIC_MIGRATION_REPAIR_ATTEMPTS) {
    issues.push(`Repair attempt must be ${MAX_SEMANTIC_MIGRATION_REPAIR_ATTEMPTS}.`);
  }
  if (expectedWriteCount > 0) {
    if (output.status !== 'repaired') issues.push('Repair status must be repaired while required writes remain invalid.');
    if (output.files.length === 0) issues.push('Repair returned files:[] while required writes remain invalid.');
  } else {
    if (output.status !== 'no_change') issues.push('Repair status must be no_change when no writes are required.');
    if (output.files.length > 0) issues.push('Repair returned files for an explicit no-op.');
  }
  issues.push(...generatedFileSemanticIssues(output.files, context));
  return issues;
}

export function semanticMigrationStageContract(contractId: SemanticMigrationStageContractId): SemanticMigrationStageContractDefinition {
  return SEMANTIC_MIGRATION_STAGE_CONTRACTS[contractId];
}

export function validateSemanticMigrationStageOutput<T extends SemanticMigrationStageOutput = SemanticMigrationStageOutput>(
  contractId: SemanticMigrationStageContractId,
  output: unknown,
  context: SemanticMigrationContractValidationContext = {},
): SemanticMigrationContractValidationResult<T> {
  const issues = schemaValidationIssues(contractId, output);
  if (issues.length > 0) return { ok: false, issues };

  let semanticIssues: string[] = [];
  if (contractId === SEMANTIC_MIGRATION_PLAN_CONTRACT) {
    semanticIssues = planSemanticIssues(output as SemanticMigrationPlanV2Output);
  } else if (contractId === SEMANTIC_MIGRATION_COMPILE_CONTRACT) {
    semanticIssues = compileSemanticIssues(output as SemanticMigrationCompileV2Output, context);
  } else {
    semanticIssues = repairSemanticIssues(output as SemanticMigrationRepairV2Output, context);
  }
  return semanticIssues.length > 0
    ? { ok: false, issues: semanticIssues }
    : { ok: true, issues: [], output: output as T };
}

export function assertSemanticMigrationStageOutput<T extends SemanticMigrationStageOutput = SemanticMigrationStageOutput>(
  contractId: SemanticMigrationStageContractId,
  output: unknown,
  context: SemanticMigrationContractValidationContext = {},
): T {
  const result = validateSemanticMigrationStageOutput<T>(contractId, output, context);
  if (!result.ok || !result.output) throw new SemanticMigrationContractError(contractId, result.issues);
  return result.output;
}

const FORBIDDEN_STAGE_INPUT_KEYS = /^(?:confirmedPlan|planMessage|planText|rawPlan)$/i;
const FORBIDDEN_STAGE_DIRECTIVES = [
  { label: 'PLAN ONLY directive', pattern: /\bPLAN\s+ONLY\b/i },
  { label: 'no-YAML directive', pattern: /\bNO[\s_-]*YAML\b/i },
  { label: 'YAML prohibition', pattern: /\bDO\s+NOT\s+(?:RETURN|GENERATE|EMIT|PRODUCE|WRITE)\s+(?:DEPLOYABLE\s+)?YAML\b/i },
] as const;

export function semanticMigrationStageIsolationIssues(value: unknown): string[] {
  const issues: string[] = [];
  const seen = new WeakSet<object>();

  function inspect(candidate: unknown, path: string): void {
    if (typeof candidate === 'string') {
      FORBIDDEN_STAGE_DIRECTIVES.forEach(({ label, pattern }) => {
        if (pattern.test(candidate)) issues.push(`${path} contains a ${label}.`);
      });
      return;
    }
    if (!candidate || typeof candidate !== 'object') return;
    if (seen.has(candidate)) return;
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      candidate.forEach((item, index) => inspect(item, `${path}[${index}]`));
      return;
    }
    Object.entries(asRecord(candidate)).forEach(([key, item]) => {
      const childPath = `${path}.${key}`;
      if (FORBIDDEN_STAGE_INPUT_KEYS.test(key)) issues.push(`${childPath} is a forbidden raw-plan field.`);
      inspect(item, childPath);
    });
  }

  inspect(value, '$');
  return Array.from(new Set(issues));
}

export function assertSemanticMigrationStageIsolation(stage: 'compile' | 'repair', value: unknown): void {
  const issues = semanticMigrationStageIsolationIssues(value);
  if (issues.length > 0) throw new SemanticMigrationStageIsolationError(stage, issues);
}

export interface FreshSemanticMigrationStageMetadata {
  contractVersion: SemanticMigrationStageContractId;
  stage: SemanticMigrationStage;
  runId: string;
  parentRunId?: string;
  conversationMode: 'fresh';
  conversationId?: undefined;
  repairAttempt: 0 | 1;
}

export function nextSemanticMigrationRepairAttempt(previousAttempts: number): 1 {
  if (!Number.isInteger(previousAttempts) || previousAttempts < 0) {
    throw new Error('Previous repair attempts must be a non-negative integer.');
  }
  if (previousAttempts >= MAX_SEMANTIC_MIGRATION_REPAIR_ATTEMPTS) {
    throw new Error('The bounded semantic migration repair attempt has already been used.');
  }
  return 1;
}

export function createFreshSemanticMigrationStageMetadata(
  stage: SemanticMigrationStage,
  runId: string,
  options: { parentRunId?: string; previousRepairAttempts?: number } = {},
): FreshSemanticMigrationStageMetadata {
  if (!runId.trim()) throw new Error('A stage run ID is required.');
  const contractVersion = stage === 'plan'
    ? SEMANTIC_MIGRATION_PLAN_CONTRACT
    : stage === 'compile'
      ? SEMANTIC_MIGRATION_COMPILE_CONTRACT
      : SEMANTIC_MIGRATION_REPAIR_CONTRACT;
  const repairAttempt = stage === 'repair'
    ? nextSemanticMigrationRepairAttempt(options.previousRepairAttempts || 0)
    : 0;
  return {
    contractVersion,
    stage,
    runId: runId.trim(),
    parentRunId: options.parentRunId?.trim() || undefined,
    conversationMode: 'fresh',
    conversationId: undefined,
    repairAttempt,
  };
}

export function assertFreshSemanticMigrationStageMetadata(
  metadata: FreshSemanticMigrationStageMetadata,
  expectedStage: SemanticMigrationStage,
): void {
  const expectedContract = expectedStage === 'plan'
    ? SEMANTIC_MIGRATION_PLAN_CONTRACT
    : expectedStage === 'compile'
      ? SEMANTIC_MIGRATION_COMPILE_CONTRACT
      : SEMANTIC_MIGRATION_REPAIR_CONTRACT;
  const candidate = metadata as FreshSemanticMigrationStageMetadata & { conversationId?: string };
  if (metadata.stage !== expectedStage || metadata.contractVersion !== expectedContract) {
    throw new Error(`Stage metadata must use the ${expectedContract} contract.`);
  }
  if (metadata.conversationMode !== 'fresh' || candidate.conversationId) {
    throw new Error(`${expectedStage} must start a fresh AI conversation.`);
  }
  if (expectedStage === 'repair' && metadata.repairAttempt !== 1) {
    throw new Error('Repair metadata must describe the single allowed repair attempt.');
  }
  if (expectedStage !== 'repair' && metadata.repairAttempt !== 0) {
    throw new Error(`${expectedStage} metadata cannot carry a repair attempt.`);
  }
}

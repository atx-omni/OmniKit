import type {
  TransformationDeploymentPlan,
  TransformationDeploymentResult,
  TransformationPackage,
  TransformationTargetKind,
  TransformationValidationCheck,
  TransformationValidationReport,
} from './types';
import { TRANSFORMATION_TARGET_CAPABILITIES, transformationAdapterConformanceIssues } from './transformationAdapters';

const FORBIDDEN_SQL = /\b(drop|truncate|delete|update|insert|merge|alter|grant|revoke|call|execute\s+immediate|copy\s+into|put|remove)\b/i;
const CREATE_OR_REPLACE = /\bcreate\s+or\s+replace\b/i;
const SECRET_ASSIGNMENT = /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|private[_-]?key)\b\s*[:=]/i;
const PRODUCTION_LABEL = /(^|\b|[_-])(prod|production)(\b|[_-]|$)/i;

export type TransformationValidationEvidence = {
  schemaValidated?: boolean;
  grainValidated?: boolean;
  resultValidated?: boolean;
  dialectValidated?: boolean;
};

function check(
  id: string,
  category: TransformationValidationCheck['category'],
  label: string,
  status: TransformationValidationCheck['status'],
  blocking: boolean,
  message: string,
  operationIds: string[] = [],
): TransformationValidationCheck {
  return { id, category, label, status, blocking, message, operationIds };
}

export function unsafeTransformationSqlIssues(pkg: TransformationPackage): string[] {
  return pkg.files.flatMap((file) => {
    if (file.mediaType !== 'text/sql') return [];
    const issues: string[] = [];
    if (FORBIDDEN_SQL.test(file.content)) issues.push(`${file.path} contains a destructive or side-effecting SQL operation.`);
    if (CREATE_OR_REPLACE.test(file.content)) issues.push(`${file.path} replaces an existing object instead of using additive create-only behavior.`);
    if (SECRET_ASSIGNMENT.test(file.content)) issues.push(`${file.path} contains secret-shaped content.`);
    return issues;
  });
}

export function validateTransformationPackage(input: {
  package: TransformationPackage;
  target?: TransformationTargetKind;
  evidence?: TransformationValidationEvidence;
  deploymentPlan?: TransformationDeploymentPlan;
}): TransformationValidationReport {
  const pkg = input.package;
  const target = input.target || pkg.target;
  const checks: TransformationValidationCheck[] = [];
  const contractIssues = [
    ...(pkg.schemaVersion === '1.0' ? [] : ['Unsupported transformation package schema.']),
    ...(pkg.operations.length > 0 && pkg.files.length === 0 ? ['The package has operations but no rendered files.'] : []),
    ...pkg.files.filter((file) => !file.sha256).map((file) => `${file.path} is missing a checksum.`),
  ];
  checks.push(check(
    'transformation-contract',
    'contract',
    'Portable package contract',
    contractIssues.length === 0 ? 'passed' : 'blocked',
    true,
    contractIssues.length === 0 ? 'The package is versioned, rendered, and checksummed.' : contractIssues.join(' '),
    pkg.operations.map((operation) => operation.id),
  ));

  const operationIds = new Set(pkg.operations.map((operation) => operation.id));
  const nodeOperationIds = new Map(pkg.operations.map((operation) => [operation.nodeId, operation.id]));
  const dependencyIssues = pkg.operations.flatMap((operation) => operation.dependencies.flatMap((dependency) => {
    const dependencyOperation = nodeOperationIds.get(dependency);
    return dependencyOperation && operationIds.has(dependencyOperation) ? [] : [`${operation.name} references missing packaged dependency ${dependency}.`];
  }));
  checks.push(check(
    'transformation-dependencies',
    'dependency',
    'Dependency order',
    dependencyIssues.length === 0 ? 'passed' : 'blocked',
    true,
    dependencyIssues.length === 0 ? 'Every packaged dependency is present in deterministic execution order.' : dependencyIssues.join(' '),
    pkg.operations.map((operation) => operation.id),
  ));

  const securityIssues = unsafeTransformationSqlIssues(pkg);
  checks.push(check(
    'transformation-security',
    'security',
    'Additive SQL safety',
    securityIssues.length === 0 ? 'passed' : 'blocked',
    true,
    securityIssues.length === 0 ? 'No destructive, replacement, side-effecting, or secret-shaped SQL was detected.' : securityIssues.join(' '),
    pkg.operations.map((operation) => operation.id),
  ));

  const adapterIssues = transformationAdapterConformanceIssues(pkg, target);
  const dialectReady = adapterIssues.length === 0 && input.evidence?.dialectValidated === true;
  checks.push(check(
    'transformation-dialect',
    'dialect',
    'Target dialect',
    adapterIssues.length > 0 ? 'blocked' : dialectReady || pkg.operations.length === 0 ? 'passed' : 'pending',
    true,
    adapterIssues.length > 0
      ? adapterIssues.join(' ')
      : pkg.operations.length === 0
        ? 'No upstream SQL requires dialect validation.'
        : dialectReady
          ? `The ${TRANSFORMATION_TARGET_CAPABILITIES[target].label} dialect was reviewed.`
          : `Review or execute the generated ${TRANSFORMATION_TARGET_CAPABILITIES[target].label} package in development.`,
    pkg.operations.map((operation) => operation.id),
  ));

  for (const [category, ready, message] of [
    ['schema', input.evidence?.schemaValidated, 'Confirm the generated objects expose the required columns and types.'],
    ['grain', input.evidence?.grainValidated, 'Confirm row grain and uniqueness match the selected dashboards.'],
    ['result', input.evidence?.resultValidated, 'Compare representative source and target query results.'],
  ] as const) {
    checks.push(check(
      `transformation-${category}`,
      category,
      `${category[0]!.toUpperCase()}${category.slice(1)} validation`,
      pkg.operations.length === 0 || ready ? 'passed' : 'pending',
      true,
      pkg.operations.length === 0 ? 'No upstream transformation requires this check.' : ready ? `${category} evidence is confirmed.` : message,
      pkg.operations.map((operation) => operation.id),
    ));
  }

  if (input.deploymentPlan) {
    const plan = input.deploymentPlan;
    const capability = TRANSFORMATION_TARGET_CAPABILITIES[plan.target];
    const deploymentIssues = [
      ...(plan.mode === 'deploy' && !capability.supportsDeployment ? [`${capability.label} is export-only in OmniKit.`] : []),
      ...(plan.mode === 'deploy' && !plan.explicitlyApproved ? ['Direct deployment was not explicitly approved.'] : []),
      ...(plan.mode === 'deploy' && plan.productionLike ? ['Direct deployment to production-like targets is blocked.'] : []),
    ];
    checks.push(check(
      'transformation-deployment',
      'deployment',
      'Deployment safety',
      deploymentIssues.length === 0 ? 'passed' : 'blocked',
      true,
      deploymentIssues.length === 0 ? `${plan.mode === 'deploy' ? 'Development deployment' : 'Export'} is approved.` : deploymentIssues.join(' '),
      pkg.operations.map((operation) => operation.id),
    ));
  }

  return {
    schemaVersion: '1.0',
    generatedAt: new Date().toISOString(),
    ready: checks.every((item) => !item.blocking || item.status === 'passed'),
    checks,
  };
}

export function createTransformationDeploymentPlan(input: {
  package: TransformationPackage;
  mode: 'export' | 'deploy';
  environmentLabel: string;
  explicitlyApproved?: boolean;
}): TransformationDeploymentPlan {
  const productionLike = PRODUCTION_LABEL.test(input.environmentLabel.trim());
  return {
    id: `deployment:${input.package.packageId}:${input.mode}`,
    target: input.package.target,
    mode: input.mode,
    environmentLabel: input.environmentLabel.trim() || 'development',
    productionLike,
    explicitlyApproved: input.mode === 'export' || input.explicitlyApproved === true,
    orderedFileIds: [...input.package.files]
      .sort((left, right) => left.executionOrder - right.executionOrder)
      .filter((file) => file.mediaType === 'text/sql')
      .map((file) => file.id),
    rollbackInstructions: [...input.package.rollbackInstructions],
  };
}

export function transformationDashboardBuildGate(input: {
  validation: TransformationValidationReport;
  semanticReady: boolean;
  deploymentResult?: TransformationDeploymentResult;
  hasUpstreamOperations: boolean;
}): { ready: boolean; blockers: string[] } {
  const blockers = input.validation.checks
    .filter((item) => item.blocking && item.status !== 'passed')
    .map((item) => item.message);
  if (!input.semanticReady) blockers.push('The reviewed Omni semantic package has not passed validation.');
  if (input.hasUpstreamOperations && input.deploymentResult && !['exported', 'deployed'].includes(input.deploymentResult.status)) {
    blockers.push('The upstream transformation package did not complete successfully.');
  }
  return { ready: blockers.length === 0, blockers: Array.from(new Set(blockers)) };
}

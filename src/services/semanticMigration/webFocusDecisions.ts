import type { SourceInventoryItem } from './studioApi';
import type { MigrationArtifact, MigrationDecision } from './types';
import { mergeMigrationDecisionProposalChunks, withMigrationDecisionIdentity } from './decisionIdentity';
import { sha256Text } from './sourceEvidence';
import {
  WEBFOCUS_DEVELOPMENT_CONTEXT_VERSION,
  webFocusDevelopmentRule,
  type WebFocusDocumentationId,
  type WebFocusEvidenceClass,
  type WebFocusTargetClassification,
} from './webFocusDevelopmentContext';

const MAX_WEBFOCUS_CLASSIFICATIONS = 600;

export const WEBFOCUS_CLASSIFICATION_SCHEMA_VERSION = 'omnikit.webfocus.classification.v1';

export type WebFocusClassificationStatus = 'evidence' | 'ambiguous' | 'unsupported';
export type WebFocusDiagnosticSeverity = 'info' | 'warning' | 'blocker';
export type WebFocusSourceIdentityKind =
  | 'native_id'
  | 'repository_path'
  | 'artifact_path'
  | 'declared_name'
  | 'synthetic';

export type WebFocusDiagnosticCode =
  | 'WF_SOURCE_TRUNCATED'
  | 'WF_EMPTY_ARTIFACT'
  | 'WF_SYNTHETIC_SOURCE_ID'
  | 'WF_UNSUPPORTED_ARTIFACT'
  | 'WF_REPOSITORY_CONTENT_REQUIRED'
  | 'WF_MISSING_MASTER_FILE'
  | 'WF_MISSING_ACCESS_FILE'
  | 'WF_MISSING_INCLUDED_PROCEDURE'
  | 'WF_MISSING_CALLED_PROCEDURE'
  | 'WF_DYNAMIC_DEPENDENCY'
  | 'WF_PARAMETER_SEMANTICS_AMBIGUOUS'
  | 'WF_JOIN_SEMANTICS_AMBIGUOUS'
  | 'WF_FILTER_SEMANTICS_AMBIGUOUS'
  | 'WF_EXPRESSION_TRANSLATION_REQUIRED'
  | 'WF_EXPRESSION_INCOMPLETE'
  | 'WF_PRESENTATION_UNSUPPORTED'
  | 'WF_PROCEDURAL_LOGIC_UNSUPPORTED'
  | 'WF_ACCESS_FILE_HANDOFF_REQUIRED'
  | 'WF_SCHEDULE_HANDOFF_REQUIRED'
  | 'WF_SECURITY_HANDOFF_REQUIRED'
  | 'WF_PORTAL_HANDOFF_REQUIRED'
  | 'WF_REPORT_REQUEST_MISSING'
  | 'WF_CLASSIFICATION_TRUNCATED';

export type WebFocusDependencyKind =
  | 'contains'
  | 'uses_master_file'
  | 'uses_access_file'
  | 'joins_master_file'
  | 'includes_procedure'
  | 'executes_procedure';

export interface WebFocusSourceIdentity {
  sourceId: string;
  kind: WebFocusSourceIdentityKind;
  locator: string;
  syntheticReason?: string;
}

export interface WebFocusEvidenceClassification {
  id: string;
  sourceClass: WebFocusEvidenceClass;
  sourceName: string;
  sourceIdentity: WebFocusSourceIdentity;
  artifactId?: string;
  parentClassificationId?: string;
  status: WebFocusClassificationStatus;
  targetClassification: WebFocusTargetClassification;
  documentationIds: WebFocusDocumentationId[];
  diagnosticCodes: WebFocusDiagnosticCode[];
  attributes: Record<string, string | number | boolean | null>;
}

export interface WebFocusDependencyEdge {
  id: string;
  fromClassificationId: string;
  fromSourceId: string;
  toClassificationId?: string;
  toSourceId: string;
  kind: WebFocusDependencyKind;
  status: 'resolved' | 'missing' | 'dynamic';
  locator: string;
}

export interface WebFocusDiagnostic {
  id: string;
  code: WebFocusDiagnosticCode;
  severity: WebFocusDiagnosticSeverity;
  message: string;
  sourceId?: string;
  artifactId?: string;
  locator?: string;
  classificationId?: string;
  documentationIds: WebFocusDocumentationId[];
}

export interface WebFocusClassificationResult {
  schemaVersion: typeof WEBFOCUS_CLASSIFICATION_SCHEMA_VERSION;
  developmentContextVersion: typeof WEBFOCUS_DEVELOPMENT_CONTEXT_VERSION;
  classifications: WebFocusEvidenceClassification[];
  dependencyEdges: WebFocusDependencyEdge[];
  diagnostics: WebFocusDiagnostic[];
  evidenceComplete: boolean;
  truncated: boolean;
}

export interface WebFocusClassificationInput {
  artifacts?: readonly MigrationArtifact[];
  repositoryItems?: readonly SourceInventoryItem[];
  repositoryTruncated?: boolean;
}

interface MutableWebFocusClassification extends WebFocusEvidenceClassification {
  diagnosticCodes: WebFocusDiagnosticCode[];
}

interface ArtifactRoot {
  artifact: MigrationArtifact;
  root: MutableWebFocusClassification;
  sourceClass: 'master_file' | 'access_file' | 'report_procedure' | 'unknown';
  declaredName: string;
}

function compact(value: string | undefined | null): string {
  return (value || '').trim();
}

function fileStem(name: string): string {
  const normalized = name.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
}

function referenceKey(value: string): string {
  return compact(value)
    .replace(/^['"]|['"]$/g, '')
    .replace(/^IBFS:/i, '')
    .replace(/\\/g, '/')
    .replace(/\.(?:fex|mas|acx)$/i, '')
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase();
}

function encoded(value: string): string {
  return encodeURIComponent(value.trim().toLowerCase());
}

function genericArtifactName(name: string): boolean {
  return /^(?:pasted|uploaded?|source|artifact|webfocus-export)(?:[-_.]|$)/i.test(fileStem(name));
}

function lineLocator(artifact: MigrationArtifact, lineNumber: number): string {
  return `${artifact.name}:line:${lineNumber}`;
}

function sourceLines(artifact: MigrationArtifact): Array<{ lineNumber: number; text: string; trimmed: string }> {
  return artifact.content.replace(/\r\n?/g, '\n').split('\n').map((text, index) => ({
    lineNumber: index + 1,
    text,
    trimmed: text.trim(),
  }));
}

function declaredValue(content: string, attribute: string): string {
  const match = content.match(new RegExp(`\\b${attribute}\\s*=\\s*['"]?([A-Za-z0-9_.$/\\-]+)`, 'i'));
  return compact(match?.[1]);
}

function detectArtifactClass(artifact: MigrationArtifact): ArtifactRoot['sourceClass'] {
  const lower = artifact.name.toLowerCase();
  if (lower.endsWith('.mas')) return 'master_file';
  if (lower.endsWith('.acx')) return 'access_file';
  if (lower.endsWith('.fex')) return 'report_procedure';
  if (/^\s*(?:TABLE|GRAPH)\s+FILE\b/im.test(artifact.content)) return 'report_procedure';
  if (/\bFILENAME\s*=/i.test(artifact.content)) return 'master_file';
  if (/\bMASTER\s*=/i.test(artifact.content) && /\bTABLENAME\s*=/i.test(artifact.content)) return 'access_file';
  return 'unknown';
}

function rootIdentity(artifact: MigrationArtifact, sourceClass: ArtifactRoot['sourceClass'], declaredName: string): WebFocusSourceIdentity {
  if ((sourceClass === 'master_file' || sourceClass === 'access_file') && declaredName) {
    return { sourceId: declaredName, kind: 'declared_name', locator: artifact.name };
  }
  if (!genericArtifactName(artifact.name)) {
    return { sourceId: artifact.name, kind: 'artifact_path', locator: artifact.name };
  }
  return {
    sourceId: `manual-evidence:${sha256Text(artifact.content).slice(0, 24)}`,
    kind: 'synthetic',
    locator: artifact.name,
    syntheticReason: 'The uploaded evidence did not expose a native repository ID or durable source path, so OmniKit retained a stable content-derived evidence identity.',
  };
}

function classificationSort(left: WebFocusEvidenceClassification, right: WebFocusEvidenceClassification): number {
  return left.sourceIdentity.sourceId.localeCompare(right.sourceIdentity.sourceId)
    || left.sourceClass.localeCompare(right.sourceClass)
    || left.id.localeCompare(right.id);
}

function diagnosticSort(left: WebFocusDiagnostic, right: WebFocusDiagnostic): number {
  const severity = { blocker: 0, warning: 1, info: 2 } as const;
  return severity[left.severity] - severity[right.severity]
    || left.code.localeCompare(right.code)
    || (left.locator || '').localeCompare(right.locator || '')
    || left.id.localeCompare(right.id);
}

export function classifyWebFocusEvidence(input: WebFocusClassificationInput): WebFocusClassificationResult {
  const classifications: MutableWebFocusClassification[] = [];
  const classificationById = new Map<string, MutableWebFocusClassification>();
  const dependencyEdges: WebFocusDependencyEdge[] = [];
  const diagnostics: WebFocusDiagnostic[] = [];
  let classificationTruncated = false;

  const addClassification = (value: {
    sourceClass: WebFocusEvidenceClass;
    sourceName: string;
    sourceIdentity: WebFocusSourceIdentity;
    artifactId?: string;
    parentClassificationId?: string;
    status: WebFocusClassificationStatus;
    attributes?: Record<string, string | number | boolean | null>;
    idSuffix?: string;
  }): MutableWebFocusClassification | null => {
    if (classifications.length >= MAX_WEBFOCUS_CLASSIFICATIONS) {
      classificationTruncated = true;
      return null;
    }
    const rule = webFocusDevelopmentRule(value.sourceClass);
    const baseId = `webfocus:classification:${value.sourceClass}:${encoded(value.sourceIdentity.sourceId)}${value.idSuffix ? `:${encoded(value.idSuffix)}` : ''}`;
    let id = baseId;
    let duplicate = 1;
    while (classificationById.has(id)) {
      duplicate += 1;
      id = `${baseId}:${duplicate}`;
    }
    const classification: MutableWebFocusClassification = {
      id,
      sourceClass: value.sourceClass,
      sourceName: value.sourceName,
      sourceIdentity: { ...value.sourceIdentity },
      artifactId: value.artifactId,
      parentClassificationId: value.parentClassificationId,
      status: value.status,
      targetClassification: rule.targetClassification,
      documentationIds: [...rule.documentationIds],
      diagnosticCodes: [],
      attributes: { ...(value.attributes || {}) },
    };
    classifications.push(classification);
    classificationById.set(id, classification);
    return classification;
  };

  const addDiagnostic = (value: {
    code: WebFocusDiagnosticCode;
    severity: WebFocusDiagnosticSeverity;
    message: string;
    classification?: MutableWebFocusClassification | null;
    artifactId?: string;
    locator?: string;
    documentationIds?: WebFocusDocumentationId[];
  }) => {
    const classification = value.classification || undefined;
    if (classification && !classification.diagnosticCodes.includes(value.code)) classification.diagnosticCodes.push(value.code);
    const locator = value.locator || classification?.sourceIdentity.locator;
    const sourceId = classification?.sourceIdentity.sourceId;
    const duplicateKey = `${value.code}:${sourceId || ''}:${locator || ''}:${value.message}`;
    if (diagnostics.some((diagnostic) => diagnostic.id === duplicateKey)) return;
    diagnostics.push({
      id: duplicateKey,
      code: value.code,
      severity: value.severity,
      message: value.message,
      sourceId,
      artifactId: value.artifactId || classification?.artifactId,
      locator,
      classificationId: classification?.id,
      documentationIds: [...(value.documentationIds || classification?.documentationIds || [])],
    });
  };

  const addEdge = (value: Omit<WebFocusDependencyEdge, 'id'>) => {
    const id = `webfocus:edge:${encoded(value.fromClassificationId)}:${value.kind}:${encoded(value.toSourceId)}:${encoded(value.locator)}`;
    if (dependencyEdges.some((edge) => edge.id === id)) return;
    dependencyEdges.push({ id, ...value });
  };

  const addContainsEdge = (
    parent: MutableWebFocusClassification,
    child: MutableWebFocusClassification | null,
  ) => {
    if (!child) return;
    addEdge({
      fromClassificationId: parent.id,
      fromSourceId: parent.sourceIdentity.sourceId,
      toClassificationId: child.id,
      toSourceId: child.sourceIdentity.sourceId,
      kind: 'contains',
      status: 'resolved',
      locator: child.sourceIdentity.locator,
    });
  };

  const artifactRoots: ArtifactRoot[] = [];
  (input.artifacts || []).forEach((artifact) => {
    const sourceClass = detectArtifactClass(artifact);
    const declaredName = sourceClass === 'master_file'
      ? declaredValue(artifact.content, 'FILENAME')
      : sourceClass === 'access_file'
        ? declaredValue(artifact.content, 'MASTER')
        : fileStem(artifact.name);
    const identity = rootIdentity(artifact, sourceClass, declaredName);
    const root = addClassification({
      sourceClass,
      sourceName: declaredName || fileStem(artifact.name) || artifact.name,
      sourceIdentity: identity,
      artifactId: artifact.id,
      status: sourceClass === 'unknown' ? 'unsupported' : sourceClass === 'access_file' ? 'ambiguous' : 'evidence',
      attributes: { artifactKind: artifact.kind, sizeBytes: artifact.sizeBytes },
    });
    if (!root) return;
    artifactRoots.push({ artifact, root, sourceClass, declaredName });

    if (identity.kind === 'synthetic') {
      addDiagnostic({
        code: 'WF_SYNTHETIC_SOURCE_ID',
        severity: 'warning',
        message: identity.syntheticReason || 'OmniKit used a synthetic identity because the source did not expose one.',
        classification: root,
      });
    }
    if (!artifact.content.trim()) {
      addDiagnostic({
        code: 'WF_EMPTY_ARTIFACT',
        severity: 'blocker',
        message: `${artifact.name} has no source content and cannot contribute migration evidence.`,
        classification: root,
      });
    }
    artifact.parseWarnings.filter((warning) => /truncat/i.test(warning)).forEach((warning) => {
      addDiagnostic({
        code: 'WF_SOURCE_TRUNCATED',
        severity: 'blocker',
        message: warning,
        classification: root,
      });
    });
    if (sourceClass === 'unknown') {
      addDiagnostic({
        code: 'WF_UNSUPPORTED_ARTIFACT',
        severity: 'blocker',
        message: `${artifact.name} did not match a bounded WebFOCUS Master File, Access File, or report procedure contract.`,
        classification: root,
      });
    }
  });

  const masterByReference = new Map<string, MutableWebFocusClassification>();
  const accessByReference = new Map<string, MutableWebFocusClassification>();
  const procedureByReference = new Map<string, MutableWebFocusClassification>();
  const registerRoot = (registry: Map<string, MutableWebFocusClassification>, root: ArtifactRoot) => {
    [
      root.declaredName,
      root.artifact.name,
      fileStem(root.artifact.name),
      root.root.sourceIdentity.sourceId,
    ].filter(Boolean).forEach((value) => registry.set(referenceKey(value), root.root));
  };
  artifactRoots.forEach((root) => {
    if (root.sourceClass === 'master_file') registerRoot(masterByReference, root);
    if (root.sourceClass === 'access_file') registerRoot(accessByReference, root);
    if (root.sourceClass === 'report_procedure') registerRoot(procedureByReference, root);
  });

  const missingDependency = (value: {
    parent: MutableWebFocusClassification;
    artifact: MigrationArtifact;
    sourceName: string;
    kind: Exclude<WebFocusDependencyKind, 'contains'>;
    code: Extract<WebFocusDiagnosticCode, 'WF_MISSING_MASTER_FILE' | 'WF_MISSING_ACCESS_FILE' | 'WF_MISSING_INCLUDED_PROCEDURE' | 'WF_MISSING_CALLED_PROCEDURE'>;
    locator: string;
    message: string;
  }): MutableWebFocusClassification | null => {
    const missing = addClassification({
      sourceClass: 'missing_dependency',
      sourceName: value.sourceName,
      sourceIdentity: {
        sourceId: value.sourceName,
        kind: 'declared_name',
        locator: value.locator,
      },
      artifactId: value.artifact.id,
      parentClassificationId: value.parent.id,
      status: 'unsupported',
      attributes: { dependencyKind: value.kind },
      idSuffix: `${value.parent.id}:${value.locator}`,
    });
    if (!missing) return null;
    addContainsEdge(value.parent, missing);
    addEdge({
      fromClassificationId: value.parent.id,
      fromSourceId: value.parent.sourceIdentity.sourceId,
      toClassificationId: missing.id,
      toSourceId: value.sourceName,
      kind: value.kind,
      status: 'missing',
      locator: value.locator,
    });
    addDiagnostic({ code: value.code, severity: 'blocker', message: value.message, classification: missing });
    return missing;
  };

  const connectNamedDependency = (value: {
    from: MutableWebFocusClassification;
    artifact: MigrationArtifact;
    sourceName: string;
    registry: Map<string, MutableWebFocusClassification>;
    kind: Exclude<WebFocusDependencyKind, 'contains'>;
    missingCode: Extract<WebFocusDiagnosticCode, 'WF_MISSING_MASTER_FILE' | 'WF_MISSING_ACCESS_FILE' | 'WF_MISSING_INCLUDED_PROCEDURE' | 'WF_MISSING_CALLED_PROCEDURE'>;
    locator: string;
    missingMessage: string;
  }) => {
    const target = value.registry.get(referenceKey(value.sourceName));
    if (!target) {
      missingDependency({
        parent: value.from,
        artifact: value.artifact,
        sourceName: value.sourceName,
        kind: value.kind,
        code: value.missingCode,
        locator: value.locator,
        message: value.missingMessage,
      });
      return;
    }
    addEdge({
      fromClassificationId: value.from.id,
      fromSourceId: value.from.sourceIdentity.sourceId,
      toClassificationId: target.id,
      toSourceId: target.sourceIdentity.sourceId,
      kind: value.kind,
      status: 'resolved',
      locator: value.locator,
    });
  };

  const addExpression = (value: {
    root: MutableWebFocusClassification;
    artifact: MigrationArtifact;
    sourceClass: 'define' | 'compute';
    name: string;
    expression: string;
    format: string;
    lineNumber: number;
    complete: boolean;
    scope: string;
  }) => {
    const locator = lineLocator(value.artifact, value.lineNumber);
    const expression = addClassification({
      sourceClass: value.sourceClass,
      sourceName: value.name,
      sourceIdentity: {
        sourceId: `${value.root.sourceIdentity.sourceId}::${value.sourceClass.toUpperCase()}=${value.name}`,
        kind: 'declared_name',
        locator,
      },
      artifactId: value.artifact.id,
      parentClassificationId: value.root.id,
      status: 'ambiguous',
      attributes: {
        expression: value.expression,
        expressionPresent: true,
        completeExpression: value.complete,
        format: value.format,
        scope: value.scope,
        lineNumber: value.lineNumber,
      },
      idSuffix: String(value.lineNumber),
    });
    if (!expression) return;
    addContainsEdge(value.root, expression);
    addDiagnostic({
      code: 'WF_EXPRESSION_TRANSLATION_REQUIRED',
      severity: 'blocker',
      message: `${value.sourceClass.toUpperCase()} ${value.name} is preserved as source expression evidence and requires a reviewed translation plus result validation.`,
      classification: expression,
    });
    if (!value.complete) {
      addDiagnostic({
        code: 'WF_EXPRESSION_INCOMPLETE',
        severity: 'blocker',
        message: `${value.sourceClass.toUpperCase()} ${value.name} did not expose a complete semicolon-terminated expression on the recovered statement.`,
        classification: expression,
      });
    }
  };

  artifactRoots.filter((entry) => entry.sourceClass === 'master_file').forEach(({ artifact, root }) => {
    const lines = sourceLines(artifact);
    let segment = '';
    lines.filter((line) => !line.trimmed.startsWith('-*')).forEach((line) => {
      segment = declaredValue(line.text, 'SEGMENT') || segment;
      for (const match of line.text.matchAll(/\bFIELD(?:NAME)?\s*=\s*['"]?([A-Za-z0-9_.$-]+)/gi)) {
        const name = compact(match[1]);
        const alias = declaredValue(line.text, 'ALIAS');
        const usage = declaredValue(line.text, 'USAGE');
        const actual = declaredValue(line.text, 'ACTUAL');
        const field = addClassification({
          sourceClass: 'field',
          sourceName: name,
          sourceIdentity: {
            sourceId: `${root.sourceIdentity.sourceId}::${segment ? `SEGMENT=${segment}::` : ''}FIELDNAME=${name}`,
            kind: 'declared_name',
            locator: lineLocator(artifact, line.lineNumber),
          },
          artifactId: artifact.id,
          parentClassificationId: root.id,
          status: 'evidence',
          attributes: {
            lineNumber: line.lineNumber,
            segment,
            alias,
            usage,
            actual,
            hasUsage: Boolean(usage),
            hasActual: Boolean(actual),
            hasAlias: Boolean(alias),
          },
        });
        addContainsEdge(root, field);
      }
      const define = line.text.match(/^\s*DEFINE\s+(?!FILE\b)([A-Za-z0-9_.$-]+)(?:\/([^=\s,]+))?\s*=\s*(.+)$/i);
      if (define) addExpression({
        root,
        artifact,
        sourceClass: 'define',
        name: compact(define[1]),
        format: compact(define[2]),
        expression: compact(define[3]),
        lineNumber: line.lineNumber,
        complete: /;\s*(?:\$)?\s*$/.test(define[3]),
        scope: 'master_file',
      });
      const filter = line.text.match(/^\s*FILTER\s+([A-Za-z0-9_.$-]+)\s*=\s*(.+)$/i);
      if (filter) {
        const locator = lineLocator(artifact, line.lineNumber);
        const classification = addClassification({
          sourceClass: 'report_filter',
          sourceName: compact(filter[1]),
          sourceIdentity: { sourceId: `${root.sourceIdentity.sourceId}::FILTER=${compact(filter[1])}`, kind: 'declared_name', locator },
          artifactId: artifact.id,
          parentClassificationId: root.id,
          status: 'ambiguous',
          attributes: { masterFileFilter: true, completeExpression: /;/.test(filter[2]), lineNumber: line.lineNumber },
        });
        addContainsEdge(root, classification);
        addDiagnostic({
          code: 'WF_FILTER_SEMANTICS_AMBIGUOUS',
          severity: 'blocker',
          message: `Master File FILTER ${compact(filter[1])} requires reviewed target timing and result equivalence.`,
          classification,
        });
      }
      const crossReference = line.text.match(/\bCRFILE\s*=\s*['"]?([A-Za-z0-9_.$/-]+)/i);
      if (crossReference) {
        const targetName = compact(crossReference[1]);
        const locator = lineLocator(artifact, line.lineNumber);
        const join = addClassification({
          sourceClass: 'dynamic_join',
          sourceName: `${root.sourceName} to ${targetName}`,
          sourceIdentity: {
            sourceId: `${root.sourceIdentity.sourceId}::CRFILE=${targetName}`,
            kind: 'declared_name',
            locator,
          },
          artifactId: artifact.id,
          parentClassificationId: root.id,
          status: 'ambiguous',
          attributes: { embeddedMasterJoin: true, conditional: /\bJOIN_WHERE\s*=/i.test(line.text), lineNumber: line.lineNumber },
        });
        addContainsEdge(root, join);
        addDiagnostic({
          code: 'WF_JOIN_SEMANTICS_AMBIGUOUS',
          severity: 'blocker',
          message: `The Master File cross-reference to ${targetName} requires explicit key, cardinality, fanout, and null-behavior validation.`,
          classification: join,
        });
        if (join) connectNamedDependency({ from: join, artifact, sourceName: targetName, registry: masterByReference, kind: 'joins_master_file', missingCode: 'WF_MISSING_MASTER_FILE', locator, missingMessage: `${artifact.name} references Master File ${targetName}, but that Master File is missing.` });
      }
    });

    const accessName = declaredValue(artifact.content, 'ACCESSFILE') || declaredValue(artifact.content, 'ACCESS');
    if (accessName) {
      connectNamedDependency({
        from: root,
        artifact,
        sourceName: accessName,
        registry: accessByReference,
        kind: 'uses_access_file',
        missingCode: 'WF_MISSING_ACCESS_FILE',
        locator: artifact.name,
        missingMessage: `${artifact.name} declares Access File ${accessName}, but the paired .acx evidence is missing.`,
      });
    }
  });

  artifactRoots.filter((entry) => entry.sourceClass === 'access_file').forEach(({ artifact, root, declaredName }) => {
    addDiagnostic({
      code: 'WF_ACCESS_FILE_HANDOFF_REQUIRED',
      severity: 'blocker',
      message: `${artifact.name} contains adapter and physical-table evidence that requires an explicit upstream data-source handoff.`,
      classification: root,
    });
    if (declaredName) {
      connectNamedDependency({
        from: root,
        artifact,
        sourceName: declaredName,
        registry: masterByReference,
        kind: 'uses_master_file',
        missingCode: 'WF_MISSING_MASTER_FILE',
        locator: artifact.name,
        missingMessage: `${artifact.name} is paired to Master File ${declaredName}, but that Master File is missing.`,
      });
    }
  });

  artifactRoots.filter((entry) => entry.sourceClass === 'report_procedure').forEach(({ artifact, root }) => {
    const lines = sourceLines(artifact);
    let reportRequestCount = 0;
    let defineFileScope = '';
    const parameters = new Map<string, { name: string; prefix: '&' | '&&'; lineNumber: number; hasDefault: boolean }>();

    lines.filter((line) => !line.trimmed.startsWith('-*')).forEach((line) => {
      const report = line.text.match(/^\s*(?:TABLE|GRAPH)\s+FILE\s+['"]?([A-Za-z0-9_.$/-]+)/i);
      if (report) {
        reportRequestCount += 1;
        const sourceName = compact(report[1]);
        connectNamedDependency({
          from: root,
          artifact,
          sourceName,
          registry: masterByReference,
          kind: 'uses_master_file',
          missingCode: 'WF_MISSING_MASTER_FILE',
          locator: lineLocator(artifact, line.lineNumber),
          missingMessage: `${artifact.name} reports from ${sourceName}, but the referenced Master File is missing.`,
        });
      }

      const defineFile = line.text.match(/^\s*DEFINE\s+FILE\s+['"]?([A-Za-z0-9_.$/-]+)/i);
      if (defineFile) {
        defineFileScope = compact(defineFile[1]);
      } else if (defineFileScope && /^\s*END\s*$/i.test(line.text)) {
        defineFileScope = '';
      } else if (defineFileScope) {
        const expression = line.text.match(/^\s*([A-Za-z0-9_.$-]+)(?:\/([^=\s,]+))?\s*=\s*(.+)$/i);
        if (expression) addExpression({
          root,
          artifact,
          sourceClass: 'define',
          name: compact(expression[1]),
          format: compact(expression[2]),
          expression: compact(expression[3]),
          lineNumber: line.lineNumber,
          complete: /;\s*$/.test(expression[3]),
          scope: `procedure:${defineFileScope}`,
        });
      }

      const directDefine = line.text.match(/^\s*DEFINE\s+(?!FILE\b)([A-Za-z0-9_.$-]+)(?:\/([^=\s,]+))?\s*=\s*(.+)$/i);
      if (directDefine) addExpression({
        root,
        artifact,
        sourceClass: 'define',
        name: compact(directDefine[1]),
        format: compact(directDefine[2]),
        expression: compact(directDefine[3]),
        lineNumber: line.lineNumber,
        complete: /;\s*$/.test(directDefine[3]),
        scope: 'procedure',
      });
      const compute = line.text.match(/^\s*COMPUTE\s+([A-Za-z0-9_.$-]+)(?:\/([^=\s,]+))?\s*=\s*(.+)$/i);
      if (compute) addExpression({
        root,
        artifact,
        sourceClass: 'compute',
        name: compact(compute[1]),
        format: compact(compute[2]),
        expression: compact(compute[3]),
        lineNumber: line.lineNumber,
        complete: /;\s*$/.test(compute[3]),
        scope: 'report_request',
      });

      const joinLine = /^\s*JOIN\b/i.test(line.text);
      if (joinLine) {
        const joinMatch = line.text.match(/^\s*JOIN\s+([A-Za-z0-9_.$-]+)\s+IN\s+([A-Za-z0-9_.$/-]+).*?\s+TO(?:\s+(ALL|UNIQUE|MULTIPLE))?\s*([A-Za-z0-9_.$-]+)\s+IN\s+([A-Za-z0-9_.$/-]+)/i);
        const fromSource = compact(joinMatch?.[2]);
        const toSource = compact(joinMatch?.[5]);
        const locator = lineLocator(artifact, line.lineNumber);
        const join = addClassification({
          sourceClass: 'dynamic_join',
          sourceName: fromSource && toSource ? `${fromSource} to ${toSource}` : `JOIN at line ${line.lineNumber}`,
          sourceIdentity: {
            sourceId: `${root.sourceIdentity.sourceId}::JOIN@${line.lineNumber}`,
            kind: 'synthetic',
            locator,
            syntheticReason: 'A JOIN statement has no separate repository object ID, so OmniKit used the containing procedure and source line.',
          },
          artifactId: artifact.id,
          parentClassificationId: root.id,
          status: 'ambiguous',
          attributes: {
            lineNumber: line.lineNumber,
            parsedEndpoints: Boolean(fromSource && toSource),
            fromField: compact(joinMatch?.[1]),
            fromSource,
            toField: compact(joinMatch?.[4]),
            toSource,
            sourceQualifier: compact(joinMatch?.[3]) || 'unspecified',
          },
        });
        addContainsEdge(root, join);
        addDiagnostic({
          code: 'WF_JOIN_SEMANTICS_AMBIGUOUS',
          severity: 'blocker',
          message: fromSource && toSource
            ? `JOIN ${fromSource} to ${toSource} requires explicit key, cardinality, fanout, and null-behavior validation.`
            : `The JOIN at ${locator} could not be fully classified and requires the complete statement.`,
          classification: join,
        });
        if (join && fromSource) connectNamedDependency({ from: join, artifact, sourceName: fromSource, registry: masterByReference, kind: 'joins_master_file', missingCode: 'WF_MISSING_MASTER_FILE', locator, missingMessage: `${artifact.name} joins from ${fromSource}, but that Master File is missing.` });
        if (join && toSource) connectNamedDependency({ from: join, artifact, sourceName: toSource, registry: masterByReference, kind: 'joins_master_file', missingCode: 'WF_MISSING_MASTER_FILE', locator, missingMessage: `${artifact.name} joins to ${toSource}, but that Master File is missing.` });
      }

      const filter = line.text.match(/^\s*(WHERE|IF)\s+(.+)$/i);
      if (filter) {
        const locator = lineLocator(artifact, line.lineNumber);
        const classification = addClassification({
          sourceClass: 'report_filter',
          sourceName: `${filter[1].toUpperCase()} at line ${line.lineNumber}`,
          sourceIdentity: {
            sourceId: `${root.sourceIdentity.sourceId}::${filter[1].toUpperCase()}@${line.lineNumber}`,
            kind: 'synthetic',
            locator,
            syntheticReason: 'A report selection statement has no separate repository object ID, so OmniKit used the containing procedure and source line.',
          },
          artifactId: artifact.id,
          parentClassificationId: root.id,
          status: 'ambiguous',
          attributes: {
            lineNumber: line.lineNumber,
            selectionKind: filter[1].toUpperCase(),
            expression: compact(filter[2]),
            expressionPresent: Boolean(compact(filter[2])),
          },
        });
        addContainsEdge(root, classification);
        addDiagnostic({
          code: 'WF_FILTER_SEMANTICS_AMBIGUOUS',
          severity: 'blocker',
          message: `${filter[1].toUpperCase()} selection at ${locator} requires reviewed field, parameter, and evaluation-timing equivalence.`,
          classification,
        });
      }

      const include = line.text.match(/^\s*-INCLUDE\s+([^\s,]+)/i);
      if (include) {
        const targetName = compact(include[1]);
        const dynamic = targetName.includes('&');
        const locator = lineLocator(artifact, line.lineNumber);
        const classification = addClassification({
          sourceClass: 'include',
          sourceName: targetName,
          sourceIdentity: {
            sourceId: `${root.sourceIdentity.sourceId}::-INCLUDE@${line.lineNumber}`,
            kind: 'synthetic',
            locator,
            syntheticReason: 'An include directive has no separate repository object ID, so OmniKit used the containing procedure and source line.',
          },
          artifactId: artifact.id,
          parentClassificationId: root.id,
          status: dynamic ? 'ambiguous' : 'evidence',
          attributes: { lineNumber: line.lineNumber, dynamic },
        });
        addContainsEdge(root, classification);
        if (classification && dynamic) {
          addEdge({ fromClassificationId: classification.id, fromSourceId: classification.sourceIdentity.sourceId, toSourceId: targetName, kind: 'includes_procedure', status: 'dynamic', locator });
          addDiagnostic({ code: 'WF_DYNAMIC_DEPENDENCY', severity: 'blocker', message: `${artifact.name} uses variable-named include ${targetName}; every possible included procedure must be bounded.`, classification });
        } else if (classification) {
          connectNamedDependency({ from: classification, artifact, sourceName: targetName, registry: procedureByReference, kind: 'includes_procedure', missingCode: 'WF_MISSING_INCLUDED_PROCEDURE', locator, missingMessage: `${artifact.name} includes ${targetName}, but that procedure is missing.` });
        }
      }

      const call = line.text.match(/^\s*(?:EX|EXEC)\s+([^\s,]+)/i);
      if (call) {
        const targetName = compact(call[1]);
        const dynamic = targetName.includes('&');
        const locator = lineLocator(artifact, line.lineNumber);
        const classification = addClassification({
          sourceClass: 'called_procedure',
          sourceName: targetName,
          sourceIdentity: {
            sourceId: `${root.sourceIdentity.sourceId}::EXEC@${line.lineNumber}`,
            kind: 'synthetic',
            locator,
            syntheticReason: 'A procedure call has no separate repository object ID, so OmniKit used the containing procedure and source line.',
          },
          artifactId: artifact.id,
          parentClassificationId: root.id,
          status: dynamic ? 'ambiguous' : 'evidence',
          attributes: { lineNumber: line.lineNumber, dynamic, hasArguments: /[,=]/.test(line.text.slice(call.index || 0)) },
        });
        addContainsEdge(root, classification);
        if (classification && dynamic) {
          addEdge({ fromClassificationId: classification.id, fromSourceId: classification.sourceIdentity.sourceId, toSourceId: targetName, kind: 'executes_procedure', status: 'dynamic', locator });
          addDiagnostic({ code: 'WF_DYNAMIC_DEPENDENCY', severity: 'blocker', message: `${artifact.name} uses variable-named procedure call ${targetName}; every possible target must be bounded.`, classification });
        } else if (classification) {
          connectNamedDependency({ from: classification, artifact, sourceName: targetName, registry: procedureByReference, kind: 'executes_procedure', missingCode: 'WF_MISSING_CALLED_PROCEDURE', locator, missingMessage: `${artifact.name} calls ${targetName}, but that procedure is missing.` });
        }
      }

      const procedural = line.text.match(/^\s*(-IF|-GOTO|-REPEAT|-LOOP|-READ|-WRITE|-SYSTEM|-DOS|-UNIX|MODIFY\s+FILE|MAINTAIN\s+FILE|MATCH\s+FILE)\b/i);
      if (procedural) {
        const locator = lineLocator(artifact, line.lineNumber);
        const classification = addClassification({
          sourceClass: 'procedural_logic',
          sourceName: `${procedural[1].toUpperCase()} at line ${line.lineNumber}`,
          sourceIdentity: {
            sourceId: `${root.sourceIdentity.sourceId}::PROCEDURAL@${line.lineNumber}`,
            kind: 'synthetic',
            locator,
            syntheticReason: 'A procedural statement has no separate repository object ID, so OmniKit used the containing procedure and source line.',
          },
          artifactId: artifact.id,
          parentClassificationId: root.id,
          status: 'unsupported',
          attributes: { command: procedural[1].toUpperCase(), lineNumber: line.lineNumber },
        });
        addContainsEdge(root, classification);
        addDiagnostic({
          code: 'WF_PROCEDURAL_LOGIC_UNSUPPORTED',
          severity: 'blocker',
          message: `${procedural[1].toUpperCase()} behavior at ${locator} requires an explicit upstream or application handoff.`,
          classification,
        });
      }

      if (/^\s*(?:ON\s+TABLE\s+(?:PCHOLD|HOLD|SAVE)|HEADING\b|FOOTING\b|ON\s+TABLE\s+SET\s+STYLE\b|TYPE\s*=)/i.test(line.text)) {
        const locator = lineLocator(artifact, line.lineNumber);
        const classification = addClassification({
          sourceClass: 'presentation',
          sourceName: `Presentation directive at line ${line.lineNumber}`,
          sourceIdentity: {
            sourceId: `${root.sourceIdentity.sourceId}::PRESENTATION@${line.lineNumber}`,
            kind: 'synthetic',
            locator,
            syntheticReason: 'A presentation directive has no separate repository object ID, so OmniKit used the containing procedure and source line.',
          },
          artifactId: artifact.id,
          parentClassificationId: root.id,
          status: 'unsupported',
          attributes: { lineNumber: line.lineNumber },
        });
        addContainsEdge(root, classification);
        addDiagnostic({
          code: 'WF_PRESENTATION_UNSUPPORTED',
          severity: 'blocker',
          message: `Presentation behavior at ${locator} is preserved for redesign and cannot be treated as automatic dashboard parity.`,
          classification,
        });
      }

      const defaultVariable = line.text.match(/^\s*-DEFAULTS?H?\s+&&?([A-Za-z][A-Za-z0-9_]*)\s*=/i)?.[1]?.toUpperCase();
      for (const match of line.text.matchAll(/(^|[^&])(&&?)([A-Za-z][A-Za-z0-9_]*)/g)) {
        const name = compact(match[3]).toUpperCase();
        const prefix = match[2] as '&' | '&&';
        const key = `${prefix}${name}`;
        const current = parameters.get(key);
        parameters.set(key, {
          name,
          prefix,
          lineNumber: current?.lineNumber || line.lineNumber,
          hasDefault: Boolean(current?.hasDefault || defaultVariable === name),
        });
      }
    });

    parameters.forEach((parameter) => {
      const locator = lineLocator(artifact, parameter.lineNumber);
      const classification = addClassification({
        sourceClass: 'parameter',
        sourceName: `${parameter.prefix}${parameter.name}`,
        sourceIdentity: {
          sourceId: `${root.sourceIdentity.sourceId}::${parameter.prefix}${parameter.name}`,
          kind: 'declared_name',
          locator,
        },
        artifactId: artifact.id,
        parentClassificationId: root.id,
        status: 'ambiguous',
        attributes: { global: parameter.prefix === '&&', hasDefault: parameter.hasDefault, firstReferenceLine: parameter.lineNumber },
      });
      addContainsEdge(root, classification);
      addDiagnostic({
        code: 'WF_PARAMETER_SEMANTICS_AMBIGUOUS',
        severity: 'blocker',
        message: `${parameter.prefix}${parameter.name} requires explicit type, allowed-value, default, and control-scope evidence; its current value will not be inlined.`,
        classification,
      });
    });

    if (reportRequestCount === 0) {
      addDiagnostic({
        code: 'WF_REPORT_REQUEST_MISSING',
        severity: 'blocker',
        message: `${artifact.name} did not expose a TABLE FILE or GRAPH FILE request; treat it as incomplete procedural evidence.`,
        classification: root,
      });
    }
  });

  (input.repositoryItems || []).forEach((item) => {
    const metadataSynthetic = item.metadata.syntheticId === true;
    const identity: WebFocusSourceIdentity = metadataSynthetic
      ? {
          sourceId: item.id,
          kind: 'synthetic',
          locator: item.path || item.name,
          syntheticReason: 'The repository inventory response did not expose an object ID, so the connector generated a positional identity.',
        }
      : {
          sourceId: item.id,
          kind: item.path ? 'repository_path' : 'native_id',
          locator: item.path || item.name,
        };
    const repositoryItem = addClassification({
      sourceClass: 'repository_item',
      sourceName: item.name,
      sourceIdentity: identity,
      status: 'ambiguous',
      attributes: {
        itemKind: item.kind,
        hasPath: Boolean(item.path),
        dependencyCount: item.dependencyIds.length,
      },
    });
    if (!repositoryItem) return;
    if (metadataSynthetic) {
      addDiagnostic({ code: 'WF_SYNTHETIC_SOURCE_ID', severity: 'blocker', message: identity.syntheticReason || 'The repository item lacks a native source identity.', classification: repositoryItem });
    }
    addDiagnostic({
      code: 'WF_REPOSITORY_CONTENT_REQUIRED',
      severity: 'blocker',
      message: `${item.name} is repository inventory only. Retrieve its version-specific content and dependencies before semantic planning.`,
      classification: repositoryItem,
    });

    const descriptor = `${item.kind} ${item.name} ${item.path || ''} ${Object.values(item.metadata).filter((value) => typeof value === 'string').join(' ')}`;
    const addRepositoryHandoff = (sourceClass: 'schedule' | 'security' | 'portal', code: WebFocusDiagnosticCode, message: string) => {
      const handoff = addClassification({
        sourceClass,
        sourceName: item.name,
        sourceIdentity: {
          sourceId: `${item.id}::${sourceClass}`,
          kind: 'synthetic',
          locator: item.path || item.name,
          syntheticReason: `The repository listing exposed ${sourceClass} signals but no separate normalized ${sourceClass} object ID.`,
        },
        parentClassificationId: repositoryItem.id,
        status: 'unsupported',
        attributes: { repositoryEvidence: true },
      });
      addContainsEdge(repositoryItem, handoff);
      addDiagnostic({ code, severity: 'blocker', message, classification: handoff });
    };
    if (item.kind === 'schedule' || /\b(?:schedule|reportcaster)\b/i.test(descriptor)) addRepositoryHandoff('schedule', 'WF_SCHEDULE_HANDOFF_REQUIRED', `${item.name} contains schedule evidence that requires a ReportCaster operational handoff.`);
    if (
      item.kind === 'permission'
      || Object.keys(item.metadata).some((key) => /permission|policy|access/i.test(key))
      || item.riskFlags.some((flag) => /security|permission|policy|access list/i.test(flag))
      || /\b(?:permission|security policy|access list)\b/i.test(descriptor)
    ) addRepositoryHandoff('security', 'WF_SECURITY_HANDOFF_REQUIRED', `${item.name} contains repository security evidence that requires identity-class access review.`);
    if (/\b(?:portal|bip page|resource tree page)\b/i.test(descriptor)) addRepositoryHandoff('portal', 'WF_PORTAL_HANDOFF_REQUIRED', `${item.name} contains portal evidence that requires an explicit dashboard or application redesign.`);
  });

  if (input.repositoryTruncated || classificationTruncated) {
    addDiagnostic({
      code: 'WF_CLASSIFICATION_TRUNCATED',
      severity: 'blocker',
      message: input.repositoryTruncated
        ? 'The WebFOCUS repository inventory was truncated; required dependency closure is not proven.'
        : `WebFOCUS classification exceeded the ${MAX_WEBFOCUS_CLASSIFICATIONS} item safety limit; split the source scope without omitting dependencies.`,
      documentationIds: ['repository-rest-content-9.3.3'],
    });
  }

  const cleanClassifications = classifications.map((classification) => ({
    ...classification,
    sourceIdentity: { ...classification.sourceIdentity },
    documentationIds: [...classification.documentationIds],
    diagnosticCodes: Array.from(new Set(classification.diagnosticCodes)).sort(),
    attributes: { ...classification.attributes },
  })).sort(classificationSort);
  const cleanEdges = [...dependencyEdges].sort((left, right) => left.fromSourceId.localeCompare(right.fromSourceId) || left.kind.localeCompare(right.kind) || left.toSourceId.localeCompare(right.toSourceId) || left.id.localeCompare(right.id));
  const cleanDiagnostics = diagnostics.map((diagnostic) => ({ ...diagnostic, documentationIds: [...diagnostic.documentationIds] })).sort(diagnosticSort);
  const truncated = Boolean(
    input.repositoryTruncated
    || classificationTruncated
    || cleanDiagnostics.some((diagnostic) => diagnostic.code === 'WF_SOURCE_TRUNCATED'),
  );
  return {
    schemaVersion: WEBFOCUS_CLASSIFICATION_SCHEMA_VERSION,
    developmentContextVersion: WEBFOCUS_DEVELOPMENT_CONTEXT_VERSION,
    classifications: cleanClassifications,
    dependencyEdges: cleanEdges,
    diagnostics: cleanDiagnostics,
    evidenceComplete: !cleanDiagnostics.some((diagnostic) => diagnostic.severity === 'blocker'),
    truncated,
  };
}

function reachableClassifications(
  result: WebFocusClassificationResult,
  rootIds: string[],
): Set<string> {
  const adjacency = new Map<string, string[]>();
  result.dependencyEdges.filter((edge) => edge.status === 'resolved' && edge.toClassificationId).forEach((edge) => {
    adjacency.set(edge.fromClassificationId, [...(adjacency.get(edge.fromClassificationId) || []), edge.toClassificationId!]);
  });
  const visited = new Set(rootIds);
  const queue = [...rootIds];
  while (queue.length > 0) {
    const current = queue.shift()!;
    (adjacency.get(current) || []).forEach((next) => {
      if (visited.has(next)) return;
      visited.add(next);
      queue.push(next);
    });
  }
  return visited;
}

export function requiredWebFocusMigrationDecisions(
  result: WebFocusClassificationResult | null,
  selectedProcedureSourceIds: string[] = [],
): MigrationDecision[] {
  if (!result) return [];
  const procedureRoots = result.classifications.filter((classification) => classification.sourceClass === 'report_procedure' || classification.sourceClass === 'repository_item');
  const selectedSet = new Set(selectedProcedureSourceIds);
  const selectedRoots = selectedProcedureSourceIds.length === 0
    ? procedureRoots
    : procedureRoots.filter((classification) => selectedSet.has(classification.sourceIdentity.sourceId) || selectedSet.has(classification.id));
  if (selectedProcedureSourceIds.length > 0 && selectedRoots.length === 0) return [];
  const includedIds = selectedProcedureSourceIds.length === 0
    ? new Set(result.classifications.map((classification) => classification.id))
    : reachableClassifications(result, selectedRoots.map((classification) => classification.id));
  const impactsByClassificationId = new Map<string, Set<string>>();
  selectedRoots.forEach((root) => {
    reachableClassifications(result, [root.id]).forEach((classificationId) => {
      impactsByClassificationId.set(classificationId, new Set([...(impactsByClassificationId.get(classificationId) || []), root.sourceIdentity.sourceId]));
    });
  });
  const diagnosticsByClassificationId = new Map<string, WebFocusDiagnostic[]>();
  result.diagnostics.forEach((diagnostic) => {
    if (!diagnostic.classificationId) return;
    diagnosticsByClassificationId.set(diagnostic.classificationId, [...(diagnosticsByClassificationId.get(diagnostic.classificationId) || []), diagnostic]);
  });

  return result.classifications.filter((classification) => includedIds.has(classification.id)).map((classification) => {
    const rule = webFocusDevelopmentRule(classification.sourceClass);
    const relatedDiagnostics = diagnosticsByClassificationId.get(classification.id) || [];
    const rationale = [
      rule.guidance,
      ...relatedDiagnostics.map((diagnostic) => diagnostic.message),
    ].join(' ').trim();
    const confidence = classification.status === 'evidence'
      ? rule.disposition === 'candidate' ? 0.9 : 0.75
      : classification.status === 'ambiguous' ? 0.5 : 0.2;
    return withMigrationDecisionIdentity({
      id: `decision:${classification.id}`,
      nodeId: classification.id,
      domain: rule.decisionDomain,
      sourceLabel: classification.sourceName,
      action: rule.defaultDecisionAction,
      rationale,
      confidence,
      evidence: [{
        sourceId: classification.sourceIdentity.sourceId,
        artifactId: classification.artifactId,
        locator: classification.sourceIdentity.locator,
      }],
      blocking: true,
      impactAssetIds: Array.from(impactsByClassificationId.get(classification.id) || []).sort(),
      validationRequired: true,
      compatibilityKey: `webfocus:${classification.sourceClass}:${encoded(classification.sourceIdentity.sourceId)}`,
      approvedByUser: false,
    });
  }).sort((left, right) => left.domain.localeCompare(right.domain) || left.sourceLabel.localeCompare(right.sourceLabel) || left.id.localeCompare(right.id));
}

function scopedDecisionKey(decision: MigrationDecision): string {
  const evidence = decision.evidence.map((item) => `${item.sourceId}:${item.locator || ''}`).sort().join('|');
  return `${decision.domain}:${decision.sourceLabel.trim().toLowerCase()}:${evidence}`;
}

export function mergeRequiredWebFocusDecisions(
  aiDecisions: MigrationDecision[],
  requiredDecisions: MigrationDecision[],
): MigrationDecision[] {
  const remaining = new Map(requiredDecisions.map((decision) => [decision.id, decision]));
  const byNodeId = new Map(requiredDecisions.map((decision) => [decision.nodeId, decision]));
  const byScopedKey = new Map(requiredDecisions.map((decision) => [scopedDecisionKey(decision), decision]));
  const merged = aiDecisions.map((decision) => {
    const required = remaining.get(decision.id)
      || byNodeId.get(decision.nodeId)
      || byScopedKey.get(scopedDecisionKey(decision));
    if (!required || !remaining.has(required.id)) return decision;
    remaining.delete(required.id);
    return withMigrationDecisionIdentity({
      ...required,
      ...decision,
      id: required.id,
      nodeId: required.nodeId,
      semanticKey: undefined,
      evidence: Array.from(new Map([...required.evidence, ...decision.evidence].map((item) => [`${item.sourceId}:${item.locator || ''}`, item])).values()),
      impactAssetIds: Array.from(new Set([...required.impactAssetIds, ...decision.impactAssetIds])).sort(),
      blocking: true,
      validationRequired: true,
      compatibilityKey: required.compatibilityKey,
      approvedByUser: false,
    });
  });
  return mergeMigrationDecisionProposalChunks([[
    ...merged,
    ...Array.from(remaining.values()).map(withMigrationDecisionIdentity),
  ]]);
}

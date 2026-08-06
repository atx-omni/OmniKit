import {
  MICROSTRATEGY_EVIDENCE_SCHEMA_VERSION,
  MICROSTRATEGY_OFFICIAL_DOCUMENTATION,
  MICROSTRATEGY_SUPPORTED_EVIDENCE_CLASSES,
} from '../../../src/services/semanticMigration/microStrategyEvidence';
import type {
  MicroStrategyArtifactClass,
  MicroStrategyCandidatePlacement,
  MicroStrategyDependencyEdge,
  MicroStrategyEvidenceBundle,
  MicroStrategyEvidenceClassification,
  MicroStrategyEvidenceDiagnostic,
  MicroStrategyEvidenceLevel,
  MicroStrategyEvidenceNode,
  MicroStrategyExpressionEvidence,
  MicroStrategyMetricDimensionalityUnit,
  MicroStrategyObjectReference,
} from '../../../src/services/semanticMigration/microStrategyEvidence';
import type { MigrationArtifact } from '../../../src/services/semanticMigration/types';

type RecordValue = Record<string, unknown>;

interface LocatedRecord {
  artifactName: string;
  value: RecordValue;
  path: string;
  parentKey: string;
  ancestors: LocatedRecord[];
}

interface ParsedArtifact {
  artifact: MigrationArtifact;
  value: unknown;
}

const DEFINITION_REQUIRED = new Set<MicroStrategyArtifactClass>([
  'report',
  'dossier',
  'document',
  'dataset',
  'intelligent_cube',
  'attribute',
  'attribute_form',
  'metric',
  'filter',
  'prompt',
]);

const SOURCE_ID_EXPECTED = new Set<MicroStrategyArtifactClass>([
  'project',
  'report',
  'dossier',
  'document',
  'dataset',
  'intelligent_cube',
  'attribute',
  'attribute_form',
  'metric',
  'prompt',
  'derived_element',
]);

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(...values: unknown[]): string {
  const value = values.find((item) => (typeof item === 'string' || typeof item === 'number') && String(item).trim());
  return value == null ? '' : String(value).trim();
}

function optionalText(...values: unknown[]): string | undefined {
  return text(...values) || undefined;
}

function unique(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9:_-]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
}

function information(record: RecordValue): RecordValue {
  return isRecord(record.information) ? record.information : {};
}

function sourceId(record: RecordValue): string | undefined {
  const info = information(record);
  return optionalText(record.id, record.objectId, info.objectId, info.id);
}

function objectName(record: RecordValue): string | undefined {
  const info = information(record);
  return optionalText(record.name, record.title, info.name);
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function expressionEvidence(value: unknown, fallbackText?: string): MicroStrategyExpressionEvidence {
  const expression = isRecord(value) ? value : {};
  return {
    text: optionalText(expression.text, expression.expressionText, fallbackText),
    hasTree: isRecord(expression.tree) || Array.isArray(expression.tree),
    hasTokens: Array.isArray(expression.tokens),
  };
}

function walkRecords(
  artifactName: string,
  value: unknown,
  path = '$',
  parentKey = '',
  ancestors: LocatedRecord[] = [],
  output: LocatedRecord[] = [],
  depth = 0,
): LocatedRecord[] {
  if (depth > 16) {
    throw new Error(`MicroStrategy evidence exceeded the 16-level traversal limit at ${artifactName}:${path}.`);
  }
  if (output.length >= 12_000) {
    throw new Error(`MicroStrategy evidence exceeded the 12,000-record traversal limit in ${artifactName}.`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkRecords(artifactName, item, `${path}[${index}]`, parentKey, ancestors, output, depth + 1));
    return output;
  }
  if (!isRecord(value)) return output;

  const location: LocatedRecord = { artifactName, value, path, parentKey, ancestors };
  output.push(location);
  const nextAncestors = [...ancestors, location];
  Object.entries(value).forEach(([key, child]) => {
    if (child && typeof child === 'object') walkRecords(artifactName, child, `${path}.${key}`, key, nextAncestors, output, depth + 1);
  });
  return output;
}

function kindFromObjectType(value: unknown): MicroStrategyArtifactClass | undefined {
  const raw = text(value).toLowerCase();
  if (!raw) return undefined;
  if (raw === '71' || /intelligent[_ ]?cube|report_cube|cube/.test(raw)) return 'intelligent_cube';
  if (raw === '3' || /report/.test(raw)) return 'report';
  if (raw === '4' || /metric/.test(raw)) return 'metric';
  if (raw === '12' || /attribute(?!_form)/.test(raw)) return 'attribute';
  if (/attribute_form/.test(raw)) return 'attribute_form';
  if (raw === '55' || /document/.test(raw)) return 'document';
  if (/dataset/.test(raw)) return 'dataset';
  if (/derived|consolidation_element/.test(raw)) return 'derived_element';
  if (/prompt/.test(raw)) return 'prompt';
  if (/filter/.test(raw)) return 'filter';
  if (/project/.test(raw)) return 'project';
  return undefined;
}

function nearestAncestor(location: LocatedRecord, kinds: MicroStrategyArtifactClass[]): LocatedRecord | undefined {
  return [...location.ancestors].reverse().find((ancestor) => {
    const kind = classifyLocation(ancestor);
    return Boolean(kind && kinds.includes(kind));
  });
}

function classifyLocation(location: LocatedRecord): MicroStrategyArtifactClass | undefined {
  const key = location.parentKey.toLowerCase();
  const record = location.value;
  if (key === 'information') return undefined;
  const info = information(record);
  const declaredKind = kindFromObjectType(text(record.subType, record.type, record.kind, info.subType, info.type));

  if (['reportlimit', 'reportlimits', 'report_limit', 'templatelimit'].includes(key)) return 'report_limit';
  if (['metriclimit', 'metric_limit', 'metriclimits'].includes(key)) return 'metric_limit';
  if (key === 'limit' && nearestAncestor(location, ['metric'])) return 'metric_limit';
  if (key === 'limit' && nearestAncestor(location, ['report'])) return 'report_limit';
  if (['derivedelements', 'derived_elements', 'derivedelement'].includes(key) || declaredKind === 'derived_element') return 'derived_element';
  if (key === 'forms' || declaredKind === 'attribute_form') return 'attribute_form';
  if (key === 'prompts' || declaredKind === 'prompt') return 'prompt';
  if (['filters', 'filter', 'viewfilter', 'view_filter'].includes(key) || declaredKind === 'filter' || (isRecord(record.qualification) && Boolean(sourceId(record)))) return 'filter';
  if (key === 'attributes' || (key === 'availableobjects' && declaredKind === 'attribute') || declaredKind === 'attribute') return 'attribute';
  if (['metrics', 'measures'].includes(key) || (key === 'availableobjects' && declaredKind === 'metric') || declaredKind === 'metric') return 'metric';
  if (key === 'reports' || declaredKind === 'report' || (isRecord(record.dataSource) && (isRecord(record.grid) || record.sourceType !== undefined))) return 'report';
  if (key === 'cubes' || declaredKind === 'intelligent_cube') return 'intelligent_cube';
  if (key === 'datasets' || declaredKind === 'dataset') return 'dataset';
  if (key === 'documents' || declaredKind === 'document') return 'document';
  if (['dossiers', 'dashboards'].includes(key) || Array.isArray(record.chapters)) return /document/i.test(text(record.documentType, info.subType)) ? 'document' : 'dossier';
  if (key === 'projects' || declaredKind === 'project' || (record.status !== undefined && Boolean(text(record.alias)))) return 'project';
  return undefined;
}

function evidenceLevel(kind: MicroStrategyArtifactClass, record: RecordValue): MicroStrategyEvidenceLevel {
  if (kind === 'project') return 'inventory';
  if (kind === 'sql') return 'execution';
  if (kind === 'report') return isRecord(record.dataSource) || Array.isArray(record.attributes) || Array.isArray(record.metrics) || Boolean(record.cubeId) ? 'definition' : 'inventory';
  if (kind === 'dossier' || kind === 'document') return Array.isArray(record.datasets) || Array.isArray(record.chapters) ? 'definition' : 'inventory';
  if (kind === 'dataset' || kind === 'intelligent_cube') return Array.isArray(record.availableObjects) || Array.isArray(record.attributes) || Array.isArray(record.metrics) ? 'definition' : 'inventory';
  if (kind === 'attribute') return Array.isArray(record.forms) || Array.isArray(record.expressions) ? 'definition' : 'reference';
  if (kind === 'attribute_form') return Array.isArray(record.expressions) || record.dataType !== undefined || record.category !== undefined ? 'definition' : 'reference';
  if (kind === 'metric') return isRecord(record.expression) || record.formula !== undefined || isRecord(record.dimty) ? 'definition' : 'reference';
  if (kind === 'filter') return isRecord(record.qualification) || isRecord(record.expression) || Boolean(text(record.summary, record.viewFilterSummary, record.metricLimitSummary)) ? 'definition' : 'reference';
  if (kind === 'prompt') return record.type !== undefined || record.required !== undefined || record.defaultAnswer !== undefined ? 'definition' : 'reference';
  return 'definition';
}

function referenceKind(record: RecordValue, parentKey: string): MicroStrategyArtifactClass | undefined {
  const explicit = kindFromObjectType(text(record.subType, record.type, record.kind, information(record).subType));
  if (explicit) return explicit;
  const key = parentKey.toLowerCase();
  if (key === 'attributes') return 'attribute';
  if (['metrics', 'measures'].includes(key)) return 'metric';
  if (key === 'reports') return 'report';
  if (key === 'datasets') return 'dataset';
  if (key === 'cubes') return 'intelligent_cube';
  if (key === 'filters') return 'filter';
  if (key === 'prompts') return 'prompt';
  return undefined;
}

function collectReferences(
  value: unknown,
  sourcePath: string,
  ownerSourceId: string | undefined,
  parentKey = '',
  output: MicroStrategyObjectReference[] = [],
  depth = 0,
): MicroStrategyObjectReference[] {
  if (depth > 10) {
    throw new Error(`MicroStrategy dependency evidence exceeded the 10-level traversal limit at ${sourcePath}.`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectReferences(item, `${sourcePath}[${index}]`, ownerSourceId, parentKey, output, depth + 1));
    return output;
  }
  if (!isRecord(value)) return output;

  const id = sourceId(value);
  const kind = referenceKind(value, parentKey);
  if (id && id !== ownerSourceId && kind) {
    output.push({
      sourceId: id,
      name: objectName(value),
      expectedKinds: kind === 'dataset' || kind === 'intelligent_cube' ? ['dataset', 'intelligent_cube', 'report'] : [kind],
      sourcePath,
      requirement: 'definition',
    });
  }
  Object.entries(value).forEach(([key, child]) => {
    if (child && typeof child === 'object') collectReferences(child, `${sourcePath}.${key}`, ownerSourceId, key, output, depth + 1);
  });
  return output;
}

function addDirectReference(
  references: MicroStrategyObjectReference[],
  sourceIdValue: unknown,
  expectedKinds: MicroStrategyArtifactClass[],
  sourcePath: string,
  name?: string,
): void {
  const id = text(sourceIdValue);
  if (!id) return;
  references.push({ sourceId: id, name, expectedKinds, sourcePath, requirement: 'definition' });
}

function dedupeReferences(references: MicroStrategyObjectReference[]): MicroStrategyObjectReference[] {
  return Array.from(new Map(references.map((reference) => [
    `${reference.sourceId}:${reference.expectedKinds.join(',')}:${reference.sourcePath}`,
    reference,
  ])).values());
}

function baseClassification(kind: MicroStrategyArtifactClass): MicroStrategyEvidenceClassification {
  const placement: Record<MicroStrategyArtifactClass, MicroStrategyCandidatePlacement> = {
    project: 'model_context',
    report: 'topic',
    dossier: 'dashboard_specification',
    document: 'dashboard_specification',
    dataset: 'shared_model_view',
    intelligent_cube: 'shared_model_view',
    attribute: 'dimension',
    attribute_form: 'dimension',
    metric: 'shared_model_measure',
    filter: 'filter',
    prompt: 'filter',
    report_limit: 'unsupported',
    metric_limit: 'unsupported',
    derived_element: 'unsupported',
    sql: 'upstream_transformation',
  };
  const status = kind === 'project' || kind === 'attribute' || kind === 'attribute_form'
    ? 'captured'
    : kind === 'report_limit' || kind === 'metric_limit' || kind === 'derived_element'
      ? 'unsupported'
      : 'review_required';
  const reasonCodes = kind === 'report_limit' || kind === 'metric_limit'
    ? ['limit_behavior_requires_explicit_target_decision']
    : kind === 'derived_element'
      ? ['derived_element_translation_unsupported']
      : kind === 'sql'
        ? ['execution_sql_is_not_semantic_definition']
        : [];
  return { status, candidatePlacement: placement[kind], reasonCodes };
}

function identity(location: LocatedRecord, kind: MicroStrategyArtifactClass): {
  evidenceId: string;
  sourceId?: string;
  occurrenceKey?: string;
  syntheticIdentityReason?: 'source_object_id_missing';
  name: string;
} {
  const id = sourceId(location.value);
  const occurrenceKey = kind === 'prompt' ? optionalText(location.value.key) : undefined;
  const name = objectName(location.value) || `${kind.replace(/_/g, ' ')} at ${location.path}`;
  const discriminator = occurrenceKey || location.path;
  return {
    evidenceId: `microstrategy:${kind}:${slug(location.artifactName)}:${slug(id || location.path)}:${slug(discriminator)}`,
    sourceId: id,
    occurrenceKey,
    syntheticIdentityReason: id ? undefined : 'source_object_id_missing',
    name,
  };
}

function metricDimensionality(record: RecordValue): { status: 'explicit' | 'missing'; units: MicroStrategyMetricDimensionalityUnit[] } {
  const dimty = isRecord(record.dimty) ? record.dimty : {};
  const units = array(dimty.dimtyUnits).filter(isRecord).map((unit) => {
    const target = isRecord(unit.target) ? unit.target : {};
    return {
      unitType: text(unit.dimtyUnitType, unit.type, 'unknown'),
      targetSourceId: sourceId(target),
      targetName: objectName(target),
      aggregation: optionalText(unit.aggregation),
      filtering: optionalText(unit.filtering),
      groupBy: typeof unit.groupBy === 'boolean' ? unit.groupBy : undefined,
    };
  });
  return { status: units.length ? 'explicit' : 'missing', units };
}

function nearestOwnerIdentity(location: LocatedRecord): { id?: string; name?: string } {
  const currentKind = classifyLocation(location);
  if (currentKind && ['report', 'dossier', 'document', 'dataset', 'intelligent_cube'].includes(currentKind)) {
    return { id: sourceId(location.value), name: objectName(location.value) };
  }
  const owner = nearestAncestor(location, ['report', 'dossier', 'document', 'dataset', 'intelligent_cube']);
  return owner ? { id: sourceId(owner.value), name: objectName(owner.value) } : {};
}

function makeNode(location: LocatedRecord, kind: MicroStrategyArtifactClass): MicroStrategyEvidenceNode {
  const record = location.value;
  const objectIdentity = identity(location, kind);
  const level = evidenceLevel(kind, record);
  const references = collectReferences(record, location.path, objectIdentity.sourceId);
  const common = {
    ...objectIdentity,
    sourceArtifact: location.artifactName,
    sourcePath: location.path,
    evidenceLevel: level,
    classification: baseClassification(kind),
    references,
  };

  if (kind === 'project') return { ...common, kind, details: { alias: optionalText(record.alias), status: optionalText(record.status) } };

  if (kind === 'report') {
    addDirectReference(references, record.cubeId, ['intelligent_cube', 'dataset'], `${location.path}.cubeId`);
    addDirectReference(references, record.datasetId, ['dataset', 'intelligent_cube', 'report'], `${location.path}.datasetId`);
    const dataSource = isRecord(record.dataSource) ? record.dataSource : {};
    const cube = isRecord(dataSource.cube) ? dataSource.cube : {};
    const report = isRecord(dataSource.report) ? dataSource.report : {};
    addDirectReference(references, sourceId(cube), ['intelligent_cube', 'dataset'], `${location.path}.dataSource.cube`, objectName(cube));
    addDirectReference(references, sourceId(report), ['report'], `${location.path}.dataSource.report`, objectName(report));
    const sourceType = optionalText(record.sourceType);
    return {
      ...common,
      kind,
      references: dedupeReferences(references),
      details: {
        sourceType,
        freeformSql: Boolean(sourceType && /freeform|free_form|sql/i.test(sourceType)),
        datasetSourceIds: [],
        attributeSourceIds: [],
        metricSourceIds: [],
        filterSourceIds: [],
        promptSourceIds: [],
        limitEvidenceIds: [],
        derivedElementSourceIds: [],
        sqlEvidenceIds: [],
      },
    };
  }

  if (kind === 'dossier' || kind === 'document') {
    array(record.datasets).filter(isRecord).forEach((dataset, index) => addDirectReference(
      references,
      sourceId(dataset),
      ['dataset', 'intelligent_cube', 'report'],
      `${location.path}.datasets[${index}]`,
      objectName(dataset),
    ));
    const records = walkRecords(location.artifactName, record, location.path);
    return {
      ...common,
      kind,
      references: dedupeReferences(references),
      details: {
        datasetSourceIds: [],
        chapterCount: records.filter((candidate) => candidate.parentKey === 'chapters').length,
        pageCount: records.filter((candidate) => candidate.parentKey === 'pages').length,
        visualizationCount: records.filter((candidate) => candidate.parentKey === 'visualizations').length,
        filterEvidenceIds: [],
        promptEvidenceIds: [],
      },
    };
  }

  if (kind === 'dataset' || kind === 'intelligent_cube') {
    addDirectReference(references, record.reportId, ['report'], `${location.path}.reportId`);
    return {
      ...common,
      kind,
      references: dedupeReferences(references),
      details: { sourceType: optionalText(record.sourceType, record.subType), attributeSourceIds: [], metricSourceIds: [], reportSourceIds: [] },
    };
  }

  if (kind === 'attribute') {
    const keyForm = isRecord(record.keyForm) ? record.keyForm : {};
    const lookupTable = isRecord(record.attributeLookupTable) ? record.attributeLookupTable : {};
    return {
      ...common,
      kind,
      references: dedupeReferences(references),
      details: { formSourceIds: [], keyFormName: objectName(keyForm), lookupTableSourceId: sourceId(lookupTable) },
    };
  }

  if (kind === 'attribute_form') {
    const parent = nearestAncestor(location, ['attribute']);
    const firstExpression = array(record.expressions).find(isRecord);
    const expression = firstExpression && isRecord(firstExpression.expression) ? firstExpression.expression : record.expression;
    const dataType = isRecord(record.dataType) ? record.dataType : {};
    return {
      ...common,
      kind,
      references: dedupeReferences(references),
      details: {
        parentAttributeSourceId: parent ? sourceId(parent.value) : undefined,
        category: optionalText(record.category, record.baseFormCategory),
        dataType: optionalText(record.displayFormat, dataType.type, record.baseFormType),
        expression: expressionEvidence(expression),
      },
    };
  }

  if (kind === 'metric') {
    const metricExpression = expressionEvidence(record.expression, text(record.formula, record.definition, record.expressionText));
    const dimensionality = metricDimensionality(record);
    return {
      ...common,
      kind,
      references: dedupeReferences(references),
      details: {
        expression: metricExpression,
        dimensionalityStatus: dimensionality.status,
        dimensionalityUnits: dimensionality.units,
        conditionalFilterSourceIds: [],
      },
    };
  }

  if (kind === 'filter') {
    const qualification = isRecord(record.qualification) ? record.qualification : record.expression;
    const lowerPath = location.path.toLowerCase();
    const filterRole = lowerPath.includes('viewfilter') || lowerPath.includes('view_filter')
      ? 'view_filter'
      : lowerPath.includes('selector') || Boolean(record.selectorType)
        ? 'selector'
        : nearestAncestor(location, ['report'])
          ? 'report_filter'
          : 'standalone';
    return {
      ...common,
      kind,
      references: dedupeReferences(references),
      details: { qualification: expressionEvidence(qualification, text(record.summary, record.viewFilterSummary, record.metricLimitSummary)), filterRole },
    };
  }

  if (kind === 'prompt') {
    return {
      ...common,
      kind,
      references: dedupeReferences(references),
      details: {
        promptType: optionalText(record.type, record.promptType),
        required: typeof record.required === 'boolean' ? record.required : undefined,
        closed: typeof record.closed === 'boolean' ? record.closed : undefined,
        hasDefaultAnswer: Array.isArray(record.defaultAnswer) ? record.defaultAnswer.length > 0 : record.defaultAnswer != null,
      },
    };
  }

  if (kind === 'report_limit' || kind === 'metric_limit') {
    const owner = nearestOwnerIdentity(location);
    return {
      ...common,
      kind,
      references: dedupeReferences(references),
      details: { expression: expressionEvidence(record.expression, text(record.text, record.summary)), ownerSourceId: owner.id },
    };
  }

  if (kind === 'derived_element') {
    const attribute = isRecord(record.attribute) ? record.attribute : {};
    return {
      ...common,
      kind,
      references: dedupeReferences(references),
      details: {
        attributeSourceId: sourceId(attribute),
        elementCount: array(record.elements).length,
        elementTypes: unique(array(record.elements).filter(isRecord).map((element) => optionalText(element.type))),
      },
    };
  }

  throw new Error(`Unexpected record-backed MicroStrategy evidence kind: ${kind}`);
}

function sqlNodes(locations: LocatedRecord[]): MicroStrategyEvidenceNode[] {
  const nodes: MicroStrategyEvidenceNode[] = [];
  locations.forEach((location) => {
    Object.entries(location.value).forEach(([key, value]) => {
      if (typeof value !== 'string' || !value.trim()) return;
      const normalizedKey = key.toLowerCase().replace(/_/g, '');
      const sourceType = text(location.value.sourceType).toLowerCase();
      const isSql = ['sqlstatement', 'freeformsql', 'customsql'].includes(normalizedKey)
        || (normalizedKey === 'sql' && (/freeform|sql/.test(sourceType) || /sqlview/i.test(location.path)));
      if (!isSql) return;
      const owner = nearestOwnerIdentity(location);
      const directOwnerId = optionalText(location.value.reportId, location.value.datasetId, location.value.cubeId, owner.id);
      const sourcePath = `${location.path}.${key}`;
      nodes.push({
        evidenceId: `microstrategy:sql:${slug(`${location.artifactName}:${sourcePath}`)}`,
        kind: 'sql',
        syntheticIdentityReason: 'source_object_id_missing',
        name: `${owner.name || 'Strategy'} SQL`,
        sourceArtifact: location.artifactName,
        sourcePath,
        evidenceLevel: 'execution',
        classification: baseClassification('sql'),
        references: [],
        details: { ownerSourceId: directOwnerId, statement: value.trim(), executionScoped: true },
      });
    });
  });
  return nodes;
}

function descendants(nodes: MicroStrategyEvidenceNode[], owner: MicroStrategyEvidenceNode, kinds: MicroStrategyArtifactClass[]): MicroStrategyEvidenceNode[] {
  const prefix = `${owner.sourcePath}.`;
  return nodes.filter((node) => node.sourceArtifact === owner.sourceArtifact && node.sourcePath.startsWith(prefix) && kinds.includes(node.kind));
}

function populateDetails(nodes: MicroStrategyEvidenceNode[]): void {
  nodes.forEach((node) => {
    const refsFor = (...kinds: MicroStrategyArtifactClass[]) => unique(node.references
      .filter((reference) => reference.expectedKinds.some((kind) => kinds.includes(kind)))
      .map((reference) => reference.sourceId));

    if (node.kind === 'report') {
      node.details.datasetSourceIds = refsFor('dataset', 'intelligent_cube', 'report').filter((id) => id !== node.sourceId);
      node.details.attributeSourceIds = refsFor('attribute');
      node.details.metricSourceIds = refsFor('metric');
      node.details.filterSourceIds = refsFor('filter');
      node.details.promptSourceIds = refsFor('prompt');
      node.details.limitEvidenceIds = descendants(nodes, node, ['report_limit', 'metric_limit']).map((item) => item.evidenceId);
      node.details.derivedElementSourceIds = unique(descendants(nodes, node, ['derived_element']).map((item) => item.sourceId));
      node.details.sqlEvidenceIds = nodes.filter((item) => item.kind === 'sql'
        && ((item.details.ownerSourceId && item.details.ownerSourceId === node.sourceId)
          || (item.sourceArtifact === node.sourceArtifact && item.sourcePath.startsWith(`${node.sourcePath}.`))))
        .map((item) => item.evidenceId);
      if (node.details.freeformSql && node.details.sqlEvidenceIds.length === 0) {
        node.classification = { ...node.classification, status: 'blocked', reasonCodes: [...node.classification.reasonCodes, 'freeform_sql_evidence_missing'] };
      }
      return;
    }

    if (node.kind === 'dossier' || node.kind === 'document') {
      node.details.datasetSourceIds = refsFor('dataset', 'intelligent_cube', 'report');
      node.details.filterEvidenceIds = descendants(nodes, node, ['filter']).map((item) => item.evidenceId);
      node.details.promptEvidenceIds = descendants(nodes, node, ['prompt']).map((item) => item.evidenceId);
      if (node.evidenceLevel === 'definition' && node.details.datasetSourceIds.length === 0) {
        node.classification = { ...node.classification, status: 'blocked', reasonCodes: [...node.classification.reasonCodes, 'dataset_dependency_missing'] };
      }
      return;
    }

    if (node.kind === 'dataset' || node.kind === 'intelligent_cube') {
      node.details.attributeSourceIds = refsFor('attribute');
      node.details.metricSourceIds = refsFor('metric');
      node.details.reportSourceIds = refsFor('report');
      return;
    }

    if (node.kind === 'attribute') {
      node.details.formSourceIds = unique(descendants(nodes, node, ['attribute_form']).map((item) => item.sourceId));
      return;
    }

    if (node.kind === 'metric') node.details.conditionalFilterSourceIds = refsFor('filter');
  });
}

function reconcileDefinitions(nodes: MicroStrategyEvidenceNode[]): void {
  const matching = (node: MicroStrategyEvidenceNode) => node.sourceId
    ? nodes.filter((candidate) => candidate.kind === node.kind && candidate.sourceId === node.sourceId)
    : [node];

  nodes.forEach((node) => {
    if (!DEFINITION_REQUIRED.has(node.kind)) return;
    const peers = matching(node);
    const hasDefinition = peers.some((candidate) => candidate.evidenceLevel === 'definition');
    if (!hasDefinition) {
      node.classification = {
        ...node.classification,
        status: 'blocked',
        reasonCodes: unique([...node.classification.reasonCodes, `${node.kind}_definition_missing`]),
      };
    }

    if (node.kind === 'metric') {
      const hasDimensionality = peers.some((candidate) => candidate.kind === 'metric' && candidate.details.dimensionalityStatus === 'explicit');
      if (!hasDimensionality) {
        node.classification = {
          ...node.classification,
          status: 'blocked',
          reasonCodes: unique([...node.classification.reasonCodes, 'metric_dimensionality_missing']),
        };
      } else if (hasDefinition && node.classification.status === 'blocked'
        && node.classification.reasonCodes.every((code) => code.endsWith('_definition_missing') || code === 'metric_dimensionality_missing')) {
        node.classification = { ...node.classification, status: 'review_required', reasonCodes: [] };
      }
    }
  });
}

function resolveDependencies(nodes: MicroStrategyEvidenceNode[]): MicroStrategyDependencyEdge[] {
  const edges: MicroStrategyDependencyEdge[] = [];
  nodes.forEach((node) => {
    node.references.forEach((reference, index) => {
      const matches = nodes.filter((candidate) => candidate.sourceId === reference.sourceId && reference.expectedKinds.includes(candidate.kind));
      const definition = matches.find((candidate) => candidate.evidenceLevel === 'definition' || candidate.evidenceLevel === 'execution');
      const resolved = definition || matches[0];
      const status = !resolved ? 'missing' : reference.requirement === 'definition' && !definition ? 'partial' : 'resolved';
      edges.push({
        id: `microstrategy:dependency:${slug(node.evidenceId)}:${slug(reference.sourceId)}:${index}`,
        sourceEvidenceId: node.evidenceId,
        dependencySourceId: reference.sourceId,
        dependencyName: reference.name,
        expectedKinds: reference.expectedKinds,
        requirement: reference.requirement,
        sourcePath: reference.sourcePath,
        resolvedEvidenceId: resolved?.evidenceId,
        status,
      });
    });
  });
  return edges;
}

function diagnosticMessage(node: MicroStrategyEvidenceNode, code: string): string {
  if (code === 'metric_dimensionality_missing') return `Metric ${node.sourceId || node.name} has no explicit dimty units; dimensionality was not inferred.`;
  if (code === 'freeform_sql_evidence_missing') return `Freeform SQL report ${node.sourceId || node.name} is missing instance SQL evidence.`;
  if (code === 'dataset_dependency_missing') return `${node.kind} ${node.sourceId || node.name} does not identify a dataset dependency.`;
  if (code === 'derived_element_translation_unsupported') return `Derived element ${node.sourceId || node.name} requires an explicit target decision; no translation was inferred.`;
  if (code === 'limit_behavior_requires_explicit_target_decision') return `${node.kind.replace(/_/g, ' ')} ${node.sourceId || node.name} requires an explicit target decision; no filter coercion was applied.`;
  if (code.endsWith('_definition_missing')) return `${node.kind.replace(/_/g, ' ')} ${node.sourceId || node.name} is referenced without a full definition.`;
  return `${node.kind.replace(/_/g, ' ')} ${node.sourceId || node.name} requires review: ${code}.`;
}

function diagnostics(nodes: MicroStrategyEvidenceNode[], dependencies: MicroStrategyDependencyEdge[]): {
  blockers: MicroStrategyEvidenceDiagnostic[];
  warnings: MicroStrategyEvidenceDiagnostic[];
} {
  const blockers: MicroStrategyEvidenceDiagnostic[] = [];
  const warnings: MicroStrategyEvidenceDiagnostic[] = [];

  nodes.forEach((node) => {
    if (!node.sourceId && SOURCE_ID_EXPECTED.has(node.kind)) {
      blockers.push({
        code: 'source_id_missing',
        severity: 'blocker',
        message: `${node.kind.replace(/_/g, ' ')} ${node.name} is missing the stable source ID exposed by Strategy metadata.`,
        sourceArtifact: node.sourceArtifact,
        sourcePath: node.sourcePath,
        evidenceId: node.evidenceId,
      });
    }
    node.classification.reasonCodes.forEach((code) => {
      if (code === 'execution_sql_is_not_semantic_definition') {
        warnings.push({ code, severity: 'warning', message: diagnosticMessage(node, code), sourceArtifact: node.sourceArtifact, sourcePath: node.sourcePath, evidenceId: node.evidenceId });
        return;
      }
      blockers.push({ code, severity: 'blocker', message: diagnosticMessage(node, code), sourceArtifact: node.sourceArtifact, sourcePath: node.sourcePath, evidenceId: node.evidenceId });
    });
  });

  dependencies.filter((edge) => edge.status !== 'resolved').forEach((edge) => {
    const owner = nodes.find((node) => node.evidenceId === edge.sourceEvidenceId);
    if (!owner) return;
    const code = edge.status === 'missing' ? 'missing_dependency' : 'partial_dependency';
    blockers.push({
      code,
      severity: 'blocker',
      message: `${owner.kind.replace(/_/g, ' ')} ${owner.sourceId || owner.name} requires ${edge.dependencySourceId}, but its ${edge.requirement} evidence is ${edge.status}.`,
      sourceArtifact: owner.sourceArtifact,
      sourcePath: edge.sourcePath,
      evidenceId: owner.evidenceId,
      dependencySourceId: edge.dependencySourceId,
    });
  });

  const dedupe = (items: MicroStrategyEvidenceDiagnostic[]) => Array.from(new Map(items.map((item) => [
    `${item.code}:${item.evidenceId || ''}:${item.dependencySourceId || ''}:${item.sourcePath}`,
    item,
  ])).values());
  return { blockers: dedupe(blockers), warnings: dedupe(warnings) };
}

function counts(nodes: MicroStrategyEvidenceNode[]): Record<MicroStrategyArtifactClass, number> {
  const result = Object.fromEntries(MICROSTRATEGY_SUPPORTED_EVIDENCE_CLASSES.map((kind) => [kind, 0])) as Record<MicroStrategyArtifactClass, number>;
  nodes.forEach((node) => { result[node.kind] += 1; });
  return result;
}

export function parseMicroStrategyTypedEvidence(artifacts: MigrationArtifact[]): MicroStrategyEvidenceBundle {
  const parseBlockers: MicroStrategyEvidenceDiagnostic[] = [];
  const parsed: ParsedArtifact[] = artifacts.map((artifact) => {
    try {
      return { artifact, value: JSON.parse(artifact.content) as unknown };
    } catch {
      parseBlockers.push({
        code: 'invalid_json',
        severity: 'blocker',
        message: `${artifact.name} is not valid JSON, so its MicroStrategy definitions and dependencies were not inventoried.`,
        sourceArtifact: artifact.name,
        sourcePath: '$',
      });
      return { artifact, value: null };
    }
  });
  const locations = parsed.flatMap(({ artifact, value }) => value == null ? [] : walkRecords(artifact.name, value));
  const nodes = locations.flatMap((location) => {
    const kind = classifyLocation(location);
    return kind ? [makeNode(location, kind)] : [];
  });
  nodes.push(...sqlNodes(locations));
  populateDetails(nodes);
  reconcileDefinitions(nodes);
  const dependencies = resolveDependencies(nodes);
  const resultDiagnostics = diagnostics(nodes, dependencies);

  return {
    schemaVersion: MICROSTRATEGY_EVIDENCE_SCHEMA_VERSION,
    documentation: MICROSTRATEGY_OFFICIAL_DOCUMENTATION,
    nodes: nodes.sort((left, right) => left.kind.localeCompare(right.kind) || left.evidenceId.localeCompare(right.evidenceId)),
    dependencies,
    diagnostics: {
      counts: counts(nodes),
      syntheticIdentityCount: nodes.filter((node) => Boolean(node.syntheticIdentityReason)).length,
      missingDependencyCount: dependencies.filter((edge) => edge.status === 'missing').length,
      partialDependencyCount: dependencies.filter((edge) => edge.status === 'partial').length,
      unsupportedBehaviorCount: nodes.filter((node) => node.classification.status === 'unsupported').length,
      blockers: [...parseBlockers, ...resultDiagnostics.blockers],
      warnings: resultDiagnostics.warnings,
    },
  };
}

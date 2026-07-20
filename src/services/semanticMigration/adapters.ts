import type {
  MigrationArtifact,
  MigrationDashboardEvidence,
  MigrationExplore,
  MigrationField,
  MigrationInventory,
  MigrationMeasure,
  MigrationRelationship,
  MigrationSourceTool,
  MigrationView,
} from './types';

const MAX_ARTIFACT_CHARS = 140_000;
const MAX_DOMO_ARTIFACT_CHARS = 500_000;
const MAX_POWER_BI_ARTIFACT_CHARS = 5 * 1024 * 1024;

export const MAX_ENGINE_MANUAL_ARTIFACTS = 500;
export const MAX_ENGINE_TEXT_ARTIFACT_BYTES = 25 * 1024 * 1024;
export const MAX_ENGINE_BINARY_ARTIFACT_BYTES = 150 * 1024 * 1024;
export const MAX_ENGINE_MANUAL_TOTAL_BYTES = 180 * 1024 * 1024;

export type MigrationEngineArtifactTransport = 'text' | 'binary';

export interface MigrationEngineUploadFile {
  name: string;
  size: number;
}

export function migrationEngineArtifactTransport(
  sourceTool: MigrationSourceTool,
  name: string,
): MigrationEngineArtifactTransport | null {
  const lower = name.toLowerCase();
  if (sourceTool === 'power_bi') return lower.endsWith('.pbix') ? 'binary' : null;
  if (sourceTool === 'tableau') {
    if (lower.endsWith('.twbx') || lower.endsWith('.tdsx')) return 'binary';
    if (lower.endsWith('.twb') || lower.endsWith('.tds') || lower.endsWith('.xml')) return 'text';
    return null;
  }
  if (sourceTool === 'looker') {
    return lower.endsWith('.lkml') || lower.endsWith('.lookml') ? 'text' : null;
  }
  if (sourceTool === 'metabase') return lower.endsWith('.json') ? 'text' : null;
  return null;
}

export function validateMigrationEngineUploadFiles(
  sourceTool: MigrationSourceTool,
  files: MigrationEngineUploadFile[],
): void {
  const supported = files.flatMap((file) => {
    const transport = migrationEngineArtifactTransport(sourceTool, file.name);
    return transport ? [{ ...file, transport }] : [];
  });
  if (supported.length === 0) return;
  if (supported.length > MAX_ENGINE_MANUAL_ARTIFACTS) {
    throw new Error(`The deterministic migration engine accepts at most ${MAX_ENGINE_MANUAL_ARTIFACTS} source artifacts per analysis.`);
  }
  const duplicateNames = Array.from(new Set(supported
    .map((file) => file.name.trim().toLowerCase())
    .filter((name, index, names) => names.indexOf(name) !== index)));
  if (duplicateNames.length > 0) {
    throw new Error(`Source artifact names must be unique. Rename or remove duplicates: ${duplicateNames.slice(0, 5).join(', ')}.`);
  }
  const oversizedText = supported.find((file) => file.transport === 'text' && file.size > MAX_ENGINE_TEXT_ARTIFACT_BYTES);
  if (oversizedText) {
    throw new Error(`${oversizedText.name} exceeds the ${(MAX_ENGINE_TEXT_ARTIFACT_BYTES / 1024 / 1024).toFixed(0)} MB text-artifact limit. Split the export without truncating its contents.`);
  }
  const oversizedBinary = supported.find((file) => file.transport === 'binary' && file.size > MAX_ENGINE_BINARY_ARTIFACT_BYTES);
  if (oversizedBinary) {
    throw new Error(`${oversizedBinary.name} exceeds the ${(MAX_ENGINE_BINARY_ARTIFACT_BYTES / 1024 / 1024).toFixed(0)} MB packaged-artifact limit.`);
  }
  const totalBytes = supported.reduce((total, file) => total + file.size, 0);
  if (totalBytes > MAX_ENGINE_MANUAL_TOTAL_BYTES) {
    throw new Error(`Deterministic source artifacts may total at most ${(MAX_ENGINE_MANUAL_TOTAL_BYTES / 1024 / 1024).toFixed(0)} MB per analysis.`);
  }
}

function artifactCharacterLimit(sourceTool: MigrationSourceTool) {
  if (sourceTool === 'domo') return MAX_DOMO_ARTIFACT_CHARS;
  if (sourceTool === 'power_bi') return MAX_POWER_BI_ARTIFACT_CHARS;
  return MAX_ARTIFACT_CHARS;
}

function makeId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function compact(value: string | undefined | null) {
  return (value || '').trim();
}

function unique(values: string[], limit = 80) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).slice(0, limit);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function inferArtifactKind(name: string, sourceTool: MigrationSourceTool): MigrationArtifact['kind'] {
  const lower = name.toLowerCase();
  if (lower.endsWith('manifest.json')) return 'manifest';
  if (sourceTool === 'webfocus' && (lower.endsWith('.mas') || lower.endsWith('.acx'))) return 'metadata';
  if (sourceTool === 'webfocus' && lower.endsWith('.fex')) return 'dashboard';
  if (lower.endsWith('.sql')) return 'sql';
  if (lower.endsWith('.yml') || lower.endsWith('.yaml')) return 'yaml';
  if (lower.endsWith('.lkml') || lower.includes('lookml')) return 'lookml';
  if (lower.endsWith('.twb') || lower.endsWith('.tds') || lower.endsWith('.xml')) return 'xml';
  if (lower.endsWith('.bim') || lower.endsWith('.tmdl') || lower.endsWith('.model')) return 'metadata';
  if (lower.endsWith('.json')) return 'json';
  if (lower.includes('dashboard')) return 'dashboard';
  if (lower.endsWith('.txt') || lower.endsWith('.md') || lower.endsWith('.csv')) return 'text';
  return sourceTool === 'looker' ? 'lookml' : 'unknown';
}

function displayNameFromFile(file: File) {
  const maybeRelative = 'webkitRelativePath' in file ? String(file.webkitRelativePath || '') : '';
  return maybeRelative || file.name;
}

export async function artifactsFromFiles(sourceTool: MigrationSourceTool, files: FileList | File[]) {
  const fileArray = Array.from(files);
  const artifacts: MigrationArtifact[] = [];

  for (const file of fileArray) {
    const name = displayNameFromFile(file);
    const warnings: string[] = [];
    if (file.type.startsWith('image/')) {
      artifacts.push({
        id: makeId('artifact'),
        sourceTool,
        name,
        kind: 'unknown',
        content: '',
        sizeBytes: file.size,
        parseWarnings: ['Image and screenshot uploads are not supported in semantic migration mode. Use source SQL, YAML, manifest JSON, or LookML text.'],
      });
      continue;
    }

    let content = await file.text();
    const characterLimit = artifactCharacterLimit(sourceTool);
    if (content.length > characterLimit) {
      content = content.slice(0, characterLimit);
      warnings.push(`Truncated ${name} to ${characterLimit.toLocaleString()} characters. Split the export into smaller, focused files if parsing evidence is missing.`);
    }

    artifacts.push({
      id: makeId('artifact'),
      sourceTool,
      name,
      kind: inferArtifactKind(name, sourceTool),
      content,
      sizeBytes: file.size,
      parseWarnings: warnings,
    });
  }

  return artifacts;
}

export function artifactFromText(sourceTool: MigrationSourceTool, content: string, name = 'pasted-source.txt'): MigrationArtifact | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  const warnings: string[] = [];
  const characterLimit = artifactCharacterLimit(sourceTool);
  const safeContent = trimmed.length > characterLimit ? trimmed.slice(0, characterLimit) : trimmed;
  if (trimmed.length > safeContent.length) {
    warnings.push(`Truncated pasted content to ${characterLimit.toLocaleString()} characters. Split the export into smaller, focused sections if parsing evidence is missing.`);
  }
  return {
    id: makeId('artifact'),
    sourceTool,
    name,
    kind: inferArtifactKind(name, sourceTool),
    content: safeContent,
    sizeBytes: new Blob([safeContent]).size,
    parseWarnings: warnings,
  };
}

export function buildMigrationInventory(sourceTool: MigrationSourceTool, artifacts: MigrationArtifact[]): MigrationInventory {
  const warnings: string[] = artifacts.flatMap((artifact) => artifact.parseWarnings);
  const views: MigrationView[] = [];
  const explores: MigrationExplore[] = [];
  const relationships: MigrationRelationship[] = [];
  const dashboards: MigrationDashboardEvidence[] = [];
  const metrics: MigrationMeasure[] = [];

  artifacts.forEach((artifact) => {
    if (!artifact.content.trim()) return;
    if (sourceTool === 'dbt') {
      const parsed = parseDbtArtifact(artifact);
      views.push(...parsed.views);
      relationships.push(...parsed.relationships);
      dashboards.push(...parsed.dashboards);
      metrics.push(...parsed.metrics);
      warnings.push(...parsed.warnings);
    } else if (sourceTool === 'looker') {
      const parsed = parseLookerArtifact(artifact);
      views.push(...parsed.views);
      explores.push(...parsed.explores);
      relationships.push(...parsed.relationships);
      dashboards.push(...parsed.dashboards);
      metrics.push(...parsed.metrics);
      warnings.push(...parsed.warnings);
    } else {
      const parsed = parseStructuredBiArtifact(artifact, sourceTool);
      views.push(...parsed.views);
      explores.push(...parsed.explores);
      relationships.push(...parsed.relationships);
      dashboards.push(...parsed.dashboards);
      metrics.push(...parsed.metrics);
      warnings.push(...parsed.warnings);
    }
  });

  const mergedViews = mergeViews(views);
  const mergedMetrics = mergeMeasures([...metrics, ...mergedViews.flatMap((view) => view.measures)]);
  const mergedRelationships = mergeRelationships([...relationships, ...explores.flatMap((explore) => explore.joins)]);
  const mergedDashboards = mergeDashboards(dashboards);
  const cleanWarnings = unique(warnings, 60);

  return {
    sourceTool,
    artifactCount: artifacts.length,
    artifacts,
    views: mergedViews,
    explores: mergeExplores(explores),
    relationships: mergedRelationships,
    dashboards: mergedDashboards,
    metrics: mergedMetrics,
    warnings: cleanWarnings,
    summary: [
      `${artifacts.length} artifact${artifacts.length === 1 ? '' : 's'}`,
      `${mergedViews.length} semantic object${mergedViews.length === 1 ? '' : 's'}`,
      `${mergedMetrics.length} metric/measure${mergedMetrics.length === 1 ? '' : 's'}`,
      `${mergedRelationships.length} relationship${mergedRelationships.length === 1 ? '' : 's'}`,
      `${mergedDashboards.length} dashboard/report evidence item${mergedDashboards.length === 1 ? '' : 's'}`,
    ].join(' · '),
  };
}

export function webFocusManualEvidenceReview(
  artifacts: MigrationArtifact[],
  inventory: MigrationInventory,
) {
  const metadataArtifactCount = artifacts.filter((artifact) => (
    artifact.kind === 'metadata' || /\.(?:mas|acx)$/i.test(artifact.name)
  )).length;
  const procedureArtifactCount = artifacts.filter((artifact) => (
    artifact.kind === 'dashboard' || /\.fex$/i.test(artifact.name)
  )).length;
  const dashboardEvidenceCount = inventory.dashboards.length;
  const hasProcedureEvidence = procedureArtifactCount > 0 || dashboardEvidenceCount > 0;
  return {
    metadataArtifactCount,
    procedureArtifactCount,
    dashboardEvidenceCount,
    hasMetadataEvidence: metadataArtifactCount > 0,
    hasProcedureEvidence,
    ready: hasProcedureEvidence,
    blockers: hasProcedureEvidence
      ? []
      : ['Add at least one WebFOCUS .fex procedure or dashboard definition before continuing.'],
    notices: metadataArtifactCount > 0
      ? []
      : ['No .mas or .acx metadata was detected. Field and relationship translation may require additional review.'],
  };
}

function parseDbtArtifact(artifact: MigrationArtifact) {
  if (artifact.kind === 'manifest') return parseDbtManifest(artifact);
  if (artifact.kind === 'yaml') return parseDbtYaml(artifact);
  if (artifact.kind === 'sql') return parseDbtSql(artifact);
  return {
    views: [] as MigrationView[],
    relationships: [] as MigrationRelationship[],
    dashboards: [] as MigrationDashboardEvidence[],
    metrics: [] as MigrationMeasure[],
    warnings: [`${artifact.name} was included as context but did not match a dbt manifest, YAML, or SQL artifact.`],
  };
}

function parseDbtManifest(artifact: MigrationArtifact) {
  const warnings: string[] = [];
  const views: MigrationView[] = [];
  const relationships: MigrationRelationship[] = [];
  const dashboards: MigrationDashboardEvidence[] = [];
  const metrics: MigrationMeasure[] = [];

  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(artifact.content) as Record<string, unknown>;
  } catch {
    return {
      views,
      relationships,
      dashboards,
      metrics,
      warnings: [`${artifact.name} is not valid JSON, so OmniKit could not parse it as a dbt manifest.`],
    };
  }

  const nodes = asRecord(manifest.nodes);
  Object.values(nodes).forEach((nodeValue) => {
    const node = asRecord(nodeValue);
    const resourceType = compact(String(node.resource_type || node.resourceType || ''));
    const name = compact(String(node.name || node.alias || ''));
    if (!name) return;
    if (resourceType === 'model' || resourceType === 'seed' || resourceType === 'snapshot' || resourceType === 'source') {
      const columns = asRecord(node.columns);
      views.push({
        name,
        description: compact(String(node.description || '')),
        sourceArtifact: artifact.name,
        fields: Object.entries(columns).map(([columnName, columnValue]) => {
          const column = asRecord(columnValue);
          return {
            name: columnName,
            type: compact(String(column.data_type || column.dataType || column.type || '')),
            description: compact(String(column.description || '')),
            sourceArtifact: artifact.name,
          };
        }),
        measures: [],
        warnings: [],
      });
    }

    if (resourceType === 'metric' || resourceType === 'measure') {
      metrics.push({
        name,
        description: compact(String(node.description || '')),
        aggregateType: compact(String(node.calculation_method || node.type || '')),
        sourceArtifact: artifact.name,
      });
    }

    if (resourceType === 'exposure') {
      dashboards.push({
        name,
        fields: [],
        filters: [],
        sourceArtifact: artifact.name,
      });
    }
  });

  const semanticModels = asRecord(manifest.semantic_models || manifest.semanticModels);
  Object.values(semanticModels).forEach((semanticValue) => {
    const semantic = asRecord(semanticValue);
    const name = compact(String(semantic.name || semantic.model || ''));
    if (!name) return;
    const dimensions = Array.isArray(semantic.dimensions) ? semantic.dimensions : [];
    const measures = Array.isArray(semantic.measures) ? semantic.measures : [];
    views.push({
      name,
      description: compact(String(semantic.description || '')),
      sourceArtifact: artifact.name,
      fields: dimensions.map((dimensionValue) => {
        const dimension = asRecord(dimensionValue);
        return {
          name: compact(String(dimension.name || '')),
          type: compact(String(dimension.type || '')),
          description: compact(String(dimension.description || '')),
          sourceArtifact: artifact.name,
        };
      }).filter((field) => field.name),
      measures: measures.map((measureValue) => {
        const measure = asRecord(measureValue);
        return {
          name: compact(String(measure.name || '')),
          type: compact(String(measure.type || '')),
          aggregateType: compact(String(measure.agg || measure.agg_time_dimension || measure.type || '')),
          description: compact(String(measure.description || '')),
          sourceArtifact: artifact.name,
        };
      }).filter((measure) => measure.name),
      warnings: [],
    });
  });

  if (views.length === 0 && metrics.length === 0 && dashboards.length === 0) {
    warnings.push(`${artifact.name} parsed successfully, but no dbt models, metrics, semantic models, or exposures were detected.`);
  }

  return { views, relationships, dashboards, metrics, warnings };
}

function parseDbtYaml(artifact: MigrationArtifact) {
  const lines = artifact.content.split(/\r?\n/);
  const views: MigrationView[] = [];
  const dashboards: MigrationDashboardEvidence[] = [];
  const metrics: MigrationMeasure[] = [];
  const warnings: string[] = [];
  let section = '';
  let currentView: MigrationView | null = null;
  let inColumns = false;

  lines.forEach((line) => {
    const indent = line.match(/^\s*/)?.[0].length || 0;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const root = trimmed.match(/^([a-zA-Z_]+):\s*$/);
    if (indent === 0 && root) {
      section = root[1];
      currentView = null;
      inColumns = false;
      return;
    }

    const namedItem = trimmed.match(/^-\s+name:\s*["']?([^"'\s#]+)["']?/);
    if (namedItem && ['models', 'sources', 'semantic_models'].includes(section) && indent <= 4) {
      currentView = {
        name: namedItem[1],
        sourceArtifact: artifact.name,
        fields: [],
        measures: [],
        warnings: [],
      };
      views.push(currentView);
      inColumns = false;
      return;
    }

    if (namedItem && section === 'metrics') {
      metrics.push({ name: namedItem[1], sourceArtifact: artifact.name });
      return;
    }

    if (namedItem && section === 'exposures') {
      dashboards.push({ name: namedItem[1], fields: [], filters: [], sourceArtifact: artifact.name });
      return;
    }

    if (currentView && trimmed === 'columns:') {
      inColumns = true;
      return;
    }

    if (currentView && inColumns && namedItem) {
      currentView.fields.push({ name: namedItem[1], sourceArtifact: artifact.name });
      return;
    }

    if (currentView && trimmed.startsWith('description:') && !currentView.description) {
      currentView.description = trimmed.replace(/^description:\s*/, '').replace(/^["']|["']$/g, '');
    }
  });

  if (views.length === 0 && metrics.length === 0 && dashboards.length === 0) {
    warnings.push(`${artifact.name} did not expose dbt models, metrics, semantic models, or exposures through the lightweight parser.`);
  }
  return { views, relationships: [] as MigrationRelationship[], dashboards, metrics, warnings };
}

function parseDbtSql(artifact: MigrationArtifact) {
  const name = artifact.name.split('/').pop()?.replace(/\.sql$/i, '') || artifact.name;
  const selectList = artifact.content.match(/\bselect\b([\s\S]*?)\bfrom\b/i)?.[1] || '';
  const columns = unique(selectList
    ?.split(',')
    .map((part) => {
      const alias = part.match(/\bas\s+([a-zA-Z_][\w]*)/i)?.[1];
      const bare = part.trim().match(/([a-zA-Z_][\w]*)\s*$/)?.[1];
      return alias || bare || '';
    }) || [], 40);
  return {
    views: [{
      name,
      sourceArtifact: artifact.name,
      fields: columns.map((column) => ({ name: column, sourceArtifact: artifact.name })),
      measures: [],
      warnings: columns.length === 0 ? ['SQL model fields could not be inferred safely from the select list.'] : [],
    }],
    relationships: [] as MigrationRelationship[],
    dashboards: [] as MigrationDashboardEvidence[],
    metrics: [] as MigrationMeasure[],
    warnings: [] as string[],
  };
}

function parseLookerArtifact(artifact: MigrationArtifact) {
  const warnings: string[] = [];
  const views = extractLookmlViews(artifact);
  const explores = extractLookmlExplores(artifact);
  const relationships = explores.flatMap((explore) => explore.joins);
  const dashboards = extractLookmlDashboards(artifact);
  const metrics = views.flatMap((view) => view.measures);

  if (/access_filter\s*:/.test(artifact.content)) {
    warnings.push(`${artifact.name} contains Looker access_filter definitions. Treat them as permission requirements; do not convert them without confirmed Omni user attributes and grants.`);
  }
  if (/derived_table\s*:|explore_source\s*:|sql_trigger_value\s*:/.test(artifact.content)) {
    warnings.push(`${artifact.name} appears to contain a derived table or PDT pattern. Prefer moving transformation logic to dbt or a governed warehouse model before generating Omni view YAML.`);
  }
  if (views.length === 0 && explores.length === 0 && dashboards.length === 0) {
    warnings.push(`${artifact.name} did not expose LookML views, explores, or dashboard evidence through the lightweight parser.`);
  }

  return { views, explores, relationships, dashboards, metrics, warnings };
}

function extractLookmlViews(artifact: MigrationArtifact): MigrationView[] {
  return extractNamedBlocks(artifact.content, 'view').map(({ name, block }) => {
    const fields = extractNamedBlocks(block, 'dimension')
      .concat(extractNamedBlocks(block, 'dimension_group'))
      .map(({ name: fieldName, block: fieldBlock }) => parseLookmlField(fieldName, fieldBlock, artifact.name));
    const measures = extractNamedBlocks(block, 'measure')
      .map(({ name: measureName, block: measureBlock }) => ({
        ...parseLookmlField(measureName, measureBlock, artifact.name),
        aggregateType: matchLookmlParam(measureBlock, 'type'),
      }));
    return {
      name,
      description: matchLookmlParam(block, 'description'),
      sourceArtifact: artifact.name,
      fields,
      measures,
      warnings: /hidden:\s*yes|hidden:\s*true/.test(block) ? ['Contains hidden Looker fields; preserve intent instead of blindly exposing everything in Omni.'] : [],
    };
  });
}

function extractLookmlExplores(artifact: MigrationArtifact): MigrationExplore[] {
  return extractNamedBlocks(artifact.content, 'explore').map(({ name, block }) => {
    const joins = extractNamedBlocks(block, 'join').map(({ name: joinName, block: joinBlock }) => ({
      from: name,
      to: joinName,
      joinType: matchLookmlParam(joinBlock, 'type'),
      relationshipType: matchLookmlParam(joinBlock, 'relationship'),
      sql: matchLookmlParam(joinBlock, 'sql_on'),
      sourceArtifact: artifact.name,
    }));
    return {
      name,
      baseView: matchLookmlParam(block, 'view_name') || name,
      joins,
      fields: unique(Array.from(block.matchAll(/\bfields\s*:\s*\[([^\]]+)\]/g)).flatMap((match) => splitInlineList(match[1])), 80),
      filters: unique(Array.from(block.matchAll(/\b(?:always_filter|conditionally_filter|access_filter)\s*:\s*([^\n{]+)/g)).map((match) => match[0]), 40),
      sourceArtifact: artifact.name,
    };
  });
}

function extractLookmlDashboards(artifact: MigrationArtifact): MigrationDashboardEvidence[] {
  const braceDashboards = extractNamedBlocks(artifact.content, 'dashboard').map(({ name, block }) => ({
    name,
    fields: extractLookmlDashboardFields(block),
    filters: unique(Array.from(block.matchAll(/\bfilter(?:s)?\s*:\s*([^\n{]+)/g)).map((match) => match[1]), 40),
    sourceArtifact: artifact.name,
  }));

  const yamlDashboards = extractLookmlDashboardSections(artifact.content).map(({ name, block }) => ({
    name,
    fields: extractLookmlDashboardFields(block),
    filters: extractLookmlDashboardFilterNames(block),
    sourceArtifact: artifact.name,
  }));

  const dashboards = mergeDashboards([...braceDashboards, ...yamlDashboards]);

  if (dashboards.length > 0) return dashboards;
  if ((artifact.kind === 'dashboard' || /\.dashboard\.lookml$/i.test(artifact.name)) && /dashboard|element|tile|vis_config|listen:/i.test(artifact.content)) {
    return [{
      name: artifact.name.replace(/\.(dashboard\.)?lookml$/i, ''),
      fields: extractLookmlDashboardFields(artifact.content),
      filters: unique(Array.from(artifact.content.matchAll(/\bfilter(?:s)?\s*:\s*([^\n{]+)/g)).map((match) => match[1]), 40),
      sourceArtifact: artifact.name,
    }];
  }
  return [];
}

function extractLookmlDashboardSections(content: string) {
  const matches = Array.from(content.matchAll(/^\s*-\s*dashboard\s*:\s*['"]?([^'"\s#]+)['"]?\s*$/gm));
  return matches.map((match, index) => {
    const block = content.slice(match.index || 0, matches[index + 1]?.index ?? content.length);
    const title = block.match(/^\s*title\s*:\s*(?:"([^"]*)"|'([^']*)'|([^\n#]+))/m);
    return {
      name: compact(title?.[1] || title?.[2] || title?.[3] || match[1]),
      block,
    };
  });
}

function extractLookmlDashboardFilterNames(content: string) {
  const dashboardFilterBlock = content.match(/^\s*filters\s*:\s*$([\s\S]*?)(?=^\s*(?:elements|tabs)\s*:\s*$|(?![\s\S]))/m)?.[1] || '';
  const filterNames = Array.from(dashboardFilterBlock.matchAll(/^\s*-\s*name\s*:\s*['"]?([^'"\n]+)['"]?\s*$/gm)).map((match) => match[1]);
  const listenNames = Array.from(content.matchAll(/^\s+listen\s*:\s*$([\s\S]*?)(?=^\s{2,}\w[\w_]*\s*:|^\s*-\s*name\s*:|(?![\s\S]))/gm))
    .flatMap((match) => Array.from(match[1].matchAll(/^\s+([^:\n]+)\s*:/gm)).map((entry) => entry[1].trim()));
  return unique([...filterNames, ...listenNames], 40);
}

function extractLookmlDashboardFields(content: string) {
  const scalarFields = Array.from(content.matchAll(/\b(?:field|dimension|measure)\s*:\s*"?([^"\n\]]+)"?/g))
    .map((match) => match[1]);
  const inlineFieldLists = Array.from(content.matchAll(/\bfields\s*:\s*\[([^\]]+)\]/g))
    .flatMap((match) => splitInlineList(match[1]));
  const multilineFieldItems = Array.from(content.matchAll(/^\s*-\s*["']?([A-Za-z0-9_.$]+(?:\.[A-Za-z0-9_.$]+)+)["']?\s*$/gm))
    .map((match) => match[1]);

  return unique([...scalarFields, ...inlineFieldLists, ...multilineFieldItems], 80);
}

function parseLookmlField(name: string, block: string, sourceArtifact: string): MigrationField {
  return {
    name,
    type: matchLookmlParam(block, 'type'),
    sql: matchLookmlParam(block, 'sql'),
    description: matchLookmlParam(block, 'description'),
    sourceArtifact,
  };
}

function parseStructuredBiArtifact(artifact: MigrationArtifact, sourceTool: MigrationSourceTool) {
  if (sourceTool === 'power_bi') return parsePowerBiArtifact(artifact);
  if (sourceTool === 'tableau') return parseTableauArtifact(artifact);
  if (sourceTool === 'domo') return parseDomoArtifact(artifact);
  if (sourceTool === 'sigma') return parseSigmaArtifact(artifact);
  if (sourceTool === 'metabase') return parseMetabaseArtifact(artifact);
  if (sourceTool === 'webfocus') return parseWebFocusArtifact(artifact);
  if (sourceTool === 'microstrategy') return parseMicroStrategyArtifact(artifact);
  return emptyParseResult(`${artifact.name} is not supported by a migration adapter yet.`);
}

function emptyParseResult(warning?: string) {
  return {
    views: [] as MigrationView[],
    explores: [] as MigrationExplore[],
    relationships: [] as MigrationRelationship[],
    dashboards: [] as MigrationDashboardEvidence[],
    metrics: [] as MigrationMeasure[],
    warnings: warning ? [warning] : [] as string[],
  };
}

function parsePowerBiArtifact(artifact: MigrationArtifact) {
  const parsedJson = tryParseJson(artifact.content);
  if (parsedJson) return parsePowerBiJsonArtifact(artifact, parsedJson);
  const textResult = parsePowerBiTextArtifact(artifact);
  const embeddedJsonResults = extractEmbeddedJsonObjects(artifact.content)
    .map((json, index) => parsePowerBiJsonArtifact({ ...artifact, name: `${artifact.name} JSON segment ${index + 1}` }, json));

  if (embeddedJsonResults.length === 0) return textResult;

  return {
    views: [...textResult.views, ...embeddedJsonResults.flatMap((result) => result.views)],
    explores: [...textResult.explores, ...embeddedJsonResults.flatMap((result) => result.explores)],
    relationships: [...textResult.relationships, ...embeddedJsonResults.flatMap((result) => result.relationships)],
    dashboards: [...textResult.dashboards, ...embeddedJsonResults.flatMap((result) => result.dashboards)],
    metrics: [...textResult.metrics, ...embeddedJsonResults.flatMap((result) => result.metrics)],
    warnings: [...textResult.warnings, ...embeddedJsonResults.flatMap((result) => result.warnings)],
  };
}

function extractEmbeddedJsonObjects(content: string) {
  const objects: unknown[] = [];
  for (let index = 0; index < content.length && objects.length < 5; index += 1) {
    if (content[index] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let cursor = index; cursor < content.length; cursor += 1) {
      const char = content[cursor];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }
      if (char === '"') {
        inString = true;
      } else if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          const parsed = tryParseJson(content.slice(index, cursor + 1));
          if (parsed && (findFirstRecord(parsed, ['model']) || findFirstArray(parsed, ['tables', 'relationships', 'sections']))) {
            objects.push(parsed);
            index = cursor;
          }
          break;
        }
      }
    }
  }
  return objects;
}

function parsePowerBiJsonArtifact(artifact: MigrationArtifact, json: unknown) {
  const warnings: string[] = [];
  const model = findFirstRecord(json, ['model']) || asRecord(json);
  const tables = findFirstArray(model, ['tables']) || findFirstArray(json, ['tables', 'entities']);
  const relationshipsRaw = findFirstArray(model, ['relationships']) || findFirstArray(json, ['relationships']);
  const views: MigrationView[] = [];
  const metrics: MigrationMeasure[] = [];
  const relationships: MigrationRelationship[] = [];
  const dashboards: MigrationDashboardEvidence[] = [];

  tables.forEach((tableValue) => {
    const table = asRecord(tableValue);
    const name = compact(String(table.name || table.displayName || table.entityName || ''));
    if (!name) return;
    const columns = findFirstArray(table, ['columns', 'fields']) || [];
    const measures = findFirstArray(table, ['measures']) || [];
    const parsedMeasures = measures.map((measureValue) => {
      const measure = asRecord(measureValue);
      return {
        name: compact(String(measure.name || measure.displayName || '')),
        type: 'measure',
        sql: compact(String(measure.expression || measure.dax || '')),
        description: compact(String(measure.description || '')),
        aggregateType: 'DAX',
        sourceArtifact: artifact.name,
      };
    }).filter((measure) => measure.name);
    metrics.push(...parsedMeasures);
    views.push({
      name,
      description: compact(String(table.description || '')),
      sourceArtifact: artifact.name,
      fields: columns.map((columnValue) => {
        const column = asRecord(columnValue);
        return {
          name: compact(String(column.name || column.displayName || '')),
          type: compact(String(column.dataType || column.type || '')),
          description: compact(String(column.description || '')),
          sourceArtifact: artifact.name,
        };
      }).filter((field) => field.name),
      measures: parsedMeasures,
      warnings: [],
    });
  });

  relationshipsRaw.forEach((relationshipValue) => {
    const relationship = asRecord(relationshipValue);
    const from = compact(String(relationship.fromTable || relationship.from_table || relationship.fromColumn || relationship.from || ''));
    const to = compact(String(relationship.toTable || relationship.to_table || relationship.toColumn || relationship.to || ''));
    if (!from || !to) return;
    relationships.push({
      from,
      to,
      relationshipType: compact(String(relationship.cardinality || relationship.crossFilteringBehavior || '')),
      sourceArtifact: artifact.name,
    });
  });

  const reportName = compact(String(asRecord(json).name || asRecord(json).displayName || ''));
  const visualFields = unique(Array.from(JSON.stringify(json).matchAll(/"queryRef"\s*:\s*"([^"]+)"/g)).map((match) => match[1]), 80);
  if (reportName || visualFields.length > 0 || /visual(Container|s)|sections/i.test(JSON.stringify(json))) {
    dashboards.push({
      name: reportName || artifact.name.replace(/\.[^.]+$/, ''),
      fields: visualFields,
      filters: unique(Array.from(JSON.stringify(json).matchAll(/"filter"\s*:\s*"([^"]+)"/g)).map((match) => match[1]), 40),
      sourceArtifact: artifact.name,
    });
  }

  if (views.length === 0 && metrics.length === 0 && dashboards.length === 0) {
    warnings.push(`${artifact.name} is JSON, but OmniKit could not detect Power BI tables, measures, relationships, or report field usage.`);
  }
  warnings.push('Power BI DAX measures are captured as semantic evidence; review measure definitions before converting them to Omni measures.');
  return { views, explores: [] as MigrationExplore[], relationships, dashboards, metrics, warnings };
}

function parsePowerBiTextArtifact(artifact: MigrationArtifact) {
  const warnings: string[] = [];
  const views: MigrationView[] = [];
  const metrics: MigrationMeasure[] = [];
  const tableBlocks = extractIndentedBlocks(artifact.content, 'table');

  tableBlocks.forEach(({ name, block }) => {
    const fields = Array.from(block.matchAll(/\bcolumn\s+["']?([^"'\n=]+)["']?/gi)).map((match) => ({
      name: compact(match[1]),
      sourceArtifact: artifact.name,
    })).filter((field) => field.name);
    const measures = Array.from(block.matchAll(/\bmeasure\s+["']?([^"'\n=]+)["']?\s*=?\s*([^\n]*)/gi)).map((match) => ({
      name: compact(match[1]),
      sql: compact(match[2]),
      aggregateType: 'DAX',
      sourceArtifact: artifact.name,
    })).filter((measure) => measure.name);
    metrics.push(...measures);
    views.push({
      name,
      sourceArtifact: artifact.name,
      fields,
      measures,
      warnings: [],
    });
  });

  if (views.length === 0 && metrics.length === 0) {
    warnings.push(`${artifact.name} did not expose Power BI TMDL table or measure definitions through the lightweight parser.`);
  }
  return { views, explores: [] as MigrationExplore[], relationships: [] as MigrationRelationship[], dashboards: [] as MigrationDashboardEvidence[], metrics, warnings };
}

function parseTableauArtifact(artifact: MigrationArtifact) {
  const content = artifact.content;
  const warnings: string[] = [];
  const fields: MigrationField[] = [];
  const measures: MigrationMeasure[] = [];
  const dashboards: MigrationDashboardEvidence[] = [];
  const relationships: MigrationRelationship[] = [];
  const datasourceNames = unique(Array.from(content.matchAll(/<datasource\b[^>]*(?:caption|name)=["']([^"']+)["']/gi)).map((match) => match[1]), 30);

  Array.from(content.matchAll(/<column\b([^>]*?)\/>|<column\b([^>]*)>([\s\S]*?)<\/column>/gi)).forEach((match) => {
    const attrs = parseXmlAttributes(match[1] || match[2] || '');
    const body = match[3] || '';
    const rawName = cleanTableauName(attrs.caption || attrs.name || '');
    if (!rawName) return;
    const role = (attrs.role || '').toLowerCase();
    const calculation = body.match(/<calculation\b[^>]*formula=["']([^"']+)["']/i)?.[1];
    if (role === 'measure' || calculation) {
      measures.push({
        name: rawName,
        type: attrs.datatype || attrs.type,
        sql: calculation,
        aggregateType: attrs['default-aggregation'],
        sourceArtifact: artifact.name,
      });
    } else {
      fields.push({
        name: rawName,
        type: attrs.datatype || attrs.type,
        sourceArtifact: artifact.name,
      });
    }
  });

  Array.from(content.matchAll(/<relation\b([^>]*)\btype=["']join["']([^>]*)>([\s\S]*?)<\/relation>/gi)).forEach((match) => {
    const attrs = parseXmlAttributes(`${match[1]} ${match[2]}`);
    const nested = Array.from(match[3].matchAll(/<relation\b([^>]*)\/?\s*>/gi))
      .map((relationMatch) => parseXmlAttributes(relationMatch[1]))
      .map((relationAttrs) => cleanTableauName(relationAttrs.name || relationAttrs.table || ''))
      .filter(Boolean);
    if (nested.length >= 2) {
      relationships.push({
        from: nested[0],
        to: nested[1],
        joinType: attrs.join,
        sql: compact(match[3].match(/<clause\b[^>]*>([\s\S]*?)<\/clause>/i)?.[1] || ''),
        sourceArtifact: artifact.name,
      });
    }
  });

  Array.from(content.matchAll(/<dashboard\b[^>]*name=["']([^"']+)["'][\s\S]*?<\/dashboard>/gi)).forEach((match) => {
    dashboards.push({
      name: cleanTableauName(match[1]),
      fields: unique(Array.from(match[0].matchAll(/(?:column|field)=["']([^"']+)["']/gi)).map((fieldMatch) => cleanTableauName(fieldMatch[1])), 80),
      filters: unique(Array.from(match[0].matchAll(/filter[^=]*=["']([^"']+)["']/gi)).map((filterMatch) => cleanTableauName(filterMatch[1])), 40),
      sourceArtifact: artifact.name,
    });
  });

  const views = datasourceNames.length > 0 || fields.length > 0 || measures.length > 0
    ? [{
        name: datasourceNames[0] || artifact.name.replace(/\.[^.]+$/, ''),
        sourceArtifact: artifact.name,
        fields,
        measures,
        warnings: [],
      }]
    : [];

  if (!/<workbook|<datasource|<column/i.test(content)) {
    warnings.push(`${artifact.name} does not look like Tableau TWB/TDS XML. Use unencrypted .twb or .tds text exports for better parsing.`);
  }
  if (views.length === 0 && dashboards.length === 0) {
    warnings.push(`${artifact.name} did not expose Tableau datasource fields or dashboard evidence through the lightweight parser.`);
  }
  warnings.push('Tableau calculated fields are captured as formula evidence; review calculations before converting them to Omni SQL.');
  return { views, explores: [] as MigrationExplore[], relationships, dashboards, metrics: measures, warnings };
}

function parseMetabaseArtifact(artifact: MigrationArtifact) {
  const parsed = tryParseJson(artifact.content);
  if (!parsed) {
    return emptyParseResult(`${artifact.name} does not contain a Metabase API snapshot JSON document.`);
  }
  const root = asRecord(parsed);
  const tables = findFirstArray(root, ['tables']);
  const metricRecords = findFirstArray(root, ['metrics']);
  const cards = findFirstArray(root, ['cards', 'questions']);
  const dashboardRecords = findFirstArray(root, ['dashboards']);
  const metricsByTable = new Map<string, MigrationMeasure[]>();
  const metrics: MigrationMeasure[] = [];

  metricRecords.forEach((value) => {
    const metric = asRecord(value);
    const name = compact(String(metric.name || metric.title || metric.id || ''));
    if (!name) return;
    const definition = asRecord(metric.definition);
    const datasetQuery = asRecord(metric.dataset_query || metric.datasetQuery);
    const query = asRecord(datasetQuery.query);
    const measure = {
      name,
      sql: compact(JSON.stringify(definition.aggregation || query.aggregation || metric.expression || '')),
      aggregateType: 'Metabase metric',
      sourceArtifact: artifact.name,
    } satisfies MigrationMeasure;
    metrics.push(measure);
    const tableId = String(metric.table_id || query['source-table'] || '');
    if (tableId) metricsByTable.set(tableId, [...(metricsByTable.get(tableId) || []), measure]);
  });

  const views = tables.map((value, index) => {
    const table = asRecord(value);
    const fields = findFirstArray(table, ['fields', 'columns']).map((fieldValue) => {
      const field = asRecord(fieldValue);
      return {
        name: compact(String(field.name || field.display_name || field.id || '')),
        type: compact(String(field.base_type || field.effective_type || field.type || '')),
        description: compact(String(field.description || '')),
        sourceArtifact: artifact.name,
      } satisfies MigrationField;
    }).filter((field) => field.name);
    return {
      name: compact(String(table.name || table.display_name || table.id || `metabase_table_${index + 1}`)),
      description: compact(String(table.description || '')),
      sourceArtifact: artifact.name,
      fields,
      measures: metricsByTable.get(String(table.id || '')) || [],
      warnings: [],
    } satisfies MigrationView;
  });

  const fieldIndex = new Map<string, { tableId: string; name: string }>();
  tables.forEach((value) => {
    const table = asRecord(value);
    findFirstArray(table, ['fields', 'columns']).forEach((fieldValue) => {
      const field = asRecord(fieldValue);
      if (field.id != null) fieldIndex.set(String(field.id), { tableId: String(table.id || ''), name: compact(String(field.name || field.id)) });
    });
  });
  const tableNames = new Map(tables.map((value) => {
    const table = asRecord(value);
    return [String(table.id || ''), compact(String(table.name || table.display_name || table.id || ''))] as const;
  }));
  const relationships: MigrationRelationship[] = [];
  tables.forEach((value) => {
    const table = asRecord(value);
    findFirstArray(table, ['fields', 'columns']).forEach((fieldValue) => {
      const field = asRecord(fieldValue);
      const target = fieldIndex.get(String(field.fk_target_field_id || field.fkTargetFieldId || ''));
      if (!target) return;
      relationships.push({
        from: tableNames.get(String(table.id || '')) || String(table.id || ''),
        to: tableNames.get(target.tableId) || target.tableId,
        joinType: 'many_to_one',
        sql: `${compact(String(field.name || field.id || ''))} = ${target.name}`,
        sourceArtifact: artifact.name,
      });
    });
  });

  const cardsById = new Map(cards.map((value) => {
    const card = asRecord(value);
    return [String(card.id || ''), card] as const;
  }));
  const dashboards = dashboardRecords.map((value, index) => {
    const dashboard = asRecord(value);
    const dashcards = findFirstArray(dashboard, ['dashcards', 'cards']);
    const linkedCards = dashcards.map((dashcardValue) => {
      const dashcard = asRecord(dashcardValue);
      return asRecord(dashcard.card || cardsById.get(String(dashcard.card_id || dashcard.cardId || '')));
    });
    const serialized = JSON.stringify(linkedCards);
    return {
      name: compact(String(dashboard.name || dashboard.title || dashboard.id || `metabase_dashboard_${index + 1}`)),
      fields: unique(Array.from(serialized.matchAll(/"(?:name|display_name|field)"\s*:\s*"([^"]+)"/gi)).map((match) => match[1]), 80),
      filters: unique(findFirstArray(dashboard, ['parameters', 'filters']).map((filterValue) => {
        const filter = asRecord(filterValue);
        return compact(String(filter.name || filter.slug || filter.id || ''));
      }).filter(Boolean), 40),
      sourceArtifact: artifact.name,
    } satisfies MigrationDashboardEvidence;
  });
  const warnings = views.length === 0 && dashboards.length === 0
    ? [`${artifact.name} is JSON, but no Metabase tables or dashboards were detected.`]
    : ['Metabase MBQL and visualization settings remain source evidence; OmniKit’s first-party engine performs the authoritative deterministic translation.'];
  return { views, explores: [] as MigrationExplore[], relationships, dashboards, metrics, warnings };
}

function parseDomoArtifact(artifact: MigrationArtifact) {
  const parsedJson = tryParseJson(artifact.content);
  if (parsedJson) return parseDomoJsonArtifact(artifact, parsedJson);
  return parseDomoTextArtifact(artifact);
}

function parseDomoJsonArtifact(artifact: MigrationArtifact, json: unknown) {
  const warnings: string[] = [];
  const views: MigrationView[] = [];
  const dashboards: MigrationDashboardEvidence[] = [];
  const metrics: MigrationMeasure[] = [];
  const root = asRecord(json);
  const datasets = findFirstArray(root, ['datasets', 'dataSets', 'schemas']) || (root.columns ? [root] : []);
  datasets.forEach((datasetValue) => {
    const dataset = asRecord(datasetValue);
    const name = compact(String(dataset.name || dataset.title || dataset.id || artifact.name.replace(/\.[^.]+$/, '')));
    const columns = findFirstArray(dataset, ['columns', 'fields', 'schema']) || [];
    views.push({
      name,
      description: compact(String(dataset.description || '')),
      sourceArtifact: artifact.name,
      fields: columns.map((columnValue) => {
        const column = asRecord(columnValue);
        return {
          name: compact(String(column.name || column.columnName || column.field || '')),
          type: compact(String(column.type || column.dataType || '')),
          sourceArtifact: artifact.name,
        };
      }).filter((field) => field.name),
      measures: [],
      warnings: [],
    });
  });

  const beastModes = findFirstArray(root, ['beastModes', 'calculatedFields', 'calculations']) || [];
  beastModes.forEach((measureValue) => {
    const measure = asRecord(measureValue);
    metrics.push({
      name: compact(String(measure.name || measure.title || '')),
      sql: compact(String(measure.formula || measure.expression || '')),
      aggregateType: 'Beast Mode',
      sourceArtifact: artifact.name,
    });
  });

  const cards = findFirstArray(root, ['cards', 'dashboards', 'pages']) || [];
  cards.forEach((cardValue) => {
    const card = asRecord(cardValue);
    dashboards.push({
      name: compact(String(card.name || card.title || card.id || artifact.name.replace(/\.[^.]+$/, ''))),
      fields: unique(JSON.stringify(card).match(/"name"\s*:\s*"([^"]+)"/g)?.map((value) => value.replace(/^"name"\s*:\s*"|"$/g, '')) || [], 80),
      filters: unique(JSON.stringify(card).match(/"filter[^"]*"\s*:\s*"([^"]+)"/g)?.map((value) => value.replace(/^"filter[^"]*"\s*:\s*"|"$/g, '')) || [], 40),
      sourceArtifact: artifact.name,
    });
  });

  if (views.length === 0 && dashboards.length === 0 && metrics.length === 0) {
    warnings.push(`${artifact.name} is JSON, but OmniKit could not detect Domo datasets, cards, dashboards, or Beast Mode calculations.`);
  }
  warnings.push('Domo Beast Mode formulas and card metadata are semantic evidence; validate calculations and dataset grain before generating Omni YAML.');
  return { views, explores: [] as MigrationExplore[], relationships: [] as MigrationRelationship[], dashboards, metrics, warnings };
}

function parseDomoTextArtifact(artifact: MigrationArtifact) {
  const warnings: string[] = [];
  const metrics = Array.from(artifact.content.matchAll(/(?:beast\s*mode|calculated\s*field)\s*:?\s*([^\n=]+)\s*=?\s*([^\n]+)/gi)).map((match) => ({
    name: compact(match[1]),
    sql: compact(match[2]),
    aggregateType: 'Beast Mode',
    sourceArtifact: artifact.name,
  })).filter((measure) => measure.name);
  if (metrics.length === 0) warnings.push(`${artifact.name} did not expose Domo dataset schema, card metadata, or Beast Mode calculations through the lightweight parser.`);
  return {
    views: [] as MigrationView[],
    explores: [] as MigrationExplore[],
    relationships: [] as MigrationRelationship[],
    dashboards: [] as MigrationDashboardEvidence[],
    metrics,
    warnings,
  };
}

function parseSigmaArtifact(artifact: MigrationArtifact) {
  const parsed = tryParseJson(artifact.content);
  if (!parsed) {
    return emptyParseResult(`${artifact.name} does not contain Sigma JSON. Export workbook, page, element, and dataset metadata through the Sigma REST API.`);
  }
  const root = asRecord(parsed);
  const datasets = findFirstArray(root, ['datasets', 'tables', 'dataSources', 'sources']);
  const elements = findFirstArray(root, ['elements', 'workbookElements', 'charts', 'visualizations']);
  const pages = findFirstArray(root, ['pages', 'workbookPages', 'dashboards']);
  const relationshipRecords = findFirstArray(root, ['relationships', 'joins']);
  const views: MigrationView[] = datasets.map((value, index) => {
    const dataset = asRecord(value);
    const fields = findFirstArray(dataset, ['columns', 'fields', 'dimensions']);
    const calculations = findFirstArray(dataset, ['calculations', 'metrics', 'measures']);
    const name = compact(String(dataset.name || dataset.title || dataset.id || `sigma_dataset_${index + 1}`));
    return {
      name,
      description: compact(String(dataset.description || '')),
      sourceArtifact: artifact.name,
      fields: fields.map((fieldValue) => {
        const field = asRecord(fieldValue);
        return {
          name: compact(String(field.name || field.label || field.id || '')),
          type: compact(String(field.type || field.dataType || '')),
          sql: compact(String(field.formula || field.expression || '')),
          sourceArtifact: artifact.name,
        };
      }).filter((field) => field.name),
      measures: calculations.map((measureValue) => {
        const measure = asRecord(measureValue);
        return {
          name: compact(String(measure.name || measure.label || measure.id || '')),
          sql: compact(String(measure.formula || measure.expression || '')),
          aggregateType: compact(String(measure.aggregate || measure.aggregation || 'Sigma formula')),
          sourceArtifact: artifact.name,
        };
      }).filter((measure) => measure.name),
      warnings: [],
    };
  });
  const dashboards: MigrationDashboardEvidence[] = [...pages, ...elements].map((value, index) => {
    const item = asRecord(value);
    return {
      name: compact(String(item.name || item.title || item.id || `sigma_item_${index + 1}`)),
      fields: unique(JSON.stringify(item).match(/"(?:column|field|metric)(?:Id|Name)?"\s*:\s*"([^"]+)"/gi)?.map((match) => match.replace(/^.*:\s*"|"$/g, '')) || []),
      filters: unique(JSON.stringify(item).match(/"filter[^"]*"\s*:\s*"([^"]+)"/gi)?.map((match) => match.replace(/^.*:\s*"|"$/g, '')) || []),
      sourceArtifact: artifact.name,
    };
  });
  const warnings = views.length === 0 && dashboards.length === 0
    ? [`${artifact.name} is JSON, but no Sigma datasets, pages, or elements were detected.`]
    : ['Sigma formulas are captured as source evidence and require target-grain validation before Omni YAML is compiled.'];
  const relationships = relationshipRecords.map((value) => {
    const relationship = asRecord(value);
    return {
      from: compact(String(relationship.from || relationship.source || relationship.left || '')),
      to: compact(String(relationship.to || relationship.target || relationship.right || '')),
      joinType: compact(String(relationship.joinType || relationship.type || '')),
      sql: compact(String(relationship.sql || relationship.on || relationship.condition || '')),
      sourceArtifact: artifact.name,
    } satisfies MigrationRelationship;
  }).filter((relationship) => relationship.from && relationship.to);
  return { views, explores: [] as MigrationExplore[], relationships, dashboards, metrics: views.flatMap((view) => view.measures), warnings };
}

function parseWebFocusArtifact(artifact: MigrationArtifact) {
  const parsed = tryParseJson(artifact.content);
  const text = parsed ? JSON.stringify(parsed, null, 2) : artifact.content;
  const fieldMatches = Array.from(text.matchAll(/(?:FIELDNAME|FIELD|COLUMN)\s*[=:]\s*['"]?([A-Za-z0-9_.$-]+)/gi));
  const defineMatches = Array.from(text.matchAll(/(?:DEFINE|COMPUTE|MEASURE)\s+([A-Za-z0-9_.$-]+)\s*(?:\/[A-Za-z0-9]+)?\s*=\s*([^;\n]+)/gi));
  const relationMatches = Array.from(text.matchAll(/\bJOIN\s+[A-Za-z0-9_.$-]+\s+IN\s+([A-Za-z0-9_.$-]+)\s+TO(?:\s+(?:ALL|MULTIPLE|UNIQUE))?\s+[A-Za-z0-9_.$-]+\s+IN\s+([A-Za-z0-9_.$-]+)/gi));
  const sourceName = text.match(/\b(?:FILENAME\s*=|TABLE\s+FILE|GRAPH\s+FILE)\s*['"]?([A-Za-z0-9_.$-]+)/i)?.[1];
  const baseName = (sourceName || artifact.name.replace(/\.[^.]+$/, '')).replace(/[^A-Za-z0-9_]+/g, '_');
  const measures: MigrationMeasure[] = defineMatches.map((match) => ({
    name: compact(match[1]),
    sql: compact(match[2]),
    aggregateType: 'WebFOCUS DEFINE/COMPUTE',
    sourceArtifact: artifact.name,
  }));
  const fields: MigrationField[] = fieldMatches.map((match) => ({ name: compact(match[1]), sourceArtifact: artifact.name }));
  const views: MigrationView[] = fields.length > 0 || measures.length > 0 ? [{
    name: baseName,
    sourceArtifact: artifact.name,
    fields,
    measures,
    warnings: [],
  }] : [];
  const relationships: MigrationRelationship[] = relationMatches.map((match) => ({
    from: compact(match[1]),
    to: compact(match[2]),
    joinType: 'WebFOCUS JOIN',
    sourceArtifact: artifact.name,
  }));
  const dashboardName = text.match(/^\s*-\*\s*DASHBOARD\s*:\s*([^\n]+)/im)?.[1]?.trim();
  const procedureFields = unique(Array.from(text.matchAll(/^\s*(?:SUM|PRINT|BY|ACROSS)\s+([A-Za-z0-9_.$-]+)/gim)).map((match) => match[1]), 80);
  const procedureFilters = unique(Array.from(text.matchAll(/^\s*WHERE\s+([A-Za-z0-9_.$-]+)/gim)).map((match) => match[1]), 40);
  const isProcedure = artifact.kind === 'dashboard' || /\.fex$/i.test(artifact.name);
  const hasProcedureBody = /\b(?:TABLE|GRAPH)\s+FILE\b|^\s*(?:SUM|PRINT|BY|ACROSS|WHERE)\s+/im.test(text);
  const dashboards = dashboardName || (isProcedure && hasProcedureBody) ? [{
    name: dashboardName || artifact.name.replace(/\.fex$/i, '').replace(/[^A-Za-z0-9_]+/g, ' '),
    fields: procedureFields,
    filters: procedureFilters,
    sourceArtifact: artifact.name,
  } satisfies MigrationDashboardEvidence] : [];
  const warnings = views.length === 0 && dashboards.length === 0
    ? [`${artifact.name} did not expose WebFOCUS metadata or a report procedure.`]
    : views.length === 0
      ? [`${artifact.name} contains report procedure evidence but no FIELDNAME, DEFINE, COMPUTE, or JOIN metadata. Add the relevant .mas or .acx exports when available.`]
    : ['WebFOCUS procedures and repository definitions are evidence; OmniKit will require review before translating proprietary expressions.'];
  return { views, explores: [] as MigrationExplore[], relationships, dashboards, metrics: measures, warnings };
}

function parseMicroStrategyArtifact(artifact: MigrationArtifact) {
  const parsed = tryParseJson(artifact.content);
  if (!parsed) return emptyParseResult(`${artifact.name} does not contain MicroStrategy JSON metadata.`);
  const root = asRecord(parsed);
  const reports = findAllArrays(root, ['reports', 'documents', 'dossiers', 'dashboards', 'objects']);
  const cubes = findFirstArray(root, ['cubes', 'datasets']);
  const metrics = findFirstArray(root, ['metrics', 'measures']).map((value) => {
    const metric = asRecord(value);
    return {
      name: compact(String(metric.name || metric.title || metric.id || '')),
      sql: compact(String(metric.formula || metric.expression || metric.definition || '')),
      aggregateType: 'MicroStrategy metric',
      description: compact(String(metric.description || '')),
      sourceArtifact: artifact.name,
    } satisfies MigrationMeasure;
  }).filter((metric) => metric.name);
  const attributes = findFirstArray(root, ['attributes', 'forms', 'fields']).map((value) => {
    const attribute = asRecord(value);
    return {
      name: compact(String(attribute.name || attribute.title || attribute.id || '')),
      type: compact(String(attribute.type || attribute.dataType || 'attribute')),
      description: compact(String(attribute.description || '')),
      sourceArtifact: artifact.name,
    } satisfies MigrationField;
  }).filter((field) => field.name);
  const views: MigrationView[] = cubes.map((value, index) => {
    const cube = asRecord(value);
    return {
      name: compact(String(cube.name || cube.title || cube.id || `microstrategy_cube_${index + 1}`)),
      description: compact(String(cube.description || '')),
      sourceArtifact: artifact.name,
      fields: attributes,
      measures: metrics,
      warnings: [],
    };
  });
  const dashboards: MigrationDashboardEvidence[] = reports.map((value, index) => {
    const report = asRecord(value);
    return {
      name: compact(String(report.name || report.title || report.id || `microstrategy_content_${index + 1}`)),
      fields: unique(JSON.stringify(report).match(/"(?:attribute|metric|field)(?:Id|Name)?"\s*:\s*"([^"]+)"/gi)?.map((match) => match.replace(/^.*:\s*"|"$/g, '')) || []),
      filters: unique(JSON.stringify(report).match(/"(?:filter|prompt)[^"]*"\s*:\s*"([^"]+)"/gi)?.map((match) => match.replace(/^.*:\s*"|"$/g, '')) || []),
      sourceArtifact: artifact.name,
    };
  });
  const warnings = views.length === 0 && dashboards.length === 0 && metrics.length === 0 && attributes.length === 0
    ? [`${artifact.name} did not expose MicroStrategy reports, dashboards/documents, cubes, metrics, or attributes.`]
    : ['MicroStrategy prompts, security filters, derived elements, and dossier interactions require explicit migration decisions.'];
  return { views, explores: [] as MigrationExplore[], relationships: [] as MigrationRelationship[], dashboards, metrics, warnings };
}

function tryParseJson(content: string) {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return null;
  }
}

function findFirstRecord(value: unknown, keys: string[]): Record<string, unknown> | null {
  const queue: unknown[] = [value];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== 'object') continue;
    const record = current as Record<string, unknown>;
    for (const key of keys) {
      if (record[key] && typeof record[key] === 'object' && !Array.isArray(record[key])) return record[key] as Record<string, unknown>;
    }
    Object.values(record).forEach((item) => {
      if (item && typeof item === 'object') queue.push(item);
    });
  }
  return null;
}

function findFirstArray(value: unknown, keys: string[]): unknown[] {
  const queue: unknown[] = [value];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== 'object') continue;
    const record = current as Record<string, unknown>;
    for (const key of keys) {
      if (Array.isArray(record[key])) return record[key] as unknown[];
    }
    Object.values(record).forEach((item) => {
      if (item && typeof item === 'object') queue.push(item);
    });
  }
  return [];
}

function findAllArrays(value: unknown, keys: string[]): unknown[] {
  const queue: unknown[] = [value];
  const results: unknown[] = [];
  const seen = new Set<unknown>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const record = current as Record<string, unknown>;
    keys.forEach((key) => {
      if (Array.isArray(record[key])) results.push(...record[key] as unknown[]);
    });
    Object.values(record).forEach((item) => {
      if (item && typeof item === 'object') queue.push(item);
    });
  }
  return results;
}

function extractIndentedBlocks(content: string, keyword: string) {
  const lines = content.split(/\r?\n/);
  const blocks: Array<{ name: string; block: string }> = [];
  lines.forEach((line, index) => {
    const match = line.trim().match(new RegExp(`^${keyword}\\s+['"]?([^'"]+)['"]?`, 'i'));
    if (!match) return;
    const indent = line.match(/^\s*/)?.[0].length || 0;
    const blockLines: string[] = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const currentIndent = lines[cursor].match(/^\s*/)?.[0].length || 0;
      if (lines[cursor].trim() && currentIndent <= indent) break;
      blockLines.push(lines[cursor]);
    }
    blocks.push({ name: compact(match[1]), block: blockLines.join('\n') });
  });
  return blocks;
}

function parseXmlAttributes(value: string) {
  const attrs: Record<string, string> = {};
  Array.from(value.matchAll(/([A-Za-z0-9_-]+)=["']([^"']*)["']/g)).forEach((match) => {
    attrs[match[1]] = match[2];
  });
  return attrs;
}

function cleanTableauName(value: string) {
  return compact(value)
    .replace(/^\[|\]$/g, '')
    .replace(/^Calculation_/, '')
    .replace(/\s+/g, ' ');
}

function matchLookmlParam(block: string, param: string) {
  const match = block.match(new RegExp(
    `\\b${param}\\s*:\\s*(?:"([^"]*)"|'([^']*)'|([\\s\\S]*?))(?=\\s+[A-Za-z_][\\w.]*\\s*:|$)`,
    'i',
  ));
  return compact((match?.[1] || match?.[2] || match?.[3] || '').replace(/;;\s*$/, ''));
}

function extractNamedBlocks(content: string, keyword: string) {
  const blocks: Array<{ name: string; block: string }> = [];
  const regex = new RegExp(`\\b${keyword}\\s*:\\s*([\\w.]+)\\s*\\{`, 'g');
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content))) {
    const name = match[1];
    const blockStart = match.index + match[0].length;
    const blockEnd = findMatchingBrace(content, blockStart - 1);
    if (blockEnd > blockStart) {
      blocks.push({ name, block: content.slice(blockStart, blockEnd) });
      regex.lastIndex = blockEnd;
    }
  }
  return blocks;
}

function findMatchingBrace(content: string, openBraceIndex: number) {
  let depth = 0;
  for (let index = openBraceIndex; index < content.length; index += 1) {
    const char = content[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function splitInlineList(value: string) {
  return value
    .split(',')
    .map((item) => item.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

function mergeViews(views: MigrationView[]) {
  const map = new Map<string, MigrationView>();
  views.forEach((view) => {
    const existing = map.get(view.name);
    if (!existing) {
      map.set(view.name, {
        ...view,
        fields: mergeFields(view.fields),
        measures: mergeMeasures(view.measures),
        warnings: unique(view.warnings),
      });
      return;
    }
    existing.description ||= view.description;
    existing.fields = mergeFields([...existing.fields, ...view.fields]);
    existing.measures = mergeMeasures([...existing.measures, ...view.measures]);
    existing.warnings = unique([...existing.warnings, ...view.warnings]);
  });
  return Array.from(map.values());
}

function mergeFields(fields: MigrationField[]) {
  const map = new Map<string, MigrationField>();
  fields.forEach((field) => {
    if (!field.name) return;
    const existing = map.get(field.name);
    if (!existing) {
      map.set(field.name, field);
      return;
    }
    existing.type ||= field.type;
    existing.sql ||= field.sql;
    existing.description ||= field.description;
  });
  return Array.from(map.values()).slice(0, 100);
}

function mergeMeasures(measures: MigrationMeasure[]) {
  const map = new Map<string, MigrationMeasure>();
  measures.forEach((measure) => {
    if (!measure.name) return;
    const existing = map.get(measure.name);
    if (!existing) {
      map.set(measure.name, measure);
      return;
    }
    existing.type ||= measure.type;
    existing.sql ||= measure.sql;
    existing.description ||= measure.description;
    existing.aggregateType ||= measure.aggregateType;
  });
  return Array.from(map.values()).slice(0, 120);
}

function mergeRelationships(relationships: MigrationRelationship[]) {
  const seen = new Set<string>();
  return relationships.filter((relationship) => {
    const key = `${relationship.from}|${relationship.to}|${relationship.sql || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 120);
}

function mergeExplores(explores: MigrationExplore[]) {
  const map = new Map<string, MigrationExplore>();
  explores.forEach((explore) => {
    const existing = map.get(explore.name);
    if (!existing) {
      map.set(explore.name, {
        ...explore,
        joins: mergeRelationships(explore.joins),
        fields: unique(explore.fields),
        filters: unique(explore.filters),
      });
      return;
    }
    existing.joins = mergeRelationships([...existing.joins, ...explore.joins]);
    existing.fields = unique([...existing.fields, ...explore.fields]);
    existing.filters = unique([...existing.filters, ...explore.filters]);
  });
  return Array.from(map.values());
}

function mergeDashboards(dashboards: MigrationDashboardEvidence[]) {
  const map = new Map<string, MigrationDashboardEvidence>();
  dashboards.forEach((dashboard) => {
    const existing = map.get(dashboard.name);
    if (!existing) {
      map.set(dashboard.name, {
        ...dashboard,
        fields: unique(dashboard.fields),
        filters: unique(dashboard.filters),
      });
      return;
    }
    existing.fields = unique([...existing.fields, ...dashboard.fields]);
    existing.filters = unique([...existing.filters, ...dashboard.filters]);
  });
  return Array.from(map.values());
}

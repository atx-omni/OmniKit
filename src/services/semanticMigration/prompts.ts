import type { MigrationInventory } from './types';
import { SEMANTIC_MIGRATION_PROMPT_VERSION } from './protocol';
import { domoDevelopmentPromptGuidance } from './domoDevelopmentContext';
import {
  SEMANTIC_MIGRATION_PLAN_CONTRACT,
  assertSemanticMigrationStageIsolation,
} from './contracts';

export {
  buildSemanticMigrationCompilePrompt,
  buildSemanticMigrationRepairPrompt,
} from './compilePipeline';

const MAX_ARTIFACT_SNIPPET_CHARS = 12_000;
const MAX_TOTAL_SNIPPET_CHARS = 36_000;

const PROMPT_CONTRACT_ID_KEY = /(?:^id$|id$|ids$|evidenceids?$)/i;
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const IDENTITY_COLLECTION_KEY = /^(users?|members?|principals?|identities|assignments?|admins?|owners?)$/i;
const IDENTITY_VALUE_KEY = /^(email|emailAddress|mail|upn|userPrincipalName|principalId|principalName|userId|userName|objectId|ownerId|ownerName|displayName)$/i;
const PROVIDER_SECRET_VALUE_KEY = /^(?:api[_-]?keys?|authorization|access[_-]?tokens?|refresh[_-]?tokens?|tokens?|secrets?|client[_-]?secrets?|password|pwd|credentials?|connection[_-]?strings?|private[_-]?keys?|account[_-]?keys?|sas[_-]?tokens?|signatures?)$/i;
const PROVIDER_SECURITY_PREDICATE_KEY = /^(?:table[_-]?permissions?|filter[_-]?expressions?|security[_-]?predicates?|row[_-]?(?:level[_-]?)?security|object[_-]?(?:level[_-]?)?security|rls[_-]?predicates?|ols[_-]?predicates?|access[_-]?filters?|security[_-]?filters?)$/i;
const PROVIDER_POWER_BI_M_KEY = /^(?:m[_-]?expressions?|power[_-]?queries?|power[_-]?query[_-]?expressions?|partition[_-]?expressions?)$/i;
const PROVIDER_SECURITY_SEMANTIC_KIND = /^(?:permission|row_level_security|object_level_security|access_policy)$/i;
const SECRET_URL_PATTERN = /https?:\/\/[^\s<>"']+[?&](?:access_token|api[_-]?key|apikey|token|key|sig|signature|client_secret|password|pwd|x-amz-credential|x-amz-signature|x-amz-security-token)=[^\s&#<>"']+/i;
const URL_USERINFO_PATTERN = /https?:\/\/[^\s/@:]+:[^\s/@]+@/i;
const CONNECTION_STRING_PATTERN = /(?:\b(?:connection\s*string|connectionString)\b\s*[:=]\s*(?!\[redacted)|\b(?:server|data\s+source|initial\s+catalog|database|host|warehouse|account)\s*=\s*[^;\r\n]+;\s*(?:database|initial\s+catalog|user\s+id|uid|password|pwd|authentication|warehouse|role)\s*=)/i;
const CONNECTION_SECRET_PATTERN = /\b(?:user\s*id|uid|password|pwd|private\s*key|client\s*secret|access\s*token|refresh\s*token)\s*=\s*(?!\[redacted)(?:"[^"]+"|'[^']+'|[^;\s]+)/i;
const RAW_SECURITY_PREDICATE_PATTERN = /(?:\btable[_-]?permissions?\b\s+[^=\n]+\s*=|"(?:table[_-]?permissions?|filter[_-]?expressions?|security[_-]?predicates?|row[_-]?(?:level[_-]?)?security|object[_-]?(?:level[_-]?)?security|rls[_-]?predicates?|ols[_-]?predicates?|access[_-]?filters?|security[_-]?filters?)"\s*:\s*"(?!\[(?:redacted|security predicate omitted))|\b(?:access_filters?|sql_always_where|row_access_policy)\s*[:=]|\b(?:USERPRINCIPALNAME|USERNAME|CUSTOMDATA)\s*\(|\b(?:security|RLS|OLS|row-level|object-level|table permission)[\s\S]{0,1_000}\[[^\]\r\n]+\]\s*(?:=|<>|\bIN\b))/i;
const RAW_SECURITY_DECISION_PATTERN = /"semanticKind"\s*:\s*"(?:permission|row_level_security|object_level_security|access_policy)"[\s\S]{0,4000}"approvedDefinition"\s*:\s*"(?!\[(?:redacted|security predicate omitted))/i;
const RAW_POWER_BI_M_PATTERNS = [
  /\b(?:Sql|Snowflake|OData|Web|Excel|Csv|Json|SharePoint|Databricks|Table)\.(?:Database|Databases|Feed|Contents|Workbook|Document|Files|Catalogs|TransformColumns|SelectRows|AddColumn|NestedJoin)\s*\(/i,
  /\blet\s+(?:#"[^"]+"|[A-Za-z_][\w ]*)\s*=\s*[\s\S]{0,4000}\bin\s+(?:#"[^"]+"|[A-Za-z_][\w ]*)/i,
  /\bsection\s+[A-Za-z_][\w]*\s*;[\s\S]{0,4000}\bshared\s+[A-Za-z_][\w]*\s*=/i,
];
const UNREDACTED_CREDENTIAL_PATTERN = /\b(?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|token|secret|client[_-]?secret|password|pwd|credential|private[_-]?key|account[_-]?key|sas[_-]?token|signature)\b\s*[:=]\s*(?!\[redacted)(?:"[^"]+"|'[^']+'|[^\s,;}]+)/i;
const PRIVATE_KEY_PATTERN = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i;
const TOKEN_SHAPE_PATTERN = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/;

export const SEMANTIC_MIGRATION_REDACTION_DISCLOSURE = 'Principal identities, PII-shaped emails and user IDs, secret-shaped values, and bearer tokens are redacted before prompt construction and checked again at the server provider boundary.';
export const DEFAULT_SEMANTIC_MIGRATION_PROMPT_CHAR_LIMIT = 500_000;

export class SemanticMigrationProviderBoundaryError extends Error {
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = 'SemanticMigrationProviderBoundaryError';
  }
}

function providerContentFingerprint(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, '0')}`;
}

function suspectedSecretMaterial(value: string): boolean {
  return SECRET_URL_PATTERN.test(value)
    || URL_USERINFO_PATTERN.test(value)
    || CONNECTION_STRING_PATTERN.test(value)
    || CONNECTION_SECRET_PATTERN.test(value)
    || UNREDACTED_CREDENTIAL_PATTERN.test(value)
    || PRIVATE_KEY_PATTERN.test(value)
    || TOKEN_SHAPE_PATTERN.test(value);
}

function containsPowerBiM(value: string): boolean {
  return RAW_POWER_BI_M_PATTERNS.some((pattern) => pattern.test(value));
}

function containsSecurityPredicate(value: string): boolean {
  return RAW_SECURITY_PREDICATE_PATTERN.test(value) || RAW_SECURITY_DECISION_PATTERN.test(value);
}

function summarizedProviderEvidence(kind: string, value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : JSON.stringify(value);
  if (!text) return `[${kind} omitted: empty evidence]`;
  if (suspectedSecretMaterial(text)) {
    throw new SemanticMigrationProviderBoundaryError(`${kind} contains secret-shaped material. OmniKit blocked the provider request; remove credentials from the source evidence and retry.`);
  }
  return `[${kind} omitted from provider payload; ${text.length} characters; content fingerprint ${providerContentFingerprint(text)}]`;
}

function assertNoUnsafeProviderContent(value: string): void {
  const reason = SECRET_URL_PATTERN.test(value)
    ? 'a URL containing a secret-shaped query parameter'
    : URL_USERINFO_PATTERN.test(value)
      ? 'a URL containing embedded credentials'
      : CONNECTION_STRING_PATTERN.test(value) || CONNECTION_SECRET_PATTERN.test(value)
        ? 'a connection string or credential-bearing connection value'
        : containsSecurityPredicate(value)
          ? 'a raw row-level or object-level security predicate'
          : containsPowerBiM(value)
            ? 'a raw Power Query/M expression'
            : UNREDACTED_CREDENTIAL_PATTERN.test(value) || PRIVATE_KEY_PATTERN.test(value) || TOKEN_SHAPE_PATTERN.test(value)
              ? 'unredacted credential-shaped material'
              : '';
  if (reason) {
    throw new SemanticMigrationProviderBoundaryError(`Provider request contains ${reason}. OmniKit blocked egress instead of redacting or guessing at sensitive source logic.`);
  }
}

function providerSafeString(value: string, key: string, preserveContractId = false): string {
  if (suspectedSecretMaterial(value)) {
    throw new SemanticMigrationProviderBoundaryError('Provider-bound evidence contains secret-shaped material. OmniKit blocked the provider request; remove credentials from the source evidence and retry.');
  }
  if (PROVIDER_SECURITY_PREDICATE_KEY.test(key) || containsSecurityPredicate(value)) {
    return summarizedProviderEvidence('security predicate', value);
  }
  if (PROVIDER_POWER_BI_M_KEY.test(key) || containsPowerBiM(value)) {
    return summarizedProviderEvidence('Power Query/M expression', value);
  }
  return preserveContractId ? redactSensitive(value) : redactSemanticMigrationPromptText(value);
}

export interface SemanticMigrationPromptEnvelope {
  systemCharacters: number;
  promptCharacters: number;
  totalCharacters: number;
  maxCharacters: number;
  withinLimit: boolean;
}

export function semanticMigrationPromptEnvelope(
  system: string,
  prompt: string,
  maxCharacters = DEFAULT_SEMANTIC_MIGRATION_PROMPT_CHAR_LIMIT,
): SemanticMigrationPromptEnvelope {
  const systemCharacters = system.length;
  const promptCharacters = prompt.length;
  const totalCharacters = systemCharacters + promptCharacters;
  return { systemCharacters, promptCharacters, totalCharacters, maxCharacters, withinLimit: totalCharacters <= maxCharacters };
}

function redactSensitive(value: string) {
  return value
    .replace(/(api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|token|secret|client[_-]?secret|password|pwd|credential|connection[_-]?string|private[_-]?key|account[_-]?key|sas[_-]?token|signature)(["'\s:=]+)(?:"[^"]*"|'[^']*'|[^"',\s}]+)/gi, '$1$2[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(PRIVATE_KEY_PATTERN, '[redacted private key]')
    .replace(TOKEN_SHAPE_PATTERN, '[redacted credential]');
}

export function redactSemanticMigrationPromptText(value: string): string {
  return redactSensitive(value)
    .replace(EMAIL_PATTERN, '[redacted email]')
    .replace(UUID_PATTERN, '[redacted id]');
}

const PROVIDER_IDENTITY_JSON_VALUE = /("(?:email|emailAddress|mail|upn|userPrincipalName|principalId|principalName|userId|userName|objectId|ownerId|ownerName)"\s*:\s*")[^"]*"/gi;
const PROVIDER_IDENTITY_PROSE_VALUE = /\b((?:principal|user|member|identity|owner)(?:\s+(?:name|id))?\s*[:=]\s*)([0-9a-f]{8}-[0-9a-f-]{27,}|[^\s,;}"]+)(?=$|[\s,;}])/gi;

function scrubProviderBoundaryJson(value: unknown, key = '', depth = 0): unknown {
  if (depth > 20) return '[redacted nested content]';
  if (PROVIDER_SECRET_VALUE_KEY.test(key)) return '[redacted]';
  if (PROVIDER_SECURITY_PREDICATE_KEY.test(key)) return summarizedProviderEvidence('security predicate', value);
  if (PROVIDER_POWER_BI_M_KEY.test(key)) return summarizedProviderEvidence('Power Query/M expression', value);
  if (IDENTITY_COLLECTION_KEY.test(key)) return '[redacted identity records]';
  if (IDENTITY_VALUE_KEY.test(key) && key !== 'displayName') return '[redacted identity]';
  if (Array.isArray(value)) return value.map((item) => scrubProviderBoundaryJson(item, key, depth + 1));
  if (typeof value === 'string') return providerSafeString(value, key, PROMPT_CONTRACT_ID_KEY.test(key));
  if (!value || typeof value !== 'object') return value;
  const entries = Object.entries(value as Record<string, unknown>);
  const identityRecord = entries.some(([childKey]) => IDENTITY_COLLECTION_KEY.test(childKey) || (IDENTITY_VALUE_KEY.test(childKey) && childKey !== 'displayName'));
  const securityDefinitionRecord = entries.some(([childKey, item]) =>
    /^(?:semanticKind|targetKind)$/i.test(childKey)
      && typeof item === 'string'
      && PROVIDER_SECURITY_SEMANTIC_KIND.test(item)
  );
  return Object.fromEntries(entries.map(([childKey, item]) => {
    if (PROVIDER_SECRET_VALUE_KEY.test(childKey)) return [childKey, '[redacted]'];
    if (PROVIDER_SECURITY_PREDICATE_KEY.test(childKey)) return [childKey, summarizedProviderEvidence('security predicate', item)];
    if (securityDefinitionRecord && /^(?:approvedDefinition|definition|expression)$/i.test(childKey)) return [childKey, summarizedProviderEvidence('security predicate', item)];
    if (PROVIDER_POWER_BI_M_KEY.test(childKey)) return [childKey, summarizedProviderEvidence('Power Query/M expression', item)];
    if (IDENTITY_COLLECTION_KEY.test(childKey)) return [childKey, '[redacted identity records]'];
    if (IDENTITY_VALUE_KEY.test(childKey) && (childKey !== 'displayName' || identityRecord)) return [childKey, '[redacted identity]'];
    return [childKey, scrubProviderBoundaryJson(item, childKey, depth + 1)];
  }));
}

function jsonValueEnd(value: string, start: number): number {
  const first = value[start];
  if (first === '"') {
    let escaped = false;
    for (let index = start + 1; index < value.length; index += 1) {
      const char = value[index];
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') return index + 1;
    }
    return value.length;
  }
  if (first === '{' || first === '[') {
    const closing = first === '{' ? '}' : ']';
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < value.length; index += 1) {
      const char = value[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === first) depth += 1;
      else if (char === closing && --depth === 0) return index + 1;
    }
    return value.length;
  }
  const match = /^[^,}\]\s]+/.exec(value.slice(start));
  return start + (match?.[0].length || 0);
}

function redactEmbeddedJsonIdentityValues(value: string): string {
  const identityKey = /"(users?|members?|principals?|identities|assignments?|admins?|owners?|email|emailAddress|mail|upn|userPrincipalName|principalId|principalName|userId|userName|objectId|ownerId|ownerName)"\s*:/gi;
  let result = '';
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = identityKey.exec(value))) {
    const whitespace = value.slice(identityKey.lastIndex).match(/^\s*/)?.[0].length || 0;
    const valueStart = identityKey.lastIndex + whitespace;
    const valueEnd = jsonValueEnd(value, valueStart);
    if (valueEnd <= valueStart) continue;
    result += value.slice(cursor, valueStart);
    result += IDENTITY_COLLECTION_KEY.test(match[1]) ? '"[redacted identity records]"' : '"[redacted identity]"';
    cursor = valueEnd;
    identityKey.lastIndex = valueEnd;
  }
  return result ? result + value.slice(cursor) : value;
}

/** Final provider-boundary defense that preserves migration contract IDs. */
export function sanitizeSemanticMigrationProviderText(value: string): string {
  let sanitized = value;
  try {
    sanitized = JSON.stringify(scrubProviderBoundaryJson(JSON.parse(value) as unknown));
  } catch {
    sanitized = value;
  }
  assertNoUnsafeProviderContent(sanitized);
  const redacted = redactEmbeddedJsonIdentityValues(redactSensitive(sanitized))
    .replace(EMAIL_PATTERN, '[redacted email]')
    .replace(PROVIDER_IDENTITY_JSON_VALUE, '$1[redacted identity]"')
    .replace(PROVIDER_IDENTITY_PROSE_VALUE, '$1[redacted identity]');
  assertNoUnsafeProviderContent(redacted);
  return redacted;
}

function scrubIdentityJson(value: unknown, depth = 0): unknown {
  if (depth > 20) return '[redacted nested content]';
  if (Array.isArray(value)) return value.map((item) => scrubIdentityJson(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => {
    if (IDENTITY_COLLECTION_KEY.test(key)) return [key, '[redacted identity records]'];
    if (IDENTITY_VALUE_KEY.test(key)) return [key, '[redacted identity]'];
    return [key, scrubIdentityJson(item, depth + 1)];
  }));
}

function redactRawSource(value: string): string {
  let sanitized = value;
  try {
    sanitized = JSON.stringify(scrubIdentityJson(JSON.parse(value) as unknown));
  } catch {
    sanitized = value;
  }
  return redactSemanticMigrationPromptText(sanitized)
    .replace(/("(?:email|emailAddress|mail|upn|userPrincipalName|principalId|principalName|userId|objectId|displayName)"\s*:\s*")[^"]*"/gi, '$1[redacted identity]"')
    .replace(EMAIL_PATTERN, '[redacted email]')
    .replace(UUID_PATTERN, '[redacted id]');
}

export function sanitizeSemanticMigrationPromptPayload(value: unknown, key = ''): unknown {
  if (PROVIDER_SECRET_VALUE_KEY.test(key)) return '[redacted]';
  if (PROVIDER_SECURITY_PREDICATE_KEY.test(key)) return summarizedProviderEvidence('security predicate', value);
  if (PROVIDER_POWER_BI_M_KEY.test(key)) return summarizedProviderEvidence('Power Query/M expression', value);
  if (Array.isArray(value)) {
    if (IDENTITY_COLLECTION_KEY.test(key)) return '[redacted identity records]';
    return value.map((item) => sanitizeSemanticMigrationPromptPayload(item, key));
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    const securityDefinitionRecord = entries.some(([childKey, item]) =>
      /^(?:semanticKind|targetKind)$/i.test(childKey)
        && typeof item === 'string'
        && PROVIDER_SECURITY_SEMANTIC_KIND.test(item)
    );
    return Object.fromEntries(entries.map(([childKey, item]) => {
      if (PROVIDER_SECRET_VALUE_KEY.test(childKey)) return [childKey, '[redacted]'];
      if (PROVIDER_SECURITY_PREDICATE_KEY.test(childKey)) return [childKey, summarizedProviderEvidence('security predicate', item)];
      if (securityDefinitionRecord && /^(?:approvedDefinition|definition|expression)$/i.test(childKey)) return [childKey, summarizedProviderEvidence('security predicate', item)];
      if (PROVIDER_POWER_BI_M_KEY.test(childKey)) return [childKey, summarizedProviderEvidence('Power Query/M expression', item)];
      if (IDENTITY_COLLECTION_KEY.test(childKey)) return [childKey, '[redacted identity records]'];
      if (IDENTITY_VALUE_KEY.test(childKey) && childKey !== 'displayName') return [childKey, '[redacted identity]'];
      return [childKey, sanitizeSemanticMigrationPromptPayload(item, childKey)];
    }));
  }
  if (typeof value !== 'string') return value;
  return providerSafeString(value, key, PROMPT_CONTRACT_ID_KEY.test(key));
}

export function stringifySemanticMigrationPromptPayload(value: unknown): string {
  return JSON.stringify(sanitizeSemanticMigrationPromptPayload(value));
}

function listItems(values: string[], fallback = '- None detected') {
  return values.length > 0 ? values.map((value) => `- ${value}`).join('\n') : fallback;
}

function normalizedExpression(value: string | undefined): string {
  if (!value?.trim()) return '';
  return providerSafeString(value.trim(), 'expression');
}

function isPowerBiMView(view: MigrationInventory['views'][number]): boolean {
  return view.kind === 'query_view'
    || Boolean(view.partitions?.length)
    || view.warnings.some((warning) => /Power Query\/M|\bM expression\b/i.test(warning));
}

function inventorySummary(inventory: MigrationInventory) {
  const viewLines = inventory.views.map((view) => {
    const fieldNames = view.fields.map((field) => `${redactSemanticMigrationPromptText(field.name)}${field.type ? ` (${redactSemanticMigrationPromptText(field.type)})` : ''}${field.sql ? ` = ${normalizedExpression(field.sql)}` : ''}`).join(', ');
    const measureNames = view.measures.map((measure) => `${redactSemanticMigrationPromptText(measure.name)}${measure.sql ? ` = ${normalizedExpression(measure.sql)}` : ''}`).join(', ');
    const queryEvidence = inventory.sourceTool === 'power_bi' && view.sql && isPowerBiMView(view)
      ? summarizedProviderEvidence('Power Query/M expression', view.sql)
      : normalizedExpression(view.sql);
    return `${redactSemanticMigrationPromptText(view.name)}${view.description ? ` - ${redactSemanticMigrationPromptText(view.description)}` : ''}${fieldNames ? ` | fields: ${fieldNames}` : ''}${measureNames ? ` | measures: ${measureNames}` : ''}${queryEvidence ? ` | normalized query evidence: ${queryEvidence}` : ''}`;
  });

  const exploreLines = inventory.explores.map((explore) => {
    const joins = explore.joins.map((join) => `${redactSemanticMigrationPromptText(join.from)} -> ${redactSemanticMigrationPromptText(join.to)}${join.sql ? ` on ${normalizedExpression(join.sql)}` : ''}`).join('; ');
    return `${redactSemanticMigrationPromptText(explore.name)}${explore.baseView ? ` | base: ${redactSemanticMigrationPromptText(explore.baseView)}` : ''}${joins ? ` | joins: ${joins}` : ''}`;
  });

  const relationshipLines = inventory.relationships.map((relationship) =>
    `${redactSemanticMigrationPromptText(relationship.from)} -> ${redactSemanticMigrationPromptText(relationship.to)}${relationship.relationshipType ? ` (${redactSemanticMigrationPromptText(relationship.relationshipType)})` : ''}${relationship.sql ? ` | ${normalizedExpression(relationship.sql)}` : ''}`
  );

  const dashboardLines = inventory.dashboards.map((dashboard) => {
    const fields = dashboard.fields.map(redactSemanticMigrationPromptText).join(', ');
    const filters = dashboard.filters.map((filter) => providerSafeString(filter, 'filter')).join(', ');
    const dependencies = (dashboard.dependencyIds || []).map(redactSemanticMigrationPromptText).join(', ');
    const risks = (dashboard.riskFlags || []).map(redactSemanticMigrationPromptText).join('; ');
    return `${redactSemanticMigrationPromptText(dashboard.assetKind || 'dashboard')}: ${redactSemanticMigrationPromptText(dashboard.name)}${dashboard.parentId ? ` | parent: ${redactSemanticMigrationPromptText(dashboard.parentId)}` : ''}${fields ? ` | fields: ${fields}` : ''}${filters ? ` | filters: ${filters}` : ''}${dependencies ? ` | dependencies: ${dependencies}` : ''}${risks ? ` | risks: ${risks}` : ''}`;
  });

  const metricLines = inventory.metrics.map((metric) =>
    `${redactSemanticMigrationPromptText(metric.name)}${metric.aggregateType ? ` (${redactSemanticMigrationPromptText(metric.aggregateType)})` : ''}${metric.sql ? ` = ${normalizedExpression(metric.sql)}` : ''}${metric.description ? ` - ${redactSemanticMigrationPromptText(metric.description)}` : ''}`
  );

  return [
    `Source tool: ${redactSemanticMigrationPromptText(inventory.sourceTool)}`,
    `Inventory: ${redactSemanticMigrationPromptText(inventory.summary)}`,
    '',
    'Detected semantic objects:',
    listItems(viewLines),
    '',
    'Detected explores/topics:',
    listItems(exploreLines),
    '',
    'Detected relationships:',
    listItems(relationshipLines),
    '',
    'Detected metrics/measures:',
    listItems(metricLines),
    '',
    'Detected dashboard/report evidence:',
    listItems(dashboardLines),
    '',
    'Parser warnings:',
    listItems(inventory.warnings.map((warning) => providerSafeString(warning, 'diagnostic'))),
  ].join('\n');
}

export function semanticMigrationAiEvidenceSummary(inventory: MigrationInventory, includeRawSourceSnippets = false) {
  const rawSourceEnabled = includeRawSourceSnippets && inventory.sourceTool !== 'power_bi';
  const rawArtifacts = inventory.artifacts.filter((artifact) => artifact.content.trim()).slice(0, 8);
  const rawCharacterEstimate = rawSourceEnabled
    ? Math.min(MAX_TOTAL_SNIPPET_CHARS, rawArtifacts.reduce((total, artifact) => total + Math.min(artifact.content.length, MAX_ARTIFACT_SNIPPET_CHARS), 0))
    : 0;
  const normalizedCharacterEstimate = inventorySummary(inventory).length;
  return {
    mode: rawSourceEnabled ? 'normalized_and_raw' as const : 'normalized' as const,
    providerCategories: inventory.sourceTool === 'power_bi'
      ? ['semantic objects', 'DAX expressions', 'Power Query/M fingerprints', 'relationships', 'report fields', 'filters', 'parser warnings']
      : ['semantic objects', 'expressions', 'relationships', 'report fields', 'filters', 'parser warnings'],
    artifactCategories: Array.from(new Set(inventory.artifacts.map((artifact) => artifact.kind))).sort(),
    rawArtifactCount: rawSourceEnabled ? rawArtifacts.length : 0,
    approximatePayloadCharacters: normalizedCharacterEstimate + rawCharacterEstimate,
    redaction: SEMANTIC_MIGRATION_REDACTION_DISCLOSURE,
    perArtifactCharacterLimit: rawSourceEnabled ? MAX_ARTIFACT_SNIPPET_CHARS : 0,
    totalRawCharacterLimit: rawSourceEnabled ? MAX_TOTAL_SNIPPET_CHARS : 0,
  };
}

function sourceEvidenceContext(inventory: MigrationInventory, includeRawSourceSnippets = false) {
  const summary = semanticMigrationAiEvidenceSummary(inventory, includeRawSourceSnippets);
  const rawSourceEnabled = summary.mode === 'normalized_and_raw';
  return [
    `AI evidence mode: ${summary.mode}`,
    `Normalized categories: ${summary.providerCategories.join(', ')}`,
    summary.redaction,
    rawSourceEnabled
      ? `Raw source snippets explicitly enabled: up to ${summary.rawArtifactCount} artifacts, ${summary.perArtifactCharacterLimit.toLocaleString()} characters each, ${summary.totalRawCharacterLimit.toLocaleString()} characters total.`
      : inventory.sourceTool === 'power_bi' && includeRawSourceSnippets
        ? 'Raw source snippets disabled for Power BI: Power Query/M, connection, and security source bodies never cross the provider boundary.'
        : 'Raw source snippets disabled: full uploaded files are not included in this prompt.',
    '',
    'Normalized parser evidence:',
    inventorySummary(inventory),
    '',
    'Raw source artifact snippets:',
    rawSourceEnabled ? artifactSnippets(inventory) || '- No raw snippets were available.' : '- Disabled by provider-boundary policy.',
  ].join('\n');
}

function artifactSnippets(inventory: MigrationInventory) {
  let total = 0;
  return inventory.artifacts
    .filter((artifact) => artifact.content.trim())
    .slice(0, 8)
    .map((artifact) => {
      const remaining = Math.max(0, MAX_TOTAL_SNIPPET_CHARS - total);
      const limit = Math.min(MAX_ARTIFACT_SNIPPET_CHARS, remaining);
      if (limit <= 0) return '';
      const snippet = redactRawSource(artifact.content.slice(0, limit));
      total += snippet.length;
      return [
        `--- Artifact: ${redactSemanticMigrationPromptText(artifact.name)} (${artifact.kind}, ${artifact.sizeBytes} bytes) ---`,
        snippet,
      ].join('\n');
    })
    .filter(Boolean)
    .join('\n\n');
}

function existingFileContext(fileNames?: string[]) {
  const names = (fileNames || []).filter(Boolean).sort().map(redactSemanticMigrationPromptText);
  if (names.length === 0) return '- Target model file list was not loaded. Treat target file names as validation items.';
  return listItems(names);
}

function currentTargetYamlContext(files?: Record<string, string>) {
  const entries = Object.entries(files || {}).filter(([, yaml]) => yaml.trim());
  if (entries.length === 0) return '- Current target YAML bodies were not loaded. Do not return complete replacements for existing files unless the admin confirms the current body separately.';

  return entries
    .map(([fileName, yaml]) => {
      const body = redactSemanticMigrationPromptText(yaml);
      return [
        `--- Current target file: ${redactSemanticMigrationPromptText(fileName)} ---`,
        '```yaml',
        body,
        '```',
      ].join('\n');
    })
    .join('\n\n');
}

function sourcePracticeGuidance(sourceTool: MigrationInventory['sourceTool']) {
  if (sourceTool === 'dbt') {
    return `dbt migration practice:
- Treat dbt as the transformation and semantic evidence layer, not as an Omni semantic file replacement.
- Use dbt model YAML, columns, metrics, semantic models, constraints, tests, and exposures to infer Omni views, relationships, topics, and validation notes.
- Keep dbt repository source and Omni semantic model files separate; OmniKit should generate Omni YAML to a dev branch only.
- Do not invent joins, measures, or permission controls that are not supported by source artifacts or confirmed admin intent.`;
  }

  if (sourceTool === 'looker') {
    return `Looker migration practice:
- Treat LookML views, explores, joins, measures, access filters, and dashboard usage as evidence for an Omni re-model.
- Re-model for Omni semantics instead of transliterating LookML one-to-one.
- Use dashboards and Looks only as usage evidence for topics, fields, default filters, and validation priorities.
- Derived tables/PDTs should generally become dbt or warehouse models before Omni view YAML; route access_filter logic to Permission Builder validation.`;
  }

  if (sourceTool === 'power_bi') {
    return `Power BI migration practice:
- Treat model.bim, TMDL, DAX measures, relationships, and report layout metadata as semantic evidence for Omni.
- Convert Power BI tables and measures into Omni-native views/measures only after validating DAX definitions, grain, and filter context assumptions.
- Use selected reports/pages/visuals to produce reviewable dashboard plans for the exact supplied visual IDs. Do not treat them as Omni-native import JSON or invent unsupported interactions.
- Row-level security roles, workspace permissions, and sensitivity labels should become Permission Builder validation items unless explicitly confirmed.`;
  }

  if (sourceTool === 'tableau') {
    return `Tableau migration practice:
- Treat TWB/TDS datasource XML, fields, calculated fields, joins, worksheets, and dashboards as semantic evidence for Omni.
- Convert Tableau calculated fields carefully; table calculations and LOD expressions need human review before becoming Omni SQL.
- Use workbooks and dashboards as usage evidence for topics, field curation, and validation priorities, not as dashboard recreation instructions.
- Tableau permissions, extracts, and refresh schedules should stay validation notes unless the target Omni file supports an explicit equivalent.`;
  }

  if (sourceTool === 'metabase') {
    return `Metabase migration practice:
- Treat collections, dashboards, Cards, dashboard parameters, MBQL/native queries, and collection permissions as separate evidence classes; preserve Card and dashboard IDs through dependency closure.
- Treat MBQL as versioned opaque source evidence unless the deterministic extractor has normalized a supported expression. Never infer a join, metric, or filter binding from native SQL text alone.
- Unknown visualizations, unresolved parameter-to-Card mappings, native SQL lineage, pulses/alerts, actions, and incomplete permissions remain blocking review items rather than fallback tables or guessed Omni behavior.
- Use dashboard layout and query metadata as recreation and validation evidence. Keep collection permissions and delivery behavior in explicit governance or operational handoffs.`;
  }

  if (sourceTool === 'sigma') {
    return `Sigma migration practice:
- Treat data models, element-scoped columns, metrics, relationships, workbooks, pages, elements, controls, lineage, grants, and materialization schedules as separate evidence classes with native IDs.
- Use only documented element bindings and relationship keys. Do not infer filter bindings from undocumented control payload fields, invent join keys, or coerce an unknown visualization to a table.
- Treat generated SQL as fingerprinted validation evidence, not as authority to create semantic objects. Input tables, actions, writeback, permissions, and materialization behavior require explicit handoffs or reviewed target decisions.
- Require bounded, version-pinned workbook evidence before claiming source completeness; preserve unsupported layout or interaction behavior as blocking review evidence.`;
  }

  if (sourceTool === 'microstrategy') {
    return `MicroStrategy migration practice:
- Treat project-scoped report, dossier/document, dataset, Intelligent Cube, attribute/form, metric, filter, prompt, and report-limit objects as typed source evidence; preserve stable object IDs and dependency edges.
- Do not guess metric dimensionality, level, transformation behavior, prompt answers, or security-filter semantics. Missing referenced metadata must remain a blocking dependency.
- Route Freeform SQL, cube materialization, and reusable transformation logic upstream unless reviewed evidence shows that a bounded Omni query view is the appropriate target.
- Use dossier and report layout only as dashboard intent. ACLs, subscriptions, schedules, and security filters require named governance or operational handoffs and target validation.`;
  }

  if (sourceTool === 'webfocus') {
    return `WebFOCUS migration practice:
- Treat repository metadata, FEX procedures, Master File MAS definitions, and Access File ACX definitions as separate evidence classes; preserve referenced procedure and data-source identities.
- Resolve DEFINE/COMPUTE expressions, JOIN paths, WHERE/IF filters, amper-variable parameters, and report procedure dependencies before proposing Omni semantics.
- Route procedural, multi-step, writeback, operating-system, or warehouse transformation logic upstream. Generate an Omni query view only for bounded read-only query logic with complete field lineage.
- Missing Master File or referenced procedure evidence blocks readiness. ReportCaster, portal layout, schedules, and security remain explicit handoffs unless documented target evidence proves an equivalent.`;
  }

  if (sourceTool === 'domo') return domoDevelopmentPromptGuidance();

  return `Source migration practice:
- Treat the normalized source inventory as evidence, not as target-native Omni code.
- Propose only objects supported by the selected source dependency closure and the documented Omni target contract.
- Keep unsupported calculations, transformations, permissions, delivery behavior, and application interactions visible as explicit review items or accountable handoffs.
- Never infer missing source behavior or claim parity without validation evidence.`;
}

export function buildSemanticMigrationPlanPrompt(params: {
  inventory: MigrationInventory;
  modelName: string;
  modelId: string;
  adminGoal: string;
  existingFileNames?: string[];
  includeRawSourceSnippets?: boolean;
}) {
  const { inventory, modelName, modelId, adminGoal, existingFileNames, includeRawSourceSnippets = false } = params;
  return `Semantic Migration Studio Plan
Protocol: ${SEMANTIC_MIGRATION_PROMPT_VERSION}
Contract: ${SEMANTIC_MIGRATION_PLAN_CONTRACT}

Act as a senior analytics engineer migrating semantic layer evidence into Omni.

Stage contract: PLAN ONLY.
- Return concise admin-friendly markdown.
- Do not return deployable YAML, Target file blocks, or code fences labeled yaml.
- Do not deploy dashboards, return dashboard import JSON, analyze screenshots, or request external BI credentials.
- Dashboard/report artifacts are semantic and visual-intent evidence. When the caller supplies a selected visual evidence contract, return reviewable dashboardPlans only for those exact report and visual IDs.

Decision identity contract:
- Return one decision for each independent semantic deliverable. A view, each relationship, a topic, a field, and a scoped filter are separate decisions even when they share source lineage.
- Every decision id must be unique within the response.
- Use a semanticKind that describes the decision itself: data_source, model, view, field, measure, relationship, topic, filter, folder, user, group, permission, schedule, dashboard, or visual.
- Scope nodeId to the semantic deliverable whenever possible. Examples: view:daily_grill_report, relationship:daily_grill_report:northstar_locations, topic:daily_grill_report, field:daily_grill_report:business_date, filter:topic:daily_grill_report:business_date.
- Never present related deliverables as alternative recommendations. Return alternatives only when they are genuinely different outcomes for the same semantic object.
- OmniKit independently validates and repairs decision identity. Reused ids or ambiguous node ids remain visible for human review and never authorize a write.

Target Omni model:
- Name: ${redactSemanticMigrationPromptText(modelName)}
- ID: ${modelId}

Existing Omni semantic files in the target model:
${existingFileContext(existingFileNames)}

Admin migration goal:
${redactSemanticMigrationPromptText(adminGoal.trim() || 'Create reviewed Omni semantic YAML from uploaded/pasted source artifacts.')}

${sourcePracticeGuidance(inventory.sourceTool)}

Source evidence sent to the selected AI provider:
${sourceEvidenceContext(inventory, includeRawSourceSnippets)}

Return exactly these sections:
- Migration readout
- Proposed Omni semantic targets
- Translation risks
- Human confirmations needed
- Package readiness

Keep each section to 3-5 bullets.`;
}

export function buildSemanticMigrationPackagePrompt(params: {
  inventory: MigrationInventory;
  modelName: string;
  modelId: string;
  adminGoal: string;
  /** @deprecated Raw plan prose is intentionally ignored at the compile boundary. */
  confirmedPlan?: string;
  existingFileNames?: string[];
  currentTargetFiles?: Record<string, string>;
  includeRawSourceSnippets?: boolean;
}) {
  const { inventory, modelName, modelId, adminGoal, existingFileNames, currentTargetFiles, includeRawSourceSnippets = false } = params;
  const prompt = `Semantic Migration Studio YAML Package
Protocol: ${SEMANTIC_MIGRATION_PROMPT_VERSION}

Act as a senior analytics engineer generating reviewable Omni semantic YAML from confirmed migration inputs.

Stage contract: PACKAGE.
- Prior-stage prose is excluded from this request. Only structured approved decisions, placements, evidence references, and target baselines supplied for this stage can authorize files.
- Return complete replacement YAML bodies only for Omni semantic files that are needed and supported by the source evidence.
- Each file must be preceded by "Target file: <target>" and the next non-empty line must be \`\`\`yaml.
- Supported targets: model, relationships, <view>.view, <topic>.topic.
- Put assumptions and validations after the final YAML block only.
- Do not return dashboard JSON, dashboard build specs, screenshots, BI credentials, patch fragments, or files for unsupported tools.
- Do not modify Topic Builder, Model / View Builder, or Permission Builder prompts; this is a Semantic Migration Studio package.

Omni file rules:
- model is for model-wide settings only. Do not put topic joins, fields, dimensions, measures, or ai_context in model.
- relationships is a top-level YAML list of relationship objects. Do not wrap it in a relationships: key.
- <view>.view is for dimensions, measures, field descriptions, formats, hidden flags, primary keys, links, synonyms, and view-level metadata.
- <topic>.topic is for base_view, label, description, default_filters, joins, fields, ai_fields, sample_queries, and final ai_context.
- Preserve source intent but generate Omni-native YAML. Do not transliterate unsupported source syntax.
- Use exact existing target file names when replacing current files. Do not shorten schema-qualified paths: if the target model contains public/order_items.view, return Target file: public/order_items.view, not Target file: order_items.view.
- If a source object maps to an existing file listed below, update that existing file path. Only return a new unqualified <view>.view or <topic>.topic file when the admin explicitly confirmed a new file should be created.
- For every existing file you return, use the current target YAML body below as source of truth and return a complete replacement that preserves all unchanged top-level sections and existing fields/measures. Do not replace a mature file with a minimal skeleton.
- Prefer small, safe metadata/context edits over broad rewrites. If preserving a current file body is too large or uncertain, omit that deployable file and put the recommendation in Assumptions / validations.
- Quote description values or use YAML block scalars when description text contains colon-space, lists, formulas, or source field inventories. Do not emit unquoted description strings such as "Source fields: id, status" because Omni may reject them as non-string values.
- If a join, metric, filter, permission, or target file is not confirmed by source evidence, put it in assumptions/validations instead of inventing deployable YAML.
- Do not convert source dashboard filters, LookML always_filter, access_filter, or prose filter defaults into deployable Omni default_filters unless the current target file already contains a known-good default_filters map to preserve. If exact Omni filter map syntax is uncertain, keep the filter rule in ai_context and Assumptions / validations.
- Treat raw PII, access filters, user attributes, and permissions as validation items unless explicitly confirmed in the source evidence and target file type supports them.
- Do not add direct PII, contact fields, person names, raw identifiers, zip/postal codes, or precise latitude/longitude to topic fields or ai_fields unless the admin explicitly confirmed governed exposure in this package. If source artifacts mention these fields, keep them in Assumptions / validations or add negative AI-routing guidance in ai_context.
- Do not add a broad topic fields list just to mirror a BI datasource. Use topic fields only for a narrow, current-safe curation set; otherwise preserve the existing topic shape and describe curation recommendations after the YAML.

Target Omni model:
- Name: ${redactSemanticMigrationPromptText(modelName)}
- ID: ${modelId}

Existing Omni semantic files in the target model:
${existingFileContext(existingFileNames)}

Current YAML bodies for likely target files:
${currentTargetYamlContext(currentTargetFiles)}

Admin migration goal:
${redactSemanticMigrationPromptText(adminGoal.trim() || 'Create reviewed Omni semantic YAML from uploaded/pasted source artifacts.')}

${sourcePracticeGuidance(inventory.sourceTool)}

Source evidence sent to the selected AI provider:
${sourceEvidenceContext(inventory, includeRawSourceSnippets)}

Required response shape:
Target file: <model | relationships | name.view | name.topic>
\`\`\`yaml
<complete replacement YAML body>
\`\`\`

Assumptions / validations
- <max 5 bullets>`;
  assertSemanticMigrationStageIsolation('compile', prompt);
  return prompt;
}

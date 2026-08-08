import { parseDocument } from 'yaml';

const REQUIRED_RELATIONSHIP_FIELDS = [
  'join_from_view',
  'join_to_view',
  'join_type',
  'on_sql',
  'relationship_type',
] as const;

const DOCUMENTED_RELATIONSHIP_TYPES = new Set([
  'one_to_one',
  'many_to_one',
  'one_to_many',
  'many_to_many',
  'assumed_many_to_one',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validates the complete Settings/relationships file contract before staging.
 * Syntax failures are included so the helper is safe to use independently.
 */
export function semanticRelationshipYamlIssues(yaml: string): readonly string[] {
  const document = parseDocument(yaml, {
    prettyErrors: false,
    strict: false,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    return Object.freeze(document.errors.map((error) => `invalid YAML syntax: ${error.message}`));
  }

  const parsed = document.toJS() as unknown;
  if (!Array.isArray(parsed)) {
    return Object.freeze(['relationships must be a top-level YAML list of relationship objects.']);
  }
  if (parsed.length === 0) {
    return Object.freeze(['relationships must contain at least one reviewed relationship object.']);
  }

  const issues: string[] = [];
  parsed.forEach((candidate, index) => {
    const label = `relationships item ${index + 1}`;
    if (!isRecord(candidate)) {
      issues.push(`${label} must be a YAML mapping/object.`);
      return;
    }

    REQUIRED_RELATIONSHIP_FIELDS.forEach((field) => {
      const value = candidate[field];
      if (typeof value !== 'string' || !value.trim()) {
        issues.push(`${label} must include a non-empty ${field}.`);
      }
    });

    const relationshipType = candidate.relationship_type;
    if (
      typeof relationshipType === 'string'
      && relationshipType.trim()
      && !DOCUMENTED_RELATIONSHIP_TYPES.has(relationshipType.trim())
    ) {
      issues.push(`${label} has unsupported relationship_type "${relationshipType}".`);
    }
    if (
      Object.prototype.hasOwnProperty.call(candidate, 'reversible')
      && typeof candidate.reversible !== 'boolean'
    ) {
      issues.push(`${label} reversible must be true or false, not a string or number.`);
    }
  });

  return Object.freeze(issues);
}

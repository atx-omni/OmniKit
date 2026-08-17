import type { AIContentMode } from './types';

export type AIContentNarrativeSectionKey =
  | 'evidence-reviewed'
  | 'supported-findings'
  | 'unknowns'
  | 'recommended-next-steps'
  | 'report'
  | 'evidence-limits'
  | 'follow-ups';

export interface AIContentNarrativeSection {
  key: AIContentNarrativeSectionKey;
  heading: string;
  body: string;
  evidenceLimit: boolean;
}

export interface AIContentNarrativeResult {
  kind: 'structured-review' | 'structured-report' | 'unstructured-creation';
  sections: AIContentNarrativeSection[];
  raw: string;
}

const SCHEMAS: Partial<Record<AIContentMode, Array<{
  key: AIContentNarrativeSectionKey;
  heading: string;
  evidenceLimit?: boolean;
}>>> = {
  review: [
    { key: 'evidence-reviewed', heading: 'Evidence reviewed' },
    { key: 'supported-findings', heading: 'Supported findings' },
    { key: 'unknowns', heading: 'Unknowns', evidenceLimit: true },
    { key: 'recommended-next-steps', heading: 'Recommended next steps' },
  ],
  report: [
    { key: 'report', heading: 'Report' },
    { key: 'evidence-limits', heading: 'Evidence limits', evidenceLimit: true },
    { key: 'follow-ups', heading: 'Follow-ups' },
  ],
};

function markdownSections(message: string): Map<string, string> {
  const collected = new Map<string, string[]>();
  let current = '';
  for (const line of message.split(/\r?\n/)) {
    // The response contract reserves level-two headings for the required
    // top-level sections. Preserve deeper headings inside the section body so
    // the presentation layer can render them instead of silently dropping the
    // content that follows.
    const match = line.match(/^ {0,3}##(?!#)[\t ]+(.+?)(?:[\t ]+#+)?[\t ]*$/);
    if (match) {
      current = match[1].trim().toLowerCase();
      if (!collected.has(current)) collected.set(current, []);
      continue;
    }
    if (current) collected.get(current)?.push(line);
  }
  return new Map(Array.from(collected, ([heading, lines]) => [heading, lines.join('\n').trim()]));
}

export function parseAIContentNarrative(message: string, mode: AIContentMode): AIContentNarrativeResult {
  const raw = message.trim();
  const schema = SCHEMAS[mode];
  if (!schema) return { kind: 'unstructured-creation', sections: [], raw };

  const sections = markdownSections(raw);
  const parsed = schema.map((definition) => ({
    key: definition.key,
    heading: definition.heading,
    body: sections.get(definition.heading.toLowerCase()) || '',
    evidenceLimit: Boolean(definition.evidenceLimit),
  }));
  const expectedHeadings = new Set(schema.map((definition) => definition.heading.toLowerCase()));
  const hasUnexpectedTopLevelSection = Array.from(sections.keys()).some((heading) => !expectedHeadings.has(heading));
  const hasIncompleteRequiredSection = parsed.some((section) => !section.body.trim());

  return {
    kind: mode === 'review' ? 'structured-review' : 'structured-report',
    // If Omni misses the exact section contract, render the complete raw
    // response rather than presenting empty cards or discarding useful prose.
    sections: hasUnexpectedTopLevelSection || hasIncompleteRequiredSection ? [] : parsed,
    raw,
  };
}

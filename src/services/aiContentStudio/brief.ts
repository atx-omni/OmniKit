import type {
  AIContentAgentMode,
  AIContentOneShotBrief,
  AIContentOneShotBriefField,
} from './types';

export const AI_CONTENT_BRIEF_SOFT_CHARACTERS = 6_000;
export const AI_CONTENT_BRIEF_MAX_CHARACTERS = 12_000;

export const AI_CONTENT_BRIEF_FIELD_LIMITS: Record<AIContentOneShotBriefField, number> = {
  audience: 500,
  objective: 1_200,
  requiredContent: 2_200,
  layoutAndInteractions: 1_600,
  visualDirection: 800,
  exclusions: 1_000,
  acceptanceCriteria: 1_800,
  additionalContext: 2_900,
};

export function emptyAIContentOneShotBrief(): AIContentOneShotBrief {
  return {
    audience: '',
    objective: '',
    requiredContent: '',
    layoutAndInteractions: '',
    visualDirection: '',
    exclusions: '',
    acceptanceCriteria: '',
    additionalContext: '',
  };
}

export function aiContentBriefCharacterCount(brief: AIContentOneShotBrief): number {
  return Object.values(brief).reduce((sum, value) => sum + value.length, 0);
}

export function aiContentBriefHasObjective(brief: AIContentOneShotBrief): boolean {
  return brief.objective.trim().length > 0;
}

const REQUIRED_FIELDS_BY_MODE: Record<AIContentAgentMode, readonly AIContentOneShotBriefField[]> = {
  review: [],
  dashboard: ['objective'],
  app: ['objective', 'requiredContent', 'layoutAndInteractions', 'acceptanceCriteria'],
  report: ['objective'],
};

const APP_FIELD_PLACEHOLDERS: Partial<Record<AIContentOneShotBriefField, string>> = {
  requiredContent: 'Name the exact governed fields, grain, ordering, coordinates, and any permitted derivation rules the App needs.',
  layoutAndInteractions: 'Map each selector, filter, range, and primary action to the query data or App state it must change.',
  acceptanceCriteria: 'Define pass/fail checks for populated selectors, finite ranges and counts, working primary actions, and explicit loading, empty, and error states.',
};

export function aiContentBriefRequiredFields(
  mode: AIContentAgentMode,
): readonly AIContentOneShotBriefField[] {
  return REQUIRED_FIELDS_BY_MODE[mode];
}

export function aiContentBriefIsReady(
  mode: AIContentAgentMode,
  brief: AIContentOneShotBrief,
): boolean {
  return aiContentBriefRequiredFields(mode).every((field) => brief[field].trim().length > 0);
}

export function aiContentBriefPlaceholder(
  mode: AIContentAgentMode,
  field: AIContentOneShotBriefField,
  fallback: string,
): string {
  return mode === 'app' ? APP_FIELD_PLACEHOLDERS[field] || fallback : fallback;
}

export function aiContentBriefForPrompt(brief: AIContentOneShotBrief): Partial<AIContentOneShotBrief> {
  const entries = (Object.keys(AI_CONTENT_BRIEF_FIELD_LIMITS) as AIContentOneShotBriefField[])
    .flatMap((field) => {
      const value = brief[field].trim();
      return value ? [[field, value]] : [];
    });
  return Object.fromEntries(entries) as Partial<AIContentOneShotBrief>;
}

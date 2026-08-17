import {
  AI_CONTENT_BRIEF_FIELD_LIMITS,
  AI_CONTENT_BRIEF_MAX_CHARACTERS,
  AI_CONTENT_BRIEF_SOFT_CHARACTERS,
  aiContentBriefCharacterCount,
  aiContentBriefPlaceholder,
  aiContentBriefRequiredFields,
} from '@/services/aiContentStudio/brief';
import type {
  AIContentAgentMode,
  AIContentOneShotBrief,
  AIContentOneShotBriefField,
} from '@/services/aiContentStudio/types';

interface BriefField {
  field: AIContentOneShotBriefField;
  label: string;
  placeholder: string;
  rows: number;
}

const PRIMARY_FIELDS: BriefField[] = [
  {
    field: 'audience',
    label: 'Audience',
    placeholder: 'Who will use this content, and what decisions do they own?',
    rows: 2,
  },
  {
    field: 'objective',
    label: 'Outcome or decision',
    placeholder: 'State the decision, question, or outcome this content must support.',
    rows: 3,
  },
  {
    field: 'requiredContent',
    label: 'Required metrics, dimensions, and content',
    placeholder: 'List the must-have measures, breakdowns, time windows, comparisons, and definitions.',
    rows: 4,
  },
  {
    field: 'acceptanceCriteria',
    label: 'Acceptance criteria',
    placeholder: 'Describe what must be true for the first result to be useful and review-ready.',
    rows: 3,
  },
];

const DETAIL_FIELDS: BriefField[] = [
  {
    field: 'layoutAndInteractions',
    label: 'Layout and interactions',
    placeholder: 'Describe sections, hierarchy, filters, drill paths, navigation, and responsive behavior.',
    rows: 4,
  },
  {
    field: 'visualDirection',
    label: 'Visual direction',
    placeholder: 'Describe tone, density, emphasis, and presentation preferences. Screenshots remain visual guidance only.',
    rows: 3,
  },
  {
    field: 'exclusions',
    label: 'Exclusions and guardrails',
    placeholder: 'List content, assumptions, audiences, or behaviors that must not be included.',
    rows: 3,
  },
  {
    field: 'additionalContext',
    label: 'Additional context',
    placeholder: 'Add only context that materially changes the requested outcome.',
    rows: 4,
  },
];

function BriefTextarea({
  config,
  value,
  disabled,
  required,
  mode,
  onChange,
}: {
  config: BriefField;
  value: string;
  disabled: boolean;
  required: boolean;
  mode: AIContentAgentMode;
  onChange: (field: AIContentOneShotBriefField, value: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-content-secondary">
        {config.label}{required ? ' (required)' : ''}
      </span>
      <textarea
        value={value}
        onChange={(event) => onChange(config.field, event.target.value)}
        disabled={disabled}
        required={required}
        maxLength={AI_CONTENT_BRIEF_FIELD_LIMITS[config.field]}
        rows={config.rows}
        placeholder={aiContentBriefPlaceholder(mode, config.field, config.placeholder)}
        className="input-field resize-y"
      />
      <div className="mt-1 text-right text-[11px] text-content-tertiary">
        {value.length.toLocaleString()} / {AI_CONTENT_BRIEF_FIELD_LIMITS[config.field].toLocaleString()}
      </div>
    </label>
  );
}

export function OneShotBriefForm({
  mode,
  brief,
  disabled,
  onChange,
}: {
  mode: AIContentAgentMode;
  brief: AIContentOneShotBrief;
  disabled: boolean;
  onChange: (field: AIContentOneShotBriefField, value: string) => void;
}) {
  const totalCharacters = aiContentBriefCharacterCount(brief);
  const overSoftGuidance = totalCharacters > AI_CONTENT_BRIEF_SOFT_CHARACTERS;
  const requiredFields = aiContentBriefRequiredFields(mode);

  return (
    <fieldset className="rounded-card border border-border bg-surface-secondary/40 p-4" disabled={disabled}>
      <legend className="px-1 text-sm font-semibold text-content-primary">
        {mode === 'review' ? 'Optional review brief' : 'One-shot brief'}
      </legend>
      <p className="mb-4 text-xs leading-5 text-content-secondary">
        {mode === 'review' ? (
          <>Optionally identify the audience, decision, or review priorities. The selected model and topic remain authoritative for data meaning, and the automatically captured dashboard render remains authoritative for the visible state.</>
        ) : (
          <>Lead with the decision and success criteria. Omni&apos;s selected model and topic remain authoritative for data meaning; this brief controls the {mode === 'report' ? 'narrative' : 'content'} outcome and presentation.{mode === 'app' && ' App data, interaction, and acceptance details are required so wiring can be verified before creation.'}</>
        )}
      </p>

      <div className="grid gap-4 lg:grid-cols-2">
        {PRIMARY_FIELDS.map((config) => (
          <BriefTextarea
            key={config.field}
            config={config}
            value={brief[config.field]}
            disabled={disabled}
            required={requiredFields.includes(config.field)}
            mode={mode}
            onChange={onChange}
          />
        ))}
      </div>

      <details className="mt-4 rounded-card border border-border bg-white px-3 py-2" open={mode === 'app'}>
        <summary className="cursor-pointer text-xs font-semibold text-content-primary">
          {mode === 'app'
            ? 'App interaction details (required)'
            : mode === 'review'
              ? 'Add optional review priorities and guardrails'
              : 'Add layout, visual, and guardrail details'}
        </summary>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          {DETAIL_FIELDS.map((config) => (
            <BriefTextarea
              key={config.field}
              config={config}
              value={brief[config.field]}
              disabled={disabled}
              required={requiredFields.includes(config.field)}
              mode={mode}
              onChange={onChange}
            />
          ))}
        </div>
      </details>

      <div className={`mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] ${overSoftGuidance ? 'text-amber-800' : 'text-content-tertiary'}`}>
        <span>
          {mode === 'review'
            ? overSoftGuidance
              ? 'This optional review brief is getting long. Keep only priorities that change the assessment.'
              : 'Keep the brief focused; leave it empty for a general visual and usability review.'
            : mode === 'app'
            ? 'Specify the required data grain and fields, control behavior, and pass/fail checks; extra background does not improve the build.'
            : overSoftGuidance
              ? 'This brief is getting long. Remove background that does not change the requested result.'
              : 'A focused 4,000–6,000 character brief usually gives the strongest one-shot result.'}
        </span>
        <span>{totalCharacters.toLocaleString()} / {AI_CONTENT_BRIEF_MAX_CHARACTERS.toLocaleString()}</span>
      </div>
    </fieldset>
  );
}

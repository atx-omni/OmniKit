import { useMemo, useState, type KeyboardEvent } from 'react';
import { CheckCircle2, Plus, ShieldCheck, Trash2, X } from 'lucide-react';
import {
  semanticPermissionListValues,
  type SemanticPermissionAccessGrantDraft,
  type SemanticPermissionContractDraft,
  type SemanticPermissionFieldOption,
  type SemanticPermissionFilterableViewOption,
  type SemanticPermissionTopicAccessFilterDraft,
  type SemanticPermissionUserAttributeOption,
} from '@/services/semanticPermissionContract';

type SemanticPermissionContractFormProps = {
  draft: SemanticPermissionContractDraft;
  issues: string[];
  targetFileName: string;
  userAttributes: SemanticPermissionUserAttributeOption[];
  fieldOptions: SemanticPermissionFieldOption[];
  fieldScopeViewName?: string;
  fieldScopeViewOptions?: SemanticPermissionFilterableViewOption[];
  loadingFieldOptions?: boolean;
  fieldOptionsError?: string;
  loadingUserAttributes?: boolean;
  userAttributeError?: string;
  onFieldScopeViewChange?: (viewName: string) => void;
  onChange: (patch: Partial<SemanticPermissionContractDraft>) => void;
};

function ruleId(prefix: 'grant' | 'filter') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function newGrant(): SemanticPermissionAccessGrantDraft {
  return { id: ruleId('grant'), name: '', userAttribute: '', allowedValues: [], accessBoostable: false };
}

function newFilter(): SemanticPermissionTopicAccessFilterDraft {
  return { id: ruleId('filter'), field: '', userAttribute: '', allowUnfilteredValues: false, valuesForUnfiltered: [] };
}

function AttributeSelect({
  value,
  options,
  disabled,
  onChange,
}: {
  value: string;
  options: SemanticPermissionUserAttributeOption[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      className="input-field mt-1 font-mono text-xs disabled:cursor-not-allowed disabled:bg-surface-secondary"
    >
      <option value="">Choose an Omni attribute</option>
      {options.map((option) => (
        <option key={option.reference} value={option.reference}>
          {option.label} ({option.reference}) · {option.type}{option.multipleValues ? ' · multiple values' : ''}{option.system ? ' · system' : ''}
        </option>
      ))}
    </select>
  );
}

function AttributeDefaultWarning({
  reference,
  options,
}: {
  reference: string;
  options: SemanticPermissionUserAttributeOption[];
}) {
  const selected = options.find((option) => option.reference === reference);
  if (!selected?.defaultValue) return null;

  return (
    <span className="mt-1 block text-[10px] font-normal leading-relaxed text-amber-800">
      Omni default: {selected.defaultValue}. Confirm that this default should participate in the access rule.
    </span>
  );
}

function FieldSelect({
  value,
  options,
  onChange,
}: {
  value: string;
  options: SemanticPermissionFieldOption[];
  onChange: (value: string) => void;
}) {
  const grouped = useMemo(() => {
    const groups = new Map<string, SemanticPermissionFieldOption[]>();
    options.forEach((option) => groups.set(option.viewName, [...(groups.get(option.viewName) || []), option]));
    return Array.from(groups.entries());
  }, [options]);

  return (
    <select
      value={value}
      disabled={options.length === 0}
      onChange={(event) => onChange(event.target.value)}
      className="input-field mt-1 font-mono text-xs disabled:cursor-not-allowed disabled:bg-surface-secondary"
    >
      <option value="">Choose a topic field</option>
      {grouped.map(([viewName, fields]) => (
        <optgroup key={viewName} label={viewName}>
          {fields.map((field) => (
            <option key={field.reference} value={field.reference}>{field.label} ({field.reference})</option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

function ValueChips({
  values,
  placeholder,
  onChange,
}: {
  values: string[];
  placeholder: string;
  onChange: (values: string[]) => void;
}) {
  const [pending, setPending] = useState('');

  function commit(value: string) {
    const additions = semanticPermissionListValues(value);
    if (additions.length > 0) onChange(semanticPermissionListValues([...values, ...additions]));
    setPending('');
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      commit(pending);
    }
  }

  return (
    <div className="mt-1 rounded-button border border-border bg-white px-2 py-2 focus-within:border-omni-400 focus-within:ring-1 focus-within:ring-omni-200">
      {values.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {values.map((value) => (
            <span key={value.toLowerCase()} className="inline-flex max-w-full items-center gap-1 rounded-chip bg-surface-secondary px-2 py-1 text-[11px] text-content-primary">
              <span className="truncate">{value}</span>
              <button
                type="button"
                onClick={() => onChange(values.filter((item) => item !== value))}
                className="text-content-tertiary hover:text-content-primary"
                aria-label={`Remove ${value}`}
                title={`Remove ${value}`}
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <input
          value={pending}
          onChange={(event) => setPending(event.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={() => pending.trim() && commit(pending)}
          className="min-w-0 flex-1 border-0 bg-transparent px-1 py-1 text-xs outline-none"
          placeholder={placeholder}
          autoComplete="off"
        />
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => commit(pending)}
          disabled={!pending.trim()}
          className="inline-flex min-h-8 items-center gap-1 px-2 text-xs font-semibold text-omni-700 disabled:cursor-not-allowed disabled:text-content-tertiary"
        >
          <Plus size={13} /> Add
        </button>
      </div>
    </div>
  );
}

export function SemanticPermissionContractForm({
  draft,
  issues,
  targetFileName,
  userAttributes,
  fieldOptions,
  fieldScopeViewName = '',
  fieldScopeViewOptions = [],
  loadingFieldOptions = false,
  fieldOptionsError = '',
  loadingUserAttributes = false,
  userAttributeError = '',
  onFieldScopeViewChange,
  onChange,
}: SemanticPermissionContractFormProps) {
  const ready = issues.length === 0;
  const attributesReady = userAttributes.length > 0 && !loadingUserAttributes;

  function updateGrant(id: string, patch: Partial<SemanticPermissionAccessGrantDraft>) {
    onChange({
      grants: draft.grants.map((grant) => grant.id === id ? { ...grant, ...patch } : grant),
      reviewedAndConfirmed: false,
    });
  }

  function updateFilter(id: string, patch: Partial<SemanticPermissionTopicAccessFilterDraft>) {
    onChange({
      filters: draft.filters.map((filter) => filter.id === id ? { ...filter, ...patch } : filter),
      reviewedAndConfirmed: false,
    });
  }

  return (
    <section className="overflow-hidden rounded-card border border-border bg-white" aria-labelledby="permission-contract-heading">
      <div className="flex flex-col gap-3 border-b border-border bg-surface-secondary px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <ShieldCheck size={16} className="text-omni-700" />
            <h3 id="permission-contract-heading" className="text-sm font-semibold text-content-primary">Access policy to deploy</h3>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-content-secondary">
            Add every reviewed grant and row filter needed for this topic. OmniKit compiles only selected Omni attributes and model fields; Blobby cannot invent access rules.
          </p>
        </div>
        <span className={`w-fit rounded-chip px-2 py-1 text-[11px] font-semibold ${ready ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-800'}`}>
          {ready ? 'Policy ready' : `${issues.length} detail${issues.length === 1 ? '' : 's'} needed`}
        </span>
      </div>

      <div className="divide-y divide-border">
        <div className="px-4 py-4">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-content-tertiary">Policy type</div>
          <div className="mt-2 grid grid-cols-1 overflow-hidden rounded-button border border-border sm:grid-cols-3" role="radiogroup" aria-label="Access policy type">
            {([
              ['grant_only', 'Topic visibility', 'Require one or more reviewed grants.'],
              ['row_filter_only', 'Row filtering', 'Apply one or more row filters.'],
              ['grant_and_row_filter', 'Visibility + rows', 'Apply both control sets together.'],
            ] as const).map(([mode, label, description]) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={draft.mode === mode}
                onClick={() => onChange({ mode, reviewedAndConfirmed: false })}
                className={`min-h-[68px] border-b border-border px-3 py-2 text-left last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0 ${draft.mode === mode ? 'bg-omni-50 text-omni-800' : 'bg-white text-content-secondary hover:bg-surface-secondary'}`}
              >
                <span className="block text-xs font-semibold text-content-primary">{label}</span>
                <span className="mt-0.5 block text-[10px] leading-relaxed">{description}</span>
              </button>
            ))}
          </div>
        </div>

        {draft.mode !== 'row_filter_only' && (
          <div>
            <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wider text-content-tertiary">1. Model access grants</div>
                <p className="mt-1 text-xs text-content-secondary">Define each reusable grant in Settings/model, then require the reviewed combination on this topic.</p>
              </div>
              <button
                type="button"
                onClick={() => onChange({ grants: [...draft.grants, newGrant()], reviewedAndConfirmed: false })}
                className="btn-secondary inline-flex items-center gap-1.5 text-xs"
              >
                <Plus size={14} /> Add grant
              </button>
            </div>

            {!loadingUserAttributes && userAttributeError && (
              <div className="mx-4 mb-3 rounded-button border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900" role="alert">
                Omni attributes could not be loaded: {userAttributeError}. Use an Organization Admin credential and refresh before configuring access.
              </div>
            )}

            <div className="divide-y divide-border border-t border-border">
              {draft.grants.length === 0 ? (
                <div className="px-4 py-4 text-xs text-content-secondary">No grants added. Add one to control topic visibility.</div>
              ) : draft.grants.map((grant, index) => (
                <div key={grant.id} className="grid grid-cols-1 gap-3 px-4 py-4 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,1.2fr)_auto]">
                  <label className="text-xs font-semibold text-content-primary">
                    Grant {index + 1} name
                    <input
                      value={grant.name}
                      onChange={(event) => updateGrant(grant.id, { name: event.target.value })}
                      className="input-field mt-1 font-mono text-xs"
                      placeholder="regional_access"
                      autoComplete="off"
                    />
                  </label>
                  <label className="text-xs font-semibold text-content-primary">
                    Omni attribute
                    <AttributeSelect
                      value={grant.userAttribute}
                      options={userAttributes}
                      disabled={!attributesReady}
                      onChange={(userAttribute) => updateGrant(grant.id, { userAttribute })}
                    />
                    <AttributeDefaultWarning reference={grant.userAttribute} options={userAttributes} />
                  </label>
                  <div className="text-xs font-semibold text-content-primary">
                    Values that receive access
                    <ValueChips
                      values={grant.allowedValues}
                      placeholder="Type an exact value, then press Enter"
                      onChange={(allowedValues) => updateGrant(grant.id, { allowedValues })}
                    />
                    <label className="mt-2 flex items-start gap-2 font-normal text-content-secondary">
                      <input
                        type="checkbox"
                        checked={grant.accessBoostable}
                        onChange={(event) => updateGrant(grant.id, { accessBoostable: event.target.checked })}
                        className="mt-0.5 rounded border-border text-omni-700 focus:ring-omni-500"
                      />
                      Allow approved AccessBoost documents to bypass this grant
                    </label>
                  </div>
                  <button
                    type="button"
                    onClick={() => onChange({ grants: draft.grants.filter((item) => item.id !== grant.id), reviewedAndConfirmed: false })}
                    className="mt-5 inline-flex h-10 w-10 items-center justify-center rounded-button border border-border text-content-tertiary hover:border-red-200 hover:bg-red-50 hover:text-red-700"
                    aria-label={`Remove grant ${index + 1}`}
                    title={`Remove grant ${index + 1}`}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>

            {draft.grants.length > 1 && (
              <div className="flex flex-col gap-3 border-t border-border bg-surface-secondary px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="text-xs font-semibold text-content-primary">How should these grants combine?</div>
                  <div className="mt-0.5 text-[11px] text-content-secondary">This creates one explicit Omni grant expression instead of relying on ambiguous list behavior.</div>
                </div>
                <div className="grid min-w-[260px] grid-cols-2 overflow-hidden rounded-button border border-border" role="radiogroup" aria-label="Grant combination logic">
                  {([
                    ['all', 'Require all', 'AND'],
                    ['any', 'Require any', 'OR'],
                  ] as const).map(([logic, label, operator]) => (
                    <button
                      key={logic}
                      type="button"
                      role="radio"
                      aria-checked={draft.grantLogic === logic}
                      onClick={() => onChange({ grantLogic: logic, reviewedAndConfirmed: false })}
                      className={`px-3 py-2 text-left text-xs ${draft.grantLogic === logic ? 'bg-omni-50 text-omni-800' : 'bg-white text-content-secondary hover:bg-surface-primary'}`}
                    >
                      <span className="block font-semibold">{label}</span>
                      <span className="text-[10px]">{operator} logic</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {draft.mode !== 'grant_only' && (
          <div>
            <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wider text-content-tertiary">2. Topic row filters</div>
                <p className="mt-1 text-xs text-content-secondary">Match each selected topic field to an Omni user attribute on every query. Users without a value fail closed.</p>
              </div>
              <button
                type="button"
                onClick={() => onChange({ filters: [...draft.filters, newFilter()], reviewedAndConfirmed: false })}
                className="btn-secondary inline-flex items-center gap-1.5 text-xs"
              >
                <Plus size={14} /> Add row filter
              </button>
            </div>

            {onFieldScopeViewChange && (
              <div className="border-t border-border bg-surface-secondary px-4 py-3">
                <label className="block max-w-xl text-xs font-semibold text-content-primary">
                  Topic field scope
                  <select
                    value={fieldScopeViewName}
                    disabled={loadingFieldOptions || fieldScopeViewOptions.length === 0}
                    onChange={(event) => onFieldScopeViewChange(event.target.value)}
                    className="input-field mt-1 font-mono text-xs disabled:cursor-not-allowed disabled:bg-surface-primary"
                  >
                    <option value="">Use the reviewed base view and relationships</option>
                    {fieldScopeViewOptions.map((option) => (
                      <option key={option.name} value={option.name}>
                        {option.name} · {option.fieldCount} filterable field{option.fieldCount === 1 ? '' : 's'}
                      </option>
                    ))}
                  </select>
                  <span className="mt-1 block font-normal leading-relaxed text-content-secondary">
                    If the reviewed topic scope is not ready yet, choose the exact model view that owns the filter field. OmniKit will require the generated topic to reach that view before it can be staged.
                  </span>
                </label>
              </div>
            )}

            {loadingFieldOptions && fieldOptions.length === 0 && (
              <div className="mx-4 mb-3 rounded-button border border-omni-100 bg-omni-50 px-3 py-2 text-xs text-omni-800" role="status">
                Loading verified filterable dimensions from the selected model...
              </div>
            )}

            {!loadingFieldOptions && fieldOptionsError && fieldOptions.length === 0 && (
              <div className="mx-4 mb-3 rounded-button border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900" role="alert">
                OmniKit could not load the resolved model field inventory: {fieldOptionsError}. Refresh the review before choosing a row filter.
              </div>
            )}

            {!loadingFieldOptions && !fieldOptionsError && fieldOptions.length === 0 && (
              <div className="mx-4 mb-3 rounded-button border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900" role="alert">
                No verified filterable dimensions are available for this topic yet. Choose a topic field scope above, or rerun the review after confirming the base view and relationships.
              </div>
            )}

            <div className="divide-y divide-border border-t border-border">
              {draft.filters.length === 0 ? (
                <div className="px-4 py-4 text-xs text-content-secondary">No row filters added. Add one to restrict rows by an Omni attribute.</div>
              ) : draft.filters.map((filter, index) => (
                <div key={filter.id} className="grid grid-cols-1 gap-3 px-4 py-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)_minmax(0,1.2fr)_auto]">
                  <label className="text-xs font-semibold text-content-primary">
                    Row filter {index + 1} field
                    <FieldSelect
                      value={filter.field}
                      options={fieldOptions}
                      onChange={(field) => updateFilter(filter.id, { field })}
                    />
                  </label>
                  <label className="text-xs font-semibold text-content-primary">
                    Matching Omni attribute
                    <AttributeSelect
                      value={filter.userAttribute}
                      options={userAttributes}
                      disabled={!attributesReady}
                      onChange={(userAttribute) => updateFilter(filter.id, { userAttribute })}
                    />
                    <AttributeDefaultWarning reference={filter.userAttribute} options={userAttributes} />
                  </label>
                  <div className="text-xs font-semibold text-content-primary">
                    Cross-scope bypass
                    <label className="mt-1 flex min-h-[42px] items-center gap-2 rounded-button border border-border px-3 font-normal text-content-secondary">
                      <input
                        type="checkbox"
                        checked={filter.allowUnfilteredValues}
                        onChange={(event) => updateFilter(filter.id, { allowUnfilteredValues: event.target.checked })}
                        className="rounded border-border text-omni-700 focus:ring-omni-500"
                      />
                      Allow reviewed values to see all rows
                    </label>
                    {filter.allowUnfilteredValues && (
                      <ValueChips
                        values={filter.valuesForUnfiltered}
                        placeholder="Add a reviewed bypass value"
                        onChange={(valuesForUnfiltered) => updateFilter(filter.id, { valuesForUnfiltered })}
                      />
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => onChange({ filters: draft.filters.filter((item) => item.id !== filter.id), reviewedAndConfirmed: false })}
                    className="mt-5 inline-flex h-10 w-10 items-center justify-center rounded-button border border-border text-content-tertiary hover:border-red-200 hover:bg-red-50 hover:text-red-700"
                    aria-label={`Remove row filter ${index + 1}`}
                    title={`Remove row filter ${index + 1}`}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="space-y-3 px-4 py-4">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-content-tertiary">3. Review the enforcement boundary</div>
            <div className="mt-2 grid grid-cols-1 gap-2 text-xs text-content-secondary md:grid-cols-3">
              <div className="border-l-2 border-omni-300 pl-3"><span className="font-semibold text-content-primary">Settings/model</span><br />{draft.mode === 'row_filter_only' ? 'No model grant change.' : `Defines ${draft.grants.length} reviewed grant${draft.grants.length === 1 ? '' : 's'}.`}</div>
              <div className="border-l-2 border-blue-300 pl-3"><span className="font-semibold text-content-primary">{targetFileName || 'Selected topic'}</span><br />Requires the reviewed grant expression and/or applies {draft.filters.length} row filter{draft.filters.length === 1 ? '' : 's'}.</div>
              <div className="border-l-2 border-amber-300 pl-3"><span className="font-semibold text-content-primary">Settings &gt; Attributes</span><br />Attribute provisioning and user assignments remain outside this branch.</div>
            </div>
          </div>
          <label className={`flex cursor-pointer items-start gap-3 rounded-button border px-3 py-3 text-xs ${draft.reviewedAndConfirmed ? 'border-green-200 bg-green-50 text-green-900' : 'border-amber-200 bg-amber-50 text-amber-900'}`}>
            <input
              type="checkbox"
              checked={draft.reviewedAndConfirmed}
              onChange={(event) => onChange({ reviewedAndConfirmed: event.target.checked })}
              className="mt-0.5 rounded border-amber-300 text-omni-700 focus:ring-omni-500"
            />
            <span>
              <span className="font-semibold">I reviewed this exact access contract.</span>{' '}
              Every referenced attribute, value, field, AND/OR choice, and bypass is intentional. Users without a row-filter value must fail closed.
            </span>
          </label>

          {issues.length > 0 ? (
            <div className="rounded-button border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900" role="status">
              <div className="font-semibold">Complete these details before generating enforceable YAML</div>
              <ul className="mt-1 list-disc space-y-1 pl-4">
                {issues.map((issue) => <li key={issue}>{issue}</li>)}
              </ul>
            </div>
          ) : (
            <div className="flex items-center gap-2 rounded-button border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-800" role="status">
              <CheckCircle2 size={14} /> Exact multi-rule access contract confirmed. OmniKit can compile it deterministically.
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

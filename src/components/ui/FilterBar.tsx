import { useId } from 'react';
import { SearchInput } from './SearchInput';

export interface FilterConfig {
  key: string;
  label: string;
  type: 'search' | 'select' | 'toggle';
  placeholder?: string;
  options?: Array<{ label: string; value: string }>;
}

interface FilterBarProps {
  filters: FilterConfig[];
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
}

export function FilterBar({ filters, values, onChange }: FilterBarProps) {
  const controlId = useId();

  return (
    <div className="flex flex-wrap items-end gap-2.5" role="group" aria-label="Filters">
      {filters.map((filter, index) => {
        const inputId = `${controlId}-${index}`;

        if (filter.type === 'search') {
          return (
            <div key={filter.key} className="min-w-[220px] flex-1">
              <SearchInput
                value={values[filter.key] || ''}
                onChange={(v) => onChange(filter.key, v)}
                placeholder={filter.placeholder || `Search ${filter.label.toLowerCase()}...`}
                ariaLabel={`Search ${filter.label}`}
              />
            </div>
          );
        }

        if (filter.type === 'select') {
          return (
            <div key={filter.key} className="min-w-[152px]">
              <label htmlFor={inputId} className="mb-1 block text-[11px] font-semibold text-content-secondary">
                {filter.label}
              </label>
              <select
                id={inputId}
                value={values[filter.key] || ''}
                onChange={(e) => onChange(filter.key, e.target.value)}
                className="input-field h-9 py-0 text-sm hover:border-border-strong"
              >
                <option value="">All</option>
                {filter.options?.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          );
        }

        if (filter.type === 'toggle') {
          return (
            <label key={filter.key} htmlFor={inputId} className="group inline-flex min-h-9 cursor-pointer items-center gap-2.5">
              <input
                id={inputId}
                type="checkbox"
                role="switch"
                checked={values[filter.key] === 'true'}
                onChange={(e) => onChange(filter.key, e.target.checked ? 'true' : '')}
                className="peer sr-only"
              />
              <span
                aria-hidden="true"
                className="relative h-4 w-8 flex-shrink-0 rounded-full border border-border-strong bg-surface-tertiary transition-colors after:absolute after:left-[2px] after:top-[2px] after:h-3 after:w-3 after:rounded-full after:border after:border-border-strong after:bg-brand-warm after:content-[''] after:transition-transform peer-checked:border-brand-wine peer-checked:bg-brand-pink peer-checked:after:translate-x-4 peer-focus-visible:ring-2 peer-focus-visible:ring-brand-wine peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-brand-warm"
              />
              <span className="text-xs font-medium text-content-secondary transition-colors group-hover:text-brand-wine">
                {filter.label}
              </span>
            </label>
          );
        }

        return null;
      })}
    </div>
  );
}

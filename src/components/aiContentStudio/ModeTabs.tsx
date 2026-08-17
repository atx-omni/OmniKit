import type { AIContentMode } from '@/services/aiContentStudio/types';
import { AI_CONTENT_MODE_DETAILS } from './modeDetails';

export function ModeTabs({
  mode,
  disabled,
  onChange,
}: {
  mode: AIContentMode;
  disabled: boolean;
  onChange: (mode: AIContentMode) => void;
}) {
  return (
    <div role="tablist" aria-label="AI Content Studio mode" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {AI_CONTENT_MODE_DETAILS.map((item) => {
        const Icon = item.icon;
        const selected = item.mode === mode;
        return (
          <button
            key={item.mode}
            type="button"
            role="tab"
            aria-selected={selected}
            disabled={disabled}
            onClick={() => onChange(item.mode)}
            className={`rounded-card border p-4 text-left transition-colors ${selected ? 'border-omni-300 bg-omni-50 ring-1 ring-omni-200' : 'border-border bg-white hover:border-omni-200'}`}
          >
            <Icon size={18} className={selected ? 'text-omni-700' : 'text-content-secondary'} />
            <div className="mt-3 text-sm font-semibold text-content-primary">{item.label}</div>
            <div className="mt-1 text-xs leading-5 text-content-secondary">{item.description}</div>
          </button>
        );
      })}
    </div>
  );
}

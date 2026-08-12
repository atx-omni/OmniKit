import { Search, X } from 'lucide-react';

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
}

export function SearchInput({ value, onChange, placeholder = 'Search...', ariaLabel }: SearchInputProps) {
  return (
    <div className="group relative min-w-0">
      <Search
        size={15}
        aria-hidden="true"
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-content-tertiary transition-colors group-focus-within:text-omni-600"
      />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel || placeholder}
        className="input-field h-9 py-0 pl-9 pr-9 hover:border-border-strong"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          className="absolute right-1.5 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-button text-content-tertiary transition-colors hover:bg-omni-50 hover:text-omni-700"
          aria-label="Clear search"
        >
          <X size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

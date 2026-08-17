import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { CheckCircle2, ChevronDown, Loader2, Search } from 'lucide-react';
import { selectedRowClass, unselectedRowClass } from './selectionStyles';
import {
  comboBoxEmptyText,
  filterComboBoxOptions,
  limitComboBoxOptions,
  resolveComboBoxDisplay,
  resolveComboBoxOptionAccessibleText,
  type ComboBoxOption,
  type ComboBoxOptionLayout,
} from './comboBoxUtils';

interface ComboBoxProps {
  options: ComboBoxOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  allowFreeText?: boolean;
  ariaLabel?: string;
  disabled?: boolean;
  emptyLabel?: string;
  isLoading?: boolean;
  loadingLabel?: string;
  maxVisibleOptions?: number;
  onOpen?: () => void;
  optionLayout?: ComboBoxOptionLayout;
}

export interface ComboBoxKeyboardContext {
  isOpen: boolean;
  highlightedIndex: number;
  optionCount: number;
  allowFreeText: boolean;
  hasSearch: boolean;
}

export type ComboBoxKeyboardAction =
  | { type: 'none' }
  | { type: 'open'; highlightedIndex: number }
  | { type: 'move'; highlightedIndex: number }
  | { type: 'select'; highlightedIndex: number }
  | { type: 'commit-free-text' }
  | { type: 'close' };

// Exported for deterministic keyboard-contract coverage without launching a browser.
// eslint-disable-next-line react-refresh/only-export-components
export function resolveComboBoxKeyboardAction(
  key: string,
  context: ComboBoxKeyboardContext,
): ComboBoxKeyboardAction {
  const { isOpen, highlightedIndex, optionCount, allowFreeText, hasSearch } = context;

  if (key === 'ArrowDown') {
    if (!isOpen) return { type: 'open', highlightedIndex: optionCount > 0 ? 0 : -1 };
    if (optionCount === 0) return { type: 'none' };
    return {
      type: 'move',
      highlightedIndex: highlightedIndex < optionCount - 1 ? highlightedIndex + 1 : 0,
    };
  }

  if (key === 'ArrowUp') {
    if (!isOpen) return { type: 'open', highlightedIndex: optionCount > 0 ? optionCount - 1 : -1 };
    if (optionCount === 0) return { type: 'none' };
    return {
      type: 'move',
      highlightedIndex: highlightedIndex > 0 ? highlightedIndex - 1 : optionCount - 1,
    };
  }

  if (isOpen && key === 'Home' && optionCount > 0) {
    return { type: 'move', highlightedIndex: 0 };
  }

  if (isOpen && key === 'End' && optionCount > 0) {
    return { type: 'move', highlightedIndex: optionCount - 1 };
  }

  if (key === 'Enter') {
    if (!isOpen) return { type: 'open', highlightedIndex: optionCount > 0 ? 0 : -1 };
    if (highlightedIndex >= 0 && highlightedIndex < optionCount) {
      return { type: 'select', highlightedIndex };
    }
    if (allowFreeText && hasSearch) return { type: 'commit-free-text' };
    return { type: 'none' };
  }

  if (key === 'Escape' && isOpen) return { type: 'close' };
  if (key === 'Tab' && isOpen) return { type: 'close' };
  return { type: 'none' };
}

export function ComboBox({
  options,
  value,
  onChange,
  placeholder = 'Select or type...',
  allowFreeText = true,
  ariaLabel,
  disabled = false,
  emptyLabel = 'No options found',
  isLoading = false,
  loadingLabel = 'Loading options...',
  maxVisibleOptions = 100,
  onOpen,
  optionLayout = 'compact',
}: ComboBoxProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const valueDescriptionId = `${listboxId}-value-description`;

  const filtered = filterComboBoxOptions(options, search);
  const visibleOptions = limitComboBoxOptions(filtered, maxVisibleOptions);
  const hiddenOptionCount = Math.max(0, filtered.length - visibleOptions.length);
  const { selectedLabel, showIdBelowLabel } = resolveComboBoxDisplay(options, value);
  const customValue = search.trim();
  const showCustomOption = Boolean(allowFreeText && customValue && filtered.length === 0 && !isLoading);
  const selectableOptionCount = visibleOptions.length > 0 ? visibleOptions.length : showCustomOption ? 1 : 0;
  const activeOptionId = isOpen && highlightedIndex >= 0 && highlightedIndex < selectableOptionCount
    ? `${listboxId}-option-${highlightedIndex}`
    : undefined;

  useEffect(() => {
    setHighlightedIndex(-1);
  }, [search]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setSearch('');
        setHighlightedIndex(-1);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const scrollToIndex = useCallback((index: number) => {
    if (!listRef.current) return;
    const items = listRef.current.querySelectorAll('[data-combobox-option]');
    items[index]?.scrollIntoView({ block: 'nearest' });
  }, []);

  function focusInput() {
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }

  function openMenu(nextHighlightedIndex = -1) {
    if (disabled) return;
    if (!isOpen) {
      setIsOpen(true);
      setSearch('');
      setHighlightedIndex(nextHighlightedIndex);
      onOpen?.();
    } else if (nextHighlightedIndex >= 0) {
      setHighlightedIndex(nextHighlightedIndex);
    }
    focusInput();
  }

  function closeMenu({ restoreFocus = true }: { restoreFocus?: boolean } = {}) {
    setIsOpen(false);
    setSearch('');
    setHighlightedIndex(-1);
    if (restoreFocus) focusInput();
  }

  function handleSelect(selectedValue: string) {
    if (disabled) return;
    onChange(selectedValue);
    closeMenu();
  }

  function handleInputChange(nextSearch: string) {
    if (disabled) return;
    if (!isOpen) openMenu();
    setSearch(nextSearch);
    if (allowFreeText) onChange(nextSearch);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (disabled) return;

    if (!isOpen && event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      openMenu();
      setSearch(event.key);
      if (allowFreeText) onChange(event.key);
      return;
    }

    if (!isOpen && (event.key === 'Backspace' || event.key === 'Delete')) {
      event.preventDefault();
      openMenu();
      if (allowFreeText) onChange('');
      return;
    }

    const action = resolveComboBoxKeyboardAction(event.key, {
      isOpen,
      highlightedIndex,
      optionCount: selectableOptionCount,
      allowFreeText,
      hasSearch: Boolean(customValue),
    });

    if (action.type === 'none') return;
    if (event.key !== 'Tab') event.preventDefault();

    if (action.type === 'open') {
      openMenu(action.highlightedIndex);
      if (action.highlightedIndex >= 0) window.setTimeout(() => scrollToIndex(action.highlightedIndex), 0);
      return;
    }
    if (action.type === 'move') {
      setHighlightedIndex(action.highlightedIndex);
      scrollToIndex(action.highlightedIndex);
      return;
    }
    if (action.type === 'select') {
      if (visibleOptions.length > 0) handleSelect(visibleOptions[action.highlightedIndex].value);
      else if (showCustomOption) handleSelect(customValue);
      return;
    }
    if (action.type === 'commit-free-text') {
      onChange(search);
      closeMenu();
      return;
    }
    closeMenu({ restoreFocus: event.key !== 'Tab' });
  }

  return (
    <div ref={containerRef} className="relative">
      <div
        className={`input-field flex min-h-9 items-center justify-between gap-2 py-1.5 hover:border-border-strong focus-within:border-brand-wine ${
          disabled ? 'cursor-not-allowed opacity-60' : 'cursor-text'
        }`}
      >
        <Search size={14} aria-hidden="true" className={`flex-shrink-0 ${isOpen ? 'text-omni-600' : 'text-content-tertiary'}`} />
        <div className="min-w-0 flex-1">
          <input
            ref={inputRef}
            type="text"
            value={isOpen ? search : value ? selectedLabel : ''}
            onChange={(event) => handleInputChange(event.target.value)}
            onFocus={() => openMenu()}
            onClick={() => openMenu()}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            className={`w-full min-w-0 bg-transparent text-sm placeholder:text-content-tertiary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-wine ${value && !isOpen ? 'font-medium text-content-primary' : 'text-content-primary'}`}
            role="combobox"
            aria-autocomplete={allowFreeText ? 'both' : 'list'}
            aria-expanded={isOpen}
            aria-haspopup="listbox"
            aria-controls={isOpen ? listboxId : undefined}
            aria-activedescendant={activeOptionId}
            aria-describedby={!isOpen && value && showIdBelowLabel ? valueDescriptionId : undefined}
            aria-label={ariaLabel || placeholder}
            disabled={disabled}
            autoComplete="off"
          />
          {!isOpen && value && showIdBelowLabel && (
            <div id={valueDescriptionId} className="truncate font-mono text-[10px] text-content-tertiary">
              {value}
            </div>
          )}
        </div>
        <ChevronDown
          size={16}
          aria-hidden="true"
          className={`pointer-events-none flex-shrink-0 transition-all ${isOpen ? 'rotate-180 text-omni-600' : 'text-content-tertiary'}`}
        />
      </div>

      {isOpen && (
        <div
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-label={`${ariaLabel || placeholder} options`}
          aria-busy={isLoading}
          className="absolute z-50 mt-1 max-h-60 w-full overflow-y-auto rounded-button border border-border-strong bg-surface-primary shadow-dropdown"
        >
          {isLoading ? (
            <div className="flex items-center gap-2 px-3 py-2.5 text-sm text-content-secondary" role="status">
              <Loader2 size={14} aria-hidden="true" className="animate-spin text-info" />
              <span>{loadingLabel}</span>
            </div>
          ) : filtered.length === 0 ? (
            showCustomOption ? (
              <div
                data-combobox-option
                id={`${listboxId}-option-0`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => handleSelect(customValue)}
                onMouseMove={() => setHighlightedIndex(0)}
                role="option"
                aria-selected={customValue === value}
                className={`w-full cursor-pointer px-3 py-2.5 text-left text-sm transition-colors ${
                  customValue === value
                    ? selectedRowClass
                    : highlightedIndex === 0
                      ? 'border-l-4 border-l-brand-pink bg-brand-purple/40 text-brand-wine'
                      : unselectedRowClass
                }`}
              >
                Use &quot;{customValue}&quot; as custom value
              </div>
            ) : (
              <div className="px-3 py-2.5 text-sm text-content-secondary" role="status">
                {comboBoxEmptyText({ allowFreeText, search, emptyLabel })}
              </div>
            )
          ) : (
            <>
              {visibleOptions.map((option, index) => (
                <div
                  key={`${option.value}:${index}`}
                  data-combobox-option
                  id={`${listboxId}-option-${index}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => handleSelect(option.value)}
                  onMouseMove={() => setHighlightedIndex(index)}
                  role="option"
                  aria-label={optionLayout === 'stacked' ? resolveComboBoxOptionAccessibleText(option, optionLayout) : undefined}
                  aria-selected={option.value === value}
                  className={`w-full cursor-pointer px-3 py-2 text-left text-sm transition-colors ${
                    option.value === value
                      ? selectedRowClass
                      : index === highlightedIndex
                        ? 'border-l-4 border-l-brand-pink bg-brand-purple/40 text-brand-wine'
                        : unselectedRowClass
                  }`}
                >
                  <div className={`flex min-w-0 gap-2 ${optionLayout === 'stacked' ? 'items-start' : 'items-center'}`}>
                    <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
                      {option.value === value && <CheckCircle2 size={14} aria-hidden="true" className="text-omni-600" />}
                    </span>
                    {optionLayout === 'stacked' ? (
                      <span className="min-w-0 flex-1">
                        <span className="block whitespace-normal break-words font-medium leading-5">{option.label}</span>
                        {option.subtitle && (
                          <span className="mt-0.5 block whitespace-normal break-words text-[11px] leading-4 text-content-secondary">
                            {option.subtitle}
                          </span>
                        )}
                        {option.showValue && option.label !== option.value && (
                          <span className="mt-0.5 block break-all font-mono text-[10px] leading-4 text-content-tertiary">
                            ID: {option.value}
                          </span>
                        )}
                      </span>
                    ) : (
                      <>
                        <span className="min-w-0 flex-1 truncate font-medium">{option.label}</span>
                        {option.subtitle && (
                          <span className="max-w-[45%] flex-shrink-0 truncate rounded-chip border border-omni-200 bg-brand-purple/70 px-1.5 py-0.5 text-[10px] font-semibold text-brand-wine">
                            {option.subtitle}
                          </span>
                        )}
                      </>
                    )}
                  </div>
                  {optionLayout === 'compact' && option.showValue && option.label !== option.value && (
                    <div className="ml-6 break-all font-mono text-[11px] text-content-secondary">{option.value}</div>
                  )}
                </div>
              ))}
              {hiddenOptionCount > 0 && (
                <div className="border-t border-border bg-surface-secondary/60 px-3 py-2 text-[11px] text-content-secondary">
                  Showing {visibleOptions.length} of {filtered.length}. Type to narrow the list.
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

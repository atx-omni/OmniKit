export interface ComboBoxOption {
  value: string;
  label: string;
  selectedLabel?: string;
  subtitle?: string;
  showValue?: boolean;
}

export type ComboBoxOptionLayout = 'compact' | 'stacked';

export function resolveComboBoxOptionAccessibleText(
  option: ComboBoxOption,
  layout: ComboBoxOptionLayout,
): string {
  const valueText = option.showValue && option.label !== option.value
    ? layout === 'stacked'
      ? `ID: ${option.value}`
      : option.value
    : undefined;
  return [option.label, option.subtitle, valueText].filter(Boolean).join(' - ');
}

export function filterComboBoxOptions(options: ComboBoxOption[], search: string): ComboBoxOption[] {
  const query = search.trim().toLowerCase();
  if (!query) return options;
  return options.filter(
    (option) =>
      option.label.toLowerCase().includes(query) ||
      option.value.toLowerCase().includes(query) ||
      option.subtitle?.toLowerCase().includes(query)
  );
}

export function limitComboBoxOptions(options: ComboBoxOption[], maxVisibleOptions: number): ComboBoxOption[] {
  if (!Number.isFinite(maxVisibleOptions) || maxVisibleOptions <= 0) return options;
  return options.slice(0, maxVisibleOptions);
}

export function resolveComboBoxDisplay(options: ComboBoxOption[], value: string) {
  const selectedOption = options.find((option) => option.value === value);
  return {
    selectedLabel: selectedOption?.selectedLabel || selectedOption?.label || value,
    showIdBelowLabel: Boolean(selectedOption?.showValue && selectedOption.label !== selectedOption.value),
  };
}

export function comboBoxEmptyText({
  allowFreeText,
  search,
  emptyLabel,
}: {
  allowFreeText: boolean;
  search: string;
  emptyLabel: string;
}): string {
  return allowFreeText && search ? `Use "${search}" as custom value` : emptyLabel;
}

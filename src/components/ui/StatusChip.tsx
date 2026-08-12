import type { MigrationItemStatus } from '@/types';

const variants: Record<string, { classes: string; dot: string }> = {
  success: { classes: 'bg-success-light text-success border-success/30', dot: 'bg-success' },
  ready: { classes: 'bg-success-light text-success border-success/30', dot: 'bg-success' },
  error: { classes: 'bg-error-light text-error border-error/30', dot: 'bg-error' },
  failed: { classes: 'bg-error-light text-error border-error/30', dot: 'bg-error' },
  warning: { classes: 'bg-warning-light text-warning border-warning/30', dot: 'bg-warning' },
  skipped: { classes: 'bg-warning-light text-warning border-warning/30', dot: 'bg-warning' },
  info: { classes: 'bg-info-light text-info border-info/30', dot: 'bg-info' },
  pending: { classes: 'bg-surface-secondary text-content-secondary border-border', dot: 'bg-content-tertiary' },
  in_progress: { classes: 'bg-info-light text-info border-info/30', dot: 'bg-info' },
};

const labels: Record<string, string> = {
  success: 'Success',
  ready: 'Ready',
  error: 'Error',
  failed: 'Failed',
  warning: 'Warning',
  skipped: 'Skipped',
  info: 'Info',
  pending: 'Pending',
  in_progress: 'In Progress',
};

interface StatusChipProps {
  status: MigrationItemStatus | string;
  label?: string;
  className?: string;
  title?: string;
  size?: 'xs' | 'sm' | 'md';
  showDot?: boolean;
}

const sizes: Record<NonNullable<StatusChipProps['size']>, string> = {
  xs: 'px-2 py-0.5 text-[11px] gap-1',
  sm: 'px-2.5 py-0.5 text-xs gap-1.5',
  md: 'px-3 py-1 text-sm gap-1.5',
};

export function StatusChip({ status, label, className = '', title, size = 'sm', showDot = true }: StatusChipProps) {
  const variant = variants[status] || variants.info;
  const text = label || labels[status] || status;

  return (
    <span
      title={title || text}
      className={`${variant.classes} ${className} ${sizes[size]} rounded-chip border font-semibold inline-flex min-w-0 max-w-full items-center`}
    >
      {showDot && <span aria-hidden="true" className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${variant.dot}`} />}
      <span className="min-w-0 truncate">{text}</span>
    </span>
  );
}

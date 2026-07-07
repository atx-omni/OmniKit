import type { MigrationItemStatus } from '@/types';

const variants: Record<string, { classes: string; dot: string }> = {
  success: { classes: 'bg-green-50 text-green-800 border-green-200', dot: 'bg-green-500' },
  ready: { classes: 'bg-green-50 text-green-800 border-green-200', dot: 'bg-green-500' },
  error: { classes: 'bg-red-50 text-red-800 border-red-200', dot: 'bg-red-500' },
  failed: { classes: 'bg-red-50 text-red-800 border-red-200', dot: 'bg-red-500' },
  warning: { classes: 'bg-yellow-50 text-yellow-900 border-yellow-200', dot: 'bg-yellow-500' },
  skipped: { classes: 'bg-yellow-50 text-yellow-900 border-yellow-200', dot: 'bg-yellow-500' },
  info: { classes: 'bg-blue-50 text-blue-800 border-blue-200', dot: 'bg-blue-500' },
  pending: { classes: 'bg-gray-50 text-gray-600 border-gray-200', dot: 'bg-gray-400' },
  in_progress: { classes: 'bg-blue-50 text-blue-800 border-blue-200', dot: 'bg-blue-500' },
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
      {showDot && <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${variant.dot}`} />}
      <span className="min-w-0 truncate">{text}</span>
    </span>
  );
}

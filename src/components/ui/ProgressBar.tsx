import { useReducedMotion } from '@/hooks/useReducedMotion';

interface ProgressBarProps {
  current: number;
  total: number;
  label?: string;
  indeterminate?: boolean;
  tone?: 'brand' | 'danger' | 'success';
}

const TONES = {
  brand: {
    fill: '#FF5FA2',
    track: '#EFE9E3',
    text: '#4D122C',
  },
  danger: {
    fill: '#B91C1C',
    track: '#FFE5E1',
    text: '#B91C1C',
  },
  success: {
    fill: '#327A00',
    track: '#C2FCA0',
    text: '#327A00',
  },
};

export function ProgressBar({ current, total, label, indeterminate, tone = 'brand' }: ProgressBarProps) {
  const pct = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
  const t = TONES[tone];
  const reduced = useReducedMotion();

  return (
    <div className="w-full">
      {label && (
        <div className="flex justify-between items-center mb-1.5">
          <span className="text-[12px] font-medium text-content-secondary">{label}</span>
          {!indeterminate && (
            <span className="text-[12px] tabular-nums font-semibold" style={{ color: t.text }}>
              {pct}%
            </span>
          )}
        </div>
      )}
      <div
        role="progressbar"
        aria-valuenow={indeterminate ? undefined : pct}
        aria-valuemin={0}
        aria-valuemax={100}
        className="relative w-full rounded-full overflow-hidden"
        style={{ height: 4, background: t.track }}
      >
        {indeterminate ? (
          <div
            className="absolute top-0 h-full rounded-full"
            style={{
              width: '40%',
              background: t.fill,
              animation: reduced ? undefined : 'progressSweep 1.6s ease-in-out infinite',
	              boxShadow: 'none',
            }}
          />
        ) : (
          <div
            className="h-full rounded-full"
            style={{
              width: `${pct}%`,
              background: t.fill,
              transition: reduced ? 'none' : 'width 420ms cubic-bezier(0.22, 1, 0.36, 1)',
	              boxShadow: 'none',
            }}
          />
        )}
        <div
          className="absolute inset-x-0 top-0 h-px pointer-events-none"
          style={{ background: 'transparent' }}
          aria-hidden
        />
      </div>
    </div>
  );
}

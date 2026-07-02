import { useMemo, useState } from 'react';
import { collapseUnchangedDiffRuns, lineDiff, type LineDiffPart } from '@/utils/lineDiff';

interface DiffViewProps {
  before: string;
  after: string;
  beforeLabel?: string;
  afterLabel?: string;
  emptyLabel?: string;
  className?: string;
}

function lineClassName(part: LineDiffPart) {
  if (part.type === 'add') return 'border-green-200 bg-green-50 text-green-900';
  if (part.type === 'remove') return 'border-red-200 bg-red-50 text-red-900';
  if (part.oldLineNumber === undefined && part.newLineNumber === undefined) return 'border-border-subtle bg-surface-secondary text-content-secondary';
  return 'border-transparent text-content-secondary';
}

function linePrefix(type: LineDiffPart['type']) {
  if (type === 'add') return '+';
  if (type === 'remove') return '-';
  return ' ';
}

function PlainCodeBlock({ value, emptyLabel }: { value: string; emptyLabel: string }) {
  return (
    <pre className="max-h-80 overflow-auto rounded-card border border-border-subtle bg-white p-3 text-[11px] leading-relaxed text-content-secondary">
      {value || emptyLabel}
    </pre>
  );
}

export function DiffView({
  before,
  after,
  beforeLabel = 'Current',
  afterLabel = 'Proposed',
  emptyLabel = 'No YAML available.',
  className = '',
}: DiffViewProps) {
  const [mode, setMode] = useState<'unified' | 'side_by_side' | 'plain'>('unified');
  const parts = useMemo(() => collapseUnchangedDiffRuns(lineDiff(before, after), 3), [after, before]);
  const hasDiff = before !== after;

  return (
    <div className={className}>
      <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-xs font-semibold uppercase tracking-[0.14em] text-content-secondary">
          {beforeLabel} -&gt; {afterLabel}
        </div>
        <div className="inline-flex rounded-card border border-border-subtle bg-white p-1 text-[11px] font-semibold" role="tablist" aria-label="Diff display mode">
          <button
            type="button"
            onClick={() => setMode('unified')}
            role="tab"
            aria-selected={mode === 'unified'}
            className={`rounded-card px-2 py-1 ${mode === 'unified' ? 'bg-omni-600 text-white' : 'text-content-secondary'}`}
          >
            Unified
          </button>
          <button
            type="button"
            onClick={() => setMode('side_by_side')}
            role="tab"
            aria-selected={mode === 'side_by_side'}
            className={`rounded-card px-2 py-1 ${mode === 'side_by_side' ? 'bg-omni-600 text-white' : 'text-content-secondary'}`}
          >
            Side by side
          </button>
          <button
            type="button"
            onClick={() => setMode('plain')}
            role="tab"
            aria-selected={mode === 'plain'}
            className={`rounded-card px-2 py-1 ${mode === 'plain' ? 'bg-omni-600 text-white' : 'text-content-secondary'}`}
          >
            Plain text
          </button>
        </div>
      </div>

      {!hasDiff && (
        <div className="mb-2 rounded-card border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-800">
          No line changes detected.
        </div>
      )}

      {mode === 'unified' && (
        <div className="max-h-96 overflow-auto rounded-card border border-border-subtle bg-white p-2 font-mono text-[11px] leading-relaxed">
          {parts.length === 0 ? (
            <div className="p-2 text-content-secondary">{emptyLabel}</div>
          ) : parts.map((part, index) => (
            <div
              key={`${part.type}:${part.oldLineNumber || ''}:${part.newLineNumber || ''}:${index}`}
              className={`grid grid-cols-[2.5rem_1rem_minmax(0,1fr)] gap-2 rounded border px-2 py-0.5 ${lineClassName(part)}`}
            >
              <span className="text-right text-content-tertiary">
                {part.newLineNumber ?? part.oldLineNumber ?? ''}
              </span>
              <span aria-hidden="true">{linePrefix(part.type)}</span>
              <span className="whitespace-pre-wrap break-words">{part.text}</span>
            </div>
          ))}
        </div>
      )}

      {mode === 'side_by_side' && (
        <div className="grid gap-3 lg:grid-cols-2">
          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-[0.14em] text-content-secondary">{beforeLabel}</div>
            <PlainCodeBlock value={before} emptyLabel={emptyLabel} />
          </div>
          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-[0.14em] text-content-secondary">{afterLabel}</div>
            <PlainCodeBlock value={after} emptyLabel={emptyLabel} />
          </div>
        </div>
      )}

      {mode === 'plain' && (
        <PlainCodeBlock value={after || before} emptyLabel={emptyLabel} />
      )}
    </div>
  );
}

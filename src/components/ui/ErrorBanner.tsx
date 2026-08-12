import { useState } from 'react';
import { XCircle, ChevronDown, ChevronRight } from 'lucide-react';

interface ErrorBannerProps {
  title?: string;
  message: string;
  detail?: string;
}

export function ErrorBanner({ title = 'Something went wrong', message, detail }: ErrorBannerProps) {
  const [showDetail, setShowDetail] = useState(false);

  return (
    <div className="flex items-start gap-3 rounded-card border border-error/30 bg-error-light px-4 py-3" role="alert">
      <XCircle size={16} aria-hidden="true" className="mt-0.5 flex-shrink-0 text-error" />
      <div className="flex-1 min-w-0">
        <p className="text-xs font-semibold text-error">{title}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-error">{message}</p>
        {detail && (
          <>
            <button
              type="button"
              onClick={() => setShowDetail(!showDetail)}
              aria-expanded={showDetail}
              className="mt-1.5 flex items-center gap-1 text-[11px] font-medium text-error transition-colors hover:text-brand-ink"
            >
              {showDetail ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
              Technical details
            </button>
            {showDetail && (
              <pre className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap rounded-button border border-error/20 bg-surface-primary px-2 py-1.5 font-mono text-[11px] text-error">
                {detail}
              </pre>
            )}
          </>
        )}
      </div>
    </div>
  );
}

import { useEffect, useState, useCallback } from 'react';
import { CheckCircle, XCircle, AlertTriangle, Info, X } from 'lucide-react';
import { Blobby } from './Blobby';
import type { BlobbyMood } from './blobbyAssets';
import { registerToastHandler, type ToastMessage, type ToastMood } from '@/services/toast';

const icons = {
  success: <CheckCircle size={18} aria-hidden="true" className="text-success" />,
  error: <XCircle size={18} aria-hidden="true" className="text-error" />,
  warning: <AlertTriangle size={18} aria-hidden="true" className="text-warning" />,
  info: <Info size={18} aria-hidden="true" className="text-info" />,
};

const bgColors = {
  success: 'bg-success-light border-success/30',
  error: 'bg-error-light border-error/30',
  warning: 'bg-warning-light border-warning/30',
  info: 'bg-info-light border-info/30',
};

const MOOD_TO_BLOBBY: Record<ToastMood, BlobbyMood> = {
  celebrate: 'celebrating',
  think: 'thinking',
  wave: 'waving',
  sad: 'sad',
  warn: 'warning',
};

const DEFAULT_MOOD_BY_TYPE: Record<ToastMessage['type'], ToastMood | undefined> = {
  success: 'celebrate',
  error: 'sad',
  warning: 'warn',
  info: undefined,
};

function ToastItem({ toast, onDismiss }: { toast: ToastMessage; onDismiss: (id: string) => void }) {
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    const duration = toast.duration ?? 5000;
    if (duration <= 0) return;
    const timer = setTimeout(() => {
      setExiting(true);
      setTimeout(() => onDismiss(toast.id), 300);
    }, duration);
    return () => clearTimeout(timer);
  }, [toast.id, toast.duration, onDismiss]);

  const mood = toast.mood ?? DEFAULT_MOOD_BY_TYPE[toast.type];

  return (
    <div
      role={toast.type === 'error' ? 'alert' : 'status'}
      aria-live={toast.type === 'error' ? 'assertive' : 'polite'}
      className={`flex w-[calc(100vw-2rem)] max-w-sm items-start gap-3 rounded-card border px-4 py-3 shadow-dropdown transition-all duration-300 ${bgColors[toast.type]} ${
        exiting ? 'translate-x-4 opacity-0' : 'translate-x-0 opacity-100 motion-safe:animate-slideIn'
      }`}
    >
      <div className="flex-shrink-0 mt-0.5">
        {mood ? (
          <Blobby mood={MOOD_TO_BLOBBY[mood]} size={36} className="animate-pop-in" />
        ) : (
          icons[toast.type]
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-content-primary">{toast.title}</p>
        {toast.detail && (
          <p className="text-xs text-content-secondary mt-0.5 leading-relaxed">{toast.detail}</p>
        )}
      </div>
      <button
        type="button"
        onClick={() => {
          setExiting(true);
          setTimeout(() => onDismiss(toast.id), 300);
        }}
        className="inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-button text-content-secondary transition-colors hover:bg-surface-primary/70 hover:text-content-primary"
        aria-label={`Dismiss ${toast.type} notification`}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  useEffect(() => {
    registerToastHandler((msg) => {
      const id = crypto.randomUUID();
      setToasts((prev) => [...prev, { ...msg, id }]);
    });
    return () => {
      registerToastHandler(null);
    };
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed right-4 top-4 z-50 flex flex-col gap-2">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={dismiss} />
      ))}
    </div>
  );
}

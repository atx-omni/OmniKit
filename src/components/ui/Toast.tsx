import { useEffect, useState, useCallback } from 'react';
import { CheckCircle, XCircle, AlertTriangle, Info, X } from 'lucide-react';
import { Blobby } from './Blobby';
import type { BlobbyMood } from './blobbyAssets';
import { registerToastHandler, type ToastMessage, type ToastMood } from '@/services/toast';

const icons = {
  success: <CheckCircle size={18} className="text-green-500" />,
  error: <XCircle size={18} className="text-red-500" />,
  warning: <AlertTriangle size={18} className="text-yellow-500" />,
  info: <Info size={18} className="text-blue-500" />,
};

const bgColors = {
  success: 'bg-green-50 border-green-200',
  error: 'bg-red-50 border-red-200',
  warning: 'bg-yellow-50 border-yellow-200',
  info: 'bg-blue-50 border-blue-200',
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
      className={`flex items-start gap-3 px-4 py-3 border rounded-card shadow-dropdown max-w-sm transition-all duration-300 ${bgColors[toast.type]} ${
        exiting ? 'opacity-0 translate-x-4' : 'opacity-100 translate-x-0 animate-slideIn'
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
        onClick={() => {
          setExiting(true);
          setTimeout(() => onDismiss(toast.id), 300);
        }}
        className="flex-shrink-0 text-content-secondary hover:text-content-primary transition-colors"
      >
        <X size={14} />
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
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={dismiss} />
      ))}
    </div>
  );
}

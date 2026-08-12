import { useState, useEffect, useRef } from 'react';
import { AlertTriangle, X } from 'lucide-react';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'primary' | 'danger';
  itemCount?: number;
  requireTypedConfirmation?: boolean;
  confirmationPhrase?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'primary',
  itemCount,
  requireTypedConfirmation = false,
  confirmationPhrase = 'DELETE',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [typedValue, setTypedValue] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) {
      previousFocusRef.current = document.activeElement as HTMLElement;
      setTimeout(() => dialogRef.current?.focus(), 0);
    } else {
      setTypedValue('');
      previousFocusRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Tab' && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onCancel]);

  if (!open) return null;

  const needsTyped = requireTypedConfirmation || (variant === 'danger' && itemCount && itemCount >= 5);
  const isConfirmDisabled = needsTyped ? typedValue !== confirmationPhrase : false;
  const iconBg = variant === 'danger' ? 'bg-error-light' : 'bg-warning-light';
  const iconColor = variant === 'danger' ? 'text-error' : 'text-warning';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
      aria-describedby="confirm-message"
    >
      <div className="absolute inset-0 bg-brand-ink/45" onClick={onCancel} />
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="relative mx-4 w-full max-w-md rounded-card border border-border bg-surface-primary p-6 shadow-dropdown outline-none motion-safe:animate-fadeIn"
      >
        <button
          type="button"
          onClick={onCancel}
          className="absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-button text-content-secondary transition-colors hover:bg-surface-secondary hover:text-content-primary"
          aria-label="Close dialog"
        >
          <X size={18} aria-hidden="true" />
        </button>

        <div className="flex items-start gap-3 mb-4">
          <div className={`flex-shrink-0 w-10 h-10 rounded-full ${iconBg} flex items-center justify-center`}>
            <AlertTriangle size={20} aria-hidden="true" className={iconColor} />
          </div>
          <div>
            <h3 id="confirm-title" className="text-lg font-semibold text-content-primary">{title}</h3>
            <p id="confirm-message" className="mt-1 text-sm leading-relaxed text-content-secondary">
              {message}
              {itemCount != null && itemCount > 0 && (
                <span className="font-semibold text-content-primary"> ({itemCount} {itemCount === 1 ? 'item' : 'items'})</span>
              )}
            </p>
          </div>
        </div>

        {needsTyped && (
          <div className="mb-4 rounded-card border border-border bg-surface-secondary p-3">
            <p className="text-xs text-content-secondary mb-2">
              Type <span className="rounded border border-border bg-surface-primary px-1.5 py-0.5 font-mono font-semibold text-content-primary">{confirmationPhrase}</span> to confirm
            </p>
            <input
              type="text"
              value={typedValue}
              onChange={(e) => setTypedValue(e.target.value)}
              placeholder={confirmationPhrase}
              className="input-field text-sm font-mono"
              autoFocus
            />
          </div>
        )}

        <div className="flex justify-end gap-3 mt-6">
          <button type="button" onClick={onCancel} className="btn-secondary text-sm">
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isConfirmDisabled}
            className={variant === 'danger' ? 'btn-danger text-sm' : 'btn-primary text-sm'}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

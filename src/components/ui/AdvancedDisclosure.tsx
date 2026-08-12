import { useState, type ReactNode, type SyntheticEvent } from 'react';
import { ChevronDown } from 'lucide-react';

interface AdvancedDisclosureProps {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  lazyReadOnly?: boolean;
  className?: string;
  summaryClassName?: string;
  contentClassName?: string;
}

export function AdvancedDisclosure({
  title,
  description,
  children,
  open,
  defaultOpen = false,
  onOpenChange,
  lazyReadOnly = false,
  className = '',
  summaryClassName = '',
  contentClassName = '',
}: AdvancedDisclosureProps) {
  const controlled = open !== undefined;
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isOpen = controlled ? open : internalOpen;

  const handleToggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    const nextOpen = event.currentTarget.open;
    if (!controlled) setInternalOpen(nextOpen);
    if (nextOpen !== isOpen) onOpenChange?.(nextOpen);
  };

  return (
    <details
      open={isOpen}
      onToggle={handleToggle}
      className={`group rounded-card border border-border-subtle bg-surface-subtle ${className}`}
    >
      <summary
        className={`flex cursor-pointer list-none items-start justify-between gap-3 px-4 py-3 text-left marker:hidden [&::-webkit-details-marker]:hidden ${summaryClassName}`}
      >
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-content-primary">{title}</span>
          {description && <span className="mt-0.5 block text-xs leading-5 text-content-secondary">{description}</span>}
        </span>
        <ChevronDown
          aria-hidden="true"
          size={16}
          className="mt-0.5 shrink-0 text-content-tertiary transition-transform group-open:rotate-180"
        />
      </summary>
      {(!lazyReadOnly || isOpen) && (
        <div className={`border-t border-border-subtle px-4 py-4 ${contentClassName}`}>{children}</div>
      )}
    </details>
  );
}

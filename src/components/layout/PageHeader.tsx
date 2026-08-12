import type { ReactNode } from 'react';

interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: ReactNode;
  icon?: ReactNode;
  gradient?: boolean;
}

export function PageHeader({ title, description, actions, icon, gradient = false }: PageHeaderProps) {
  void gradient;

  return (
    <header className="mb-6 flex flex-col gap-4 border-b border-border pb-5 lg:flex-row lg:items-start lg:justify-between">
      <div className="flex min-w-0 items-start gap-3 sm:gap-4">
        {icon && (
          <div
            className="flex h-12 w-12 shrink-0 items-center justify-center overflow-visible text-omni-700 sm:h-14 sm:w-14"
            aria-hidden="true"
          >
            {icon}
          </div>
        )}
        <div className="min-w-0 border-l-2 border-omni-500 pl-3 pt-0.5 sm:pl-4">
          <h1 className="break-words text-[22px] font-semibold leading-tight tracking-normal text-omni-900 sm:text-2xl">
            {title}
          </h1>
          {description && (
            <p className="mt-1.5 max-w-3xl text-[13px] leading-5 text-content-secondary">{description}</p>
          )}
        </div>
      </div>
      {actions && (
        <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto sm:gap-2.5 lg:justify-end lg:pl-6">
          {actions}
        </div>
      )}
    </header>
  );
}

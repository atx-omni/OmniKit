import { LayoutDashboard } from 'lucide-react';
import { OmniKitLogo } from '@/components/brand/OmniKitLogo';
import { SecurityBadge } from '@/components/ui/SecurityBadge';

export function Header() {
  return (
    <header
      className="flex h-14 flex-shrink-0 items-center justify-between gap-3 border-b border-white/10 bg-omni-900 px-3 text-white sm:px-5"
      aria-label="Omni Kit application header"
    >
      <div className="flex min-w-0 items-center gap-3">
        <OmniKitLogo variant="light" size="sm" />
        <span className="hidden h-5 w-px shrink-0 bg-white/20 sm:block" aria-hidden="true" />
        <div className="flex min-w-0 items-center gap-2 text-white/80">
          <LayoutDashboard size={15} className="hidden shrink-0 text-omni-400 sm:block" aria-hidden="true" />
          <span className="truncate text-xs font-medium tracking-normal sm:text-[13px]">Dashboard Migrator</span>
        </div>
      </div>
      <div className="hidden min-w-0 md:block">
        <SecurityBadge />
      </div>
    </header>
  );
}

import { ShieldCheck } from 'lucide-react';

export function SecurityBadge() {
  return (
    <div className="inline-flex items-center gap-2 rounded-card border border-success/30 bg-success-light px-3.5 py-2 text-xs font-medium text-success">
      <ShieldCheck size={14} aria-hidden="true" className="flex-shrink-0" />
      <span>Credentials stay encrypted in the local vault.</span>
    </div>
  );
}

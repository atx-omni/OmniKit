import { AppWindow, FileText, LayoutDashboard, ShieldCheck, type LucideIcon } from 'lucide-react';
import type { AIContentMode } from '@/services/aiContentStudio/types';

export interface AIContentModeDetail {
  mode: AIContentMode;
  label: string;
  description: string;
  icon: LucideIcon;
}

export const AI_CONTENT_MODE_DETAILS: AIContentModeDetail[] = [
  { mode: 'review', label: 'Review dashboard', description: 'Request one visual, evidence-grounded AI review of an existing dashboard.', icon: ShieldCheck },
  { mode: 'dashboard', label: 'Dashboard creation', description: 'Request one persistent dashboard, then verify its destination.', icon: LayoutDashboard },
  { mode: 'app', label: 'Apps (Beta)', description: 'Request a workbook-backed App, then manually verify its query bindings and behavior in Omni.', icon: AppWindow },
  { mode: 'report', label: 'Narrative report', description: 'Generate a structured narrative in this studio.', icon: FileText },
];

export function aiContentModeDetail(mode: AIContentMode): AIContentModeDetail {
  return AI_CONTENT_MODE_DETAILS.find((item) => item.mode === mode) || AI_CONTENT_MODE_DETAILS[0];
}

import { exportFullDashboardAsPng } from '@/services/deckBuilder/omniDeckApi';
import {
  addContentAttachments,
  MAX_CONTENT_ATTACHMENTS,
  MAX_CONTENT_ATTACHMENTS_TOTAL_BYTES,
} from './attachments';
import type { AIContentAttachment } from './types';

function safeDashboardName(value: string): string {
  const cleaned = value
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .toLowerCase();
  return cleaned || 'dashboard';
}

export function hasReviewImageFallback(attachments: AIContentAttachment[]): boolean {
  return attachments.some((attachment) => attachment.contentType.startsWith('image/'));
}

export async function captureDashboardReviewRender(input: {
  baseUrl: string;
  apiKey: string;
  dashboardId: string;
  dashboardName: string;
  userAttachments: AIContentAttachment[];
  signal: AbortSignal;
  onStatusChange?: (message: string) => void;
}): Promise<{ attachments: AIContentAttachment[]; renderAttachmentName: string }> {
  const blob = await exportFullDashboardAsPng(
    input.baseUrl,
    input.apiKey,
    input.dashboardId,
    input.signal,
    input.onStatusChange,
  );
  if (input.signal.aborted) {
    throw input.signal.reason instanceof Error
      ? input.signal.reason
      : new DOMException('The dashboard render was cancelled.', 'AbortError');
  }

  const renderAttachmentName = `${safeDashboardName(input.dashboardName)}-dashboard-render.png`;
  const file = new File([blob], renderAttachmentName, { type: 'image/png' });
  const result = await addContentAttachments([], [file]);
  const renderAttachment = result.attachments[0];
  if (!renderAttachment) {
    throw new Error(result.rejected[0] || 'The exported dashboard PNG did not pass attachment validation.');
  }

  const attachments = [renderAttachment, ...input.userAttachments];
  if (attachments.length > MAX_CONTENT_ATTACHMENTS) {
    throw new Error(`The automatic dashboard render and optional references exceed the ${MAX_CONTENT_ATTACHMENTS}-attachment limit.`);
  }
  const totalBytes = attachments.reduce((sum, attachment) => sum + attachment.size, 0);
  if (totalBytes > MAX_CONTENT_ATTACHMENTS_TOTAL_BYTES) {
    throw new Error('The automatic dashboard render and optional references exceed the available upload budget.');
  }
  return { attachments, renderAttachmentName };
}

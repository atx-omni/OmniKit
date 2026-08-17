import { useRef, useState, type DragEvent } from 'react';
import { FileImage, FileText, Trash2, Upload } from 'lucide-react';
import {
  formatAttachmentSize,
  MAX_CONTENT_ATTACHMENTS,
  MAX_CONTENT_ATTACHMENTS_TOTAL_BYTES,
} from '@/services/aiContentStudio/attachments';
import type { AIContentAttachment } from '@/services/aiContentStudio/types';

export function AttachmentDropzone({
  attachments,
  disabled,
  error,
  onFiles,
  onRemove,
}: {
  attachments: AIContentAttachment[];
  disabled: boolean;
  error: string;
  onFiles: (files: File[]) => void;
  onRemove: (id: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const totalBytes = attachments.reduce((sum, attachment) => sum + attachment.size, 0);

  function drop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    if (!disabled) onFiles(Array.from(event.dataTransfer.files));
  }

  return (
    <div className="space-y-3">
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        aria-label="Add screenshot or PDF visual references"
        onClick={() => !disabled && inputRef.current?.click()}
        onKeyDown={(event) => {
          if (!disabled && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragEnter={(event) => { event.preventDefault(); if (!disabled) setDragging(true); }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={() => setDragging(false)}
        onDrop={drop}
        className={`rounded-card border-2 border-dashed p-5 text-center transition-colors ${
          disabled ? 'cursor-not-allowed border-border bg-surface-secondary opacity-60' : dragging ? 'cursor-copy border-omni-400 bg-omni-50' : 'cursor-pointer border-border bg-white hover:border-omni-300 hover:bg-omni-50/30'
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp,image/gif,application/pdf"
          className="hidden"
          disabled={disabled}
          onChange={(event) => {
            onFiles(Array.from(event.target.files || []));
            event.target.value = '';
          }}
        />
        <Upload size={22} className="mx-auto text-omni-600" />
        <div className="mt-2 text-sm font-semibold text-content-primary">Drop screenshots or PDFs</div>
        <div className="mt-1 text-xs leading-5 text-content-secondary">
          Or click to browse. You can also paste screenshots anywhere on this page.
        </div>
        <div className="mt-1 text-[11px] text-content-tertiary">
          PNG, JPEG, WebP, GIF, or PDF · 3 MiB per image · {MAX_CONTENT_ATTACHMENTS} files · prompt space reserved automatically
        </div>
      </div>

      {error && <div role="alert" className="text-xs leading-5 text-red-700">{error}</div>}

      {attachments.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-[11px] text-content-tertiary">
            <span>{attachments.length} of {MAX_CONTENT_ATTACHMENTS} attachments</span>
            <span>{formatAttachmentSize(totalBytes)} of {formatAttachmentSize(MAX_CONTENT_ATTACHMENTS_TOTAL_BYTES)} available</span>
          </div>
          {attachments.map((attachment) => (
            <div key={attachment.id} className="flex items-center gap-3 rounded-card border border-border bg-white px-3 py-2">
              {attachment.contentType === 'application/pdf'
                ? <FileText size={16} className="shrink-0 text-red-600" />
                : <FileImage size={16} className="shrink-0 text-omni-600" />}
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium text-content-primary">{attachment.name}</div>
                <div className="text-[11px] text-content-tertiary">{formatAttachmentSize(attachment.size)} · {attachment.contentType}</div>
              </div>
              <button
                type="button"
                className="btn-ghost btn-sm"
                disabled={disabled}
                onClick={(event) => { event.stopPropagation(); onRemove(attachment.id); }}
                aria-label={`Remove ${attachment.name}`}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

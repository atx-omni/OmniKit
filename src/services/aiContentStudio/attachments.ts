import type { AIContentAttachment } from './types';

export const MAX_CONTENT_ATTACHMENTS = 5;
export const MAX_CONTENT_IMAGE_BYTES = 3 * 1024 * 1024;
export const MAX_CONTENT_REQUEST_BYTES = 15 * 1024 * 1024;
export const MAX_CONTENT_PROMPT_RESERVED_BYTES = 96 * 1024;
export const MAX_CONTENT_ATTACHMENTS_TOTAL_BYTES = MAX_CONTENT_REQUEST_BYTES - MAX_CONTENT_PROMPT_RESERVED_BYTES;

const ALLOWED_CONTENT_TYPES = new Set<AIContentAttachment['contentType']>([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/pdf',
]);

function contentTypeForFile(file: File): AIContentAttachment['contentType'] | null {
  if (ALLOWED_CONTENT_TYPES.has(file.type as AIContentAttachment['contentType'])) {
    return file.type as AIContentAttachment['contentType'];
  }
  const extension = file.name.toLowerCase().split('.').pop();
  if (extension === 'png') return 'image/png';
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'webp') return 'image/webp';
  if (extension === 'gif') return 'image/gif';
  if (extension === 'pdf') return 'application/pdf';
  return null;
}

function hasBytes(bytes: Uint8Array, expected: number[], offset = 0): boolean {
  return expected.every((value, index) => bytes[offset + index] === value);
}

function sniffContentType(buffer: ArrayBuffer): AIContentAttachment['contentType'] | null {
  const bytes = new Uint8Array(buffer.slice(0, 16));
  if (hasBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (hasBytes(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (hasBytes(bytes, [0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return 'image/gif';
  if (hasBytes(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  if (hasBytes(bytes, [0x52, 0x49, 0x46, 0x46]) && hasBytes(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  return null;
}

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function stableAttachmentId(file: File, buffer: ArrayBuffer): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
  const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${file.name}-${file.size}-${sha256}`;
}

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export async function addContentAttachments(
  current: AIContentAttachment[],
  files: File[],
): Promise<{ attachments: AIContentAttachment[]; rejected: string[] }> {
  const next = [...current];
  const rejected: string[] = [];

  for (const file of files) {
    if (next.length >= MAX_CONTENT_ATTACHMENTS) {
      rejected.push(`${file.name}: only ${MAX_CONTENT_ATTACHMENTS} attachments are allowed.`);
      continue;
    }
    const declaredContentType = contentTypeForFile(file);
    if (!declaredContentType) {
      rejected.push(`${file.name}: use PNG, JPEG, WebP, GIF, or PDF.`);
      continue;
    }
    if (file.size <= 0) {
      rejected.push(`${file.name}: empty files are not supported.`);
      continue;
    }
    if (declaredContentType.startsWith('image/') && file.size > MAX_CONTENT_IMAGE_BYTES) {
      rejected.push(`${file.name}: each image must be 3 MiB or smaller.`);
      continue;
    }
    const currentBytes = next.reduce((sum, attachment) => sum + attachment.size, 0);
    if (currentBytes + file.size > MAX_CONTENT_ATTACHMENTS_TOTAL_BYTES) {
      rejected.push(`${file.name}: attachments exceed the available upload budget after reserving space for the one-shot brief.`);
      continue;
    }

    const buffer = await file.arrayBuffer();
    const detectedContentType = sniffContentType(buffer);
    const extension = file.name.toLowerCase().split('.').pop();
    const extensionContentType = extension === 'png' ? 'image/png'
      : extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg'
        : extension === 'webp' ? 'image/webp'
          : extension === 'gif' ? 'image/gif'
            : extension === 'pdf' ? 'application/pdf'
              : null;
    if (!detectedContentType
      || (file.type && detectedContentType !== file.type)
      || (extensionContentType && detectedContentType !== extensionContentType)) {
      rejected.push(`${file.name}: file contents do not match the declared file type.`);
      continue;
    }
    const data = bufferToBase64(buffer);
    const id = await stableAttachmentId(file, buffer);
    if (next.some((attachment) => attachment.id === id)) {
      rejected.push(`${file.name}: this attachment is already included.`);
      continue;
    }
    next.push({ id, name: file.name, contentType: detectedContentType, size: file.size, data });
  }

  return { attachments: next, rejected };
}

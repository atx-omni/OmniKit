import type { MigrationValidationCheck } from './validation';

export type MigrationVisualEvidenceRole = 'source' | 'target';

export interface MigrationVisualEvidenceDescriptor {
  id: string;
  role: MigrationVisualEvidenceRole;
  reference: string;
  mimeType: string;
  width: number;
  height: number;
  sha256: string;
  perceptualHash?: string;
  redacted: boolean;
  capturedAt: string;
}

export interface MigrationVisualComparison {
  id: string;
  sourceEvidenceId: string;
  targetEvidenceId: string;
  method: 'exact_hash' | 'perceptual_hash' | 'metadata_only';
  status: 'passed' | 'attention' | 'unverified';
  score?: number;
  findings: string[];
}

export interface MigrationVisualReviewDisclosure {
  llmOptIn: boolean;
  redactionConfirmed: boolean;
  llmReviewExecuted: boolean;
  providerLabel?: string;
  statement: string;
}

function safeReference(value: string): string {
  const withoutControls = Array.from(value)
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join('')
    .trim()
    .slice(0, 240);
  try {
    const parsed = new URL(withoutControls);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return withoutControls.replace(/^.*[\\/]/, '');
  }
}

function validHash(value: string | undefined, length: number): string | undefined {
  const normalized = value?.toLowerCase().trim();
  return normalized && new RegExp(`^[a-f0-9]{${length}}$`).test(normalized) ? normalized : undefined;
}

export function normalizeMigrationVisualEvidenceDescriptor(input: MigrationVisualEvidenceDescriptor): MigrationVisualEvidenceDescriptor {
  const sha256 = validHash(input.sha256, 64);
  if (!sha256) throw new Error('Visual evidence requires a valid SHA-256 digest.');
  if (!Number.isFinite(input.width) || !Number.isFinite(input.height) || input.width <= 0 || input.height <= 0) {
    throw new Error('Visual evidence requires positive pixel dimensions.');
  }
  return {
    id: input.id.replace(/[^a-zA-Z0-9:_-]/g, '').slice(0, 180),
    role: input.role,
    reference: safeReference(input.reference),
    mimeType: input.mimeType.toLowerCase().slice(0, 80),
    width: Math.round(input.width),
    height: Math.round(input.height),
    sha256,
    perceptualHash: validHash(input.perceptualHash, 16),
    redacted: Boolean(input.redacted),
    capturedAt: Number.isFinite(Date.parse(input.capturedAt)) ? new Date(input.capturedAt).toISOString() : new Date().toISOString(),
  };
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((value) => value.toString(16).padStart(2, '0')).join('');
}

export async function migrationVisualEvidenceDescriptorFromFile(
  file: File,
  role: MigrationVisualEvidenceRole,
  redacted: boolean,
): Promise<MigrationVisualEvidenceDescriptor> {
  if (!file.type.startsWith('image/')) throw new Error(`${file.name} is not an image.`);
  const bytes = await file.arrayBuffer();
  const sha256 = bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 8;
    canvas.height = 8;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('The browser could not create a visual evidence canvas.');
    context.drawImage(bitmap, 0, 0, 8, 8);
    const pixels = context.getImageData(0, 0, 8, 8).data;
    const luminance = Array.from({ length: 64 }, (_, index) => {
      const offset = index * 4;
      return pixels[offset]! * 0.299 + pixels[offset + 1]! * 0.587 + pixels[offset + 2]! * 0.114;
    });
    const average = luminance.reduce((sum, value) => sum + value, 0) / luminance.length;
    const bits = luminance.map((value) => value >= average ? '1' : '0').join('');
    const perceptualHash = Array.from({ length: 16 }, (_, index) => Number.parseInt(bits.slice(index * 4, index * 4 + 4), 2).toString(16)).join('');
    return normalizeMigrationVisualEvidenceDescriptor({
      id: `visual:${role}:${sha256.slice(0, 16)}`,
      role,
      reference: file.name,
      mimeType: file.type,
      width: bitmap.width,
      height: bitmap.height,
      sha256,
      perceptualHash,
      redacted,
      capturedAt: new Date(file.lastModified || Date.now()).toISOString(),
    });
  } finally {
    bitmap.close();
  }
}

function hashDistance(left: string, right: string): number {
  let distance = 0;
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const xor = Number.parseInt(left[index]!, 16) ^ Number.parseInt(right[index]!, 16);
    distance += xor.toString(2).replace(/0/g, '').length;
  }
  return distance + Math.abs(left.length - right.length) * 4;
}

export function compareMigrationVisualEvidence(
  source: MigrationVisualEvidenceDescriptor,
  target: MigrationVisualEvidenceDescriptor,
): MigrationVisualComparison {
  if (source.sha256 === target.sha256) {
    return { id: `visual:${source.id}:${target.id}`, sourceEvidenceId: source.id, targetEvidenceId: target.id, method: 'exact_hash', status: 'passed', score: 1, findings: ['Source and target evidence are byte-identical.'] };
  }
  const findings: string[] = [];
  const sourceRatio = source.width / source.height;
  const targetRatio = target.width / target.height;
  const ratioDelta = Math.abs(sourceRatio - targetRatio) / Math.max(sourceRatio, targetRatio);
  if (ratioDelta > 0.05) findings.push(`Aspect ratio differs by ${Math.round(ratioDelta * 100)}%.`);
  if (source.perceptualHash && target.perceptualHash) {
    const distance = hashDistance(source.perceptualHash, target.perceptualHash);
    const score = Math.max(0, 1 - distance / 64);
    if (score < 0.9) findings.push(`Perceptual similarity is ${Math.round(score * 100)}%.`);
    return {
      id: `visual:${source.id}:${target.id}`,
      sourceEvidenceId: source.id,
      targetEvidenceId: target.id,
      method: 'perceptual_hash',
      status: score >= 0.9 && ratioDelta <= 0.05 ? 'passed' : 'attention',
      score,
      findings: findings.length > 0 ? findings : ['Perceptual structure and aspect ratio are aligned.'],
    };
  }
  return {
    id: `visual:${source.id}:${target.id}`,
    sourceEvidenceId: source.id,
    targetEvidenceId: target.id,
    method: 'metadata_only',
    status: 'unverified',
    findings: findings.length > 0 ? findings : ['Image hashes differ and no perceptual hashes were captured.'],
  };
}

export function pairMigrationVisualEvidence(descriptors: MigrationVisualEvidenceDescriptor[]): MigrationVisualComparison[] {
  const sources = descriptors.filter((item) => item.role === 'source');
  const targets = descriptors.filter((item) => item.role === 'target');
  return sources.slice(0, Math.min(sources.length, targets.length)).map((source, index) => compareMigrationVisualEvidence(source, targets[index]!));
}

export function migrationVisualReviewDisclosure(input: {
  llmOptIn: boolean;
  redactionConfirmed: boolean;
  llmReviewExecuted?: boolean;
  providerLabel?: string;
}): MigrationVisualReviewDisclosure {
  const llmReviewExecuted = Boolean(input.llmReviewExecuted && input.llmOptIn && input.redactionConfirmed);
  return {
    llmOptIn: input.llmOptIn,
    redactionConfirmed: input.redactionConfirmed,
    llmReviewExecuted,
    providerLabel: llmReviewExecuted ? input.providerLabel?.slice(0, 120) : undefined,
    statement: llmReviewExecuted
      ? `Redacted visual evidence was reviewed by ${input.providerLabel || 'the selected AI provider'} with explicit operator consent.`
      : input.llmOptIn
        ? 'AI visual review was requested but has not run; image evidence remains local until redaction is confirmed and a review job is explicitly started.'
        : 'AI visual review is off. No screenshot bytes were sent to an AI provider.',
  };
}

export function buildMigrationVisualValidationCheck(
  descriptors: MigrationVisualEvidenceDescriptor[],
  comparisons: MigrationVisualComparison[],
): MigrationValidationCheck {
  if (descriptors.length === 0) {
    return { id: 'visual_intent', label: 'Visual fidelity', status: 'unsupported', blocking: true, summary: 'No source and target visual evidence was captured.', evidence: [] };
  }
  const sourceCount = descriptors.filter((item) => item.role === 'source').length;
  const targetCount = descriptors.filter((item) => item.role === 'target').length;
  const attention = comparisons.filter((item) => item.status !== 'passed');
  if (sourceCount === 0 || targetCount === 0 || comparisons.length < Math.max(sourceCount, targetCount)) {
    return { id: 'visual_intent', label: 'Visual fidelity', status: 'failed', blocking: true, summary: `Visual evidence is incomplete: ${sourceCount} source and ${targetCount} target image${targetCount === 1 ? '' : 's'} produced ${comparisons.length} comparison${comparisons.length === 1 ? '' : 's'}.`, evidence: ['Capture one target image for each source image and preserve their order.'] };
  }
  if (attention.length > 0) {
    return { id: 'visual_intent', label: 'Visual fidelity', status: 'failed', blocking: true, summary: `${attention.length} of ${comparisons.length} visual comparison${comparisons.length === 1 ? '' : 's'} require review.`, evidence: attention.flatMap((item) => item.findings).slice(0, 12) };
  }
  return { id: 'visual_intent', label: 'Visual fidelity', status: 'passed', blocking: true, summary: `All ${comparisons.length} source-target visual comparison${comparisons.length === 1 ? '' : 's'} passed deterministic review.`, evidence: comparisons.map((item) => `${item.method}: ${item.score === undefined ? 'matched' : `${Math.round(item.score * 100)}%`}`) };
}

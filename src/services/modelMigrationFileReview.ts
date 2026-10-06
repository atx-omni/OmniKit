import type { ModelMigratorTranslatedFile } from './opsConsole';

export type ModelMigrationFileReviewStatus = 'pending' | 'accepted' | 'skipped' | 'unchanged';

export function ordinaryModelFileReview(
  file: ModelMigratorTranslatedFile,
  options: { accepted?: string; edited?: string; skipped?: boolean } = {},
): { value: string; status: ModelMigrationFileReviewStatus } {
  const value = options.edited ?? options.accepted ?? (file.aiDraft || file.translated || file.deterministic || file.original);
  if (file.blocked || file.targetOriginal === undefined) return { value, status: 'pending' };
  if (typeof file.targetOriginal === 'string' && value === file.targetOriginal) return { value, status: 'unchanged' };
  if (options.skipped) return { value, status: 'skipped' };
  return { value, status: options.accepted === value ? 'accepted' : 'pending' };
}

export function ordinaryModelReviewComplete(
  files: ModelMigratorTranslatedFile[],
  accepted: Record<string, string>,
  edited: Record<string, string>,
  skipped: string[],
): boolean {
  const reviews = files.map((file) => ordinaryModelFileReview(file, {
    accepted: accepted[file.fileName], edited: edited[file.fileName], skipped: skipped.includes(file.fileName),
  }));
  return reviews.some((review) => review.status === 'accepted')
    && reviews.every((review) => review.status !== 'pending');
}

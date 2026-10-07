const PREFIX = 'omnikit-topics-';
const LEGACY = /^omnikit-topics-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TIMESTAMP = /^omnikit-topics-(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{3})-utc(?:-([1-9]\d{0,4}))?$/;

function isTimestampName(value: string): boolean {
  const match = TIMESTAMP.exec(value);
  if (!match || (match[8] !== undefined && Number(match[8]) < 2)) return false;
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${match[7]}Z`;
  const time = Date.parse(iso);
  return Number.isFinite(time) && new Date(time).toISOString() === iso;
}

/** Historical UUID names stay valid; timestamp-like free text is never exempted. */
export function isTopicMigrationBranchName(value: unknown): value is string {
  return typeof value === 'string' && (LEGACY.test(value) || isTimestampName(value));
}

/** Legacy names retain their original plan-ID binding; new names are bound by the saved plan proof. */
export function isTopicMigrationBranchNameForPlan(value: unknown, planId: unknown): value is string {
  return typeof value === 'string' && (isTimestampName(value) || (LEGACY.test(value) && value === PREFIX + planId));
}

/** Ordinals distinguish same-millisecond plans without inventing a later creation time. */
export function createTopicMigrationBranchName(createdAt: number, occupiedNames: Iterable<string> = []): string {
  if (!Number.isSafeInteger(createdAt) || createdAt < 0 || createdAt > 253402300799999) throw new Error('A valid creation timestamp is required for a review branch.');
  const base = PREFIX + new Date(createdAt).toISOString().replace(/[T:.]/g, '-').replace(/Z$/, '-utc');
  const occupied = new Set([...occupiedNames].map(name => name.toLowerCase()));
  if (!occupied.has(base)) return base;
  // Saved topic-plan history is bounded to 500 records. Keep allocation bounded too.
  for (let ordinal = 2; ordinal <= 1000; ordinal += 1) {
    const candidate = base + '-' + ordinal;
    if (!occupied.has(candidate)) return candidate;
  }
  throw new Error('A unique dated review-branch name is unavailable. Try preparing a new plan later.');
}

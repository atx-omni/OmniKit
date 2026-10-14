import type { TopicBranchValidation } from '../../shared/topicBranchCorrection';
import type { OmniClient } from './omniClient';
import { redactSensitiveText } from './jobSanitizer';

const MAX_TOPICS = 20;
const MAX_ISSUES = 1_000;
const MAX_RECORDS = 2_000;
const LIMITATION = 'Native validation only; warehouse queries were not executed or verified.';
const CONTENT_LIMITATION = 'Selected-topic content references only; personal folders are excluded and large documents may receive surface checks. Warehouse queries were not executed or verified.';
type Issue = TopicBranchValidation['issues'][number];
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value: unknown, max = 8_192): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max
  && ![...value].some(character => character.charCodeAt(0) < 32 && !['\n', '\r', '\t'].includes(character) || character.charCodeAt(0) === 127);
const exactId = (value: unknown): value is string => text(value, 1_024) && value === value.trim()
  && ![...value].some(character => character.charCodeAt(0) < 32);
function invalid(): never { throw new Error('Incomplete validation evidence.'); }
function array(value: unknown, max = MAX_RECORDS): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid();
  return value;
}
function modelIssues(raw: unknown): Issue[] {
  return array(raw, MAX_ISSUES).map(value => {
    if (!object(value) || !text(value.message) || typeof value.is_warning !== 'boolean'
      || (value.yaml_path !== undefined && !text(value.yaml_path, 1_024))) invalid();
    return { message: redactSensitiveText(value.message), warning: value.is_warning,
      ...(typeof value.yaml_path === 'string' ? { fileName: redactSensitiveText(value.yaml_path) } : {}) };
  });
}
function contentIssues(raw: unknown, modelId: string, branchId: string): Issue[] {
  if (!object(raw) || raw.model_id !== modelId || !object(raw.branch) || raw.branch.id !== branchId
    || ['error', 'errors', 'next_cursor', 'nextCursor', 'pageInfo'].some(key => Object.hasOwn(raw, key))) invalid();
  const issues: Issue[] = [];
  const append = (values: unknown) => {
    for (const value of array(values, MAX_ISSUES)) {
      if (!text(value) || issues.length >= MAX_ISSUES) invalid();
      issues.push({ message: redactSensitiveText(value), warning: false });
    }
  };
  let queries = 0;
  for (const document of array(raw.content)) {
    if (!object(document)) invalid();
    for (const query of array(document.queries_and_issues)) {
      if (!object(query) || ++queries > MAX_RECORDS) invalid();
      append(query.issues);
    }
    append(document.dashboard_filter_issues);
  }
  return issues;
}
function selectedTopics(topicIds: string[] | undefined): string[] {
  if (!Array.isArray(topicIds) || !topicIds.length || topicIds.length > MAX_TOPICS) invalid();
  const identities = new Map<string, string>();
  for (const id of topicIds) {
    if (!exactId(id) || id.length > 512 || id.includes('\\') || id.split('/').some(part => !part || part === '.' || part === '..')
      || !id.endsWith('.topic')) invalid();
    const name = id.split('/').pop()!.slice(0, -6);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || (identities.has(name) && identities.get(name) !== id)) invalid();
    identities.set(name, id);
  }
  return [...identities.keys()].sort();
}

/** Read-only, bounded native checks. The caller must prove the branch hash before and after this observation. */
export async function validateTopicCorrectionBranch(client: OmniClient, modelId: string, branchId: string, branchHash: string,
  kind: 'model' | 'content', topicIds?: string[], signal?: AbortSignal): Promise<TopicBranchValidation> {
  const issues: Issue[] = [];
  const validHash = typeof branchHash === 'string' && /^sha256:[a-f0-9]{64}$/.test(branchHash);
  const result = (status: TopicBranchValidation['status'], message: string): TopicBranchValidation => ({ status,
    checkedAt: Date.now(), ...(validHash ? { branchHash } : {}), issues, message });
  try {
    if (!validHash || !exactId(modelId) || !exactId(branchId) || !['model', 'content'].includes(kind)) invalid();
    const deadline = AbortSignal.timeout(30_000);
    const readSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    readSignal.throwIfAborted();
    if (kind === 'model') issues.push(...modelIssues(await client.getModelValidationRaw(modelId, branchId, readSignal)));
    else {
      for (const name of selectedTopics(topicIds)) {
        readSignal.throwIfAborted();
        const scoped = contentIssues(await client.getModelContentValidationRaw(modelId, branchId, name, readSignal), modelId, branchId);
        if (issues.length + scoped.length > MAX_ISSUES) invalid();
        issues.push(...scoped);
      }
    }
    readSignal.throwIfAborted();
    return result(issues.length ? 'issues' : 'passed', kind === 'content' ? CONTENT_LIMITATION : LIMITATION);
  } catch {
    // Never persist untrusted HTTP bodies, credentials, or error strings as validation evidence.
    return result('unavailable', 'Complete branch-scoped validation evidence was unavailable, malformed, interrupted, or exceeded its limits. No successful validation is claimed.');
  }
}

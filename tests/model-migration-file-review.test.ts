import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ordinaryModelFileReview, ordinaryModelReviewComplete } from '../src/services/modelMigrationFileReview';
import type { ModelMigratorTranslatedFile } from '../src/services/opsConsole';

function file(patch: Partial<ModelMigratorTranslatedFile> = {}): ModelMigratorTranslatedFile {
  return {
    fileName: 'example.view', targetOriginal: '{}', original: '{}', deterministic: '{}', translated: '{}',
    changed: false, promptVersion: 'example-test', reviewRequired: true, warnings: [], ...patch,
  };
}

test('exact destination matches are unchanged for draft, accepted, or current edited proposals', () => {
  assert.equal(ordinaryModelFileReview(file()).status, 'unchanged');
  const changed = file({ deterministic: 'sql: SELECT 1', translated: 'sql: SELECT 1' });
  assert.equal(ordinaryModelFileReview(changed, { accepted: '{}' }).status, 'unchanged');
  assert.equal(ordinaryModelFileReview(changed, { accepted: 'sql: SELECT 1', edited: '{}' }).status, 'unchanged');
  assert.equal(ordinaryModelFileReview(file(), { skipped: true }).status, 'unchanged');
  assert.equal(ordinaryModelFileReview(file({ aiDraft: 'sql: SELECT 2' })).status, 'pending');
  assert.equal(ordinaryModelFileReview(file({ targetOriginal: '{}\n' })).status, 'pending', 'comparison must remain exact');
});

test('new files still require acceptance and unavailable or blocked destination evidence never becomes unchanged', () => {
  const newFile = file({ targetOriginal: null, additiveStatus: 'unchanged' });
  assert.equal(ordinaryModelFileReview(newFile).status, 'pending');
  assert.equal(ordinaryModelFileReview(newFile, { accepted: '{}' }).status, 'accepted');
  assert.equal(ordinaryModelFileReview(file({ targetOriginal: undefined }), { accepted: '{}' }).status, 'pending');
  assert.equal(ordinaryModelFileReview(file({ blocked: true }), { accepted: '{}' }).status, 'pending');
});

test('editing an unchanged file requires fresh acceptance and reverting it excludes it from accepted changes', () => {
  const current = file();
  assert.equal(ordinaryModelFileReview(current, { edited: 'sql: SELECT 1' }).status, 'pending');
  assert.equal(ordinaryModelFileReview(current, { edited: 'sql: SELECT 1', accepted: 'sql: SELECT 1' }).status, 'accepted');
  assert.equal(ordinaryModelFileReview(current, { edited: '{}', accepted: 'sql: SELECT 1' }).status, 'unchanged');
  assert.equal(ordinaryModelFileReview(current, { edited: 'sql: SELECT 2', accepted: 'sql: SELECT 1' }).status, 'pending');
  const accepted = [{ current, yaml: '{}' }, { current, yaml: 'sql: SELECT 1' }]
    .filter(({ current: candidate, yaml }) => ordinaryModelFileReview(candidate, { accepted: yaml }).status === 'accepted');
  assert.deepEqual(accepted.map(({ yaml }) => yaml), ['sql: SELECT 1']);
});

test('review completion needs an actual accepted change while unchanged files need no decision', () => {
  const unchanged = file();
  const changed = file({ fileName: 'changed.view', translated: 'sql: SELECT 1' });
  assert.equal(ordinaryModelReviewComplete([unchanged], {}, {}, []), false);
  assert.equal(ordinaryModelReviewComplete([unchanged], { 'example.view': '{}' }, {}, []), false);
  assert.equal(ordinaryModelReviewComplete([unchanged, changed], { 'changed.view': 'sql: SELECT 1' }, {}, []), true);
  assert.equal(ordinaryModelReviewComplete([unchanged, changed], {}, {}, ['changed.view']), false);
  assert.equal(ordinaryModelReviewComplete([unchanged, changed], { 'changed.view': 'sql: SELECT 1' }, { 'changed.view': '{}' }, []), false);
  assert.equal(ordinaryModelReviewComplete([unchanged, changed, file({ fileName: 'missing.view', targetOriginal: undefined })], { 'changed.view': 'sql: SELECT 1' }, {}, ['missing.view']), false);
});

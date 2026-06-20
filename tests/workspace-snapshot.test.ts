import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  countWorkspaceSnapshotSemanticModels,
  isActiveSemanticModel,
} from '../src/services/workspaceSnapshot';

test('workspace snapshot counts active semantic models only', () => {
  const count = countWorkspaceSnapshotSemanticModels([
    { id: 'schema', kind: 'SCHEMA' },
    { id: 'shared', kind: 'SHARED' },
    { id: 'extension', model_kind: 'SHARED_EXTENSION' },
    { id: 'branch', kind: 'BRANCH' },
    { id: 'deleted', kind: 'SHARED', deletedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'deleted-snake-case', modelKind: 'SHARED', deleted_at: '2026-01-01T00:00:00.000Z' },
    { id: 'shared-kind-omitted-by-scoped-response' },
  ]);

  assert.equal(count, 3);
});

test('workspace snapshot model helpers handle incomplete payloads safely', () => {
  assert.equal(countWorkspaceSnapshotSemanticModels(null), null);
  assert.equal(countWorkspaceSnapshotSemanticModels({ models: [] }), null);
  assert.equal(isActiveSemanticModel({ id: 'missing-kind' }), false);
  assert.equal(isActiveSemanticModel({ id: 'missing-kind' }, { treatMissingKindAsSemantic: true }), true);
  assert.equal(isActiveSemanticModel({ id: 'deleted-boolean', kind: 'SHARED', deleted: true }), false);
});

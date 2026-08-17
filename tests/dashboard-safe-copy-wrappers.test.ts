import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DashboardSafeCopyContentError } from '../server/services/dashboardSafeCopyContent';
import {
  materializeDashboardSafeCopyDocument,
  rewriteDashboardSafeCopyQueryForTarget,
} from '../server/services/migrationJobs';

function sourceDashboard(): Record<string, unknown> {
  return {
    name: 'Safe copy example',
    description: 'Content-only dashboard copy.',
    modelId: 'source-model',
    queryPresentations: {
      data: {
        '1': {
          type: 'query',
          name: 'Revenue',
          query: {
            modelId: 'source-model',
            baseModelId: 'source-model',
            modelExtensionId: 'source-extension',
            topicName: 'source-topic',
            viewName: 'source_view',
            fields: ['source_view.revenue'],
          },
          visConfig: { type: 'table' },
        },
      },
      order: ['1'],
    },
    controls: [],
    settings: { interactionMode: 'cross-filter' },
    containers: [{ type: 'grid', queryPresentationKeys: ['1'] }],
  };
}

const topicMappings = [{
  sourceTopicName: 'source-topic',
  action: 'map_existing' as const,
  targetTopicName: 'target-topic',
}];

const queryViewMappings = [{
  sourceQueryViewName: 'source_view',
  action: 'map_existing' as const,
  targetQueryViewName: 'target_view',
}];

function assertContentError(
  action: () => unknown,
  code: DashboardSafeCopyContentError['code'],
): void {
  assert.throws(action, (error: unknown) => (
    error instanceof DashboardSafeCopyContentError && error.code === code
  ));
}

test('safe-copy document wrapper validates, detaches, rewrites, and rematerializes content', () => {
  const sourceState = sourceDashboard();
  const result = materializeDashboardSafeCopyDocument({
    sourceState,
    targetModelId: ' target-model ',
    topicMappings,
    queryViewMappings,
  });
  const query = result.content.queryPresentations.data['1'].query;

  assert.equal(result.sourceModelId, 'source-model');
  assert.equal(query?.modelId, 'target-model');
  assert.equal(query?.baseModelId, 'target-model');
  assert.equal(query?.modelExtensionId, undefined);
  assert.equal(query?.topicName, 'target-topic');
  assert.equal(query?.viewName, 'target_view');
  assert.equal(result.modelRewriteCount, 2);
  assert.equal(result.modelExtensionRemovalCount, 1);
  assert.equal(result.topicRewriteCount, 1);
  assert.equal(result.queryViewRewriteCount, 1);

  const sourceQuery = (((sourceState.queryPresentations as Record<string, unknown>).data as Record<string, unknown>)['1'] as Record<string, unknown>).query as Record<string, unknown>;
  sourceQuery.modelId = 'mutated-after-copy';
  assert.equal(query?.modelId, 'target-model');
});

test('safe-copy query wrapper preserves the established model, topic, and query-view rewrites', () => {
  const result = rewriteDashboardSafeCopyQueryForTarget({
    query: {
      modelExtensionId: 'source-extension',
      topic: 'source-topic',
      view: 'source_view',
    },
    targetModelId: 'target-model',
    topicMappings,
    queryViewMappings,
  });

  assert.equal(result.query.modelId, 'target-model');
  assert.equal(result.query.modelExtensionId, undefined);
  assert.equal(result.query.topic, 'target-topic');
  assert.equal(result.query.view, 'target_view');
  assert.equal(result.modelExtensionRemovalCount, 1);
  assert.equal(result.topicRewriteCount, 1);
  assert.equal(result.queryViewRewriteCount, 1);
});

test('safe-copy document wrapper rejects malformed descriptions before rewriting', () => {
  const sourceState = sourceDashboard();
  sourceState.description = { unexpected: true };

  assertContentError(
    () => materializeDashboardSafeCopyDocument({
      sourceState,
      targetModelId: 'target-model',
      topicMappings: [],
      queryViewMappings: [],
    }),
    'SAFE_COPY_CONTENT_INVALID_DOCUMENT',
  );
});

test('safe-copy document wrapper rejects accessors and cycles before rewrite traversal', () => {
  const withAccessor = sourceDashboard();
  const accessorQuery = ((((withAccessor.queryPresentations as Record<string, unknown>).data as Record<string, unknown>)['1'] as Record<string, unknown>).query) as Record<string, unknown>;
  let accessorReads = 0;
  Object.defineProperty(accessorQuery, 'dynamic', {
    enumerable: true,
    get() {
      accessorReads += 1;
      return 'must-not-run';
    },
  });
  assertContentError(
    () => materializeDashboardSafeCopyDocument({
      sourceState: withAccessor,
      targetModelId: 'target-model',
      topicMappings: [],
      queryViewMappings: [],
    }),
    'SAFE_COPY_CONTENT_UNSUPPORTED_VALUE',
  );
  assert.equal(accessorReads, 0);

  const withCycle = sourceDashboard();
  const cyclicQuery = ((((withCycle.queryPresentations as Record<string, unknown>).data as Record<string, unknown>)['1'] as Record<string, unknown>).query) as Record<string, unknown>;
  cyclicQuery.self = cyclicQuery;
  assertContentError(
    () => materializeDashboardSafeCopyDocument({
      sourceState: withCycle,
      targetModelId: 'target-model',
      topicMappings: [],
      queryViewMappings: [],
    }),
    'SAFE_COPY_CONTENT_UNSUPPORTED_VALUE',
  );
});

test('safe-copy wrappers reject blank target model identifiers', () => {
  assert.throws(
    () => materializeDashboardSafeCopyDocument({
      sourceState: sourceDashboard(),
      targetModelId: '   ',
      topicMappings: [],
      queryViewMappings: [],
    }),
    /Target model ID is required for safe dashboard copy/,
  );
  assert.throws(
    () => rewriteDashboardSafeCopyQueryForTarget({
      query: {},
      targetModelId: '\n\t',
      topicMappings: [],
      queryViewMappings: [],
    }),
    /Target model ID is required for safe dashboard copy/,
  );
});

test('safe-copy document wrapper rejects nonportable presentations', () => {
  const sourceState = sourceDashboard();
  const presentation = (((sourceState.queryPresentations as Record<string, unknown>).data as Record<string, unknown>)['1'] as Record<string, unknown>);
  presentation.type = 'app';

  assert.throws(
    () => materializeDashboardSafeCopyDocument({
      sourceState,
      targetModelId: 'target-model',
      topicMappings: [],
      queryViewMappings: [],
    }),
    /presentation that is not safe for automatic copy/,
  );
});

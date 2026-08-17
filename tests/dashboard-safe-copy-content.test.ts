import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DashboardSafeCopyContentError,
  materializeDashboardSafeCopyDocumentContent,
} from '../server/services/dashboardSafeCopyContent';

function validContent(): Record<string, unknown> {
  return {
    name: 'Example dashboard',
    description: 'Bounded content-only example.',
    queryPresentations: {
      data: {
        '1': {
          type: 'query',
          name: 'Example tile',
          query: {
            fields: ['orders.order_id'],
            filters: { 'orders.transaction_date': { kind: 'EQUALS', values: ['2026-08-16'] } },
          },
          visConfig: { type: 'table' },
        },
      },
      order: ['1'],
    },
    controls: [],
    settings: { interactionMode: 'cross-filter', accessibilityLabel: 'Example dashboard' },
    containers: [{ type: 'grid', queryPresentationKeys: ['1'] }],
  };
}

function contentError(value: unknown): DashboardSafeCopyContentError {
  try {
    materializeDashboardSafeCopyDocumentContent(value);
  } catch (error) {
    assert.ok(error instanceof DashboardSafeCopyContentError);
    return error;
  }
  assert.fail('expected content parsing to fail closed');
}

function firstPresentation(value: Record<string, unknown>): Record<string, unknown> {
  return (value.queryPresentations as { data: Record<string, Record<string, unknown>> }).data['1'];
}

test('content materialization returns a detached bounded Documents V2 clone', () => {
  const input = validContent();
  const materialized = materializeDashboardSafeCopyDocumentContent(input);
  assert.equal(materialized.name, 'Example dashboard');
  assert.equal(materialized.queryPresentations.order[0], '1');
  assert.notEqual(materialized, input);
  assert.notEqual(materialized.queryPresentations, input.queryPresentations);

  (input.queryPresentations as { data: Record<string, { query: Record<string, unknown> }> })
    .data['1'].query.permissions = [{ access: 'MANAGE' }];
  (input.containers as Array<Record<string, unknown>>)[0].owner = 'source-owner';
  assert.doesNotMatch(JSON.stringify(materialized), /permissions|source-owner/);
});

test('access, sharing, ownership, security, and automation metadata are rejected at every content slot', () => {
  const mutations: Array<(value: Record<string, unknown>) => void> = [
    (value) => { value.permissions = [{ access: 'MANAGE' }]; },
    (value) => { value.owner = { id: 'source-owner' }; },
    (value) => {
      const tile = ((value.queryPresentations as { data: Record<string, Record<string, unknown>> }).data['1']);
      (tile.query as Record<string, unknown>).rowAccessPolicy = 'all_users';
    },
    (value) => {
      const tile = ((value.queryPresentations as { data: Record<string, Record<string, unknown>> }).data['1']);
      (tile.visConfig as Record<string, unknown>).ownerEmail = 'owner@example.test';
    },
    (value) => { value.controls = [{ webhookUrl: 'https://example.test/hook' }]; },
    (value) => { value.settings = { publicLinkEnabled: true }; },
    (value) => { value.containers = [{ scheduledAction: 'send' }]; },
  ];

  for (const mutate of mutations) {
    const value = validContent();
    mutate(value);
    const error = contentError(value);
    assert.match(error.code, /^SAFE_COPY_CONTENT_(?:UNKNOWN_FIELD|FORBIDDEN_METADATA)$/);
    assert.doesNotMatch(error.message, /owner@example|example\.test|all_users|source-owner/);
  }
});

test('non-JSON structures, accessors, symbols, prototype keys, cycles, and sparse arrays fail closed', () => {
  const withGetter = validContent();
  Object.defineProperty(withGetter.settings as object, 'dynamic', {
    enumerable: true,
    get() {
      return 'secret';
    },
  });
  assert.equal(contentError(withGetter).code, 'SAFE_COPY_CONTENT_UNSUPPORTED_VALUE');

  const withSymbol = validContent();
  Object.defineProperty(withSymbol.settings as object, Symbol('hidden'), { value: true });
  assert.equal(contentError(withSymbol).code, 'SAFE_COPY_CONTENT_UNSUPPORTED_VALUE');

  const withPrototypeKey = validContent();
  Object.defineProperty(withPrototypeKey.settings as object, '__proto__', {
    value: { polluted: true },
    enumerable: true,
  });
  assert.equal(contentError(withPrototypeKey).code, 'SAFE_COPY_CONTENT_FORBIDDEN_METADATA');

  const cyclic = validContent();
  (cyclic.settings as Record<string, unknown>).cycle = cyclic.settings;
  assert.equal(contentError(cyclic).code, 'SAFE_COPY_CONTENT_UNSUPPORTED_VALUE');

  const nonFinite = validContent();
  (nonFinite.settings as Record<string, unknown>).maximum = Number.POSITIVE_INFINITY;
  assert.equal(contentError(nonFinite).code, 'SAFE_COPY_CONTENT_UNSUPPORTED_VALUE');

  const sparse = validContent();
  sparse.controls = new Array(2);
  assert.equal(contentError(sparse).code, 'SAFE_COPY_CONTENT_UNSUPPORTED_VALUE');
});

test('legitimate transaction, interaction, and accessibility content remains supported', () => {
  const materialized = materializeDashboardSafeCopyDocumentContent(validContent());
  const serialized = JSON.stringify(materialized);
  assert.match(serialized, /transaction_date/);
  assert.match(serialized, /interactionMode/);
  assert.match(serialized, /accessibilityLabel/);
});

test('presentation order, linked references, and supported presentation types are exact', () => {
  const duplicateOrder = validContent();
  (duplicateOrder.queryPresentations as { order: string[] }).order = ['1', '1'];
  assert.equal(contentError(duplicateOrder).code, 'SAFE_COPY_CONTENT_INVALID_PRESENTATIONS');

  const missingLinkedTarget = validContent();
  const data = (missingLinkedTarget.queryPresentations as { data: Record<string, unknown> }).data;
  data['1'] = { type: 'linked', sourceQueryPresentationKey: '2' };
  assert.equal(contentError(missingLinkedTarget).code, 'SAFE_COPY_CONTENT_INVALID_PRESENTATIONS');

  const unsupportedType = validContent();
  ((unsupportedType.queryPresentations as { data: Record<string, Record<string, unknown>> }).data['1']).type = 'unknown-type';
  assert.equal(contentError(unsupportedType).code, 'SAFE_COPY_CONTENT_INVALID_PRESENTATIONS');
});

test('documented portable Documents V2 presentation fields round-trip through a detached clone', () => {
  const input = validContent();
  const sourcePresentation = firstPresentation(input);
  Object.assign(sourcePresentation, {
    subTitle: 'Portable query presentation',
    topicName: 'orders',
    isSql: false,
    prefersChart: false,
    automaticVis: false,
    filterOrder: ['orders.transaction_date', 'orders.order_id'],
    editingModelObjectName: 'orders',
    editingModelObjectNameChange: 'orders_v2',
    resultConfig: {
      columnOrder: ['orders.order_id'],
      limit: 50,
    },
    aiConfig: {
      prompt: 'Prefer concise labels.',
      enabled: true,
    },
  });

  const materialized = materializeDashboardSafeCopyDocumentContent(input);
  const materializedPresentation = materialized.queryPresentations.data['1'] as Record<string, unknown>;
  assert.deepEqual(materializedPresentation, sourcePresentation);
  assert.notEqual(materializedPresentation, sourcePresentation);
  assert.notEqual(materializedPresentation.filterOrder, sourcePresentation.filterOrder);
  assert.notEqual(materializedPresentation.resultConfig, sourcePresentation.resultConfig);
  assert.notEqual(materializedPresentation.aiConfig, sourcePresentation.aiConfig);

  (sourcePresentation.filterOrder as string[])[0] = 'mutated.filter';
  (sourcePresentation.resultConfig as Record<string, unknown>).limit = 1;
  (sourcePresentation.aiConfig as Record<string, unknown>).prompt = 'Mutated prompt.';
  assert.deepEqual(materializedPresentation.filterOrder, [
    'orders.transaction_date',
    'orders.order_id',
  ]);
  assert.deepEqual(materializedPresentation.resultConfig, {
    columnOrder: ['orders.order_id'],
    limit: 50,
  });
  assert.deepEqual(materializedPresentation.aiConfig, {
    prompt: 'Prefer concise labels.',
    enabled: true,
  });
});

test('documented nullable presentation fields preserve explicit null values', () => {
  const input = validContent();
  Object.assign(firstPresentation(input), {
    subTitle: null,
    topicName: null,
    isSql: null,
    automaticVis: null,
    editingModelObjectName: null,
    editingModelObjectNameChange: null,
    aiConfig: null,
  });

  const materialized = materializeDashboardSafeCopyDocumentContent(input);
  const materializedPresentation = materialized.queryPresentations.data['1'] as Record<string, unknown>;
  assert.deepEqual(
    {
      subTitle: materializedPresentation.subTitle,
      topicName: materializedPresentation.topicName,
      isSql: materializedPresentation.isSql,
      automaticVis: materializedPresentation.automaticVis,
      editingModelObjectName: materializedPresentation.editingModelObjectName,
      editingModelObjectNameChange: materializedPresentation.editingModelObjectNameChange,
      aiConfig: materializedPresentation.aiConfig,
    },
    {
      subTitle: null,
      topicName: null,
      isSql: null,
      automaticVis: null,
      editingModelObjectName: null,
      editingModelObjectNameChange: null,
      aiConfig: null,
    },
  );
});

test('presentation subTitle accepts 250 characters and rejects 251 exactly', () => {
  const atLimit = validContent();
  firstPresentation(atLimit).subTitle = 's'.repeat(250);
  const materialized = materializeDashboardSafeCopyDocumentContent(atLimit);
  assert.equal(
    (materialized.queryPresentations.data['1'] as Record<string, unknown>).subTitle,
    's'.repeat(250),
  );

  const overLimit = validContent();
  firstPresentation(overLimit).subTitle = 's'.repeat(251);
  assert.equal(contentError(overLimit).code, 'SAFE_COPY_CONTENT_LIMIT_EXCEEDED');
});

test('portable presentation fields reject incorrect types with the presentation error', () => {
  const invalidCases: Array<{
    label: string;
    mutate: (presentation: Record<string, unknown>) => void;
  }> = [
    { label: 'subTitle', mutate: (presentation) => { presentation.subTitle = 1; } },
    { label: 'topicName', mutate: (presentation) => { presentation.topicName = false; } },
    { label: 'isSql', mutate: (presentation) => { presentation.isSql = 'false'; } },
    { label: 'prefersChart', mutate: (presentation) => { presentation.prefersChart = null; } },
    { label: 'automaticVis', mutate: (presentation) => { presentation.automaticVis = 'automatic'; } },
    { label: 'filterOrder container', mutate: (presentation) => { presentation.filterOrder = 'orders.order_id'; } },
    { label: 'filterOrder member', mutate: (presentation) => { presentation.filterOrder = ['orders.order_id', 1]; } },
    { label: 'editingModelObjectName', mutate: (presentation) => { presentation.editingModelObjectName = true; } },
    { label: 'editingModelObjectNameChange', mutate: (presentation) => { presentation.editingModelObjectNameChange = 1; } },
    { label: 'resultConfig', mutate: (presentation) => { presentation.resultConfig = []; } },
    { label: 'resultConfig null', mutate: (presentation) => { presentation.resultConfig = null; } },
    { label: 'aiConfig', mutate: (presentation) => { presentation.aiConfig = []; } },
  ];

  for (const invalidCase of invalidCases) {
    const input = validContent();
    invalidCase.mutate(firstPresentation(input));
    assert.equal(
      contentError(input).code,
      'SAFE_COPY_CONTENT_INVALID_PRESENTATIONS',
      invalidCase.label,
    );
  }
});

test('source model extension identifiers are validated on read and omitted from output', () => {
  for (const sourceValue of ['source-model-extension-secret', 'm'.repeat(64_000), null]) {
    const input = validContent();
    firstPresentation(input).model_extension_id = sourceValue;
    const materialized = materializeDashboardSafeCopyDocumentContent(input);
    const materializedPresentation = materialized.queryPresentations.data['1'] as Record<string, unknown>;
    assert.equal(Object.hasOwn(materializedPresentation, 'model_extension_id'), false);
    assert.equal(JSON.stringify(materialized).includes('model_extension_id'), false);
    assert.equal(JSON.stringify(materialized).includes('source-model-extension-secret'), false);
  }

  const invalidType = validContent();
  firstPresentation(invalidType).model_extension_id = false;
  assert.equal(contentError(invalidType).code, 'SAFE_COPY_CONTENT_INVALID_PRESENTATIONS');

  const overLimit = validContent();
  firstPresentation(overLimit).model_extension_id = 'm'.repeat(64_001);
  assert.equal(contentError(overLimit).code, 'SAFE_COPY_CONTENT_LIMIT_EXCEEDED');
});

test('fileUploadId remains rejected without reflected key or value', () => {
  const input = validContent();
  const sourceValue = 'source-file-upload-secret';
  firstPresentation(input).fileUploadId = sourceValue;
  const error = contentError(input);
  assert.equal(error.code, 'SAFE_COPY_CONTENT_UNKNOWN_FIELD');
  assert.equal(
    error.message,
    'Safe-copy document content contains a field outside the supported content schema.',
  );
  assert.equal(error.message.includes('fileUploadId'), false);
  assert.equal(error.message.includes(sourceValue), false);
  assert.equal(JSON.stringify(error).includes('fileUploadId'), false);
  assert.equal(JSON.stringify(error).includes(sourceValue), false);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import listModelsHandler from '../server/handlers/list-models';
import {
  classifyCollectionReadFailure,
  CollectionContractError,
  planScheduleMutationRefresh,
  parseConnectionDbtConfig,
  parseConnectionRefreshSchedules,
  parseConnectionsCollection,
  parseScheduleDocumentsCollection,
  parseSchedulesCollection,
  parseSchemaModelsCollection,
  parseUploadsCollection,
} from '../src/services/collectionContracts';

const RAW_MARKER = 'RAW_UPSTREAM_ERROR_MUST_NOT_RENDER';

function assertContractFailure(action: () => unknown) {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof CollectionContractError);
    assert.doesNotMatch(error.message, new RegExp(RAW_MARKER));
    return true;
  });
}

function terminalPageInfo(totalRecords: number, pageSize = 25) {
  return { hasNextPage: false, nextCursor: null, pageSize, totalRecords };
}

test('schedule mutations invalidate prior totals and restart offset pagination at page one', () => {
  assert.deepEqual(planScheduleMutationRefresh(1), {
    pageNumber: 1,
    clearPaginationEvidence: true,
  });
  assert.deepEqual(planScheduleMutationRefresh(4), {
    pageNumber: 1,
    clearPaginationEvidence: true,
  });
  assert.throws(() => planScheduleMutationRefresh(0), CollectionContractError);
});

function scheduleRecord(id = 'schedule-1') {
  return {
    id,
    schedule: '0 9 * * *',
    disabledAt: null,
    name: `Schedule ${id}`,
    timezone: 'UTC',
    identifier: `dashboard-${id}`,
    dashboardName: `Dashboard ${id}`,
    ownerId: 'owner-1',
    ownerName: 'Example owner',
    lastCompletedAt: null,
    lastStatus: 'none',
    destinationType: 'email',
    format: 'pdf',
    recipientCount: 1,
    content: 'dashboard',
    systemDisabledAt: null,
    systemDisabledReason: null,
    alert: null,
  };
}

function uploadRecord(id = 'upload-1') {
  return {
    id,
    file_name: `${id}.csv`,
    view_name: 'example_view',
    connection_id: 'connection-1',
    in_db_as_table_name: 'example_upload_table',
    model_id: 'model-1',
    size_bytes: 1024,
    created_at: '2026-08-01T10:00:00.000Z',
    updated_at: '2026-08-02T10:00:00.000Z',
    uploaded_by_user: { id: 'user-1', name: 'Example user' },
  };
}

function uploadContext(overrides: Partial<{
  pageNumber: number;
  previouslyLoaded: number;
  previousRecordIds: string[];
  previousCursors: string[];
  expectedTotalRecords: number;
  currentCursor: string;
}> = {}) {
  return {
    pageNumber: 1,
    previouslyLoaded: 0,
    previousRecordIds: [],
    previousCursors: [],
    ...overrides,
  };
}

function scheduleContext(pageNumber = 1, expectedPageSize = 25, expectedTotalRecords?: number) {
  return { pageNumber, expectedPageSize, expectedTotalRecords };
}

function listModelsRequest(overrides: Record<string, unknown> = {}): Request {
  return new Request('http://127.0.0.1/api/list-models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base_url: 'https://neutral-models.omniapp.co',
      api_key: 'private-model-test-key',
      all_pages: true,
      model_kind: 'SCHEMA',
      page_size: 100,
      ...overrides,
    }),
  });
}

test('connection and normalized model collections require exact envelopes and stable records', () => {
  assert.deepEqual(parseConnectionsCollection({ connections: [] }), []);
  assert.equal(parseConnectionsCollection({
    connections: [{
      id: 'connection-1',
      name: 'Warehouse',
      dialect: 'snowflake',
      database: 'analytics',
      defaultSchema: 'public',
      deletedAt: null,
    }],
  })[0]?.id, 'connection-1');
  assert.deepEqual(parseSchemaModelsCollection({
    models: [],
    pageInfo: terminalPageInfo(0, 100),
    pagesFetched: 1,
    complete: true,
    loadedResults: 0,
    totalResults: 0,
  }), []);
  assert.equal(parseSchemaModelsCollection({
    models: [{ id: 'model-1', name: 'Warehouse schema', connectionId: 'connection-1', kind: 'SCHEMA', deletedAt: null }],
    pageInfo: terminalPageInfo(1, 100),
    pagesFetched: 1,
    complete: true,
    loadedResults: 1,
    totalResults: 1,
  })[0]?.connectionId, 'connection-1');
  assert.equal(parseSchemaModelsCollection({
    models: [
      { id: 'model-1', name: 'Warehouse schema', connectionId: 'connection-1', kind: 'SCHEMA', deletedAt: null },
      { id: 'model-2', name: 'Sparse cursor schema', connectionId: 'connection-2', kind: 'SCHEMA', deletedAt: null },
    ],
    pageInfo: terminalPageInfo(2, 100),
    pagesFetched: 2,
    complete: true,
    loadedResults: 2,
    totalResults: 2,
  })[1]?.id, 'model-2');

  assertContractFailure(() => parseConnectionsCollection({ records: [] }));
  assertContractFailure(() => parseConnectionsCollection({ error: RAW_MARKER, connections: [] }));
  assertContractFailure(() => parseConnectionsCollection({ error: '', connections: [] }));
  assertContractFailure(() => parseConnectionsCollection({ errors: null, connections: [] }));
  assertContractFailure(() => parseConnectionsCollection({ connections: [{ id: '', name: 'Broken', dialect: 'snowflake' }] }));
  assertContractFailure(() => parseConnectionsCollection({
    connections: [
      { id: 'duplicate', name: 'First', dialect: 'snowflake' },
      { id: 'duplicate', name: 'Second', dialect: 'postgres' },
    ],
  }));
  assertContractFailure(() => parseSchemaModelsCollection({ data: [] }));
  assertContractFailure(() => parseSchemaModelsCollection({ models: 'not-an-array' }));
  assertContractFailure(() => parseSchemaModelsCollection({ models: [] }));
  assertContractFailure(() => parseSchemaModelsCollection({
    models: [{ id: 'model-1', name: '' }],
    pageInfo: terminalPageInfo(1, 100),
    pagesFetched: 1,
    complete: true,
    loadedResults: 1,
    totalResults: 1,
  }));
  for (const invalidModel of [
    { id: 'model-1', name: 'Missing kind', connectionId: 'connection-1' },
    { id: 'model-1', name: 'Wrong kind', connectionId: 'connection-1', kind: 'WORKBOOK' },
    { id: 'model-1', name: 'Missing connection', kind: 'SCHEMA' },
  ]) {
    assertContractFailure(() => parseSchemaModelsCollection({
      models: [invalidModel],
      pageInfo: terminalPageInfo(1, 100),
      pagesFetched: 1,
      complete: true,
      loadedResults: 1,
      totalResults: 1,
    }));
  }
});

test('top-level collection failures use fixed status-derived copy without upstream body text', () => {
  const cases = [
    [{ status: 403, message: RAW_MARKER }, 'unauthorized', 'Connection inventory is unavailable: the saved credential is unauthorized for this read.'],
    [{ status: 404, message: RAW_MARKER }, 'unsupported', 'Connection inventory is unavailable: this read is unsupported by the connected instance.'],
    [{ status: 503, message: RAW_MARKER }, 'unavailable', 'Connection inventory is temporarily unavailable.'],
    [{ status: 400, message: RAW_MARKER }, 'failed', 'Connection inventory is unavailable because the response could not be verified.'],
    [new CollectionContractError(RAW_MARKER), 'failed', 'Connection inventory is unavailable because the response could not be verified.'],
  ] as const;
  for (const [error, state, message] of cases) {
    const failure = classifyCollectionReadFailure(error, 'Connection inventory');
    assert.deepEqual(failure, { state, message });
    assert.doesNotMatch(failure.message, new RegExp(RAW_MARKER));
  }
});

test('connection detail contracts reject error envelopes, wrong scopes, and malformed refresh schedules', () => {
  const configuredDbt = {
    supportsDbt: true,
    autogenRelationships: true,
    branch: ' main ',
    dbtVersion: 'Auto',
    enableSemanticLayer: false,
    enableVirtualSchemas: true,
    projectRootPath: null,
    sshUrl: ' git@github.com:example/analytics.git ',
  };
  assert.deepEqual(parseConnectionDbtConfig(configuredDbt), {
    state: 'configured',
    supportsDbt: true,
    autogenRelationships: true,
    branch: 'main',
    dbtVersion: 'Auto',
    enableSemanticLayer: false,
    enableVirtualSchemas: true,
    projectRootPath: null,
    sshUrl: 'git@github.com:example/analytics.git',
  });
  assert.deepEqual(
    parseConnectionDbtConfig({ message: 'dbt not configured for this connection' }),
    { state: 'not_configured' },
  );
  assert.deepEqual(
    parseConnectionDbtConfig({ supportsDbt: true, message: 'dbt not configured for this connection' }),
    { state: 'not_configured', supportsDbt: true },
  );
  assert.deepEqual(
    parseConnectionDbtConfig({ supportsDbt: false, message: 'dbt not configured for this connection' }),
    { state: 'not_supported', supportsDbt: false },
  );
  assert.deepEqual(
    parseConnectionDbtConfig({ ...configuredDbt, supportsDbt: false }),
    { state: 'not_supported', supportsDbt: false },
  );
  assertContractFailure(() => parseConnectionDbtConfig({}));
  assertContractFailure(() => parseConnectionDbtConfig({ branch: 'main', dbtVersion: 'Auto' }));
  assertContractFailure(() => parseConnectionDbtConfig({ ...configuredDbt, error: '' }));
  assertContractFailure(() => parseConnectionDbtConfig({ ...configuredDbt, errors: null }));
  assertContractFailure(() => parseConnectionDbtConfig({ ...configuredDbt, message: 'dbt not configured for this connection' }));
  assertContractFailure(() => parseConnectionDbtConfig({ message: 'different upstream message' }));
  assertContractFailure(() => parseConnectionDbtConfig({ error: RAW_MARKER }));
  assertContractFailure(() => parseConnectionDbtConfig([]));

  assert.deepEqual(parseConnectionRefreshSchedules({ schedules: [] }, 'connection-1'), []);
  assert.equal(parseConnectionRefreshSchedules({
    schedules: [{
      scheduleId: 'refresh-1',
      connectionId: 'connection-1',
      schedule: '0 6 * * *',
      timezone: 'UTC',
      description: 'Daily refresh',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-02T10:00:00.000Z',
      disabledAt: null,
    }],
  }, 'connection-1')[0]?.scheduleId, 'refresh-1');

  assertContractFailure(() => parseConnectionRefreshSchedules({ records: [] }, 'connection-1'));
  assertContractFailure(() => parseConnectionRefreshSchedules({ error: RAW_MARKER, schedules: [] }, 'connection-1'));
  assertContractFailure(() => parseConnectionRefreshSchedules({
    schedules: [{ scheduleId: 'refresh-1', connectionId: 'connection-2', schedule: '0 6 * * *', timezone: 'UTC' }],
  }, 'connection-1'));
  assertContractFailure(() => parseConnectionRefreshSchedules({
    schedules: [{ scheduleId: '', connectionId: 'connection-1', schedule: '0 6 * * *', timezone: 'UTC' }],
  }, 'connection-1'));
});

test('schedule pages distinguish verified empty, populated, and contradictory pagination evidence', () => {
  assert.deepEqual(parseSchedulesCollection({ records: [], pageInfo: terminalPageInfo(0) }, scheduleContext()).records, []);
  assert.equal(parseSchedulesCollection({
    records: [scheduleRecord()],
    pageInfo: terminalPageInfo(1),
  }, scheduleContext()).records[0]?.id, 'schedule-1');
  assert.equal(parseSchedulesCollection({
    records: [scheduleRecord('schedule-1')],
    pageInfo: { hasNextPage: true, nextCursor: '2', pageSize: 1, totalRecords: 2 },
  }, scheduleContext(1, 1)).pageInfo.hasNextPage, true);
  assert.equal(parseSchedulesCollection({
    records: [scheduleRecord('schedule-2')],
    pageInfo: terminalPageInfo(2, 1),
  }, scheduleContext(2, 1, 2)).records[0]?.id, 'schedule-2');
  assert.equal(parseSchedulesCollection({
    records: [scheduleRecord('schedule-2')],
    pageInfo: { hasNextPage: true, nextCursor: '3', pageSize: 1, totalRecords: 3 },
  }, scheduleContext(2, 1, 3)).pageInfo.nextCursor, '3');

  assertContractFailure(() => parseSchedulesCollection({ error: RAW_MARKER, records: [], pageInfo: terminalPageInfo(0) }, scheduleContext()));
  assertContractFailure(() => parseSchedulesCollection({ error: '', records: [], pageInfo: terminalPageInfo(0) }, scheduleContext()));
  assertContractFailure(() => parseSchedulesCollection({ schedules: [], pageInfo: terminalPageInfo(0) }, scheduleContext()));
  assertContractFailure(() => parseSchedulesCollection({ records: [], pageInfo: { hasNextPage: true, nextCursor: '2', pageSize: 25, totalRecords: 0 } }, scheduleContext()));
  assertContractFailure(() => parseSchedulesCollection({
    records: [scheduleRecord('short-schedule-page')],
    pageInfo: { hasNextPage: true, nextCursor: '2', pageSize: 25, totalRecords: 2 },
  }, scheduleContext()));
  assertContractFailure(() => parseSchedulesCollection({
    records: [scheduleRecord('schedule-1')],
    pageInfo: { hasNextPage: true, nextCursor: '999', pageSize: 1, totalRecords: 2 },
  }, scheduleContext(1, 1)));
  assertContractFailure(() => parseSchedulesCollection({
    records: [],
    pageInfo: { hasNextPage: false, pageSize: 25, totalRecords: 0 },
  }, scheduleContext()));
  assertContractFailure(() => parseSchedulesCollection({ records: [scheduleRecord()], pageInfo: { hasNextPage: true, nextCursor: '2', pageSize: 1, totalRecords: 2 } }, scheduleContext()));
  assertContractFailure(() => parseSchedulesCollection({ records: [], pageInfo: terminalPageInfo(2) }, scheduleContext(2, 25, 2)));
  assertContractFailure(() => parseSchedulesCollection({ records: [scheduleRecord()], pageInfo: terminalPageInfo(2) }, scheduleContext()));
  assertContractFailure(() => parseSchedulesCollection({
    records: [scheduleRecord('schedule-2')],
    pageInfo: terminalPageInfo(2, 1),
  }, scheduleContext(2, 1, 3)));
  assertContractFailure(() => parseSchedulesCollection({
    records: [{ ...scheduleRecord(), lastCompletedAt: 'not-a-timestamp' }],
    pageInfo: terminalPageInfo(1),
  }, scheduleContext()));
});

test('upload pages require exact paginated records and validated upload metadata', () => {
  assert.deepEqual(parseUploadsCollection({ records: [], pageInfo: terminalPageInfo(0) }, uploadContext()).records, []);
  assert.equal(parseUploadsCollection({
    records: [uploadRecord()],
    pageInfo: terminalPageInfo(1),
  }, uploadContext()).records[0]?.file_name, 'upload-1.csv');
  assert.equal(parseUploadsCollection({
    records: [{ ...uploadRecord(), connection_id: '', model_id: null }],
    pageInfo: terminalPageInfo(1),
  }, uploadContext()).records[0]?.connection_id, '');
  const firstCursorPage = parseUploadsCollection({
    records: [uploadRecord('short-upload-page')],
    pageInfo: { hasNextPage: true, nextCursor: 'cursor-2', pageSize: 25, totalRecords: 2 },
  }, uploadContext());
  assert.equal(firstCursorPage.records[0]?.id, 'short-upload-page');
  assert.equal(firstCursorPage.cumulativeLoaded, 1);
  assert.equal(parseUploadsCollection({
    records: [uploadRecord('terminal-upload-page')],
    pageInfo: terminalPageInfo(2),
  }, uploadContext({
    pageNumber: 2,
    previouslyLoaded: firstCursorPage.cumulativeLoaded,
    previousRecordIds: firstCursorPage.cumulativeRecordIds,
    previousCursors: firstCursorPage.cursorHistory,
    expectedTotalRecords: 2,
    currentCursor: 'cursor-2',
  })).cumulativeLoaded, 2);

  assertContractFailure(() => parseUploadsCollection({ error: RAW_MARKER, records: [], pageInfo: terminalPageInfo(0) }, uploadContext()));
  assertContractFailure(() => parseUploadsCollection({ errors: null, records: [], pageInfo: terminalPageInfo(0) }, uploadContext()));
  assertContractFailure(() => parseUploadsCollection({ uploads: [], pageInfo: terminalPageInfo(0) }, uploadContext()));
  assertContractFailure(() => parseUploadsCollection({ records: [], pageInfo: null }, uploadContext()));
  assertContractFailure(() => parseUploadsCollection({ records: [], pageInfo: terminalPageInfo(2) }, uploadContext({
    pageNumber: 2,
    previouslyLoaded: 1,
    previousRecordIds: ['upload-previous'],
    previousCursors: [],
    expectedTotalRecords: 2,
    currentCursor: 'cursor-2',
  })));
  assertContractFailure(() => parseUploadsCollection({
    records: [uploadRecord('terminal-mismatch')],
    pageInfo: terminalPageInfo(3),
  }, uploadContext({
    pageNumber: 2,
    previouslyLoaded: 1,
    previousRecordIds: ['upload-previous'],
    previousCursors: [],
    expectedTotalRecords: 3,
    currentCursor: 'cursor-2',
  })));
  assertContractFailure(() => parseUploadsCollection({
    records: [uploadRecord('upload-previous')],
    pageInfo: terminalPageInfo(2),
  }, uploadContext({
    pageNumber: 2,
    previouslyLoaded: 1,
    previousRecordIds: ['upload-previous'],
    previousCursors: [],
    expectedTotalRecords: 2,
    currentCursor: 'cursor-2',
  })));
  assertContractFailure(() => parseUploadsCollection({
    records: [uploadRecord(' upload-previous ')],
    pageInfo: terminalPageInfo(2),
  }, uploadContext({
    pageNumber: 2,
    previouslyLoaded: 1,
    previousRecordIds: ['upload-previous'],
    previousCursors: [],
    expectedTotalRecords: 2,
    currentCursor: 'cursor-2',
  })));
  assertContractFailure(() => parseUploadsCollection({
    records: [uploadRecord('upload-3')],
    pageInfo: { hasNextPage: true, nextCursor: 'cursor-2', pageSize: 25, totalRecords: 4 },
  }, uploadContext({
    pageNumber: 3,
    previouslyLoaded: 2,
    previousRecordIds: ['upload-1', 'upload-2'],
    previousCursors: ['cursor-2'],
    expectedTotalRecords: 4,
    currentCursor: 'cursor-3',
  })));
  assertContractFailure(() => parseUploadsCollection({
    records: [uploadRecord('upload-4')],
    pageInfo: terminalPageInfo(4),
  }, uploadContext({
    pageNumber: 4,
    previouslyLoaded: 3,
    previousRecordIds: ['upload-1', 'upload-2', 'upload-3'],
    previousCursors: [],
    expectedTotalRecords: 4,
    currentCursor: 'cursor-4',
  })));
  assertContractFailure(() => parseUploadsCollection({ records: [uploadRecord()], pageInfo: terminalPageInfo(0) }, uploadContext()));
  assertContractFailure(() => parseUploadsCollection({
    records: [{ ...uploadRecord(), uploaded_by_user: { id: 'user-1', name: '' } }],
    pageInfo: terminalPageInfo(1),
  }, uploadContext()));
});

test('schedule dashboard picker requires the complete normalized document-handler envelope', () => {
  const empty = {
    documents: [],
    pageInfo: terminalPageInfo(0, 100),
    pagesFetched: 1,
    complete: true,
    loadedResults: 0,
    totalResults: 0,
  };
  assert.deepEqual(parseScheduleDocumentsCollection(empty).documents, []);

  const populated = {
    documents: [{ id: 'dashboard-1', identifier: 'dashboard-1', name: 'Example dashboard', type: 'dashboard' }],
    pageInfo: terminalPageInfo(1, 100),
    pagesFetched: 1,
    complete: true,
    loadedResults: 1,
    totalResults: 1,
  };
  assert.equal(parseScheduleDocumentsCollection(populated).documents[0]?.id, 'dashboard-1');
  assert.equal(parseScheduleDocumentsCollection({
    documents: [{ id: 'dashboard-1', identifier: 'dashboard-1', name: 'Example dashboard', type: 'dashboard' }],
    pageInfo: terminalPageInfo(2, 100),
    pagesFetched: 2,
    complete: true,
    loadedResults: 2,
    totalResults: 2,
  }).documents[0]?.id, 'dashboard-1');

  assert.deepEqual(parseScheduleDocumentsCollection({
    ...populated,
    documents: [],
  }).documents, []);
  assertContractFailure(() => parseScheduleDocumentsCollection({ ...empty, error: RAW_MARKER }));
  assertContractFailure(() => parseScheduleDocumentsCollection({ ...empty, documents: undefined, records: [] }));
  assertContractFailure(() => parseScheduleDocumentsCollection({ ...empty, complete: false }));
  assertContractFailure(() => parseScheduleDocumentsCollection({ ...empty, loadedResults: 1 }));
  assertContractFailure(() => parseScheduleDocumentsCollection({
    ...populated,
    documents: [{ id: '', name: 'Missing stable identity' }],
  }));
  assertContractFailure(() => parseScheduleDocumentsCollection({
    ...populated,
    documents: [{ id: 'dashboard-1', name: '' }],
  }));
});

test('list-models handler rejects alternate envelopes, malformed identities, and raw upstream failures', async (t) => {
  const responses = [
    new Response(JSON.stringify({ errors: [] }), { status: 200 }),
    new Response(JSON.stringify({ error: '', records: [], pageInfo: terminalPageInfo(0, 100) }), { status: 200 }),
    new Response(JSON.stringify({ errors: null, records: [], pageInfo: terminalPageInfo(0, 100) }), { status: 200 }),
    new Response(JSON.stringify({ models: [] }), { status: 200 }),
    new Response(JSON.stringify({
      records: [
        { id: 'duplicate-model', name: 'First' },
        { id: 'duplicate-model', name: 'Second' },
      ],
      pageInfo: terminalPageInfo(2, 2),
    }), { status: 200 }),
    new Response(`${RAW_MARKER}:private-model-test-key`, { status: 403 }),
  ];
  let responseIndex = 0;
  t.mock.method(globalThis, 'fetch', async () => responses[responseIndex++]);

  const results = [
    await listModelsHandler(listModelsRequest()),
    await listModelsHandler(listModelsRequest()),
    await listModelsHandler(listModelsRequest()),
    await listModelsHandler(listModelsRequest()),
    await listModelsHandler(listModelsRequest()),
    await listModelsHandler(listModelsRequest()),
  ];
  assert.deepEqual(results.map((response) => response.status), [502, 502, 502, 502, 502, 403]);
  for (const response of results) {
    const serialized = JSON.stringify(await response.json());
    assert.doesNotMatch(serialized, new RegExp(RAW_MARKER));
    assert.doesNotMatch(serialized, /private-model-test-key/);
    assert.doesNotMatch(serialized, /errors|models/);
  }
  assert.equal(responseIndex, responses.length);
});

test('list-models handler binds documented model kind and connection filters to every top-level record', async (t) => {
  const responses = [
    {
      records: [{ id: 'missing-kind', name: 'Missing kind', connectionId: 'connection-1' }],
      pageInfo: terminalPageInfo(1, 100),
    },
    {
      records: [{ id: 'wrong-kind', name: 'Wrong kind', connectionId: 'connection-1', modelKind: 'WORKBOOK' }],
      pageInfo: terminalPageInfo(1, 100),
    },
    {
      records: [{ id: 'wrong-connection', name: 'Wrong connection', connectionId: 'connection-other', modelKind: 'SCHEMA' }],
      pageInfo: terminalPageInfo(1, 100),
    },
  ];
  let responseIndex = 0;
  t.mock.method(globalThis, 'fetch', async () => new Response(
    JSON.stringify(responses[responseIndex++]),
    { status: 200 },
  ));

  const results = [
    await listModelsHandler(listModelsRequest()),
    await listModelsHandler(listModelsRequest()),
    await listModelsHandler(listModelsRequest({ connection_id: 'connection-expected' })),
  ];
  assert.deepEqual(results.map((response) => response.status), [502, 502, 502]);
  for (const response of results) {
    assert.deepEqual(await response.json(), { error: 'The Omni model inventory could not be verified.' });
  }
  assert.equal(responseIndex, responses.length);
});

test('list-models handler normalizes documented null fields without accepting missing or blank fields', async (t) => {
  const responses = [
    {
      records: [{
        id: 'model-with-identifier',
        identifier: 'friendly-model',
        name: null,
        modelKind: 'SCHEMA',
      }],
      pageInfo: terminalPageInfo(1, 100),
    },
    {
      records: [{ id: 'model-id-fallback', name: null, modelKind: 'SCHEMA' }],
      pageInfo: terminalPageInfo(1, 100),
    },
    {
      records: [{ id: 'model-null-kind', name: 'Unclassified model', modelKind: null }],
      pageInfo: terminalPageInfo(1, 100),
    },
    {
      records: [{ id: 'model-missing-name', modelKind: 'SCHEMA' }],
      pageInfo: terminalPageInfo(1, 100),
    },
    {
      records: [{ id: 'model-blank-name', name: '   ', modelKind: 'SCHEMA' }],
      pageInfo: terminalPageInfo(1, 100),
    },
    {
      records: [{ id: 'model-missing-kind', name: 'Missing kind' }],
      pageInfo: terminalPageInfo(1, 100),
    },
    {
      records: [{ id: 'model-blank-kind', name: 'Blank kind', modelKind: '   ' }],
      pageInfo: terminalPageInfo(1, 100),
    },
  ];
  let responseIndex = 0;
  t.mock.method(globalThis, 'fetch', async () => new Response(
    JSON.stringify(responses[responseIndex++]),
    { status: 200 },
  ));

  const withIdentifier = await listModelsHandler(listModelsRequest());
  const withIdentifierBody = await withIdentifier.json() as { models: Array<{ name: string }> };
  assert.equal(withIdentifier.status, 200);
  assert.equal(withIdentifierBody.models[0]?.name, 'friendly-model');

  const withIdFallback = await listModelsHandler(listModelsRequest());
  const withIdFallbackBody = await withIdFallback.json() as { models: Array<{ name: string }> };
  assert.equal(withIdFallback.status, 200);
  assert.equal(withIdFallbackBody.models[0]?.name, 'model-id-fallback');

  const withNullKind = await listModelsHandler(listModelsRequest({ model_kind: undefined }));
  const withNullKindBody = await withNullKind.json() as { models: Array<{ name: string; kind?: string }> };
  assert.equal(withNullKind.status, 200);
  assert.deepEqual(withNullKindBody.models[0], {
    id: 'model-null-kind',
    name: 'Unclassified model',
    deletedAt: null,
  });

  const invalidResponses = [
    await listModelsHandler(listModelsRequest()),
    await listModelsHandler(listModelsRequest()),
    await listModelsHandler(listModelsRequest({ model_kind: undefined })),
    await listModelsHandler(listModelsRequest({ model_kind: undefined })),
  ];
  assert.deepEqual(
    invalidResponses.map((response) => response.status),
    [502, 502, 502, 502],
  );
  for (const response of invalidResponses) {
    assert.deepEqual(await response.json(), { error: 'The Omni model inventory could not be verified.' });
  }
  assert.equal(responseIndex, responses.length);
});

test('list-models handler validates active branch summaries without requiring top-level model fields', async (t) => {
  const responses = [
    {
      records: [{
        id: 'shared-model',
        name: 'Shared model',
        modelKind: 'SCHEMA',
        branches: [
          { id: 'branch-summary', name: 'Active branch' },
          {
            id: 'branch-with-metadata',
            name: 'Active branch with metadata',
            modelKind: 'BRANCH',
            baseModelId: 'shared-model',
            updatedAt: '2026-08-08T12:00:00.000Z',
          },
        ],
      }],
      pageInfo: terminalPageInfo(1, 100),
    },
    {
      records: [{
        id: 'model-with-malformed-branch',
        name: 'Malformed branch model',
        modelKind: 'SCHEMA',
        branches: [{ id: 'branch-without-name' }],
      }],
      pageInfo: terminalPageInfo(1, 100),
    },
    {
      records: [{
        id: 'model-with-blank-branch',
        name: 'Blank branch model',
        modelKind: 'SCHEMA',
        branches: [{ id: 'branch-with-blank-name', name: '   ' }],
      }],
      pageInfo: terminalPageInfo(1, 100),
    },
    {
      records: [{
        id: 'model-with-duplicate-branches',
        name: 'Duplicate branch model',
        modelKind: 'SCHEMA',
        branches: [
          { id: 'duplicate-branch', name: 'First branch' },
          { id: 'duplicate-branch', name: 'Second branch' },
        ],
      }],
      pageInfo: terminalPageInfo(1, 100),
    },
  ];
  let responseIndex = 0;
  t.mock.method(globalThis, 'fetch', async () => new Response(
    JSON.stringify(responses[responseIndex++]),
    { status: 200 },
  ));

  const validResponse = await listModelsHandler(listModelsRequest({ include: 'activeBranches' }));
  const validBody = await validResponse.json() as {
    models: Array<{ branches?: Array<{ id: string; name: string; kind?: string }> }>;
  };
  assert.equal(validResponse.status, 200);
  assert.deepEqual(validBody.models[0]?.branches, [
    { id: 'branch-summary', name: 'Active branch', deletedAt: null },
    {
      id: 'branch-with-metadata',
      name: 'Active branch with metadata',
      baseModelId: 'shared-model',
      kind: 'BRANCH',
      updatedAt: '2026-08-08T12:00:00.000Z',
      deletedAt: null,
    },
  ]);

  const malformedResponses = [
    await listModelsHandler(listModelsRequest({ include: 'activeBranches' })),
    await listModelsHandler(listModelsRequest({ include: 'activeBranches' })),
    await listModelsHandler(listModelsRequest({ include: 'activeBranches' })),
  ];
  assert.deepEqual(malformedResponses.map((response) => response.status), [502, 502, 502]);
  for (const response of malformedResponses) {
    assert.deepEqual(await response.json(), { error: 'The Omni model inventory could not be verified.' });
  }
  assert.equal(responseIndex, responses.length);
});

test('list-models handler preserves nullable records across an unfiltered mixed-kind inventory', async (t) => {
  const requestedUrls: string[] = [];
  const responses = [
    {
      records: [
        { id: 'shared-model', name: 'Curated shared model', modelKind: 'SHARED' },
        { id: 'query-model', name: null, modelKind: 'QUERY', baseModelId: 'shared-model' },
        { id: 'workbook-model', name: null, modelKind: 'WORKBOOK', baseModelId: 'shared-model' },
        { id: 'unclassified-model', name: 'Unclassified model', modelKind: null },
      ],
      pageInfo: { hasNextPage: true, nextCursor: 'cursor-2', pageSize: 100, totalRecords: 5 },
    },
    {
      records: [{
        id: 'shared-extension',
        identifier: 'department-extension',
        name: null,
        modelKind: 'SHARED_EXTENSION',
      }],
      pageInfo: terminalPageInfo(5, 100),
    },
  ];
  let responseIndex = 0;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    requestedUrls.push(String(input));
    return new Response(JSON.stringify(responses[responseIndex++]), { status: 200 });
  });

  const response = await listModelsHandler(listModelsRequest({
    model_kind: undefined,
    page_size: 100,
  }));
  const body = await response.json() as {
    models: Array<{ id: string; name: string; kind?: string }>;
    complete: boolean;
    loadedResults: number;
    totalResults: number;
  };

  assert.equal(response.status, 200);
  assert.deepEqual(
    [body.complete, body.loadedResults, body.totalResults],
    [true, 5, 5],
  );
  assert.deepEqual(
    body.models.map((model) => [model.id, model.name, model.kind]),
    [
      ['shared-model', 'Curated shared model', 'SHARED'],
      ['query-model', 'query-model', 'QUERY'],
      ['workbook-model', 'workbook-model', 'WORKBOOK'],
      ['unclassified-model', 'Unclassified model', undefined],
      ['shared-extension', 'department-extension', 'SHARED_EXTENSION'],
    ],
  );
  assert.deepEqual(
    body.models
      .filter((model) => !model.kind || ['SHARED', 'SHARED_EXTENSION'].includes(model.kind))
      .map((model) => model.id),
    ['shared-model', 'unclassified-model', 'shared-extension'],
  );
  assert.equal(new URL(requestedUrls[0]!).searchParams.has('modelKind'), false);
  assert.equal(new URL(requestedUrls[0]!).searchParams.get('pageSize'), '100');
  assert.equal(new URL(requestedUrls[1]!).searchParams.get('cursor'), 'cursor-2');
  assert.equal(responseIndex, responses.length);
});

test('list-models handler returns reconciled completeness for verified empty and multi-page collections', async (t) => {
  const requestedUrls: string[] = [];
  const responses = [
    {
      records: [],
      pageInfo: terminalPageInfo(0, 100),
    },
    {
      records: [{
        id: 'model-1',
        name: 'First model',
        connectionId: 'connection-1',
        modelKind: 'SCHEMA',
        createdAt: '2026-08-01T10:00:00.000Z',
        updatedAt: '2026-08-02T10:00:00.000Z',
        deletedAt: null,
      }],
      pageInfo: { hasNextPage: true, nextCursor: 'cursor-2', pageSize: 1, totalRecords: 2 },
    },
    {
      records: [{
        id: 'model-2',
        name: 'Second model',
        connectionId: 'connection-2',
        modelKind: 'SCHEMA',
        createdAt: '2026-08-01T10:00:00.000Z',
        updatedAt: '2026-08-02T10:00:00.000Z',
        deletedAt: null,
      }],
      pageInfo: terminalPageInfo(2, 1),
    },
  ];
  let responseIndex = 0;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    requestedUrls.push(String(input));
    return new Response(JSON.stringify(responses[responseIndex++]), { status: 200 });
  });

  const emptyResponse = await listModelsHandler(listModelsRequest());
  const emptyBody = await emptyResponse.json() as Record<string, unknown>;
  assert.equal(emptyResponse.status, 200);
  assert.deepEqual(emptyBody.models, []);
  assert.deepEqual(
    [emptyBody.complete, emptyBody.loadedResults, emptyBody.totalResults, emptyBody.pagesFetched],
    [true, 0, 0, 1],
  );
  assert.deepEqual(parseSchemaModelsCollection(emptyBody), []);

  const populatedResponse = await listModelsHandler(listModelsRequest({ page_size: 1 }));
  const populatedBody = await populatedResponse.json() as Record<string, unknown>;
  assert.equal(populatedResponse.status, 200);
  assert.deepEqual(
    [populatedBody.complete, populatedBody.loadedResults, populatedBody.totalResults, populatedBody.pagesFetched],
    [true, 2, 2, 2],
  );
  assert.deepEqual(
    parseSchemaModelsCollection(populatedBody).map((model) => [model.id, model.connectionId, model.kind]),
    [
      ['model-1', 'connection-1', 'SCHEMA'],
      ['model-2', 'connection-2', 'SCHEMA'],
    ],
  );
  assert.equal(new URL(requestedUrls[2]!).searchParams.get('cursor'), 'cursor-2');
  assert.equal(responseIndex, responses.length);
});

test('list-models handler rejects pagination metadata drift across an all-pages collection', async (t) => {
  const responses = [
    {
      records: [{ id: 'model-1', name: 'First model', modelKind: 'SCHEMA' }],
      pageInfo: { hasNextPage: true, nextCursor: 'cursor-2', pageSize: 1, totalRecords: 2 },
    },
    {
      records: [{ id: 'model-2', name: 'Second model', modelKind: 'SCHEMA' }],
      pageInfo: terminalPageInfo(2, 2),
    },
  ];
  let responseIndex = 0;
  t.mock.method(globalThis, 'fetch', async () => new Response(
    JSON.stringify(responses[responseIndex++]),
    { status: 200 },
  ));

  const response = await listModelsHandler(listModelsRequest({ page_size: 1 }));
  const body = await response.json() as Record<string, unknown>;
  assert.equal(response.status, 502);
  assert.deepEqual(body, { error: 'The Omni model inventory could not be verified.' });
  assert.equal(responseIndex, responses.length);
});

test('list-models handler marks the 50-page bound incomplete and the Connections parser refuses it', async (t) => {
  let requestCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requestCount += 1;
    return new Response(JSON.stringify({
      records: [{ id: `model-${requestCount}`, name: `Model ${requestCount}`, modelKind: 'SCHEMA' }],
      pageInfo: {
        hasNextPage: true,
        nextCursor: `cursor-${requestCount + 1}`,
        pageSize: 1,
        totalRecords: 51,
      },
    }), { status: 200 });
  });

  const response = await listModelsHandler(listModelsRequest({ page_size: 1 }));
  const body = await response.json() as Record<string, unknown>;
  assert.equal(response.status, 200);
  assert.deepEqual(
    [body.complete, body.loadedResults, body.totalResults, body.pagesFetched, body.reasonCode],
    [false, 50, 51, 50, 'PAGINATION_SAFETY_LIMIT_REACHED'],
  );
  assertContractFailure(() => parseSchemaModelsCollection(body));
  assert.equal(requestCount, 50);
});

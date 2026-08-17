import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assertDashboardSafeCopyLiveQuerySet,
  DashboardSafeCopyQueryProofError,
  deriveDashboardSafeCopyExecutableQuerySet,
  proveDashboardSafeCopyQueryExecutions,
  type DashboardSafeCopyExecutableQuerySet,
  type DashboardSafeCopyQueryProofErrorCode,
} from '../server/services/dashboardSafeCopyQueryProof';

function validContent(): Record<string, unknown> {
  return {
    name: 'Safe query proof',
    description: 'Content-only proof fixture.',
    queryPresentations: {
      data: {
        '2': {
          type: 'query',
          name: 'Orders',
          query: {
            fields: ['orders.order_id', 'orders.net_sales'],
            filters: { 'orders.status': { kind: 'EQUALS', values: ['complete'] } },
          },
          visConfig: { type: 'table' },
        },
        '10': {
          type: 'query-view',
          name: 'Customers',
          query: {
            fields: ['customers.customer_id'],
            sorts: [{ field: 'customers.customer_id', direction: 'ascending' }],
          },
        },
        '11': { type: 'blank', name: 'Notes' },
      },
      order: ['2', '10', '11'],
    },
    controls: [{ type: 'filter', targetQueryPresentationKey: '2' }],
    settings: { interactionMode: 'cross-filter' },
    containers: [{ type: 'grid', queryPresentationKeys: ['2', '10', '11'] }],
  };
}

function proofError(
  invoke: () => unknown,
  code: DashboardSafeCopyQueryProofErrorCode,
): DashboardSafeCopyQueryProofError {
  try {
    invoke();
  } catch (error) {
    assert.ok(error instanceof DashboardSafeCopyQueryProofError);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`expected ${code}`);
}

function presentation(
  content: Record<string, unknown>,
  id: string,
): Record<string, unknown> {
  return (((content.queryPresentations as Record<string, unknown>).data as Record<string, unknown>)[id]) as Record<string, unknown>;
}

test('derives deterministic stable IDs, hashes, and detached canonical query bodies', () => {
  const input = validContent();
  const derived = deriveDashboardSafeCopyExecutableQuerySet(input);
  assert.deepEqual(derived.queries.map(({ id }) => id), ['10', '2']);
  assert.match(derived.setHash, /^[a-f0-9]{64}$/);
  assert.ok(derived.queries.every(({ hash }) => /^[a-f0-9]{64}$/.test(hash)));

  const reordered = validContent();
  const orders = presentation(reordered, '2');
  orders.query = {
    filters: { 'orders.status': { values: ['complete'], kind: 'EQUALS' } },
    fields: ['orders.order_id', 'orders.net_sales'],
  };
  (reordered.queryPresentations as { order: string[] }).order = ['11', '10', '2'];
  const second = deriveDashboardSafeCopyExecutableQuerySet(reordered);
  assert.equal(second.setHash, derived.setHash);
  assert.deepEqual(second.queries.map(({ hash }) => hash), derived.queries.map(({ hash }) => hash));

  ((presentation(input, '2').query as { fields: string[] }).fields)[0] = 'secret.changed_field';
  assert.equal(derived.queries.find(({ id }) => id === '2')?.query.fields?.[0], 'orders.order_id');
  assert.doesNotMatch(JSON.stringify(derived), /secret\.changed_field/);
});

test('missing, empty, and incompatible presentation query structures fail closed', () => {
  const missing = validContent();
  delete presentation(missing, '2').query;
  proofError(
    () => deriveDashboardSafeCopyExecutableQuerySet(missing),
    'SAFE_COPY_QUERY_STRUCTURE_MISSING',
  );

  const empty = validContent();
  presentation(empty, '2').query = {};
  proofError(
    () => deriveDashboardSafeCopyExecutableQuerySet(empty),
    'SAFE_COPY_QUERY_STRUCTURE_INVALID',
  );

  const blankWithQuery = validContent();
  presentation(blankWithQuery, '11').query = { fields: ['orders.order_id'] };
  proofError(
    () => deriveDashboardSafeCopyExecutableQuerySet(blankWithQuery),
    'SAFE_COPY_QUERY_STRUCTURE_INVALID',
  );
});

test('duplicate presentation structures, accessors, and cycles are rejected before proof', () => {
  const duplicateOrder = validContent();
  (duplicateOrder.queryPresentations as { order: string[] }).order = ['2', '10', '10'];
  proofError(
    () => deriveDashboardSafeCopyExecutableQuerySet(duplicateOrder),
    'SAFE_COPY_QUERY_CONTENT_INVALID',
  );

  const accessor = validContent();
  Object.defineProperty(presentation(accessor, '2'), 'query', {
    enumerable: true,
    get() {
      return { fields: ['secret.accessor'] };
    },
  });
  const accessorError = proofError(
    () => deriveDashboardSafeCopyExecutableQuerySet(accessor),
    'SAFE_COPY_QUERY_CONTENT_INVALID',
  );
  assert.doesNotMatch(accessorError.message, /secret|accessor/i);

  const cyclic = validContent();
  const query = presentation(cyclic, '2').query as Record<string, unknown>;
  query.cycle = query;
  proofError(
    () => deriveDashboardSafeCopyExecutableQuerySet(cyclic),
    'SAFE_COPY_QUERY_CONTENT_INVALID',
  );
});

test('unknown query-bearing shapes outside the canonical presentation query fail closed', () => {
  const mutations: Array<(content: Record<string, unknown>) => void> = [
    (content) => {
      (presentation(content, '2').visConfig as Record<string, unknown>).query = {
        fields: ['secret.hidden_query'],
      };
    },
    (content) => { content.settings = { queryDefinition: { fields: ['secret.settings'] } }; },
    (content) => { content.controls = [{ sqlText: 'select secret from hidden' }]; },
    (content) => { content.containers = [{ alternateQueries: [{ fields: ['secret.container'] }] }]; },
  ];
  for (const mutate of mutations) {
    const content = validContent();
    mutate(content);
    const error = proofError(
      () => deriveDashboardSafeCopyExecutableQuerySet(content),
      'SAFE_COPY_QUERY_BEARING_SHAPE_UNKNOWN',
    );
    assert.doesNotMatch(error.message, /hidden_query|secret\.settings|select secret|secret\.container/);
  }
});

test('exact live comparison accepts canonical key reorder and rejects changed, missing, or extra queries', () => {
  const expected = deriveDashboardSafeCopyExecutableQuerySet(validContent());
  const reordered = validContent();
  presentation(reordered, '10').query = {
    sorts: [{ direction: 'ascending', field: 'customers.customer_id' }],
    fields: ['customers.customer_id'],
  };
  assert.equal(assertDashboardSafeCopyLiveQuerySet(expected, reordered).setHash, expected.setHash);

  const changed = validContent();
  presentation(changed, '2').query = { fields: ['orders.changed'] };
  proofError(
    () => assertDashboardSafeCopyLiveQuerySet(expected, changed),
    'SAFE_COPY_QUERY_SET_MISMATCH',
  );

  const missing = validContent();
  const missingData = (missing.queryPresentations as {
    data: Record<string, unknown>;
    order: string[];
  });
  delete missingData.data['10'];
  missingData.order = ['2', '11'];
  proofError(
    () => assertDashboardSafeCopyLiveQuerySet(expected, missing),
    'SAFE_COPY_QUERY_SET_MISMATCH',
  );

  const extra = validContent();
  const extraData = (extra.queryPresentations as {
    data: Record<string, unknown>;
    order: string[];
  });
  extraData.data['12'] = { type: 'query', query: { fields: ['orders.extra'] } };
  extraData.order.push('12');
  proofError(
    () => assertDashboardSafeCopyLiveQuerySet(expected, extra),
    'SAFE_COPY_QUERY_SET_MISMATCH',
  );
});

test('tampered or duplicate expected query-set evidence is rejected independently of live content', () => {
  const expected = deriveDashboardSafeCopyExecutableQuerySet(validContent());
  const tampered = structuredClone(expected) as DashboardSafeCopyExecutableQuerySet;
  tampered.queries[0].query.fields = ['secret.tampered'];
  const error = proofError(
    () => assertDashboardSafeCopyLiveQuerySet(tampered, validContent()),
    'SAFE_COPY_QUERY_SET_INVALID',
  );
  assert.doesNotMatch(error.message, /secret|tampered/i);

  const duplicate: DashboardSafeCopyExecutableQuerySet = {
    ...expected,
    queries: [...expected.queries, expected.queries[0]],
  };
  proofError(
    () => assertDashboardSafeCopyLiveQuerySet(duplicate, validContent()),
    'SAFE_COPY_QUERY_STRUCTURE_DUPLICATE',
  );
});

test('execution proof requires exactly one explicit successful terminal summary per query', () => {
  const expected = deriveDashboardSafeCopyExecutableQuerySet(validContent());
  const proof = proveDashboardSafeCopyQueryExecutions(expected, expected.queries.map((query, index) => ({
    queryId: query.id,
    queryHash: query.hash,
    summary: {
      status: index === 0 ? 'completed' : 'SUCCEEDED',
      jobId: `query-job-${index + 1}`,
      rowCount: index === 0 ? 0 : 14,
    },
  })));
  assert.equal(proof.querySetHash, expected.setHash);
  assert.equal(proof.queryCount, 2);
  assert.deepEqual(proof.executions.map(({ status }) => status), ['COMPLETED', 'SUCCEEDED']);
  assert.deepEqual(proof.executions.map(({ rowCount }) => rowCount), [0, 14]);
  assert.doesNotMatch(JSON.stringify(proof), /fields|filters|sorts/);
});

test('empty, inferred, pending, and failed execution summaries never count as success', () => {
  const expected = deriveDashboardSafeCopyExecutableQuerySet(validContent());
  const evidence = expected.queries.map((query) => ({
    queryId: query.id,
    queryHash: query.hash,
    summary: { status: 'COMPLETE' },
  }));

  for (const summary of [{}, { rowCount: 0 }, { status: '' }]) {
    const invalid = evidence.map((row) => ({ ...row, summary: { ...row.summary } }));
    invalid[0].summary = summary as { status: string };
    proofError(
      () => proveDashboardSafeCopyQueryExecutions(expected, invalid),
      'SAFE_COPY_QUERY_EXECUTION_EVIDENCE_INVALID',
    );
  }

  for (const status of ['RUNNING', 'PENDING', 'FAILED', 'ERROR']) {
    const unfinished = evidence.map((row) => ({ ...row, summary: { ...row.summary } }));
    unfinished[0].summary.status = status;
    proofError(
      () => proveDashboardSafeCopyQueryExecutions(expected, unfinished),
      'SAFE_COPY_QUERY_EXECUTION_FAILED',
    );
  }
});

test('execution proof rejects missing, extra, duplicate, mismatched, accessor, and malformed evidence', () => {
  const expected = deriveDashboardSafeCopyExecutableQuerySet(validContent());
  const evidence = expected.queries.map((query) => ({
    queryId: query.id,
    queryHash: query.hash,
    summary: { status: 'COMPLETE', rowCount: 1 },
  }));
  const invalidCases: unknown[][] = [
    evidence.slice(1),
    [...evidence, { queryId: '99', queryHash: 'a'.repeat(64), summary: { status: 'COMPLETE' } }],
    [evidence[0], evidence[0]],
    [{ ...evidence[0], queryHash: 'a'.repeat(64) }, evidence[1]],
    [{ ...evidence[0], summary: { status: 'COMPLETE', rowCount: -1 } }, evidence[1]],
    [{ ...evidence[0], summary: { status: 'COMPLETE', rawPayload: 'secret' } }, evidence[1]],
  ];
  for (const invalid of invalidCases) {
    const error = proofError(
      () => proveDashboardSafeCopyQueryExecutions(
        expected,
        invalid as Parameters<typeof proveDashboardSafeCopyQueryExecutions>[1],
      ),
      'SAFE_COPY_QUERY_EXECUTION_EVIDENCE_INVALID',
    );
    assert.doesNotMatch(error.message, /rawPayload|secret/);
  }

  const accessorSummary: Record<string, unknown> = {};
  Object.defineProperty(accessorSummary, 'status', {
    enumerable: true,
    get() {
      return 'COMPLETE';
    },
  });
  const accessorEvidence = evidence.map((row) => ({ ...row }));
  accessorEvidence[0].summary = accessorSummary as { status: string; rowCount: number };
  proofError(
    () => proveDashboardSafeCopyQueryExecutions(expected, accessorEvidence),
    'SAFE_COPY_QUERY_EXECUTION_EVIDENCE_INVALID',
  );
});

test('a document with no executable query presentations has an explicit empty proof', () => {
  const content = validContent();
  const presentations = content.queryPresentations as {
    data: Record<string, unknown>;
    order: string[];
  };
  presentations.data = { '1': { type: 'blank', name: 'Notes' } };
  presentations.order = ['1'];
  const expected = deriveDashboardSafeCopyExecutableQuerySet(content);
  assert.deepEqual(expected.queries, []);
  const proof = proveDashboardSafeCopyQueryExecutions(expected, []);
  assert.equal(proof.queryCount, 0);
  assert.deepEqual(proof.executions, []);
});
